import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FigmaClient } from "./figma.js";
import { figmaNodeId } from "./node-id.js";
import { fileKeyParam } from "./file-key.js";
import { BridgeOffline } from "./websocket.js";
import { jsonText } from "./tool-text.js";

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

export const AUDIT_RULE_IDS = [
  "duplicate-key",
  "unkeyed-node",
  "hardcoded-fill",
  "hardcoded-stroke",
  "unstyled-text",
  "placeholder-text",
  "detached-instance",
  "contrast",
  "default-name",
  "empty-text",
  "hardcoded-effect",
  "spacing",
  "radius",
] as const;

export function registerAuditTools(server: McpServer, client: FigmaClient) {
  server.tool(
    "figma_audit",
    "Read-only design-system audit of a page or subtree. Reports stable-key problems (duplicate keys, nodes added to a built tree without a key), literal fills/strokes that are neither a style nor a variable, text without a text style, placeholder copy, detached instances, WCAG AA contrast against the effective background, default layer names, and (opt-in) empty text, literal effects, off-scale spacing and off-scale radius. " +
      "Every finding carries nodeId, stable key, name, type, path, rule, severity and the value that caused it. With suggest:true (default) a hardcoded colour also carries exact local paint-style and colour-variable candidates, and unstyled text carries exact local text-style candidates; spacing/radius findings name the nearest on-scale value. It never edits the document.",
    {
      rootNodeId: figmaNodeId("rootNodeId")
        .optional()
        .describe("Page or subtree to audit; defaults to the current page"),
      rules: z
        .array(z.enum(AUDIT_RULE_IDS))
        .min(1)
        .optional()
        .describe(
          "Rules to run. Defaults to duplicate-key, unkeyed-node, hardcoded-fill, hardcoded-stroke, unstyled-text, placeholder-text, detached-instance, contrast, default-name. Add spacing, radius, empty-text or hardcoded-effect explicitly.",
        ),
      includeHidden: z.boolean().default(false).describe("Audit hidden layers too"),
      suggest: z
        .boolean()
        .default(true)
        .describe("Attach exact local paint-style, colour-variable and text-style candidates to findings; never applies them"),
      maxNodes: z.number().int().min(1).max(10000).default(2000).describe("Stop after this many visible nodes"),
      maxFindings: z.number().int().min(1).max(5000).default(200).describe("List at most this many findings; counts are still complete"),
      spacingScale: z
        .array(z.number().min(0))
        .optional()
        .describe("Allowed spacing values, e.g. [0,4,8,12,16,24,32]. When omitted, spacingMultiple is used."),
      spacingMultiple: z.number().positive().default(4).describe("Off-scale spacing means not a multiple of this"),
      radiusScale: z.array(z.number().min(0)).optional().describe("Allowed corner radii"),
      radiusMultiple: z.number().positive().default(4).describe("Off-scale radius means not a multiple of this"),
      fileKey: fileKeyParam,
    },
    async (a) =>
      guard(async () => {
        const result = await client.call("audit", a, 120_000);
        return content(result);
      }),
  );
}
