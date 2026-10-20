/**
 * Checkpoints: describe a subtree as data, and put it back.
 *
 * WHY NOT UNDO. The Plugin API has no "go back to where I was": triggerUndo()
 * pops ONE transaction, and the undo stack is shared with the user's own edits
 * and with every other tool call. So a checkpoint is a DESCRIPTION plus a
 * REBUILD, not a saved undo step — and the honest part is everything a rebuild
 * cannot reproduce, which this module NAMES rather than hides:
 *
 *   - a restored COMPONENT is a new component (new id, new key, no instances);
 *   - an INSTANCE comes back as an instance of its main component, with
 *     component properties re-applied — the overridden leaves inside it are not
 *     captured, so it shows the main component's current content;
 *   - per-run text variable bindings and per-run style links are not rebuilt;
 *     the runs themselves (font, size, fills, case, decoration, line height,
 *     letter spacing and hyperlink) are;
 *   - style ids, node-level variable bindings and explicit modes travel in
 *     `meta` and are re-linked by id when they still exist; every one that does
 *     not is reported instead of passing as restored;
 *   - node types this version cannot rebuild are refused by name, or skipped
 *     with allowPartial: true and listed in the result.
 *
 * The reading half takes plain nodes (`any`) and never touches `figma`, so the
 * schema is unit-tested against fixtures (test/checkpoint.test.mjs). The writing
 * half takes the API surface it uses as `ctx`, for the same reason. Nothing here
 * calls commitUndo/triggerUndo: the caller owns the transaction, because it is
 * the caller who knows whether a rollback would steal someone else's edit
 * (plugin/tools.ts `transact`).
 */

export const DUMP_SCHEMA = "checkpoint-v1";
export const MAX_NODES = 2000;
export const MAX_DEPTH = 40;

/**
 * Everything checkpoint-v1 knowingly does NOT carry. Printed on every save, so
 * it travels with the data instead of living only in this file.
 */
export const LIMITATIONS: readonly string[] = [
  "instance interiors are not captured: a restored INSTANCE shows its main component's current content (component properties are re-applied)",
  "text runs are rebuilt (font, size, fills, case, decoration, line height, letter spacing and hyperlink); per-run variable bindings and per-run style links are not",
  "style ids are re-linked when the style still exists; node-level variable bindings and explicit modes are re-linked when their variable, collection and mode still exist, and every missing link is reported",
  "per-range text bindings are not rebuilt; a single binding across the whole text is restored",
  "a restored COMPONENT is a NEW component: the checkpoint's key, id and instances do not come back",
  "a BOOLEAN_OPERATION is not rebuilt (its inputs are not recoverable from the API)",
];

export type Dict = Record<string, any>;

/** One node in a checkpoint. `state` is what a restore writes back. */
export interface DumpNode {
  type: string;
  name: string;
  state: Dict;
  /** Read for the record, never restored and never compared. */
  meta?: Dict;
  children?: DumpNode[];
  /** Present when this node cannot be rebuilt; the text is the reason. */
  unsupported?: string;
}

export interface DumpResult {
  root: DumpNode;
  nodes: number;
  truncated: boolean;
  unsupported: Array<{ path: string; type: string; why: string }>;
}

export interface DumpOptions {
  maxNodes?: number;
  maxDepth?: number;
}

export interface RestoreContext {
  /** The Plugin API factories (figma.createFrame, figma.group, ...). */
  figma: any;
  /** The node to rebuild INSIDE. Its children are replaced. */
  target: any;
  /** Called before the first write, so the caller can gate its rollback. */
  mark?: () => void;
  /** figma.loadFontAsync. Omitted in unit tests, which use a stub. */
  loadFont?: (font: { family: string; style: string }) => Promise<void>;
  /** Font for text whose checkpointed font could not be loaded. */
  fallbackFont?: { family: string; style: string };
}

export interface RestoreOptions {
  allowPartial?: boolean;
  dryRun?: boolean;
  /** Set when the dump was cut short by MAX_NODES: restoring it would delete the tail. */
  truncated?: boolean;
}

export interface RestoreReport {
  dryRun: boolean;
  removed: number;
  created: number;
  /** Nodes the rebuild could not produce, with the reason. */
  skipped: Array<{ path: string; type: string; why: string }>;
  fontsUnavailable: string[];
  /** Paints restored by value because their variable bindings would not apply. */
  bindingsDropped: string[];
  /** Node-level variable bindings re-applied because the variable still exists. */
  bindingsRestored: Array<{ path: string; field: string; id: string; name?: string }>;
  /** Node-level variable bindings the file could not resolve; the value is still restored. */
  bindingsMissing: Array<{ path: string; field: string; id: string; why: string }>;
  /** Explicit variable modes re-applied because their collection and mode still exist. */
  modesRestored: Array<{ path: string; collectionId: string; collectionName?: string; modeId: string; modeName?: string }>;
  /** Explicit variable modes the file could not resolve. */
  modesMissing: Array<{ path: string; collectionId: string; modeId: string; why: string }>;
  /** Style links re-applied because the style still exists in the file. */
  stylesRestored: Array<{ path: string; field: string; id: string; name?: string }>;
  /** Style links the file no longer has; the paint/font value is still restored. */
  stylesMissing: Array<{ path: string; field: string; id: string; why: string }>;
  propertiesFailed: Array<{ path: string; name: string; why: string }>;
  notes: string[];
  wouldRemove?: Array<{ id: string; name: string; type: string }>;
}

// ---------------------------------------------------------------- reading

const round = (n: number) => Math.round(n * 100) / 100;
const msg = (e: any) => String(e && e.message ? e.message : e);

/**
 * `figma.mixed` is a unique SYMBOL, and this module must load outside Figma, so
 * it is recognised by kind rather than by identity against the global: every
 * real value in these fields is an object, a number or a string.
 */
const isMixedValue = (v: any) => typeof v === "symbol";
const isObj = (v: any) => !!v && typeof v === "object" && !Array.isArray(v);

function copy(v: any): any {
  if (v === undefined || isMixedValue(v)) return undefined;
  return JSON.parse(JSON.stringify(v));
}

/** A paint / effect list: copied verbatim, so gradients, filters and blends survive. */
function list(v: any): any {
  if (isMixedValue(v)) return "mixed";
  if (!Array.isArray(v)) return undefined;
  return v.map((p: any) => copy(p));
}

function strokeWeightOf(node: any): any {
  if (!isMixedValue(node.strokeWeight)) return node.strokeWeight;
  if (!("strokeTopWeight" in node)) return "mixed";
  return [node.strokeTopWeight, node.strokeRightWeight, node.strokeBottomWeight, node.strokeLeftWeight];
}

