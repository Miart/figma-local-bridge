/// <reference types="@figma/plugin-typings" />

/**
 * Design-token sync for Figma variables.
 *
 * The tool works on one explicit document, not on a pile of heuristics:
 *
 *  - export writes the local variable collections as `figma-tokens/v1`, with
 *    every mode value and with aliases kept as aliases;
 *  - diff and import build the same plan, so "what will change" and "what did
 *    change" cannot disagree;
 *  - import creates missing collections, modes and variables, updates values
 *    and descriptions, and never deletes unless `prune` is explicitly allowed.
 *
 * The token document is deliberately smaller than the whole design system:
 * variables are what a design-token pipeline can round-trip without inventing
 * style semantics. Native `figma-tokens/v1` is the lossless form; a plain DTCG
 * tree (or a DTCG group under a collection/mode) is accepted on import as a
 * convenience. Unsupported DTCG types are blocking findings, never dropped.
 *
 * Safety follows the rest of the bridge: a dry run fingerprints the live
 * variable state, apply requires that fingerprint, the whole import is one undo
 * transaction, and after writing every collection/mode/variable is read back
 * and compared. A rollback that Figma refuses is reported as ROLLBACK FAILED.
 */

import { parseColor } from "./ui-build";
import { hashString } from "./fingerprint";

export const TOKEN_SCHEMA = "figma-tokens/v1";
export const TOKEN_TYPES = ["COLOR", "FLOAT", "STRING", "BOOLEAN"] as const;
type TokenType = (typeof TOKEN_TYPES)[number];
const TYPE_SET = new Set<string>(TOKEN_TYPES);
const MAX_COLLECTIONS = 200;
const MAX_VARIABLES = 10000;
const MAX_MODES = 64;
const MAX_DTCG_DEPTH = 64;

type Json = any;

const isObj = (v: any) => !!v && typeof v === "object" && !Array.isArray(v);
const errMsg = (e: any) => String(e && e.message ? e.message : e);
const round = (n: number) => Math.round(n * 100000) / 100000;

/** Stable JSON, so a fingerprint does not change when a key moves. */
function canonical(v: any): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const o = v as Record<string, any>;
  return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort()
    .map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
}

function colorChannels(v: any): { r: number; g: number; b: number; a: number } | null {
  if (!isObj(v)) return null;
  const channel = (x: any) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
  if (!channel(v.r) || !channel(v.g) || !channel(v.b)) return null;
  const a = v.a === undefined ? 1 : v.a;
  if (!channel(a)) return null;
  return { r: v.r, g: v.g, b: v.b, a };
}

function colorHex(v: any): string {
  const c = colorChannels(v) || { r: 0, g: 0, b: 0, a: 1 };
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n * 255))).toString(16).padStart(2, "0");
  const base = "#" + h(c.r) + h(c.g) + h(c.b);
  return c.a < 1 ? base + h(Math.max(0, Math.min(1, c.a))) : base;
}

function figmaColor(c: { r: number; g: number; b: number; a: number }): any {
  return c.a >= 1 ? { r: c.r, g: c.g, b: c.b } : { r: c.r, g: c.g, b: c.b, a: c.a };
}

function sameNumber(a: any, b: any): boolean {
  return typeof a === "number" && Number.isFinite(a) && typeof b === "number" && Number.isFinite(b) && Math.abs(a - b) < 1e-5;
}

function sameColor(a: any, b: any): boolean {
  const x = colorChannels(a);
  const y = colorChannels(b);
  if (!x || !y) return false;
  const channel = (p: number, q: number) => Math.abs(p - q) <= 1 / 255 + 1e-9;
  return channel(x.r, y.r) && channel(x.g, y.g) && channel(x.b, y.b) && channel(x.a, y.a);
}

function sameAlias(a: any, id: string): boolean {
  return isObj(a) && a.type === "VARIABLE_ALIAS" && a.id === id;
}

function normalizeType(type: any): TokenType | null {
  const s = String(type || "").trim().toUpperCase();
  return TYPE_SET.has(s) ? (s as TokenType) : null;
}

function normalizeModes(value: any, fallback: string): string[] {
  const list = value === undefined ? [fallback] : value;
  if (!Array.isArray(list) || !list.length) throw new Error("modes must be a non-empty array of names");
  const out: string[] = [];
  for (const raw of list) {
    const name = String(raw ?? "").trim();
    if (!name) throw new Error("mode names cannot be empty");
    if (out.includes(name)) throw new Error(`duplicate mode name "${name}"`);
    out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------- token values

interface SpecValue {
  kind: "literal" | "alias" | "remoteAlias";
  /** Figma-shaped value for a literal. */
  value?: any;
  /** A token type, for a literal value. */
  type?: TokenType;
  collection?: string;
  name?: string;
  /** The live remote/library variable id, for a remoteAlias. */
  id?: string;
}

function literal(type: TokenType, value: any): SpecValue {
  return { kind: "literal", type, value };
}

function alias(collection: string, name: string): SpecValue {
  return { kind: "alias", collection, name };
}

function remoteAlias(collection: string, name: string, id: string): SpecValue {
  return { kind: "remoteAlias", collection, name, id };
}

function aliasObject(v: any): { collection: string; name: string } | null {
  if (!isObj(v) || !isObj(v.alias)) return null;
  const collection = typeof v.alias.collection === "string" ? v.alias.collection.trim() : "";
  const name = typeof v.alias.name === "string" ? v.alias.name.trim() : "";
  return collection && name ? { collection, name } : null;
}

function parseNativeValue(raw: any, type: TokenType, path: string, warnings: string[], fail: (m: string) => void): SpecValue | null {
  if (isObj(raw) && isObj(raw.alias) && raw.alias.remote !== undefined) {
    if (typeof raw.alias.remote !== "boolean") {
      fail(`${path}: alias.remote must be true or false`);
      return null;
    }
    if (raw.alias.remote === true) {
      const id =
        typeof raw.alias.id === "string" && raw.alias.id
          ? raw.alias.id
          : typeof raw.alias.variableId === "string" && raw.alias.variableId
            ? raw.alias.variableId
            : "";
      if (!id) {
        fail(`${path}: a remote/library alias needs its live variable id so an unchanged value can be recognized`);
        return null;
      }
      const collection = typeof raw.alias.collection === "string" ? raw.alias.collection.trim() : "";
      const name = typeof raw.alias.name === "string" ? raw.alias.name.trim() : "";
      return remoteAlias(collection, name, id);
    }
  }
  const ref = aliasObject(raw);
  if (ref) return alias(ref.collection, ref.name);
  if (isObj(raw) && "alias" in raw) {
    if (isObj(raw.alias) && typeof raw.alias.variableId === "string") {
      fail(`${path}: alias target ${raw.alias.variableId} has no readable collection/name; bind a local variable by name first`);
    } else {
      fail(`${path}: alias must be {alias:{collection,name}} with non-empty strings`);
    }
    return null;
  }
  if (raw === null || raw === undefined) {
    fail(`${path}: value is missing`);
    return null;
  }
  if (type === "COLOR") {
    try {
      const c = parseColor(raw);
      return literal(type, figmaColor(c));
    } catch (e) {
      fail(`${path}: ${errMsg(e)}`);
      return null;
    }
  }
  if (type === "FLOAT") {
    if (typeof raw === "number" && Number.isFinite(raw)) return literal(type, raw);
    if (typeof raw === "string") {
      const m = /^(-?\d+(?:\.\d+)?)(px)?$/i.exec(raw.trim());
      if (m) {
        if (m[2]) warnings.push(`${path}: "px" is dropped because a Figma FLOAT is unitless`);
        return literal(type, Number(m[1]));
      }
    }
    fail(`${path}: FLOAT needs a finite number (or a number with a px suffix)`);
    return null;
  }
  if (type === "STRING") {
    if (typeof raw === "string") return literal(type, raw);
    fail(`${path}: STRING needs a string`);
    return null;
  }
  if (type === "BOOLEAN") {
    if (typeof raw === "boolean") return literal(type, raw);
    fail(`${path}: BOOLEAN needs true or false`);
    return null;
  }
  fail(`${path}: unsupported type ${type}`);
  return null;
}

function dtcgAliasPath(raw: any): string | null {
  if (typeof raw !== "string") return null;
  const m = /^\s*\{([^{}]+)\}\s*$/.exec(raw);
  return m ? m[1].trim() : null;
}

function dtcgNumber(raw: any, path: string, fail: (m: string) => void): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && /^-?\d+(?:\.\d+)?$/.test(raw.trim())) return Number(raw);
  fail(`${path}: expected a finite number`);
  return null;
}

