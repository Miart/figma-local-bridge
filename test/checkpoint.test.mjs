// Unit tests for the checkpoint module — the thing that DELETES a subtree's
// children and rebuilds them. No Figma: fixtures plus a stub API, driving the
// shipped artifact (plugin/checkpoint.mjs, built from checkpoint.ts).
//
// The interesting assertions are the refusals and the losses. A rebuild that
// quietly drops the nodes it cannot produce would be worse than no checkpoint at
// all, so every "we cannot do this" path is pinned here.
import {
  DUMP_SCHEMA, LIMITATIONS, dumpSubtree, restoreSubtree, collectUnsupported, countNodes,
} from "../plugin/checkpoint.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; process.stdout.write(`PASS  ${name}\n`); }
  else { fail++; process.stdout.write(`FAIL  ${name}${detail ? "  — " + detail : ""}\n`); }
};

// ---------------------------------------------------------------- fixtures

let seq = 0;
const nextId = () => `${++seq}:${seq}`;

const COMMON = () => ({
  x: 0, y: 0, width: 100, height: 100, rotation: 0,
  opacity: 1, blendMode: "NORMAL", visible: true, locked: false,
  fillStyleId: "", strokeStyleId: "", effectStyleId: "", textStyleId: "",
  fills: [], strokes: [], strokeWeight: 1, strokeAlign: "INSIDE",
  strokeCap: "NONE", strokeJoin: "MITER", dashPattern: [],
  cornerRadius: 0, effects: [],
  boundVariables: undefined, explicitVariableModes: {},
  constraints: { horizontal: "MIN", vertical: "MIN" },
  absoluteBoundingBox: null, relativeTransform: [[1, 0, 0], [0, 1, 0]],
  removed: false,
});

const BY_TYPE = (t) => {
  if (t === "FRAME" || t === "COMPONENT" || t === "SECTION" || t === "GROUP") {
    return {
      children: [],
      clipsContent: false,
      layoutMode: "NONE", paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
      itemSpacing: 0, primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN",
      primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED",
      layoutWrap: "NO_WRAP", counterAxisSpacing: null,
      strokesIncludedInLayout: false, itemReverseZIndex: false,
      layoutGrids: [],
      layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED", layoutAlign: "INHERIT",
      layoutGrow: 0, layoutPositioning: "AUTO",
      minWidth: null, minHeight: null, maxWidth: null, maxHeight: null,
    };
  }
  if (t === "TEXT") {
    return {
      characters: "hello",
      fontName: { family: "Inter", style: "Regular" },
      fontSize: 12,
      lineHeight: { unit: "AUTO" },
      letterSpacing: { unit: "PERCENT", value: 0 },
      textAlignHorizontal: "LEFT", textAlignVertical: "TOP",
      textAutoResize: "NONE", textCase: "ORIGINAL", textDecoration: "NONE",
      paragraphSpacing: 0, paragraphIndent: 0,
      layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED", layoutAlign: "INHERIT",
      layoutGrow: 0, layoutPositioning: "AUTO",
      minWidth: null, minHeight: null, maxWidth: null, maxHeight: null,
      getStyledTextSegments: () => [{ characters: "hello" }],
    };
  }
  if (t === "ELLIPSE") return { arcData: { startingAngle: 0, endingAngle: 6.283, innerRadius: 0 } };
  if (t === "VECTOR") {
    return {
      vectorNetwork: {
        vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
        segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }],
        regions: [{ windingRule: "NONZERO", loops: [[0, 1]] }],
      },
      windingRule: "NONZERO",
      setVectorNetworkAsync(net) { this.vectorNetwork = net; },
      layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED", layoutAlign: "INHERIT",
      layoutGrow: 0, layoutPositioning: "AUTO",
      minWidth: null, minHeight: null, maxWidth: null, maxHeight: null,
    };
  }
  if (t === "INSTANCE") {
    return {
      children: [],
      _main: null,
      getMainComponentAsync: async function () { return this._main; },
      componentProperties: {},
      setProperties(props) {
        for (const k of Object.keys(props)) if (!(k in this.componentProperties)) throw new Error(`unknown property ${k}`);
        this._applied = { ...(this._applied || {}), ...props };
      },
      layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED", layoutAlign: "INHERIT",
      layoutGrow: 0, layoutPositioning: "AUTO",
      minWidth: null, minHeight: null, maxWidth: null, maxHeight: null,
    };
  }
  return {
    layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED", layoutAlign: "INHERIT",
    layoutGrow: 0, layoutPositioning: "AUTO",
    minWidth: null, minHeight: null, maxWidth: null, maxHeight: null,
  };
};

