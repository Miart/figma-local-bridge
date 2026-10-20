// Unit tests for the reverse direction: a live subtree becomes a figma_build
// spec. The useful assertions are the ordinary round-trip fields AND the named
// losses — a spec that quietly dropped a GROUP or an instance interior would
// look complete and then build the wrong thing.
import test from "node:test";
import assert from "node:assert/strict";
import { runExportSpec } from "../plugin/spec-export.mjs";
import { BUILD_DATA, KEY_DATA, normalizeTree } from "../plugin/ui-build.mjs";

let seq = 0;
const ALL = new Map();

function node(type, opts = {}) {
  const p = {
    id: opts.id || `${++seq}:${seq}`,
    type,
    name: opts.name || type,
    visible: opts.visible !== false,
    opacity: opts.opacity === undefined ? 1 : opts.opacity,
    blendMode: opts.blendMode || "NORMAL",
    locked: opts.locked === true,
    x: opts.x === undefined ? 0 : opts.x,
    y: opts.y === undefined ? 0 : opts.y,
    width: opts.width === undefined ? 100 : opts.width,
    height: opts.height === undefined ? 100 : opts.height,
    rotation: opts.rotation || 0,
    parent: opts.parent || null,
    children: opts.children || [],
    removed: false,
    fills: opts.fills || [],
    strokes: opts.strokes || [],
    effects: opts.effects || [],
    fillStyleId: opts.fillStyleId || "",
    strokeStyleId: opts.strokeStyleId || "",
    effectStyleId: opts.effectStyleId || "",
    textStyleId: opts.textStyleId || "",
    strokeWeight: opts.strokeWeight === undefined ? 1 : opts.strokeWeight,
    strokeAlign: opts.strokeAlign || "INSIDE",
    strokeCap: opts.strokeCap || "NONE",
    strokeJoin: opts.strokeJoin || "MITER",
    strokeMiterLimit: opts.strokeMiterLimit === undefined ? 4 : opts.strokeMiterLimit,
    dashPattern: opts.dashPattern || [],
    cornerRadius: opts.cornerRadius === undefined ? 0 : opts.cornerRadius,
    topLeftRadius: opts.topLeftRadius === undefined ? 0 : opts.topLeftRadius,
    topRightRadius: opts.topRightRadius === undefined ? 0 : opts.topRightRadius,
    bottomRightRadius: opts.bottomRightRadius === undefined ? 0 : opts.bottomRightRadius,
    bottomLeftRadius: opts.bottomLeftRadius === undefined ? 0 : opts.bottomLeftRadius,
    isMask: opts.isMask === true,
    itemReverseZIndex: opts.itemReverseZIndex === true,
    strokesIncludedInLayout: opts.strokesIncludedInLayout === true,
    layoutGrids: opts.layoutGrids || [],
    cornerSmoothing: opts.cornerSmoothing || 0,
    constraints: opts.constraints || { horizontal: "MIN", vertical: "MIN" },
    layoutMode: opts.layoutMode || "NONE",
    clipsContent: opts.clipsContent === true,
    itemSpacing: opts.itemSpacing || 0,
    counterAxisSpacing: opts.counterAxisSpacing ?? null,
    paddingTop: opts.paddingTop || 0,
    paddingRight: opts.paddingRight || 0,
    paddingBottom: opts.paddingBottom || 0,
    paddingLeft: opts.paddingLeft || 0,
    primaryAxisAlignItems: opts.primaryAxisAlignItems || "MIN",
    counterAxisAlignItems: opts.counterAxisAlignItems || "MIN",
    primaryAxisSizingMode: opts.primaryAxisSizingMode || "FIXED",
    counterAxisSizingMode: opts.counterAxisSizingMode || "FIXED",
    layoutWrap: opts.layoutWrap || "NO_WRAP",
    layoutGrow: opts.layoutGrow || 0,
    layoutAlign: opts.layoutAlign || "INHERIT",
    layoutPositioning: opts.layoutPositioning || "AUTO",
    layoutSizingHorizontal: opts.layoutSizingHorizontal || "FIXED",
    layoutSizingVertical: opts.layoutSizingVertical || "FIXED",
    minWidth: opts.minWidth ?? null,
    maxWidth: opts.maxWidth ?? null,
    minHeight: opts.minHeight ?? null,
    maxHeight: opts.maxHeight ?? null,
  };
  const plugin = opts.plugin || {};
  p.getPluginData = (key) => plugin[key] || "";
  if (type === "TEXT") {
    p.characters = opts.characters ?? "Text";
    p.fontName = opts.fontName || { family: "Inter", style: "Regular" };
    p.fontSize = opts.fontSize === undefined ? 16 : opts.fontSize;
    p.textAutoResize = opts.textAutoResize || "NONE";
    p.textAlignHorizontal = opts.textAlignHorizontal || "LEFT";
    p.textAlignVertical = opts.textAlignVertical || "TOP";
    p.lineHeight = opts.lineHeight || { unit: "AUTO" };
    p.letterSpacing = opts.letterSpacing || { unit: "PERCENT", value: 0 };
    p.textCase = opts.textCase || "ORIGINAL";
    p.textDecoration = opts.textDecoration || "NONE";
    p.paragraphSpacing = opts.paragraphSpacing || 0;
    p.paragraphIndent = opts.paragraphIndent || 0;
  }
  if (type === "INSTANCE") {
    p.main = opts.main || null;
    p.componentProperties = opts.componentProperties || {};
    p.getMainComponentAsync = async () => p.main;
  }
  for (const child of p.children) child.parent = p;
  ALL.set(p.id, p);
  return p;
}

