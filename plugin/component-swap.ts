/// <reference types="@figma/plugin-typings" />

/**
 * Component swap: replace an INSTANCE's main component without quietly
 * detaching its overrides.
 *
 * `InstanceNode.swapComponent` preserves overrides with the same heuristics as
 * the editor, but those heuristics are not a contract: Figma may change them,
 * a different component may not have the same layers, and a layer that moved
 * can end up on the wrong sibling. This module therefore treats the swap as a
 * migration with a compatibility report:
 *
 *   1. Read the instance the way a checkpoint does: its main component, its
 *      component properties and every direct per-layer override.
 *   2. Resolve the requested component BEFORE writing and compare the two
 *      structures. An override path is exact index+name first, then a unique
 *      name in the new component (reported as remapped). A changed node type,
 *      a missing layer, a changed nested component or a dropped component
 *      property is a named loss.
 *   3. Refuse to apply a lossy or unverified swap unless the caller says
 *      allowLoss / allowUnverified, and refuse a document that moved since the
 *      dry run (expectedFingerprints).
 *   4. Apply in one undo transaction: swap, restore the root-level instance
 *      overrides that are not on main (name, size, opacity, paints, layout),
 *      map component properties by display name and type, replay the layer
 *      overrides, then verify the main component landed.
 *
 * What this deliberately does NOT do: it does not invent a component property
 * whose name or type changed, does not apply a layer override to a different
 * node type, does not touch an instance nested inside another instance (that is
 * an override of the outer instance, not an independent swap), and does not
 * claim that a library component's structure was checked when it was not.
 */

import { hashString, snapshot, STRICT } from "./fingerprint";
import {
  applyInstanceOverrideState,
  applyInstanceOverrides,
  readInstance,
  readMeta,
  readState,
} from "./checkpoint";

export const SWAP_SCHEMA = "component-swap-v1";
export const MAX_TARGETS = 50;
const MAX_NODES = 4000;
const MAX_DETAILS = 80;

type Json = any;
type Dict = Record<string, any>;

const isObj = (v: any) => !!v && typeof v === "object" && !Array.isArray(v);
const errMsg = (e: any) => String(e && e.message ? e.message : e);

function canon(v: any): any {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    const out: Dict = {};
    for (const k of Object.keys(v).sort()) out[k] = canon(v[k]);
    return out;
  }
  if (typeof v === "symbol") return String(v);
  return v;
}

