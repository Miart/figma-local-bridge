import test from "node:test";
import assert from "node:assert/strict";
import { runDesignSystem } from "../plugin/design-system.mjs";
import { diffInventory } from "../server/dist/design-system.js";

function style(kind, id, name, extra = {}) {
  const base = { id, key: `key-${id}`, name, type: kind.toUpperCase(), description: "" };
  if (kind === "paint") base.paints = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }];
  if (kind === "text") {
    base.fontName = { family: "Inter", style: "Regular" };
    base.fontSize = 16;
    base.lineHeight = { unit: "AUTO" };
    base.letterSpacing = { unit: "PERCENT", value: 0 };
  }
  if (kind === "effect") base.effects = [];
  if (kind === "grid") base.layoutGrids = [];
  return { ...base, ...extra };
}

function fixture() {
  const collections = [{ id: "C:1", key: "kc1", name: "Color", modes: [{ modeId: "M:1", name: "Light" }], defaultModeId: "M:1" }];
  const variables = [
    { id: "V:1", key: "kv1", name: "brand/primary", variableCollectionId: "C:1", resolvedType: "COLOR", valuesByMode: { "M:1": { type: "VARIABLE_ALIAS", id: "V:2" } } },
    { id: "V:2", key: "kv2", name: "brand/red", variableCollectionId: "C:1", resolvedType: "COLOR", valuesByMode: { "M:1": { r: 1, g: 0, b: 0, a: 1 } } },
  ];
  const components = [
    {
      id: "1:1", key: "kcomp1", name: "Button", type: "COMPONENT_SET",
      description: "Primary action", parent: { name: "Components" },
      componentPropertyDefinitions: {
        State: { type: "VARIANT", defaultValue: "Default", variantOptions: ["Default", "Hover"] },
        Label: { type: "TEXT", defaultValue: "Go" },
      },
    },
    { id: "1:2", key: "kcomp2", name: "Icon", type: "COMPONENT", description: "", parent: { name: "Components" } },
  ];
  return {
    root: { name: "Design file", findAllWithCriteria: () => components },
    fileKey: "FILEKEY",
    getLocalPaintStylesAsync: async () => [style("paint", "S:1", "brand/primary")],
    getLocalTextStylesAsync: async () => [style("text", "S:2", "body/regular")],
    getLocalEffectStylesAsync: async () => [style("effect", "S:3", "shadow/card")],
    getLocalGridStylesAsync: async () => [style("grid", "S:4", "layout/12")],
    variables: { getLocalVariableCollectionsAsync: async () => collections, getLocalVariablesAsync: async () => variables },
  };
}

test("design-system inventory returns comparable styles, variables and components", async () => {
  const report = await runDesignSystem(fixture(), {});
  assert.equal(report.schema, "design-system-v1");
  assert.equal(report.counts.styles, 4);
  assert.equal(report.counts.variables, 2);
  assert.equal(report.counts.components, 2);
  assert.equal(report.file.key, "FILEKEY");
  assert.equal(report.styles[0].paints[0].color.r, 1);
  assert.equal(report.variables[0].collection, "Color");
  assert.equal(report.variables[0].valuesByMode["M:1"].id, "V:2");
  assert.equal(report.components[0].properties[0].name, "State");
  assert.deepEqual(report.components[0].properties[0].variantOptions, ["Default", "Hover"]);
});

test("design-system inventory honours include, cap and a bad section", async () => {
  const only = await runDesignSystem(fixture(), { include: ["variables"], maxItems: 1 });
  assert.equal(only.styles.length, 0);
  assert.equal(only.variables.length, 1);
  assert.equal(only.truncated, true);
  assert.ok(only.warnings[0].includes("cap 1"));
  await assert.rejects(() => runDesignSystem(fixture(), { include: ["nope"] }), /unknown design-system kind/);
});

function inventory(overrides = {}) {
  return {
    schema: "design-system-v1",
    styles: [
      { key: "s1", id: "1:1", type: "PAINT", name: "brand/primary", paints: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }] },
      { key: "s2", id: "1:2", type: "TEXT", name: "body", fontName: { family: "Inter", style: "Regular" } },
    ],
    variables: [
      { key: "v1", id: "2:1", name: "brand/primary", resolvedType: "COLOR", valuesByMode: { m1: { type: "VARIABLE_ALIAS", id: "2:9" } } },
    ],
    components: [
      { key: "c1", id: "3:1", type: "COMPONENT_SET", name: "Button", properties: [{ name: "State", type: "VARIANT", variantOptions: ["Default", "Hover"] }] },
    ],
    ...overrides,
  };
}

test("diff reports added, removed and changed by stable key", () => {
  const before = inventory();
  const after = inventory({
    styles: [
      { key: "s1", id: "9:1", type: "PAINT", name: "brand/primary", paints: [{ type: "SOLID", color: { r: 0, g: 0, b: 1 } }] },
      { key: "s3", id: "9:3", type: "EFFECT", name: "shadow" },
    ],
    variables: [
      { key: "v1", id: "9:4", name: "brand/primary", resolvedType: "COLOR", valuesByMode: { m1: { type: "VARIABLE_ALIAS", id: "2:10" } } },
    ],
    components: [
      { key: "c1", id: "9:5", type: "COMPONENT_SET", name: "Button", properties: [{ name: "State", type: "VARIANT", variantOptions: ["Default", "Pressed"] }] },
    ],
  });
  const diff = diffInventory(before, after);
  assert.equal(diff.counts.changed, 3);
  assert.equal(diff.counts.added, 1);
  assert.equal(diff.counts.removed, 1);
  assert.equal(diff.counts.unchanged, 0);
  assert.deepEqual(diff.sections.styles.added.map((x) => x.key), ["styles:s3"]);
  assert.deepEqual(diff.sections.styles.removed.map((x) => x.key), ["styles:s2"]);
  // A changed nested alias id is a value change, not a dropped id.
  assert.deepEqual(diff.sections.variables.changed[0].after.valuesByMode.m1.id, "2:10");
});

test("recreated ids alone are not a change, and maxDiff truncates", () => {
  const before = inventory();
  const after = inventory({
    styles: before.styles.map((s) => ({ ...s, id: "99:99" })),
    variables: before.variables.map((v) => ({ ...v, id: "99:98" })),
    components: before.components.map((c) => ({ ...c, id: "99:97" })),
  });
  const same = diffInventory(before, after);
  assert.equal(same.counts.changed, 0);
  assert.equal(same.counts.unchanged, 4);

  const many = inventory({ styles: Array.from({ length: 5 }, (_, i) => ({ key: `x${i}`, type: "PAINT", name: `p${i}` })) });
  const none = inventory({ styles: [] });
  const cut = diffInventory(none, many, 2);
  assert.equal(cut.sections.styles.added.length, 2);
  assert.equal(cut.counts.added, 5);
  assert.equal(cut.truncated, true);
});
