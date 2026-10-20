/// <reference types="@figma/plugin-typings" />

/**
 * The reverse of ui-build: describe a live subtree as a build spec.
 *
 * A design that was made by hand can be handed to figma_build/figma_patch on
 * another page or in another file. This is a lossy translation by nature — the
 * Plugin API cannot recover an SVG's source, a BOOLEAN_OPERATION's inputs, or
 * the inside of an instance — so the report names every field it could not
 * carry instead of returning a spec that looks complete.
 *
 * The spec is ordinary data and the source is never modified.
 */

import { BUILD_DATA, KEY_DATA, KIND_DATA, PROTECTED_DATA } from "./ui-build";

export const SPEC_EXPORT_SCHEMA = "build-spec-export/v1";

type Json = any;

const EXPORTABLE = new Set(["FRAME", "RECTANGLE", "ELLIPSE", "LINE", "TEXT", "INSTANCE", "COMPONENT"]);
const SHADOWS = new Set(["DROP_SHADOW", "INNER_SHADOW"]);
const BLURS = new Set(["LAYER_BLUR", "BACKGROUND_BLUR"]);

const isObj = (v: any) => !!v && typeof v === "object" && !Array.isArray(v);
const isMixed = (v: any) => typeof v === "symbol";
const errMsg = (e: any) => String(e && e.message ? e.message : e);
const round = (n: number) => Math.round(n * 100) / 100;

function slug(value: string): string {
  const out = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return out || "node";
}

const deriveKey = (parentKey: string, name: string, index: number) => `${parentKey}/${slug(name)}#${index}`;

function keyOf(node: any): string {
  try { return node.getPluginData(KEY_DATA) || ""; } catch { return ""; }
}
function buildOf(node: any): string {
  try { return node.getPluginData(BUILD_DATA) || ""; } catch { return ""; }
}
function kindOf(node: any): string {
  try { return node.getPluginData(KIND_DATA) || ""; } catch { return ""; }
}
function protectedOf(node: any): boolean {
  try { return node.getPluginData(PROTECTED_DATA) === "1"; } catch { return false; }
}

function pathOf(node: any): string {
  const parts: string[] = [];
  let n: any = node;
  while (n && n.type !== "DOCUMENT") {
    parts.unshift(String(n.name || n.type));
    n = n.parent;
  }
  return parts.join(" / ");
}

function hex(color: any): string | null {
  if (!isObj(color)) return null;
  const channel = (v: any) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(255, Math.round(n * 255))) : null;
  };
  const r = channel(color.r);
  const g = channel(color.g);
  const b = channel(color.b);
  if (r === null || g === null || b === null) return null;
  const h = (n: number) => n.toString(16).padStart(2, "0");
  const a = Number(color.a);
  return `#${h(r)}${h(g)}${h(b)}${Number.isFinite(a) && a < 1 ? h(Math.round(Math.max(0, a) * 255)) : ""}`;
}

function validKey(key: string): boolean {
  return !!key && key.length <= 160 && !/\s/.test(key);
}

async function styleInfo(ctx: any, id: any, cache: Map<string, any>): Promise<any | null> {
  if (!id || isMixed(id) || typeof id !== "string") return null;
  if (cache.has(id)) return cache.get(id);
  let info: any = null;
  try {
    const style = await ctx.getStyleByIdAsync(id);
    if (style) info = { name: style.name, fontName: style.fontName ?? null };
  } catch {
    info = null;
  }
  cache.set(id, info);
  return info;
}

async function variableName(ctx: any, id: any, cache: Map<string, any>): Promise<string | null> {
  if (!id || isMixed(id) || typeof id !== "string") return null;
  if (cache.has(id)) return cache.get(id);
  let name: string | null = null;
  try {
    const v = await ctx.variables.getVariableByIdAsync(id);
    if (v) name = v.name;
  } catch {
    name = null;
  }
  cache.set(id, name);
  return name;
}