function same(a: any, b: any): boolean {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

function baseName(key: string): string {
  const raw = String(key || "");
  const hash = raw.lastIndexOf("#");
  return hash > 0 ? raw.slice(0, hash) : raw;
}

function pathLabel(path: any): string {
  if (!Array.isArray(path)) return "(no path)";
  return path.map((s: any) => (s && typeof s.name === "string" && s.name ? s.name : `#${s?.index}`)).join(" / ");
}

function mainRef(main: any): Json {
  return main
    ? { id: main.id, key: main.key ?? null, name: main.name, remote: main.remote === true }
    : null;
}

function componentFingerprint(component: any): string {
  let parent: Json = null;
  try {
    if (component.parent && component.parent.type === "COMPONENT_SET") {
      parent = {
        id: component.parent.id,
        key: component.parent.key ?? null,
        name: component.parent.name,
        componentPropertyDefinitions: component.parent.componentPropertyDefinitions ?? null,
      };
    }
  } catch { /* the component itself is still fingerprintable */ }
  return hashString(JSON.stringify(canon({
    id: component.id,
    key: component.key ?? null,
    name: component.name,
    remote: component.remote === true,
    type: component.type,
    parent,
    variantProperties: component.variantProperties ?? null,
    componentPropertyDefinitions: component.componentPropertyDefinitions ?? null,
    meta: readMeta(component) ?? null,
    snapshot: snapshot(component, STRICT).hash,
  })));
}

function targetContext(node: any): Json {
  const out: Json = { parent: null, insideInstance: false, insideComponent: false };
  try {
    let parent = node.parent;
    if (parent) out.parent = { id: parent.id, type: parent.type };
    let guard = 0;
    while (parent && guard++ < 256) {
      if (parent.type === "INSTANCE") out.insideInstance = true;
      if (parent.type === "COMPONENT") out.insideComponent = true;
      parent = parent.parent;
    }
  } catch { /* an unreadable parent is still better than no fingerprint */ }
  return out;
}

function instanceFingerprint(instance: any, main: any): string {
  let properties: any = null;
  try { properties = instance.componentProperties ?? null; } catch { /* unreadable */ }
  let meta: any = null;
  try { meta = readMeta(instance) ?? null; } catch { /* unreadable */ }
  // The semantic snapshot deliberately leaves layout and placement properties
  // out. A swap restores those root-level fields, so they are part of the
  // fingerprint too: editing padding, constraints or sizing after the dry run
  // must force another dry run instead of quietly applying a stale plan.
  let rootState: any = null;
  try {
    const rs = readState(instance);
    rootState = { size: rs.size };
    for (const group of Object.keys(ROOT_STATE_FIELDS)) {
      if (rs[group] !== undefined) rootState[group] = rs[group];
    }
  } catch { /* the snapshot still covers the visual half */ }
  return hashString(JSON.stringify(canon({
    snapshot: snapshot(instance, STRICT).hash,
    name: instance.name,
    context: targetContext(instance),
    main: main ? { ref: mainRef(main), fingerprint: componentFingerprint(main) } : null,
    properties,
    meta: meta ?? null,
    rootState,
  })));
}

/**
 * The instance half is always comparable. The target half is added only when
 * the target component is known: an unverified library key must not make the
 * dry-run fingerprint impossible to satisfy after the import. The composite
 * value is what `expectedFingerprints` carries, so a rename, a property edit or
 * a changed target component is refused before the first write.
 */
function swapFingerprint(instance: any, main: any, target: any): { value: string; instance: string; target: string | null } {
  const inst = instanceFingerprint(instance, main);
  const tgt = target ? componentFingerprint(target) : null;
  return {
    value: tgt ? hashString(JSON.stringify(canon({ instance: inst, target: tgt }))) : inst,
    instance: inst,
    target: tgt,
  };
}

function newReport(): Json {
  return {
    dryRun: false,
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
    plannedLosses: [],
    notes: [],
  };
}

const REPORT_ARRAYS = [
  "skipped", "fontsUnavailable", "bindingsDropped", "bindingsRestored", "bindingsMissing",
  "overridesRestored", "overridesMissing", "overridesUnsupported", "modesRestored", "modesMissing",
  "stylesRestored", "stylesMissing", "propertiesFailed", "plannedLosses", "notes",
];

function mergeReport(into: Json, from: Json): void {
  for (const key of REPORT_ARRAYS) {
    if (Array.isArray(from?.[key])) into[key].push(...from[key]);
  }
  into.removed += Number(from?.removed) || 0;
  into.created += Number(from?.created) || 0;
}

// ---------------------------------------------------------------- document search

async function allPages(ctx: any): Promise<any[]> {
  try {
    if (typeof ctx.loadAllPagesAsync === "function") await ctx.loadAllPagesAsync();
  } catch {
    /* a dynamic-page document may refuse; the current page still works */
  }
  try {
    const pages = [...ctx.root.children];
    if (pages.length) return pages;
  } catch {
    /* fall through */
  }
  return ctx.currentPage ? [ctx.currentPage] : [];
}

function walk(node: any, visit: (n: any) => void): void {
  if (!node) return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

async function findComponents(ctx: any, pred: (n: any) => boolean): Promise<any[]> {
  const out: any[] = [];
  for (const page of await allPages(ctx)) walk(page, (n) => { if (pred(n)) out.push(n); });
  return out;
}

async function findComponentByKey(ctx: any, key: string): Promise<any | null> {
  const hits = await findComponents(ctx, (n) => n.type === "COMPONENT" && n.key === key);
  return hits[0] || null;
}

async function findComponentSetByKey(ctx: any, key: string): Promise<any | null> {
  const hits = await findComponents(ctx, (n) => n.type === "COMPONENT_SET" && n.key === key);
  return hits[0] || null;
}

async function findComponentsByName(ctx: any, name: string): Promise<any[]> {
  return findComponents(ctx, (n) => n.type === "COMPONENT" && n.name === name);
}

async function findComponentSetsByName(ctx: any, name: string): Promise<any[]> {
  return findComponents(ctx, (n) => n.type === "COMPONENT_SET" && n.name === name);
}

// ---------------------------------------------------------------- component resolution

function variantLabel(component: any): string {
  try {
    return JSON.stringify(component.variantProperties || {});
  } catch {
    return component.name;
  }
}

function pickVariant(set: any, properties: any): { node: any; warning: string } {
  if (!set || set.type !== "COMPONENT_SET") throw new Error("variantProperties need a COMPONENT_SET");
  const variants = (set.children || []).filter((c: any) => c.type === "COMPONENT");
  if (!variants.length) throw new Error(`component set "${set.name}" has no variant COMPONENTs`);
  if (!isObj(properties) || !Object.keys(properties).length) {
    const node = set.defaultVariant || variants[0];
    return {
      node,
      warning: `no variantProperties given; using the default variant ${variantLabel(node)} of "${set.name}"`,
    };
  }
  const matches = variants.filter((c: any) => {
    const vp = c.variantProperties || {};
    return Object.keys(properties).every((k) => String(vp[k]) === String(properties[k]));
  });
  if (!matches.length) {
    throw new Error(
      `no variant of "${set.name}" matches ${JSON.stringify(properties)}; available: ${variants.map(variantLabel).join(", ")}`,
    );
  }
  if (matches.length > 1) {
    throw new Error(`variantProperties ${JSON.stringify(properties)} match more than one component in "${set.name}"`);
  }
  return { node: matches[0], warning: "" };
}

async function resolveComponentRef(ctx: any, ref: Json, apply: boolean): Promise<Json> {
  const modes = ["componentId", "componentKey", "componentName", "componentSetId", "componentSetKey"].filter(
    (k) => ref && ref[k] !== undefined && ref[k] !== null && ref[k] !== "",
  );
  if (modes.length !== 1) {
    throw new Error("give exactly one of componentId, componentKey, componentName, componentSetId or componentSetKey");
  }
  const mode = modes[0];
  if (ref.variantProperties !== undefined && !isObj(ref.variantProperties)) {
    throw new Error("variantProperties must be an object of property name -> value");
  }
  if (ref.variantProperties !== undefined && !["componentSetId", "componentSetKey", "componentName"].includes(mode)) {
    throw new Error("variantProperties can only be used with componentSetId, componentSetKey or a component-set name");
  }

  const requested = {
    componentId: ref.componentId ?? null,
    componentKey: ref.componentKey ?? null,
    componentName: ref.componentName ?? null,
    componentSetId: ref.componentSetId ?? null,
    componentSetKey: ref.componentSetKey ?? null,
    variantProperties: ref.variantProperties ?? null,
  };

  let node: any = null;
  let set: any = null;
  let imported = false;
  let warning = "";
  let unresolved = "";
  let viaSet = false;

  if (mode === "componentId") {
    node = await ctx.getNodeByIdAsync(String(ref.componentId));
    if (!node || node.removed === true) throw new Error(`componentId ${ref.componentId} was not found`);
    if (node.type === "COMPONENT_SET") throw new Error(`componentId ${ref.componentId} is a COMPONENT_SET; use componentSetId`);
    if (node.type !== "COMPONENT") throw new Error(`componentId ${ref.componentId} is ${node.type}, not COMPONENT`);
  } else if (mode === "componentSetId") {
    set = await ctx.getNodeByIdAsync(String(ref.componentSetId));
    if (!set || set.removed === true) throw new Error(`componentSetId ${ref.componentSetId} was not found`);
    if (set.type !== "COMPONENT_SET") throw new Error(`componentSetId ${ref.componentSetId} is ${set.type}, not COMPONENT_SET`);
    const picked = pickVariant(set, ref.variantProperties);
    node = picked.node;
    warning = picked.warning;
    viaSet = true;
  } else if (mode === "componentKey") {
    const local = await findComponentByKey(ctx, String(ref.componentKey));
    if (local) {
      node = local;
    } else if (apply) {
      if (typeof ctx.importComponentByKeyAsync !== "function") {
        throw new Error("this Figma session cannot import a component by key");
      }
      try {
        node = await ctx.importComponentByKeyAsync(String(ref.componentKey));
      } catch (e) {
        throw new Error(`cannot import componentKey ${ref.componentKey}: ${errMsg(e)}`);
      }
      if (!node || node.type !== "COMPONENT") {
        throw new Error(`componentKey ${ref.componentKey} did not resolve to a COMPONENT`);
      }
      imported = true;
    } else {
      unresolved = `componentKey ${ref.componentKey} is not in this file; a dry run cannot prove it exists or compare its structure`;
    }
  } else if (mode === "componentSetKey") {
    const local = await findComponentSetByKey(ctx, String(ref.componentSetKey));
    if (local) {
      set = local;
    } else if (apply) {
      if (typeof ctx.importComponentSetByKeyAsync !== "function") {
        throw new Error("this Figma session cannot import a component set by key");
      }
      try {
        set = await ctx.importComponentSetByKeyAsync(String(ref.componentSetKey));
      } catch (e) {
        throw new Error(`cannot import componentSetKey ${ref.componentSetKey}: ${errMsg(e)}`);
      }
      if (!set || set.type !== "COMPONENT_SET") {
        throw new Error(`componentSetKey ${ref.componentSetKey} did not resolve to a COMPONENT_SET`);
      }
      imported = true;
    } else {
      unresolved = `componentSetKey ${ref.componentSetKey} is not in this file; a dry run cannot prove it exists or compare its structure`;
    }
    if (set && !unresolved) {
      const picked = pickVariant(set, ref.variantProperties);
      node = picked.node;
      warning = picked.warning;
      viaSet = true;
    }
  } else {
    const name = String(ref.componentName);
    const components = await findComponentsByName(ctx, name);
    if (components.length === 1) {
      node = components[0];
    } else if (components.length > 1) {
      throw new Error(
        `componentName "${name}" is ambiguous; candidates: ${components
          .map((c: any) => `${c.id}${c.key ? ` (${c.key})` : ""}`)
          .join(", ")}`,
      );
    } else {
      const sets = await findComponentSetsByName(ctx, name);
      if (sets.length === 1) {
        set = sets[0];
        const picked = pickVariant(set, ref.variantProperties);
        node = picked.node;
        warning = picked.warning;
        viaSet = true;
      } else if (sets.length > 1) {
        throw new Error(`componentName "${name}" matches more than one component set`);
      } else {
        throw new Error(`no local COMPONENT or COMPONENT_SET is named "${name}"`);
      }
    }
    if (node && ref.variantProperties !== undefined && !viaSet) {
      throw new Error("variantProperties can only be used when componentName names a COMPONENT_SET");
    }
  }

  if (unresolved) {
    warning = unresolved + "; apply with allowUnverified:true to import it, and expect the compatibility report to be unchecked";
  }
  return { node, set, imported, via: mode, warning, unresolved: unresolved || null, requested };
}

// ---------------------------------------------------------------- target resolution

async function loadTargets(ctx: any, nodeIds: string[]): Promise<{ items: any[]; warnings: string[] }> {
  const seen = new Set<string>();
  const items: any[] = [];
  const warnings: string[] = [];
  for (const id of nodeIds) {
    if (seen.has(id)) {
      warnings.push(`target ${id} was listed more than once; the duplicate is ignored`);
      continue;
    }
    seen.add(id);
    const node = await ctx.getNodeByIdAsync(id);
    if (!node || node.removed === true) {
      items.push({ id, error: `target ${id} was not found` });
      continue;
    }
    if (node.type !== "INSTANCE") {
      items.push({ id, error: `target ${id} is ${node.type}, not INSTANCE` });
      continue;
    }
    let parent = node.parent;
    let insideInstance = false;
    let insideComponent = false;
    while (parent) {
      if (parent.type === "INSTANCE") insideInstance = true;
      if (parent.type === "COMPONENT") insideComponent = true;
      parent = parent.parent;
    }
    if (insideInstance) {
      items.push({
        id,
        error: `target ${id} is an instance inside another INSTANCE; swapping it is an override of the outer instance, not an independent swap`,
      });
      continue;
    }
    let main: any = null;
    try {
      main = typeof node.getMainComponentAsync === "function" ? await node.getMainComponentAsync() : node.mainComponent;
    } catch (e) {
      items.push({ id, error: `target ${id}: cannot read its main component (${errMsg(e)})` });
      continue;
    }
    if (!main) {
      items.push({ id, error: `target ${id} has no main component` });
      continue;
    }
    items.push({ id, instance: node, main, insideComponent });
  }
  return { items, warnings };
}

// ---------------------------------------------------------------- structure matching

function resolvePath(root: any, path: any): { node: any; path: any[]; remapped: boolean; chain: any[] } | null {
  if (!root || !Array.isArray(path) || !path.length) return null;
  let node = root;
  let remapped = false;
  const out: any[] = [];
  const chain: any[] = [];
  for (const step of path) {
    const index = step?.index;
    if (!Number.isInteger(index)) return null;
    const children = Array.isArray(node.children) ? node.children : [];
    let child = children[index];
    let chosen = index;
    if (!child || (typeof step.name === "string" && step.name && child.name !== step.name)) {
      if (!step.name) return null;
      const matches: Array<{ child: any; index: number }> = [];
      for (let i = 0; i < children.length; i++) {
        if (children[i]?.name === step.name) matches.push({ child: children[i], index: i });
      }
      if (matches.length !== 1) return null;
      chosen = matches[0].index;
      child = matches[0].child;
      remapped = true;
    }
    if (!child) return null;
    out.push({ name: child.name, index: chosen });
    chain.push(child);
    node = child;
  }
  return { node, path: out, remapped, chain };
}

const RISK_KINDS = new Set([
  "override-missing",
  "override-old-path-missing",
  "override-type-changed",
  "override-nested-component-changed",
  "override-unresolved",
  "override-unsupported",
]);

async function mainOf(node: any): Promise<any> {
  try {
    return typeof node.getMainComponentAsync === "function" ? await node.getMainComponentAsync() : node.mainComponent;
  } catch {
    return null;
  }
}

async function chainProblem(oldChain: any[], newChain: any[]): Promise<Json | null> {
  if (!Array.isArray(oldChain) || !Array.isArray(newChain) || oldChain.length !== newChain.length) {
    return { kind: "override-missing", why: "the layer path has a different depth in the new component" };
  }
  for (let i = 0; i < oldChain.length; i++) {
    const a = oldChain[i];
    const b = newChain[i];
    if (a?.type !== b?.type) {
      return {
        kind: "override-type-changed",
        fromType: a?.type ?? "unknown",
        toType: b?.type ?? "unknown",
        why: "a layer on the path changed its node type",
      };
    }
    // A descendant override can sit below a nested INSTANCE. If that nested
    // instance now points at another component, a path that happens to have the
    // same indices and names is not the same layer anymore.
    if (a?.type === "INSTANCE") {
      const oldMain = await mainOf(a);
      const newMain = await mainOf(b);
      const sameMain = oldMain && newMain &&
        (oldMain.id === newMain.id || (oldMain.key && oldMain.key === newMain.key));
      if (!sameMain) {
        return {
          kind: "override-nested-component-changed",
          from: mainRef(oldMain),
          to: mainRef(newMain),
          why: "a nested instance on the path now points at a different component; the old descendant override was dropped instead of being applied to the wrong layer",
        };
      }
    }
  }
  return null;
}

async function remapOverrides(
  records: any[],
  oldRoot: any,
  newRoot: any,
  basePath: string,
): Promise<{ records: any[]; details: Json[] }> {
  const out: any[] = [];
  const details: Json[] = [];
  if (!Array.isArray(records)) return { records: out, details };
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec || typeof rec !== "object") continue;
    const at = `${basePath}[${i}]`;
    if (typeof rec.unresolved === "string") {
      details.push({ kind: "override-unresolved", path: at, why: rec.unresolved });
      continue;
    }
    const oldRes = resolvePath(oldRoot, rec.path);
    if (!oldRes) {
      details.push({ kind: "override-old-path-missing", path: at, layer: pathLabel(rec.path), why: "the layer path no longer matches the old main component" });
      continue;
    }
    const newRes = resolvePath(newRoot, rec.path);
    if (!newRes) {
      details.push({
        kind: "override-missing",
        path: at,
        layer: pathLabel(rec.path),
        fromType: oldRes.node.type,
        why: "no layer at that index and no unique layer with that name in the new component",
      });
      continue;
    }
    const pathProblem = await chainProblem(oldRes.chain, newRes.chain);
    if (pathProblem) {
      details.push({
        ...pathProblem,
        path: at,
        layer: pathLabel(rec.path),
        fields: Array.isArray(rec.fields) ? rec.fields.length : 0,
      });
      continue;
    }
    if (newRes.node.type !== oldRes.node.type) {
      details.push({
        kind: "override-type-changed",
        path: at,
        layer: pathLabel(rec.path),
        fromType: oldRes.node.type,
        toType: newRes.node.type,
        fields: Array.isArray(rec.fields) ? rec.fields.length : 0,
      });
      continue;
    }
    const next: Json = { ...rec, path: newRes.path };
    if (newRes.remapped) {
      details.push({ kind: "override-remapped", path: at, layer: pathLabel(rec.path), from: rec.path, to: newRes.path });
    }
    if (Array.isArray(rec.unsupported) && rec.unsupported.length) {
      details.push({ kind: "override-unsupported", path: at, layer: pathLabel(rec.path), fields: rec.unsupported });
    }
    if (rec.state?.instance && newRes.node.type === "INSTANCE") {
      let oldNestedMain: any = null;
      let newNestedMain: any = null;
      try {
        oldNestedMain = typeof oldRes.node.getMainComponentAsync === "function"
          ? await oldRes.node.getMainComponentAsync()
          : oldRes.node.mainComponent;
      } catch { /* named below */ }
      try {
        newNestedMain = typeof newRes.node.getMainComponentAsync === "function"
          ? await newRes.node.getMainComponentAsync()
          : newRes.node.mainComponent;
      } catch { /* named below */ }
      const sameNested = oldNestedMain && newNestedMain &&
        (oldNestedMain.id === newNestedMain.id || (oldNestedMain.key && oldNestedMain.key === newNestedMain.key));
      if (sameNested) {
        const nested = await remapOverrides(rec.state.instance.overrides || [], oldNestedMain, newNestedMain, `${at}.instance.overrides`);
        next.state = { ...rec.state, instance: { ...rec.state.instance, overrides: nested.records } };
        details.push(...nested.details);
      } else if (rec.state.instance.overrides?.length || rec.state.instance.properties) {
        details.push({
          kind: "override-nested-component-changed",
          path: at,
          layer: pathLabel(rec.path),
          from: mainRef(oldNestedMain),
          to: mainRef(newNestedMain),
          why: "the nested instance now points at a different component; its old properties and overrides were dropped instead of being applied to the wrong layers",
        });
        next.state = {
          ...rec.state,
          instance: { ...rec.state.instance, overrides: undefined, properties: undefined },
        };
      }
    }
    out.push(next);
  }
  return { records: out, details };
}

