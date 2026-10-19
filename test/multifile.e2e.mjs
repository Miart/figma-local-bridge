// End-to-end test for MULTI-FILE routing:
//   plugin A (file aaa)  --ws-->            <--ws--> one MCP client
//   plugin B (file bbb)  --ws-->  daemon    <--ws--> one raw MCP client
//
// One daemon used to hold ONE plugin slot; the second Figma window was refused
// with 4409. This test pins the replacement contract:
//
//   * two files stay paired at once
//   * figma_ping lists them (it is the tool an agent calls to learn fileKeys)
//   * a call without fileKey with two files is refused WITH the list, before
//     anything is sent — never a guess
//   * a call with fileKey goes to that plugin and nowhere else
//   * an unroutable request is answered by the daemon immediately, not left to
//     time out, and its id echoes back so the caller can match it
//   * reconnecting the SAME file replaces its old socket (4409) without
//     disturbing the other file
//   * one file closing removes only its own entry
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import fs from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PORT = Number(process.env.TEST_PORT_MULTI || 8898);
const INFO = join(homedir(), ".local/share/opencode", "figma-bridge-daemon-multifile-test.json");

const ATLAS = { fileKey: "aaa0000000000001", name: "Atlas" };
const LOBBY = { fileKey: "bbb0000000000002", name: "Lobby" };

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
    env: { ...process.env, FIGMA_BRIDGE_INFO_FILE: INFO, FIGMA_BRIDGE_DESTRUCTIVE: "1" },
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
  return { proc, rpc, kill: () => proc.kill() };
}

/** Tool result as text; a refusal arrives as isError with a plain message. */
const textOf = (r) => {
  const raw = r?.result?.content?.[0]?.text;
  if (typeof raw !== "string") return "";
  try { return JSON.parse(raw); } catch { return raw; }
};
const isError = (r) => r?.result?.isError === true;

function pluginUrl(info, file) {
  const u = new URL(info.ws.replace("127.0.0.1", "localhost"));
  u.searchParams.set("role", "plugin");
  u.searchParams.set("fileKey", file.fileKey);
  u.searchParams.set("name", file.name);
  return u.toString();
}

/** Answers like a plugin, and records what it was asked. */
async function fakePlugin(info, file) {
  const ws = await connect(pluginUrl(info, file));
  if (!ws) return null;
  ws.methods = [];
  ws.on("message", (raw) => {
    let env; try { env = JSON.parse(raw.toString()); } catch { return; }
    if (!env.method) return;
    ws.methods.push({ method: env.method, file: env.file, params: env.params });
    ws.send(JSON.stringify({ id: env.id, ok: true, result: { pong: true, page: file.name } }));
  });
  // Announce a selection, as the real plugin does on load.
  ws.send(JSON.stringify({
    id: null, event: "selection",
    page: { id: "0:1", name: file.name },
    selection: [{ id: "1:1", name: file.name + " node", type: "FRAME" }],
  }));
  return ws;
}