function dtcgColorValue(raw: any, path: string, fail: (m: string) => void): any {
  if (isObj(raw) && typeof raw.colorSpace === "string") {
    if (raw.colorSpace !== "srgb") {
      fail(`${path}: colorSpace "${raw.colorSpace}" is not supported; use srgb or a hex/rgb() string`);
      return null;
    }
    if (!Array.isArray(raw.components) || raw.components.length < 3) {
      fail(`${path}: color components must contain at least three numbers`);
      return null;
    }
    const c = raw.components.slice(0, 3).map(Number);
    const a = raw.alpha === undefined ? 1 : Number(raw.alpha);
    if (c.some((v: number) => !Number.isFinite(v) || v < 0 || v > 1) || !Number.isFinite(a) || a < 0 || a > 1) {
      fail(`${path}: srgb components and alpha must be between 0 and 1`);
      return null;
    }
    return figmaColor({ r: c[0], g: c[1], b: c[2], a });
  }
  try {
    return figmaColor(parseColor(raw));
  } catch (e) {
    fail(`${path}: ${errMsg(e)}`);
    return null;
  }
}

const FONT_WEIGHTS: Record<string, number> = {
  thin: 100, hairline: 100,
  "extra light": 200, extralight: 200, "ultra light": 200, ultralight: 200,
  light: 300,
  normal: 400, regular: 400, book: 400,
  medium: 500,
  "semi bold": 600, semibold: 600, "demi bold": 600, demibold: 600,
  bold: 700,
  "extra bold": 800, extrabold: 800, "ultra bold": 800, ultrabold: 800,
  black: 900, heavy: 900,
  "extra black": 950, extrablack: 950, "ultra black": 950, ultrablack: 950,
};

function dtcgValue(raw: any, type: string, path: string, warnings: string[], fail: (m: string) => void): SpecValue | null {
  const lower = String(type).trim().toLowerCase();
  type = lower === "fontfamily" ? "fontFamily" : lower === "fontweight" ? "fontWeight" : lower;
  const ref = dtcgAliasPath(raw);
  if (ref) {
    // DTCG paths use dots for groups. A slash is already a Figma variable name.
    return alias("", ref.includes("/") ? ref : ref.split(".").join("/"));
  }
  if (type === "color") {
    const c = dtcgColorValue(raw, path, fail);
    return c ? literal("COLOR", c) : null;
  }
  if (type === "number") {
    const n = dtcgNumber(raw, path, fail);
    return n === null ? null : literal("FLOAT", n);
  }
  if (type === "dimension") {
    let n: number | null = null;
    let unit = "";
    if (isObj(raw)) {
      n = dtcgNumber(raw.value, path, fail);
      unit = raw.unit === undefined ? "" : String(raw.unit).toLowerCase();
    } else if (typeof raw === "string") {
      const m = /^(-?\d+(?:\.\d+)?)([a-z%]*)$/i.exec(raw.trim());
      if (m) {
        n = Number(m[1]);
        unit = m[2].toLowerCase();
      }
    } else {
      n = dtcgNumber(raw, path, fail);
    }
    if (n === null) return null;
    if (unit && unit !== "px") {
      fail(`${path}: dimension unit "${unit}" cannot be converted to a unitless Figma FLOAT; use px or a number`);
      return null;
    }
    if (unit === "px") warnings.push(`${path}: dimension is stored as a unitless FLOAT (px dropped)`);
    return literal("FLOAT", n);
  }
  if (type === "string") {
    if (typeof raw === "string") return literal("STRING", raw);
    fail(`${path}: string needs a string`);
    return null;
  }
  if (type === "boolean") {
    if (typeof raw === "boolean") return literal("BOOLEAN", raw);
    fail(`${path}: boolean needs true or false`);
    return null;
  }
  if (type === "fontFamily") {
    if (typeof raw === "string") return literal("STRING", raw);
    if (Array.isArray(raw) && raw.length && raw.every((v) => typeof v === "string")) {
      warnings.push(`${path}: fontFamily fallback list is joined into one STRING`);
      return literal("STRING", raw.join(", "));
    }
    fail(`${path}: fontFamily needs a string or a non-empty array of strings`);
    return null;
  }
  if (type === "fontWeight") {
    if (typeof raw === "string") {
      const named = FONT_WEIGHTS[raw.trim().toLowerCase().replace(/[-_]+/g, " ")];
      if (named !== undefined) return literal("FLOAT", named);
    }
    const n = dtcgNumber(raw, path, fail);
    return n === null ? null : literal("FLOAT", n);
  }
  fail(`${path}: $type "${type}" is not supported by Figma variables (supported: color, number, dimension, string, boolean, fontFamily, fontWeight)`);
  return null;
}

// ---------------------------------------------------------------- document normalization

interface SpecVariable {
  name: string;
  type: TokenType;
  description?: string;
  values: Record<string, SpecValue>;
}

interface SpecCollection {
  name: string;
  modes: string[];
  defaultMode?: string;
  variables: SpecVariable[];
}

interface Normalized {
  collections: SpecCollection[];
  warnings: string[];
  blocking: string[];
}

