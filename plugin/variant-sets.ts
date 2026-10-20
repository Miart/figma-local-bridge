/// <reference types="@figma/plugin-typings" />

/**
 * Variant-set authoring: combine components into a set, add a variant by
 * cloning one that already exists, or rename a variant's property combination.
 *
 * A variant set is not a bag of components. Its identity is the property matrix
 * encoded in the component names, and every write here changes that matrix:
 * combine replaces the standalone names, add introduces a new row/column, edit
 * renames an existing row/column in place. The dry run therefore validates the
 * whole matrix before writing and fingerprints both the components and the set,
 * plus the destination layout when a new set is created.
 *
 * The tool deliberately does not guess:
 *  - a component already in a set is not combined into another set;
 *  - components with different property names, or a duplicate property
 *    combination, are refused before the first write;
 *  - a destination inside an INSTANCE is refused; inside a COMPONENT it is
 *    allowed and named as an edit to the component definition;
 *  - after writing, the component names are read back as variantProperties and
 *    the set's group matrix is verified; a Figma that did not accept the name is
 *    rolled back, not reported as a success.
 */

import { snapshot, STRICT, hashString, containerFingerprint } from "./fingerprint";
import { KEY_DATA, PROTECTED_DATA } from "./ui-build";

export const VARIANT_SET_SCHEMA = "variant-set-v1";
const MAX_COMPONENTS = 50;

type Json = any;

const isObj = (v: any) => !!v && typeof v === "object" && !Array.isArray(v);
const errMsg = (e: any) => String(e && e.message ? e.message : e);

function targetRef(n: any): Json {
  let key = "";
  try { key = n.getPluginData(KEY_DATA) || ""; } catch { key = ""; }
  const publishedKey = typeof n.key === "string" && n.key ? n.key : null;
  return { id: n.id, name: n.name, type: n.type, key, publishedKey };
}

function protect(n: any): void {
  try {
    if (n.getPluginData(PROTECTED_DATA) === "1") {
      throw new Error(`node ${n.id} ("${n.name}") is protected; variant-set editing will not change it`);
    }
  } catch (e: any) {
    if (String(e && e.message).includes("protected")) throw e;
  }
}

function byKey(figma: any, key: string): any[] {
  const out: any[] = [];
  const visit = (n: any) => {
    try { if (n.getPluginData(KEY_DATA) === key) out.push(n); } catch { /* ignore */ }
    for (const c of n.children || []) visit(c);
  };
  visit(figma.currentPage);
  return out;
}

function hasRef(ref: Json, idField: string, keyField: string): { id: boolean; key: boolean } {
  return {
    id: ref[idField] !== undefined && ref[idField] !== null && String(ref[idField]) !== "",
    key: ref[keyField] !== undefined && ref[keyField] !== null && String(ref[keyField]) !== "",
  };
}

async function resolveRef(figma: any, ref: Json, idField: string, keyField: string, label: string): Promise<any> {
  const has = hasRef(ref, idField, keyField);
  if (has.id && has.key) throw new Error(`${label}: give ${idField} or ${keyField}, not both`);
  if (!has.id && !has.key) throw new Error(`${label}: needs ${idField} or ${keyField}`);
  if (has.key) {
    const hits = byKey(figma, String(ref[keyField]));
    if (!hits.length) throw new Error(`${label}: no node with key "${ref[keyField]}" on the current page`);
    if (hits.length > 1) {
      throw new Error(`${label}: key "${ref[keyField]}" is ambiguous (${hits.map((n: any) => n.id).join(", ")})`);
    }
    return hits[0];
  }
  const n = await figma.getNodeByIdAsync(String(ref[idField]));
  if (!n) throw new Error(`${label}: node not found: ${ref[idField]}`);
  if (n.removed === true) throw new Error(`${label}: node ${ref[idField]} has been removed`);
  return n;
}

function pageOf(node: any): any | null {
  let p = node;
  while (p) {
    if (p.type === "PAGE") return p;
    p = p.parent;
  }
  return null;
}

function insideInstance(node: any): any | null {
  let p = node;
  while (p) {
    if (p.type === "INSTANCE") return p;
    p = p.parent;
  }
  return null;
}

function componentAncestor(node: any): any | null {
  let p = node;
  while (p) {
    if (p.type === "COMPONENT") return p;
    p = p.parent;
  }
  return null;
}