/** A node that carries what checkpoint.ts reads, and behaves like the API where the tests look. */
function node(type, props = {}) {
  const n = {
    ...COMMON(),
    ...BY_TYPE(type),
    type,
    name: props.name ?? type,
    id: props.id ?? nextId(),
    parent: null,
    resizes: 0,
    resize(w, h) { this.resizes++; this.width = w; this.height = h; },
    setBoundVariable(field, variable) {
      if (this.bindingRejects === field) throw new Error(`field ${field} cannot be bound on this node`);
      if (!variable || typeof variable.id !== "string") throw new Error("setBoundVariable needs a Variable object");
      this.boundVariables = { ...(this.boundVariables ?? {}), [field]: { type: "VARIABLE_ALIAS", id: variable.id } };
    },
    setExplicitVariableModeForCollection(collection, modeId) {
      if (!collection || typeof collection !== "object" || !Array.isArray(collection.modes)) {
        throw new Error("setExplicitVariableModeForCollection needs a VariableCollection object");
      }
      if (!collection.modes.some((m) => m.modeId === modeId)) throw new Error(`collection has no mode ${modeId}`);
      this.explicitVariableModes = { ...(this.explicitVariableModes ?? {}), [collection.id]: modeId };
    },
    appendChild(child) {
      if (child.parent) child.parent.children = child.parent.children.filter((c) => c !== child);
      child.parent = this;
      this.children.push(child);
      return child;
    },
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
      this.parent = null;
      this.removed = true;
    },
    ...props,
  };
  for (const c of n.children ?? []) c.parent = n;
  n.absoluteBoundingBox = n.absoluteBoundingBox ?? { x: n.x, y: n.y, width: n.width, height: n.height };
  if (type === "COMPONENT") {
    // The API's own shape: an instance carries its main component's properties,
    // and setProperties refuses a name the component does not have.
    n.createInstance = () => node("INSTANCE", { _main: n, componentProperties: JSON.parse(JSON.stringify(n._defaults ?? {})) });
  }
  return n;
}

/** A target's children are the fixture's children: same shape as the API. */
const withChildren = (parent, kids) => kids.forEach((k) => parent.appendChild(k));

function fakeFigma(registry = [], options = {}) {
  const made = [];
  const track = (n) => { made.push(n); registry.push(n); return n; };
  return {
    made,
    variables: {
      async getVariableByIdAsync(id) { return (options.variables ?? []).find((v) => v.id === id) ?? null; },
      async getVariableCollectionByIdAsync(id) { return (options.collections ?? []).find((c) => c.id === id) ?? null; },
    },
    createFrame: () => track(node("FRAME")),
    createComponent: () => track(node("COMPONENT")),
    createSection: () => track(node("SECTION")),
    createRectangle: () => track(node("RECTANGLE")),
    createEllipse: () => track(node("ELLIPSE")),
    createLine: () => track(node("LINE")),
    createText: () => track(node("TEXT")),
    createVector: () => track(node("VECTOR")),
    group(nodes, parent) {
      const g = track(node("GROUP"));
      nodes.forEach((n) => g.appendChild(n));
      parent.appendChild(g);
      return g;
    },
    async getNodeByIdAsync(id) { return registry.find((n) => n.id === id) ?? null; },
    async importComponentByKeyAsync(key) { return registry.find((n) => n.type === "COMPONENT" && n.key === key) ?? null; },
  };
}

const ctxFor = (figma, target, over = {}) => ({
  figma, target,
  mark: over.mark ?? (() => { over.marks = (over.marks ?? 0) + 1; }),
  loadFont: over.loadFont ?? (async () => {}),
  ...over,
});

const errors = async (fn) => {
  try { await fn(); return null; } catch (e) { return String(e.message ?? e); }
};

// ---------------------------------------------------------------- the dump

