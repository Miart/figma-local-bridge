// Dispatch contract: the plugin side of retry safety.
//
// Two failures this guards against, both of which damage a document quietly:
//
//   * a retry arriving while the first attempt is STILL RUNNING used to find an
//     empty cache and execute the same snippet a second time, concurrently
//   * two mutations in flight at once share ONE global undo boundary
//     (figma.commitUndo/triggerUndo), so one call's rollback can revert the
//     other's edits
//
// The module is pure — no `figma` — because a bug here is invisible until it has
// already written to a real file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Dispatcher } from "../plugin/dispatch.mjs";
import { MUTATING_METHODS, toolMethods } from "../plugin/tools.mjs";

const tick = () => new Promise((r) => setImmediate(r));

/** A promise the test releases by hand, to hold a call open mid-flight. */
function gate() {
  let open;
  const promise = new Promise((res) => { open = res; });
  return { promise, open };
}

/** Counter standing in for plugin/rev.ts. */
function counter() {
  let n = 0;
  return () => ++n;
}

const body = (reply) => ({ ok: reply.ok, result: reply.result, error: reply.error });

test("a retry while the first attempt is still running joins it instead of re-running", async () => {
  const calls = [];
  const hold = gate();
  const d = new Dispatcher({
    run: async (method) => {
      calls.push(method);
      await hold.promise;
      return { created: 1 };
    },
    mutating: new Set(["use_figma"]),
    bump: counter(),
  });

  const first = d.handle({ id: "a1", method: "use_figma", opId: "op1", params: { code: "x" } });
  const retry = d.handle({ id: "a2", method: "use_figma", opId: "op1", params: { code: "x" } });
  await tick();
  assert.equal(calls.length, 1, "the snippet must run exactly once while it is in flight");

  hold.open();
  const [r1, r2] = await Promise.all([first, retry]);

  assert.deepEqual(r1.result, { created: 1 });
  assert.deepEqual(r2.result, { created: 1 }, "the retry gets the same answer");
  assert.equal(r1.replayed, undefined, "the attempt that did the work is not a replay");
  assert.equal(r2.replayed, true);
  assert.equal(r2.id, "a2", "each attempt answers under its own transport id");
  assert.equal(r1.id, "a1");
});

test("a retry after completion replays from the cache and touches nothing", async () => {
  let calls = 0;
  const d = new Dispatcher({
    run: async () => { calls++; return { ok: 1 }; },
    mutating: new Set(["use_figma"]),
    bump: counter(),
  });

  const r1 = await d.handle({ id: "a1", method: "use_figma", opId: "op1" });
  const r2 = await d.handle({ id: "a2", method: "use_figma", opId: "op1" });

  assert.equal(calls, 1);
  assert.equal(r2.replayed, true);
  assert.deepEqual(body(r1), body(r2));
});

test("distinct opIds are distinct work", async () => {
  const seen = [];
  const d = new Dispatcher({
    run: async (method, params) => { seen.push(params.n); return { n: params.n }; },
    mutating: new Set(["use_figma"]),
    bump: counter(),
  });

  const a = await d.handle({ id: "a", method: "use_figma", opId: "op-a", params: { n: 1 } });
  const b = await d.handle({ id: "b", method: "use_figma", opId: "op-b", params: { n: 2 } });

  assert.deepEqual(seen, [1, 2]);
  assert.equal(a.result.n, 1);
  assert.equal(b.result.n, 2);
});

test("two mutations never interleave — the second starts only after the first ends", async () => {
  const log = [];
  const holds = { use_figma: gate(), import_images: gate() };
  const d = new Dispatcher({
    run: async (method) => {
      log.push(`${method}:start`);
      await holds[method].promise;
      log.push(`${method}:end`);
      return {};
    },
    mutating: new Set(["use_figma", "import_images"]),
    bump: counter(),
  });

  const a = d.handle({ id: "a", method: "use_figma", opId: "op-a" });
  const b = d.handle({ id: "b", method: "import_images", opId: "op-b" });
  await tick();
  assert.deepEqual(log, ["use_figma:start"], "the second write waits, it does not start");

  holds.use_figma.open();
  await tick();
  await tick();
  assert.deepEqual(log, ["use_figma:start", "use_figma:end", "import_images:start"],
    "and it starts exactly once the first is done");

  holds.import_images.open();
  await Promise.all([a, b]);
  assert.deepEqual(log, ["use_figma:start", "use_figma:end", "import_images:start", "import_images:end"]);
});