function componentSetAncestor(node: any): any | null {
  let p = node;
  while (p) {
    if (p.type === "COMPONENT_SET") return p;
    p = p.parent;
  }
  return null;
}

function isAncestor(ancestor: any, node: any): boolean {
  let p = node;
  while (p) {
    if (p.id === ancestor.id) return true;
    p = p.parent;
  }
  return false;
}

function normalizeProperties(raw: any, label: string): Record<string, string> {
  if (!isObj(raw) || !Object.keys(raw).length) throw new Error(`${label}: properties must be a non-empty object`);
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const key = String(rawKey).trim();
    const value = String(rawValue ?? "").trim();
    if (!key) throw new Error(`${label}: a variant property name is empty`);
    if (!value) throw new Error(`${label}: variant property "${key}" has an empty value`);
    if (/[,=\n\r]/.test(key)) throw new Error(`${label}: variant property name "${key}" cannot contain comma, equals or a new line`);
    if (/[,=\n\r]/.test(value)) throw new Error(`${label}: value "${value}" of "${key}" cannot contain comma, equals or a new line`);
    if (Object.prototype.hasOwnProperty.call(out, key)) throw new Error(`${label}: variant property "${key}" is duplicated after trimming`);
    out[key] = value;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function variantName(props: Record<string, string>): string {
  return Object.entries(props).map(([k, v]) => `${k}=${v}`).join(", ");
}

function propertyKeySignature(props: Record<string, string>): string {
  return Object.keys(props).sort().join("\u0001");
}

function variantSignature(props: Record<string, string>): string {
  return Object.entries(props)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\u0001");
}

function sameProperties(a: any, b: any): boolean {
  if (!isObj(a) || !isObj(b)) return false;
  return variantSignature(a as Record<string, string>) === variantSignature(b as Record<string, string>);
}

/**
 * The API field, never the name. Figma writes both when a name is accepted; a
 * verification that could fall back to parsing the name would prove only that
 * the name was set, not that Figma turned it into variantProperties. That is the
 * exact failure this tool must not report as success.
 */
function variantPropertiesOf(node: any): Record<string, string> | null {
  const vp = node && node.variantProperties;
  return isObj(vp) && Object.keys(vp).length ? { ...vp } : null;
}

function isVariantComponent(node: any): boolean {
  return node.type === "COMPONENT" && node.parent?.type === "COMPONENT_SET";
}

function groupProperties(set: any): Record<string, { values: string[] }> {
  const vg = set.variantGroupProperties;
  if (isObj(vg)) {
    const out: Record<string, { values: string[] }> = {};
    for (const [key, value] of Object.entries(vg as Record<string, any>)) {
      out[key] = { values: Array.isArray(value?.values) ? value.values.map(String).sort() : [] };
    }
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
  const out: Record<string, Set<string>> = {};
  for (const child of set.children || []) {
    if (child.type !== "COMPONENT") continue;
    const props = variantPropertiesOf(child);
    if (!props) continue;
    for (const [k, v] of Object.entries(props)) (out[k] ||= new Set()).add(v);
  }
  return Object.fromEntries(
    Object.entries(out)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, { values: [...v].sort() }]),
  );
}

function groupKeys(set: any): string[] {
  const groups = groupProperties(set);
  return Object.keys(groups).sort();
}

function variantsOf(set: any): any[] {
  return (set.children || []).filter((c: any) => c.type === "COMPONENT");
}

/**
 * A set is a matrix only when every child exposes the API's variantProperties.
 * If one does not, the duplicate check would be guessing at its row; refuse the
 * whole edit rather than risk two variants with the same combination.
 */
function assertReadableMatrix(set: any, label: string): void {
  const unknown = variantsOf(set).filter((v) => !variantPropertiesOf(v));
  if (unknown.length) {
    throw new Error(
      `${label}: set ${set.name || set.id} contains variant${unknown.length === 1 ? "" : "s"} without variantProperties (${unknown.map((v: any) => v.id).join(", ")}); ` +
        "refusing to guess the property matrix",
    );
  }
}

function setFingerprint(set: any): string {
  const state = {
    variantGroupProperties: groupProperties(set),
    componentPropertyDefinitions: set.componentPropertyDefinitions ?? null,
    defaultVariantId: set.defaultVariant?.id ?? null,
  };
  return hashString(`${containerFingerprint(set)}|${JSON.stringify(state)}`);
}

