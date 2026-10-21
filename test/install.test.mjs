import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_LABEL,
  appPaths,
  appleScriptString,
  backupPathFor,
  buildLaunchAgentPlist,
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
  removeMcpServer,
  removeOpenCodeServer,
} from "../install/lib.mjs";

const SERVER = "/Users/example/Library/Application Support/Figma Local Bridge/app/server/dist/index.js";

test("installer args are explicit and reject unknown flags", () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.dryRun, false);
  assert.equal(defaults.client, "auto");
  assert.equal(defaults.appDir, null);

  const parsed = parseArgs([
    "--dry-run",
    "--no-start",
    "--no-config",
    "--no-clipboard",
    "--no-open",
    "--gui",
    "--json",
    "--client=opencode,claude-desktop",
    "--app-dir=/tmp/figma-test",
  ]);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.noStart, true);
  assert.equal(parsed.noConfig, true);
  assert.equal(parsed.noClipboard, true);
  assert.equal(parsed.noOpen, true);
  assert.equal(parsed.gui, true);
  assert.equal(parsed.json, true);
  assert.equal(parsed.appDir, "/tmp/figma-test");
  assert.throws(() => parseArgs(["--wat"]), /unknown option/);
  assert.throws(() => parseArgs(["--client"]), /needs a value/);
});

test("client selection accepts aliases and rejects unknown clients", () => {
  assert.deepEqual(parseClientSelection("auto"), { mode: "auto", selected: new Set() });
  assert.equal(parseClientSelection("all").selected.size, 4);
  assert.equal(parseClientSelection("none").selected.size, 0);
  assert.deepEqual([...parseClientSelection("claude").selected], ["claude-code"]);
  assert.deepEqual([...parseClientSelection("opencode,cursor").selected], ["opencode", "cursor"]);
  assert.throws(() => parseClientSelection("vim"), /unknown client/);
});

test("daemon ownership survives the app path's spaces and capitalization", () => {
  assert.equal(isOurDaemonCommand("/opt/homebrew/bin/node /Users/me/Library/Application Support/Figma Local Bridge/app/server/dist/daemon.js"), true);
  assert.equal(isOurDaemonCommand("/opt/homebrew/bin/node /Users/me/figma-local-bridge/server/dist/daemon.js"), true);
  assert.equal(isOurDaemonCommand("/opt/homebrew/bin/node /tmp/another/server/dist/daemon.js"), false);
  assert.equal(isOurDaemonCommand(""), false);
});

test("Node.js 20 is the minimum, and paths are per-user", () => {
  assert.equal(isSupportedNodeVersion("20.0.0"), true);
  assert.equal(isSupportedNodeVersion("22.14.0"), true);
  assert.equal(isSupportedNodeVersion("18.20.0"), false);
  assert.equal(isSupportedNodeVersion("not-a-version"), false);

  const paths = appPaths("/Users/example", {});
  assert.equal(paths.appDir, "/Users/example/Library/Application Support/Figma Local Bridge/app");
  assert.equal(paths.plistPath, `/Users/example/Library/LaunchAgents/${DEFAULT_LABEL}.plist`);
  assert.equal(paths.infoFile, "/Users/example/.local/share/opencode/figma-bridge-daemon.json");
  assert.equal(paths.claudeCodeConfig, "/Users/example/.claude.json");
  assert.equal(paths.cursorConfig, "/Users/example/.cursor/mcp.json");
});

test("LaunchAgent plist is valid XML and escapes paths", () => {
  const plist = buildLaunchAgentPlist({
    label: DEFAULT_LABEL,
    nodePath: "/opt/homebrew/bin/node",
    daemonPath: "/Users/A & B/Figma <Bridge>/app/server/dist/daemon.js",
    workingDirectory: "/Users/A & B/Figma <Bridge>/app",
    stdoutLog: "/Users/A & B/Library/Logs/Figma Local Bridge/daemon.log",
    stderrLog: "/Users/A & B/Library/Logs/Figma Local Bridge/daemon.error.log",
    logDir: "/Users/A & B/Library/Logs/Figma Local Bridge",
  });
  assert.match(plist, /<key>Label<\/key>\n  <string>com\.miart\.figma-local-bridge<\/string>/);
  assert.match(plist, /<string>\/opt\/homebrew\/bin\/node<\/string>/);
  assert.match(plist, /&amp;/);
  assert.doesNotMatch(plist, /A & B/);
  assert.match(plist, /<key>KeepAlive<\/key>\n  <true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\n  <true\/>/);
  assert.throws(() => buildLaunchAgentPlist({ nodePath: "/node" }), /needs/);
});