function add(parent, child) {
  child.parent = parent;
  parent.children.push(child);
  return child;
}

function makeCtx({ styles = new Map(), vars = new Map(), selection = [] } = {}) {
  return {
    currentPage: { selection },
    styles,
    vars,
    async getStyleByIdAsync(id) {
      return styles.get(id) || null;
    },
    variables: {
      async getVariableByIdAsync(id) {
        return vars.get(id) || null;
      },
    },
    async getNodeByIdAsync(id) {
      if (id === "0:1") return { id: "0:1", type: "PAGE", name: "Page 1", parent: { type: "DOCUMENT" }, selection };
      return ALL.get(id) || null;
    },
  };
}

test("exports a keyed card with styles, text and auto layout", async () => {
  const styles = new Map([
    ["S:paint", { id: "S:paint", name: "brand/surface", type: "PAINT" }],
    ["S:text", { id: "S:text", name: "text/heading", type: "TEXT", fontName: { family: "Inter", style: "Bold" } }],
  ]);
  const title = node("TEXT", {
    name: "Title", characters: "Hello", key: "title",
    fontName: { family: "Inter", style: "Bold" }, fontSize: 24,
    textStyleId: "S:text", fillStyleId: "S:text",
    textCase: "UPPER", textDecoration: "UNDERLINE", paragraphSpacing: 3, paragraphIndent: 2,
  });
  const bg = node("RECTANGLE", {
    name: "Bg", key: "bg", width: 320, height: 120,
    fillStyleId: "S:paint", cornerRadius: 0,
    topLeftRadius: 12, topRightRadius: 0, bottomRightRadius: 8, bottomLeftRadius: 2,
    strokeCap: "ROUND", strokeJoin: "ROUND", strokeMiterLimit: 6,
    isMask: true, itemReverseZIndex: true, strokesIncludedInLayout: true,
  });
  const card = node("FRAME", {
    name: "Card", key: "card", width: 320, height: 120, rotation: 15,
    layoutMode: "VERTICAL", itemSpacing: 8,
    paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16,
    fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: 0.5 }],
    children: [bg, title],
    plugin: { [KEY_DATA]: "card", [BUILD_DATA]: "build-1" },
  });
  // The child keys above are illustrative; the engine reads plugin data.
  bg.getPluginData = (k) => (k === KEY_DATA ? "bg" : "");
  title.getPluginData = (k) => (k === KEY_DATA ? "title" : "");

  const report = await runExportSpec(makeCtx({ styles }), { nodeId: card.id });
  assert.equal(report.schema, "build-spec-export/v1");
  assert.equal(report.source.key, "card");
  assert.equal(report.source.buildId, "build-1");
  assert.equal(report.spec.key, "card");
  assert.equal(report.spec.type, "FRAME");
  assert.deepEqual(report.spec.size, { width: 320, height: 120 });
  assert.equal(report.spec.layout.mode, "VERTICAL");
  assert.equal(report.spec.layout.gap, 8);
  assert.deepEqual(report.spec.layout.padding, [16, 16, 16, 16]);
  assert.equal(report.spec.fills[0].opacity, 0.5);
  assert.equal(report.spec.rotation, 15);

  const [madeBg, madeTitle] = report.spec.children;
  assert.equal(madeBg.key, "bg");
  assert.equal(madeBg.fillStyle, "brand/surface");
  assert.equal(madeBg.topLeftRadius, 12);
  assert.equal(madeBg.topRightRadius, 0);
  assert.equal(madeBg.bottomRightRadius, 8);
  assert.equal(madeBg.bottomLeftRadius, 2);
  assert.equal(madeBg.strokeCap, "ROUND");
  assert.equal(madeBg.strokeJoin, "ROUND");
  assert.equal(madeBg.strokeMiterLimit, 6);
  assert.equal(madeBg.isMask, true);
  assert.equal(madeBg.itemReverseZIndex, true);
  assert.equal(madeBg.strokesIncludedInLayout, true);
  assert.equal(madeTitle.key, "title");
  assert.equal(madeTitle.text, "Hello");
  assert.equal(madeTitle.textStyle, "text/heading");
  assert.equal(madeTitle.fontSize, 24);
  assert.equal(madeTitle.fillStyle, "text/heading");
  assert.equal(madeTitle.textCase, "UPPER");
  assert.equal(madeTitle.textDecoration, "UNDERLINE");
  assert.equal(madeTitle.paragraphSpacing, 3);
  assert.equal(madeTitle.paragraphIndent, 2);
  assert.equal(madeTitle.font, undefined, "the style's own font is not re-declared");
  assert.equal(report.truncated, false);

  // The point of the export is a spec the build engine accepts, not merely a
  // JSON shape that looks plausible in a test.
  const normalized = normalizeTree(report.spec);
  assert.equal(normalized.nodes, 3);
  assert.deepEqual(normalized.keys, ["card", "bg", "title"]);
});

