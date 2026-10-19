#!/usr/bin/env node
/**
 * Build smoke test: `npm run smoke`.
 *
 * The e2e suite drives the whole chain (daemon + a simulated plugin + retries),
 * which is exactly why it is slow and why it fails for reasons that have nothing
 * to do with "did the build survive". This is the other question, asked in a few
 * seconds and with no daemon at all:
 *
 *   does server/dist start, speak MCP, expose the intended tool surface, serve
 *   the guide, and fail offline the way an agent can act on?
 *
 * The figure of merit is the OFFLINE path: the bridge is not running most of the
 * time, so the first thing a new user (and every agent) meets is the offline
 * error. It must arrive in well under a second and name the reason, not hang.
 *
 * Pointing FIGMA_BRIDGE_INFO_FILE at a scratch path is what guarantees "no
 * daemon": the server then takes its offline branch even if the developer has a
 * real bridge running on the default path.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "server/dist/index.js");

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  process.stdout.write(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}\n`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(ENTRY)) {
  console.error(`no build at ${ENTRY} — run: npm run build`);
  process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), "figma-bridge-smoke-"));
const INFO = join(scratch, "daemon.json"); // never created: this is the offline case

const proc = spawn("node", [ENTRY], {
  env: { ...process.env, FIGMA_BRIDGE_INFO_FILE: INFO },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
proc.stderr.on("data", (d) => { stderr += d.toString(); });

let rpcId = 0;
const pending = new Map();
let buf = "";
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function rpc(method, params) {
  const id = ++rpcId;
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error("rpc timeout: " + method)), 5000);
    pending.set(id, (msg) => { clearTimeout(timer); res(msg); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const text = (res) => String(res?.result?.content?.[0]?.text ?? "");

try {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05", capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  check("server starts and answers initialize", !!init.result,
    init.result ? `${init.result.serverInfo.name} ${init.result.serverInfo.version}` : JSON.stringify(init.error));
  check("the guide rides the handshake",
    typeof init.result?.instructions === "string" && /fileKey/.test(init.result.instructions),
    `${init.result?.instructions?.length ?? 0} chars`);

  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await rpc("tools/list", {});
  const names = (list.result?.tools || []).map((t) => t.name);
  check("tool surface is present", names.length >= 20, `${names.length} tools`);
  for (const want of ["figma_ping", "figma_inspect", "figma_get_design_context", "figma_use", "figma_checkpoint", "figma_ops", "figma_cancel"]) {
    check(`${want} is exposed`, names.includes(want));
  }
  // The invariant the whole design rests on: no primitives.
  const primitives = names.filter((n) => /^figma_(remove|delete|move|reparent|duplicate|append_child|create_instance|set_constraints|get_node|get_page)$/.test(n));
  check("no primitive tools came back", primitives.length === 0, primitives.join(",") || "none");

  const res = await rpc("resources/read", { uri: "figma-local://guide/skill" });
  const guide = res.result?.contents?.[0]?.text || "";
  check("the guide resource reads", guide.length > 500 && guide.includes("scopeNodeId"), `${guide.length} chars`);

  const t0 = Date.now();
  const ping = text(await rpc("tools/call", { name: "figma_ping", arguments: {} }));
  const ms = Date.now() - t0;
  check("offline figma_ping answers fast", ms < 2000, `${ms}ms`);
  // figma_ping is the one tool that must NOT fail: it is how an agent learns the
  // bridge is down, so it answers connected:false instead of an error.
  let pingOk = false;
  try { pingOk = JSON.parse(ping).connected === false; } catch { /* stays false */ }
  check("offline figma_ping says connected:false", pingOk, ping.slice(0, 60));

  const t1 = Date.now();
  const insp = text(await rpc("tools/call", { name: "figma_inspect", arguments: { nodeId: "1:2" } }));
  const ms2 = Date.now() - t1;
  // ~2s by design: one bounded wait for a daemon that might be starting, then a
  // clean refusal. The number that matters is that it is not a hang.
  check("a file-scoped tool fails offline in seconds, not minutes", ms2 < 3000, `${ms2}ms`);
  check("...and names the reason", /FIGMA_BRIDGE_OFFLINE/.test(insp) && /daemon/i.test(insp),
    insp.replace(/\s+/g, " ").slice(0, 90));
} catch (e) {
  check("smoke run completed", false, String(e && e.message ? e.message : e));
} finally {
  try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  await sleep(150);
  rmSync(scratch, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log("failed:\n  " + failed.map((f) => f.name).join("\n  "));
  console.log("server stderr:\n" + stderr.trim());
  process.exitCode = 1;
}
