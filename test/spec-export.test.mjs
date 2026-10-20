// Unit tests for the reverse direction: a live subtree becomes a figma_build
// spec. The useful assertions are the ordinary round-trip fields AND the named
// losses — a spec that quietly dropped a GROUP or an instance interior would
// look complete and then build the wrong thing.
import test from "node:test";
import assert from "node:assert/strict";
import { runExportSpec } from "../plugin/spec-export.mjs";
import { BUILD_DATA, KEY_DATA, KIND_DATA as KIND_DATA_FOR_TEST, normalizeTree } from "../plugin/ui-build.mjs";

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
    boundVariables: opts.boundVariables,
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
    p.hyperlink = opts.hyperlink === undefined ? null : opts.hyperlink;
    p.getStyledTextSegments = () => opts.segments || [{
      characters: p.characters,
      start: 0,
      end: p.characters.length,
      fontName: p.fontName,
      fontSize: p.fontSize,
      fills: p.fills,
      textCase: p.textCase,
      textDecoration: p.textDecoration,
      lineHeight: p.lineHeight,
      letterSpacing: p.letterSpacing,
      hyperlink: p.hyperlink,
      textStyleId: p.textStyleId,
      fillStyleId: p.fillStyleId,
    }];
  }
  if (type === "INSTANCE") {
    p.main = opts.main || null;
    p.componentProperties = opts.componentProperties || {};
    p.overrides = opts.overrides || [];
    p.getMainComponentAsync = async () => p.main;
  }
  if (type === "BOOLEAN_OPERATION") p.booleanOperation = opts.booleanOperation || "UNION";
  if (opts.exportAsync) p.exportAsync = opts.exportAsync;
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
    hyperlink: { type: "URL", value: "https://example.com/title" },
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
  assert.deepEqual(madeTitle.hyperlink, { type: "URL", value: "https://example.com/title" });
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

