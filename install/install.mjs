#!/usr/bin/env node
/**
 * Figma Local Bridge — macOS installer.
 *
 * This is deliberately a small, auditable program: it installs a prebuilt
 * release next to the user's data, writes one per-user LaunchAgent, makes a
 * backup before touching a client config, and never prints the daemon token.
 * Figma has no public API for registering a development plugin, so importing
 * `plugin/manifest.json` remains the one manual step.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import {
  DEFAULT_LABEL,
  appPaths,
  appVersionFromPackage,
  appleScriptString,
  backupPathFor,
  buildLaunchAgentPlist,
  clientTargets,
  configMode,
  isOurDaemonCommand,
  isSupportedNodeVersion,
  mcpServerEntry,
  mergeMcpServers,
  mergeOpenCodeConfig,
  openCodeServerEntry,
  parseArgs,
  parseClientSelection,
  readJsonConfig,
} from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = dirname(HERE);
const VERSION = appVersionFromPackage(SOURCE_ROOT) || "0.34.1";
const APP_ALLOWLIST = [
  "package.json",
  "package-lock.json",
  "server/dist",
  "plugin/code.js",
  "plugin/ui.html",
  "plugin/manifest.json",
  "skills",
  "install",
  "README.md",
  "llms.txt",
  "LICENSE",
  "node_modules",
];
const REQUIRED_SOURCE = [
  "server/dist/index.js",
  "server/dist/daemon.js",
  "plugin/code.js",
  "plugin/ui.html",
  "plugin/manifest.json",
  "node_modules/@modelcontextprotocol/sdk",
  "node_modules/ws",
  "node_modules/zod",
];

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--version")) {
    process.stdout.write(VERSION + "\n");
    return;
  }
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }
  if (process.platform !== "darwin") {
    throw installError("UNSUPPORTED_PLATFORM", "The 0.34 installer supports macOS only. Use the source checkout on other platforms.");
  }
  if (!isSupportedNodeVersion(process.versions.node)) {
    throw installError("NODE_TOO_OLD", `Node.js ${process.versions.node} is too old; this installer needs Node.js 20 or newer.`);
  }
  validateSource();
  const paths = appPaths(homedir(), {});
  const appDir = options.appDir ? resolve(options.appDir) : paths.appDir;
  if (appDir === "/" || appDir === resolve(homedir())) {
    throw installError("UNSAFE_APP_DIR", `Refusing to install into ${appDir}. Choose a dedicated app directory.`);
  }
  if (
    existsSync(appDir)
    && safeRealpath(appDir) !== safeRealpath(SOURCE_ROOT)
    && !existsSync(join(appDir, "server/dist/index.js"))
    && !existsSync(join(appDir, "plugin/manifest.json"))
  ) {
    throw installError("UNSAFE_APP_DIR", `${appDir} exists but does not look like a Figma Local Bridge app directory; refusing to replace it.`);
  }
  const clientSelection = parseClientSelection(options.client);
  const selectedClients = selectClients(paths, clientSelection);
  const nodePath = process.execPath;
  const serverPath = join(appDir, "server/dist/index.js");
  const daemonPath = join(appDir, "server/dist/daemon.js");
  const port = readManifestPort(SOURCE_ROOT) || 8787;
  const report = {
    ok: true,
    version: VERSION,
    appDir,
    plistPath: paths.plistPath,
    infoFile: paths.infoFile,
    port,
    dryRun: options.dryRun,
    daemon: { started: false, pid: null },
    token: { copiedToClipboard: false },
    configs: [],
    manualSteps: [],
  };

  say(options, `Figma Local Bridge ${VERSION}`);
  say(options, `  app    : ${appDir}`);
  say(options, `  launchd: ${paths.plistPath}`);
  say(options, `  logs   : ${paths.logDir}`);

  if (options.dryRun) {
    report.configs = selectedClients.map((target) => ({
      id: target.id,
      label: target.label,
      path: target.path,
      action: target.exists ? "would-update" : "would-create",
      skipped: false,
    }));
    report.manualSteps = manualSteps(appDir, paths, false);
    printReport(options, report);
    return;
  }

  if (!options.noStart) {
    validateRunningPort(port);
    stopExistingDaemon(paths, port);
  }
  mkdirSync(paths.logDir, { recursive: true });
  mkdirSync(paths.launchAgentsDir, { recursive: true });

  const previousPlist = existsSync(paths.plistPath) ? readFileSync(paths.plistPath, "utf8") : null;
  const appInstall = installApp(SOURCE_ROOT, appDir);
  let rollback = () => {};
  try {
    const plist = buildLaunchAgentPlist({
      label: DEFAULT_LABEL,
      nodePath,
      daemonPath,
      workingDirectory: appDir,
      stdoutLog: paths.stdoutLog,
      stderrLog: paths.stderrLog,
      logDir: paths.logDir,
    });
    writeFileSync(paths.plistPath, plist, { mode: 0o644 });
    rollback = () => {
      try { bootout(paths.plistPath); } catch { /* best effort */ }
      try {
        if (previousPlist === null) rmSync(paths.plistPath, { force: true });
        else writeFileSync(paths.plistPath, previousPlist, { mode: 0o644 });
      } catch { /* best effort */ }
      appInstall.restore();
    };

    if (options.noStart) {
      say(options, "  daemon : plist written; --no-start skipped launchctl");
    } else {
      startAgent(paths.plistPath);
      const before = readDaemonInfo(paths.infoFile);
      const info = waitForDaemon(paths.infoFile, before?.startedAt ?? null, 15_000);
      report.daemon = { started: true, pid: info.pid, startedAt: info.startedAt };
      say(options, `  daemon : running (pid ${info.pid}, port ${port})`);

      if (!options.noClipboard) {
        const copied = copyToClipboard(String(info.pluginToken));
        report.token.copiedToClipboard = copied;
        say(options, `  token  : ${copied ? "copied to clipboard" : "could not copy; see " + paths.infoFile}`);
      }
    }

    const configs = options.noConfig ? [] : installConfigs({
      targets: selectedClients,
      appDir,
      nodePath,
      serverPath,
      paths,
      dryRun: false,
    });
    report.configs = configs;
    for (const config of configs) {
      if (config.skipped) say(options, `  config : ${config.label}: skipped (${config.reason})`);
      else if (config.action === "unchanged") say(options, `  config : ${config.label}: already up to date`);
      else say(options, `  config : ${config.label}: ${config.action} (${config.path})`);
    }

    if (!options.noOpen) openPluginFolder(appDir);
    report.manualSteps = manualSteps(appDir, paths, report.token.copiedToClipboard);
    printReport(options, report);
    if (options.gui) finalDialog(appDir, report);
    appInstall.commit();
  } catch (error) {
    rollback();
    throw error;
  }
}

