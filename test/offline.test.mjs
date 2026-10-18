// The offline contract.
//
// The old behaviour: a tool call made while the plugin was away waited 15 s in
// callOnce and another 15 s in the retry loop before failing, so the agent sat
// there for 30 s and then read a message about the wrong cause. These tests pin
// the replacement:
//
//   * a call with no plugin is never sent, and fails after ONE bounded grace
//   * the same is true when the daemon socket itself is gone
//   * a plugin that comes back inside the grace is still waited for — the
//     bounded wait must not turn a normal flap into an error
//   * when retries are exhausted, the message may not claim the work was never
//     attempted; nobody knows whether the snippet ran
//
// The grace is a real 2 s timer, so these tests take a few seconds. That is the
// point: they fail if someone raises the constant back towards 15 s.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FigmaClient } from "../server/dist/figma.js";
import { BridgeOffline, BridgeNotPaired } from "../server/dist/websocket.js";

/** The grace in server/src/figma.ts. Kept in sync by the assertions below. */
const GRACE_MS = 2000;
/** A call may wait the grace once; twice means the old 30 s bug is back. */
const MAX_MS = GRACE_MS + 1000;

/** Link stand-in, as in retry.test.mjs. Default state: socket up, no plugin. */
class FakeLink {
  constructor() {
    this.sent = [];
    this.handlers = [];
    this._connected = true;
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
  }
  emit(env) {
    for (const h of this.handlers) h(env);
  }
  /** Plugin pairs: the daemon's authoritative "link" event. */
  pair() {
    this.emit({ event: "link", connected: true });
  }
  dropPlugin() {
    this.emit({ event: "link", connected: false });
  }
  /** The daemon socket itself goes away. */
  dropDaemon() {
    this._connected = false;
    this.emit({ event: "link", connected: false });
  }
  raiseDaemon() {
    this._connected = true;
  }
}

const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("with no plugin paired the call is never sent and fails after one grace", async () => {
  const link = new FakeLink();
  const client = new FigmaClient(link);

  const t0 = Date.now();
  await assert.rejects(client.call("inspect", { nodeId: "1:2" }, 5000), (err) => {
    assert.equal(err.name, "BridgeNotPaired");
    assert.ok(err instanceof BridgeOffline, "still an offline error for the tool guard");
    assert.match(err.message, /FIGMA_BRIDGE_OFFLINE/);
    assert.match(err.message, /no Figma plugin is paired/);
    assert.match(err.message, /inspect was not sent/);
    return true;
  });
  const elapsed = Date.now() - t0;

  assert.equal(link.sent.length, 0, "nothing may reach the wire");
  assert.ok(elapsed < MAX_MS, `waited ${elapsed}ms — one grace, not two`);
});

test("with the daemon socket down the call is never sent and fails after one grace", async () => {
  const link = new FakeLink();
  link.dropDaemon();
  const client = new FigmaClient(link);

  const t0 = Date.now();
  await assert.rejects(client.call("get_metadata", { nodeId: "1:2" }, 5000), (err) => {
    assert.equal(err.name, "BridgeNotPaired");
    assert.match(err.message, /no socket to the bridge daemon/);
    return true;
  });
  const elapsed = Date.now() - t0;

  assert.equal(link.sent.length, 0);
  assert.ok(elapsed < MAX_MS, `waited ${elapsed}ms`);
});

test("a plugin that returns inside the grace is waited for, not failed", async () => {
  const link = new FakeLink();
  const client = new FigmaClient(link);

  const pending = client.call("ping", {}, 5000);
  await sleep(150); // well inside the grace
  assert.equal(link.sent.length, 0, "not sent while there is no plugin");

  link.pair();
  await tick();
  await tick();
  assert.equal(link.sent.length, 1, "the call goes out the moment the plugin pairs");

  link.emit({ id: link.sent[0].id, ok: true, result: { ok: true, editor: "figma" } });
  assert.deepEqual(await pending, { ok: true, editor: "figma" });
});

test("the daemon returning inside the grace is also waited for", async () => {
  const link = new FakeLink();
  link.dropDaemon();
  const client = new FigmaClient(link);

  const pending = client.call("ping", {}, 5000);
  await sleep(150);

  link.raiseDaemon();
  link.pair();
  await tick();
  await tick();
  assert.equal(link.sent.length, 1);

  link.emit({ id: link.sent[0].id, ok: true, result: { ok: true } });
  assert.deepEqual(await pending, { ok: true });
});

test("a mid-flight drop that never recovers does not claim the work was not attempted", async () => {
  const link = new FakeLink();
  const client = new FigmaClient(link);
  link.pair();

  const pending = client.call("use_figma", { code: "figma.createFrame()" }, 5000);
  await tick();
  assert.equal(link.sent.length, 1, "the first attempt went out");

  link.dropPlugin(); // still in flight: nothing came back for it
  const t0 = Date.now();

  await assert.rejects(pending, (err) => {
    assert.equal(err.name, "BridgeNotPaired");
    assert.match(err.message, /may or may not have been applied/, "the dangerous possibility is kept");
    assert.match(err.message, /was not re-sent/);
    assert.doesNotMatch(err.message, /unattempted/, "the first attempt DID reach the plugin");
    return true;
  });

  const elapsed = Date.now() - t0;
  assert.equal(link.sent.length, 1, "no second attempt after the grace");
  assert.ok(elapsed < MAX_MS, `waited ${elapsed}ms`);
});
