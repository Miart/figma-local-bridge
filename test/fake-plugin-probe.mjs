/**
 * Decisive check: can a Node process impersonate the plugin side at all?
 *
 * If this pairs, the daemon + protocol are sound and every drop we have seen is
 * Figma-side. If this is refused, the problem is in our own server.
 */
import { WebSocket } from "ws";
import { readFileSync } from "node:fs";

const info = JSON.parse(
  readFileSync(process.env.HOME + "/.local/share/opencode/figma-bridge-daemon.json", "utf8"),
);

const u = new URL(info.ws);
u.searchParams.set("role", "plugin");
u.searchParams.set("token", info.pluginToken);

const ws = new WebSocket(u.toString());
const out = { url: u.toString().replace(info.pluginToken, "<token>") };

ws.on("open", () => {
  out.paired = true;
  ws.send(JSON.stringify({ id: "probe-1", method: "ping", params: {} }));
});

ws.on("message", (d) => {
  out.echo = JSON.parse(d.toString());
  // Hold the slot open long enough for a real MCP call to land on it.
  setTimeout(() => {
    ws.close();
    process.exit(0);
  }, 4000);
});

ws.on("close", (code, reason) => {
  out.closed = { code, reason: String(reason) };
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
});

ws.on("error", (e) => {
  out.error = String(e.message);
  console.log(JSON.stringify(out, null, 2));
  process.exit(1);
});

setTimeout(() => {
  out.timeout = true;
  console.log(JSON.stringify(out, null, 2));
  process.exit(2);
}, 8000);