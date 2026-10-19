import { z } from "zod";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { FigmaClient } from "./figma.js";
import { figmaNodeId } from "./node-id.js";
import { fileKeyParam } from "./file-key.js";
import { BridgeOffline } from "./websocket.js";
import { pngSize } from "./compare.js";

/**
 * Export artefacts a build actually consumes: a sprite sheet plus the rects
 * that describe it, a 9-slice sprite, and the states of a button as files.
 *
 * The plugin measures, renders and builds the manifest; THIS side writes the
 * files and checks what landed on disk. The plugin already reads the PNG's IHDR,
 * so the check here is deliberately a second, independent one: the bytes are
 * re-read from the filesystem, the size re-parsed and compared against what the
 * manifest claims. A manifest describing an image nobody wrote is the failure
 * this pair exists to catch, and two checks that both run against the file are
 * cheap while one that trusts a promise is not.
 *
 * These tools never modify the document — they are reads, and they work with
 * write access off.
 */

type ToolResult = CallToolResult;

const text = (v: unknown): ToolResult => ({
  content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }],
});

async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BridgeOffline) throw new Error(err.message);
    throw err;
  }
}

const safe = (s: string) => s.replace(/[^\w.\- ]+/g, "_").slice(0, 80) || "node";
const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex").slice(0, 16);

function svgSize(svg: string): { width: number; height: number } | null {
  const direct = /<svg\b[^>]*?\bwidth="([\d.]+)"[^>]*?\bheight="([\d.]+)"/.exec(svg);
  if (direct) return { width: Number(direct[1]), height: Number(direct[2]) };
  const box = /<svg\b[^>]*?\bviewBox="[\d.\s-]*?([\d.]+)\s+([\d.]+)"/.exec(svg);
  if (box) return { width: Number(box[1]), height: Number(box[2]) };
  return null;
}

interface DiskFile {
  path: string;
  bytes: number;
  hash: string;
  width?: number;
  height?: number;
  /** False when the file on disk contradicts what the manifest claims. */
  matchesManifest?: boolean;
  error?: string;
  /** True when a file was already there and this write replaced it. */
  replaced?: boolean;
}

function writeChecked(
  path: string,
  data: Buffer,
  expected: { width: number; height: number } | null,
  kind: "png" | "svg",
): DiskFile {
  const replaced = existsSync(path);
  writeFileSync(path, data);
  const back = readFileSync(path);
  const out: DiskFile = { path, bytes: back.length, hash: sha(back) };
  if (replaced) out.replaced = true;
  const size = kind === "png" ? pngSize(back) : svgSize(back.toString("utf8"));
  if (!size) {
    out.error =
      kind === "png" ? "the file on disk is not a readable PNG" : "the SVG on disk has neither width/height nor a viewBox";
    if (expected) out.matchesManifest = false;
    return out;
  }
  out.width = size.width;
  out.height = size.height;
  if (expected) out.matchesManifest = size.width === expected.width && size.height === expected.height;
  return out;
}

/** The on-disk half of the verification, and the warnings it earns. */
function diskWarnings(disk: DiskFile, expected: { width: number; height: number } | null, warnings: string[]): void {
  if (disk.replaced) warnings.push(`wrote over an existing file: ${disk.path}`);
  if (disk.error) warnings.push(`on disk: ${disk.error}`);
  else if (disk.matchesManifest === false && expected) {
    warnings.push(
      `on disk: the file is ${disk.width}x${disk.height} while the manifest was built for ` +
        `${expected.width}x${expected.height} — the manifest does not describe this file`,
    );
  }
}