async function paintToSpec(
  ctx: any,
  paint: any,
  vars: Map<string, any>,
  warnings: string[],
  path: string,
): Promise<any | null> {
  if (!paint || paint.visible === false) return null;
  if (paint.type === "SOLID" && paint.color) {
    const out: Json = { color: hex(paint.color) };
    if (!out.color) {
      warnings.push(`${path}: a SOLID paint has an unreadable colour and was omitted`);
      return null;
    }
    if (paint.opacity !== undefined && Number(paint.opacity) !== 1) out.opacity = round(Number(paint.opacity));
    const alias = paint.boundVariables && paint.boundVariables.color && paint.boundVariables.color.id;
    if (alias) {
      const name = await variableName(ctx, alias, vars);
      if (name) out.variable = name;
      else warnings.push(`${path}: paint bound to variable ${alias}, which could not be resolved; the literal colour was exported`);
    }
    return out;
  }
  if (paint.type === "IMAGE" && paint.imageHash) {
    const out: Json = { type: "IMAGE", imageHash: paint.imageHash, scaleMode: paint.scaleMode || "FILL" };
    if (paint.opacity !== undefined && Number(paint.opacity) !== 1) out.opacity = round(Number(paint.opacity));
    return out;
  }
  if (paint.type && String(paint.type).startsWith("GRADIENT")) {
    const stops = (paint.gradientStops || []).map((s: any) => ({
      at: round(Number(s.position ?? 0)),
      color: hex(s.color),
    }));
    if (stops.length < 2 || stops.some((s: any) => !s.color)) {
      warnings.push(`${path}: a ${paint.type} paint has fewer than two readable stops and was omitted`);
      return null;
    }
    const out: Json = { type: paint.type, stops };
    if (paint.gradientTransform) out.gradientTransform = paint.gradientTransform;
    if (paint.opacity !== undefined && Number(paint.opacity) !== 1) out.opacity = round(Number(paint.opacity));
    return out;
  }
  warnings.push(`${path}: paint type "${paint.type}" is not representable and was omitted`);
  return null;
}

async function paintsFor(
  ctx: any,
  node: any,
  field: "fills" | "strokes",
  styles: Map<string, any>,
  vars: Map<string, any>,
  warnings: string[],
  path: string,
): Promise<{ style?: string; paints?: any[] } | null> {
  if (!(field in node)) return null;
  const styleId = field === "fills" ? node.fillStyleId : node.strokeStyleId;
  const style = await styleInfo(ctx, styleId, styles);
  if (style) return { style: style.name };
  if (styleId && !isMixed(styleId) && !style) {
    warnings.push(`${path}: ${field === "fills" ? "fill" : "stroke"} style id ${styleId} no longer resolves; exported literal paints instead`);
  }
  const list = node[field];
  if (!Array.isArray(list)) {
    warnings.push(`${path}: ${field} is mixed and cannot be exported`);
    return null;
  }
  const paints: any[] = [];
  for (let i = 0; i < list.length; i++) {
    const p = await paintToSpec(ctx, list[i], vars, warnings, `${path}.${field}[${i}]`);
    if (p) paints.push(p);
  }
  return { paints };
}

async function paintsToSpec(
  ctx: any,
  paints: any,
  vars: Map<string, any>,
  warnings: string[],
  path: string,
): Promise<any[] | null> {
  if (!Array.isArray(paints)) return null;
  const out: any[] = [];
  for (let i = 0; i < paints.length; i++) {
    const p = await paintToSpec(ctx, paints[i], vars, warnings, `${path}[${i}]`);
    if (p) out.push(p);
  }
  return out;
}

const TEXT_SEGMENT_FIELDS = [
  "fontName", "fontSize", "fills", "textCase", "textDecoration",
  "lineHeight", "letterSpacing", "hyperlink", "textStyleId", "fillStyleId",
];

const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

const plain = (v: any) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function compactFont(value: any): { family: string; style: string } | null {
  if (!isObj(value) || typeof value.family !== "string" || !value.family) return null;
  return { family: value.family, style: String(value.style || "Regular") };
}

function compactLink(value: any): { type: "URL" | "NODE"; value: string } | null {
  if (!isObj(value) || (value.type !== "URL" && value.type !== "NODE") || typeof value.value !== "string" || !value.value) {
    return null;
  }
  return { type: value.type, value: value.value };
}

/**
 * A mixed text node is read as Figma's own styled segments, so the spec does not
 * have to guess one font and lose the rest. Returning null means the node is
 * uniform (or the host could not read segments); the caller keeps the existing
 * one-style export path.
 */