test("image and video paint geometry, filters and paint visibility survive the export", async () => {
  const imageTransform = [[1, 0, 0], [0, 1, 0]];
  const filters = { exposure: 0.2, contrast: 0.1, saturation: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0 };
  const rect = node("RECTANGLE", {
    name: "Photo",
    fills: [{
      type: "IMAGE", imageHash: "img:1", scaleMode: "CROP",
      imageTransform, scalingFactor: 0.5, rotation: 90, filters,
      opacity: 0.8, blendMode: "MULTIPLY", visible: false,
    }, {
      type: "GRADIENT_LINEAR",
      gradientStops: [
        { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
        { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
      ],
      gradientTransform: [[1, 0, 0], [0, 1, 0]],
      opacity: 0.5, blendMode: "SCREEN",
    }, {
      type: "VIDEO", videoHash: "video:1", scaleMode: "TILE",
      videoTransform: [[1, 0, 0], [0, 1, 0]], scalingFactor: 0.25, rotation: 180, filters,
      opacity: 0.6, blendMode: "OVERLAY", visible: false,
    }],
  });

  const report = await runExportSpec(makeCtx(), { nodeId: rect.id });
  assert.deepEqual(report.spec.fills[0], {
    type: "IMAGE", imageHash: "img:1", scaleMode: "CROP",
    imageTransform, scalingFactor: 0.5, rotation: 90, filters,
    opacity: 0.8, visible: false, blendMode: "MULTIPLY",
  });
  assert.deepEqual(report.spec.fills[1], {
    type: "GRADIENT_LINEAR",
    stops: [{ at: 0, color: "#ff0000" }, { at: 1, color: "#0000ff" }],
    gradientTransform: [[1, 0, 0], [0, 1, 0]],
    opacity: 0.5, blendMode: "SCREEN",
  });
  assert.deepEqual(report.spec.fills[2], {
    type: "VIDEO", videoHash: "video:1", scaleMode: "TILE",
    videoTransform: [[1, 0, 0], [0, 1, 0]], scalingFactor: 0.25, rotation: 180, filters,
    opacity: 0.6, blendMode: "OVERLAY", visible: false,
  });
  assert.equal(report.warnings.length, 0);
  assert.doesNotThrow(() => normalizeTree(report.spec));
});

test("pattern paints export their source and tiling fields", async () => {
  const source = node("RECTANGLE", { name: "Tile source" });
  const rect = node("RECTANGLE", {
    name: "Pattern",
    fills: [{
      type: "PATTERN", sourceNodeId: source.id,
      tileType: "VERTICAL_HEXAGONAL", scalingFactor: 0.75,
      spacing: { x: 3, y: 5 }, horizontalAlignment: "END",
      opacity: 0.4, blendMode: "SCREEN", visible: false,
    }],
  });

  const report = await runExportSpec(makeCtx(), { nodeId: rect.id });
  assert.deepEqual(report.spec.fills[0], {
    type: "PATTERN", sourceNodeId: source.id,
    tileType: "VERTICAL_HEXAGONAL", scalingFactor: 0.75,
    spacing: { x: 3, y: 5 }, horizontalAlignment: "END",
    opacity: 0.4, visible: false, blendMode: "SCREEN",
  });
  assert.equal(report.warnings.length, 0);
  assert.doesNotThrow(() => normalizeTree(report.spec));
});

test("URL links export, while NODE links and mixed runs are named", async () => {
  const url = node("TEXT", { name: "Docs", hyperlink: { type: "URL", value: "https://example.com/docs" } });
  const urlReport = await runExportSpec(makeCtx(), { nodeId: url.id });
  assert.deepEqual(urlReport.spec.hyperlink, { type: "URL", value: "https://example.com/docs" });
  assert.equal(normalizeTree(urlReport.spec).root.spec.hyperlink.value, "https://example.com/docs");

  const nodeLink = node("TEXT", { name: "Jump", hyperlink: { type: "NODE", value: "1:2" } });
  const nodeReport = await runExportSpec(makeCtx(), { nodeId: nodeLink.id });
  assert.deepEqual(nodeReport.spec.hyperlink, { type: "NODE", value: "1:2" });
  assert.ok(nodeReport.warnings.some((w) => /NODE link is file-local/.test(w)));

  const mixed = node("TEXT", { name: "Runs", hyperlink: Symbol("mixed") });
  const mixedReport = await runExportSpec(makeCtx(), { nodeId: mixed.id });
  assert.equal(mixedReport.spec.hyperlink, undefined);
  assert.ok(mixedReport.warnings.some((w) => /mixed across runs/.test(w)));
});

test("mixed fonts and per-run styling export as text runs", async () => {
  const red = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: 1 }];
  const blue = [{ type: "SOLID", color: { r: 0, g: 0, b: 1 }, opacity: 1 }];
  const segments = [
    {
      characters: "Hello", start: 0, end: 5,
      fontName: { family: "Inter", style: "Bold" }, fontSize: 24, fills: red,
      textCase: "ORIGINAL", textDecoration: "NONE",
      lineHeight: { unit: "AUTO" }, letterSpacing: { unit: "PERCENT", value: 0 },
      hyperlink: null, textStyleId: "S:text-base", fillStyleId: "",
      boundVariables: {
        fontSize: { type: "VARIABLE_ALIAS", id: "V:size-base" },
        letterSpacing: { type: "VARIABLE_ALIAS", id: "V:tracking" },
      },
    },
    {
      characters: " World", start: 5, end: 11,
      fontName: { family: "Inter", style: "Regular" }, fontSize: 16, fills: blue,
      textCase: "UPPER", textDecoration: "UNDERLINE",
      lineHeight: { unit: "PIXELS", value: 20 }, letterSpacing: { unit: "PIXELS", value: 1 },
      hyperlink: { type: "URL", value: "https://example.com" }, textStyleId: "S:text-emphasis", fillStyleId: "S:fill-emphasis",
      boundVariables: {
        fontSize: { type: "VARIABLE_ALIAS", id: "V:size-run" },
        fontFamily: { type: "VARIABLE_ALIAS", id: "V:family" },
      },
    },
  ];
  const styles = new Map([
    ["S:text-base", { id: "S:text-base", name: "text/base", type: "TEXT", fontName: { family: "Inter", style: "Bold" } }],
    ["S:text-emphasis", { id: "S:text-emphasis", name: "text/emphasis", type: "TEXT", fontName: { family: "Inter", style: "Regular" } }],
    ["S:fill-emphasis", { id: "S:fill-emphasis", name: "fill/emphasis", type: "PAINT" }],
  ]);
  const vars = new Map([
    ["V:size-base", { id: "V:size-base", name: "type/size-base" }],
    ["V:size-run", { id: "V:size-run", name: "type/size-run" }],
    ["V:family", { id: "V:family", name: "type/family" }],
    ["V:tracking", { id: "V:tracking", name: "type/tracking" }],
  ]);
  const title = node("TEXT", { name: "Mixed", characters: "Hello World", segments });
  title.fontName = Symbol("mixed");
  title.fontSize = Symbol("mixed");
  title.fills = Symbol("mixed");
  title.lineHeight = Symbol("mixed");
  title.letterSpacing = Symbol("mixed");
  title.textCase = Symbol("mixed");
  title.textDecoration = Symbol("mixed");
  title.hyperlink = Symbol("mixed");

  const report = await runExportSpec(makeCtx({ styles, vars }), { nodeId: title.id });
  assert.equal(report.spec.textStyle, "text/base");
  assert.deepEqual(report.spec.textVariable, { fontSize: "type/size-base", letterSpacing: "type/tracking" });
  assert.equal(report.spec.font, undefined);
  assert.equal(report.spec.fontSize, 24);
  assert.deepEqual(report.spec.fills, [{ color: "#ff0000" }]);
  assert.equal(report.spec.runs.length, 1);
  const run = report.spec.runs[0];
  assert.equal(run.start, 5);
  assert.equal(run.end, 11);
  assert.deepEqual(run.font, { family: "Inter", style: "Regular" });
  assert.equal(run.fontSize, 16);
  assert.equal(run.textStyle, "text/emphasis");
  assert.equal(run.fillStyle, "fill/emphasis");
  assert.equal(run.fills, undefined);
  assert.deepEqual(run.variable, {
    fontSize: "type/size-run",
    fontFamily: "type/family",
    letterSpacing: null,
  });
  assert.equal(run.textCase, "UPPER");
  assert.equal(run.textDecoration, "UNDERLINE");
  assert.deepEqual(run.lineHeight, { unit: "PIXELS", value: 20 });
  assert.deepEqual(run.letterSpacing, { unit: "PIXELS", value: 1 });
  assert.deepEqual(run.hyperlink, { type: "URL", value: "https://example.com" });
  assert.equal(report.warnings.some((w) => /MIXED fonts|mixed across runs|per-run .*not representable/.test(w)), false);

  const normalized = normalizeTree(report.spec);
  assert.equal(normalized.root.spec.runs.length, 1);
  assert.deepEqual(normalized.root.spec.runs[0].font, { family: "Inter", style: "Regular" });
  assert.equal(normalized.root.spec.runs[0].textStyle, "text/emphasis");
  assert.equal(normalized.root.spec.runs[0].fillStyle, "fill/emphasis");
  assert.deepEqual(normalized.root.spec.textVariable, { fontSize: "type/size-base", letterSpacing: "type/tracking" });
  assert.deepEqual(normalized.root.spec.runs[0].variable, {
    fontSize: "type/size-run",
    fontFamily: "type/family",
    letterSpacing: null,
  });
});

