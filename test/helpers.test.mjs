// Unit tests for the snippet standard library (plugin/helpers.ts, built to
// plugin/helpers.mjs and handed to every use_figma snippet as `flb`).
//
// The stub below models the behaviours that make the helpers worth having, not
// just a happy path:
//
//   - `getNodeById` does not exist (the real one THROWS in this manifest's
//     dynamic-page mode), so a helper that used it would fail here;
//   - writing `characters` before loadFontAsync throws, as Figma does;
//   - `appendChild` keeps a node's LOCAL position, so a grid that measures
//     after reparenting lands every sprite one offset away;
//   - resizing an INSTANCE throws, and a HUG-sized frame ignores the resize;
//   - `absoluteRenderBounds` is null for a node with nothing to draw.
//
// Every refusal is asserted: those messages are the interface.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHelpers, FIND_LIMIT } from "../plugin/helpers.mjs";

// ---------------------------------------------------------------- stub Figma

let seq = 0;
const nextId = () => `n${++seq}`;

const SIZES = { RECTANGLE: [40, 30], TEXT: [80, 20], FRAME: [200, 200], INSTANCE: [60, 60] };
// Only containers have `children` in the real API — a hand-written stub that
// gives every node an array makes "a leaf cannot be cleared" untestable.
const CONTAINERS = new Set(["PAGE", "FRAME", "GROUP", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SECTION"]);

function buildNode(api, type, name, opts = {}) {
  const node = {
    id: opts.id ?? nextId(),
    type,
    name,
    parent: null,
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    width: opts.width ?? SIZES[type]?.[0] ?? 100,
    height: opts.height ?? SIZES[type]?.[1] ?? 100,
    layoutMode: opts.layoutMode ?? "NONE",
    layoutSizingHorizontal: opts.layoutSizingHorizontal ?? "FIXED",
    layoutSizingVertical: opts.layoutSizingVertical ?? "FIXED",
    layoutPositioning: opts.layoutPositioning ?? "AUTO",
    textAutoResize: opts.textAutoResize ?? "WIDTH_AND_HEIGHT",
    // Whatever is drawn beyond the box (a shadow, a stroke): the atlas has to
    // pack by this, not by the layout box.
    _pad: opts.pad ?? null,
    _nothingDrawn: opts.nothingDrawn === true,
    _detachFails: opts.detachFails ?? null,
    _font: null,
    _characters: "",
    fills: [],
  };

  Object.defineProperty(node, "absoluteTransform", {
    get() {
      if (node.type === "PAGE") return [[1, 0, 0], [0, 1, 0]];
      const p = node.parent;
      let bx = 0, by = 0;
      if (p && p.type !== "PAGE") {
        const t = p.absoluteTransform;
        bx = t[0][2];
        by = t[1][2];
      }
      return [[1, 0, bx + node.x], [0, 1, by + node.y]];
    },
  });
  Object.defineProperty(node, "absoluteBoundingBox", {
    get() {
      if (node.type === "PAGE") return null;
      const t = node.absoluteTransform;
      return { x: t[0][2], y: t[1][2], width: node.width, height: node.height };
    },
  });
  Object.defineProperty(node, "absoluteRenderBounds", {
    get() {
      if (node.type === "PAGE") return null;
      const b = node.absoluteBoundingBox;
      if (!b) return null;
      if (node._nothingDrawn) return null;
      const p = node._pad;
      if (!p) return b;
      return { x: b.x - p, y: b.y - p, width: b.width + 2 * p, height: b.height + 2 * p };
    },
  });
  Object.defineProperty(node, "characters", {
    get: () => node._characters,
    set: (v) => {
      // Figma's own rule: characters cannot be written before the font is loaded.
      if (!node._font || !api.loadedFonts.has(`${node._font.family} ${node._font.style}`)) {
        throw new Error("Cannot write to node with unloaded font. Please call figma.loadFontAsync");
      }
      node._characters = String(v);
    },
  });
  Object.defineProperty(node, "fontName", {
    get: () => node._font,
    set: (f) => { node._font = { family: f.family, style: f.style }; },
  });

  if (CONTAINERS.has(type)) node.children = [];
  node.appendChild = (child) => {
    if (child.parent) child.parent.children = child.parent.children.filter((c) => c !== child);
    child.parent = node;
    (node.children ?? (node.children = [])).push(child);
    return child; // Figma keeps the LOCAL position — no rebasing here on purpose
  };
  node.remove = () => {
    if (node.parent) node.parent.children = node.parent.children.filter((c) => c !== node);
    node.parent = null;
  };
  node.resize = (w, h) => {
    if (node.type === "INSTANCE") throw new Error("cannot resize an instance");
    if (node.layoutMode !== "NONE" && (node.layoutSizingHorizontal === "HUG" || node.layoutSizingVertical === "HUG")) return;
    node.width = w;
    node.height = h;
  };
  node.detachInstance = () => {
    if (node._detachFails) throw new Error(node._detachFails);
    const frame = api.makeNode("FRAME", node.name, { x: node.x, y: node.y, width: node.width, height: node.height });
    for (const child of [...node.children]) frame.appendChild(child);
    if (node.parent) {
      const at = node.parent.children.indexOf(node);
      node.parent.children[at] = frame;
      frame.parent = node.parent;
    }
    return frame;
  };
  node.findAll = (pred) => {
    if (node.type === "PAGE" && !node._loaded) {
      throw new Error("You must call loadAsync() on this page before accessing its children");
    }
    const out = [];
    const walk = (n) => {
      for (const c of n.children ?? []) {
        if (!pred || pred(c)) out.push(c);
        walk(c);
      }
    };
    walk(node);
    return out;
  };
  return node;
}

function makeApi() {
  const api = {
    loadedFonts: new Set(),
    calls: [],
    util: {
      solidPaint: (hex) => {
        const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(hex));
        if (!m) throw new Error(`bad hex ${hex}`);
        const n = parseInt(m[1], 16);
        const paint = { type: "SOLID", color: { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 } };
        if (m[2]) paint.opacity = parseInt(m[2], 16) / 255;
        return paint;
      },
    },
  };
  const page = buildNode(api, "PAGE", "Page 1", { _loaded: true });
  delete page.x;
  delete page.y;
  api.currentPage = page;
  api.page = page;
  const registry = new Map();
  api.registry = registry;
  api.makeNode = (type, name, opts = {}) => {
    const n = buildNode(api, type, name, opts);
    registry.set(n.id, n);
    return n;
  };
  api.add = (type, name, opts = {}) => {
    const n = api.makeNode(type, name, opts);
    (opts.parent ?? page).appendChild(n);
    return n;
  };
  // Deliberately the ONLY lookup: no getNodeById, because the real one throws
  // in a dynamic-page manifest.
  api.getNodeByIdAsync = async (id) => registry.get(id) ?? null;
  api.loadFontAsync = async (font) => {
    api.calls.push(`loadFont:${font.family} ${font.style}`);
    if (!["Inter Regular", "Inter Bold", "Roboto Bold"].includes(`${font.family} ${font.style}`)) {
      throw new Error(`The font "${font.family} ${font.style}" could not be loaded`);
    }
    api.loadedFonts.add(`${font.family} ${font.style}`);
  };
  api.createText = () => {
    api.calls.push("createText");
    return api.add("TEXT", "Text", {});
  };
  return api;
}

// ---------------------------------------------------------------- flb.byId

test("byId: resolves through the ASYNC getter, and says a missing id belongs to another file", async () => {
  const api = makeApi();
  const flb = makeHelpers(api);
  const rect = api.add("RECTANGLE", "sprite");
  assert.equal((await flb.byId(rect.id)).id, rect.id);

  await assert.rejects(() => flb.byId("12:345"), /no node 12:345 in this file[\s\S]*figma_get_metadata/);
});

// ---------------------------------------------------------------- flb.find / flb.one

test("find: filters by name, type and pattern, and searches inside a node", () => {
  const api = makeApi();
  const flb = makeHelpers(api);
  const frame = api.add("FRAME", "Atlas");
  api.add("RECTANGLE", "icon_1", { parent: frame });
  api.add("RECTANGLE", "icon_2", { parent: frame });
  api.add("TEXT", "icon_1 label", { parent: frame });
  api.add("RECTANGLE", "icon_9");

  assert.equal(flb.find({ within: frame, type: "RECTANGLE" }).length, 2);
  assert.equal(flb.find({ within: frame, name: "icon_1" }).length, 1);
  assert.equal(flb.find({ within: frame, match: "^icon_\\d$" }).length, 2, "a string is a pattern");
  assert.equal(flb.find({ within: frame, match: /label$/ }).length, 1, "a RegExp works too");
  assert.equal(flb.find({ within: frame, name: "nope" }).length, 0);

  assert.throws(() => flb.find({ within: frame }), /give a name, a match pattern or a type/);
});

test("find: refuses to answer with a truncated list instead of pretending it fits", () => {
  const api = makeApi();
  const flb = makeHelpers(api);
  const frame = api.add("FRAME", "Huge");
  for (let i = 0; i <= FIND_LIMIT; i++) api.add("RECTANGLE", `r${i}`, { parent: frame });

  assert.throws(() => flb.find({ within: frame, type: "RECTANGLE" }), new RegExp(`${FIND_LIMIT + 1} nodes match`));
});

test("one: exactly one, or a refusal that names what else matched", () => {
  const api = makeApi();
  const flb = makeHelpers(api);
  const frame = api.add("FRAME", "Atlas");
  const only = api.add("RECTANGLE", "coin", { parent: frame });
  api.add("RECTANGLE", "star", { parent: frame });

  assert.equal(flb.one({ within: frame, name: "coin" }).id, only.id);
  assert.throws(() => flb.one({ within: frame, type: "RECTANGLE" }), /flb\.one: 2 nodes match[\s\S]*"coin"[\s\S]*"star"[\s\S]*picking the first/);
  assert.throws(() => flb.one({ within: frame, name: "gem" }), /flb\.one: nothing matches/);
});

test("find: a page that was never loaded is refused with the call that loads it", () => {
  const api = makeApi();
  const flb = makeHelpers(api);
  const other = api.makeNode("PAGE", "Page 2", { _loaded: false });
  const frame = api.makeNode("FRAME", "In there");
  other.appendChild(frame);

  assert.throws(
    () => flb.find({ within: other, type: "FRAME" }),
    /loadAsync\(\) first[\s\S]*refuses a page switch mid-call/,
  );
});

// ---------------------------------------------------------------- flb.bbox

test("bbox: layout bounds by default, render bounds on request, and a note when nothing is drawn", () => {
  const api = makeApi();
  const flb = makeHelpers(api);
  const outer = api.add("FRAME", "Outer", { x: 100, y: 50 });
  const sprite = api.add("RECTANGLE", "glow", { parent: outer, x: 10, y: 5, width: 40, height: 30, pad: 8 });

  assert.deepEqual(flb.bbox(sprite), { x: 110, y: 55, width: 40, height: 30, render: false });
  const render = flb.bbox(sprite, { render: true });
  assert.deepEqual([render.x, render.y, render.width, render.height], [102, 47, 56, 46], "shadows grow the box");
  assert.equal(render.render, true);

  const empty = api.add("FRAME", "Empty", { nothingDrawn: true });
  assert.equal(empty.absoluteRenderBounds, null);
  const b = flb.bbox(empty, { render: true });
  assert.equal(b.render, false);
  assert.match(b.note, /nothing is drawn/);
  assert.equal(b.width, empty.width);

  assert.throws(() => flb.bbox(api.page), /PAGE has none/);
  assert.throws(() => flb.bbox(null), /pass a node/);
});

// ---------------------------------------------------------------- flb.clear

test("clear: removes every child and reports what went", () => {
  const api = makeApi();
  const flb = makeHelpers(api);
  const frame = api.add("FRAME", "Atlas");
  api.add("RECTANGLE", "a", { parent: frame });
  api.add("RECTANGLE", "b", { parent: frame });

  const removed = flb.clear(frame);
  assert.deepEqual(removed.map((r) => r.name), ["a", "b"]);
  assert.equal(frame.children.length, 0);

  assert.throws(() => flb.clear(api.add("RECTANGLE", "leaf")), /has no children/);
  const inst = api.add("INSTANCE", "Symbol 1");
  assert.throws(() => flb.clear(inst), /INSTANCE[\s\S]*main component[\s\S]*flb\.flatten/);
});

// ---------------------------------------------------------------- scope and page refusals

test("write helpers refuse a target outside the declared scope, BEFORE writing", () => {
  const api = makeApi();
  const inside = api.add("FRAME", "In scope");
  const outside = api.add("FRAME", "Elsewhere");
  api.add("RECTANGLE", "kept", { parent: outside });
  const flb = makeHelpers(api, { scopeRootId: inside.id });

  assert.throws(() => flb.clear(outside), /outside the declared scopeNodeId[\s\S]*rolled back/);
  assert.equal(outside.children.length, 1, "nothing was removed by the refused call");

  const inner = api.add("FRAME", "Inner", { parent: inside });
  api.add("RECTANGLE", "gone", { parent: inner });
  assert.equal(flb.clear(inner).length, 1, "a node INSIDE the scope is fine");

  // pageWide turns the check off
  const wide = makeHelpers(api, { pageWide: true });
  assert.doesNotThrow(() => wide.bbox(outside));
});

test("a node on another page is refused by name, because the scope guard only sees one page", () => {
  const api = makeApi();
  const flb = makeHelpers(api);
  const other = api.makeNode("PAGE", "Page 2", { _loaded: true });
  const frame = api.makeNode("FRAME", "Elsewhere");
  other.appendChild(frame);
  api.registry.set(other.id, other);
  api.registry.set(frame.id, frame);

  assert.throws(() => flb.clear(frame), /on page "Page 2", not the current page "Page 1"[\s\S]*figma_set_page/);
});

// ---------------------------------------------------------------- flb.flatten

test("flatten: detaches the root and every nested instance, outermost first", () => {
  const api = makeApi();
  const flb = makeHelpers(api);
  const frame = api.add("FRAME", "Atlas");
  const outer = api.add("INSTANCE", "Symbol", { parent: frame });
  const inner = api.makeNode("INSTANCE", "Nested");
  outer.appendChild(inner);
  const plain = api.makeNode("RECTANGLE", "shape");
  inner.appendChild(plain);

  const res = flb.flatten(outer);
  assert.equal(res.detached.length, 2, "the caller's instance and the one inside it");
  assert.equal(res.root.type, "FRAME", "the root came back as the frame it became");
  assert.equal(frame.children[0], res.root, "and it sits where the instance was");
  assert.deepEqual(res.detached.map((d) => d.name), ["Symbol", "Nested"]);
  assert.equal(plain.parent.id, res.detached[1].frame, "the leaf ended up inside the inner frame");
});

test("flatten: a node with no instances is a no-op, and a failure is never reported as success", () => {
  const api = makeApi();
  const flb = makeHelpers(api);
  const frame = api.add("FRAME", "Plain");
  api.add("RECTANGLE", "a", { parent: frame });
  assert.deepEqual(flb.flatten(frame).detached, []);

  const stubborn = api.add("INSTANCE", "Locked", { detachFails: "this instance is locked by its main component" });
  assert.throws(() => flb.flatten(stubborn), /1 instance\(s\) could not be detached[\s\S]*locked by its main component[\s\S]*Nothing is reported as flattened/);
});

// ---------------------------------------------------------------- flb.grid

test("grid: places cells at ABSOLUTE coordinates, in the parent's own space", () => {
  const api = makeApi();
  const flb = makeHelpers(api);
  const page = api.page;
  const outer = api.add("FRAME", "Outer", { x: 1000, y: 500 });
  const atlas = api.add("FRAME", "Atlas", { parent: outer, x: 30, y: 20 });
  const a = api.add("RECTANGLE", "a", { parent: page, width: 10, height: 10 });
  const b = api.add("RECTANGLE", "b", { parent: page, width: 20, height: 10, pad: 0 });
  const c = api.add("RECTANGLE", "c", { parent: page, width: 10, height: 10 });

  const res = flb.grid([a, b, c], { parent: atlas, cell: 100, gap: 10, columns: 2, origin: { x: 2000, y: 1000 } });

  // atlas' own origin is absolute (1030, 520), so local = absolute - that.
  assert.deepEqual([a.x, a.y], [2000 - 1030 + 45, 1000 - 520 + 45]);
  assert.deepEqual([b.x, b.y], [2000 - 1030 + 110 + 40, 1000 - 520 + 45]);
  assert.deepEqual([c.x, c.y], [2000 - 1030 + 45, 1000 - 520 + 110 + 45]);
  assert.deepEqual([a.parent.name, b.parent.name, c.parent.name], ["Atlas", "Atlas", "Atlas"]);

  assert.equal(res.columns, 2);
  assert.equal(res.rows, 2);
  assert.equal(res.width, 210);
  assert.equal(res.height, 210);
  assert.deepEqual(res.origin, { x: 2000, y: 1000 });
  assert.deepEqual(res.cells[0], { id: a.id, name: "a", x: 2000, y: 1000, width: 100, height: 100 });
  assert.deepEqual(res.cells[2], { id: c.id, name: "c", x: 2000, y: 1110, width: 100, height: 100 });
  assert.deepEqual(res.resized, []);
});

test("grid: defaults — cell from the largest render bounds, origin from the first node, columns from the count", () => {
  const api = makeApi();
  const flb = makeHelpers(api);
  const big = api.add("RECTANGLE", "glow", { x: 40, y: 60, width: 40, height: 30, pad: 8 });
  const small = api.add("RECTANGLE", "dot", { x: 300, y: 300, width: 10, height: 10 });

  const res = flb.grid([big, small]);
  assert.deepEqual(res.cell, { width: 56, height: 46 }, "render bounds of the glow, not its layout box");
  assert.deepEqual(res.origin, { x: 32, y: 52 }, "the first node's render top-left");
  assert.match(res.notes.join(" "), /cell sized to the largest render bounds/);
  assert.equal(res.columns, 2, "ceil(sqrt(2))");
});

test("grid: fit scales DOWN into the cell, never up, and reports what it did", () => {
  const api = makeApi();
  const flb = makeHelpers(api);
  const sprite = api.add("RECTANGLE", "wide", { x: 0, y: 0, width: 200, height: 100 });
  const small = api.add("RECTANGLE", "small", { x: 500, y: 500, width: 10, height: 10 });

  const res = flb.grid([sprite, small], { cell: 50, columns: 1, origin: { x: 0, y: 0 }, fit: true });
  assert.deepEqual([sprite.width, sprite.height], [50, 25], "aspect ratio kept, scaled down");
  assert.deepEqual([small.width, small.height], [10, 10], "already smaller: untouched");
  assert.deepEqual(res.resized.map((r) => r.name), ["wide"]);
  assert.deepEqual(res.resized[0].to, [50, 25]);
  assert.equal(sprite.y, 12.5, "centred in a 50x50 cell");
});

test("grid: refuses what the API would quietly ignore or throw on", () => {
  const api = makeApi();
  const flb = makeHelpers(api);
  const inst = api.add("INSTANCE", "Symbol");
  assert.throws(() => flb.grid([inst], { cell: 10, fit: true }), /INSTANCE[\s\S]*cannot be resized[\s\S]*flb\.flatten/);

  const hug = api.add("FRAME", "Hug", { x: 400, y: 0, layoutMode: "VERTICAL", layoutSizingVertical: "HUG" });
  assert.throws(() => flb.grid([hug], { cell: 10, fit: true }), /sizes itself from its contents[\s\S]*FIXED/);

  const auto = api.add("FRAME", "Auto", { x: 600, y: 0, layoutMode: "HORIZONTAL" });
  const loose = api.add("RECTANGLE", "loose", { x: 800, y: 0 });
  assert.throws(() => flb.grid([loose], { parent: auto, cell: 10 }), /uses auto-layout[\s\S]*layoutPositioning = "ABSOLUTE"/);

  const abs = api.add("RECTANGLE", "abs", { x: 900, y: 0, layoutPositioning: "ABSOLUTE" });
  assert.doesNotThrow(() => flb.grid([abs], { parent: auto, cell: 10 }));

  const inA = api.add("FRAME", "A");
  const inB = api.add("FRAME", "B");
  const one = api.add("RECTANGLE", "one", { parent: inA, x: 0, y: 0 });
  const two = api.add("RECTANGLE", "two", { parent: inB, x: 100, y: 0 });
  assert.throws(() => flb.grid([one, two], { cell: 10 }), /2 different parents[\s\S]*pass `parent`/);

  assert.throws(() => flb.grid([], {}), /pass the nodes to arrange/);
});

// ---------------------------------------------------------------- flb.text

test("text: loads the font BEFORE writing characters, and turns a hex string into a paint", async () => {
  const api = makeApi();
  const flb = makeHelpers(api);
  const node = await flb.text("x5", { size: 48, font: "Inter Bold", fills: "#ffcc00" });

  assert.deepEqual(api.calls, ["loadFont:Inter Bold", "createText"], "load first, then create — the stub throws otherwise");
  assert.equal(node.characters, "x5");
  assert.equal(node.fontSize, 48);
  assert.deepEqual(node.fontName, { family: "Inter", style: "Bold" });
  assert.equal(node.name, "x5");
  assert.equal(node.fills.type, "SOLID");
  assert.equal(Math.round(node.fills.color.r * 255), 255);
  assert.equal(Math.round(node.fills.color.g * 255), 204);
});

test("text: absolute coordinates become local to the parent, and a missing font names itself", async () => {
  const api = makeApi();
  const flb = makeHelpers(api);
  const outer = api.add("FRAME", "Outer", { x: 1000, y: 500 });
  const frame = api.add("FRAME", "Card", { parent: outer, x: 30, y: 20 });

  const node = await flb.text("win", { parent: frame, x: 1200, y: 600 });
  assert.deepEqual([node.x, node.y], [170, 80], "local to the frame, not the page");
  assert.equal(node.parent.id, frame.id);

  await assert.rejects(() => flb.text("hi", { font: "Comic Sans Regular" }), /could not be loaded[\s\S]*listAvailableFontsAsync/);

  const scoped = makeHelpers(api, { scopeRootId: frame.id });
  await assert.rejects(() => scoped.text("orphan"), /no parent the text lands on the page[\s\S]*declared scopeNodeId/);

  await assert.rejects(() => makeHelpers(api).text("x", { font: { style: "Bold" } }), /must be "Family Style" or \{ family, style \}/);
});
