#!/usr/bin/env node
/**
 * Build the self-contained macOS release zip.
 *
 * The zip deliberately contains compiled server/plugin output and production
 * node_modules, so a non-developer never has to run npm install or npm run
 * build. It is built locally; publishing/tagging is a separate decision.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const RELEASE_DIR = join(ROOT, "release");
const STAGE_NAME = `figma-local-bridge-${VERSION}`;
const STAGE = join(RELEASE_DIR, STAGE_NAME);
const ZIP = join(RELEASE_DIR, `${STAGE_NAME}-macos.zip`);

const REQUIRED = [
  "server/dist/index.js",
  "server/dist/daemon.js",
  "plugin/code.js",
  "plugin/ui.html",
  "plugin/manifest.json",
  "install/install.mjs",
  "install/lib.mjs",
  "install/Install.command",
  "install/Uninstall.command",
];

function main() {
  const missing = REQUIRED.filter((path) => !existsSync(join(ROOT, path)));
  if (missing.length) {
    throw new Error(`build first: missing ${missing.join(", ")} (run npm run build)`);
  }
  rmSync(STAGE, { recursive: true, force: true });
  rmSync(ZIP, { force: true });
  mkdirSync(STAGE, { recursive: true });

  for (const entry of [
    "package.json",
    "package-lock.json",
    "README.md",
    "llms.txt",
    "LICENSE",
    "server/dist",
    "plugin/code.js",
    "plugin/ui.html",
    "plugin/manifest.json",
    "skills",
    "install",
  ]) {
    const from = join(ROOT, entry);
    if (existsSync(from)) cpSync(from, join(STAGE, entry), { recursive: true, force: true });
  }

  // The double-clickable files live at the top of the zip, not inside install/.
  cpSync(join(ROOT, "install/Install.command"), join(STAGE, "Install.command"));
  cpSync(join(ROOT, "install/Uninstall.command"), join(STAGE, "Uninstall.command"));
  chmodSync(join(STAGE, "Install.command"), 0o755);
  chmodSync(join(STAGE, "Uninstall.command"), 0o755);

  copyProductionNodeModules();

  // The unpacked tree is useful for tests and debugging; the zip is the UX.
  const fileCount = countFiles(STAGE);
  const zipResult = execFileSync("ditto", [
    "-c",
    "-k",
    "--norsrc",
    "--keepParent",
    STAGE,
    ZIP,
  ], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (zipResult.trim()) process.stderr.write(zipResult);
  const stat = statSync(ZIP);
  const sha = createHash("sha256").update(readFileSync(ZIP)).digest("hex");
  writeFileSync(join(RELEASE_DIR, `${STAGE_NAME}-macos.zip.sha256`), `${sha}  ${STAGE_NAME}-macos.zip\n`);
  process.stdout.write(`release: ${relative(ROOT, ZIP)}\n`);
  process.stdout.write(`version: ${VERSION}\n`);
  process.stdout.write(`files:   ${fileCount}\n`);
  process.stdout.write(`size:    ${(stat.size / 1024 / 1024).toFixed(1)} MiB\n`);
  process.stdout.write(`sha256:  ${sha}\n`);
}

function copyProductionNodeModules() {
  const target = join(STAGE, "node_modules");
  mkdirSync(target, { recursive: true });
  let output;
  try {
    output = execFileSync("npm", ["ls", "--omit=dev", "--parseable", "--all"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 100 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`npm ls --omit=dev failed: ${error?.stderr || error?.message || error}`);
  }
  const root = resolve(ROOT);
  const paths = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const copied = new Set();
  for (const path of paths) {
    const absolute = resolve(path);
    if (absolute === root) continue;
    const rel = relative(root, absolute);
    if (!rel || rel.startsWith("..") || rel.includes("node_modules/.bin")) continue;
    if (copied.has(rel)) continue;
    copied.add(rel);
    const to = join(STAGE, rel);
    if (!existsSync(to)) {
      cpSync(absolute, to, { recursive: true, force: true, dereference: false });
    }
  }
  if (!existsSync(join(target, "@modelcontextprotocol/sdk"))) {
    throw new Error("production dependency copy is incomplete: @modelcontextprotocol/sdk is missing");
  }
  if (!existsSync(join(target, "ws"))) {
    throw new Error("production dependency copy is incomplete: ws is missing");
  }
}

function countFiles(root) {
  let count = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) count += countFiles(path);
    else count += 1;
  }
  return count;
}

try {
  main();
} catch (error) {
  process.stderr.write(`build-release failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
