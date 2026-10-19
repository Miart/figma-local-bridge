// End-to-end test for the journal: a real daemon, a stub plugin that answers
// most calls and answers one too late, and the MCP client in its own process.
//
// The unit tests pin the file format and the client's state machine. This one
// pins the part only a second process can prove:
//
//   - a line written by the MCP client process is readable by figma_journal,
//     which runs in ITS process and reads the file from disk;
//   - the caller's timeout and the plugin's late answer both land in the file,
//     under one opId, in that order;
//   - the target and the figma_use description are recorded, the snippet is
//     not;
//   - FIGMA_BRIDGE_JOURNAL=0 really records nothing, and says so.
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import fs from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { FigmaClient } from "../server/dist/figma.js";
import { DaemonLink, readDaemonInfo } from "../server/dist/link.js";

const PORT = Number(process.env.TEST_PORT || 8902);
const OUT = fs.mkdtempSync(join(os.tmpdir(), "figma-journal-e2e-"));
const INFO = join(OUT, "daemon.json");
const JOURNAL = join(OUT, "journal");
const JFILE = join(JOURNAL, "ops.jsonl");
// The direct DaemonLink client in this process writes here too — same module,
// same env, so the test proves several processes appending to one file.
process.env.FIGMA_BRIDGE_JOURNAL_DIR = JOURNAL;

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

