/// <reference types="@figma/plugin-typings" />

/**
 * A readable snapshot of the file's local design system.
 *
 * This is deliberately not another search box: the sync workflow needs a
 * stable, comparable shape. Styles, variables (with modes and values) and
 * components are returned in one document so a server-side diff can say what
 * changed since the last export, by stable key — not by "the name is still
 * there".
 */

export const DESIGN_SYSTEM_SCHEMA = "design-system-v1";

type Json = any;

const KINDS = ["styles", "variables", "components"] as const;
type Kind = (typeof KINDS)[number];
const KIND_SET = new Set<string>(KINDS);

function clone(v: any): any {
  if (v === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return String(v);
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

const errMsg = (e: any) => String(e && e.message ? e.message : e);

function normalizedKinds(value: any): Set<Kind> {
  if (value === undefined) return new Set(KINDS);
  if (!Array.isArray(value) || !value.length) throw new Error("include must be a non-empty array of styles, variables, components");
  const out = new Set<Kind>();
  for (const k of value) {
    const s = String(k);
    if (!KIND_SET.has(s)) throw new Error(`unknown design-system kind "${s}"; use styles, variables or components`);
    out.add(s as Kind);
  }
  return out;
}

function styleEntry(style: any, kind: string): Json {
  const out: Json = {
    kind,
    id: style.id,
    key: style.key || null,
    name: style.name,
    type: style.type,
    description: style.description || "",
  };
  if (style.paints !== undefined) out.paints = clone(style.paints);
  if (style.fontName !== undefined) out.fontName = clone(style.fontName);
  if (style.fontSize !== undefined) out.fontSize = style.fontSize;
  if (style.lineHeight !== undefined) out.lineHeight = clone(style.lineHeight);
  if (style.letterSpacing !== undefined) out.letterSpacing = clone(style.letterSpacing);
  if (style.textCase !== undefined && style.textCase !== "ORIGINAL") out.textCase = style.textCase;
  if (style.textDecoration !== undefined && style.textDecoration !== "NONE") out.textDecoration = style.textDecoration;
  if (style.paragraphSpacing !== undefined) out.paragraphSpacing = style.paragraphSpacing;
  if (style.paragraphIndent !== undefined) out.paragraphIndent = style.paragraphIndent;
  if (style.effects !== undefined) out.effects = clone(style.effects);
  if (style.layoutGrids !== undefined) out.layoutGrids = clone(style.layoutGrids);
  return out;
}

function variableEntry(v: any, collections: Map<string, any>): Json {
  const collection = collections.get(v.variableCollectionId) || null;
  return {
    id: v.id,
    key: v.key || null,
    name: v.name,
    collectionId: v.variableCollectionId,
    collection: collection ? collection.name : null,
    resolvedType: v.resolvedType,
    description: v.description || "",
    hiddenFromPublishing: v.hiddenFromPublishing === true,
    scopes: clone(v.scopes),
    codeSyntax: clone(v.codeSyntax),
    valuesByMode: clone(v.valuesByMode),
  };
}

function componentEntry(node: any): Json {
  const out: Json = {
    id: node.id,
    key: safe(() => node.key || null, null),
    name: node.name,
    type: node.type,
    description: safe(() => node.description || "", ""),
    page: safe(() => {
      let p = node.parent;
      while (p && p.type !== "PAGE") p = p.parent;
      return p ? p.name : null;
    }, null),
  };
  try {
    const defs = node.componentPropertyDefinitions;
    if (defs && Object.keys(defs).length) {
      out.properties = Object.keys(defs).map((name) => {
        const d = defs[name] || {};
        const p: Json = { name, type: d.type };
        if (d.defaultValue !== undefined) p.defaultValue = clone(d.defaultValue);
        if (d.variantOptions) p.variantOptions = clone(d.variantOptions);
        if (d.preferredValues) p.preferredValues = clone(d.preferredValues);
        return p;
      });
    }
  } catch {
    /* a component whose definitions cannot be read is still listed */
  }
  return out;
}

export async function runDesignSystem(ctx: any, params: Json = {}): Promise<Json> {
  const t0 = Date.now();
  const include = normalizedKinds(params.include);
  const maxItems = Math.max(1, Math.min(Number(params.maxItems === undefined ? 2000 : params.maxItems), 20000));
  if (!Number.isFinite(maxItems)) throw new Error("maxItems must be a number");
  const out: Json = { styles: [], variables: [], components: [] };
  const warnings: string[] = [];
  let truncated = false;
  let listed = 0;
  const take = (): boolean => {
    if (listed >= maxItems) {
      truncated = true;
      return false;
    }
    listed++;
    return true;
  };

  if (include.has("styles")) {
    const styles: Array<[string, () => Promise<any[]>]> = [
      ["paint", () => ctx.getLocalPaintStylesAsync()],
      ["text", () => ctx.getLocalTextStylesAsync()],
      ["effect", () => ctx.getLocalEffectStylesAsync()],
      ["grid", () => ctx.getLocalGridStylesAsync()],
    ];
    for (const [kind, load] of styles) {
      if (truncated) break;
      let items: any[] = [];
      try {
        items = await load();
      } catch (e) {
        warnings.push(`${kind} styles could not be read: ${errMsg(e)}`);
        continue;
      }
      for (const style of items) {
        if (!take()) break;
        out.styles.push(styleEntry(style, kind));
      }
    }
  }

  if (include.has("variables") && !truncated) {
    try {
      const collections = await ctx.variables.getLocalVariableCollectionsAsync();
      const byId = new Map<string, any>();
      for (const c of collections) byId.set(c.id, c);
      const variables = await ctx.variables.getLocalVariablesAsync();
      for (const v of variables) {
        if (!take()) break;
        out.variables.push(variableEntry(v, byId));
      }
    } catch (e) {
      warnings.push(`variables could not be read: ${errMsg(e)}`);
    }
  }

  if (include.has("components") && !truncated) {
    let components: any[] = [];
    try {
      components = ctx.root.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] });
    } catch (e) {
      components = [];
      warnings.push(`components could not be read: ${errMsg(e)}`);
    }
    for (const c of components) {
      if (!take()) break;
      out.components.push(componentEntry(c));
    }
  }

  return {
    schema: DESIGN_SYSTEM_SCHEMA,
    file: { name: safe(() => ctx.root.name, null), key: safe(() => ctx.fileKey, null) },
    include: [...include],
    styles: out.styles,
    variables: out.variables,
    components: out.components,
    counts: {
      styles: out.styles.length,
      variables: out.variables.length,
      components: out.components.length,
      total: listed,
    },
    truncated,
    warnings: [
      ...(truncated ? [`item cap ${maxItems} reached; narrow include or raise maxItems`] : []),
      ...warnings,
    ],
    ms: { inventory: Date.now() - t0 },
  };
}
