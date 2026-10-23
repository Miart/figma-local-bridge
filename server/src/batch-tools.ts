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

const paintSchema = z.union([
  z.string().describe("A colour: #rrggbb, #rrggbbaa, rgb(...) or rgba(...)"),
  z
    .object({
      type: z.string().optional(),
      color: z.string().optional(),
      opacity: z.number().min(0).max(1).optional(),
      imageHash: z.string().optional(),
      scaleMode: z.enum(["FILL", "FIT", "CROP", "TILE"]).optional(),
      stops: z.array(z.object({ at: z.number(), color: z.string() })).optional(),
      gradientTransform: z.array(z.array(z.number())).optional(),
    })
    .passthrough(),
]);

const fontSchema = z.union([
  z.string().describe('"Inter/Regular" or "Inter:Regular"'),
  z.object({ family: z.string(), style: z.string().optional() }),
]);

const targetFields = {
  nodeId: figmaNodeId("nodeId").optional().describe("Target node id"),
  key: z
    .string()
    .min(1)
    .max(160)
    .optional()
    .describe("Stable key stored in pluginData (survives node re-creation; preferred over nodeId)"),
};

const layoutSchema = z
  .object({
    mode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]).optional(),
    gap: z.number().min(0).optional(),
    counterAxisSpacing: z.number().min(0).optional(),
    padding: z
      .union([
        z.number().min(0),
        z.array(z.number().min(0)).min(1).max(4),
        z.object({
          top: z.number().min(0).optional(),
          right: z.number().min(0).optional(),
          bottom: z.number().min(0).optional(),
          left: z.number().min(0).optional(),
        }),
      ])
      .optional(),
    align: z.enum(["MIN", "CENTER", "MAX", "SPACE_BETWEEN"]).optional(),
    crossAlign: z.enum(["MIN", "CENTER", "MAX", "BASELINE"]).optional(),
    wrap: z.enum(["NO_WRAP", "WRAP"]).optional(),
    clipsContent: z.boolean().optional(),
    sizing: z
      .object({
        horizontal: z.enum(["FIXED", "HUG", "FILL", "AUTO"]).optional(),
        vertical: z.enum(["FIXED", "HUG", "FILL", "AUTO"]).optional(),
        primaryAxis: z.enum(["FIXED", "HUG", "FILL", "AUTO"]).optional(),
        counterAxis: z.enum(["FIXED", "HUG", "FILL", "AUTO"]).optional(),
      })
      .optional(),
    minWidth: z.number().min(0).optional(),
    maxWidth: z.number().min(0).optional(),
    minHeight: z.number().min(0).optional(),
    maxHeight: z.number().min(0).optional(),
  })
  .passthrough();

const opSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("set_text"),
    ...targetFields,
    text: z.string().optional(),
    font: fontSchema.optional(),
    fontSize: z.number().positive().optional(),
    textStyle: z.string().optional().describe("Local text style name or id"),
    textAutoResize: z.enum(["NONE", "WIDTH_AND_HEIGHT", "HEIGHT", "TRUNCATE"]).optional(),
    hyperlink: z
      .object({ type: z.enum(["URL", "NODE"]), value: z.string().min(1) })
      .nullable()
      .optional()
      .describe("Set or clear a text hyperlink; URL, or a NODE link to a node id in the same file"),
  }),
  z.object({
    op: z.literal("set_name"),
    ...targetFields,
    name: z.string().min(1),
  }),
  z.object({
    op: z.literal("rename"),
    ...targetFields,
    name: z.string().min(1),
  }),
  z.object({
    op: z.literal("set_fill"),
    ...targetFields,
    fills: z.union([paintSchema, z.array(paintSchema)]).optional(),
    fillStyle: z.string().optional().describe("Local paint style name or id"),
  }),
  z.object({
    op: z.literal("set_stroke"),
    ...targetFields,
    strokes: z.union([paintSchema, z.array(paintSchema)]).optional(),
    strokeStyle: z.string().optional().describe("Local paint style name or id"),
    strokeWeight: z.number().min(0).optional(),
    strokeAlign: z.enum(["INSIDE", "OUTSIDE", "CENTER"]).optional(),
  }),
  z.object({
    op: z.literal("resize"),
    ...targetFields,
    width: z.number().positive(),
    height: z.number().positive(),
  }),
  z.object({
    op: z.literal("move"),
    ...targetFields,
    x: z.number(),
    y: z.number(),
    absolute: z.boolean().optional().describe("In an auto-layout parent, set layoutPositioning ABSOLUTE first"),
  }),
  z.object({
    op: z.literal("set_visible"),
    ...targetFields,
    visible: z.boolean(),
  }),
  z.object({
    op: z.literal("set_opacity"),
    ...targetFields,
    opacity: z.number().min(0).max(1),
  }),
  z.object({
    op: z.literal("set_rotation"),
    ...targetFields,
    rotation: z.number().describe("Degrees, clockwise; Figma's rotation property"),
  }),
  z.object({
    op: z.literal("set_layout"),
    ...targetFields,
    layout: layoutSchema,
  }),
  z.object({
    op: z.literal("set_variant"),
    ...targetFields,
    properties: z.record(z.union([z.string(), z.boolean()])),
  }),
  z.object({
    op: z.literal("set_constraints"),
    ...targetFields,
    constraints: z.object({ horizontal: z.string(), vertical: z.string() }),
  }),
  z.object({
    op: z.literal("duplicate"),
    ...targetFields,
    newKey: z.string().min(1).max(160).describe("Stable key for the clone. Re-running with the same key is a no-op."),
    name: z.string().optional(),
    parentId: figmaNodeId("parentId").optional().describe("Destination parent id; mutually exclusive with parentKey"),
    parentKey: z
      .string()
      .min(1)
      .max(160)
      .optional()
      .describe("Destination parent stable key, resolved on the current page; preferred over parentId"),
    x: z.number().optional(),
    y: z.number().optional(),
  }),
  z.object({
    op: z.literal("reparent"),
    ...targetFields,
    parentId: figmaNodeId("parentId").optional().describe("Destination parent id; mutually exclusive with parentKey"),
    parentKey: z
      .string()
      .min(1)
      .max(160)
      .optional()
      .describe("Destination parent stable key, resolved on the current page; preferred over parentId"),
    index: z.number().int().min(0).optional().describe("Final child index; omitted means append"),
    preserveAbsolute: z.boolean().optional().describe("Keep the node at the same on-canvas position (default true)"),
  }),
]);

export function registerBatchTools(server: McpServer, client: FigmaClient, caps: Capabilities) {
  server.tool(
    "figma_batch_edit",
    "Apply many small edits to many targets in ONE undo transaction, after resolving every target, font, style and component property in a dry run. " +
      "Targets are nodeId or stable key; a key is the better identity because it survives node re-creation. " +
      "Ops: set_text, set_name/rename, set_fill, set_stroke, resize, move, set_visible, set_opacity, set_rotation, set_layout, set_variant, set_constraints, duplicate, reparent. " +
      "duplicate and reparent accept a destination parentId or parentKey; the key is resolved on the current page. " +
      "dryRun defaults to TRUE and returns per-op plans plus a fingerprint per target and per non-page destination; apply with dryRun:false and the same expectedFingerprints. " +
      "A reparent index is the final child index; omitted appends. A same-parent reorder keeps layoutPositioning unchanged. " +
      "A failed op rolls the whole batch back unless stopOnError:false, which reports partial success and exactly which op failed.",
    {
      ops: z.array(opSchema).min(1).max(200).describe("Operations, applied in order"),
      dryRun: z.boolean().default(true).describe("TRUE (default): resolve and fingerprint only. FALSE: apply in one transaction."),
      stopOnError: z
        .boolean()
        .default(true)
        .describe("TRUE: any failed op rolls back the whole batch. FALSE: continue and report partial success."),
      expectedFingerprints: z
        .record(z.string())
        .optional()
        .describe("Map of nodeId -> fingerprint from the dry run. Apply refuses if any target moved since."),
      planId: z
        .string()
        .optional()
        .describe("The planId returned by figma_batch_edit; if supplied on apply, a different op list is refused."),
      fileKey: fileKeyParam,
    },
    async (a) =>
      guard(async () => {
        if (a.dryRun === false && !caps.write) {
          throw new Error(
            "figma_batch_edit cannot apply: the bridge is registered in read-only mode (FIGMA_BRIDGE_WRITE=0). dryRun:true still works.",
          );
        }
        const pid = planIdOf(a);
        if (a.dryRun === false && a.planId && a.planId !== pid) {
          throw new Error(
            `PLAN_MISMATCH: these ops hash to ${pid}, not ${a.planId}. They changed since the dry run; run figma_batch_edit again with dryRun:true.`,
          );
        }
        const result: any = await client.call("batch", { ...a, planId: pid }, 180_000);
        return content({ ...result, planId: pid });
      }),
  );
}