// ---------------------------------------------------------------- component properties

async function planProperties(ctx: any, instance: any, newMain: any): Promise<Json> {
  let oldProps: Json = {};
  try {
    oldProps = instance.componentProperties || {};
  } catch {
    oldProps = {};
  }
  let defs: Json = {};
  try {
    // A variant COMPONENT can expose an empty own definition map while the
    // definitions live on its COMPONENT_SET parent. Merge instead of letting
    // the empty object shadow the parent.
    const own = newMain.componentPropertyDefinitions || {};
    const parentDefs = newMain.parent?.componentPropertyDefinitions || {};
    defs = { ...parentDefs, ...own };
  } catch {
    defs = {};
  }
  const byBase = new Map<string, Array<{ key: string; def: any }>>();
  for (const [key, def] of Object.entries(defs as Dict)) {
    const type = String((def as any)?.type || "");
    if (type === "VARIANT") continue;
    const base = baseName(key);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base)!.push({ key, def });
  }

  const replayable: Json[] = [];
  const dropped: Json[] = [];
  const variant: Json[] = [];
  const values: Dict = {};
  const entries = Object.entries(oldProps as Dict);
  for (const [key, raw] of entries) {
    const prop = raw && typeof raw === "object" ? raw : { value: raw };
    const type = String((prop as any).type || "");
    const value = (prop as any).value;
    const base = baseName(key);
    if (type === "VARIANT") {
      variant.push({ name: base, value });
      continue;
    }
    if (type === "SLOT") {
      dropped.push({ name: base, type, why: "SLOT component properties cannot be set through the Plugin API" });
      continue;
    }
    const candidates = byBase.get(base) || [];
    if (!candidates.length) {
      dropped.push({ name: base, type: type || "unknown", why: "the new component has no property with that display name" });
      continue;
    }
    let match: { key: string; def: any } | null = null;
    if (type) {
      const sameType = candidates.filter((c) => String(c.def?.type || "") === type);
      if (sameType.length === 1) match = sameType[0];
      else if (sameType.length > 1) {
        dropped.push({ name: base, type, why: "more than one new property has that display name and type" });
        continue;
      }
    } else if (candidates.length === 1) {
      match = candidates[0];
    }
    if (!match) {
      dropped.push({
        name: base,
        type: type || "unknown",
        why: `the property exists but its type changed (new type: ${candidates.map((c) => c.def?.type || "unknown").join(", ")})`,
      });
      continue;
    }
    if (value === undefined || value === null) {
      dropped.push({ name: base, type: type || String(match.def?.type || "unknown"), why: "the old instance had no value for this property" });
      continue;
    }
    if (String(match.def?.type || type) === "INSTANCE_SWAP") {
      if (typeof value !== "string" || !value) {
        dropped.push({ name: base, type: "INSTANCE_SWAP", why: "the old instance had no component selected" });
        continue;
      }
      let selected: any = null;
      try { selected = await ctx.getNodeByIdAsync(value); } catch { /* named below */ }
      if (!selected || selected.removed === true || selected.type !== "COMPONENT") {
        dropped.push({ name: base, type: "INSTANCE_SWAP", why: "the component selected in the old instance no longer exists" });
        continue;
      }
    }
    replayable.push({ name: base, from: key, to: match.key, type: type || String(match.def?.type || "unknown"), value });
    values[match.key] = value;
  }
  return { total: entries.length, replayable, dropped, variant, values };
}