test("a read does not queue behind a mutation", async () => {
  const hold = gate();
  const d = new Dispatcher({
    run: async (method) => {
      if (method === "use_figma") await hold.promise;
      return { method };
    },
    mutating: new Set(["use_figma"]),
    bump: counter(),
  });

  const write = d.handle({ id: "w", method: "use_figma", opId: "op-w" });
  await tick();

  const read = await d.handle({ id: "r", method: "get_metadata", opId: "op-r" });
  assert.equal(read.result.method, "get_metadata", "the read answered while the write is blocked");

  hold.open();
  await write;
});

test("a failed mutation does not poison the queue", async () => {
  const log = [];
  const d = new Dispatcher({
    run: async (method) => {
      log.push(method);
      if (method === "use_figma") throw new Error("boom");
      return { fine: true };
    },
    mutating: new Set(["use_figma", "import_images"]),
    bump: counter(),
  });

  const a = d.handle({ id: "a", method: "use_figma", opId: "op-a" });
  const b = d.handle({ id: "b", method: "import_images", opId: "op-b" });
  const [ra, rb] = await Promise.all([a, b]);

  assert.equal(ra.ok, false);
  assert.match(ra.error.message, /boom/);
  assert.equal(rb.ok, true);
  assert.deepEqual(log, ["use_figma", "import_images"]);
});

test("a failed call is cached: its retry gets the same error, not a second attempt", async () => {
  let calls = 0;
  const d = new Dispatcher({
    run: async () => { calls++; throw new Error("refused"); },
    mutating: new Set(["use_figma"]),
    bump: counter(),
  });

  const r1 = await d.handle({ id: "a1", method: "use_figma", opId: "op1" });
  const r2 = await d.handle({ id: "a2", method: "use_figma", opId: "op1" });

  assert.equal(calls, 1);
  assert.equal(r1.ok, false);
  assert.equal(r2.replayed, true);
  assert.deepEqual(body(r1), body(r2));
});

test("rev advances on failure too — a rolled-back document is not the state the agent saw", async () => {
  const d = new Dispatcher({
    run: async (method) => {
      if (method === "use_figma") throw new Error("rolled back");
      return {};
    },
    mutating: new Set(["use_figma", "get_metadata"]),
    bump: counter(),
  });

  const ok = await d.handle({ id: "a", method: "get_metadata", opId: "op-ok" });
  const bad = await d.handle({ id: "b", method: "use_figma", opId: "op-bad" });

  assert.equal(ok.rev, 1);
  assert.equal(bad.rev, 2, "a failure still moves the counter forward");
});

test("the cache is bounded, oldest first", async () => {
  const calls = [];
  const d = new Dispatcher({
    run: async (method, params) => { calls.push(params.n); return {}; },
    mutating: new Set(["use_figma"]),
    bump: counter(),
    limit: 2,
  });

  await d.handle({ id: "1", method: "use_figma", opId: "op-1", params: { n: 1 } });
  await d.handle({ id: "2", method: "use_figma", opId: "op-2", params: { n: 2 } });
  await d.handle({ id: "3", method: "use_figma", opId: "op-3", params: { n: 3 } });
  assert.deepEqual(calls, [1, 2, 3]);

  await d.handle({ id: "2b", method: "use_figma", opId: "op-2", params: { n: 2 } });
  assert.deepEqual(calls, [1, 2, 3], "the newest entries are still cached");

  await d.handle({ id: "1b", method: "use_figma", opId: "op-1", params: { n: 1 } });
  assert.deepEqual(calls, [1, 2, 3, 1], "the oldest entry was evicted and is re-executed");
});

