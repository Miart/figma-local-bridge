import test from "node:test";
import assert from "node:assert/strict";
import { runIndex, runSearch } from "../plugin/index.mjs";
import { BUILD_DATA, KEY_DATA } from "../plugin/ui-build.mjs";

let seq = 0;

function node(opts = {}) {
  const n = {
    id: opts.id || `${++seq}:${seq}`,
    type: opts.type || "FRAME",
    name: opts.name || "Node",
    visible: opts.visible !== false,
    width: opts.width === undefined ? 100 : opts.width,
    height: opts.height === undefined ? 40 : opts.height,
    characters: opts.characters,
    children: [],
    parent: opts.parent || null,
    removed: false,
    pluginData: { ...(opts.pluginData || {}) },
    getPluginData(k) { return this.pluginData[k] || ""; },
    setPluginData(k, v) { this.pluginData[k] = String(v); },
  };
  for (const child of opts.children || []) {
    child.parent = n;
    n.children.push(child);
  }
  return n;
}

function fixture() {
  const hud = node({
    type: "FRAME", name: "HUD",
    pluginData: { [BUILD_DATA]: "hud", [KEY_DATA]: "hud" },
  });
  const score = node({
    type: "TEXT", name: "Score", characters: "Score 42", parent: hud,
    pluginData: { [KEY_DATA]: "hud/score#0" },
  });
  const secret = node({
    type: "TEXT", name: "Secret", characters: "hidden", parent: hud,
    visible: false, pluginData: { [KEY_DATA]: "hud/secret#1" },
  });
  const row = node({
    type: "FRAME", name: "Row", parent: hud,
    pluginData: { [KEY_DATA]: "hud/row#2" },
  });
  const bar = node({
    type: "RECTANGLE", name: "Bar", parent: row,
    pluginData: { [KEY_DATA]: "hud/row/bar#0" },
  });
  const loose = node({ type: "TEXT", name: "Loose", characters: "TODO copy", parent: row });
  hud.children = [score, secret, row];
  row.children = [bar, loose];
  const page = node({ type: "PAGE", name: "Page 1", children: [hud] });
  hud.parent = page;
  const ctx = { currentPage: page, mixed: Symbol("mixed") };
  return { ctx, page, hud, score, secret, row, bar, loose };
}

test("index is a flat document-order list with keys, paths and sizes", async () => {
  const { ctx, hud, score, row, bar } = fixture();
  const report = await runIndex(ctx, {});
  assert.equal(report.schema, "index-v1");
  assert.equal(report.scope.type, "PAGE");
  assert.deepEqual(report.nodes.map((n) => n.name), ["HUD", "Score", "Row", "Bar", "Loose"]);
  const scoreInfo = report.nodes.find((n) => n.id === score.id);
  assert.equal(scoreInfo.key, "hud/score#0");
  assert.equal(scoreInfo.path, "Page 1 / HUD / Score");
  assert.equal(scoreInfo.depth, 1);
  assert.equal(scoreInfo.text, undefined);
  assert.equal(scoreInfo.size[0], 100);
  assert.equal(scoreInfo.build.buildId, "hud");
  assert.equal(report.nodes.find((n) => n.id === hud.id).build.buildId, "hud");
  assert.equal(report.nodes.find((n) => n.id === row.id).build.id, hud.id);
  assert.equal(report.nodes.find((n) => n.id === bar.id).key, "hud/row/bar#0");
  assert.equal(report.counts.byType.TEXT, 2);
});

test("index can include hidden layers, text and a depth limit", async () => {
  const { ctx } = fixture();
  const visible = await runIndex(ctx, { includeHidden: true, includeText: true, maxDepth: 1 });
  assert.deepEqual(visible.nodes.map((n) => n.name), ["HUD", "Score", "Secret", "Row"]);
  assert.equal(visible.nodes.find((n) => n.name === "Score").text, "Score 42");
});

test("index truncates at maxNodes and says so", async () => {
  const { ctx } = fixture();
  const report = await runIndex(ctx, { maxNodes: 2 });
  assert.equal(report.nodes.length, 2);
  assert.equal(report.truncated, true);
  assert.ok(report.warnings[0].includes("node cap 2"));
});

test("search matches name, key and text and reports where", async () => {
  const { ctx, score, bar } = fixture();
  const byName = await runSearch(ctx, { query: "score" });
  assert.equal(byName.schema, "search-v1");
  assert.deepEqual(byName.matches.map((m) => m.id), [score.id]);
  assert.deepEqual(byName.matches[0].matchedIn, ["name", "key", "text"]);
  assert.equal(byName.matches[0].snippet, "Score 42");

  const byText = await runSearch(ctx, { query: "42" });
  assert.deepEqual(byText.matches.map((m) => m.id), [score.id]);
  assert.deepEqual(byText.matches[0].matchedIn, ["text"]);

  const byKey = await runSearch(ctx, { query: "row/bar", fields: ["key"] });
  assert.deepEqual(byKey.matches.map((m) => m.id), [bar.id]);
  assert.deepEqual(byKey.matches[0].matchedIn, ["key"]);
});

test("search supports filters, regex, glob and hidden layers", async () => {
  const { ctx, bar, loose, secret } = fixture();
  const rects = await runSearch(ctx, { types: ["RECTANGLE"] });
  assert.deepEqual(rects.matches.map((m) => m.id), [bar.id]);
  assert.deepEqual(rects.matches[0].matchedIn, []);

  const regex = await runSearch(ctx, { query: "^S.ore$", mode: "regex" });
  assert.deepEqual(regex.matches.map((m) => m.id), [fixtureScore(ctx)]);
  assert.ok(regex.matches.every((m) => m.matchedIn.includes("name")));

  const glob = await runSearch(ctx, { query: "Ba*", mode: "glob" });
  assert.deepEqual(glob.matches.map((m) => m.id), [bar.id]);

  const hidden = await runSearch(ctx, { query: "hidden" });
  assert.deepEqual(hidden.matches.map((m) => m.id), [secret.id]);

  const unkeyed = await runSearch(ctx, { hasKey: false });
  assert.deepEqual(unkeyed.matches.map((m) => m.id), [loose.id]);
});

function fixtureScore(ctx) {
  return ctx.currentPage.children[0].children[0].id;
}

test("search refuses an unsafe empty query and an invalid regex", async () => {
  const { ctx } = fixture();
  await assert.rejects(() => runSearch(ctx, {}), /needs a query/);
  await assert.rejects(() => runSearch(ctx, { query: "[", mode: "regex" }), /invalid regex/);
});

test("search truncates results but keeps the total count", async () => {
  const { ctx } = fixture();
  const report = await runSearch(ctx, { query: "hud", maxResults: 1 });
  assert.equal(report.matches.length, 1);
  assert.ok(report.resultsTruncated > 0);
  assert.ok(report.counts.matches > 1);
  assert.ok(report.warnings.some((w) => w.includes("more matches")));
});
