#!/usr/bin/env node
/**
 * Writes the daemon's plugin token into the plugin UI as the first-run default,
 * so a fresh plugin panel connects without pasting. The token used at runtime is
 * still the one stored in figma.clientStorage; this only answers the first open
 * (and any open after the storage is cleared).
 *
 * Usage:
 *   node scripts/set-plugin-token.mjs                 # read ~/.local/share/opencode/figma-bridge-daemon.secret
 *   node scripts/set-plugin-token.mjs --token abc123  # explicit token
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
let token = "";
for (let i = 0; i < args.length; i++) if (args[i] === "--token") token = args[++i] || "";

const secretPath = process.env.FLB_SECRET || join(homedir(), ".local/share/opencode/figma-bridge-daemon.secret");
if (!token && existsSync(secretPath)) token = readFileSync(secretPath, "utf8").trim();
if (!/^[a-f0-9]{16,128}$/i.test(token)) {
  console.error(`No daemon token found. Pass --token <token> or run the daemon once (${secretPath}).`);
  process.exit(1);
}

const root = resolve(new URL("..", import.meta.url).pathname);
const targets = [
  join(root, "plugin/ui.html"),
  ...(existsSync(join(homedir(), "Library/Application Support/Figma Local Bridge/app/plugin/ui.html"))
    ? [join(homedir(), "Library/Application Support/Figma Local Bridge/app/plugin/ui.html")]
    : []),
];
const re = /const DEFAULT_TOKEN = "[^"]*";/;
let patched = 0;
for (const file of targets) {
  if (!existsSync(file)) continue;
  const html = readFileSync(file, "utf8");
  if (!re.test(html)) continue;
  writeFileSync(file, html.replace(re, `const DEFAULT_TOKEN = "${token}";`));
  console.log(`token -> ${file}`);
  patched++;
}
if (!patched) {
  console.error("No plugin/ui.html with a DEFAULT_TOKEN line found.");
  process.exit(1);
}
// code.js inlines ui.html, so the running plugin needs the rebuilt bundle.
const build = join(root, "plugin/build.mjs");
if (existsSync(build)) {
  const { spawnSync } = await import("node:child_process");
  const run = spawnSync(process.execPath, [build], { cwd: root, stdio: "inherit" });
  if (run.status !== 0) {
    console.error("plugin build failed — the token was written to ui.html but code.js still has the old one.");
    process.exit(1);
  }
}
console.log("Reopen the plugin in Figma (Plugins → Development → Figma Local Bridge).");