test("a uniform text binding still exports through the segment path", async () => {
  const vars = new Map([["V:size", { id: "V:size", name: "type/size" }]]);
  const fill = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1 }];
  const title = node("TEXT", {
    name: "Bound", characters: "Hi",
    fontName: { family: "Inter", style: "Regular" }, fontSize: 16, fills: fill,
    segments: [{
      characters: "Hi", start: 0, end: 2,
      fontName: { family: "Inter", style: "Regular" }, fontSize: 16, fills: fill,
      textCase: "ORIGINAL", textDecoration: "NONE",
      lineHeight: { unit: "AUTO" }, letterSpacing: { unit: "PERCENT", value: 0 },
      hyperlink: null,
      boundVariables: { fontSize: { type: "VARIABLE_ALIAS", id: "V:size" } },
    }],
  });
  const report = await runExportSpec(makeCtx({ vars }), { nodeId: title.id });
  assert.deepEqual(report.spec.textVariable, { fontSize: "type/size" });
  assert.equal(report.spec.runs, undefined);
  assert.equal(normalizeTree(report.spec).root.spec.textVariable.fontSize, "type/size");
});

test("an unresolved run variable clears the base binding instead of inheriting it", async () => {
  const vars = new Map([["V:base", { id: "V:base", name: "type/base" }]]);
  const black = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1 }];
  const segments = [
    {
      characters: "A", start: 0, end: 1,
      fontName: { family: "Inter", style: "Regular" }, fontSize: 16, fills: black,
      textCase: "ORIGINAL", textDecoration: "NONE",
      lineHeight: { unit: "AUTO" }, letterSpacing: { unit: "PERCENT", value: 0 },
      hyperlink: null,
      boundVariables: { fontSize: { type: "VARIABLE_ALIAS", id: "V:base" } },
    },
    {
      characters: "B", start: 1, end: 2,
      fontName: { family: "Inter", style: "Regular" }, fontSize: 18, fills: black,
      textCase: "ORIGINAL", textDecoration: "NONE",
      lineHeight: { unit: "AUTO" }, letterSpacing: { unit: "PERCENT", value: 0 },
      hyperlink: null,
      boundVariables: { fontSize: { type: "VARIABLE_ALIAS", id: "V:gone" } },
    },
  ];
  const title = node("TEXT", { name: "Gone", characters: "AB", segments });
  const report = await runExportSpec(makeCtx({ vars }), { nodeId: title.id });
  assert.deepEqual(report.spec.textVariable, { fontSize: "type/base" });
  assert.deepEqual(report.spec.runs[0].variable, { fontSize: null });
  assert.equal(report.spec.runs[0].fontSize, 18);
  assert.ok(report.warnings.some((w) => /V:gone.*no longer resolves/.test(w)));
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

