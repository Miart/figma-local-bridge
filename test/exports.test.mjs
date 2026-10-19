// Unit tests for plugin/exports.ts (built to plugin/exports.mjs): the arithmetic
// behind an atlas manifest, a 9-slice descriptor and a list of states.
//
// Every number this module produces is a promise about a FILE that a game build
// or a web handoff will consume, so the fixtures encode the ways that promise
// gets broken in practice:
//
//   - the exported PNG is NOT exactly round(sheet × scale) (Figma rounds the
//     frame itself), so the rects must be computed against the file's own size;
//   - two sprites adjacent at a fractional coordinate must tile after rounding —
//     rounding each width separately leaves a one-pixel seam or an overlap;
//   - a sprite's render bounds exceed its layout box (a shadow), so a cell that
//     looks fine in Figma is cut off in the sheet;
//   - two layers share a name, so a manifest keyed by name silently merges them;
//   - a component set declares several variant properties, so "State" and "Size"
//     are both plausible names for a state and one of them would be a lie;
//   - a frame carries a stroke, so the image is the node's own box, not the
//     bounding box the rects would otherwise be measured from.
//
// Refusals are asserted too: those messages are the interface.
import { test } from "node:test";
import assert from "node:assert/strict";
import { atlasManifest, nineSliceDescriptor, pngSize, stateList, MAX_OVERLAP_SCAN } from "../plugin/exports.mjs";

// ---------------------------------------------------------------- fixtures

/** A PNG signature + IHDR, which is all `pngSize` is allowed to look at. */
function pngHeader(width, height) {
  const b = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return new Uint8Array(b);
}

const box = (x, y, width, height) => ({ x, y, width, height });
const sprite = (name, b, extra = {}) => ({ id: "id-" + name, name, box: b, ...extra });
const sheetAt = (x, y, width, height) => ({ id: "sheet", name: "Sheet", sheet: box(x, y, width, height) });
const atlas = (sheet, sprites, scale, extra = {}) => atlasManifest({ ...sheet, sprites, scale, ...extra });

// ---------------------------------------------------------------- pngSize

test("pngSize reads the file's own size and rejects anything that is not a PNG", () => {
  assert.deepEqual(pngSize(pngHeader(1200, 800)), { width: 1200, height: 800 });
  assert.equal(pngSize(null), null);
  assert.equal(pngSize(new Uint8Array(4)), null);
  assert.equal(pngSize(new Uint8Array(24)), null, "all-zero bytes are not a PNG signature");
  const jpeg = new Uint8Array(24);
  jpeg[0] = 0xff;
  jpeg[1] = 0xd8;
  assert.equal(pngSize(jpeg), null);
  const wrongChunk = pngHeader(10, 10);
  wrongChunk[12] = 0x58; // "XHDR": a PNG whose size we must not guess
  assert.equal(pngSize(wrongChunk), null);
});

// ---------------------------------------------------------------- atlas

test("atlas: rects are in the exported file's pixels, measured from the sheet's origin", () => {
  const m = atlas(sheetAt(100, 100, 200, 100), [sprite("icon", box(110, 120, 40, 30))], 2, {
    exportSize: { width: 400, height: 200 },
  });
  assert.deepEqual(m.sprites[0].rect, { x: 20, y: 40, width: 80, height: 60 });
  assert.equal(m.sheet.exportWidth, 400);
  assert.equal(m.sheet.sizeMatches, true);
  assert.deepEqual(m.warnings, []);
  assert.deepEqual(m.verification, {
    rounded: 0,
    overlaps: 0,
    offSheet: 0,
    duplicateNames: 0,
    bleed: 0,
    hidden: 0,
    overlapScan: "full",
  });
});

test("atlas: sprites adjacent at a fractional coordinate tile exactly after rounding", () => {
  const m = atlas(sheetAt(0, 0, 100, 50), [sprite("a", box(0, 0, 33.4, 50)), sprite("b", box(33.4, 0, 33.3, 50))], 2);
  const [a, b] = m.sprites.map((s) => s.rect);
  assert.equal(a.x + a.width, b.x, "a rounded edge that is not shared leaves a seam or an overlap");
  assert.equal(a.x, 0);
  assert.equal(a.width, 67);
  assert.equal(b.width, 66);
  assert.equal(m.verification.rounded, 3, "66.8 and 133.4 edges, and b's shared left edge, are not integral at 2x");
  assert.equal(m.verification.overlaps, 0);
  assert.match(m.warnings.join(" "), /rounded to the nearest pixel/);
});

test("atlas: the file's real size wins over what scale predicted", () => {
  const m = atlas(sheetAt(0, 0, 200, 100), [sprite("edge", box(199.5, 0, 1, 10))], 2, {
    exportSize: { width: 399, height: 200 },
  });
  assert.equal(m.sheet.sizeMatches, false);
  assert.equal(m.sheet.exportWidth, 399);
  assert.deepEqual(m.sprites[0].rect, { x: 399, y: 0, width: 2, height: 20 });
  assert.equal(m.verification.offSheet, 1);
  assert.match(m.warnings.join(" "), /the exporter wrote 399x200/);
  assert.match(m.warnings.join(" "), /fall outside the exported image/);
});

