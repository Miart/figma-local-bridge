// Multi-file routing, client side.
//
// One daemon used to hold ONE plugin slot: the second Figma window was refused
// and the user had to close the first. Multi-file turns the slot into a map
// keyed by fileKey, and these tests pin the contract that makes it safe:
//
//   * with one file, fileKey may be omitted and the call routes to it
//   * with several files, omitting fileKey REFUSES before anything is sent —
//     never a guess, because a guess edits the wrong file
//   * fileKey is routing metadata: it must not reach the plugin payload
//   * an unknown fileKey is refused with the list of what IS connected
//   * one file disconnecting fails only its own in-flight calls, fast, without
//     the retry loop rewriting the story
//   * selection is answered per file, and refuses to guess as well
//
// Every refusal here is synchronous before the send, so these tests do not
// wait on timers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FigmaClient } from "../server/dist/figma.js";
import { BridgeOffline, BridgeNotPaired } from "../server/dist/websocket.js";

/** Link stand-in, as in offline.test.mjs. */
class FakeLink {
  constructor() {
    this.sent = [];
    this.handlers = [];
    this._connected = true;
  }
  subscribe(fn) {
    this.handlers.push(fn);
    return () => {};
  }
  get connected() {
    return this._connected;
  }
  send(env) {
    if (!this._connected) throw new Error("socket closed");
    this.sent.push(env);
  }
  close() {}
  emit(env) {
    for (const h of this.handlers) h(env);
  }
  /** The daemon's attach handshake: link state, then the files list. */
  pair(files) {
    this.emit({ id: null, event: "link", connected: true });
    if (files) this.emit({ id: null, event: "files", files });
  }
}

const tick = () => new Promise((r) => setImmediate(r));

const ATLAS = { fileKey: "atlas123", name: "Atlas", saved: true };
const LOBBY = { fileKey: "lobby456", name: "Lobby", saved: true };

function clientWith(files) {
  const link = new FakeLink();
  const client = new FigmaClient(link);
  link.pair(files);
  return { link, client };
}

test("with one file the fileKey may be omitted, and it never reaches the payload", async () => {
  const { link, client } = clientWith([ATLAS]);

  const pending = client.call("ping", {}, 5000);
  await tick();
  assert.equal(link.sent.length, 1);
  assert.equal(link.sent[0].file, ATLAS.fileKey, "routed to the only file");
  assert.deepEqual(link.sent[0].params, {}, "fileKey is routing metadata, not payload");

  link.emit({ id: link.sent[0].id, ok: true, result: { ok: true }, file: ATLAS.fileKey });
  assert.deepEqual(await pending, { ok: true });
});

test("with several files, omitting fileKey refuses and nothing is sent", async () => {
  const { link, client } = clientWith([ATLAS, LOBBY]);

  await assert.rejects(client.call("ping", {}, 5000), (err) => {
    assert.equal(err.name, "BridgeNotPaired");
    assert.ok(err instanceof BridgeOffline, "still an offline error for the tool guard");
    assert.match(err.message, /more than one Figma file is connected/);
    assert.match(err.message, /"Atlas" \(atlas123\)/);
    assert.match(err.message, /"Lobby" \(lobby456\)/);
    return true;
  });
  assert.equal(link.sent.length, 0, "a guess must never go out");
});

test("an explicit fileKey routes there, and is stripped from the payload", async () => {
  const { link, client } = clientWith([ATLAS, LOBBY]);

  const pending = client.call("get_metadata", { nodeId: "1:2", fileKey: LOBBY.fileKey }, 5000);
  await tick();
  assert.equal(link.sent.length, 1);
  assert.equal(link.sent[0].file, LOBBY.fileKey);
  assert.deepEqual(link.sent[0].params, { nodeId: "1:2" });

  link.emit({ id: link.sent[0].id, ok: true, result: { xml: "<FRAME/>" }, file: LOBBY.fileKey });
  assert.deepEqual(await pending, { xml: "<FRAME/>" });
});