{
  const rect = node("RECTANGLE", {
    name: "Splash",
    x: 10, y: 20, width: 64, height: 48,
    rotation: 15,
    opacity: 0.5,
    blendMode: "MULTIPLY",
    fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: 1 }],
    strokes: [{ type: "GRADIENT_LINEAR", gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: [{ position: 0, color: { r: 0, g: 0, b: 0, a: 1 } }] }],
    strokeWeight: 3,
    strokeAlign: "OUTSIDE",
    dashPattern: [4, 2],
    cornerRadius: 8,
    effects: [{ type: "DROP_SHADOW", radius: 4, color: { r: 0, g: 0, b: 0, a: 0.2 }, offset: { x: 1, y: 2 }, visible: true }],
    isMask: true, maskType: "LUMINANCE",
  });

  const { root, nodes, truncated, unsupported } = await dumpSubtree(rect);

  check("dump: schema fields around one node", DUMP_SCHEMA === "checkpoint-v1" && nodes === 1 && !truncated && unsupported.length === 0);
  check("dump: geometry and identity", root.type === "RECTANGLE" && root.name === "Splash" && root.state.pos[0] === 10 && root.state.size[1] === 48);
  check("dump: rotation, opacity and blend are real state", root.state.rotation === 15 && root.state.opacity === 0.5 && root.state.blendMode === "MULTIPLY");
  check("dump: a gradient stroke survives verbatim", root.state.strokes[0].type === "GRADIENT_LINEAR" && root.state.strokes[0].gradientStops[0].position === 0);
  check("dump: stroke details travel together", root.state.strokeWeight === 3 && root.state.strokeAlign === "OUTSIDE" && root.state.dashPattern[0] === 4);
  check("dump: a mask is not a detail to lose", root.state.isMask === true && root.state.maskType === "LUMINANCE");
  check("dump: effects are copied", root.state.effects[0].type === "DROP_SHADOW" && root.state.effects[0].spread === undefined);
  check("dump: the fixture is not mutated by the copy", rect.fills[0].color.r === 1 && root.state.fills !== rect.fills);
}

{
  // A mixed field means "the API refuses to name one value". Writing a guess
  // would flatten the difference, so it is recorded as the string "mixed".
  const t = node("TEXT", { fills: Symbol("mixed"), strokeWeight: Symbol("mixed"), fontName: Symbol("mixed") });
  const { root } = await dumpSubtree(t);
  check("dump: mixed fills and strokes are recorded, not guessed", root.state.fills === "mixed" && root.state.strokeWeight === "mixed");
  check("dump: mixed font is recorded", root.state.text.font === "mixed");
}

{
  // Per-run styling cannot be rebuilt, so the run COUNT is state: a loss has to
  // show up in a comparison instead of passing as equivalent.
  const t = node("TEXT", {
    characters: "AB",
    getStyledTextSegments: () => [{ characters: "A" }, { characters: "B" }],
  });
  const { root } = await dumpSubtree(t);
  check("dump: a mixed-run text records its run count", root.state.text.runs === 2);
  const plain = node("TEXT");
  check("dump: uniform text records no run count", (await dumpSubtree(plain)).root.state.text.runs === undefined);
}

{
  const frame = node("FRAME", {
    name: "Card",
    layoutMode: "VERTICAL",
    primaryAxisSizingMode: "AUTO",
    counterAxisSizingMode: "FIXED",
    paddingTop: 8, paddingRight: 4, paddingBottom: 8, paddingLeft: 4,
    itemSpacing: 6,
    primaryAxisAlignItems: "CENTER",
    counterAxisAlignItems: "MAX",
    clipsContent: true,
  });
  const { root } = await dumpSubtree(frame);
  const L = root.state.layout;
  check("dump: auto layout is captured field by field",
    L.mode === "VERTICAL" && L.primary === "AUTO" && L.counter === "FIXED" && L.gap === 6 &&
    L.padding.join(",") === "8,4,8,4" && L.primaryAlign === "CENTER" && L.counterAlign === "MAX");
  check("dump: clipping is state", root.state.clipsContent === true);
  check("dump: an empty layout grid list is omitted, so old checkpoints still compare", root.state.layoutGrids === undefined);
}

{
  const frame = node("FRAME", {
    boundVariables: {
      width: { type: "VARIABLE_ALIAS", id: "VariableID:1:2" },
      fills: [{ type: "VARIABLE_ALIAS", id: "VariableID:1:3" }],
    },
    explicitVariableModes: { "VariableCollectionId:1:1": "1:0" },
  });
  const { root } = await dumpSubtree(frame);
  check("dump: node-level variable aliases travel in meta",
    root.meta.bindings.join(",") === "width,fills" &&
    root.meta.variableBindings.width.id === "VariableID:1:2" &&
    root.meta.variableBindings.fills[0].id === "VariableID:1:3");
  check("dump: explicit variable modes travel in meta",
    root.meta.variableModes["VariableCollectionId:1:1"] === "1:0");
}