async function textSegmentsFor(node: any, state: any, path: string): Promise<any[] | null> {
  if (typeof node.getStyledTextSegments !== "function") return null;
  try {
    const segs = node.getStyledTextSegments(TEXT_SEGMENT_FIELDS);
    if (!Array.isArray(segs) || segs.length <= 1) return null;
    const usable = segs.every((s: any) => s && Number.isInteger(s.start) && Number.isInteger(s.end) && s.end > s.start);
    if (!usable) {
      state.warnings.push(`${path}: per-run text styling has unreadable character offsets; the spec carries one base style`);
      return null;
    }
    return segs;
  } catch (e) {
    state.warnings.push(`${path}: per-run text styling could not be read (${errMsg(e)}); the spec carries one base style`);
    return null;
  }
}

/**
 * Emit only the runs that differ from the first segment. The first segment
 * becomes the node's base style, so a run is the exception, not the whole text.
 */
async function textRunsFor(
  ctx: any,
  segments: any[],
  baseFills: any[] | null,
  vars: Map<string, any>,
  warnings: string[],
  path: string,
): Promise<any[]> {
  const base = segments[0];
  const baseFont = compactFont(base.fontName);
  const baseLink = compactLink(base.hyperlink);
  const baseCase = String(base.textCase || "ORIGINAL");
  const baseDecoration = String(base.textDecoration || "NONE");
  const runs: any[] = [];
  let styleIdsDiffer = false;
  let fillStyleIdsDiffer = false;

  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const at = `${path}.runs[${i - 1}]`;
    const run: any = { start: seg.start, end: seg.end };
    let changed = false;

    const font = compactFont(seg.fontName);
    if (font && !same(font, baseFont)) { run.font = font; changed = true; }
    if (Number.isFinite(Number(seg.fontSize)) && Number(seg.fontSize) !== Number(base.fontSize)) {
      run.fontSize = round(Number(seg.fontSize));
      changed = true;
    }
    const segFills = await paintsToSpec(ctx, seg.fills, vars, warnings, `${at}.fills`);
    if (segFills && baseFills && !same(segFills, baseFills)) { run.fills = segFills; changed = true; }
    const textCase = String(seg.textCase || "ORIGINAL");
    if (textCase !== baseCase) { run.textCase = textCase; changed = true; }
    const decoration = String(seg.textDecoration || "NONE");
    if (decoration !== baseDecoration) { run.textDecoration = decoration; changed = true; }
    if (!same(seg.lineHeight, base.lineHeight)) { run.lineHeight = plain(seg.lineHeight); changed = true; }
    if (!same(seg.letterSpacing, base.letterSpacing)) { run.letterSpacing = plain(seg.letterSpacing); changed = true; }
    const link = compactLink(seg.hyperlink);
    if (!same(link, baseLink)) {
      run.hyperlink = link;
      changed = true;
      if (link?.type === "NODE") {
        warnings.push(`${at}: the text hyperlink points at node ${link.value}; a NODE link is file-local and will not resolve in another file`);
      }
    }
    if (!same(seg.textStyleId ?? "", base.textStyleId ?? "")) styleIdsDiffer = true;
    if (!same(seg.fillStyleId ?? "", base.fillStyleId ?? "")) fillStyleIdsDiffer = true;
    if (changed) runs.push(run);
  }

  if (styleIdsDiffer) {
    warnings.push(`${path}: text style ids vary across runs; per-run text style links are not representable, so literal run styling was exported`);
  }
  if (fillStyleIdsDiffer) {
    warnings.push(`${path}: fill style ids vary across runs; per-run fill style links are not representable, so literal run fills were exported`);
  }
  return runs;
}