function normalizeNative(document: any, options: Json): Normalized {
  const warnings: string[] = [];
  const blocking: string[] = [];
  if (!Array.isArray(document.collections)) {
    throw new Error(`native ${TOKEN_SCHEMA} documents need a collections array`);
  }
  if (document.collections.length > MAX_COLLECTIONS) {
    throw new Error(`the token document has ${document.collections.length} collections; the limit is ${MAX_COLLECTIONS}`);
  }
  const collections: SpecCollection[] = [];
  const seenCollections = new Set<string>();
  for (const [ci, rawCollection] of document.collections.entries()) {
    const path = `collections[${ci}]`;
    if (!isObj(rawCollection)) { blocking.push(`${path}: expected an object`); continue; }
    const name = String(rawCollection.name ?? "").trim();
    if (!name) { blocking.push(`${path}.name: required`); continue; }
    if (seenCollections.has(name)) { blocking.push(`${path}.name: duplicate collection "${name}"`); continue; }
    seenCollections.add(name);
    let modes: string[];
    try {
      modes = normalizeModes(rawCollection.modes, String(options.mode || "Mode 1"));
    } catch (e) {
      blocking.push(`${path}.modes: ${errMsg(e)}`);
      continue;
    }
    if (modes.length > MAX_MODES) {
      blocking.push(`${path}.modes: ${modes.length} modes; the limit is ${MAX_MODES}`);
      continue;
    }
    let defaultMode: string | undefined;
    if (rawCollection.defaultMode !== undefined) {
      defaultMode = String(rawCollection.defaultMode).trim();
      if (!modes.includes(defaultMode)) blocking.push(`${path}.defaultMode: "${defaultMode}" is not one of the collection modes`);
    }
    const rawVariables = rawCollection.variables === undefined ? [] : rawCollection.variables;
    if (!Array.isArray(rawVariables)) { blocking.push(`${path}.variables: expected an array`); continue; }
    if (rawVariables.length > MAX_VARIABLES) {
      blocking.push(`${path}.variables: ${rawVariables.length} variables; the limit is ${MAX_VARIABLES}`);
      continue;
    }
    const variables: SpecVariable[] = [];
    const seenVariables = new Set<string>();
    for (const [vi, rawVariable] of rawVariables.entries()) {
      const vpath = `${path}.variables[${vi}]`;
      if (!isObj(rawVariable)) { blocking.push(`${vpath}: expected an object`); continue; }
      const vname = String(rawVariable.name ?? "").trim();
      if (!vname) { blocking.push(`${vpath}.name: required`); continue; }
      if (seenVariables.has(vname)) { blocking.push(`${vpath}.name: duplicate variable "${vname}"`); continue; }
      seenVariables.add(vname);
      const type = normalizeType(rawVariable.type);
      if (!type) {
        blocking.push(`${vpath}.type: must be one of ${TOKEN_TYPES.join(", ")}`);
        continue;
      }
      if (rawVariable.description !== undefined && typeof rawVariable.description !== "string") {
        blocking.push(`${vpath}.description: must be a string`);
      }
      if (!isObj(rawVariable.values)) { blocking.push(`${vpath}.values: expected an object keyed by mode name`); continue; }
      const values: Record<string, SpecValue> = {};
      let valuesOk = true;
      for (const modeName of modes) {
        if (!Object.prototype.hasOwnProperty.call(rawVariable.values, modeName)) {
          blocking.push(`${vpath}.values: missing mode "${modeName}"`);
          valuesOk = false;
          continue;
        }
        const value = parseNativeValue(rawVariable.values[modeName], type, `${vpath}.values.${modeName}`, warnings, (m) => blocking.push(m));
        if (!value) valuesOk = false;
        else values[modeName] = value;
      }
      for (const extra of Object.keys(rawVariable.values)) {
        if (!modes.includes(extra)) {
          blocking.push(`${vpath}.values.${extra}: mode is not declared in ${path}.modes`);
          valuesOk = false;
        }
      }
      if (!valuesOk) continue;
      variables.push({
        name: vname,
        type,
        description: typeof rawVariable.description === "string" ? rawVariable.description : undefined,
        values,
      });
    }
    collections.push({ name, modes, defaultMode, variables });
  }
  return { collections, warnings, blocking };
}

function normalizeDtcg(document: any, options: Json): Normalized {
  const warnings: string[] = [];
  const blocking: string[] = [];
  const collectionName = String(options.collection || "Tokens").trim();
  const modeName = String(options.mode || "Mode 1").trim();
  if (!collectionName) throw new Error("collection cannot be empty");
  if (!modeName) throw new Error("mode cannot be empty");

  const variables: SpecVariable[] = [];
  const seen = new Set<string>();

  function walk(node: any, path: string[], inheritedType: string | undefined, depth: number): void {
    if (depth > MAX_DTCG_DEPTH) {
      blocking.push(`${path.join(".") || "$"}: DTCG nesting exceeds ${MAX_DTCG_DEPTH} levels`);
      return;
    }
    if (!isObj(node)) {
      blocking.push(`${path.join(".") || "$"}: expected a token or group object`);
      return;
    }
    const keys = Object.keys(node);
    const childKeys = keys.filter((k) => !k.startsWith("$"));
    if ("$value" in node) {
      if (childKeys.length) {
        blocking.push(`${path.join(".")}: a token cannot also have child tokens`);
        return;
      }
      const declared = node.$type === undefined ? inheritedType : String(node.$type);
      if (!declared) {
        blocking.push(`${path.join(".")}: missing $type (and no group $type to inherit)`);
        return;
      }
      const mapped = dtcgTypeToFigma(declared);
      if (!mapped) {
        blocking.push(`${path.join(".") || "$"}: $type "${declared}" is not supported by Figma variables (supported: color, number, dimension, string, boolean, fontFamily, fontWeight)`);
        return;
      }
      const name = path.join("/");
      if (!name) { blocking.push(`$: a token needs a name`); return; }
      if (seen.has(name)) { blocking.push(`${path.join(".")}: duplicate token path "${name}"`); return; }
      if (variables.length >= MAX_VARIABLES) {
        blocking.push(`${path.join(".")}: the DTCG tree exceeds ${MAX_VARIABLES} tokens`);
        return;
      }
      if (node.$description !== undefined && typeof node.$description !== "string") {
        blocking.push(`${path.join(".")}.$description: must be a string`);
      }
      const value = dtcgValue(node.$value, declared, path.join(".") || "$", warnings, (m) => blocking.push(m));
      if (!value) return;
      if (value.kind === "alias") value.collection = collectionName;
      seen.add(name);
      variables.push({
        name,
        type: mapped,
        description: typeof node.$description === "string" ? node.$description : undefined,
        values: { [modeName]: value },
      });
      return;
    }
    const nextType = node.$type === undefined ? inheritedType : String(node.$type);
    for (const key of childKeys) walk(node[key], [...path, key], nextType, depth + 1);
  }

  walk(document, [], document && document.$type ? String(document.$type) : undefined, 0);
  return { collections: [{ name: collectionName, modes: [modeName], variables }], warnings, blocking };
}

function dtcgTypeToFigma(type: string): TokenType | null {
  const s = String(type).trim().toLowerCase();
  if (s === "color") return "COLOR";
  if (s === "number" || s === "dimension" || s === "fontweight") return "FLOAT";
  if (s === "string" || s === "fontfamily") return "STRING";
  if (s === "boolean") return "BOOLEAN";
  return null;
}

function normalizeDocument(document: any, options: Json): Normalized {
  if (!isObj(document)) throw new Error("the token document must be a JSON object");
  // A DTCG group may legitimately contain a token named "collections" whose
  // value is an array; only a document with no DTCG markers is native.
  if (document.schema === TOKEN_SCHEMA) return normalizeNative(document, options);
  if (Array.isArray(document.collections) && document.$type === undefined && document.$value === undefined) {
    return normalizeNative(document, options);
  }
  return normalizeDtcg(document, options);
}

