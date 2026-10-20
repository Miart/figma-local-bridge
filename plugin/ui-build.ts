/// <reference types="@figma/plugin-typings" />

/**
 * Declarative UI build / patch engine.
 *
 * The premise: an agent should describe the SCREEN, not the sequence of Plugin
 * API calls that happens to produce it. A build spec is ordinary data, so it can
 * be validated, resolved, hashed, diffed and replayed without touching the
 * document. The engine turns it into a plan, and the plan is the thing the
 * caller approves.
 *
 * The two rules that shape the implementation:
 *
 *   1. Every node the engine owns has a STABLE KEY in pluginData. Names, indices
 *      and node ids are all unstable: a designer renames a layer, inserts a
 *      sibling, or Figma tears the session down and hands out new ids. A key
 *      survives all of that, which is what makes a patch a patch instead of a
 *      delete-and-recreate.
 *
 *   2. A dry run is a REAL plan, not a guess. It resolves fonts, styles,
 *      variables and components, reports every blocker, and returns a scope
 *      fingerprint. Apply recomputes that fingerprint and refuses if the
 *      document moved underneath the caller, so a plan made against one state
 *      can never silently land on another.
 *
 * What this deliberately does NOT do yet: create GROUPs or BOOLEAN_OPERATIONs,
 * swap an existing instance's main component, or edit inside an instance beyond
 * the named overrides. Those are refusals with a reason, not quiet fallbacks.
 */

import { snapshot, STRICT, hashString } from "./fingerprint";

export const BUILD_SCHEMA = "build-v1";
export const KEY_DATA = "figma-local-bridge.key";
export const BUILD_DATA = "figma-local-bridge.buildId";
export const PROTECTED_DATA = "figma-local-bridge.protected";
export const KIND_DATA = "figma-local-bridge.kind";

export const MAX_NODES = 500;
export const MAX_DEPTH = 32;
export const MAX_SPEC_BYTES = 256 * 1024;

const DEFAULT_FONT = { family: "Inter", style: "Regular" };

const ALLOWED_TYPES = new Set([
  "FRAME", "RECTANGLE", "ELLIPSE", "LINE", "TEXT", "INSTANCE", "COMPONENT", "SVG",
]);
const CONTAINER_TYPES = new Set(["FRAME", "COMPONENT"]);
const LEAF_TYPES = new Set(["RECTANGLE", "ELLIPSE", "LINE", "TEXT", "SVG"]);
const STROKE_CAPS = new Set(["NONE", "ROUND", "SQUARE", "ARROW_LINES", "ARROW_EQUILATERAL"]);
const STROKE_JOINS = new Set(["MITER", "BEVEL", "ROUND"]);
const TEXT_CASES = new Set(["ORIGINAL", "UPPER", "LOWER", "TITLE", "SMALL_CAPS", "SMALL_CAPS_FORCED"]);
const TEXT_DECORATIONS = new Set(["NONE", "UNDERLINE", "STRIKETHROUGH"]);
// The text fields Figma can bind to a variable, and the type each one needs.
// STRING and FLOAT are the only resolved types that appear here.
const TEXT_VARIABLE_TYPES: Record<string, "STRING" | "FLOAT"> = {
  fontFamily: "STRING",
  fontStyle: "STRING",
  fontWeight: "FLOAT",
  fontSize: "FLOAT",
  letterSpacing: "FLOAT",
  lineHeight: "FLOAT",
  paragraphSpacing: "FLOAT",
  paragraphIndent: "FLOAT",
};
const MAX_TEXT_RUNS = 200;
const GRID_PATTERNS = new Set(["COLUMNS", "ROWS", "GRID"]);
const GRID_ALIGNMENTS = new Set(["MIN", "MAX", "CENTER", "STRETCH"]);

type Json = any;

const has = (o: any, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v: any) => !!v && typeof v === "object" && !Array.isArray(v);
const errMsg = (e: any) => String(e && e.message ? e.message : e);
const round = (n: number) => Math.round(n * 100) / 100;

function slug(s: string): string {
  const out = String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return out || "node";
}

function compactKeys(obj: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of Object.keys(obj)) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

// ---------------------------------------------------------------- colours

/**
 * A colour is accepted as hex, rgb()/rgba(), or {r,g,b,a} in either 0..1 or
 * 0..255 units. The ambiguity is resolved by the largest channel: a value above
 * 1 cannot be a Figma float, so the triple is scaled. Mixing units is refused.
 */
export function parseColor(input: any): { r: number; g: number; b: number; a: number } {
  if (isObj(input)) {
    const nums = [input.r, input.g, input.b].map(Number);
    if (nums.some((n) => !Number.isFinite(n) || n < 0)) throw new Error("colour channels must be non-negative numbers");
    const scale = Math.max(...nums) > 1 ? 255 : 1;
    if (nums.some((n) => n > scale)) throw new Error("colour channels are out of range");
    const a = input.a === undefined ? 1 : Number(input.a);
    if (!Number.isFinite(a) || a < 0 || a > 1) throw new Error("colour alpha must be between 0 and 1");
    return { r: nums[0] / scale, g: nums[1] / scale, b: nums[2] / scale, a };
  }
  if (typeof input !== "string") throw new Error("colour must be a string or {r,g,b,a}");
  const s = input.trim();
  let m = /^#?([0-9a-f]{3})$/i.exec(s);
  if (m) {
    const [r, g, b] = m[1].split("").map((c) => parseInt(c + c, 16) / 255);
    return { r, g, b, a: 1 };
  }
  m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  if (m) {
    const n = parseInt(m[1], 16);
    return {
      r: ((n >> 16) & 255) / 255,
      g: ((n >> 8) & 255) / 255,
      b: (n & 255) / 255,
      a: m[2] ? parseInt(m[2], 16) / 255 : 1,
    };
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (m) {
    const [r, g, b] = [m[1], m[2], m[3]].map(Number);
    const a = m[4] === undefined ? 1 : Number(m[4]);
    if ([r, g, b].some((v) => v < 0 || v > 255) || a < 0 || a > 1) throw new Error("rgb()/rgba() channel out of range");
    return { r: r / 255, g: g / 255, b: b / 255, a };
  }
  throw new Error(`cannot parse colour "${input}" — use #rrggbb, #rrggbbaa, rgb(...) or rgba(...)`);
}

function solidPaint(color: any, opacity?: number): any {
  const c = parseColor(color);
  return {
    type: "SOLID",
    color: { r: c.r, g: c.g, b: c.b },
    opacity: opacity === undefined ? c.a : Math.max(0, Math.min(1, opacity)) * c.a,
  };
}

// ---------------------------------------------------------------- fonts

export function fontSpec(input: any): { family: string; style: string } | null {
  if (!input) return null;
  if (typeof input === "string") {
    const [family, ...rest] = input.split(/[/:]/);
    const trimmed = family.trim();
    if (!trimmed) return null;
    return { family: trimmed, style: (rest.join(":").trim() || "Regular") };
  }
  if (isObj(input) && input.family) {
    const family = String(input.family).trim();
    if (!family) return null;
    return { family, style: String(input.style || "Regular").trim() || "Regular" };
  }
  return null;
}

function fontKey(f: { family: string; style: string }): string {
  return `${f.family}/${f.style}`;
}

// ---------------------------------------------------------------- normalized tree

export interface NormalizedNode {
  key: string;
  type: string;
  name: string;
  spec: Json;
  children: NormalizedNode[];
}

export interface NormalizeResult {
  root: NormalizedNode;
  nodes: number;
  maxDepth: number;
  keys: string[];
  warnings: string[];
}

function defaultName(type: string, index: number): string {
  const base = type.charAt(0) + type.slice(1).toLowerCase();
  return `${base} ${index + 1}`;
}

function deriveKey(parentKey: string, type: string, name: string, index: number): string {
  return `${parentKey}/${slug(name || type)}#${index}`;
}

function validateNumber(v: any, path: string, opts: { positive?: boolean; min?: number; max?: number } = {}): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${path} must be a finite number`);
  if (opts.positive && n <= 0) throw new Error(`${path} must be > 0`);
  if (opts.min !== undefined && n < opts.min) throw new Error(`${path} must be >= ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) throw new Error(`${path} must be <= ${opts.max}`);
  return n;
}

function validatePoint(v: any, path: string): { x: number; y: number } {
  if (!isObj(v)) throw new Error(`${path} must be {x,y}`);
  return { x: validateNumber(v.x, `${path}.x`), y: validateNumber(v.y, `${path}.y`) };
}

export function hyperlinkFromSpec(v: any, path: string): { type: "URL" | "NODE"; value: string } | null {
  if (v === null) return null;
  if (!isObj(v)) throw new Error(`${path} must be {type:"URL"|"NODE", value} or null`);
  const type = String(v.type || "").toUpperCase();
  if (type !== "URL" && type !== "NODE") throw new Error(`${path}.type must be URL or NODE`);
  const value = typeof v.value === "string" ? v.value.trim() : "";
  if (!value) throw new Error(`${path}.value must be a non-empty string`);
  return { type, value };
}

function lineHeightFromSpec(v: any, path: string): Json {
  if (typeof v === "number") return { unit: "PIXELS", value: validateNumber(v, path, { min: 0 }) };
  if (!isObj(v)) throw new Error(`${path} must be a number or {unit,value}`);
  if (typeof v.unit !== "string" || !v.unit) throw new Error(`${path}.unit must be a non-empty string`);
  if (v.value !== undefined) validateNumber(v.value, `${path}.value`);
  return { ...v };
}

function letterSpacingFromSpec(v: any, path: string): Json {
  if (typeof v === "number") return { unit: "PIXELS", value: validateNumber(v, path) };
  if (!isObj(v)) throw new Error(`${path} must be a number or {unit,value}`);
  if (typeof v.unit !== "string" || !v.unit) throw new Error(`${path}.unit must be a non-empty string`);
  if (v.value !== undefined) validateNumber(v.value, `${path}.value`);
  return { ...v };
}

/**
 * A textVariable binds text fields to local variables. The keys are the Figma
 * field names, so the spec does not need its own vocabulary; the value is a
 * local variable name/id, or null to clear a binding inherited from the base.
 */
export function textVariableFromSpec(value: any, path: string): Json {
  if (!isObj(value)) throw new Error(`${path} must be an object`);
  const out: Json = {};
  for (const [field, ref] of Object.entries(value)) {
    if (!TEXT_VARIABLE_TYPES[field]) {
      throw new Error(`${path}.${field} is not a bindable text field; use one of ${Object.keys(TEXT_VARIABLE_TYPES).join(", ")}`);
    }
    if (ref !== null && (typeof ref !== "string" || !ref.trim())) {
      throw new Error(`${path}.${field} must be a non-empty variable name/id, or null to clear the binding`);
    }
    out[field] = ref === null ? null : ref.trim();
  }
  if (!Object.keys(out).length) throw new Error(`${path} needs at least one text field binding`);
  return out;
}

/**
 * Text runs are absolute character ranges, not a list of overrides that can
 * overlap. Keeping them ordered and disjoint makes apply deterministic: a font
 * set by run 1 cannot be silently undone by run 2. A field the run omits
 * inherits the node's base text style.
 */