test("layout grids and line length survive the round trip", async () => {
  const line = node("LINE", { name: "Rule", width: 120, height: 0, rotation: 30 });
  const frame = node("FRAME", {
    name: "Gridded", width: 360, height: 200,
    layoutGrids: [{
      pattern: "COLUMNS", visible: true,
      color: { r: 1, g: 0, b: 0, a: 0.1 },
      alignment: "STRETCH", gutterSize: 8, offset: 4, count: 3, sectionSize: 96,
    }],
    children: [line],
  });

  const report = await runExportSpec(makeCtx(), { nodeId: frame.id });
  assert.equal(report.spec.layoutGrids[0].pattern, "COLUMNS");
  assert.equal(report.spec.layoutGrids[0].color, "#ff00001a");
  assert.equal(report.spec.layoutGrids[0].count, 3);
  assert.equal(report.spec.layoutGrids[0].sectionSize, 96);
  assert.equal(report.spec.children[0].length, 120);
  assert.equal(report.spec.children[0].rotation, 30);
  assert.equal(report.spec.children[0].size, undefined);
  assert.equal(report.warnings.some((w) => w.includes("LINE length")), false);

  const normalized = normalizeTree(report.spec);
  assert.equal(normalized.nodes, 2);
});

test("variables, derived keys and unsupported nodes are named", async () => {
  const vars = new Map([["VariableID:1:2", { id: "VariableID:1:2", name: "color/text/primary" }]]);
  const leaf = node("RECTANGLE", {
    name: "Accent", fills: [{
      type: "SOLID", color: { r: 0.1, g: 0.2, b: 0.3 },
      boundVariables: { color: { type: "VARIABLE_ALIAS", id: "VariableID:1:2" } },
    }],
  });
  const group = node("GROUP", { name: "Legacy group" });
  const frame = node("FRAME", {
    name: "Panel", width: 200, height: 100,
    children: [leaf, group],
  });

  const report = await runExportSpec(makeCtx({ vars }), { nodeId: frame.id });
  assert.equal(report.spec.key, "/panel#0");
  assert.equal(report.spec.children.length, 1);
  assert.equal(report.spec.children[0].key, "/panel#0/accent#0");
  assert.equal(report.spec.children[0].fills[0].variable, "color/text/primary");
  assert.equal(report.spec.children[0].fills[0].color, "#1a334d");
  assert.equal(report.unsupported.length, 1);
  assert.equal(report.unsupported[0].type, "GROUP");
  assert.match(report.unsupported[0].why, /no build-spec equivalent/);
});