// ---------------------------------------------------------------- live state and fingerprints

interface LiveState {
  fileKey: string | null;
  fileName: string | null;
  collections: any[];
  variables: any[];
  collectionByName: Map<string, any>;
  variablesByCollection: Map<string, Map<string, any>>;
  variableById: Map<string, any>;
}

async function loadState(ctx: any): Promise<LiveState> {
  const api = ctx && ctx.variables;
  if (!api || typeof api.getLocalVariableCollectionsAsync !== "function" || typeof api.getLocalVariablesAsync !== "function") {
    throw new Error("TOKENS_UNAVAILABLE: the Variables API is not available in this session");
  }
  const collections = await api.getLocalVariableCollectionsAsync();
  const variables = await api.getLocalVariablesAsync();
  const collectionByName = new Map<string, any>();
  for (const c of collections) {
    if (!collectionByName.has(c.name)) collectionByName.set(c.name, c);
    else collectionByName.set(c.name, null);
  }
  const variablesByCollection = new Map<string, Map<string, any>>();
  const variableById = new Map<string, any>();
  for (const v of variables) {
    variableById.set(v.id, v);
    let map = variablesByCollection.get(v.variableCollectionId);
    if (!map) { map = new Map(); variablesByCollection.set(v.variableCollectionId, map); }
    map.set(v.name, map.has(v.name) ? null : v);
  }
  return {
    fileKey: ctx && typeof ctx.fileKey === "string" ? ctx.fileKey : null,
    fileName: ctx && ctx.root ? String(ctx.root.name ?? "") : null,
    collections,
    variables,
    collectionByName,
    variablesByCollection,
    variableById,
  };
}

function collectionModes(c: any): Array<{ modeId: string; name: string }> {
  return Array.isArray(c && c.modes) ? c.modes : [];
}

function modeName(c: any, modeId: string): string | null {
  const m = collectionModes(c).find((x) => x.modeId === modeId);
  return m ? m.name : null;
}