function componentFingerprint(component: any): string {
  const state = {
    // Use the API field, not the name fallback: a standalone component can be
    // named "Size=Large" without being a variant, and its old name is replaced
    // by this operation, so parsing it into the fingerprint would refuse a
    // harmless rename.
    variantProperties: component.variantProperties ?? null,
    componentPropertyDefinitions: component.componentPropertyDefinitions ?? null,
    parentId: component.parent?.id ?? null,
  };
  return hashString(`${snapshot(component, STRICT).hash}|${JSON.stringify(state)}`);
}

function addFingerprint(map: Record<string, string>, node: any): void {
  if (!node || node.type === "PAGE") return;
  map[node.id] = containerFingerprint(node);
}

function validatePropertyNames(props: Record<string, string>, expectedKeys: string[], label: string): void {
  const actual = propertyKeySignature(props);
  const expected = expectedKeys.slice().sort().join("\u0001");
  if (actual !== expected) {
    const has = new Set(Object.keys(props));
    const want = new Set(expectedKeys);
    const missing = expectedKeys.filter((k) => !has.has(k));
    const extra = Object.keys(props).filter((k) => !want.has(k));
    throw new Error(
      `${label}: properties must use the set's property names (${expectedKeys.join(", ") || "(none)"})` +
        (missing.length ? `; missing ${missing.join(", ")}` : "") +
        (extra.length ? `; unexpected ${extra.join(", ")}` : ""),
    );
  }
}

async function resolveDestination(figma: any, params: Json, components: any[]): Promise<any> {
  const has = hasRef(params, "parentId", "parentKey");
  let parent: any;
  if (has.id && has.key) throw new Error("combine: give parentId or parentKey, not both");
  if (has.id || has.key) {
    parent = await resolveRef(figma, params, "parentId", "parentKey", "combine parent");
  } else {
    const first = components[0]?.parent;
    if (!first) throw new Error("combine: the first component has no parent; pass parentId or parentKey");
    if (!components.every((c) => c.parent && c.parent.id === first.id)) {
      throw new Error("combine: the components have different parents; pass parentId or parentKey for the new set");
    }
    parent = first;
  }
  if (!parent || !("appendChild" in parent) || !("insertChild" in parent)) {
    throw new Error(`combine: destination ${parent?.id ?? "(none)"} cannot accept children`);
  }
  if (parent.type === "DOCUMENT") throw new Error("combine: DOCUMENT cannot be a destination");
  if (parent.type === "COMPONENT_SET") {
    throw new Error("combine: a COMPONENT_SET is already a set; use `add` to extend it");
  }
  if (parent.type === "INSTANCE") {
    throw new Error("combine: an INSTANCE cannot accept children; detach it or pick a real parent");
  }
  if (insideInstance(parent)) {
    throw new Error("combine: destination is inside an INSTANCE; its interior is an override, not a normal layer tree");
  }
  const setAncestor = componentSetAncestor(parent);
  if (setAncestor) {
    throw new Error(`combine: destination ${parent.id} is inside COMPONENT_SET ${setAncestor.id} ("${setAncestor.name}"); a set cannot be nested in another set`);
  }
  const definition = componentAncestor(parent);
  if (definition) {
    throw new Error(
      `combine: destination ${parent.id} is inside COMPONENT ${definition.id} ("${definition.name}"); ` +
        "Figma refuses to reparent a component into a component definition. Use a page or frame, or edit the existing set with add/edit.",
    );
  }
  const parentPage = pageOf(parent);
  for (const c of components) {
    if (parent.id === c.id || isAncestor(c, parent)) {
      throw new Error(`combine: destination ${parent.id} is inside component ${c.id}; a set cannot be created inside one of its own variants`);
    }
    const componentPage = pageOf(c);
    if (!parentPage || !componentPage || parentPage.id !== componentPage.id) {
      throw new Error(`combine: component ${c.id} and destination ${parent.id} are not on the same page`);
    }
  }
  return parent;
}

