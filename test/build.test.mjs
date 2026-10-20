// Unit tests for the declarative build/patch engine against a stub Plugin API.
//
// The point is not "does it create a rectangle". It is the invariants that make
// a second call safe: deterministic keys, update-in-place instead of duplicate,
// a real dry run that writes nothing, keyed patch/prune, and a fingerprint that
// refuses to land a stale plan on a changed document.

import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILD_DATA, KEY_DATA, KIND_DATA, PROTECTED_DATA,
  keyFor, normalizeTree, parseColor, runBuild, runPatch,
} from "../plugin/ui-build.mjs";
import { runBatch } from "../plugin/batch.mjs";

// ---------------------------------------------------------------- stub

let seq = 0;
const nextId = () => `${++seq}:${seq}`;

function makeCtx({ textStyles = [], paintStyles = [], localVariables = [] } = {}) {
  const byId = new Map();
  const fonts = [];
  let undos = 0;
  let triggers = 0;

  const defaults = (type) => ({
    id: nextId(), type, name: type, x: 0, y: 0, width: 100, height: 100,
    opacity: 1, blendMode: "NORMAL", visible: true, locked: false, rotation: 0,
    fills: [], strokes: [], strokeWeight: 1, strokeAlign: "INSIDE", strokeDashes: [],
    fillStyleId: "", strokeStyleId: "", effectStyleId: "", textStyleId: "",
    strokeCap: "NONE", strokeJoin: "MITER", strokeMiterLimit: 4,
    cornerRadius: 0, topLeftRadius: 0, topRightRadius: 0, bottomRightRadius: 0, bottomLeftRadius: 0,
    isMask: false, itemReverseZIndex: false, strokesIncludedInLayout: false, effects: [], layoutGrids: [],
    textCase: "ORIGINAL", textDecoration: "NONE", paragraphSpacing: 0, paragraphIndent: 0,
    constraints: { horizontal: "MIN", vertical: "MIN" },
    layoutMode: "NONE", itemSpacing: 0,
    paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
    primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN",
    primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED",
    layoutWrap: "NO_WRAP", counterAxisSpacing: null, clipsContent: false,
    layoutGrow: 0, layoutAlign: "INHERIT", layoutPositioning: "AUTO",
    layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED",
    absoluteBoundingBox: null, removed: false, parent: null, children: [],
    pluginData: {},
    getPluginData(k) { return this.pluginData[k] || ""; },
    setPluginData(k, v) { this.pluginData[k] = String(v); },
    appendChild(child) {
      if (child.parent) {
        const i = child.parent.children.indexOf(child);
        if (i >= 0) child.parent.children.splice(i, 1);
      }
      child.parent = this;
      this.children.push(child);
    },
    insertChild(index, child) {
      if (child.parent) {
        const i = child.parent.children.indexOf(child);
        if (i >= 0) child.parent.children.splice(i, 1);
      }
      child.parent = this;
      this.children.splice(Math.max(0, Math.min(index, this.children.length)), 0, child);
    },
    clone() {
      const copy = defaults(this.type);
      copy.name = this.name;
      copy.x = this.x;
      copy.y = this.y;
      copy.width = this.width;
      copy.height = this.height;
      copy.opacity = this.opacity;
      copy.visible = this.visible;
      copy.fills = JSON.parse(JSON.stringify(this.fills || []));
      copy.strokes = JSON.parse(JSON.stringify(this.strokes || []));
      copy.strokeWeight = this.strokeWeight;
      copy.effects = JSON.parse(JSON.stringify(this.effects || []));
      copy.pluginData = { ...this.pluginData };
      delete copy.pluginData[BUILD_DATA];
      if (this.type === "TEXT") {
        copy.characters = this.characters;
        copy.fontName = this.fontName ? { ...this.fontName } : this.fontName;
        copy.fontSize = this.fontSize;
        copy.textAutoResize = this.textAutoResize;
      }
      byId.set(copy.id, copy);
      for (const child of this.children) copy.appendChild(child.clone());
      return copy;
    },
    remove() {
      if (this.parent) {
        const i = this.parent.children.indexOf(this);
        if (i >= 0) this.parent.children.splice(i, 1);
      }
      this.removed = true;
      this.parent = null;
    },
    resize(w, h) { this.width = Number(w); this.height = Number(h); },
    findOne(pred) {
      for (const c of this.children) {
        if (pred(c)) return c;
        const hit = c.findOne ? c.findOne(pred) : null;
        if (hit) return hit;
      }
      return null;
    },
    findAll(pred) {
      const out = [];
      const visit = (n) => {
        for (const c of n.children || []) {
          if (pred(c)) out.push(c);
          visit(c);
        }
      };
      visit(this);
      return out;
    },
    getMainComponentAsync() { return Promise.resolve(this.mainComponent || null); },
    createInstance() {
      const inst = defaults("INSTANCE");
      inst.name = this.name;
      inst.width = this.width;
      inst.height = this.height;
      inst.mainComponent = this;
      byId.set(inst.id, inst);
      for (const child of this.children || []) inst.appendChild(child.clone());
      return inst;
    },
    setProperties(props) { this.properties = { ...(this.properties || {}), ...props }; },
    getRangeAllFontNames() { return this.fontName ? [this.fontName] : []; },
    setRangeFontName(start, end, value) { (this.rangeOps ||= []).push({ field: "font", start, end, value }); },
    setRangeFontSize(start, end, value) { (this.rangeOps ||= []).push({ field: "fontSize", start, end, value }); },
    setRangeTextStyleIdAsync(start, end, value) { return Promise.resolve((this.rangeOps ||= []).push({ field: "textStyleId", start, end, value })); },
    setRangeFillStyleIdAsync(start, end, value) { return Promise.resolve((this.rangeOps ||= []).push({ field: "fillStyleId", start, end, value })); },
    setRangeFills(start, end, value) { (this.rangeOps ||= []).push({ field: "fills", start, end, value }); },
    setBoundVariable(field, variable) { (this.bindOps ||= []).push({ field, variable, range: null }); },
    setRangeBoundVariable(start, end, field, variable) { (this.bindOps ||= []).push({ field, variable, start, end }); },
    setRangeTextCase(start, end, value) { (this.rangeOps ||= []).push({ field: "textCase", start, end, value }); },
    setRangeTextDecoration(start, end, value) { (this.rangeOps ||= []).push({ field: "textDecoration", start, end, value }); },
    setRangeLineHeight(start, end, value) { (this.rangeOps ||= []).push({ field: "lineHeight", start, end, value }); },
    setRangeLetterSpacing(start, end, value) { (this.rangeOps ||= []).push({ field: "letterSpacing", start, end, value }); },
    setRangeHyperlink(start, end, value) { (this.rangeOps ||= []).push({ field: "hyperlink", start, end, value }); },
    textAutoResize: "NONE",
    characters: type === "TEXT" ? "" : undefined,
    fontName: type === "TEXT" ? { family: "Inter", style: "Regular" } : undefined,
    fontSize: type === "TEXT" ? 16 : undefined,
    letterSpacing: type === "TEXT" ? { unit: "PIXELS", value: 0 } : undefined,
    textAlignHorizontal: type === "TEXT" ? "LEFT" : undefined,
    hyperlink: type === "TEXT" ? null : undefined,
    componentProperties: {},
  });

  const ctx = {
    mixed: Symbol("mixed"),
    root: null,
    currentPage: null,
    viewport: { center: { x: 0, y: 0 } },
    loadFontAsync(f) { fonts.push(f); return Promise.resolve(); },
    commitUndo() { undos++; },
    triggerUndo() { triggers++; },
    getNodeByIdAsync(id) { return Promise.resolve(byId.get(id) || null); },
    async getLocalTextStylesAsync() { return textStyles; },
    async getLocalPaintStylesAsync() { return paintStyles; },
    async getLocalEffectStylesAsync() { return []; },
    variables: {
      async getLocalVariablesAsync() { return localVariables; },
      setBoundVariableForPaint(p) { return p; },
    },
    createFrame() { const n = defaults("FRAME"); byId.set(n.id, n); return n; },
    createRectangle() { const n = defaults("RECTANGLE"); byId.set(n.id, n); return n; },
    createEllipse() { const n = defaults("ELLIPSE"); byId.set(n.id, n); return n; },
    createLine() { const n = defaults("LINE"); byId.set(n.id, n); return n; },
    createText() { const n = defaults("TEXT"); byId.set(n.id, n); return n; },
    createComponent() { const n = defaults("COMPONENT"); byId.set(n.id, n); return n; },
    createNodeFromSvg(svg) {
      const n = defaults("FRAME");
      const raw = String(svg);
      const vector = defaults("VECTOR");
      vector.name = raw.includes("v3") ? "Third vector" : raw.includes("v2") ? "Second vector" : "First vector";
      n.appendChild(vector);
      n.svgSource = raw;
      byId.set(n.id, n);
      byId.set(vector.id, vector);
      return n;
    },
    metrics: {
      get undos() { return undos; },
      get triggers() { return triggers; },
      get fonts() { return fonts.slice(); },
      byId,
    },
  };

  const root = defaults("DOCUMENT");
  const page = defaults("PAGE");
  root.children = [page];
  page.parent = root;
  ctx.root = root;
  ctx.currentPage = page;
  byId.set(root.id, root);
  byId.set(page.id, page);
  return ctx;
}

