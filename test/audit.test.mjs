// Unit tests for the read-only audit. The rules are promises about what a
// finding MEANS, so the tests pin the semantics, not the wording of the report.

import test from "node:test";
import assert from "node:assert/strict";
import { runAudit, contrastRatio } from "../plugin/audit.mjs";
import { BUILD_DATA, KEY_DATA } from "../plugin/ui-build.mjs";

let seq = 0;

function makeCtx() {
  const byId = new Map();
  const page = node({ type: "PAGE", name: "Page 1" });
  const root = node({ type: "DOCUMENT", name: "Document", children: [page], parent: null });
  page.parent = root;
  byId.set(page.id, page);
  byId.set(root.id, root);
  return {
    mixed: Symbol("mixed"),
    currentPage: page,
    root,
    getNodeByIdAsync(id) { return Promise.resolve(byId.get(id) || null); },
    metrics: { byId },
  };
}

function node(opts = {}) {
  const n = {
    id: `${++seq}:${seq}`,
    type: opts.type || "FRAME",
    name: opts.name || "Node",
    visible: opts.visible !== false,
    opacity: opts.opacity === undefined ? 1 : opts.opacity,
    blendMode: opts.blendMode || "NORMAL",
    fills: opts.fills || [],
    strokes: opts.strokes || [],
    fillStyleId: opts.fillStyleId || "",
    strokeStyleId: opts.strokeStyleId || "",
    textStyleId: opts.textStyleId || "",
    cornerRadius: opts.cornerRadius === undefined ? 0 : opts.cornerRadius,
    effects: opts.effects || [],
    effectStyleId: opts.effectStyleId || "",
    layoutMode: opts.layoutMode || "NONE",
    itemSpacing: opts.itemSpacing === undefined ? 0 : opts.itemSpacing,
    counterAxisSpacing: opts.counterAxisSpacing === undefined ? null : opts.counterAxisSpacing,
    paddingTop: opts.paddingTop === undefined ? 0 : opts.paddingTop,
    paddingRight: opts.paddingRight === undefined ? 0 : opts.paddingRight,
    paddingBottom: opts.paddingBottom === undefined ? 0 : opts.paddingBottom,
    paddingLeft: opts.paddingLeft === undefined ? 0 : opts.paddingLeft,
    characters: opts.characters,
    fontName: opts.fontName || (opts.type === "TEXT" ? { family: "Inter", style: "Regular" } : undefined),
    fontSize: opts.fontSize === undefined ? (opts.type === "TEXT" ? 16 : undefined) : opts.fontSize,
    children: [],
    parent: opts.parent || null,
    removed: false,
    pluginData: { ...(opts.pluginData || {}) },
    getPluginData(k) { return this.pluginData[k] || ""; },
    setPluginData(k, v) { this.pluginData[k] = String(v); },
    getMainComponentAsync() { return Promise.resolve(opts.mainComponent || null); },
  };
  for (const child of opts.children || []) {
    child.parent = n;
    n.children.push(child);
  }
  if (!opts.noRegister) ctxRegister.set(n.id, n);
  return n;
}

const ctxRegister = new Map();

function solid(r, g, b, extra = {}) {
  return { type: "SOLID", visible: true, opacity: 1, color: { r, g, b }, ...extra };
}

function fixture() {
  const ctx = makeCtx();
  const byId = ctx.metrics.byId;

  const hud = node({
    type: "FRAME", name: "HUD", fills: [solid(1, 1, 1)],
    pluginData: { [BUILD_DATA]: "hud", [KEY_DATA]: "hud" },
  });
  byId.set(hud.id, hud);

  const title = node({
    type: "TEXT", name: "Title", parent: hud,
    characters: "Lorem ipsum dolor", fills: [solid(1, 1, 1)],
    pluginData: { [KEY_DATA]: "hud/title#0" },
  });
  const loose = node({
    type: "TEXT", name: "Loose", parent: hud, characters: "Hello",
    fills: [solid(0, 0, 0)],
  });
  const styled = node({
    type: "RECTANGLE", name: "Styled", parent: hud, fills: [solid(0, 0, 1)],
    fillStyleId: "S:1",
    pluginData: { [KEY_DATA]: "hud/styled#2" },
  });
  const defaultName = node({ type: "FRAME", name: "Frame 12", parent: hud });
  const dupA = node({ type: "RECTANGLE", name: "Dup A", parent: hud, pluginData: { [KEY_DATA]: "dup" } });
  const dupB = node({ type: "RECTANGLE", name: "Dup B", parent: hud, pluginData: { [KEY_DATA]: "dup" } });
  const instance = node({ type: "INSTANCE", name: "Detached", parent: hud, mainComponent: null });
  const hidden = node({
    type: "RECTANGLE", name: "Hidden literal", parent: hud, visible: false,
    fills: [solid(1, 0, 0)],
  });

  hud.children = [title, loose, styled, defaultName, dupA, dupB, instance, hidden];
  ctx.currentPage.children = [hud];
  return { ctx, hud, title, loose, styled, defaultName, dupA, dupB, instance, hidden };
}

