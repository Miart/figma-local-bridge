// Unit tests for the component-swap engine against a stub Plugin API.
//
// The point is not that swapComponent was called. It is that a swap is a
// migration: the plan must compare the two structures, name every override and
// property it cannot carry, refuse to land on a document that moved, and then
// actually restore the compatible root state, component properties and layer
// overrides in one transaction.

import test from "node:test";
import assert from "node:assert/strict";
import { runComponentSwap } from "../plugin/component-swap.mjs";

let seq = 0;
const nextId = () => `${++seq}:${seq}`;
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

const TEXT_DEFAULTS = {
  characters: "",
  fontName: { family: "Inter", style: "Regular" },
  fontSize: 16,
  lineHeight: { unit: "AUTO" },
  letterSpacing: { unit: "PIXELS", value: 0 },
  textCase: "ORIGINAL",
  textDecoration: "NONE",
  paragraphSpacing: 0,
  paragraphIndent: 0,
  hyperlink: null,
  textAlignHorizontal: "LEFT",
  textAlignVertical: "TOP",
  textAutoResize: "NONE",
};

const STATE_DEFAULTS = {
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

function defaultProperties(component) {
  const out = {};
  for (const [key, def] of Object.entries(component.componentPropertyDefinitions || {})) {
    let value = def.defaultValue;
    if (value === undefined) value = def.type === "BOOLEAN" ? false : "";
    out[key] = { type: def.type, value };
  }
  return out;
}

function node(type, props = {}) {
  const n = {
    id: nextId(),
    type,
    name: props.name || type,
    ...clone(STATE_DEFAULTS),
    ...(type === "TEXT" ? clone(TEXT_DEFAULTS) : {}),
    componentProperties: {},
    componentPropertyDefinitions: {},
    children: [],
    parent: null,
    removed: false,
    ...props,
    appendChild(child) {
      if (child.parent) child.parent.children = child.parent.children.filter((c) => c !== child);
      child.parent = this;
      this.children.push(child);
      this._ctx?.register?.(child);
      return child;
    },
    insertChild(index, child) {
      if (child.parent) child.parent.children = child.parent.children.filter((c) => c !== child);
      child.parent = this;
      this.children.splice(index, 0, child);
      this._ctx?.register?.(child);
      return child;
    },
    resize(width, height) {
      this.width = width;
      this.height = height;
    },
    setProperties(values) {
      for (const [key, value] of Object.entries(values)) {
        if (!(key in (this.componentPropertyDefinitions || {}))) {
          throw new Error(`unknown component property ${key}`);
        }
        this.componentProperties[key] = { type: this.componentPropertyDefinitions[key].type, value };
      }
    },
    async getMainComponentAsync() {
      if (this.type === "INSTANCE") return this.mainComponent || null;
      return null;
    },
    swapComponent(component) {
      if (!component || component.type !== "COMPONENT") throw new Error("swapComponent needs a COMPONENT");
      this.onSwap?.();
      this.mainComponent = component;
      this.children = [];
      for (const child of component.children) this.appendChild(cloneTree(child));
      this.overrides = [];
      this.name = component.name;
      for (const key of [
        "width", "height", "opacity", "blendMode", "visible", "locked", "isMask", "maskType",
        "clipsContent", "rotation", "fills", "strokes", "strokeWeight", "strokeAlign", "strokeCap",
        "strokeJoin", "dashPattern", "cornerRadius", "topLeftRadius", "topRightRadius",
        "bottomRightRadius", "bottomLeftRadius", "effects", "layoutGrids", "exportSettings",
        "fillStyleId", "strokeStyleId", "effectStyleId", "textStyleId", "layoutMode",
        "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "itemSpacing",
        "primaryAxisAlignItems", "counterAxisAlignItems", "primaryAxisSizingMode",
        "counterAxisSizingMode", "layoutWrap", "counterAxisSpacing", "strokesIncludedInLayout",
        "itemReverseZIndex", "layoutSizingHorizontal", "layoutSizingVertical", "layoutAlign",
        "layoutGrow", "layoutPositioning", "constraints", "minWidth", "minHeight", "maxWidth", "maxHeight",
      ]) this[key] = clone(component[key]);
      this.componentPropertyDefinitions = clone(component.componentPropertyDefinitions);
      this.componentProperties = defaultProperties(component);
    },
    getStyledTextSegments() {
      return [];
    },
    getPluginData() {
      return "";
    },
    setPluginData() {},
    remove() {
      this.removed = true;
      if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    },
  };
  if (type === "COMPONENT") {
    n.createInstance = function createInstance() {
      const inst = node("INSTANCE", {
        name: this.name,
        width: this.width,
        height: this.height,
        mainComponent: this,
        componentPropertyDefinitions: clone(this.componentPropertyDefinitions),
      });
      inst.componentProperties = defaultProperties(this);
      inst._ctx = this._ctx;
      for (const child of this.children) inst.appendChild(cloneTree(child));
      this._ctx?.register?.(inst);
      return inst;
    };
  }
  for (const child of props.children || []) n.appendChild(child);
  return n;
}

function cloneTree(src) {
  const data = {};
  for (const [key, value] of Object.entries(src)) {
    if (key.startsWith("_")) continue;
    if (typeof value === "function") continue;
    if (["id", "parent", "children", "mainComponent", "overrides", "componentProperties", "componentPropertyDefinitions"].includes(key)) continue;
    data[key] = clone(value);
  }
  const out = node(src.type, data);
  out.componentPropertyDefinitions = clone(src.componentPropertyDefinitions || {});
  out.componentProperties = clone(src.componentProperties || {});
  if (src.type === "INSTANCE") {
    out.mainComponent = src.mainComponent;
    out.overrides = [];
  }
  out._ctx = src._ctx;
  for (const child of src.children || []) out.appendChild(cloneTree(child));
  return out;
}

function makeCtx() {
  const byId = new Map();
  const metrics = { swaps: 0, imports: 0, commits: 0, undos: 0 };
  const page = node("PAGE", { name: "Page" });
  const root = node("DOCUMENT", { name: "Document", children: [page] });
  const ctx = {
    mixed: Symbol("mixed"),
    root,
    currentPage: page,
    metrics,
    async getNodeByIdAsync(id) {
      return byId.get(id) || null;
    },
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
    add(n) {
      page.appendChild(n);
      ctx.register(n);
      return n;
    },
  };
  ctx.register(root);
  return ctx;
}

function buttonPair(ctx, { newChildren } = {}) {
  const oldMain = node("COMPONENT", {
    name: "Button",
    key: "button-old",
    width: 200,
    height: 60,
    componentPropertyDefinitions: {
      "Label#old": { type: "TEXT", defaultValue: "Default" },
      "Show icon#old": { type: "BOOLEAN", defaultValue: true },
    },
  });
  const oldLabel = node("TEXT", { name: "Label", characters: "Default", fontSize: 12, width: 100, height: 20 });
  const oldIcon = node("RECTANGLE", { name: "Icon", width: 24, height: 24 });
  oldMain.appendChild(oldLabel);
  oldMain.appendChild(oldIcon);

  const newMain = node("COMPONENT", {
    name: "Button v2",
    key: "button-new",
    width: 240,
    height: 64,
    componentPropertyDefinitions: {
      "Label#new": { type: "TEXT", defaultValue: "New default" },
      "Show icon#new": { type: "BOOLEAN", defaultValue: false },
    },
  });
  const children = newChildren || [
    node("TEXT", { name: "Label", characters: "New default", fontSize: 12, width: 120, height: 20 }),
    node("RECTANGLE", { name: "Icon", width: 28, height: 28 }),
  ];
  for (const child of children) newMain.appendChild(child);

  ctx.add(oldMain);
  ctx.add(newMain);
  return { oldMain, oldLabel, oldIcon, newMain };
}

test("dry run compares the structures and writes nothing", async () => {
  const ctx = makeCtx();
  const { oldMain, newMain } = buttonPair(ctx);
  const inst = oldMain.createInstance();
  inst.name = "Play button";
  inst.resize(180, 50);
  inst.opacity = 0.85;
  inst.componentProperties["Label#old"].value = "Play";
  inst.componentProperties["Show icon#old"].value = false;
  inst.children[0].characters = "Play";
  inst.children[0].visible = false;
  inst.children[1].opacity = 0.5;
  inst.children[1].resize(16, 16);
  inst.overrides = [
    { id: inst.children[0].id, overriddenFields: ["characters", "visible"] },
    { id: inst.children[1].id, overriddenFields: ["opacity", "width", "height"] },
  ];
  inst.onSwap = () => { ctx.metrics.swaps++; };

  const plan = await runComponentSwap(ctx, {
    nodeIds: [inst.id],
    componentId: newMain.id,
    dryRun: true,
  });

  assert.equal(plan.status, "dry_run");
  assert.equal(plan.state, "compatible");
  assert.equal(plan.targets.length, 1);
  assert.equal(plan.targets[0].compatibility.status, "compatible");
  assert.equal(plan.targets[0].compatibility.overrides.total, 2);
  assert.equal(plan.targets[0].compatibility.overrides.replayable, 2);
  assert.equal(plan.targets[0].compatibility.overrides.atRisk, 0);
  assert.equal(plan.targets[0].compatibility.properties.replayable, 2);
  assert.equal(plan.targets[0].compatibility.properties.dropped, 0);
  assert.deepEqual(plan.targets[0].compatibility.root.fields.sort(), ["height", "opacity", "width"]);
  assert.equal(plan.targets[0].compatibility.root.size, "preserved");
  assert.equal(ctx.metrics.swaps, 0);
  assert.equal(ctx.metrics.commits, 0);
  assert.equal(ctx.metrics.undos, 0);
  assert.match(plan.targets[0].fingerprint, /^[0-9a-f]+$/);
});

test("apply restores root overrides, maps component properties and replays layer overrides", async () => {
  const ctx = makeCtx();
  const { oldMain, newMain } = buttonPair(ctx);
  const inst = oldMain.createInstance();
  inst.name = "Play button";
  inst.resize(180, 50);
  inst.opacity = 0.85;
  inst.componentProperties["Label#old"].value = "Play";
  inst.componentProperties["Show icon#old"].value = false;
  inst.children[0].characters = "Play";
  inst.children[0].visible = false;
  inst.children[1].opacity = 0.5;
  inst.children[1].resize(16, 16);
  inst.overrides = [
    { id: inst.children[0].id, overriddenFields: ["characters", "visible"] },
    { id: inst.children[1].id, overriddenFields: ["opacity", "width", "height"] },
  ];
  inst.onSwap = () => { ctx.metrics.swaps++; };

  const dry = await runComponentSwap(ctx, { nodeIds: [inst.id], componentId: newMain.id, dryRun: true });
  const applied = await runComponentSwap(ctx, {
    nodeIds: [inst.id],
    componentId: newMain.id,
    dryRun: false,
    expectedFingerprints: { [inst.id]: dry.targets[0].fingerprint },
  });

  assert.equal(applied.status, "applied");
  assert.equal(applied.verification.ok, true);
  assert.equal(ctx.metrics.swaps, 1);
  assert.equal(ctx.metrics.commits, 3);
  assert.equal(ctx.metrics.undos, 0);
  assert.equal(inst.mainComponent, newMain);
  assert.equal(inst.name, "Play button");
  assert.equal(inst.width, 180);
  assert.equal(inst.height, 50);
  assert.equal(inst.opacity, 0.85);
  assert.equal(inst.componentProperties["Label#new"].value, "Play");
  assert.equal(inst.componentProperties["Show icon#new"].value, false);
  assert.equal(inst.children[0].characters, "Play");
  assert.equal(inst.children[0].visible, false);
  assert.equal(inst.children[1].opacity, 0.5);
  assert.equal(inst.children[1].width, 16);
  assert.equal(inst.children[1].height, 16);
  assert.equal(applied.targets[0].overrides.restored, 2);
  assert.equal(applied.targets[0].overrides.missing, 0);
});

test("a missing layer is named in the dry run and blocks apply unless allowLoss is set", async () => {
  const ctx = makeCtx();
  const { oldMain, newMain } = buttonPair(ctx, {
    newChildren: [
      node("TEXT", { name: "Label", characters: "New default", width: 120, height: 20 }),
      node("RECTANGLE", { name: "Other", width: 28, height: 28 }),
    ],
  });
  const inst = oldMain.createInstance();
  inst.children[0].characters = "Play";
  inst.children[0].visible = false;
  inst.children[1].opacity = 0.5;
  inst.overrides = [
    { id: inst.children[0].id, overriddenFields: ["characters", "visible"] },
    { id: inst.children[1].id, overriddenFields: ["opacity"] },
  ];
  inst.onSwap = () => { ctx.metrics.swaps++; };

  const dry = await runComponentSwap(ctx, { nodeIds: [inst.id], componentId: newMain.id, dryRun: true });
  assert.equal(dry.state, "lossy");
  assert.equal(dry.targets[0].compatibility.overrides.missing, 1);
  assert.ok(dry.targets[0].compatibility.losses.some((l) => l.kind === "override-missing" && l.layer === "Icon"));

  await assert.rejects(
    runComponentSwap(ctx, {
      nodeIds: [inst.id],
      componentId: newMain.id,
      dryRun: false,
      expectedFingerprints: { [inst.id]: dry.targets[0].fingerprint },
    }),
    /COMPONENT_SWAP_LOSSY/,
  );
  assert.equal(ctx.metrics.swaps, 0);

  const applied = await runComponentSwap(ctx, {
    nodeIds: [inst.id],
    componentId: newMain.id,
    dryRun: false,
    allowLoss: true,
    expectedFingerprints: { [inst.id]: dry.targets[0].fingerprint },
  });
  assert.equal(applied.status, "applied");
  assert.equal(applied.verification.ok, false);
  assert.equal(ctx.metrics.swaps, 1);
  assert.equal(inst.children[0].characters, "Play");
  assert.ok(applied.report.plannedLosses.length >= 1);
  assert.ok(applied.targets[0].losses.some((l) => l.kind === "override-missing"));
});

test("a moved target is refused before the first write", async () => {
  const ctx = makeCtx();
  const { oldMain, newMain } = buttonPair(ctx);
  const inst = oldMain.createInstance();
  inst.onSwap = () => { ctx.metrics.swaps++; };
  const dry = await runComponentSwap(ctx, { nodeIds: [inst.id], componentId: newMain.id, dryRun: true });
  inst.opacity = 0.5;

  const refused = await runComponentSwap(ctx, {
    nodeIds: [inst.id],
    componentId: newMain.id,
    dryRun: false,
    expectedFingerprints: { [inst.id]: dry.targets[0].fingerprint },
  });
  assert.equal(refused.status, "refused");
  assert.equal(refused.reason, "FINGERPRINT_MISMATCH");
  assert.equal(ctx.metrics.swaps, 0);
  assert.equal(ctx.metrics.commits, 0);
});

test("apply requires a fingerprint from the dry run", async () => {
  const ctx = makeCtx();
  const { oldMain, newMain } = buttonPair(ctx);
  const inst = oldMain.createInstance();
  await assert.rejects(
    runComponentSwap(ctx, { nodeIds: [inst.id], componentId: newMain.id, dryRun: false }),
    /FINGERPRINTS_REQUIRED/,
  );
  assert.equal(ctx.metrics.swaps, 0);
});

test("a uniquely named layer is remapped and reported as a change, not a loss", async () => {
  const ctx = makeCtx();
  const { oldMain, newMain } = buttonPair(ctx, {
    newChildren: [
      node("FRAME", { name: "Spacer", width: 8, height: 8 }),
      node("TEXT", { name: "Label", characters: "New default", width: 120, height: 20 }),
    ],
  });
  const inst = oldMain.createInstance();
  inst.children[0].characters = "Play";
  inst.overrides = [{ id: inst.children[0].id, overriddenFields: ["characters"] }];
  inst.onSwap = () => { ctx.metrics.swaps++; };

  const dry = await runComponentSwap(ctx, { nodeIds: [inst.id], componentId: newMain.id, dryRun: true });
  assert.equal(dry.state, "compatible");
  assert.equal(dry.targets[0].compatibility.overrides.remapped, 1);
  assert.equal(dry.targets[0].compatibility.losses.length, 0);
  assert.equal(dry.targets[0].compatibility.lossCount, 0);
  assert.ok(dry.targets[0].compatibility.changes.some((c) => c.kind === "override-remapped"));

  const applied = await runComponentSwap(ctx, {
    nodeIds: [inst.id],
    componentId: newMain.id,
    dryRun: false,
    expectedFingerprints: { [inst.id]: dry.targets[0].fingerprint },
  });
  assert.equal(applied.status, "applied");
  assert.equal(applied.verification.ok, true);
  assert.equal(inst.children[1].name, "Label");
  assert.equal(inst.children[1].characters, "Play");
});

test("a changed node type is a named loss, not an override applied to the wrong layer", async () => {
  const ctx = makeCtx();
  const { oldMain, newMain } = buttonPair(ctx, {
    newChildren: [
      node("TEXT", { name: "Label", characters: "New default", width: 120, height: 20 }),
      node("ELLIPSE", { name: "Icon", width: 28, height: 28 }),
    ],
  });
  const inst = oldMain.createInstance();
  inst.children[1].opacity = 0.5;
  inst.children[1].resize(16, 16);
  inst.overrides = [{ id: inst.children[1].id, overriddenFields: ["opacity", "width", "height"] }];
  inst.onSwap = () => { ctx.metrics.swaps++; };

  const dry = await runComponentSwap(ctx, { nodeIds: [inst.id], componentId: newMain.id, dryRun: true });
  assert.equal(dry.state, "lossy");
  assert.equal(dry.targets[0].compatibility.overrides.typeChanged, 1);
  assert.ok(dry.targets[0].compatibility.losses.some((l) => l.kind === "override-type-changed" && l.layer === "Icon"));

  const applied = await runComponentSwap(ctx, {
    nodeIds: [inst.id],
    componentId: newMain.id,
    dryRun: false,
    allowLoss: true,
    expectedFingerprints: { [inst.id]: dry.targets[0].fingerprint },
  });
  assert.equal(applied.status, "applied");
  assert.equal(applied.targets[0].predictedLosses, 1);
  assert.equal(applied.verification.ok, false);
  assert.equal(inst.children[1].type, "ELLIPSE");
  assert.equal(inst.children[1].opacity, 1);
});

test("a component property that disappeared is reported rather than invented", async () => {
  const ctx = makeCtx();
  const { oldMain, newMain } = buttonPair(ctx);
  newMain.componentPropertyDefinitions = { "Label#new": { type: "TEXT", defaultValue: "New default" } };
  const inst = oldMain.createInstance();
  inst.componentProperties["Show icon#old"].value = false;
  inst.onSwap = () => { ctx.metrics.swaps++; };

  const dry = await runComponentSwap(ctx, { nodeIds: [inst.id], componentId: newMain.id, dryRun: true });
  assert.equal(dry.state, "lossy");
  assert.equal(dry.targets[0].compatibility.properties.replayable, 1);
  assert.equal(dry.targets[0].compatibility.properties.dropped, 1);
  assert.ok(dry.targets[0].compatibility.losses.some((l) => l.kind === "property-dropped" && l.name === "Show icon"));

  await assert.rejects(
    runComponentSwap(ctx, {
      nodeIds: [inst.id],
      componentId: newMain.id,
      dryRun: false,
      expectedFingerprints: { [inst.id]: dry.targets[0].fingerprint },
    }),
    /COMPONENT_SWAP_LOSSY/,
  );
  assert.equal(ctx.metrics.swaps, 0);
});

test("an unexpected loss during apply rolls the whole transaction back", async () => {
  const ctx = makeCtx();
  const { oldMain, newMain } = buttonPair(ctx);
  const inst = oldMain.createInstance();
  inst.children[0].characters = "Play";
  inst.overrides = [{ id: inst.children[0].id, overriddenFields: ["characters"] }];
  inst.onSwap = () => { ctx.metrics.swaps++; };
  const dry = await runComponentSwap(ctx, { nodeIds: [inst.id], componentId: newMain.id, dryRun: true });
  assert.equal(dry.state, "compatible");

  // The target component changes at the instant of the swap. The target
  // instance itself did not, so only the post-apply report can catch the loss —
  // and it must undo the whole transaction.
  const originalSwap = inst.swapComponent;
  inst.swapComponent = function (component) {
    component.children = component.children.filter((c) => c.name !== "Label");
    return originalSwap.call(this, component);
  };
  await assert.rejects(
    runComponentSwap(ctx, {
      nodeIds: [inst.id],
      componentId: newMain.id,
      dryRun: false,
      expectedFingerprints: { [inst.id]: dry.targets[0].fingerprint },
    }),
    /rolled back/,
  );
  assert.equal(ctx.metrics.swaps, 1);
  assert.equal(ctx.metrics.undos, 1);
});

test("an instance nested inside another instance is refused as a swap target", async () => {
  const ctx = makeCtx();
  const { oldMain, newMain } = buttonPair(ctx);
  const inner = node("COMPONENT", { name: "Inner", width: 10, height: 10, key: "inner" });
  ctx.add(inner);
  const innerInst = inner.createInstance();
  const outerMain = node("COMPONENT", { name: "Outer", width: 100, height: 100 });
  outerMain.appendChild(innerInst);
  ctx.add(outerMain);
  const outer = outerMain.createInstance();
  const nested = outer.children[0];
  assert.equal(nested.type, "INSTANCE");

  const dry = await runComponentSwap(ctx, { nodeIds: [nested.id], componentId: newMain.id, dryRun: true });
  assert.equal(dry.state, "incompatible");
  assert.match(dry.blocking[0].why, /inside another INSTANCE/);
  await assert.rejects(
    runComponentSwap(ctx, { nodeIds: [nested.id], componentId: newMain.id, dryRun: false }),
    /COMPONENT_SWAP_BLOCKED/,
  );
  assert.equal(ctx.metrics.swaps, 0);
});

test("preserveSize:false adopts the new component size but keeps other root overrides", async () => {
  const ctx = makeCtx();
  const { oldMain, newMain } = buttonPair(ctx);
  const inst = oldMain.createInstance();
  inst.name = "Play button";
  inst.resize(180, 50);
  inst.opacity = 0.85;
  inst.onSwap = () => { ctx.metrics.swaps++; };

  const dry = await runComponentSwap(ctx, {
    nodeIds: [inst.id],
    componentId: newMain.id,
    dryRun: true,
    preserveSize: false,
  });
  assert.equal(dry.targets[0].compatibility.root.size, "adopted");
  assert.ok(!dry.targets[0].compatibility.root.fields.includes("width"));
  const applied = await runComponentSwap(ctx, {
    nodeIds: [inst.id],
    componentId: newMain.id,
    dryRun: false,
    preserveSize: false,
    expectedFingerprints: { [inst.id]: dry.targets[0].fingerprint },
  });
  assert.equal(applied.status, "applied");
  assert.equal(inst.width, 240);
  assert.equal(inst.height, 64);
  assert.equal(inst.opacity, 0.85);
  assert.equal(inst.name, "Play button");
});

function nestedPair(ctx, { sameKey = true } = {}) {
  const innerOld = node("COMPONENT", { name: "Inner", key: "inner-old", width: 100, height: 20 });
  innerOld.appendChild(node("TEXT", { name: "NestedLabel", characters: "Old", width: 80, height: 20 }));
  ctx.add(innerOld);

  const innerNew = node("COMPONENT", { name: "Inner", key: sameKey ? "inner-old" : "inner-new", width: 100, height: 20 });
  innerNew.appendChild(node("TEXT", { name: "NestedLabel", characters: "New", width: 80, height: 20 }));
  ctx.add(innerNew);

  const outerOld = node("COMPONENT", { name: "Outer", width: 100, height: 100 });
  outerOld.appendChild(innerOld.createInstance());
  ctx.add(outerOld);

  const outerNew = node("COMPONENT", { name: "Outer v2", width: 120, height: 120 });
  outerNew.appendChild(innerNew.createInstance());
  ctx.add(outerNew);

  const outer = outerOld.createInstance();
  const nested = outer.children[0];
  const text = nested.children[0];
  text.characters = "Override";
  nested.opacity = 0.6;
  nested.overrides = [{ id: text.id, overriddenFields: ["characters"] }];
  outer.overrides = [
    { id: nested.id, overriddenFields: ["opacity"] },
    { id: text.id, overriddenFields: ["characters"] },
  ];
  outer.onSwap = () => { ctx.metrics.swaps++; };
  return { innerOld, innerNew, outerOld, outerNew, outer, nested, text };
}

test("nested instance overrides are remapped when the nested component is the same", async () => {
  const ctx = makeCtx();
  const { outerOld, outerNew, outer } = nestedPair(ctx);
  const dry = await runComponentSwap(ctx, { nodeIds: [outer.id], componentId: outerNew.id, dryRun: true });
  assert.equal(dry.state, "compatible");
  assert.equal(dry.targets[0].compatibility.overrides.total, 2);
  assert.equal(dry.targets[0].compatibility.overrides.atRisk, 0);

  const applied = await runComponentSwap(ctx, {
    nodeIds: [outer.id],
    componentId: outerNew.id,
    dryRun: false,
    expectedFingerprints: { [outer.id]: dry.targets[0].fingerprint },
  });
  assert.equal(applied.status, "applied");
  assert.equal(outer.mainComponent, outerNew);
  assert.equal(outer.children[0].mainComponent.key, "inner-old");
  assert.equal(outer.children[0].opacity, 0.6);
  assert.equal(outer.children[0].children[0].characters, "Override");
});

test("a changed nested component drops descendant overrides and says so", async () => {
  const ctx = makeCtx();
  const { outerNew, outer } = nestedPair(ctx, { sameKey: false });
  const dry = await runComponentSwap(ctx, { nodeIds: [outer.id], componentId: outerNew.id, dryRun: true });
  assert.equal(dry.state, "lossy");
  assert.ok(dry.targets[0].compatibility.overrides.nestedChanged >= 1);
  assert.ok(dry.targets[0].compatibility.losses.some((l) => l.kind === "override-nested-component-changed"));

  await assert.rejects(
    runComponentSwap(ctx, {
      nodeIds: [outer.id],
      componentId: outerNew.id,
      dryRun: false,
      expectedFingerprints: { [outer.id]: dry.targets[0].fingerprint },
    }),
    /COMPONENT_SWAP_LOSSY/,
  );

  const applied = await runComponentSwap(ctx, {
    nodeIds: [outer.id],
    componentId: outerNew.id,
    dryRun: false,
    allowLoss: true,
    expectedFingerprints: { [outer.id]: dry.targets[0].fingerprint },
  });
  assert.equal(applied.status, "applied");
  assert.equal(applied.verification.ok, false);
  assert.equal(outer.children[0].mainComponent.key, "inner-new");
  assert.equal(outer.children[0].opacity, 1);
  assert.equal(outer.children[0].children[0].characters, "New");
});

test("a component property edited after the dry run refuses the stale plan", async () => {
  const ctx = makeCtx();
  const { oldMain, newMain } = buttonPair(ctx);
  const inst = oldMain.createInstance();
  inst.onSwap = () => { ctx.metrics.swaps++; };
  const dry = await runComponentSwap(ctx, { nodeIds: [inst.id], componentId: newMain.id, dryRun: true });
  assert.equal(dry.state, "compatible");

  inst.componentProperties["Label#old"].value = "Changed after the plan";
  const refused = await runComponentSwap(ctx, {
    nodeIds: [inst.id],
    componentId: newMain.id,
    dryRun: false,
    expectedFingerprints: { [inst.id]: dry.targets[0].fingerprint },
  });
  assert.equal(refused.status, "refused");
  assert.equal(refused.reason, "FINGERPRINT_MISMATCH");
  assert.equal(ctx.metrics.swaps, 0);
});

test("a renamed instance after the dry run refuses the stale plan", async () => {
  const ctx = makeCtx();
  const { oldMain, newMain } = buttonPair(ctx);
  const inst = oldMain.createInstance();
  inst.onSwap = () => { ctx.metrics.swaps++; };
  const dry = await runComponentSwap(ctx, { nodeIds: [inst.id], componentId: newMain.id, dryRun: true });
  assert.equal(dry.state, "compatible");

  inst.name = "Renamed after the plan";
  const refused = await runComponentSwap(ctx, {
    nodeIds: [inst.id],
    componentId: newMain.id,
    dryRun: false,
    expectedFingerprints: { [inst.id]: dry.targets[0].fingerprint },
  });
  assert.equal(refused.status, "refused");
  assert.equal(refused.reason, "FINGERPRINT_MISMATCH");
  assert.equal(ctx.metrics.swaps, 0);
});

test("a target component that changed after the dry run refuses the stale plan", async () => {
  const ctx = makeCtx();
  const { oldMain, newMain } = buttonPair(ctx);
  const inst = oldMain.createInstance();
  inst.onSwap = () => { ctx.metrics.swaps++; };
  const dry = await runComponentSwap(ctx, { nodeIds: [inst.id], componentId: newMain.id, dryRun: true });
  assert.equal(dry.state, "compatible");

  newMain.children = newMain.children.filter((c) => c.name !== "Label");
  const refused = await runComponentSwap(ctx, {
    nodeIds: [inst.id],
    componentId: newMain.id,
    dryRun: false,
    expectedFingerprints: { [inst.id]: dry.targets[0].fingerprint },
  });
  assert.equal(refused.status, "refused");
  assert.equal(refused.reason, "FINGERPRINT_MISMATCH");
  assert.equal(ctx.metrics.swaps, 0);
});

function deepInstanceChain(ctx, levels) {
  let component = node("COMPONENT", { name: "L0", width: 10, height: 10 });
  component.appendChild(node("TEXT", { name: "Leaf", characters: "deep", width: 10, height: 10 }));
  ctx.add(component);
  for (let i = 1; i <= levels; i++) {
    const next = node("COMPONENT", { name: `L${i}`, width: 10, height: 10 });
    next.appendChild(component.createInstance());
    ctx.add(next);
    component = next;
  }
  const outer = component.createInstance();
  let cursor = outer;
  for (let depth = 0; depth < levels; depth++) {
    const child = cursor.children[0];
    assert.equal(child.type, "INSTANCE");
    cursor.overrides = [{ id: child.id, overriddenFields: ["opacity"] }];
    cursor = child;
  }
  cursor.overrides = [{ id: cursor.children[0].id, overriddenFields: ["characters"] }];
  return outer;
}

test("nested overrides beyond the depth cap block instead of truncating", async () => {
  const ctx = makeCtx();
  const outer = deepInstanceChain(ctx, 13);
  const { newMain } = buttonPair(ctx);
  const dry = await runComponentSwap(ctx, { nodeIds: [outer.id], componentId: newMain.id, dryRun: true });
  assert.equal(dry.state, "incompatible");
  assert.match(dry.blocking[0].why, /deeper than 12 levels/);
});

test("a root layout override edited after the dry run refuses the stale plan", async () => {
  const ctx = makeCtx();
  const { oldMain, newMain } = buttonPair(ctx);
  const inst = oldMain.createInstance();
  inst.onSwap = () => { ctx.metrics.swaps++; };
  inst.layoutSizingHorizontal = "FILL";
  const dry = await runComponentSwap(ctx, { nodeIds: [inst.id], componentId: newMain.id, dryRun: true });
  inst.layoutSizingHorizontal = "HUG";

  const refused = await runComponentSwap(ctx, {
    nodeIds: [inst.id],
    componentId: newMain.id,
    dryRun: false,
    expectedFingerprints: { [inst.id]: dry.targets[0].fingerprint },
  });
  assert.equal(refused.status, "refused");
  assert.equal(refused.reason, "FINGERPRINT_MISMATCH");
  assert.equal(ctx.metrics.swaps, 0);
});

test("moving a target into a component after the dry run is refused", async () => {
  const ctx = makeCtx();
  const { oldMain, newMain } = buttonPair(ctx);
  const inst = oldMain.createInstance();
  inst.onSwap = () => { ctx.metrics.swaps++; };
  const dry = await runComponentSwap(ctx, { nodeIds: [inst.id], componentId: newMain.id, dryRun: true });
  const host = node("COMPONENT", { name: "Host", width: 300, height: 100 });
  ctx.add(host);
  host.appendChild(inst);

  const refused = await runComponentSwap(ctx, {
    nodeIds: [inst.id],
    componentId: newMain.id,
    dryRun: false,
    expectedFingerprints: { [inst.id]: dry.targets[0].fingerprint },
  });
  assert.equal(refused.status, "refused");
  assert.equal(refused.reason, "FINGERPRINT_MISMATCH");
  assert.equal(ctx.metrics.swaps, 0);
});

test("a library key is unverified until apply imports it", async () => {
  const ctx = makeCtx();
  const { oldMain, newMain } = buttonPair(ctx);
  newMain.key = "library-button";
  // The library component is not reachable by id from this file's page walk.
  ctx.root.children[0].children = ctx.root.children[0].children.filter((n) => n !== newMain);
  let imported = 0;
  ctx.importComponentByKeyAsync = async (key) => {
    imported++;
    assert.equal(key, "library-button");
    return newMain;
  };
  const inst = oldMain.createInstance();
  inst.children[0].characters = "Play";
  inst.overrides = [{ id: inst.children[0].id, overriddenFields: ["characters"] }];
  inst.onSwap = () => { ctx.metrics.swaps++; };

  const dry = await runComponentSwap(ctx, { nodeIds: [inst.id], componentKey: "library-button", dryRun: true });
  assert.equal(dry.state, "unverified");
  assert.equal(dry.targets[0].compatibility.status, "unverified");

  await assert.rejects(
    runComponentSwap(ctx, {
      nodeIds: [inst.id],
      componentKey: "library-button",
      dryRun: false,
      expectedFingerprints: { [inst.id]: dry.targets[0].fingerprint },
    }),
    /COMPONENT_SWAP_UNVERIFIED/,
  );
  assert.equal(imported, 0);
  assert.equal(ctx.metrics.swaps, 0);

  const applied = await runComponentSwap(ctx, {
    nodeIds: [inst.id],
    componentKey: "library-button",
    dryRun: false,
    allowUnverified: true,
    expectedFingerprints: { [inst.id]: dry.targets[0].fingerprint },
  });
  assert.equal(applied.status, "applied");
  assert.equal(imported, 1);
  assert.equal(ctx.metrics.swaps, 1);
  assert.equal(inst.children[0].characters, "Play");
});

test("swapping to the current main component is a no-op", async () => {
  const ctx = makeCtx();
  const { oldMain } = buttonPair(ctx);
  const inst = oldMain.createInstance();
  inst.onSwap = () => { ctx.metrics.swaps++; };
  const dry = await runComponentSwap(ctx, { nodeIds: [inst.id], componentId: oldMain.id, dryRun: true });
  assert.equal(dry.state, "noop");
  assert.equal(dry.targets[0].compatibility.status, "noop");
  const applied = await runComponentSwap(ctx, {
    nodeIds: [inst.id],
    componentId: oldMain.id,
    dryRun: false,
    expectedFingerprints: { [inst.id]: dry.targets[0].fingerprint },
  });
  assert.equal(applied.status, "noop");
  assert.equal(ctx.metrics.swaps, 0);
  assert.equal(ctx.metrics.commits, 0);
});

test("variantProperties select a variant from a component set", async () => {
  const ctx = makeCtx();
  const oldMain = node("COMPONENT", { name: "Old", width: 100, height: 40 });
  ctx.add(oldMain);
  const inst = oldMain.createInstance();
  inst.componentProperties = { "Label#old": { type: "TEXT", value: "Play" } };
  const small = node("COMPONENT", { name: "Size=Small", width: 100, height: 40, variantProperties: { Size: "S" }, componentPropertyDefinitions: {} });
  const large = node("COMPONENT", { name: "Size=Large", width: 200, height: 80, variantProperties: { Size: "L" }, componentPropertyDefinitions: {} });
  const set = node("COMPONENT_SET", {
    name: "Button sizes",
    width: 300,
    height: 80,
    children: [small, large],
    defaultVariant: small,
    componentPropertyDefinitions: { "Label#set": { type: "TEXT", defaultValue: "Submit" } },
  });
  ctx.add(set);
  const dry = await runComponentSwap(ctx, {
    nodeIds: [inst.id],
    componentSetId: set.id,
    variantProperties: { Size: "L" },
    dryRun: true,
  });
  assert.equal(dry.state, "compatible");
  assert.equal(dry.targets[0].to.id, large.id);
  assert.equal(dry.targets[0].to.name, "Size=Large");
  assert.equal(dry.targets[0].compatibility.properties.replayable, 1);

  const bySetName = await runComponentSwap(ctx, {
    nodeIds: [inst.id],
    componentName: "Button sizes",
    variantProperties: { Size: "L" },
    dryRun: true,
  });
  assert.equal(bySetName.state, "compatible");
  assert.equal(bySetName.targets[0].to.id, large.id);
});