test("a retry arriving while the call is still QUEUED coalesces with it", async () => {
  const log = [];
  const hold = gate();
  const d = new Dispatcher({
    run: async (method) => {
      log.push(method);
      if (method === "use_figma") await hold.promise;
      return {};
    },
    mutating: new Set(["use_figma", "import_images"]),
    bump: counter(),
  });

  const a = d.handle({ id: "a", method: "use_figma", opId: "op-a" });
  const b = d.handle({ id: "b", method: "import_images", opId: "op-b" });
  const bRetry = d.handle({ id: "b2", method: "import_images", opId: "op-b" });
  await tick();

  hold.open();
  const [, rb, rb2] = await Promise.all([a, b, bRetry]);

  assert.deepEqual(log, ["use_figma", "import_images"], "the queued call ran once, not twice");
  assert.equal(rb2.replayed, true);
  assert.deepEqual(body(rb), body(rb2));
});

// The opId is an idempotency key, so it must keep naming the SAME call. Reusing
// it for a different one handed out the first call's answer — and for a write
// that means reporting an edit that was never made. It was the last way to get
// a silently wrong answer through a correct-looking path.
test("the same opId with different arguments is refused, not answered", async () => {
  const calls = [];
  const d = new Dispatcher({
    run: async (method, params) => { calls.push(params.n); return { n: params.n }; },
    mutating: new Set(["use_figma"]),
    bump: counter(),
    peek: () => 1,
  });

  const first = await d.handle({ id: "1", method: "use_figma", opId: "op-1", params: { n: 1 } });
  assert.deepEqual(first.result, { n: 1 });

  const other = await d.handle({ id: "2", method: "use_figma", opId: "op-1", params: { n: 2 } });
  assert.equal(other.ok, false);
  assert.match(other.error.message, /OPID_REUSED/);
  assert.equal(other.replayed, undefined, "a refusal is not a replay");
  assert.equal(other.rev, 1, "nothing ran, so the document did not move");
  assert.deepEqual(calls, [1], "the second call must not run under a used key");

  const still = await d.handle({ id: "3", method: "use_figma", opId: "op-1", params: { n: 1 } });
  assert.deepEqual(still.result, { n: 1 }, "the recorded answer survives the refusal");
  assert.equal(still.replayed, true);

  const wrongMethod = await d.handle({ id: "4", method: "import_images", opId: "op-1", params: { n: 1 } });
  assert.equal(wrongMethod.ok, false);
  assert.match(wrongMethod.error.message, /OPID_REUSED/, "a different method under one key is the same mistake");
});

test("a retry may re-encode its arguments: key order does not change the call", async () => {
  const calls = [];
  const d = new Dispatcher({
    run: async (method, params) => { calls.push(params); return { n: params.n }; },
    mutating: new Set(["use_figma"]),
    bump: counter(),
    peek: () => 1,
  });

  const a = await d.handle({ id: "1", method: "use_figma", opId: "op-9", params: { nodeId: "1:2", depth: 3 } });
  const b = await d.handle({ id: "2", method: "use_figma", opId: "op-9", params: { depth: 3, nodeId: "1:2" } });
  assert.equal(calls.length, 1, "the same call is replayed, not re-run");
  assert.equal(b.replayed, true);
  assert.deepEqual(body(b), body(a));
});

test("a different call under a key that is still in flight is refused at once", async () => {
  const hold = gate();
  const calls = [];
  const d = new Dispatcher({
    run: async (method, params) => { calls.push(params.code); await hold.promise; return { code: params.code }; },
    mutating: new Set(["use_figma"]),
    bump: counter(),
    peek: () => 0,
  });

  const a = d.handle({ id: "1", method: "use_figma", opId: "op-7", params: { code: "x" } });
  await tick();
  const other = await d.handle({ id: "2", method: "use_figma", opId: "op-7", params: { code: "y" } });
  assert.equal(other.ok, false);
  assert.match(other.error.message, /OPID_REUSED/);
  assert.deepEqual(calls, ["x"], "the refused attempt neither joined nor started a run");

  hold.open();
  const ra = await a;
  assert.deepEqual(ra.result, { code: "x" });
});

test("every declared mutating method exists on the tool table", () => {
  // A typo here is silent: the method simply would not be serialised. The
  // reverse mistake (a writer nobody listed) cannot be detected here — it is
  // what the comment above MUTATING_METHODS is for.
  assert.ok(MUTATING_METHODS.size > 0, "an empty set would serialise nothing");
  const names = new Set(Object.keys(toolMethods));
  for (const name of MUTATING_METHODS) {
    assert.ok(names.has(name), `${name} is not a method in plugin/tools.ts`);
  }
});
