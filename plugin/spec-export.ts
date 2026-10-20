/// <reference types="@figma/plugin-typings" />

/**
 * The reverse of ui-build: describe a live subtree as a build spec.
 *
 * A design that was made by hand can be handed to figma_build/figma_patch on
 * another page or in another file. This is a lossy translation by nature — the
 * Plugin API cannot recover an SVG's source or the inside of an instance, and
 * some node types have no live build equivalent — so the report names every
 * field it could not carry instead of returning a spec that looks complete. A
 * node with no build equivalent can instead travel as the SVG render of its
 * current appearance; the spec then says it is flattened and the report names
 * what that loses.
 *
 * The spec is ordinary data and the source is never modified.
 */

import { BUILD_DATA, KEY_DATA, KIND_DATA, MAX_SPEC_BYTES, PROTECTED_DATA } from "./ui-build";

export const SPEC_EXPORT_SCHEMA = "build-spec-export/v1";

type Json = any;

const EXPORTABLE = new Set([
  "FRAME", "RECTANGLE", "ELLIPSE", "LINE", "TEXT", "INSTANCE", "COMPONENT", "BOOLEAN_OPERATION",
]);
const BOOLEAN_OPERATIONS = new Set(["UNION", "SUBTRACT", "INTERSECT", "EXCLUDE"]);
/*
 * A node type the build cannot express can still be carried as its rendered
 * appearance: Figma exports any layer as SVG, and the build engine already
 * creates a frame from an SVG string. The fallback is deliberately bounded —
 * the build refuses a spec over MAX_SPEC_BYTES, and one enormous illustration
 * must not crowd out the rest of the tree.
 */
const SVG_FALLBACK_NODE_LIMIT = 128 * 1024;
const SVG_FALLBACK_TOTAL_LIMIT = 192 * 1024;
const NO_SVG_FALLBACK = new Set(["SLICE"]);

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

function paintCommon(out: Json, paint: any): Json {
  if (paint.opacity !== undefined && Number(paint.opacity) !== 1) out.opacity = round(Number(paint.opacity));
  // An invisible paint is still a paint in the list: dropping it would change
  // the stack and its blend mode, even when nothing on screen changes today.
  if (paint.visible === false) out.visible = false;
  if (paint.blendMode && paint.blendMode !== "NORMAL") out.blendMode = paint.blendMode;
  return out;
}