test("Claude/Cursor MCP merge preserves other servers and custom env", () => {
  const existing = {
    mcpServers: {
      other: { command: "other-server", args: [] },
      figmaBridge: {
        type: "stdio",
        command: "node",
        args: ["/old/figma-local-bridge/server/dist/index.js"],
        env: { FIGMA_CLOUD: "1", KEEP: "yes" },
        custom: true,
      },
    },
    unrelated: { keep: true },
  };
  const entry = mcpServerEntry({ nodePath: "/opt/homebrew/bin/node", serverPath: SERVER, type: "stdio" });
  const result = mergeMcpServers(existing, entry, { serverPath: SERVER });
  assert.equal(result.key, "figmaBridge");
  assert.equal(result.action, "updated");
  assert.equal(result.changed, true);
  assert.equal(result.config.unrelated.keep, true);
  assert.deepEqual(result.config.mcpServers.other, existing.mcpServers.other);
  assert.equal(result.config.mcpServers.figmaBridge.command, "/opt/homebrew/bin/node");
  assert.deepEqual(result.config.mcpServers.figmaBridge.args, [SERVER]);
  assert.equal(result.config.mcpServers.figmaBridge.env.FIGMA_CLOUD, "1");
  assert.equal(result.config.mcpServers.figmaBridge.env.KEEP, "yes");
  assert.equal(result.config.mcpServers.figmaBridge.custom, true);
  assert.equal(existing.mcpServers.figmaBridge.command, "node", "input must not be mutated");

  const second = mergeMcpServers(result.config, entry, { serverPath: SERVER });
  assert.equal(second.action, "unchanged");
  assert.equal(second.changed, false);
});

test("Claude/Cursor merge adds and removes only the bridge entry", () => {
  const added = mergeMcpServers({}, mcpServerEntry({ nodePath: "/node", serverPath: SERVER }), { serverPath: SERVER });
  assert.equal(added.action, "added");
  assert.deepEqual(Object.keys(added.config.mcpServers), ["figma-local-bridge"]);
  assert.equal(added.config.mcpServers["figma-local-bridge"].type, undefined);

  const removed = removeMcpServer(added.config, { serverPath: SERVER });
  assert.equal(removed.changed, true);
  assert.equal(removed.key, "figma-local-bridge");
  assert.deepEqual(removed.config.mcpServers, {});

  const untouched = removeMcpServer({ mcpServers: { other: { command: "x" } } }, { serverPath: SERVER });
  assert.equal(untouched.changed, false);
  assert.equal(untouched.key, null);
});

test("OpenCode merge uses command array and environment, preserving extras", () => {
  const existing = {
    mcp: {
      servers: {
        other: { type: "local", command: ["other"] },
        figmaBridge: {
          type: "local",
          command: ["node", "/old/figma-local-bridge/server/dist/index.js"],
          environment: { FIGMA_BRIDGE_WRITE: "0", KEEP: "yes" },
          enabled: true,
        },
      },
    },
  };
  const entry = openCodeServerEntry({ nodePath: "/opt/homebrew/bin/node", serverPath: SERVER });
  const result = mergeOpenCodeConfig(existing, entry, { serverPath: SERVER });
  assert.equal(result.key, "figmaBridge");
  assert.equal(result.action, "updated");
  assert.deepEqual(result.config.mcp.servers.figmaBridge.command, ["/opt/homebrew/bin/node", SERVER]);
  assert.equal(result.config.mcp.servers.figmaBridge.environment.FIGMA_BRIDGE_WRITE, "0");
  assert.equal(result.config.mcp.servers.figmaBridge.environment.KEEP, "yes");
  assert.equal(result.config.mcp.servers.figmaBridge.enabled, true);
  assert.deepEqual(result.config.mcp.servers.other, existing.mcp.servers.other);

  const removed = removeOpenCodeServer(result.config, { serverPath: SERVER });
  assert.equal(removed.changed, true);
  assert.equal(removed.config.mcp.servers.figmaBridge, undefined);
  assert.deepEqual(removed.config.mcp.servers.other, existing.mcp.servers.other);
});

test("config parse failures are reported, not repaired", () => {
  const dir = mkdtempSync(join(tmpdir(), "figma-install-test-"));
  try {
    const path = join(dir, "opencode.json");
    writeFileSync(path, "{ // comment\n  \"mcp\": {}\n}\n");
    const result = readJsonConfig(path);
    assert.equal(result.ok, false);
    assert.equal(result.exists, true);
    assert.match(result.error, /JSON|property|Unexpected/);
    assert.equal(configMode(path), 0o644);
    assert.match(backupPathFor(path, 0), /\.bak-figma-local-bridge-1970-01-01T00-00-00-000Z$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AppleScript strings escape quotes and backslashes", () => {
  assert.equal(appleScriptString('a "quoted" \\ path\nnext'), 'a \\"quoted\\" \\\\ path\\nnext');
});