test("atlas: repeated layer names are keyed, counted and reported, never merged", () => {
  const m = atlas(sheetAt(0, 0, 100, 100), [sprite("coin", box(0, 0, 10, 10)), sprite("coin", box(20, 0, 10, 10))], 1);
  assert.deepEqual(m.sprites.map((s) => s.key), ["coin#1", "coin#2"]);
  assert.equal(m.verification.duplicateNames, 1);
  assert.match(m.warnings.join(" "), /sprite name\(s\) repeat/);
});

test("atlas: a layer already named `coin#2` does not collide with a keyed duplicate", () => {
  const m = atlas(
    sheetAt(0, 0, 100, 100),
    [sprite("coin", box(0, 0, 10, 10)), sprite("coin", box(20, 0, 10, 10)), sprite("coin#2", box(40, 0, 10, 10))],
    1,
  );
  assert.deepEqual(m.sprites.map((s) => s.key), ["coin#1", "coin#2", "coin#2#1"]);
  assert.equal(new Set(m.sprites.map((s) => s.key)).size, 3, "keys must be unique: they are what the engine looks sprites up by");
});

test("atlas: overlapping rects are named, because a rect cannot be sliced two ways", () => {
  const m = atlas(sheetAt(0, 0, 100, 100), [sprite("a", box(0, 0, 50, 50)), sprite("b", box(40, 40, 50, 50))], 1);
  assert.equal(m.verification.overlaps, 1);
  assert.match(m.warnings.join(" "), /a ∩ b/);
});

test("atlas: drawing that bleeds out of its own box is measured in export pixels", () => {
  const m = atlas(sheetAt(0, 0, 100, 100), [sprite("shadowed", box(20, 20, 40, 30), { render: box(16, 16, 48, 38) })], 2);
  assert.deepEqual(m.sprites[0].bleed, { left: 8, top: 8, right: 8, bottom: 8 });
  assert.equal(m.verification.bleed, 1);
  assert.match(m.warnings.join(" "), /draw outside their own box/);
});

test("atlas: a hidden sprite is still described, and said to be blank in the image", () => {
  const m = atlas(sheetAt(0, 0, 100, 100), [sprite("off", box(0, 0, 10, 10), { visible: false })], 1);
  assert.equal(m.verification.hidden, 1);
  assert.match(m.warnings.join(" "), /hidden in the file/);
});

test("atlas: the pairwise overlap scan is skipped above its limit, and says so", () => {
  const sprites = [];
  for (let i = 0; i <= MAX_OVERLAP_SCAN; i++) sprites.push(sprite("s" + i, box(i * 2, 0, 1, 1)));
  const m = atlas(sheetAt(0, 0, 10000, 100), sprites, 1);
  assert.equal(m.verification.overlapScan, "skipped");
  assert.match(m.warnings.join(" "), /overlap check skipped/);
});