export function textRunsFromSpec(value: any, path: string, text: string): Json[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  if (value.length > MAX_TEXT_RUNS) throw new Error(`${path} has ${value.length} runs; the limit is ${MAX_TEXT_RUNS}`);
  const out: Json[] = [];
  let previousEnd = 0;
  value.forEach((run: any, i: number) => {
    const at = `${path}[${i}]`;
    if (!isObj(run)) throw new Error(`${at} must be an object`);
    const start = validateNumber(run.start, `${at}.start`, { min: 0 });
    const end = validateNumber(run.end, `${at}.end`, { positive: true });
    if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error(`${at}: start and end must be integers`);
    if (end <= start) throw new Error(`${at}: end must be greater than start`);
    if (end > text.length) throw new Error(`${at}: end ${end} is past the text length ${text.length}`);
    if (i > 0 && start < previousEnd) {
      throw new Error(`${at}: runs must be ordered and non-overlapping (starts at ${start}, previous ends at ${previousEnd})`);
    }
    previousEnd = end;
    const normalized: Json = { start, end };
    let fields = 0;
    if (run.font !== undefined) {
      const font = fontSpec(run.font);
      if (!font) throw new Error(`${at}.font must be "Family/Style" or {family,style}`);
      normalized.font = font;
      fields++;
    }
    if (run.fontSize !== undefined) {
      normalized.fontSize = validateNumber(run.fontSize, `${at}.fontSize`, { positive: true });
      fields++;
    }
    if (run.textStyle !== undefined) {
      if (run.textStyle !== null && (typeof run.textStyle !== "string" || !run.textStyle.trim())) {
        throw new Error(`${at}.textStyle must be a non-empty style name/id, or null to clear the link`);
      }
      normalized.textStyle = run.textStyle === null ? null : run.textStyle.trim();
      fields++;
    }
    if (run.fills !== undefined) {
      if (!(typeof run.fills === "string" || isObj(run.fills) || Array.isArray(run.fills))) {
        throw new Error(`${at}.fills must be a colour string, a paint object or an array of paints`);
      }
      normalized.fills = run.fills;
      fields++;
    }
    if (run.fillStyle !== undefined) {
      if (run.fillStyle !== null && (typeof run.fillStyle !== "string" || !run.fillStyle.trim())) {
        throw new Error(`${at}.fillStyle must be a non-empty style name/id, or null to clear the link`);
      }
      if (run.fills !== undefined) throw new Error(`${at}: use fillStyle or fills, not both — the style link and literal paints would disagree`);
      normalized.fillStyle = run.fillStyle === null ? null : run.fillStyle.trim();
      fields++;
    }
    if (run.variable !== undefined) {
      normalized.variable = textVariableFromSpec(run.variable, `${at}.variable`);
      fields++;
    }
    if (run.textCase !== undefined) {
      if (!TEXT_CASES.has(String(run.textCase))) throw new Error(`${at}.textCase must be ${[...TEXT_CASES].join(", ")}`);
      normalized.textCase = run.textCase;
      fields++;
    }
    if (run.textDecoration !== undefined) {
      if (!TEXT_DECORATIONS.has(String(run.textDecoration))) {
        throw new Error(`${at}.textDecoration must be ${[...TEXT_DECORATIONS].join(", ")}`);
      }
      normalized.textDecoration = run.textDecoration;
      fields++;
    }
    if (run.lineHeight !== undefined) {
      normalized.lineHeight = lineHeightFromSpec(run.lineHeight, `${at}.lineHeight`);
      fields++;
    }
    if (run.letterSpacing !== undefined) {
      normalized.letterSpacing = letterSpacingFromSpec(run.letterSpacing, `${at}.letterSpacing`);
      fields++;
    }
    if (run.hyperlink !== undefined) {
      normalized.hyperlink = hyperlinkFromSpec(run.hyperlink, `${at}.hyperlink`);
      fields++;
    }
    if (!fields) throw new Error(`${at}: a run needs at least one of font, fontSize, textStyle, fills, fillStyle, variable, textCase, textDecoration, lineHeight, letterSpacing or hyperlink`);
    out.push(normalized);
  });
  return out;
}

function validateSize(v: any, path: string): { width: number; height: number } {
  if (!isObj(v)) throw new Error(`${path} must be {width,height}`);
  return {
    width: validateNumber(v.width, `${path}.width`, { positive: true }),
    height: validateNumber(v.height, `${path}.height`, { positive: true }),
  };
}

function validateLayout(v: any, path: string): Json {
  if (!isObj(v)) throw new Error(`${path} must be an object`);
  const out: Json = { ...v };
  if (v.mode !== undefined && !["NONE", "HORIZONTAL", "VERTICAL"].includes(String(v.mode))) {
    throw new Error(`${path}.mode must be NONE, HORIZONTAL or VERTICAL`);
  }
  for (const k of ["gap", "grow", "counterAxisSpacing"]) {
    if (v[k] !== undefined) out[k] = validateNumber(v[k], `${path}.${k}`, { min: 0 });
  }
  for (const k of ["minWidth", "maxWidth", "minHeight", "maxHeight"]) {
    if (v[k] !== undefined) out[k] = validateNumber(v[k], `${path}.${k}`, { min: 0 });
  }
  if (v.padding !== undefined) {
    if (typeof v.padding === "number") {
      if (v.padding < 0) throw new Error(`${path}.padding must be >= 0`);
    } else if (Array.isArray(v.padding)) {
      if (![1, 2, 4].includes(v.padding.length)) throw new Error(`${path}.padding must have 1, 2 or 4 values`);
      if (v.padding.some((n: any) => !Number.isFinite(Number(n)) || Number(n) < 0)) {
        throw new Error(`${path}.padding values must be non-negative numbers`);
      }
    } else if (isObj(v.padding)) {
      for (const side of ["top", "right", "bottom", "left"]) {
        if (v.padding[side] !== undefined) validateNumber(v.padding[side], `${path}.padding.${side}`, { min: 0 });
      }
    } else {
      throw new Error(`${path}.padding must be a number, array or object`);
    }
  }
  if (v.sizing !== undefined) {
    if (!isObj(v.sizing)) throw new Error(`${path}.sizing must be an object`);
    for (const axis of ["horizontal", "vertical", "primaryAxis", "counterAxis"]) {
      const s = v.sizing[axis];
      if (s !== undefined && !["FIXED", "HUG", "FILL", "AUTO"].includes(String(s))) {
        throw new Error(`${path}.sizing.${axis} must be FIXED, HUG, FILL or AUTO`);
      }
    }
  }
  return out;
}

function validateNode(
  raw: any,
  path: string,
  depth: number,
  state: { nodes: number; maxDepth: number; keys: Set<string>; warnings: string[] },
  parentKey: string,
  index: number,
): NormalizedNode {
  if (!isObj(raw)) throw new Error(`${path} must be an object`);
  state.nodes++;
  state.maxDepth = Math.max(state.maxDepth, depth);
  if (state.nodes > MAX_NODES) throw new Error(`spec has more than ${MAX_NODES} nodes; split the screen`);
  if (depth > MAX_DEPTH) throw new Error(`spec is deeper than ${MAX_DEPTH} levels at ${path}`);

  let type = String(raw.type || "").toUpperCase();
  if (type === "RECT") type = "RECTANGLE";
  if (!ALLOWED_TYPES.has(type)) {
    throw new Error(
      `${path}.type "${raw.type}" is not supported. Supported: ${[...ALLOWED_TYPES].join(", ")}. ` +
        `A GROUP is not a container here — use FRAME with fills: [] when you mean one.`,
    );
  }

  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : defaultName(type, index);
  const explicitKey = raw.key !== undefined ? String(raw.key).trim() : "";
  if (explicitKey && (explicitKey.length > 160 || /\s/.test(explicitKey))) {
    throw new Error(`${path}.key must be 1..160 characters with no whitespace`);
  }
  const key = explicitKey || deriveKey(parentKey, type, name, index);
  if (state.keys.has(key)) throw new Error(`duplicate key "${key}" in the spec (${path})`);
  state.keys.add(key);

  const out: NormalizedNode = { key, type, name, spec: { ...raw }, children: [] };

  if (raw.visible !== undefined && typeof raw.visible !== "boolean") throw new Error(`${path}.visible must be boolean`);
  if (raw.opacity !== undefined) validateNumber(raw.opacity, `${path}.opacity`, { min: 0, max: 1 });
  if (raw.size !== undefined) out.spec.size = validateSize(raw.size, `${path}.size`);
  if (raw.length !== undefined) {
    if (type !== "LINE") throw new Error(`${path}.length is only valid on LINE; use size for other nodes`);
    if (raw.size !== undefined) throw new Error(`${path}: LINE takes length or size, not both`);
    out.spec.length = validateNumber(raw.length, `${path}.length`, { positive: true });
  }
  if (raw.position !== undefined) out.spec.position = validatePoint(raw.position, `${path}.position`);
  if (raw.layout !== undefined) out.spec.layout = validateLayout(raw.layout, `${path}.layout`);
  if (raw.layoutGrids !== undefined) out.spec.layoutGrids = layoutGridsFromSpec(raw.layoutGrids, `${path}.layoutGrids`);
  if (raw.rotation !== undefined) validateNumber(raw.rotation, `${path}.rotation`);
  if (raw.cornerRadius !== undefined) validateNumber(raw.cornerRadius, `${path}.cornerRadius`, { min: 0 });
  for (const corner of ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"]) {
    if (raw[corner] !== undefined) validateNumber(raw[corner], `${path}.${corner}`, { min: 0 });
  }
  if (raw.strokeWeight !== undefined) validateNumber(raw.strokeWeight, `${path}.strokeWeight`, { min: 0 });
  if (raw.strokeCap !== undefined && !STROKE_CAPS.has(String(raw.strokeCap))) {
    throw new Error(`${path}.strokeCap must be ${[...STROKE_CAPS].join(", ")}`);
  }
  if (raw.strokeJoin !== undefined && !STROKE_JOINS.has(String(raw.strokeJoin))) {
    throw new Error(`${path}.strokeJoin must be ${[...STROKE_JOINS].join(", ")}`);
  }
  if (raw.strokeMiterLimit !== undefined) validateNumber(raw.strokeMiterLimit, `${path}.strokeMiterLimit`, { min: 0 });
  for (const flag of ["isMask", "itemReverseZIndex", "strokesIncludedInLayout"]) {
    if (raw[flag] !== undefined && typeof raw[flag] !== "boolean") throw new Error(`${path}.${flag} must be boolean`);
  }
  if (raw.fontSize !== undefined) validateNumber(raw.fontSize, `${path}.fontSize`, { positive: true });
  if (raw.textCase !== undefined && !TEXT_CASES.has(String(raw.textCase))) {
    throw new Error(`${path}.textCase must be ${[...TEXT_CASES].join(", ")}`);
  }
  if (raw.textDecoration !== undefined && !TEXT_DECORATIONS.has(String(raw.textDecoration))) {
    throw new Error(`${path}.textDecoration must be ${[...TEXT_DECORATIONS].join(", ")}`);
  }
  for (const k of ["paragraphSpacing", "paragraphIndent"]) {
    if (raw[k] !== undefined) validateNumber(raw[k], `${path}.${k}`, { min: 0 });
  }
  if (raw.font !== undefined && !fontSpec(raw.font)) throw new Error(`${path}.font must be "Family/Style" or {family,style}`);
  if (raw.hyperlink !== undefined) {
    if (type !== "TEXT") throw new Error(`${path}.hyperlink is only valid on TEXT`);
    out.spec.hyperlink = hyperlinkFromSpec(raw.hyperlink, `${path}.hyperlink`);
  }
  if (raw.runs !== undefined) {
    if (type !== "TEXT") throw new Error(`${path}.runs is only valid on TEXT`);
    if (raw.text === undefined) throw new Error(`${path}.runs needs text, so character offsets can be validated`);
  }
  if (raw.textVariable !== undefined) {
    if (type !== "TEXT") throw new Error(`${path}.textVariable is only valid on TEXT`);
    out.spec.textVariable = textVariableFromSpec(raw.textVariable, `${path}.textVariable`);
  }

  if (type === "TEXT") {
    if (raw.text !== undefined && typeof raw.text !== "string") throw new Error(`${path}.text must be a string`);
    if (raw.text === undefined) out.spec.text = "";
    if (raw.runs !== undefined) out.spec.runs = textRunsFromSpec(raw.runs, `${path}.runs`, String(out.spec.text));
    if (raw.children !== undefined) throw new Error(`${path}: TEXT cannot have children`);
  }
  if (LEAF_TYPES.has(type) && type !== "TEXT" && raw.children !== undefined) {
    throw new Error(`${path}: ${type} cannot have children`);
  }
  if (type === "INSTANCE") {
    if (raw.children !== undefined) throw new Error(`${path}: INSTANCE cannot have children — use overrides for its interior`);
    if (!raw.componentId && !raw.componentKey && !raw.componentName && !raw.componentSetKey) {
      throw new Error(`${path}: INSTANCE needs componentId, componentKey, componentName or componentSetKey`);
    }
  }
  if (type === "SVG") {
    if (typeof raw.svg !== "string" || !raw.svg.trim()) throw new Error(`${path}: SVG needs a non-empty svg string`);
  }
  if (type !== "SVG" && raw.svg !== undefined) throw new Error(`${path}: svg is only valid on type SVG`);

  if (raw.fills !== undefined && raw.fillStyle !== undefined) {
    throw new Error(`${path}: fills and fillStyle are exclusive; a style and a literal paint cannot both win`);
  }
  if (raw.strokes !== undefined && raw.strokeStyle !== undefined) {
    throw new Error(`${path}: strokes and strokeStyle are exclusive`);
  }

  if (raw.children !== undefined) {
    if (!Array.isArray(raw.children)) throw new Error(`${path}.children must be an array`);
    if (!CONTAINER_TYPES.has(type)) {
      throw new Error(`${path}: ${type} cannot have children (only FRAME and COMPONENT can)`);
    }
    raw.children.forEach((child: any, i: number) => {
      out.children.push(validateNode(child, `${path}.children[${i}]`, depth + 1, state, key, i));
    });
  }

  return out;
}

