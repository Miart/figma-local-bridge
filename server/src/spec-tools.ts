import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FigmaClient } from "./figma.js";
import { figmaNodeId } from "./node-id.js";
import { fileKeyParam } from "./file-key.js";
import { BridgeOffline } from "./websocket.js";

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BridgeOffline) throw new Error(err.message);
    throw err;
  }
}

const content = (v: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }],
});

export function registerSpecTools(server: McpServer, client: FigmaClient) {
  server.tool(
    "figma_export_build_spec",
    "Turn a live subtree into a figma_build spec. Keys that are already stored are kept; nodes without one get the same derived key the build engine would choose. Fills, strokes and effects use styles or variables when the node is linked to them, and plain values otherwise. " +
      "The reply is deliberately lossy and says where: unsupported node types, SVG source that the Plugin API cannot read, instance interiors, mixed fonts, per-corner radii and unrepresentable paints are listed under unsupported/warnings. " +
      "Read-only; never modifies the file. A truncated export is marked truncated and must not be built as-is.",
    {
      nodeId: figmaNodeId().optional().describe("Subtree root; defaults to the single selected node"),
      maxNodes: z.number().int().min(1).max(2000).default(500).describe("Stop after this many nodes; sets truncated"),
      maxDepth: z.number().int().min(0).max(64).default(32).describe("Stop below this depth; skipped nodes are reported"),
      includeHidden: z.boolean().default(true).describe("Include hidden layers in the spec"),
      fileKey: fileKeyParam,
    },
    async (a) =>
      guard(async () => {
        const result = await client.call("export_spec", a, 120_000);
        return content(result);
      }),
  );
}