// ---------------------------------------------------------------- root overrides

const ROOT_STATE_FIELDS: Record<string, string[]> = {
  rotation: ["rotation"],
  visible: ["visible"],
  locked: ["locked"],
  opacity: ["opacity"],
  blendMode: ["blendMode"],
  isMask: ["isMask"],
  maskType: ["isMask", "maskType"],
  clipsContent: ["clipsContent"],
  fills: ["fills"],
  strokes: ["strokes"],
  strokeWeight: ["strokeWeight"],
  strokeAlign: ["strokeAlign"],
  strokeCap: ["strokeCap"],
  strokeJoin: ["strokeJoin"],
  dashPattern: ["dashPattern"],
  cornerRadius: ["cornerRadius"],
  effects: ["effects"],
  layoutGrids: ["layoutGrids"],
  exportSettings: ["exportSettings"],
  layout: [
    "layoutMode", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "itemSpacing",
    "primaryAxisAlignItems", "counterAxisAlignItems", "primaryAxisSizingMode", "counterAxisSizingMode",
    "layoutWrap", "counterAxisSpacing", "strokesIncludedInLayout", "itemReverseZIndex",
  ],
  sizing: ["layoutSizingHorizontal", "layoutSizingVertical"],
  layoutAlign: ["layoutAlign"],
  layoutGrow: ["layoutGrow"],
  layoutPositioning: ["layoutPositioning"],
  constraints: ["constraints"],
  minSize: ["minWidth", "minHeight"],
  maxSize: ["maxWidth", "maxHeight"],
};

