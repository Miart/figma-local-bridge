/**
 * The optional Figma REST tools.
 *
 * They are registered only when `readCloudConfig()` returns `enabled`, so the
 * default local surface stays exactly the local bridge. The schemas still
 * validate everything: a cloud token is not a reason to let an agent send an
 * arbitrary path or an unbounded response back through the MCP process.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { figmaNodeIds } from "./node-id.js";
import {
  CLOUD_DEFAULT_MAX_BYTES,
  CloudClient,
  CloudError,
  type CloudConfig,
} from "./cloud.js";

const fileKey = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_-]+$/, {
    message: "a Figma REST file key uses letters, digits, '-' or '_'",
  })
  .describe("Figma file key from the file URL; this reads that file, not the open one");

const maxBytes = z
  .number()
  .int()
  .min(64_000)
  .max(32_000_000)
  .default(CLOUD_DEFAULT_MAX_BYTES)
  .describe(
    "Refuse a response larger than this many bytes instead of serialising a huge document; narrow nodeIds/depth when it fires",
  );

const depth = z
  .number()
  .int()
  .min(0)
  .max(10)
  .optional()
  .describe("Figma REST depth; omitted means the endpoint's own full subtree");

const version = z.string().min(1).optional().describe("Figma file version id to read");

const pluginData = z
  .enum(["shared", "all"])
  .optional()
  .describe("Figma REST plugin_data visibility");

const json = (v: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }],
});

const failure = (err: CloudError) => ({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify({ ok: false, source: "figma-rest", error: err.toJSON() }, null, 2),
    },
  ],
  isError: true,
});

async function cloudGuard(fn: () => Promise<unknown>) {
  try {
    return json(await fn());
  } catch (err) {
    if (err instanceof CloudError) return failure(err);
    throw err;
  }
}

export function registerCloudTools(server: McpServer, config: CloudConfig) {
  if (!config.enabled) return;
  const client = new CloudClient(config);

  server.tool(
    "figma_cloud_ping",
    "Optional read-only Figma REST adapter health check. Validates FIGMA_CLOUD_TOKEN (PAT) or FIGMA_CLOUD_OAUTH_TOKEN (OAuth) against GET /v1/me and reports the account. It does not need the local daemon, never returns the token, and requires the current_user:read scope.",
    {},
    async () =>
      cloudGuard(async () => {
        const r = await client.me();
        return {
          ok: true,
          source: "figma-rest",
          apiBase: config.apiBase,
          auth: config.tokenKind,
          requestId: r.requestId,
          user: r.data,
        };
      }),
  );

  server.tool(
    "figma_cloud_get_file",
    "Read a file's JSON over the Figma REST API (read-only; does not need the local daemon). Use nodeIds and depth to keep the response small; a response over maxBytes is refused, never truncated. Set FIGMA_CLOUD=1 and a token to register this tool.",
    {
      fileKey,
      nodeIds: figmaNodeIds("nodeIds", 50).optional().describe("Read only these nodes instead of the whole file"),
      depth,
      version,
      geometry: z.boolean().optional().describe("Include vector geometry paths"),
      pluginData,
      maxBytes,
    },
    async (a) =>
      cloudGuard(async () => {
        const r = await client.getFile({
          fileKey: a.fileKey,
          nodeIds: a.nodeIds,
          depth: a.depth,
          version: a.version,
          geometry: a.geometry,
          pluginData: a.pluginData,
          maxBytes: a.maxBytes,
        });
        return {
          ok: true,
          source: "figma-rest",
          fileKey: a.fileKey,
          bytes: r.bytes,
          requestId: r.requestId,
          data: r.data,
        };
      }),
  );

  server.tool(
    "figma_cloud_get_nodes",
    "Read specific nodes from a Figma file over the REST API (read-only; does not need the local daemon). nodeIds is required; a response over maxBytes is refused, never truncated.",
    {
      fileKey,
      nodeIds: figmaNodeIds("nodeIds", 50),
      depth,
      version,
      geometry: z.boolean().optional().describe("Include vector geometry paths"),
      pluginData,
      maxBytes,
    },
    async (a) =>
      cloudGuard(async () => {
        const r = await client.getNodes({
          fileKey: a.fileKey,
          nodeIds: a.nodeIds,
          depth: a.depth,
          version: a.version,
          geometry: a.geometry,
          pluginData: a.pluginData,
          maxBytes: a.maxBytes,
        });
        return {
          ok: true,
          source: "figma-rest",
          fileKey: a.fileKey,
          bytes: r.bytes,
          requestId: r.requestId,
          data: r.data,
        };
      }),
  );

  server.tool(
    "figma_cloud_get_image",
    "Get temporary render URLs for nodes from a Figma file over the REST API (read-only; does not need the local daemon). This returns URLs, not downloaded files; treat them as temporary. Over maxBytes is refused, never truncated.",
    {
      fileKey,
      nodeIds: figmaNodeIds("nodeIds", 50),
      format: z.enum(["png", "jpg", "svg", "pdf"]).default("png"),
      scale: z.number().min(0.01).max(4).optional().describe("Render scale; Figma's endpoint decides the default"),
      svgOutlineText: z.boolean().optional().describe("SVG only: outline text"),
      svgIncludeId: z.boolean().optional().describe("SVG only: include element ids"),
      svgIncludeNodeId: z.boolean().optional().describe("SVG only: include data-node-id"),
      svgSimplifyStroke: z.boolean().optional().describe("SVG only: simplify strokes"),
      contentsOnly: z.boolean().optional().describe("Trim to the node's contents"),
      useAbsoluteBounds: z.boolean().optional().describe("Use absolute rather than render bounds"),
      version,
      maxBytes,
    },
    async (a) =>
      cloudGuard(async () => {
        const r = await client.getImage({
          fileKey: a.fileKey,
          nodeIds: a.nodeIds,
          format: a.format,
          scale: a.scale,
          svgOutlineText: a.svgOutlineText,
          svgIncludeId: a.svgIncludeId,
          svgIncludeNodeId: a.svgIncludeNodeId,
          svgSimplifyStroke: a.svgSimplifyStroke,
          contentsOnly: a.contentsOnly,
          useAbsoluteBounds: a.useAbsoluteBounds,
          version: a.version,
          maxBytes: a.maxBytes,
        });
        return {
          ok: true,
          source: "figma-rest",
          fileKey: a.fileKey,
          bytes: r.bytes,
          requestId: r.requestId,
          note: "image URLs are temporary; this tool does not download them",
          data: r.data,
        };
      }),
  );
}