// ---------------------------------------------------------------- pure

test("colour parsing accepts the shapes agents actually write", () => {
  assert.deepEqual(parseColor("#ff0000"), { r: 1, g: 0, b: 0, a: 1 });
  assert.deepEqual(parseColor("#00ff0080"), { r: 0, g: 1, b: 0, a: 128 / 255 });
  const rgba = parseColor("rgba(0, 128, 255, .5)");
  assert.ok(Math.abs(rgba.r) < 1e-9 && Math.abs(rgba.g - 128 / 255) < 1e-9 && Math.abs(rgba.a - 0.5) < 1e-9);
  assert.deepEqual(parseColor({ r: 255, g: 0, b: 0 }), { r: 1, g: 0, b: 0, a: 1 });
  assert.throws(() => parseColor("red-ish"), /cannot parse colour/);
});

test("keys are deterministic and duplicate keys are refused", () => {
  const a = normalizeTree({ type: "FRAME", name: "HUD", children: [
    { type: "TEXT", name: "Score", text: "0" },
    { type: "TEXT", name: "Score", text: "1" },
  ] }, { buildId: "hud" });
  assert.equal(a.root.key, "hud");
  assert.equal(a.root.children[0].key, keyFor("hud", "TEXT", "Score", 0));
  assert.equal(a.root.children[1].key, keyFor("hud", "TEXT", "Score", 1));
  assert.throws(
    () => normalizeTree({ type: "FRAME", key: "r", children: [{ type: "TEXT", key: "x", text: "a" }, { type: "TEXT", key: "x", text: "b" }] }),
    /duplicate key/,
  );
});

test("unsupported containers are a refusal, not a silent frame", () => {
  assert.throws(() => normalizeTree({ type: "GROUP", children: [] }), /not supported/);
  assert.throws(() => normalizeTree({ type: "TEXT", text: "x", children: [] }), /cannot have children/);
  assert.throws(() => normalizeTree({ type: "INSTANCE", name: "i" }), /needs component/);
});

test("a hyperlink is text-only and normalized", () => {
  const text = normalizeTree({ type: "TEXT", text: "Docs", hyperlink: { type: "url", value: " https://example.com " } });
  assert.deepEqual(text.root.spec.hyperlink, { type: "URL", value: "https://example.com" });
  assert.equal(normalizeTree({ type: "TEXT", text: "Off", hyperlink: null }).root.spec.hyperlink, null);
  assert.throws(() => normalizeTree({ type: "FRAME", hyperlink: { type: "URL", value: "https://example.com" } }), /only valid on TEXT/);
  assert.throws(() => normalizeTree({ type: "TEXT", text: "x", hyperlink: { type: "EMAIL", value: "a@b.c" } }), /URL or NODE/);
  assert.throws(() => normalizeTree({ type: "TEXT", text: "x", hyperlink: { type: "URL", value: "  " } }), /non-empty/);
});