function validateCombineComponents(components: any[], properties: Record<string, string>[]): void {
  if (!components.length || components.length > MAX_COMPONENTS) {
    throw new Error(`combine: components must contain 1–${MAX_COMPONENTS} items`);
  }
  const ids = new Set<string>();
  for (const c of components) {
    if (ids.has(c.id)) throw new Error(`combine: component ${c.id} appears more than once`);
    ids.add(c.id);
    if (c.type !== "COMPONENT") throw new Error(`combine: ${c.id} is ${c.type}, not a COMPONENT`);
    if (isVariantComponent(c)) {
      throw new Error(`combine: ${c.id} is already a variant of ${c.parent?.name || c.parent?.id}; a set cannot be nested in another set`);
    }
    if (insideInstance(c)) throw new Error(`combine: ${c.id} is inside an INSTANCE and cannot be moved independently`);
    const setAncestor = componentSetAncestor(c);
    if (setAncestor) {
      throw new Error(`combine: ${c.id} is inside COMPONENT_SET ${setAncestor.id} ("${setAncestor.name}"); a component inside a set cannot be moved into another set`);
    }
  }
  for (let i = 0; i < components.length; i++) {
    for (let j = i + 1; j < components.length; j++) {
      if (isAncestor(components[i], components[j]) || isAncestor(components[j], components[i])) {
        throw new Error(`combine: ${components[i].id} and ${components[j].id} are nested; combine sibling components, not a component and its child`);
      }
    }
  }
  const firstKeys = propertyKeySignature(properties[0]);
  for (let i = 1; i < properties.length; i++) {
    if (propertyKeySignature(properties[i]) !== firstKeys) {
      throw new Error(
        `combine: components[0] uses properties (${Object.keys(properties[0]).join(", ")}) but components[${i}] uses (${Object.keys(properties[i]).join(", ")}); every variant needs the same property names`,
      );
    }
  }
  const seen = new Map<string, number>();
  for (let i = 0; i < properties.length; i++) {
    const sig = variantSignature(properties[i]);
    if (seen.has(sig)) {
      throw new Error(
        `combine: components[${seen.get(sig)}] and components[${i}] describe the same variant ${JSON.stringify(properties[i])}`,
      );
    }
    seen.set(sig, i);
  }
}

function groupFrom(properties: Record<string, string>[]): Record<string, { values: string[] }> {
  const groups: Record<string, Set<string>> = {};
  for (const props of properties) {
    for (const [k, v] of Object.entries(props)) (groups[k] ||= new Set()).add(v);
  }
  return Object.fromEntries(
    Object.entries(groups)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, { values: [...v].sort() }]),
  );
}

async function buildCombine(figma: any, params: Json): Promise<Json> {
  const raw = params.components;
  if (!Array.isArray(raw) || !raw.length) throw new Error("combine: components must be a non-empty array");
  if (raw.length > MAX_COMPONENTS) throw new Error(`combine: at most ${MAX_COMPONENTS} components per call`);
  const components: any[] = [];
  const properties: Record<string, string>[] = [];
  const items: Json[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!isObj(item)) throw new Error(`combine: components[${i}] must be an object`);
    const component = await resolveRef(figma, item, "nodeId", "key", `combine components[${i}]`);
    const props = normalizeProperties(item.properties, `combine components[${i}]`);
    components.push(component);
    properties.push(props);
    items.push({
      nodeId: component.id,
      key: targetRef(component).key,
      name: component.name,
      previousParent: component.parent ? targetRef(component.parent) : null,
      variantProperties: props,
      variantName: variantName(props),
    });
  }
  validateCombineComponents(components, properties);
  if (typeof figma.combineAsVariants !== "function") {
    throw new Error("VARIANT_SET_UNAVAILABLE: this Figma build does not expose figma.combineAsVariants");
  }
  const setName = String(params.name ?? "").trim();
  if (!setName) throw new Error("combine: name must be a non-empty set name");
  const parent = await resolveDestination(figma, params, components);
  const warnings: string[] = [
    "component names are replaced by the requested variant names; previous names are reported",
    "instances follow their component identity; their ids and overrides are not recreated",
  ];
  if (components.some((c) => componentAncestor(c.parent))) {
    warnings.push("a component was inside a COMPONENT definition; combining it moves it out and edits that definition");
  }
  if ("layoutMode" in parent && parent.layoutMode !== "NONE") {
    warnings.push("destination uses auto-layout; the new COMPONENT_SET is placed in its flow");
  }
  if (components.length === 1) {
    warnings.push("a component set with one variant is allowed, but it has no matrix yet; add another variant to make the set useful");
  }
  protect(parent);
  for (const c of components) {
    protect(c);
    if (c.parent && c.parent.id !== parent.id) protect(c.parent);
  }
  const fingerprints: Record<string, string> = {};
  for (const c of components) fingerprints[c.id] = componentFingerprint(c);
  for (const c of components) addFingerprint(fingerprints, c.parent);
  addFingerprint(fingerprints, parent);

  const groups = groupFrom(properties);
  return {
    public: {
      status: "dry_run",
      schema: VARIANT_SET_SCHEMA,
      action: "combine",
      dryRun: true,
      set: { name: setName, parent: targetRef(parent), nodeId: null },
      components: items,
      variantProperties: groups,
      counts: { components: components.length, propertyNames: Object.keys(groups).length, variants: components.length },
      warnings,
      fingerprints,
    },
    internal: {
      action: "combine",
      components,
      properties,
      names: items.map((i) => i.variantName),
      parent,
      setName,
      fingerprints,
      warnings,
      previousNames: components.map((c) => c.name),
    },
  };
}