async function paintToSpec(
  ctx: any,
  paint: any,
  vars: Map<string, any>,
  warnings: string[],
  path: string,
): Promise<any | null> {
  if (!paint) return null;
  if (paint.type === "SOLID" && paint.color) {
    const out: Json = { color: hex(paint.color) };
    if (!out.color) {
      warnings.push(`${path}: a SOLID paint has an unreadable colour and was omitted`);
      return null;
    }
    const alias = paint.boundVariables && paint.boundVariables.color && paint.boundVariables.color.id;
    if (alias) {
      const name = await variableName(ctx, alias, vars);
      if (name) out.variable = name;
      else warnings.push(`${path}: paint bound to variable ${alias}, which could not be resolved; the literal colour was exported`);
    }
    return paintCommon(out, paint);
  }
  if (paint.type === "PATTERN") {
    const sourceNodeId = typeof paint.sourceNodeId === "string" ? paint.sourceNodeId : "";
    if (!sourceNodeId) {
      warnings.push(`${path}: a PATTERN paint has no sourceNodeId and was omitted`);
      return null;
    }
    const spacing = isObj(paint.spacing)
      ? { x: Number(paint.spacing.x), y: Number(paint.spacing.y) }
      : { x: 0, y: 0 };
    const scalingFactor = paint.scalingFactor === undefined ? 1 : Number(paint.scalingFactor);
    const tileType = paint.tileType || "RECTANGULAR";
    const horizontalAlignment = paint.horizontalAlignment || "START";
    if (!Number.isFinite(spacing.x) || !Number.isFinite(spacing.y) || !Number.isFinite(scalingFactor) || scalingFactor <= 0) {
      warnings.push(`${path}: a PATTERN paint has an unreadable scaling factor or spacing and was omitted`);
      return null;
    }
    if (!["RECTANGULAR", "HORIZONTAL_HEXAGONAL", "VERTICAL_HEXAGONAL"].includes(tileType) ||
        !["START", "CENTER", "END"].includes(horizontalAlignment)) {
      warnings.push(`${path}: a PATTERN paint has an unknown tile type or horizontal alignment and was omitted`);
      return null;
    }
    return paintCommon({
      type: "PATTERN",
      sourceNodeId,
      tileType,
      scalingFactor,
      spacing,
      horizontalAlignment,
    }, paint);
  }
  if (paint.type === "SHADER") {
    const shaderId = typeof paint.id === "string" ? paint.id : "";
    if (!shaderId) {
      warnings.push(`${path}: a SHADER paint has no id and was omitted`);
      return null;
    }
    const out: Json = { type: "SHADER", shaderId };
    if (paint.properties !== undefined) {
      if (!isObj(paint.properties)) {
        warnings.push(`${path}: a SHADER paint has unreadable properties; they were omitted and the shader defaults apply`);
      } else {
        try {
          const properties = JSON.parse(JSON.stringify(paint.properties));
          if (Object.keys(properties).length) out.properties = properties;
        } catch {
          warnings.push(`${path}: a SHADER paint has properties that are not JSON-serializable; they were omitted`);
        }
      }
    }
    return paintCommon(out, paint);
  }
  if (paint.type === "IMAGE" || paint.type === "VIDEO") {
    const hash = paint.type === "IMAGE" ? paint.imageHash : paint.videoHash;
    if (!hash) {
      warnings.push(`${path}: a ${paint.type} paint has no ${paint.type === "IMAGE" ? "imageHash" : "videoHash"} and was omitted`);
      return null;
    }
    const out: Json = { type: paint.type, [paint.type === "IMAGE" ? "imageHash" : "videoHash"]: hash, scaleMode: paint.scaleMode || "FILL" };
    const transform = paint.type === "IMAGE" ? paint.imageTransform : paint.videoTransform;
    if (transform) out[paint.type === "IMAGE" ? "imageTransform" : "videoTransform"] = transform;
    if (paint.scalingFactor !== undefined) out.scalingFactor = paint.scalingFactor;
    if (paint.rotation !== undefined) out.rotation = paint.rotation;
    if (paint.filters) out.filters = paint.filters;
    return paintCommon(out, paint);
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
    return paintCommon(out, paint);
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
  "boundVariables",
];

const TEXT_VARIABLE_FIELDS = new Set([
  "fontFamily", "fontStyle", "fontWeight", "fontSize",
  "letterSpacing", "lineHeight", "paragraphSpacing", "paragraphIndent",
]);

const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

/** field -> uniform alias id. A field with several different ids is left to runs. */
function textVariableIds(bound: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObj(bound)) return out;
  for (const field of TEXT_VARIABLE_FIELDS) {
    const value = bound[field];
    if (!value) continue;
    const list = Array.isArray(value) ? value : [value];
    const ids = [...new Set(list
      .filter((a: any) => isObj(a) && a.type === "VARIABLE_ALIAS" && typeof a.id === "string" && a.id)
      .map((a: any) => a.id))];
    if (ids.length === 1) out[field] = ids[0];
  }
  return out;
}