test("contrast ratio matches WCAG extremes", () => {
  assert.equal(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 1, g: 1, b: 1 }), 21);
  assert.equal(contrastRatio({ r: 1, g: 1, b: 1 }, { r: 1, g: 1, b: 1 }), 1);
});

test("default audit finds keys, literals, text styles, placeholders, detached instances and contrast", async () => {
  const { ctx, title } = fixture();
  const report = await runAudit(ctx, {});
  assert.equal(report.schema, "audit-v2");
  assert.equal(report.scope.type, "PAGE");
  assert.ok(report.nodesScanned >= 8);
  const rules = new Set(report.findings.map((f) => f.rule));
  for (const rule of ["hardcoded-fill", "unstyled-text", "placeholder-text", "contrast", "duplicate-key", "unkeyed-node", "detached-instance", "default-name"]) {
    assert.ok(rules.has(rule), `expected ${rule}, got ${[...rules].join(", ")}`);
  }
  const titleFindings = report.findings.filter((f) => f.nodeId === title.id);
  assert.ok(titleFindings.some((f) => f.rule === "contrast" && f.ratio === 1));
  assert.ok(titleFindings.some((f) => f.rule === "placeholder-text"));
  const dup = report.findings.filter((f) => f.rule === "duplicate-key");
  assert.equal(dup.length, 2);
  assert.ok(dup.every((f) => f.duplicateKey === "dup" && f.severity === "error"));
  assert.equal(report.counts.error > 0, true);
  assert.equal(report.counts.warning > 0, true);
});

test("style-bound paint is not reported as a hardcoded fill", async () => {
  const { ctx, styled } = fixture();
  const report = await runAudit(ctx, { rules: ["hardcoded-fill"] });
  assert.ok(!report.findings.some((f) => f.nodeId === styled.id));
});

test("rules are opt-in: a contrast-only run reports only contrast", async () => {
  const { ctx } = fixture();
  const report = await runAudit(ctx, { rules: ["contrast"] });
  assert.ok(report.findings.length > 0);
  assert.ok(report.findings.every((f) => f.rule === "contrast"));
  assert.equal(report.byRule["hardcoded-fill"], undefined);
});

test("spacing and radius are opt-in and point at the property", async () => {
  const { ctx, hud } = fixture();
  hud.layoutMode = "VERTICAL";
  hud.itemSpacing = 7;
  hud.paddingTop = 10;
  hud.cornerRadius = 5;
  const report = await runAudit(ctx, { rules: ["spacing", "radius"] });
  const spacing = report.findings.filter((f) => f.rule === "spacing");
  assert.ok(spacing.some((f) => f.property === "itemSpacing" && f.value === 7));
  assert.ok(spacing.some((f) => f.property === "paddingTop" && f.value === 10));
  const item = spacing.find((f) => f.property === "itemSpacing" && f.value === 7);
  assert.ok(item);
  assert.equal(item.nearest, 8);
  assert.equal(item.delta, 1);
  assert.ok(report.findings.some((f) => f.rule === "radius" && f.value === 5 && f.nearest === 4));
});

test("hidden layers are skipped unless includeHidden is true", async () => {
  const { ctx, hidden } = fixture();
  const normal = await runAudit(ctx, { rules: ["hardcoded-fill"] });
  assert.ok(!normal.findings.some((f) => f.nodeId === hidden.id));
  const all = await runAudit(ctx, { rules: ["hardcoded-fill"], includeHidden: true });
  assert.ok(all.findings.some((f) => f.nodeId === hidden.id));
});

test("maxFindings truncates the list but not the counts", async () => {
  const { ctx } = fixture();
  const report = await runAudit(ctx, { maxFindings: 1 });
  assert.equal(report.findings.length, 1);
  assert.ok(report.findingsTruncated > 0);
  assert.ok(report.counts.total > 1);
  assert.ok(report.warnings.some((w) => w.includes("more findings")));
});

test("contrast composites a translucent overlay over the card behind it", async () => {
  const { ctx } = fixture();
  const card = node({ type: "FRAME", name: "Card", fills: [solid(0, 0, 0)] });
  const overlay = node({
    type: "FRAME", name: "Overlay", parent: card,
    fills: [{ ...solid(1, 1, 1), opacity: 0.5 }],
  });
  const label = node({
    type: "TEXT", name: "Label", parent: overlay,
    characters: "White",
    fills: [solid(1, 1, 1)],
  });
  card.children = [overlay];
  overlay.children = [label];
  ctx.currentPage.children = [card];

  const report = await runAudit(ctx, { rules: ["contrast"] });
  const finding = report.findings.find((f) => f.nodeId === label.id);
  assert.ok(finding, "expected a contrast finding");
  // White 50% over black is 50% gray, not white over white.
  assert.equal(finding.background, "#808080");
  assert.ok(finding.backgroundSource.includes(card.id), "the card is named as the background source");
  assert.equal(finding.ratio, 3.98);
});

