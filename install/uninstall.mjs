#!/usr/bin/env node
/**
 * Remove the per-user Figma Local Bridge installation.
 *
 * Defaults are conservative: app, LaunchAgent and this bridge's MCP entries
 * are removed; daemon data (including the token) is left alone unless
 * --purge is passed. Every client config that changes is backed up first.
 */
import {
  copyFileSync,
  existsSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  appPaths,
  appleScriptString,
  backupPathFor,
  clientTargets,
  configMode,
  readJsonConfig,
  removeMcpServer,
  removeOpenCodeServer,
} from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = dirname(HERE);

function parse(argv) {
  const out = { yes: false, dryRun: false, gui: false, keepApp: false, keepConfig: false, purge: false, appDir: null };
  for (const arg of argv) {
    if (arg === "--yes") out.yes = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--gui") out.gui = true;
    else if (arg === "--keep-app") out.keepApp = true;
    else if (arg === "--keep-config") out.keepConfig = true;
    else if (arg === "--purge") out.purge = true;
    else if (arg.startsWith("--app-dir=")) out.appDir = arg.slice("--app-dir=".length);
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return out;
}

function main() {
  const options = parse(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`Figma Local Bridge uninstaller

Usage: node install/uninstall.mjs [--yes] [--dry-run] [--keep-app] [--keep-config] [--purge] [--app-dir=PATH] [--gui]

Default: remove the app, LaunchAgent and this bridge's MCP entries; keep data.
--purge additionally removes the daemon descriptor and token.
`);
    return;
  }
  if (process.platform !== "darwin") throw new Error("This uninstaller supports macOS only.");
  if (!options.yes && !options.dryRun) {
    throw new Error("Refusing to remove files without --yes. Run with --dry-run to see the plan.");
  }
  const paths = appPaths(homedir(), {});
  const installedRoot = APP_ROOT.includes("Library/Application Support/Figma Local Bridge");
  const appDir = options.appDir ? resolve(options.appDir) : (installedRoot ? APP_ROOT : paths.appDir);
  if (appDir === "/" || appDir === resolve(homedir())) {
    throw new Error(`Refusing to remove ${appDir}.`);
  }
  if (!options.keepApp && existsSync(appDir) && !existsSync(join(appDir, "server/dist/index.js")) && !existsSync(join(appDir, "plugin/manifest.json"))) {
    throw new Error(`${appDir} does not look like a Figma Local Bridge app directory; refusing to remove it.`);
  }
  const serverPath = join(appDir, "server/dist/index.js");
  const plan = {
    appDir,
    plist: paths.plistPath,
    configs: [],
    data: options.purge ? [paths.infoFile, paths.tokenFile] : [],
  };
  for (const target of clientTargets(paths)) {
    if (!existsSync(target.path)) continue;
    const read = readJsonConfig(target.path);
    if (!read.ok) {
      plan.configs.push({ id: target.id, path: target.path, action: "skip", reason: read.error });
      continue;
    }
    const merged = target.kind === "opencode"
      ? removeOpenCodeServer(read.data, { serverPath })
      : removeMcpServer(read.data, { serverPath });
    plan.configs.push({ id: target.id, path: target.path, action: merged.changed ? "remove" : "unchanged", key: merged.key });
  }

  if (options.dryRun) {
    process.stdout.write(JSON.stringify({ dryRun: true, ...plan }, null, 2) + "\n");
    return;
  }

  bootout(paths.plistPath);
  if (!options.keepConfig) {
    for (const target of clientTargets(paths)) {
      if (!existsSync(target.path)) continue;
      const read = readJsonConfig(target.path);
      if (!read.ok) {
        process.stderr.write(`skip ${target.label}: cannot parse ${target.path}: ${read.error}\n`);
        continue;
      }
      const merged = target.kind === "opencode"
        ? removeOpenCodeServer(read.data, { serverPath })
        : removeMcpServer(read.data, { serverPath });
      if (!merged.changed) continue;
      const backup = backupPathFor(target.path);
      copyFileSync(target.path, backup);
      writeJsonAtomic(target.path, merged.config);
      process.stdout.write(`removed MCP entry from ${target.label} (backup: ${backup})\n`);
    }
  }
  rmSync(paths.plistPath, { force: true });
  if (!options.keepApp) rmSync(appDir, { recursive: true, force: true });
  for (const file of plan.data) rmSync(file, { force: true });
  if (options.purge) rmSync(paths.logDir, { recursive: true, force: true });
  const summary = `Figma Local Bridge removed.${options.keepApp ? " The app directory was kept." : ""}${options.keepConfig ? " MCP configs were kept." : ""}`;
  process.stdout.write(summary + "\n");
  if (options.gui) osaDialog(summary, "Figma Local Bridge");
}

function writeJsonAtomic(path, data) {
  const mode = configMode(path);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode });
    renameSync(tmp, path);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function launchctl(args) {
  return spawnSync("/bin/launchctl", args, { encoding: "utf8" });
}

function uid() {
  return typeof process.getuid === "function" ? process.getuid() : 501;
}

function bootout(plistPath) {
  if (!existsSync(plistPath)) return;
  const result = launchctl(["bootout", `gui/${uid()}`, plistPath]);
  if (result.status !== 0) launchctl(["unload", "-w", plistPath]);
}

function osaDialog(message, title) {
  const script = `display dialog "${appleScriptString(message)}" buttons {"OK"} default button "OK" with title "${appleScriptString(title)}" with icon note`;
  spawnSync("osascript", ["-e", script], { stdio: "ignore" });
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`uninstall failed: ${error instanceof Error ? error.message : String(error)}\n`);
    if (process.argv.includes("--gui")) osaDialog(String(error?.message || error), "Figma Local Bridge");
    process.exitCode = 1;
  }
}
