#!/usr/bin/env node
/**
 * Figma Local Bridge — MCP stdio CLIENT.
 *
 * The editor spawns one of these per working directory. None of them own the
 * WebSocket: they attach to the long-lived daemon (server/dist/daemon.js), which
 * holds the single socket to the Figma plugin on a fixed port.
 *
 * stdout is reserved for the MCP protocol; all diagnostics go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DaemonLink, OfflineLink, readDaemonInfo } from "./link.js";
import { BridgeOffline } from "./websocket.js";
import { FigmaClient } from "./figma.js";
import { registerTools, type Capabilities } from "./tools.js";
import { GUIDE, registerGuide } from "./guide.js";

const INFO_FILE =
  process.env.FIGMA_BRIDGE_INFO_FILE ||
  join(homedir(), ".local/share/opencode/figma-bridge-daemon.json");

const caps: Capabilities = {
  read: true,
  write: process.env.FIGMA_BRIDGE_WRITE !== "0",
  destructive: process.env.FIGMA_BRIDGE_DESTRUCTIVE === "1",
};

function log(...a: unknown[]) {
  process.stderr.write(a.join(" ") + "\n");
}

async function main() {
  // The guide rides the handshake as well as the resource: a client that shows
  // `instructions` to the model at connect time teaches the retry and fileKey
  // rules before the first call, and one that ignores them can still fetch
  // figma-local://guide/skill. Deliberately short — it is a doctrine, not the
  // README.

  // The version clients print for this server. Keep it in step with
  // package.json: the two numbers had already drifted apart once.
  const server = new McpServer(
    { name: "figma-local-bridge", version: "0.5.0" },
    { capabilities: { tools: {} }, instructions: GUIDE },
  );
  registerGuide(server);

  if (!existsSync(INFO_FILE)) {
    // Still serve tools; they will report the daemon is missing. Failing here
    // would make the whole MCP server disappear from the editor, and the first
    // tool call is exactly where the mistake should surface.
    registerTools(server, new FigmaClient(new OfflineLink()), caps);
    log("");
    log("Figma Local Bridge — daemon NOT running.");
    log("  start it with:  npm run daemon");
    log("  expected info file: " + INFO_FILE);
    log("  the descriptor is read ONCE, at startup: tools report");
    log("  FIGMA_BRIDGE_OFFLINE for this whole session — restart the session");
    log("  (or the editor that spawned it) once the daemon is up.");
    log("");
    await server.connect(new StdioServerTransport());
    return;
  }

  const info = readDaemonInfo(INFO_FILE);
  if (!info) throw new Error("daemon info file is unreadable: " + INFO_FILE);

  const link = new DaemonLink(info, undefined, INFO_FILE);

  // Subscribe BEFORE the socket opens. The daemon sends its current state —
  // `link` and `files` — exactly once per connection, when the client
  // attaches; a FigmaClient built after connect() could miss both frames and
  // spend the whole session reporting a live plugin as offline. (link-state.e2e
  // pins the invariant on the link itself; this ordering is what made the gap
  // reachable from here.)
  const figma = new FigmaClient(link);
  link.connect();

  // Wait for the daemon's authoritative plugin state rather than sleeping a
  // guessed interval: the very first tool call after startup must not race it.
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 1500);
    const off = link.subscribe((e) => {
      if (e.event === "link" || e.event === "linkattached") {
        clearTimeout(t);
        off();
        resolve();
      }
    });
  });

  registerTools(server, figma, caps);

  log("");
  log("Figma Local Bridge — client attached");
  log("  daemon : pid " + info.pid + "  ws " + info.ws.replace(/token=.*/, "token=<...>"));
  log("  caps   : read=" + caps.read + " write=" + caps.write + " destructive=" + caps.destructive);
  log("");

  await server.connect(new StdioServerTransport());
}

/**
 * Fail loudly on a rejection nobody handled.
 *
 * In this process those come from chains we deliberately do not await — the
 * daemon link's reconnect timer, socket callbacks. Continuing would serve tool
 * calls over a link that may be half-dead, and a silent hang is precisely how
 * the accident that started all this went unnoticed for so long. Exiting makes
 * the editor restart the server, so the next tool call either works or reports
 * a clean FIGMA_BRIDGE_OFFLINE.
 *
 * The stack matters here: the old message was `String(e)`, which threw away the
 * one line that says WHERE it happened.
 */
process.on("unhandledRejection", (e) => {
  const err = e as any;
  log("bridge fatal: unhandled rejection in pid " + process.pid);
  log(String((err && err.stack) || err));
  if (err instanceof BridgeOffline) log("(a link failure — see README, «Диагностика»)");
  process.exit(1);
});

main().catch((e) => {
  log("bridge failed to start: " + String(e && (e as Error).message));
  process.exit(1);
});