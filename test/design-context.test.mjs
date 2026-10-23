import test from "node:test";
import assert from "node:assert/strict";

/**
 * `get_design_context` resolves names for styles and pinned variable modes per
 * node. The lookups are cached for the call because a file repeats the same
 * style/collection on many layers — but a mode cache must be keyed by
 * collection AND mode. Keying it by collection alone made a second layer pinned
 * to Dark read the first layer's Light name, which is exactly the sort of
 * "looks like data" failure this file exists to catch.
 */

test("design context resolves each collection mode independently and caches repeats", async () => {
  let collectionReads = 0;
  const collection = {
    id: "c1",
    name: "Theme",
    modes: [
      { modeId: "m1", name: "Light" },
      { modeId: "m2", name: "Dark" },
    ],
  };
  const makeNode = (id, name, explicitVariableModes, children = []) => ({
    id,
    type: "FRAME",
    name,
    width: 10,
    height: 10,
    x: 0,
    y: 0,
    visible: true,
    children,
    parent: null,
    explicitVariableModes,
  });
  const child = makeNode("2", "Child", { c1: "m2" });
  const parent = makeNode("1", "Parent", { c1: "m1" }, [child]);
  child.parent = parent;

  globalThis.figma = {
    mixed: Symbol("mixed"),
    currentPage: { id: "0:1", name: "Page", selection: [] },
    getNodeByIdAsync: async (id) => (id === parent.id ? parent : null),
    variables: {
      getVariableCollectionByIdAsync: async (id) => {
        collectionReads++;
        assert.equal(id, "c1");
        return collection;
      },
    },
  };

  const { toolMethods } = await import("../plugin/tools.mjs");
  const result = await toolMethods.get_design_context({ nodeId: "1" });
  assert.equal(result.tree.explicitModes.Theme, "Light");
  assert.equal(result.tree.children[0].explicitModes.Theme, "Dark");
  assert.equal(collectionReads, 2, "two distinct modes need two lookups; a third repeat would reuse one");
});

test("design context resolves a repeated style once", async () => {
  let styleReads = 0;
  const makeNode = (id, name, children = []) => ({
    id,
    type: "FRAME",
    name,
    width: 10,
    height: 10,
    x: 0,
    y: 0,
    visible: true,
    children,
    parent: null,
    fillStyleId: "S:1",
  });
  const child = makeNode("2", "Child");
  const parent = makeNode("1", "Parent", [child]);
  child.parent = parent;

  globalThis.figma = {
    mixed: Symbol("mixed"),
    currentPage: { id: "0:1", name: "Page", selection: [] },
    getNodeByIdAsync: async (id) => (id === parent.id ? parent : null),
    getStyleByIdAsync: async (id) => {
      styleReads++;
      assert.equal(id, "S:1");
      return { id, name: "brand/primary" };
    },
  };

  const { toolMethods } = await import("../plugin/tools.mjs");
  const result = await toolMethods.get_design_context({ nodeId: "1" });
  assert.equal(result.tree.styles.fill, "brand/primary");
  assert.equal(result.tree.children[0].styles.fill, "brand/primary");
  assert.equal(styleReads, 1, "the same style id is resolved once per call, not once per layer");
});
