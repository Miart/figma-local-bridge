#!/usr/bin/env node
/**
 * Figma Local Bridge — DAEMON.
 *
 * Owns THE WebSocket to the Figma plugin. MCP client processes (one per working
 * directory, spawned by the editor) connect here instead. This exists because:
 *
 *   - the plugin can only be paired with one socket, and
 *   - Figma's CSP manifest can only allowlist FIXED origins, so the port cannot
 *     be ephemeral — but the editor spawns several MCP processes at once, which
 *     would collide on a fixed port.
 *
 * One daemon => one socket, one fixed port, one token, one plugin import.
 *
 * Run:  node server/dist/daemon.js
 */

import { randomBytes } from "node:crypto";
import { writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Daemon, type DaemonInfo } from "./link.js";

/**
 * The port Figma will actually be allowed to reach.
 *
 * It is fixed in plugin/manifest.json: `networkAccess.devAllowedDomains` lists
 * exact origins, and Figma refuses anything else, so a daemon on a different
 * port is simply unreachable from the plugin. Reading the manifest here means
 * the two cannot silently disagree — the old hardcoded 8787 could, the moment
 * someone edited the manifest.
 *
 * FIGMA_BRIDGE_PORT still wins, for the tests (each e2e daemon gets its own
 * port) and for a second instance; a mismatch is loud on purpose.
 */
function portFromManifest(): number | null {
  try {
    const file = new URL("../../plugin/manifest.json", import.meta.url);
    const m = JSON.parse(readFileSync(file, "utf8"));
    const domains: string[] = [...(m?.networkAccess?.devAllowedDomains || []), ...(m?.networkAccess?.allowedDomains || [])];
    for (const d of domains) {
      const p = Number(new URL(d).port);
      if (Number.isFinite(p) && p > 0) return p;
    }
  } catch {
    /* no manifest next to the build, or nothing usable in it */
  }
  return null;
}

const manifestPort = portFromManifest();
const envPort = process.env.FIGMA_BRIDGE_PORT ? Number(process.env.FIGMA_BRIDGE_PORT) : null;
const PORT = envPort || manifestPort || 8787;
const HOSTS = (process.env.FIGMA_BRIDGE_HOSTS || "127.0.0.1,::1").split(",");
const INFO_FILE =
  process.env.FIGMA_BRIDGE_INFO_FILE ||
  join(homedir(), ".local/share/opencode/figma-bridge-daemon.json");

/**
 * The token is PERSISTENT. It used to be minted per process start, so every
 * daemon restart (launchd does that after any crash) invalidated the token the
 * user had already pasted into the Figma plugin. One file, one stable value,
 * created only when absent.
 */
const TOKEN_FILE =
  process.env.FIGMA_BRIDGE_TOKEN_FILE ||
  join(homedir(), ".local/share/opencode/figma-bridge-daemon.secret");

function loadOrCreateToken(): string {
  try {
    const existing = readFileSync(TOKEN_FILE, "utf8").trim();
    if (/^[0-9a-f]{32,}$/.test(existing)) return existing;
  } catch {
    /* absent or unreadable — create below */
  }
  const token = randomBytes(16).toString("hex");
  writeFileSync(TOKEN_FILE, token + "\n", { mode: 0o600 });
  return token;
}

async function main() {
  const info: DaemonInfo = {
    ws: `ws://127.0.0.1:${PORT}/?token=`,
    pluginToken: loadOrCreateToken(),
    clientKey: randomBytes(24).toString("hex"),
    pid: process.pid,
    startedAt: Date.now(),
  };
  info.ws = `ws://127.0.0.1:${PORT}/?token=${info.pluginToken}`;

  const daemon = new Daemon(info);
  await daemon.listen(PORT, HOSTS);

  writeFileSync(INFO_FILE, JSON.stringify(info, null, 2), { mode: 0o600 });

  const log = (...a: unknown[]) => process.stderr.write(a.join(" ") + "\n");
  log("");
  log("Figma Local Bridge — daemon");
  log("  port    : " + PORT + " on " + HOSTS.join(", "));
  log("  token   : " + info.pluginToken);
  log("  info    : " + INFO_FILE);
  if (envPort && manifestPort && envPort !== manifestPort) {
    log("");
    log(`  WARNING: FIGMA_BRIDGE_PORT=${envPort}, but plugin/manifest.json only allows port ${manifestPort}.`);
    log("           Figma refuses origins that are not in the manifest, so the plugin cannot reach this");
    log("           daemon. That is fine for a test; for real use, unset the variable or edit the manifest.");
  }
  log("");
  log("  Figma > Plugins > Development > Import plugin from manifest");
  log("     -> " + new URL("../../plugin/manifest.json", import.meta.url).pathname);
  log("  then run 'Figma Local Bridge'; the first time it asks for the token above");
  log("  (the panel reads the port from manifest.json, and remembers the token)");
  log("");

  const bye = () => {
    daemon.close();
    process.exit(0);
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}

main().catch((e) => {
  process.stderr.write("daemon failed: " + String(e && (e as Error).message) + "\n");
  process.exit(1);
});