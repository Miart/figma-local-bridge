// Builds plugin/code.ts -> plugin/code.js and inlines ui.html as __html__,
// because Figma's sandbox has no filesystem access at runtime.
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const uiHtml = readFileSync(join(here, "ui.html"), "utf8");

// Escaped for embedding in a JS string literal. The UI is ours, but the escape
// is what keeps a stray backtick or ${ from silently breaking the bundle.
const escaped = uiHtml
  .replace(/\\/g, "\\\\")
  .replace(/`/g, "\\`")
  .replace(/\$\{/g, "\\${");

await build({
  entryPoints: [join(here, "code.ts")],
  bundle: true,
  format: "iife",
  // ES2020: the fingerprint module uses BigInt for FNV-1a 64. Figma's plugin
  // sandbox has no DOM but does support modern JS.
  target: "es2020",
  outfile: join(here, "code.js"),
  define: { __html__: JSON.stringify(uiHtml), __UI_ESCAPED__: JSON.stringify(escaped) },
  logLevel: "info",
});

// Keep the raw UI next to the bundle as well: useful when debugging in Figma's
// console, and required if you ever switch to a non-inlined UI.
writeFileSync(join(here, "ui.built.html"), uiHtml);

// Same reason as fingerprint.mjs below: plugin/scope.ts is the single source of
// truth for scope enforcement and must be the thing the tests import.
await build({
  entryPoints: [join(here, "scope.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: join(here, "scope.mjs"),
  logLevel: "warning",
});

// commands.ts is the code that deletes nodes. Its integration test imports it
// against a mock `figma`, so it must be loadable outside Figma too.
await build({
  entryPoints: [join(here, "commands.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: join(here, "commands.mjs"),
  logLevel: "warning",
});

// dispatch.ts holds the opId cache, the in-flight coalescing and the write
// queue. None of that touches `figma`, so the unit test loads it directly —
// and it must be the shipped module, not a copy.
await build({
  entryPoints: [join(here, "dispatch.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: join(here, "dispatch.mjs"),
  logLevel: "warning",
});

// The tool table, so a test can check MUTATING_METHODS against the methods that
// actually exist. tools.ts only touches `figma` inside its handlers, never at
// module scope, which is what makes it loadable here.
await build({
  entryPoints: [join(here, "tools.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: join(here, "tools.mjs"),
  logLevel: "warning",
});

// Emit fingerprint.mjs from fingerprint.ts.
//
// This file used to be a hand-maintained COPY of fingerprint.ts, last touched
// long before the TypeScript was. The unit tests import fingerprint.mjs, so
// they spent a long time cheerfully passing against code that Figma never runs
// — including every result printed before a real bug was found. The tests must
// exercise the shipped module, so the only source of truth is the .ts and this
// artifact is generated, never edited.
await build({
  entryPoints: [join(here, "fingerprint.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: join(here, "fingerprint.mjs"),
  logLevel: "warning",
});

console.log("plugin built ->", join(here, "code.js"));
console.log("test artifacts regenerated from .ts: fingerprint.mjs, scope.mjs, commands.mjs, dispatch.mjs");