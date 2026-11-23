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
import { spawn } from "node:child_process";
import { connect as tcpConnect } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonLink, OfflineLink, readDaemonInfo, type DaemonInfo } from "./link.js";
import { BridgeOffline } from "./websocket.js";
import { FigmaClient } from "./figma.js";
import { registerTools, type Capabilities } from "./tools.js";
import { readCloudConfig } from "./cloud.js";
import { GUIDE, registerGuide } from "./guide.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

const INFO_FILE =
  process.env.FIGMA_BRIDGE_INFO_FILE ||
  join(homedir(), ".local/share/opencode/figma-bridge-daemon.json");

const caps: Capabilities = {
  read: true,
  write: process.env.FIGMA_BRIDGE_WRITE !== "0",
  destructive: process.env.FIGMA_BRIDGE_DESTRUCTIVE === "1",
};

// Opt-in, read-only, and independent of the local daemon. The token itself is
// never logged or serialised; only the mode and the public API base are.
const cloud = readCloudConfig();

function log(...a: unknown[]) {
  process.stderr.write(a.join(" ") + "\n");
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** Порт демона из дескриптора: больше о нём ничего не известно. */
function daemonPort(info: DaemonInfo | null): number | null {
  if (!info) return null;
  try {
    const port = Number(new URL(info.ws).port);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/**
 * Жив ли демон на самом деле.
 *
 * Файл дескриптора переживает падение демона: при SIGKILL или падении его никто
 * не удаляет, поэтому `existsSync(INFO_FILE)` отвечает «есть», когда слушать уже
 * некому, и сессия до конца жизни видит мёртвый порт. Единственная честная
 * проверка — TCP-коннект на порт из дескриптора.
 */
function daemonAnswers(info: DaemonInfo | null, timeoutMs = 400): Promise<boolean> {
  const port = daemonPort(info);
  if (port == null) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = tcpConnect({ host: "127.0.0.1", port });
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/**
 * Дескриптор работающего демона, при необходимости — только что поднятого.
 *
 * Демон общий на машину и не должен требовать ручного запуска: первый, кому он
 * понадобился (этот stdio-сервер, кнопка в панели плагина или launchd), его и
 * поднимает. Автостарт не спорит с launchd: живность проверяется до запуска, а
 * после — что дескриптор появился и порт отвечает, поэтому второй экземпляр не
 * плодится, даже если агент успел раньше.
 */
async function ensureDaemon(waitMs = 6000): Promise<DaemonInfo | null> {
  const current = readDaemonInfo(INFO_FILE);
  if (await daemonAnswers(current)) return current;

  const daemon = join(HERE, "daemon.js");
  try {
    const child = spawn(process.execPath, [daemon], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.unref();
    log("Figma Local Bridge — daemon was not answering, starting " + daemon +
      (child.pid ? " (pid " + child.pid + ")" : ""));
  } catch (e) {
    log("Figma Local Bridge — could not start the daemon: " + String((e as Error)?.message ?? e));
    return readDaemonInfo(INFO_FILE);
  }

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    const info = readDaemonInfo(INFO_FILE);
    if (await daemonAnswers(info)) return info;
  }
  return readDaemonInfo(INFO_FILE);
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
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: GUIDE },
  );
  registerGuide(server);

  // Поднимаем демон сами, если он не отвечает: иначе первая же сессия агента
  // проживёт весь срок с FIGMA_BRIDGE_OFFLINE, хотя демон можно было запустить
  // за секунду (дескриптор читается один раз — см. ниже).
  const info = await ensureDaemon();
  if (!info) {
    // Still serve tools; they will report the daemon is missing. Failing here
    // would make the whole MCP server disappear from the editor, and the first
    // tool call is exactly where the mistake should surface.
    registerTools(server, new FigmaClient(new OfflineLink()), caps, cloud);
    log("");
    log("Figma Local Bridge — daemon NOT running and could not be started.");
    log("  tried: " + join(HERE, "daemon.js"));
    log("  start it by hand:  npm run daemon");
    log("  expected info file: " + INFO_FILE);
    log("  the descriptor is read ONCE, at startup: tools report");
    log("  FIGMA_BRIDGE_OFFLINE for this whole session — restart the session");
    log("  (or the editor that spawned it) once the daemon is up.");
    log("");
    await server.connect(new StdioServerTransport());
    return;
  }

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

  registerTools(server, figma, caps, cloud);

  log("");
  log("Figma Local Bridge — client attached");
  log("  daemon : pid " + info.pid + "  ws " + info.ws.replace(/token=.*/, "token=<...>"));
  log("  caps   : read=" + caps.read + " write=" + caps.write + " destructive=" + caps.destructive);
  log("  cloud  : " + (cloud.enabled ? "read-only REST enabled" : "disabled"));
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