{
  const main = node("COMPONENT", { name: "Button/Primary", key: "COMPKEY", id: "9:9" });
  const inst = node("INSTANCE", {
    name: "Button/Primary instance",
    _main: main,
    componentProperties: { "Show icon#1:2": { type: "BOOLEAN", value: true }, Label: { type: "TEXT", value: "Play" } },
  });
  const { root } = await dumpSubtree(inst);
  const i = root.state.instance;
  check("dump: an instance records the identity of its main component",
    i.componentId === "9:9" && i.componentKey === "COMPKEY" && i.componentName === "Button/Primary");
  check("dump: component property values are state",
    i.properties["Show icon#1:2"] === true && i.properties.Label === "Play");
  check("dump: an instance's interior is not walked", root.children === undefined);
}

{
  const frame = node("FRAME");
  withChildren(frame, [
    node("RECTANGLE", { name: "keep" }),
    node("BOOLEAN_OPERATION", { name: "Union", children: [node("ELLIPSE", { name: "dot" })] }),
  ]);
  const { root, unsupported } = await dumpSubtree(frame);
  check("dump: an unsupported node is named, not skipped silently",
    unsupported.length === 1 && unsupported[0].type === "BOOLEAN_OPERATION" && unsupported[0].path === "$.children[1]");
  check("dump: its reason names the operation", /does not expose its inputs/.test(unsupported[0].why));
  check("dump: its interior is not walked", root.children[1].children === undefined);
  check("dump: collectUnsupported can exclude the root",
    collectUnsupported(root, true).length === 1 && collectUnsupported(root, false).length === 1);
}

{
  const frame = node("FRAME");
  withChildren(frame, [node("RECTANGLE"), node("RECTANGLE"), node("RECTANGLE")]);
  const { nodes, truncated, root } = await dumpSubtree(frame, { maxNodes: 2 });
  check("dump: the node cap truncates and SAYS so", truncated === true && nodes === 2 && root.children.length === 1);
  const deep = await dumpSubtree(frame, { maxDepth: 0 });
  check("dump: the depth cap truncates too", deep.truncated === false && deep.root.children === undefined);
}

// ---------------------------------------------------------------- restore: refusals

{
  const figma = fakeFigma();
  const target = node("FRAME", { name: "Card" });
  const dump = (await dumpSubtree(node("FRAME", { name: "Card" }))).root;

  const noTarget = await errors(() => restoreSubtree(dump, { figma, target: null }));
  check("restore: a missing target is refused", /no target/.test(noTarget));

  const group = await errors(() => restoreSubtree(dump, { figma, target: node("GROUP") }));
  check("restore: a GROUP target is refused, with the reason", /last child deletes the group/.test(group));

  const inst = await errors(() => restoreSubtree(dump, { figma, target: node("INSTANCE") }));
  check("restore: an INSTANCE target is refused", /belong to the main component/.test(inst));

  const leaf = await errors(() => restoreSubtree(dump, { figma, target: node("RECTANGLE") }));
  check("restore: a leaf target is refused", /cannot hold children/.test(leaf));

  const truncated = await errors(() => restoreSubtree(dump, { figma, target }, { truncated: true }));
  check("restore: a truncated dump is refused before anything is touched",
    /truncated/.test(truncated) && target.children.length === 0);
}

{
  const figma = fakeFigma();
  const target = node("FRAME");
  withChildren(target, [node("RECTANGLE", { name: "old" })]);
  const frame = node("FRAME", { name: "Card" });
  withChildren(frame, [node("BOOLEAN_OPERATION", { name: "Union" }), node("RECTANGLE", { name: "kept" })]);
  const { root } = await dumpSubtree(frame);

  const refused = await errors(() => restoreSubtree(root, { figma, target }, {}));
  check("restore: unsupported nodes refuse the whole restore by default",
    /cannot rebuild 1 node/.test(refused) && target.children[0].name === "old" && figma.made.length === 0);
}

// ---------------------------------------------------------------- restore: dry run

