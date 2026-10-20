// Unit tests for variant-set authoring against a stub Plugin API.
//
// The subject is the matrix, not that combineAsVariants was called: a dry run
// must validate property names/combinations and fingerprint the components,
// set and destination; apply must rename, combine/clone/rename, verify that
// Figma actually parsed the names back into variantProperties, and roll back
// when it did not.

import test from "node:test";
import assert from "node:assert/strict";
import { runVariantSet } from "../plugin/variant-sets.mjs";

let seq = 0;
const nextId = () => `${++seq}:${seq}`;
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

const DEFAULTS = {
  x: 0, y: 0, width: 100, height: 100,
  opacity: 1, blendMode: "NORMAL", visible: true, locked: false,
  isMask: false, maskType: "ALPHA", clipsContent: false, rotation: 0,
  fills: [], strokes: [], strokeWeight: 1, strokeAlign: "INSIDE",
  strokeCap: "NONE", strokeJoin: "MITER", dashPattern: [],
  cornerRadius: 0, topLeftRadius: 0, topRightRadius: 0, bottomRightRadius: 0, bottomLeftRadius: 0,
  effects: [], layoutGrids: [], exportSettings: [],
  fillStyleId: "", strokeStyleId: "", effectStyleId: "", textStyleId: "",
  boundVariables: undefined, explicitVariableModes: {},
  layoutMode: "NONE", paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
  itemSpacing: 0, primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN",
  primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED",
  layoutWrap: "NO_WRAP", counterAxisSpacing: null,
  strokesIncludedInLayout: false, itemReverseZIndex: false,
  layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED",
  layoutAlign: "INHERIT", layoutGrow: 0, layoutPositioning: "AUTO",
  constraints: { horizontal: "MIN", vertical: "MIN" },
  minWidth: null, minHeight: null, maxWidth: null, maxHeight: null,
};

function parseVariantName(name) {
  const out = {};
  for (const part of String(name || "").split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) return null;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!key || !value) return null;
    out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

function node(type, props = {}) {
  const n = {
    id: nextId(),
    type,
    ...clone(DEFAULTS),
    children: [],
    parent: null,
    removed: false,
    pluginData: new Map(),
    componentPropertyDefinitions: {},
    ...props,
  };
  let name = props.name || type;
  Object.defineProperty(n, "name", {
    enumerable: true,
    configurable: true,
    get: () => name,
    set: (value) => {
      name = String(value);
      if (n.type === "COMPONENT") {
        n.variantProperties = n.parent?.type === "COMPONENT_SET" ? parseVariantName(name) : null;
      }
    },
  });
  n.variantProperties = null;

  const detach = (child) => {
    if (child.parent) child.parent.children = child.parent.children.filter((c) => c !== child);
  };
  const attach = (child, index = null) => {
    detach(child);
    child.parent = n;
    if (index === null) n.children.push(child);
    else n.children.splice(index, 0, child);
    if (n.type === "COMPONENT_SET" && child.type === "COMPONENT") {
      child.variantProperties = n._ctx?.ignoreVariantNames ? null : parseVariantName(child.name);
    } else if (child.type === "COMPONENT" && n.type !== "COMPONENT_SET") {
      child.variantProperties = null;
    }
    child._ctx?.register?.(child);
    return child;
  };

  n.appendChild = (child) => attach(child);
  n.insertChild = (index, child) => attach(child, index);
  n.getPluginData = (key) => n.pluginData.get(key) || "";
  n.setPluginData = (key, value) => { n.pluginData.set(key, String(value)); };
  n.remove = () => {
    detach(n);
    n.removed = true;
  };
  n.clone = function cloneComponent() {
    if (n.type !== "COMPONENT") throw new Error("clone is only implemented for COMPONENT in this stub");
    const copy = cloneTree(n);
    n._ctx?.metrics && (n._ctx.metrics.clones++);
    n._ctx?.register?.(copy);
    return copy;
  };
  return n;
}

function cloneTree(src) {
  const data = {};
  for (const [key, value] of Object.entries(src)) {
    if (key.startsWith("_")) continue;
    if (["id", "parent", "children", "pluginData", "removed", "variantProperties"].includes(key)) continue;
    if (typeof value === "function") continue;
    data[key] = clone(value);
  }
  const out = node(src.type, { ...data, name: src.name });
  out.componentPropertyDefinitions = clone(src.componentPropertyDefinitions || {});
  out._ctx = src._ctx;
  for (const child of src.children || []) out.appendChild(cloneTree(child));
  return out;
}

