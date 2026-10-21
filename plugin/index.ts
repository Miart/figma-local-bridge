/// <reference types="@figma/plugin-typings" />

/**
 * A compact page index and a node search.
 *
 * `get_metadata` is the right tool for one subtree; it is the wrong tool for
 * "where is the score label?" on a page with a thousand layers. This walks the
 * page once, keeps only the fields an agent searches by (id, stable key, name,
 * type, path, text) and returns either the whole flat index or the matches.
 *
 * Neither function writes. Both stop at a node cap and say they truncated,
 * instead of quietly returning a partial answer that looks complete.
 */

import { BUILD_DATA, KEY_DATA } from "./ui-build";

export const INDEX_SCHEMA = "index-v1";
export const SEARCH_SCHEMA = "search-v1";

type Json = any;

const TRUNC_TEXT = 160;
const MAX_QUERY = 256;

function textOf(node: any): string {
  try {
    return typeof node.characters === "string" ? node.characters : "";
  } catch {
    return "";
  }
}

function keyOf(node: any): string {
  try { return node.getPluginData(KEY_DATA) || ""; } catch { return ""; }
}

function buildOf(node: any): string {
  try { return node.getPluginData(BUILD_DATA) || ""; } catch { return ""; }
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

function sizeOf(node: any): [number, number] | null {
  const width = Number(node.width);
  const height = Number(node.height);
  return Number.isFinite(width) && Number.isFinite(height) ? [Math.round(width), Math.round(height)] : null;
}

function info(node: any, depth: number, builtRoot: any, includeText: boolean): Json {
  const out: Json = {
    id: node.id,
    key: keyOf(node),
    name: node.name,
    type: node.type,
    path: pathOf(node),
    depth,
    visible: node.visible !== false,
    size: sizeOf(node),
    childCount: Array.isArray(node.children) ? node.children.length : 0,
  };
  if (builtRoot) out.build = { id: builtRoot.id, name: builtRoot.name, buildId: buildOf(builtRoot) };
  if (includeText && node.type === "TEXT") out.text = textOf(node).slice(0, TRUNC_TEXT);
  // Deliberately no `component` field for INSTANCE. This manifest declares
  // documentAccess: "dynamic-page", where the synchronous `node.mainComponent`
  // getter THROWS (and logs to Figma's console even when caught). Resolving it
  // with `getMainComponentAsync()` for every instance would turn a cheap index
  // into one round trip per instance. `figma_inspect` and `flb.main` answer the
  // question for a single node, where the cost is justified.
  return out;
}

function normalizeRoot(ctx: any, params: Json): any {
  return params.rootNodeId ? ctx.getNodeByIdAsync(String(params.rootNodeId)) : Promise.resolve(ctx.currentPage);
}

function cap(value: any, fallback: number, min: number, max: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n)) throw new Error(`maxNodes/maxResults must be a number`);
  return Math.max(min, Math.min(Math.floor(n), max));
}

export async function runIndex(ctx: any, params: Json = {}): Promise<Json> {
  const t0 = Date.now();
  const root = await normalizeRoot(ctx, params);
  if (!root || root.removed === true) throw new Error(`index root not found: ${params.rootNodeId || "current page"}`);
  const includeHidden = params.includeHidden === true;
  const includeText = params.includeText === true;
  const maxNodes = cap(params.maxNodes, 1000, 1, 20000);
  const maxDepth = params.maxDepth === undefined ? Infinity : Math.max(0, Math.floor(Number(params.maxDepth)));
  const nodes: Json[] = [];
  const byType: Record<string, number> = {};
  let scanned = 0;
  let truncated = false;

  const visit = (node: any, depth: number, builtRoot: any) => {
    if (truncated) return;
    if (!includeHidden && node.visible === false) return;
    scanned++;
    if (scanned > maxNodes) {
      truncated = true;
      return;
    }
    const ownBuild = buildOf(node);
    const activeBuild = ownBuild ? node : builtRoot;
    nodes.push(info(node, depth, activeBuild, includeText));
    byType[node.type] = (byType[node.type] || 0) + 1;
    if (depth >= maxDepth) return;
    for (const child of node.children || []) visit(child, depth + 1, activeBuild);
  };

  // The page is the scope, not a layer in it. Listing it would put "Page 1" at
  // the top of every index and make depth mean two different things.
  if (root.type === "PAGE") {
    for (const child of root.children || []) visit(child, 0, buildOf(child) ? child : null);
  } else {
    visit(root, 0, buildOf(root) ? root : null);
  }
  return {
    schema: INDEX_SCHEMA,
    scope: { id: root.id, name: root.name, type: root.type, path: pathOf(root) },
    nodes,
    counts: { nodes: nodes.length, byType },
    settings: { includeHidden, includeText, maxNodes, maxDepth: Number.isFinite(maxDepth) ? maxDepth : null },
    truncated,
    warnings: truncated ? [`node cap ${maxNodes} reached; ask for a subtree or raise maxNodes`] : [],
    ms: { index: Date.now() - t0 },
  };
}

