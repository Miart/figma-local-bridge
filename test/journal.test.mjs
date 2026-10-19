// The journal: the durable half of the ops trail.
//
// figma_ops answers "what happened to that timed-out call" from two memories —
// the client's abandoned-call map and the plugin's opId cache — and both die
// with their processes. These tests pin what the journal must get right for the
// question to survive that:
//
//   - one line per event, on disk, in order, never a payload;
//   - `send` only after the request reached the wire (a call that was never
//     sent changed nothing and must not look like it might have);
//   - `timeout` written by the caller's own timer, `late` when the answer
//     arrives afterwards, `dropped` when no answer ever came;
//   - a journal that fails (no permission, no space) never breaks the call,
//     and says so through journalStatus;
//   - reading is bounded and total: a partial tail or a corrupt line is
//     reported, not fatal.

import "./helpers/journal-dir.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { FigmaClient } from "../server/dist/figma.js";
import {
  ENV_DIR,
  ENV_OFF,
  SEGMENTS,
  appendJournal,
  journalConfig,
  journalStatus,
  journalTargets,
  readJournal,
  rotateIfNeeded,
} from "../server/dist/journal.js";

const dirs = [];
function freshDir() {
  const d = fs.mkdtempSync(join(os.tmpdir(), "figma-journal-"));
  dirs.push(d);
  return d;
}

process.on("exit", () => {
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

/** Point the module at a temp dir for the duration of one test. */
function useDir(dir) {
  process.env[ENV_DIR] = dir;
  delete process.env[ENV_OFF];
}

const readLines = (dir, name = SEGMENTS[0]) =>
  fs
    .readFileSync(join(dir, name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

// --------------------------------------------------------------- the file

test("appendJournal writes one stamped JSON line and creates the directory", () => {
  const dir = freshDir();
  useDir(join(dir, "journal"));

  const r1 = appendJournal({ event: "send", opId: "aa", method: "inspect", file: "f1", pid: 1 });
  assert.ok(r1 && "path" in r1 && !r1.error, "append succeeds");

  appendJournal({ event: "ok", opId: "aa", method: "inspect", file: "f1" });
  const lines = readLines(join(dir, "journal"));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].event, "send");
  assert.match(lines[0].at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(lines[0].opId, "aa");
  assert.equal(lines[1].event, "ok");
  // `at`/`pid` are stamped by the writer; a caller cannot override them.
  assert.equal(lines[0].pid, process.pid);
  assert.equal(lines[1].pid, process.pid);
});

test("FIGMA_BRIDGE_JOURNAL=0 switches recording off and touches no file", () => {
  const dir = freshDir();
  process.env[ENV_DIR] = dir;
  process.env[ENV_OFF] = "0";

  assert.equal(appendJournal({ event: "send", opId: "aa", method: "x", file: null }), null);
  assert.equal(fs.existsSync(join(dir, SEGMENTS[0])), false);
  assert.equal(journalConfig().enabled, false);

  delete process.env[ENV_OFF];
});

test("journalTargets keeps targets and permissions, clips description, drops payload", () => {
  const out = journalTargets({
    nodeId: "12:34",
    scopeNodeId: "56:78",
    allowPageWide: false,
    dryRun: true,
    description: "  build the   sheet\nwith sprites  ",
    code: "figma.createFrame()",
    base64: "iVBORw0KGgo=",
    text: "<svg/>",
  });
  assert.deepEqual(out, {
    nodeId: "12:34",
    scopeNodeId: "56:78",
    allowPageWide: false,
    dryRun: true,
    description: "build the sheet with sprites",
  });
  assert.equal("code" in out, false);
  assert.equal("base64" in out, false);
  assert.equal("text" in out, false);

  const clipped = journalTargets({ description: "x".repeat(500) });
  assert.equal(clipped.description.length, 200);
  assert.ok(clipped.description.endsWith("…"));
});

test("rotation keeps the active file plus two older segments and drops the rest", () => {
  const dir = freshDir();
  useDir(dir);

  for (let i = 0; i < 40; i++) appendJournal({ event: "send", opId: `op${i}`, method: "m", file: null }, { maxBytes: 512 });

  for (const name of SEGMENTS) assert.ok(fs.existsSync(join(dir, name)), `${name} exists`);
  assert.equal(rotateIfNeeded(dir, Number.MAX_SAFE_INTEGER), false, "a threshold nothing reaches does nothing");

  const all = [...SEGMENTS].reverse().flatMap((n) => readLines(dir, n));
  const ops = all.map((l) => l.opId);
  // The oldest lines are gone, the newest are all here, and the order survives.
  assert.ok(!ops.includes("op0"), "oldest segment was dropped");
  assert.equal(ops[ops.length - 1], "op39", "the newest line is last");
  assert.ok(ops.length >= 10, `most lines survived (${ops.length})`);
  assert.deepEqual(ops, [...ops].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2))), "order intact");
});

