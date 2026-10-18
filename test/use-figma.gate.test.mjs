/**
 * MCP-level gating for figma_use.
 *
 * The scope DECISION is unit-tested against the shipped module in
 * scope.test.mjs. This file covers the other half: that the server refuses the
 * call before it ever reaches Figma, so an agent cannot get there by accident.
 *
 *   1. FIGMA_BRIDGE_DESTRUCTIVE=0 disables the tool outright. The flag was
 *      declared and then never read anywhere — it protected nothing.
 *   2. allowDestructive must be passed explicitly, per call.
 *   3. A scopeNodeId (or an explicit allowPageWide) must be named.
 *
 * (1)–(3) are asserted end to end through real MCP stdio against a stub plugin,
 * so a passing run means the refusal actually happened on the wire.
 */
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PORT = Number(process.env.TEST_PORT || 8896);
const INFO = join(homedir(), ".local/share/opencode", "figma-bridge-daemon-usetest.json");
const TOKEN_FILE = join(homedir(), ".local/share/opencode", "figma-bridge-daemon-usetest.secret");

let pass = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; process.stdout.write(`PASS  ${name}\n`); }
  else { fails.push(name); process.stdout.write(`FAIL  ${name}${detail ? "  — " + detail : ""}\n`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const f of [INFO, TOKEN_FILE]) if (existsSync(f)) rmSync(f);

const daemon = spawn("node", ["server/dist/daemon.js"], {
  env: {
    ...process.env,
    FIGMA_BRIDGE_PORT: String(PORT),
    FIGMA_BRIDGE_HOSTS: "127.0.0.1",
    FIGMA_BRIDGE_INFO_FILE: INFO,
    FIGMA_BRIDGE_TOKEN_FILE: TOKEN_FILE,
  },
  // stderr is kept: swallowing it is what made the one flaky run so hard to
  // read — the daemon says exactly which socket closed and why.
  stdio: ["ignore", "ignore", "pipe"],
});
let daemonErr = "";
daemon.stderr.on("data", (d) => { daemonErr = (daemonErr + d).slice(-6000); });

function mcpClient(destructive) {
  const proc = spawn("node", ["server/dist/index.js"], {
    env: {
      ...process.env,
      FIGMA_BRIDGE_INFO_FILE: INFO,
      FIGMA_BRIDGE_DESTRUCTIVE: destructive ? "1" : "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  let err = "";
  const pending = new Map();
  proc.stderr.on("data", (d) => { err = (err + d).slice(-3000); });
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  let rpcId = 0;
  return {
    proc,
    stderr: () => err,
    rpc(method, params) {
      const id = ++rpcId;
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error("rpc timeout " + method)), 15000);
        pending.set(id, (m) => { clearTimeout(t); res(m); });
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
  };
}

const textOf = (r) => JSON.stringify(r?.result?.content ?? r?.error ?? "");

let ws;
let locked;
let opened;
try {
  const t0 = Date.now();
  while (!existsSync(INFO) && Date.now() - t0 < 10000) await sleep(100);
  if (!existsSync(INFO)) throw new Error("daemon never wrote " + INFO);
  const info = JSON.parse(readFileSync(INFO, "utf8"));

  // A stub plugin that accepts anything, so any refusal observed must have come
  // from the server gate and not from the plugin.
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/?role=plugin&token=${info.pluginToken}`);
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  const reached = [];
  ws.on("message", (raw) => {
    const env = JSON.parse(raw.toString());
    reached.push(env.method);
    ws.send(JSON.stringify({ id: env.id, ok: true, result: { ok: true, changed: true, effects: { added: 1, removed: 0, changed: 0, scope: env.params?.scopeNodeId || "page-wide" } } }));
  });

  locked = mcpClient(false);
  opened = mcpClient(true);
  await sleep(1200);

  const init = async (c) => {
    await c.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    c.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  };
  await init(locked);
  await init(opened);

  const use = (c, args) => c.rpc("tools/call", { name: "figma_use", arguments: args });

  const r1 = await use(locked, { code: "return 1", allowDestructive: true, scopeNodeId: "1:2" });
  check("1. figma_use refused when FIGMA_BRIDGE_DESTRUCTIVE=0",
    textOf(r1).includes("FIGMA_BRIDGE_DESTRUCTIVE=0"), textOf(r1).slice(0, 100));
  check("1b. …and it never reached the plugin",
    !reached.includes("use_figma"), "plugin saw " + reached.join(","));

  const r2 = await use(opened, { code: "return 1", scopeNodeId: "1:2" });
  check("2. figma_use requires allowDestructive:true",
    textOf(r2).includes("allowDestructive"), textOf(r2).slice(0, 100));
  check("2b. …and it never reached the plugin",
    !reached.includes("use_figma"), "plugin saw " + reached.join(","));

  const r3 = await use(opened, { code: "return 1", allowDestructive: true });
  check("3. figma_use refuses without scopeNodeId or allowPageWide",
    textOf(r3).includes("scopeNodeId"), textOf(r3).slice(0, 100));
  check("3b. …and it never reached the plugin",
    !reached.includes("use_figma"), "plugin saw " + reached.join(","));

  // The gate must not make the tool unusable: a properly declared call goes
  // through, and the caller learns what it changed.
  const r4 = await use(opened, { code: "return 1", allowDestructive: true, scopeNodeId: "1:2" });
  check("4. a properly declared call DOES reach the plugin",
    reached.includes("use_figma"), "plugin saw " + reached.join(","));
  check("5. the result reports its effects, so a mutation is never silent",
    textOf(r4).includes("effects") && textOf(r4).includes("scope"), textOf(r4).slice(0, 140));

  // allowPageWide must actually pass through, not be silently dropped.
  const before = reached.length;
  await use(opened, { code: "return 1", allowDestructive: true, allowPageWide: true });
  check("6. allowPageWide is accepted and forwarded",
    reached.length === before + 1, "plugin saw " + reached.join(","));

  // The tool description must tell the agent the rules, or every one of these
  // refusals is a surprise at runtime.
  const list = await opened.rpc("tools/list", {});
  const desc = (list.result.tools.find((t) => t.name === "figma_use") || {}).description || "";
  check("7. the tool description states the safety contract",
    /allowDestructive/.test(desc) && /scopeNodeId/.test(desc) && /rolled back|rolls back/i.test(desc),
    desc.slice(0, 120));
} catch (e) {
  check("harness completed", false, String(e && e.message ? e.message : e));
} finally {
  try { locked && locked.proc.kill("SIGKILL"); } catch {}
  try { opened && opened.proc.kill("SIGKILL"); } catch {}
  try { ws && ws.close(); } catch {}
  try { daemon.kill("SIGTERM"); } catch {}
  await sleep(300);
  for (const f of [INFO, TOKEN_FILE]) if (existsSync(f)) rmSync(f);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log("failed: " + fails.join(", "));
  console.log("--- daemon stderr ---\n" + (daemonErr.trim() || "(empty)"));
  if (locked) console.log("--- client (destructive=0) stderr ---\n" + (locked.stderr().trim() || "(empty)"));
  if (opened) console.log("--- client (destructive=1) stderr ---\n" + (opened.stderr().trim() || "(empty)"));
}
// Explicit exit: the plugin socket and MCP children keep the loop alive.
setTimeout(() => process.exit(fails.length ? 1 : 0), 50);