function effectsFor(node: any, warnings: string[], path: string): any[] | undefined {
  if (!Array.isArray(node.effects)) return undefined;
  const out: any[] = [];
  for (let i = 0; i < node.effects.length; i++) {
    const e = node.effects[i];
    if (!e || !SHADOWS.has(e.type) && !BLURS.has(e.type)) {
      warnings.push(`${path}.effects[${i}]: effect type "${e && e.type}" is not representable and was omitted`);
      continue;
    }
    if (SHADOWS.has(e.type)) {
      const color = hex(e.color);
      if (!color) {
        warnings.push(`${path}.effects[${i}]: shadow colour is unreadable and was omitted`);
        continue;
      }
      out.push({
        type: e.type,
        color,
        offset: [Number(e.offset?.x || 0), Number(e.offset?.y || 0)],
        radius: Number(e.radius || 0),
        spread: Number(e.spread || 0),
        visible: e.visible !== false,
      });
    } else {
      out.push({ type: e.type, radius: Number(e.radius || 0), visible: e.visible !== false });
    }
  }
  return out;
}

function gridsFor(node: any, warnings: string[], path: string): any[] | undefined {
  if (!Array.isArray(node.layoutGrids) || !node.layoutGrids.length) return undefined;
  const out: any[] = [];
  for (let i = 0; i < node.layoutGrids.length; i++) {
    const g = node.layoutGrids[i];
    const pattern = String(g && g.pattern || "").toUpperCase();
    if (!g || !["COLUMNS", "ROWS", "GRID"].includes(pattern)) {
      warnings.push(`${path}.layoutGrids[${i}]: pattern "${g && g.pattern}" is not representable and was omitted`);
      continue;
    }
    const color = hex(g.color);
    if (!color) {
      warnings.push(`${path}.layoutGrids[${i}]: colour is unreadable and was omitted`);
      continue;
    }
    out.push({
      pattern,
      visible: g.visible !== false,
      color,
      alignment: g.alignment || "MIN",
      gutterSize: round(Number(g.gutterSize || 0)),
      offset: round(Number(g.offset || 0)),
      count: Math.max(1, Math.round(Number(g.count || 1))),
      sectionSize: round(Number(g.sectionSize || 1)),
    });
  }
  return out.length ? out : undefined;
}

function containerLayout(node: any): Json | undefined {
  if (!("layoutMode" in node)) return undefined;
  const out: Json = { mode: node.layoutMode || "NONE" };
  if (out.mode !== "NONE") {
    out.gap = Number(node.itemSpacing || 0);
    if (node.counterAxisSpacing !== null && node.counterAxisSpacing !== undefined) out.counterAxisSpacing = Number(node.counterAxisSpacing);
    out.padding = [Number(node.paddingTop || 0), Number(node.paddingRight || 0), Number(node.paddingBottom || 0), Number(node.paddingLeft || 0)];
    const align = node.primaryAxisAlignItems;
    const cross = node.counterAxisAlignItems;
    if (align && align !== "MIN") out.align = align;
    if (cross && cross !== "MIN") out.crossAlign = cross;
    if (node.layoutWrap && node.layoutWrap !== "NO_WRAP") out.wrap = node.layoutWrap;
    const sizing: Json = {};
    if (node.primaryAxisSizingMode) sizing.primaryAxis = node.primaryAxisSizingMode === "AUTO" ? "HUG" : "FIXED";
    if (node.counterAxisSizingMode) sizing.counterAxis = node.counterAxisSizingMode === "AUTO" ? "HUG" : "FIXED";
    if (Object.keys(sizing).length) out.sizing = sizing;
  }
  if (node.clipsContent !== undefined) out.clipsContent = node.clipsContent === true;
  for (const k of ["minWidth", "maxWidth", "minHeight", "maxHeight"]) {
    if (node[k] !== null && node[k] !== undefined) out[k] = Number(node[k]);
  }
  return out;
}

function childLayout(node: any): Json | undefined {
  const parent = node.parent;
  if (!parent || !parent.layoutMode || parent.layoutMode === "NONE") return undefined;
  const out: Json = {};
  if (node.layoutPositioning === "ABSOLUTE") out.positioning = "ABSOLUTE";
  if (Number(node.layoutGrow) > 0) out.grow = Number(node.layoutGrow);
  if (node.layoutAlign && node.layoutAlign !== "INHERIT") out.alignSelf = node.layoutAlign;
  const sizing: Json = {};
  if (node.layoutSizingHorizontal === "FILL") sizing.horizontal = "FILL";
  if (node.layoutSizingVertical === "FILL") sizing.vertical = "FILL";
  if (Object.keys(sizing).length) out.sizing = sizing;
  return Object.keys(out).length ? out : undefined;
}