test("a write failure is returned and remembered, and never thrown", () => {
  const dir = freshDir();
  useDir(dir);
  const blocker = join(dir, "blocked");
  fs.writeFileSync(blocker, "not a directory");

  const r = appendJournal({ event: "send", opId: "aa", method: "m", file: null }, { dir: blocker });
  assert.ok(r && r.error, "the failure comes back as data");
  assert.ok(journalStatus().lastError, "and is remembered in status");
});

// --------------------------------------------------------------- reading

test("readJournal returns the tail, oldest first, and counts what it scanned", () => {
  const dir = freshDir();
  useDir(dir);
  for (let i = 0; i < 5; i++) appendJournal({ event: "send", opId: `op${i}`, method: "m", file: null });

  const r = readJournal({ last: 3 });
  assert.equal(r.matching, 5);
  assert.deepEqual(r.entries.map((e) => e.opId), ["op2", "op3", "op4"]);
  assert.equal(r.scannedLines, 5);
  assert.equal(r.skippedLines, 0);
  assert.equal(r.partialTail, false);
  assert.equal(r.enabled, true);
  assert.equal(r.files[0].name, "ops.jsonl");
  assert.ok(r.files[0].bytes > 0);
});

test("readJournal filters by fileKey, method and unsettled", () => {
  const dir = freshDir();
  useDir(dir);
  const e = (event, file, method, opId) => appendJournal({ event, file, method, opId });
  e("send", "f1", "use_figma", "a");
  e("ok", "f1", "use_figma", "a");
  e("send", "f2", "inspect", "b");
  e("ok", "f2", "inspect", "b");
  e("send", "f1", "use_figma", "c");
  e("timeout", "f1", "use_figma", "c");
  e("late", "f1", "use_figma", "c");
  e("send", "f1", "inspect", "d");
  e("dropped", "f1", "inspect", "d");

  assert.deepEqual(readJournal({ fileKey: "f2" }).entries.map((x) => x.opId), ["b", "b"]);
  assert.deepEqual(readJournal({ method: "inspect" }).entries.map((x) => x.opId), ["b", "b", "d", "d"]);
  assert.deepEqual(readJournal({ unsettled: true }).entries.map((x) => x.event), ["timeout", "late", "dropped"]);
  assert.deepEqual(
    readJournal({ unsettled: true, fileKey: "f1", method: "use_figma" }).entries.map((x) => x.opId),
    ["c", "c"],
  );
});

test("a partial tail line is dropped and named; a corrupt line is counted, not fatal", () => {
  const dir = freshDir();
  useDir(dir);
  appendJournal({ event: "send", opId: "ok1", method: "m", file: null });

  // Half a line, as a killed process leaves it.
  fs.appendFileSync(join(dir, SEGMENTS[0]), '{"at":"2026-10-19T00:00:00.000Z","event":"se');
  let r = readJournal({});
  assert.equal(r.entries.length, 1);
  assert.equal(r.partialTail, true);
  assert.equal(r.skippedLines, 0);

  // A complete but corrupt line, as a hand-edit leaves it.
  fs.appendFileSync(join(dir, SEGMENTS[0]), "not json at all\n");
  r = readJournal({});
  assert.equal(r.entries.length, 1);
  assert.equal(r.skippedLines, 1);
});

// ------------------------------------------------------- the client hook

/** Minimal Link stand-in, same shape as retry.test.mjs uses. */
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

function paired(dir) {
  useDir(dir);
  const link = new FakeLink();
  const client = new FigmaClient(link);
  link.emit({ event: "link", connected: true });
  return { link, client };
}