/**
 * What a restore can write back, per node. Read through `in` checks: node types
 * expose different properties, and a field that this type does not have is not
 * a field that failed to restore.
 */
export function readState(node: any): Dict {
  const s: Dict = {};
  if ("x" in node && node.type !== "PAGE") s.pos = [round(node.x), round(node.y)];
  s.size = [round(node.width), round(node.height)];
  if ("rotation" in node && node.rotation) s.rotation = round(node.rotation);
  if (node.visible === false) s.visible = false;
  if (node.locked === true) s.locked = true;
  if ("opacity" in node && node.opacity !== 1) s.opacity = node.opacity;
  if ("blendMode" in node && node.blendMode !== "NORMAL" && node.blendMode !== "PASS_THROUGH") s.blendMode = node.blendMode;
  if ("isMask" in node && node.isMask) {
    s.isMask = true;
    if (node.maskType) s.maskType = node.maskType;
  }
  if ("clipsContent" in node && node.clipsContent) s.clipsContent = true;
  if ("fills" in node) s.fills = list(node.fills) ?? [];
  if ("strokes" in node) {
    s.strokes = list(node.strokes) ?? [];
    s.strokeWeight = strokeWeightOf(node);
    if (node.strokeAlign) s.strokeAlign = node.strokeAlign;
    if ("strokeCap" in node && node.strokeCap) s.strokeCap = node.strokeCap;
    if ("strokeJoin" in node && node.strokeJoin) s.strokeJoin = node.strokeJoin;
    if ("dashPattern" in node && node.dashPattern && node.dashPattern.length) s.dashPattern = copy(node.dashPattern);
  }
  if ("cornerRadius" in node) {
    s.cornerRadius = isMixedValue(node.cornerRadius)
      ? [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius]
      : node.cornerRadius;
  }
  if ("effects" in node) s.effects = list(node.effects) ?? [];
  // Omitted when empty so an old checkpoint (which never carried grids) still
  // compares equal against a fresh dump of a node that has none.
  if ("layoutGrids" in node && Array.isArray(node.layoutGrids) && node.layoutGrids.length) {
    s.layoutGrids = list(node.layoutGrids);
  }
  if ("arcData" in node) s.arcData = copy(node.arcData);

  if ("layoutMode" in node && node.layoutMode !== "NONE") {
    const L: Dict = {
      mode: node.layoutMode,
      padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft],
      gap: node.itemSpacing,
      primaryAlign: node.primaryAxisAlignItems,
      counterAlign: node.counterAxisAlignItems,
    };
    if ("primaryAxisSizingMode" in node) L.primary = node.primaryAxisSizingMode;
    if ("counterAxisSizingMode" in node) L.counter = node.counterAxisSizingMode;
    if ("layoutWrap" in node && node.layoutWrap === "WRAP") L.wrap = true;
    if ("counterAxisSpacing" in node && node.counterAxisSpacing !== null) L.counterGap = node.counterAxisSpacing;
    if ("strokesIncludedInLayout" in node && node.strokesIncludedInLayout) L.strokesIncluded = true;
    if ("itemReverseZIndex" in node && node.itemReverseZIndex) L.reverseZ = true;
    s.layout = L;
  }
  if ("layoutSizingHorizontal" in node) s.sizing = [node.layoutSizingHorizontal, node.layoutSizingVertical];
  if ("layoutAlign" in node && node.layoutAlign !== "INHERIT") s.layoutAlign = node.layoutAlign;
  if ("layoutGrow" in node && node.layoutGrow !== 0) s.layoutGrow = node.layoutGrow;
  if ("layoutPositioning" in node && node.layoutPositioning === "ABSOLUTE") s.layoutPositioning = "ABSOLUTE";
  if ("constraints" in node && node.constraints) s.constraints = [node.constraints.horizontal, node.constraints.vertical];
  if ("minWidth" in node && (node.minWidth !== null || node.minHeight !== null)) s.minSize = [node.minWidth, node.minHeight];
  if ("maxWidth" in node && (node.maxWidth !== null || node.maxHeight !== null)) s.maxSize = [node.maxWidth, node.maxHeight];

  if (node.type === "TEXT") s.text = readText(node);
  if (node.type === "VECTOR") {
    s.vector = copy(node.vectorNetwork);
    if (node.windingRule) s.windingRule = node.windingRule;
  }
  return s;
}

function readTextRun(seg: any): Dict {
  const out: Dict = { start: seg.start, end: seg.end };
  if (!isMixedValue(seg.fontName) && isObj(seg.fontName)) out.font = copy(seg.fontName);
  if (!isMixedValue(seg.fontSize) && Number.isFinite(Number(seg.fontSize))) out.fontSize = Number(seg.fontSize);
  if (Array.isArray(seg.fills)) out.fills = list(seg.fills) ?? [];
  if (seg.textCase) out.textCase = copy(seg.textCase);
  if (seg.textDecoration) out.textDecoration = copy(seg.textDecoration);
  if (seg.lineHeight && !isMixedValue(seg.lineHeight)) out.lineHeight = copy(seg.lineHeight);
  if (seg.letterSpacing && !isMixedValue(seg.letterSpacing)) out.letterSpacing = copy(seg.letterSpacing);
  if (seg.hyperlink === null) out.hyperlink = null;
  else if (seg.hyperlink && !isMixedValue(seg.hyperlink)) out.hyperlink = copy(seg.hyperlink);
  return out;
}

function readText(node: any): Dict {
  const t: Dict = { characters: node.characters };
  t.font = isMixedValue(node.fontName) ? "mixed" : copy(node.fontName);
  t.fontSize = isMixedValue(node.fontSize) ? "mixed" : node.fontSize;
  t.lineHeight = isMixedValue(node.lineHeight) ? "mixed" : copy(node.lineHeight);
  t.letterSpacing = isMixedValue(node.letterSpacing) ? "mixed" : copy(node.letterSpacing);
  t.align = [node.textAlignHorizontal, node.textAlignVertical];
  t.autoResize = node.textAutoResize;
  if (isMixedValue(node.hyperlink)) t.hyperlink = "mixed";
  else if (node.hyperlink) t.hyperlink = copy(node.hyperlink);
  if (node.textCase && node.textCase !== "ORIGINAL") t.textCase = copy(node.textCase);
  if (node.textDecoration && node.textDecoration !== "NONE") t.textDecoration = copy(node.textDecoration);
  if (typeof node.paragraphSpacing === "number" && node.paragraphSpacing) t.paragraphSpacing = node.paragraphSpacing;
  if (typeof node.paragraphIndent === "number" && node.paragraphIndent) t.paragraphIndent = node.paragraphIndent;
  // Runs are part of STATE: a rebuild that loses them must show up in the
  // comparison. `runs` keeps the old count for older checkpoints; `textRuns`
  // carries the values a restore writes back.
  try {
    const segs = node.getStyledTextSegments([
      "fontName", "fontSize", "fills", "textCase", "textDecoration",
      "lineHeight", "letterSpacing", "hyperlink",
    ]);
    if (Array.isArray(segs) && segs.length > 1) {
      t.runs = segs.length;
      const usable = segs.every((s: any) => s && Number.isInteger(s.start) && Number.isInteger(s.end) && s.end > s.start);
      if (usable) t.textRuns = segs.map(readTextRun);
    }
  } catch {
    /* fonts not loaded: the run count is simply unknown */
  }
  return t;
}