/**
 * Validate and normalize a build spec. Keys are derived deterministically from
 * the path when the caller does not supply one, so re-sending the same spec
 * produces the same keys and therefore updates instead of duplicating.
 */
export function normalizeTree(raw: any, opts: { buildId?: string; rootKey?: string } = {}): NormalizeResult {
  if (!isObj(raw)) throw new Error("root must be an object");
  const buildId = opts.buildId ? String(opts.buildId) : "";
  const state = { nodes: 0, maxDepth: 0, keys: new Set<string>(), warnings: [] as string[] };
  // The root key is the build scope. If the caller gave a buildId but no root
  // key, using the buildId is what makes a second build hit the same root
  // instead of deriving a key from the (possibly changed) display name.
  const rootRaw = { ...raw };
  const rootSeed = opts.rootKey || buildId;
  if (!rootRaw.key && rootSeed) rootRaw.key = rootSeed;
  const root = validateNode(rootRaw, "root", 0, state, "", 0);
  if (!raw.key && !rootSeed) {
    state.warnings.push(`no buildId or root.key given; derived build scope "${root.key}"`);
  }
  return { root, nodes: state.nodes, maxDepth: state.maxDepth, keys: [...state.keys], warnings: state.warnings };
}

// ---------------------------------------------------------------- resource resolution

interface Resources {
  fonts: Map<string, { family: string; style: string }>;
  textStyles: Map<string, any>;
  paintStyles: Map<string, any>;
  effectStyles: Map<string, any>;
  variables: Map<string, any>;
  variableKinds: Map<string, string>;
  components: Map<string, any>;
  styleNames: { text: string[]; paint: string[]; effect: string[] };
  variableNames: string[];
  componentRefs: Json[];
  warnings: string[];
  blocking: string[];
}

function resourceMap(): Resources {
  return {
    fonts: new Map(),
    textStyles: new Map(),
    paintStyles: new Map(),
    effectStyles: new Map(),
    variables: new Map(),
    variableKinds: new Map(),
    components: new Map(),
    styleNames: { text: [], paint: [], effect: [] },
    variableNames: [],
    componentRefs: [],
    warnings: [],
    blocking: [],
  };
}

function styleListName(kind: "text" | "paint" | "effect"): string {
  return kind === "text" ? "text style" : kind === "paint" ? "paint style" : "effect style";
}

function findStyle(list: any[], ref: string, kind: "text" | "paint" | "effect" = "text"): any | null {
  const hits = list.filter((s) => s.id === ref || s.key === ref || s.name === ref);
  if (hits.length > 1) {
    throw new Error(
      `style "${ref}" matches ${hits.length} ${styleListName(kind)}s: ` +
        hits.map((s) => `${s.name} (${s.id})`).join(", ") +
        " — pass the id",
    );
  }
  return hits[0] || null;
}

async function loadStyleList(ctx: any, kind: "text" | "paint" | "effect"): Promise<any[]> {
  try {
    if (kind === "text") return await ctx.getLocalTextStylesAsync();
    if (kind === "paint") return await ctx.getLocalPaintStylesAsync();
    return await ctx.getLocalEffectStylesAsync();
  } catch {
    // A test stub or an older host may not implement the async getter. Falling
    // back to an empty list turns every style reference into a blocker, which
    // is the truthful outcome: we cannot prove the style exists.
    return [];
  }
}

function addFont(res: Resources, f: any, where: string) {
  const parsed = fontSpec(f);
  if (!parsed) {
    res.blocking.push(`${where}: cannot parse font ${JSON.stringify(f)}`);
    return;
  }
  res.fonts.set(fontKey(parsed), parsed);
}

function collectVariableRef(res: Resources, ref: any, where: string, kind = "COLOR") {
  if (ref === undefined || ref === null) return;
  if (typeof ref !== "string" || !ref.trim()) {
    res.blocking.push(`${where}: variable reference must be a non-empty string`);
    return;
  }
  const previous = res.variableKinds.get(ref);
  if (previous && previous !== kind) {
    res.blocking.push(`${where}: variable "${ref}" is already used as ${previous}, not ${kind}`);
    return;
  }
  res.variableKinds.set(ref, kind);
  if (!res.variableNames.includes(ref)) res.variableNames.push(ref);
}

function collectPaints(res: Resources, paints: any, where: string) {
  if (paints === undefined || paints === null) return;
  const list = Array.isArray(paints) ? paints : [paints];
  list.forEach((p: any, i: number) => {
    if (typeof p === "string") return;
    if (!isObj(p)) {
      res.blocking.push(`${where}[${i}]: paint must be a colour string or object`);
      return;
    }
    if (p.variable !== undefined) collectVariableRef(res, p.variable, `${where}[${i}]`);
    if (p.color !== undefined) {
      try { parseColor(p.color); } catch (e) { res.blocking.push(`${where}[${i}]: ${errMsg(e)}`); }
    }
    if (p.type && !["SOLID", "IMAGE", "GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND"].includes(String(p.type))) {
      res.blocking.push(`${where}[${i}]: unsupported paint type "${p.type}"`);
    }
    if (p.type === "IMAGE" && !p.imageHash) res.blocking.push(`${where}[${i}]: IMAGE paint needs imageHash`);
  });
}

async function resolveVariables(ctx: any, res: Resources) {
  if (!res.variableNames.length) return;
  let variables: any[] = [];
  try {
    variables = await ctx.variables.getLocalVariablesAsync();
  } catch (e) {
    res.blocking.push(`cannot read local variables: ${errMsg(e)}`);
    return;
  }
  for (const ref of res.variableNames) {
    const hits = variables.filter((v: any) => v.id === ref || v.key === ref || v.name === ref);
    if (!hits.length) {
      res.blocking.push(
        `variable "${ref}" not found among local variables. Library variables must be imported into the file (or passed by id) first.`,
      );
      continue;
    }
    if (hits.length > 1) {
      res.blocking.push(`variable "${ref}" is ambiguous: ${hits.map((v: any) => `${v.name} (${v.id})`).join(", ")}`);
      continue;
    }
    const v = hits[0];
    const kind = res.variableKinds.get(ref) || "COLOR";
    if (v.resolvedType && v.resolvedType !== kind) {
      const use = kind === "COLOR" ? "a paint" : `the text field (${kind})`;
      res.blocking.push(`variable "${ref}" is ${v.resolvedType}, but ${use} needs ${kind}`);
      continue;
    }
    res.variables.set(ref, v);
  }
}

async function collectResources(ctx: any, root: NormalizedNode): Promise<Resources> {
  const res = resourceMap();
  const textStyles = await loadStyleList(ctx, "text");
  const paintStyles = await loadStyleList(ctx, "paint");
  const effectStyles = await loadStyleList(ctx, "effect");

  const visit = (n: NormalizedNode) => {
    const s = n.spec;
    if (n.type === "TEXT") {
      if (s.textStyle !== undefined) {
        const st = findStyle(textStyles, String(s.textStyle));
        if (!st) res.blocking.push(`${n.key}: text style "${s.textStyle}" not found`);
        else {
          res.textStyles.set(String(s.textStyle), st);
          addFont(res, st.fontName, `${n.key} text style "${st.name}"`);
          if (!res.styleNames.text.includes(st.name)) res.styleNames.text.push(st.name);
        }
      } else if (s.font !== undefined) {
        addFont(res, s.font, n.key);
      } else {
        addFont(res, DEFAULT_FONT, n.key);
        res.warnings.push(`${n.key}: no font or textStyle; defaulting to Inter/Regular`);
      }
      if (isObj(s.textVariable)) {
        for (const [field, ref] of Object.entries(s.textVariable)) {
          collectVariableRef(res, ref, `${n.key}.textVariable.${field}`, TEXT_VARIABLE_TYPES[field]);
        }
      }
      if (Array.isArray(s.runs)) {
        s.runs.forEach((run: Json, i: number) => {
          if (run.font !== undefined) addFont(res, run.font, `${n.key}.runs[${i}]`);
          if (run.textStyle !== undefined && run.textStyle !== null) {
            const ref = String(run.textStyle);
            const st = findStyle(textStyles, ref);
            if (!st) res.blocking.push(`${n.key}.runs[${i}]: text style "${ref}" not found`);
            else {
              res.textStyles.set(ref, st);
              addFont(res, st.fontName, `${n.key}.runs[${i}] text style "${st.name}"`);
              if (!res.styleNames.text.includes(st.name)) res.styleNames.text.push(st.name);
            }
          }
          if (run.fillStyle !== undefined && run.fillStyle !== null) {
            const ref = String(run.fillStyle);
            const st = findStyle(paintStyles, ref, "paint");
            if (!st) res.blocking.push(`${n.key}.runs[${i}]: paint style "${ref}" not found`);
            else {
              res.paintStyles.set(ref, st);
              if (!res.styleNames.paint.includes(st.name)) res.styleNames.paint.push(st.name);
            }
          }
          if (isObj(run.variable)) {
            for (const [field, ref] of Object.entries(run.variable)) {
              collectVariableRef(res, ref, `${n.key}.runs[${i}].variable.${field}`, TEXT_VARIABLE_TYPES[field]);
            }
          }
          collectPaints(res, run.fills, `${n.key}.runs[${i}].fills`);
        });
      }
    }
    if (s.fillStyle !== undefined) {
      const st = findStyle(paintStyles, String(s.fillStyle), "paint");
      if (!st) res.blocking.push(`${n.key}: paint style "${s.fillStyle}" not found`);
      else {
        res.paintStyles.set(String(s.fillStyle), st);
        if (!res.styleNames.paint.includes(st.name)) res.styleNames.paint.push(st.name);
      }
    }
    if (s.strokeStyle !== undefined) {
      const st = findStyle(paintStyles, String(s.strokeStyle), "paint");
      if (!st) res.blocking.push(`${n.key}: paint style "${s.strokeStyle}" not found`);
      else {
        res.paintStyles.set(String(s.strokeStyle), st);
        if (!res.styleNames.paint.includes(st.name)) res.styleNames.paint.push(st.name);
      }
    }
    if (s.effectStyle !== undefined) {
      const st = findStyle(effectStyles, String(s.effectStyle), "effect");
      if (!st) res.blocking.push(`${n.key}: effect style "${s.effectStyle}" not found`);
      else {
        res.effectStyles.set(String(s.effectStyle), st);
        if (!res.styleNames.effect.includes(st.name)) res.styleNames.effect.push(st.name);
      }
    }
    collectPaints(res, s.fills, `${n.key}.fills`);
    collectPaints(res, s.strokes, `${n.key}.strokes`);
    if (n.type === "INSTANCE" && s.overrides && isObj(s.overrides)) {
      for (const name of Object.keys(s.overrides)) {
        const o = s.overrides[name];
        if (isObj(o) && o.text !== undefined) {
          res.warnings.push(`${n.key}: override "${name}" sets text; its font is loaded when the instance exists`);
        }
      }
    }
    if (s.componentId || s.componentKey || s.componentName || s.componentSetKey) {
      res.componentRefs.push({
        key: n.key,
        componentId: s.componentId,
        componentKey: s.componentKey,
        componentName: s.componentName,
        componentSetKey: s.componentSetKey,
        properties: s.properties,
      });
    }
    for (const c of n.children) visit(c);
  };
  visit(root);
  await resolveVariables(ctx, res);
  return res;
}

