import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FigmaClient } from "./figma.js";
import { figmaNodeId } from "./node-id.js";
import { fileKeyParam } from "./file-key.js";
import { BridgeOffline } from "./websocket.js";
import { decodePng, diffImages, heatmapPng } from "./compare.js";

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BridgeOffline) throw new Error(err.message);
    throw err;
  }
}

/**
 * figma_compare — one render, one image on disk, one report.
 *
 * The bridge can already render any node (`figma_get_screenshot`) and write any
 * node to a file (`figma_download_assets`), so comparing two nodes is: export
 * one, compare the other against it. That keeps the tool to a single shape
 * instead of a matrix of sources, and it keeps the expected picture ON DISK —
 * where a later run can point at it, and where a human can open it next to the
 * heatmap. Nothing here touches the document, so it is registered in read-only
 * mode as well.
 *
 * The one piece of magic it refuses to do is guessing the scale: a reference
 * that is twice the size of the render is a mismatch, not a render to resize.
 * The report says so, and when the ratio is a clean integer it names the scale
 * the caller should have passed.
 */
export function registerCompareTool(server: McpServer, client: FigmaClient) {
  server.tool(
    "figma_compare",
    "Render a node and diff it against a PNG on disk — a mockup, an earlier export, or another node exported with figma_download_assets. Reports the differing area, its bounding box in the reference's own pixels (top-left origin, so a box can be cropped straight out of that PNG) and the largest clusters, and writes a heatmap. Anti-aliasing is absorbed by `tolerance`; a size mismatch is reported, never hidden. Read-only: the document is not touched.",
    {
      nodeId: figmaNodeId().describe("The node to render now"),
      reference: z.string().describe("Path to the PNG to compare against"),
      tolerance: z
        .number()
        .int()
        .min(0)
        .max(64)
        .default(8)
        .describe(
          "Per-channel difference that still counts as equal, 0..64 of 255. Two renders of the same node need a few counts (anti-aliasing, font hinting); a real edit is usually far above",
        ),
      scale: z
        .number()
        .min(0.1)
        .max(4)
        .default(1)
        .describe("Export scale for the render. Comparison is pixel-for-pixel, so a 2x mockup needs scale: 2"),
      outPath: z.string().optional().describe("Where to write the heatmap PNG; defaults to <reference>-diff.png"),
      inline: z.boolean().default(true).describe("Also return the heatmap as an image"),
      fileKey: fileKeyParam,
    },
    async (a) =>
      guard(async () => {
        const refPath = resolve(a.reference);
        if (!existsSync(refPath)) throw new Error(`reference image not found: ${refPath}`);
        const bytes = readFileSync(refPath);
        if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47) {
          throw new Error(`reference must be a PNG: ${refPath} (export one with figma_download_assets, format PNG)`);
        }
        const reference = decodePng(bytes);

        const { result: r, rev } = await client.callWithMeta<any>(
          "get_screenshot",
          { nodeId: a.nodeId, format: "PNG", scale: a.scale, fileKey: a.fileKey },
          90_000,
        );
        const render = decodePng(Buffer.from(r.base64, "base64"));

        const report = diffImages(reference, render, a.tolerance);
        const out = resolve(a.outPath ?? join(dirname(refPath), `${basename(refPath, extname(refPath))}-diff.png`));
        const heatmap = heatmapPng(reference, render, a.tolerance);
        writeFileSync(out, heatmap);

        // A clean integer ratio is the caller's own scale, mis-typed — worth
        // naming. Anything else stays a plain mismatch.
        const hint = scaleHint(report.reference, report.render);
        const summary = {
          identical: report.identical,
          different: report.different,
          total: report.total,
          ratioPercent: Number((report.ratio * 100).toFixed(2)),
          tolerance: report.tolerance,
          maxDelta: report.maxDelta,
          meanDelta: Number(report.meanDelta.toFixed(1)),
          sizeMismatch: report.sizeMismatch,
          hint,
          reference: { path: refPath, size: report.reference },
          render: { nodeId: r.nodeId, name: r.name, size: report.render, scale: r.scale, rev: rev ?? null },
          bbox: report.bbox,
          clusters: report.clusters,
          clustersTotal: report.clustersTotal,
          heatmap: out,
        };

        const caption =
          (report.identical
            ? `no difference at tolerance ${report.tolerance}`
            : `${report.different} px differ (${summary.ratioPercent}% of ${report.compared.width}x${report.compared.height} ` +
              `compared) at tolerance ${report.tolerance}`) +
          (report.bbox ? `, bbox ${report.bbox.join(",")}` : "") +
          `, rev ${rev ?? "?"} — heatmap: ${out}` +
          (hint ? `\n${hint}` : "") +
          (report.sizeMismatch && !hint
            ? `\nSizes differ (reference ${report.reference.join("x")} vs render ${report.render.join("x")}): ` +
              `the extra area counts as different.`
            : "");

        return {
          content: [
            { type: "text" as const, text: `${caption}\n\n${JSON.stringify(summary, null, 2)}` },
            ...(a.inline ? [{ type: "image" as const, data: heatmap.toString("base64"), mimeType: "image/png" }] : []),
          ],
        };
      }),
  );
}

/** Name the scale the caller probably meant, when the sizes are a clean multiple. */
export function scaleHint(reference: [number, number], render: [number, number]): string | null {
  const factors = [2, 3, 4];
  for (const f of factors) {
    const near = (x: number, y: number) => Math.abs(x / y - f) <= 0.05 * f;
    if (near(reference[0], render[0]) && near(reference[1], render[1])) {
      return `The reference is ${f}x the render: it was captured at scale ${f} — pass scale: ${f}.`;
    }
    if (near(render[0], reference[0]) && near(render[1], reference[1])) {
      return `The render is ${f}x the reference: it was captured at scale ${f} — pass scale: ${1 / f}.`;
    }
  }
  return null;
}
