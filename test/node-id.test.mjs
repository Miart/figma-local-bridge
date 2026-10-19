// Node-id validation, the pattern taken from gethopp/figma-mcp-bridge.
//
// The plugin resolves ids as strings, so a hyphenated id from a Figma URL
// ("4029-12345") travels all the way into Figma and comes back as "node not
// found" — a true statement that names the wrong problem. These tests pin the
// refusal at the tool edge and the message that says what to fix.

import { test } from "node:test";
import assert from "node:assert/strict";
import { figmaNodeId, figmaNodeIds } from "../server/dist/node-id.js";

const parse = (schema, value) => schema.safeParse(value);

test("top-level and instance-child ids are accepted", () => {
  for (const id of ["4029:12345", "0:1", "I12740:17806;12740:17793", "I1:2;3:4;5:6"]) {
    assert.equal(parse(figmaNodeId(), id).success, true, `rejected a valid id: ${id}`);
  }
});

test("a hyphenated URL id is refused with the fix spelled out", () => {
  const r = parse(figmaNodeId(), "4029-12345");
  assert.equal(r.success, false);
  assert.match(r.error.issues[0].message, /colon/, "the message must say what to do");
  assert.match(r.error.issues[0].message, /4029-12345/, "the message must name the offending form");
});

test("hyphenated ids are refused in every field that carries them", () => {
  assert.equal(parse(figmaNodeId("sourceId"), "1-2").success, false);
  assert.equal(parse(figmaNodeIds("compareWith"), ["1:2", "3-4"]).success, false);
  assert.match(parse(figmaNodeId("scopeNodeId"), "1-2").error.issues[0].message, /^scopeNodeId/);
});

test("garbage is refused rather than forwarded to Figma", () => {
  for (const bad of ["", "4029", "abc", "4029:", ":12345", "4029:12345 ", "4029:12a", "i1:2;3:4", "4029:12345;", "4029-12345"]) {
    assert.equal(parse(figmaNodeId(), bad).success, false, `accepted: ${JSON.stringify(bad)}`);
  }
});

test("node id lists require at least one id", () => {
  assert.equal(parse(figmaNodeIds(), ["1:2"]).success, true);
  assert.equal(parse(figmaNodeIds(), []).success, false);
});
