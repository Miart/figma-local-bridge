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

export function registerIndexTools(server: McpServer, client: FigmaClient) {
  server.tool(
    "figma_index",
    "A compact flat index of a page or subtree, in document order: id, stable key, name, type, path, depth, visibility, size, child count, and the build root when the node is inside a figma_build/patch tree. Use it to find the shape of a page before inspecting one subtree. Read-only; stops at maxNodes and says so rather than returning a partial index that looks complete.",
    {
      rootNodeId: figmaNodeId("rootNodeId").optional().describe("Subtree root; defaults to the current page"),
      maxNodes: z.number().int().min(1).max(20000).default(1000).describe("Stop after this many visible nodes"),
      maxDepth: z.number().int().min(0).optional().describe("0 = root only; omitted = the whole subtree"),
      includeHidden: z.boolean().default(false).describe("Index hidden layers too"),
      includeText: z.boolean().default(false).describe("Include a 160-character text preview for TEXT nodes"),
      fileKey: fileKeyParam,
    },
    async (a) =>
      guard(async () => {
        const result = await client.call("index", a, 120_000);
        return content(result);
      }),
  );

  server.tool(
    "figma_search",
    "Find nodes by name, stable key or text without fetching the whole tree. Substring (default), regex or glob matching; filter by node type, key prefix, hasKey, or use no query with a filter. Returns compact node records with path, matched fields, a text snippet, build root and size. Read-only; maxNodes and maxResults are reported when hit.",
    {
      query: z.string().max(256).optional().describe("Text to find; omit when filtering only by types/keyPrefix/hasKey"),
      mode: z.enum(["substring", "regex", "glob"]).default("substring"),
      caseSensitive: z.boolean().default(false),
      fields: z
        .array(z.enum(["name", "key", "text"]))
        .min(1)
        .default(["name", "key", "text"])
        .describe("Where the query may match"),
      types: z.array(z.string()).min(1).optional().describe("Only these node types, e.g. ['TEXT','FRAME']"),
      keyPrefix: z.string().optional().describe("Only stable keys beginning with this prefix"),
      hasKey: z.boolean().optional().describe("true = keyed nodes only; false = unkeyed only"),
      rootNodeId: figmaNodeId("rootNodeId").optional().describe("Subtree root; defaults to the current page"),
      includeHidden: z.boolean().default(true).describe("Search hidden layers too"),
      maxNodes: z.number().int().min(1).max(50000).default(10000),
      maxResults: z.number().int().min(1).max(500).default(50),
      fileKey: fileKeyParam,
    },
    async (a) =>
      guard(async () => {
        const result = await client.call("search", a, 120_000);
        return content(result);
      }),
  );
}