function makeMatcher(query: string, mode: string, caseSensitive: boolean): RegExp {
  if (mode === "substring") {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, caseSensitive ? "" : "i");
  }
  if (mode === "regex") {
    try {
      return new RegExp(query, caseSensitive ? "" : "i");
    } catch (e: any) {
      throw new Error(`invalid regex: ${e && e.message ? e.message : e}`);
    }
  }
  if (mode === "glob") {
    const escaped = query.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`, caseSensitive ? "" : "i");
  }
  throw new Error(`mode must be substring, regex or glob`);
}

function snippet(text: string, match: RegExp): string {
  const m = match.exec(text);
  if (!m) return text.slice(0, TRUNC_TEXT);
  const start = Math.max(0, m.index - 40);
  const end = Math.min(text.length, m.index + m[0].length + 60);
  return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function normalizeTypes(value: any): Set<string> | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || !value.length) throw new Error("types must be a non-empty array of node types");
  return new Set(value.map((v) => String(v).toUpperCase()));
}

export async function runSearch(ctx: any, params: Json = {}): Promise<Json> {
  const t0 = Date.now();
  const root = await normalizeRoot(ctx, params);
  if (!root || root.removed === true) throw new Error(`search root not found: ${params.rootNodeId || "current page"}`);

  const query = params.query === undefined ? "" : String(params.query);
  if (query.length > MAX_QUERY) throw new Error(`query is ${query.length} characters; the limit is ${MAX_QUERY}`);
  const mode = params.mode === undefined ? "substring" : String(params.mode);
  const caseSensitive = params.caseSensitive === true;
  const fields = params.fields === undefined ? ["name", "key", "text"] : params.fields.map((f: any) => String(f));
  const allowedFields = new Set(["name", "key", "text"]);
  for (const f of fields) if (!allowedFields.has(f)) throw new Error(`unknown search field "${f}"; use name, key or text`);
  const types = normalizeTypes(params.types);
  const keyPrefix = params.keyPrefix === undefined ? null : String(params.keyPrefix);
  const hasKey = params.hasKey === undefined ? null : params.hasKey === true;
  const includeHidden = params.includeHidden !== false;
  const maxNodes = cap(params.maxNodes, 10000, 1, 50000);
  const maxResults = cap(params.maxResults, 50, 1, 500);
  const matcher = query ? makeMatcher(query, mode, caseSensitive) : null;
  if (!matcher && !types && keyPrefix === null && hasKey === null) {
    throw new Error("search needs a query, types, keyPrefix or hasKey so it does not return the whole page by accident");
  }

  const matches: Json[] = [];
  const byField: Record<string, number> = {};
  const byType: Record<string, number> = {};
  let scanned = 0;
  let truncated = false;
  let resultsTruncated = 0;

  const visit = (node: any, depth: number, builtRoot: any) => {
    if (truncated) return;
    if (!includeHidden && node.visible === false) return;
    scanned++;
    if (scanned > maxNodes) {
      truncated = true;
      return;
    }
    const ownBuild = buildOf(node);
    const activeBuild = ownBuild ? node : builtRoot;
    if (!types || types.has(String(node.type))) {
      const key = keyOf(node);
      const name = String(node.name || "");
      const text = textOf(node);
      const matched: string[] = [];
      if (matcher && fields.includes("name") && matcher.test(name)) matched.push("name");
      if (matcher && fields.includes("key") && key && matcher.test(key)) matched.push("key");
      if (matcher && fields.includes("text") && text && matcher.test(text)) matched.push("text");
      const filtersOk =
        (keyPrefix === null || key.startsWith(keyPrefix)) &&
        (hasKey === null || (hasKey ? key.length > 0 : key.length === 0)) &&
        (!matcher || matched.length > 0);
      if (filtersOk) {
        const out = info(node, depth, activeBuild, false);
        out.matchedIn = matched;
        if (text) out.text = text.slice(0, TRUNC_TEXT);
        if (matched.includes("text")) out.snippet = snippet(text, matcher as RegExp);
        for (const f of matched) byField[f] = (byField[f] || 0) + 1;
        byType[node.type] = (byType[node.type] || 0) + 1;
        if (matches.length < maxResults) matches.push(out);
        else resultsTruncated++;
      }
    }
    for (const child of node.children || []) visit(child, depth + 1, activeBuild);
  };

  if (root.type === "PAGE") {
    for (const child of root.children || []) visit(child, 0, buildOf(child) ? child : null);
  } else {
    visit(root, 0, buildOf(root) ? root : null);
  }
  return {
    schema: SEARCH_SCHEMA,
    scope: { id: root.id, name: root.name, type: root.type, path: pathOf(root) },
    query: { text: query, mode, caseSensitive, fields },
    filters: { types: types ? [...types] : null, keyPrefix, hasKey, includeHidden },
    matches,
    counts: { matches: matches.length + resultsTruncated, listed: matches.length, byField, byType, scanned },
    truncated,
    resultsTruncated,
    warnings: [
      ...(truncated ? [`node cap ${maxNodes} reached; narrow the root or raise maxNodes`] : []),
      ...(resultsTruncated ? [`${resultsTruncated} more matches were counted but not listed (maxResults ${maxResults})`] : []),
    ],
    ms: { search: Date.now() - t0 },
  };
}