function makeCtx() {
  const byId = new Map();
  const metrics = { combines: 0, clones: 0, commits: 0, undos: 0 };
  const page = node("PAGE", { name: "Page", width: 1000, height: 1000 });
  const root = node("DOCUMENT", { name: "Document", children: [page] });
  page.parent = root;

  const ctx = {
    currentPage: page,
    root,
    metrics,
    async getNodeByIdAsync(id) { return byId.get(id) || null; },
    async loadAllPagesAsync() {},
    async loadFontAsync() {},
    commitUndo() { metrics.commits++; },
    triggerUndo() { metrics.undos++; },
    register(n) {
      byId.set(n.id, n);
      n._ctx = ctx;
      for (const child of n.children || []) ctx.register(child);
      return n;
    },
    add(n, parent = page) {
      parent.appendChild(n);
      ctx.register(n);
      return n;
    },
    combineAsVariants(nodes, parent) {
      metrics.combines++;
      const set = node("COMPONENT_SET", { name: "Component Set", width: 200, height: 200, layoutMode: "HORIZONTAL" });
      Object.defineProperty(set, "variantGroupProperties", {
        enumerable: true,
        configurable: true,
        get() {
          const out = {};
          for (const child of set.children) {
            if (child.type !== "COMPONENT" || !child.variantProperties) continue;
            for (const [k, v] of Object.entries(child.variantProperties)) (out[k] ||= new Set()).add(v);
          }
          return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { values: [...v].sort() }]));
        },
      });
      Object.defineProperty(set, "defaultVariant", {
        enumerable: true,
        configurable: true,
        get() { return set.children.find((c) => c.type === "COMPONENT") || null; },
      });
      ctx.register(set);
      parent.appendChild(set);
      for (const n of nodes) set.appendChild(n);
      return set;
    },
  };
  ctx.register(root);
  return ctx;
}

function component(ctx, name, props = {}) {
  return ctx.add(node("COMPONENT", { name, ...props }));
}

function combineParams(a, b, extra = {}) {
  return {
    action: "combine",
    name: "Button",
    components: [
      { nodeId: a.id, properties: { Size: "S", Tone: "Light" } },
      { nodeId: b.id, properties: { Size: "M", Tone: "Light" } },
    ],
    ...extra,
  };
}

function apply(ctx, dry, params) {
  return runVariantSet(ctx, { ...params, dryRun: false, expectedFingerprints: dry.fingerprints });
}

async function combined() {
  const ctx = makeCtx();
  const a = component(ctx, "Button/Default");
  const b = component(ctx, "Button/Hover");
  const params = combineParams(a, b);
  const dry = await runVariantSet(ctx, params);
  const applied = await apply(ctx, dry, params);
  assert.equal(applied.status, "applied");
  return { ctx, set: byId(ctx, applied.set.id), components: applied.components.map((c) => byId(ctx, c.nodeId)), dry, params };
}

function byId(ctx, id) {
  // The fake keeps its registry private; find by walking the page.
  const visit = (n) => {
    if (n.id === id) return n;
    for (const c of n.children || []) {
      const hit = visit(c);
      if (hit) return hit;
    }
    return null;
  };
  return visit(ctx.currentPage);
}

test("combine dry run validates the matrix and writes nothing", async () => {
  const ctx = makeCtx();
  const a = component(ctx, "Button/Default");
  const b = component(ctx, "Button/Hover");
  const dry = await runVariantSet(ctx, combineParams(a, b));
  assert.equal(dry.status, "dry_run");
  assert.equal(dry.action, "combine");
  assert.equal(dry.set.name, "Button");
  assert.deepEqual(dry.variantProperties, { Size: { values: ["M", "S"] }, Tone: { values: ["Light"] } });
  assert.equal(dry.components.length, 2);
  assert.equal(dry.components[0].variantName, "Size=S, Tone=Light");
  assert.equal(dry.fingerprints[a.id] !== undefined, true);
  assert.equal(dry.fingerprints[b.id] !== undefined, true);
  assert.equal(ctx.metrics.combines, 0);
  assert.equal(ctx.metrics.commits, 0);
  assert.equal(a.parent, ctx.currentPage);
});