function hasTextVariables(bound: any): boolean {
  if (!isObj(bound)) return false;
  for (const field of TEXT_VARIABLE_FIELDS) {
    const value = bound[field];
    if (!value) continue;
    if (Array.isArray(value) ? value.length > 0 : isObj(value)) return true;
  }
  return false;
}

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
    if (!Array.isArray(segs) || !segs.length) return null;
    // A uniform text with a variable binding still needs the segment path: the
    // first segment becomes the base binding, and the ordinary text path has no
    // field for a text variable.
    const force = hasTextVariables(node.boundVariables) || segs.some((s: any) => hasTextVariables(s?.boundVariables));
    if (segs.length <= 1 && !force) return null;
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
  baseTextStyleId: string,
  baseFillStyleId: string,
  baseVars: Record<string, string>,
  vars: Map<string, any>,
  styles: Map<string, any>,
  warnings: string[],
  path: string,
): Promise<any[]> {
  const base = segments[0];
  const baseFont = compactFont(base.fontName);
  const baseLink = compactLink(base.hyperlink);
  const baseCase = String(base.textCase || "ORIGINAL");
  const baseDecoration = String(base.textDecoration || "NONE");
  const runs: any[] = [];

  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const at = `${path}.runs[${i - 1}]`;
    const run: any = { start: seg.start, end: seg.end };
    let changed = false;
    const segTextStyleId = typeof seg.textStyleId === "string" ? seg.textStyleId : "";
    const segFillStyleId = typeof seg.fillStyleId === "string" ? seg.fillStyleId : "";

    if (segTextStyleId !== baseTextStyleId) {
      if (!segTextStyleId) {
        run.textStyle = null;
        changed = true;
      } else {
        const style = await styleInfo(ctx, segTextStyleId, styles);
        if (style) {
          run.textStyle = style.name;
          changed = true;
        } else {
          warnings.push(`${at}: text style id ${segTextStyleId} no longer resolves; the run keeps literal styling`);
        }
      }
    }
    const font = compactFont(seg.fontName);
    if (font && !same(font, baseFont)) { run.font = font; changed = true; }
    if (Number.isFinite(Number(seg.fontSize)) && Number(seg.fontSize) !== Number(base.fontSize)) {
      run.fontSize = round(Number(seg.fontSize));
      changed = true;
    }
    const segFills = await paintsToSpec(ctx, seg.fills, vars, warnings, `${at}.fills`);
    const fillsDiffer = !!segFills && !!baseFills && !same(segFills, baseFills);
    if (segFillStyleId !== baseFillStyleId) {
      if (!segFillStyleId) {
        run.fillStyle = null;
        if (fillsDiffer) run.fills = segFills;
        changed = true;
      } else {
        const style = await styleInfo(ctx, segFillStyleId, styles);
        if (style) {
          run.fillStyle = style.name;
          changed = true;
        } else {
          warnings.push(`${at}: fill style id ${segFillStyleId} no longer resolves; the run keeps literal fills`);
          if (fillsDiffer) {
            run.fills = segFills;
            changed = true;
          }
        }
      }
    } else if (fillsDiffer) {
      run.fills = segFills;
      changed = true;
    }
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
    const segVars = textVariableIds(seg.boundVariables);
    for (const field of TEXT_VARIABLE_FIELDS) {
      const segId = segVars[field] || "";
      const baseId = baseVars[field] || "";
      if (segId === baseId) continue;
      if (!segId) {
        (run.variable ||= {})[field] = null;
        changed = true;
        continue;
      }
      const name = await variableName(ctx, segId, vars);
      if (name) {
        (run.variable ||= {})[field] = name;
        changed = true;
      } else {
        // Clearing the inherited base binding is what lets the literal run
        // value actually win after the rebuild.
        (run.variable ||= {})[field] = null;
        changed = true;
        warnings.push(`${at}: variable id ${segId} bound to ${field} no longer resolves; the literal value was exported`);
      }
    }
    if (changed) runs.push(run);
  }
  return runs;
}