test("a boolean operation exports its operation and live operands", async () => {
  const base = node("RECTANGLE", { name: "Base", width: 40, height: 40, fills: "#00ff00" });
  const dot = node("ELLIPSE", { name: "Dot", width: 8, height: 8, x: 4, y: 4 });
  const ring = node("ELLIPSE", { name: "Ring", width: 16, height: 16, x: 12, y: 12 });
  const nested = node("BOOLEAN_OPERATION", {
    name: "Nested", booleanOperation: "EXCLUDE", width: 20, height: 20,
    children: [dot, ring],
  });
  const cutout = node("BOOLEAN_OPERATION", {
    name: "Cutout", booleanOperation: "SUBTRACT", width: 40, height: 40,
    children: [base, nested],
  });

  const report = await runExportSpec(makeCtx(), { nodeId: cutout.id });
  assert.equal(report.spec.type, "BOOLEAN_OPERATION");
  assert.equal(report.spec.booleanOperation, "SUBTRACT");
  assert.equal(report.spec.size, undefined);
  assert.equal(report.spec.children.length, 2);
  assert.equal(report.spec.children[0].type, "RECTANGLE");
  assert.equal(report.spec.children[1].type, "BOOLEAN_OPERATION");
  assert.equal(report.spec.children[1].booleanOperation, "EXCLUDE");
  assert.equal(report.spec.children[1].size, undefined);
  assert.equal(report.spec.children[1].children.length, 2);
  assert.deepEqual(report.spec.children[1].children[0].position, { x: 4, y: 4 });
  assert.equal(report.unsupported.length, 0);

  // The exported shape is the build language's shape, not just similar JSON.
  const normalized = normalizeTree(report.spec);
  assert.equal(normalized.root.type, "BOOLEAN_OPERATION");
  assert.equal(normalized.root.spec.booleanOperation, "SUBTRACT");
  assert.equal(normalized.root.children.length, 2);
  assert.equal(normalized.root.children[1].children.length, 2);
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
  assert.equal(report.spec.overrides, undefined);
  assert.ok(!report.warnings.some((w) => /instance interiors/.test(w)));
  assert.ok(report.warnings.some((w) => /property "Icon"/.test(w)));
});