{
  const figma = fakeFigma();
  const target = node("FRAME", { name: "Card" });
  withChildren(target, [node("RECTANGLE", { name: "old A" }), node("TEXT", { name: "old B" })]);
  const frame = node("FRAME", { name: "Card" });
  withChildren(frame, [node("RECTANGLE", { name: "new A" }), node("ELLIPSE", { name: "new B" }), node("GROUP", { name: "g", children: [node("RECTANGLE")] })]);
  const { root } = await dumpSubtree(frame);

  let marked = 0;
  const report = await restoreSubtree(root, ctxFor(figma, target, { mark: () => { marked++; } }), { dryRun: true });
  check("dry run: nothing is written", figma.made.length === 0 && target.children.length === 2 && marked === 0);
  check("dry run: it names what would be deleted", report.wouldRemove.map((n) => n.name).join(",") === "old A,old B");
  check("dry run: it counts the nodes it would create", report.created === 4 && report.removed === 2);
  check("dry run: it says it was a dry run", report.dryRun === true);
}

// ---------------------------------------------------------------- restore: the wet path

{
  const figma = fakeFigma();
  const target = node("FRAME", { name: "Card" });
  withChildren(target, [node("RECTANGLE", { name: "old" })]);
  const src = node("FRAME", {
    name: "Card",
    layoutMode: "HORIZONTAL",
    itemSpacing: 12,
    paddingTop: 4, paddingRight: 4, paddingBottom: 4, paddingLeft: 4,
    clipsContent: true,
    fills: [{ type: "SOLID", color: { r: 0.1, g: 0.2, b: 0.3 } }],
    layoutGrids: [{ pattern: "COLUMNS", visible: true, color: { r: 1, g: 0, b: 0, a: 0.1 }, alignment: "MIN", gutterSize: 8, offset: 0, count: 3, sectionSize: 96 }],
  });
  withChildren(src, [
    node("RECTANGLE", { name: "bg", x: 1, y: 2, width: 30, height: 20, cornerRadius: 4, fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }] }),
    node("TEXT", { name: "label", characters: "PLAY", fontSize: 18, width: 40, height: 12 }),
    node("GROUP", { name: "cluster", x: 50, y: 60, children: [node("ELLIPSE", { name: "dot", x: 3, y: 4, width: 8, height: 8 })] }),
  ]);
  const { root } = await dumpSubtree(src);

  let marks = 0;
  const report = await restoreSubtree(root, ctxFor(figma, target, { mark: () => { marks++; } }), {});
  check("restore: the old children are gone and the new ones exist",
    target.children.map((c) => c.name).join(",") === "bg,label,cluster" && report.removed === 1 && report.created === 4);
  check("restore: mark() is called exactly once, before the writes", marks === 1);
  check("restore: the root's own state is re-applied", target.itemSpacing === 12 && target.layoutMode === "HORIZONTAL" && target.clipsContent === true);
  check("restore: the root keeps its position", target.x === 0 && target.y === 0);
  check("restore: leaves are positioned", target.children[0].x === 1 && target.children[0].y === 2);
  check("restore: fills come back", target.children[0].fills[0].color.r === 1 && target.fills[0].color.b === 0.3);
  check("restore: layout grids come back", target.layoutGrids[0].count === 3 && target.layoutGrids[0].sectionSize === 96);
  check("restore: a group is rebuilt as a group, moved to where it was",
    target.children[2].type === "GROUP" && target.children[2].x === 50 && target.children[2].y === 60 &&
    target.children[2].children[0].type === "ELLIPSE");
  check("restore: text characters and size are set", target.children[1].characters === "PLAY" && target.children[1].fontSize === 18);
  const round = await dumpSubtree(target);
  const strip = (n) => ({ type: n.type, name: n.name, state: dropVolatile(n.state), children: (n.children ?? []).map(strip) });
  const dropVolatile = (s) => {
    const { runs, ...rest } = s;
    return rest;
  };
  check("restore: dump -> restore -> dump is field-identical",
    JSON.stringify(strip(round.root)) === JSON.stringify(strip(root)),
    JSON.stringify(strip(round.root)) + "\nvs\n" + JSON.stringify(strip(root)));
}