test("atlas: a frame with a stroke names the box its image actually is", () => {
  const withStroke = atlas(sheetAt(0, 0, 100, 100), [sprite("a", box(0, 0, 10, 10))], 1, { basis: "nodeBox" });
  assert.equal(withStroke.sheet.basis, "nodeBox");
  assert.match(withStroke.warnings.join(" "), /the frame has a stroke/);
  const unmatched = atlas(sheetAt(0, 0, 100, 100), [sprite("a", box(0, 0, 10, 10))], 2, {
    exportSize: { width: 190, height: 200 },
    basis: "unmatched",
  });
  assert.match(unmatched.warnings.join(" "), /matches neither the frame's box nor its bounding box/);
});

// ---------------------------------------------------------------- 9-slice

test("9-slice: explicit insets become file pixels, a middle, and CSS slices", () => {
  const d = nineSliceDescriptor({
    width: 100,
    height: 60,
    insets: { top: 10, right: 12, bottom: 8, left: 6 },
    scale: 2,
    exportSize: { width: 200, height: 120 },
  });
  assert.deepEqual(d.exported.insets, { top: 20, right: 24, bottom: 16, left: 12 });
  assert.deepEqual(d.middle, { width: 164, height: 84 });
  assert.equal(d.cssBorderImageSlice, "20 24 16 12");
  assert.deepEqual(d.warnings, []);
});

test("9-slice: a `9slice` child marks the stretchable middle", () => {
  const d = nineSliceDescriptor({
    width: 100,
    height: 60,
    guide: { sheet: box(0, 0, 100, 60), guide: box(10, 8, 76, 44) },
    scale: 1,
  });
  assert.deepEqual(d.design.insets, { top: 8, right: 14, bottom: 8, left: 10 });
  assert.deepEqual(d.middle, { width: 76, height: 44 });
});

test("9-slice: a guide that sticks out of the frame is refused with its numbers", () => {
  assert.throws(
    () => nineSliceDescriptor({ width: 100, height: 60, guide: { sheet: box(0, 0, 100, 60), guide: box(-5, 5, 100, 50) }, scale: 1 }),
    /sticks out of the frame/,
  );
});

test("9-slice: insets that leave no middle are refused, not exported as a lie", () => {
  assert.throws(
    () => nineSliceDescriptor({ width: 100, height: 60, insets: { top: 5, right: 60, bottom: 5, left: 50 }, scale: 1 }),
    /leave no middle/,
  );
  assert.throws(() => nineSliceDescriptor({ width: 100, height: 60, scale: 1 }), /no child named "9slice"/);
});

test("9-slice: a middle too small to stretch at this scale is a warning, not a refusal", () => {
  const d = nineSliceDescriptor({ width: 100, height: 60, insets: { top: 5, right: 49, bottom: 5, left: 49 }, scale: 0.1 });
  assert.ok(d.middle.width < 1);
  assert.match(d.warnings.join(" "), /nothing to stretch/);
});

test("9-slice: the slice numbers follow the file when the exporter rounds differently", () => {
  const d = nineSliceDescriptor({
    width: 100,
    height: 60,
    insets: { top: 10, right: 10, bottom: 10, left: 10 },
    scale: 1,
    exportSize: { width: 99, height: 60 },
  });
  assert.equal(d.exported.width, 99);
  assert.equal(d.middle.width, 79);
  assert.match(d.warnings.join(" "), /the exporter wrote 99x60/);
});

// ---------------------------------------------------------------- states

const variant = (name, props, w = 80, h = 32) => ({ id: "id-" + name, name, type: "COMPONENT", width: w, height: h, variantProperties: props });

test("states: a set with one variant property names states by its values, without asking", () => {
  const list = stateList({
    nodeType: "COMPONENT_SET",
    variantPropertyNames: ["State"],
    children: [variant("n", { State: "normal" }), variant("h", { State: "hover" })],
  });
  assert.equal(list.property, "State");
  assert.deepEqual(list.states.map((s) => s.key), ["normal", "hover"]);
  assert.deepEqual(list.states[0], { key: "normal", name: "normal", id: "id-n", width: 80, height: 32, visible: true, value: "normal" });
});

test("states: several properties are refused until the caller says which one names the states", () => {
  const facts = {
    nodeType: "COMPONENT_SET",
    variantPropertyNames: ["State", "Size"],
    children: [variant("n", { State: "normal", Size: "L" }), variant("h", { State: "hover", Size: "L" })],
  };
  assert.throws(() => stateList(facts), /declares 2 variant properties \("State", "Size"\)/);
  const list = stateList({ ...facts, property: "Size" });
  assert.deepEqual(list.states.map((s) => s.key), ["L#1", "L#2"], "both children carry Size=L: the names collide and are keyed");
  assert.match(list.warnings.join(" "), /state name\(s\) repeat/);
});

test("states: a property the set does not declare is refused, not approximated", () => {
  assert.throws(
    () =>
      stateList({
        nodeType: "COMPONENT_SET",
        variantPropertyNames: ["State"],
        property: "Tone",
        children: [variant("n", { State: "normal" })],
      }),
    /do not declare a property "Tone" — the set has "State"/,
  );
});

test("states: a plain frame takes its state names from the layers", () => {
  const list = stateList({
    nodeType: "FRAME",
    children: [
      { id: "a", name: "normal", type: "FRAME", width: 120, height: 40 },
      { id: "b", name: "hover", type: "FRAME", width: 120, height: 40, visible: false },
    ],
  });
  assert.equal(list.property, null);
  assert.deepEqual(list.states.map((s) => s.key), ["normal", "hover"]);
  assert.equal(list.states[1].visible, false);
  assert.match(list.warnings.join(" "), /hidden in the file/);
});

test("states: a child that does not carry the property keeps its layer name, and it is said so", () => {
  const list = stateList({
    nodeType: "COMPONENT_SET",
    variantPropertyNames: ["State"],
    children: [variant("n", { State: "normal" }), { id: "id-x", name: "leftover", type: "COMPONENT", width: 10, height: 10, variantProperties: {} }],
  });
  assert.deepEqual(list.states.map((s) => s.key), ["normal", "leftover"]);
  assert.match(list.warnings.join(" "), /do not carry "State"/);
});

test("states: an empty container and a property on a non-variant frame are refused", () => {
  assert.throws(() => stateList({ nodeType: "FRAME", children: [] }), /has no children to export as states/);
  assert.throws(
    () => stateList({ nodeType: "FRAME", property: "State", children: [{ id: "a", name: "normal", type: "FRAME", width: 1, height: 1 }] }),
    /nothing here is a variant/,
  );
});
