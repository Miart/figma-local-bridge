// End-to-end test for the DAEMON architecture:
//   plugin <--ws--> daemon <--ws--> one or more MCP client processes
// This is the shape that survives opencode spawning one MCP process per
// working directory, and the shape Figma's fixed-origin CSP actually allows.
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import fs from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { freshDescriptor } from "./helpers/fresh-descriptor.mjs";

const PORT = Number(process.env.TEST_PORT || 8897);
const INFO = join(homedir(), ".local/share/opencode", "figma-bridge-daemon-test.json");

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

async function mcpClient() {
  const proc = spawn("node", ["server/dist/index.js"], {
    env: { ...process.env, FIGMA_BRIDGE_INFO_FILE: INFO, FIGMA_BRIDGE_DESTRUCTIVE: "1", FIGMA_BRIDGE_JOURNAL: "0" },
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
    const t = setTimeout(() => rej(new Error("rpc timeout " + method)), 8000);
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

freshDescriptor(INFO);
const daemon = spawn("node", ["server/dist/daemon.js"], {
  env: { ...process.env, FIGMA_BRIDGE_PORT: String(PORT), FIGMA_BRIDGE_INFO_FILE: INFO },
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  // wait for the info file
  let info = null;
  for (let i = 0; i < 60 && !info; i++) {
    await sleep(150);
    try { info = JSON.parse(fs.readFileSync(INFO, "utf8")); } catch {}
  }
  check("daemon writes an info file", !!info, info ? `pid ${info.pid}` : "never appeared");

  if (!info) throw new Error("no daemon info");

  // Two MCP clients, as opencode would spawn — this is the case the old
  // single-socket design could not survive.
  const a = await mcpClient();
  const b = await mcpClient();
  await sleep(400);
  check("two MCP clients connect to ONE daemon", true);

  const lists = [await a.rpc("tools/list", {}), await b.rpc("tools/list", {})];
  const na = lists[0].result.tools.length, nb = lists[1].result.tools.length;
  check("both clients see the same tools", na === nb && na > 0, `${na} / ${nb}`);

  const offA = a.text(await a.rpc("tools/call", { name: "figma_ping", arguments: {} }));
  check("ping before plugin pair reports connected:false", offA && offA.connected === false);

  // Plugin connects with the token.
  const pluginUrl = info.ws.replace("127.0.0.1", "localhost") + "&role=plugin";
  const plugin = await connect(pluginUrl);
  check("plugin pairs using localhost (dual-stack)", !!plugin);

  const badUrl = new URL(info.ws.replace("127.0.0.1", "localhost"));
  badUrl.searchParams.set("token", "wrong");
  badUrl.searchParams.set("role", "plugin");
  // The handshake completes, then the server closes with 4401 — so assert on
  // the close code, not on whether 'open' fired.
  const bad = await connect(badUrl.toString());
  const badCode = bad ? await new Promise((res) => { bad.on("close", (c) => res(c)); setTimeout(() => res("no-close"), 3000); }) : "never-opened";
  check("wrong token refused", String(badCode) === "4401", `close=${badCode}`);

  // Answer RPCs immediately, otherwise the first ping has nobody to talk to.
  plugin.on("message", (raw) => {
    const env = JSON.parse(raw.toString());
    if (env.method === "ping") {
      plugin.send(JSON.stringify({ id: env.id, ok: true, result: { pong: true, page: "Actual" } }));
    }
    if (env.method === "get_selection") {
      plugin.send(JSON.stringify({
        id: env.id, ok: true,
        result: { page: { id: "0:1", name: "Actual" }, selection: [{ id: "9:9", name: "HUD", type: "FRAME" }] },
      }));
    }
    if (env.method === "route_probe") {
      plugin.send(JSON.stringify({ id: env.id, ok: true, result: { echo: env.id } }));
    }
  });

  await sleep(300);

  // Both clients must see the plugin, and a call through either must reach it.
  const pongA = a.text(await a.rpc("tools/call", { name: "figma_ping", arguments: {} }));
  check("client A sees plugin after pairing", !!(pongA && pongA.connected), JSON.stringify(pongA));

  const pongB = b.text(await b.rpc("tools/call", { name: "figma_ping", arguments: {} }));
  check("client B also sees the plugin (broadcast)", !!(pongB && pongB.connected), JSON.stringify(pongB));

  // Simulate the plugin answering an RPC that client B initiates.
  const selB = b.text(await b.rpc("tools/call", { name: "figma_get_selection", arguments: {} }));
  check("RPC from client B round-trips through daemon to plugin",
    !!(selB && selB.selection && selB.selection[0].id === "9:9"), JSON.stringify(selB));

  // Reply routing. A reply carries the id of the client that asked, namespaced
  // `<cid>:<id>`, and the daemon used to fan every reply out to every attached
  // client — every session parsed every other session's screenshots. Raw sockets
  // here, not MCP clients: through stdio a misrouted frame is silently dropped
  // (unknown id), so the bug would be invisible from up there.
  {
    const rawClient = async (cid) => {
      const u = new URL(info.ws.replace("127.0.0.1", "localhost"));
      u.searchParams.set("role", "mcp");
      u.searchParams.set("key", info.clientKey);
      u.searchParams.set("cid", cid);
      const ws = await connect(u.toString());
      const seen = [];
      ws.on("message", (raw) => { try { seen.push(JSON.parse(raw.toString())); } catch {} });
      return { ws, seen };
    };
    const ra = await rawClient("aaa11111");
    const rb = await rawClient("bbb22222");
    await sleep(300);
    ra.seen.length = 0; // drain the link/clients pushes sent on attach
    rb.seen.length = 0;

    ra.ws.send(JSON.stringify({ id: "aaa11111:probe-1", method: "route_probe", params: {} }));
    await sleep(500);

    const gotA = ra.seen.find((e) => e.id === "aaa11111:probe-1");
    const gotB = rb.seen.find((e) => String(e.id || "").includes("probe-1"));
    check("a reply reaches the client whose id namespace it carries", !!gotA && gotA.ok === true, JSON.stringify(ra.seen));
    check("…and is not broadcast to the other MCP session", !gotB, JSON.stringify(rb.seen));
    ra.ws.close(); rb.ws.close();
  }

  plugin.close();
  await sleep(300);
  const after = a.text(await a.rpc("tools/call", { name: "figma_ping", arguments: {} }));
  check("plugin disconnect is observed by clients", !!(after && after.connected === false));

  a.kill(); b.kill(); daemon.kill();
  try { fs.unlinkSync(INFO); } catch {}

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  process.exit(fail ? 1 : 0);
} catch (err) {
  process.stdout.write("ERROR: " + err.message + "\n");
  try { fs.unlinkSync(INFO); } catch {}
  daemon.kill();
  process.exit(1);
}