test("text runs are ordered, bounded and text-only", () => {
  const text = normalizeTree({
    type: "TEXT", text: "Hello", textVariable: { fontSize: " type/size ", fontFamily: null },
    runs: [
      { start: 0, end: 2, font: "Inter/Bold", fontSize: 24, textStyle: " body/bold ", fillStyle: " accent ", variable: { fontSize: " type/size ", lineHeight: null }, textCase: "UPPER", hyperlink: null },
      { start: 2, end: 5, lineHeight: 20, letterSpacing: 1, textDecoration: "UNDERLINE" },
    ],
  });
  assert.deepEqual(text.root.spec.textVariable, { fontSize: "type/size", fontFamily: null });
  assert.deepEqual(text.root.spec.runs[0].font, { family: "Inter", style: "Bold" });
  assert.equal(text.root.spec.runs[0].textStyle, "body/bold");
  assert.equal(text.root.spec.runs[0].fillStyle, "accent");
  assert.deepEqual(text.root.spec.runs[0].variable, { fontSize: "type/size", lineHeight: null });
  assert.deepEqual(text.root.spec.runs[1].lineHeight, { unit: "PIXELS", value: 20 });
  assert.equal(text.root.spec.runs[0].hyperlink, null);

  assert.throws(() => normalizeTree({ type: "FRAME", runs: [] }), /only valid on TEXT/);
  assert.throws(() => normalizeTree({ type: "TEXT", runs: [{ start: 0, end: 1, fontSize: 12 }] }), /needs text/);
  assert.throws(() => normalizeTree({ type: "TEXT", text: "x", runs: [{ start: 0, end: 2, fontSize: 12 }] }), /past the text length/);
  assert.throws(() => normalizeTree({ type: "TEXT", text: "abc", runs: [
    { start: 0, end: 2, fontSize: 12 },
    { start: 1, end: 3, fontSize: 14 },
  ] }), /ordered and non-overlapping/);
  assert.throws(() => normalizeTree({ type: "TEXT", text: "abc", runs: [{ start: 0, end: 1 }] }), /at least one/);
  assert.throws(() => normalizeTree({ type: "TEXT", text: "abc", runs: [{ start: 0, end: 1, font: " " }] }), /font/);
  assert.throws(() => normalizeTree({ type: "TEXT", text: "abc", runs: [{ start: 0, end: 1, textStyle: " " }] }), /textStyle/);
  assert.throws(() => normalizeTree({ type: "TEXT", text: "abc", runs: [{ start: 0, end: 1, fillStyle: " " }] }), /fillStyle/);
  assert.throws(() => normalizeTree({ type: "TEXT", text: "abc", runs: [{ start: 0, end: 1, fillStyle: "a", fills: "#fff" }] }), /not both/);
  assert.throws(() => normalizeTree({ type: "TEXT", text: "abc", runs: [{ start: 0, end: 1, variable: { bold: "x" } }] }), /not a bindable/);
  assert.throws(() => normalizeTree({ type: "TEXT", text: "abc", runs: [{ start: 0, end: 1, variable: { fontSize: " " } }] }), /non-empty/);
  assert.throws(() => normalizeTree({ type: "FRAME", textVariable: { fontSize: "x" } }), /only valid on TEXT/);
  assert.throws(() => normalizeTree({ type: "TEXT", text: "abc", textVariable: { weight: "x" } }), /not a bindable/);
  assert.throws(() => normalizeTree({ type: "TEXT", text: "abc", runs: [{ start: 0, end: 1, textCase: "SHOUT" }] }), /textCase/);
});

// ---------------------------------------------------------------- build

test("dry run plans without writing, then apply creates one keyed tree", async () => {
  const ctx = makeCtx();
  const spec = {
    buildId: "hud",
    root: {
      type: "FRAME", name: "HUD",
      size: { width: 360, height: 200 },
      fills: "#101820",
      layout: { mode: "VERTICAL", gap: 8, padding: 16 },
      children: [
        { type: "TEXT", name: "Score", text: "12,480", font: "Inter/Bold", fontSize: 32, fills: "#ffffff" },
        { type: "FRAME", name: "Bar", size: { width: 328, height: 8 }, fills: "#33cc99" },
      ],
    },
  };

  const dry = await runBuild(ctx, { ...spec, dryRun: true });
  assert.equal(dry.status, "dry_run");
  assert.equal(dry.counts.create, 3);
  assert.equal(dry.root.nodeId, null);
  assert.equal(ctx.currentPage.children.length, 0);
  assert.equal(ctx.metrics.undos, 0);
  assert.ok(dry.fingerprint);
  assert.deepEqual(dry.fonts, ["Inter/Bold"]);

  const applied = await runBuild(ctx, { ...spec, dryRun: false });
  assert.equal(applied.status, "applied");
  assert.equal(applied.created.length, 3);
  assert.equal(applied.verification.ok, true);
  assert.equal(ctx.currentPage.children.length, 1);
  const root = ctx.currentPage.children[0];
  assert.equal(root.getPluginData(BUILD_DATA), "hud");
  assert.equal(root.getPluginData(KEY_DATA), "hud");
  const score = root.children[0];
  assert.equal(score.getPluginData(KEY_DATA), keyFor("hud", "TEXT", "Score", 0));
  assert.equal(score.characters, "12,480");
  assert.equal(score.fontName.style, "Bold");
  assert.ok(ctx.metrics.fonts.some((f) => f.family === "Inter" && f.style === "Bold"));
});

