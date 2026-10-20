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
 *     component properties and direct per-layer overrides re-applied — the
 *     interior's STRUCTURE is the main component's current structure;
 *   - the runs themselves (font, size, fills, style links, variable bindings,
 *     case, decoration, line height, letter spacing and hyperlink) are saved
 *     and rebuilt;
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
  "an INSTANCE's interior STRUCTURE is its main component's current structure; direct per-layer overrides are captured and re-applied, but a layer added to or removed from the main component is not described by the checkpoint",
  "a direct instance override that changed per-run text styling is captured with the layer snapshot and replayed range by range; a per-run style link or variable binding that the override REMOVED is not cleared from the main component's current run",
  "text runs are rebuilt (font, size, fills, text/fill style links, variable bindings, case, decoration, line height, letter spacing and hyperlink)",
  "style ids are re-linked when the style still exists; node-level and run-level variable bindings and explicit modes are re-linked when their variable, collection and mode still exist, and every missing link is reported",
  "a restored COMPONENT is a NEW component: the checkpoint's key, id and instances do not come back",
  "a restored COMPONENT_SET is a new set: its variant components are rebuilt, its non-variant properties are added back by type and default value, layer references are remapped to the new names, and property descriptions, preferred values, slot settings and definition-level default-value variable bindings are restored when their property type and a live variable allow it; variant options come from the component names, while component/property ids, component keys and existing instances do not come back",
  "a restored root's own componentPropertyReferences point at its parent component, which is outside the checkpoint, so they are not replayed",
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
  /** Variable bindings re-applied because the variable still exists. */
  bindingsRestored: Array<{ path: string; field: string; id: string; name?: string }>;
  /** Variable bindings the file could not resolve; the value is still restored. */
  bindingsMissing: Array<{ path: string; field: string; id: string; why: string }>;
  /** Direct per-layer overrides re-applied inside a rebuilt INSTANCE. */
  overridesRestored: Array<{ path: string; fields: number }>;
  /** Direct overrides whose target path no longer matches the main component. */
  overridesMissing: Array<{ path: string; why: string }>;
  /** Direct override fields this version cannot write back; named, not hidden. */
  overridesUnsupported: Array<{ path: string; fields: string[] }>;
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
  if ("exportSettings" in node) s.exportSettings = list(node.exportSettings) ?? [];
  if ("componentPropertyDefinitions" in node) {
    // Omitted when empty, like layout grids: an old checkpoint of a component
    // with no properties still compares equal against a fresh dump.
    const defs = copy(node.componentPropertyDefinitions);
    if (defs && Object.keys(defs).length) s.componentPropertyDefinitions = defs;
  }
  if ("componentPropertyReferences" in node && node.componentPropertyReferences) {
    const refs = copy(node.componentPropertyReferences);
    if (refs && Object.keys(refs).length) s.componentPropertyReferences = refs;
  }
  if ("arcData" in node) s.arcData = copy(node.arcData);
  if ("pointCount" in node) s.pointCount = node.pointCount;
  if ("innerRadius" in node) s.innerRadius = node.innerRadius;
  if ("booleanOperation" in node) s.booleanOperation = node.booleanOperation;

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

const TEXT_RANGE_FIELDS = new Set([
  "fontFamily", "fontStyle", "fontWeight", "fontSize",
  "letterSpacing", "lineHeight", "paragraphSpacing", "paragraphIndent",
]);

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
  if (typeof seg.textStyleId === "string" && seg.textStyleId) out.textStyleId = seg.textStyleId;
  if (typeof seg.fillStyleId === "string" && seg.fillStyleId) out.fillStyleId = seg.fillStyleId;
  if (isObj(seg.boundVariables)) {
    const variables: Dict = {};
    for (const field of TEXT_RANGE_FIELDS) {
      const alias = seg.boundVariables[field];
      if (isAlias(alias)) variables[field] = copy(alias);
    }
    if (Object.keys(variables).length) out.variables = variables;
  }
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
      "lineHeight", "letterSpacing", "hyperlink", "textStyleId", "fillStyleId",
      "boundVariables",
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

/**
 * The path to a directly overridden layer, from the INSTANCE down. Names come
 * from the main component, not the instance: renaming a layer is itself an
 * override, and a path carrying the new name would not match the layer created
 * from the main component. The index is the structural selector; the name makes
 * a path readable and catches a main component whose structure moved.
 */
/**
 * Override fields this version knows how to write back. The rest are named on
 * the record (and in the restore report) rather than silently skipped: a
 * checkpoint that says "restored" while dropping a field is worse than one that
 * says exactly what is missing.
 */
const SUPPORTED_OVERRIDE_FIELDS = new Set([
  "name", "visible", "locked", "opacity", "blendMode", "isMask", "maskType", "clipsContent",
  "x", "y", "width", "height", "rotation", "cornerRadius",
  "topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius",
  "constraints", "layoutAlign", "layoutGrow", "layoutPositioning",
  "layoutSizingHorizontal", "layoutSizingVertical",
  "layoutMode", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "itemSpacing", "primaryAxisAlignItems", "counterAxisAlignItems",
  "primaryAxisSizingMode", "counterAxisSizingMode", "layoutWrap",
  "counterAxisSpacing", "strokesIncludedInLayout", "itemReverseZIndex",
  "minWidth", "minHeight", "maxWidth", "maxHeight", "layoutGrids",
  "pointCount", "innerRadius",
  "fills", "fillStyleId", "strokes", "strokeStyleId", "strokeWeight",
  "strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight",
  "strokeAlign", "strokeCap", "strokeJoin", "dashPattern",
  "effects", "effectStyleId", "arcData", "vectorNetwork", "vectorPaths", "windingRule",
  "characters", "fontName", "fontSize", "lineHeight", "letterSpacing",
  "textCase", "textDecoration", "paragraphSpacing", "paragraphIndent",
  "hyperlink", "textAlignHorizontal", "textAlignVertical", "textAutoResize",
  "textStyleId", "componentProperties",
]);

function instanceOverridePath(instance: any, target: any, main: any): any[] | null {
  const nodes: any[] = [];
  let node = target;
  while (node && node !== instance) {
    const parent = node.parent;
    if (!parent) return null;
    nodes.unshift(node);
    node = parent;
  }
  if (node !== instance || !nodes.length) return null;

  const path: any[] = [];
  let base = main;
  for (const step of nodes) {
    const parent = step.parent;
    const index = (parent.children || []).indexOf(step);
    if (index < 0) return null;
    const baseChild = base && Array.isArray(base.children) ? base.children[index] : null;
    const name = baseChild && typeof baseChild.name === "string" ? baseChild.name : "";
    path.push(name ? { name, index } : { index });
    base = baseChild || null;
  }
  return path;
}

/**
 * A direct override is a SNAPSHOT of one layer, not a diff: the layer belongs
 * to the main component, and the checkpoint is restoring the state the user
 * saw. Defaults are written explicitly so an override that set a value back to
 * its default still beats whatever the main component does today.
 */