{
  // A HUG axis belongs to the layout engine. Resizing it would fight the owner
  // and the comparison afterwards would report our own change as a difference.
  const figma = fakeFigma();
  const target = node("FRAME");
  const src = node("FRAME", { layoutMode: "VERTICAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED", width: 90, height: 200 });
  const { root } = await dumpSubtree(src);
  await restoreSubtree(root, ctxFor(figma, target), {});
  check("restore: a HUG frame is not resized (its size belongs to the layout)", target.resizes === 0);

  const figma2 = fakeFigma();
  const t2 = node("FRAME");
  const auto = node("TEXT", { textAutoResize: "WIDTH_AND_HEIGHT", width: 12, height: 9 });
  const { root: r2 } = await dumpSubtree(node("FRAME", { children: [auto] }));
  await restoreSubtree(r2, ctxFor(figma2, t2), {});
  check("restore: auto-resizing text is not resized", t2.children[0].resizes === 0);

  const figma3 = fakeFigma();
  const t3 = node("FRAME");
  const fixed = node("RECTANGLE", { width: 64, height: 32 });
  const { root: r3 } = await dumpSubtree(node("FRAME", { children: [fixed] }));
  await restoreSubtree(r3, ctxFor(figma3, t3), {});
  check("restore: everything else IS resized", t3.children[0].resizes === 1 && t3.children[0].width === 64);
}

{
  const figma = fakeFigma();
  const target = node("FRAME");
  const src = node("FRAME", { children: [node("VECTOR", { name: "chevron" })] });
  const { root } = await dumpSubtree(src);
  await restoreSubtree(root, ctxFor(figma, target), {});
  const v = target.children[0];
  check("restore: a vector gets its network back",
    v.vectorNetwork.vertices.length === 3 && v.vectorNetwork.regions[0].windingRule === "NONZERO" && v.windingRule === "NONZERO");
}

// ---------------------------------------------------------------- restore: the losses, named

{
  const figma = fakeFigma();
  const target = node("FRAME");
  const src = node("FRAME");
  withChildren(src, [node("BOOLEAN_OPERATION", { name: "Union" }), node("RECTANGLE", { name: "kept" })]);
  const { root } = await dumpSubtree(src);

  const report = await restoreSubtree(root, ctxFor(figma, target), { allowPartial: true });
  check("allowPartial: the rest is rebuilt and the loss is listed",
    target.children.map((c) => c.name).join(",") === "kept" &&
    report.skipped.length === 1 && report.skipped[0].type === "BOOLEAN_OPERATION" && report.created === 1);
}

{
  const figma = fakeFigma();
  const target = node("FRAME");
  const src = node("FRAME", { children: [node("TEXT", { name: "title", characters: "PLAY", fontName: { family: "Space Grotesk", style: "Bold" } })] });
  const { root } = await dumpSubtree(src);
  const report = await restoreSubtree(root, ctxFor(figma, target, {
    loadFont: async (f) => { if (f.family === "Space Grotesk") throw new Error("not available"); },
  }), {});
  check("fonts: a font that will not load is named, and the text still comes back",
    report.fontsUnavailable.join(",") === "Space Grotesk Bold" && target.children[0].characters === "PLAY");
  check("fonts: the note says which font was used instead", /Inter Regular/.test(report.notes.join(" ")));
}

{
  // A paint carrying a variable binding fails to apply when the variable is not
  // available in the file. Dropping the paint would lose a colour; the retry
  // drops the binding instead, and says so.
  const figma = fakeFigma();
  const target = node("FRAME");
  const src = node("FRAME", { children: [node("RECTANGLE", { name: "bg" })] });
  const { root } = await dumpSubtree(src);
  const bound = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, boundVariables: { color: { type: "VARIABLE_ALIAS", id: "VariableID:1:2" } } }];
  root.children[0].state.fills = bound;

  const guard = {
    ...figma,
    createRectangle() {
      const n = node("RECTANGLE");
      let fills = [];
      Object.defineProperty(n, "fills", {
        get: () => fills,
        set: (v) => {
          if (Array.isArray(v) && v.some((p) => p && p.boundVariables)) throw new Error("variable not found in this file");
          fills = v;
        },
      });
      figma.made.push(n);
      return n;
    },
  };

  const report = await restoreSubtree(root, ctxFor(guard, target), {});
  check("bindings: the paint comes back by value and the dropped binding is reported",
    target.children[0].fills[0].color.r === 1 && report.bindingsDropped.join(",") === "$.children[0].state.fills");
}