test("an SVG spec creates a frame, and a repeat build or patch updates it in place", async () => {
  const ctx = makeCtx();
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><!-- v1 --><circle cx="12" cy="12" r="12"/></svg>';
  const spec = {
    buildId: "icons",
    root: {
      type: "SVG", name: "Logo", key: "icons/logo", svg,
      size: { width: 24, height: 24 },
      position: { x: 40, y: 60 },
    },
  };
  const dry = await runBuild(ctx, { ...spec, dryRun: true });
  assert.equal(dry.status, "dry_run");
  assert.deepEqual(dry.counts.create, 1);

  const applied = await runBuild(ctx, { ...spec, dryRun: false });
  assert.equal(applied.status, "applied");
  assert.equal(applied.verification.ok, true);
  const root = ctx.currentPage.children[0];
  assert.equal(root.type, "FRAME");
  assert.equal(root.svgSource, svg);
  assert.equal(root.getPluginData(KIND_DATA), "SVG");
  assert.equal(root.getPluginData(BUILD_DATA), "icons");
  assert.equal(root.getPluginData(KEY_DATA), "icons/logo");
  assert.equal(root.name, "Logo");
  assert.equal(root.x, 40);
  assert.equal(root.y, 60);
  assert.equal(root.width, 24);
  assert.equal(root.height, 24);
  assert.equal(root.children[0].name, "First vector");

  // The second build is an update, not a type change: an SVG-created frame is
  // still an SVG leaf to the planner even though Figma calls it a FRAME.
  const again = await runBuild(ctx, { ...spec, dryRun: false });
  assert.equal(again.status, "applied");
  assert.equal(again.verification.ok, true);
  assert.deepEqual(again.created, []);
  assert.ok(again.updated.includes("icons/logo"));
  assert.equal(ctx.currentPage.children.length, 1);
  assert.equal(ctx.currentPage.children[0].id, root.id);
  assert.equal(root.children[0].name, "First vector");

  // A changed source replaces the interior and keeps the id, key and buildId.
  const svg2 = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><!-- v2 --><rect width="24" height="24"/></svg>';
  const changed = await runBuild(ctx, {
    ...spec,
    root: { ...spec.root, svg: svg2 },
    dryRun: false,
  });
  assert.equal(changed.status, "applied");
  assert.equal(changed.verification.ok, true);
  assert.equal(ctx.currentPage.children[0].id, root.id);
  assert.equal(root.getPluginData(KEY_DATA), "icons/logo");
  assert.equal(root.height, 24);
  assert.equal(root.children[0].name, "Second vector");

  // The same source can also arrive through figma_patch, whose root type
  // defaults to the stored kind (SVG), not Figma's FRAME.
  const svg3 = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><!-- v3 --><circle cx="12" cy="12" r="6"/></svg>';
  const patched = await runPatch(ctx, {
    buildId: "icons",
    dryRun: false,
    patch: { type: "SVG", key: "icons/logo", svg: svg3 },
  });
  assert.equal(patched.status, "applied");
  assert.equal(patched.verification.ok, true);
  assert.equal(ctx.currentPage.children[0].id, root.id);
  assert.equal(root.children[0].name, "Third vector");
});

test("build applies text runs without flattening the base style", async () => {
  const ctx = makeCtx();
  const spec = {
    buildId: "runs",
    root: {
      type: "FRAME", name: "Runs",
      size: { width: 320, height: 80 },
      children: [{
        type: "TEXT", name: "Label", key: "runs/label", text: "Hello!",
        font: "Inter/Regular", fontSize: 16, fills: "#111111",
        runs: [
          {
            start: 0, end: 2, font: "Inter/Bold", fontSize: 24, fills: "#ff0000",
            textCase: "UPPER", textDecoration: "UNDERLINE", lineHeight: 28,
            letterSpacing: 1, hyperlink: { type: "URL", value: "https://example.com" },
          },
          { start: 3, end: 6, font: "Inter/Italic", fontSize: 12 },
        ],
      }],
    },
  };

  const dry = await runBuild(ctx, { ...spec, dryRun: true });
  assert.equal(dry.status, "dry_run");
  assert.deepEqual(dry.fonts, ["Inter/Bold", "Inter/Italic", "Inter/Regular"]);

  const applied = await runBuild(ctx, { ...spec, dryRun: false });
  assert.equal(applied.status, "applied");
  assert.equal(applied.verification.ok, true);
  const label = ctx.currentPage.children[0].children[0];
  assert.equal(label.characters, "Hello!");
  assert.equal(label.fontName.style, "Regular");
  assert.equal(label.fontSize, 16);
  assert.deepEqual(label.rangeOps[0], {
    field: "font", start: 0, end: 2, value: { family: "Inter", style: "Bold" },
  });
  assert.ok(label.rangeOps.some((op) => op.field === "fontSize" && op.start === 0 && op.end === 2 && op.value === 24));
  assert.ok(label.rangeOps.some((op) => op.field === "fills" && op.value[0].color.r === 1));
  assert.ok(label.rangeOps.some((op) => op.field === "textCase" && op.value === "UPPER"));
  assert.ok(label.rangeOps.some((op) => op.field === "textDecoration" && op.value === "UNDERLINE"));
  assert.ok(label.rangeOps.some((op) => op.field === "lineHeight" && op.value.value === 28));
  assert.ok(label.rangeOps.some((op) => op.field === "letterSpacing" && op.value.value === 1));
  assert.ok(label.rangeOps.some((op) => op.field === "hyperlink" && op.value.value === "https://example.com"));
  assert.ok(label.rangeOps.some((op) => op.field === "font" && op.start === 3 && op.end === 6 && op.value.style === "Italic"));
});

