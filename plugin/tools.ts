/// <reference types="@figma/plugin-typings" />

/**
 * Figma-MCP-parity tools, plugin side.
 *
 * Everything the official Figma MCP can do that is possible from inside a
 * plugin: run Plugin API code, read metadata / design context / variables,
 * screenshots, asset export + import, design-system search, FigJam reads and a
 * local Code Connect map. (Cloud-only features — create_new_file,
 * generate_figma_design, shaders, Weave — cannot be done from a plugin.)
 *
 * WRITES: every mutating handler runs through `transact`, which brackets it with
 * commitUndo() and, on failure AFTER the first write, commitUndo()+triggerUndo().
 * Rolling back a call that never wrote would revert the user's previous step, so
 * rollback is gated on `mark()` (or, for arbitrary code, a page nodechange).
 */

type Json = any;
import { indexTree, indexGlobals, enforceScope } from "./scope";
import { current as currentRev } from "./rev";
import { snapshot, STRICT } from "./fingerprint";
import { DUMP_SCHEMA, LIMITATIONS, dumpSubtree, restoreSubtree } from "./checkpoint";
import { sessionKey } from "./session-key";
import { makeHelpers } from "./helpers";
import { atlasManifest, nineSliceDescriptor, pngSize, stateList } from "./exports";

const NS = "figma-local-bridge";
const MAX_NODES = 1500;

// ---------------------------------------------------------------- generic

const round = (n: number) => Math.round(n * 100) / 100;
const isMixed = (v: any) => v === figma.mixed;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exports are capped at 4x on the plugin side (Figma's own dialog goes to 4x). */
const clampScale = (v: any, dflt: number) => Math.min(Math.max(Number(v) || dflt, 0.1), 4);

/** A plain absolute box, or null when the node has none (empty frames, lines). */
function box4(b: any): { x: number; y: number; width: number; height: number } | null {
  if (!b) return null;
  return { x: round(b.x), y: round(b.y), width: round(b.width), height: round(b.height) };
}

/**
 * Which box the exported image actually is, when a node has a stroke.
 *
 * `absoluteBoundingBox` includes strokes; `absoluteTransform` + `width`/`height`
 * is the node's own box. Figma exports one of the two depending on the node, and
 * a rect computed against the wrong origin is off by the stroke width — the
 * kind of error that survives review because everything still looks plausible.
 * The exported file's own size decides which; when neither matches, the bounding
 * box is used and the caller is warned that the rects may be offset.
 */
function exportBasis(node: any, size: { width: number; height: number } | null, scale: number) {
  const bbox = box4(node.absoluteBoundingBox);
  const t = node.absoluteTransform;
  const nodeBox = t && node.width && node.height
    ? { x: round(t[0][2]), y: round(t[1][2]), width: round(node.width), height: round(node.height) }
    : null;
  if (!bbox && !nodeBox) throw new Error(`"${node.name}" has no bounds to export`);
  if (!bbox) return { box: nodeBox!, basis: "nodeBox" as const };
  if (!nodeBox) return { box: bbox, basis: "boundingBox" as const };
  const same =
    Math.abs(bbox.x - nodeBox.x) < 0.01 && Math.abs(bbox.y - nodeBox.y) < 0.01 &&
    Math.abs(bbox.width - nodeBox.width) < 0.01 && Math.abs(bbox.height - nodeBox.height) < 0.01;
  if (same || !size) return { box: bbox, basis: "boundingBox" as const };
  const fitsBbox = Math.round(bbox.width * scale) === size.width && Math.round(bbox.height * scale) === size.height;
  const fitsNode = Math.round(nodeBox.width * scale) === size.width && Math.round(nodeBox.height * scale) === size.height;
  if (fitsNode && !fitsBbox) return { box: nodeBox, basis: "nodeBox" as const };
  return { box: bbox, basis: "boundingBox" as const, ambiguous: true };
}


function hex(c: RGB | RGBA, opacity?: number): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0");
  const a = "a" in c ? (c as RGBA).a : opacity === undefined ? 1 : opacity;
  const o = opacity === undefined ? a : a * opacity;
  return "#" + h(c.r) + h(c.g) + h(c.b) + (o < 1 ? h(o) : "");
}

const nameCache = new Map<string, string>();
async function varName(id: string): Promise<string> {
  if (nameCache.has(id)) return nameCache.get(id)!;
  let n = id;
  try {
    const v = await figma.variables.getVariableByIdAsync(id);
    if (v) n = v.name;
  } catch {
    /* library variable not resolvable */
  }
  nameCache.set(id, n);
  return n;
}
async function styleName(id: any): Promise<string | null> {
  if (!id || isMixed(id)) return null;
  try {
    const s = await figma.getStyleByIdAsync(id);
    return s ? s.name : null;
  } catch {
    return null;
  }
}

/** Runs `fn(mark)` as one undo step; rolls back only if it had started writing. */
async function transact<T>(fn: (mark: () => void) => Promise<T>): Promise<T> {
  let wrote = false;
  figma.commitUndo();
  try {
    const out = await fn(() => { wrote = true; });
    figma.commitUndo();
    return out;
  } catch (err: any) {
    let rolled = false;
    if (wrote) {
      try { figma.commitUndo(); figma.triggerUndo(); rolled = true; } catch { /* ignore */ }
    }
    const e = new Error(String(err && err.message ? err.message : err) + (rolled ? " (rolled back)" : ""));
    throw e;
  }
}

/**
 * Resolves a node id, refusing anything that is no longer in the document.
 *
 * `getNodeByIdAsync` hands back a cached node for an id that has since been
 * deleted. Such a node still answers `name`, `type` and often `width`, so it
 * reads as perfectly healthy and a tool will happily report the state of
 * something that no longer exists — which is worse than an error, because it
 * looks like data. `removed` is the flag Figma sets on exactly those nodes.
 */
async function nodeOrSelectionOrPage(id?: string): Promise<BaseNode> {
  if (id) {
    const n: any = await figma.getNodeByIdAsync(id);
    if (!n) throw new Error("node not found: " + id);
    if (n.removed === true) {
      throw new Error(
        `node ${id} ("${n.name}") has been removed from the document. ` +
          `The id resolved from a stale cache, so its properties would be misleading.`,
      );
    }
    return n;
  }
  const sel = figma.currentPage.selection;
  if (sel.length === 1) return sel[0];
  return figma.currentPage;
}

// ---------------------------------------------------------------- serializing paints etc.

function paints(list: any): Json {
  if (isMixed(list)) return "mixed";
  if (!Array.isArray(list) || !list.length) return undefined;
  return list
    .filter((p: Paint) => p.visible !== false)
    .map((p: any) => {
      if (p.type === "SOLID") return { type: "SOLID", color: hex(p.color, p.opacity) };
      if (p.type.startsWith("GRADIENT")) {
        return {
          type: p.type,
          stops: p.gradientStops.map((s: ColorStop) => ({ at: round(s.position), color: hex(s.color) })),
          opacity: p.opacity,
        };
      }
      if (p.type === "IMAGE") return { type: "IMAGE", imageHash: p.imageHash, scaleMode: p.scaleMode };
      return { type: p.type };
    });
}