function lines() {
  try {
    return fs.readFileSync(JFILE, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function waitFor(fn, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(50);
  }
  return false;
}

async function mcpClient(env = {}) {
  const proc = spawn("node", ["server/dist/index.js"], {
    env: {
      ...process.env,
      FIGMA_BRIDGE_INFO_FILE: INFO,
      FIGMA_BRIDGE_DESTRUCTIVE: "1",
      FIGMA_BRIDGE_JOURNAL_DIR: JOURNAL,
      ...env,
    },
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
    const t = setTimeout(() => rej(new Error("rpc timeout " + method)), 10000);
    pending.set(id, (m) => { clearTimeout(t); res(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const text = (r) => {
    const t = r?.result?.content?.[0]?.text;
    return t ? JSON.parse(t) : null;
  };
  return { proc, rpc, text, kill: () => proc.kill() };
}

const daemon = spawn("node", ["server/dist/daemon.js"], {
  env: { ...process.env, FIGMA_BRIDGE_PORT: String(PORT), FIGMA_BRIDGE_INFO_FILE: INFO },
  stdio: ["ignore", "pipe", "pipe"],
});

let direct = null;
try {
  let info = null;
  for (let i = 0; i < 60 && !info; i++) {
    await sleep(150);
    try { info = JSON.parse(fs.readFileSync(INFO, "utf8")); } catch {}
  }
  if (!info) throw new Error("no daemon info");

  const c = await mcpClient();
  const tools = (await c.rpc("tools/list", {})).result.tools.map((t) => t.name);
  check("figma_journal is registered", tools.includes("figma_journal"), tools.join(","));

  // The stub names the file it serves, so routing and the journal's `file`
  // field have a real value to agree on.
  const plugin = await connect(info.ws.replace("127.0.0.1", "localhost") + "&role=plugin&fileKey=file-1&name=E2E");
  plugin.on("message", (raw) => {
    const env = JSON.parse(raw.toString());
    const ok = (result, rev = 11) => {
      try { plugin.send(JSON.stringify({ id: env.id, ok: true, result, rev })); } catch { /* torn down */ }
    };
    const failMsg = (m) => {
      try { plugin.send(JSON.stringify({ id: env.id, ok: false, error: { message: m }, rev: 11 })); } catch { /* torn down */ }
    };
    switch (env.method) {
      case "ping": return ok({ ok: true, page: { id: "0:1", name: "Page 1" }, editorType: "figma" });
      case "whoami": return ok({ file: { key: "file-1", name: "E2E" }, selection: [] });
      case "use_figma": return ok({ result: { done: 1 }, logs: [], changed: true, effects: [], ms: { code: 1, index: 0, total: 1 }, nodes: { before: 1, after: 1 } });
      // The answer nobody will be waiting for any more: 500 ms, caller waits 150.
      case "hang": setTimeout(() => ok({ late: true }, 3), 500); return;
      default: return failMsg("unhandled " + env.method);
    }
  });
  await sleep(300);

  // ------------------------------------------------------------ a clean call
  const ping = c.text(await c.rpc("tools/call", { name: "figma_ping", arguments: {} }));
  check(
    "figma_ping answers from the stub",
    ping && ping.connected === true && ping.files.some((f) => f.fileKey === "file-1"),
    JSON.stringify(ping),
  );
  check(
    "a call that went out is on disk by the time the tool returns",
    await waitFor(() => lines().some((l) => l.method === "ping" && l.event === "ok")),
    `dir=${fs.existsSync(JOURNAL)} file=${fs.existsSync(JFILE)} lines=${lines().length}`,
  );
  let ls = lines();
  const pingSend = ls.findIndex((l) => l.method === "ping" && l.event === "send");
  const pingOk = ls.findIndex((l) => l.method === "ping" && l.event === "ok");
  check("send comes before ok for the same call", pingSend >= 0 && pingOk > pingSend, `send=${pingSend} ok=${pingOk}`);
  check("the send line names the file and the process that wrote it", ls[pingSend].file === "file-1" && ls[pingSend].pid === c.proc.pid, JSON.stringify(ls[pingSend]));
  check("ok carries the revision the plugin stamped", ls[pingOk].rev === 11 && ls[pingOk].attempts === 1);

  // -------------------------------------------------- target, not payload
  await c.rpc("tools/call", {
    name: "figma_use",
    arguments: { code: "const x = 'SECRET-CODE'; return 1", allowDestructive: true, scopeNodeId: "1:2", description: "e2e journal check" },
  });
  check("the figma_use call is journaled", await waitFor(() => lines().some((l) => l.method === "use_figma" && l.event === "ok")));
  ls = lines();
  const useSend = ls.find((l) => l.method === "use_figma" && l.event === "send");
  check("the journal keeps the scope and the one-line description", useSend.scopeNodeId === "1:2" && useSend.description === "e2e journal check", JSON.stringify(useSend));
  check("the snippet itself is not in the file", !fs.readFileSync(JFILE, "utf8").includes("SECRET-CODE"));

  // ------------------------------------------------------------- the reader
  const j = c.text(await c.rpc("tools/call", { name: "figma_journal", arguments: { last: 20 } }));
  check("figma_journal reads the same directory", j.dir === JOURNAL, j.dir);
  check("it lists the segment files", j.files.some((f) => f.name === "ops.jsonl" && f.bytes > 0), JSON.stringify(j.files));
  check("it returns the calls this process made", j.entries.some((e) => e.method === "ping") && j.entries.some((e) => e.method === "use_figma"));
  check("the read facts travel with the entries", j.read.matching >= j.entries.length && j.read.skippedLines === 0 && j.read.partialTail === false, JSON.stringify(j.read));
  check("the note names the blind spots", /may have been applied/.test(j.note) && /human did/.test(j.note), j.note);

  const onlyUse = c.text(await c.rpc("tools/call", { name: "figma_journal", arguments: { method: "use_figma", last: 20 } }));
  check("filtering by method works", onlyUse.entries.length > 0 && onlyUse.entries.every((e) => e.method === "use_figma"));
  const onlyFile = c.text(await c.rpc("tools/call", { name: "figma_journal", arguments: { fileKey: "file-1", last: 20 } }));
  check("filtering by fileKey works", onlyFile.entries.length > 0 && onlyFile.entries.every((e) => e.file === "file-1"));
  const clean = c.text(await c.rpc("tools/call", { name: "figma_journal", arguments: { unsettled: true, last: 20 } }));
  check("nothing is unsettled before the timeout", clean.entries.length === 0, JSON.stringify(clean.entries));

  // ------------------------------------------- timeout, then the late answer
  const dlink = new DaemonLink(info, undefined, INFO);
  direct = new FigmaClient(dlink);
  await new Promise((res) => {
    const t = setTimeout(res, 3000);
    const off = dlink.subscribe((e) => { if (e.event === "link" && e.connected) { clearTimeout(t); off(); res(); } });
    dlink.connect();
  });
  let timedOut = false;
  try {
    await direct.call("hang", {}, 150);
  } catch {
    timedOut = true;
  }
  check("the caller gives up before the stub answers", timedOut);
  check("the timeout is on disk before any answer exists", await waitFor(() => lines().some((l) => l.method === "hang" && l.event === "timeout"), 2000));
  check("the late answer settles the timeout", await waitFor(() => lines().some((l) => l.method === "hang" && l.event === "late")));

  ls = lines().filter((l) => l.method === "hang");
  const to = ls.find((l) => l.event === "timeout");
  const late = ls.find((l) => l.event === "late");
  check("both lines name one opId, timeout first", to && late && to.opId === late.opId && ls.indexOf(to) < ls.indexOf(late), JSON.stringify(ls));
  check("the late line carries what the caller never saw", late.ok === true && late.rev === 3 && late.attempt === 1, JSON.stringify(late));
  dlink.close();

  const unsettled = c.text(await c.rpc("tools/call", { name: "figma_journal", arguments: { unsettled: true, last: 20 } }));
  check(
    "unsettled shows the timeout and its late answer",
    unsettled.entries.some((e) => e.event === "timeout") && unsettled.entries.some((e) => e.event === "late"),
    JSON.stringify(unsettled.entries),
  );

  // ------------------------------------------------- switched off, read-only
  const off = await mcpClient({ FIGMA_BRIDGE_WRITE: "0", FIGMA_BRIDGE_JOURNAL: "0" });
  const offTools = (await off.rpc("tools/list", {})).result.tools.map((t) => t.name);
  check("the journal tool is available on a read-only bridge", offTools.includes("figma_journal"));
  const offView = off.text(await off.rpc("tools/call", { name: "figma_journal", arguments: { last: 5 } }));
  check("a switched-off journal says so and still shows what exists", offView.enabled === false && offView.entries.length > 0, JSON.stringify({ enabled: offView.enabled, n: offView.entries.length }));
  const before = fs.statSync(JFILE).size;
  await off.rpc("tools/call", { name: "figma_ping", arguments: {} });
  await sleep(200);
  const after = fs.statSync(JFILE).size;
  check("FIGMA_BRIDGE_JOURNAL=0 records nothing", before === after, `${before} -> ${after}`);
  check("its note says nothing new is being recorded", /switched off/.test(offView.note), offView.note);
  off.kill();

  c.kill();
} catch (err) {
  fail++;
  process.stdout.write(`FAIL  harness — ${err && err.message}\n${err && err.stack}\n`);
} finally {
  try { direct?.link?.close?.(); } catch {}
  daemon.kill();
  try { fs.rmSync(OUT, { recursive: true, force: true }); } catch {}
  await sleep(200);
  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
