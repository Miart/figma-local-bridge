// The retry contract.
//
// Figma tears the plugin down and brings it back several times a second in a
// heavy document, so a call that dies with the socket gets retried. The danger
// is the mutating ones: a retried `use_figma` re-runs the same snippet and
// duplicates everything it created. The defence is that the opId is minted once
// per logical call and reused by every attempt, so the plugin can recognise the
// repeat and replay its recorded answer.
//
// These tests pin that contract, because a regression here corrupts a design
// file silently rather than loudly.

import "./helpers/journal-dir.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FigmaClient } from "../server/dist/figma.js";

/** Minimal Link stand-in: records what was sent and lets the test push envelopes. */
class FakeLink {
  constructor() {
    this.sent = [];
    this.handlers = [];
    this._connected = true;
    /** Optional hook run inside send(), to simulate a drop mid-handshake. */
    this.onSend = null;
  }
  subscribe(fn) {
    this.handlers.push(fn);
  }
  get connected() {
    return this._connected;
  }
  send(msg) {
    if (!this._connected) throw new Error("socket closed");
    this.sent.push(msg);
    if (this.onSend) this.onSend(this);
  }
  emit(env) {
    for (const h of this.handlers) h(env);
  }
  /** Bring the client up, the way the daemon does when the plugin pairs. */
  pair() {
    this.emit({ event: "link", connected: true });
  }
  drop() {
    this._connected = false;
    this.emit({ event: "link", connected: false });
  }
  raise() {
    this._connected = true;
    this.emit({ event: "link", connected: true });
  }
}

const tick = () => new Promise((r) => setImmediate(r));

/** A client whose plugin is already paired and ready. */
function paired() {
  const link = new FakeLink();
  const client = new FigmaClient(link);
  link.pair();
  return { link, client };
}

test("a dropped call is retried under the SAME opId but a NEW request id", async () => {
  const { link, client } = paired();

  const pending = client.call("use_figma", { code: "figma.createFrame()" }, 5000);
  await tick();
  assert.equal(link.sent.length, 1, "first attempt went out");
  const first = link.sent[0];

  // The plugin drops with the call in flight, then comes back.
  link.drop();
  pending.catch(() => {});
  link.raise();
  await tick();
  await tick();

  assert.equal(link.sent.length, 2, "second attempt went out");
  const second = link.sent[1];

  assert.equal(second.opId, first.opId, "opId must survive the retry — this is what stops a double apply");
  assert.notEqual(second.id, first.id, "each attempt needs its own transport id to match the reply");
  assert.deepEqual(second.params, first.params, "the same work is being asked for");

  link.emit({ id: second.id, ok: true, result: { changed: 1 } });
  assert.deepEqual(await pending, { changed: 1 });
});

test("exhausting the retries still reports that the work may have been applied", async () => {
  const { link, client } = paired();

  const pending = client.call("use_figma", { code: "figma.createFrame()" }, 5000);
  pending.catch(() => {});

  // Drop and restore five times: every attempt dies in flight, the link is back
  // in time to be retried, and the loop runs out.
  for (let i = 0; i < 5; i++) {
    await tick();
    link.drop();
    link.raise();
    await tick();
  }

  // The retry budget is spent, and the message has to say the dangerous thing:
  // nobody knows whether that snippet ran once, twice, or not at all.
  await assert.rejects(pending, (err) => {
    assert.match(err.message, /may or may not have been applied/);
    assert.match(err.message, /Gave up on use_figma after 5 attempts/);
    assert.match(err.message, new RegExp(`op ${link.sent[0].opId}`), "names the operation for diagnosis");
    return true;
  });
});

test("a drop before the write still retries under the same opId", async () => {
  const { link, client } = paired();

  // The socket dies inside send(), before `sent` is set — the narrow window the
  // flag exists for. Nothing was applied, so the retry is unambiguously safe.
  link.onSend = (l) => {
    l.onSend = null;
    l.drop();
  };

  const pending = client.call("replace_repeated_with_component", { ids: ["1:1"] }, 5000);
  await tick();

  const first = link.sent[0];
  pending.catch(() => {});

  link.raise();
  await tick();
  await tick();

  assert.equal(link.sent.length, 2, "it retried once the plugin was back");
  assert.equal(link.sent[1].opId, first.opId, "same logical work, so same opId");

  link.emit({ id: link.sent[1].id, ok: true, result: { replaced: 3 } });
  assert.deepEqual(await pending, { replaced: 3 });
});

test("a retried call succeeds and returns the plugin's answer", async () => {
  const { link, client } = paired();

  const pending = client.call("get_metadata", { nodeId: "1:2" }, 5000);
  await tick();

  link.drop();
  pending.catch(() => {});

  link.raise();
  await tick();
  await tick();

  const retry = link.sent[1];
  link.emit({ id: retry.id, ok: true, result: { nodeId: "1:2", name: "Frame 1" } });

  assert.deepEqual(await pending, { nodeId: "1:2", name: "Frame 1" });
});

