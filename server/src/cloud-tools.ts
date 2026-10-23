/**
 * The optional Figma REST tools.
 *
 * They are registered only when `readCloudConfig()` returns `enabled`, so the
 * default local surface stays exactly the local bridge. The schemas still
 * validate everything: a cloud token is not a reason to let an agent send an
 * arbitrary path or an unbounded response back through the MCP process.
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { figmaNodeIds } from "./node-id.js";
import { jsonText } from "./tool-text.js";
import {
  CLOUD_DEFAULT_DOWNLOAD_TOTAL_BYTES,
  CLOUD_DEFAULT_IMAGE_MAX_BYTES,
  CLOUD_DEFAULT_MAX_BYTES,
  CLOUD_MAX_DOWNLOAD_NODES,
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

const downloadFormat = z
  .enum(["png", "jpg", "svg", "pdf"])
  .default("png")
  .describe("Rendered file format; the extension and the signature check follow this value");

const downloadMaxBytes = z
  .number()
  .int()
  .min(64_000)
  .max(32_000_000)
  .default(CLOUD_DEFAULT_IMAGE_MAX_BYTES)
  .describe("Refuse a single rendered image larger than this many bytes instead of writing it");

const downloadTotalBytes = z
  .number()
  .int()
  .min(64_000)
  .max(200_000_000)
  .default(CLOUD_DEFAULT_DOWNLOAD_TOTAL_BYTES)
  .describe("Refuse the whole call when the rendered images together exceed this many bytes");

const downloadOutDir = z
  .string()
  .min(1)
  .optional()
  .describe("Directory for the downloaded files; defaults to a temp directory and is created if missing");

/** A node id is not a filename: keep the readable shape but never allow a path separator. */
function safeNodeId(nodeId: string): string {
  return nodeId.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 120) || "node";
}

function downloadTarget(dir: string, nodeId: string, format: string): string {
  const target = resolve(dir, `figma-${safeNodeId(nodeId)}.${format}`);
  if (target !== dir && !target.startsWith(resolve(dir) + sep)) {
    throw new CloudError("CLOUD_DOWNLOAD_FAILED", "Refusing a download path outside outDir.");
  }
  return target;
}

/** The bytes must be the requested format, not an HTML error page behind a 200. */
function imageProblem(buffer: Buffer, format: string): string | null {
  if (buffer.length === 0) return "the download was empty";
  if (format === "png") {
    return buffer.length >= 8 && buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a"
      ? null
      : "PNG signature is missing";
  }
  if (format === "jpg") {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
      ? null
      : "JPEG signature is missing";
  }
  if (format === "pdf") {
    return buffer.subarray(0, 5).toString("ascii") === "%PDF-"
      ? null
      : "PDF signature is missing";
  }
  if (format === "svg") {
    const head = buffer
      .subarray(0, Math.min(buffer.length, 4_096))
      .toString("utf8")
      .replace(/^\uFEFF/, "")
      .trimStart();
    return head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))
      ? null
      : "SVG root element is missing";
  }
  return `unsupported format ${format}`;
}