function installError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function say(options, text) {
  if (options.json) process.stderr.write(text + "\n");
  else process.stdout.write(text + "\n");
}

function printHelp() {
  process.stdout.write(`Figma Local Bridge ${VERSION} — macOS installer

Usage: node install/install.mjs [options]

Options:
  --dry-run            Print the plan without writing anything
  --no-start           Write the LaunchAgent but do not load or stop the daemon
  --no-config          Do not edit MCP client configs
  --no-clipboard       Do not copy the daemon token to the clipboard
  --no-open            Do not open the plugin folder in Finder
  --client=LIST        auto (default), all, none, or comma-separated:
                       opencode, claude-code, claude-desktop, cursor
  --app-dir=PATH       Install the app somewhere else (tests)
  --gui                Use macOS dialogs for the final screen and errors
  --json               Machine-readable report on stdout
  --help               This help
`);
}

function validateSource() {
  const missing = REQUIRED_SOURCE.filter((relative) => !existsSync(join(SOURCE_ROOT, relative)));
  if (missing.length) {
    throw installError(
      "BUILD_REQUIRED",
      `This is not a built release: missing ${missing.join(", ")}. Run "npm run build" and "npm run build:release", or use a release zip.`,
    );
  }
}

function readManifestPort(root) {
  try {
    const manifest = JSON.parse(readFileSync(join(root, "plugin/manifest.json"), "utf8"));
    for (const value of [
      ...(manifest?.networkAccess?.devAllowedDomains || []),
      ...(manifest?.networkAccess?.allowedDomains || []),
    ]) {
      const port = Number(new URL(value).port);
      if (Number.isFinite(port) && port > 0) return port;
    }
  } catch { /* fall back */ }
  return null;
}

function selectClients(paths, selection) {
  const all = clientTargets(paths).map((target) => ({
    ...target,
    exists: existsSync(target.path),
  }));
  if (selection.mode === "none") return [];
  if (selection.mode === "explicit") return all.filter((target) => selection.selected.has(target.id));
  if (selection.mode === "all") return all;
  return all.filter((target) => target.exists || detectedApp(target.id));
}

