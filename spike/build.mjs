// Builds spike/code.ts -> spike/code.js with ui.html inlined as __html__.
// Kept separate from plugin/build.mjs because the spike is a throwaway probe
// with a different entry point and must never be shipped in the bridge.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const uiHtml = readFileSync(join(here, "ui.html"), "utf8");

await build({
  entryPoints: [join(here, "code.ts")],
  bundle: true,
  format: "iife",
  target: "es2017",
  outfile: join(here, "code.js"),
  define: { __html__: JSON.stringify(uiHtml) },
  logLevel: "info",
});

console.log("spike built ->", join(here, "code.js"));