test("combine apply renames, combines and verifies the set matrix", async () => {
  const { ctx, set, components } = await combined();
  assert.equal(set.type, "COMPONENT_SET");
  assert.equal(set.name, "Button");
  assert.equal(set.children.length, 2);
  assert.deepEqual(components.map((c) => c.name), ["Size=S, Tone=Light", "Size=M, Tone=Light"]);
  assert.deepEqual(components.map((c) => c.variantProperties), [
    { Size: "S", Tone: "Light" },
    { Size: "M", Tone: "Light" },
  ]);
  assert.equal(ctx.metrics.combines, 1);
  assert.ok(ctx.metrics.commits >= 3);
  assert.equal(ctx.metrics.undos, 0);
});

test("combine fingerprints the destination layout", async () => {
  const ctx = makeCtx();
  const parent = ctx.add(node("FRAME", { name: "Board", width: 300, height: 300, layoutMode: "NONE" }));
  const a = component(ctx, "Button/Default");
  const b = component(ctx, "Button/Hover");
  const params = combineParams(a, b, { parentId: parent.id });
  const dry = await runVariantSet(ctx, params);
  assert.ok(dry.fingerprints[parent.id]);
  parent.layoutMode = "VERTICAL";
  const refused = await apply(ctx, dry, params);
  assert.equal(refused.status, "refused");
  assert.equal(refused.reason, "FINGERPRINT_MISMATCH");
  assert.equal(ctx.metrics.combines, 0);
  assert.equal(a.parent, ctx.currentPage);
});

test("combine refuses duplicate combinations and mismatched property names", async () => {
  const ctx = makeCtx();
  const a = component(ctx, "A");
  const b = component(ctx, "B");
  const dup = combineParams(a, b);
  dup.components[1].properties = { Size: "S", Tone: "Light" };
  await assert.rejects(() => runVariantSet(ctx, dup), /describe the same variant/);

  const mixed = combineParams(a, b);
  mixed.components[1].properties = { Size: "M" };
  await assert.rejects(() => runVariantSet(ctx, mixed), /same property names/);
});

test("combine refuses a destination inside an INSTANCE", async () => {
  const ctx = makeCtx();
  const a = component(ctx, "A");
  const b = component(ctx, "B");
  const instance = ctx.add(node("INSTANCE", { name: "Use" }));
  const params = combineParams(a, b, { parentId: instance.id });
  await assert.rejects(() => runVariantSet(ctx, params), /INSTANCE cannot accept children/);
});

test("add clones an existing variant and verifies the new matrix value", async () => {
  const { ctx, set, components } = await combined();
  const source = components[0];
  const params = { action: "add", sourceId: source.id, properties: { Size: "L", Tone: "Light" } };
  const dry = await runVariantSet(ctx, params);
  assert.equal(dry.action, "add");
  assert.equal(dry.variant.name, "Size=L, Tone=Light");
  assert.equal(dry.variant.nodeId, null);
  assert.equal(dry.set.nodeId, set.id);
  assert.ok(dry.fingerprints[set.id]);
  const applied = await apply(ctx, dry, params);
  assert.equal(applied.status, "applied");
  assert.equal(applied.verification.ok, true);
  assert.equal(set.children.length, 3);
  const added = set.children.find((c) => c.variantProperties?.Size === "L");
  assert.ok(added);
  assert.deepEqual(added.variantProperties, { Size: "L", Tone: "Light" });
  assert.equal(ctx.metrics.clones, 1);
  assert.ok(ctx.metrics.commits >= 3);
});

test("add refuses an existing combination and a changed set", async () => {
  const { ctx, set, components } = await combined();
  await assert.rejects(
    () => runVariantSet(ctx, { action: "add", sourceId: components[0].id, properties: { Size: "M", Tone: "Light" } }),
    /already has a variant/,
  );

  const params = { action: "add", sourceId: components[0].id, properties: { Size: "L", Tone: "Light" } };
  const dry = await runVariantSet(ctx, params);
  set.layoutMode = "VERTICAL";
  const refused = await apply(ctx, dry, params);
  assert.equal(refused.status, "refused");
  assert.equal(refused.reason, "FINGERPRINT_MISMATCH");
});

test("edit renames a variant in place and is a no-op when the values do not change", async () => {
  const { ctx, set, components } = await combined();
  const variant = components[0];
  const params = { action: "edit", variantId: variant.id, properties: { Size: "XL", Tone: "Light" } };
  const dry = await runVariantSet(ctx, params);
  assert.equal(dry.variant.previousProperties.Size, "S");
  assert.equal(dry.variant.nodeId, variant.id);
  const applied = await apply(ctx, dry, params);
  assert.equal(applied.status, "applied");
  assert.equal(set.children.length, 2);
  assert.equal(variant.id, applied.variant.nodeId);
  assert.deepEqual(variant.variantProperties, { Size: "XL", Tone: "Light" });

  const noopParams = { action: "edit", variantId: variant.id, properties: { Size: "XL", Tone: "Light" } };
  const noop = await runVariantSet(ctx, noopParams);
  assert.equal(noop.status, "noop");
  const commits = ctx.metrics.commits;
  const result = await apply(ctx, noop, noopParams);
  assert.equal(result.status, "noop");
  assert.equal(ctx.metrics.commits, commits);
});