async function readInstance(node: any): Promise<Dict> {
  const out: Dict = {};
  try {
    const main = await node.getMainComponentAsync();
    if (main) {
      out.componentId = main.id;
      out.componentKey = main.key ?? null;
      out.componentName = main.name;
      out.remote = main.remote === true;
    }
  } catch (e) {
    out.unresolved = msg(e);
  }
  try {
    const props = node.componentProperties;
    if (props && Object.keys(props).length) {
      const values: Dict = {};
      for (const [k, v] of Object.entries(props as Dict)) values[k] = (v as any)?.value;
      out.properties = values;
    }
  } catch {
    /* a component property that cannot be read cannot be restored either */
  }
  return out;
}

function readMeta(node: any): Dict | undefined {
  const meta: Dict = {};
  try {
    const bv = node.boundVariables;
    if (bv) {
      const fields = Object.keys(bv);
      if (fields.length) {
        meta.bindings = fields;
        // The field NAMES are for humans; the aliases are what a restore needs.
        // Nested paint/font aliases are copied as-is.
        meta.variableBindings = copy(bv);
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const modes = node.explicitVariableModes;
    if (modes && Object.keys(modes).length) meta.variableModes = copy(modes);
  } catch {
    /* not every node type exposes explicit modes */
  }
  const styles: string[] = [];
  const styleIds: Dict = {};
  for (const k of ["fillStyleId", "strokeStyleId", "effectStyleId", "textStyleId"]) {
    try {
      const id = node[k];
      if (id && !isMixedValue(id) && id !== "") {
        styles.push(k.replace("StyleId", ""));
        styleIds[k] = id;
      }
    } catch {
      /* ignore */
    }
  }
  if (styles.length) meta.styles = styles;
  if (Object.keys(styleIds).length) meta.styleIds = styleIds;
  if (node.type === "TEXT" && typeof node.getStyledTextSegments === "function") {
    try {
      const segs = node.getStyledTextSegments(["textStyleId", "fillStyleId"]);
      if (Array.isArray(segs) && segs.length > 1) {
        const textStyleIds = [...new Set(segs.map((s: any) => s.textStyleId).filter((id: any) => typeof id === "string" && id))];
        const fillStyleIds = [...new Set(segs.map((s: any) => s.fillStyleId).filter((id: any) => typeof id === "string" && id))];
        if (textStyleIds.length > 1 || fillStyleIds.length > 1) {
          meta.textRunStyles = {
            ...(textStyleIds.length > 1 ? { textStyleIds } : {}),
            ...(fillStyleIds.length > 1 ? { fillStyleIds } : {}),
          };
        }
      }
    } catch {
      /* style ids are optional; the run values are still recorded */
    }
  }
  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
    try {
      if (node.key) meta.componentKey = node.key;
    } catch {
      /* ignore */
    }
  }
  return Object.keys(meta).length ? meta : undefined;
}

/** Node types checkpoint-v1 can build. Anything else is refused by name. */
const REBUILDABLE = new Set([
  "FRAME",
  "GROUP",
  "COMPONENT",
  "SECTION",
  "INSTANCE",
  "RECTANGLE",
  "ELLIPSE",
  "LINE",
  "TEXT",
  "VECTOR",
]);

/** A node whose type we cannot build still records its identity, so the report can name it. */
function unsupportedWhy(type: string): string {
  if (type === "BOOLEAN_OPERATION") return "a BOOLEAN_OPERATION cannot be rebuilt: the Plugin API does not expose its inputs or its operation";
  if (type === "COMPONENT_SET") return "a COMPONENT_SET cannot be rebuilt (variants and their combined identity are not restorable); checkpoint its variants instead";
  if (type === "STAR" || type === "POLYGON") return `a ${type} is not rebuilt by checkpoint-v1`;
  return `${type} is not rebuilt by checkpoint-v1`;
}

async function readNode(node: any, depth: number, budget: { n: number; truncated: boolean }, opts: Required<DumpOptions>): Promise<DumpNode> {
  budget.n++;
  const out: DumpNode = { type: node.type, name: node.name, state: {}, meta: undefined };

  if (!REBUILDABLE.has(node.type)) {
    // Identity plus the fields the report needs to point at it. Children are not
    // walked: they cannot come back anyway.
    out.state = { size: [round(node.width), round(node.height)] };
    if ("x" in node) out.state.pos = [round(node.x), round(node.y)];
    out.unsupported = unsupportedWhy(node.type);
    return out;
  }

  out.state = readState(node);
  if (node.type === "INSTANCE") out.state.instance = await readInstance(node);
  const meta = readMeta(node);
  if (meta) out.meta = meta;

  const canRecurse = "children" in node && node.type !== "INSTANCE";
  if (canRecurse && depth < opts.maxDepth) {
    const kids: DumpNode[] = [];
    for (const child of node.children as any[]) {
      if (budget.n >= opts.maxNodes) {
        budget.truncated = true;
        break;
      }
      kids.push(await readNode(child, depth + 1, budget, opts));
    }
    if (kids.length) out.children = kids;
  }
  return out;
}

export async function dumpSubtree(node: any, options: DumpOptions = {}): Promise<DumpResult> {
  const opts: Required<DumpOptions> = {
    maxNodes: options.maxNodes ?? MAX_NODES,
    maxDepth: options.maxDepth ?? MAX_DEPTH,
  };
  const budget = { n: 0, truncated: false };
  const root = await readNode(node, 0, budget, opts);
  return {
    root,
    nodes: budget.n,
    truncated: budget.truncated,
    unsupported: collectUnsupported(root, true),
  };
}

/** Every node the rebuild cannot produce, as paths a human can follow. */
export function collectUnsupported(root: DumpNode, includeRoot = false): Array<{ path: string; type: string; why: string }> {
  const out: Array<{ path: string; type: string; why: string }> = [];
  const walk = (n: DumpNode, path: string, isRoot: boolean) => {
    if (n.unsupported && (!isRoot || includeRoot)) out.push({ path, type: n.type, why: n.unsupported });
    (n.children ?? []).forEach((c, i) => walk(c, `${path}.children[${i}]`, false));
  };
  walk(root, "$", true);
  return out;
}

export function countNodes(root: DumpNode): number {
  let n = 1;
  for (const c of root.children ?? []) n += countNodes(c);
  return n;
}

// ---------------------------------------------------------------- writing

const describeTarget = (t: any) => `"${t.name}" (${t.type} ${t.id})`;

/**
 * Rebuild `dump`'s children inside `ctx.target`, replacing whatever is there.
 *
 * The root node is rebuilt INTO, never rebuilt itself: its children are
 * replaced, its own appearance is re-applied when the types match, and it keeps
 * its position (a position is context, not state — the sibling order and the
 * parent are the caller's business).
 *
 * Refusals are the point of this function. A dump that contains node types this
 * version cannot build is refused by default, because a partial rebuild under
 * "restore" silently deletes the parts it cannot rebuild. `allowPartial: true`
 * trades that for a list of exactly what was skipped.
 */
export async function restoreSubtree(dump: DumpNode, ctx: RestoreContext, opts: RestoreOptions = {}): Promise<RestoreReport> {
  const report: RestoreReport = {
    dryRun: opts.dryRun === true,
    removed: 0,
    created: 0,
    skipped: [],
    fontsUnavailable: [],
    bindingsDropped: [],
    bindingsRestored: [],
    bindingsMissing: [],
    modesRestored: [],
    modesMissing: [],
    stylesRestored: [],
    stylesMissing: [],
    propertiesFailed: [],
    notes: [],
  };

  if (opts.truncated && !opts.allowPartial) {
    throw new Error(
      "this checkpoint was truncated at the node cap, so it describes only PART of the subtree. " +
        "Restoring it would delete everything the dump never reached — save a checkpoint of a smaller scope (or raise maxNodes) and restore that.",
    );
  }

  const target = ctx.target;
  if (!target) throw new Error("no target node");
  if (target.type === "GROUP") {
    throw new Error(
      `a GROUP cannot be a restore target: removing its last child deletes the group itself, and the rebuild would then write into a dead node. Restore into the frame or section that contains "${target.name}".`,
    );
  }
  if (target.type === "INSTANCE") throw new Error("an INSTANCE cannot be a restore target: its children belong to the main component.");
  if (!("children" in target) || !Array.isArray(target.children)) throw new Error(`the target ${describeTarget(target)} cannot hold children`);

  const unsupported = collectUnsupported(dump, false);
  if (unsupported.length && !opts.allowPartial) {
    const named = unsupported.slice(0, 8).map((u) => `${u.path} (${u.type})`).join(", ");
    throw new Error(
      `checkpoint-v1 cannot rebuild ${unsupported.length} node(s) in this subtree: ${named}${unsupported.length > 8 ? ", …" : ""}. ` +
        `Restoring anyway would delete them. Pass allowPartial: true to rebuild the rest — the skipped nodes are listed back to you.`,
    );
  }

  const existing: any[] = [...target.children];

  if (report.dryRun) {
    report.removed = existing.length;
    report.wouldRemove = existing.slice(0, 50).map((k) => ({ id: k.id, name: k.name, type: k.type }));
    if (existing.length > 50) report.notes.push(`${existing.length - 50} more child(ren) not listed`);
    // The root is rebuilt INTO, so it is not one of the nodes this restore creates.
    report.created = (dump.children ?? []).reduce((n, c) => n + countNodes(c), 0);
    for (const u of unsupported) report.skipped.push({ path: u.path, type: u.type, why: u.why });
    return report;
  }

  if (dump.type !== target.type) {
    report.notes.push(
      `the target is a ${target.type} and the checkpoint describes a ${dump.type}: only the children are restored, ` +
        `not the target's own layout and appearance`,
    );
  } else {
    await applyVariableModes(target, dump.meta?.variableModes, ctx, report, "$");
    applyLayout(target, dump.state, report, "$");
  }

  ctx.mark?.();
  report.removed = existing.length;
  for (const child of existing) {
    try {
      child.remove();
    } catch (e) {
      report.notes.push(`could not remove child ${child.id} ("${child.name}"): ${msg(e)}`);
    }
  }

  const children = dump.children ?? [];
  for (let i = 0; i < children.length; i++) {
    await buildNode(children[i], target, ctx, report, `$.children[${i}]`, opts);
  }

  if (dump.type === target.type) {
    await applyFinal(target, dump.state, ctx, report, "$", true, dump.meta);
    await applyStyleLinks(target, dump.meta?.styleIds, ctx, report, "$");
    await applyVariableBindings(target, dump.meta?.variableBindings, dump.state, ctx, report, "$");
  }
  return report;
}

async function buildNode(d: DumpNode, parent: any, ctx: RestoreContext, report: RestoreReport, path: string, opts: RestoreOptions): Promise<any> {
  if (d.unsupported) {
    report.skipped.push({ path, type: d.type, why: d.unsupported });
    return null;
  }
  if (d.type === "GROUP") return buildGroup(d, parent, ctx, report, path, opts);

  let node: any = null;
  try {
    node = await createNode(d, ctx, report, path);
    parent.appendChild(node);
    await applyVariableModes(node, d.meta?.variableModes, ctx, report, path);
    applyLayout(node, d.state, report, path);
    const kids = d.children ?? [];
    for (let i = 0; i < kids.length; i++) {
      await buildNode(kids[i], node, ctx, report, `${path}.children[${i}]`, opts);
    }
    await applyFinal(node, d.state, ctx, report, path, false, d.meta);
    await applyStyleLinks(node, d.meta?.styleIds, ctx, report, path);
    await applyVariableBindings(node, d.meta?.variableBindings, d.state, ctx, report, path);
    report.created++;
    return node;
  } catch (e) {
    if (!opts.allowPartial) throw new Error(`${path} (${d.type} "${d.name}"): ${msg(e)}`);
    report.skipped.push({ path, type: d.type, why: msg(e) });
    try {
      if (node && !node.removed) node.remove();
    } catch {
      /* the node may already be gone */
    }
    return null;
  }
}

/**
 * A group is built last: its children are created in the parent, then grouped —
 * Figma derives the group's own box from its children, and the group's recorded
 * position is then applied to the whole cluster, which puts every child back at
 * the absolute position the dump describes.
 */
async function buildGroup(d: DumpNode, parent: any, ctx: RestoreContext, report: RestoreReport, path: string, opts: RestoreOptions): Promise<any> {
  const kids = d.children ?? [];
  if (!kids.length) {
    report.skipped.push({ path, type: "GROUP", why: "an empty GROUP cannot exist, so it cannot be rebuilt" });
    return null;
  }
  const made: any[] = [];
  try {
    for (let i = 0; i < kids.length; i++) {
      const child = await buildNode(kids[i], parent, ctx, report, `${path}.children[${i}]`, opts);
      if (child) made.push(child);
    }
    if (!made.length) {
      report.skipped.push({ path, type: "GROUP", why: "none of its children could be rebuilt" });
      return null;
    }
    const group = ctx.figma.group(made, parent);
    group.name = d.name;
    await applyVariableModes(group, d.meta?.variableModes, ctx, report, path);
    applyLayout(group, d.state, report, path);
    await applyFinal(group, d.state, ctx, report, path, false, d.meta);
    await applyStyleLinks(group, d.meta?.styleIds, ctx, report, path);
    await applyVariableBindings(group, d.meta?.variableBindings, d.state, ctx, report, path);
    report.created++;
    return group;
  } catch (e) {
    if (!opts.allowPartial) throw new Error(`${path} (GROUP "${d.name}"): ${msg(e)}`);
    report.skipped.push({ path, type: "GROUP", why: msg(e) });
    return null;
  }
}

async function createNode(d: DumpNode, ctx: RestoreContext, report: RestoreReport, path: string): Promise<any> {
  const f = ctx.figma;
  let node: any;
  switch (d.type) {
    case "FRAME": node = f.createFrame(); break;
    case "COMPONENT":
      node = f.createComponent();
      report.notes.push(`${path}: a restored COMPONENT is a NEW component — its key, id and instances do not come back`);
      break;
    case "SECTION": node = f.createSection(); break;
    case "RECTANGLE": node = f.createRectangle(); break;
    case "ELLIPSE": node = f.createEllipse(); break;
    case "LINE": node = f.createLine(); break;
    case "TEXT": node = f.createText(); break;
    case "VECTOR": node = f.createVector(); break;
    case "INSTANCE": {
      const main = await resolveMain(d.state.instance ?? {}, ctx);
      if (!main) {
        const inst = d.state.instance ?? {};
        throw new Error(
          `its main component could not be resolved (id ${inst.componentId ?? "?"}, key ${inst.componentKey ?? "?"}` +
            `${inst.componentName ? `, "${inst.componentName}"` : ""}): the component is not in this file and not importable from a library`,
        );
      }
      node = main.createInstance();
      break;
    }
    default:
      throw new Error(`checkpoint-v1 cannot build a ${d.type}`);
  }
  node.name = d.name;
  return node;
}

async function resolveMain(inst: Dict, ctx: RestoreContext): Promise<any> {
  if (inst.componentId) {
    try {
      const local = await ctx.figma.getNodeByIdAsync(inst.componentId);
      if (local && local.removed !== true && (local.type === "COMPONENT" || local.type === "COMPONENT_SET")) return local;
    } catch {
      /* fall through to the key */
    }
  }
  if (inst.componentKey) {
    try {
      return await ctx.figma.importComponentByKeyAsync(inst.componentKey);
    } catch {
      /* the key is not importable (unpublished, or from a library that is gone) */
    }
  }
  return null;
}

/** Phase A: everything that must be true BEFORE children exist, so they land in the right layout. */
function applyLayout(node: any, state: Dict, report: RestoreReport, path: string): void {
  const L = state?.layout;
  if (!L || !("layoutMode" in node)) return;
  try {
    if (L.mode) node.layoutMode = L.mode;
    if (Array.isArray(L.padding)) {
      node.paddingTop = L.padding[0];
      node.paddingRight = L.padding[1];
      node.paddingBottom = L.padding[2];
      node.paddingLeft = L.padding[3];
    }
    if (typeof L.gap === "number") node.itemSpacing = L.gap;
    if (L.wrap && "layoutWrap" in node) {
      node.layoutWrap = "WRAP";
      if (typeof L.counterGap === "number") node.counterAxisSpacing = L.counterGap;
    }
    if (L.primaryAlign) node.primaryAxisAlignItems = L.primaryAlign;
    if (L.counterAlign) node.counterAxisAlignItems = L.counterAlign;
    if (L.primary && "primaryAxisSizingMode" in node) node.primaryAxisSizingMode = L.primary;
    if (L.counter && "counterAxisSizingMode" in node) node.counterAxisSizingMode = L.counter;
    if (L.strokesIncluded && "strokesIncludedInLayout" in node) node.strokesIncludedInLayout = true;
    if (L.reverseZ && "itemReverseZIndex" in node) node.itemReverseZIndex = true;
  } catch (e) {
    report.notes.push(`${path}: layout not fully applied: ${msg(e)}`);
  }
}

function ownsSize(node: any, state: Dict): boolean {
  // Derived from something else: the geometry (vector), the children (group), the
  // text metrics, or the auto-layout engine. Resizing would fight the owner and
  // the comparison afterwards would report OUR change as a difference.
  if (node.type === "VECTOR" || node.type === "GROUP") return false;
  if (node.type === "TEXT") return state?.text?.autoResize === "NONE";
  const L = state?.layout;
  if (L && (L.primary === "AUTO" || L.counter === "AUTO")) return false;
  return true;
}

/** Phase B: size, position and appearance. `isRoot` keeps the target where it is. */
async function applyFinal(node: any, state: Dict, ctx: RestoreContext, report: RestoreReport, path: string, isRoot: boolean, meta?: Dict): Promise<void> {
  const soft = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      report.notes.push(`${path}: ${what} not restored: ${msg(e)}`);
    }
  };

  if (typeof state.rotation === "number" && "rotation" in node) soft("rotation", () => { node.rotation = state.rotation; });
  if (Array.isArray(state.sizing) && "layoutSizingHorizontal" in node) {
    soft("layout sizing", () => { node.layoutSizingHorizontal = state.sizing[0]; node.layoutSizingVertical = state.sizing[1]; });
  }
  if (Array.isArray(state.size) && typeof state.size[0] === "number") {
    if (ownsSize(node, state)) soft("size", () => { node.resize(state.size[0], state.size[1]); });
  }
  if (Array.isArray(state.minSize) && "minWidth" in node) soft("min size", () => { node.minWidth = state.minSize[0]; node.minHeight = state.minSize[1]; });
  if (Array.isArray(state.maxSize) && "maxWidth" in node) soft("max size", () => { node.maxWidth = state.maxSize[0]; node.maxHeight = state.maxSize[1]; });
  if (state.layoutPositioning === "ABSOLUTE" && "layoutPositioning" in node) soft("absolute positioning", () => { node.layoutPositioning = "ABSOLUTE"; });
  if (!isRoot && Array.isArray(state.pos) && "x" in node) soft("position", () => { node.x = state.pos[0]; node.y = state.pos[1]; });
  if (state.layoutAlign && "layoutAlign" in node) soft("layout align", () => { node.layoutAlign = state.layoutAlign; });
  if (typeof state.layoutGrow === "number" && "layoutGrow" in node) soft("layout grow", () => { node.layoutGrow = state.layoutGrow; });
  if (Array.isArray(state.constraints) && "constraints" in node) {
    soft("constraints", () => { node.constraints = { horizontal: state.constraints[0], vertical: state.constraints[1] }; });
  }

  applyPaints(node, "fills", state.fills, report, path);
  if (state.effects !== undefined && "effects" in node) applyPaints(node, "effects", state.effects, report, path);
  applyPaints(node, "strokes", state.strokes, report, path);
  if (state.layoutGrids !== undefined && "layoutGrids" in node) applyPaints(node, "layoutGrids", state.layoutGrids, report, path);
  if (typeof state.strokeWeight === "number" && "strokeWeight" in node) soft("stroke weight", () => { node.strokeWeight = state.strokeWeight; });
  else if (Array.isArray(state.strokeWeight) && "strokeTopWeight" in node) {
    soft("stroke weights", () => {
      node.strokeTopWeight = state.strokeWeight[0];
      node.strokeRightWeight = state.strokeWeight[1];
      node.strokeBottomWeight = state.strokeWeight[2];
      node.strokeLeftWeight = state.strokeWeight[3];
    });
  }
  if (state.strokeAlign && "strokeAlign" in node) soft("stroke align", () => { node.strokeAlign = state.strokeAlign; });
  if (state.strokeCap && "strokeCap" in node) soft("stroke cap", () => { node.strokeCap = state.strokeCap; });
  if (state.strokeJoin && "strokeJoin" in node) soft("stroke join", () => { node.strokeJoin = state.strokeJoin; });
  if (Array.isArray(state.dashPattern) && "dashPattern" in node) soft("dash pattern", () => { node.dashPattern = state.dashPattern; });
  if (typeof state.cornerRadius === "number" && "cornerRadius" in node) soft("corner radius", () => { node.cornerRadius = state.cornerRadius; });
  else if (Array.isArray(state.cornerRadius) && "topLeftRadius" in node) {
    soft("corner radii", () => {
      node.topLeftRadius = state.cornerRadius[0];
      node.topRightRadius = state.cornerRadius[1];
      node.bottomRightRadius = state.cornerRadius[2];
      node.bottomLeftRadius = state.cornerRadius[3];
    });
  }
  if (state.arcData && "arcData" in node) soft("arc data", () => { node.arcData = state.arcData; });
  if (typeof state.opacity === "number" && "opacity" in node) soft("opacity", () => { node.opacity = state.opacity; });
  if (state.blendMode && "blendMode" in node) soft("blend mode", () => { node.blendMode = state.blendMode; });
  if (state.isMask && "isMask" in node) soft("mask", () => { node.isMask = true; if (state.maskType && "maskType" in node) node.maskType = state.maskType; });
  if (state.clipsContent && "clipsContent" in node) soft("clips content", () => { node.clipsContent = true; });
  if (state.visible === false) soft("visibility", () => { node.visible = false; });
  if (state.locked === true) soft("locked", () => { node.locked = true; });

  if (node.type === "TEXT") await applyText(node, state.text, ctx, report, path, meta);
  if (node.type === "INSTANCE" && state.instance?.properties) applyInstanceProperties(node, state.instance.properties, report, path);
  if (node.type === "VECTOR" && state.vector) {
    // setVectorNetworkAsync is the only way back into a vector: the network is
    // read-only. Its size follows from the geometry, which is why ownsSize()
    // refuses to resize a VECTOR.
    try {
      await node.setVectorNetworkAsync(state.vector);
      if (state.windingRule) node.windingRule = state.windingRule;
    } catch (e) {
      report.notes.push(`${path}: vector network not restored: ${msg(e)}`);
    }
  }
}