const json = (v: unknown) => ({
  content: [{ type: "text" as const, text: jsonText(v) }],
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

  server.tool(
    "figma_cloud_download_image",
    "Download rendered nodes from a Figma file to a local directory over the REST API (the Figma document is untouched). This is the byte-downloading counterpart to figma_cloud_get_image: it calls /v1/images, fetches each temporary URL without sending the Figma token, verifies the PNG/JPEG/SVG/PDF signature, caps each file and the total, and refuses to overwrite unless overwrite:true. All downloads and signature checks finish before the first write; with overwrite:false a failed write removes the files this call created. Requires file_content:read and the same opt-in as the other cloud tools.",
    {
      fileKey,
      nodeIds: figmaNodeIds("nodeIds", CLOUD_MAX_DOWNLOAD_NODES),
      format: downloadFormat,
      scale: z.number().min(0.01).max(4).optional().describe("Render scale; Figma's endpoint decides the default"),
      svgOutlineText: z.boolean().optional().describe("SVG only: outline text"),
      svgIncludeId: z.boolean().optional().describe("SVG only: include element ids"),
      svgIncludeNodeId: z.boolean().optional().describe("SVG only: include data-node-id"),
      svgSimplifyStroke: z.boolean().optional().describe("SVG only: simplify strokes"),
      contentsOnly: z.boolean().optional().describe("Trim to the node's contents"),
      useAbsoluteBounds: z.boolean().optional().describe("Use absolute rather than render bounds"),
      version,
      outDir: downloadOutDir,
      overwrite: z
        .boolean()
        .default(false)
        .describe("Replace an existing target file; default false refuses before downloading anything"),
      maxBytes: downloadMaxBytes,
      maxTotalBytes: downloadTotalBytes,
    },
    async (a) =>
      cloudGuard(async () => {
        const nodeIds = [...new Set(a.nodeIds)];
        const format = a.format;
        const dir = resolve(a.outDir || join(tmpdir(), "figma-bridge-cloud-images"));

        const imageReply = await client.getImage({
          fileKey: a.fileKey,
          nodeIds,
          format,
          scale: a.scale,
          svgOutlineText: a.svgOutlineText,
          svgIncludeId: a.svgIncludeId,
          svgIncludeNodeId: a.svgIncludeNodeId,
          svgSimplifyStroke: a.svgSimplifyStroke,
          contentsOnly: a.contentsOnly,
          useAbsoluteBounds: a.useAbsoluteBounds,
          version: a.version,
          maxBytes: 1_000_000,
        });
        const imageData = imageReply.data as {
          images?: Record<string, unknown>;
          err?: unknown;
        };
        if (imageData?.err) {
          throw new CloudError(
            "CLOUD_BAD_RESPONSE",
            `Figma image render failed: ${JSON.stringify(imageData.err).slice(0, 500)}`,
            { requestId: imageReply.requestId },
          );
        }

        const images = imageData?.images;
        const entries: Array<{ nodeId: string; url: string }> = [];
        const missing: string[] = [];
        for (const nodeId of nodeIds) {
          const url = images?.[nodeId];
          if (typeof url === "string" && url) entries.push({ nodeId, url });
          else missing.push(nodeId);
        }
        if (missing.length > 0) {
          throw new CloudError(
            "CLOUD_BAD_RESPONSE",
            `Figma returned no image URL for: ${missing.join(", ")}.`,
            { requestId: imageReply.requestId },
          );
        }

        const targets = entries.map(({ nodeId }) => downloadTarget(dir, nodeId, format));
        if (!a.overwrite) {
          const existing = targets.filter((path) => existsSync(path));
          if (existing.length > 0) {
            throw new CloudError(
              "CLOUD_DOWNLOAD_FAILED",
              `Refusing to overwrite existing file(s): ${existing.join(", ")}. Pass overwrite:true to replace them.`,
              { requestId: imageReply.requestId },
            );
          }
        }

        const downloads: Array<{
          nodeId: string;
          target: string;
          data: Buffer;
          bytes: number;
          contentType?: string;
          urlHost: string;
          requestId?: string;
        }> = [];
        let totalBytes = 0;
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          const download = await client.downloadImage(entry.url, a.maxBytes);
          totalBytes += download.bytes;
          if (totalBytes > a.maxTotalBytes) {
            throw new CloudError(
              "CLOUD_RESPONSE_TOO_LARGE",
              `Downloaded images total ${totalBytes} bytes, over the ${a.maxTotalBytes}-byte limit; lower the scale, request fewer nodes, or raise maxTotalBytes.`,
              { maxBytes: a.maxTotalBytes, bytes: totalBytes, requestId: download.requestId || imageReply.requestId },
            );
          }
          const problem = imageProblem(download.data, format);
          if (problem) {
            throw new CloudError(
              "CLOUD_BAD_IMAGE",
              `Downloaded ${format} for ${entry.nodeId} is not valid: ${problem}.`,
              { bytes: download.bytes, requestId: download.requestId || imageReply.requestId },
            );
          }
          downloads.push({
            nodeId: entry.nodeId,
            target: targets[i],
            data: download.data,
            bytes: download.bytes,
            contentType: download.contentType,
            urlHost: new URL(download.url).host,
            requestId: download.requestId,
          });
        }

        try {
          mkdirSync(dir, { recursive: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new CloudError("CLOUD_DOWNLOAD_FAILED", `Could not create ${dir}: ${message}`);
        }

        const files: Array<{
          nodeId: string;
          path: string;
          bytes: number;
          sha256: string;
          contentType?: string;
          urlHost: string;
          requestId?: string;
        }> = [];
        const created: string[] = [];
        try {
          for (const download of downloads) {
            // openSync("wx") fails before creating if the target appeared after
            // the preflight. Track the file as soon as it is created so a
            // failed or partial write is removed, not left behind as a
            // plausible-looking image.
            const fd = openSync(download.target, a.overwrite ? "w" : "wx");
            created.push(download.target);
            try {
              writeFileSync(fd, download.data);
            } finally {
              closeSync(fd);
            }
            files.push({
              nodeId: download.nodeId,
              path: download.target,
              bytes: download.bytes,
              sha256: createHash("sha256").update(download.data).digest("hex"),
              contentType: download.contentType,
              urlHost: download.urlHost,
              requestId: download.requestId,
            });
          }
        } catch (err) {
          // With overwrite:false every `created` path was made by this call,
          // including a file whose write failed part-way, so removing them is
          // safe. With overwrite:true the old bytes are gone; report the failure
          // instead of pretending the directory is whole.
          if (!a.overwrite) {
            for (const path of created) {
              try { rmSync(path, { force: true }); } catch { /* best effort */ }
            }
          }
          const message = err instanceof Error ? err.message : String(err);
          throw new CloudError("CLOUD_DOWNLOAD_FAILED", `Could not write ${dir}: ${message}`);
        }

        return {
          ok: true,
          source: "figma-rest",
          fileKey: a.fileKey,
          format,
          dir,
          overwrite: a.overwrite,
          totalBytes,
          requestId: imageReply.requestId,
          files,
        };
      }),
  );
}