export function registerExportTools(server: McpServer, client: FigmaClient) {
  const call = <T = any>(m: string, p: Record<string, unknown> = {}, t = 60_000) => client.call<T>(m, p, t);

  server.tool(
    "figma_export_ui_atlas",
    "Export a sprite sheet for a game build: ONE PNG plus a JSON manifest whose rects are in that PNG's own pixels. " +
      "The sheet frame's DIRECT children are the sprites; nothing is repacked, so the layout stays the designer's. " +
      "The manifest names what would make the sheet unsliceable — overlapping rects, sprites off the image, drawing that bleeds " +
      "out of its cell, repeated names, coordinates that had to be rounded — and the file is re-read from disk afterwards to check " +
      "the manifest describes it. Returns the rects, so the caller can wire an engine up without opening the file.",
    {
      nodeId: figmaNodeId().optional().describe("The sheet frame whose direct children are the sprites; defaults to the single selected node"),
      scale: z.number().min(0.1).max(4).default(1).describe("Export scale; the rects are in the scaled file's pixels"),
      outDir: z.string().optional().describe("Where the PNG and the manifest go; defaults to a temp directory"),
      fileKey: fileKeyParam,
    },
    async (a) =>
      guard(async () => {
        const r = await call<any>("export_atlas", { nodeId: a.nodeId, scale: a.scale, fileKey: a.fileKey }, 180_000);
        const dir = resolve(a.outDir || join(tmpdir(), "figma-bridge-atlas"));
        mkdirSync(dir, { recursive: true });
        const base = safe(r.name);
        const expected = r.exportSize ?? null;
        const warnings: string[] = [...(r.manifest?.warnings ?? [])];
        const image = writeChecked(join(dir, `${base}.png`), Buffer.from(r.base64, "base64"), expected, "png");
        diskWarnings(image, expected, warnings);
        const manifestPath = join(dir, `${base}.atlas.json`);
        const manifest = {
          schema: "figma-atlas/v1",
          generatedAt: new Date().toISOString(),
          source: { fileKey: a.fileKey ?? null, nodeId: r.nodeId, name: r.name, rev: r.rev ?? null },
          image: {
            name: `${base}.png`,
            width: image.width ?? null,
            height: image.height ?? null,
            bytes: image.bytes,
            sha256_16: image.hash,
          },
          sheet: r.manifest.sheet,
          sprites: r.manifest.sprites,
          skipped: r.skipped,
          verification: {
            ...r.manifest.verification,
            disk: { bytes: image.bytes, sha256_16: image.hash, matchesManifest: image.matchesManifest !== false },
          },
          warnings,
        };
        const replaced = existsSync(manifestPath);
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        return text({
          dir,
          image: { path: image.path, width: image.width ?? null, height: image.height ?? null, bytes: image.bytes, sha256_16: image.hash },
          manifest: manifestPath,
          sheet: r.manifest.sheet,
          sprites: r.manifest.sprites,
          skipped: r.skipped,
          verification: manifest.verification,
          rev: r.rev ?? null,
          ...(replaced ? { replacedManifest: true } : {}),
          warnings,
        });
      }),
  );

  server.tool(
    "figma_export_9slice",
    "Export one sprite with its 9-slice insets: a PNG plus a descriptor (insets in the file's pixels, the stretchable middle, " +
      "and CSS `border-image` values with slices in image pixels and widths in design pixels, which is what a @2x image needs). " +
      "Pass insets, or leave a child layer named exactly `9slice` where the middle should stretch. Insets that leave no middle are " +
      "refused with the numbers that caused it; the file is re-read from disk to check the descriptor describes it.",
    {
      nodeId: figmaNodeId().optional().describe("The frame to slice; defaults to the single selected node"),
      insets: z
        .object({ top: z.number().min(0), right: z.number().min(0), bottom: z.number().min(0), left: z.number().min(0) })
        .optional()
        .describe("Design-pixel insets; overrides a `9slice` guide layer"),
      scale: z.number().min(0.1).max(4).default(1).describe("Export scale; slice numbers are in the scaled file's pixels"),
      outDir: z.string().optional().describe("Where the PNG and the descriptor go; defaults to a temp directory"),
      fileKey: fileKeyParam,
    },
    async (a) =>
      guard(async () => {
        const r = await call<any>("export_9slice", { nodeId: a.nodeId, insets: a.insets, scale: a.scale, fileKey: a.fileKey }, 180_000);
        const dir = resolve(a.outDir || join(tmpdir(), "figma-bridge-9slice"));
        mkdirSync(dir, { recursive: true });
        const base = safe(r.name);
        const expected = r.exportSize ?? null;
        const d = r.descriptor;
        const warnings: string[] = [...(d.warnings ?? [])];
        const image = writeChecked(join(dir, `${base}.png`), Buffer.from(r.base64, "base64"), expected, "png");
        diskWarnings(image, expected, warnings);
        const css = {
          borderImageSource: `url(${base}.png)`,
          borderImageSlice: d.cssBorderImageSlice,
          borderImageWidth: `${d.design.insets.top}px ${d.design.insets.right}px ${d.design.insets.bottom}px ${d.design.insets.left}px`,
          borderImageRepeat: "stretch",
        };
        const descriptorPath = join(dir, `${base}.9slice.json`);
        const replaced = existsSync(descriptorPath);
        writeFileSync(
          descriptorPath,
          JSON.stringify(
            {
              schema: "figma-9slice/v1",
              generatedAt: new Date().toISOString(),
              source: { fileKey: a.fileKey ?? null, nodeId: r.nodeId, name: r.name, rev: r.rev ?? null },
              image: { name: `${base}.png`, width: image.width ?? null, height: image.height ?? null, bytes: image.bytes, sha256_16: image.hash },
              scale: r.scale,
              guide: r.guide,
              design: d.design,
              exported: d.exported,
              middle: d.middle,
              css,
              verification: { disk: { bytes: image.bytes, sha256_16: image.hash, matchesManifest: image.matchesManifest !== false } },
              warnings,
            },
            null,
            2,
          ),
        );
        return text({
          dir,
          image: { path: image.path, width: image.width ?? null, height: image.height ?? null, bytes: image.bytes },
          descriptor: descriptorPath,
          scale: r.scale,
          guide: r.guide,
          design: d.design,
          exported: d.exported,
          middle: d.middle,
          css,
          rev: r.rev ?? null,
          ...(replaced ? { replacedDescriptor: true } : {}),
          warnings,
        });
      }),
  );

  server.tool(
    "figma_export_ui_states",
    "Export the states of a button/component as one file per state, plus a manifest naming them. A COMPONENT_SET names its variants " +
      "by property (the only property, or the one you pass as `property`); a frame names them by layer name. States with identical " +
      "bytes are reported — a hover that draws exactly like normal is usually a bug, though it can be deliberate. Every file is " +
      "re-read from disk: its size is checked against the node and its hash recorded.",
    {
      nodeId: figmaNodeId().optional().describe("A component set or a frame whose children are the states; defaults to the single selected node"),
      property: z.string().optional().describe("Which variant property names the states, when the set declares several"),
      format: z.enum(["PNG", "SVG"]).default("PNG").describe("SVG for icons (the file carries width/height), PNG otherwise"),
      scale: z.number().min(0.1).max(4).default(1).describe("PNG scale; files are named @2x, @3x … when it is not 1"),
      outDir: z.string().optional().describe("Where the files go; defaults to a temp directory"),
      fileKey: fileKeyParam,
    },
    async (a) =>
      guard(async () => {
        const r = await call<any>(
          "export_ui_states",
          { nodeId: a.nodeId, property: a.property, format: a.format, scale: a.scale, fileKey: a.fileKey },
          180_000,
        );
        const dir = resolve(a.outDir || join(tmpdir(), "figma-bridge-states"));
        mkdirSync(dir, { recursive: true });
        const base = safe(r.name);
        const suffix = a.scale !== 1 ? `@${a.scale}x` : "";
        const warnings: string[] = [...(r.warnings ?? [])];
        const byHash = new Map<string, string[]>();
        const files: any[] = [];
        for (const f of r.files ?? []) {
          if (f.error) {
            files.push({ key: f.key, id: f.id, name: f.name, error: f.error });
            continue;
          }
          const ext = a.format === "PNG" ? "png" : "svg";
          const name = `${safe(f.key)}${suffix}.${ext}`;
          const data = a.format === "PNG" ? Buffer.from(f.base64, "base64") : Buffer.from(f.text, "utf8");
          const expected = a.format === "PNG" ? f.exportSize ?? null : null;
          const disk = writeChecked(join(dir, name), data, expected, a.format === "PNG" ? "png" : "svg");
          diskWarnings(disk, expected, warnings);
          const state = (r.states ?? []).find((s: any) => s.id === f.id) ?? {};
          const group = byHash.get(disk.hash) ?? [];
          group.push(name);
          byHash.set(disk.hash, group);
          files.push({
            key: f.key,
            id: f.id,
            name: f.name,
            file: name,
            path: disk.path,
            width: disk.width ?? state.width ?? null,
            height: disk.height ?? state.height ?? null,
            bytes: disk.bytes,
            sha256_16: disk.hash,
          });
        }
        for (const group of byHash.values()) {
          if (group.length > 1) {
            warnings.push(
              `${group.join(" and ")} are byte-identical — a state that draws exactly like another is usually a bug ` +
                `(the variant is not what its name says), though it can be deliberate`,
            );
          }
        }
        const manifestPath = join(dir, `${base}.states.json`);
        const replaced = existsSync(manifestPath);
        writeFileSync(
          manifestPath,
          JSON.stringify(
            {
              schema: "figma-ui-states/v1",
              generatedAt: new Date().toISOString(),
              source: { fileKey: a.fileKey ?? null, nodeId: r.nodeId, name: r.name, type: r.type, rev: r.rev ?? null },
              property: r.property,
              format: r.format,
              scale: r.scale,
              states: files,
              warnings,
            },
            null,
            2,
          ),
        );
        return text({
          dir,
          manifest: manifestPath,
          property: r.property,
          format: r.format,
          scale: r.scale,
          files,
          rev: r.rev ?? null,
          ...(replaced ? { replacedManifest: true } : {}),
          warnings,
        });
      }),
  );
}
