// End-to-end test for the export tools: the plugin side measures and renders,
// the MCP side writes the artefacts and checks what landed on disk.
//
// The stub plugin answers with PNGs built here, which is the point: the checks
// under test are the ones that compare the FILE with the manifest, so the file
// has to be real. Three things this test exists to catch:
//
//   - a manifest whose numbers describe an image nobody wrote (the stub claims
//     128x64 and sends 64x32: the tool must say the file contradicts it);
//   - states that are byte-identical (two of the three here), which is usually a
//     variant that does not draw what its name says;
//   - exports being unavailable in read-only mode — they are reads of the
//     document, so a handoff or a build must work with writes off.
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import fs from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { encodePng, pngSize } from "../server/dist/compare.js";
import { freshDescriptor } from "./helpers/fresh-descriptor.mjs";

const PORT = Number(process.env.TEST_PORT || 8901);
const INFO = join(homedir(), ".local/share/opencode", "figma-bridge-daemon-exports-test.json");
const OUT = fs.mkdtempSync(join(os.tmpdir(), "figma-exports-e2e-"));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; process.stdout.write(`PASS  ${name}\n`); }
  else { fail++; process.stdout.write(`FAIL  ${name}${detail ? "  — " + detail : ""}\n`); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(url) {
  return new Promise((res) => {
    const ws = new WebSocket(url);
    ws.on("open", () => res(ws));
    ws.on("error", () => res(null));
  });
}

async function mcpClient(env = {}) {
  const proc = spawn("node", ["server/dist/index.js"], {
    env: { ...process.env, FIGMA_BRIDGE_INFO_FILE: INFO, FIGMA_BRIDGE_DESTRUCTIVE: "1", FIGMA_BRIDGE_JOURNAL: "0", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const pending = new Map();
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  let rpcId = 0;
  const rpc = (method, params) => new Promise((res, rej) => {
    const id = ++rpcId;
    const t = setTimeout(() => rej(new Error("rpc timeout " + method)), 8000);
    pending.set(id, (m) => { clearTimeout(t); res(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const text = (r) => {
    const t = r?.result?.content?.[0]?.text;
    return t ? JSON.parse(t) : null;
  };
  return { proc, rpc, text, kill: () => proc.kill() };
}

/** A real PNG of the given size, so `pngSize` on disk has something to read. */
function png(width, height, rgba = [255, 0, 0, 255]) {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) buf.set(rgba, i * 4);
  return encodePng({ width, height, rgba: new Uint8Array(buf) }).toString("base64");
}

freshDescriptor(INFO);
const daemon = spawn("node", ["server/dist/daemon.js"], {
  env: { ...process.env, FIGMA_BRIDGE_PORT: String(PORT), FIGMA_BRIDGE_INFO_FILE: INFO },
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  let info = null;
  for (let i = 0; i < 60 && !info; i++) {
    await sleep(150);
    try { info = JSON.parse(fs.readFileSync(INFO, "utf8")); } catch {}
  }
  if (!info) throw new Error("no daemon info");

  const c = await mcpClient();
  const tools = (await c.rpc("tools/list", {})).result.tools.map((t) => t.name);
  check(
    "the four export tools are registered",
    ["figma_export_ui_atlas", "figma_export_9slice", "figma_export_ui_states", "figma_export_web_handoff"].every((n) =>
      tools.includes(n),
    ),
    tools.join(","),
  );

  const plugin = await connect(info.ws.replace("127.0.0.1", "localhost") + "&role=plugin");
  const seen = [];
  plugin.on("message", (raw) => {
    const env = JSON.parse(raw.toString());
    seen.push(env);
    const ok = (result) => plugin.send(JSON.stringify({ id: env.id, ok: true, result, rev: 11 }));
    const fail = (m) => plugin.send(JSON.stringify({ id: env.id, ok: false, error: { message: m } }));
    switch (env.method) {
      case "ping": return ok({ ok: true });
      case "export_atlas": {
        if (env.params.nodeId === "1:2") {
          // The honest case: a 200x100 file and a manifest that describes it.
          return ok({
            nodeId: "9:1", name: "Sheet/Hero", format: "PNG", scale: 2, bytes: 80070, exportSize: { width: 200, height: 100 },
            skipped: [{ id: "9:9", name: "empty", type: "FRAME", why: "no bounds (empty)" }],
            manifest: {
              sheet: { id: "9:1", name: "Sheet/Hero", scale: 2, width: 100, height: 50, exportWidth: 200, exportHeight: 100, expectedWidth: 200, expectedHeight: 100, sizeMatches: true, basis: "boundingBox" },
              sprites: [
                { key: "icon", id: "9:2", name: "icon", rect: { x: 0, y: 0, width: 80, height: 60 } },
                { key: "gem#1", id: "9:3", name: "gem", rect: { x: 80, y: 0, width: 80, height: 60 } },
              ],
              verification: { rounded: 0, overlaps: 0, offSheet: 0, duplicateNames: 1, bleed: 0, hidden: 0, overlapScan: "full" },
              warnings: ['1 sprite name(s) repeat — entries are keyed "name#2"'],
            },
            rev: 11,
            base64: png(200, 100),
          });
        }
        // The trap: the manifest says 128x64 while the bytes are 64x32.
        return ok({
          nodeId: "9:4", name: "Lying", format: "PNG", scale: 2, bytes: 10, exportSize: { width: 128, height: 64 },
          skipped: [],
          manifest: {
            sheet: { id: "9:4", name: "Lying", scale: 2, width: 64, height: 32, exportWidth: 128, exportHeight: 64, expectedWidth: 128, expectedHeight: 64, sizeMatches: true, basis: "boundingBox" },
            sprites: [],
            verification: { rounded: 0, overlaps: 0, offSheet: 0, duplicateNames: 0, bleed: 0, hidden: 0, overlapScan: "full" },
            warnings: [],
          },
          rev: 11,
          base64: png(64, 32),
        });
      }
      case "export_9slice": return ok({
        nodeId: "8:1", name: "Panel", format: "PNG", scale: 2, bytes: 48040, exportSize: { width: 120, height: 80 },
        guide: { id: "8:2", name: "9slice", ignored: false },
        descriptor: {
          design: { width: 60, height: 40, insets: { top: 8, right: 10, bottom: 6, left: 12 } },
          exported: { width: 120, height: 80, insets: { top: 16, right: 20, bottom: 12, left: 24 } },
          middle: { width: 76, height: 52 },
          cssBorderImageSlice: "16 20 12 24",
          warnings: [],
        },
        rev: 11,
        base64: png(120, 80),
      });
      case "export_web_handoff": {
        if (!["6:1", "6:2", "6:3", "6:4"].includes(env.params.nodeId)) return fail("unknown handoff node");
        const other = env.params.nodeId === "6:2";
        const lying = env.params.nodeId === "6:3";
        const dotted = env.params.nodeId === "6:4";
        const name = dotted ? ".." : lying ? "Lying" : "Page/Home";
        const warning = "1 font style could not be loaded: Inter Display Bold — a browser without it will substitute";
        return ok({
          nodeId: env.params.nodeId, name, type: "FRAME", width: 200, height: 100,
          fileKey: "web-file", scale: 2, rev: 11,
          spec: {
            schema: "figma-web-handoff-spec/v1",
            source: { fileKey: "web-file", nodeId: env.params.nodeId, name, type: "FRAME", rev: 11 },
            space: { units: "px", origin: "top-left of the frame's bounding box", yDown: true },
            frame: { id: env.params.nodeId, name, type: "FRAME", width: 200, height: 100 },
            counts: { nodes: 2, colors: 1, fonts: 1, textStyles: 1, spacing: 0 },
            nodes: [
              { id: env.params.nodeId, parent: null, depth: 0, name, type: "FRAME", box: { x: 0, y: 0, width: 200, height: 100 } },
              {
                id: "6:9", parent: env.params.nodeId, depth: 1, name: "Title", type: "TEXT",
                box: { x: 16, y: 12, width: 168, height: 32 },
                text: {
                  characters: "Hello", font: { family: "Inter", style: "Bold", weight: 700 }, fontSize: 24,
                  color: "#111111", token: "text-primary", styleToken: "heading-h1",
                },
              },
            ],
            warnings: other ? [] : [warning],
          },
          tokens: {
            schema: "figma-web-handoff-tokens/v1",
            colors: { "text-primary": { value: "#111111", hex: "#111111", cssVar: "--color-text-primary", uses: 1 } },
            fonts: {
              "inter-bold": { name: "inter-bold", family: "Inter", style: "Bold", weight: 700, familyVar: "--font-family-inter", weightVar: "--font-weight-inter-bold", uses: 1 },
            },
            text: {
              "heading-h1": { name: "heading-h1", cssClass: "heading-h1", font: { family: "Inter", style: "Bold", weight: 700 }, size: 24, align: "LEFT", uses: 1 },
            },
            spacing: {},
          },
          css:
            "/* handoff */\n:root {\n  --color-text-primary: #111111;\n  --font-family-inter: \"Inter\", sans-serif;\n" +
            "  --font-weight-inter-bold: 700;\n}\n\n.heading-h1 {\n  font-family: var(--font-family-inter);\n" +
            "  font-weight: 700;\n  font-size: 24px;\n}\n",
          readme:
            `# Web handoff — ${name}\n\nThis folder is a specification for a developer, not production HTML.\n\n` +
            (other ? "" : `- ${warning}\n`),
          counts: { nodes: 2, colors: 1, fonts: 1, textStyles: 1, spacing: 0 },
          missingFonts: other ? [] : ["Inter Display Bold"],
          uncheckedFonts: other ? [] : ["Stolzl Medium"],
          timings: { walkMs: 12, checkMs: 3, exportMs: 41 },
          warnings: other ? [] : [warning],
          previews: lying
            ? [{ scale: 1, width: 200, height: 100, basis: "boundingBox", base64: png(100, 50) }]
            : [
                { scale: 1, width: 200, height: 100, basis: "boundingBox", bytes: 1, base64: png(200, 100) },
                { scale: 2, width: 400, height: 200, basis: "boundingBox", bytes: 1, base64: png(400, 200) },
              ],
        });
      }
      case "export_ui_states": {
        // normal and disabled are byte-identical on purpose: the tool must notice.
        const [normal, hover] = [png(80, 32, [10, 10, 10, 255]), png(80, 32, [200, 200, 200, 255])];
        return ok({
          nodeId: "7:1", name: "Button/States", type: "COMPONENT_SET", property: "State", format: "PNG", scale: 2,
          states: [
            { key: "normal", name: "normal", id: "7:2", width: 40, height: 16, visible: true, value: "normal" },
            { key: "hover", name: "hover", id: "7:3", width: 40, height: 16, visible: true, value: "hover" },
            { key: "disabled", name: "disabled", id: "7:4", width: 40, height: 16, visible: true, value: "disabled" },
          ],
          files: [
            { key: "normal", id: "7:2", name: "normal", format: "PNG", scale: 2, bytes: 1, exportSize: { width: 80, height: 32 }, base64: normal },
            { key: "hover", id: "7:3", name: "hover", format: "PNG", scale: 2, bytes: 1, exportSize: { width: 80, height: 32 }, base64: hover },
            { key: "disabled", id: "7:4", name: "disabled", format: "PNG", scale: 2, bytes: 1, exportSize: { width: 80, height: 32 }, base64: normal },
          ],
          warnings: [],
          rev: 11,
        });
      }
      default: return fail("unhandled " + env.method);
    }
  });
  await sleep(300);

  // ------------------------------------------------------------- atlas
  const atlasDir = join(OUT, "atlas");
  const atlas = c.text(await c.rpc("tools/call", { name: "figma_export_ui_atlas", arguments: { nodeId: "1:2", scale: 2, outDir: atlasDir } }));
  const atlasReq = seen.find((e) => e.method === "export_atlas");
  check("export_atlas is asked for a scaled PNG of the sheet", atlasReq.params.scale === 2 && atlasReq.params.nodeId === "1:2");
  check("the sheet name becomes the file name", atlas.image.path === join(atlasDir, "Sheet_Hero.png"), atlas.image.path);
  check(
    "the file on disk is the size the manifest claims",
    atlas.image.width === 200 && atlas.image.height === 100 && atlas.verification.disk.matchesManifest === true,
    JSON.stringify(atlas.image),
  );
  const atlasManifest = JSON.parse(fs.readFileSync(atlas.manifest, "utf8"));
  check(
    "the manifest on disk carries the rects, the skipped layer and the warnings",
    atlasManifest.sprites.length === 2 && atlasManifest.sprites[1].key === "gem#1" &&
      atlasManifest.skipped[0].why === "no bounds (empty)" && atlasManifest.warnings.length === 1,
    JSON.stringify(atlasManifest).slice(0, 200),
  );
  check(
    "the rects are in the sheet's own pixels, not the design's",
    JSON.stringify(atlas.sprites.map((s) => s.rect)) === JSON.stringify([
      { x: 0, y: 0, width: 80, height: 60 }, { x: 80, y: 0, width: 80, height: 60 },
    ]),
    JSON.stringify(atlas.sprites),
  );

  const lyingDir = join(OUT, "lying");
  const lying = c.text(await c.rpc("tools/call", { name: "figma_export_ui_atlas", arguments: { nodeId: "9:4", scale: 2, outDir: lyingDir } }));
  check(
    "a file that contradicts the manifest is reported, not believed",
    lying.verification.disk.matchesManifest === false &&
      lying.warnings.some((w) => w.includes("the manifest does not describe this file")),
    JSON.stringify(lying.warnings),
  );

  // ------------------------------------------------------------- 9-slice
  const sliceDir = join(OUT, "slice");
  const slice = c.text(await c.rpc("tools/call", { name: "figma_export_9slice", arguments: { nodeId: "8:1", outDir: sliceDir } }));
  check(
    "the 9-slice descriptor keeps slices in image pixels and widths in design pixels",
    slice.css.borderImageSlice === "16 20 12 24" &&
      slice.css.borderImageWidth === "8px 10px 6px 12px" &&
      slice.css.borderImageSource === "url(Panel.png)",
    JSON.stringify(slice.css),
  );
  const sliceManifest = JSON.parse(fs.readFileSync(slice.descriptor, "utf8"));
  check(
    "the descriptor on disk names the guide layer and the middle",
    sliceManifest.guide.name === "9slice" && sliceManifest.middle.width === 76 && sliceManifest.image.width === 120,
    JSON.stringify(sliceManifest).slice(0, 200),
  );

  // ------------------------------------------------------------- states
  const statesDir = join(OUT, "states");
  const states = c.text(await c.rpc("tools/call", { name: "figma_export_ui_states", arguments: { nodeId: "7:1", scale: 2, outDir: statesDir } }));
  const names = states.files.map((f) => f.file).sort();
  check(
    "each state is one file, named by the variant value with the scale suffix",
    JSON.stringify(names) === JSON.stringify(["disabled@2x.png", "hover@2x.png", "normal@2x.png"]),
    names.join(","),
  );
  check("the variant property that named the states is reported", states.property === "State");
  check(
    "two states with identical bytes are called out",
    states.warnings.some((w) => w.includes("normal@2x.png and disabled@2x.png are byte-identical")),
    JSON.stringify(states.warnings),
  );
  check(
    "the files on disk are real PNGs of the node's size at scale 2",
    states.files.every((f) => f.width === 80 && f.height === 32 && fs.statSync(f.path).size === f.bytes),
    JSON.stringify(states.files),
  );

  // ------------------------------------------------------------- web handoff
  const handoffRoot = join(OUT, "handoff");
  const handoff = c.text(
    await c.rpc("tools/call", {
      name: "figma_export_web_handoff",
      arguments: { nodeId: "6:1", scale: 2, outDir: handoffRoot },
    }),
  );
  const hdir = handoff.dir;
  const hfiles = ["preview.png", "preview@2x.png", "spec.json", "tokens.json", "tokens.css", "README.md", "handoff.json"];
  check(
    "the handoff writes one folder with every promised file",
    hdir === join(handoffRoot, "Page_Home") && hfiles.every((n) => fs.existsSync(join(hdir, n))),
    hdir,
  );
  const hSpec = JSON.parse(fs.readFileSync(join(hdir, "spec.json"), "utf8"));
  const hTokens = JSON.parse(fs.readFileSync(join(hdir, "tokens.json"), "utf8"));
  const hCss = fs.readFileSync(join(hdir, "tokens.css"), "utf8");
  const hReadme = fs.readFileSync(join(hdir, "README.md"), "utf8");
  const hManifest = JSON.parse(fs.readFileSync(join(hdir, "handoff.json"), "utf8"));
  check(
    "the spec on disk keeps both layers and names the source",
    hSpec.source.nodeId === "6:1" && hSpec.nodes.length === 2 && hSpec.nodes[1].text.font.weight === 700,
    JSON.stringify(hSpec.nodes).slice(0, 200),
  );
  check(
    "the tokens and CSS on disk carry the colour and the text class",
    hTokens.colors["text-primary"].value === "#111111" &&
      hCss.includes("--color-text-primary: #111111;") &&
      hCss.includes(".heading-h1"),
    hCss.slice(0, 160),
  );
  check(
    "the README says this is not production HTML and repeats the missing font",
    hReadme.includes("not production HTML") && hReadme.includes("Inter Display Bold"),
    hReadme.slice(0, 160),
  );
  check(
    "the PNGs on disk are the sizes the manifest names",
    JSON.stringify(pngSize(fs.readFileSync(join(hdir, "preview.png")))) === JSON.stringify({ width: 200, height: 100 }) &&
      JSON.stringify(pngSize(fs.readFileSync(join(hdir, "preview@2x.png")))) === JSON.stringify({ width: 400, height: 200 }) &&
      hManifest.images.every((i) => i.matchesManifest === true),
    JSON.stringify(hManifest.images),
  );
  const specEntry = hManifest.files.find((f) => f.name === "spec.json");
  const specHash = createHash("sha256").update(fs.readFileSync(join(hdir, "spec.json"))).digest("hex").slice(0, 16);
  check(
    "the manifest's hashes describe the files that were written",
    specEntry &&
      specEntry.sha256_16 === specHash &&
      hManifest.verification.allFilesWritten === true &&
      hManifest.verification.countsMatchSpec === true &&
      hManifest.verification.imagesMatchManifest === true &&
      handoff.files.length === 6,
    JSON.stringify(hManifest.verification),
  );
  check(
    "the reply points at the README and the manifest",
    handoff.entry === join(hdir, "README.md") && handoff.manifest === join(hdir, "handoff.json"),
    JSON.stringify({ entry: handoff.entry, manifest: handoff.manifest }),
  );
  check(
    "a font the check could not confirm is carried as unchecked, next to the missing one",
    handoff.fonts.unchecked.includes("Stolzl Medium") &&
      hManifest.fonts.unchecked.includes("Stolzl Medium") &&
      handoff.fonts.missing.includes("Inter Display Bold"),
    JSON.stringify({ reply: handoff.fonts, manifest: hManifest.fonts }),
  );
  check(
    "the reply keeps the plugin's per-phase timings, and the manifest invents none",
    JSON.stringify(handoff.timings) === JSON.stringify({ walkMs: 12, checkMs: 3, exportMs: 41 }) &&
      hManifest.timings === undefined,
    JSON.stringify({ reply: handoff.timings, manifest: hManifest.timings }),
  );

  // A bundle belongs to one node; the same folder for another node would mix
  // two documents' hashes and warnings.
  const clash = await c.rpc("tools/call", {
    name: "figma_export_web_handoff",
    arguments: { nodeId: "6:2", scale: 2, outDir: handoffRoot },
  });
  const clashText = String(clash?.result?.content?.[0]?.text ?? clash?.error?.message ?? "");
  check(
    "a second node cannot reuse the first node's folder",
    clash?.result?.isError === true && /already holds a handoff/.test(clashText),
    clashText.slice(0, 180),
  );

  // A preview is checked against its own bytes, not against what the plugin
  // says it exported: a manifest that describes an image nobody wrote is the
  // failure this check exists for.
  const mismatched = c.text(
    await c.rpc("tools/call", {
      name: "figma_export_web_handoff",
      arguments: { nodeId: "6:3", scale: 1, outDir: join(OUT, "handoff-lying") },
    }),
  );
  check(
    "a preview whose bytes contradict its declared size is reported, not believed",
    mismatched.verification.imagesMatchManifest === false &&
      mismatched.warnings.some((w) => w.includes("on disk: the file is 100x50")),
    JSON.stringify({ verification: mismatched.verification, warnings: mismatched.warnings }),
  );

  // A layer can be called "..". It must become a folder name, not a path that
  // walks out of outDir.
  const dotRoot = join(OUT, "handoff-dotdot");
  const dotted = c.text(
    await c.rpc("tools/call", {
      name: "figma_export_web_handoff",
      arguments: { nodeId: "6:4", scale: 1, outDir: dotRoot },
    }),
  );
  check(
    "a node named .. cannot escape outDir",
    dotted.dir === join(dotRoot, "node") &&
      fs.existsSync(join(dotted.dir, "preview.png")) &&
      !fs.existsSync(join(dotRoot, "README.md")),
    dotted.dir,
  );

  // ------------------------------------------------------------- read-only
  const ro = await mcpClient({ FIGMA_BRIDGE_WRITE: "0" });
  const roTools = (await ro.rpc("tools/list", {})).result.tools.map((t) => t.name);
  const roDir = join(OUT, "readonly");
  const roAtlas = ro.text(await ro.rpc("tools/call", { name: "figma_export_ui_atlas", arguments: { nodeId: "1:2", scale: 1, outDir: roDir } }));
  check(
    "exports work with write access off",
    roTools.includes("figma_export_ui_atlas") && roAtlas.image.path === join(roDir, "Sheet_Hero.png") && roAtlas.verification.disk.matchesManifest === true,
    roTools.join(","),
  );
  const roHandoff = ro.text(
    await ro.rpc("tools/call", {
      name: "figma_export_web_handoff",
      arguments: { nodeId: "6:1", scale: 1, outDir: join(OUT, "readonly-handoff") },
    }),
  );
  check(
    "the handoff works with write access off, and scale 1 writes only preview.png",
    roTools.includes("figma_export_web_handoff") &&
      fs.existsSync(join(roHandoff.dir, "preview.png")) &&
      !fs.existsSync(join(roHandoff.dir, "preview@1x.png")),
    JSON.stringify({ dir: roHandoff.dir, files: roHandoff.files?.map((f) => f.name) }),
  );
  ro.kill();

  c.kill();
} catch (err) {
  fail++;
  process.stdout.write(`FAIL  harness — ${err && err.message}\n${err && err.stack}\n`);
} finally {
  daemon.kill();
  try { fs.rmSync(OUT, { recursive: true, force: true }); } catch {}
  await sleep(200);
  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