function fingerprintState(state: LiveState): string {
  const file = { key: state.fileKey, name: state.fileName };
  const collections = state.collections.map((c) => ({
    id: c.id,
    name: c.name,
    defaultModeId: c.defaultModeId ?? null,
    modes: collectionModes(c).map((m) => ({ modeId: m.modeId, name: m.name })),
  })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const variables = state.variables.map((v) => ({
    id: v.id,
    collectionId: v.variableCollectionId,
    name: v.name,
    type: v.resolvedType,
    description: v.description ?? "",
    values: v.valuesByMode ?? {},
  })).sort((a, b) => (a.collectionId + "/" + a.name < b.collectionId + "/" + b.name ? -1 : 1));
  return hashString(canonical({ file, collections, variables }));
}

// ---------------------------------------------------------------- planning

interface ModePlan {
  name: string;
  modeId: string | null;
  action: "existing" | "create";
}

interface CollectionPlan {
  spec: SpecCollection;
  existing: any | null;
  modes: ModePlan[];
  defaultModeName: string;
  extraModes: string[];
}

interface VariablePlan {
  spec: SpecVariable;
  collection: CollectionPlan;
  existing: any | null;
  action: "create" | "update" | "unchanged" | "delete";
  changes: {
    description?: { before: string; after: string };
    values: Record<string, { before: any; after: any }>;
  };
  fallbackModes: string[];
}

interface PlanInternal {
  state: LiveState;
  normalized: Normalized;
  collections: CollectionPlan[];
  variables: VariablePlan[];
  deletes: VariablePlan[];
  fingerprint: string;
}

interface BuildResult {
  internal: PlanInternal;
  publicPlan: Json;
}

function planValueSummary(v: SpecValue): any {
  if (v.kind === "remoteAlias") {
    return {
      alias: {
        ...(v.collection ? { collection: v.collection } : {}),
        ...(v.name ? { name: v.name } : {}),
        remote: true,
      },
    };
  }
  if (v.kind === "alias") return { alias: { collection: v.collection, name: v.name } };
  if (v.type === "COLOR") return colorHex(v.value);
  return v.value;
}

function expectedTargetRef(state: LiveState, v: SpecValue): any | null {
  if (v.kind !== "alias") return null;
  const collection = state.collectionByName.get(String(v.collection));
  if (!collection) return null;
  const map = state.variablesByCollection.get(collection.id);
  return map ? map.get(String(v.name)) || null : null;
}

function valueMatches(state: LiveState, existingValue: any, expected: SpecValue): boolean {
  if (expected.kind === "remoteAlias") return sameAlias(existingValue, String(expected.id));
  if (expected.kind === "alias") {
    const target = expectedTargetRef(state, expected);
    return !!target && sameAlias(existingValue, target.id);
  }
  if (expected.type === "COLOR") return sameColor(existingValue, expected.value);
  if (expected.type === "FLOAT") return sameNumber(existingValue, expected.value);
  return existingValue === expected.value;
}

function targetType(state: LiveState, normalized: Normalized, ref: SpecValue): TokenType | null {
  if (ref.kind === "remoteAlias") return null;
  if (ref.kind !== "alias") return ref.type || null;
  const targetCollection = normalized.collections.find((c) => c.name === ref.collection);
  if (targetCollection) {
    const spec = targetCollection.variables.find((v) => v.name === ref.name);
    if (spec) return spec.type;
  }
  const collection = state.collectionByName.get(String(ref.collection));
  if (!collection) return null;
  const map = state.variablesByCollection.get(collection.id);
  const existing = map ? map.get(String(ref.name)) : null;
  return existing ? (existing.resolvedType as TokenType) : null;
}

function aliasGraphCycle(state: LiveState, normalized: Normalized, changedKeys: Set<string>): string[] | null {
  // Build variable-level edges for every value changed by this import, then
  // follow existing aliases from those variables. A cycle in the resulting
  // reachable graph means Figma would be asked to create one.
  const edges = new Map<string, string[]>();
  const addEdge = (from: string, to: string) => {
    const list = edges.get(from) || [];
    list.push(to);
    edges.set(from, list);
  };
  const keyOf = (collection: string, name: string) => collection + "/" + name;
  for (const c of normalized.collections) {
    for (const v of c.variables) {
      const from = keyOf(c.name, v.name);
      for (const value of Object.values(v.values)) {
        if (value.kind === "alias") addEdge(from, keyOf(String(value.collection), String(value.name)));
      }
    }
  }
  // Existing aliases on variables that remain, so a new edge cannot close a
  // cycle through an untouched variable.
  for (const variable of state.variables) {
    const collection = state.collections.find((c) => c.id === variable.variableCollectionId);
    if (!collection) continue;
    const from = keyOf(collection.name, variable.name);
    for (const value of Object.values((variable.valuesByMode || {}) as Record<string, any>)) {
      if (isObj(value) && value.type === "VARIABLE_ALIAS") {
        const target = state.variableById.get(value.id);
        if (!target) continue;
        const targetCollection = state.collections.find((c) => c.id === target.variableCollectionId);
        if (targetCollection) addEdge(from, keyOf(targetCollection.name, target.name));
      }
    }
  }

  const visiting = new Set<string>();
  const done = new Set<string>();
  const stack: string[] = [];
  function visit(node: string): string[] | null {
    if (visiting.has(node)) {
      const at = stack.indexOf(node);
      return [...stack.slice(at), node];
    }
    if (done.has(node)) return null;
    visiting.add(node);
    stack.push(node);
    for (const next of edges.get(node) || []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(node);
    done.add(node);
    return null;
  }
  for (const from of changedKeys) {
    const cycle = visit(from);
    if (cycle) return cycle;
  }
  return null;
}

async function buildPlan(ctx: any, params: Json, opts: { diffOnly?: boolean } = {}): Promise<BuildResult> {
  const state = await loadState(ctx);
  const normalized = normalizeDocument(params.document, params);
  const warnings = [...normalized.warnings];
  const blocking = [...normalized.blocking];
  const collectionPlans: CollectionPlan[] = [];
  const variablePlans: VariablePlan[] = [];
  const changedKeys = new Set<string>();

  for (const spec of normalized.collections) {
    const existing = state.collectionByName.get(spec.name) || null;
    if (state.collectionByName.has(spec.name) && !existing) {
      blocking.push(`more than one local collection is named "${spec.name}"; rename one before syncing`);
      continue;
    }
    const existingModes = existing ? collectionModes(existing) : [];
    const byName = new Map(existingModes.map((m) => [m.name, m]));
    const modes: ModePlan[] = [];
    for (const name of spec.modes) {
      const found = byName.get(name);
      modes.push({ name, modeId: found ? found.modeId : null, action: found ? "existing" : "create" });
    }
    let defaultModeName = spec.defaultMode || spec.modes[0];
    if (!existing && spec.defaultMode && spec.defaultMode !== spec.modes[0]) {
      blocking.push(`${spec.name}: a new collection's first mode is its default; put "${spec.defaultMode}" first or omit defaultMode`);
    }
    if (existing) {
      const existingDefault = modeName(existing, existing.defaultModeId);
      if (existingDefault && spec.modes.includes(existingDefault) && !spec.defaultMode) defaultModeName = existingDefault;
      if (spec.defaultMode && existingDefault && existingDefault !== spec.defaultMode) {
        warnings.push(`${spec.name}: Figma keeps "${existingDefault}" as the collection default; "${spec.defaultMode}" is used only for this document's values`);
      }
    }
    const extraModes = existingModes.filter((m) => !spec.modes.includes(m.name)).map((m) => m.name);
    if (extraModes.length) {
      warnings.push(`${spec.name}: modes kept unchanged because the document does not name them: ${extraModes.join(", ")}`);
    }
    const cp: CollectionPlan = { spec, existing, modes, defaultModeName, extraModes };
    collectionPlans.push(cp);

    const variableMap = existing ? state.variablesByCollection.get(existing.id) : null;
    for (const vs of spec.variables) {
      const current = variableMap ? variableMap.get(vs.name) || null : null;
      if (variableMap && variableMap.has(vs.name) && !current) {
        blocking.push(`more than one local variable in "${spec.name}" is named "${vs.name}"; rename one before syncing`);
        continue;
      }
      if (current && current.resolvedType !== vs.type) {
        blocking.push(`${spec.name}/${vs.name}: existing type is ${current.resolvedType}, document says ${vs.type}; Figma cannot change a variable's type`);
        continue;
      }
      const changes: VariablePlan["changes"] = { values: {} };
      if (vs.description !== undefined) {
        const before = current ? String(current.description || "") : "";
        if (before !== vs.description) changes.description = { before, after: vs.description };
      }
      const runtimeModes = new Map<string, string>();
      for (const m of modes) if (m.modeId) runtimeModes.set(m.name, m.modeId);
      for (const [modeNameValue, expected] of Object.entries(vs.values)) {
        const modeId = runtimeModes.get(modeNameValue);
        if (!modeId) {
          changes.values[modeNameValue] = { before: null, after: planValueSummary(expected) };
          continue;
        }
        const before = current && current.valuesByMode ? current.valuesByMode[modeId] : undefined;
        if (!current || !valueMatches(state, before, expected)) {
          changes.values[modeNameValue] = {
            before: before === undefined ? null : before,
            after: planValueSummary(expected),
          };
        }
      }
      const action: VariablePlan["action"] = !current
        ? "create"
        : (Object.keys(changes.values).length || changes.description ? "update" : "unchanged");
      if (action !== "unchanged" && entryKey(spec.name, vs.name)) changedKeys.add(entryKey(spec.name, vs.name));
      const fallbackModes = action === "create" ? extraModes : [];
      variablePlans.push({ spec: vs, collection: cp, existing: current, action, changes, fallbackModes });
    }
  }

  // Aliases must point at a variable that will exist, and its type must match.
  // A remote/library alias cannot be bound by name through the Plugin API, so
  // it is only accepted where the live value already points at that exact id.
  for (const vp of variablePlans) {
    const modeIds = new Map(
      vp.collection.modes
        .filter((m) => !!m.modeId)
        .map((m) => [m.name, m.modeId as string]),
    );
    for (const [mode, value] of Object.entries(vp.spec.values)) {
      if (value.kind === "remoteAlias") {
        const modeId = modeIds.get(mode);
        const before = vp.existing && vp.existing.valuesByMode && modeId ? vp.existing.valuesByMode[modeId] : undefined;
        if (!modeId || !sameAlias(before, String(value.id))) {
          const label = value.collection && value.name ? `${value.collection}/${value.name} (${value.id})` : String(value.id);
          blocking.push(`${vp.collection.spec.name}/${vp.spec.name} (${mode}): remote/library alias ${label} cannot be bound by name; only an existing identical alias can be preserved`);
        }
        continue;
      }
      if (value.kind !== "alias") continue;
      const targetTypeValue = targetType(state, normalized, value);
      if (!targetTypeValue) {
        blocking.push(`${vp.collection.spec.name}/${vp.spec.name} (${mode}): alias target "${value.collection}/${value.name}" does not exist`);
      } else if (targetTypeValue !== vp.spec.type) {
        blocking.push(`${vp.collection.spec.name}/${vp.spec.name} (${mode}): alias target "${value.collection}/${value.name}" is ${targetTypeValue}, but this variable is ${vp.spec.type}`);
      }
    }
  }
  const cycle = aliasGraphCycle(state, normalized, changedKeys);
  if (cycle) blocking.push(`alias cycle: ${cycle.join(" -> ")}`);

  // Pruning is opt-in and only touches the collections named by the document.
  const deletes: VariablePlan[] = [];
  if (params.prune === true) {
    if (params.allowDestructive !== true) {
      const candidates = collectionPlans.reduce((n, cp) => {
        if (!cp.existing) return n;
        const map = state.variablesByCollection.get(cp.existing.id);
        if (!map) return n;
        const names = new Set(cp.spec.variables.map((v) => v.name));
        return n + [...map.values()].filter((v) => v && !names.has(v.name)).length;
      }, 0);
      if (candidates) blocking.push(`prune would delete ${candidates} variable(s); pass allowDestructive:true to confirm`);
    } else {
      const deleteKeys = new Set<string>();
      for (const cp of collectionPlans) {
        if (!cp.existing) continue;
        const map = state.variablesByCollection.get(cp.existing.id);
        if (!map) continue;
        const names = new Set(cp.spec.variables.map((v) => v.name));
        for (const v of map.values()) {
          if (!v || names.has(v.name)) continue;
          deleteKeys.add(v.id);
          deletes.push({
            spec: { name: v.name, type: v.resolvedType, values: {} },
            collection: cp,
            existing: v,
            action: "delete",
            changes: { values: {} },
            fallbackModes: [],
          });
        }
      }
      // A variable alias is the one dependency the import can see. Node
      // bindings cannot be enumerated cheaply; the apply report names that.
      for (const v of state.variables) {
        if (deleteKeys.has(v.id)) continue;
        for (const value of Object.values((v.valuesByMode || {}) as Record<string, any>)) {
          if (isObj(value) && value.type === "VARIABLE_ALIAS" && deleteKeys.has(value.id)) {
            const collection = state.collections.find((c) => c.id === v.variableCollectionId);
            blocking.push(`prune would delete ${collection ? collection.name + "/" : ""}${v.name}'s alias target; update or remove that alias first`);
          }
        }
      }
      if (deletes.length) {
        warnings.push(`${deletes.length} variable(s) will be deleted; node bindings to them will break`);
        const deleteIds = new Set(deletes.map((d) => d.existing.id));
        for (const vp of variablePlans) {
          for (const value of Object.values(vp.spec.values)) {
            if (value.kind !== "alias") continue;
            const target = expectedTargetRef(state, value);
            if (target && deleteIds.has(target.id)) {
              blocking.push(`${vp.collection.spec.name}/${vp.spec.name}: alias target ${value.collection}/${value.name} is being pruned`);
            }
          }
        }
      }
    }
  } else if (params.prune !== true) {
    const extras = collectionPlans.reduce((n, cp) => {
      if (!cp.existing) return n;
      const map = state.variablesByCollection.get(cp.existing.id);
      if (!map) return n;
      const names = new Set(cp.spec.variables.map((v) => v.name));
      return n + [...map.values()].filter((v) => v && !names.has(v.name)).length;
    }, 0);
    if (extras) warnings.push(`${extras} existing variable(s) are not in the document; prune:false keeps them`);
  }

  const internal: PlanInternal = {
    state,
    normalized: { collections: normalized.collections, warnings, blocking },
    collections: collectionPlans,
    variables: variablePlans,
    deletes,
    fingerprint: fingerprintState(state),
  };
  return { internal, publicPlan: publicPlan(internal, params, opts, warnings, blocking) };
}

function entryKey(collection: string, name: string): string {
  return collection + "/" + name;
}

function publicPlan(internal: PlanInternal, params: Json, opts: { diffOnly?: boolean }, warnings: string[], blocking: string[]): Json {
  const maxChanges = Math.max(1, Math.min(Number(params.maxChanges) || 500, 5000));
  const changes: Json[] = [];
  let totalChanges = 0;
  let truncated = false;
  const push = (change: Json) => {
    totalChanges++;
    if (changes.length >= maxChanges) { truncated = true; return; }
    changes.push(change);
  };
  const collectionCounts = { create: 0, existing: 0, modesCreate: 0, extraModes: 0 };
  for (const cp of internal.collections) {
    collectionCounts[cp.existing ? "existing" : "create"]++;
    collectionCounts.modesCreate += cp.modes.filter((m) => m.action === "create").length;
    collectionCounts.extraModes += cp.extraModes.length;
    if (!cp.existing) {
      push({ kind: "collection", action: "create", collection: cp.spec.name, modes: cp.spec.modes, defaultMode: cp.defaultModeName });
    }
    // A new collection already carries its modes in the collection change.
    if (cp.existing) for (const mode of cp.modes) {
      if (mode.action === "create") push({ kind: "mode", action: "create", collection: cp.spec.name, mode: mode.name });
    }
  }
  const variableCounts = { create: 0, update: 0, delete: 0, unchanged: 0 };
  for (const vp of internal.variables) {
    variableCounts[vp.action]++;
    if (vp.action === "unchanged") continue;
    push({
      kind: "variable",
      action: vp.action,
      collection: vp.collection.spec.name,
      name: vp.spec.name,
      type: vp.spec.type,
      ...(vp.changes.description ? { description: vp.changes.description } : {}),
      ...(Object.keys(vp.changes.values).length ? { values: vp.changes.values } : {}),
      ...(vp.fallbackModes.length ? { fillsUnmanagedModes: vp.fallbackModes } : {}),
    });
  }
  for (const vp of internal.deletes) {
    variableCounts.delete++;
    push({ kind: "variable", action: "delete", collection: vp.collection.spec.name, name: vp.spec.name, type: vp.spec.type, id: vp.existing.id });
  }
  return {
    status: opts.diffOnly ? "diff" : "dry_run",
    schema: TOKEN_SCHEMA,
    dryRun: !opts.diffOnly,
    summary: {
      collections: collectionCounts,
      variables: variableCounts,
      changes: totalChanges,
      truncated,
    },
    changes,
    fingerprint: internal.fingerprint,
    warnings,
    blocking,
    ms: { plan: 0 },
  };
}

// ---------------------------------------------------------------- export

async function resolveAliasForExport(ctx: any, state: LiveState, id: string, cache: Map<string, any>): Promise<any | null> {
  if (state.variableById.has(id)) return state.variableById.get(id);
  if (cache.has(id)) return cache.get(id);
  let found: any = null;
  try {
    if (ctx.variables && typeof ctx.variables.getVariableByIdAsync === "function") {
      found = await ctx.variables.getVariableByIdAsync(id);
    }
  } catch { found = null; }
  cache.set(id, found);
  return found;
}

async function resolveAliasCollectionForExport(ctx: any, state: LiveState, target: any, cache: Map<string, any>): Promise<any | null> {
  const local = state.collections.find((c) => c.id === target.variableCollectionId);
  if (local) return { collection: local, remote: false };
  if (cache.has(target.variableCollectionId)) return cache.get(target.variableCollectionId);
  let remote: any = null;
  try {
    if (ctx.variables && typeof ctx.variables.getVariableCollectionByIdAsync === "function") {
      remote = await ctx.variables.getVariableCollectionByIdAsync(target.variableCollectionId);
    }
  } catch { remote = null; }
  const result = remote && remote.name ? { collection: remote, remote: true } : null;
  cache.set(target.variableCollectionId, result);
  return result;
}

export async function exportTokens(ctx: any, params: Json = {}): Promise<Json> {
  const t0 = Date.now();
  const state = await loadState(ctx);
  const warnings: string[] = [];
  const aliasCache = new Map<string, any>();
  const aliasCollectionCache = new Map<string, any>();
  const collections: Json[] = [];
  let skipped = 0;
  for (const collection of [...state.collections].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const modes = collectionModes(collection);
    const variables: Json[] = [];
    const seenNames = new Set<string>();
    for (const variable of state.variables
      .filter((v) => v.variableCollectionId === collection.id)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (seenNames.has(variable.name)) {
        warnings.push(`${collection.name}/${variable.name}: more than one local variable has this name; both are exported and an import will refuse the duplicate`);
      }
      seenNames.add(variable.name);
      if (!TYPE_SET.has(variable.resolvedType)) {
        warnings.push(`${collection.name}/${variable.name}: type ${variable.resolvedType} is not a colour, number, string or boolean; skipped`);
        skipped++;
        continue;
      }
      const values: Json = {};
      for (const mode of modes) {
        const raw = variable.valuesByMode ? variable.valuesByMode[mode.modeId] : undefined;
        if (raw === undefined) {
          warnings.push(`${collection.name}/${variable.name}: mode "${mode.name}" has no value`);
          values[mode.name] = null;
          continue;
        }
        if (isObj(raw) && raw.type === "VARIABLE_ALIAS") {
          const target = await resolveAliasForExport(ctx, state, raw.id, aliasCache);
          if (!target) {
            warnings.push(`${collection.name}/${variable.name}: alias target ${raw.id} is not readable; kept as a remote id`);
            values[mode.name] = { alias: { variableId: raw.id, remote: true } };
            continue;
          }
          const targetCollection = await resolveAliasCollectionForExport(ctx, state, target, aliasCollectionCache);
          if (!targetCollection) {
            warnings.push(`${collection.name}/${variable.name}: alias target ${target.name} is outside this file and its collection name is not readable; kept as a remote id`);
            values[mode.name] = { alias: { variableId: raw.id, remote: true } };
            continue;
          }
          if (targetCollection.remote) {
            warnings.push(`${collection.name}/${variable.name}: alias target ${target.name} is in a remote/library collection; exported with remote:true and its id so an unchanged value can be preserved, but it cannot be rebound by name`);
            values[mode.name] = {
              alias: {
                collection: targetCollection.collection.name,
                name: target.name,
                remote: true,
                id: raw.id,
              },
            };
            continue;
          }
          if (!TYPE_SET.has(target.resolvedType)) {
            warnings.push(`${collection.name}/${variable.name}: alias target ${target.name} has type ${target.resolvedType}, which this format cannot carry; value set to null`);
            values[mode.name] = null;
            continue;
          }
          values[mode.name] = {
            alias: {
              collection: targetCollection.collection.name,
              name: target.name,
            },
          };
          continue;
        }
        if (variable.resolvedType === "COLOR") {
          if (!colorChannels(raw)) {
            warnings.push(`${collection.name}/${variable.name}: mode "${mode.name}" is not an RGBA colour; value set to null`);
            values[mode.name] = null;
          } else values[mode.name] = colorHex(raw);
        } else if (variable.resolvedType === "FLOAT") {
          if (typeof raw !== "number" || !Number.isFinite(raw)) {
            warnings.push(`${collection.name}/${variable.name}: mode "${mode.name}" is not a finite number; value set to null`);
            values[mode.name] = null;
          } else values[mode.name] = raw;
        } else if (variable.resolvedType === "STRING") {
          if (typeof raw !== "string") {
            warnings.push(`${collection.name}/${variable.name}: mode "${mode.name}" is not a string; value set to null`);
            values[mode.name] = null;
          } else values[mode.name] = raw;
        } else if (variable.resolvedType === "BOOLEAN") {
          if (typeof raw !== "boolean") {
            warnings.push(`${collection.name}/${variable.name}: mode "${mode.name}" is not true/false; value set to null`);
            values[mode.name] = null;
          } else values[mode.name] = raw;
        } else values[mode.name] = raw;
      }
      variables.push({
        name: variable.name,
        type: variable.resolvedType,
        ...(variable.description ? { description: variable.description } : {}),
        values,
      });
    }
    collections.push({
      name: collection.name,
      modes: modes.map((m) => m.name),
      defaultMode: modeName(collection, collection.defaultModeId) || modes[0]?.name,
      variables,
    });
  }
  const document = {
    schema: TOKEN_SCHEMA,
    file: { name: ctx && ctx.root ? ctx.root.name : null, key: ctx ? ctx.fileKey ?? null : null },
    collections,
  };
  return {
    status: "exported",
    schema: TOKEN_SCHEMA,
    document,
    counts: {
      collections: collections.length,
      variables: collections.reduce((n, c) => n + c.variables.length, 0),
      modes: collections.reduce((n, c) => n + c.modes.length, 0),
      skipped,
    },
    warnings,
    ms: { export: Date.now() - t0 },
  };
}

// ---------------------------------------------------------------- apply

function figmaValue(vp: VariablePlan, value: SpecValue, runtimeByKey: Map<string, any>, ctx: any): any {
  if (value.kind === "remoteAlias") {
    throw new Error("a remote/library alias cannot be created by name; it can only be preserved when already present");
  }
  if (value.kind === "alias") {
    const target = runtimeByKey.get(entryKey(String(value.collection), String(value.name)));
    if (!target) throw new Error(`alias target ${value.collection}/${value.name} was not created`);
    return ctx.variables && typeof ctx.variables.createVariableAlias === "function"
      ? ctx.variables.createVariableAlias(target)
      : { type: "VARIABLE_ALIAS", id: target.id };
  }
  if (value.type === "COLOR") return figmaColor(parseColor(value.value));
  return value.value;
}

function compareLiveValue(state: LiveState, raw: any, expected: SpecValue): boolean {
  if (expected.kind === "remoteAlias") return sameAlias(raw, String(expected.id));
  if (expected.kind === "alias") {
    const target = expectedTargetRef(state, expected);
    return !!target && sameAlias(raw, target.id);
  }
  if (expected.type === "COLOR") return sameColor(raw, expected.value);
  if (expected.type === "FLOAT") return sameNumber(raw, expected.value);
  return raw === expected.value;
}

export async function runTokens(ctx: any, params: Json = {}): Promise<Json> {
  const action = String(params.action || "export");
  if (action === "export") return exportTokens(ctx, params);
  if (action !== "diff" && action !== "import") throw new Error(`unknown token action "${action}"; use export, diff or import`);
  const t0 = Date.now();
  const { internal, publicPlan: publicDoc } = await buildPlan(ctx, params, { diffOnly: action === "diff" });
  publicDoc.ms = { plan: Date.now() - t0 };
  if (action === "diff") return publicDoc;

  const dryRun = params.dryRun !== false;
  if (dryRun) return publicDoc;
  if (typeof params.expectedFingerprint !== "string" || !params.expectedFingerprint) {
    throw new Error("TOKENS_FINGERPRINT_REQUIRED: apply needs the expectedFingerprint returned by the dry run");
  }
  if (internal.fingerprint !== params.expectedFingerprint) {
    return {
      status: "refused",
      reason: "TOKENS_PLAN_CHANGED",
      schema: TOKEN_SCHEMA,
      dryRun: false,
      expectedFingerprint: params.expectedFingerprint,
      fingerprint: internal.fingerprint,
      warnings: ["the live variable state changed since the dry run; re-run with dryRun:true"],
      ms: { plan: Date.now() - t0, total: Date.now() - t0 },
    };
  }
  if (internal.normalized.blocking.length) {
    throw new Error(`TOKENS_IMPORT_BLOCKED: ${internal.normalized.blocking.slice(0, 8).join("; ")}`);
  }
  const work = internal.collections.some((c) => !c.existing || c.modes.some((m) => m.action === "create")) ||
    internal.variables.some((v) => v.action === "create" || v.action === "update") || internal.deletes.length > 0;
  if (!work) {
    return {
      ...publicDoc,
      status: "noop",
      dryRun: false,
      ms: { plan: Date.now() - t0, total: Date.now() - t0 },
    };
  }

  let wrote = false;
  const mark = () => { if (!wrote) { ctx.commitUndo(); wrote = true; } };
  ctx.commitUndo();
  const applyT0 = Date.now();
  const runtimeByKey = new Map<string, any>();
  const runtimeCollections = new Map<string, any>();
  for (const collection of internal.state.collections) {
    const map = internal.state.variablesByCollection.get(collection.id);
    if (!map) continue;
    for (const variable of map.values()) {
      if (variable) runtimeByKey.set(entryKey(collection.name, variable.name), variable);
    }
  }
  try {
    // 1. Collections and modes.
    for (const cp of internal.collections) {
      let collection = cp.existing;
      if (!collection) {
        mark();
        collection = ctx.variables.createVariableCollection(cp.spec.name);
        const first = collectionModes(collection)[0];
        if (first && first.name !== cp.modes[0].name) collection.renameMode(first.modeId, cp.modes[0].name);
      }
      runtimeCollections.set(cp.spec.name, collection);
      const byName = new Map(collectionModes(collection).map((m) => [m.name, m]));
      for (const mode of cp.modes) {
        if (mode.modeId) continue;
        const found = byName.get(mode.name);
        if (found) { mode.modeId = found.modeId; continue; }
        mark();
        mode.modeId = collection.addMode(mode.name);
      }
      // Point every mode at the id the collection actually has now.
      for (const mode of cp.modes) {
        const found = collectionModes(collection).find((m) => m.modeId === mode.modeId || m.name === mode.name);
        if (found) mode.modeId = found.modeId;
      }
    }

    // 2. Create variables first so every alias target has an id.
    for (const vp of internal.variables) {
      const collection = runtimeCollections.get(vp.collection.spec.name);
      if (!collection) throw new Error(`collection ${vp.collection.spec.name} was not created`);
      if (vp.action === "create") {
        mark();
        vp.existing = ctx.variables.createVariable(vp.spec.name, collection, vp.spec.type);
      }
      if (vp.existing) runtimeByKey.set(entryKey(vp.collection.spec.name, vp.spec.name), vp.existing);
    }

    // 3. Values and descriptions. New variables also need a value in modes the
    // document does not manage; the collection's default/first managed mode is
    // the only honest fallback, and the plan names those modes.
    for (const vp of internal.variables) {
      if (vp.action !== "create" && vp.action !== "update") continue;
      const collection = runtimeCollections.get(vp.collection.spec.name);
      if (!collection) continue;
      const modeIds = new Map(collectionModes(collection).map((m) => [m.name, m.modeId]));
      const values: Array<[string, SpecValue]> = Object.entries(vp.spec.values);
      if (vp.action === "create" && vp.fallbackModes.length) {
        const fallback = vp.spec.values[vp.collection.defaultModeName] || values[0]?.[1];
        if (fallback) for (const extra of vp.fallbackModes) values.push([extra, fallback]);
      }
      for (const [mode, value] of values) {
        const modeId = modeIds.get(mode);
        if (!modeId) continue;
        if (value.kind === "remoteAlias") continue;
        mark();
        vp.existing.setValueForMode(modeId, figmaValue(vp, value, runtimeByKey, ctx));
      }
      if (vp.spec.description !== undefined) {
        mark();
        vp.existing.description = vp.spec.description;
      }
    }

    // 4. Opt-in deletions last.
    for (const vp of internal.deletes) {
      mark();
      vp.existing.remove();
    }

    ctx.commitUndo();

    // 5. Read back every value from a fresh state, never from the plan.
    const after = await loadState(ctx);
    const problems: string[] = [];
    for (const cp of internal.collections) {
      const collection = after.collectionByName.get(cp.spec.name);
      if (!collection) { problems.push(`collection "${cp.spec.name}" is missing`); continue; }
      const modes = new Map(collectionModes(collection).map((m) => [m.name, m.modeId]));
      for (const mode of cp.modes) if (!modes.has(mode.name)) problems.push(`${cp.spec.name}: mode "${mode.name}" is missing`);
    }
    for (const vp of internal.deletes) {
      const collection = after.collectionByName.get(vp.collection.spec.name);
      if (!collection) continue;
      const map = after.variablesByCollection.get(collection.id);
      if (map && map.has(vp.spec.name)) problems.push(`${vp.collection.spec.name}/${vp.spec.name}: still exists after prune`);
    }
    for (const vp of internal.variables) {
      const collection = after.collectionByName.get(vp.collection.spec.name);
      if (!collection) continue;
      const map = after.variablesByCollection.get(collection.id);
      const live = map ? map.get(vp.spec.name) : null;
      if (!live) { problems.push(`${vp.collection.spec.name}/${vp.spec.name}: variable is missing`); continue; }
      if (live.resolvedType !== vp.spec.type) problems.push(`${vp.collection.spec.name}/${vp.spec.name}: type is ${live.resolvedType}, expected ${vp.spec.type}`);
      if (vp.spec.description !== undefined && String(live.description || "") !== vp.spec.description) {
        problems.push(`${vp.collection.spec.name}/${vp.spec.name}: description is not the requested one`);
      }
      const modes = new Map(collectionModes(collection).map((m) => [m.name, m.modeId]));
      const verifyValues: Array<[string, SpecValue]> = Object.entries(vp.spec.values);
      if (vp.action === "create" && vp.fallbackModes.length) {
        const fallback = vp.spec.values[vp.collection.defaultModeName] || Object.values(vp.spec.values)[0];
        if (fallback) for (const extra of vp.fallbackModes) verifyValues.push([extra, fallback]);
      }
      for (const [mode, expected] of verifyValues) {
        const modeId = modes.get(mode);
        if (!modeId) { problems.push(`${vp.collection.spec.name}/${vp.spec.name}: mode "${mode}" is missing`); continue; }
        if (!compareLiveValue(after, live.valuesByMode ? live.valuesByMode[modeId] : undefined, expected)) {
          problems.push(`${vp.collection.spec.name}/${vp.spec.name} (${mode}): value does not match the document`);
        }
      }
    }
    if (problems.length) {
      throw new Error(`TOKENS_VERIFICATION_FAILED: ${problems.slice(0, 8).join("; ")}`);
    }
    return {
      ...publicDoc,
      status: "applied",
      dryRun: false,
      verification: { ok: true, problems: [] },
      ms: { plan: publicDoc.ms.plan, apply: Date.now() - applyT0, total: Date.now() - t0 },
    };
  } catch (e) {
    let rolledBack = false;
    if (wrote) {
      try {
        ctx.commitUndo();
        ctx.triggerUndo();
        rolledBack = true;
      } catch {
        // The document may contain a partial import. Saying "rolled back" here
        // would be worse than the failure itself.
      }
    }
    const suffix = !wrote ? "" : rolledBack
      ? " (rolled back)"
      : " (ROLLBACK FAILED; the document may contain partial changes — inspect before retrying)";
    throw new Error(errMsg(e) + suffix);
  }
}