function readOverrideState(node: any): Dict {
  const s = readState(node);
  if ("rotation" in node) s.rotation = round(node.rotation);
  if ("visible" in node) s.visible = node.visible === true;
  if ("locked" in node) s.locked = node.locked === true;
  if ("opacity" in node) s.opacity = node.opacity;
  if ("blendMode" in node) s.blendMode = node.blendMode;
  if ("isMask" in node) s.isMask = node.isMask === true;
  if ("maskType" in node && node.maskType) s.maskType = node.maskType;
  if ("clipsContent" in node) s.clipsContent = node.clipsContent === true;
  if ("layoutGrids" in node) s.layoutGrids = list(node.layoutGrids) ?? [];
  if ("layoutMode" in node) {
    const L: Dict = s.layout || {};
    L.mode = node.layoutMode;
    L.padding = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft];
    L.gap = node.itemSpacing;
    L.primaryAlign = node.primaryAxisAlignItems;
    L.counterAlign = node.counterAxisAlignItems;
    if ("primaryAxisSizingMode" in node) L.primary = node.primaryAxisSizingMode;
    if ("counterAxisSizingMode" in node) L.counter = node.counterAxisSizingMode;
    if ("layoutWrap" in node) L.wrap = node.layoutWrap === "WRAP";
    if ("counterAxisSpacing" in node) L.counterGap = node.counterAxisSpacing;
    if ("strokesIncludedInLayout" in node) L.strokesIncluded = node.strokesIncludedInLayout === true;
    if ("itemReverseZIndex" in node) L.reverseZ = node.itemReverseZIndex === true;
    s.layout = L;
  }
  if ("layoutAlign" in node) s.layoutAlign = node.layoutAlign;
  if ("layoutGrow" in node) s.layoutGrow = node.layoutGrow;
  if ("layoutPositioning" in node) s.layoutPositioning = node.layoutPositioning;
  if ("minWidth" in node) s.minSize = [node.minWidth, node.minHeight];
  if ("maxWidth" in node) s.maxSize = [node.maxWidth, node.maxHeight];
  if (node.type === "TEXT" && s.text) {
    if (s.text.hyperlink === undefined) s.text.hyperlink = null;
    if (s.text.textCase === undefined) s.text.textCase = isMixedValue(node.textCase) ? "mixed" : (node.textCase || "ORIGINAL");
    if (s.text.textDecoration === undefined) s.text.textDecoration = isMixedValue(node.textDecoration) ? "mixed" : (node.textDecoration || "NONE");
    if (typeof s.text.paragraphSpacing !== "number") s.text.paragraphSpacing = node.paragraphSpacing ?? 0;
    if (typeof s.text.paragraphIndent !== "number") s.text.paragraphIndent = node.paragraphIndent ?? 0;
  }
  return s;
}

/**
 * Style ids for a direct override, including the EMPTY ones: a removed style
 * link is as much a snapshot as a new one, and the rebuild has to clear what
 * the main component carries today.
 */
function readOverrideMeta(node: any): Dict | undefined {
  const meta = readMeta(node) || {};
  const ids: Dict = {};
  for (const field of ["fillStyleId", "strokeStyleId", "effectStyleId", "textStyleId"]) {
    if (!(field in node)) continue;
    const value = node[field];
    ids[field] = typeof value === "string" && !isMixedValue(value) ? value : "";
  }
  if (Object.keys(ids).length) meta.styleIds = ids;
  return Object.keys(meta).length ? meta : undefined;
}

async function readInstanceOverrides(
  instance: any,
  main: any,
  depth: number,
  budget: { n: number; truncated: boolean },
  maxNodes: number,
): Promise<any[] | undefined> {
  const entries = instance.overrides;
  if (!Array.isArray(entries) || !entries.length) return undefined;

  const byId = new Map<string, any>();
  const walk = (node: any) => {
    for (const child of node.children || []) {
      if (!child || typeof child.id !== "string") continue;
      byId.set(child.id, child);
      walk(child);
    }
  };
  walk(instance);

  const out: any[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry.id !== "string") continue;
    const target = byId.get(entry.id);
    if (budget.n >= maxNodes) {
      // A cut-short override list is as dangerous as a cut-short tree: the
      // restore would silently use the main component for the missing layers.
      budget.truncated = true;
      break;
    }
    budget.n++;
    const fields: string[] = Array.isArray(entry.overriddenFields) ? entry.overriddenFields.map((f: any) => String(f)) : [];
    if (!target) {
      // The layer is gone from the instance, but the entry is still a loss:
      // keep it so show and restore can name it instead of dropping it.
      out.push({
        path: null,
        name: "",
        fields,
        state: {},
        unresolved: `the overridden layer ${entry.id} is not present in this instance`,
      });
      continue;
    }
    const rec: Dict = {
      path: instanceOverridePath(instance, target, main),
      name: target.name,
      fields,
      state: readOverrideState(target),
    };
    const unsupported = fields.filter((f) => !SUPPORTED_OVERRIDE_FIELDS.has(f));
    if (unsupported.length) rec.unsupported = unsupported;
    const meta = readOverrideMeta(target);
    if (meta) rec.meta = meta;
    if (target.type === "INSTANCE" && depth < 8) rec.state.instance = await readInstance(target, depth + 1, budget, maxNodes);
    out.push(rec);
  }
  return out.length ? out : undefined;
}

async function readInstance(
  node: any,
  depth = 0,
  budget: { n: number; truncated: boolean } = { n: 0, truncated: false },
  maxNodes = MAX_NODES,
): Promise<Dict> {
  const out: Dict = {};
  let main: any = null;
  try {
    main = await node.getMainComponentAsync();
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
  if (depth < 8) {
    try {
      const overrides = await readInstanceOverrides(node, main, depth, budget, maxNodes);
      if (overrides) out.overrides = overrides;
    } catch (e) {
      out.overridesUnresolved = msg(e);
    }
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
  "STAR",
  "POLYGON",
  "BOOLEAN_OPERATION",
  "SLICE",
  "COMPONENT_SET",
]);

/** A node whose type we cannot build still records its identity, so the report can name it. */
function unsupportedWhy(type: string): string {
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
  if (node.type === "INSTANCE") out.state.instance = await readInstance(node, 0, budget, opts.maxNodes);
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
    overridesRestored: [],
    overridesMissing: [],
    overridesUnsupported: [],
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
  const restored: Array<{ node: any; dump: DumpNode; path: string }> = [];
  for (let i = 0; i < children.length; i++) {
    let child = children[i];
    if (dump.type === "COMPONENT_SET" && target.type === "COMPONENT_SET") {
      // The target set already owns these definitions; a variant rebuilt into
      // it must not add a duplicate copy before the set's own state is applied.
      child = { ...child, state: { ...(child.state ?? {}) } };
      delete child.state.componentPropertyDefinitions;
    }
    const built = await buildNode(child, target, ctx, report, `$.children[${i}]`, opts);
    if (built) restored.push({ node: built, dump: child, path: `$.children[${i}]` });
  }

  if (dump.type === target.type) {
    if (dump.state?.componentPropertyReferences) {
      report.notes.push("$: the target's own componentPropertyReferences point at its parent component and are not replayed");
    }
    await applyFinal(target, dump.state, ctx, report, "$", true);
    await applyStyleLinks(target, dump.meta?.styleIds, ctx, report, "$", dump.state);
    await applyVariableBindings(target, dump.meta?.variableBindings, dump.state, ctx, report, "$");
    if (dump.type === "COMPONENT") {
      const propertyMap = await applyComponentProperties(target, dump.state, ctx, report, "$");
      if (propertyMap.size) applyPropertyReferences(target, dump, propertyMap, report, "$");
    } else if (dump.type === "COMPONENT_SET") {
      const propertyMap = await applyComponentProperties(target, dump.state, ctx, report, "$");
      for (const b of restored) {
        applyNodeReferences(b.node, b.dump, propertyMap, report, b.path);
        applyPropertyReferences(b.node, b.dump, propertyMap, report, b.path);
      }
    }
  }
  return report;
}

async function buildNode(d: DumpNode, parent: any, ctx: RestoreContext, report: RestoreReport, path: string, opts: RestoreOptions): Promise<any> {
  if (d.unsupported) {
    report.skipped.push({ path, type: d.type, why: d.unsupported });
    return null;
  }
  if (d.type === "GROUP") return buildGroup(d, parent, ctx, report, path, opts);
  if (d.type === "BOOLEAN_OPERATION") return buildBoolean(d, parent, ctx, report, path, opts);
  if (d.type === "COMPONENT_SET") return buildComponentSet(d, parent, ctx, report, path, opts);

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
    await applyFinal(node, d.state, ctx, report, path, false);
    await applyStyleLinks(node, d.meta?.styleIds, ctx, report, path, d.state);
    await applyVariableBindings(node, d.meta?.variableBindings, d.state, ctx, report, path);
    if (d.type === "COMPONENT") {
      const propertyMap = await applyComponentProperties(node, d.state, ctx, report, path);
      if (propertyMap.size) applyPropertyReferences(node, d, propertyMap, report, path);
    }
    if (d.type === "INSTANCE") {
      await applyInstanceOverrides(node, d.state.instance?.overrides, ctx, report, path);
    }
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
    await applyFinal(group, d.state, ctx, report, path, false);
    await applyStyleLinks(group, d.meta?.styleIds, ctx, report, path, d.state);
    await applyVariableBindings(group, d.meta?.variableBindings, d.state, ctx, report, path);
    report.created++;
    return group;
  } catch (e) {
    if (!opts.allowPartial) throw new Error(`${path} (GROUP "${d.name}"): ${msg(e)}`);
    report.skipped.push({ path, type: "GROUP", why: msg(e) });
    return null;
  }
}