async function resolveComponent(ctx: any, ref: Json, apply: boolean, res: Resources): Promise<any | null> {
  try {
    if (ref.componentId) {
      const n = await ctx.getNodeByIdAsync(String(ref.componentId));
      if (!n || n.type !== "COMPONENT") {
        res.blocking.push(`${ref.key}: componentId ${ref.componentId} is not a COMPONENT`);
        return null;
      }
      return n;
    }
    if (ref.componentSetKey) {
      let set: any = null;
      if (apply) {
        try {
          set = await ctx.importComponentSetByKeyAsync(String(ref.componentSetKey));
        } catch (e) {
          res.blocking.push(`${ref.key}: cannot import component set ${ref.componentSetKey}: ${errMsg(e)}`);
          return null;
        }
      } else {
        set = await findComponentSetByKey(ctx, String(ref.componentSetKey));
        if (!set) {
          res.warnings.push(`${ref.key}: component set ${ref.componentSetKey} is a library import; dry run cannot prove it exists`);
          return null;
        }
      }
      if (ref.properties && isObj(ref.properties)) {
        const variants = (set.children || []).filter((c: any) => c.type === "COMPONENT");
        const match = variants.find((c: any) => {
          const vp = c.variantProperties || {};
          return Object.keys(ref.properties).every((k) => String(vp[k]) === String(ref.properties[k]));
        });
        if (!match) {
          res.blocking.push(
            `${ref.key}: no variant of ${ref.componentSetKey} matches ${JSON.stringify(ref.properties)}; ` +
              `available: ${variants.map((c: any) => JSON.stringify(c.variantProperties || {})).join(", ")}`,
          );
          return null;
        }
        return match;
      }
      return set.defaultVariant || (set.children || []).find((c: any) => c.type === "COMPONENT") || null;
    }
    if (ref.componentKey) {
      // A dry run MUST NOT import: importComponentByKeyAsync materialises a
      // library component in the file, which is a write. Scan local components
      // instead and say plainly that a library key is unproven until apply.
      const local = await findComponentByKey(ctx, String(ref.componentKey));
      if (local) return local;
      if (!apply) {
        res.warnings.push(`${ref.key}: component ${ref.componentKey} is a library import; dry run cannot prove it exists`);
        return null;
      }
      try {
        return await ctx.importComponentByKeyAsync(String(ref.componentKey));
      } catch (e) {
        res.blocking.push(`${ref.key}: cannot import component ${ref.componentKey}: ${errMsg(e)}`);
        return null;
      }
    }
    if (ref.componentName) {
      const comps = await findComponentsByName(ctx, String(ref.componentName));
      if (!comps.length) {
        res.blocking.push(`${ref.key}: no component named "${ref.componentName}"`);
        return null;
      }
      if (comps.length > 1) {
        res.blocking.push(
          `${ref.key}: component name "${ref.componentName}" is ambiguous (${comps.length}); ` +
            `use componentKey: ${comps.map((c: any) => c.key).join(", ")}`,
        );
        return null;
      }
      return comps[0];
    }
  } catch (e) {
    res.blocking.push(`${ref.key}: component resolution failed: ${errMsg(e)}`);
  }
  return null;
}

async function findComponentByKey(ctx: any, key: string): Promise<any | null> {
  const pages = await allPages(ctx);
  for (const page of pages) {
    try {
      const hit = page.findOne((n: any) => n.type === "COMPONENT" && n.key === key);
      if (hit) return hit;
    } catch {
      /* an unloaded page is simply not searchable */
    }
  }
  return null;
}

async function findComponentSetByKey(ctx: any, key: string): Promise<any | null> {
  const pages = await allPages(ctx);
  for (const page of pages) {
    try {
      const hit = page.findOne((n: any) => n.type === "COMPONENT_SET" && n.key === key);
      if (hit) return hit;
    } catch {
      /* an unloaded page is simply not searchable */
    }
  }
  return null;
}

async function findComponentsByName(ctx: any, name: string): Promise<any[]> {
  const pages = await allPages(ctx);
  const out: any[] = [];
  for (const page of pages) {
    try {
      const hits = page.findAll((n: any) => n.type === "COMPONENT" && n.name === name);
      out.push(...hits);
    } catch {
      /* ignore unloaded pages */
    }
  }
  return out;
}

async function allPages(ctx: any): Promise<any[]> {
  try {
    if (typeof ctx.loadAllPagesAsync === "function") await ctx.loadAllPagesAsync();
  } catch {
    /* dynamic-page documents may refuse; current page still works */
  }
  try {
    return [...ctx.root.children];
  } catch {
    return [ctx.currentPage];
  }
}

async function resolveComponents(ctx: any, res: Resources, apply: boolean): Promise<void> {
  for (const ref of res.componentRefs) {
    const c = await resolveComponent(ctx, ref, apply, res);
    if (c) res.components.set(ref.key, c);
  }
}

// ---------------------------------------------------------------- existing tree

function collectKeyMap(root: any): Map<string, any[]> {
  const map = new Map<string, any[]>();
  const visit = (n: any) => {
    let key = "";
    try { key = n.getPluginData(KEY_DATA) || ""; } catch { key = ""; }
    if (key) {
      const list = map.get(key) || [];
      list.push(n);
      map.set(key, list);
    }
    const kids = n.children;
    if (kids) for (const c of kids) visit(c);
  };
  visit(root);
  return map;
}

function collectProtected(root: any): Set<string> {
  const out = new Set<string>();
  const visit = (n: any) => {
    try { if (n.getPluginData(PROTECTED_DATA) === "1") out.add(n.id); } catch { /* no pluginData */ }
    if (n.children) for (const c of n.children) visit(c);
  };
  visit(root);
  return out;
}

function directRootsByBuildId(ctx: any, buildId: string, parent: any): any[] {
  const out: any[] = [];
  const kids = parent && parent.children ? parent.children : [];
  for (const c of kids) {
    try {
      if (c.getPluginData(BUILD_DATA) === buildId) out.push(c);
    } catch {
      /* node cannot carry pluginData */
    }
  }
  return out;
}

function rootsByBuildIdAnywhere(ctx: any, buildId: string): any[] {
  const out: any[] = [];
  const visit = (n: any) => {
    try { if (n.getPluginData(BUILD_DATA) === buildId) out.push(n); } catch { /* ignore */ }
    for (const c of n.children || []) visit(c);
  };
  for (const page of ctx.root.children || []) visit(page);
  return out;
}

function findRootByKey(ctx: any, key: string): any[] {
  const out: any[] = [];
  const visit = (n: any) => {
    try { if (n.getPluginData(KEY_DATA) === key) out.push(n); } catch { /* ignore */ }
    for (const c of n.children || []) visit(c);
  };
  for (const page of ctx.root.children || []) visit(page);
  return out;
}

function scopeFingerprint(node: any): string {
  if (!node) return "none";
  if (node.type === "PAGE" || node.type === "DOCUMENT") {
    const parts: string[] = [];
    for (const c of node.children || []) {
      try { parts.push(snapshot(c, STRICT).hash); } catch { parts.push(`${c.id}:${c.type}:${c.name}`); }
    }
    return hashString(parts.join("|"));
  }
  try {
    return snapshot(node, STRICT).hash;
  } catch (e) {
    return hashString(`uninspectable:${node.id}:${node.type}:${node.name}:${errMsg(e)}`);
  }
}

function nodeLabel(n: any): string {
  return `${n.type} "${n.name}" (${n.id})`;
}

// ---------------------------------------------------------------- plan

export interface Plan {
  schema: string;
  status: "planned" | "blocked";
  dryRun: boolean;
  mode: string;
  buildId: string;
  root: { key: string; type: string; name: string; nodeId: string | null; action: "create" | "update" };
  parent: { id: string; name: string; type: string };
  counts: { nodes: number; create: number; update: number; unchanged: number; delete: number };
  planned: { create: string[]; update: string[]; delete: string[]; unchanged: string[] };
  keys: Record<string, string>;
  fingerprint: string;
  fonts: string[];
  styles: { text: string[]; paint: string[]; effect: string[] };
  variables: string[];
  components: Json[];
  warnings: string[];
  blocking: string[];
  prune: boolean;
}

function emptyPlan(): Plan {
  return {
    schema: BUILD_SCHEMA,
    status: "planned",
    dryRun: true,
    mode: "upsert",
    buildId: "",
    root: { key: "", type: "", name: "", nodeId: null, action: "create" },
    parent: { id: "", name: "", type: "" },
    counts: { nodes: 0, create: 0, update: 0, unchanged: 0, delete: 0 },
    planned: { create: [], update: [], delete: [], unchanged: [] },
    keys: {},
    fingerprint: "",
    fonts: [],
    styles: { text: [], paint: [], effect: [] },
    variables: [],
    components: [],
    warnings: [],
    blocking: [],
    prune: false,
  };
}

function addUnique(list: string[], v: string) {
  if (!list.includes(v)) list.push(v);
}

async function planBuild(ctx: any, p: Json): Promise<Plan> {
  const plan = emptyPlan();
  plan.dryRun = p.dryRun !== false;
  plan.mode = String(p.mode || "upsert");
  if (!["upsert", "create"].includes(plan.mode)) throw new Error('mode must be "upsert" or "create"');
  plan.prune = p.prune === true;

  const buildId = p.buildId !== undefined ? String(p.buildId).trim() : "";
  if (buildId.length > 160 || /\s/.test(buildId)) throw new Error("buildId must be 1..160 characters with no whitespace");
  const normalized = normalizeTree(p.root, { buildId, rootKey: p.rootKey });
  plan.root.key = normalized.root.key;
  plan.root.type = normalized.root.type;
  plan.root.name = normalized.root.name;
  plan.buildId = buildId || normalized.root.key;
  plan.counts.nodes = normalized.nodes;
  plan.warnings.push(...normalized.warnings);

  let parent: any = ctx.currentPage;
  if (p.parentId) {
    parent = await ctx.getNodeByIdAsync(String(p.parentId));
    if (!parent) throw new Error("parent node not found: " + p.parentId);
    if (parent.removed === true) throw new Error(`parent ${p.parentId} has been removed`);
  }
  if (!parent || !("appendChild" in parent)) throw new Error(`parent ${parent ? parent.type : "(none)"} cannot accept children`);
  if (parent.type === "INSTANCE") throw new Error("an INSTANCE cannot accept children; build inside its main component or a frame");
  plan.parent = { id: parent.id, name: parent.name, type: parent.type };

  const direct = directRootsByBuildId(ctx, plan.buildId, parent);
  const anywhere = rootsByBuildIdAnywhere(ctx, plan.buildId);
  let existingRoot: any = null;
  if (direct.length > 1) {
    plan.blocking.push(`buildId "${plan.buildId}" is already on ${direct.length} roots: ${direct.map(nodeLabel).join(", ")}`);
  } else if (direct.length === 1) {
    existingRoot = direct[0];
  } else if (anywhere.length) {
    plan.blocking.push(
      `buildId "${plan.buildId}" already exists outside the requested parent: ${anywhere.map(nodeLabel).join(", ")}. ` +
        `Pass that parent, or use a different buildId.`,
    );
  }
  if (existingRoot && plan.mode === "create") {
    plan.blocking.push(`mode is "create" but buildId "${plan.buildId}" already exists: ${nodeLabel(existingRoot)}`);
  }
  if (existingRoot) {
    if (existingRoot.type !== normalized.root.type) {
      plan.blocking.push(
        `${plan.root.key}: existing node is ${existingRoot.type}, spec says ${normalized.root.type}; ` +
          `changing a node's type would destroy its id and overrides, so it is refused`,
      );
    }
    plan.root.nodeId = existingRoot.id;
    plan.root.action = "update";
    plan.planned.update.push(normalized.root.key);
    plan.keys[normalized.root.key] = existingRoot.id;
  } else {
    plan.root.action = "create";
    plan.planned.create.push(normalized.root.key);
  }

  const keyMap = existingRoot ? collectKeyMap(existingRoot) : new Map<string, any[]>();
  const walk = (n: NormalizedNode, parentNode: any) => {
    const hits = keyMap.get(n.key) || [];
    if (hits.length > 1) {
      plan.blocking.push(`key "${n.key}" appears ${hits.length} times under the root: ${hits.map(nodeLabel).join(", ")}`);
      return;
    }
    if (hits.length === 1) {
      const hit = hits[0];
      if (hit.type !== n.type) {
        plan.blocking.push(`${n.key}: existing node is ${hit.type}, spec says ${n.type}; type changes are refused`);
      }
      if (parentNode && hit.parent && hit.parent.id !== parentNode.id) {
        plan.blocking.push(
          `${n.key}: key lives under ${nodeLabel(hit.parent)}, but the spec puts it under ${nodeLabel(parentNode)}. ` +
            `Moving a keyed node between parents is not implicit.`,
        );
      }
      plan.planned.update.push(n.key);
      plan.keys[n.key] = hit.id;
    } else {
      plan.planned.create.push(n.key);
    }
    for (const c of n.children) walk(c, hits.length === 1 ? hits[0] : null);
  };
  for (const c of normalized.root.children) walk(c, existingRoot);

  if (plan.prune && existingRoot) {
    const expected = new Set(normalized.keys);
    const protectedIds = collectProtected(existingRoot);
    for (const [key, nodes] of keyMap) {
      if (expected.has(key)) continue;
      for (const n of nodes) {
        if (protectedIds.has(n.id)) {
          plan.warnings.push(`prune skipped protected node ${nodeLabel(n)}`);
          continue;
        }
        plan.planned.delete.push(key);
        plan.counts.delete++;
      }
    }
  }

  const res = await collectResources(ctx, normalized.root);
  // Planning is always read-only. Library imports happen inside the apply
  // transaction, so a failure later can roll them back with everything else.
  await resolveComponents(ctx, res, false);
  plan.warnings.push(...res.warnings);
  plan.blocking.push(...res.blocking);
  plan.fonts = [...res.fonts.values()].map(fontKey).sort();
  plan.styles = {
    text: res.styleNames.text.sort(),
    paint: res.styleNames.paint.sort(),
    effect: res.styleNames.effect.sort(),
  };
  plan.variables = res.variableNames.slice().sort();
  plan.components = res.componentRefs.map((r) => ({
    key: r.key,
    componentId: r.componentId ?? null,
    componentKey: r.componentKey ?? null,
    componentName: r.componentName ?? null,
    componentSetKey: r.componentSetKey ?? null,
    resolved: res.components.has(r.key),
  }));

  plan.counts.create = plan.planned.create.length;
  plan.counts.update = plan.planned.update.length;
  plan.counts.unchanged = plan.planned.unchanged.length;
  plan.fingerprint = scopeFingerprint(existingRoot || parent);
  plan.status = plan.blocking.length ? "blocked" : "planned";
  // Stash the normalized tree and resolved resources for apply without putting
  // them in the JSON report (functions and Figma nodes do not serialise).
  (plan as any)._tree = normalized.root;
  (plan as any)._res = res;
  (plan as any)._parent = parent;
  (plan as any)._existingRoot = existingRoot;
  (plan as any)._keyMap = keyMap;
  return plan;
}

