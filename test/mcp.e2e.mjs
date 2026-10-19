/**
 * End-to-end: MCP stdio -> FigmaClient -> daemon WebSocket -> simulated plugin.
 * The whole chain except Figma itself.
 *
 * REWRITTEN. The previous version of this file tested the original 10-tool MVP
 * surface (figma_remove, figma_append_child, figma_set_constraints,
 * figma_create_instance, figma_get_page, figma_get_node,
 * figma_replace_with_instance) — the exact primitives the design deliberately
 * removed. It had been failing silently (it scraped a token from a stderr
 * banner that index.ts now redacts), so the suite read green while testing a
 * surface that no longer exists.
 *
 * The most important assertion here is negative: the primitive surface must
 * NOT come back. That is the whole safety argument for the bridge.
 */
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PORT = Number(process.env.TEST_PORT || 8899);
const INFO = join(homedir(), ".local/share/opencode", "figma-bridge-daemon-mcptest.json");
const TOKEN_FILE = join(homedir(), ".local/share/opencode", "figma-bridge-daemon-mcptest.secret");

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  process.stdout.write(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}\n`);
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
  stdio: ["ignore", "ignore", "ignore"],
});

const proc = spawn("node", ["server/dist/index.js"], {
  env: {
    ...process.env,
    FIGMA_BRIDGE_INFO_FILE: INFO,
    FIGMA_BRIDGE_DESTRUCTIVE: "1",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
proc.stderr.on("data", (d) => { stderr += d.toString(); });

const waitForToken = async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if (existsSync(INFO)) {
      try {
        const t = JSON.parse(readFileSync(INFO, "utf8")).pluginToken;
        if (/^[0-9a-f]{32,}$/.test(t || "")) return t;
      } catch { /* daemon mid-write */ }
    }
    await sleep(100);
  }
  throw new Error("no daemon descriptor at " + INFO + "; stderr:\n" + stderr);
};

// Minimal MCP stdio client.
let rpcId = 0;
const pendingRpc = new Map();
let stdoutBuf = "";
proc.stdout.on("data", (d) => {
  stdoutBuf += d.toString();
  let i;
  while ((i = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, i).trim();
    stdoutBuf = stdoutBuf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pendingRpc.has(msg.id)) {
      pendingRpc.get(msg.id)(msg);
      pendingRpc.delete(msg.id);
    }
  }
});

function rpc(method, params) {
  const id = ++rpcId;
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error("rpc timeout: " + method)), 15000);
    pendingRpc.set(id, (msg) => { clearTimeout(timer); res(msg); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const toolText = (res) => {
  const t = res.result && res.result.content && res.result.content[0] && res.result.content[0].text;
  try { return t ? JSON.parse(t) : null; } catch { return null; }
};

/** Primitives that must never be reachable from an agent. */
const FORBIDDEN = [
  "figma_remove",
  "figma_append_child",
  "figma_set_constraints",
  "figma_create_instance",
  "figma_create_component_from_node",
  "figma_replace_with_instance",
  "figma_get_node",
  "figma_get_page",
  "figma_delete",
  "figma_duplicate",
  "figma_move",
  "figma_reparent",
];

let ws;
try {
  const token = await waitForToken();
  check("bridge token available from daemon descriptor", !!token);

  // Pair a simulated plugin BEFORE any tool call — this also exercises the
  // "client attaches late and must learn the state immediately" path.
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/?role=plugin&token=${token}`);
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });

  const calls = [];
  ws.on("message", (raw) => {
    const env = JSON.parse(raw.toString());
    calls.push(env.method);
    if (env.method === "ping") {
      ws.send(JSON.stringify({ id: env.id, ok: true, result: {
        ok: true, editor: "figma", writeEnabled: true, nodesOnPage: 1,
        page: { id: "0:1", name: "Actual" } } }));
    } else if (env.method === "get_selection") {
      ws.send(JSON.stringify({ id: env.id, ok: true, result: {
        page: { id: "0:1", name: "Actual" },
        selection: [{ id: "1:2", name: "HUD", type: "FRAME" }] } }));
    } else if (env.method === "inspect") {
      ws.send(JSON.stringify({ id: env.id, ok: true, result: {
        node: { id: env.params.nodeId || "1:2", type: "FRAME", name: "HUD", size: [10, 10], children: [] },
        fingerprint: { hash: "deadbeefdeadbeef", geometryStatus: "EXACT" },
        warnings: ["children[0] Union: boolean compared as tree: UNION"] } }));
    } else if (env.method === "replace_repeated_with_component") {
      ws.send(JSON.stringify({ id: env.id, ok: false, error: {
        message: "TARGETS_NOT_EQUIVALENT: 8:700 differs (fill)" } }));
    } else {
      ws.send(JSON.stringify({ id: env.id, ok: true, result: { echo: env.method } }));
    }
  });
  check("simulated plugin paired", true);

  // --- MCP handshake ---
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05", capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  check("initialize", !!init.result,
    init.result ? `server ${init.result.serverInfo.name}` : JSON.stringify(init.error));
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // --- tools/list ---
  const list = await rpc("tools/list", {});
  const names = (list.result.tools || []).map((t) => t.name);
  check("tools/list", names.length > 0, `${names.length} tools`);

  // The design invariant: no primitives.
  const leaked = FORBIDDEN.filter((f) => names.includes(f));
  check("NO primitive tools are exposed",
    leaked.length === 0,
    leaked.length ? "LEAKED: " + leaked.join(",") : `${FORBIDDEN.length} primitives absent`);

  const core = ["figma_ping", "figma_get_selection", "figma_inspect",
    "figma_replace_repeated_with_component"];
  const missingCore = core.filter((c) => !names.includes(c));
  check("all 4 core tools exposed", missingCore.length === 0,
    missingCore.length ? "missing: " + missingCore.join(",") : core.join(","));

  const parity = ["figma_use", "figma_get_metadata", "figma_whoami"];
  const missingParity = parity.filter((c) => !names.includes(c));
  check("parity tools exposed", missingParity.length === 0,
    missingParity.length ? "missing: " + missingParity.join(",") : parity.join(","));

  // --- the guide: handshake instructions + a readable resource ---
  // Both carry the same text, and it must be the file on disk, not the inline
  // fallback: that is what fails if guide.ts ever loses the path.
  const armed = "Which file a call lands in";
  check("initialize carries the operating guide as instructions",
    typeof init.result?.instructions === "string" && init.result.instructions.includes(armed),
    init.result?.instructions ? `${init.result.instructions.length} chars` : "none");

  const resList = await rpc("resources/list", {});
  const guideRes = (resList.result?.resources || []).find((r) => r.uri === "figma-local://guide/skill");
  check("guide is listed as a resource", !!guideRes,
    guideRes ? `${guideRes.mimeType}` : JSON.stringify(resList.result || resList.error));

  const resRead = await rpc("resources/read", { uri: "figma-local://guide/skill" });
  const guideText = resRead.result?.contents?.[0]?.text || "";
  check("guide resource reads back SKILL.md",
    guideText.includes(armed) && guideText.includes("scopeNodeId"),
    `${guideText.length} chars`);

  // --- calls through the real chain ---
  const ping = toolText(await rpc("tools/call", { name: "figma_ping", arguments: {} }));
  check("figma_ping round-trip reaches the plugin",
    ping && ping.connected === true && ping.editor === "figma",
    calls.includes("ping") ? `nodesOnPage=${ping && ping.nodesOnPage}` : "no plugin call");

  const sel = toolText(await rpc("tools/call", { name: "figma_get_selection", arguments: {} }));
  check("figma_get_selection", sel && sel.selection && sel.selection[0].id === "1:2",
    sel ? sel.source : "null");

  const insp = toolText(await rpc("tools/call", { name: "figma_inspect", arguments: { nodeId: "1:2" } }));
  check("figma_inspect returns fingerprint + boolean warning",
    insp && insp.fingerprint && insp.fingerprint.hash === "deadbeefdeadbeef" &&
    insp.warnings && /boolean/.test(insp.warnings[0]),
    insp ? insp.fingerprint.geometryStatus : "null");

  // A refusal from the plugin must reach the agent as an error, not as success.
  const repRaw = await rpc("tools/call", {
    name: "figma_replace_repeated_with_component",
    arguments: { sourceId: "1:2", componentKey: "k", expectedCount: 6, dryRun: true },
  });
  // A refusal arrives as an isError result whose text is NOT json — that is the
  // point of it: the agent must see the reason, not an empty success payload.
  const repText = String(repRaw.result?.content?.[0]?.text ?? JSON.stringify(repRaw));
  check("TARGETS_NOT_EQUIVALENT refusal surfaces to the agent",
    repText.includes("TARGETS_NOT_EQUIVALENT") && !!repRaw.result?.isError,
    repText.slice(0, 90));

  // --- offline path: kill the plugin, expect an instant clear error ---
  ws.close();
  await sleep(600);
  const pingOff = await rpc("tools/call", { name: "figma_ping", arguments: {} });
  const pingText = JSON.stringify(pingOff.result?.content?.[0]?.text ?? "");
  check("ping while offline reports connected:false",
    pingText.includes("connected") && pingText.includes("false"));

  const t0 = Date.now();
  const off = await rpc("tools/call", { name: "figma_inspect", arguments: { nodeId: "1:2" } });
  const offText = JSON.stringify(off.result?.content ?? off.error ?? "");
  const elapsed = Date.now() - t0;
  check("offline call fails FAST with FIGMA_BRIDGE_OFFLINE",
    offText.includes("FIGMA_BRIDGE_OFFLINE") && elapsed < 3000,
    `${elapsed}ms`);
} catch (e) {
  check("harness completed without crashing", false, String(e && e.message ? e.message : e));
} finally {
  try { ws && ws.close(); } catch {}
  try { proc.kill("SIGKILL"); } catch {}
  try { daemon.kill("SIGTERM"); } catch {}
  await sleep(300);
  for (const f of [INFO, TOKEN_FILE]) if (existsSync(f)) rmSync(f);
}

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);
console.log(`\n${passed}/${results.length} passed`);
if (failed.length) {
  console.log("failed:\n  " + failed.map((f) => f.name).join("\n  "));
  // NOT process.exit(): on a piped stdout it truncates buffered writes, which
  // made a failing run print nothing at all.
  process.exitCode = 1;
}