/**
 * A boolean operation is built from its children, exactly like a group: the
 * children are created first so the API can derive the operation's bounds, then
 * the matching figma.union/subtract/intersect/exclude makes the node. A boolean
 * needs at least two inputs; fewer is named rather than faked as a plain shape.
 */
async function buildBoolean(d: DumpNode, parent: any, ctx: RestoreContext, report: RestoreReport, path: string, opts: RestoreOptions): Promise<any> {
  const kids = d.children ?? [];
  if (kids.length < 2) {
    report.skipped.push({ path, type: "BOOLEAN_OPERATION", why: "a boolean operation needs at least two children, so it cannot be rebuilt" });
    return null;
  }
  const made: any[] = [];
  try {
    for (let i = 0; i < kids.length; i++) {
      const child = await buildNode(kids[i], parent, ctx, report, `${path}.children[${i}]`, opts);
      if (child) made.push(child);
    }
    if (made.length < 2) {
      report.skipped.push({ path, type: "BOOLEAN_OPERATION", why: "fewer than two of its children could be rebuilt" });
      return null;
    }
    const op = d.state.booleanOperation;
    const makers: Dict = {
      UNION: ctx.figma.union,
      SUBTRACT: ctx.figma.subtract,
      INTERSECT: ctx.figma.intersect,
      EXCLUDE: ctx.figma.exclude,
    };
    const maker = makers[op] ?? ctx.figma.union;
    if (typeof maker !== "function") throw new Error(`the Plugin API does not expose ${op || "UNION"}`);
    const node = maker(made, parent);
    node.name = d.name;
    if (op && "booleanOperation" in node) node.booleanOperation = op;
    await applyVariableModes(node, d.meta?.variableModes, ctx, report, path);
    applyLayout(node, d.state, report, path);
    await applyFinal(node, d.state, ctx, report, path, false);
    await applyStyleLinks(node, d.meta?.styleIds, ctx, report, path, d.state);
    await applyVariableBindings(node, d.meta?.variableBindings, d.state, ctx, report, path);
    report.created++;
    return node;
  } catch (e) {
    if (!opts.allowPartial) throw new Error(`${path} (BOOLEAN_OPERATION "${d.name}"): ${msg(e)}`);
    report.skipped.push({ path, type: "BOOLEAN_OPERATION", why: msg(e) });
    return null;
  }
}

/**
 * A component set is built from its variant COMPONENTs: each variant is created
 * first (without its set-level property definitions, which belong to the set),
 * then figma.combineAsVariants moves them under one set. The set's own state is
 * applied last, including the non-variant component properties. Component and
 * property ids cannot be preserved; the report carries that in LIMITATIONS.
 */
async function buildComponentSet(d: DumpNode, parent: any, ctx: RestoreContext, report: RestoreReport, path: string, opts: RestoreOptions): Promise<any> {
  const kids = d.children ?? [];
  if (!kids.length) {
    report.skipped.push({ path, type: "COMPONENT_SET", why: "an empty COMPONENT_SET cannot exist, so it cannot be rebuilt" });
    return null;
  }
  const made: any[] = [];
  const built: Array<{ node: any; dump: DumpNode; path: string }> = [];
  let set: any = null;
  try {
    for (let i = 0; i < kids.length; i++) {
      const childPath = `${path}.children[${i}]`;
      const childDump: DumpNode = { ...kids[i], state: { ...(kids[i].state ?? {}) } };
      // The set carries these definitions. Adding them to every variant before
      // combining would create duplicate properties under shifting ids.
      delete childDump.state.componentPropertyDefinitions;
      const child = await buildNode(childDump, parent, ctx, report, childPath, opts);
      if (child) {
        made.push(child);
        built.push({ node: child, dump: childDump, path: childPath });
      }
    }
    if (!made.length) {
      report.skipped.push({ path, type: "COMPONENT_SET", why: "none of its variants could be rebuilt" });
      return null;
    }
    if (made.some((n) => n.type !== "COMPONENT")) {
      throw new Error("a COMPONENT_SET can only contain COMPONENT variants");
    }
    set = ctx.figma.combineAsVariants(made, parent);
    set.name = d.name;
    await applyVariableModes(set, d.meta?.variableModes, ctx, report, path);
    applyLayout(set, d.state, report, path);
    await applyFinal(set, d.state, ctx, report, path, false);
    await applyStyleLinks(set, d.meta?.styleIds, ctx, report, path, d.state);
    await applyVariableBindings(set, d.meta?.variableBindings, d.state, ctx, report, path);
    const propertyMap = await applyComponentProperties(set, d.state, ctx, report, path);
    // Walk the variants we built, not set.children: Figma may reorder them by
    // position when combining, and a reference must not land on the wrong one.
    for (const b of built) {
      applyNodeReferences(b.node, b.dump, propertyMap, report, b.path);
      applyPropertyReferences(b.node, b.dump, propertyMap, report, b.path);
    }
    report.created++;
    return set;
  } catch (e) {
    if (!opts.allowPartial) throw new Error(`${path} (COMPONENT_SET "${d.name}"): ${msg(e)}`);
    report.skipped.push({ path, type: "COMPONENT_SET", why: msg(e) });
    // A skipped set must not leave half-built variants behind.
    try {
      if (set && !set.removed) set.remove();
      else for (const n of made) if (!n.removed) n.remove();
    } catch {
      /* cleanup is best effort */
    }
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
    case "STAR": node = f.createStar(); break;
    case "POLYGON": node = f.createPolygon(); break;
    case "SLICE": node = f.createSlice(); break;
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
    if (typeof L.wrap === "boolean" && "layoutWrap" in node) {
      node.layoutWrap = L.wrap ? "WRAP" : "NO_WRAP";
      if ("counterAxisSpacing" in node && L.counterGap !== undefined) node.counterAxisSpacing = L.counterGap;
    }
    if (L.primaryAlign) node.primaryAxisAlignItems = L.primaryAlign;
    if (L.counterAlign) node.counterAxisAlignItems = L.counterAlign;
    if (L.primary && "primaryAxisSizingMode" in node) node.primaryAxisSizingMode = L.primary;
    if (L.counter && "counterAxisSizingMode" in node) node.counterAxisSizingMode = L.counter;
    if (typeof L.strokesIncluded === "boolean" && "strokesIncludedInLayout" in node) node.strokesIncludedInLayout = L.strokesIncluded;
    if (typeof L.reverseZ === "boolean" && "itemReverseZIndex" in node) node.itemReverseZIndex = L.reverseZ;
  } catch (e) {
    report.notes.push(`${path}: layout not fully applied: ${msg(e)}`);
  }
}