const ROOT_STATE_KEYS = Object.keys(ROOT_STATE_FIELDS);

function planRootOverrides(instance: any, main: any, preserveRoot: boolean, preserveSize: boolean): Json {
  if (!preserveRoot) {
    return { fields: [], state: undefined, meta: undefined, name: null, size: "adopted", skipped: ["all root-level overrides"] };
  }
  let instanceState: Dict = {};
  let mainState: Dict = {};
  try { instanceState = readState(instance); } catch { instanceState = {}; }
  try { mainState = readState(main); } catch { mainState = {}; }

  const fields = new Set<string>();
  const skipped: string[] = [];
  for (const key of ROOT_STATE_KEYS) {
    if (same(instanceState[key], mainState[key])) continue;
    for (const field of ROOT_STATE_FIELDS[key] || []) fields.add(field);
  }

  let size = "inherited";
  if (!same(instanceState.size, mainState.size)) {
    if (preserveSize) {
      fields.add("width");
      fields.add("height");
      size = "preserved";
    } else {
      size = "adopted";
      skipped.push("size");
    }
  }

  let name: string | null = null;
  if (instance.name !== main.name) name = instance.name;

  const meta = readMeta(instance) || {};
  const styleIds: Dict = { ...((meta as any).styleIds || {}) };
  for (const field of ["fillStyleId", "strokeStyleId", "effectStyleId", "textStyleId"]) {
    if (!(field in instance) || !(field in main)) continue;
    if (instance[field] === main[field]) continue;
    styleIds[field] = typeof instance[field] === "string" ? instance[field] : "";
    fields.add(field);
  }
  if (Object.keys(styleIds).length) (meta as any).styleIds = styleIds;

  return {
    fields: [...fields],
    state: instanceState,
    meta,
    name,
    size,
    skipped,
  };
}

async function applyRootOverrides(instance: any, root: Json, ctx: any, report: Json, path: string): Promise<void> {
  if (!root) return;
  if (typeof root.name === "string" && root.name !== instance.name) {
    try {
      instance.name = root.name;
    } catch (e) {
      report.notes.push(`${path}: name not restored: ${errMsg(e)}`);
    }
  }
  const fields = (root.fields || []).filter((f: string) => f !== "name");
  if (!fields.length) return;
  await applyInstanceOverrideState(instance, { fields, state: root.state, meta: root.meta }, ctx, report, path);
}

function applyMappedProperties(instance: any, values: Dict | undefined, report: Json, path: string): void {
  if (!isObj(values)) return;
  for (const [key, value] of Object.entries(values as Dict)) {
    if (typeof instance.setProperties !== "function") {
      report.propertiesFailed.push({ path, name: baseName(key), why: "this instance has no setProperties method" });
      continue;
    }
    try {
      instance.setProperties({ [key]: value });
    } catch (e) {
      report.propertiesFailed.push({ path, name: baseName(key), why: errMsg(e) });
    }
  }
}

// ---------------------------------------------------------------- planning

function lossSummary(plan: Json, limit = 8): string {
  const out: string[] = [];
  for (const target of plan.targets || []) {
    for (const loss of target.compatibility?.losses || []) {
      out.push(`${target.nodeId}: ${loss.kind}${loss.layer ? ` (${loss.layer})` : ""}${loss.why ? ` — ${loss.why}` : ""}`);
      if (out.length >= limit) return out.join("; ");
    }
  }
  return out.join("; ");
}