async function resolvePatchRoot(ctx: any, p: Json): Promise<{ root: any; parent: any }> {
  let root: any = null;
  if (p.rootNodeId) {
    root = await ctx.getNodeByIdAsync(String(p.rootNodeId));
    if (!root) throw new Error("root node not found: " + p.rootNodeId);
  } else if (p.buildId) {
    const hits = rootsByBuildIdAnywhere(ctx, String(p.buildId));
    if (hits.length > 1) throw new Error(`buildId "${p.buildId}" is ambiguous: ${hits.map(nodeLabel).join(", ")}`);
    root = hits[0] || null;
    if (!root) throw new Error(`no root with buildId "${p.buildId}"`);
  } else if (p.rootKey) {
    const hits = findRootByKey(ctx, String(p.rootKey));
    if (hits.length > 1) throw new Error(`root key "${p.rootKey}" is ambiguous: ${hits.map(nodeLabel).join(", ")}`);
    root = hits[0] || null;
    if (!root) throw new Error(`no root with key "${p.rootKey}"`);
  } else {
    throw new Error("patch needs rootNodeId, buildId or rootKey");
  }
  if (root.removed === true) throw new Error(`root ${root.id} has been removed`);
  if (!root.getPluginData(BUILD_DATA) && !root.getPluginData(KEY_DATA)) {
    throw new Error(
      `patch refuses ${nodeLabel(root)}: it carries neither a buildId nor a key, so it is not a tree this engine owns. ` +
        `Build it with figma_build first (or pass a node inside a built tree).`,
    );
  }
  if (p.buildId && root.getPluginData(BUILD_DATA) && root.getPluginData(BUILD_DATA) !== String(p.buildId)) {
    throw new Error(`root ${root.id} has buildId "${root.getPluginData(BUILD_DATA)}", not "${p.buildId}"`);
  }
  const parent = root.parent;
  if (!parent) throw new Error("root has no parent");
  return { root, parent };
}

async function planPatch(ctx: any, p: Json): Promise<Plan> {
  const plan = emptyPlan();
  plan.dryRun = p.dryRun !== false;
  plan.mode = "patch";
  plan.prune = p.prune === true;
  const { root, parent } = await resolvePatchRoot(ctx, p);
  plan.parent = { id: parent.id, name: parent.name, type: parent.type };
  const buildId = root.getPluginData(BUILD_DATA) || "";
  plan.buildId = buildId;
  plan.root.nodeId = root.id;
  plan.root.key = root.getPluginData(KEY_DATA) || buildId || "";
  plan.root.type = root.type;
  plan.root.name = root.name;
  plan.root.action = "update";

  if (!p.patch || typeof p.patch !== "object") throw new Error("patch must be an object");
  const normalized = normalizeTree(
    { ...p.patch, type: p.patch.type || root.type, key: p.patch.key || plan.root.key || "root" },
    { buildId, rootKey: plan.root.key },
  );
  if (normalized.root.type !== root.type) {
    throw new Error(`patch root type is ${normalized.root.type}, but ${root.id} is ${root.type}; type changes are refused`);
  }
  if (normalized.root.key !== plan.root.key) {
    plan.blocking.push(`patch root key is "${normalized.root.key}", but the target root key is "${plan.root.key}"`);
  }
  plan.root.key = normalized.root.key || plan.root.key;
  plan.counts.nodes = normalized.nodes;
  plan.warnings.push(...normalized.warnings);
  plan.planned.update.push(plan.root.key);
  plan.keys[plan.root.key] = root.id;

  const keyMap = collectKeyMap(root);
  const protectedIds = collectProtected(root);
  const allowCreate = p.allowCreate === true;
  const walk = (n: NormalizedNode, parentNode: any, parentKey: string) => {
    for (const c of n.children) {
      const hits = keyMap.get(c.key) || [];
      if (hits.length > 1) {
        plan.blocking.push(`key "${c.key}" appears ${hits.length} times under the root: ${hits.map(nodeLabel).join(", ")}`);
        continue;
      }
      let hit = hits[0] || null;
      if (!hit) {
        // A nested patch can introduce a whole new subtree. It is created only
        // under a parent the patch already resolved, so a typo in a key cannot
        // silently attach a node to the page.
        if (!allowCreate) {
          plan.blocking.push(`${c.key}: no node with this key under ${nodeLabel(parentNode)} (pass allowCreate: true to add it)`);
          continue;
        }
        plan.planned.create.push(c.key);
      } else {
        if (hit.type !== c.type) {
          plan.blocking.push(`${c.key}: existing node is ${hit.type}, patch says ${c.type}; type changes are refused`);
        }
        if (hit.parent && hit.parent.id !== parentNode.id) {
          plan.blocking.push(
            `${c.key}: key lives under ${nodeLabel(hit.parent)}, but the patch puts it under ${nodeLabel(parentNode)}. ` +
              `Moving a keyed node between parents is not implicit; use a deliberate move operation.`,
          );
        }
        plan.planned.update.push(c.key);
        plan.keys[c.key] = hit.id;
      }
      walk(c, hit || parentNode, c.key);
      if (plan.prune && hit) {
        const expected = new Set(c.children.map((x) => x.key));
        for (const gc of (hit.children || [])) {
          let k = "";
          try { k = gc.getPluginData(KEY_DATA) || ""; } catch { k = ""; }
          if (!k || expected.has(k)) continue;
          if (protectedIds.has(gc.id)) {
            plan.warnings.push(`prune skipped protected node ${nodeLabel(gc)}`);
            continue;
          }
          plan.planned.delete.push(k);
          plan.counts.delete++;
        }
      }
    }
  };
  walk(normalized.root, root, plan.root.key);

  if (plan.prune) {
    const expected = new Set(normalized.root.children.map((x) => x.key));
    for (const key of keyMap.keys()) {
      if (expected.has(key)) continue;
      for (const n of keyMap.get(key) || []) {
        if (protectedIds.has(n.id)) {
          plan.warnings.push(`prune skipped protected node ${nodeLabel(n)}`);
          continue;
        }
        plan.planned.delete.push(key);
        plan.counts.delete++;
      }
    }
  }

  const res = await collectResources(ctx, normalized.root);
  // Planning is always read-only. Library imports happen inside the apply
  // transaction, so a failure later can roll them back with everything else.
  await resolveComponents(ctx, res, false);
  plan.warnings.push(...res.warnings);
  plan.blocking.push(...res.blocking);
  plan.fonts = [...res.fonts.values()].map(fontKey).sort();
  plan.styles = {
    text: res.styleNames.text.sort(),
    paint: res.styleNames.paint.sort(),
    effect: res.styleNames.effect.sort(),
  };
  plan.variables = res.variableNames.slice().sort();
  plan.components = res.componentRefs.map((r) => ({
    key: r.key,
    componentId: r.componentId ?? null,
    componentKey: r.componentKey ?? null,
    componentName: r.componentName ?? null,
    componentSetKey: r.componentSetKey ?? null,
    resolved: res.components.has(r.key),
  }));
  plan.counts.create = plan.planned.create.length;
  plan.counts.update = plan.planned.update.length;
  plan.counts.unchanged = plan.planned.unchanged.length;
  plan.fingerprint = scopeFingerprint(root);
  plan.status = plan.blocking.length ? "blocked" : "planned";
  (plan as any)._tree = normalized.root;
  (plan as any)._res = res;
  (plan as any)._parent = parent;
  (plan as any)._existingRoot = root;
  (plan as any)._keyMap = keyMap;
  (plan as any)._patch = true;
  return plan;
}

// ---------------------------------------------------------------- paint / effect / layout