function effects(list: any): Json {
  if (isMixed(list)) return "mixed";
  if (!Array.isArray(list) || !list.length) return undefined;
  return list
    .filter((e: Effect) => e.visible !== false)
    .map((e: any) => ({
      type: e.type,
      radius: e.radius,
      ...(e.offset ? { offset: [e.offset.x, e.offset.y] } : {}),
      ...(e.spread ? { spread: e.spread } : {}),
      ...(e.color ? { color: hex(e.color) } : {}),
    }));
}

/**
 * A stroke weight readback. `MIXED` alone says only that the sides differ — not
 * which side, nor by how much — and a caller comparing two nodes then has to
 * answer INCONCLUSIVE about a property the plugin can plainly see. The four
 * per-side weights are that truth, in [top, right, bottom, left] order, the
 * same shape cornerRadius already uses.
 */
function strokeWeight(node: any): Json {
  if (!isMixed(node.strokeWeight)) return node.strokeWeight;
  if (!("strokeTopWeight" in node)) return "mixed";
  return [node.strokeTopWeight, node.strokeRightWeight, node.strokeBottomWeight, node.strokeLeftWeight];
}

/**
 * The variable modes a node PINS.
 *
 * A frame that pins a mode renders exactly like one that inherits it, and the
 * difference decides whether re-wrapping a design in a new frame changes it —
 * invisible otherwise, because the resolved set mixes pinned and inherited
 * modes. Emitted only when something is pinned. Ids are resolved to
 * collection/mode names the way variable names are, because that is what an
 * agent (and a human reading a diff) can act on; a mode whose library is not
 * loaded keeps its id.
 */