test("edit refuses a combination already used by another variant", async () => {
  const { ctx, components } = await combined();
  await assert.rejects(
    () => runVariantSet(ctx, { action: "edit", variantId: components[0].id, properties: { Size: "M", Tone: "Light" } }),
    /already has a variant/,
  );
});

test("combine refuses an already-variant component", async () => {
  const { ctx, components } = await combined();
  const standalone = component(ctx, "Other");
  await assert.rejects(
    () => runVariantSet(ctx, combineParams(components[0], standalone)),
    /already a variant/,
  );
});


test("combine rolls back when Figma does not parse the variant names", async () => {
  const ctx = makeCtx();
  ctx.ignoreVariantNames = true;
  const a = component(ctx, "Button/Default");
  const b = component(ctx, "Button/Hover");
  const params = combineParams(a, b);
  const dry = await runVariantSet(ctx, params);
  await assert.rejects(
    () => apply(ctx, dry, params),
    /VARIANT_SET_VERIFICATION_FAILED.*(read back|matrix).*rolled back/,
  );
  assert.equal(ctx.metrics.undos, 1);
});


test("combine refuses a destination inside a variant, and nested components inside a set", async () => {
  const { ctx, components } = await combined();
  const standalone = component(ctx, "Other");
  await assert.rejects(
    () => runVariantSet(ctx, combineParams(standalone, component(ctx, "Another"), { parentId: components[0].id })),
    /inside COMPONENT_SET|nested in another set/,
  );

  const nested = ctx.add(node("COMPONENT", { name: "Nested" }), components[0]);
  await assert.rejects(
    () => runVariantSet(ctx, combineParams(nested, standalone)),
    /inside COMPONENT_SET/,
  );
});

test("add rolls back when Figma's set matrix does not contain the new value", async () => {
  const { ctx, set, components } = await combined();
  Object.defineProperty(set, "variantGroupProperties", {
    configurable: true,
    get() {
      return { Size: { values: ["M", "S"] }, Tone: { values: ["Light"] } };
    },
  });
  const params = { action: "add", sourceId: components[0].id, properties: { Size: "L", Tone: "Light" } };
  const dry = await runVariantSet(ctx, params);
  await assert.rejects(
    () => apply(ctx, dry, params),
    /VARIANT_SET_VERIFICATION_FAILED.*set matrix.*rolled back/,
  );
  assert.equal(ctx.metrics.undos, 1);
});

test("add rolls back when the set ignores the requested insertion index", async () => {
  const { ctx, set, components } = await combined();
  set.insertChild = function ignoreIndex(_index, child) {
    return this.appendChild(child);
  };
  const params = { action: "add", sourceId: components[0].id, properties: { Size: "L", Tone: "Light" }, index: 0 };
  const dry = await runVariantSet(ctx, params);
  await assert.rejects(
    () => apply(ctx, dry, params),
    /VARIANT_SET_VERIFICATION_FAILED.*expected 0.*rolled back/,
  );
  assert.equal(ctx.metrics.undos, 1);
});

test("a failed undo is reported as a failed rollback, never as rolled back", async () => {
  const ctx = makeCtx();
  ctx.ignoreVariantNames = true;
  const a = component(ctx, "Button/Default");
  const b = component(ctx, "Button/Hover");
  const params = combineParams(a, b);
  const dry = await runVariantSet(ctx, params);
  ctx.triggerUndo = () => { throw new Error("undo unavailable"); };
  await assert.rejects(
    () => apply(ctx, dry, params),
    /ROLLBACK FAILED; the document may contain partial changes/,
  );
});

test("combine refuses a destination inside a standalone COMPONENT definition", async () => {
  const ctx = makeCtx();
  const container = component(ctx, "Container");
  const a = component(ctx, "A");
  const b = component(ctx, "B");
  await assert.rejects(
    () => runVariantSet(ctx, combineParams(a, b, { parentId: container.id })),
    /inside COMPONENT .*Figma refuses to reparent a component into a component definition/,
  );
});
