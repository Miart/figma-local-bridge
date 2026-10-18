// The daemon descriptor is read by every MCP process on start and on every
// reconnect, so its shape is load-bearing: `pid` decides whether a reconnect is
// even needed (DaemonLink.refreshInfo), `clientKey` authenticates, `ws` is
// dialled. A missing pid used to read as "changed" on every refresh — a thrash
// loop — and a truncated file (daemon killed mid-write) used to be accepted as
// a daemon whose URL is `undefined`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDaemonInfo } from "../server/dist/link.js";

const write = (content) => {
  const dir = mkdtempSync(join(tmpdir(), "flb-info-"));
  const p = join(dir, "info.json");
  writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
  return p;
};

const good = { ws: "ws://127.0.0.1:8787/?token=t", pluginToken: "t", clientKey: "k", pid: 42, startedAt: 1 };

test("a complete descriptor is read", () => {
  assert.deepEqual(readDaemonInfo(write(good)), good);
});

test("a truncated descriptor reads as absent", () => {
  // Exactly what a daemon killed mid-write leaves behind.
  assert.equal(readDaemonInfo(write(JSON.stringify(good).slice(0, 40))), null);
});

test("a descriptor missing any field is rejected", () => {
  for (const drop of ["ws", "pluginToken", "clientKey", "pid", "startedAt"]) {
    const partial = { ...good };
    delete partial[drop];
    assert.equal(readDaemonInfo(write(partial)), null, `accepted a descriptor with no ${drop}`);
  }
  assert.equal(readDaemonInfo(write({ ...good, pid: "42" })), null, "pid as a string");
  assert.equal(readDaemonInfo(write({ ...good, ws: "" })), null, "empty ws");
});

test("a missing or unreadable file returns null instead of throwing", () => {
  assert.equal(readDaemonInfo(join(tmpdir(), `flb-absent-${process.pid}-${Date.now()}.json`)), null);
  assert.equal(readDaemonInfo(tmpdir()), null, "a directory is not a descriptor");
});