async function explicitModes(node: any): Promise<Json> {
  const raw = node.explicitVariableModes;
  if (!raw || typeof raw !== "object") return undefined;
  const out: Json = {};
  for (const [collectionId, modeId] of Object.entries(raw as Record<string, string>)) {
    let key = collectionId;
    let value = String(modeId);
    try {
      const col = await figma.variables.getVariableCollectionByIdAsync(collectionId);
      if (col) {
        key = col.name;
        value = col.modes.find((m) => m.modeId === modeId)?.name ?? value;
      }
    } catch { /* unknown collection: the ids still tell the two modes apart */ }
    out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

async function boundNames(node: any): Promise<Json> {
  const bv = node.boundVariables;
  if (!bv) return undefined;
  const out: Json = {};
  for (const [field, val] of Object.entries(bv)) {
    const list = Array.isArray(val) ? val : [val];
    const names: string[] = [];
    for (const a of list as any[]) if (a && a.id) names.push(await varName(a.id));
    if (names.length) out[field] = names.length === 1 ? names[0] : names;
  }
  return Object.keys(out).length ? out : undefined;
}

// ---------------------------------------------------------------- design context

async function fullNode(node: any, depth: number, budget: { n: number; truncated: boolean }): Promise<Json> {
  budget.n++;
  const out: Json = { id: node.id, type: node.type, name: node.name };
  if (node.visible === false) out.visible = false;
  if ("x" in node && node.type !== "PAGE") {
    out.x = round(node.x); out.y = round(node.y);
    out.width = round(node.width); out.height = round(node.height);
  }
  if ("rotation" in node && node.rotation) out.rotation = round(node.rotation);
  if ("opacity" in node && node.opacity !== 1) out.opacity = node.opacity;
  if ("blendMode" in node && node.blendMode !== "PASS_THROUGH" && node.blendMode !== "NORMAL") out.blendMode = node.blendMode;

  if ("layoutMode" in node && node.layoutMode !== "NONE") {
    out.layout = {
      mode: node.layoutMode,
      gap: node.itemSpacing,
      padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft],
      primaryAlign: node.primaryAxisAlignItems,
      counterAlign: node.counterAxisAlignItems,
      ...(node.layoutWrap === "WRAP" ? { wrap: true, counterGap: node.counterAxisSpacing } : {}),
    };
  }
  if ("layoutSizingHorizontal" in node) out.sizing = [node.layoutSizingHorizontal, node.layoutSizingVertical];
  if ("layoutPositioning" in node && node.layoutPositioning === "ABSOLUTE") out.absolute = true;
  if ("constraints" in node && node.parent && !("layoutMode" in node.parent && node.parent.layoutMode !== "NONE")) {
    out.constraints = [node.constraints.horizontal, node.constraints.vertical];
  }

  if ("fills" in node) { const f = paints(node.fills); if (f) out.fills = f; }
  if ("strokes" in node) {
    const s = paints(node.strokes);
    if (s) out.stroke = { paints: s, weight: strokeWeight(node), align: node.strokeAlign };
  }
  if ("cornerRadius" in node) {
    if (isMixed(node.cornerRadius)) out.cornerRadius = [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius];
    else if (node.cornerRadius) out.cornerRadius = node.cornerRadius;
  }
  if ("effects" in node) { const e = effects(node.effects); if (e) out.effects = e; }
  if ("clipsContent" in node && node.clipsContent && node.type === "FRAME") out.clips = true;

  const styles: Json = {};
  for (const k of ["fillStyleId", "strokeStyleId", "effectStyleId", "textStyleId", "gridStyleId"]) {
    if (k in node) { const n = await styleName(node[k]); if (n) styles[k.replace("StyleId", "")] = n; }
  }
  if (Object.keys(styles).length) out.styles = styles;
  const vars = await boundNames(node);
  if (vars) out.variables = vars;
  const modes = await explicitModes(node);
  if (modes) out.explicitModes = modes;

  if (node.type === "TEXT") {
    out.text = node.characters;
    try {
      const segs = node.getStyledTextSegments(["fontName", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "fills", "textStyleId"]);
      out.runs = [];
      for (const s of segs) {
        out.runs.push({
          text: s.characters,
          font: s.fontName.family + " " + s.fontName.style,
          size: s.fontSize,
          weight: s.fontWeight,
          lineHeight: s.lineHeight.unit === "AUTO" ? "auto" : round(s.lineHeight.value) + (s.lineHeight.unit === "PERCENT" ? "%" : "px"),
          letterSpacing: s.letterSpacing.value ? round(s.letterSpacing.value) + (s.letterSpacing.unit === "PERCENT" ? "%" : "px") : undefined,
          color: paints(s.fills),
          style: await styleName(s.textStyleId),
        });
      }
    } catch { /* fonts unavailable */ }
    out.align = [node.textAlignHorizontal, node.textAlignVertical];
  }
  if (node.type === "INSTANCE") {
    try {
      const main = await node.getMainComponentAsync();
      if (main) out.component = { id: main.id, name: main.name, key: main.key, remote: main.remote };
    } catch { /* ignore */ }
    const props = node.componentProperties;
    if (props && Object.keys(props).length) {
      out.properties = Object.fromEntries(Object.entries(props).map(([k, v]: any) => [k, v.value]));
    }
  }
  if (node.type === "COMPONENT") {
    out.key = node.key;
    if (node.description) out.description = node.description;
  }
  if (node.type === "COMPONENT_SET") out.key = node.key;
  if (node.type === "STICKY" || node.type === "SHAPE_WITH_TEXT" || node.type === "CODE_BLOCK") {
    try { out.text = node.text ? node.text.characters : node.code; } catch { /* ignore */ }
  }
  if (node.type === "CONNECTOR") {
    out.from = node.connectorStart && "endpointNodeId" in node.connectorStart ? node.connectorStart.endpointNodeId : null;
    out.to = node.connectorEnd && "endpointNodeId" in node.connectorEnd ? node.connectorEnd.endpointNodeId : null;
    try { out.text = node.text.characters || undefined; } catch { /* ignore */ }
  }

  if ("children" in node && node.children.length) {
    if (depth <= 0) {
      out.childCount = node.children.length;
    } else {
      out.children = [];
      for (const c of node.children) {
        if (budget.n >= MAX_NODES) { budget.truncated = true; break; }
        out.children.push(await fullNode(c, depth - 1, budget));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- metadata (XML)

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function xml(node: any, depth: number, budget: { n: number; truncated: boolean }, indent: string): string {
  budget.n++;
  const tag = String(node.type).toLowerCase().replace(/_/g, "-");
  let attrs = ` id="${node.id}" name="${esc(node.name)}"`;
  if ("x" in node && node.type !== "PAGE") {
    attrs += ` x="${round(node.x)}" y="${round(node.y)}" width="${round(node.width)}" height="${round(node.height)}"`;
  }
  if (node.visible === false) attrs += ` hidden="true"`;
  if (node.type === "TEXT") attrs += ` text="${esc(node.characters.slice(0, 80))}"`;
  const kids: any[] = "children" in node ? node.children : [];
  if (!kids.length || depth <= 0) {
    if (kids.length) attrs += ` children="${kids.length}"`;
    return indent + `<${tag}${attrs} />\n`;
  }
  let s = indent + `<${tag}${attrs}>\n`;
  for (const c of kids) {
    if (budget.n >= MAX_NODES * 2) { budget.truncated = true; break; }
    s += xml(c, depth - 1, budget, indent + "  ");
  }
  return s + indent + `</${tag}>\n`;
}

// ---------------------------------------------------------------- layout snapshot

/** A rectangle as four rounded numbers, or null when the node has none. */
function bbox(v: any): Json | null {
  return v ? { x: round(v.x), y: round(v.y), width: round(v.width), height: round(v.height) } : null;
}

/**
 * One row of the layout snapshot.
 *
 * Deliberately narrower than `describe`/`fullNode`: this is the geometry the
 * RENDERER used, not the design intent. Fields a node type does not carry are
 * absent, never zeroed — a zero would read as a real measurement.
 */
function layoutEntry(n: any): Json {
  const entry: Json = { id: n.id, parentId: n.parent ? n.parent.id : null, name: n.name, type: n.type };
  if (n.visible === false) entry.visible = false;
  if ("width" in n) entry.size = [round(n.width), round(n.height)];
  if ("absoluteTransform" in n && Array.isArray(n.absoluteTransform)) {
    entry.absoluteTransform = n.absoluteTransform.map((row: number[]) => row.map((v) => round(v)));
  }
  if ("absoluteBoundingBox" in n) entry.boundingBox = bbox(n.absoluteBoundingBox);
  if ("absoluteRenderBounds" in n) entry.renderBounds = bbox(n.absoluteRenderBounds);
  if ("clipsContent" in n && n.clipsContent) entry.clips = true;
  return entry;
}

// ---------------------------------------------------------------- variables

async function formatVar(v: Variable): Promise<Json> {
  const col = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
  const modes = col ? col.modes : [];
  const values: Json = {};
  for (const m of modes) {
    const raw: any = v.valuesByMode[m.modeId];
    if (raw && typeof raw === "object" && raw.type === "VARIABLE_ALIAS") values[m.name] = { alias: await varName(raw.id) };
    else if (raw && typeof raw === "object" && "r" in raw) values[m.name] = hex(raw);
    else values[m.name] = raw;
  }
  return { id: v.id, name: v.name, type: v.resolvedType, collection: col ? col.name : null, values };
}

function collectAliases(obj: any, into: Set<string>, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 6) return;
  if (obj.type === "VARIABLE_ALIAS" && obj.id) { into.add(obj.id); return; }
  if (Array.isArray(obj)) { for (const x of obj) collectAliases(x, into, depth + 1); return; }
  for (const k of Object.keys(obj)) collectAliases(obj[k], into, depth + 1);
}

function walk(node: any, fn: (n: any) => void, budget = { n: 0 }) {
  if (budget.n++ > 20000) return;
  fn(node);
  if ("children" in node) for (const c of node.children) walk(c, fn, budget);
}

// ---------------------------------------------------------------- results for use_figma

/**
 * Fields worth carrying when a node-like object survives `plain`.
 *
 * Not a generic dump: Plugin API nodes keep almost everything behind prototype
 * getters, so `Object.keys` would expose internals rather than the things an
 * agent actually reads. This is the list that answers "what does this node
 * actually look like" in one round trip.
 */
const NODE_FIELDS = [
  "x", "y", "width", "height", "rotation",
  "visible", "locked", "opacity", "blendMode",
  "fills", "strokes", "strokeWeight", "strokeAlign", "cornerRadius",
  "layoutMode", "layoutSizingHorizontal", "layoutSizingVertical", "itemSpacing",
  "paddingLeft", "paddingRight", "paddingTop", "paddingBottom",
  "constraints", "characters", "fontSize", "fontName", "textAlignHorizontal",
  "clipsContent", "counterAxisSizingMode",
];

const isNodeLike = (v: any) =>
  typeof v === "object" && typeof v.id === "string" && typeof v.type === "string" && "name" in v;

/**
 * Serialises a Plugin API result for transport.
 *
 * A bare node is collapsed to `{id, type, name}` because that is what the JSON
 * wire format can carry safely — and because the default has to stay cheap
 * enough for a 10k-node page. The catch is that this discarded `width`, `fills`,
 * `layoutMode` and everything else without saying so, so reading a node's real
 * state cost another round trip every single time. `verbose` opts into the
 * curated field list instead.
 */
function plain(v: any, depth = 0, verbose = false): any {
  if (v === undefined) return null;
  if (v === null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return v.length > 100_000 ? v.slice(0, 100_000) + "…[truncated]" : v;
  if (typeof v === "symbol") return v === figma.mixed ? "mixed" : String(v.description);
  if (typeof v === "function") return "[function]";
  if (depth > 6) return "[max depth]";
  if (v instanceof Uint8Array) return `[Uint8Array ${v.length}]`;
  if (Array.isArray(v)) return v.slice(0, 500).map((x) => plain(x, depth + 1, verbose));
  if (isNodeLike(v)) {
    const base: Json = { id: v.id, type: v.type, name: v.name };
    if (!verbose) return base;
    const extra: Json = {};
    for (const k of NODE_FIELDS) {
      try {
        if (v[k] !== undefined) extra[k] = plain(v[k], depth + 1, verbose);
      } catch {
        /* not every node type carries every field */
      }
    }
    return { ...base, ...extra };
  }
  const out: Json = {};
  for (const k of Object.keys(v).slice(0, 200)) {
    try { out[k] = plain(v[k], depth + 1, verbose); } catch { out[k] = "[unreadable]"; }
  }
  return out;
}

// ---------------------------------------------------------------- tools

/**
 * Methods that write to the document, or move state the document is read
 * against (the current page, the selection). The dispatcher runs these strictly
 * one at a time, because `figma.commitUndo()` / `triggerUndo()` mark ONE global
 * undo boundary: two writes in flight can undo each other's work.
 *
 * A NEW METHOD THAT WRITES MUST BE LISTED HERE. Nothing enforces it
 * automatically — test/dispatch.test.mjs checks only that every name listed
 * exists, so an omission fails silently, as a rare corruption.
 */
export const MUTATING_METHODS: ReadonlySet<string> = new Set([
  "use_figma",
  "import_images",
  "add_code_connect_map",
  "set_page",
  "set_selection",
  "checkpoint_restore",
]);

export const toolMethods: Record<string, (p: Json) => Promise<Json>> = {
  /** Run Plugin API code. `figma` and a capturing `console` are in scope. */
  async use_figma(p: Json) {
    if (typeof p.code !== "string" || !p.code.trim()) throw new Error("code is required");

    // Opt-in has to be explicit per call. This tool hands over the whole Plugin
    // API, so it must never fire as a side effect of a plausible-looking call.
    if (p.allowDestructive !== true) {
      throw new Error(
        "use_figma runs arbitrary Plugin API code, which can destroy the file. " +
          "Pass allowDestructive: true to run it, and scopeNodeId to name the subtree it may touch.",
      );
    }

    const pageWide = p.allowPageWide === true;
    const scopeRootId: string | null = p.scopeNodeId ? String(p.scopeNodeId) : null;
    if (!scopeRootId && !pageWide) {
      throw new Error(
        "use_figma requires scopeNodeId (the subtree the code may touch). " +
          "Pass allowPageWide: true to run unconfined, which is refused by default.",
      );
    }
    const allowGlobal = p.allowGlobalChanges === true;

    const timeoutMs = Math.min(Math.max(Number(p.timeoutMs) || 30_000, 1000), 110_000);

    const logs: string[] = [];
    const cap = (lvl: string) => (...a: any[]) => {
      if (logs.length < 200) logs.push((lvl === "log" ? "" : lvl + ": ") + a.map((x) => (typeof x === "string" ? x : JSON.stringify(plain(x)))).join(" "));
    };
    const con = { log: cap("log"), info: cap("log"), warn: cap("warn"), error: cap("error") };

    let changed = false;
    // The scope check rolls back ITSELF before throwing. Without this guard the
    // catch block would undo a second time, and that second undo reverts the
    // USER's previous step instead of our own — silently undoing their work.
    let alreadyRolledBack = false;
    const page = figma.currentPage;
    const onChange = () => { changed = true; };
    page.on("nodechange", onChange);

    // Scope root must exist BEFORE the code runs; if it is gone afterwards we
    // cannot prove containment and must treat the whole call as unverified.
    if (scopeRootId && !(await figma.getNodeByIdAsync(scopeRootId))) {
      throw new Error("scopeNodeId not found: " + scopeRootId + ". Nothing was run.");
    }
    // Always index the WHOLE page, even when scoped, otherwise changes outside the
    // scope would be invisible — which is the entire point of declaring it.
    const t0 = Date.now();
    const beforeTree = indexTree(page);
    const beforeGlobals = indexGlobals(figma);
    const beforeMs = Date.now() - t0;

    figma.commitUndo();
    // A page switch while the code runs would move the ground under the diff
    // below: this call indexes ONE page, so edits made on another page after
    // figma.setCurrentPageAsync() are invisible to the guard. Watch for the
    // event rather than only comparing figma.currentPage afterwards — the code
    // can switch away and back, leaving currentPage identical and the other
    // page silently edited.
    let pageSwitched = false;
    const onPageChange = () => { pageSwitched = true; };
    figma.on("currentpagechange", onPageChange);
    let timedOut = false;
    try {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      // `flb` is the snippet standard library (plugin/helpers.ts): the Plugin
      // API with this manifest's traps named — dynamic-page getters, font
      // loading, absolute vs parent-relative coordinates, instance flattening.
      // It is built per call so the write helpers know the declared scope and
      // can refuse an out-of-scope target BEFORE writing it.
      const fn = new AsyncFunction("figma", "console", "flb", p.code);
      const codePromise = fn(figma, con, makeHelpers(figma, { scopeRootId, pageWide }));
      // A timeout leaves this promise running: it is now a zombie that can keep
      // writing. Its eventual rejection must not surface as an unhandled
      // rejection in Figma's console, where it would look unrelated to us.
      codePromise.catch(() => {});
      let timer: any;
      const result = await Promise.race([
        codePromise,
        new Promise((_, rej) => { timer = setTimeout(() => { timedOut = true; rej(new Error("use_figma timed out after " + timeoutMs + "ms")); }, timeoutMs); }),
      ]);
      clearTimeout(timer);
      // nodechange is delivered asynchronously; let the tree settle before diffing
      // or every real change reads as "unchanged".
      await sleep(120);

      const tDiff = Date.now();
      const afterTree = indexTree(page);
      const diffMs = Date.now() - tDiff;
      const verdict = enforceScope({
        before: beforeTree,
        after: afterTree,
        beforeGlobals,
        afterGlobals: indexGlobals(figma),
        scopeRootId,
        pageWide,
        allowGlobalChanges: allowGlobal,
        pageSwitched,
      });

      if (!verdict.ok) {
        figma.commitUndo();
        figma.triggerUndo();
        alreadyRolledBack = true;
        // Advice has to match the violation: telling someone to widen the scope
        // does not help when the problem was switching pages mid-call.
        const advice = pageSwitched
          ? "Do not switch pages inside use_figma — one call per page, or use the figma_set_page tool first."
          : "Declare a wider scopeNodeId, or set allowPageWide/allowGlobalChanges if that was intended.";
        throw new Error(
          "use_figma REFUSED and rolled back — " + verdict.violations.join("; ") + ". " + advice,
        );
      }

      figma.commitUndo();
      return {
        ok: true,
        result: plain(result, 0, p.verbose === true),
        logs,
        changed,
        effects: verdict.effects,
        // The page index dominates this call on a large document, so it is
        // measured rather than guessed at. If `ms.index` approaches the call
        // timeout, the page is too big to guard cheaply and the work should be
        // split rather than run as one call.
        ms: { code: Date.now() - t0 - beforeMs - diffMs, index: beforeMs + diffMs, total: Date.now() - t0 },
        nodes: { before: beforeTree.size, after: afterTree.size },
      };
    } catch (err: any) {
      await sleep(80); // nodechange is delivered asynchronously
      let rolledBack = alreadyRolledBack;
      // A timed-out snippet is a ZOMBIE: Promise.race stopped waiting, but the
      // code keeps running and will write MORE after any rollback we do now.
      // Rolling back would therefore both lie ("(rolled back)") and leave a
      // half-edited document nobody is watching. So a timeout never rolls back;
      // it says exactly what is true instead.
      const zombie = timedOut && !alreadyRolledBack && changed;
      if (changed && !alreadyRolledBack && !zombie) {
        try { figma.commitUndo(); figma.triggerUndo(); rolledBack = true; } catch { /* ignore */ }
      }
      let suffix = "";
      if (rolledBack) suffix = " (rolled back)";
      else if (zombie) suffix = " (NOT rolled back: the code is still running and may still write — inspect the scope before trusting it)";
      else if (timedOut) suffix = " (timed out; the code may still be running)";
      else if (changed) suffix = " (changes could not be rolled back)";

      const e: any = new Error(String(err && err.message ? err.message : err) + suffix);
      if (logs.length) e.message += "\nconsole output before the error:\n" + logs.join("\n");
      throw e;
    } finally {
      try { page.off("nodechange", onChange); } catch { /* page gone */ }
      try { figma.off("currentpagechange", onPageChange); } catch { /* ignore */ }
    }
  },

  async get_metadata(p: Json) {
    const node = await nodeOrSelectionOrPage(p.nodeId);
    const budget = { n: 0, truncated: false };
    const depth = p.depth === undefined ? 6 : p.depth;
    const text = xml(node, depth, budget, "");
    return { xml: text, nodes: budget.n, truncated: budget.truncated };
  },

  async get_design_context(p: Json) {
    const node = await nodeOrSelectionOrPage(p.nodeId);
    const budget = { n: 0, truncated: false };
    const tree = await fullNode(node, p.depth === undefined ? 4 : p.depth, budget);
    return { tree, nodes: budget.n, truncated: budget.truncated, page: figma.currentPage.name };
  },

  /**
   * Absolute geometry snapshot of a subtree.
   *
   * The `x`/`y` our other readers return are relative to the parent — useless
   * for checking a rebuild against a rendered PNG. This is the other coordinate
   * space: `absoluteTransform` and the absolute boxes are the numbers the
   * rasteriser actually used, so N nodes can be verified in one call instead of
   * N `get_node`s.
   *
   * The screenshot stays a SEPARATE call, and `capture` echoes the export
   * settings that would make the two comparable — `atomicWithScreenshot: false`
   * says plainly that they were never taken together, instead of leaving the
   * reader to assume they line up.
   */
  async get_layout_tree(p: Json) {
    const root: any = await nodeOrSelectionOrPage(p.nodeId);
    if (root.type === "PAGE" || root.type === "DOCUMENT") {
      throw new Error(
        "get_layout_tree needs a scene node: a page has no transform. " +
          "Pass nodeId, or use get_metadata for the page skeleton.",
      );
    }
    const maxNodes = Math.min(Math.max(Number(p.maxNodes) || 2000, 1), 5000);
    const t0 = Date.now();
    const nodes: Json[] = [];
    const stack: any[] = [root];
    let truncated = false;
    while (stack.length) {
      if (nodes.length >= maxNodes) { truncated = true; break; }
      const n = stack.pop();
      nodes.push(layoutEntry(n));
      // Pushed in reverse so children are emitted in layer order.
      if ("children" in n) for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
    }
    const window = bbox(root.absoluteBoundingBox);
    return {
      schemaVersion: 1,
      snapshotId: new Date().toISOString(),
      atomicWithScreenshot: false,
      file: { name: figma.root.name, key: (figma as any).fileKey || null },
      page: { id: figma.currentPage.id, name: figma.currentPage.name },
      root: { id: root.id, name: root.name, type: root.type },
      coordinateSpace: "document-absolute",
      truncated,
      nodeCount: nodes.length,
      nodes,
      capture: {
        window,
        exportSettings: {
          format: "PNG",
          contentsOnly: true,
          useAbsoluteBounds: true,
          constraint: { type: "SCALE", value: 1 },
        },
        clipping: "Rectangles are layout AABBs; ancestor masks and painted visibility are not evaluated.",
      },
      ms: Date.now() - t0,
    };
  },

  async get_screenshot(p: Json) {
    const node: any = await nodeOrSelectionOrPage(p.nodeId);
    if (!("exportAsync" in node)) throw new Error(node.type + " cannot be exported");
    const format = String(p.format || "PNG").toUpperCase();
    const scale = Math.min(Math.max(Number(p.scale) || 1, 0.1), 4);
    const settings: any = { format };
    if (format === "PNG" || format === "JPG") settings.constraint = { type: "SCALE", value: scale };
    const bytes: Uint8Array = await node.exportAsync(settings);
    if (bytes.length > 12 * 1024 * 1024) throw new Error("export is " + bytes.length + " bytes; lower scale or pick a smaller node");
    return {
      nodeId: node.id, name: node.name, format, scale, bytes: bytes.length,
      width: round(node.width), height: round(node.height),
      // Figma's exporter serves a cached image after the document changes and
      // offers no way to invalidate it. Two identical byte counts with
      // different revs mean the render is stale, not that the edit did nothing.
      rev: currentRev(),
      ...(format === "SVG" ? { text: decodeUtf8(bytes) } : { base64: figma.base64Encode(bytes) }),
    };
  },

  async export_nodes(p: Json) {
    const ids: string[] = p.nodeIds || [];
    if (!ids.length) throw new Error("nodeIds is empty");
    const format = String(p.format || "PNG").toUpperCase();
    const scale = Math.min(Math.max(Number(p.scale) || 1, 0.1), 4);
    const out: Json[] = [];
    for (const id of ids) {
      const node: any = await figma.getNodeByIdAsync(id);
      if (!node || !("exportAsync" in node)) { out.push({ nodeId: id, error: "not found or not exportable" }); continue; }
      const settings: any = { format };
      if (format === "PNG" || format === "JPG") settings.constraint = { type: "SCALE", value: scale };
      const bytes: Uint8Array = await node.exportAsync(settings);
      out.push({ nodeId: id, name: node.name, format, bytes: bytes.length, base64: figma.base64Encode(bytes) });
    }
    return { files: out };
  },

  /**
   * A sprite sheet plus the rects that describe it, in one call.
   *
   * The sheet is exported as ONE image and the manifest describes THAT image:
   * the PNG's IHDR is read, the rects are computed in the file's pixels, and
   * anything that makes the sheet unsliceable (overlapping rects, sprites off
   * the image, drawing that bleeds out of its own cell, names that repeat) comes
   * back named. Nothing is repacked and nothing is guessed — the layout is the
   * designer's, the numbers are the file's.
   */
  async export_atlas(p: Json) {
    const sheet: any = await nodeOrSelectionOrPage(p.nodeId);
    if (!("exportAsync" in sheet)) throw new Error(sheet.type + " cannot be exported");
    if (!("children" in sheet)) throw new Error(sheet.type + " has no children to describe as sprites");
    if (!sheet.children.length) {
      throw new Error(`"${sheet.name}" has no children — an atlas of nothing would be an empty manifest`);
    }
    const scale = clampScale(p.scale, 1);
    const bytes: Uint8Array = await sheet.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale } });
    const size = pngSize(bytes);
    const b = exportBasis(sheet, size, scale);
    const skipped: Json[] = [];
    const sprites: Json[] = [];
    for (const c of sheet.children as any[]) {
      const box = box4(c.absoluteBoundingBox);
      if (!box) { skipped.push({ id: c.id, name: c.name, type: c.type, why: "no bounds (empty)" }); continue; }
      sprites.push({ id: c.id, name: c.name, box, render: box4(c.absoluteRenderBounds), visible: c.visible !== false });
    }
    const manifest = atlasManifest({
      sheetId: sheet.id,
      sheetName: sheet.name,
      sheet: b.box,
      sprites,
      scale,
      exportSize: size,
      basis: b.ambiguous ? "unmatched" : b.basis,
    });
    return {
      nodeId: sheet.id,
      name: sheet.name,
      format: "PNG",
      scale,
      bytes: bytes.length,
      exportSize: size,
      skipped,
      manifest,
      rev: currentRev(),
      base64: figma.base64Encode(bytes),
    };
  },

  /**
   * The insets of a 9-slice sprite, either given or read from a child layer
   * named exactly `9slice` — the rectangle the designer drew where the middle
   * should stretch. One PNG plus the descriptor, whose numbers are checked
   * against the file that was produced.
   */
  async export_9slice(p: Json) {
    const node: any = await nodeOrSelectionOrPage(p.nodeId);
    if (!("exportAsync" in node)) throw new Error(node.type + " cannot be exported");
    if (!(node.width > 0) || !(node.height > 0)) throw new Error(`"${node.name}" has no size to slice`);
    const scale = clampScale(p.scale, 1);
    const insets = p.insets
      ? { top: Number(p.insets.top), right: Number(p.insets.right), bottom: Number(p.insets.bottom), left: Number(p.insets.left) }
      : null;
    if (insets && [insets.top, insets.right, insets.bottom, insets.left].some((v) => !Number.isFinite(v) || v < 0)) {
      throw new Error("insets must be four non-negative numbers {top, right, bottom, left}, in design pixels");
    }
    const children: any[] = "children" in node ? node.children : [];
    const guide = children.find((c) => c.name === "9slice") ?? null;
    // The frame's own box, not its bounding box: the guides are laid out inside
    // the frame, and a stroke would shift every inset by half of it.
    const t = node.absoluteTransform;
    const nodeBox = t ? { x: round(t[0][2]), y: round(t[1][2]), width: round(node.width), height: round(node.height) } : null;
    const sheetBox = nodeBox ?? box4(node.absoluteBoundingBox);
    const guideBox = guide ? box4(guide.absoluteBoundingBox) : null;
    const bytes: Uint8Array = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale } });
    const size = pngSize(bytes);
    const descriptor = nineSliceDescriptor({
      width: node.width,
      height: node.height,
      insets,
      guide: !insets && guideBox && sheetBox ? { sheet: sheetBox, guide: guideBox } : null,
      scale,
      exportSize: size,
    });
    return {
      nodeId: node.id,
      name: node.name,
      format: "PNG",
      scale,
      bytes: bytes.length,
      exportSize: size,
      guide: guide ? { id: guide.id, name: guide.name, ignored: !!insets } : null,
      descriptor,
      rev: currentRev(),
      base64: figma.base64Encode(bytes),
    };
  },

  /**
   * The states of a button (or of any component) as separate files, plus what
   * each file is called.
   *
   * A COMPONENT_SET names its variants by property; a frame names them by layer
   * name. Both are facts of the document, so neither is guessed: the tool refuses
   * when a set declares several properties and the caller did not say which one
   * names the states, because "State=hover" and "Size=L" are both plausible and
   * one of them would be a lie.
   */
  async export_ui_states(p: Json) {
    const node: any = await nodeOrSelectionOrPage(p.nodeId);
    if (node.type === "PAGE" || node.type === "DOCUMENT") {
      throw new Error(`export_ui_states needs a frame or a component set, not a ${node.type}`);
    }
    if (!("children" in node) || !node.children.length) {
      throw new Error(`"${node.name}" has no children to export as states`);
    }
    const format = String(p.format || "PNG").toUpperCase();
    if (format !== "PNG" && format !== "SVG") throw new Error("format must be PNG or SVG");
    const scale = clampScale(p.scale, 1);
    const declared =
      node.type === "COMPONENT_SET" && node.variantGroupProperties ? Object.keys(node.variantGroupProperties) : null;
    const list = stateList({
      nodeType: node.type,
      variantPropertyNames: declared,
      property: p.property ? String(p.property) : null,
      children: node.children.map((c: any) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        width: c.width,
        height: c.height,
        visible: c.visible !== false,
        variantProperties: c.variantProperties ?? null,
      })),
    });
    const files: Json[] = [];
    for (const st of list.states) {
      const child: any = await figma.getNodeByIdAsync(st.id);
      if (!child) { files.push({ key: st.key, id: st.id, error: "node not found" }); continue; }
      if (!("exportAsync" in child)) { files.push({ key: st.key, id: st.id, error: child.type + " cannot be exported" }); continue; }
      try {
        const settings: any = { format };
        if (format === "PNG") settings.constraint = { type: "SCALE", value: scale };
        const bytes: Uint8Array = await child.exportAsync(settings);
        files.push({
          key: st.key,
          id: st.id,
          name: child.name,
          format,
          scale,
          bytes: bytes.length,
          exportSize: format === "PNG" ? pngSize(bytes) : null,
          expected: format === "PNG" ? { width: Math.round(st.width * scale), height: Math.round(st.height * scale) } : null,
          ...(format === "SVG" ? { text: decodeUtf8(bytes) } : { base64: figma.base64Encode(bytes) }),
        });
      } catch (err: any) {
        files.push({ key: st.key, id: st.id, name: child.name, error: String(err && err.message ? err.message : err) });
      }
    }
    return {
      nodeId: node.id,
      name: node.name,
      type: node.type,
      property: list.property,
      format,
      scale,
      states: list.states,
      files,
      warnings: list.warnings,
      rev: currentRev(),
    };
  },

  async import_images(p: Json) {
    const files: Array<{ name?: string; base64: string }> = p.files || [];
    if (!files.length) throw new Error("files is empty");
    return transact(async (mark) => {
      const parent: any = p.parentId ? await figma.getNodeByIdAsync(p.parentId) : figma.currentPage;
      if (!parent || !("appendChild" in parent)) throw new Error("parent cannot accept children");
      const target: any = p.targetNodeId ? await figma.getNodeByIdAsync(p.targetNodeId) : null;
      if (p.targetNodeId && (!target || !("fills" in target))) throw new Error("targetNodeId cannot take a fill");

      const created: Json[] = [];
      let x = p.x !== undefined ? p.x : figma.viewport.center.x;
      const y = p.y !== undefined ? p.y : figma.viewport.center.y;
      for (const f of files) {
        mark();
        const image = figma.createImage(figma.base64Decode(f.base64));
        if (target) {
          target.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: p.scaleMode || "FILL" }];
          created.push({ nodeId: target.id, imageHash: image.hash, mode: "fill" });
          continue;
        }
        const size = await image.getSizeAsync();
        const rect = figma.createRectangle();
        rect.name = f.name || "image";
        rect.resize(size.width, size.height);
        rect.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: "FILL" }];
        parent.appendChild(rect);
        rect.x = x; rect.y = y;
        x += size.width + 40;
        created.push({ nodeId: rect.id, name: rect.name, width: size.width, height: size.height, imageHash: image.hash });
      }
      return { created };
    });
  },

  async get_variable_defs(p: Json) {
    let vars: Variable[] = [];
    if (p.nodeId || figma.currentPage.selection.length) {
      const node: any = await nodeOrSelectionOrPage(p.nodeId);
      const ids = new Set<string>();
      walk(node, (n) => {
        collectAliases(n.boundVariables, ids);
        for (const k of ["fills", "strokes", "effects"]) if (Array.isArray(n[k])) for (const x of n[k]) collectAliases(x.boundVariables, ids);
      });
      for (const id of ids) {
        const v = await figma.variables.getVariableByIdAsync(id);
        if (v) vars.push(v);
      }
    } else {
      vars = await figma.variables.getLocalVariablesAsync();
    }
    const list: Json[] = [];
    for (const v of vars.slice(0, 1000)) list.push(await formatVar(v));
    // Flat "name: value" map in the first mode, which is what design-to-code wants.
    const flat: Json = {};
    for (const v of list) flat[v.name] = Object.values(v.values)[0];
    return { count: list.length, defs: flat, variables: list };
  },

  async get_libraries() {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const out: Json = {
      file: figma.root.name,
      localCollections: collections.map((c) => ({ id: c.id, name: c.name, modes: c.modes.map((m) => m.name), variables: c.variableIds.length })),
      libraryCollections: [],
    };
    try {
      const libs = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
      out.libraryCollections = libs.map((l) => ({ key: l.key, name: l.name, library: l.libraryName }));
    } catch (e: any) {
      out.libraryError = String(e && e.message ? e.message : e);
    }
    return out;
  },

  async search_design_system(p: Json) {
    const tokens = String(p.query || "").toLowerCase().split(/\s+/).filter(Boolean);
    const kinds: string[] = p.kinds && p.kinds.length ? p.kinds : ["components", "styles", "variables"];
    const limit = Math.min(Number(p.limit) || 25, 100);
    const match = (...parts: any[]) => {
      const hay = parts.filter(Boolean).join(" ").toLowerCase();
      return tokens.every((t) => hay.includes(t));
    };
    const out: Json = { query: p.query, components: [], styles: [], variables: [], libraryVariables: [] };

    if (kinds.includes("components")) {
      await figma.loadAllPagesAsync();
      const found = figma.root.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] });
      for (const c of found) {
        if (c.type === "COMPONENT" && c.parent && c.parent.type === "COMPONENT_SET") continue;
        if (!match(c.name, (c as any).description)) continue;
        out.components.push({ id: c.id, key: (c as any).key, name: c.name, type: c.type, description: (c as any).description || undefined, page: pageOf(c) });
        if (out.components.length >= limit) break;
      }
    }
    if (kinds.includes("styles")) {
      const all: Json[] = [];
      for (const [kind, getter] of [
        ["paint", figma.getLocalPaintStylesAsync], ["text", figma.getLocalTextStylesAsync],
        ["effect", figma.getLocalEffectStylesAsync], ["grid", figma.getLocalGridStylesAsync],
      ] as Array<[string, () => Promise<BaseStyle[]>]>) {
        for (const s of await getter.call(figma)) {
          if (match(s.name, s.description)) all.push({ id: s.id, key: s.key, kind, name: s.name, description: s.description || undefined });
        }
      }
      out.styles = all.slice(0, limit);
    }
    if (kinds.includes("variables")) {
      const vs = await figma.variables.getLocalVariablesAsync();
      for (const v of vs) {
        if (!match(v.name, v.description)) continue;
        out.variables.push(await formatVar(v));
        if (out.variables.length >= limit) break;
      }
      try {
        const libs = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
        for (const l of libs) if (match(l.name, l.libraryName)) out.libraryVariables.push({ key: l.key, name: l.name, library: l.libraryName });
      } catch { /* no teamlibrary access */ }
    }
    return out;
  },

  async whoami() {
    const u = figma.currentUser;
    return {
      user: u ? { id: u.id, name: u.name, photoUrl: u.photoUrl, color: u.color } : null,
      file: { name: figma.root.name, key: (figma as any).fileKey || null, editorType: figma.editorType },
      page: { id: figma.currentPage.id, name: figma.currentPage.name },
      pages: figma.root.children.map((pg) => ({ id: pg.id, name: pg.name })),
      viewport: { center: figma.viewport.center, zoom: figma.viewport.zoom },
    };
  },

  async get_figjam(p: Json) {
    if (figma.editorType !== "figjam") throw new Error("not a FigJam file (editor is " + figma.editorType + ")");
    const root: any = await nodeOrSelectionOrPage(p.nodeId);
    const items: Json[] = [];
    walk(root, (n) => {
      if (["STICKY", "SHAPE_WITH_TEXT", "CONNECTOR", "SECTION", "TEXT", "CODE_BLOCK", "TABLE", "STAMP", "WIDGET"].includes(n.type)) {
        const it: Json = { id: n.id, type: n.type, name: n.name };
        try { if (n.text) it.text = n.text.characters; else if (n.characters) it.text = n.characters; } catch { /* ignore */ }
        if (n.type === "CONNECTOR") {
          it.from = n.connectorStart && n.connectorStart.endpointNodeId;
          it.to = n.connectorEnd && n.connectorEnd.endpointNodeId;
        }
        if ("x" in n) { it.x = round(n.x); it.y = round(n.y); }
        if (n.parent && n.parent.type === "SECTION") it.section = n.parent.name;
        items.push(it);
      }
    });
    return { count: items.length, items: items.slice(0, 1000) };
  },

  /** Code Connect, local variant: kept in shared plugin data on the node. */
  async get_code_connect_map(p: Json) {
    const node: any = await nodeOrSelectionOrPage(p.nodeId);
    const read = (n: any) => { try { return JSON.parse(n.getSharedPluginData(NS, "codeConnect") || "[]"); } catch { return []; } };
    const out: Json = { nodeId: node.id, mappings: read(node) };
    if (node.type === "INSTANCE") {
      const main = await node.getMainComponentAsync();
      if (main) out.fromMainComponent = { id: main.id, mappings: read(main) };
    }
    return out;
  },

  async add_code_connect_map(p: Json) {
    if (!p.nodeId || !p.source || !p.componentName) throw new Error("nodeId, source and componentName are required");
    return transact(async (mark) => {
      const node: any = await figma.getNodeByIdAsync(p.nodeId);
      if (!node) throw new Error("node not found: " + p.nodeId);
      let list: Json[] = [];
      try { list = JSON.parse(node.getSharedPluginData(NS, "codeConnect") || "[]"); } catch { /* reset */ }
      list = list.filter((m) => !(m.source === p.source && m.componentName === p.componentName && m.label === p.label));
      list.push({ source: p.source, componentName: p.componentName, label: p.label || "default", language: p.language });
      mark();
      node.setSharedPluginData(NS, "codeConnect", JSON.stringify(list));
      return { nodeId: node.id, mappings: list };
    });
  },

  /**
   * Select nodes in the editor and scroll them into view.
   *
   * The bridge is the only thing that can move the user's cursor, so this is
   * how a build hands its work over: "look at what I just made" without the
   * user hunting for it on a canvas that is now 30 000px wide.
   */
  async set_selection(p: Json) {
    const ids: string[] = p.nodeIds || [];
    if (!ids.length) throw new Error("nodeIds is empty");
    const nodes: any[] = [];
    for (const id of ids) {
      const n: any = await figma.getNodeByIdAsync(id);
      if (!n) throw new Error("node not found: " + id);
      nodes.push(n);
    }
    const parent = nodes[0].parent;
    if (parent && parent.type === "PAGE" && parent !== figma.currentPage) {
      // Under documentAccess:"dynamic-page" figma.currentPage is READ-ONLY;
      // assigning to it is a no-op that looks like it worked. The API that
      // actually switches pages is setCurrentPageAsync.
      try { await figma.setCurrentPageAsync(parent); } catch { /* page switch refused */ }
    }
    figma.currentPage.selection = nodes;
    if (p.zoom !== false) {
      try { figma.viewport.scrollAndZoomIntoView(nodes); } catch { /* viewport not available */ }
    }
    return {
      page: figma.currentPage.name,
      selected: nodes.map((n) => ({ id: n.id, name: n.name, type: n.type })),
    };
  },

  /** Switch the editor to another page. */
  async set_page(p: Json) {
    const name = String(p.name || "");
    if (!name) throw new Error("name is required");
    const target = figma.root.children.find((pg) => pg.name === name);
    if (!target) {
      const available = figma.root.children.map((pg) => pg.name);
      throw new Error("page not found: " + name + ". Available: " + available.join(", "));
    }
    try { await figma.setCurrentPageAsync(target); } catch { /* page switch refused by the API */ }
    return { page: figma.currentPage.name, id: target.id };
  },

  /** Every component and component set in the file, for Code Connect work. */
  async list_file_components(p: Json) {
    const out: Json[] = [];
    const pages = p.allPages === false ? [figma.currentPage] : figma.root.children;
    for (const pg of pages) {
      let found: any[] = [];
      try { found = pg.findAll((n: any) => n.type === "COMPONENT" || n.type === "COMPONENT_SET"); } catch { continue; }
      for (const c of found) {
        out.push({
          id: c.id, name: c.name, type: c.type, page: pg.name,
          ...(c.type === "COMPONENT" ? { size: [round(c.width), round(c.height)] } : {}),
          ...(c.description ? { description: c.description } : {}),
        });
      }
    }
    return { count: out.length, components: out };
  },

  /**
   * Which fonts the file actually uses, by text node.
   *
   * Consistency work needs this: a design system that claims one typeface and
   * quietly uses three is the usual failure, and it is invisible until someone
   * measures it.
   */
  async get_font_inventory(p: Json) {
    const counts: Record<string, number> = {};
    const pages = p.allPages === false ? [figma.currentPage] : figma.root.children;
    for (const pg of pages) {
      let texts: any[] = [];
      try { texts = pg.findAll((n: any) => n.type === "TEXT"); } catch { continue; }
      for (const t of texts) {
        const f = t.fontName;
        if (f && f !== figma.mixed) {
          const key = f.family + " / " + f.style;
          counts[key] = (counts[key] || 0) + 1;
          continue;
        }
        let ranges: any[] = [];
        try { ranges = t.getRangeAllFontNames(0, t.characters.length); } catch { ranges = []; }
        for (const fn of ranges) {
          const key = fn.family + " / " + fn.style;
          counts[key] = (counts[key] || 0) + 1;
        }
      }
    }
    const fonts = Object.keys(counts)
      .map((k) => ({ font: k, nodes: counts[k] }))
      .sort((a, b) => b.nodes - a.nodes);
    return { count: fonts.length, fonts };
  },

  // -------------------------------------------------------- checkpoints

  /**
   * Describe a subtree as data (checkpoint-v1).
   *
   * Read-only, and deliberately explicit about its blind spots: `limitations`
   * travels with every dump, `truncated` says the node cap cut the tail off, and
   * `unsupported` names every node a rebuild could not produce. A page is
   * refused as a root: "checkpoint everything" is not a scope, it is a plan to
   * restore by deleting the page.
   */
  async checkpoint_dump(p: Json) {
    const node: any = await nodeOrSelectionOrPage(p.nodeId);
    if (node.type === "PAGE" || node.type === "DOCUMENT") {
      throw new Error(
        `checkpoint_dump needs one scene node — a ${node.type} is not a scope: restoring such a checkpoint would replace the whole ${node.type.toLowerCase()}. ` +
          `Pass nodeId of the frame (or subtree root) you are about to rebuild.`,
      );
    }
    const dump = await dumpSubtree(node, { maxNodes: p.maxNodes, maxDepth: p.maxDepth });
    const fp = snapshot(node, STRICT);
    return {
      schema: DUMP_SCHEMA,
      capturedAt: new Date().toISOString(),
      rev: currentRev(),
      file: { key: figma.fileKey || sessionKey(figma.root), name: figma.root.name },
      page: { id: figma.currentPage.id, name: figma.currentPage.name },
      root: { id: node.id, name: node.name, type: node.type },
      nodes: dump.nodes,
      truncated: dump.truncated,
      unsupported: dump.unsupported,
      limitations: LIMITATIONS,
      fingerprint: {
        hash: fp.hash,
        appearanceHash: fp.appearanceHash,
        geometryHash: fp.geometryHash,
        childrenHash: fp.childrenHash,
        geometryStatus: fp.geometryStatus,
      },
      dump: dump.root,
    };
  },

  /**
   * Rebuild the children of a node from a checkpoint (checkpoint-v1).
   *
   * One transaction, one undo step: the children are removed and rebuilt inside
   * `transact`, so a failure halfway rolls the whole rebuild back. This method
   * reports what it DID — what it removed, created, skipped and could not make
   * exact. Whether the result matches the checkpoint is answered by dumping the
   * subtree again and comparing, which is the caller's job: a module that
   * verifies its own write against its own data proves nothing.
   */
  async checkpoint_restore(p: Json) {
    if (!p.dump || typeof p.dump !== "object") {
      throw new Error("checkpoint_restore needs `dump`: the subtree from a checkpoint_dump reply.");
    }
    if (p.allowDestructive !== true && p.dryRun !== true) {
      throw new Error(
        "REFUSED: checkpoint_restore deletes the target's current children and rebuilds them from the checkpoint. " +
          "Pass allowDestructive: true to say that out loud — or dryRun: true, which only reports what would happen.",
      );
    }
    const target: any = await nodeOrSelectionOrPage(p.nodeId);
    if (target.type === "PAGE" || target.type === "DOCUMENT") {
      throw new Error(`REFUSED: a ${target.type} cannot be a restore target — the rebuild would replace the whole ${target.type.toLowerCase()}. Pass nodeId of the frame.`);
    }
    return transact(async (mark) => {
      const report = await restoreSubtree(
        p.dump,
        { figma, target, mark, loadFont: (f) => figma.loadFontAsync(f) },
        { allowPartial: p.allowPartial === true, dryRun: p.dryRun === true, truncated: p.truncated === true },
      );
      return { target: { id: target.id, name: target.name, type: target.type }, ...report };
    });
  },
};

function pageOf(n: BaseNode): string | null {
  let cur: BaseNode | null = n;
  while (cur && cur.type !== "PAGE") cur = cur.parent;
  return cur ? cur.name : null;
}

function decodeUtf8(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  try { return decodeURIComponent(escape(s)); } catch { return s; }
}