{
  const figma = fakeFigma([], { variables: [{ id: "VariableID:1:2", name: "color/bg", resolvedType: "COLOR" }] });
  const target = node("FRAME");
  const src = node("FRAME", { children: [node("RECTANGLE", { name: "bg" })] });
  const { root } = await dumpSubtree(src);
  root.children[0].state.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, boundVariables: { color: { type: "VARIABLE_ALIAS", id: "VariableID:1:2" } } }];

  const guard = {
    ...figma,
    createRectangle() {
      const n = node("RECTANGLE");
      let fills = [];
      Object.defineProperty(n, "fills", {
        get: () => fills,
        set: (v) => {
          const missing = Array.isArray(v) && v.some((p) => p?.boundVariables && p.boundVariables.color?.id !== "VariableID:1:2");
          if (missing) throw new Error("variable not found in this file");
          fills = v;
        },
      });
      figma.made.push(n);
      return n;
    },
  };

  const report = await restoreSubtree(root, ctxFor(guard, target), {});
  check("bindings: a paint binding whose variable exists comes back linked",
    target.children[0].fills[0].boundVariables.color.id === "VariableID:1:2" && report.bindingsDropped.length === 0);
}

{
  // Node-level bindings are not paint values: they live in meta, are re-linked
  // by id, and a missing variable leaves the recorded value in place.
  const widthVar = { id: "VariableID:1:2", name: "size/card", resolvedType: "FLOAT" };
  const collection = { id: "VariableCollectionId:1:1", name: "Theme", modes: [{ modeId: "1:0", name: "Light" }] };
  const figma = fakeFigma([], { variables: [widthVar], collections: [collection] });
  const target = node("FRAME");
  const src = node("FRAME", {
    explicitVariableModes: { [collection.id]: "1:0" },
    children: [node("RECTANGLE", {
      name: "card", width: 120, height: 40,
      boundVariables: {
        width: { type: "VARIABLE_ALIAS", id: widthVar.id },
        opacity: { type: "VARIABLE_ALIAS", id: "VariableID:9:9" },
      },
    })],
  });
  const { root } = await dumpSubtree(src);
  const report = await restoreSubtree(root, ctxFor(figma, target), {});

  check("restore: an explicit mode is re-applied by collection",
    target.explicitVariableModes[collection.id] === "1:0" &&
    report.modesRestored.length === 1 && report.modesRestored[0].modeName === "Light");
  check("restore: a node-level binding is re-applied by id",
    target.children[0].boundVariables.width.id === widthVar.id &&
    report.bindingsRestored.some((b) => b.field === "width" && b.name === "size/card"));
  check("restore: a missing variable is named, and its value stays",
    target.children[0].width === 120 &&
    report.bindingsMissing.some((b) => b.field === "opacity" && /no longer exists/.test(b.why)));
}

{
  const a = { id: "VariableID:1:2", name: "font/a", resolvedType: "FLOAT" };
  const b = { id: "VariableID:1:3", name: "font/b", resolvedType: "FLOAT" };
  const figma = fakeFigma([], { variables: [a, b] });
  const target = node("FRAME");
  const src = node("FRAME", {
    children: [node("TEXT", {
      characters: "AB",
      fills: Symbol("mixed"),
      boundVariables: {
        fontSize: [{ type: "VARIABLE_ALIAS", id: a.id }, { type: "VARIABLE_ALIAS", id: b.id }],
        textRangeFills: [{ type: "VARIABLE_ALIAS", id: a.id }],
      },
    })],
  });
  const { root } = await dumpSubtree(src);
  const report = await restoreSubtree(root, ctxFor(figma, target), {});
  check("restore: per-range text bindings are named, not flattened",
    report.bindingsMissing.some((x) => x.field === "fontSize" && /per-range/.test(x.why)) &&
    report.bindingsMissing.some((x) => x.field === "textRangeFills" && /per-range/.test(x.why)) &&
    target.children[0].boundVariables === undefined);
}

{
  const target = node("FRAME");
  const src = node("FRAME", { explicitVariableModes: { "VariableCollectionId:9:9": "1:0" } });
  const { root } = await dumpSubtree(src);
  const report = await restoreSubtree(root, ctxFor(fakeFigma(), target), {});
  check("restore: a mode whose collection is gone is reported",
    report.modesMissing.length === 1 && /collection no longer exists/.test(report.modesMissing[0].why) &&
    Object.keys(target.explicitVariableModes).length === 0);
}