test("text runs link and clear local styles by range", async () => {
  const ctx = makeCtx({
    textStyles: [{ id: "S:text-bold", name: "body/bold", type: "TEXT", fontName: { family: "Inter", style: "Bold" } }],
    paintStyles: [{ id: "S:accent", name: "accent/solid", type: "PAINT", paints: [] }],
  });
  const spec = {
    buildId: "runs/styles",
    root: {
      type: "FRAME", name: "Styled runs", size: { width: 200, height: 40 },
      children: [{
        type: "TEXT", name: "Label", key: "runs/styles/label", text: "Hello",
        font: "Inter/Regular",
        runs: [
          { start: 0, end: 2, textStyle: "body/bold", fillStyle: "accent/solid" },
          { start: 2, end: 5, textStyle: null, fillStyle: null, fontSize: 18 },
        ],
      }],
    },
  };

  const dry = await runBuild(ctx, { ...spec, dryRun: true });
  assert.equal(dry.status, "dry_run");
  assert.ok(dry.fonts.includes("Inter/Bold"));
  assert.ok(dry.styles.text.includes("body/bold"));
  assert.ok(dry.styles.paint.includes("accent/solid"));

  const applied = await runBuild(ctx, { ...spec, dryRun: false });
  assert.equal(applied.status, "applied");
  const label = ctx.currentPage.children[0].children[0];
  assert.ok(label.rangeOps.some((op) => op.field === "textStyleId" && op.start === 0 && op.end === 2 && op.value === "S:text-bold"));
  assert.ok(label.rangeOps.some((op) => op.field === "fillStyleId" && op.start === 0 && op.end === 2 && op.value === "S:accent"));
  assert.ok(label.rangeOps.some((op) => op.field === "textStyleId" && op.start === 2 && op.end === 5 && op.value === ""));
  assert.ok(label.rangeOps.some((op) => op.field === "fillStyleId" && op.start === 2 && op.end === 5 && op.value === ""));
});

test("text variables bind the base and a run by local variable name", async () => {
  const size = { id: "V:size", key: "size-key", name: "type/size", resolvedType: "FLOAT" };
  const family = { id: "V:family", key: "family-key", name: "type/family", resolvedType: "STRING" };
  const ctx = makeCtx({ localVariables: [size, family] });
  const spec = {
    buildId: "runs/variables",
    root: {
      type: "FRAME", name: "Bound", size: { width: 200, height: 40 },
      children: [{
        type: "TEXT", name: "Label", key: "runs/variables/label", text: "Hello",
        font: "Inter/Regular", textVariable: { fontSize: "type/size" },
        runs: [{ start: 0, end: 2, variable: { fontSize: null, fontFamily: "type/family" } }],
      }],
    },
  };

  const dry = await runBuild(ctx, { ...spec, dryRun: true });
  assert.equal(dry.status, "dry_run");
  assert.deepEqual(dry.variables, ["type/family", "type/size"]);

  const applied = await runBuild(ctx, { ...spec, dryRun: false });
  assert.equal(applied.status, "applied");
  const label = ctx.currentPage.children[0].children[0];
  assert.ok(label.bindOps.some((op) => op.range === null && op.field === "fontSize" && op.variable.id === "V:size"));
  assert.ok(label.bindOps.some((op) => op.start === 0 && op.end === 2 && op.field === "fontSize" && op.variable === null));
  assert.ok(label.bindOps.some((op) => op.start === 0 && op.end === 2 && op.field === "fontFamily" && op.variable.id === "V:family"));
});

test("a text variable of the wrong type blocks the build before writing", async () => {
  const ctx = makeCtx({
    localVariables: [{ id: "V:color", key: "color-key", name: "brand/red", resolvedType: "COLOR" }],
  });
  const plan = await runBuild(ctx, {
    buildId: "runs/bad-variable",
    root: {
      type: "TEXT", text: "x", font: "Inter/Regular",
      textVariable: { fontSize: "brand/red" },
    },
    dryRun: true,
  });
  assert.equal(plan.status, "blocked");
  assert.match(plan.blocking.join(" "), /COLOR.*FLOAT/);
  assert.equal(ctx.metrics.undos, 0);
});

test("instance overrides resolve by path and apply styles, literals and size", async () => {
  const ctx = makeCtx({
    textStyles: [{ id: "S:text", name: "body/label", fontName: { family: "Inter", style: "Bold" } }],
    paintStyles: [{ id: "S:paint", name: "brand/red", paints: [] }],
  });
  const comp = ctx.createComponent();
  comp.name = "Button";
  comp.resize(200, 60);
  const label = ctx.createText();
  label.name = "Label";
  label.characters = "Main";
  comp.appendChild(label);
  const icon = ctx.createRectangle();
  icon.name = "Icon";
  comp.appendChild(icon);

  const spec = {
    buildId: "instance-overrides",
    root: {
      type: "INSTANCE", key: "button", name: "Button", componentId: comp.id,
      overrides: {
        Label: {
          path: [{ name: "Label", index: 0 }],
          textStyle: "body/label", fillStyle: "brand/red",
          text: "Play", fontSize: 22,
          hyperlink: { type: "URL", value: "https://example.com/play" },
        },
        Icon: {
          path: [{ name: "Icon", index: 1 }],
          visible: false, opacity: 0.4, size: { width: 30, height: 30 },
          rotation: 10, cornerRadius: 4, strokeWeight: 2,
        },
        Stale: {
          path: [{ name: "Gone", index: 0 }],
          text: "this must not land",
        },
      },
    },
  };

  const dry = await runBuild(ctx, { ...spec, dryRun: true });
  assert.equal(dry.status, "dry_run");
  assert.deepEqual(dry.fonts, ["Inter/Bold"]);

  const applied = await runBuild(ctx, { ...spec, dryRun: false });
  assert.equal(applied.status, "applied");
  assert.equal(applied.verification.ok, true);
  const instance = ctx.currentPage.children[0];
  const buttonLabel = instance.children[0];
  assert.equal(buttonLabel.characters, "Play");
  assert.equal(buttonLabel.fontSize, 22);
  assert.equal(buttonLabel.textStyleId, "S:text");
  assert.equal(buttonLabel.fillStyleId, "S:paint");
  assert.equal(buttonLabel.hyperlink.value, "https://example.com/play");
  const buttonIcon = instance.children[1];
  assert.equal(buttonIcon.visible, false);
  assert.equal(buttonIcon.opacity, 0.4);
  assert.equal(buttonIcon.width, 30);
  assert.equal(buttonIcon.height, 30);
  assert.equal(buttonIcon.rotation, 10);
  assert.equal(buttonIcon.cornerRadius, 4);
  assert.equal(buttonIcon.strokeWeight, 2);
  assert.ok(applied.warnings.some((w) => /expected "Gone" at index 0, found "Label"/.test(w)));
});