test("hidden nodes and depth limits are explicit, and maxNodes marks the spec incomplete", async () => {
  const hidden = node("RECTANGLE", { name: "Secret", visible: false });
  const frame = node("FRAME", { name: "Box", children: [hidden] });
  const noHidden = await runExportSpec(makeCtx(), { nodeId: frame.id, includeHidden: false });
  assert.equal(noHidden.spec.children, undefined);
  assert.equal(noHidden.counts.scanned, 2);

  const shallow = await runExportSpec(makeCtx(), { nodeId: frame.id, maxDepth: 0 });
  assert.equal(shallow.spec.children, undefined);
  assert.equal(shallow.unsupported[0].why, "deeper than maxDepth 0");

  const capped = await runExportSpec(makeCtx(), { nodeId: frame.id, maxNodes: 1 });
  assert.equal(capped.truncated, true);
  assert.equal(capped.spec.children, undefined);
  assert.ok(capped.warnings.some((w) => /INCOMPLETE/.test(w)));
});

test("an instance carries its main component and properties, but not its interior", async () => {
  const main = { id: "1:2", key: "component-key", name: "Button" };
  const inside = node("TEXT", { name: "Label", characters: "Play" });
  const page = node("PAGE", { name: "Page 1" });
  const inst = node("INSTANCE", {
    name: "Play button", main, parent: page, x: 10, y: 20, width: 80, height: 32, opacity: 0.5,
    componentProperties: {
      Label: { type: "TEXT", value: "Play" },
      Disabled: { type: "BOOLEAN", value: false },
      Icon: { type: "INSTANCE_SWAP", value: { id: "3:4" } },
    },
    children: [inside],
  });
  const report = await runExportSpec(makeCtx(), { nodeId: inst.id });
  assert.equal(report.spec.type, "INSTANCE");
  assert.equal(report.spec.componentKey, "component-key");
  assert.deepEqual(report.spec.properties, { Label: "Play", Disabled: false });
  assert.deepEqual(report.spec.size, { width: 80, height: 32 });
  assert.deepEqual(report.spec.position, { x: 10, y: 20 });
  assert.equal(report.spec.opacity, 0.5);
  assert.equal(report.spec.children, undefined);
  assert.ok(report.warnings.some((w) => /instance interiors/.test(w)));
  assert.ok(report.warnings.some((w) => /property "Icon"/.test(w)));
});

test("a detached instance is skipped, not exported as a fake instance", async () => {
  const inst = node("INSTANCE", { name: "Lost", main: null });
  const frame = node("FRAME", { name: "Page", children: [inst] });
  const report = await runExportSpec(makeCtx(), { nodeId: frame.id });
  assert.equal(report.spec.children, undefined);
  assert.equal(report.unsupported[0].type, "INSTANCE");
  assert.match(report.unsupported[0].why, /detached instance/);
});

test("no node and no single selection is a refusal", async () => {
  await assert.rejects(
    () => runExportSpec(makeCtx(), {}),
    /needs nodeId, or exactly one selected node/,
  );
});