function instanceDescendants(root: any): Map<string, any> {
  const out = new Map<string, any>();
  const walk = (node: any) => {
    for (const child of node.children || []) {
      if (!child || typeof child.id !== "string") continue;
      out.set(child.id, child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

function overridePathFrom(instance: any, target: any, main: any): any[] | null {
  const nodes: any[] = [];
  let node = target;
  while (node && node !== instance) {
    const parent = node.parent;
    if (!parent) return null;
    nodes.unshift(node);
    node = parent;
  }
  if (node !== instance || !nodes.length) return null;

  // Names come from the main component, not from the instance: renaming a layer
  // inside an instance is itself an override, and a path that used the new name
  // would not match the layer the rebuild creates from the main component.
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
 * A build spec cannot contain an instance's interior, but it can say which
 * layers the instance overrides. Only direct overrides are exposed by the API;
 * each one is exported as a structural path plus the fields the rebuild can
 * express. Anything else is named instead of silently rebuilding the default.
 */
async function instanceOverridesFor(ctx: any, instance: any, main: any, state: Json, path: string): Promise<Json | undefined> {
  const entries = Array.isArray(instance.overrides) ? instance.overrides : [];
  if (!entries.length) return undefined;
  const descendants = instanceDescendants(instance);
  const overrides: Json = {};
  for (const entry of entries) {
    if (!isObj(entry) || typeof entry.id !== "string") {
      state.warnings.push(`${path}: an instance override entry has no node id and was skipped`);
      continue;
    }
    const target = descendants.get(entry.id);
    if (!target) {
      state.warnings.push(`${path}: override target ${entry.id} is not inside this instance; skipped`);
      continue;
    }
    const steps = overridePathFrom(instance, target, main);
    if (!steps) {
      state.warnings.push(`${path}: override target "${target.name}" is not reachable from this instance; skipped`);
      continue;
    }
    const at = `${path}: instance override on "${target.name}"`;
    const out: Json = { path: steps };
    const unsupported: string[] = [];
    const wants = { fills: false, strokes: false, effects: false, size: false };
    const fields: string[] = Array.isArray(entry.overriddenFields)
      ? [...new Set((entry.overriddenFields as any[]).map((field) => String(field)))]
      : [];

    for (const field of fields) {
      switch (field) {
        case "name":
          if (typeof target.name === "string") out.name = target.name;
          else unsupported.push(field);
          break;
        case "characters":
          if (target.type === "TEXT" && typeof target.characters === "string") out.text = target.characters;
          else unsupported.push(field);
          break;
        case "fontName": {
          const font = compactFont(target.fontName);
          if (font) out.font = font;
          else unsupported.push(field);
          break;
        }
        case "fontSize":
          if (Number.isFinite(Number(target.fontSize))) out.fontSize = round(Number(target.fontSize));
          else unsupported.push(field);
          break;
        case "textCase":
          if (typeof target.textCase === "string") out.textCase = target.textCase;
          else unsupported.push(field);
          break;
        case "textDecoration":
          if (typeof target.textDecoration === "string") out.textDecoration = target.textDecoration;
          else unsupported.push(field);
          break;
        case "lineHeight":
          if (target.lineHeight && !isMixed(target.lineHeight)) out.lineHeight = plain(target.lineHeight);
          else unsupported.push(field);
          break;
        case "letterSpacing":
          if (target.letterSpacing && !isMixed(target.letterSpacing)) out.letterSpacing = plain(target.letterSpacing);
          else unsupported.push(field);
          break;
        case "paragraphSpacing":
          if (Number.isFinite(Number(target.paragraphSpacing))) out.paragraphSpacing = round(Number(target.paragraphSpacing));
          else unsupported.push(field);
          break;
        case "paragraphIndent":
          if (Number.isFinite(Number(target.paragraphIndent))) out.paragraphIndent = round(Number(target.paragraphIndent));
          else unsupported.push(field);
          break;
        case "textAlignHorizontal":
          if (typeof target.textAlignHorizontal === "string") out.textAlignHorizontal = target.textAlignHorizontal;
          else unsupported.push(field);
          break;
        case "textAlignVertical":
          if (typeof target.textAlignVertical === "string") out.textAlignVertical = target.textAlignVertical;
          else unsupported.push(field);
          break;
        case "textAutoResize":
          if (typeof target.textAutoResize === "string") out.textAutoResize = target.textAutoResize;
          else unsupported.push(field);
          break;
        case "hyperlink":
          out.hyperlink = compactLink(target.hyperlink);
          break;
        case "visible":
          out.visible = target.visible !== false;
          break;
        case "locked":
          out.locked = target.locked === true;
          break;
        case "opacity":
          if (Number.isFinite(Number(target.opacity))) out.opacity = round(Number(target.opacity));
          else unsupported.push(field);
          break;
        case "blendMode":
          if (typeof target.blendMode === "string") out.blendMode = target.blendMode;
          else unsupported.push(field);
          break;
        case "rotation":
          if (Number.isFinite(Number(target.rotation))) out.rotation = round(Number(target.rotation));
          else unsupported.push(field);
          break;
        case "cornerRadius":
          if (Number.isFinite(Number(target.cornerRadius))) out.cornerRadius = round(Number(target.cornerRadius));
          else unsupported.push(field);
          break;
        case "topLeftRadius":
        case "topRightRadius":
        case "bottomLeftRadius":
        case "bottomRightRadius":
          if (Number.isFinite(Number(target[field]))) out[field] = round(Number(target[field]));
          else unsupported.push(field);
          break;
        case "strokeWeight":
          if (Number.isFinite(Number(target.strokeWeight))) out.strokeWeight = round(Number(target.strokeWeight));
          else unsupported.push(field);
          break;
        case "fills":
          wants.fills = true;
          break;
        case "strokes":
          wants.strokes = true;
          break;
        case "effects":
          wants.effects = true;
          break;
        case "width":
        case "height":
          wants.size = true;
          break;
        case "fillStyleId": {
          const style = await styleInfo(ctx, target.fillStyleId, state.styles);
          if (style) out.fillStyle = style.name;
          else {
            state.warnings.push(`${at}: fill style ${target.fillStyleId || "(none)"} no longer resolves; literal fills were exported`);
            wants.fills = true;
          }
          break;
        }
        case "strokeStyleId": {
          const style = await styleInfo(ctx, target.strokeStyleId, state.styles);
          if (style) out.strokeStyle = style.name;
          else {
            state.warnings.push(`${at}: stroke style ${target.strokeStyleId || "(none)"} no longer resolves; literal strokes were exported`);
            wants.strokes = true;
          }
          break;
        }
        case "effectStyleId": {
          const style = await styleInfo(ctx, target.effectStyleId, state.styles);
          if (style) out.effectStyle = style.name;
          else {
            state.warnings.push(`${at}: effect style ${target.effectStyleId || "(none)"} no longer resolves; literal effects were exported`);
            wants.effects = true;
          }
          break;
        }
        case "textStyleId": {
          const style = await styleInfo(ctx, target.textStyleId, state.styles);
          if (style) out.textStyle = style.name;
          else {
            state.warnings.push(`${at}: text style ${target.textStyleId || "(none)"} no longer resolves; literal font and size were exported`);
            const font = compactFont(target.fontName);
            if (font) out.font = font;
            if (Number.isFinite(Number(target.fontSize))) out.fontSize = round(Number(target.fontSize));
          }
          break;
        }
        default:
          unsupported.push(field);
      }
    }

    if (wants.fills) {
      const paints = await paintsToSpec(ctx, target.fills, state.vars, state.warnings, `${path}.overrides["${target.name}"].fills`);
      if (paints) out.fills = paints;
      else unsupported.push("fills (mixed or unreadable)");
    }
    if (wants.strokes) {
      const paints = await paintsToSpec(ctx, target.strokes, state.vars, state.warnings, `${path}.overrides["${target.name}"].strokes`);
      if (paints) out.strokes = paints;
      else unsupported.push("strokes (mixed or unreadable)");
    }
    if (wants.effects) {
      const effects = effectsFor(target, state.warnings, `${path}.overrides["${target.name}"].effects`);
      if (effects) out.effects = effects;
      else unsupported.push("effects (unreadable)");
    }
    if (wants.size) {
      const width = Number(target.width);
      const height = Number(target.height);
      if (Number.isFinite(width) && Number.isFinite(height)) out.size = { width: round(width), height: round(height) };
      else unsupported.push("size");
    }
    if (unsupported.length) {
      state.warnings.push(`${at} changes ${unsupported.join(", ")}, which a build spec cannot represent`);
    }
    if (Object.keys(out).length > 1) {
      const base = String(target.name || target.type || "layer");
      let key = base;
      let n = 2;
      while (Object.prototype.hasOwnProperty.call(overrides, key)) key = `${base}#${n++}`;
      overrides[key] = out;
    }
  }
  return Object.keys(overrides).length ? overrides : undefined;
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

/** Decode the UTF-8 bytes of an SVG export without relying on `TextDecoder`. */
function decodeUtf8(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i++];
    if (b < 0x80) out += String.fromCharCode(b);
    else if (b < 0xe0) out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
    else if (b < 0xf0) {
      out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
    } else {
      const cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      out += String.fromCodePoint(cp);
    }
  }
  return out;
}

/**
 * Render a layer as an inline SVG. `SVG_STRING` is the direct form; older
 * plugin sessions only know `SVG`, whose bytes are decoded by hand. A caller
 * gets a reason in `warnings` whenever no usable SVG comes back, so a skipped
 * fallback never looks like a node that was never there.
 */
async function svgFallbackFor(
  node: any,
  state: Json,
  path: string,
): Promise<{ svg: string | null; error?: string }> {
  if (typeof node.exportAsync !== "function") {
    const error = "this node has no exportAsync in this session";
    state.warnings.push(`${path}: SVG fallback is unavailable: ${error}`);
    return { svg: null, error };
  }
  let svg: any = "";
  try {
    svg = await node.exportAsync({
      format: "SVG_STRING",
      svgOutlineText: true,
      svgIdAttribute: false,
      svgSimplifyStroke: true,
    });
  } catch {
    try {
      const bytes: Uint8Array = await node.exportAsync({
        format: "SVG",
        svgOutlineText: true,
        svgIdAttribute: false,
        svgSimplifyStroke: true,
      });
      svg = decodeUtf8(bytes);
    } catch (e) {
      const error = `the SVG exporter failed: ${errMsg(e)}`;
      state.warnings.push(`${path}: SVG fallback failed: ${errMsg(e)}`);
      return { svg: null, error };
    }
  }
  if (typeof svg !== "string") svg = decodeUtf8(svg);
  if (!/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(svg)) {
    const error = "the exporter returned something that is not an <svg> document";
    state.warnings.push(`${path}: ${error}; fallback skipped`);
    return { svg: null, error };
  }
  if (svg.length > SVG_FALLBACK_NODE_LIMIT) {
    const error = `the render is ${Math.ceil(svg.length / 1024)} KiB, over the ${SVG_FALLBACK_NODE_LIMIT / 1024} KiB per-node fallback budget`;
    state.warnings.push(`${path}: ${error}; skipped`);
    return { svg: null, error };
  }
  if (state.svgBytes + svg.length > SVG_FALLBACK_TOTAL_LIMIT) {
    const error =
      `the render does not fit the remaining ${Math.ceil((SVG_FALLBACK_TOTAL_LIMIT - state.svgBytes) / 1024)} KiB of the ` +
      `${SVG_FALLBACK_TOTAL_LIMIT / 1024} KiB total fallback budget`;
    state.warnings.push(`${path}: ${error}; skipped`);
    return { svg: null, error };
  }
  return { svg };
}

/**
 * Placement and layout still belong to the surrounding tree; appearance does
 * not. The SVG already bakes in rotation, opacity, blends, effects, fills and
 * the text outlines, so copying those fields would apply them twice. Hidden and
 * mask bits are container semantics, not paint, and are safe to carry.
 */
function svgFallbackSpec(node: any, key: string, svg: string): Json {
  const spec: Json = { type: "SVG", name: node.name, key, svg };
  if (node.visible === false) spec.visible = false;
  if (node.locked === true) spec.locked = true;
  if (protectedOf(node)) spec.protected = true;
  if (node.isMask === true) spec.isMask = true;
  const parentAuto = node.parent && node.parent.layoutMode && node.parent.layoutMode !== "NONE";
  if (
    node.parent && (!parentAuto || node.layoutPositioning === "ABSOLUTE") &&
    Number.isFinite(Number(node.x)) && Number.isFinite(Number(node.y))
  ) {
    spec.position = { x: round(Number(node.x)), y: round(Number(node.y)) };
  }
  const layout = childLayout(node);
  if (layout) spec.layout = layout;
  if (node.constraints && !parentAuto) {
    spec.constraints = { horizontal: node.constraints.horizontal, vertical: node.constraints.vertical };
  }
  return spec;
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

  let direct = EXPORTABLE.has(node.type);
  let fallbackWhy = "";
  if (!direct) {
    fallbackWhy = NO_SVG_FALLBACK.has(node.type)
      ? `type ${node.type} is an export region, not a layer with a visual to rebuild`
      : `type ${node.type} has no build-spec equivalent`;
  } else if (node.type === "FRAME" && kindOf(node) === "SVG") {
    direct = false;
    fallbackWhy = "the node was created from SVG; the Plugin API does not expose the source string";
  } else if (node.type === "BOOLEAN_OPERATION" && !BOOLEAN_OPERATIONS.has(String(node.booleanOperation))) {
    direct = false;
    fallbackWhy = `boolean operation "${node.booleanOperation}" is not a build-spec operation`;
  } else if (node.type === "BOOLEAN_OPERATION") {
    const visibleOperands = (Array.isArray(node.children) ? node.children : [])
      .filter((child: any) => state.includeHidden || child.visible !== false).length;
    if (visibleOperands < 2) {
      direct = false;
      fallbackWhy = `the boolean operation has only ${visibleOperands} exportable operands; a build spec needs at least two`;
    }
  }

  let main: any = null;
  if (direct && node.type === "INSTANCE") {
    try {
      main = typeof node.getMainComponentAsync === "function" ? await node.getMainComponentAsync() : node.mainComponent;
    } catch {
      main = null;
    }
    if (!main) {
      direct = false;
      fallbackWhy = "detached instance: its main component cannot be resolved";
    }
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
  if (!direct) {
    if (state.svgFallback && !NO_SVG_FALLBACK.has(node.type)) {
      const result = await svgFallbackFor(node, state, path);
      if (result.svg) {
        state.keys.add(key);
        state.svgFallbacks++;
        state.svgBytes += result.svg.length;
        state.warnings.push(
          `${path}: ${fallbackWhy}; exported as an inline SVG render (flattened into vectors: no original child layers, text is outlined, no component identity, overrides, style or variable links)`,
        );
        state.nodes++;
        return svgFallbackSpec(node, key, result.svg);
      }
      if (result.error) fallbackWhy = `${fallbackWhy}; SVG fallback skipped: ${result.error}`;
    }
    state.unsupported.push({ path, type: node.type, why: fallbackWhy });
    return null;
  }

  state.keys.add(key);
  const spec: Json = { type: node.type, name: node.name, key };
  if (node.type === "BOOLEAN_OPERATION") spec.booleanOperation = String(node.booleanOperation);
  const textSegments = node.type === "TEXT" ? await textSegmentsFor(node, state, path) : null;
  if (node.type === "INSTANCE") {
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
    const overrides = await instanceOverridesFor(ctx, node, main, state, path);
    if (overrides) spec.overrides = overrides;
  }

  const size = [Number(node.width), Number(node.height)];
  const textAutoResize = node.type === "TEXT" ? node.textAutoResize : undefined;
  // A boolean's size is derived from its operands; exporting it would make the
  // rebuild resize the result after the operands have already set the bounds.
  const derivedSize = node.type === "BOOLEAN_OPERATION";
  if (
    !derivedSize && node.type !== "LINE" &&
    Number.isFinite(size[0]) && Number.isFinite(size[1]) && size[0] > 0 && size[1] > 0 &&
    (node.type !== "TEXT" || textAutoResize === "NONE")
  ) {
    spec.size = { width: round(size[0]), height: round(size[1]) };
  } else if (!derivedSize && node.type !== "TEXT" && node.type !== "LINE" && (!Number.isFinite(size[0]) || !Number.isFinite(size[1]) || size[0] <= 0 || size[1] <= 0)) {
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
  let baseTextStyleId = "";
  let baseFillStyleId = "";
  let baseVars: Record<string, string> = {};
  if (textSegments) {
    const base = textSegments[0];
    baseTextStyleId = typeof base.textStyleId === "string"
      ? base.textStyleId
      : (typeof node.textStyleId === "string" ? node.textStyleId : "");
    baseFillStyleId = typeof base.fillStyleId === "string"
      ? base.fillStyleId
      : (typeof node.fillStyleId === "string" ? node.fillStyleId : "");
    // The first segment's bindings are the base, but a field the segment does
    // not report can still be bound uniformly across the whole text.
    const baseBound = {
      ...(isObj(node.boundVariables) ? node.boundVariables : {}),
      ...(isObj(base.boundVariables) ? base.boundVariables : {}),
    };
    baseVars = textVariableIds(baseBound);
    const textVariable: any = {};
    for (const [field, id] of Object.entries(baseVars)) {
      const name = await variableName(ctx, id, state.vars);
      if (name) textVariable[field] = name;
      else state.warnings.push(`${path}: variable id ${id} bound to ${field} no longer resolves; the literal value was exported`);
    }
    if (Object.keys(textVariable).length) spec.textVariable = textVariable;
    const style = await styleInfo(ctx, baseFillStyleId, state.styles);
    if (style) spec.fillStyle = style.name;
    else if (baseFillStyleId) {
      state.warnings.push(`${path}: fill style id ${baseFillStyleId} no longer resolves; exported literal paints instead`);
    }
    // The style carries the base paints; the literal version is still needed to
    // decide which later runs differ from them.
    baseFillsSpec = await paintsToSpec(ctx, base.fills, state.vars, state.warnings, `${path}.fills`);
    if (!style) {
      if (baseFillsSpec) spec.fills = baseFillsSpec;
      else state.warnings.push(`${path}: the base run's fills could not be read and were omitted`);
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
    const textStyleId = textSegments ? baseTextStyleId : node.textStyleId;
    const style = await styleInfo(ctx, textStyleId, state.styles);
    if (style) spec.textStyle = style.name;
    else if (textStyleId && (textSegments || !isMixed(textStyleId))) {
      state.warnings.push(`${path}: text style id ${textStyleId} no longer resolves; exported literal text styling instead`);
    }
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
      const runs = await textRunsFor(
        ctx, textSegments, baseFillsSpec, baseTextStyleId, baseFillStyleId, baseVars,
        state.vars, state.styles, state.warnings, path,
      );
      if (runs.length) spec.runs = runs;
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
  if ((node.type === "FRAME" || node.type === "COMPONENT" || node.type === "BOOLEAN_OPERATION") && Array.isArray(node.children)) {
    const children: any[] = [];
    for (const child of node.children) {
      const made = await exportNode(ctx, child, key, children.length, depth + 1, state);
      if (made) children.push(made);
    }
    if (children.length) spec.children = children;
    if (node.type === "BOOLEAN_OPERATION" && children.length < 2) {
      const why = `the boolean operation exported only ${children.length} operand(s); a build spec needs at least two`;
      state.unsupported.push({ path, type: node.type, why });
      state.warnings.push(`${path}: ${why}`);
      return null;
    }
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
  const directRoot = EXPORTABLE.has(root.type) && !(root.type === "FRAME" && kindOf(root) === "SVG");
  if (!directRoot && params.svgFallback === false) {
    throw new Error(
      `the root is a ${root.type}; a build spec can describe ${[...EXPORTABLE].join(", ")}; ` +
        `pass svgFallback (default true) to export its appearance as an inline SVG`,
    );
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
    svgFallback: params.svgFallback !== false,
    svgFallbacks: 0,
    svgBytes: 0,
    truncated: false,
    keys: new Set<string>(),
    warnings: [] as string[],
    unsupported: [] as Array<{ path: string; type: string; why: string }>,
    styles: new Map<string, any>(),
    vars: new Map<string, any>(),
  };

  const spec = await exportNode(ctx, root, "", 0, 0, state);
  if (!spec) {
    const why = state.unsupported[0]?.why || "unsupported node";
    const detail = state.warnings.length ? ` (${state.warnings[state.warnings.length - 1]})` : "";
    throw new Error(`the root could not be exported: ${why}${detail}`);
  }
  const specBytes = JSON.stringify(spec).length;
  const warnings = [...state.warnings];
  if (state.truncated) warnings.push(`node cap ${maxNodes} reached; the spec is INCOMPLETE and should not be built as-is`);
  if (specBytes > MAX_SPEC_BYTES) {
    warnings.push(
      `the spec is ${specBytes} bytes; figma_build and figma_patch refuse a spec over ${MAX_SPEC_BYTES} bytes — split the tree or reduce the SVG fallback content`,
    );
  }
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
    counts: {
      nodes: state.nodes,
      scanned: state.scanned,
      skipped: state.unsupported.length,
      svgFallbacks: state.svgFallbacks,
      svgBytes: state.svgBytes,
      specBytes,
    },
    unsupported: state.unsupported,
    warnings,
    truncated: state.truncated,
    ms: { export: Date.now() - t0 },
  };
}