/**
 * Paint writes are the one place a documented value can be refused: a paint that
 * carries a variable binding fails to apply when the variable is not available.
 * The retry drops the binding rather than the paint, and says so — a colour
 * restored by value beats a colour that vanished.
 */
function applyPaints(node: any, field: string, value: any, report: RestoreReport, path: string): void {
  if (value === undefined || value === null || value === "mixed") return;
  if (!(field in node)) return;
  try {
    node[field] = value;
  } catch {
    const stripped = Array.isArray(value)
      ? value.map((p: any) => {
          if (!p || typeof p !== "object") return p;
          const { boundVariables, ...rest } = p;
          return rest;
        })
      : value;
    try {
      node[field] = stripped;
      report.bindingsDropped.push(`${path}.state.${field}`);
    } catch (e) {
      report.notes.push(`${path}: ${field} not restored: ${msg(e)}`);
    }
  }
}

const isAlias = (value: any): value is { type: "VARIABLE_ALIAS"; id: string } =>
  !!value && typeof value === "object" && value.type === "VARIABLE_ALIAS" && typeof value.id === "string";

/** Alias lists that are already carried by the paint/effect/grid values in `state`. */
const PAINT_LEVEL_BINDINGS = new Set(["fills", "strokes", "effects", "layoutGrids"]);