function mergeLayout(a: Json | undefined, b: Json | undefined): Json | undefined {
  if (!a) return b;
  if (!b) return a;
  return { ...a, ...b, ...(a.sizing || b.sizing ? { sizing: { ...(a.sizing || {}), ...(b.sizing || {}) } } : {}) };
}

async function exportNode(
  ctx: any,
  node: any,
  parentKey: string,
  index: number,
  depth: number,
  state: Json,
): Promise<any | null> {
  state.scanned++;
  if (state.scanned > state.maxNodes) {
    state.truncated = true;
    return null;
  }
  const path = pathOf(node);
  if (node.visible === false && !state.includeHidden) return null;
  if (!EXPORTABLE.has(node.type) || (node.type === "FRAME" && kindOf(node) === "SVG")) {
    const why =
      node.type === "FRAME" && kindOf(node) === "SVG"
        ? "the node was created from SVG; the Plugin API does not expose the source string"
        : `type ${node.type} has no build-spec equivalent`;
    state.unsupported.push({ path, type: node.type, why });
    return null;
  }
  if (depth > state.maxDepth) {
    state.unsupported.push({ path, type: node.type, why: `deeper than maxDepth ${state.maxDepth}` });
    return null;
  }

  let key = keyOf(node);
  if (key && !validKey(key)) {
    state.warnings.push(`${path}: key "${key}" has whitespace or is too long; a derived key is used instead`);
    key = "";
  }
  if (!key) key = deriveKey(parentKey, String(node.name || node.type), index);
  if (state.keys.has(key)) {
    state.warnings.push(`${path}: key "${key}" is already used; this node gets a derived key instead`);
    key = deriveKey(parentKey, String(node.name || node.type), index);
  }
  state.keys.add(key);

  const spec: Json = { type: node.type, name: node.name, key };
  const textSegments = node.type === "TEXT" ? await textSegmentsFor(node, state, path) : null;
  if (node.type === "INSTANCE") {
    let main: any = null;
    try {
      main = typeof node.getMainComponentAsync === "function" ? await node.getMainComponentAsync() : node.mainComponent;
    } catch {
      main = null;
    }
    if (!main) {
      state.unsupported.push({ path, type: node.type, why: "detached instance: its main component cannot be resolved" });
      return null;
    }
    if (main.key) spec.componentKey = main.key;
    else spec.componentId = main.id;
    const properties: Json = {};
    try {
      for (const [name, value] of Object.entries(node.componentProperties || {})) {
        const v = (value as any)?.value;
        if (typeof v === "string" || typeof v === "boolean") properties[name] = v;
        else state.warnings.push(`${path}: component property "${name}" has a value this spec cannot represent and was omitted`);
      }
    } catch (e) {
      state.warnings.push(`${path}: component properties could not be read: ${errMsg(e)}`);
    }
    if (Object.keys(properties).length) spec.properties = properties;
    state.warnings.push(`${path}: instance interiors and per-layer overrides are not part of a build spec`);
  }

  const size = [Number(node.width), Number(node.height)];
  const textAutoResize = node.type === "TEXT" ? node.textAutoResize : undefined;
  if (
    node.type !== "LINE" &&
    Number.isFinite(size[0]) && Number.isFinite(size[1]) && size[0] > 0 && size[1] > 0 &&
    (node.type !== "TEXT" || textAutoResize === "NONE")
  ) {
    spec.size = { width: round(size[0]), height: round(size[1]) };
  } else if (node.type !== "TEXT" && node.type !== "LINE" && (!Number.isFinite(size[0]) || !Number.isFinite(size[1]) || size[0] <= 0 || size[1] <= 0)) {
    state.warnings.push(`${path}: size ${size[0]}x${size[1]} cannot be represented; the build will use the node default`);
  }
  const parentAuto = node.parent && node.parent.layoutMode && node.parent.layoutMode !== "NONE";
  if (node.parent && (!parentAuto || node.layoutPositioning === "ABSOLUTE") &&
      Number.isFinite(Number(node.x)) && Number.isFinite(Number(node.y))) {
    spec.position = { x: round(Number(node.x)), y: round(Number(node.y)) };
  }

  if (node.visible === false) spec.visible = false;
  if (Number(node.opacity) !== 1) spec.opacity = round(Number(node.opacity));
  if (node.blendMode && node.blendMode !== "NORMAL" && node.blendMode !== "PASS_THROUGH") spec.blendMode = node.blendMode;
  if (node.locked === true) spec.locked = true;
  if (protectedOf(node)) spec.protected = true;
  const radii = ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"]
    .map((k) => (Number.isFinite(Number(node[k])) ? Number(node[k]) : NaN));
  const hasIndividual = radii.every(Number.isFinite);
  const individualSet = hasIndividual && radii.some((r) => r > 0);
  if (individualSet && radii.some((r) => r !== radii[0])) {
    spec.topLeftRadius = round(radii[0]);
    spec.topRightRadius = round(radii[1]);
    spec.bottomRightRadius = round(radii[2]);
    spec.bottomLeftRadius = round(radii[3]);
  } else if (typeof node.cornerRadius === "number" && node.cornerRadius > 0) {
    spec.cornerRadius = round(node.cornerRadius);
  } else if (individualSet) {
    spec.cornerRadius = round(radii[0]);
  } else if (Array.isArray(node.cornerRadius)) {
    const uniform = node.cornerRadius.map(Number);
    if (uniform.every((r: number) => r === uniform[0]) && uniform[0] > 0) spec.cornerRadius = round(uniform[0]);
    else state.warnings.push(`${path}: per-corner radii could not be read as four numbers`);
  }
  if (typeof node.cornerSmoothing === "number" && node.cornerSmoothing > 0) spec.cornerSmoothing = round(node.cornerSmoothing);
  if (typeof node.strokeWeight === "number") spec.strokeWeight = round(node.strokeWeight);
  if (node.strokeAlign && node.strokeAlign !== "INSIDE") spec.strokeAlign = node.strokeAlign;
  if (node.strokeCap && node.strokeCap !== "NONE") spec.strokeCap = node.strokeCap;
  if (node.strokeJoin && node.strokeJoin !== "MITER") spec.strokeJoin = node.strokeJoin;
  if (Number(node.strokeMiterLimit) > 0 && Number(node.strokeMiterLimit) !== 4) {
    spec.strokeMiterLimit = round(Number(node.strokeMiterLimit));
  }
  if (Array.isArray(node.dashPattern) && node.dashPattern.length) spec.dashPattern = node.dashPattern.map(Number);
  if (node.constraints && !parentAuto) spec.constraints = { horizontal: node.constraints.horizontal, vertical: node.constraints.vertical };

  if (Math.abs(Number(node.rotation) || 0) > 0.01) spec.rotation = round(Number(node.rotation));
  if (node.type === "LINE") {
    if (Number(node.width) > 0) spec.length = round(Number(node.width));
    else state.warnings.push(`${path}: LINE has no positive width, so its length is not representable`);
    if (Math.abs(Number(node.height) || 0) > 0.01) {
      state.warnings.push(`${path}: LINE has a non-zero height ${round(Number(node.height))}; only a straight line is representable`);
    }
  }
  if (node.isMask === true) spec.isMask = true;
  const grids = gridsFor(node, state.warnings, path);
  if (grids) spec.layoutGrids = grids;
  if (node.itemReverseZIndex === true) spec.itemReverseZIndex = true;
  if (node.strokesIncludedInLayout === true) spec.strokesIncludedInLayout = true;

  let baseFillsSpec: any[] | null = null;
  if (textSegments) {
    const style = await styleInfo(ctx, node.fillStyleId, state.styles);
    if (style) spec.fillStyle = style.name;
    else {
      if (node.fillStyleId && !isMixed(node.fillStyleId)) {
        state.warnings.push(`${path}: fill style id ${node.fillStyleId} no longer resolves; exported literal paints instead`);
      }
      baseFillsSpec = await paintsToSpec(ctx, textSegments[0].fills, state.vars, state.warnings, `${path}.fills`);
      if (baseFillsSpec) spec.fills = baseFillsSpec;
      else state.warnings.push(`${path}: the base run's fills could not be read and were omitted`);
    }
    // The style carries the base paints; the literal version is still needed to
    // decide which later runs differ from them.
    if (!baseFillsSpec) {
      baseFillsSpec = await paintsToSpec(ctx, textSegments[0].fills, state.vars, state.warnings, `${path}.fills`);
    }
  } else {
    const fills = await paintsFor(ctx, node, "fills", state.styles, state.vars, state.warnings, path);
    if (fills?.style) spec.fillStyle = fills.style;
    else if (fills) spec.fills = fills.paints;
  }
  const strokes = await paintsFor(ctx, node, "strokes", state.styles, state.vars, state.warnings, path);
  if (strokes?.style) spec.strokeStyle = strokes.style;
  else if (strokes) spec.strokes = strokes.paints;

  let effectStyle = null;
  if ("effectStyleId" in node) {
    effectStyle = await styleInfo(ctx, node.effectStyleId, state.styles);
    if (effectStyle) spec.effectStyle = effectStyle.name;
    else if (node.effectStyleId && !isMixed(node.effectStyleId)) {
      state.warnings.push(`${path}: effect style id ${node.effectStyleId} no longer resolves; exported literal effects instead`);
    }
  }
  if (!effectStyle) {
    const effects = effectsFor(node, state.warnings, path);
    if (effects && effects.length) spec.effects = effects;
  }

  const layout = mergeLayout(containerLayout(node), childLayout(node));
  if (layout && Object.keys(layout).length) spec.layout = layout;

  if (node.type === "TEXT") {
    spec.text = typeof node.characters === "string" ? node.characters : "";
    const style = await styleInfo(ctx, node.textStyleId, state.styles);
    if (style) spec.textStyle = style.name;
    if (textSegments) {
      const base = textSegments[0];
      const baseFont = compactFont(base.fontName);
      if (baseFont) {
        if (!style || !style.fontName || style.fontName.family !== baseFont.family || style.fontName.style !== baseFont.style) {
          spec.font = baseFont;
        }
      } else {
        state.warnings.push(`${path}: the first text run has no readable font`);
      }
      if (Number.isFinite(Number(base.fontSize))) spec.fontSize = round(Number(base.fontSize));
      if (base.lineHeight) spec.lineHeight = plain(base.lineHeight);
      if (base.letterSpacing) spec.letterSpacing = plain(base.letterSpacing);
      if (base.textCase && base.textCase !== "ORIGINAL") spec.textCase = base.textCase;
      if (base.textDecoration && base.textDecoration !== "NONE") spec.textDecoration = base.textDecoration;
      const baseLink = compactLink(base.hyperlink);
      if (baseLink) {
        spec.hyperlink = baseLink;
        if (baseLink.type === "NODE") {
          state.warnings.push(`${path}: the text hyperlink points at node ${baseLink.value}; a NODE link is file-local and will not resolve in another file`);
        }
      }
      const runs = await textRunsFor(ctx, textSegments, baseFillsSpec, state.vars, state.warnings, path);
      if (runs.length) spec.runs = runs;
      if (isMixed(node.textStyleId)) {
        state.warnings.push(`${path}: text style ids are mixed across runs; per-run text style links are not representable, so literal run styling was exported`);
      }
      if (isMixed(node.fillStyleId)) {
        state.warnings.push(`${path}: fill style ids are mixed across runs; per-run fill style links are not representable, so literal run fills were exported`);
      }
    } else {
      if (isObj(node.fontName)) {
        if (!style || (style.fontName && (style.fontName.family !== node.fontName.family || style.fontName.style !== node.fontName.style))) {
          spec.font = { family: node.fontName.family, style: node.fontName.style };
        }
      } else if (!style) {
        state.warnings.push(`${path}: text uses MIXED fonts; the spec can only carry one font`);
      }
      if (!isMixed(node.fontSize) && Number.isFinite(Number(node.fontSize))) spec.fontSize = round(Number(node.fontSize));
      if (!isMixed(node.lineHeight) && node.lineHeight) spec.lineHeight = node.lineHeight;
      if (!isMixed(node.letterSpacing) && node.letterSpacing) spec.letterSpacing = node.letterSpacing;
      if (node.textCase && node.textCase !== "ORIGINAL") spec.textCase = node.textCase;
      if (node.textDecoration && node.textDecoration !== "NONE") spec.textDecoration = node.textDecoration;
      const link = node.hyperlink;
      if (isObj(link) && (link.type === "URL" || link.type === "NODE") && typeof link.value === "string" && link.value) {
        spec.hyperlink = { type: link.type, value: link.value };
        if (link.type === "NODE") {
          state.warnings.push(`${path}: the text hyperlink points at node ${link.value}; a NODE link is file-local and will not resolve in another file`);
        }
      } else if (isMixed(link)) {
        state.warnings.push(`${path}: text hyperlinks are mixed across runs; the spec can carry one link and they were omitted`);
      } else if (link) {
        state.warnings.push(`${path}: the text hyperlink is unreadable and was omitted`);
      }
    }
    if (textAutoResize) spec.textAutoResize = textAutoResize;
    for (const k of ["textAlignHorizontal", "textAlignVertical"]) {
      if (node[k]) spec[k] = node[k];
    }
    if (Number(node.paragraphSpacing) > 0) spec.paragraphSpacing = round(Number(node.paragraphSpacing));
    if (Number(node.paragraphIndent) > 0) spec.paragraphIndent = round(Number(node.paragraphIndent));
  }

  state.nodes++;
  if ((node.type === "FRAME" || node.type === "COMPONENT") && Array.isArray(node.children)) {
    const children: any[] = [];
    for (const child of node.children) {
      const made = await exportNode(ctx, child, key, children.length, depth + 1, state);
      if (made) children.push(made);
    }
    if (children.length) spec.children = children;
  }
  return spec;
}

