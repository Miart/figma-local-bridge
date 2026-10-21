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

// ui-build.ts is the declarative build/patch engine. It takes the Plugin API as
// an argument, never reaches for the global, so the planner and the apply path
// can be driven by a stub in plain Node.
await build({
  entryPoints: [join(here, "ui-build.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: join(here, "ui-build.mjs"),
  logLevel: "warning",
});

// batch.ts is the multi-target edit engine. Same rule as ui-build: the Plugin
// API is an argument, so the preflight and apply paths are testable in Node.
await build({
  entryPoints: [join(here, "batch.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: join(here, "batch.mjs"),
  logLevel: "warning",
});

// audit.ts is read-only, but it is exactly the kind of code that must be tested
// against the shipped module: its rules are promises about what a finding means.
await build({
  entryPoints: [join(here, "audit.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: join(here, "audit.mjs"),
  logLevel: "warning",
});

// index.ts is the read-only page index/search; its node cap and match semantics
// are exactly what a test needs to pin.
await build({
  entryPoints: [join(here, "index.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: join(here, "index.mjs"),
  logLevel: "warning",
});

// spec-export.ts turns a live subtree back into a figma_build spec.
await build({
  entryPoints: [join(here, "spec-export.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: join(here, "spec-export.mjs"),
  logLevel: "warning",
});

// design-system.ts is the comparable snapshot behind the sync diff.
await build({
  entryPoints: [join(here, "design-system.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: join(here, "design-system.mjs"),
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

// session-key.ts holds the key an unsaved file answers to. The unit test pins
// the contract it exists for — "a plugin reload keeps the key" — so the shipped
// module is built here rather than copied.
await build({
  entryPoints: [join(here, "session-key.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: join(here, "session-key.mjs"),
  logLevel: "warning",
});

// checkpoint.ts is the dump schema and the rebuild. The rebuild deletes the
// target's children, so the thing under test must be the shipped module; the
// tests drive it with fixtures and a stub API.
await build({
  entryPoints: [join(here, "checkpoint.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: join(here, "checkpoint.mjs"),
  logLevel: "warning",
});

// helpers.ts is the snippet standard library. Every refusal in it is a promise
// about what a snippet may touch, so the tests drive the shipped module against
// a stub Plugin API rather than a copy of the rules.
await build({
  entryPoints: [join(here, "helpers.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: join(here, "helpers.mjs"),
  logLevel: "warning",
});

// exports.ts is the arithmetic behind an atlas manifest, a 9-slice descriptor
// and a list of states. Every number in it is a promise about a FILE, so the
// tests drive the shipped module with fixtures rather than a copy.
await build({
  entryPoints: [join(here, "exports.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: join(here, "exports.mjs"),
  logLevel: "warning",
});

// component-swap.ts is the instance migration engine. Its dry run decides
// whether an apply is allowed at all, so the tests drive the shipped module.
await build({
  entryPoints: [join(here, "component-swap.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: join(here, "component-swap.mjs"),
  logLevel: "warning",
});

// variant-sets.ts creates and edits COMPONENT_SETs. Its dry run validates the
// whole property matrix before writing, so the tests drive the shipped module.
await build({
  entryPoints: [join(here, "variant-sets.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: join(here, "variant-sets.mjs"),
  logLevel: "warning",
});

// tokens.ts turns design-token documents into variables. A dry run has to be
// the same plan the apply executes, so the tests drive this shipped module.
await build({
  entryPoints: [join(here, "tokens.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: join(here, "tokens.mjs"),
  logLevel: "warning",
});

console.log("plugin built ->", join(here, "code.js"));
console.log("test artifacts regenerated from .ts: fingerprint.mjs, scope.mjs, commands.mjs, dispatch.mjs, session-key.mjs, checkpoint.mjs, helpers.mjs, exports.mjs, ui-build.mjs, batch.mjs, audit.mjs, index.mjs, design-system.mjs, spec-export.mjs, component-swap.mjs, variant-sets.mjs, tokens.mjs");