async function buildAdd(figma: any, params: Json): Promise<Json> {
  const source = await resolveRef(figma, params, "sourceId", "sourceKey", "add source variant");
  if (source.type !== "COMPONENT") throw new Error(`add: source ${source.id} is ${source.type}, not a COMPONENT`);
  if (source.parent?.type !== "COMPONENT_SET") {
    throw new Error(`add: source ${source.id} is not a variant in a COMPONENT_SET; use combine for standalone components`);
  }
  const set = source.parent;
  if (typeof source.clone !== "function" || typeof set.insertChild !== "function") {
    throw new Error("VARIANT_SET_UNAVAILABLE: this Figma build cannot clone a variant or insert it into the set");
  }
  protect(set);
  if (insideInstance(set)) throw new Error("add: the set is inside an INSTANCE and cannot be edited independently");
  const props = normalizeProperties(params.properties, "add variant");
  assertReadableMatrix(set, "add variant");
  const keys = groupKeys(set);
  if (!keys.length) throw new Error(`add: set ${set.id} has no variant properties`);
  validatePropertyNames(props, keys, "add variant");
  const duplicate = variantsOf(set).find((v) => sameProperties(variantPropertiesOf(v), props));
  if (duplicate) {
    throw new Error(`add: ${set.name} already has a variant ${JSON.stringify(props)} (${duplicate.id}); use edit or choose another value`);
  }
  const sourceProps = variantPropertiesOf(source);
  if (!sourceProps) throw new Error(`add: source ${source.id} does not expose variantProperties; it is not a usable template`);
  const existingProps = variantsOf(set).map((v) => variantPropertiesOf(v) as Record<string, string>);
  const expectedGroups = groupFrom([...existingProps, props]);
  const before = variantsOf(set).length;
  const index = params.index === undefined ? set.children.length : Number(params.index);
  if (!Number.isInteger(index) || index < 0 || index > set.children.length) {
    throw new Error(`add: index ${params.index} is out of range for ${set.name} (0..${set.children.length})`);
  }
  const warnings: string[] = [
    "the new variant is a clone of the source variant; instances of the source are not copied",
  ];
  if (set.layoutMode === "NONE") {
    warnings.push("the set is not auto-layout; the new variant is offset on the canvas to avoid overlapping the source");
  }
  if (componentAncestor(set.parent)) {
    warnings.push(`the set is inside COMPONENT "${componentAncestor(set.parent).name}"; adding a variant edits that definition`);
  }
  const fingerprints: Record<string, string> = {
    [source.id]: componentFingerprint(source),
    [set.id]: setFingerprint(set),
  };
  return {
    public: {
      status: "dry_run",
      schema: VARIANT_SET_SCHEMA,
      action: "add",
      dryRun: true,
      set: { ...targetRef(set), nodeId: set.id, variantProperties: groupProperties(set), defaultVariantId: set.defaultVariant?.id ?? null },
      source: { ...targetRef(source), nodeId: source.id, variantProperties: sourceProps },
      variant: { nodeId: null, properties: props, name: variantName(props), index },
      counts: { variantsBefore: before, variantsAfter: before + 1 },
      warnings,
      fingerprints,
    },
    internal: {
      action: "add",
      source,
      set,
      properties: props,
      name: variantName(props),
      index,
      fingerprints,
      warnings,
      before,
      expectedGroups,
    },
  };
}

