import { z } from "zod";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { FigmaClient } from "./figma.js";
import { figmaNodeId, figmaNodeIds } from "./node-id.js";
import { fileKeyParam } from "./file-key.js";
import { BridgeOffline } from "./websocket.js";
import type { Capabilities } from "./tools.js";

/**
 * Tools that mirror the official Figma MCP server, implemented over the local
 * plugin bridge. Names are prefixed `figma_`.
 *
 * Not possible from a plugin (cloud-only in the official server): create_new_file,
 * generate_figma_design, generate_diagram, shaders, Weave, export_video,
 * Code Connect cloud sync/suggestions.
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

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };
const safe = (s: string) => s.replace(/[^\w.\- ]+/g, "_").slice(0, 80) || "node";

export function registerParityTools(server: McpServer, client: FigmaClient, caps: Capabilities) {
  const call = <T = any>(m: string, p: Record<string, unknown> = {}, t = 60_000) => client.call<T>(m, p, t);
  /** Same, but keeps the envelope facts (rev, replayed) the tool may report. */
  const callMeta = <T = any>(m: string, p: Record<string, unknown> = {}, t = 60_000) =>
    client.callWithMeta<T>(m, p, t);

  // ------------------------------------------------------------------ reads

  server.tool(
    "figma_whoami",
    "Current Figma user, open file (name/key/editor type), pages and viewport. With several files connected, pass fileKey — its reply names the file it actually read.",
    { fileKey: fileKeyParam },
    async (a) => guard(async () => text(await call("whoami", { fileKey: a.fileKey }))),
  );

  server.tool(
    "figma_get_metadata",
    "Sparse XML outline of a node/page/selection: type, id, name, position and size. Cheap; use it to find ids before get_design_context or get_screenshot.",
    {
      nodeId: figmaNodeId().optional().describe("Defaults to the single selected node, else the current page"),
      depth: z.number().int().min(0).max(12).default(6),
      fileKey: fileKeyParam,
    },
    async (a) =>
      guard(async () => {
        const r = await call<{ xml: string; nodes: number; truncated: boolean }>("get_metadata", a);
        return text(r.xml + (r.truncated ? `\n<!-- truncated at ${r.nodes} nodes; pass a deeper nodeId -->\n` : ""));
      }),
  );

  server.tool(
    "figma_get_design_context",
    "Full design description of a node for implementing it in code: layout (auto layout, padding, gap, sizing), fills/strokes/effects as hex, text runs with font/size/weight/line-height, style and variable names, component/instance info and properties.",
    {
      nodeId: figmaNodeId().optional().describe("Defaults to the single selected node"),
      depth: z.number().int().min(0).max(8).default(4),
      fileKey: fileKeyParam,
    },
    async (a) => guard(async () => text(await call("get_design_context", a))),
  );

  server.tool(
    "figma_get_layout_tree",
    "Absolute-geometry snapshot of a subtree in ONE call: per node — parent, size, absoluteTransform (2x3 matrix), absolute layout and render bounds, clip flag. Measured in document-absolute space, the same space a PNG export uses, so it is what you check a rebuild or an atlas against instead of one get_node per layer. The screenshot is a SEPARATE call (`atomicWithScreenshot: false`): geometry first, then capture, and compare `rev`.",
    {
      nodeId: figmaNodeId().optional().describe("Scene node to snapshot; defaults to the single selected node"),
      maxNodes: z.number().int().min(1).max(5000).default(2000).describe("Truncation budget; `truncated` says when it was hit"),
      fileKey: fileKeyParam,
    },
    async (a) => guard(async () => text(await call("get_layout_tree", a))),
  );

  server.tool(
    "figma_get_screenshot",
    "Render a node as PNG/JPG (returned as an image) or SVG (returned as text).",
    {
      nodeId: figmaNodeId().optional().describe("Defaults to the single selected node"),
      format: z.enum(["PNG", "JPG", "SVG"]).default("PNG"),
      scale: z.number().min(0.1).max(4).default(1),
      fileKey: fileKeyParam,
    },
    async (a) =>
      guard(async () => {
        const { result: r, rev } = await callMeta<any>("get_screenshot", a, 90_000);
        if (r.format === "SVG") return text(r.text);
        return {
          content: [
            { type: "image" as const, data: r.base64, mimeType: r.format === "JPG" ? "image/jpeg" : "image/png" },
            {
              type: "text" as const,
              // rev belongs on the caption, not hidden in a log: two captures
              // with identical bytes and a different rev are proof that the
              // render is stale (Figma caches exports and the Plugin API cannot
              // invalidate that cache), not proof that the edit did nothing.
              text:
                `${r.name} (${r.nodeId}) ${r.width}x${r.height} @${r.scale}x, ${r.bytes} bytes, rev ${rev ?? "?"}. ` +
                `Compare rev with the previous capture: same bytes AND a higher rev means the render is stale, not that nothing changed.`,
            },
          ],
        };
      }),
  );

  server.tool(
    "figma_get_variable_defs",
    "Variables (design tokens) used by a node's subtree, or all local variables when nothing is selected/given. Returns a flat name→value map plus per-mode values.",
    { nodeId: figmaNodeId().optional(), fileKey: fileKeyParam },
    async (a) => guard(async () => text(await call("get_variable_defs", a))),
  );

  server.tool(
    "figma_get_libraries",
    "Variable collections available in this file: local ones and those enabled from team libraries.",
    { fileKey: fileKeyParam },
    async (a) => guard(async () => text(await call("get_libraries", { fileKey: a.fileKey }))),
  );

  server.tool(
    "figma_search_design_system",
    "Search components, styles and variables (local file, plus library variable collections) by name/description. All words in the query must match.",
    {
      query: z.string(),
      kinds: z.array(z.enum(["components", "styles", "variables"])).optional(),
      limit: z.number().int().min(1).max(100).default(25),
      fileKey: fileKeyParam,
    },
    async (a) => guard(async () => text(await call("search_design_system", a, 120_000))),
  );

  server.tool(
    "figma_get_figjam",
    "Read a FigJam board: stickies, shapes with text, connectors (with endpoints), sections and text. Fails in a regular Figma file.",
    { nodeId: figmaNodeId().optional(), fileKey: fileKeyParam },
    async (a) => guard(async () => text(await call("get_figjam", a))),
  );

  server.tool(
    "figma_download_assets",
    "Export nodes to files on disk (PNG/JPG/SVG/PDF) and return the paths.",
    {
      nodeIds: figmaNodeIds("nodeIds", 50),
      format: z.enum(["PNG", "JPG", "SVG", "PDF"]).default("PNG"),
      scale: z.number().min(0.1).max(4).default(2),
      outDir: z.string().optional().describe("Defaults to a temp directory"),
      fileKey: fileKeyParam,
    },
    async ({ nodeIds, format, scale, outDir, fileKey }) =>
      guard(async () => {
        const r = await call<{ files: any[] }>("export_nodes", { nodeIds, format, scale, fileKey }, 180_000);
        const dir = resolve(outDir || join(tmpdir(), "figma-bridge-assets"));
        mkdirSync(dir, { recursive: true });
        const saved = r.files.map((f) => {
          if (f.error) return { nodeId: f.nodeId, error: f.error };
          const path = join(dir, `${safe(f.name)}-${f.nodeId.replace(/[:;]/g, "_")}.${format.toLowerCase()}`);
          writeFileSync(path, Buffer.from(f.base64, "base64"));
          return { nodeId: f.nodeId, path, bytes: f.bytes };
        });
        return text({ dir, files: saved });
      }),
  );

  server.tool(
    "figma_get_code_connect_map",
    "Local Code Connect mapping stored on a node (and on its main component for instances). Stored in this file's shared plugin data; not synced with Figma's cloud Code Connect.",
    { nodeId: figmaNodeId().optional(), fileKey: fileKeyParam },
    async (a) => guard(async () => text(await call("get_code_connect_map", a))),
  );

  server.tool(
    "figma_set_selection",
    "Select nodes in the Figma editor and scroll them into view. The only way to move the user's cursor — use it to hand work over ('look at what I just built') instead of making them hunt for it on a huge canvas. Editor state only; the document is not modified.",
    {
      nodeIds: figmaNodeIds("nodeIds").describe("Node ids to select"),
      zoom: z.boolean().default(true).describe("Scroll and zoom the viewport to the selection"),
      fileKey: fileKeyParam,
    },
    async (a) => guard(async () => text(await call("set_selection", a))),
  );

  server.tool(
    "figma_set_page",
    "Switch the Figma editor to another page. Editor state only; the document is not modified.",
    { name: z.string().describe("Exact page name"), fileKey: fileKeyParam },
    async (a) => guard(async () => text(await call("set_page", a))),
  );

  server.tool(
    "figma_list_file_components_for_code_connect",
    "Every component and component set in the file, with ids, names, page and size — the inventory you need before wiring up Code Connect mappings.",
    { allPages: z.boolean().default(true).describe("Search every page, not just the current one"), fileKey: fileKeyParam },
    async (a) => guard(async () => text(await call("list_file_components", a))),
  );

  server.tool(
    "figma_get_font_inventory",
    "Which fonts the file actually uses, counted by text node (family / style). Consistency work needs this: a design system that claims one typeface and quietly uses three is the usual failure.",
    { allPages: z.boolean().default(true).describe("Count every page, not just the current one"), fileKey: fileKeyParam },
    async (a) => guard(async () => text(await call("get_font_inventory", a))),
  );

  // ----------------------------------------------------------------- writes

  if (!caps.write) return;

  server.tool(
    "figma_use",
    "Run Plugin API JavaScript inside the open Figma file (async function body; `figma` and a capturing `console` are in scope; `return` a value to get it back). One call = one undo step. " +
      "SAFETY: arbitrary code cannot be sandboxed, so the plugin indexes the page before and after, and ROLLS BACK the call if anything outside `scopeNodeId` was created, deleted, reparented or altered, if the scope root itself disappeared, or if page-global state (variables/styles/paints) changed. " +
      "Known limits: fire-and-forget async work that lands after the diff is not covered, and edits inside an existing node are detected only by a cheap signature (type, name, child count, text length), not pixel-exact. " +
      "Requires allowDestructive:true, and scopeNodeId unless allowPageWide:true. Prefer small calls and return the ids you create. " +
      "A third argument `flb` is a small helper set for this manifest's traps (dynamic-page mode, font loading, absolute vs parent-relative coordinates): " +
      "`await flb.byId(id)` resolves a node id (figma.getNodeById throws in dynamic-page mode; the error says an id from another file never resolves); " +
      "`flb.find({within, name, match, type})` / `flb.one(...)` search descendants and refuse to answer with a truncated list or an ambiguous pick; " +
      "`flb.bbox(node, {render:true})` gives ABSOLUTE bounds (render bounds include shadows/strokes — the ones packing needs); " +
      "`flb.clear(node)` removes children and returns what went; " +
      "`flb.flatten(node)` detaches every instance in a subtree (outermost first) and throws rather than leave it half flat; " +
      "`flb.grid(nodes, {parent, cell, columns, gap, origin, fit})` lays nodes out in uniform atlas cells at ABSOLUTE coordinates, optionally scaling them down to fit; " +
      "`await flb.text(content, {parent, x, y, size, font, fills})` loads the font before writing characters. " +
      "The write helpers refuse a target outside scopeNodeId, or on a page other than the current one (the scope guard only indexes one page), BEFORE writing anything.",
    {
      code: z.string().describe("Body of an async function. Example: `const f = figma.createFrame(); f.name='Card'; return f.id`"),
      allowDestructive: z.boolean().describe("Must be true. Acknowledges that this runs arbitrary Plugin API code."),
      scopeNodeId: figmaNodeId("scopeNodeId").optional().describe("The only subtree the code may touch. Anything outside is rolled back. Required unless allowPageWide."),
      allowPageWide: z.boolean().optional().default(false).describe("Run unconfined — refused by default."),
      allowGlobalChanges: z.boolean().optional().default(false).describe("Permit variables/styles/paints changes, which are not inside any subtree."),
      verbose: z.boolean().optional().default(false).describe("Return full node objects instead of the compact id/type/name form."),
      description: z.string().optional().describe("One line on what this does (for the log)"),
      timeoutMs: z.number().int().min(1000).max(110_000).default(30_000),
      fileKey: fileKeyParam,
    },
    async ({ code, allowDestructive, scopeNodeId, allowPageWide, allowGlobalChanges, verbose, timeoutMs, fileKey }) =>
      guard(async () => {
        if (!caps.destructive) {
          throw new Error(
            "figma_use is disabled: this bridge runs with FIGMA_BRIDGE_DESTRUCTIVE=0. " +
              "Set it to 1 in the MCP server environment to allow arbitrary Plugin API code.",
          );
        }
        if (!allowDestructive) {
          throw new Error("figma_use requires allowDestructive: true.");
        }
        if (!scopeNodeId && !allowPageWide) {
          throw new Error(
            "figma_use requires scopeNodeId naming the subtree the code may touch, " +
              "or allowPageWide: true to run unconfined.",
          );
        }
        const { result: r, rev, replayed } = await callMeta<any>(
          "use_figma",
          { code, allowDestructive, scopeNodeId, allowPageWide, allowGlobalChanges, verbose, timeoutMs, fileKey },
          timeoutMs + 15_000,
        );
        return text({
          result: r.result,
          logs: Array.isArray(r.logs) && r.logs.length ? r.logs : undefined,
          changedPage: r.changed,
          effects: r.effects,
          // The two facts that make a later screenshot interpretable: which
          // document revision this answer belongs to, and whether the code even
          // ran (a replayed answer means a retry was served from the opId cache).
          rev,
          replayed: replayed || undefined,
          // Where the time went. `index` is the page scan that guards the call;
          // when it approaches the timeout the page is too big for one call and
          // the work should be split. `nodes` is the size the guard compared.
          ms: r.ms,
          nodes: r.nodes,
        });
      }),
  );

  server.tool(
    "figma_upload_assets",
    "Import local image files (PNG/JPG/GIF/WEBP) into Figma as rectangles with an image fill, or apply one as the fill of an existing node.",
    {
      paths: z.array(z.string()).min(1).max(20).describe("Absolute paths of image files"),
      parentId: figmaNodeId("parentId").optional().describe("Where to place new rectangles (default: current page)"),
      targetNodeId: figmaNodeId("targetNodeId").optional().describe("Apply the first image as this node's fill instead of creating a rectangle"),
      x: z.number().optional(),
      y: z.number().optional(),
      scaleMode: z.enum(["FILL", "FIT", "CROP", "TILE"]).default("FILL"),
      fileKey: fileKeyParam,
    },
    async ({ paths, ...rest }) =>
      guard(async () => {
        const files = paths.map((p) => {
          const ext = extname(p).slice(1).toLowerCase();
          if (!MIME[ext] || ext === "svg") throw new Error(`unsupported image type for ${p} (use PNG/JPG/GIF/WEBP; SVG via figma_use createNodeFromSvg)`);
          const buf = readFileSync(p);
          if (buf.length > 20 * 1024 * 1024) throw new Error(`${p} is larger than 20MB`);
          return { name: basename(p, extname(p)), base64: buf.toString("base64") };
        });
        return text(await call("import_images", { files, ...rest }, 180_000));
      }),
  );

  server.tool(
    "figma_add_code_connect_map",
    "Attach a local Code Connect mapping (source file + component name) to a node. Stored in shared plugin data in this file.",
    {
      nodeId: figmaNodeId(),
      source: z.string().describe("Path or URL of the code component"),
      componentName: z.string(),
      label: z.string().optional(),
      language: z.string().optional(),
      fileKey: fileKeyParam,
    },
    async (a) => guard(async () => text(await call("add_code_connect_map", a))),
  );
}