test("direct instance overrides export as structural paths", async () => {
  const main = {
    id: "1:2", key: "component-key", name: "Button",
    children: [{ name: "Label", children: [] }, { name: "Icon", children: [] }],
  };
  const solid = (r, g, b) => [{ type: "SOLID", color: { r, g, b }, opacity: 1 }];
  const label = node("TEXT", {
    name: "Label", characters: "Play", fontSize: 16,
    fontName: { family: "Inter", style: "Bold" },
    hyperlink: { type: "URL", value: "https://example.com/play" },
    fills: solid(0, 0, 1),
  });
  const icon = node("RECTANGLE", {
    name: "Icon", width: 24, height: 24, visible: false, opacity: 0.4,
    fills: solid(1, 0, 0),
  });
  const inst = node("INSTANCE", {
    name: "Play button", main, children: [label, icon],
    overrides: [
      { id: label.id, overriddenFields: ["characters", "fontSize", "fontName", "hyperlink"] },
      { id: icon.id, overriddenFields: ["visible", "opacity", "fills", "width", "height"] },
    ],
  });
  const report = await runExportSpec(makeCtx(), { nodeId: inst.id });
  assert.deepEqual(report.spec.overrides.Label.path, [{ name: "Label", index: 0 }]);
  assert.equal(report.spec.overrides.Label.text, "Play");
  assert.equal(report.spec.overrides.Label.fontSize, 16);
  assert.deepEqual(report.spec.overrides.Label.font, { family: "Inter", style: "Bold" });
  assert.equal(report.spec.overrides.Label.hyperlink.value, "https://example.com/play");
  assert.deepEqual(report.spec.overrides.Icon.path, [{ name: "Icon", index: 1 }]);
  assert.equal(report.spec.overrides.Icon.visible, false);
  assert.equal(report.spec.overrides.Icon.opacity, 0.4);
  assert.deepEqual(report.spec.overrides.Icon.size, { width: 24, height: 24 });
  assert.equal(report.spec.overrides.Icon.fills[0].color, "#ff0000");
  assert.ok(!report.warnings.some((w) => /instance interiors/.test(w)));
});

test("an override path uses the main component's layer names, not the rename", async () => {
  const main = { id: "1:2", key: "component-key", name: "Button", children: [{ name: "Label", children: [] }] };
  const label = node("TEXT", { name: "Renamed label", characters: "Play" });
  const inst = node("INSTANCE", {
    name: "Button", main, children: [label],
    overrides: [{ id: label.id, overriddenFields: ["name", "characters"] }],
  });
  const report = await runExportSpec(makeCtx(), { nodeId: inst.id });
  assert.deepEqual(report.spec.overrides["Renamed label"].path, [{ name: "Label", index: 0 }]);
  assert.equal(report.spec.overrides["Renamed label"].name, "Renamed label");
  assert.equal(report.spec.overrides["Renamed label"].text, "Play");
});