async function resolveVariable(alias: any, ctx: RestoreContext): Promise<{ variable?: any; why?: string }> {
  if (!isAlias(alias)) return { why: "the recorded binding is not a variable alias" };
  const api = ctx.figma?.variables;
  if (!api || typeof api.getVariableByIdAsync !== "function") {
    return { why: "the Variables API is not available in this session" };
  }
  try {
    const variable = await api.getVariableByIdAsync(alias.id);
    if (variable) return { variable };
  } catch (e) {
    return { why: msg(e) };
  }
  return { why: "the variable no longer exists in this file" };
}

/**
 * Explicit modes decide WHICH value a bound variable resolves to, so they are
 * applied before children are built and before any paint is written.
 */
async function applyVariableModes(node: any, modes: Dict | undefined, ctx: RestoreContext, report: RestoreReport, path: string): Promise<void> {
  if (!modes || typeof modes !== "object") return;
  for (const [collectionId, modeId] of Object.entries(modes)) {
    if (typeof modeId !== "string") continue;
    const missing = (why: string) => report.modesMissing.push({ path, collectionId, modeId, why });
    if (typeof node.setExplicitVariableModeForCollection !== "function") {
      missing(`a ${node.type} cannot carry an explicit variable mode`);
      continue;
    }
    const api = ctx.figma?.variables;
    if (!api || typeof api.getVariableCollectionByIdAsync !== "function") {
      missing("the Variables API is not available in this session");
      continue;
    }
    let collection: any = null;
    try {
      collection = await api.getVariableCollectionByIdAsync(collectionId);
    } catch (e) {
      missing(msg(e));
      continue;
    }
    if (!collection) {
      missing("the variable collection no longer exists in this file");
      continue;
    }
    const mode = Array.isArray(collection.modes) ? collection.modes.find((m: any) => m && m.modeId === modeId) : null;
    if (!mode) {
      missing(`the collection no longer has mode ${modeId}`);
      continue;
    }
    try {
      node.setExplicitVariableModeForCollection(collection, modeId);
      report.modesRestored.push({
        path,
        collectionId,
        collectionName: collection.name,
        modeId,
        modeName: mode.name,
      });
    } catch (e) {
      missing(msg(e));
    }
  }
}

