import test from "node:test";
import assert from "node:assert/strict";
import { jsonText } from "../server/dist/tool-text.js";

test("small objects keep the readable pretty form", () => {
  const text = jsonText({ ok: true, count: 2 });
  assert.equal(text, '{\n  "ok": true,\n  "count": 2\n}');
});

test("strings pass through unchanged (XML, SVG and captions)", () => {
  const xml = '<frame id="1:2" />';
  assert.equal(jsonText(xml), xml);
});

test("large objects switch to compact JSON", () => {
  const value = { nodes: Array.from({ length: 5000 }, (_, i) => ({ id: `1:${i}`, name: `Layer ${i}` })) };
  const text = jsonText(value);
  assert.ok(text.length > 128 * 1024);
  assert.equal(text.includes("\n"), false, "whitespace would be pure overhead at this size");
  assert.deepEqual(JSON.parse(text), value);
});

test("undefined is represented instead of returning the string 'undefined'", () => {
  assert.equal(jsonText(undefined), "null");
});