async function buildEdit(figma: any, params: Json): Promise<Json> {
  const variant = await resolveRef(figma, params, "variantId", "variantKey", "edit variant");
  if (variant.type !== "COMPONENT") throw new Error(`edit: ${variant.id} is ${variant.type}, not a COMPONENT`);
  if (variant.parent?.type !== "COMPONENT_SET") {
    throw new Error(`edit: ${variant.id} is not a variant in a COMPONENT_SET`);
  }
  const set = variant.parent;
  protect(set);
  protect(variant);
  if (insideInstance(set)) throw new Error("edit: the set is inside an INSTANCE and cannot be edited independently");
  const props = normalizeProperties(params.properties, "edit variant");
  assertReadableMatrix(set, "edit variant");
  const keys = groupKeys(set);
  if (!keys.length) throw new Error(`edit: set ${set.id} has no variant properties`);
  validatePropertyNames(props, keys, "edit variant");
  const others = variantsOf(set).filter((v) => v.id !== variant.id);
  const duplicate = others.find((v) => sameProperties(variantPropertiesOf(v), props));
  if (duplicate) {
    throw new Error(`edit: ${set.name} already has a variant ${JSON.stringify(props)} (${duplicate.id})`);
  }
  const oldProps = variantPropertiesOf(variant);
  if (!oldProps) throw new Error(`edit: ${variant.id} does not expose variantProperties`);
  const noop = sameProperties(oldProps, props);
  const expectedGroups = groupFrom([...others.map((v) => variantPropertiesOf(v) as Record<string, string>), props]);
  const warnings: string[] = [];
  if (noop) warnings.push("the requested properties are already present; edit is a no-op");
  else warnings.push("instances of this variant follow its new property values; their ids and overrides are not recreated");
  if (componentAncestor(set.parent)) {
    warnings.push(`the set is inside COMPONENT "${componentAncestor(set.parent).name}"; editing a variant edits that definition`);
  }
  const fingerprints: Record<string, string> = {
    [variant.id]: componentFingerprint(variant),
    [set.id]: setFingerprint(set),
  };
  return {
    public: {
      status: noop ? "noop" : "dry_run",
      schema: VARIANT_SET_SCHEMA,
      action: "edit",
      dryRun: true,
      set: { ...targetRef(set), nodeId: set.id, variantProperties: groupProperties(set), defaultVariantId: set.defaultVariant?.id ?? null },
      variant: { ...targetRef(variant), nodeId: variant.id, previousProperties: oldProps, properties: props, name: variantName(props) },
      counts: { variantsBefore: variantsOf(set).length, variantsAfter: variantsOf(set).length },
      warnings,
      fingerprints,
    },
    internal: {
      action: "edit",
      variant,
      set,
      properties: props,
      name: variantName(props),
      oldProps,
      noop,
      fingerprints,
      warnings,
      before: variantsOf(set).length,
      expectedGroups,
    },
  };
}

async function buildPlan(figma: any, params: Json): Promise<Json> {
  if (!isObj(params) || typeof params.action !== "string") throw new Error("variant_set needs an action: combine, add or edit");
  switch (params.action) {
    case "combine": return buildCombine(figma, params);
    case "add": return buildAdd(figma, params);
    case "edit": return buildEdit(figma, params);
    default: throw new Error(`variant_set: unsupported action "${params.action}"`);
  }
}

function missingFingerprints(required: Record<string, string>, provided: any): string[] {
  return Object.keys(required).filter((id) => !Object.prototype.hasOwnProperty.call(provided, id));
}

function fingerprintMismatch(required: Record<string, string>, provided: any): Json[] {
  const out: Json[] = [];
  for (const id of Object.keys(provided || {})) {
    if (required[id] !== provided[id]) {
      out.push({ nodeId: id, expected: provided[id], actual: required[id] ?? null });
    }
  }
  for (const id of Object.keys(required)) {
    if (!Object.prototype.hasOwnProperty.call(provided || {}, id)) {
      out.push({ nodeId: id, expected: null, actual: required[id] });
    }
  }
  return out;
}

function groupMatches(actual: Record<string, { values: string[] }>, expected: Record<string, { values: string[] }>, exact: boolean): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (actualKeys.join("\u0001") !== expectedKeys.join("\u0001")) return false;
  for (const key of expectedKeys) {
    const have = new Set((actual[key]?.values || []).map(String));
    for (const value of expected[key].values) if (!have.has(value)) return false;
    if (exact && have.size !== expected[key].values.length) return false;
  }
  return true;
}