test("a successful call journals send then ok — target and description, never the payload", async () => {
  const dir = freshDir();
  const { link, client } = paired(dir);

  const pending = client.call("use_figma", { code: "SECRET SNIPPET", scopeNodeId: "1:2", description: "make a frame" }, 5000);
  await tick();
  link.emit({ id: link.sent[0].id, ok: true, result: { applied: 1 }, rev: 7 });
  await pending;

  const lines = readLines(dir);
  assert.deepEqual(lines.map((l) => l.event), ["send", "ok"]);
  assert.equal(lines[0].method, "use_figma");
  assert.equal(lines[0].scopeNodeId, "1:2");
  assert.equal(lines[0].description, "make a frame");
  assert.equal(lines[0].attempt, 1);
  assert.equal(lines[1].rev, 7);
  assert.equal(lines[1].attempts, 1);
  assert.equal(typeof lines[1].ms, "number");
  const raw = fs.readFileSync(join(dir, SEGMENTS[0]), "utf8");
  assert.ok(!raw.includes("SECRET"), "the snippet never reaches the file");
});

test("a plugin error journals failed with the revision the call reached", async () => {
  const dir = freshDir();
  const { link, client } = paired(dir);

  const pending = client.call("use_figma", { code: "x", scopeNodeId: "3:4" }, 5000);
  await tick();
  link.emit({ id: link.sent[0].id, ok: false, error: { message: "REFUSED and rolled back" }, rev: 9 });
  await assert.rejects(pending, /REFUSED/);

  const lines = readLines(dir);
  assert.deepEqual(lines.map((l) => l.event), ["send", "failed"]);
  assert.equal(lines[1].rev, 9);
  assert.match(lines[1].error, /REFUSED/);
});

test("a timeout is journaled by the caller's timer, and the late answer settles it", async () => {
  const dir = freshDir();
  const { link, client } = paired(dir);

  await assert.rejects(client.call("slow_read", { nodeId: "5:6" }, 60), /bridge timeout after 60ms/);
  let lines = readLines(dir);
  assert.deepEqual(lines.map((l) => l.event), ["send", "timeout"]);
  assert.equal(lines[1].opId, lines[0].opId, "the timeout names the same logical call");
  assert.equal(typeof lines[1].waitedMs, "number");

  // The answer nobody was waiting for any more arrives.
  link.emit({ id: link.sent[0].id, ok: true, result: { ok: 1 }, rev: 12 });
  lines = readLines(dir);
  assert.deepEqual(lines.map((l) => l.event), ["send", "timeout", "late"]);
  assert.equal(lines[2].ok, true);
  assert.equal(lines[2].rev, 12);
  assert.equal(lines[2].attempt, 1);
  assert.equal(typeof lines[2].afterMs, "number");
});

test("a drop with the call in flight journals retry, then ok under the same opId", async () => {
  const dir = freshDir();
  const { link, client } = paired(dir);

  const pending = client.call("use_figma", { code: "x", scopeNodeId: "7:8" }, 5000);
  pending.catch(() => {});
  await tick();
  link.drop();
  link.raise();
  await tick();
  await tick();
  assert.equal(link.sent.length, 2, "the call was retried");
  link.emit({ id: link.sent[1].id, ok: true, result: {}, rev: 20, replayed: false });
  await pending;

  const lines = readLines(dir);
  assert.deepEqual(lines.map((l) => l.event), ["send", "retry", "send", "ok"]);
  assert.equal(lines[1].attempt, 1, "the retry names the attempt that dropped");
  assert.equal(lines[2].attempt, 2);
  assert.equal(lines[0].opId, lines[2].opId, "both attempts carry the one opId");
  assert.equal(lines[3].attempts, 2);
});

test("a plugin that never comes back journals dropped — no answer ever came", async () => {
  const dir = freshDir();
  const { link, client } = paired(dir);

  const pending = client.call("use_figma", { code: "x", scopeNodeId: "9:10" }, 5000);
  pending.catch(() => {});
  await tick();
  link.drop();
  // No link.raise(): the 2s grace expires, the call is not re-sent.
  await assert.rejects(pending, /did not come back/);

  const lines = readLines(dir);
  assert.equal(lines[lines.length - 1].event, "dropped");
  assert.equal(lines[lines.length - 1].attempts, 1);
  assert.match(lines[lines.length - 1].error, /may or may not have been applied|disconnected/);
});

test("a call that was never sent journals nothing at all", async () => {
  const dir = freshDir();
  useDir(dir);
  const link = new FakeLink();
  link._connected = false;
  const client = new FigmaClient(link);

  await assert.rejects(client.call("inspect", { nodeId: "1:1" }, 3000), /was not sent|no socket/);
  assert.equal(fs.existsSync(join(dir, SEGMENTS[0])), false, "nothing was written");
});