async function buildPlan(ctx: any, params: Json, opts: { apply?: boolean; resolved?: Json; dryRun?: boolean } = {}): Promise<Json> {
  const t0 = Date.now();
  const resolved = opts.resolved || await resolveComponentRef(ctx, params, opts.apply === true);
  const targetResult = await loadTargets(ctx, params.nodeIds || []);
  const blocking: Json[] = [];
  const warnings: string[] = [...targetResult.warnings];
  if (resolved.warning) warnings.push(resolved.warning);
  const publicTargets: Json[] = [];
  const internalTargets: Json[] = [];

  for (const item of targetResult.items) {
    if (item.error) {
      blocking.push({ nodeId: item.id, why: item.error });
      continue;
    }
    const instance = item.instance;
    const oldMain = item.main;
    if (item.insideComponent) {
      warnings.push(`${item.id} is inside a COMPONENT; the swap changes that component's definition, not only an instance on the page`);
    }
    let fp: { value: string; instance: string; target: string | null };
    try {
      fp = swapFingerprint(instance, oldMain, resolved.node);
    } catch (e) {
      blocking.push({ nodeId: item.id, why: `cannot fingerprint ${item.id}: ${errMsg(e)}` });
      continue;
    }
    const fingerprint = fp.value;
    const budget: { n: number; truncated: boolean; depthTruncated?: boolean } = { n: 0, truncated: false };
    let oldSnapshot: Json;
    try {
      oldSnapshot = await readInstance(instance, 0, budget, MAX_NODES, 12);
    } catch (e) {
      blocking.push({ nodeId: item.id, why: `cannot read ${item.id}'s overrides: ${errMsg(e)}` });
      continue;
    }
    if (oldSnapshot.unresolved) {
      blocking.push({ nodeId: item.id, why: `cannot read ${item.id}'s main component: ${oldSnapshot.unresolved}` });
      continue;
    }
    if (oldSnapshot.overridesUnresolved) {
      blocking.push({ nodeId: item.id, why: `cannot read ${item.id}'s overrides: ${oldSnapshot.overridesUnresolved}` });
      continue;
    }
    if (budget.truncated || budget.depthTruncated || oldSnapshot.depthTruncated) {
      blocking.push({
        nodeId: item.id,
        why: budget.truncated
          ? `${item.id} has more than ${MAX_NODES} override layers; a truncated snapshot cannot be replayed safely`
          : `${item.id} has nested instance overrides deeper than 12 levels; a truncated snapshot cannot be replayed safely`,
      });
      continue;
    }

    const from = mainRef(oldMain);
    const to = resolved.node ? mainRef(resolved.node) : {
      id: null,
      key: resolved.requested.componentKey || resolved.requested.componentSetKey || null,
      name: null,
      remote: null,
      unresolved: true,
    };
    const noop = !!(resolved.node && oldMain.id === resolved.node.id);
    const targetWarnings: string[] = [];
    let compatibility: Json;
    let internal: Json;

    if (noop) {
      compatibility = {
        status: "noop",
        overrides: { total: (oldSnapshot.overrides || []).length, replayable: 0, atRisk: 0, unsupportedFields: 0, remapped: 0, missing: 0, typeChanged: 0, nestedChanged: 0, unresolved: 0 },
        properties: { total: 0, replayable: 0, variant: 0, dropped: 0, names: [] },
        root: { fields: [], name: null, size: "inherited", skipped: [] },
        losses: [],
        changes: [],
        lossCount: 0,
      };
      internal = {
        instanceId: instance.id, fingerprint, instanceFingerprint: fp.instance, targetFingerprint: fp.target,
        toNode: resolved.node, noop: true, insideComponent: item.insideComponent, compatibility, from, to,
      };
    } else if (!resolved.node) {
      const totalOverrides = (oldSnapshot.overrides || []).length;
      let totalProperties = 0;
      try { totalProperties = Object.keys(instance.componentProperties || {}).length; } catch { totalProperties = 0; }
      compatibility = {
        status: "unverified",
        overrides: { total: totalOverrides, replayable: 0, atRisk: 0, unsupportedFields: 0, remapped: 0, missing: 0, typeChanged: 0, nestedChanged: 0, unresolved: 0 },
        properties: { total: totalProperties, replayable: 0, variant: 0, dropped: 0, names: [] },
        root: { fields: [], name: null, size: "unverified", skipped: [] },
        losses: [],
        changes: [],
        lossCount: 0,
      };
      internal = {
        instanceId: instance.id, fingerprint, instanceFingerprint: fp.instance, targetFingerprint: fp.target,
        toNode: null, noop: false, insideComponent: item.insideComponent, compatibility, from, to,
      };
    } else {
      const remap = await remapOverrides(oldSnapshot.overrides || [], oldMain, resolved.node, `${instance.id}.overrides`);
      const properties = await planProperties(ctx, instance, resolved.node);
      const root = planRootOverrides(
        instance,
        oldMain,
        params.preserveRootOverrides !== false,
        params.preserveSize !== false,
      );
      const atRisk = remap.details.filter((d) => RISK_KINDS.has(d.kind)).length;
      const unsupportedFields = remap.details
        .filter((d) => d.kind === "override-unsupported")
        .reduce((n: number, d: any) => n + (Array.isArray(d.fields) ? d.fields.length : 0), 0);
      const missing = remap.details.filter((d) => d.kind === "override-missing").length;
      const typeChanged = remap.details.filter((d) => d.kind === "override-type-changed").length;
      const nestedChanged = remap.details.filter((d) => d.kind === "override-nested-component-changed").length;
      const unresolvedOverrides = remap.details.filter((d) => d.kind === "override-unresolved" || d.kind === "override-old-path-missing").length;
      const remapped = remap.details.filter((d) => d.kind === "override-remapped").length;
      // `override-remapped` is a change, not a loss. Keep it visible but do not
      // let it inflate the loss list or the apply gate.
      const changes = remap.details.filter((d: any) => d.kind === "override-remapped");
      const losses: Json[] = [
        ...remap.details.filter((d: any) => RISK_KINDS.has(d.kind)),
        ...properties.dropped.map((d: any) => ({ kind: "property-dropped", ...d })),
      ];
      // atRisk already counts an unsupported record once; unsupportedFields is
      // the number of fields inside it, shown for diagnosis but not added again.
      const count = atRisk + properties.dropped.length;
      compatibility = {
        status: count ? "lossy" : "compatible",
        overrides: {
          total: (oldSnapshot.overrides || []).length,
          replayable: remap.records.length,
          atRisk,
          unsupportedFields,
          remapped,
          missing,
          typeChanged,
          nestedChanged,
          unresolved: unresolvedOverrides,
        },
        properties: {
          total: properties.total,
          replayable: properties.replayable.length,
          variant: properties.variant.length,
          dropped: properties.dropped.length,
          names: properties.replayable.map((p: any) => p.name),
        },
        root: {
          fields: root.fields,
          name: root.name,
          size: root.size,
          skipped: root.skipped,
        },
        losses: losses.slice(0, MAX_DETAILS),
        changes: changes.slice(0, MAX_DETAILS),
        lossCount: count,
      };
      if (properties.variant.length) {
        targetWarnings.push(
          `${item.id}: variant properties (${properties.variant.map((v: any) => v.name).join(", ")}) are chosen by the target component, not replayed`,
        );
      }
      if (root.size === "adopted") {
        targetWarnings.push(`${item.id}: the old instance was resized, but preserveSize:false adopts the new component's size`);
      }
      internal = {
        instanceId: instance.id,
        fingerprint,
        instanceFingerprint: fp.instance,
        targetFingerprint: fp.target,
        toNode: resolved.node,
        noop: false,
        insideComponent: item.insideComponent,
        compatibility,
        from,
        to,
        overrides: remap.records,
        properties: properties.values,
        root,
      };
    }

    publicTargets.push({
      nodeId: instance.id,
      name: instance.name,
      from,
      to,
      fingerprint,
      targetFingerprint: fp.target,
      insideComponent: item.insideComponent,
      compatibility,
      warnings: targetWarnings,
    });
    internalTargets.push(internal);
    if (targetWarnings.length) warnings.push(...targetWarnings);
  }

  const allNoop = publicTargets.length > 0 && publicTargets.every((t) => t.compatibility.status === "noop");
  const lossy = publicTargets.some((t) => t.compatibility.status === "lossy");
  const unverified = publicTargets.some((t) => t.compatibility.status === "unverified");
  const state = blocking.length ? "incompatible" : allNoop ? "noop" : lossy ? "lossy" : unverified ? "unverified" : "compatible";
  const counts = {
    targets: publicTargets.length,
    noop: publicTargets.filter((t) => t.compatibility.status === "noop").length,
    compatible: publicTargets.filter((t) => t.compatibility.status === "compatible").length,
    lossy: publicTargets.filter((t) => t.compatibility.status === "lossy").length,
    unverified: publicTargets.filter((t) => t.compatibility.status === "unverified").length,
    overridesTotal: publicTargets.reduce((n, t) => n + Number(t.compatibility.overrides?.total || 0), 0),
    overridesReplayable: publicTargets.reduce((n, t) => n + Number(t.compatibility.overrides?.replayable || 0), 0),
    overridesAtRisk: publicTargets.reduce((n, t) => n + Number(t.compatibility.overrides?.atRisk || 0), 0),
    propertiesReplayable: publicTargets.reduce((n, t) => n + Number(t.compatibility.properties?.replayable || 0), 0),
    propertiesDropped: publicTargets.reduce((n, t) => n + Number(t.compatibility.properties?.dropped || 0), 0),
  };
  const plan: Json = {
    status: "dry_run",
    schema: SWAP_SCHEMA,
    dryRun: opts.dryRun !== false,
    target: resolved.requested,
    targets: publicTargets,
    counts,
    state,
    lossy,
    unverified,
    blocking,
    warnings,
    ms: { plan: Date.now() - t0 },
  };
  // A cheap deep signature of the thing the apply will actually do. The
  // semantic snapshot covers pixels and geometry; this covers the parts that
  // decide what can be replayed (names, component properties, style links,
  // old/new main components and the remapped override records). Apply re-plans
  // and refuses if this moved after the dry run.
  const signature = hashString(JSON.stringify(canon({
    state,
    blocking,
    targets: internalTargets.map((t) => ({
      instanceId: t.instanceId,
      fingerprint: t.fingerprint,
      noop: t.noop === true,
      insideComponent: t.insideComponent === true,
      from: t.from ?? null,
      to: t.to ?? null,
      compatibility: t.compatibility ?? null,
      overrides: t.overrides ?? null,
      properties: t.properties ?? null,
      root: t.root ?? null,
    })),
  })));
  return {
    public: plan,
    internal: {
      resolved,
      targets: internalTargets,
      state,
      lossy,
      unverified,
      blocking,
      signature,
    },
  };
}