function ownsSize(node: any, state: Dict): boolean {
  // Derived from something else: the geometry (vector), the children (group), the
  // text metrics, or the auto-layout engine. Resizing would fight the owner and
  // the comparison afterwards would report OUR change as a difference.
  if (node.type === "VECTOR" || node.type === "GROUP" || node.type === "BOOLEAN_OPERATION" || node.type === "COMPONENT_SET") return false;
  if (node.type === "TEXT") return state?.text?.autoResize === "NONE";
  const L = state?.layout;
  if (L && (L.primary === "AUTO" || L.counter === "AUTO")) return false;
  return true;
}

/** Phase B: size, position and appearance. `isRoot` keeps the target where it is. */
async function applyFinal(node: any, state: Dict, ctx: RestoreContext, report: RestoreReport, path: string, isRoot: boolean): Promise<void> {
  const soft = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      report.notes.push(`${path}: ${what} not restored: ${msg(e)}`);
    }
  };

  if (typeof state.rotation === "number" && "rotation" in node) soft("rotation", () => { node.rotation = state.rotation; });
  // Point count and inner radius describe the outline before the final box is
  // applied: resizing first and changing the outline afterwards can move the
  // star/polygon off the recorded size.
  if (typeof state.pointCount === "number" && "pointCount" in node) soft("point count", () => { node.pointCount = state.pointCount; });
  if (typeof state.innerRadius === "number" && "innerRadius" in node) soft("inner radius", () => { node.innerRadius = state.innerRadius; });
  if (state.booleanOperation && "booleanOperation" in node) soft("boolean operation", () => { node.booleanOperation = state.booleanOperation; });
  if (Array.isArray(state.sizing) && "layoutSizingHorizontal" in node) {
    soft("layout sizing", () => { node.layoutSizingHorizontal = state.sizing[0]; node.layoutSizingVertical = state.sizing[1]; });
  }
  if (Array.isArray(state.size) && typeof state.size[0] === "number") {
    if (ownsSize(node, state)) soft("size", () => { node.resize(state.size[0], state.size[1]); });
  }
  if (Array.isArray(state.minSize) && "minWidth" in node) soft("min size", () => { node.minWidth = state.minSize[0]; node.minHeight = state.minSize[1]; });
  if (Array.isArray(state.maxSize) && "maxWidth" in node) soft("max size", () => { node.maxWidth = state.maxSize[0]; node.maxHeight = state.maxSize[1]; });
  if (state.layoutPositioning && "layoutPositioning" in node) soft("layout positioning", () => { node.layoutPositioning = state.layoutPositioning; });
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
  if (Array.isArray(state.exportSettings) && "exportSettings" in node) soft("export settings", () => { node.exportSettings = copy(state.exportSettings); });
  if (typeof state.opacity === "number" && "opacity" in node) soft("opacity", () => { node.opacity = state.opacity; });
  if (state.blendMode && "blendMode" in node) soft("blend mode", () => { node.blendMode = state.blendMode; });
  if (typeof state.isMask === "boolean" && "isMask" in node) {
    soft("mask", () => { node.isMask = state.isMask; if (state.maskType && "maskType" in node) node.maskType = state.maskType; });
  }
  if (typeof state.clipsContent === "boolean" && "clipsContent" in node) soft("clips content", () => { node.clipsContent = state.clipsContent; });
  if (typeof state.visible === "boolean") soft("visibility", () => { node.visible = state.visible; });
  if (typeof state.locked === "boolean") soft("locked", () => { node.locked = state.locked; });

  if (node.type === "TEXT") await applyText(node, state.text, ctx, report, path);
  if (node.type === "INSTANCE" && state.instance?.properties) applyInstanceProperties(node, state.instance.properties, report, path);
  if (node.type === "INSTANCE" && state.instance?.overridesUnresolved) {
    report.notes.push(`${path}: the instance's overrides could not be read when the checkpoint was saved: ${state.instance.overridesUnresolved}`);
  }
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
 * Component properties other than VARIANT are not implied by the variant names,
 * so they are added from the checkpoint. A VARIANT property is inferred by
 * figma.combineAsVariants from the component names; if it did not appear, the
 * report says so instead of inventing one. The returned map is from the saved
 * full property name to the rebuilt one, which is what a layer-level reference
 * needs: addComponentProperty assigns a new suffix.
 */
/** Metadata that editComponentProperty supports for this property type. */
function propertyMetadataUpdate(type: string, def: any): Dict | null {
  const update: Dict = {};
  if ((type === "INSTANCE_SWAP" || type === "SLOT") && Array.isArray((def as any).preferredValues)) {
    update.preferredValues = copy((def as any).preferredValues);
  }
  if (type === "SLOT") {
    if (typeof (def as any).description === "string") update.description = (def as any).description;
    if (isObj((def as any).slotSettings)) update.slotSettings = copy((def as any).slotSettings);
  }
  return Object.keys(update).length ? update : null;
}

function applyPropertyMetadata(
  node: any,
  key: string,
  base: string,
  type: string,
  def: any,
  report: RestoreReport,
  path: string,
): string {
  const update = propertyMetadataUpdate(type, def);
  if (!update) return key;
  if (typeof node.editComponentProperty !== "function") {
    report.propertiesFailed.push({ path, name: base, why: "this node cannot edit component property metadata" });
    return key;
  }
  try {
    const full = node.editComponentProperty(key, update);
    return typeof full === "string" && full ? full : key;
  } catch (e) {
    report.propertiesFailed.push({ path, name: base, why: msg(e) });
    return key;
  }
}

async function applyPropertyDefaultBinding(
  node: any,
  key: string,
  base: string,
  type: string,
  def: any,
  ctx: RestoreContext,
  report: RestoreReport,
  path: string,
): Promise<string> {
  const alias = (def as any)?.boundVariables?.defaultValue;
  if (alias === undefined) return key;
  const field = `componentProperty.${base}.defaultValue`;
  if (type === "VARIANT" || type === "SLOT") {
    report.bindingsMissing.push({
      path,
      field,
      id: String((alias as any)?.id ?? ""),
      why: `${type} component property default values cannot be variable-bound`,
    });
    return key;
  }
  if (!isAlias(alias)) {
    report.bindingsMissing.push({ path, field, id: String((alias as any)?.id ?? ""), why: "the recorded binding is not a variable alias" });
    return key;
  }
  const resolved = await resolveVariable(alias, ctx);
  if (!resolved.variable) {
    report.bindingsMissing.push({ path, field, id: alias.id, why: resolved.why ?? "unresolved" });
    return key;
  }
  if (typeof node.editComponentProperty !== "function") {
    report.bindingsMissing.push({ path, field, id: alias.id, why: "this node cannot edit component property defaults" });
    return key;
  }
  try {
    const full = node.editComponentProperty(key, { defaultValue: { type: "VARIABLE_ALIAS", id: resolved.variable.id } });
    report.bindingsRestored.push({ path, field, id: resolved.variable.id, name: resolved.variable.name });
    return typeof full === "string" && full ? full : key;
  } catch (e) {
    report.bindingsMissing.push({ path, field, id: alias.id, why: msg(e) });
    return key;
  }
}

