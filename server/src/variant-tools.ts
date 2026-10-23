import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FigmaClient } from "./figma.js";
import { figmaNodeId } from "./node-id.js";
import { fileKeyParam } from "./file-key.js";
import { BridgeOffline } from "./websocket.js";
import { jsonText } from "./tool-text.js";
import type { Capabilities } from "./tools.js";
import { planIdOf } from "./build-tools.js";

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BridgeOffline) throw new Error(err.message);
    throw err;
  }
}

const content = (v: unknown) => ({
  content: [{ type: "text" as const, text: jsonText(v) }],
});

const variantProperties = z.record(z.string()).describe('Complete property map, e.g. {"Size":"Large","Tone":"Dark"}. Names and values cannot contain comma, equals or a new line.');

export function registerVariantTools(server: McpServer, client: FigmaClient, caps: Capabilities) {
  server.tool(
    "figma_variant_set",
    "Author a COMPONENT_SET as a property matrix in ONE transaction. action \"combine\" turns standalone COMPONENTs into a new set (names are replaced by the requested variant names), \"add\" clones an existing variant with a new property combination, and \"edit\" renames one variant in place. " +
      "The dry run (default) validates the whole matrix: every variant has the same property names, no combination is duplicated, the destination is not an INSTANCE, another set or a COMPONENT definition, and a combine destination is not inside one of its own variants. It returns per-component and per-set fingerprints plus the destination layout, so a changed document is refused before writing. " +
      "Apply with the returned planId and expectedFingerprints; it is one undo transaction. After writing, component names are read back as variantProperties and the set matrix is verified — a Figma that did not accept the name is rolled back, not reported as a success; if the undo itself fails, the error says ROLLBACK FAILED. Components already in a set are refused by combine; components inside an INSTANCE are refused. A combine destination inside a COMPONENT is refused because Figma will not reparent a component into a component definition; add and edit still operate on an existing set.",
    {
      action: z.enum(["combine", "add", "edit"]).describe("combine: standalone COMPONENTs -> new COMPONENT_SET | add: clone a variant with new properties | edit: rename one variant's properties"),
      components: z
        .array(
          z.object({
            nodeId: figmaNodeId("nodeId").optional().describe("A standalone COMPONENT; its id may be on any page, its key only on the current page"),
            key: z.string().optional().describe("Its stable key (pluginData), resolved on the current page"),
            properties: variantProperties,
          }),
        )
        .min(1)
        .max(50)
        .optional()
        .describe("combine: the components and the variant properties each one should represent"),
      name: z.string().optional().describe("combine: the new COMPONENT_SET name"),
      parentId: figmaNodeId("parentId").optional().describe("combine: where to create the set. Omit when all components already share a parent"),
      parentKey: z.string().optional().describe("combine: stable key of the destination, resolved on the current page"),
      sourceId: figmaNodeId("sourceId").optional().describe("add: the existing variant to clone"),
      sourceKey: z.string().optional().describe("add: stable key of the variant to clone, resolved on the current page"),
      variantId: figmaNodeId("variantId").optional().describe("edit: the variant to rename"),
      variantKey: z.string().optional().describe("edit: stable key of the variant to rename, resolved on the current page"),
      properties: variantProperties.optional().describe("add/edit: the new variant's complete property map"),
      index: z.number().int().min(0).optional().describe("add: insertion index inside the set; omitted appends"),
      dryRun: z.boolean().default(true).describe("TRUE (default): validate and fingerprint only. FALSE: apply in one undo transaction."),
      expectedFingerprints: z
        .record(z.string())
        .optional()
        .describe("Required on apply: nodeId -> fingerprint from the dry run, covering every component, the set and its destination layout."),
      planId: z
        .string()
        .optional()
        .describe("The planId returned by figma_variant_set; if supplied on apply, a different request is refused before it is sent"),
      fileKey: fileKeyParam,
    },
    async (a) =>
      guard(async () => {
        const exactlyOne = (id: string | undefined, key: string | undefined, label: string) => {
          const n = [id, key].filter((v) => v !== undefined && v !== null && String(v) !== "").length;
          if (n !== 1) throw new Error(`figma_variant_set ${label} needs exactly one of ${label === "combine parent" ? "parentId or parentKey" : label === "add source" ? "sourceId or sourceKey" : "variantId or variantKey"}`);
        };
        if (a.action === "combine") {
          if (!a.components?.length) throw new Error("figma_variant_set combine needs components[]");
          if (!a.name?.trim()) throw new Error("figma_variant_set combine needs a non-empty name");
          if (a.sourceId || a.sourceKey || a.variantId || a.variantKey || a.properties) {
            throw new Error("figma_variant_set combine takes components[].properties, not source/variant/properties");
          }
          if (a.index !== undefined) throw new Error("figma_variant_set combine appends the set; move it afterwards with figma_batch_edit if needed");
          if (a.parentId || a.parentKey) exactlyOne(a.parentId, a.parentKey, "combine parent");
        } else if (a.action === "add") {
          exactlyOne(a.sourceId, a.sourceKey, "add source");
          if (!a.properties || !Object.keys(a.properties).length) throw new Error("figma_variant_set add needs a non-empty properties map");
          if (a.components || a.name || a.parentId || a.parentKey || a.variantId || a.variantKey) {
            throw new Error("figma_variant_set add takes sourceId/sourceKey and properties; no components, name, parent or variant");
          }
        } else if (a.action === "edit") {
          exactlyOne(a.variantId, a.variantKey, "edit variant");
          if (!a.properties || !Object.keys(a.properties).length) throw new Error("figma_variant_set edit needs a non-empty properties map");
          if (a.components || a.name || a.parentId || a.parentKey || a.sourceId || a.sourceKey || a.index !== undefined) {
            throw new Error("figma_variant_set edit takes variantId/variantKey and properties; no components, name, parent, source or index");
          }
        }
        if (a.dryRun === false && !caps.write) {
          throw new Error(
            "figma_variant_set cannot apply: the bridge is registered in read-only mode (FIGMA_BRIDGE_WRITE=0). dryRun:true still works.",
          );
        }
        if (a.dryRun === false && (!a.expectedFingerprints || !Object.keys(a.expectedFingerprints).length)) {
          throw new Error("figma_variant_set apply needs expectedFingerprints from a dry run; run it with dryRun:true first.");
        }
        const pid = planIdOf(a);
        if (a.dryRun === false && a.planId && a.planId !== pid) {
          throw new Error(
            `PLAN_MISMATCH: this variant-set request hashes to ${pid}, not ${a.planId}. It changed since the dry run; run figma_variant_set with dryRun:true again.`,
          );
        }
        const result: any = await client.call("variant_set", { ...a, planId: pid }, 180_000);
        return content({ ...result, planId: pid });
      }),
  );
}