const daemon = spawn("node", ["server/dist/daemon.js"], {
  env: { ...process.env, FIGMA_BRIDGE_PORT: String(PORT), FIGMA_BRIDGE_INFO_FILE: INFO },
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  let info = null;
  for (let i = 0; i < 60 && !info; i++) {
    await sleep(150);
    try { info = JSON.parse(fs.readFileSync(INFO, "utf8")); } catch {}
  }
  check("daemon writes an info file", !!info, info ? `pid ${info.pid}` : "never appeared");
  if (!info) throw new Error("no daemon info");

  const client = await mcpClient();

  const off = textOf(await client.rpc("tools/call", { name: "figma_ping", arguments: {} }));
  check("no files yet: connected:false and an empty list", off && off.connected === false && Array.isArray(off.files) && off.files.length === 0, JSON.stringify(off));

  const atlas = await fakePlugin(info, ATLAS);
  const lobby = await fakePlugin(info, LOBBY);
  check("two files pair at once (no 4409 refusal)", !!atlas && !!lobby);
  await sleep(400);

  const ping = textOf(await client.rpc("tools/call", { name: "figma_ping", arguments: {} }));
  const keys = (ping && ping.files || []).map((f) => f.fileKey).sort();
  check("figma_ping lists both files without a fileKey", ping && ping.connected === true && keys.join() === [ATLAS.fileKey, LOBBY.fileKey].sort().join(), JSON.stringify(ping));
  check("…and says to pass fileKey", typeof ping?.note === "string", JSON.stringify(ping?.note));

  // A call with no fileKey and two files must be refused WITH the list, before
  // anything reaches a plugin.
  atlas.methods.length = 0; lobby.methods.length = 0;
  const ambiguous = await client.rpc("tools/call", { name: "figma_get_selection", arguments: {} });
  const ambiguousText = String(textOf(ambiguous));
  check("no fileKey with two files: refused, not guessed", isError(ambiguous) && /more than one Figma file is connected/.test(ambiguousText), ambiguousText);
  check("…the refusal lists both files", /"Atlas"/.test(ambiguousText) && /"Lobby"/.test(ambiguousText), ambiguousText);
  check("…and nothing was sent to either plugin", atlas.methods.length === 0 && lobby.methods.length === 0, JSON.stringify([atlas.methods, lobby.methods]));

  // fileKey routes; the other plugin never sees the call.
  const sel = textOf(await client.rpc("tools/call", { name: "figma_get_selection", arguments: { fileKey: LOBBY.fileKey } }));
  check("figma_get_selection with fileKey answers from that file", sel && sel.selection && sel.selection[0].name === "Lobby node", JSON.stringify(sel));

  const meta = textOf(await client.rpc("tools/call", { name: "figma_get_metadata", arguments: { nodeId: "1:2", fileKey: LOBBY.fileKey } }));
  check("a routed call reaches the right plugin", lobby.methods.some((m) => m.method === "get_metadata" && m.file === LOBBY.fileKey), JSON.stringify(lobby.methods));
  check("…and not the other one", !atlas.methods.some((m) => m.method === "get_metadata"), JSON.stringify(atlas.methods));

  // Daemon-level refusals, seen through a raw socket so the client-side checks
  // cannot mask them.
  {
    const u = new URL(info.ws.replace("127.0.0.1", "localhost"));
    u.searchParams.set("role", "mcp");
    u.searchParams.set("key", info.clientKey);
    u.searchParams.set("cid", "raw00001");
    const ws = await connect(u.toString());
    const seen = [];
    ws.on("message", (raw) => { try { seen.push(JSON.parse(raw.toString())); } catch {} });
    await sleep(300);

    const helloFiles = seen.find((e) => e.event === "files");
    const helloKeys = (helloFiles?.files || []).map((f) => f.fileKey).sort();
    check("a late client is told the files in its hello packet", helloKeys.join() === [ATLAS.fileKey, LOBBY.fileKey].sort().join(), JSON.stringify(helloFiles));

    seen.length = 0;
    const t0 = Date.now();
    ws.send(JSON.stringify({ id: "raw00001:gone-1", method: "ping", params: {}, file: "no-such-file" }));
    await sleep(700);
    const gone = seen.find((e) => e.id === "raw00001:gone-1");
    check("unknown fileKey: daemon answers with an error, not a timeout", !!gone && gone.ok === false, JSON.stringify(seen));
    check("…fast (no waiting for a plugin)", Date.now() - t0 < 1500, `${Date.now() - t0}ms`);
    check("…with the id echoed for matching", !!gone && gone.id === "raw00001:gone-1");
    check("…and the reason names the file", /FIGMA_BRIDGE_UNKNOWN_FILE.*no Figma plugin is connected for fileKey "no-such-file"/s.test(String(gone?.error?.message)), JSON.stringify(gone?.error));

    seen.length = 0;
    ws.send(JSON.stringify({ id: "raw00001:two-1", method: "ping", params: {} }));
    await sleep(700);
    const two = seen.find((e) => e.id === "raw00001:two-1");
    check("two files, no fileKey: daemon refuses with the list", !!two && two.ok === false && /FIGMA_BRIDGE_FILE_KEY_REQUIRED/.test(String(two.error?.message)) && /more than one file is connected/.test(String(two.error?.message)), JSON.stringify(seen));
    ws.close();
  }

  // Reconnecting the same file replaces its socket; the neighbour is untouched.
  // Attach the close listener BEFORE the replacement connects: the daemon sends
  // the 4409 the moment the new socket arrives, which can beat this script.
  const oldClosed = new Promise((res) => { atlas.on("close", (c) => res(c)); setTimeout(() => res("no-close"), 3000); });
  const replacement = await fakePlugin(info, ATLAS);
  const oldCode = await oldClosed;
  check("the replaced socket is closed with 4409", String(oldCode) === "4409", `close=${oldCode}`);

  const filesAfterReplace = textOf(await client.rpc("tools/call", { name: "figma_ping", arguments: {} }));
  const keysAfter = (filesAfterReplace.files || []).map((f) => f.fileKey).sort();
  check("the files list still has exactly one entry per file", keysAfter.join() === [ATLAS.fileKey, LOBBY.fileKey].sort().join(), JSON.stringify(filesAfterReplace));

  replacement.methods.length = 0;
  const meta2 = textOf(await client.rpc("tools/call", { name: "figma_get_metadata", arguments: { nodeId: "1:3", fileKey: ATLAS.fileKey } }));
  check("calls now reach the replacement socket", replacement.methods.some((m) => m.method === "get_metadata" && m.file === ATLAS.fileKey), JSON.stringify(replacement.methods));

  // Closing one file must remove only its entry.
  replacement.close();
  await sleep(400);
  const afterClose = textOf(await client.rpc("tools/call", { name: "figma_ping", arguments: {} }));
  const keysAfterClose = (afterClose.files || []).map((f) => f.fileKey);
  check("closing one file leaves the other connected", afterClose.connected === true && keysAfterClose.join() === LOBBY.fileKey, JSON.stringify(afterClose));

  const toGoneFile = await client.rpc("tools/call", { name: "figma_get_selection", arguments: { fileKey: ATLAS.fileKey } });
  const toGoneText = String(textOf(toGoneFile));
  check("a call to the closed file is refused with the current list", isError(toGoneFile) && /FIGMA_BRIDGE_UNKNOWN_FILE/.test(toGoneText) && /no Figma plugin is connected for fileKey/.test(toGoneText) && /"Lobby"/.test(toGoneText) && !/"Atlas"/.test(toGoneText), toGoneText);

  lobby.close();
  await sleep(400);
  const last = textOf(await client.rpc("tools/call", { name: "figma_ping", arguments: {} }));
  check("with the last file gone: connected:false again", last && last.connected === false && (last.files || []).length === 0, JSON.stringify(last));

  client.kill(); daemon.kill();
  try { fs.unlinkSync(INFO); } catch {}

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  process.exit(fail ? 1 : 0);
} catch (err) {
  process.stdout.write("ERROR: " + err.message + "\n");
  try { fs.unlinkSync(INFO); } catch {}
  daemon.kill();
  process.exit(1);
}
