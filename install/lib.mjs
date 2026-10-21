/**
 * Pure helpers for the macOS installer.
 *
 * Keeping the filesystem/launchd work in `install.mjs` and the data shaping
 * here makes the dangerous part small and the merge rules testable without
 * touching a real home directory. Nothing in this module writes a file.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const DEFAULT_LABEL = "com.miart.figma-local-bridge";
export const DEFAULT_SERVER_KEY = "figma-local-bridge";
export const MIN_NODE_MAJOR = 20;
export const CLIENTS = ["opencode", "claude-code", "claude-desktop", "cursor"];

export function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    dryRun: false,
    noStart: false,
    noConfig: false,
    noClipboard: false,
    noOpen: false,
    gui: false,
    json: false,
    help: false,
    client: "auto",
    appDir: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--dry-run": out.dryRun = true; break;
      case "--no-start": out.noStart = true; break;
      case "--no-config": out.noConfig = true; break;
      case "--no-clipboard": out.noClipboard = true; break;
      case "--no-open": out.noOpen = true; break;
      case "--gui": out.gui = true; break;
      case "--json": out.json = true; break;
      case "--help":
      case "-h":
        out.help = true;
        break;
      case "--client": {
        const value = argv[++i];
        if (!value) throw new Error("--client needs a value");
        out.client = value;
        break;
      }
      case "--app-dir": {
        const value = argv[++i];
        if (!value) throw new Error("--app-dir needs a value");
        out.appDir = resolve(value);
        break;
      }
      default:
        if (arg.startsWith("--client=")) out.client = arg.slice("--client=".length);
        else if (arg.startsWith("--app-dir=")) out.appDir = resolve(arg.slice("--app-dir=".length));
        else if (arg === "--version") out.version = true;
        else throw new Error(`unknown option: ${arg}`);
    }
  }
  return out;
}

export function parseClientSelection(value = "auto") {
  const text = String(value || "auto").trim().toLowerCase();
  if (text === "auto") return { mode: "auto", selected: new Set() };
  if (text === "all") return { mode: "all", selected: new Set(CLIENTS) };
  if (text === "none") return { mode: "none", selected: new Set() };
  const selected = new Set();
  for (const part of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    const normalized = part === "claude" ? "claude-code" : part;
    if (!CLIENTS.includes(normalized)) {
      throw new Error(`unknown client: ${part} (use ${CLIENTS.join(", ")}, all, auto or none)`);
    }
    selected.add(normalized);
  }
  if (!selected.size) throw new Error("--client selected no clients");
  return { mode: "explicit", selected };
}

export function isSupportedNodeVersion(version) {
  const major = Number(String(version ?? "").split(".")[0]);
  return Number.isInteger(major) && major >= MIN_NODE_MAJOR;
}

export function appPaths(home = homedir(), env = process.env) {
  const appRoot = join(home, "Library/Application Support/Figma Local Bridge");
  return {
    appRoot,
    appDir: join(appRoot, "app"),
    launchAgentsDir: join(home, "Library/LaunchAgents"),
    plistPath: join(home, "Library/LaunchAgents", `${DEFAULT_LABEL}.plist`),
    logDir: join(home, "Library/Logs/Figma Local Bridge"),
    stdoutLog: join(home, "Library/Logs/Figma Local Bridge/daemon.log"),
    stderrLog: join(home, "Library/Logs/Figma Local Bridge/daemon.error.log"),
    infoFile:
      env.FIGMA_BRIDGE_INFO_FILE ||
      join(home, ".local/share/opencode/figma-bridge-daemon.json"),
    tokenFile:
      env.FIGMA_BRIDGE_TOKEN_FILE ||
      join(home, ".local/share/opencode/figma-bridge-daemon.secret"),
    opencodeConfig: join(home, ".config/opencode/opencode.json"),
    opencodeJsonc: join(home, ".config/opencode/opencode.jsonc"),
    claudeCodeConfig: join(home, ".claude.json"),
    claudeDesktopConfig: join(home, "Library/Application Support/Claude/claude_desktop_config.json"),
    cursorConfig: join(home, ".cursor/mcp.json"),
  };
}

export function clientTargets(paths) {
  return [
    { id: "opencode", label: "OpenCode", path: paths.opencodeConfig, kind: "opencode" },
    { id: "claude-code", label: "Claude Code", path: paths.claudeCodeConfig, kind: "mcp-servers" },
    { id: "claude-desktop", label: "Claude Desktop", path: paths.claudeDesktopConfig, kind: "mcp-servers" },
    { id: "cursor", label: "Cursor", path: paths.cursorConfig, kind: "mcp-servers" },
  ];
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildLaunchAgentPlist({
  label = DEFAULT_LABEL,
  nodePath,
  daemonPath,
  workingDirectory,
  stdoutLog,
  stderrLog,
  logDir,
} = {}) {
  if (!nodePath || !daemonPath || !workingDirectory || !stdoutLog || !stderrLog) {
    throw new Error("buildLaunchAgentPlist needs nodePath, daemonPath, workingDirectory and both log paths");
  }
  const pathEnv = [
    dirname(nodePath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter((v, i, a) => a.indexOf(v) === i).join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(daemonPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(pathEnv)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdoutLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderrLog)}</string>
</dict>
</plist>
`;
}

export function readJsonConfig(path) {
  if (!existsSync(path)) return { ok: true, exists: false, data: {} };
  try {
    const text = readFileSync(path, "utf8");
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, exists: true, error: "the top-level value is not an object" };
    }
    return { ok: true, exists: true, data };
  } catch (error) {
    return { ok: false, exists: true, error: error instanceof Error ? error.message : String(error) };
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBridgeEntry(entry, serverPath) {
  const text = JSON.stringify(entry ?? {});
  const normalized = text.replaceAll("\\\\", "/");
  return (
    (normalized.includes("figma-local-bridge") && normalized.includes("server/dist/index.js"))
    || normalized.includes(String(serverPath).replaceAll("\\", "/"))
  );
}

function findServerKey(servers, preferredKey, serverPath) {
  if (isPlainObject(servers[preferredKey])) return preferredKey;
  for (const [key, entry] of Object.entries(servers)) {
    if (isBridgeEntry(entry, serverPath)) return key;
  }
  return preferredKey;
}

export function mergeMcpServers(config, entry, { serverPath, preferredKey = DEFAULT_SERVER_KEY } = {}) {
  if (!isPlainObject(config)) throw new Error("config is not an object");
  const next = cloneJson(config);
  if (next.mcpServers === undefined) next.mcpServers = {};
  if (!isPlainObject(next.mcpServers)) throw new Error("mcpServers is not an object");
  const key = findServerKey(next.mcpServers, preferredKey, serverPath);
  const previous = isPlainObject(next.mcpServers[key]) ? next.mcpServers[key] : null;
  const merged = { ...(previous ?? {}), ...cloneJson(entry) };
  if (previous && isPlainObject(previous.env) && isPlainObject(entry.env)) {
    merged.env = { ...previous.env, ...cloneJson(entry.env) };
  }
  next.mcpServers[key] = merged;
  return {
    config: next,
    key,
    action: previous ? (sameJson(previous, merged) ? "unchanged" : "updated") : "added",
    changed: !sameJson(config, next),
  };
}

export function mergeOpenCodeConfig(config, entry, { serverPath, preferredKey = DEFAULT_SERVER_KEY } = {}) {
  if (!isPlainObject(config)) throw new Error("config is not an object");
  const next = cloneJson(config);
  if (next.mcp === undefined) next.mcp = {};
  if (!isPlainObject(next.mcp)) throw new Error("mcp is not an object");
  if (next.mcp.servers === undefined) next.mcp.servers = {};
  if (!isPlainObject(next.mcp.servers)) throw new Error("mcp.servers is not an object");
  const key = findServerKey(next.mcp.servers, preferredKey, serverPath);
  const previous = isPlainObject(next.mcp.servers[key]) ? next.mcp.servers[key] : null;
  const merged = { ...(previous ?? {}), ...cloneJson(entry) };
  if (previous && isPlainObject(previous.environment) && isPlainObject(entry.environment)) {
    merged.environment = { ...previous.environment, ...cloneJson(entry.environment) };
  }
  next.mcp.servers[key] = merged;
  return {
    config: next,
    key,
    action: previous ? (sameJson(previous, merged) ? "unchanged" : "updated") : "added",
    changed: !sameJson(config, next),
  };
}

export function removeMcpServer(config, { serverPath, preferredKey = DEFAULT_SERVER_KEY } = {}) {
  if (!isPlainObject(config)) throw new Error("config is not an object");
  const next = cloneJson(config);
  if (!isPlainObject(next.mcpServers)) {
    return { config: next, key: null, changed: false };
  }
  const key = findServerKey(next.mcpServers, preferredKey, serverPath);
  if (!isPlainObject(next.mcpServers[key]) || !isBridgeEntry(next.mcpServers[key], serverPath)) {
    return { config: next, key: null, changed: false };
  }
  delete next.mcpServers[key];
  return { config: next, key, changed: true };
}

export function removeOpenCodeServer(config, { serverPath, preferredKey = DEFAULT_SERVER_KEY } = {}) {
  if (!isPlainObject(config)) throw new Error("config is not an object");
  const next = cloneJson(config);
  if (!isPlainObject(next.mcp) || !isPlainObject(next.mcp.servers)) {
    return { config: next, key: null, changed: false };
  }
  const key = findServerKey(next.mcp.servers, preferredKey, serverPath);
  if (!isPlainObject(next.mcp.servers[key]) || !isBridgeEntry(next.mcp.servers[key], serverPath)) {
    return { config: next, key: null, changed: false };
  }
  delete next.mcp.servers[key];
  return { config: next, key, changed: true };
}

export function mcpServerEntry({ nodePath, serverPath, type = null, env = {} } = {}) {
  const entry = { type, command: nodePath, args: [serverPath], env };
  if (!type) delete entry.type;
  return entry;
}

export function openCodeServerEntry({ nodePath, serverPath, env = {} } = {}) {
  return { type: "local", command: [nodePath, serverPath], environment: env };
}

export function backupPathFor(configPath, now = Date.now()) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  return `${configPath}.bak-figma-local-bridge-${stamp}`;
}

export function configMode(path) {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return 0o644;
  }
}

export function appleScriptString(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

export function appVersionFromPackage(sourceRoot) {
  try {
    const pkg = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

export function commandBasename(command) {
  return String(command ?? "").split("/").pop() || "";
}

export function isOurDaemonCommand(command) {
  return Boolean(command)
    && String(command).includes("server/dist/daemon.js")
    && /figma[- ]local[- ]bridge/i.test(String(command));
}