// ---------------------------------------------------------------- apply

function fingerprintMismatch(targets: any[], expected: any): Json[] {
  const out: Json[] = [];
  for (const t of targets) {
    if (!t || !t.instanceId) continue;
    if (expected[t.instanceId] !== t.fingerprint) {
      out.push({ nodeId: t.instanceId, expected: expected[t.instanceId] ?? null, actual: t.fingerprint || null });
    }
  }
  return out;
}

function instanceFingerprintMismatch(targets: any[], expected: any): Json[] {
  const out: Json[] = [];
  for (const t of targets) {
    if (!t || !t.instanceId) continue;
    if (expected[t.instanceId] !== t.instanceFingerprint) {
      out.push({ nodeId: t.instanceId, expected: expected[t.instanceId] ?? null, actual: t.instanceFingerprint || null });
    }
  }
  return out;
}

function missingFingerprints(targets: any[], expected: any): string[] {
  const out: string[] = [];
  for (const t of targets) {
    if (t && t.instanceId && typeof expected[t.instanceId] !== "string") out.push(t.instanceId);
  }
  return out;
}

export async function runComponentSwap(ctx: any, params: Json): Promise<Json> {
  const t0 = Date.now();
  if (!params || !Array.isArray(params.nodeIds) || !params.nodeIds.length) {
    throw new Error("swap_component needs at least one nodeId in nodeIds");
  }
  if (params.nodeIds.length > MAX_TARGETS) {
    throw new Error(`swap_component has ${params.nodeIds.length} targets; the limit is ${MAX_TARGETS}`);
  }
  const dryRun = params.dryRun !== false;
  const pre = await buildPlan(ctx, params, { apply: false, dryRun });
  if (pre.internal.blocking.length) {
    if (dryRun) return pre.public;
    throw new Error(
      `COMPONENT_SWAP_BLOCKED: ${pre.internal.blocking.map((b: any) => b.why).join("; ")}`,
    );
  }
  if (dryRun) return pre.public;

  if (!isObj(params.expectedFingerprints)) {
    throw new Error(
      "COMPONENT_SWAP_FINGERPRINTS_REQUIRED: apply needs expectedFingerprints from a dry run (nodeId -> fingerprint). " +
        "Run figma_swap_component with dryRun:true first.",
    );
  }
  const missing = missingFingerprints(pre.internal.targets, params.expectedFingerprints);
  if (missing.length) {
    throw new Error(`COMPONENT_SWAP_FINGERPRINTS_REQUIRED: no fingerprint for ${missing.join(", ")}; run the dry run again.`);
  }
  const mismatch = fingerprintMismatch(pre.internal.targets, params.expectedFingerprints);
  if (mismatch.length) {
    return {
      status: "refused",
      reason: "FINGERPRINT_MISMATCH",
      schema: SWAP_SCHEMA,
      dryRun: false,
      message: "The document changed since the plan was made. Run figma_swap_component with dryRun:true again.",
      mismatch,
      ms: { plan: Date.now() - t0 },
    };
  }
  if (pre.internal.state === "noop") {
    return {
      ...pre.public,
      status: "noop",
      dryRun: false,
      ms: { plan: pre.public.ms?.plan ?? 0, apply: 0, total: Date.now() - t0 },
    };
  }
  if (pre.internal.lossy && params.allowLoss !== true) {
    throw new Error(
      `COMPONENT_SWAP_LOSSY: ${lossSummary(pre.public) || "the swap would drop overrides"}. ` +
        "Pass allowLoss:true to apply it and receive the same losses in the report, or choose a component with matching layers.",
    );
  }
  if (pre.internal.unverified && params.allowUnverified !== true) {
    throw new Error(
      "COMPONENT_SWAP_UNVERIFIED: the target component is a library import, so its structure was not compared. " +
        "Pass allowUnverified:true to import it and apply with the unchecked losses reported.",
    );
  }

  // For a local (already verified) target, re-plan immediately before the
  // first write. This catches a renamed instance, a component property edited
  // after the dry run, a style link changed, or the target component itself
  // changed: the semantic fingerprint alone does not cover all of those.
  if (!pre.internal.unverified) {
    const fresh = await buildPlan(ctx, params, { apply: false, dryRun: false });
    if (fresh.internal.blocking.length) {
      throw new Error(`COMPONENT_SWAP_PLAN_CHANGED: ${fresh.internal.blocking.map((b: any) => b.why).join("; ")}`);
    }
    if (fresh.internal.signature !== pre.internal.signature) {
      throw new Error(
        "COMPONENT_SWAP_PLAN_CHANGED: the instance, its component properties or the target component changed since the dry run; run figma_swap_component with dryRun:true again.",
      );
    }
  }

  ctx.commitUndo();
  let wrote = false;
  const mark = () => { if (!wrote) { wrote = true; ctx.commitUndo(); } };
  try {
    let plan = pre;
    if (pre.internal.unverified) {
      mark();
      const resolved = await resolveComponentRef(ctx, params, true);
      plan = await buildPlan(ctx, params, { apply: false, resolved, dryRun: false });
      if (plan.internal.blocking.length) {
        throw new Error(plan.internal.blocking.map((b: any) => b.why).join("; "));
      }
      const secondMismatch = instanceFingerprintMismatch(plan.internal.targets, params.expectedFingerprints);
      if (secondMismatch.length) {
        throw new Error(`targets changed while importing the component: ${secondMismatch.map((m) => m.nodeId).join(", ")}`);
      }
      if (plan.internal.unverified) {
        throw new Error("the imported component could not be resolved to a local COMPONENT");
      }
      if (plan.internal.lossy && params.allowLoss !== true) {
        throw new Error(`the imported component is lossy: ${lossSummary(plan.public)}`);
      }
      if (plan.internal.state === "noop") {
        return {
          ...plan.public,
          status: "noop",
          dryRun: false,
          ms: { plan: pre.public.ms?.plan ?? 0, apply: Date.now() - t0, total: Date.now() - t0 },
        };
      }
    }

    const merged = newReport();
    const results: Json[] = [];
    for (const target of plan.internal.targets) {
      if (target.noop) {
        results.push({
          nodeId: target.instanceId,
          status: "noop",
          compatibility: target.compatibility,
          verified: true,
        });
        continue;
      }
      const instance = await ctx.getNodeByIdAsync(target.instanceId);
      if (!instance || instance.type !== "INSTANCE" || instance.removed === true) {
        throw new Error(`target ${target.instanceId} disappeared between plan and apply`);
      }
      if (!target.toNode) throw new Error(`target ${target.instanceId} has no resolved component to swap to`);
      let liveFingerprint = "";
      try {
        liveFingerprint = swapFingerprint(instance, await mainOf(instance), target.toNode).value;
      } catch (e) {
        throw new Error(`target ${target.instanceId} could not be fingerprinted before the swap: ${errMsg(e)}`);
      }
      if (liveFingerprint !== target.fingerprint) {
        throw new Error(`target ${target.instanceId} changed after the plan; run the dry run again`);
      }
      if (typeof instance.swapComponent !== "function") {
        throw new Error(`target ${target.instanceId}: this Figma session does not expose InstanceNode.swapComponent`);
      }
      mark();
      instance.swapComponent(target.toNode);

      const report = newReport();
      report.plannedLosses.push(...(target.compatibility?.losses || []));
      const restoreCtx = {
        figma: ctx,
        target: instance,
        mark,
        loadFont: typeof ctx.loadFontAsync === "function" ? ctx.loadFontAsync.bind(ctx) : undefined,
      };
      // Properties and layer overrides can change text/layout geometry, so the
      // root size is restored last: a manually resized instance must not be
      // resized back by the very overrides it carries.
      applyMappedProperties(instance, target.properties, report, `${target.instanceId}:properties`);
      await applyInstanceOverrides(instance, target.overrides, restoreCtx, report, target.instanceId);
      await applyRootOverrides(instance, target.root, restoreCtx, report, `${target.instanceId}:root`);

      let afterMain: any = null;
      try {
        afterMain = await instance.getMainComponentAsync();
      } catch {
        afterMain = null;
      }
      const mainMatches = !!afterMain && afterMain.id === target.toNode.id;
      if (!mainMatches) {
        throw new Error(
          `target ${target.instanceId}: the main component did not change to ${target.toNode.id} ` +
            `(now ${afterMain ? afterMain.id : "unreadable"})`,
        );
      }
      const softFailures = report.notes.filter((n: string) => /not restored|not cleared/i.test(n));
      const actualLosses = report.overridesMissing.length + report.propertiesFailed.length + softFailures.length;
      if (!params.allowLoss && actualLosses) {
        throw new Error(
          `target ${target.instanceId}: the swap would lose ${actualLosses} override(s) that the dry run did not predict: ` +
            `${[
              ...report.overridesMissing.map((m: any) => m.why),
              ...report.propertiesFailed.map((m: any) => `${m.name}: ${m.why}`),
              ...softFailures,
            ].slice(0, 6).join("; ")}`,
        );
      }
      mergeReport(merged, report);
      const predictedLosses = Number(target.compatibility?.lossCount || 0);
      results.push({
        nodeId: target.instanceId,
        status: "applied",
        from: target.from ?? null,
        to: target.to ?? null,
        compatibility: target.compatibility,
        mainComponentId: afterMain?.id ?? null,
        verified: mainMatches && actualLosses === 0 && predictedLosses === 0,
        predictedLosses,
        losses: target.compatibility?.losses || [],
        overrides: {
          restored: report.overridesRestored.length,
          missing: report.overridesMissing.length,
          unsupported: report.overridesUnsupported.length,
        },
        propertiesFailed: report.propertiesFailed.length,
        notes: report.notes.slice(0, 40),
      });
    }
    ctx.commitUndo();
    return {
      status: "applied",
      schema: SWAP_SCHEMA,
      dryRun: false,
      targets: results,
      counts: plan.public.counts,
      report: merged,
      verification: {
        ok: results.every((r) => r.verified !== false),
        targets: results.map((r) => ({
          nodeId: r.nodeId,
          verified: r.verified !== false,
          mainComponentId: r.mainComponentId ?? null,
        })),
      },
      warnings: plan.public.warnings,
      ms: { plan: pre.public.ms?.plan ?? 0, apply: Date.now() - t0, total: Date.now() - t0 },
    };
  } catch (e) {
    if (wrote) {
      try { ctx.commitUndo(); ctx.triggerUndo(); } catch { /* ignore */ }
    }
    throw new Error(errMsg(e) + (wrote ? " (rolled back)" : ""));
  }
}
