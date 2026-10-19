// The mascot's art block, as the panel consumes it.
//
// plugin/ui.html carries the art as an emitted JS block (scripts/mascot.py is
// the source; the block is never hand-edited) and renderMascot() relies on
// facts about it: ten rows per phase, blank cells exactly where the two pupils
// go, and a picture no wider than the panel's content. A hand edit that breaks
// any of those would still be valid HTML — the octopus would just be wrong on
// screen — so they are pinned here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
const ui = readFileSync(new URL("plugin/ui.html", root), "utf8");

const block = ui.match(/\/\/ >>> mascot art[^\n]*\n([\s\S]*?)\n\s*\/\/ <<< mascot art/);
assert.ok(block, "ui.html must carry the emitted mascot block between its markers");
const { ART, EYE_AT, EYES } = new Function(block[1] + "\nreturn { ART, EYE_AT, EYES };")();

const PHASES = ["a", "b", "d"];
const SHADES = new Set([" ", "░", "▒", "▓", "█"]);
const MOODS = ["ready", "busy", "look", "happy", "sad", "annoyed", "sleep"];

test("the mascot is one picture in three phases", () => {
  assert.deepEqual(Object.keys(ART), PHASES);
  for (const phase of PHASES) {
    const rows = ART[phase];
    assert.equal(rows.length, 10, `phase ${phase}: ten rows, like the panel's line count`);
    for (const row of rows) {
      for (const ch of row) assert.ok(SHADES.has(ch), `phase ${phase}: ${JSON.stringify(ch)} is not shade art`);
    }
  }
});

test("the eye sockets are blank in every phase and fit inside the art", () => {
  const { col, row, right } = EYE_AT;
  assert.ok(col >= 0 && right > col, "the left eye must come before the right one");
  for (const phase of PHASES) {
    const line = ART[phase][row];
    for (const c of [col, col + 1, right, right + 1]) {
      assert.equal(line[c] ?? " ", " ", `phase ${phase}: cell ${c} of row ${row} is the ${c === col || c === col + 1 ? "left" : "right"} pupil's seat, not art`);
    }
  }
});

test("every mood fills both eye sockets with two characters", () => {
  for (const mood of MOODS) {
    const eyes = EYES[mood];
    assert.ok(eyes, `mood ${mood} needs a pair of eyes`);
    assert.equal(eyes.length, 2, `mood ${mood}: one expression per eye`);
    for (const e of eyes) assert.equal(e.length, 2, `mood ${mood}: two characters per eye, ${JSON.stringify(e)} given`);
  }
});

test("the picture fits the panel's content width", () => {
  const width = Number(ui.match(/#mascot \{[^}]*font-size: (\d+)px/)[1]);
  const advance = 0.618 * width;                        // the panel's mono face (Menlo) at that size
  const content = Number(readFileSync(new URL("plugin/code.ts", root), "utf8").match(/const UI_WIDTH = (\d+)/)[1]) - 20;
  const widest = PHASES.reduce((w, p) => Math.max(w, ...ART[p].map((r) => r.length)), 0);
  assert.ok(widest * advance <= content,
    `${widest} cells x ${advance.toFixed(1)}px do not fit the panel's ${content}px of content`);
});