export async function runExportSpec(ctx: any, params: Json = {}): Promise<Json> {
  const t0 = Date.now();
  let root: any = null;
  if (params.nodeId) root = await ctx.getNodeByIdAsync(String(params.nodeId));
  else {
    const selection = ctx.currentPage && ctx.currentPage.selection;
    if (Array.isArray(selection) && selection.length === 1) root = selection[0];
  }
  if (!root || root.removed === true) {
    throw new Error("export_build_spec needs nodeId, or exactly one selected node");
  }
  if (!EXPORTABLE.has(root.type) || (root.type === "FRAME" && kindOf(root) === "SVG")) {
    throw new Error(`the root is a ${root.type}; a build spec can describe ${[...EXPORTABLE].join(", ")}`);
  }
  if (root.visible === false && params.includeHidden === false) {
    throw new Error("the root is hidden and includeHidden is false; nothing would be exported");
  }

  const maxNodes = Math.max(1, Math.min(Number(params.maxNodes === undefined ? 500 : params.maxNodes), 2000));
  const maxDepth = Math.max(0, Math.min(Number(params.maxDepth === undefined ? 32 : params.maxDepth), 64));
  if (!Number.isFinite(maxNodes) || !Number.isFinite(maxDepth)) throw new Error("maxNodes and maxDepth must be numbers");
  const state: Json = {
    nodes: 0,
    scanned: 0,
    maxNodes,
    maxDepth,
    includeHidden: params.includeHidden !== false,
    truncated: false,
    keys: new Set<string>(),
    warnings: [] as string[],
    unsupported: [] as Array<{ path: string; type: string; why: string }>,
    styles: new Map<string, any>(),
    vars: new Map<string, any>(),
  };

  const spec = await exportNode(ctx, root, "", 0, 0, state);
  if (!spec) throw new Error(`the root could not be exported: ${state.unsupported[0]?.why || "unsupported node"}`);
  return {
    schema: SPEC_EXPORT_SCHEMA,
    source: {
      id: root.id,
      name: root.name,
      type: root.type,
      key: keyOf(root) || null,
      buildId: buildOf(root) || null,
      path: pathOf(root),
    },
    spec,
    counts: { nodes: state.nodes, scanned: state.scanned, skipped: state.unsupported.length },
    unsupported: state.unsupported,
    warnings: [
      ...state.warnings,
      ...(state.truncated ? [`node cap ${maxNodes} reached; the spec is INCOMPLETE and should not be built as-is`] : []),
    ],
    truncated: state.truncated,
    ms: { export: Date.now() - t0 },
  };
}