/**
 * Re-bind node-level variables (width, padding, opacity, text metrics, …) by
 * id. A variable the file no longer has leaves the explicitly restored value in
 * place and is named; it is never replaced by a guessed value.
 */
async function applyVariableBindings(node: any, bindings: Dict | undefined, state: Dict | undefined, ctx: RestoreContext, report: RestoreReport, path: string): Promise<void> {
  if (!bindings || typeof bindings !== "object") return;
  for (const [field, value] of Object.entries(bindings)) {
    if (PAINT_LEVEL_BINDINGS.has(field)) continue;

    if (field === "textRangeFills") {
      // The paints already carry a whole-text binding when there is one. A
      // mixed fill has per-range bindings; text runs are restored, but the
      // aliases attached to those runs are not.
      if (state?.fills === "mixed") {
        for (const alias of (Array.isArray(value) ? value : [value]).filter(isAlias)) {
          report.bindingsMissing.push({
            path, field, id: alias.id,
            why: "per-range text fill bindings are not rebuilt; literal run fills were restored without the binding",
          });
        }
      }
      continue;
    }

    if (field === "componentProperties" && value && typeof value === "object") {
      for (const [name, alias] of Object.entries(value as Dict)) {
        if (!isAlias(alias)) continue;
        const resolved = await resolveVariable(alias, ctx);
        if (!resolved.variable) {
          report.bindingsMissing.push({ path, field: `componentProperties.${name}`, id: alias.id, why: resolved.why ?? "unresolved" });
          continue;
        }
        if (typeof node.setProperties !== "function") {
          report.bindingsMissing.push({ path, field: `componentProperties.${name}`, id: alias.id, why: "this node does not expose component properties" });
          continue;
        }
        try {
          const aliasValue = ctx.figma?.variables?.createVariableAlias
            ? ctx.figma.variables.createVariableAlias(resolved.variable)
            : { type: "VARIABLE_ALIAS", id: resolved.variable.id };
          node.setProperties({ [name]: aliasValue });
          report.bindingsRestored.push({ path, field: `componentProperties.${name}`, id: resolved.variable.id, name: resolved.variable.name });
        } catch (e) {
          report.bindingsMissing.push({ path, field: `componentProperties.${name}`, id: alias.id, why: msg(e) });
        }
      }
      continue;
    }

    const aliases = (Array.isArray(value) ? value : [value]).filter(isAlias);
    if (!aliases.length) continue;
    // Text fields are per-range arrays. One alias (or the same alias on every
    // range) can be applied to the whole text; several different ones cannot,
    // because the runs themselves are not rebuilt.
    const ids = [...new Set(aliases.map((a) => a.id))];
    if (ids.length > 1) {
      report.bindingsMissing.push({
        path, field, id: ids.join(","),
        why: `${aliases.length} different per-range bindings; text runs are restored but their variable bindings are not`,
      });
      continue;
    }
    const alias = aliases[0];
    const resolved = await resolveVariable(alias, ctx);
    if (!resolved.variable) {
      report.bindingsMissing.push({ path, field, id: alias.id, why: resolved.why ?? "unresolved" });
      continue;
    }
    if (typeof node.setBoundVariable !== "function") {
      report.bindingsMissing.push({ path, field, id: alias.id, why: `a ${node.type} has no bindable ${field} field` });
      continue;
    }
    try {
      node.setBoundVariable(field, resolved.variable);
      report.bindingsRestored.push({ path, field, id: resolved.variable.id, name: resolved.variable.name });
    } catch (e) {
      report.bindingsMissing.push({ path, field, id: alias.id, why: msg(e) });
    }
  }
}