function detectedApp(id) {
  if (id === "opencode") return commandExists("opencode");
  if (id === "claude-code") return commandExists("claude") || existsSync(join(homedir(), ".local/bin/claude"));
  if (id === "claude-desktop") return existsSync("/Applications/Claude.app");
  if (id === "cursor") return existsSync("/Applications/Cursor.app");
  return false;
}

function commandExists(command) {
  const result = spawnSync("/usr/bin/which", [command], { encoding: "utf8" });
  return result.status === 0 && Boolean(result.stdout.trim());
}

function installApp(sourceRoot, appDir) {
  const source = safeRealpath(sourceRoot);
  const target = safeRealpath(appDir);
  if (source === target) return { restore() {}, commit() {} };
  const tmp = `${appDir}.new-${process.pid}`;
  const previous = `${appDir}.previous-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  rmSync(previous, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    for (const entry of APP_ALLOWLIST) {
      const from = join(sourceRoot, entry);
      if (!existsSync(from)) continue;
      cpSync(from, join(tmp, entry), { recursive: true, force: true, dereference: false });
    }
    if (existsSync(appDir)) renameSync(appDir, previous);
    try {
      renameSync(tmp, appDir);
    } catch (error) {
      if (existsSync(previous)) renameSync(previous, appDir);
      throw error;
    }
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
  let active = true;
  return {
    restore() {
      if (!active) return;
      active = false;
      try { rmSync(appDir, { recursive: true, force: true }); } catch { /* best effort */ }
      try { if (existsSync(previous)) renameSync(previous, appDir); } catch { /* best effort */ }
    },
    commit() {
      active = false;
      rmSync(previous, { recursive: true, force: true });
    },
  };
}

function safeRealpath(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function writeJsonAtomic(path, data) {
  const mode = configMode(path);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode });
    renameSync(tmp, path);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function installConfigs({ targets, appDir, nodePath, serverPath, paths }) {
  const results = [];
  for (const target of targets) {
    const read = readJsonConfig(target.path);
    if (!read.ok) {
      results.push({
        id: target.id,
        label: target.label,
        path: target.path,
        action: "skipped",
        skipped: true,
        reason: `cannot parse JSON: ${read.error}; not touching the file`,
      });
      continue;
    }
    try {
      const merged = target.kind === "opencode"
        ? mergeOpenCodeConfig(read.data, openCodeServerEntry({ nodePath, serverPath }), { serverPath })
        : mergeMcpServers(
          read.data,
          mcpServerEntry({
            nodePath,
            serverPath,
            type: target.id === "claude-code" ? "stdio" : null,
          }),
          { serverPath },
        );
      if (!merged.changed) {
        results.push({
          id: target.id,
          label: target.label,
          path: target.path,
          key: merged.key,
          action: "unchanged",
          skipped: false,
        });
        continue;
      }
      const backup = backupPathFor(target.path);
      if (read.exists) copyFileSync(target.path, backup);
      writeJsonAtomic(target.path, merged.config);
      results.push({
        id: target.id,
        label: target.label,
        path: target.path,
        key: merged.key,
        action: merged.action,
        backup: read.exists ? backup : null,
        skipped: false,
      });
    } catch (error) {
      results.push({
        id: target.id,
        label: target.label,
        path: target.path,
        action: "skipped",
        skipped: true,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

function copyToClipboard(text) {
  const result = spawnSync("pbcopy", [], { input: text, encoding: "utf8" });
  return result.status === 0;
}

function openPluginFolder(appDir) {
  try {
    spawnSync("open", ["-R", join(appDir, "plugin/manifest.json")], { stdio: "ignore" });
  } catch { /* Finder is a convenience, not a requirement */ }
}

function manualSteps(appDir, paths, tokenCopied) {
  return [
    `Figma → Plugins → Development → Import plugin from manifest… → ${join(appDir, "plugin/manifest.json")}`,
    "Run “Figma Local Bridge” and paste the token" + (tokenCopied ? " (already in the clipboard)" : ` from ${paths.infoFile}`),
    "Restart the MCP client you configured",
  ];
}

function finalDialog(appDir, report) {
  const message = [
    `Figma Local Bridge ${VERSION} installed.`,
    "",
    "1. Figma → Plugins → Development → Import plugin from manifest…",
    `   ${join(appDir, "plugin/manifest.json")}`,
    "2. Run “Figma Local Bridge” and paste the token" +
      (report.token.copiedToClipboard ? " (it is in the clipboard)." : "."),
    "3. Restart your MCP client.",
  ].join("\n");
  osaDialog(message, "Figma Local Bridge");
}

function errorDialog(error) {
  const message = [
    "Figma Local Bridge could not finish installing.",
    "",
    error?.code ? `Code: ${error.code}` : null,
    String(error?.message || error),
    "",
    "Nothing was silently reported as installed.",
  ].filter((line) => line !== null).join("\n");
  osaDialog(message, "Figma Local Bridge");
}

function osaDialog(message, title) {
  const script = `display dialog "${appleScriptString(message)}" buttons {"OK"} default button "OK" with title "${appleScriptString(title)}" with icon note`;
  spawnSync("osascript", ["-e", script], { stdio: "ignore" });
}

function printReport(options, report) {
  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }
  process.stdout.write("\n");
  if (report.daemon.started) {
    process.stdout.write(`Daemon is running (pid ${report.daemon.pid}).\n`);
  } else if (!options.noStart) {
    process.stdout.write("Daemon was not started.\n");
  }
  if (report.token.copiedToClipboard) {
    process.stdout.write("Token copied to clipboard; it is never printed by this installer.\n");
  }
  process.stdout.write("\nRemaining manual steps:\n");
  for (const [index, step] of report.manualSteps.entries()) {
    process.stdout.write(`  ${index + 1}. ${step}\n`);
  }
  process.stdout.write("\n");
}

function readDaemonInfo(path) {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (!data || typeof data !== "object") return null;
    if (typeof data.pid !== "number" || typeof data.startedAt !== "number") return null;
    if (typeof data.pluginToken !== "string" || typeof data.ws !== "string") return null;
    return data;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function waitForDaemon(infoFile, beforeStartedAt, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const info = readDaemonInfo(infoFile);
    if (info && pidAlive(info.pid) && info.startedAt !== beforeStartedAt) return info;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw installError("DAEMON_DID_NOT_START", `The daemon did not publish a fresh descriptor at ${infoFile}.`);
}

function launchctl(args) {
  return spawnSync("/bin/launchctl", args, { encoding: "utf8" });
}

function uid() {
  return typeof process.getuid === "function" ? process.getuid() : 501;
}

function bootout(plistPath) {
  const result = launchctl(["bootout", `gui/${uid()}`, plistPath]);
  if (result.status !== 0) {
    // macOS before the bootstrap/bootout pair only knows unload.
    launchctl(["unload", "-w", plistPath]);
  }
}

function startAgent(plistPath) {
  bootout(plistPath);
  let result = launchctl(["bootstrap", `gui/${uid()}`, plistPath]);
  if (result.status !== 0) result = launchctl(["load", "-w", plistPath]);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw installError("LAUNCHD_FAILED", `launchctl could not load ${plistPath}${detail ? `: ${detail}` : ""}`);
  }
  launchctl(["enable", `gui/${uid()}/${DEFAULT_LABEL}`]);
}

function validateRunningPort(port) {
  const pids = portListeners(port);
  if (!pids.length) return;
  const pid = pids[0];
  const command = processCommand(pid);
  if (isOurDaemonCommand(command)) return;
  throw installError(
    "PORT_IN_USE",
    `Port ${port} is already in use by pid ${pid}${command ? ` (${command})` : ""}. Stop it and rerun the installer.`,
  );
}

function stopExistingDaemon(paths, port) {
  if (existsSync(paths.plistPath)) bootout(paths.plistPath);
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    const pids = portListeners(port);
    if (!pids.length) return;
    if (pids.some((pid) => !isOurDaemonCommand(processCommand(pid)))) {
      validateRunningPort(port);
      return;
    }
    for (const pid of pids) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    }
    sleep(150);
  }
  const pids = portListeners(port);
  if (pids.length) {
    throw installError("PORT_IN_USE", `Port ${port} is still busy after stopping the old bridge (pid ${pids.join(", ")}).`);
  }
}

function portListeners(port) {
  const result = spawnSync("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) return [];
  return [...new Set(result.stdout.trim().split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

function processCommand(pid) {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try {
    main();
  } catch (error) {
    if (process.argv.includes("--json")) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: {
          code: error?.code || "INSTALL_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      }, null, 2) + "\n");
    } else {
      process.stderr.write(`install failed: ${error?.code ? error.code + ": " : ""}${error instanceof Error ? error.message : String(error)}\n`);
    }
    if (process.argv.includes("--gui")) errorDialog(error);
    process.exitCode = 1;
  }
}