test("contrast composites a translucent text fill before measuring it", async () => {
  const { ctx } = fixture();
  const card = node({ type: "FRAME", name: "Card", fills: [solid(0, 0, 0)] });
  const label = node({
    type: "TEXT", name: "Label", parent: card,
    characters: "Half white",
    fills: [{ ...solid(1, 1, 1), opacity: 0.3 }],
  });
  card.children = [label];
  ctx.currentPage.children = [card];

  const report = await runAudit(ctx, { rules: ["contrast"] });
  const finding = report.findings.find((f) => f.nodeId === label.id);
  assert.ok(finding, "30% white on black is not white on black");
  assert.equal(finding.foreground, "#4d4d4d");
  assert.equal(finding.foregroundOpacity, 0.3);
  assert.equal(finding.ratio, 2.46);
});

test("audit v2 suggests exact local paint styles and colour variables", async () => {
  const { ctx, hud } = fixture();
  ctx.getLocalPaintStylesAsync = async () => [
    { id: "S:brand", name: "Brand/White", paints: [solid(1, 1, 1)] },
  ];
  const collection = {
    id: "C:1",
    name: "Theme",
    modes: [{ modeId: "M:1", name: "Light" }, { modeId: "M:2", name: "Dark" }],
  };
  ctx.variables = {
    async getLocalVariableCollectionsAsync() { return [collection]; },
    async getLocalVariablesAsync() {
      return [{
        id: "V:1",
        name: "surface",
        resolvedType: "COLOR",
        variableCollectionId: "C:1",
        valuesByMode: {
          "M:1": { r: 1, g: 1, b: 1 },
          "M:2": { r: 0, g: 0, b: 0 },
        },
      }];
    },
  };
  const report = await runAudit(ctx, { rules: ["hardcoded-fill"] });
  const finding = report.findings.find((f) => f.nodeId === hud.id);
  assert.ok(finding);
  assert.equal(finding.suggestions.paintStyles[0].name, "Brand/White");
  assert.equal(finding.suggestions.colorVariables[0].name, "surface");
  assert.deepEqual(finding.suggestions.colorVariables[0].modes, ["Light"]);
  assert.equal(finding.suggestions.colorVariables[0].allModes, false);
  assert.ok(report.suggestions.paintStyles > 0);
  assert.ok(report.suggestions.colorVariables > 0);
});

test("audit v2 suggests an exact local text style", async () => {
  const { ctx, loose } = fixture();
  ctx.getLocalTextStylesAsync = async () => [
    { id: "T:body", name: "Body/16", fontName: { family: "Inter", style: "Regular" }, fontSize: 16 },
  ];
  const report = await runAudit(ctx, { rules: ["unstyled-text"] });
  const finding = report.findings.find((f) => f.nodeId === loose.id);
  assert.ok(finding);
  assert.equal(finding.suggestions.textStyles[0].name, "Body/16");
  assert.equal(report.suggestions.textStyles > 0, true);
});

test("empty text and hardcoded effects are opt-in findings", async () => {
  const { ctx, hud } = fixture();
  const empty = node({ type: "TEXT", name: "Empty", parent: hud, characters: "   " });
  const shadow = node({
    type: "FRAME", name: "Shadow", parent: hud,
    effects: [{ type: "DROP_SHADOW", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 0.2 }],
  });
  const styledShadow = node({
    type: "FRAME", name: "Styled shadow", parent: hud,
    effectStyleId: "E:1",
    effects: [{ type: "DROP_SHADOW", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 0.2 }],
  });
  hud.children.push(empty, shadow, styledShadow);
  const report = await runAudit(ctx, { rules: ["empty-text", "hardcoded-effect"] });
  assert.ok(report.findings.some((f) => f.rule === "empty-text" && f.nodeId === empty.id));
  assert.ok(report.findings.some((f) => f.rule === "hardcoded-effect" && f.nodeId === shadow.id));
  assert.ok(!report.findings.some((f) => f.nodeId === styledShadow.id));
});

test("suggest:false skips loading local styles", async () => {
  const { ctx } = fixture();
  let calls = 0;
  ctx.getLocalPaintStylesAsync = async () => { calls++; return []; };
  await runAudit(ctx, { rules: ["hardcoded-fill"], suggest: false });
  assert.equal(calls, 0);
});

test("an unknown rule is a refusal with the list of rules", async () => {
  const { ctx } = fixture();
  await assert.rejects(() => runAudit(ctx, { rules: ["nope"] }), /unknown audit rule/);
});