test("an unknown fileKey is refused with the list, before sending", async () => {
  const { link, client } = clientWith([ATLAS, LOBBY]);

  await assert.rejects(client.call("ping", { fileKey: "ghost" }, 5000), (err) => {
    assert.equal(err.name, "BridgeNotPaired");
    assert.match(err.message, /no Figma plugin is connected for fileKey "ghost"/);
    assert.match(err.message, /"Atlas" \(atlas123\)/);
    assert.match(err.message, /"Lobby" \(lobby456\)/);
    return true;
  });
  assert.equal(link.sent.length, 0);
});

test("one file disconnecting fails only its own in-flight calls", async () => {
  const { link, client } = clientWith([ATLAS, LOBBY]);

  const atlasCall = client.call("ping", { fileKey: ATLAS.fileKey }, 5000);
  const lobbyCall = client.call("ping", { fileKey: LOBBY.fileKey }, 5000);
  await tick();
  assert.equal(link.sent.length, 2, "both went out");
  const [atlasEnv, lobbyEnv] = link.sent;

  link.emit({ id: null, event: "file", fileKey: ATLAS.fileKey, connected: false });

  await assert.rejects(atlasCall, (err) => {
    assert.ok(err instanceof BridgeOffline);
    assert.match(err.message, /file "atlas123" disconnected/);
    assert.match(err.message, /may or may not have been applied/);
    assert.match(err.message, /re-check the document/);
    assert.doesNotMatch(err.message, /was not sent/, "the request DID go out");
    return true;
  });

  // The neighbour is untouched and can still be answered.
  link.emit({ id: lobbyEnv.id, ok: true, result: { ok: true }, file: LOBBY.fileKey });
  assert.deepEqual(await lobbyCall, { ok: true });
  assert.equal(link.sent.length, 2, "the failed file's call was not re-sent");
});

test("selection is answered per file, and refuses to guess", () => {
  const { link, client } = clientWith([ATLAS, LOBBY]);

  link.emit({
    id: null,
    event: "selection",
    file: ATLAS.fileKey,
    page: { id: "0:1", name: "Symbols" },
    selection: [{ id: "1:1", name: "7", type: "TEXT" }],
  });
  link.emit({
    id: null,
    event: "selection",
    file: LOBBY.fileKey,
    page: { id: "0:2", name: "Lobby" },
    selection: [{ id: "2:2", name: "spin", type: "FRAME" }],
  });

  assert.equal(client.lastSelection(ATLAS.fileKey).selection[0].id, "1:1");
  assert.equal(client.lastSelection(LOBBY.fileKey).selection[0].id, "2:2");
  assert.throws(() => client.lastSelection(), /more than one Figma file is connected/);

  // The file that went away loses its cached selection; the other keeps its own.
  link.emit({ id: null, event: "file", fileKey: ATLAS.fileKey, connected: false });
  assert.equal(client.lastSelection(ATLAS.fileKey), null);
  assert.equal(client.lastSelection(LOBBY.fileKey).selection[0].id, "2:2");
});

test("the files list follows the daemon, and an empty list falls back to the daemon's routing", async () => {
  const { link, client } = clientWith([ATLAS]);
  assert.deepEqual(client.files, [ATLAS]);

  link.emit({ id: null, event: "files", files: [] });
  assert.deepEqual(client.files, []);

  const pending = client.call("ping", {}, 5000);
  await tick();
  assert.equal(link.sent.length, 1);
  assert.equal(link.sent[0].file, undefined, "with no list, the daemon decides");

  link.emit({ id: link.sent[0].id, ok: true, result: { ok: true, files: [] } });
  assert.deepEqual(await pending, { ok: true, files: [] });
});

test("the link dropping clears the files list and the selections", () => {
  const { link, client } = clientWith([ATLAS, LOBBY]);
  link.emit({
    id: null,
    event: "selection",
    file: ATLAS.fileKey,
    page: { id: "0:1", name: "Symbols" },
    selection: [{ id: "1:1", name: "7", type: "TEXT" }],
  });
  assert.equal(client.files.length, 2);

  link.emit({ id: null, event: "link", connected: false });
  assert.deepEqual(client.files, [], "stale file list would misroute the next call");
  assert.equal(client.lastSelection(ATLAS.fileKey), null);
});