test("build carries rotation, per-corner radii, stroke shape and text formatting", async () => {
  const ctx = makeCtx();
  const spec = {
    buildId: "styled",
    root: {
      type: "FRAME", name: "Styled",
      rotation: 15,
      topLeftRadius: 12, topRightRadius: 0, bottomRightRadius: 8, bottomLeftRadius: 2,
      strokeCap: "ROUND", strokeJoin: "ROUND", strokeMiterLimit: 6,
      isMask: true, itemReverseZIndex: true, strokesIncludedInLayout: true,
      layoutGrids: [{
        pattern: "COLUMNS", count: 3, gutterSize: 8, offset: 4,
        sectionSize: 96, alignment: "STRETCH", color: "#ff00001a",
      }],
      children: [{
        type: "TEXT", name: "Label", text: "Hello",
        textCase: "UPPER", textDecoration: "UNDERLINE",
        paragraphSpacing: 6, paragraphIndent: 4,
        hyperlink: { type: "URL", value: "https://example.com/docs" },
      }, {
        type: "LINE", name: "Divider", length: 120, rotation: 30,
      }],
    },
  };
  const applied = await runBuild(ctx, { ...spec, dryRun: false });
  assert.equal(applied.verification.ok, true);
  const root = ctx.currentPage.children[0];
  const label = root.children[0];
  const divider = root.children[1];
  assert.equal(root.rotation, 15);
  assert.equal(root.topLeftRadius, 12);
  assert.equal(root.topRightRadius, 0);
  assert.equal(root.bottomRightRadius, 8);
  assert.equal(root.bottomLeftRadius, 2);
  assert.equal(root.strokeCap, "ROUND");
  assert.equal(root.strokeJoin, "ROUND");
  assert.equal(root.strokeMiterLimit, 6);
  assert.equal(root.isMask, true);
  assert.equal(root.itemReverseZIndex, true);
  assert.equal(root.strokesIncludedInLayout, true);
  assert.equal(root.layoutGrids.length, 1);
  assert.equal(root.layoutGrids[0].pattern, "COLUMNS");
  assert.equal(root.layoutGrids[0].count, 3);
  assert.equal(root.layoutGrids[0].gutterSize, 8);
  assert.equal(root.layoutGrids[0].alignment, "STRETCH");
  assert.equal(divider.width, 120);
  assert.equal(divider.height, 0);
  assert.equal(divider.rotation, 30);
  assert.equal(label.textCase, "UPPER");
  assert.equal(label.textDecoration, "UNDERLINE");
  assert.equal(label.paragraphSpacing, 6);
  assert.equal(label.paragraphIndent, 4);
  assert.deepEqual(label.hyperlink, { type: "URL", value: "https://example.com/docs" });

  assert.throws(
    () => normalizeTree({ type: "FRAME", strokeCap: "POINTY" }),
    /strokeCap/,
  );
  assert.throws(
    () => normalizeTree({ type: "RECTANGLE", length: 10 }),
    /only valid on LINE/,
  );
});

test("build restores image paint geometry, filters, visibility and paint blend mode", async () => {
  const ctx = makeCtx();
  const imageTransform = [[1, 0, 0], [0, 1, 0]];
  const filters = { exposure: 0.2, contrast: 0.1, saturation: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0 };
  const spec = {
    buildId: "paint",
    root: {
      type: "FRAME", name: "Paint",
      fills: [{
        type: "IMAGE", imageHash: "img:1", scaleMode: "CROP",
        imageTransform, scalingFactor: 0.5, rotation: 90, filters,
        opacity: 0.8, blendMode: "MULTIPLY", visible: false,
      }, {
        type: "GRADIENT_LINEAR",
        stops: [{ at: 0, color: "#ff0000" }, { at: 1, color: "#0000ff" }],
        gradientTransform: [[1, 0, 0], [0, 1, 0]],
        opacity: 0.5, blendMode: "SCREEN",
      }, {
        color: "#ff000080", opacity: 0.5,
      }],
    },
  };

  const applied = await runBuild(ctx, { ...spec, dryRun: false });
  assert.equal(applied.verification.ok, true);
  const fills = ctx.currentPage.children[0].fills;
  assert.deepEqual(fills[0], {
    type: "IMAGE", imageHash: "img:1", scaleMode: "CROP",
    imageTransform, scalingFactor: 0.5, rotation: 90, filters,
    opacity: 0.8, visible: false, blendMode: "MULTIPLY",
  });
  assert.equal(fills[1].type, "GRADIENT_LINEAR");
  assert.equal(fills[1].opacity, 0.5);
  assert.equal(fills[1].blendMode, "SCREEN");
  assert.equal(fills[1].gradientStops.length, 2);
  assert.ok(Math.abs(fills[2].opacity - 0.5 * (128 / 255)) < 1e-9);
});

test("re-sending the same build updates in place and never duplicates", async () => {
  const ctx = makeCtx();
  const first = {
    buildId: "hud",
    root: { type: "FRAME", name: "HUD", children: [{ type: "TEXT", name: "Score", text: "1" }] },
  };
  await runBuild(ctx, { ...first, dryRun: false });
  const rootId = ctx.currentPage.children[0].id;

  const dry = await runBuild(ctx, { ...first, dryRun: true });
  assert.equal(dry.status, "dry_run");
  assert.equal(dry.root.nodeId, rootId);
  assert.equal(dry.counts.create, 0);
  assert.equal(dry.counts.update, 2);

  const second = {
    buildId: "hud",
    root: { type: "FRAME", name: "HUD", children: [{ type: "TEXT", name: "Score", text: "2" }] },
  };
  const applied = await runBuild(ctx, { ...second, dryRun: false });
  assert.equal(applied.status, "applied");
  assert.equal(applied.created.length, 0);
  assert.equal(ctx.currentPage.children.length, 1);
  assert.equal(ctx.currentPage.children[0].children.length, 1);
  assert.equal(ctx.currentPage.children[0].children[0].characters, "2");
});

