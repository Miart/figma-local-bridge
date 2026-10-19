/**
 * Regression tests for three link-state bugs that made a LIVE, PAIRED plugin
 * report itself as offline for minutes while nothing was wrong.
 *
 *   1. DaemonLink guessed `connected` from its OWN socket state on open, so a
 *      client with no plugin at all claimed "connected" (false positive).
 *   2. The daemon never sent its current plugin state to a client that attached
 *      AFTER the plugin paired. A late client stayed `connected:false` forever
 *      (false negative) — this is the bug that looked like "the plugin keeps
 *      dying".
 *   3. DaemonLink had no reconnect, and the daemon mints a fresh clientKey on
 *      every start, so one daemon restart orphaned every MCP process forever.
 *
 * These are invisible to a test that only checks the happy path, which is why
 * the suite was green while the product was unusable.
 */
import "./helpers/journal-dir.mjs";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DaemonLink } from "../server/dist/link.js";
import { FigmaClient } from "../server/dist/figma.js";

const PORT = Number(process.env.TEST_PORT || 8898);
const INFO = join(homedir(), ".local/share/opencode", "figma-bridge-daemon-linktest.json");
const TOKEN = join(homedir(), ".local/share/opencode", "figma-bridge-daemon-linktest.secret");

let pass = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("PASS  " + name); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  <- " + detail : "")); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits for `fn()` to become true, or gives up. */
async function until(fn, ms = 4000, step = 50) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
}

function startDaemon() {
  return spawn("node", ["server/dist/daemon.js"], {
    env: {
      ...process.env,
      FIGMA_BRIDGE_PORT: String(PORT),
      FIGMA_BRIDGE_HOSTS: "127.0.0.1",
      FIGMA_BRIDGE_INFO_FILE: INFO,
      FIGMA_BRIDGE_TOKEN_FILE: TOKEN,
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
}

function pluginSocket(info) {
  const u = new URL(info.ws);
  u.searchParams.set("role", "plugin");
  u.searchParams.set("token", info.pluginToken);
  return new WebSocket(u.toString());
}

const readInfo = () => JSON.parse(require("node:fs").readFileSync(INFO, "utf8"));

// node's ESM loader has no require; make it work for the one read above.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

async function main() {
  for (const f of [INFO, TOKEN]) if (existsSync(f)) rmSync(f);

  let daemon = startDaemon();
  await until(() => existsSync(INFO), 5000);
  const info1 = readInfo();

  // ---------------------------------------------------------------- test 1
  // An MCP client that attaches with NO plugin must report offline. Before the
  // fix it reported connected:true because it read its own socket state.
  {
    const link = new DaemonLink(info1, "aaa", INFO);
    const client = new FigmaClient(link);
    link.connect();
    await sleep(400); // let the daemon's state frame arrive
    check(
      "1. client with no plugin reports OFFLINE",
      client.connected === false,
      "connected=" + client.connected,
    );
    link.close();
  }

  // ---------------------------------------------------------------- test 2
  // Plugin pairs, then an already-attached client learns about it.
  let plugin;
  {
    const link = new DaemonLink(info1, "bbb", INFO);
    const client = new FigmaClient(link);
    link.connect();
    await sleep(300);
    check("2a. offline before plugin pairs", client.connected === false);

    plugin = pluginSocket(info1);
    await new Promise((res, rej) => { plugin.on("open", res); plugin.on("error", rej); });

    const got = await until(() => client.connected === true, 4000);
    check("2b. attached client becomes CONNECTED when plugin pairs", got);

    plugin.close();
    const lost = await until(() => client.connected === false, 4000);
    check("2c. client goes OFFLINE when plugin leaves", lost);

    // Re-pair so test 3 has a plugin present.
    plugin = pluginSocket(info1);
    await new Promise((res, rej) => { plugin.on("open", res); plugin.on("error", rej); });
    await until(() => client.connected === true, 4000);
    link.close();
  }

  // ---------------------------------------------------------------- test 3
  // THE bug. A client that attaches AFTER the plugin is already paired must
  // learn the state immediately. Before the fix it waited for an event that had
  // already fired and reported a live file as empty/offline indefinitely.
  {
    const link = new DaemonLink(info1, "ccc", INFO);
    const client = new FigmaClient(link);
    link.connect();
    const saw = await until(() => client.connected === true, 3000);
    check(
      "3. LATE client immediately sees the already-paired plugin",
      saw,
      "connected=" + client.connected,
    );
    link.close();
  }

  // ---------------------------------------------------------------- test 4
  // The state frames are sent ONCE per connection. A subscriber that joins
  // AFTER they arrived must still learn the current state — otherwise any
  // component built late (index.ts used to construct its FigmaClient only
  // after connect()) reports a live, paired plugin as offline for the rest of
  // the session. That is exactly the "the plugin keeps dying" shape.
  {
    const link = new DaemonLink(info1, "eee", INFO);
    link.connect();

    // Precondition: watch the frames arrive from the wire on this connection.
    let wireFiles = null;
    const off = link.subscribe((e) => { if (e.event === "files") wireFiles = e; });
    const arrived = await until(() => !!wireFiles, 3000);
    off();
    check("4a. attach frames carry the state", arrived, JSON.stringify(wireFiles));

    // Now subscribe late, as a FigmaClient built after connect() would.
    const replayed = [];
    link.subscribe((e) => replayed.push(e));
    const linkEv = replayed.find((e) => e.event === "link");
    const filesEv = replayed.find((e) => e.event === "files");
    check(
      "4b. a subscriber that joins after the state still learns it",
      !!linkEv && linkEv.connected === true && !!filesEv && (filesEv.files || []).length === 1,
      JSON.stringify(replayed),
    );
    link.close();
  }

  // ---------------------------------------------------------------- test 5
  // Daemon restart must not orphan clients, and the client must pick up the NEW
  // clientKey rather than retrying with the dead one.
  {
    const link = new DaemonLink(info1, "ddd", INFO);
    const client = new FigmaClient(link);
    link.connect();
    await until(() => client.connected === true, 4000);
    check("5a. client connected before daemon restart", client.connected === true);

    daemon.kill("SIGTERM");
    await sleep(500);
    daemon = startDaemon();
    await until(() => existsSync(INFO) && readInfo().pid !== info1.pid, 6000);
    const info2 = readInfo();
    check("5b. daemon really restarted with a NEW clientKey", info2.clientKey !== info1.clientKey);

    // No plugin can be paired yet: the old plugin's socket died with the old
    // daemon. In the real product the Figma plugin retries every 2s; here we do
    // the same by hand. If the client had NOT reconnected, or had retried with
    // the dead clientKey (4403), it could never turn green.
    plugin.close();
    const plugin2 = pluginSocket(info2);
    await new Promise((res, rej) => { plugin2.on("open", res); plugin2.on("error", rej); });

    const back = await until(() => client.connected === true, 15_000, 100);
    check(
      "5c. client RECONNECTS by itself and re-authenticates with the new key",
      back,
      "connected=" + client.connected,
    );
    plugin = plugin2;
    link.close();
  }

  if (plugin) plugin.close();
  daemon.kill("SIGTERM");
  await sleep(300);
  for (const f of [INFO, TOKEN]) if (existsSync(f)) rmSync(f);

  console.log("\n" + pass + " passed, " + fails.length + " failed");
  if (fails.length) { console.log("failed: " + fails.join(", ")); process.exit(1); }
  process.exit(0);
}

main().catch((e) => {
  console.error("harness crashed: " + (e && e.stack ? e.stack : e));
  try { daemon.kill("SIGKILL"); } catch {}
  process.exit(2);
});