test("duplicate instance layer names keep distinct paths, and unsupported fields are named", async () => {
  const main = {
    id: "1:2", key: "component-key", name: "List",
    children: [{ name: "Label", children: [] }, { name: "Label", children: [] }],
  };
  const first = node("TEXT", { name: "Label", characters: "A" });
  const second = node("TEXT", { name: "Label", characters: "B" });
  const inst = node("INSTANCE", {
    name: "List", main, children: [first, second],
    overrides: [
      { id: first.id, overriddenFields: ["characters"] },
      { id: second.id, overriddenFields: ["characters", "reactions"] },
    ],
  });
  const report = await runExportSpec(makeCtx(), { nodeId: inst.id });
  assert.deepEqual(report.spec.overrides.Label.path, [{ name: "Label", index: 0 }]);
  assert.equal(report.spec.overrides.Label.text, "A");
  assert.deepEqual(report.spec.overrides["Label#2"].path, [{ name: "Label", index: 1 }]);
  assert.equal(report.spec.overrides["Label#2"].text, "B");
  assert.ok(report.warnings.some((w) => /reactions/.test(w) && /cannot represent/.test(w)));
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

test("an unsupported layer exports as the SVG render the build can rebuild", async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" rx="4"/></svg>';
  const settings = [];
  const badge = node("GROUP", {
    name: "Badge", width: 40, height: 20, x: 12, y: 8,
    exportAsync: async (s) => { settings.push(s); return svg; },
  });
  const frame = node("FRAME", { name: "HUD", width: 200, height: 100, children: [badge] });
  const report = await runExportSpec(makeCtx(), { nodeId: frame.id });
  const fallback = report.spec.children[0];
  assert.equal(fallback.type, "SVG");
  assert.equal(fallback.name, "Badge");
  assert.equal(fallback.svg, svg);
  assert.deepEqual(fallback.position, { x: 12, y: 8 });
  assert.equal(report.counts.svgFallbacks, 1);
  assert.equal(report.counts.svgBytes, svg.length);
  assert.equal(report.unsupported.length, 0);
  assert.ok(report.warnings.some((w) => /no build-spec equivalent/.test(w) && /flattened/.test(w)));
  assert.equal(settings.length, 1);
  assert.equal(settings[0].format, "SVG_STRING");
  assert.equal(settings[0].svgOutlineText, true);

  // The fallback is not just JSON that looks plausible: the build normalizer
  // accepts it as a leaf and keeps its key.
  const normalized = normalizeTree(report.spec);
  assert.equal(normalized.nodes, 2);
  assert.deepEqual(normalized.keys, [report.spec.key, fallback.key]);
});

test("an SVG-created frame and a detached instance fall back instead of being dropped", async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="12"/></svg>';
  const logo = node("FRAME", {
    name: "Logo", width: 24, height: 24,
    plugin: { [KIND_DATA_FOR_TEST]: "SVG" },
    exportAsync: async () => svg,
  });
  const rootReport = await runExportSpec(makeCtx(), { nodeId: logo.id });
  assert.equal(rootReport.spec.type, "SVG");
  assert.equal(rootReport.spec.svg, svg);
  assert.equal(rootReport.source.type, "FRAME");
  assert.ok(rootReport.warnings.some((w) => /created from SVG/.test(w)));
  await assert.rejects(
    () => runExportSpec(makeCtx(), { nodeId: logo.id, svgFallback: false }),
    /pass svgFallback/,
  );

  const lost = node("INSTANCE", {
    name: "Lost", main: null, width: 30, height: 30,
    exportAsync: async () => '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"></svg>',
  });
  const frame = node("FRAME", { name: "Card", children: [lost] });
  const report = await runExportSpec(makeCtx(), { nodeId: frame.id });
  assert.equal(report.spec.children[0].type, "SVG");
  assert.equal(report.spec.children[0].componentKey, undefined);
  assert.equal(report.spec.children[0].properties, undefined);
  assert.ok(report.warnings.some((w) => /detached instance/.test(w) && /flattened/.test(w)));

  const off = await runExportSpec(makeCtx(), { nodeId: frame.id, svgFallback: false });
  assert.equal(off.spec.children, undefined);
  assert.match(off.unsupported[0].why, /detached instance/);
});

test("the SVG fallback names a missing exporter and its size budgets", async () => {
  const missing = node("GROUP", { name: "No exporter" });
  const missingFrame = node("FRAME", { name: "Missing", children: [missing] });
  const missingReport = await runExportSpec(makeCtx(), { nodeId: missingFrame.id });
  assert.equal(missingReport.spec.children, undefined);
  assert.equal(missingReport.unsupported[0].type, "GROUP");
  assert.match(missingReport.unsupported[0].why, /no exportAsync/);
  assert.ok(missingReport.warnings.some((w) => /no exportAsync in this session/.test(w)));

  const huge = '<svg xmlns="http://www.w3.org/2000/svg">' + "x".repeat(129 * 1024) + "</svg>";
  const oversized = node("GROUP", { name: "Huge", exportAsync: async () => huge });
  const hugeFrame = node("FRAME", { name: "Huge frame", children: [oversized] });
  const hugeReport = await runExportSpec(makeCtx(), { nodeId: hugeFrame.id });
  assert.equal(hugeReport.spec.children, undefined);
  assert.equal(hugeReport.unsupported[0].type, "GROUP");
  assert.match(hugeReport.unsupported[0].why, /per-node fallback budget/);
  assert.ok(hugeReport.warnings.some((w) => /per-node fallback budget/.test(w)));

  const nearly = '<svg xmlns="http://www.w3.org/2000/svg">' + "x".repeat(100 * 1024) + "</svg>";
  const first = node("GROUP", { name: "First", exportAsync: async () => nearly });
  const second = node("GROUP", { name: "Second", exportAsync: async () => nearly });
  const frame = node("FRAME", { name: "Budget", children: [first, second] });
  const budget = await runExportSpec(makeCtx(), { nodeId: frame.id });
  assert.equal(budget.counts.svgFallbacks, 1);
  assert.equal(budget.spec.children.length, 1);
  assert.match(budget.unsupported[0].why, /no build-spec equivalent/);
  assert.match(budget.unsupported[0].why, /total fallback budget/);
  assert.ok(budget.warnings.some((w) => /total fallback budget/.test(w)));
});
