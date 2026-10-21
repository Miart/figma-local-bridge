#!/usr/bin/env node
/**
 * Privacy gate for the repository.
 *
 * This is a public, MIT-licensed project. It must not carry a contributor's
 * absolute home paths, private e-mail addresses, credentials, HAR captures or
 * the names of client/company projects that were only meant to be examples.
 *
 * The scan is deliberately local and dependency-free. It checks the files Git
 * tracks (or, with --staged, the exact bytes that are about to be committed):
 *
 *   - absolute home directories (`/Users/<name>`, `/home/<name>`, `C:\Users\…`);
 *   - real e-mail addresses, while allowing the `example.com` placeholders used
 *     by tests and documentation;
 *   - private keys and common token shapes (GitHub, Figma, OpenAI-style);
 *   - every literal in a local denylist.
 *
 * The denylist is NOT stored in this repository: putting a client/project name
 * in the scanner would leak the very thing the scanner is meant to catch. Point
 * it at a local file instead:
 *
 *   ~/.config/figma-local-bridge/privacy-denylist.txt
 *
 * One term per line, `#` starts a comment. `PRIVACY_DENYLIST` can also carry
 * comma/newline-separated terms for a one-off run.
 *
 * Usage:
 *   node scripts/check-privacy.mjs             scan tracked files
 *   node scripts/check-privacy.mjs --staged    scan staged content (git hook)
 *   node scripts/check-privacy.mjs --all       include .gitignore'd files? no:
 *                                              this flag is rejected on purpose
 *
 * Exit code 1 means at least one finding. A finding prints its category and
 * `path:line`, never the surrounding payload.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCANNER = "scripts/check-privacy.mjs";
const TEST_SCANNER = "test/check-privacy.test.mjs";
const MAX_BYTES = 2 * 1024 * 1024;

const PLACEHOLDER_HOMES = new Set(["example", "me", "user", "A & B", "runner", "you"]);

/** A match is a finding; `text` is only used to make the message useful. */
export function scanText(text, { denylist = [], file = "" } = {}) {
  const findings = [];
  const add = (kind, line, detail) => findings.push({ kind, file, line, detail });

  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Absolute home paths. Tests use /Users/example and /Users/me on purpose;
    // those are placeholders, not somebody's account.
    for (const m of line.matchAll(/(?:^|[^A-Za-z0-9._-])((?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)([^/\\\n"'`]+))/g)) {
      if (!PLACEHOLDER_HOMES.has(m[2].trim())) add("absolute-home-path", i + 1, "a path under a real home directory");
    }

    // Real e-mail addresses. The repository's examples use example.com and
    // git@github.com (a transport address, not a person).
    for (const m of line.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
      const domain = m[1].toLowerCase();
      // `preview@2x.png` is a scale notation, not an address. Keep it out of
      // the e-mail rule without weakening the rule for real domains.
      if (/@(?:\d+x|Nx)\.(?:png|jpe?g|webp|svg)$/i.test(m[0])) continue;
      if (domain === "example.com" || domain === "example.org" || domain === "github.com") continue;
      add("email-address", i + 1, "a real e-mail address");
    }

    if (/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/.test(line)) {
      add("private-key", i + 1, "a private-key block");
    }
    if (/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/.test(line)) {
      add("github-token", i + 1, "a GitHub token");
    }
    if (/\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(line)) {
      add("github-token", i + 1, "a fine-grained GitHub token");
    }
    if (/\bfigd_[A-Za-z0-9_-]{20,}\b/.test(line)) {
      add("figma-token", i + 1, "a Figma personal access token");
    }
    if (/\bsk-[A-Za-z0-9]{20,}\b/.test(line)) {
      add("api-token", i + 1, "an API token");
    }
    if (/(?:FIGMA_CLOUD_TOKEN|FIGMA_CLOUD_OAUTH_TOKEN|FIGMA_BRIDGE_TOKEN|FIGMA_TOKEN)\s*[:=]\s*["']?[A-Za-z0-9._-]{20,}/i.test(line)) {
      add("configured-secret", i + 1, "a non-empty secret in a config assignment");
    }

    const lower = line.toLowerCase();
    for (const term of denylist) {
      if (!term) continue;
      if (lower.includes(term.toLowerCase())) add("denylisted-term", i + 1, `"${term}"`);
    }
  }

  return findings;
}

export function loadDenylist() {
  const terms = [];
  const fromEnv = process.env.PRIVACY_DENYLIST || "";
  for (const term of fromEnv.split(/[,\n]/)) {
    const clean = term.trim();
    if (clean && !clean.startsWith("#")) terms.push(clean);
  }

  const candidates = [
    process.env.PRIVACY_DENYLIST_FILE,
    join(homedir(), ".config", "figma-local-bridge", "privacy-denylist.txt"),
    join(ROOT, ".privacy-denylist"),
  ].filter(Boolean);

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const clean = line.trim();
      if (clean && !clean.startsWith("#")) terms.push(clean);
    }
  }
  return [...new Set(terms)];
}

function git(args, input) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
}

function trackedFiles() {
  return git(["ls-files", "-z"]).split("\0").filter(Boolean);
}

function stagedFiles() {
  return git(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"])
    .split("\0")
    .filter(Boolean);
}

function contentFor(relativePath, staged) {
  // The index is what a commit will contain; the working tree may already have
  // a later edit, so a pre-commit hook must read the staged blob.
  const data = staged ? git(["show", `:${relativePath}`]) : readFileSync(join(ROOT, relativePath), "utf8");
  if (typeof data !== "string") return null;
  if (data.includes("\0")) return null; // binary
  if (Buffer.byteLength(data, "utf8") > MAX_BYTES) return null;
  return data;
}

function main(argv) {
  const staged = argv.includes("--staged");
  const unknown = argv.filter((a) => a !== "--staged");
  if (unknown.length) {
    throw new Error(`check-privacy: unknown argument(s) ${unknown.join(" ")}; only --staged is supported`);
  }

  const denylist = loadDenylist();
  const files = (staged ? stagedFiles() : trackedFiles())
    .filter((f) => f !== SCANNER && f !== TEST_SCANNER);

  const findings = [];
  for (const file of files) {
    let text;
    try {
      text = contentFor(file, staged);
    } catch {
      continue; // deleted since the index was read; the index pass covers it
    }
    if (text == null) continue;
    findings.push(...scanText(text, { denylist, file }));
  }

  const scope = staged ? "staged" : "tracked";
  const where = relative(process.cwd(), ROOT) || ".";
  if (findings.length) {
    process.stderr.write(`privacy: ${findings.length} finding(s) in ${files.length} ${scope} file(s) under ${where}\n`);
    for (const f of findings.slice(0, 200)) {
      process.stderr.write(`  ${f.file}:${f.line}  ${f.kind}${f.detail ? ` — ${f.detail}` : ""}\n`);
    }
    if (findings.length > 200) process.stderr.write(`  … and ${findings.length - 200} more\n`);
    process.stderr.write("Fix the content or remove it before committing. The denylist lives outside the repo.\n");
    return 1;
  }

  process.stdout.write(`privacy: ${files.length} ${scope} file(s) clean${denylist.length ? ` (${denylist.length} denylisted term(s))` : ""}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`privacy: ${err && err.message ? err.message : String(err)}\n`);
    process.exitCode = 2;
  }
}
