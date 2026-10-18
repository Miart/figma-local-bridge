// The two figma_use safety paths that live in the plugin glue, where the scope
// guard alone cannot help:
//
//   1. TIMEOUT. The snippet is a zombie — `Promise.race` stopped waiting, but
//      the code keeps running and can write MORE. Rolling back at that moment
//      would undo its first write and then let its second write land on top of
//      the restored state, while telling the agent "(rolled back)".
//   2. PAGE SWITCH. The guard indexes ONE page. `figma.setCurrentPageAsync()`
//      inside the snippet moves the ground under it: edits on the other page are
//      invisible, and a round trip (switch away, edit, switch back) leaves the
//      indexed page byte-identical, so only the event can catch it.
//
// Driven against a mock `figma` — there is no other way to test a timeout that
// finishes after the timeout, and this is the path that writes to a real file.

import { test } from "node:test";
import assert from "node:assert/strict";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The smallest figma a use_figma call touches. `notifyChange` stands in for the
 * `nodechange` event Figma fires by itself after a write, and
 * `setCurrentPageAsync` fires `currentpagechange` the way the real API does.
 */
function mockFigma() {
  const state = { commits: 0, undos: 0, pageChanges: 0 };
  const figmaHandlers = new Set();

  const makePage = (id, name) => {
    const handlers = new Set();
    return {
      id, type: "PAGE", name, children: [], parent: null,
      on: (t, h) => { if (t === "nodechange") handlers.add(h); },
      off: (t, h) => { if (t === "nodechange") handlers.delete(h); },
      _fire: () => { for (const h of [...handlers]) h(); },
    };
  };

  const first = makePage("0:1", "Page 1");
  const other = makePage("0:2", "Page 2");
  const scope = { id: "1:1", type: "FRAME", name: "SAFE", children: [], parent: first, x: 0, y: 0, width: 100, height: 100 };
  first.children.push(scope);

  const api = {
    currentPage: first,
    getNodeByIdAsync: async (id) => [scope, first, other].find((n) => n.id === id) || null,
    commitUndo: () => { state.commits++; },
    triggerUndo: () => { state.undos++; },
    setCurrentPageAsync: async (p) => {
      state.pageChanges++;
      api.currentPage = p;
      for (const h of [...figmaHandlers]) h();
    },
    on: (t, h) => { if (t === "currentpagechange") figmaHandlers.add(h); },
    off: (t, h) => { if (t === "currentpagechange") figmaHandlers.delete(h); },
    /** Stands in for the nodechange Figma sends after a write on a page. */
    notifyChange: (n, page) => {
      let p = page || (n && n.parent);
      while (p && !p._fire) p = p.parent;
      (p || api.currentPage)._fire();
    },
    _firstPage: first,
    _otherPage: other,
    _scope: scope,
  };
  return { api, state, first, other, scope };
}

/**
 * Writes one node under `parentExpr` and tells Figma about it. Braced: one
 * snippet may contain several writes, and each would otherwise redeclare `n`.
 */
const write = (id, name, parentExpr = "figma.currentPage") => `{
  const n = { id: ${JSON.stringify(id)}, type: "RECTANGLE", name: ${JSON.stringify(name)}, characters: "", children: [], parent: ${parentExpr}, x: 0, y: 0, width: 10, height: 10 };
  ${parentExpr}.children.push(n);
  figma.notifyChange(n);
}`;

test("a timeout does NOT roll back, and the zombie's later write really lands", async () => {
  const { api, state, first } = mockFigma();
  globalThis.figma = api;
  const { toolMethods } = await import("../plugin/tools.mjs");

  await assert.rejects(
    toolMethods.use_figma({
      code: write("9:1", "early") + "await new Promise((r) => setTimeout(r, 1400));" + write("9:2", "late"),
      allowDestructive: true,
      scopeNodeId: "1:1",
      timeoutMs: 1000,
    }),
    (err) => {
      assert.match(err.message, /timed out after 1000ms/);
      assert.match(err.message, /NOT rolled back/);
      assert.match(err.message, /still running and may still write/);
      assert.doesNotMatch(err.message, /\(rolled back\)/);
      return true;
    },
  );
  assert.equal(state.undos, 0, "a rollback here is what the zombie would have written on top of");

  // The reason the refusal is honest rather than merely cautious: the second
  // write really does arrive after we stopped waiting.
  await sleep(700);
  assert.deepEqual(first.children.map((n) => n.name), ["SAFE", "early", "late"]);
});

test("an ordinary failure still rolls back and says so", async () => {
  const { api, state } = mockFigma();
  globalThis.figma = api;
  const { toolMethods } = await import("../plugin/tools.mjs");

  await assert.rejects(
    toolMethods.use_figma({
      code: write("9:1", "doomed") + "throw new Error('nope');",
      allowDestructive: true,
      scopeNodeId: "1:1",
      timeoutMs: 5000,
    }),
    (err) => {
      assert.match(err.message, /nope/);
      assert.match(err.message, /\(rolled back\)/);
      return true;
    },
  );
  assert.equal(state.undos, 1, "one undo for a failure that had written");
});

test("switching the page inside the snippet is refused and rolled back", async () => {
  const { api, state, first, other } = mockFigma();
  globalThis.figma = api;
  const { toolMethods } = await import("../plugin/tools.mjs");

  await assert.rejects(
    toolMethods.use_figma({
      // Switch away, write there, switch back — the round trip that leaves the
      // guarded page untouched and would otherwise pass every check.
      code:
        "await figma.setCurrentPageAsync(figma._otherPage);" +
        write("9:1", "elsewhere") +
        "await figma.setCurrentPageAsync(figma._firstPage);",
      allowDestructive: true,
      scopeNodeId: "1:1",
      timeoutMs: 5000,
    }),
    (err) => {
      assert.match(err.message, /REFUSED and rolled back/);
      assert.match(err.message, /current page changed/);
      assert.match(err.message, /Do not switch pages inside use_figma/);
      return true;
    },
  );
  assert.equal(state.pageChanges, 2);
  assert.equal(state.undos, 1, "the switch is a violation, so the call is undone");
  assert.equal(state.commits, 2, "commitUndo brackets the refusal, as for any violation");
  assert.deepEqual(first.children.map((n) => n.name), ["SAFE"], "the guarded page never changed");
  assert.deepEqual(other.children.map((n) => n.name), ["elsewhere"], "the write landed on the other page");
});

test("a snippet that is simply slow is allowed to finish", async () => {
  const { api, state, first, scope } = mockFigma();
  globalThis.figma = api;
  const { toolMethods } = await import("../plugin/tools.mjs");

  const out = await toolMethods.use_figma({
    code: write("9:1", "patient", "figma._scope") + "await new Promise((r) => setTimeout(r, 300)); return 'done';",
    allowDestructive: true,
    scopeNodeId: "1:1",
    timeoutMs: 5000,
  });
  assert.equal(out.result, "done");
  assert.equal(state.undos, 0);
  assert.equal(state.commits, 2, "one to open the step, one to close it");
  assert.deepEqual(scope.children.map((n) => n.name), ["patient"], "the write stayed inside the declared scope");
  assert.deepEqual(first.children.map((n) => n.name), ["SAFE"]);
});
