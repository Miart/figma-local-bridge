// The pre-send enum guard. A bad enum literal used to surface only inside the
// plugin, after the snippet had already written part of its work:
//
//   in set_overflowDirection: Property "overflowDirection" failed validation:
//   Invalid option: expected one of "NONE"|"HORIZONTAL"|"VERTICAL"|"BOTH"
//
// which rolls the whole snippet back. figma_use now tokenises the snippet and
// refuses a known cross-API spelling or a near-miss before the plugin is called
// — nothing is sent, so nothing can be applied or rolled back. A value that is
// merely unfamiliar is allowed through: the runtime is the authority.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import {
  RUNTIME_ENUMS,
  findEnumLiteralViolations,
  formatEnumViolations,
} from "../server/dist/enum-guard.js";

const preludePath = join(process.cwd(), "skills/figma-local-bridge/assets/prelude.js");

test("catches the overflow spelling that started this", () => {
  const code = [
    "const list = await flb.byId('1:2');",
    "list.clipsContent = true;",
    'list.overflowDirection = "VERTICAL_SCROLLING";',
  ].join("\n");
  const found = findEnumLiteralViolations(code);
  assert.equal(found.length, 1);
  assert.equal(found[0].property, "overflowDirection");
  assert.equal(found[0].value, "VERTICAL_SCROLLING");
  assert.equal(found[0].line, 3);
  assert.equal(found[0].suggestion, "VERTICAL");
  assert.deepEqual(found[0].accepted, RUNTIME_ENUMS.overflowDirection);
});

test("catches a near-miss as a typo, not just a known alias", () => {
  const found = findEnumLiteralViolations('n.overflowDirection = "VERTICL";');
  assert.equal(found.length, 1);
  assert.equal(found[0].suggestion, "VERTICAL");
});

test("accepts every runtime spelling, case-insensitively, in both notations", () => {
  const code = [
    'a.overflowDirection = "VERTICAL";',
    "a.overflowDirection = 'both';",
    'a["overflowDirection"] = "horizontal";',
    'a.layoutMode = "GRID";',
    'a.layoutSizingHorizontal = "fill";',
    'a.textAutoResize = "WIDTH_AND_HEIGHT";',
    'a.textCase = "SMALL_CAPS";',
    'a.strokeCap = "DIAMOND_FILLED";',
    'a.primaryAxisAlignItems = "SPACE_EVENLY";',
  ].join("\n");
  assert.deepEqual(findEnumLiteralViolations(code), []);
});

test("an unfamiliar value is left to the runtime, so a newer enum is not blocked", () => {
  assert.deepEqual(findEnumLiteralViolations('n.layoutMode = "MOSAIC";'), []);
  assert.deepEqual(findEnumLiteralViolations('n.overflowDirection = "SOMETHING_NEW";'), []);
});

test("comments and quoted prose are not assignments", () => {
  const code = [
    '// list.overflowDirection = "VERTICAL_SCROLLING";',
    '/* list.overflowDirection = "VERTICAL_SCROLLING"; */',
    'const note = "list.overflowDirection = \'VERTICAL_SCROLLING\'";',
    "const tpl = `list.overflowDirection = \"VERTICAL_SCROLLING\"`;",
  ].join("\n");
  assert.deepEqual(findEnumLiteralViolations(code), []);
});

test("a value from a variable is left to the runtime and the prelude", () => {
  const code = [
    "const dir = pick();",
    "list.overflowDirection = dir;",
    'list.layoutMode = dir === "row" ? "HORIZONTAL" : "VERTICAL";',
  ].join("\n");
  assert.deepEqual(findEnumLiteralViolations(code), []);
});

test("comparisons are not assignments", () => {
  const code = [
    'if (node.layoutMode === "COLUMN") log(node);',
    'const same = node.layoutMode == "COLUMN";',
    'const arrow = (x) => "VERTICAL_SCROLLING";',
  ].join("\n");
  assert.deepEqual(findEnumLiteralViolations(code), []);
});

test("reports several violations in source order with line numbers", () => {
  const code = [
    'n.layoutMode = "COLUMN";',
    'n.alignItems = "CENTER";',
    'n.textAutoResize = "AUTO";',
    'n.overflowDirection = "BOTH";',
  ].join("\n");
  const found = findEnumLiteralViolations(code);
  assert.deepEqual(found.map((v) => [v.line, v.property, v.suggestion]), [
    [1, "layoutMode", "VERTICAL"],
    [3, "textAutoResize", "HEIGHT"],
  ]);
});

test("the refusal says nothing ran and names the accepted values", () => {
  const msg = formatEnumViolations(findEnumLiteralViolations('n.overflowDirection = "VERTICAL_SCROLLING";'));
  assert.match(msg, /refused before sending/);
  assert.match(msg, /Nothing was sent, so nothing changed and nothing was rolled back/);
  assert.match(msg, /accepted: NONE \| HORIZONTAL \| VERTICAL \| BOTH/);
  assert.match(msg, /Use "VERTICAL"/);
  assert.match(msg, /setEnum\(node, property, value\)/);
});

test("the guard table and the prelude table are the same vocabulary", () => {
  const src = fs.readFileSync(preludePath, "utf8");
  const { ENUMS } = new Function(src + "\nreturn { ENUMS };")();
  assert.deepEqual(ENUMS, RUNTIME_ENUMS);
});
