// Readback completeness: the two places `get_design_context` used to answer less
// than it knew.
//
//   1. STROKE WEIGHT. A node whose sides differ reported `weight: "mixed"`.
//      That says a property varies but not how — so a comparison against a
//      rebuilt node has to answer INCONCLUSIVE about something the plugin can
//      plainly see, and an agent ends up re-reading the node property by
//      property to find out. The four per-side weights are the answer.
//
//   2. PINNED VARIABLE MODES. A frame that pins a mode renders exactly like one
//      that inherits it. `explicitVariableModes` is the only place that
//      difference exists, and without it "why does this frame look different
//      after I wrapped it" is unanswerable from the readback.
//
// Driven against a mock `figma`: fullNode only needs property reads, and there
// is no other way to test the plugin sandbox from node.

import { test } from "node:test";
import assert from "node:assert/strict";

const MIXED = Symbol("figma.mixed");

/** The smallest figma get_design_context touches. */
function mockFigma(node, collections) {
  return {
    mixed: MIXED,
    currentPage: { id: "0:1", name: "Page 1", type: "PAGE", children: [node], selection: [] },
    getNodeByIdAsync: async (id) => (id === node.id ? node : null),
    variables: {
      getVariableCollectionByIdAsync: async (id) => {
        const c = collections[id];
        if (c === undefined) throw new Error("not found: " + id);
        return c;
      },
    },
  };
}

const solid = (r, g, b) => ({ type: "SOLID", color: { r, g, b }, opacity: 1, visible: true });

test("a mixed stroke weight is reported per side, not as \"mixed\"", async () => {
  const node = {
    id: "1:1", type: "FRAME", name: "Card",
    x: 10, y: 20, width: 100, height: 50, rotation: 0,
    layoutMode: "NONE", clipsContent: false,
    fills: [solid(1, 1, 1)],
    strokes: [solid(0, 0, 0)],
    strokeWeight: MIXED,
    strokeTopWeight: 4,
    strokeRightWeight: 1,
    strokeBottomWeight: 4,
    strokeLeftWeight: 1,
    strokeAlign: "INSIDE",
    effects: [],
    children: [],
  };
  globalThis.figma = mockFigma(node, {});

  const { toolMethods } = await import("../plugin/tools.mjs");
  const out = await toolMethods.get_design_context({ nodeId: "1:1" });

  assert.deepEqual(out.tree.stroke.weight, [4, 1, 4, 1],
    "top, right, bottom, left — the shape cornerRadius already uses");
  assert.equal(out.tree.stroke.align, "INSIDE", "the rest of the stroke readback is unchanged");
});

test("a uniform stroke weight still reads as a number", async () => {
  const node = {
    id: "1:2", type: "FRAME", name: "Plain",
    x: 0, y: 0, width: 10, height: 10, rotation: 0,
    layoutMode: "NONE", clipsContent: false,
    fills: [], strokes: [solid(0, 0, 0)],
    strokeWeight: 2,
    strokeAlign: "CENTER",
    effects: [], children: [],
  };
  globalThis.figma = mockFigma(node, {});

  const { toolMethods } = await import("../plugin/tools.mjs");
  const out = await toolMethods.get_design_context({ nodeId: "1:2" });
  assert.equal(out.tree.stroke.weight, 2);
});

test("pinned variable modes are named; inherited ones stay invisible", async () => {
  const node = {
    id: "1:3", type: "FRAME", name: "Themed",
    x: 0, y: 0, width: 10, height: 10, rotation: 0,
    layoutMode: "NONE", clipsContent: false,
    fills: [], strokes: [], effects: [], children: [],
    explicitVariableModes: { "VariableCollectionId:1:2": "1:1" },
  };
  globalThis.figma = mockFigma(node, {
    "VariableCollectionId:1:2": { name: "Theme", modes: [{ modeId: "1:1", name: "Dark" }] },
  });

  const { toolMethods } = await import("../plugin/tools.mjs");
  const out = await toolMethods.get_design_context({ nodeId: "1:3" });
  assert.deepEqual(out.tree.explicitModes, { Theme: "Dark" });
});

test("a mode whose collection is not loaded keeps its ids", async () => {
  const node = {
    id: "1:4", type: "FRAME", name: "Orphan",
    x: 0, y: 0, width: 10, height: 10, rotation: 0,
    layoutMode: "NONE", clipsContent: false,
    fills: [], strokes: [], effects: [], children: [],
    explicitVariableModes: { "VariableCollectionId:9:9": "9:8" },
  };
  globalThis.figma = mockFigma(node, {});

  const { toolMethods } = await import("../plugin/tools.mjs");
  const out = await toolMethods.get_design_context({ nodeId: "1:4" });
  assert.deepEqual(out.tree.explicitModes, { "VariableCollectionId:9:9": "9:8" },
    "a library collection that is not loaded must not drop the fact");
});

test("a node that pins nothing carries no explicitModes field", async () => {
  const node = {
    id: "1:5", type: "FRAME", name: "Bare",
    x: 0, y: 0, width: 10, height: 10, rotation: 0,
    layoutMode: "NONE", clipsContent: false,
    fills: [], strokes: [], effects: [], children: [],
  };
  globalThis.figma = mockFigma(node, {});

  const { toolMethods } = await import("../plugin/tools.mjs");
  const out = await toolMethods.get_design_context({ nodeId: "1:5" });
  assert.equal("explicitModes" in out.tree, false, "empty means absent, not {}");
});