test("a non-drop error is not retried — it is thrown straight through", async () => {
  const { link, client } = paired();

  const pending = client.call("use_figma", { code: "throw new Error('boom')" }, 5000);
  await tick();

  const first = link.sent[0];
  link.emit({ id: first.id, ok: false, error: { message: "boom" } });

  // A script that throws did what it was asked to do and failed cleanly. Trying
  // again would only produce the same error, possibly after a partial write.
  await assert.rejects(pending, /boom/);
  assert.equal(link.sent.length, 1, "exactly one attempt");
});

test("every logical call gets its own opId", async () => {
  const { link, client } = paired();

  const a = client.call("get_metadata", { nodeId: "1:1" }, 5000);
  const b = client.call("get_metadata", { nodeId: "1:2" }, 5000);
  await tick();

  // Sharing an opId across distinct calls would make the plugin answer the
  // second one with the first one's cached result.
  assert.notEqual(link.sent[0].opId, link.sent[1].opId);

  link.emit({ id: link.sent[0].id, ok: true, result: { nodeId: "1:1" } });
  link.emit({ id: link.sent[1].id, ok: true, result: { nodeId: "1:2" } });
  assert.deepEqual(await a, { nodeId: "1:1" });
  assert.deepEqual(await b, { nodeId: "1:2" });
});

// A call whose timeout fires is the dangerous kind of unknown: the plugin may be
// running it right now, or waiting to run it behind another write. The old code
// dropped the pending entry and forgot the call entirely, so the answer — the
// one thing that settles it — vanished. These pin the trail instead.

test("a timed-out call stays visible, and its late answer is recorded", async () => {
  const { link, client } = paired();

  const pending = client.call("use_figma", { code: "figma.createFrame()" }, 30);
  await tick();
  const sent = link.sent[0];

  await assert.rejects(pending, (err) => {
    assert.match(err.message, /bridge timeout after 30ms/);
    assert.match(err.message, new RegExp(`op ${sent.opId}`), "the opId is the handle for everything that follows");
    assert.match(err.message, /figma_ops/, "and the message says how to settle it");
    assert.match(err.message, /figma_cancel/, "including stopping it while it is still queued");
    return true;
  });

  const abandoned = client.abandonedOps();
  assert.equal(abandoned.length, 1, "the call is not forgotten");
  assert.equal(abandoned[0].opId, sent.opId);
  assert.equal(abandoned[0].method, "use_figma");
  assert.equal(abandoned[0].answer, null, "nothing has come back yet, and it says so");
  assert.ok(abandoned[0].waitedMs >= 30, "it remembers how long it waited");

  // The plugin finishes the write the caller gave up on, a moment too late.
  link.emit({ id: sent.id, ok: true, rev: 412, result: { created: 3 } });
  const settled = client.abandonedOps()[0];
  assert.deepEqual(settled.answer, { ok: true, rev: 412 }, "the late answer is kept, not dropped on the floor");
});

test("a late failure is recorded as a failure, with the plugin's own message", async () => {
  const { link, client } = paired();

  const pending = client.call("replace_repeated_with_component", { ids: ["1:1"] }, 20);
  await tick();
  const sent = link.sent[0];
  await assert.rejects(pending, /bridge timeout/);

  link.emit({ id: sent.id, ok: false, rev: 9, error: { message: "TARGETS_NOT_EQUIVALENT" } });
  assert.deepEqual(client.abandonedOps()[0].answer, { ok: false, rev: 9, error: "TARGETS_NOT_EQUIVALENT" });
});

test("a call in flight is listed with its op, its file and how long it has been waiting", async () => {
  const { link, client } = paired();

  const pending = client.call("use_figma", { code: "x" }, 5000);
  await tick();

  const inFlight = client.inFlightOps();
  assert.equal(inFlight.length, 1);
  assert.equal(inFlight[0].method, "use_figma");
  assert.equal(inFlight[0].opId, link.sent[0].opId);
  assert.equal(inFlight[0].sent, true, "it is on the wire, so a timeout would mean \"may have run\"");
  assert.ok(inFlight[0].waitedMs >= 0);

  link.emit({ id: link.sent[0].id, ok: true, result: {} });
  await pending;
  assert.deepEqual(client.inFlightOps(), [], "and it leaves the list once answered");
  assert.deepEqual(client.abandonedOps(), [], "an answered call is not an abandoned one");
});

test("the abandoned trail is bounded — newest kept, oldest dropped", async () => {
  const { link, client } = paired();

  for (let i = 0; i < 25; i++) {
    // Each one really times out before the next starts, or nothing is abandoned.
    await assert.rejects(client.call("get_metadata", { nodeId: "1:1" }, 5), /bridge timeout/);
  }

  const abandoned = client.abandonedOps();
  assert.equal(abandoned.length, 20, "a trail, not a log");
  assert.equal(abandoned[abandoned.length - 1].opId, link.sent[link.sent.length - 1].opId, "the newest call is still there");
  assert.notEqual(abandoned[0].opId, link.sent[0].opId, "the oldest fell off the end");

  // An envelope nobody asked for must not throw or start answering anything.
  link.emit({ id: "not-a-request-we-know", ok: true, rev: 1 });
  assert.equal(client.abandonedOps().length, 20);
});