{
  // A style link is not the same as the paint value. The dump records both, and
  // a restore re-links by id when the file still has the style.
  const figma = fakeFigma();
  const styles = new Map([["S:fill", { id: "S:fill", name: "brand/primary", type: "PAINT" }]]);
  figma.getStyleByIdAsync = async (id) => styles.get(id) ?? null;
  const target = node("FRAME");
  const src = node("FRAME", {
    name: "Card",
    fillStyleId: "S:fill",
    children: [node("RECTANGLE", { name: "bg", fillStyleId: "S:fill" })],
  });
  const { root } = await dumpSubtree(src);
  check("styles: the dump keeps style ids next to the paint values",
    root.meta.styleIds.fillStyleId === "S:fill" && root.children[0].meta.styleIds.fillStyleId === "S:fill");

  const report = await restoreSubtree(root, ctxFor(figma, target), {});
  check("styles: an existing style is re-linked on the root and the rebuilt leaf",
    target.fillStyleId === "S:fill" && target.children[0].fillStyleId === "S:fill" &&
    report.stylesRestored.length === 2 && report.stylesMissing.length === 0);

  const missing = fakeFigma();
  missing.getStyleByIdAsync = async () => null;
  const target2 = node("FRAME");
  const report2 = await restoreSubtree(root, ctxFor(missing, target2), {});
  check("styles: a style the file lost is reported, and the value still comes back",
    target2.children[0].fillStyleId === "" && report2.stylesMissing.length === 2 &&
    report2.notes.length === 0);
}

{
  const figma = fakeFigma();
  const target = node("FRAME");
  const src = node("FRAME", { children: [node("INSTANCE", { name: "btn", _main: null, componentProperties: {} })] });
  const { root } = await dumpSubtree(src);

  const refused = await errors(() => restoreSubtree(root, ctxFor(figma, target), {}));
  check("instances: an unresolvable main component fails the restore with the identity in the message",
    /main component could not be resolved/.test(refused) && root.children[0].state.instance.componentKey === undefined);

  const report = await restoreSubtree(root, ctxFor(fakeFigma(), target), { allowPartial: true });
  check("instances: with allowPartial it is skipped, not faked", report.skipped.length === 1 && report.skipped[0].type === "INSTANCE" && target.children.length === 0);
}

{
  const main = node("COMPONENT", { name: "Button", key: "K1", id: "7:7", _defaults: { Label: { type: "TEXT", value: "Default" } } });
  const figma = fakeFigma([main]);
  const target = node("FRAME");
  const src = node("FRAME", { children: [node("INSTANCE", { name: "btn", _main: main, componentProperties: { Label: { type: "TEXT", value: "Play" } } })] });
  const { root } = await dumpSubtree(src);
  const report = await restoreSubtree(root, ctxFor(figma, target), {});
  const inst = target.children[0];
  check("instances: the instance is recreated from its main component",
    inst.type === "INSTANCE" && inst._main === main && report.created === 1);
  check("instances: its component properties are re-applied", inst._applied.Label === "Play" && report.propertiesFailed.length === 0);
}

{
  // The target is a different node type than the checkpoint describes: the
  // children still come back, and the report says the root's own state was not.
  const figma = fakeFigma();
  const target = node("FRAME", { name: "Card" });
  const src = node("GROUP", { name: "Cluster", children: [node("RECTANGLE", { name: "a" })] });
  const { root } = await dumpSubtree(src);
  const report = await restoreSubtree(root, ctxFor(figma, target), {});
  check("type mismatch: children are restored and the report explains the rest",
    target.children.map((c) => c.name).join(",") === "a" && report.notes.some((n) => /target is a FRAME/.test(n)));
}

{
  // A partial restore keeps the names of what it could not build, and the node
  // count is honest about it.
  const frame = node("FRAME", { children: [node("RECTANGLE"), node("GROUP", { children: [node("ELLIPSE")] })] });
  const { root } = await dumpSubtree(frame);
  check("countNodes counts the whole tree", countNodes(root) === 4);
  check("LIMITATIONS is a real list: every save carries the blind spots", LIMITATIONS.length >= 4 && LIMITATIONS.every((l) => l.length > 20));
}

process.stdout.write(`\ncheckpoint.test: ${pass} passed, ${fail} failed\n`);
if (fail) process.exitCode = 1;