async function applyComponentProperties(
  node: any,
  state: Dict,
  ctx: RestoreContext,
  report: RestoreReport,
  path: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const defs = state?.componentPropertyDefinitions;
  if (!defs || !isObj(defs) || !("componentPropertyDefinitions" in node) || typeof node.addComponentProperty !== "function") return map;
  let live: Dict = {};
  try { live = node.componentPropertyDefinitions ?? {}; } catch { live = {}; }
  // Figma allows two properties with the same display name; only the #id suffix
  // tells them apart. Match initial live definitions by name AND type/default,
  // and let each unmatched saved definition add its own property, duplicates
  // included. A freshly rebuilt set starts with only its variant properties.
  const signature = (def: any) => JSON.stringify({
    type: def?.type ?? null,
    defaultValue: def?.defaultValue ?? null,
    variantOptions: def?.variantOptions ?? null,
  });
  const initial = Object.entries(live).map(([key, def]) => ({
    key,
    base: key.split("#")[0],
    sig: signature(def),
    used: false,
  }));
  for (const [key, def] of Object.entries(defs)) {
    if (!def || typeof def !== "object") continue;
    const type = (def as any).type;
    const base = key.split("#")[0];
    const sig = signature(def);
    const match = initial.find((x) => !x.used && x.base === base && x.sig === sig);
    let full: string;
    if (match) {
      match.used = true;
      full = match.key;
    } else {
      if (type === "VARIANT") {
        report.notes.push(`${path}: variant property "${base}" was not inferred from the rebuilt variant names`);
        continue;
      }
      try {
        const added = node.addComponentProperty(base, type, (def as any).defaultValue);
        if (typeof added !== "string" || !added) continue;
        full = added;
      } catch (e) {
        report.notes.push(`${path}: component property "${base}" not restored: ${msg(e)}`);
        continue;
      }
    }
    map.set(key, full);
    const afterMetadata = applyPropertyMetadata(node, full, base, type, def, report, path);
    if (afterMetadata !== full) map.set(key, afterMetadata);
    const afterBinding = await applyPropertyDefaultBinding(node, afterMetadata, base, type, def, ctx, report, path);
    if (afterBinding !== afterMetadata) map.set(key, afterBinding);
  }
  return map;
}

/**
 * Replay a node's componentPropertyReferences through the old->new property
 * map. A reference whose property was not rebuilt is named and skipped; the
 * setter is not allowed to point at a property that does not exist.
 */
function applyNodeReferences(node: any, d: DumpNode, map: Map<string, string>, report: RestoreReport, path: string): void {
  const refs = d.state?.componentPropertyReferences;
  if (!refs || !isObj(refs)) return;
  const out: Dict = {};
  for (const [field, name] of Object.entries(refs)) {
    const mapped = map.get(String(name));
    if (mapped) out[field] = mapped;
    else report.notes.push(`${path}: component property reference "${String(name)}" not restored because its property was not rebuilt`);
  }
  if (!Object.keys(out).length) return;
  try {
    node.componentPropertyReferences = out;
  } catch (e) {
    report.notes.push(`${path}: component property references not restored: ${msg(e)}`);
  }
}

/**
 * Walk the rebuilt children in parallel with their dumps. A component owns the
 * properties its children reference, so a nested COMPONENT/COMPONENT_SET is a
 * boundary: its own references are applied with the current map, while its
 * children were handled when that component applied its own map. A component
 * set is walked by buildComponentSet and the root restore path, which call this
 * function on each variant with the set's map.
 */