/**
 * Re-link a style by its stable id. The paint/font VALUE is already restored,
 * so a style the file no longer owns leaves a correct-looking node with no
 * link — and this is reported rather than presented as a full restore.
 */
async function applyStyleLinks(node: any, ids: Dict | undefined, ctx: RestoreContext, report: RestoreReport, path: string): Promise<void> {
  if (!ids) return;
  for (const [field, id] of Object.entries(ids)) {
    if (!(field in node)) continue;
    const styleId = String(id);
    try {
      const style = ctx.figma.getStyleByIdAsync ? await ctx.figma.getStyleByIdAsync(styleId) : null;
      if (!style) {
        report.stylesMissing.push({ path, field, id: styleId, why: "the style no longer exists in this file" });
        continue;
      }
      if (field === "textStyleId" && style.fontName && ctx.loadFont) {
        try { await ctx.loadFont(style.fontName); } catch { /* the setter reports the real problem */ }
      }
      if (field === "textStyleId" && typeof node.setTextStyleIdAsync === "function") {
        await node.setTextStyleIdAsync(styleId);
      } else {
        node[field] = styleId;
      }
      report.stylesRestored.push({ path, field, id: styleId, name: style.name });
    } catch (e) {
      report.stylesMissing.push({ path, field, id: styleId, why: msg(e) });
    }
  }
}

function applyInstanceProperties(node: any, props: Dict, report: RestoreReport, path: string): void {
  for (const [name, value] of Object.entries(props)) {
    try {
      node.setProperties({ [name]: value });
    } catch (e) {
      report.propertiesFailed.push({ path, name, why: msg(e) });
    }
  }
}