test("a fingerprint mismatch refuses before the write", async () => {
  const ctx = makeCtx();
  const spec = { buildId: "hud", root: { type: "FRAME", name: "HUD", children: [{ type: "TEXT", name: "Score", text: "1" }] } };
  await runBuild(ctx, { ...spec, dryRun: false });
  const dry = await runBuild(ctx, { ...spec, dryRun: true });
  const root = ctx.currentPage.children[0];

  // A human (or another tool) moves the document after the plan.
  root.children[0].characters = "changed by someone else";
  const refused = await runBuild(ctx, {
    ...spec,
    dryRun: false,
    expectedFingerprint: dry.fingerprint,
  });
  assert.equal(refused.status, "refused");
  assert.equal(refused.reason, "FINGERPRINT_MISMATCH");
  assert.equal(root.children[0].characters, "changed by someone else");
});

// ---------------------------------------------------------------- patch

test("patch updates by key, creates only on allowCreate, and prunes on request", async () => {
  const ctx = makeCtx();
  await runBuild(ctx, {
    buildId: "hud",
    dryRun: false,
    root: {
      type: "FRAME", name: "HUD",
      children: [
        { type: "TEXT", name: "Score", text: "1", hyperlink: { type: "URL", value: "https://example.com/score" } },
        { type: "RECTANGLE", name: "Old", fills: "#ff0000" },
      ],
    },
  });
  const root = ctx.currentPage.children[0];
  const score = root.children[0];
  const old = root.children[1];

  const blocked = await runPatch(ctx, {
    buildId: "hud",
    dryRun: true,
    patch: { type: "FRAME", children: [{ type: "TEXT", name: "Missing", key: "hud/missing", text: "x" }] },
  });
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.blocking.some((b) => b.includes("no node with this key")));

  const created = await runPatch(ctx, {
    buildId: "hud",
    allowCreate: true,
    dryRun: false,
    patch: { type: "FRAME", children: [{ type: "TEXT", name: "Missing", key: "hud/missing", text: "x" }] },
  });
  assert.equal(created.status, "applied");
  assert.ok(root.children.some((c) => c.getPluginData(KEY_DATA) === "hud/missing"));

  // Update the existing score by its key, and make the root exact (drop Old).
  const updated = await runPatch(ctx, {
    buildId: "hud",
    prune: true,
    dryRun: false,
    patch: {
      type: "FRAME",
      children: [
        { type: "TEXT", key: score.getPluginData(KEY_DATA), text: "99", hyperlink: null },
        { type: "TEXT", key: "hud/missing", text: "x" },
      ],
    },
  });
  assert.equal(updated.status, "applied");
  assert.equal(score.characters, "99");
  assert.equal(score.hyperlink, null);
  assert.ok(old.removed);
  assert.ok(!root.children.includes(old));
  assert.equal(root.children.length, 2);
});

test("a protected node survives prune and is reported", async () => {
  const ctx = makeCtx();
  await runBuild(ctx, {
    buildId: "hud",
    dryRun: false,
    root: {
      type: "FRAME", name: "HUD",
      children: [
        { type: "TEXT", name: "Score", text: "1" },
        { type: "RECTANGLE", name: "Keep", key: "keep", protected: true },
      ],
    },
  });
  const root = ctx.currentPage.children[0];
  const keep = root.children[1];
  assert.equal(keep.getPluginData(PROTECTED_DATA), "1");

  const applied = await runPatch(ctx, {
    buildId: "hud",
    prune: true,
    dryRun: false,
    patch: { type: "FRAME", children: [{ type: "TEXT", key: keyFor("hud", "TEXT", "Score", 0), text: "2" }] },
  });
  assert.equal(applied.status, "applied");
  assert.ok(root.children.includes(keep));
  assert.ok(applied.warnings.some((w) => w.includes("protected")));
});

// ---------------------------------------------------------------- batch

async function batchFixture() {
  const ctx = makeCtx();
  await runBuild(ctx, {
    buildId: "hud",
    dryRun: false,
    root: {
      type: "FRAME", name: "HUD", size: { width: 360, height: 200 },
      children: [
        { type: "TEXT", name: "Score", text: "1" },
        { type: "RECTANGLE", name: "Bar", size: { width: 100, height: 8 }, fills: "#ff0000" },
        { type: "FRAME", name: "Box", size: { width: 100, height: 50 }, children: [] },
      ],
    },
  });
  const root = ctx.currentPage.children[0];
  return { ctx, root, score: root.children[0], bar: root.children[1], box: root.children[2] };
}

test("batch dry run resolves every target and writes nothing", async () => {
  const { ctx, root, score, bar } = await batchFixture();
  const undosBefore = ctx.metrics.undos;
  const dry = await runBatch(ctx, {
    dryRun: true,
    ops: [
      { op: "set_text", key: score.getPluginData(KEY_DATA), text: "42" },
      { op: "set_fill", key: bar.getPluginData(KEY_DATA), fills: "#00ff00" },
      { op: "resize", key: bar.getPluginData(KEY_DATA), width: 120, height: 12 },
      { op: "rename", key: bar.getPluginData(KEY_DATA), name: "Progress" },
      { op: "set_rotation", key: bar.getPluginData(KEY_DATA), rotation: 30 },
    ],
  });
  assert.equal(dry.status, "dry_run");
  assert.equal(dry.ops.length, 5);
  assert.ok(dry.fingerprints[score.id] && dry.fingerprints[bar.id]);
  assert.equal(score.characters, "1");
  assert.equal(bar.width, 100);
  assert.equal(ctx.metrics.undos, undosBefore);
});