function applyPropertyReferences(
  node: any,
  d: DumpNode,
  map: Map<string, string>,
  report: RestoreReport,
  path: string,
): void {
  const dumps = d.children ?? [];
  const live = Array.isArray(node.children) ? node.children : [];
  if (dumps.length !== live.length) {
    // A skipped child shifts every later pairing. Applying a reference by index
    // after that would bind the wrong layer, so leave them for the report.
    report.notes.push(`${path}: component property references not restored because ${dumps.length - live.length} child(ren) could not be rebuilt`);
    return;
  }
  const count = live.length;
  for (let i = 0; i < count; i++) {
    const child = live[i];
    const childDump = dumps[i];
    const childPath = `${path}.children[${i}]`;
    applyNodeReferences(child, childDump, map, report, childPath);
    if (child.type === "INSTANCE") continue;
    if (child.type === "COMPONENT" || child.type === "COMPONENT_SET") continue;
    applyPropertyReferences(child, childDump, map, report, childPath);
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
  const runs = state?.text?.textRuns;
  const runFields = new Set<string>();
  if (Array.isArray(runs)) {
    for (const run of runs) {
      if (!isObj(run?.variables)) continue;
      for (const field of Object.keys(run.variables)) runFields.add(field);
    }
  }
  for (const [field, value] of Object.entries(bindings)) {
    if (PAINT_LEVEL_BINDINGS.has(field)) continue;
    // A field the runs carry is restored range by range; a whole-node write
    // here would flatten those bindings.
    if (runFields.has(field)) continue;

    if (field === "textRangeFills") {
      // The paints already carry a whole-text binding when there is one, and a
      // run's fills carry their own per-range bindings through setRangeFills.
      if (Array.isArray(runs) && runs.length) continue;
      if (state?.fills === "mixed") {
        for (const alias of (Array.isArray(value) ? value : [value]).filter(isAlias)) {
          report.bindingsMissing.push({
            path, field, id: alias.id,
            why: "per-range text fill bindings are not carried by these runs; literal fills were restored without the binding",
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
    // because a single setBoundVariable call has no range to target.
    const ids = [...new Set(aliases.map((a) => a.id))];
    if (ids.length > 1) {
      report.bindingsMissing.push({
        path, field, id: ids.join(","),
        why: `${aliases.length} different per-range bindings; the text runs do not carry this field's binding, so its literal value remains`,
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
async function applyStyleLinks(node: any, ids: Dict | undefined, ctx: RestoreContext, report: RestoreReport, path: string, state?: Dict): Promise<void> {
  if (!ids) return;
  for (const [field, id] of Object.entries(ids)) {
    if (!(field in node)) continue;
    // When the checkpoint carries run-level style ids, those links are applied
    // per range; a whole-node text/fill style here would flatten them again.
    if (field === "textStyleId" || field === "fillStyleId") {
      const runs = state?.text?.textRuns;
      if (Array.isArray(runs) && runs.some((r: any) => typeof r?.[field] === "string" && r[field])) continue;
    }
    const styleId = String(id);
    if (!styleId) {
      try {
        node[field] = "";
      } catch (e) {
        report.stylesMissing.push({ path, field, id: "", why: `the inherited style link could not be cleared: ${msg(e)}` });
      }
      continue;
    }
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

function resolveOverrideTarget(instance: any, path: any, at: string, report: RestoreReport): any | null {
  if (!Array.isArray(path) || !path.length) {
    report.overridesMissing.push({ path: at, why: "the checkpoint has no layer path for this override" });
    return null;
  }
  let node = instance;
  for (let i = 0; i < path.length; i++) {
    const step = path[i];
    const index = step?.index;
    if (!Number.isInteger(index)) {
      report.overridesMissing.push({ path: at, why: `path step ${i} has no integer index` });
      return null;
    }
    const children = Array.isArray(node.children) ? node.children : [];
    const child = children[index];
    if (!child) {
      report.overridesMissing.push({ path: at, why: `the main component no longer has a child at index ${index} (step ${i})` });
      return null;
    }
    if (typeof step.name === "string" && step.name && child.name !== step.name) {
      report.overridesMissing.push({ path: at, why: `step ${i} expected "${step.name}" at index ${index}, found "${child.name}"` });
      return null;
    }
    node = child;
  }
  return node;
}

const TEXT_OVERRIDE_FIELDS = new Set([
  "characters", "fontName", "fontSize", "lineHeight", "letterSpacing",
  "textCase", "textDecoration", "paragraphSpacing", "paragraphIndent",
  "hyperlink", "textAlignHorizontal", "textAlignVertical", "textAutoResize",
  "fills", "textStyleId", "fillStyleId", "textRangeFills",
]);

const LAYOUT_OVERRIDE_FIELDS = new Set([
  "layoutMode", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "itemSpacing", "primaryAxisAlignItems", "counterAxisAlignItems",
  "primaryAxisSizingMode", "counterAxisSizingMode", "layoutWrap",
  "counterAxisSpacing", "strokesIncludedInLayout", "itemReverseZIndex",
]);

const anyField = (fields: Set<string>, names: Iterable<string>): boolean => {
  for (const name of names) if (fields.has(name)) return true;
  return false;
};

/**
 * Text formatting fields are written one by one when the characters themselves
 * did not change. A full text rewrite would also pin unrelated formatting and
 * flatten a text style the main component still owns.
 */
async function applyTextOverride(
  target: any,
  state: Dict,
  fields: Set<string>,
  ctx: RestoreContext,
  report: RestoreReport,
  path: string,
): Promise<void> {
  const text = state.text || {};
  const font = text.font && text.font !== "mixed" ? text.font : null;
  const runs = textRunsOf(text);
  const replayRuns = runs.length > 0 && anyField(fields, TEXT_OVERRIDE_FIELDS);
  if (font && ctx.loadFont) {
    try {
      await ctx.loadFont(font);
    } catch {
      const key = `${font.family} ${font.style}`;
      if (!report.fontsUnavailable.includes(key)) report.fontsUnavailable.push(key);
      report.notes.push(`${path}: font "${key}" is not available — the font override was not restored`);
    }
  }
  // Every run font must be loaded before the character setter and the range
  // setters; the base font alone is not enough for mixed text.
  const runFontReady = replayRuns ? await loadTextRunFonts(runs, ctx, report, path) : [];
  const soft = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      report.notes.push(`${path}: text ${what} not restored: ${msg(e)}`);
    }
  };
  // Set the characters WITHOUT rewriting the base font: the main component's
  // formatting stays in place unless the override names a formatting field.
  if (fields.has("characters")) soft("characters", () => { target.characters = text.characters ?? ""; });
  if (fields.has("fontName") && font) soft("font", () => { target.fontName = font; });
  if (fields.has("fontSize") && typeof text.fontSize === "number") soft("font size", () => { target.fontSize = text.fontSize; });
  if (fields.has("lineHeight") && text.lineHeight && text.lineHeight !== "mixed") soft("line height", () => { target.lineHeight = text.lineHeight; });
  if (fields.has("letterSpacing") && text.letterSpacing && text.letterSpacing !== "mixed") soft("letter spacing", () => { target.letterSpacing = text.letterSpacing; });
  if (fields.has("textCase") && text.textCase && text.textCase !== "mixed") soft("text case", () => { target.textCase = text.textCase; });
  if (fields.has("textDecoration") && text.textDecoration && text.textDecoration !== "mixed") soft("text decoration", () => { target.textDecoration = text.textDecoration; });
  if (fields.has("paragraphSpacing") && typeof text.paragraphSpacing === "number") soft("paragraph spacing", () => { target.paragraphSpacing = text.paragraphSpacing; });
  if (fields.has("paragraphIndent") && typeof text.paragraphIndent === "number") soft("paragraph indent", () => { target.paragraphIndent = text.paragraphIndent; });
  if (fields.has("hyperlink")) {
    if (text.hyperlink === "mixed") {
      if (!runs.length) {
        report.notes.push(`${path}: hyperlinks are mixed and the checkpoint has no per-run data; the hyperlink override was not restored`);
      }
    } else {
      soft("hyperlink", () => { target.hyperlink = text.hyperlink ?? null; });
    }
  }
  if (fields.has("textAlignHorizontal") && Array.isArray(text.align)) soft("horizontal align", () => { target.textAlignHorizontal = text.align[0]; });
  if (fields.has("textAlignVertical") && Array.isArray(text.align)) soft("vertical align", () => { target.textAlignVertical = text.align[1]; });
  if (fields.has("textAutoResize") && text.autoResize) soft("auto resize", () => { target.textAutoResize = text.autoResize; });
  if (replayRuns) await applyTextRunValues(target, runs, runFontReady, ctx, report, path);
}

/**
 * Apply only the fields the instance actually overrode. The state is a full
 * snapshot (so defaults are explicit), but the field list is the selector: an
 * override of `visible` must not silently detach the main component's fill
 * style, and an override of `fontSize` must not rewrite the characters.
 */
async function applyInstanceOverrideState(
  target: any,
  rec: Dict,
  ctx: RestoreContext,
  report: RestoreReport,
  path: string,
): Promise<void> {
  const state: Dict = rec.state && typeof rec.state === "object" ? rec.state : {};
  const fields = new Set<string>(Array.isArray(rec.fields) ? rec.fields.map((f: any) => String(f)) : []);
  const meta = rec.meta && typeof rec.meta === "object" ? rec.meta : {};
  const soft = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      report.notes.push(`${path}: ${what} not restored: ${msg(e)}`);
    }
  };

  await applyVariableModes(target, meta.variableModes, ctx, report, path);

  // A text style is a font/size/line-height bundle; apply it before the literal
  // text overrides so those remain the final word, as they are in the file.
  if (fields.has("textStyleId") && meta.styleIds && "textStyleId" in meta.styleIds) {
    await applyStyleLinks(target, { textStyleId: meta.styleIds.textStyleId }, ctx, report, path, state);
  }
  if (anyField(fields, TEXT_OVERRIDE_FIELDS)) await applyTextOverride(target, state, fields, ctx, report, path);

  if (fields.has("fills")) applyPaints(target, "fills", state.fills, report, path);
  if (fields.has("strokes")) applyPaints(target, "strokes", state.strokes, report, path);
  if (fields.has("effects")) applyPaints(target, "effects", state.effects, report, path);
  if (fields.has("layoutGrids")) applyPaints(target, "layoutGrids", state.layoutGrids, report, path);
  if (fields.has("arcData") && state.arcData && "arcData" in target) soft("arc data", () => { target.arcData = state.arcData; });

  // Paint style links come after the literal paints: a link is the final state
  // when both were recorded.
  const paintStyles: Dict = {};
  for (const field of ["fillStyleId", "strokeStyleId", "effectStyleId"]) {
    if (fields.has(field) && meta.styleIds && field in meta.styleIds) paintStyles[field] = meta.styleIds[field];
  }
  if (Object.keys(paintStyles).length) await applyStyleLinks(target, paintStyles, ctx, report, path, state);

  if (fields.has("strokeWeight") && state.strokeWeight !== undefined) {
    if (typeof state.strokeWeight === "number" && "strokeWeight" in target) soft("stroke weight", () => { target.strokeWeight = state.strokeWeight; });
    else if (Array.isArray(state.strokeWeight) && "strokeTopWeight" in target) {
      soft("stroke weights", () => {
        target.strokeTopWeight = state.strokeWeight[0];
        target.strokeRightWeight = state.strokeWeight[1];
        target.strokeBottomWeight = state.strokeWeight[2];
        target.strokeLeftWeight = state.strokeWeight[3];
      });
    }
  }
  const weights = Array.isArray(state.strokeWeight)
    ? state.strokeWeight
    : typeof state.strokeWeight === "number" ? [state.strokeWeight, state.strokeWeight, state.strokeWeight, state.strokeWeight] : null;
  for (const [field, index] of [["strokeTopWeight", 0], ["strokeRightWeight", 1], ["strokeBottomWeight", 2], ["strokeLeftWeight", 3]] as Array<[string, number]>) {
    if (!fields.has(field) || !(field in target) || !weights) continue;
    soft(field, () => { target[field] = weights[index]; });
  }
  if (fields.has("strokeAlign") && state.strokeAlign && "strokeAlign" in target) soft("stroke align", () => { target.strokeAlign = state.strokeAlign; });
  if (fields.has("strokeCap") && state.strokeCap && "strokeCap" in target) soft("stroke cap", () => { target.strokeCap = state.strokeCap; });
  if (fields.has("strokeJoin") && state.strokeJoin && "strokeJoin" in target) soft("stroke join", () => { target.strokeJoin = state.strokeJoin; });
  if (fields.has("dashPattern") && Array.isArray(state.dashPattern) && "dashPattern" in target) soft("dash pattern", () => { target.dashPattern = state.dashPattern; });

  // Geometry comes before the size in the width/height block below.
  if (fields.has("pointCount") && typeof state.pointCount === "number" && "pointCount" in target) soft("point count", () => { target.pointCount = state.pointCount; });
  if (fields.has("innerRadius") && typeof state.innerRadius === "number" && "innerRadius" in target) soft("inner radius", () => { target.innerRadius = state.innerRadius; });

  if (anyField(fields, LAYOUT_OVERRIDE_FIELDS) && state.layout) applyLayout(target, { layout: state.layout }, report, path);

  if (fields.has("width") || fields.has("height")) {
    if (Array.isArray(state.size)) {
      const width = fields.has("width") ? state.size[0] : target.width;
      const height = fields.has("height") ? state.size[1] : target.height;
      soft("size", () => { target.resize(width, height); });
    }
  }
  if (fields.has("x") || fields.has("y")) {
    if (Array.isArray(state.pos) && "x" in target) {
      const x = fields.has("x") ? state.pos[0] : target.x;
      const y = fields.has("y") ? state.pos[1] : target.y;
      soft("position", () => { target.x = x; target.y = y; });
    }
  }
  if (fields.has("rotation") && typeof state.rotation === "number" && "rotation" in target) soft("rotation", () => { target.rotation = state.rotation; });
  if (fields.has("cornerRadius") || fields.has("topLeftRadius") || fields.has("topRightRadius") || fields.has("bottomRightRadius") || fields.has("bottomLeftRadius")) {
    if (typeof state.cornerRadius === "number" && "cornerRadius" in target) soft("corner radius", () => { target.cornerRadius = state.cornerRadius; });
    else if (Array.isArray(state.cornerRadius) && "topLeftRadius" in target) {
      soft("corner radii", () => {
        target.topLeftRadius = state.cornerRadius[0];
        target.topRightRadius = state.cornerRadius[1];
        target.bottomRightRadius = state.cornerRadius[2];
        target.bottomLeftRadius = state.cornerRadius[3];
      });
    }
  }
  if (fields.has("constraints") && Array.isArray(state.constraints) && "constraints" in target) {
    soft("constraints", () => { target.constraints = { horizontal: state.constraints[0], vertical: state.constraints[1] }; });
  }
  if (fields.has("layoutAlign") && state.layoutAlign && "layoutAlign" in target) soft("layout align", () => { target.layoutAlign = state.layoutAlign; });
  if (fields.has("layoutGrow") && typeof state.layoutGrow === "number" && "layoutGrow" in target) soft("layout grow", () => { target.layoutGrow = state.layoutGrow; });
  if (fields.has("layoutPositioning") && state.layoutPositioning && "layoutPositioning" in target) soft("layout positioning", () => { target.layoutPositioning = state.layoutPositioning; });
  if (fields.has("layoutSizingHorizontal") || fields.has("layoutSizingVertical")) {
    if (Array.isArray(state.sizing) && "layoutSizingHorizontal" in target) {
      soft("layout sizing", () => {
        if (fields.has("layoutSizingHorizontal")) target.layoutSizingHorizontal = state.sizing[0];
        if (fields.has("layoutSizingVertical")) target.layoutSizingVertical = state.sizing[1];
      });
    }
  }
  if (anyField(fields, ["minWidth", "minHeight"]) && Array.isArray(state.minSize) && "minWidth" in target) {
    soft("min size", () => {
      if (fields.has("minWidth")) target.minWidth = state.minSize[0];
      if (fields.has("minHeight")) target.minHeight = state.minSize[1];
    });
  }
  if (anyField(fields, ["maxWidth", "maxHeight"]) && Array.isArray(state.maxSize) && "maxWidth" in target) {
    soft("max size", () => {
      if (fields.has("maxWidth")) target.maxWidth = state.maxSize[0];
      if (fields.has("maxHeight")) target.maxHeight = state.maxSize[1];
    });
  }
  if (fields.has("visible") && typeof state.visible === "boolean") soft("visibility", () => { target.visible = state.visible; });
  if (fields.has("locked") && typeof state.locked === "boolean") soft("locked", () => { target.locked = state.locked; });
  if (fields.has("opacity") && typeof state.opacity === "number" && "opacity" in target) soft("opacity", () => { target.opacity = state.opacity; });
  if (fields.has("blendMode") && state.blendMode && "blendMode" in target) soft("blend mode", () => { target.blendMode = state.blendMode; });
  if (fields.has("isMask") && typeof state.isMask === "boolean" && "isMask" in target) {
    soft("mask", () => { target.isMask = state.isMask; if (state.maskType && "maskType" in target) target.maskType = state.maskType; });
  }
  if (fields.has("clipsContent") && typeof state.clipsContent === "boolean" && "clipsContent" in target) soft("clips content", () => { target.clipsContent = state.clipsContent; });

  if (anyField(fields, ["vectorNetwork", "vectorPaths", "windingRule"]) && state.vector) {
    try {
      await target.setVectorNetworkAsync(state.vector);
      if (fields.has("windingRule") && state.windingRule) target.windingRule = state.windingRule;
    } catch (e) {
      report.notes.push(`${path}: vector network not restored: ${msg(e)}`);
    }
  }

  if (target.type === "INSTANCE") {
    if (fields.has("componentProperties") && state.instance?.properties) applyInstanceProperties(target, state.instance.properties, report, path);
    await applyInstanceOverrides(target, state.instance?.overrides, ctx, report, path);
  }

  const bindings: Dict = {};
  for (const [field, value] of Object.entries(meta.variableBindings || {})) {
    if (fields.has(field) || field === "componentProperties") bindings[field] = value;
  }
  if (Object.keys(bindings).length) await applyVariableBindings(target, bindings, state, ctx, report, path);
}

/**
 * Replay every direct override the checkpoint recorded onto a freshly created
 * instance. The path is resolved against the main component's CURRENT children;
 * a path that no longer matches is reported and skipped rather than applied to
 * whatever happens to sit at that index now.
 */
async function applyInstanceOverrides(
  instance: any,
  overrides: any,
  ctx: RestoreContext,
  report: RestoreReport,
  path: string,
): Promise<void> {
  if (!Array.isArray(overrides)) return;
  for (let i = 0; i < overrides.length; i++) {
    const rec = overrides[i];
    if (!rec || typeof rec !== "object") continue;
    const at = `${path}.overrides[${i}]`;
    if (typeof rec.unresolved === "string") report.notes.push(`${at}: ${rec.unresolved}`);
    const target = resolveOverrideTarget(instance, rec.path, at, report);
    if (!target) continue;

    if (typeof rec.name === "string" && Array.isArray(rec.fields) && rec.fields.includes("name")) {
      try {
        target.name = rec.name;
      } catch (e) {
        report.notes.push(`${at}: name not restored: ${msg(e)}`);
      }
    }
    if (Array.isArray(rec.unsupported) && rec.unsupported.length) {
      const fields = rec.unsupported.map((f: any) => String(f));
      report.overridesUnsupported.push({ path: at, fields });
      report.notes.push(`${at}: override field(s) this checkpoint cannot rebuild: ${fields.join(", ")}`);
    }
    await applyInstanceOverrideState(target, rec, ctx, report, at);
    report.overridesRestored.push({ path: at, fields: Array.isArray(rec.fields) ? rec.fields.length : 0 });
  }
}

async function applyRunStyleLinks(
  node: any,
  run: Dict,
  start: number,
  end: number,
  ctx: RestoreContext,
  report: RestoreReport,
  path: string,
  i: number,
): Promise<void> {
  const api = ctx.figma;
  for (const [field, method] of [
    ["textStyleId", "setRangeTextStyleIdAsync"],
    ["fillStyleId", "setRangeFillStyleIdAsync"],
  ] as Array<[string, string]>) {
    const id = run[field];
    if (typeof id !== "string" || !id) continue;
    const at = `${path}.runs[${i}]`;
    const missing = (why: string) => report.stylesMissing.push({ path: at, field, id, why });
    if (typeof api.getStyleByIdAsync !== "function") {
      missing("the style API is not available in this session");
      continue;
    }
    let style: any = null;
    try {
      style = await api.getStyleByIdAsync(id);
    } catch (e) {
      missing(msg(e));
      continue;
    }
    if (!style) {
      missing("the style no longer exists in this file");
      continue;
    }
    // A text style cannot be applied before its font is loaded.
    if (field === "textStyleId" && style.fontName && ctx.loadFont) {
      try {
        await ctx.loadFont(style.fontName);
      } catch (e) {
        missing(`the style's font is not available (${msg(e)})`);
        continue;
      }
    }
    if (typeof node[method] !== "function") {
      missing(`a ${node.type} cannot link this style to a character range`);
      continue;
    }
    try {
      await node[method](start, end, style.id || id);
      report.stylesRestored.push({ path: at, field, id: style.id || id });
    } catch (e) {
      missing(msg(e));
    }
  }
}

async function applyRunBindings(
  node: any,
  run: Dict,
  start: number,
  end: number,
  ctx: RestoreContext,
  report: RestoreReport,
  path: string,
  i: number,
): Promise<void> {
  if (!isObj(run.variables)) return;
  for (const [field, alias] of Object.entries(run.variables as Dict)) {
    if (!TEXT_RANGE_FIELDS.has(field)) continue;
    const at = `${path}.runs[${i}]`;
    const missing = (id: string, why: string) => report.bindingsMissing.push({ path: at, field, id, why });
    if (!isAlias(alias)) {
      missing(String((alias as any)?.id ?? ""), "the recorded run binding is not a variable alias");
      continue;
    }
    const resolved = await resolveVariable(alias, ctx);
    if (!resolved.variable) {
      missing(alias.id, resolved.why ?? "unresolved");
      continue;
    }
    if (typeof node.setRangeBoundVariable !== "function") {
      missing(alias.id, `a ${node.type} cannot bind a variable to a character range`);
      continue;
    }
    try {
      node.setRangeBoundVariable(start, end, field, resolved.variable);
      report.bindingsRestored.push({ path: at, field, id: resolved.variable.id, name: resolved.variable.name });
    } catch (e) {
      missing(alias.id, msg(e));
    }
  }
}

/** Valid run ranges from a text state; malformed entries are ignored here and named by the caller. */
function textRunsOf(text: Dict): Dict[] {
  return Array.isArray(text.textRuns)
    ? text.textRuns.filter((r: any) => r && Number.isInteger(r.start) && Number.isInteger(r.end) && r.end > r.start)
    : [];
}

async function loadTextRunFonts(
  runs: Dict[],
  ctx: RestoreContext,
  report: RestoreReport,
  path: string,
): Promise<boolean[]> {
  const ready: boolean[] = runs.map(() => true);
  if (!ctx.loadFont) return ready;
  for (let i = 0; i < runs.length; i++) {
    const f = runs[i].font;
    if (!f) continue;
    try {
      await ctx.loadFont(f);
    } catch {
      ready[i] = false;
      const key = `${f.family} ${f.style}`;
      if (!report.fontsUnavailable.includes(key)) report.fontsUnavailable.push(key);
      report.notes.push(`${path}: run ${i} font "${key}" is not available — that run's font was not restored`);
    }
  }
  return ready;
}

/**
 * Replay one text state's ranges. This is shared by a rebuilt TEXT node and by
 * a direct instance override: both are snapshots of every run, so the same
 * values (style links, font, size, fills, case, decoration, line height,
 * letter spacing, hyperlink and variable bindings) go back the same way.
 */
async function applyTextRunValues(
  node: any,
  runs: Dict[],
  runFontReady: boolean[],
  ctx: RestoreContext,
  report: RestoreReport,
  path: string,
): Promise<void> {
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
    await applyRunStyleLinks(node, run, start, end, ctx, report, path, i);
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
    await applyRunBindings(node, run, start, end, ctx, report, path, i);
  }
}

async function applyText(node: any, text: Dict, ctx: RestoreContext, report: RestoreReport, path: string): Promise<void> {
  if (!text) return;
  const fallback = ctx.fallbackFont ?? { family: "Inter", style: "Regular" };
  const runs = textRunsOf(text);
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
  const runFontReady = await loadTextRunFonts(runs, ctx, report, path);
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

  if (hasRuns) await applyTextRunValues(node, runs, runFontReady, ctx, report, path);

  if (Array.isArray(text.align)) {
    soft("alignment", () => {
      node.textAlignHorizontal = text.align[0];
      node.textAlignVertical = text.align[1];
    });
  }
  if (text.autoResize) soft("auto-resize", () => { node.textAutoResize = text.autoResize; });
}