async function applyText(node: any, text: Dict, ctx: RestoreContext, report: RestoreReport, path: string, meta?: Dict): Promise<void> {
  if (!text) return;
  const fallback = ctx.fallbackFont ?? { family: "Inter", style: "Regular" };
  const runs: Dict[] = Array.isArray(text.textRuns)
    ? text.textRuns.filter((r: any) => r && Number.isInteger(r.start) && Number.isInteger(r.end) && r.end > r.start)
    : [];
  const hasRuns = runs.length > 0;
  const firstRun = hasRuns ? runs[0] : null;
  const recordedFont = text.font && text.font !== "mixed" ? text.font : null;
  let baseFont = recordedFont || (firstRun && firstRun.font) || null;
  let styled = !!baseFont;

  if (baseFont && ctx.loadFont) {
    try {
      await ctx.loadFont(baseFont);
    } catch {
      styled = false;
      report.fontsUnavailable.push(`${baseFont.family} ${baseFont.style}`);
      if (hasRuns) {
        report.notes.push(`${path}: base font "${baseFont.family} ${baseFont.style}" is not available — the recorded runs are applied without it`);
      } else {
        report.notes.push(`${path}: font "${baseFont.family} ${baseFont.style}" is not available — the text comes back in ${fallback.family} ${fallback.style}`);
      }
    }
  }
  if (!baseFont) {
    if (!hasRuns) {
      report.notes.push(`${path}: this text uses MIXED fonts and the checkpoint has no run data; the characters come back in ${fallback.family} ${fallback.style}`);
    }
  }
  if (hasRuns && meta?.textRunStyles) {
    const parts: string[] = [];
    if (Array.isArray(meta.textRunStyles.textStyleIds) && meta.textRunStyles.textStyleIds.length) parts.push("text");
    if (Array.isArray(meta.textRunStyles.fillStyleIds) && meta.textRunStyles.fillStyleIds.length) parts.push("fill");
    if (parts.length) {
      report.notes.push(`${path}: per-run ${parts.join(" and ")} style links are not rebuilt; literal run values were restored`);
    }
  }

  const runFontReady: boolean[] = runs.map(() => true);
  if (ctx.loadFont) {
    for (let i = 0; i < runs.length; i++) {
      const f = runs[i].font;
      if (!f) continue;
      try {
        await ctx.loadFont(f);
      } catch {
        runFontReady[i] = false;
        const key = `${f.family} ${f.style}`;
        if (!report.fontsUnavailable.includes(key)) report.fontsUnavailable.push(key);
        report.notes.push(`${path}: run ${i} font "${key}" is not available — that run's font was not restored`);
      }
    }
  }
  // Characters need *some* loaded font even when every run carries its own:
  // the character setter runs before the ranges are applied. If the recorded
  // base font is unavailable, fall back for the base and let the run fonts
  // replace it range by range.
  if (!styled && ctx.loadFont) {
    try {
      await ctx.loadFont(fallback);
      baseFont = fallback;
      styled = true;
    } catch (e) {
      report.notes.push(`${path}: even ${fallback.family} ${fallback.style} failed to load: ${msg(e)}`);
    }
  }

  const soft = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      report.notes.push(`${path}: text ${what} not restored: ${msg(e)}`);
    }
  };

  soft("characters", () => { node.characters = text.characters ?? ""; });
  if (styled) soft("font", () => { node.fontName = baseFont; });
  if (typeof text.fontSize === "number") soft("font size", () => { node.fontSize = text.fontSize; });
  if (text.lineHeight && text.lineHeight !== "mixed") soft("line height", () => { node.lineHeight = text.lineHeight; });
  if (text.letterSpacing && text.letterSpacing !== "mixed") soft("letter spacing", () => { node.letterSpacing = text.letterSpacing; });
  if (text.textCase && text.textCase !== "mixed") soft("text case", () => { node.textCase = text.textCase; });
  if (text.textDecoration && text.textDecoration !== "mixed") soft("text decoration", () => { node.textDecoration = text.textDecoration; });
  if (typeof text.paragraphSpacing === "number") soft("paragraph spacing", () => { node.paragraphSpacing = text.paragraphSpacing; });
  if (typeof text.paragraphIndent === "number") soft("paragraph indent", () => { node.paragraphIndent = text.paragraphIndent; });
  if (text.hyperlink !== undefined) {
    if (text.hyperlink === "mixed") {
      if (!hasRuns) {
        report.notes.push(`${path}: this text has MIXED hyperlinks and the checkpoint has no run data; the characters come back without the per-run links`);
      }
    } else {
      soft("hyperlink", () => { node.hyperlink = text.hyperlink; });
    }
  }

  if (hasRuns) {
    const length = typeof node.characters === "string" ? node.characters.length : 0;
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      const start = Number(run.start);
      const end = Number(run.end);
      if (start >= length || end > length) {
        report.notes.push(`${path}: run ${i} range ${start}..${end} is outside the restored text (${length} characters)`);
        continue;
      }
      const runSoft = (what: string, fn: () => void) => {
        try {
          fn();
        } catch (e) {
          report.notes.push(`${path}: run ${i} ${what} not restored: ${msg(e)}`);
        }
      };
      if (run.font && runFontReady[i] && typeof node.setRangeFontName === "function") {
        runSoft("font", () => { node.setRangeFontName(start, end, run.font); });
      }
      if (run.fontSize !== undefined && typeof node.setRangeFontSize === "function") {
        runSoft("font size", () => { node.setRangeFontSize(start, end, Number(run.fontSize)); });
      }
      if (run.fills !== undefined && typeof node.setRangeFills === "function") {
        runSoft("fills", () => {
          try {
            node.setRangeFills(start, end, run.fills);
          } catch {
            const stripped = run.fills.map((p: any) => {
              if (!p || typeof p !== "object") return p;
              const { boundVariables, ...rest } = p;
              return rest;
            });
            node.setRangeFills(start, end, stripped);
            report.bindingsDropped.push(`${path}.state.text.textRuns[${i}].fills`);
          }
        });
      }
      if (run.textCase !== undefined && typeof node.setRangeTextCase === "function") {
        runSoft("text case", () => { node.setRangeTextCase(start, end, run.textCase); });
      }
      if (run.textDecoration !== undefined && typeof node.setRangeTextDecoration === "function") {
        runSoft("text decoration", () => { node.setRangeTextDecoration(start, end, run.textDecoration); });
      }
      if (run.lineHeight !== undefined && typeof node.setRangeLineHeight === "function") {
        runSoft("line height", () => { node.setRangeLineHeight(start, end, run.lineHeight); });
      }
      if (run.letterSpacing !== undefined && typeof node.setRangeLetterSpacing === "function") {
        runSoft("letter spacing", () => { node.setRangeLetterSpacing(start, end, run.letterSpacing); });
      }
      if (run.hyperlink !== undefined && typeof node.setRangeHyperlink === "function") {
        runSoft("hyperlink", () => { node.setRangeHyperlink(start, end, run.hyperlink); });
      }
    }
  }

  if (Array.isArray(text.align)) {
    soft("alignment", () => {
      node.textAlignHorizontal = text.align[0];
      node.textAlignVertical = text.align[1];
    });
  }
  if (text.autoResize) soft("auto-resize", () => { node.textAutoResize = text.autoResize; });
}