test("batch applies all ops in one transaction and guards each target fingerprint", async () => {
  const { ctx, root, score, bar, box } = await batchFixture();
  const dry = await runBatch(ctx, {
    dryRun: true,
    ops: [
      { op: "set_text", key: score.getPluginData(KEY_DATA), text: "42", fontSize: 20, hyperlink: { type: "URL", value: "https://example.com/score" } },
      { op: "set_fill", key: bar.getPluginData(KEY_DATA), fills: "#00ff00" },
      { op: "resize", key: bar.getPluginData(KEY_DATA), width: 120, height: 12 },
      { op: "rename", key: bar.getPluginData(KEY_DATA), name: "Progress" },
      { op: "set_rotation", key: bar.getPluginData(KEY_DATA), rotation: 30 },
      { op: "reparent", key: score.getPluginData(KEY_DATA), parentId: box.id },
    ],
  });
  const applied = await runBatch(ctx, {
    dryRun: false,
    expectedFingerprints: dry.fingerprints,
    ops: [
      { op: "set_text", key: score.getPluginData(KEY_DATA), text: "42", fontSize: 20, hyperlink: { type: "URL", value: "https://example.com/score" } },
      { op: "set_fill", key: bar.getPluginData(KEY_DATA), fills: "#00ff00" },
      { op: "resize", key: bar.getPluginData(KEY_DATA), width: 120, height: 12 },
      { op: "rename", key: bar.getPluginData(KEY_DATA), name: "Progress" },
      { op: "set_rotation", key: bar.getPluginData(KEY_DATA), rotation: 30 },
      { op: "reparent", key: score.getPluginData(KEY_DATA), parentId: box.id },
    ],
  });
  assert.equal(applied.status, "applied");
  assert.equal(applied.failed, 0);
  assert.equal(score.characters, "42");
  assert.deepEqual(score.hyperlink, { type: "URL", value: "https://example.com/score" });
  assert.equal(score.fontSize, 20);
  assert.equal(bar.fills[0].color.g, 1);
  assert.equal(bar.width, 120);
  assert.equal(bar.name, "Progress");
  assert.equal(bar.rotation, 30);
  assert.equal(score.parent, box);
  assert.ok(ctx.metrics.undos > 0);
  assert.equal(ctx.metrics.triggers, 0);

  const before = score.characters;
  score.characters = "changed";
  const refused = await runBatch(ctx, {
    dryRun: false,
    expectedFingerprints: dry.fingerprints,
    ops: [{ op: "set_text", key: score.getPluginData(KEY_DATA), text: "nope" }],
  });
  assert.equal(refused.status, "refused");
  assert.equal(refused.reason, "FINGERPRINT_MISMATCH");
  assert.equal(score.characters, "changed");
  assert.equal(before, "42");
});

test("batch duplicate is idempotent by newKey and rekeys its descendants", async () => {
  const { ctx, root, box } = await batchFixture();
  const first = await runBatch(ctx, {
    dryRun: false,
    ops: [{ op: "duplicate", key: box.getPluginData(KEY_DATA), newKey: "hud/box-copy", name: "Box copy" }],
  });
  assert.equal(first.status, "applied");
  assert.equal(first.ops[0].status, "created");
  const copy = ctx.metrics.byId.get(first.ops[0].nodeId);
  assert.equal(copy.name, "Box copy");
  assert.equal(copy.getPluginData(KEY_DATA), "hud/box-copy");
  assert.equal(copy.parent, root);

  const again = await runBatch(ctx, {
    dryRun: true,
    ops: [{ op: "duplicate", key: box.getPluginData(KEY_DATA), newKey: "hud/box-copy" }],
  });
  assert.equal(again.ops[0].status, "noop");
  assert.equal(again.ops[0].existingNodeId, copy.id);
  assert.equal(root.children.filter((c) => c.getPluginData(KEY_DATA) === "hud/box-copy").length, 1);
});

test("batch refuses a protected target and an unknown key during preflight", async () => {
  const ctx = makeCtx();
  await runBuild(ctx, {
    buildId: "hud", dryRun: false,
    root: {
      type: "FRAME", name: "HUD",
      children: [{ type: "TEXT", name: "Keep", key: "keep", text: "1", protected: true }],
    },
  });
  const root = ctx.currentPage.children[0];
  await assert.rejects(
    () => runBatch(ctx, { dryRun: true, ops: [{ op: "set_text", key: "keep", text: "2" }] }),
    /protected/,
  );
  await assert.rejects(
    () => runBatch(ctx, { dryRun: true, ops: [{ op: "set_text", key: "nope", text: "2" }] }),
    /no node with key/,
  );
  assert.equal(root.children[0].characters, "1");
});

test("a patch key under the wrong parent is refused instead of duplicated", async () => {
  const ctx = makeCtx();
  await runBuild(ctx, {
    buildId: "hud",
    dryRun: false,
    root: {
      type: "FRAME", name: "HUD", children: [
        { type: "FRAME", name: "Left", children: [{ type: "TEXT", name: "Score", text: "1" }] },
        { type: "FRAME", name: "Right", children: [] },
      ],
    },
  });
  const root = ctx.currentPage.children[0];
  const score = root.children[0].children[0];
  const right = root.children[1];

  const blocked = await runPatch(ctx, {
    buildId: "hud",
    dryRun: true,
    patch: {
      type: "FRAME",
      children: [
        { type: "FRAME", key: root.children[0].getPluginData(KEY_DATA), children: [] },
        { type: "FRAME", key: root.children[1].getPluginData(KEY_DATA), children: [
          { type: "TEXT", key: score.getPluginData(KEY_DATA), text: "2" },
        ] },
      ],
    },
  });
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.blocking.some((b) => b.includes("lives under")));
  assert.equal(score.parent, root.children[0]);
  assert.equal(right.children.length, 0);
});