function variableFallback(v: any): any {
  const values = v && v.valuesByMode ? Object.values(v.valuesByMode) : [];
  for (const value of values) {
    if (value && typeof value === "object" && "r" in (value as any) && "g" in (value as any) && "b" in (value as any)) {
      const c = value as any;
      return { r: c.r, g: c.g, b: c.b, a: c.a === undefined ? 1 : c.a };
    }
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}

function paintFromSpec(ctx: any, value: any, res: Resources): any {
  if (typeof value === "string") return solidPaint(value);
  if (!isObj(value)) throw new Error("paint must be a colour string or object");
  if (value.style !== undefined) {
    throw new Error("paint styles are set with fillStyle / strokeStyle, not inside fills/strokes");
  }
  if (value.variable !== undefined) {
    // resolveVariables already proved the reference, but the map is keyed by
    // the caller's string and a missing entry means the plan is blocked before
    // we get here. The throw is a last line of defence, not a fallback.
    const v = res.variables.get(String(value.variable));
    if (!v) throw new Error(`variable "${value.variable}" was not resolved`);
    const fallback = value.color ? parseColor(value.color) : variableFallback(v);
    const paint: any = {
      type: "SOLID",
      color: { r: fallback.r, g: fallback.g, b: fallback.b },
      opacity: value.opacity === undefined ? fallback.a : Math.max(0, Math.min(1, Number(value.opacity))),
    };
    try {
      return ctx.variables.setBoundVariableForPaint(paint, "color", v);
    } catch {
      return paint;
    }
  }
  if (value.type === "IMAGE") {
    return {
      type: "IMAGE",
      imageHash: String(value.imageHash),
      scaleMode: value.scaleMode || "FILL",
      ...(value.opacity !== undefined ? { opacity: Number(value.opacity) } : {}),
    };
  }
  if (value.type && String(value.type).startsWith("GRADIENT")) {
    const stops = (value.stops || []).map((s: any) => ({
      position: Math.max(0, Math.min(1, Number(s.at ?? s.position ?? 0))),
      color: parseColor(s.color),
    }));
    if (stops.length < 2) throw new Error(`${value.type} needs at least two stops`);
    return {
      type: value.type,
      gradientStops: stops,
      gradientTransform: value.gradientTransform || [[1, 0, 0], [0, 1, 0]],
      ...(value.opacity !== undefined ? { opacity: Number(value.opacity) } : {}),
    };
  }
  return solidPaint(value.color !== undefined ? value.color : value, value.opacity);
}

function paintsFromSpec(ctx: any, value: any, res: Resources): any[] {
  if (value === null || value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((v) => paintFromSpec(ctx, v, res));
}

function layoutGridsFromSpec(value: any, path = "layoutGrids"): any[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  if (value.length > 32) throw new Error(`${path} has ${value.length} grids; the limit is 32`);
  return value.map((g: any, i: number) => {
    const at = `${path}[${i}]`;
    if (!isObj(g)) throw new Error(`${at} must be an object`);
    const pattern = String(g.pattern || "").toUpperCase();
    if (!GRID_PATTERNS.has(pattern)) throw new Error(`${at}.pattern must be COLUMNS, ROWS or GRID`);
    if (g.visible !== undefined && typeof g.visible !== "boolean") throw new Error(`${at}.visible must be boolean`);
    const alignment = g.alignment === undefined ? "MIN" : String(g.alignment);
    if (!GRID_ALIGNMENTS.has(alignment)) throw new Error(`${at}.alignment must be MIN, MAX, CENTER or STRETCH`);
    const nums: Record<string, number> = {
      gutterSize: g.gutterSize === undefined ? 20 : validateNumber(g.gutterSize, `${at}.gutterSize`, { min: 0 }),
      offset: g.offset === undefined ? 0 : validateNumber(g.offset, `${at}.offset`, { min: 0 }),
      count: g.count === undefined ? 5 : validateNumber(g.count, `${at}.count`, { positive: true }),
      sectionSize: g.sectionSize === undefined ? (pattern === "GRID" ? 8 : 100) : validateNumber(g.sectionSize, `${at}.sectionSize`, { positive: true }),
    };
    if (!Number.isInteger(nums.count)) throw new Error(`${at}.count must be an integer`);
    const color = parseColor(g.color === undefined ? "#ff00001a" : g.color);
    return {
      pattern,
      visible: g.visible !== false,
      color: { r: color.r, g: color.g, b: color.b, a: color.a },
      alignment,
      gutterSize: nums.gutterSize,
      offset: nums.offset,
      count: nums.count,
      sectionSize: nums.sectionSize,
    };
  });
}

function effectsFromSpec(value: any): any[] {
  if (!Array.isArray(value)) throw new Error("effects must be an array");
  return value.map((e: any) => {
    if (!isObj(e)) throw new Error("each effect must be an object");
    const type = String(e.type || "");
    if (!["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR", "BACKGROUND_BLUR"].includes(type)) {
      throw new Error(`unsupported effect type "${type}"`);
    }
    if (type === "LAYER_BLUR" || type === "BACKGROUND_BLUR") {
      const radius = Number(e.radius ?? 4);
      if (!Number.isFinite(radius) || radius < 0) throw new Error("blur radius must be >= 0");
      return { type, radius, visible: e.visible !== false };
    }
    const color = parseColor(e.color ?? "#000000");
    const offset = Array.isArray(e.offset) ? e.offset : [0, 0];
    return {
      type,
      color: { r: color.r, g: color.g, b: color.b, a: color.a },
      offset: { x: Number(offset[0] || 0), y: Number(offset[1] || 0) },
      radius: Number(e.radius ?? 4),
      spread: Number(e.spread ?? 0),
      visible: e.visible !== false,
    };
  });
}

function paddingValues(padding: any): [number, number, number, number] | null {
  if (padding === undefined) return null;
  if (typeof padding === "number") return [padding, padding, padding, padding];
  if (Array.isArray(padding)) {
    if (padding.length === 1) return [Number(padding[0]), Number(padding[0]), Number(padding[0]), Number(padding[0])];
    if (padding.length === 2) return [Number(padding[0]), Number(padding[1]), Number(padding[0]), Number(padding[1])];
    return [Number(padding[0]), Number(padding[1]), Number(padding[2]), Number(padding[3])];
  }
  if (isObj(padding)) {
    return [Number(padding.top ?? 0), Number(padding.right ?? 0), Number(padding.bottom ?? 0), Number(padding.left ?? 0)];
  }
  return null;
}

export function applyContainerLayout(node: any, layout: Json, phase: "before" | "after"): void {
  if (!layout || !("layoutMode" in node)) return;
  if (phase === "before") {
    if (layout.mode !== undefined) node.layoutMode = layout.mode;
    if (layout.gap !== undefined) node.itemSpacing = Number(layout.gap);
    if (layout.counterAxisSpacing !== undefined) node.counterAxisSpacing = Number(layout.counterAxisSpacing);
    if (layout.align !== undefined) node.primaryAxisAlignItems = layout.align;
    if (layout.crossAlign !== undefined) node.counterAxisAlignItems = layout.crossAlign;
    if (layout.wrap !== undefined) node.layoutWrap = layout.wrap;
    if (layout.clipsContent !== undefined) node.clipsContent = !!layout.clipsContent;
    const pad = paddingValues(layout.padding);
    if (pad) {
      node.paddingTop = pad[0];
      node.paddingRight = pad[1];
      node.paddingBottom = pad[2];
      node.paddingLeft = pad[3];
    }
    return;
  }
  if (node.layoutMode === "NONE") return;
  const primary = layout.sizing && (layout.sizing.primaryAxis !== undefined ? layout.sizing.primaryAxis : layout.sizing.horizontal);
  const counter = layout.sizing && (layout.sizing.counterAxis !== undefined ? layout.sizing.counterAxis : layout.sizing.vertical);
  if (primary !== undefined) {
    // primaryAxisSizingMode / counterAxisSizingMode are axis-relative in the
    // Plugin API, so no horizontal/vertical swap is needed here.
    node.primaryAxisSizingMode = primary === "HUG" || primary === "AUTO" ? "AUTO" : "FIXED";
  }
  if (counter !== undefined) {
    node.counterAxisSizingMode = counter === "HUG" || counter === "AUTO" ? "AUTO" : "FIXED";
  }
  for (const k of ["minWidth", "maxWidth", "minHeight", "maxHeight"]) {
    if (layout[k] !== undefined && k in node) node[k] = Number(layout[k]);
  }
  try {
    if (layout.sizing) {
      if (layout.sizing.horizontal === "FILL" && "layoutSizingHorizontal" in node) node.layoutSizingHorizontal = "FILL";
      if (layout.sizing.vertical === "FILL" && "layoutSizingVertical" in node) node.layoutSizingVertical = "FILL";
    }
  } catch {
    // layoutSizing* is only settable on an auto-layout child; a root frame
    // asking for FILL is a caller mistake, not a document failure.
  }
}

export function applyChildLayout(node: any, layout: Json): void {
  if (!layout) return;
  try {
    if (layout.absolute === true || layout.positioning === "ABSOLUTE") {
      if ("layoutPositioning" in node) node.layoutPositioning = "ABSOLUTE";
    }
    if (layout.grow !== undefined && "layoutGrow" in node) node.layoutGrow = Number(layout.grow);
    if (layout.alignSelf !== undefined && "layoutAlign" in node) node.layoutAlign = layout.alignSelf;
    if (layout.sizing) {
      if (layout.sizing.horizontal && "layoutSizingHorizontal" in node && layout.sizing.horizontal !== "HUG" && layout.sizing.horizontal !== "AUTO") {
        node.layoutSizingHorizontal = layout.sizing.horizontal;
      }
      if (layout.sizing.vertical && "layoutSizingVertical" in node && layout.sizing.vertical !== "HUG" && layout.sizing.vertical !== "AUTO") {
        node.layoutSizingVertical = layout.sizing.vertical;
      }
    }
  } catch {
    // A layout-only field on a node that is not an auto-layout child is not a
    // reason to abort an entire build; the child simply ignores it.
  }
}

// ---------------------------------------------------------------- apply

function assignKey(node: any, key: string) {
  // Only the ROOT carries BUILD_DATA. Giving every descendant the build id
  // would make "find the root by buildId" match the whole subtree.
  node.setPluginData(KEY_DATA, key);
}

function applyCommonProps(node: any, spec: Json, res: Resources, ctx: any) {
  if (spec.name !== undefined) node.name = String(spec.name);
  if (spec.visible !== undefined) node.visible = !!spec.visible;
  if (spec.opacity !== undefined) node.opacity = Number(spec.opacity);
  if (spec.blendMode !== undefined) node.blendMode = spec.blendMode;
  if (spec.locked !== undefined) node.locked = !!spec.locked;
  if (spec.rotation !== undefined && "rotation" in node) node.rotation = Number(spec.rotation);
  if (spec.cornerRadius !== undefined && "cornerRadius" in node) node.cornerRadius = Number(spec.cornerRadius);
  for (const corner of ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"]) {
    if (spec[corner] !== undefined && corner in node) node[corner] = Number(spec[corner]);
  }
  if (spec.cornerSmoothing !== undefined && "cornerSmoothing" in node) node.cornerSmoothing = Number(spec.cornerSmoothing);
  if (spec.constraints !== undefined && "constraints" in node) node.constraints = spec.constraints;

  if (spec.fillStyle !== undefined) {
    const st = res.paintStyles.get(String(spec.fillStyle));
    if (st && "fillStyleId" in node) node.fillStyleId = st.id;
  } else if (spec.fills !== undefined) {
    if ("fills" in node) node.fills = paintsFromSpec(ctx, spec.fills, res);
  }
  if (spec.strokeStyle !== undefined) {
    const st = res.paintStyles.get(String(spec.strokeStyle));
    if (st && "strokeStyleId" in node) node.strokeStyleId = st.id;
  } else if (spec.strokes !== undefined) {
    if ("strokes" in node) node.strokes = paintsFromSpec(ctx, spec.strokes, res);
  }
  if (spec.strokeWeight !== undefined && "strokeWeight" in node) node.strokeWeight = Number(spec.strokeWeight);
  if (spec.strokeAlign !== undefined && "strokeAlign" in node) node.strokeAlign = spec.strokeAlign;
  if (spec.strokeCap !== undefined && "strokeCap" in node) node.strokeCap = spec.strokeCap;
  if (spec.strokeJoin !== undefined && "strokeJoin" in node) node.strokeJoin = spec.strokeJoin;
  if (spec.strokeMiterLimit !== undefined && "strokeMiterLimit" in node) node.strokeMiterLimit = Number(spec.strokeMiterLimit);
  if (spec.effectStyle !== undefined) {
    const st = res.effectStyles.get(String(spec.effectStyle));
    if (st && "effectStyleId" in node) node.effectStyleId = st.id;
  } else if (spec.effects !== undefined && "effects" in node) {
    node.effects = effectsFromSpec(spec.effects);
  }
  if (spec.dashPattern !== undefined && "dashPattern" in node) node.dashPattern = spec.dashPattern;
  if (spec.layoutGrids !== undefined && "layoutGrids" in node) node.layoutGrids = layoutGridsFromSpec(spec.layoutGrids);
  if (spec.isMask !== undefined && "isMask" in node) node.isMask = !!spec.isMask;
  if (spec.itemReverseZIndex !== undefined && "itemReverseZIndex" in node) node.itemReverseZIndex = !!spec.itemReverseZIndex;
  if (spec.strokesIncludedInLayout !== undefined && "strokesIncludedInLayout" in node) {
    node.strokesIncludedInLayout = !!spec.strokesIncludedInLayout;
  }
}

async function ensureTextFont(ctx: any, node: any, spec: Json, res: Resources): Promise<void> {
  let font: any = null;
  if (spec.textStyle !== undefined) {
    const st = res.textStyles.get(String(spec.textStyle));
    if (st) font = st.fontName;
  }
  if (spec.font !== undefined) font = fontSpec(spec.font);
  if (!font && node.fontName && node.fontName !== ctx.mixed) font = node.fontName;
  if (!font && node.fontName === ctx.mixed && typeof node.getRangeAllFontNames === "function") {
    const len = typeof node.characters === "string" ? node.characters.length : 0;
    const ranges = len > 0 ? (node.getRangeAllFontNames(0, len) || []) : [];
    for (const f of ranges) await ctx.loadFontAsync(f);
    // Mixed fonts cannot be replaced wholesale without destroying the runs.
    // Load every run and let the caller change characters only.
    return;
  }
  if (!font) font = DEFAULT_FONT;
  await ctx.loadFontAsync(font);
  // Load before assigning the style: Figma validates a text style against its
  // font, and assigning it first produces a confusing font error.
  if (spec.textStyle !== undefined) {
    const st = res.textStyles.get(String(spec.textStyle));
    if (st) node.textStyleId = st.id;
  }
  if (spec.font !== undefined) node.fontName = font;
}

async function applyTextRuns(ctx: any, node: any, spec: Json, res: Resources, where: string): Promise<void> {
  const runs = Array.isArray(spec.runs) ? spec.runs : [];
  if (!runs.length) return;
  if (typeof node.setRangeFontName !== "function") {
    throw new Error(`${where}: this host does not expose per-range text styling`);
  }
  const length = typeof node.characters === "string" ? node.characters.length : 0;
  let previousEnd = 0;
  for (let i = 0; i < runs.length; i++) {
    const run: Json = runs[i];
    const start = Number(run.start);
    const end = Number(run.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > length) {
      throw new Error(`${where}.runs[${i}]: range ${run.start}..${run.end} is outside the text (${length} characters)`);
    }
    if (i > 0 && start < previousEnd) throw new Error(`${where}.runs[${i}]: runs overlap`);
    previousEnd = end;

    // A style is the base for this range; literal fields below are the
    // overrides. `null` clears a style inherited from the node.
    if (run.textStyle !== undefined) {
      if (typeof node.setRangeTextStyleIdAsync !== "function") {
        throw new Error(`${where}.runs[${i}]: this host cannot link a text style to a range`);
      }
      const style = run.textStyle === null ? null : res.textStyles.get(String(run.textStyle));
      if (run.textStyle !== null && !style) throw new Error(`${where}.runs[${i}]: text style "${run.textStyle}" was not resolved`);
      await node.setRangeTextStyleIdAsync(start, end, style ? style.id : "");
    }
    if (run.font !== undefined) node.setRangeFontName(start, end, run.font);
    if (run.fontSize !== undefined) node.setRangeFontSize(start, end, Number(run.fontSize));
    if (run.fillStyle !== undefined) {
      if (typeof node.setRangeFillStyleIdAsync !== "function") {
        throw new Error(`${where}.runs[${i}]: this host cannot link a paint style to a range`);
      }
      const style = run.fillStyle === null ? null : res.paintStyles.get(String(run.fillStyle));
      if (run.fillStyle !== null && !style) throw new Error(`${where}.runs[${i}]: paint style "${run.fillStyle}" was not resolved`);
      await node.setRangeFillStyleIdAsync(start, end, style ? style.id : "");
    }
    if (run.fills !== undefined) node.setRangeFills(start, end, paintsFromSpec(ctx, run.fills, res));
    if (run.textCase !== undefined) node.setRangeTextCase(start, end, run.textCase);
    if (run.textDecoration !== undefined) node.setRangeTextDecoration(start, end, run.textDecoration);
    if (run.lineHeight !== undefined) node.setRangeLineHeight(start, end, run.lineHeight);
    if (run.letterSpacing !== undefined) node.setRangeLetterSpacing(start, end, run.letterSpacing);
    if (run.hyperlink !== undefined) node.setRangeHyperlink(start, end, run.hyperlink);
    if (run.variable !== undefined) {
      if (typeof node.setRangeBoundVariable !== "function") {
        throw new Error(`${where}.runs[${i}]: this host cannot bind a variable to a text range`);
      }
      for (const [field, ref] of Object.entries(run.variable as Json)) {
        const variable = ref === null ? null : res.variables.get(String(ref));
        if (ref !== null && !variable) throw new Error(`${where}.runs[${i}].variable.${field}: variable "${ref}" was not resolved`);
        try {
          node.setRangeBoundVariable(start, end, field, variable);
        } catch (e) {
          throw new Error(`${where}.runs[${i}].variable.${field}: ${errMsg(e)}`);
        }
      }
    }
  }
}

function applyTextVariableBindings(node: any, spec: Json, res: Resources, where: string): void {
  if (!isObj(spec.textVariable)) return;
  if (typeof node.setBoundVariable !== "function") {
    throw new Error(`${where}: this host cannot bind a variable to a text field`);
  }
  for (const [field, ref] of Object.entries(spec.textVariable as Json)) {
    const variable = ref === null ? null : res.variables.get(String(ref));
    if (ref !== null && !variable) throw new Error(`${where}.textVariable.${field}: variable "${ref}" was not resolved`);
    try {
      node.setBoundVariable(field, variable);
    } catch (e) {
      throw new Error(`${where}.textVariable.${field}: ${errMsg(e)}`);
    }
  }
}

async function applyTextProps(ctx: any, node: any, spec: Json, res: Resources, where: string): Promise<void> {
  await ensureTextFont(ctx, node, spec, res);
  if (spec.text !== undefined) node.characters = String(spec.text);
  if (spec.hyperlink !== undefined) node.hyperlink = spec.hyperlink;
  if (spec.fontSize !== undefined) node.fontSize = Number(spec.fontSize);
  if (spec.textAutoResize !== undefined) node.textAutoResize = spec.textAutoResize;
  if (spec.textAlignHorizontal !== undefined) node.textAlignHorizontal = spec.textAlignHorizontal;
  if (spec.textAlignVertical !== undefined) node.textAlignVertical = spec.textAlignVertical;
  if (spec.lineHeight !== undefined) {
    node.lineHeight = typeof spec.lineHeight === "number"
      ? { unit: "PIXELS", value: spec.lineHeight }
      : spec.lineHeight;
  }
  if (spec.letterSpacing !== undefined) {
    node.letterSpacing = typeof spec.letterSpacing === "number"
      ? { unit: "PIXELS", value: spec.letterSpacing }
      : spec.letterSpacing;
  }
  if (spec.textCase !== undefined) node.textCase = spec.textCase;
  if (spec.textDecoration !== undefined) node.textDecoration = spec.textDecoration;
  if (spec.paragraphSpacing !== undefined) node.paragraphSpacing = Number(spec.paragraphSpacing);
  if (spec.paragraphIndent !== undefined) node.paragraphIndent = Number(spec.paragraphIndent);
  applyTextVariableBindings(node, spec, res, where);
  await applyTextRuns(ctx, node, spec, res, where);
  if (spec.size !== undefined) {
    node.textAutoResize = "NONE";
    node.resize(Number(spec.size.width), Number(spec.size.height));
  }
}

function componentPropsValid(node: any, props: Json): string[] {
  const defs = node.componentProperties || {};
  const names = Object.keys(defs);
  const bad: string[] = [];
  for (const k of Object.keys(props || {})) {
    if (!names.includes(k)) bad.push(k);
  }
  return bad;
}

async function applyOverrides(ctx: any, instance: any, overrides: Json, res: Resources, warnings: string[]) {
  for (const name of Object.keys(overrides || {})) {
    const override = overrides[name];
    if (!isObj(override)) {
      warnings.push(`override "${name}" is not an object; skipped`);
      continue;
    }
    let target: any = null;
    try {
      target = instance.findOne((n: any) => n.name === name || n.getPluginData(KEY_DATA) === name);
    } catch {
      target = null;
    }
    if (!target) {
      warnings.push(`override "${name}": no layer with that name or key inside the instance`);
      continue;
    }
    if (override.visible !== undefined) target.visible = !!override.visible;
    if (override.opacity !== undefined) target.opacity = Number(override.opacity);
    if (override.fills !== undefined && "fills" in target) target.fills = paintsFromSpec(ctx, override.fills, res);
    if (override.strokes !== undefined && "strokes" in target) target.strokes = paintsFromSpec(ctx, override.strokes, res);
    if (override.text !== undefined && target.type === "TEXT") {
      if (target.fontName && target.fontName !== ctx.mixed) await ctx.loadFontAsync(target.fontName);
      else if (typeof target.getRangeAllFontNames === "function") {
        const len = typeof target.characters === "string" ? target.characters.length : 0;
        if (len > 0) for (const f of target.getRangeAllFontNames(0, len) || []) await ctx.loadFontAsync(f);
      }
      target.characters = String(override.text);
    }
    if (override.fontSize !== undefined && target.type === "TEXT") target.fontSize = Number(override.fontSize);
    if (override.hyperlink !== undefined && target.type === "TEXT") {
      target.hyperlink = hyperlinkFromSpec(override.hyperlink, `override "${name}".hyperlink`);
    }
    if (override.size !== undefined && "resize" in target) {
      target.resize(Number(override.size.width), Number(override.size.height));
    }
  }
}

async function createNodeFor(ctx: any, n: NormalizedNode, component: any): Promise<any> {
  switch (n.type) {
    case "FRAME": return ctx.createFrame();
    case "RECTANGLE": return ctx.createRectangle();
    case "ELLIPSE": return ctx.createEllipse();
    case "LINE": return ctx.createLine();
    case "TEXT": return ctx.createText();
    case "COMPONENT": return ctx.createComponent();
    case "SVG": {
      const node = ctx.createNodeFromSvg(String(n.spec.svg));
      return node;
    }
    case "INSTANCE": {
      if (!component) throw new Error(`${n.key}: instance has no resolved component`);
      return component.createInstance();
    }
    default:
      throw new Error(`${n.key}: cannot create ${n.type}`);
  }
}

async function applyNode(
  ctx: any,
  node: any,
  n: NormalizedNode,
  res: Resources,
  opts: { buildId: string; create: boolean; patch: boolean; warnings: string[] },
): Promise<void> {
  const spec = n.spec;
  if (opts.create) {
    // Name first: Figma's default name ("Frame 123") is noise in the layer list
    // and makes the first failed build harder to read.
    node.name = n.name;
    assignKey(node, n.key);
    if (n.type === "SVG") node.setPluginData(KIND_DATA, "SVG");
    if (spec.protected === true) node.setPluginData(PROTECTED_DATA, "1");
  } else {
    if (spec.name !== undefined) node.name = String(spec.name);
    if (spec.protected === true) node.setPluginData(PROTECTED_DATA, "1");
  }

  applyCommonProps(node, spec, res, ctx);
  if (n.type === "TEXT") await applyTextProps(ctx, node, spec, res, n.key);
  else if (n.type === "LINE" && spec.length !== undefined && "resize" in node) node.resize(Number(spec.length), 0);
  else if (spec.size !== undefined && "resize" in node) node.resize(Number(spec.size.width), Number(spec.size.height));

  if (n.type === "INSTANCE") {
    if (opts.create) {
      if (spec.name === undefined) node.name = n.name;
    } else if (spec.componentId || spec.componentKey || spec.componentSetKey || spec.componentName) {
      let main: any = null;
      try { main = await node.getMainComponentAsync(); } catch { main = null; }
      const wanted = spec.componentId ? String(spec.componentId) : spec.componentKey ? String(spec.componentKey) : "";
      if (wanted && main && main.id !== wanted && main.key !== wanted) {
        throw new Error(
          `${n.key}: existing instance points at ${nodeLabel(main)}, patch asks for ${wanted}. ` +
            `Swapping a main component would change every override, so it is refused; delete and rebuild the instance instead.`,
        );
      }
    }
    if (spec.properties !== undefined) {
      const bad = componentPropsValid(node, spec.properties);
      if (bad.length) {
        throw new Error(
          `${n.key}: component has no ${bad.length === 1 ? "property" : "properties"} ${bad.join(", ")}. ` +
            `Available: ${Object.keys(node.componentProperties || {}).join(", ") || "(none)"}`,
        );
      }
      node.setProperties(spec.properties);
    }
    if (spec.overrides !== undefined) await applyOverrides(ctx, node, spec.overrides, res, opts.warnings);
  }

  if (spec.layout !== undefined) applyChildLayout(node, spec.layout);
  const parent = node.parent;
  const parentLayout = parent && "layoutMode" in parent ? parent.layoutMode : "NONE";
  const absolute = spec.layout && (spec.layout.absolute === true || spec.layout.positioning === "ABSOLUTE");
  if (spec.position !== undefined) {
    if (parentLayout !== "NONE" && !absolute) {
      opts.warnings.push(`${n.key}: position ignored because the parent uses auto-layout (set layout.absolute: true to place it explicitly)`);
    } else {
      node.x = Number(spec.position.x);
      node.y = Number(spec.position.y);
    }
  }
  if (spec.layout !== undefined) applyContainerLayout(node, spec.layout, "before");
}

type ApplyResult = { created: string[]; updated: string[]; deleted: string[]; keys: Record<string, string> };

function mergeResult(into: ApplyResult, add: ApplyResult): void {
  for (const k of add.created) if (!into.created.includes(k)) into.created.push(k);
  for (const k of add.updated) if (!into.updated.includes(k)) into.updated.push(k);
  for (const k of add.deleted) if (!into.deleted.includes(k)) into.deleted.push(k);
  for (const k of Object.keys(add.keys)) into.keys[k] = add.keys[k];
}

function directByKey(parent: any, key: string): any[] {
  const out: any[] = [];
  for (const child of parent.children || []) {
    try { if (child.getPluginData(KEY_DATA) === key) out.push(child); } catch { /* ignore */ }
  }
  return out;
}

function deepByKey(root: any, key: string): any[] {
  const out: any[] = [];
  const visit = (n: any) => {
    try { if (n.getPluginData(KEY_DATA) === key) out.push(n); } catch { /* ignore */ }
    for (const c of n.children || []) visit(c);
  };
  visit(root);
  return out;
}

function actualKind(node: any): string {
  try { return node.getPluginData(KIND_DATA) || node.type; } catch { return node.type; }
}

function pruneChildren(
  node: any,
  expected: Set<string>,
  protectedIds: Set<string>,
  warnings: string[],
  mark: () => void,
): string[] {
  const deleted: string[] = [];
  for (const child of [...(node.children || [])]) {
    let k = "";
    try { k = child.getPluginData(KEY_DATA) || ""; } catch { k = ""; }
    if (!k || expected.has(k)) continue;
    if (protectedIds.has(child.id) || child.getPluginData(PROTECTED_DATA) === "1") {
      warnings.push(`prune skipped protected node ${nodeLabel(child)}`);
      continue;
    }
    mark();
    child.remove();
    deleted.push(k);
  }
  return deleted;
}

async function applySubtree(
  ctx: any,
  parent: any,
  n: NormalizedNode,
  res: Resources,
  opts: {
    buildId: string;
    patch: boolean;
    warnings: string[];
    prune: boolean;
    rootRef: any;
    protectedIds: Set<string>;
    mark: () => void;
  },
): Promise<ApplyResult> {
  const hits = directByKey(parent, n.key);
  if (hits.length > 1) throw new Error(`${n.key}: ${hits.length} children of ${nodeLabel(parent)} share this key; refusing to choose one`);
  let node = hits[0] || null;
  let create = false;
  if (!node) {
    // A key that exists elsewhere is not a missing node: it is a hierarchy
    // change. Silently creating a duplicate would leave two live nodes with the
    // same identity, which is exactly the state patch exists to avoid.
    const elsewhere = deepByKey(opts.rootRef, n.key).filter((x) => x.parent !== parent);
    if (elsewhere.length) {
      throw new Error(
        `${n.key}: key already exists under ${nodeLabel(elsewhere[0].parent)}, not under ${nodeLabel(parent)}. ` +
          `Refusing to create a duplicate; move the node deliberately or use a new key.`,
      );
    }
    const comp = n.type === "INSTANCE" ? res.components.get(n.key) : null;
    opts.mark();
    node = await createNodeFor(ctx, n, comp);
    parent.appendChild(node);
    create = true;
  }
  opts.mark();
  await applyNode(ctx, node, n, res, { buildId: opts.buildId, create, patch: opts.patch, warnings: opts.warnings });

  const result: ApplyResult = { created: [], updated: [], deleted: [], keys: {} };
  if (create) result.created.push(n.key);
  else result.updated.push(n.key);
  result.keys[n.key] = node.id;

  for (const child of n.children) {
    mergeResult(result, await applySubtree(ctx, node, child, res, opts));
  }
  if (n.spec.layout !== undefined) applyContainerLayout(node, n.spec.layout, "after");

  if (opts.prune) {
    const expected = new Set(n.children.map((c) => c.key));
    const deleted = pruneChildren(node, expected, opts.protectedIds, opts.warnings, opts.mark);
    for (const k of deleted) result.deleted.push(k);
  }

  // Re-read the key after creation/update: this is the authoritative map the
  // report returns, and it catches a Figma-side failure to store pluginData.
  let stored = "";
  try { stored = node.getPluginData(KEY_DATA) || ""; } catch { stored = ""; }
  if (stored !== n.key) throw new Error(`${n.key}: node ${node.id} stored key "${stored}" instead of "${n.key}"`);
  return result;
}

function componentReport(res: Resources): Json[] {
  return res.componentRefs.map((r) => ({
    key: r.key,
    componentId: r.componentId ?? null,
    componentKey: r.componentKey ?? null,
    componentName: r.componentName ?? null,
    componentSetKey: r.componentSetKey ?? null,
    resolved: res.components.has(r.key),
  }));
}

async function applyPlan(ctx: any, plan: Plan, p: Json): Promise<Json> {
  const res: Resources = (plan as any)._res;
  const tree: NormalizedNode = (plan as any)._tree;
  const requestedParent: any = (plan as any)._parent;
  const existingRoot: any = (plan as any)._existingRoot;
  const patch = (plan as any)._patch === true;
  const warnings = [...plan.warnings];
  const t0 = Date.now();

  // Font loading is read-only, so it belongs before the undo baseline: a
  // missing font must fail without leaving an empty transaction behind.
  for (const f of res.fonts.values()) await ctx.loadFontAsync(f);

  let wrote = false;
  const mark = () => { if (!wrote) { wrote = true; ctx.commitUndo(); } };
  ctx.commitUndo();
  try {
    // Library component imports are writes. They happen here, after the undo
    // baseline and inside the same transaction as the nodes that will use them.
    mark();
    await resolveComponents(ctx, res, true);
    if (res.blocking.length) throw new Error("cannot resolve components: " + res.blocking.join("; "));
    plan.components = componentReport(res);

    const parent = existingRoot ? existingRoot.parent : requestedParent;
    if (!parent) throw new Error("root has no parent");
    let rootNode = existingRoot;
    if (!rootNode) {
      const comp = tree.type === "INSTANCE" ? res.components.get(tree.key) : null;
      rootNode = await createNodeFor(ctx, tree, comp);
      parent.appendChild(rootNode);
    }
    mark();
    await applyNode(ctx, rootNode, tree, res, { buildId: plan.buildId, create: !existingRoot, patch, warnings });
    if (plan.buildId) rootNode.setPluginData(BUILD_DATA, plan.buildId);

    const result: ApplyResult = {
      created: existingRoot ? [] : [tree.key],
      updated: existingRoot ? [tree.key] : [],
      deleted: [],
      keys: { [tree.key]: rootNode.id },
    };
    for (const child of tree.children) {
      mergeResult(result, await applySubtree(ctx, rootNode, child, res, {
        buildId: plan.buildId,
        patch,
        warnings,
        prune: plan.prune,
        rootRef: rootNode,
        protectedIds: collectProtected(rootNode),
        mark,
      }));
    }
    if (tree.spec.layout !== undefined) applyContainerLayout(rootNode, tree.spec.layout, "after");
    if (plan.prune) {
      const expected = new Set(tree.children.map((c) => c.key));
      const deleted = pruneChildren(rootNode, expected, collectProtected(rootNode), warnings, mark);
      for (const k of deleted) result.deleted.push(k);
    }
    ctx.commitUndo();

    let verifiedRoot: any = null;
    try {
      verifiedRoot = await ctx.getNodeByIdAsync(rootNode.id);
    } catch {
      verifiedRoot = null;
    }
    if (!verifiedRoot) verifiedRoot = rootNode;
    let verification: Json = { ok: false, reason: "root not found after apply" };
    if (verifiedRoot) {
      const live = collectKeyMap(verifiedRoot);
      const missing: string[] = [];
      const typeMismatch: string[] = [];
      for (const k of plan.planned.create.concat(plan.planned.update)) {
        const nodes = live.get(k) || [];
        const wanted = expectedType(tree, k);
        if (!nodes.length) missing.push(k);
        else if (wanted && !nodes.some((x) => actualKind(x) === wanted)) typeMismatch.push(k);
      }
      verification = {
        ok: missing.length === 0 && typeMismatch.length === 0,
        missing,
        typeMismatch,
        fingerprint: scopeFingerprint(verifiedRoot),
        nodes: [...live.values()].reduce((a, v) => a + v.length, 0),
      };
    }
    return {
      status: "applied",
      rootNodeId: rootNode.id,
      created: result.created,
      updated: result.updated,
      deleted: result.deleted,
      keys: result.keys,
      verification,
      warnings,
      ms: { plan: planMs(plan), apply: Date.now() - t0 },
    };
  } catch (e) {
    if (wrote) {
      try { ctx.commitUndo(); ctx.triggerUndo(); } catch { /* ignore */ }
    }
    const msg = errMsg(e);
    throw new Error(msg + (wrote ? " (rolled back)" : ""));
  }
}

function planMs(plan: Plan): number {
  return (plan as any)._planMs || 0;
}

function expectedType(tree: NormalizedNode, key: string): string | null {
  if (tree.key === key) return tree.type;
  for (const c of tree.children) {
    const t = expectedType(c, key);
    if (t) return t;
  }
  return null;
}

// ---------------------------------------------------------------- public entry points

function publicPlan(plan: Plan): Plan {
  const copy: any = { ...plan };
  delete copy._tree;
  delete copy._res;
  delete copy._parent;
  delete copy._existingRoot;
  delete copy._keyMap;
  delete copy._patch;
  delete copy._planMs;
  return copy as Plan;
}

function blocked(plan: Plan, t0: number): Json {
  return {
    status: "blocked",
    schema: BUILD_SCHEMA,
    dryRun: plan.dryRun,
    mode: plan.mode,
    buildId: plan.buildId,
    root: plan.root,
    parent: plan.parent,
    counts: plan.counts,
    blocking: plan.blocking,
    warnings: plan.warnings,
    fingerprint: plan.fingerprint,
    fonts: plan.fonts,
    styles: plan.styles,
    variables: plan.variables,
    components: plan.components,
    ms: { plan: Date.now() - t0 },
  };
}

export async function runBuild(ctx: any, params: Json): Promise<Json> {
  const t0 = Date.now();
  const bytes = JSON.stringify(params || {}).length;
  if (bytes > MAX_SPEC_BYTES) {
    throw new Error(`build spec is ${bytes} bytes; the limit is ${MAX_SPEC_BYTES}. Split the screen or move image data out of the spec.`);
  }
  const plan = await planBuild(ctx, params);
  (plan as any)._planMs = Date.now() - t0;
  if (params.expectedFingerprint && params.expectedFingerprint !== plan.fingerprint) {
    return {
      status: "refused",
      reason: "FINGERPRINT_MISMATCH",
      message:
        "The document changed since the plan was made. Run figma_build with dryRun:true again and inspect the new plan before applying.",
      expected: params.expectedFingerprint,
      actual: plan.fingerprint,
      root: plan.root,
      parent: plan.parent,
      ms: { plan: Date.now() - t0 },
    };
  }
  if (plan.blocking.length) return blocked(plan, t0);
  if (params.dryRun !== false) {
    return {
      ...publicPlan(plan),
      status: "dry_run",
      dryRun: true,
      ms: { plan: Date.now() - t0 },
    };
  }
  const applied = await applyPlan(ctx, plan, params);
  return {
    schema: BUILD_SCHEMA,
    mode: plan.mode,
    buildId: plan.buildId,
    root: plan.root,
    parent: plan.parent,
    counts: plan.counts,
    planned: plan.planned,
    fingerprint: plan.fingerprint,
    fonts: plan.fonts,
    styles: plan.styles,
    variables: plan.variables,
    components: plan.components,
    ...applied,
    ms: { plan: planMs(plan), apply: applied.ms.apply, total: Date.now() - t0 },
  };
}

export async function runPatch(ctx: any, params: Json): Promise<Json> {
  const t0 = Date.now();
  const bytes = JSON.stringify(params || {}).length;
  if (bytes > MAX_SPEC_BYTES) {
    throw new Error(`patch spec is ${bytes} bytes; the limit is ${MAX_SPEC_BYTES}.`);
  }
  const plan = await planPatch(ctx, params);
  (plan as any)._planMs = Date.now() - t0;
  if (params.expectedFingerprint && params.expectedFingerprint !== plan.fingerprint) {
    return {
      status: "refused",
      reason: "FINGERPRINT_MISMATCH",
      message:
        "The document changed since the plan was made. Run figma_patch with dryRun:true again and inspect the new plan before applying.",
      expected: params.expectedFingerprint,
      actual: plan.fingerprint,
      root: plan.root,
      parent: plan.parent,
      ms: { plan: Date.now() - t0 },
    };
  }
  if (plan.blocking.length) return blocked(plan, t0);
  if (params.dryRun !== false) {
    return {
      ...publicPlan(plan),
      status: "dry_run",
      dryRun: true,
      ms: { plan: Date.now() - t0 },
    };
  }
  const applied = await applyPlan(ctx, plan, params);
  return {
    schema: BUILD_SCHEMA,
    mode: "patch",
    buildId: plan.buildId,
    root: plan.root,
    parent: plan.parent,
    counts: plan.counts,
    planned: plan.planned,
    fingerprint: plan.fingerprint,
    fonts: plan.fonts,
    styles: plan.styles,
    variables: plan.variables,
    components: plan.components,
    ...applied,
    ms: { plan: planMs(plan), apply: applied.ms.apply, total: Date.now() - t0 },
  };
}

// ---------------------------------------------------------------- test seams

/** Exposed for unit tests: deterministic key derivation. */
export function keyFor(parentKey: string, type: string, name: string, index: number): string {
  return deriveKey(parentKey, type, name, index);
}