function verify(plan: Json): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const internal = plan.internal;
  const action = internal.action;
  if (action === "combine") {
    const set = internal.set;
    if (!set || set.removed === true) problems.push("the COMPONENT_SET was not created");
    else {
      if (set.type !== "COMPONENT_SET") problems.push(`the result is ${set.type}, not COMPONENT_SET`);
      if (set.parent?.id !== internal.parent.id) problems.push(`the set is under ${set.parent?.id ?? "(none)"}, expected ${internal.parent.id}`);
      if (set.name !== internal.setName) problems.push(`set name is "${set.name}", expected "${internal.setName}"`);
      const children = variantsOf(set);
      if (children.length !== internal.components.length) {
        problems.push(`set has ${children.length} variants, expected ${internal.components.length}`);
      }
      for (let i = 0; i < internal.components.length; i++) {
        const c = internal.components[i];
        if (c.removed === true) problems.push(`component ${c.id} was removed`);
        if (c.parent?.id !== set.id) problems.push(`component ${c.id} is not under the new set`);
        const got = variantPropertiesOf(c);
        if (!sameProperties(got, internal.properties[i])) {
          problems.push(`component ${c.id} reads back as ${JSON.stringify(got)}, expected ${JSON.stringify(internal.properties[i])}`);
        }
      }
      if (!groupMatches(groupProperties(set), groupFrom(internal.properties), true)) {
        problems.push(`set matrix is ${JSON.stringify(groupProperties(set))}, expected ${JSON.stringify(groupFrom(internal.properties))}`);
      }
    }
  } else if (action === "add") {
    const set = internal.set;
    const clone = internal.clone;
    if (!clone || clone.removed === true) problems.push("the new variant was not created");
    else {
      if (clone.type !== "COMPONENT") problems.push(`the new variant is ${clone.type}, not COMPONENT`);
      if (clone.parent?.id !== set.id) problems.push("the new variant is not under the set");
      if (set.children[internal.index]?.id !== clone.id) {
        problems.push(`the new variant is at child index ${set.children.findIndex((c: any) => c.id === clone.id)}, expected ${internal.index}`);
      }
      const got = variantPropertiesOf(clone);
      if (!sameProperties(got, internal.properties)) {
        problems.push(`the new variant reads back as ${JSON.stringify(got)}, expected ${JSON.stringify(internal.properties)}`);
      }
    }
    const children = variantsOf(set);
    if (children.length !== internal.before + 1) problems.push(`set has ${children.length} variants, expected ${internal.before + 1}`);
    if (!groupMatches(groupProperties(set), internal.expectedGroups, true)) {
      problems.push(`set matrix is ${JSON.stringify(groupProperties(set))}, expected ${JSON.stringify(internal.expectedGroups)}`);
    }
  } else if (action === "edit") {
    const set = internal.set;
    const variant = internal.variant;
    if (variant.removed === true) problems.push("the edited variant was removed");
    if (variant.type !== "COMPONENT") problems.push(`the edited variant is ${variant.type}, not COMPONENT`);
    if (variant.parent?.id !== set.id) problems.push("the edited variant is not under the set");
    const got = variantPropertiesOf(variant);
    if (!sameProperties(got, internal.properties)) {
      problems.push(`the edited variant reads back as ${JSON.stringify(got)}, expected ${JSON.stringify(internal.properties)}`);
    }
    const children = variantsOf(set);
    if (children.length !== internal.before) problems.push(`set has ${children.length} variants, expected ${internal.before}`);
    if (!groupMatches(groupProperties(set), internal.expectedGroups, true)) {
      problems.push(`set matrix is ${JSON.stringify(groupProperties(set))}, expected ${JSON.stringify(internal.expectedGroups)}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * The public entry point. `figma` is the Plugin API (or a stub in tests); it is
 * an argument, never the global, so the planner and apply path are testable.
 */
export async function runVariantSet(figma: any, params: Json): Promise<Json> {
  const t0 = Date.now();
  const dryRun = params?.dryRun !== false;
  const plan = await buildPlan(figma, params);
  const publicPlan = plan.public;
  const planMs = Date.now() - t0;

  if (dryRun) {
    return { ...publicPlan, ms: { plan: planMs } };
  }

  if (!isObj(params.expectedFingerprints)) {
    throw new Error(
      "VARIANT_SET_FINGERPRINTS_REQUIRED: apply needs expectedFingerprints from a dry run (nodeId -> fingerprint). " +
        "Run figma_variant_set with dryRun:true first.",
    );
  }
  const missing = missingFingerprints(plan.internal.fingerprints, params.expectedFingerprints);
  if (missing.length) {
    throw new Error(`VARIANT_SET_FINGERPRINTS_REQUIRED: no fingerprint for ${missing.join(", ")}; run the dry run again.`);
  }
  const mismatch = fingerprintMismatch(plan.internal.fingerprints, params.expectedFingerprints);
  if (mismatch.length) {
    return {
      status: "refused",
      reason: "FINGERPRINT_MISMATCH",
      schema: VARIANT_SET_SCHEMA,
      dryRun: false,
      message: "The document changed since the plan was made. Run figma_variant_set with dryRun:true again.",
      mismatch,
      ms: { plan: planMs },
    };
  }
  if (plan.internal.action === "edit" && plan.internal.noop) {
    return { ...publicPlan, status: "noop", dryRun: false, ms: { plan: planMs } };
  }

  figma.commitUndo();
  let wrote = false;
  const mark = () => { if (!wrote) { wrote = true; figma.commitUndo(); } };
  try {
    if (plan.internal.action === "combine") {
      for (let i = 0; i < plan.internal.components.length; i++) {
        const c = plan.internal.components[i];
        mark();
        c.name = plan.internal.names[i];
      }
      mark();
      const set = figma.combineAsVariants(plan.internal.components, plan.internal.parent);
      if (!set) throw new Error("figma.combineAsVariants returned no COMPONENT_SET");
      set.name = plan.internal.setName;
      plan.internal.set = set;
    } else if (plan.internal.action === "add") {
      mark();
      const clone = plan.internal.source.clone();
      if (!clone) throw new Error("clone() returned no component");
      clone.name = plan.internal.name;
      plan.internal.set.insertChild(plan.internal.index, clone);
      if (plan.internal.set.layoutMode === "NONE") {
        clone.x = Number(plan.internal.source.x || 0) + Number(plan.internal.source.width || 0) + 24;
        clone.y = Number(plan.internal.source.y || 0);
      }
      plan.internal.clone = clone;
    } else if (plan.internal.action === "edit") {
      mark();
      plan.internal.variant.name = plan.internal.name;
    } else {
      throw new Error(`variant_set: unsupported action "${plan.internal.action}"`);
    }

    const verification = verify(plan);
    if (!verification.ok) {
      throw new Error(`VARIANT_SET_VERIFICATION_FAILED: ${verification.problems.join("; ")}`);
    }
    figma.commitUndo();
    return {
      ...publicPlan,
      status: "applied",
      dryRun: false,
      set: plan.internal.set ? {
        ...targetRef(plan.internal.set),
        name: plan.internal.set.name,
        variantProperties: groupProperties(plan.internal.set),
        defaultVariantId: plan.internal.set.defaultVariant?.id ?? null,
        nodeId: plan.internal.set.id,
      } : publicPlan.set,
      components: plan.internal.action === "combine"
        ? plan.internal.components.map((c: any, i: number) => ({
            ...publicPlan.components[i],
            nodeId: c.id,
            name: c.name,
            variantProperties: variantPropertiesOf(c),
          }))
        : publicPlan.components,
      variant: plan.internal.action === "add"
        ? { ...publicPlan.variant, nodeId: plan.internal.clone.id, name: plan.internal.clone.name, properties: variantPropertiesOf(plan.internal.clone) }
        : plan.internal.action === "edit"
          ? { ...publicPlan.variant, nodeId: plan.internal.variant.id, name: plan.internal.variant.name, properties: variantPropertiesOf(plan.internal.variant), previousProperties: plan.internal.oldProps }
          : publicPlan.variant,
      verification,
      ms: { plan: planMs, apply: Date.now() - t0 - planMs, total: Date.now() - t0 },
    };
  } catch (e) {
    let rolledBack = false;
    if (wrote) {
      try {
        figma.commitUndo();
        figma.triggerUndo();
        rolledBack = true;
      } catch {
        // The document may now contain part of this transaction. Saying
        // "rolled back" here would be a lie; the caller must re-inspect.
      }
    }
    const suffix = !wrote ? "" : rolledBack ? " (rolled back)" : " (ROLLBACK FAILED; the document may contain partial changes — inspect before retrying)";
    throw new Error(errMsg(e) + suffix);
  }
}
