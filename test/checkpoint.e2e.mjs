// End-to-end test for figma_checkpoint over the real pipeline:
//   plugin <--ws--> daemon <--ws--> MCP client (server/dist/index.js)
//
// What only this level can prove:
//   - the checkpoint FILE lands where the tool says it does, and reads back;
//   - `restore` is a dry run unless the caller says otherwise, and a wet run is
//     refused both by a read-only bridge and by a missing allowDestructive;
//   - the tool verifies a rebuild by dumping the subtree AGAIN and diffing it,
//     so "verified" is a measurement (the fake plugin is the one that decides
//     what the second dump contains);
//   - a truncated checkpoint reaches the plugin as truncated, and its refusal
//     reaches the caller instead of being swallowed.
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import os, { homedir } from "node:os";

const PORT = Number(process.env.TEST_PORT || 8897);
const INFO = join(homedir(), ".local/share/opencode", "figma-bridge-daemon-checkpoint-test.json");
const DIR = mkdtempSync(join(os.tmpdir(), "flb-checkpoint-e2e-"));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; process.stdout.write(`PASS  ${name}\n`); }
  else { fail++; process.stdout.write(`FAIL  ${name}${detail ? "  — " + detail : ""}\n`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(url) {
  return new Promise((res) => {
    const ws = new WebSocket(url);
    ws.on("open", () => res(ws));
    ws.on("error", () => res(null));
  });
}

async function mcpClient(env = {}) {
  const proc = spawn("node", ["server/dist/index.js"], {
    env: { ...process.env, FIGMA_BRIDGE_INFO_FILE: INFO, FIGMA_BRIDGE_CHECKPOINTS_DIR: DIR, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const pending = new Map();
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  let rpcId = 0;
  const rpc = (method, params) => new Promise((res, rej) => {
    const id = ++rpcId;
    const t = setTimeout(() => rej(new Error("rpc timeout " + method)), 20000);
    pending.set(id, (m) => { clearTimeout(t); res(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const call = async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: args });
    const text = r?.result?.content?.[0]?.text ?? r?.error?.message ?? "";
    // A tool answers either as pure JSON or as a caption followed by a blank
    // line and the JSON.
    const json = (() => {
      try {
        const i = text.indexOf("\n\n");
        return JSON.parse(i >= 0 ? text.slice(i + 2) : text);
      } catch {
        return null;
      }
    })();
    return { text, json, isError: r?.result?.isError === true };
  };
  return { proc, rpc, call, kill: () => proc.kill() };
}

// ---------------------------------------------------------------- fixtures

const rectState = (w = 200) => ({ pos: [0, 0], size: [w, 120], fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }] });
const dumpTree = (w = 200) => ({
  type: "FRAME", name: "Card",
  state: { pos: [10, 20], size: [200, 120], fills: [{ type: "SOLID", color: { r: 0.1, g: 0.2, b: 0.3 } }] },
  children: [{ type: "RECTANGLE", name: w === 200 ? "bg" : "background", state: rectState(w) }],
});
let live = dumpTree();
let liveTruncated = false;
let liveRev = 11;
const fingerprintOf = (tree) => "fp" + JSON.stringify(tree).length;

const pluginCalls = [];
const daemon = spawn("node", ["server/dist/daemon.js"], {
  env: { ...process.env, FIGMA_BRIDGE_PORT: String(PORT), FIGMA_BRIDGE_INFO_FILE: INFO },
  stdio: ["ignore", "pipe", "pipe"],
});

let client = null;
try {
  let info = null;
  for (let i = 0; i < 60 && !info; i++) {
    await sleep(150);
    try { info = JSON.parse(fs.readFileSync(INFO, "utf8")); } catch {}
  }
  if (!info) throw new Error("no daemon info");

  const plugin = await connect(info.ws.replace("127.0.0.1", "localhost") + "&role=plugin&fileKey=FILEKEY&name=Test%20file");
  let restored = null;
  plugin.on("message", (raw) => {
    const env = JSON.parse(raw.toString());
    pluginCalls.push({ method: env.method, params: env.params });
    const ok = (result) => plugin.send(JSON.stringify({ id: env.id, ok: true, result, rev: liveRev }));
    const fail = (m) => plugin.send(JSON.stringify({ id: env.id, ok: false, error: { message: m } }));
    switch (env.method) {
      case "ping": return ok({ ok: true });
      case "checkpoint_dump":
        return ok({
          schema: "checkpoint-v1", capturedAt: "2026-10-19T12:00:00.000Z", rev: liveRev,
          file: { key: "FILEKEY", name: "Test file" }, page: { id: "0:1", name: "Page 1" },
          root: { id: "1:2", name: "Card", type: "FRAME" },
          nodes: 2, truncated: liveTruncated, unsupported: [],
          limitations: ["instance interiors are not captured"],
          fingerprint: { hash: fingerprintOf(live), geometryStatus: "EXACT" },
          dump: live,
        });
      case "checkpoint_restore":
        restored = env.params;
        if (env.params.truncated) return fail("this checkpoint was truncated at the node cap, so it describes only PART of the subtree. Restoring it would delete everything the dump never reached");
        if (env.params.dryRun) {
          return ok({
            target: { id: "1:2", name: "Card", type: "FRAME" }, dryRun: true, removed: 2, created: 2, skipped: [],
            fontsUnavailable: [], bindingsDropped: [], propertiesFailed: [], notes: [],
            wouldRemove: [{ id: "1:3", name: "bg", type: "RECTANGLE" }, { id: "1:4", name: "label", type: "TEXT" }],
          });
        }
        live = dumpTree(); // the rebuild "worked"
        liveTruncated = false;
        liveRev += 1;
        return ok({
          target: { id: "1:2", name: "Card", type: "FRAME" }, dryRun: false, removed: 2, created: 2, skipped: [],
          fontsUnavailable: [], bindingsDropped: [], propertiesFailed: [], notes: [],
        });
      default: return fail("unhandled " + env.method);
    }
  });
  await sleep(400);

  client = await mcpClient({ FIGMA_BRIDGE_DESTRUCTIVE: "1" });
  const tools = (await client.rpc("tools/list", {})).result.tools.map((t) => t.name);
  check("figma_checkpoint is registered", tools.includes("figma_checkpoint"));

  // ------------------------------------------------------------ save
  const save = await client.call("figma_checkpoint", { action: "save", nodeId: "1:2", name: "before rebuild" });
  const saved = save.json;
  check("save: an id, a path and a digest come back",
    !!saved?.id && saved.path.startsWith(DIR) && /^sha256:[0-9a-f]{16}$/.test(saved.digest ?? ""), save.text.slice(0, 240));
  check("save: the id is readable and dated", /^\d{8}-\d{6}-before-rebuild$/.test(saved.id));
  check("save: the file is really there", fs.existsSync(saved.path));
  check("save: the summary describes the subtree", saved.summary.nodes === 2 && saved.summary.byType.RECTANGLE === 1 && saved.summary.characters === 0);
  check("save: the blind spots travel with the data", Array.isArray(saved.limitations) && saved.limitations.length >= 1);

  const stored = JSON.parse(fs.readFileSync(saved.path, "utf8"));
  check("save: the file holds the dump and the summary", stored.envelope.dump.children[0].name === "bg" && stored.summary.nodes === 2 && stored.saveRev === 11);

  // ------------------------------------------------------------ show
  const shown = await client.call("figma_checkpoint", { action: "show", id: saved.id });
  check("show: an unchanged subtree is field-identical, and the fingerprint agrees",
    shown.json?.identical === true && shown.json?.fingerprint?.same === true, shown.text.slice(0, 200));

  live = dumpTree(180); // the document moved on: a child was resized and renamed
  const drifted = await client.call("figma_checkpoint", { action: "show", id: saved.id });
  check("show: drift is named field by field", drifted.json?.identical === false && drifted.json.differences >= 2, JSON.stringify(drifted.json?.diff));
  check("show: the diff carries paths and both values",
    drifted.json.diff.some((d) => d.path === "$.children[0].name" && d.before === "bg" && d.after === "background"));
  check("show: the fingerprint disagrees too", drifted.json.fingerprint.same === false);
  check("show: read-only — the plugin saw no write", !pluginCalls.some((c) => c.method === "checkpoint_restore"));

  // ------------------------------------------------------------ restore: dry run
  const dry = await client.call("figma_checkpoint", { action: "restore", id: saved.id, nodeId: "1:2" });
  check("restore: the default is a dry run that writes nothing",
    dry.json?.dryRun === true && dry.json.rebuilt === false && pluginCalls.filter((c) => c.method === "checkpoint_restore").length === 1);
  check("restore: the dry run names what would be deleted",
    dry.json.wouldRemove?.map((n) => n.name).join(",") === "bg,label");
  check("restore: the plugin was asked for a dry run", restored.dryRun === true);
  check("restore: it reports the drift it found", dry.json.drift.identical === false && dry.json.drift.differences >= 2);

  // ------------------------------------------------------------ restore: refused wet runs
  const refusedFlag = await client.call("figma_checkpoint", { action: "restore", id: saved.id, nodeId: "1:2", dryRun: false });
  check("restore: a wet run without allowDestructive is refused, before the plugin is asked",
    /allowDestructive/.test(refusedFlag.text) && pluginCalls.filter((c) => c.method === "checkpoint_restore").length === 1, refusedFlag.text.slice(0, 200));

  const readOnly = await mcpClient(); // no FIGMA_BRIDGE_DESTRUCTIVE
  const refusedEnv = await readOnly.call("figma_checkpoint", { action: "restore", id: saved.id, nodeId: "1:2", dryRun: false, allowDestructive: true });
  check("restore: a bridge without destructive writes refuses a real rebuild",
    /FIGMA_BRIDGE_DESTRUCTIVE/.test(refusedEnv.text) && pluginCalls.filter((c) => c.method === "checkpoint_restore").length === 1, refusedEnv.text.slice(0, 200));
  const readOnlyDry = await readOnly.call("figma_checkpoint", { action: "restore", id: saved.id, nodeId: "1:2" });
  check("restore: the dry run is available on a read-only bridge", readOnlyDry.json?.dryRun === true);
  readOnly.kill();

  // ------------------------------------------------------------ restore: the real thing
  const wet = await client.call("figma_checkpoint", { action: "restore", id: saved.id, nodeId: "1:2", dryRun: false, allowDestructive: true });
  check("restore: the rebuild is verified by dumping the subtree again",
    wet.json?.rebuilt === true && wet.json.verification?.verified === true && /verified field-identical/.test(wet.text), wet.text.slice(0, 300));
  check("restore: the rebuild report says what it removed and created", wet.json.removed === 2 && wet.json.created === 2);
  check("restore: it reports the drift that was there before the rebuild", wet.json.drift.identical === false);
  check("restore: the revs bracket the write", wet.json.rev.before < wet.json.rev.restore && wet.json.rev.after === wet.json.rev.restore, JSON.stringify(wet.json.rev));
  check("restore: the plugin was told to allow a partial rebuild explicitly", restored.allowPartial === false && restored.truncated === false);

  // ------------------------------------------------------------ nothing to do
  const beforeIdle = pluginCalls.filter((c) => c.method === "checkpoint_restore").length;
  const again = await client.call("figma_checkpoint", { action: "restore", id: saved.id, nodeId: "1:2", dryRun: false, allowDestructive: true });
  check("restore: a subtree that already matches is not rebuilt again",
    again.json?.alreadyMatches === true && pluginCalls.filter((c) => c.method === "checkpoint_restore").length === beforeIdle, again.text.slice(0, 200));

  // ------------------------------------------------------------ a truncated checkpoint
  live = dumpTree(170); // the document has drifted, so the restore is not short-circuited
  liveTruncated = true;
  const saveTrunc = await client.call("figma_checkpoint", { action: "save", nodeId: "1:2", name: "truncated" });
  check("save: a truncated dump is stored but flagged loudly",
    /TRUNCATED/.test(saveTrunc.text) && saveTrunc.json.truncated === true && saveTrunc.json.summary.nodes === 2);
  liveTruncated = false;
  live = dumpTree(160); // the document moved on again, so the restore reaches the plugin
  const refusedTrunc = await client.call("figma_checkpoint", { action: "restore", id: saveTrunc.json.id, nodeId: "1:2", dryRun: false, allowDestructive: true });
  check("restore: the plugin's refusal of a truncated dump reaches the caller",
    refusedTrunc.isError && /truncated/.test(refusedTrunc.text), refusedTrunc.text.slice(0, 200));

  // ------------------------------------------------------------ list / drop
  const list = await client.call("figma_checkpoint", { action: "list" }); // no fileKey: one file is connected
  check("list: it finds both checkpoints, newest first, without a fileKey",
    list.json?.count === 2 && list.json.checkpoints[0].id === saveTrunc.json.id && list.json.fileKey === "FILEKEY", list.text.slice(0, 200));
  check("list: it does not ship the dumps back", !JSON.stringify(list.json).includes('"dump"'));

  const drop = await client.call("figma_checkpoint", { action: "drop", id: "latest" });
  check("drop: it removes the newest checkpoint file only",
    drop.json?.dropped === true && !fs.existsSync(drop.json.path) && !fs.existsSync(saveTrunc.json.path));
  const after = await client.call("figma_checkpoint", { action: "list" });
  check("drop: the other checkpoint is untouched", after.json.count === 1 && after.json.checkpoints[0].id === saved.id);
  const showDropped = await client.call("figma_checkpoint", { action: "show", id: "latest" });
  check("drop: showing a dropped id resolves to what is left", showDropped.json?.id === saved.id);
} catch (err) {
  fail++;
  process.stdout.write(`FAIL  e2e aborted: ${err && err.message}\n${err && err.stack}\n`);
} finally {
  client?.kill();
  daemon.kill();
  rmSync(DIR, { recursive: true, force: true });
}

process.stdout.write(`\ncheckpoint.e2e: ${pass} passed, ${fail} failed\n`);
if (fail) process.exitCode = 1;
