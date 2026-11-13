// The skill prelude is served live from disk, so a stale or broken asset reaches
// every agent session without a build. These tests pin the runtime-enum helpers
// that replaced a repeatedly hit error:
//
//   in set_overflowDirection: Property "overflowDirection" failed validation:
//   Invalid option: expected one of "NONE"|"HORIZONTAL"|"VERTICAL"|"BOTH"
//
// The value had been written from memory ("VERTICAL_SCROLLING"); the runtime
// accepts no such option, and one rejected value rolls back the whole snippet.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const preludePath = join(root, "skills/figma-local-bridge/assets/prelude.js");
const guidePath = join(root, "skills/figma-local-bridge/GUIDE.md");
const skillPath = join(root, "skills/figma-local-bridge/SKILL.md");

function loadPrelude() {
  const src = fs.readFileSync(preludePath, "utf8");
  const factory = new Function(src + "\nreturn { ENUMS, enumValue, setEnum, setOverflow };");
  return factory();
}

test("setEnum normalizes the runtime spelling before assigning", () => {
  const { setEnum } = loadPrelude();
  const node = { layoutSizingHorizontal: "FIXED" };
  setEnum(node, "layoutSizingHorizontal", "fill");
  assert.equal(node.layoutSizingHorizontal, "FILL");
  setEnum(node, "layoutSizingHorizontal", "hug");
  assert.equal(node.layoutSizingHorizontal, "HUG");
  const text = { textAutoResize: "NONE" };
  setEnum(text, "textAutoResize", "width-and-height");
  assert.equal(text.textAutoResize, "WIDTH_AND_HEIGHT");
});

test("setEnum repairs a known cross-API spelling instead of failing the snippet", () => {
  const { setEnum } = loadPrelude();
  const frame = { overflowDirection: "NONE", layoutMode: "NONE" };
  setEnum(frame, "overflowDirection", "VERTICAL_SCROLLING");
  assert.equal(frame.overflowDirection, "VERTICAL");
  setEnum(frame, "layoutMode", "column");
  assert.equal(frame.layoutMode, "VERTICAL");
  setEnum(frame, "layoutMode", "row");
  assert.equal(frame.layoutMode, "HORIZONTAL");
});

test("setEnum refuses a typo before writing, naming the nearest runtime value", () => {
  const { setEnum } = loadPrelude();
  const node = { overflowDirection: "NONE" };
  assert.throws(
    () => setEnum(node, "overflowDirection", "VERTICL"),
    /looks like a typo; did you mean "VERTICAL"\? accepted: NONE \| HORIZONTAL \| VERTICAL \| BOTH/,
  );
  assert.equal(node.overflowDirection, "NONE");
});

test("setEnum passes an unfamiliar value through for the runtime to judge", () => {
  const { setEnum } = loadPrelude();
  const frame = { layoutMode: "NONE" };
  setEnum(frame, "layoutMode", "mosaic"); // a value newer than the table, not a known mistake
  assert.equal(frame.layoutMode, "MOSAIC");
  const unknown = {};
  setEnum(unknown, "flexDirection", "row"); // property not in the table: normalized, not blocked
  assert.equal(unknown.flexDirection, "ROW");
});

test("setEnum accepts every value the pinned typings know", () => {
  const { setEnum } = loadPrelude();
  const node = {};
  setEnum(node, "layoutMode", "GRID");
  setEnum(node, "textCase", "SMALL_CAPS");
  setEnum(node, "strokeCap", "DIAMOND_FILLED");
  setEnum(node, "primaryAxisAlignItems", "SPACE_EVENLY");
  setEnum(node, "counterAxisAlignItems", "BASELINE");
  assert.deepEqual(node, {
    layoutMode: "GRID",
    textCase: "SMALL_CAPS",
    strokeCap: "DIAMOND_FILLED",
    primaryAxisAlignItems: "SPACE_EVENLY",
    counterAxisAlignItems: "BASELINE",
  });
});

test("setOverflow uses the runtime enum and enables clipping", () => {
  const { setOverflow } = loadPrelude();
  const frame = { clipsContent: false, overflowDirection: "NONE" };
  setOverflow(frame, "vertical");
  assert.equal(frame.overflowDirection, "VERTICAL");
  assert.equal(frame.clipsContent, true);
  setOverflow(frame, "both");
  assert.equal(frame.overflowDirection, "BOTH");
  setOverflow(frame, "VERTICAL_SCROLLING");
  assert.equal(frame.overflowDirection, "VERTICAL");
});

test("setOverflow does not switch clipping on for NONE", () => {
  const { setOverflow } = loadPrelude();
  const frame = { clipsContent: false, overflowDirection: "VERTICAL" };
  setOverflow(frame, "none");
  assert.equal(frame.overflowDirection, "NONE");
  assert.equal(frame.clipsContent, false);
});

test("the guide and playbook send agents to the runtime enum, not memory", () => {
  const guide = fs.readFileSync(guidePath, "utf8");
  const skill = fs.readFileSync(skillPath, "utf8");
  assert.match(guide, /set_overflowDirection/);
  assert.match(guide, /VERTICAL_SCROLLING/);
  assert.match(guide, /setOverflow\(frame, "vertical"\)/);
  assert.match(guide, /refuses a\s+known-bad enum spelling/);
  assert.match(skill, /VERTICAL_SCROLLING/);
  assert.match(skill, /setEnum\(node, property, value\)/);
});
