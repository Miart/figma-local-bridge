// End-to-end test for the DAEMON architecture:
//   plugin <--ws--> daemon <--ws--> one or more MCP client processes
// This is the shape that survives opencode spawning one MCP process per
// working directory, and the shape Figma's fixed-origin CSP actually allows.
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import fs from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { homedir } from "node:os";
import { encodePng, decodePng } from "../server/dist/compare.js";
import { freshDescriptor } from "./helpers/fresh-descriptor.mjs";

const PORT = Number(process.env.TEST_PORT || 8896);
const INFO = join(homedir(), ".local/share/opencode", "figma-bridge-daemon-tools-test.json");

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

async function mcpClient() {
  const proc = spawn("node", ["server/dist/index.js"], {
    env: { ...process.env, FIGMA_BRIDGE_INFO_FILE: INFO, FIGMA_BRIDGE_DESTRUCTIVE: "1", FIGMA_BRIDGE_JOURNAL: "0" },
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

freshDescriptor(INFO);
const daemon = spawn("node", ["server/dist/daemon.js"], {
  env: { ...process.env, FIGMA_BRIDGE_PORT: String(PORT), FIGMA_BRIDGE_INFO_FILE: INFO },
  stdio: ["ignore", "pipe", "pipe"],
});

const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const seen = [];

try {
  let info = null;
  for (let i = 0; i < 60 && !info; i++) {
    await sleep(150);
    try { info = JSON.parse(fs.readFileSync(INFO, "utf8")); } catch {}
  }
  if (!info) throw new Error("no daemon info");

  const c = await mcpClient();
  const tools = (await c.rpc("tools/list", {})).result.tools.map((t) => t.name);
  const expected = ["figma_whoami", "figma_get_metadata", "figma_get_design_context", "figma_get_layout_tree", "figma_get_screenshot",
    "figma_get_variable_defs", "figma_get_libraries", "figma_search_design_system", "figma_get_figjam",
    "figma_download_assets", "figma_get_code_connect_map", "figma_use", "figma_upload_assets", "figma_add_code_connect_map",
    "figma_compare", "figma_checkpoint", "figma_ops", "figma_cancel",
    "figma_build", "figma_patch", "figma_batch_edit", "figma_swap_component", "figma_variant_set",
    "figma_audit", "figma_index", "figma_search", "figma_design_system", "figma_tokens", "figma_export_build_spec", "figma_review",
    "figma_motion_styles", "figma_motion_inspect", "figma_motion_apply_style", "figma_motion_remove_style",
    "figma_motion_set_keyframes", "figma_motion_remove_keyframes", "figma_motion_set_duration"];
  const missing = expected.filter((n) => !tools.includes(n));
  check("all parity tools are registered", missing.length === 0, "missing: " + missing.join(","));
  check("the local tool surface is 50 tools", tools.length === 50, `${tools.length} tools`);

  const plugin = await connect(info.ws.replace("127.0.0.1", "localhost") + "&role=plugin");
  plugin.on("message", (raw) => {
    const env = JSON.parse(raw.toString());
    seen.push(env);
    const ok = (result, extra) => plugin.send(JSON.stringify({ id: env.id, ok: true, result, rev: 7, ...extra }));
    const fail = (m) => plugin.send(JSON.stringify({ id: env.id, ok: false, error: { message: m } }));
    switch (env.method) {
      case "ping": return ok({ ok: true });
      case "get_metadata": return ok({ xml: '<frame id="1:2" name="Card" />\n', nodes: 1, truncated: false });
      case "get_layout_tree": return ok({
        schemaVersion: 1, snapshotId: "2026-10-19T00:00:00.000Z", atomicWithScreenshot: false,
        file: { name: "Test file", key: "FILEKEY" }, page: { id: "0:1", name: "Page 1" },
        root: { id: env.params.nodeId || "1:2", name: "Card", type: "FRAME" },
        coordinateSpace: "document-absolute", truncated: false, nodeCount: 2,
        nodes: [
          { id: "1:2", parentId: "0:1", name: "Card", type: "FRAME", size: [100, 50], absoluteTransform: [[1, 0, 10], [0, 1, 20]], boundingBox: { x: 10, y: 20, width: 100, height: 50 } },
          { id: "1:3", parentId: "1:2", name: "Label", type: "TEXT", size: [40, 12], boundingBox: { x: 14, y: 24, width: 40, height: 12 } },
        ],
        capture: { window: { x: 10, y: 20, width: 100, height: 50 }, exportSettings: { format: "PNG", contentsOnly: true, useAbsoluteBounds: true, constraint: { type: "SCALE", value: 1 } }, clipping: "Rectangles are layout AABBs." },
        ms: 3,
      });
      case "get_screenshot": return ok({ nodeId: env.params.nodeId || "1:2", name: "Card", format: env.params.format, scale: env.params.scale, bytes: 70, width: 1, height: 1, base64: PNG_1x1 });
      case "export_nodes": return ok({ files: [{ nodeId: "1:2", name: "Card/Hero", format: "PNG", bytes: 70, base64: PNG_1x1 }, { nodeId: "9:9", error: "not found or not exportable" }] });
      case "use_figma":
        if (env.params.code.includes("throw")) return fail("boom (rolled back)\nconsole output before the error:\nhi");
        // `replayed` is what the plugin stamps on a retry served from its opId
        // cache; rev is stamped by every reply (plugin/rev.ts).
        return ok({ ok: true, result: { id: "5:5" }, logs: ["hello"], changed: true, ms: { code: 12, index: 345, total: 360 }, nodes: { before: 3, after: 4 } },
          env.params.code.includes("replayed") ? { replayed: true, rev: 8 } : undefined);
      case "import_images": return ok({ created: env.params.files.map((f) => ({ name: f.name, bytes: Buffer.from(f.base64, "base64").length })) });
      case "build":
        return ok({
          status: env.params.dryRun === false ? "applied" : "dry_run",
          schema: "build-v1",
          buildId: env.params.buildId,
          root: { key: env.params.buildId, type: "FRAME", name: "HUD", nodeId: env.params.dryRun === false ? "7:1" : null, action: env.params.dryRun === false ? "update" : "create" },
          parent: { id: "0:1", name: "Page 1", type: "PAGE" },
          counts: { nodes: 2, create: env.params.dryRun === false ? 0 : 2, update: env.params.dryRun === false ? 2 : 0, unchanged: 0, delete: 0 },
          planned: { create: env.params.dryRun === false ? [] : ["hud", "hud/title#0"], update: env.params.dryRun === false ? ["hud", "hud/title#0"] : [], delete: [], unchanged: [] },
          fingerprint: "fp-test",
          fonts: ["Inter/Regular"], styles: { text: [], paint: [], effect: [] }, variables: [], components: [],
          warnings: [], blocking: [], prune: false,
          planId: env.params.planId,
          verification: { ok: true, missing: [], typeMismatch: [] },
        });
      case "swap_component":
        return ok({
          status: env.params.dryRun === false ? "applied" : "dry_run",
          schema: "component-swap-v1",
          state: "compatible",
          dryRun: env.params.dryRun !== false,
          targets: [{
            nodeId: env.params.nodeIds?.[0] || "1:2",
            name: "Button",
            fingerprint: "fp-test",
            from: { id: "9:9", key: "button-old", name: "Button" },
            to: { id: env.params.componentId || "9:10", key: "button-new", name: "Button v2" },
            compatibility: { status: "compatible", overrides: { total: 2, replayable: 2, atRisk: 0 }, properties: { total: 2, replayable: 2, dropped: 0 }, root: { fields: ["width", "height"], size: "preserved" }, losses: [], lossCount: 0 },
          }],
          counts: { targets: 1, compatible: 1, lossy: 0, unverified: 0, overridesTotal: 2, overridesReplayable: 2 },
          blocking: [],
          warnings: [],
          verification: { ok: true, targets: [{ nodeId: env.params.nodeIds?.[0] || "1:2", verified: true }] },
          planId: env.params.planId,
          ms: { plan: 3 },
        });
      case "variant_set":
        return ok({
          status: env.params.dryRun === false ? "applied" : "dry_run",
          schema: "variant-set-v1",
          action: env.params.action,
          dryRun: env.params.dryRun !== false,
          set: {
            id: env.params.dryRun === false ? "8:1" : "8:0",
            nodeId: env.params.dryRun === false ? "8:1" : null,
            key: "button-set",
            publishedKey: null,
            name: env.params.name || "Button",
            type: "COMPONENT_SET",
            variantProperties: { Size: { values: ["M", "S"] }, Tone: { values: ["Light"] } },
            defaultVariantId: "8:2",
          },
          components: (env.params.components || []).map((c, i) => ({
            nodeId: c.nodeId || `8:${i + 2}`,
            key: `button-${i}`,
            name: Object.entries(c.properties).map(([k, v]) => `${k}=${v}`).join(", "),
            variantProperties: c.properties,
            variantName: Object.entries(c.properties).map(([k, v]) => `${k}=${v}`).join(", "),
          })),
          variantProperties: { Size: { values: ["M", "S"] }, Tone: { values: ["Light"] } },
          counts: { components: 2, propertyNames: 2, variants: 2 },
          warnings: ["component names are replaced by the requested variant names; previous names are reported"],
          fingerprints: { "8:2": "fp-component-a", "8:3": "fp-component-b" },
          verification: env.params.dryRun === false ? { ok: true, problems: [] } : undefined,
          planId: env.params.planId,
          ms: { plan: 2, apply: 1, total: 3 },
        });
      case "tokens":
        if (env.params.action === "export") {
          return ok({
            status: "exported",
            schema: "figma-tokens/v1",
            document: {
              schema: "figma-tokens/v1",
              file: { name: "Test file", key: "FILEKEY" },
              collections: [{
                name: "Theme",
                modes: ["Light"],
                defaultMode: "Light",
                variables: [{
                  name: "color/bg", type: "COLOR", description: "background",
                  values: { Light: "#ffffff" },
                }],
              }],
            },
            counts: { collections: 1, variables: 1, modes: 1, skipped: 0 },
            warnings: [],
            ms: { export: 1 },
          });
        }
        return ok({
          status: env.params.dryRun === false ? "applied" : "dry_run",
          schema: "figma-tokens/v1",
          dryRun: env.params.dryRun !== false,
          summary: {
            collections: { create: 1, existing: 0, modesCreate: 1, extraModes: 0 },
            variables: { create: 1, update: 0, delete: 0, unchanged: 0 },
            changes: 2,
            truncated: false,
          },
          changes: [
            { kind: "collection", action: "create", collection: "Theme", modes: ["Light"], defaultMode: "Light" },
            { kind: "variable", action: "create", collection: "Theme", name: "color/bg", type: "COLOR", values: { Light: { before: null, after: "#ffffff" } } },
          ],
          fingerprint: "token-fp",
          warnings: [],
          blocking: [],
          ...(env.params.dryRun === false ? { verification: { ok: true, problems: [] } } : {}),
          ms: { plan: 2, ...(env.params.dryRun === false ? { apply: 1 } : {}) },
        });
      case "motion_styles":
        return ok({
          schema: "motion-styles-v1",
          available: true,
          playheadPosition: 0.5,
          figmaStyles: [{ styleId: "S:anim", name: "Fade in", description: "opacity" }],
          customStyles: [{ styleId: "C:anim", id: "C:anim", key: "custom-key", name: "My fade", entries: [] }],
          counts: { figma: 1, custom: 1 },
          warnings: [],
        });
      case "motion_inspect":
        return ok({
          schema: "motion-inspect-v1",
          node: { id: env.params.nodeId || "1:2", name: "Card", type: "FRAME" },
          playheadPosition: 0.5,
          animationStyles: [{ id: "A:1", styleId: "S:anim", name: "Fade in", type: "FIGMA", duration: 0.6 }],
          manualKeyframeTracks: {
            OPACITY: { id: "T:1", baseValue: { type: "FLOAT", value: 1 }, keyframes: [{ id: "K:1", timelinePosition: 0, value: { type: "FLOAT", value: 0 } }] },
          },
          animations: {},
          timelines: [{ id: "TL:1", duration: 1.2 }],
          capabilities: { animationStyles: true, applyAnimationStyle: true, removeAnimationStyle: true, manualKeyframes: true, timelineDuration: true },
        });
      case "motion_apply_style":
      case "motion_remove_style":
      case "motion_set_keyframes":
      case "motion_remove_keyframes":
      case "motion_set_duration": {
        const dry = env.params.dryRun !== false;
        const planId = env.params.planId || "motion-plan-test";
        return ok({
          schema: "motion-plan-v1",
          status: dry ? "dry_run" : "applied",
          dryRun: dry,
          planId,
          ...(dry
            ? { plan: { op: env.method, target: { id: env.params.nodeId || "1:2" }, state: "state-test" }, note: "No document write." }
            : { mutated: true, verified: true }),
        });
      }
      case "design_system":
        return ok({
          schema: "design-system-v1",
          file: { name: "Test file", key: "FILEKEY" },
          include: env.params.include || ["styles", "variables", "components"],
          styles: [{ kind: "paint", id: "S:1", key: "style-key", name: "brand/primary", type: "PAINT", paints: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }] }],
          variables: [],
          components: [],
          counts: { styles: 1, variables: 0, components: 0, total: 1 },
          truncated: false,
          warnings: [],
        });
      case "export_spec":
        return ok({
          schema: "build-spec-export/v1",
          source: { id: env.params.nodeId || "1:2", name: "Card", type: "FRAME", key: "card", buildId: null, path: "Page 1 / Card" },
          spec: { type: "FRAME", name: "Card", key: "card", size: { width: 100, height: 50 }, fills: [], children: [] },
          counts: { nodes: 1, scanned: 1, skipped: 0 },
          unsupported: [], warnings: [], truncated: false,
          ms: { export: 4 },
        });
      case "index":
        return ok({
          schema: "index-v1",
          scope: { id: "0:1", name: "Actual", type: "PAGE" },
          nodes: [{ id: "1:2", key: "hud", name: "HUD", type: "FRAME", path: "Actual / HUD", depth: 0, visible: true, size: [10, 10], childCount: 1 }],
          counts: { nodes: 1, byType: { FRAME: 1 } },
          settings: { includeHidden: false, includeText: false, maxNodes: 1000, maxDepth: null },
          truncated: false,
          warnings: [],
        });
      case "search":
        return ok({
          schema: "search-v1",
          scope: { id: "0:1", name: "Actual", type: "PAGE" },
          query: { text: env.params.query, mode: env.params.mode, caseSensitive: false, fields: ["name", "key", "text"] },
          filters: { types: null, keyPrefix: null, hasKey: null, includeHidden: true },
          matches: [{ id: "1:2", key: "hud", name: "HUD", type: "FRAME", path: "Actual / HUD", depth: 0, visible: true, size: [10, 10], childCount: 1, matchedIn: ["name"] }],
          counts: { matches: 1, listed: 1, byField: { name: 1 }, byType: { FRAME: 1 }, scanned: 1 },
          truncated: false,
          resultsTruncated: 0,
          warnings: [],
        });
      case "inspect":
        return ok({
          node: { id: env.params.nodeId || "1:2", name: "Card", type: "FRAME" },
          fingerprint: { hash: "fp-structure", appearanceHash: "fp-appearance", geometryHash: "fp-geometry", childrenHash: "fp-children", geometryStatus: "EXACT" },
          warnings: [],
        });
      case "audit": {
        const auditRoot = env.params.rootNodeId || "0:1";
        const findings = [{ rule: "contrast", severity: "error", nodeId: "1:3", nodeKey: "hud/title#0", name: "Title", type: "TEXT", path: "Card / Title", detail: "contrast 2.1:1", ratio: 2.1 }];
        if (auditRoot === "1:3") {
          findings.push({ rule: "placeholder-text", severity: "error", nodeId: "1:4", nodeKey: "hud/body#0", name: "Body", type: "TEXT", path: "Card / Body", detail: "Lorem ipsum" });
        }
        return ok({
          schema: "audit-v2",
          scope: { id: auditRoot, name: "Card", type: "FRAME" },
          rules: [{ id: "contrast", description: "text contrast", severity: "error" }],
          nodesScanned: 4,
          truncated: false,
          includeHidden: false,
          counts: { error: findings.length, warning: 0, info: 0, total: findings.length },
          byRule: findings.reduce((m, f) => ({ ...m, [f.rule]: (m[f.rule] || 0) + 1 }), {}),
          findings,
          findingsTruncated: 0,
          warnings: [],
        });
      }
      case "batch":
        return ok({
          status: env.params.dryRun === false ? "applied" : "dry_run",
          schema: "batch-v1",
          ops: env.params.ops.map((op, index) => ({
            index, op: op.op,
            target: { id: "1:2", name: "Card", type: "FRAME", key: "hud" },
            parent: op.parentKey || op.parentId ? {
              id: op.parentKey ? "1:3" : op.parentId,
              name: "Box", type: "FRAME", key: op.parentKey || "",
              fingerprint: op.parentKey ? "fp-parent" : null,
            } : undefined,
            status: env.params.dryRun === false ? "updated" : "planned",
            nodeId: env.params.dryRun === false ? "1:2" : undefined,
          })),
          fingerprints: env.params.ops.some((op) => op.parentKey) ? { "1:2": "fp-test", "1:3": "fp-parent" } : { "1:2": "fp-test" },
          applied: env.params.dryRun === false ? env.params.ops.length : 0,
          failed: 0,
          warnings: [],
          planId: env.params.planId,
        });
      case "patch":
        return ok({
          status: env.params.dryRun === false ? "applied" : "dry_run",
          schema: "build-v1",
          buildId: env.params.buildId,
          root: { key: "hud", type: "FRAME", name: "HUD", nodeId: "7:1", action: "update" },
          parent: { id: "0:1", name: "Page 1", type: "PAGE" },
          counts: { nodes: 1, create: 0, update: 1, unchanged: 0, delete: 0 },
          planned: { create: [], update: ["hud"], delete: [], unchanged: [] },
          fingerprint: "fp-test",
          fonts: [], styles: { text: [], paint: [], effect: [] }, variables: [], components: [],
          warnings: [], blocking: [], prune: false,
          planId: env.params.planId,
          verification: { ok: true, missing: [], typeMismatch: [] },
        });
      case "ops": {
        const report = {
          file: { key: "FILEKEY", name: "Test file" },
          running: [{ opId: "op-run", method: "use_figma", state: "running", queuedAt: 1000, startedAt: 1000, waitedMs: 0, ranMs: 1200 }],
          queued: [{ opId: "op-wait", method: "import_images", state: "queued", queuedAt: 1500, waitedMs: 900 }],
          recent: [{ opId: "op-done", method: "get_metadata", state: "done", queuedAt: 100, startedAt: 100, endedAt: 180, waitedMs: 0, ranMs: 80, rev: 6, ok: true }],
          seen: 3,
          kept: 3,
          note: "Only calls that carried an opId appear here.",
        };
        if (env.params.opId) {
          return ok({
            ...report,
            opId: env.params.opId,
            op: report.recent[0],
            record: { ok: true, rev: 6, result: { nodes: 1 } },
          });
        }
        return ok(report);
      }
      case "cancel":
        if (env.params.opId === "op-run") {
          return fail("OP_RUNNING: op op-run (use_figma) is running right now — 1.2 s in — and Figma runs plugin code to the end.");
        }
        return ok({ opId: env.params.opId, method: "import_images", waitedMs: 900, position: 0 });
      default: return fail("unhandled " + env.method);
    }
  });
  await sleep(300);

  const meta = await c.rpc("tools/call", { name: "figma_get_metadata", arguments: { nodeId: "1:2" } });
  check("get_metadata returns the XML as text", meta.result.content[0].text.includes('<frame id="1:2"'));

  const shot = await c.rpc("tools/call", { name: "figma_get_screenshot", arguments: { nodeId: "1:2" } });
  const img = shot.result.content.find((x) => x.type === "image");
  check("get_screenshot returns an MCP image block", !!img && img.mimeType === "image/png" && img.data === PNG_1x1);
  const shotReq = seen.find((e) => e.method === "get_screenshot");
  check("screenshot defaults applied (PNG, scale 1)", shotReq.params.format === "PNG" && shotReq.params.scale === 1);
  check("screenshot caption carries the document rev",
    shot.result.content.find((x) => x.type === "text").text.includes("rev 7"),
    JSON.stringify(shot.result.content.map((x) => x.text || x.type)));

  const layout = c.text(await c.rpc("tools/call", { name: "figma_get_layout_tree", arguments: { nodeId: "1:2" } }));
  check("get_layout_tree passes absolute geometry through untouched",
    layout.coordinateSpace === "document-absolute" && layout.nodes[1].boundingBox.x === 14 &&
    layout.atomicWithScreenshot === false && layout.truncated === false,
    JSON.stringify(layout).slice(0, 120));
  const ltReq = seen.find((e) => e.method === "get_layout_tree");
  check("get_layout_tree sends nodeId and the default truncation budget",
    ltReq.params.nodeId === "1:2" && ltReq.params.maxNodes === 2000,
    JSON.stringify(ltReq.params));

  // The plugin would answer "node not found" to a hyphenated id, which names
  // the wrong problem. The refusal has to happen at the tool edge, before the
  // request is even sent.
  const seenBefore = seen.length;
  const badId = await c.rpc("tools/call", { name: "figma_get_metadata", arguments: { nodeId: "4029-12345" } });
  const badIdMsg = String(badId.error?.message ?? badId.result?.content?.[0]?.text ?? JSON.stringify(badId));
  check("hyphenated node id is refused before the plugin sees it",
    /colon/.test(badIdMsg) && seen.length === seenBefore,
    badIdMsg.slice(0, 140));

  const dir = fs.mkdtempSync(join(os.tmpdir(), "flb-dl-"));
  const dl = c.text(await c.rpc("tools/call", { name: "figma_download_assets", arguments: { nodeIds: ["1:2", "9:9"], outDir: dir } }));
  const first = dl.files[0];
  check("download_assets writes a real PNG and sanitises the name",
    first.path && fs.existsSync(first.path) && fs.readFileSync(first.path).subarray(1, 4).toString() === "PNG" && !first.path.slice(dir.length).includes("/Hero/"),
    JSON.stringify(dl));
  check("download_assets reports per-node errors", dl.files[1].error === "not found or not exportable");

  // figma_compare: the render comes back through the plugin, the reference is a
  // file on disk, and the answer is a report with a heatmap written beside it.
  const reportOf = (r) => JSON.parse(r.result.content[0].text.slice(r.result.content[0].text.indexOf("\n\n") + 2));
  const refSame = join(dir, "ref-same.png");
  fs.writeFileSync(refSame, Buffer.from(PNG_1x1, "base64"));
  const cmpSame = reportOf(await c.rpc("tools/call", { name: "figma_compare", arguments: { nodeId: "1:2", reference: refSame } }));
  check("figma_compare calls the same render identical and writes the heatmap",
    cmpSame.identical === true && cmpSame.different === 0 && cmpSame.ratioPercent === 0 &&
    cmpSame.render.rev === 7 && fs.existsSync(cmpSame.heatmap),
    JSON.stringify(cmpSame));

  const refOther = join(dir, "ref-other.png");
  fs.writeFileSync(refOther, encodePng({ width: 1, height: 1, rgba: new Uint8Array([0, 0, 255, 255]) }));
  const cmpDiff = await c.rpc("tools/call", { name: "figma_compare", arguments: { nodeId: "1:2", reference: refOther } });
  const diffReport = reportOf(cmpDiff);
  check("figma_compare reports the one differing pixel and where it is",
    diffReport.identical === false && diffReport.different === 1 && diffReport.ratioPercent === 100 &&
    JSON.stringify(diffReport.bbox) === "[0,0,1,1]" && diffReport.clusters[0].pixels === 1,
    JSON.stringify(diffReport));
  check("figma_compare returns the heatmap as an MCP image block",
    cmpDiff.result.content.some((x) => x.type === "image" && x.mimeType === "image/png"));
  const heat = decodePng(fs.readFileSync(diffReport.heatmap));
  check("the heatmap on disk is a readable PNG of the compared area", heat.width === 1 && heat.height === 1);

  // Validation has to happen before the render, not after: a reference that is
  // not a picture means there is nothing to compare against.
  const seenBeforeCompare = seen.length;
  const notPng = join(dir, "not-a-picture.txt");
  fs.writeFileSync(notPng, "hello");
  const cmpBad = await c.rpc("tools/call", { name: "figma_compare", arguments: { nodeId: "1:2", reference: notPng } });
  const cmpBadMsg = String(cmpBad.error?.message ?? cmpBad.result?.content?.[0]?.text ?? JSON.stringify(cmpBad));
  check("a non-PNG reference is refused before anything is rendered",
    /reference must be a PNG/.test(cmpBadMsg) && seen.length === seenBeforeCompare,
    cmpBadMsg.slice(0, 140));

  // figma_use now requires an explicit destructive opt-in plus a named scope;
  // see use-figma.gate.test.mjs for the refusal cases.
  const useArgs = { allowDestructive: true, scopeNodeId: "1:2" };
  const run = c.text(await c.rpc("tools/call", { name: "figma_use", arguments: { code: "return 1", ...useArgs } }));
  check("figma_use returns result, logs and changedPage", run.result.id === "5:5" && run.logs[0] === "hello" && run.changedPage === true, JSON.stringify(run));
  check("figma_use reports rev, ms and nodes from the plugin",
    run.rev === 7 && run.ms.index === 345 && run.nodes.before === 3 && run.replayed === undefined,
    JSON.stringify(run));
  const useReq = seen.filter((e) => e.method === "use_figma")[0];
  check("figma_use sends verbose:false by default", useReq.params.verbose === false);

  const runAgain = c.text(await c.rpc("tools/call", {
    name: "figma_use",
    arguments: { code: "return 2 // replayed", ...useArgs, verbose: true },
  }));
  const useReqs = seen.filter((e) => e.method === "use_figma");
  check("figma_use passes verbose through and reports a replayed answer",
    useReqs[1].params.verbose === true && runAgain.replayed === true && runAgain.rev === 8,
    JSON.stringify(runAgain));

  const bad = await c.rpc("tools/call", { name: "figma_use", arguments: { code: "throw new Error('x')", ...useArgs } });
  const badText = JSON.stringify(bad.result?.content ?? bad.error);
  check("figma_use surfaces the error with console output", badText.includes("boom") && badText.includes("console output"));

  const img1 = join(dir, "pic.png");
  fs.writeFileSync(img1, Buffer.from(PNG_1x1, "base64"));
  const up = c.text(await c.rpc("tools/call", { name: "figma_upload_assets", arguments: { paths: [img1] } }));
  check("upload_assets sends the file bytes to the plugin", up.created && up.created[0].name === "pic" && up.created[0].bytes === 70, JSON.stringify(up));
  const svg = join(dir, "x.svg");
  fs.writeFileSync(svg, "<svg/>");
  const upSvg = await c.rpc("tools/call", { name: "figma_upload_assets", arguments: { paths: [svg] } });
  check("upload_assets rejects SVG with a pointer to figma_use", JSON.stringify(upSvg.result?.content ?? upSvg.error).includes("unsupported image type"));

  // figma_build / figma_patch: the server mints a content planId, keeps a dry
  // run read-only, and refuses to apply a spec that changed after the preview.
  const buildSeenBefore = seen.length;
  const buildDry = c.text(await c.rpc("tools/call", {
    name: "figma_build",
    arguments: {
      buildId: "hud",
      root: { type: "FRAME", name: "HUD", children: [{ type: "TEXT", name: "Title", text: "Hi" }] },
    },
  }));
  const buildReq = seen[buildSeenBefore];
  check("figma_build defaults to a dry run and sends a content planId",
    buildDry.status === "dry_run" && buildReq.method === "build" && typeof buildReq.params.planId === "string" && buildReq.params.dryRun === true,
    JSON.stringify({ dry: buildDry.status, method: buildReq.method, planId: buildReq.params.planId, dryRun: buildReq.params.dryRun }));

  const buildApplied = c.text(await c.rpc("tools/call", {
    name: "figma_build",
    arguments: {
      buildId: "hud", dryRun: false, planId: buildDry.planId, expectedFingerprint: buildDry.fingerprint,
      root: { type: "FRAME", name: "HUD", children: [{ type: "TEXT", name: "Title", text: "Hi" }] },
    },
  }));
  check("figma_build applies with the planId from the dry run",
    buildApplied.status === "applied" && buildApplied.verification.ok === true && buildApplied.planId === buildDry.planId,
    JSON.stringify(buildApplied).slice(0, 200));

  const seenBeforeMismatch = seen.length;
  const mismatch = await c.rpc("tools/call", {
    name: "figma_build",
    arguments: {
      buildId: "hud", dryRun: false, planId: "not-the-plan",
      root: { type: "FRAME", name: "HUD", children: [{ type: "TEXT", name: "Title", text: "Different" }] },
    },
  });
  const mismatchMsg = String(mismatch.error?.message ?? mismatch.result?.content?.[0]?.text ?? JSON.stringify(mismatch));
  check("figma_build refuses a planId that belongs to another spec before it reaches the plugin",
    /PLAN_MISMATCH/.test(mismatchMsg) && seen.length === seenBeforeMismatch,
    mismatchMsg.slice(0, 160));

  const patchDry = c.text(await c.rpc("tools/call", {
    name: "figma_patch",
    arguments: {
      buildId: "hud",
      patch: { type: "FRAME", children: [{ type: "TEXT", name: "Title", text: "Hello" }] },
    },
  }));
  check("figma_patch defaults to a dry-run diff",
    patchDry.status === "dry_run" && patchDry.counts.update === 1 && patchDry.planId && patchDry.fingerprint === "fp-test",
    JSON.stringify(patchDry).slice(0, 200));

  const batchSeenBefore = seen.length;
  const batchDry = c.text(await c.rpc("tools/call", {
    name: "figma_batch_edit",
    arguments: { ops: [{ op: "set_text", nodeId: "1:2", text: "Hello" }] },
  }));
  const batchReq = seen[batchSeenBefore];
  check("figma_batch_edit defaults to a dry run with per-target fingerprints",
    batchDry.status === "dry_run" && batchDry.ops.length === 1 && batchDry.fingerprints["1:2"] === "fp-test" &&
      batchReq.method === "batch" && batchReq.params.dryRun === true && typeof batchReq.params.planId === "string",
    JSON.stringify(batchDry).slice(0, 200));

  const batchApplied = c.text(await c.rpc("tools/call", {
    name: "figma_batch_edit",
    arguments: {
      dryRun: false,
      planId: batchDry.planId,
      expectedFingerprints: batchDry.fingerprints,
      ops: [{ op: "set_text", nodeId: "1:2", text: "Hello" }],
    },
  }));
  check("figma_batch_edit applies the same ops with the dry-run planId",
    batchApplied.status === "applied" && batchApplied.failed === 0 && batchApplied.planId === batchDry.planId,
    JSON.stringify(batchApplied).slice(0, 200));

  const keyedSeenBefore = seen.length;
  const keyedDry = c.text(await c.rpc("tools/call", {
    name: "figma_batch_edit",
    arguments: { ops: [{ op: "reparent", key: "hud/score#0", parentKey: "hud/box#2", index: 0 }] },
  }));
  const keyedReq = seen[keyedSeenBefore];
  check("figma_batch_edit resolves a keyed destination and fingerprints it",
    keyedReq.params.ops[0].parentKey === "hud/box#2" && keyedReq.params.ops[0].index === 0 &&
      keyedDry.ops[0].parent?.id === "1:3" && keyedDry.ops[0].parent.fingerprint === "fp-parent" &&
      keyedDry.fingerprints["1:3"] === "fp-parent",
    JSON.stringify(keyedDry).slice(0, 220));

  const batchSeenMismatch = seen.length;
  const batchMismatch = await c.rpc("tools/call", {
    name: "figma_batch_edit",
    arguments: {
      dryRun: false,
      planId: "not-the-plan",
      ops: [{ op: "set_text", nodeId: "1:2", text: "Different" }],
    },
  });
  const batchMismatchMsg = String(batchMismatch.error?.message ?? batchMismatch.result?.content?.[0]?.text ?? JSON.stringify(batchMismatch));
  check("figma_batch_edit refuses a planId that belongs to another op list",
    /PLAN_MISMATCH/.test(batchMismatchMsg) && seen.length === batchSeenMismatch,
    batchMismatchMsg.slice(0, 160));

  const swapSeenBefore = seen.length;
  const swapDry = c.text(await c.rpc("tools/call", {
    name: "figma_swap_component",
    arguments: { nodeIds: ["1:2"], componentId: "9:10" },
  }));
  const swapReq = seen[swapSeenBefore];
  check("figma_swap_component defaults to a dry run and sends a content planId",
    swapDry.status === "dry_run" && swapDry.schema === "component-swap-v1" && swapDry.targets[0].compatibility.status === "compatible" &&
      swapReq.method === "swap_component" && swapReq.params.dryRun === true && typeof swapReq.params.planId === "string",
    JSON.stringify(swapDry).slice(0, 200));

  const swapApplied = c.text(await c.rpc("tools/call", {
    name: "figma_swap_component",
    arguments: {
      dryRun: false,
      planId: swapDry.planId,
      nodeIds: ["1:2"],
      componentId: "9:10",
      allowLoss: true,
      expectedFingerprints: { "1:2": "fp-test" },
    },
  }));
  check("figma_swap_component applies with the dry-run planId and fingerprints",
    swapApplied.status === "applied" && swapApplied.planId === swapDry.planId && swapApplied.verification.ok === true,
    JSON.stringify(swapApplied).slice(0, 200));

  const swapSeenMismatch = seen.length;
  const swapMismatch = await c.rpc("tools/call", {
    name: "figma_swap_component",
    arguments: {
      dryRun: false,
      planId: swapDry.planId,
      nodeIds: ["1:2"],
      componentId: "9:11",
      expectedFingerprints: { "1:2": "fp-test" },
    },
  });
  const swapMismatchMsg = String(swapMismatch.error?.message ?? swapMismatch.result?.content?.[0]?.text ?? JSON.stringify(swapMismatch));
  check("figma_swap_component refuses a planId that belongs to another request",
    /PLAN_MISMATCH/.test(swapMismatchMsg) && seen.length === swapSeenMismatch,
    swapMismatchMsg.slice(0, 160));

  const variantSeenBefore = seen.length;
  const variantDry = c.text(await c.rpc("tools/call", {
    name: "figma_variant_set",
    arguments: {
      action: "combine",
      name: "Button",
      components: [
        { nodeId: "8:2", properties: { Size: "S", Tone: "Light" } },
        { nodeId: "8:3", properties: { Size: "M", Tone: "Light" } },
      ],
    },
  }));
  const variantReq = seen[variantSeenBefore];
  check("figma_variant_set defaults to a dry run and sends the property matrix",
    variantDry.status === "dry_run" && variantDry.schema === "variant-set-v1" && variantDry.action === "combine" &&
      variantDry.set.name === "Button" && variantDry.components.length === 2 &&
      variantReq.method === "variant_set" && variantReq.params.dryRun === true && typeof variantReq.params.planId === "string",
    JSON.stringify(variantDry).slice(0, 200));

  const variantApplied = c.text(await c.rpc("tools/call", {
    name: "figma_variant_set",
    arguments: {
      action: "combine",
      name: "Button",
      components: [
        { nodeId: "8:2", properties: { Size: "S", Tone: "Light" } },
        { nodeId: "8:3", properties: { Size: "M", Tone: "Light" } },
      ],
      dryRun: false,
      planId: variantDry.planId,
      expectedFingerprints: variantDry.fingerprints,
    },
  }));
  check("figma_variant_set applies with the dry-run planId and fingerprints",
    variantApplied.status === "applied" && variantApplied.planId === variantDry.planId &&
      variantApplied.verification.ok === true && variantApplied.set.type === "COMPONENT_SET",
    JSON.stringify(variantApplied).slice(0, 200));

  const addSeenBefore = seen.length;
  const addDry = c.text(await c.rpc("tools/call", {
    name: "figma_variant_set",
    arguments: { action: "add", sourceId: "8:2", properties: { Size: "L", Tone: "Light" } },
  }));
  check("figma_variant_set add sends the source and the complete new properties",
    addDry.action === "add" && seen[addSeenBefore].method === "variant_set" &&
      seen[addSeenBefore].params.sourceId === "8:2" && seen[addSeenBefore].params.properties.Size === "L",
    JSON.stringify(addDry).slice(0, 160));

  const editSeenBefore = seen.length;
  const editDry = c.text(await c.rpc("tools/call", {
    name: "figma_variant_set",
    arguments: { action: "edit", variantId: "8:2", properties: { Size: "XL", Tone: "Light" } },
  }));
  check("figma_variant_set edit sends the variant and the complete new properties",
    editDry.action === "edit" && seen[editSeenBefore].method === "variant_set" &&
      seen[editSeenBefore].params.variantId === "8:2" && seen[editSeenBefore].params.properties.Size === "XL",
    JSON.stringify(editDry).slice(0, 160));

  const variantSeenMismatch = seen.length;
  const variantMismatch = await c.rpc("tools/call", {
    name: "figma_variant_set",
    arguments: {
      action: "combine",
      name: "Button",
      components: [
        { nodeId: "8:2", properties: { Size: "S", Tone: "Light" } },
        { nodeId: "8:4", properties: { Size: "M", Tone: "Light" } },
      ],
      dryRun: false,
      planId: variantDry.planId,
      expectedFingerprints: variantDry.fingerprints,
    },
  });
  const variantMismatchMsg = String(variantMismatch.error?.message ?? variantMismatch.result?.content?.[0]?.text ?? JSON.stringify(variantMismatch));
  check("figma_variant_set refuses a planId that belongs to another matrix",
    /PLAN_MISMATCH/.test(variantMismatchMsg) && seen.length === variantSeenMismatch,
    variantMismatchMsg.slice(0, 160));

  const auditSeenBefore = seen.length;
  const audit = c.text(await c.rpc("tools/call", {
    name: "figma_audit",
    arguments: { rootNodeId: "1:2", rules: ["contrast"], suggest: false },
  }));
  const auditReq = seen[auditSeenBefore];
  check("figma_audit sends the subtree and the selected rules, and carries findings through",
    auditReq.method === "audit" && auditReq.params.rootNodeId === "1:2" && auditReq.params.suggest === false &&
      audit.schema === "audit-v2" && audit.findings[0].rule === "contrast" && audit.counts.error === 1,
    JSON.stringify(audit).slice(0, 200));

  const reviewDir = join(dir, "reviews");
  const reviewSaved = c.text(await c.rpc("tools/call", {
    name: "figma_review",
    arguments: { action: "save", nodeId: "1:2", dir: reviewDir, rules: ["contrast"], suggest: false },
  }));
  check("figma_review saves a PNG, the audit and the structure fingerprint",
    reviewSaved.action === "save" && reviewSaved.audit.counts.error === 1 &&
      reviewSaved.node.name === "Card" && reviewSaved.fingerprint.hash === "fp-structure" &&
      fs.existsSync(reviewSaved.path) && fs.existsSync(reviewSaved.imagePath),
    JSON.stringify(reviewSaved).slice(0, 200));
  const reviewCompared = reportOf(await c.rpc("tools/call", {
    name: "figma_review",
    arguments: { action: "compare", id: reviewSaved.id, dir: reviewDir, inline: false },
  }));
  check("figma_review compares against the baseline and says unchanged",
    reviewCompared.action === "compare" && reviewCompared.status === "unchanged" &&
      reviewCompared.visual.identical === true && reviewCompared.audit.delta.total === 0 &&
      reviewCompared.structure.fingerprintEqual === true,
    JSON.stringify(reviewCompared).slice(0, 240));
  const reviewList = c.text(await c.rpc("tools/call", {
    name: "figma_review",
    arguments: { action: "list", dir: reviewDir },
  }));
  check("figma_review lists and drops a local baseline",
    reviewList.action === "list" && reviewList.count === 1 && reviewList.reviews[0].id === reviewSaved.id,
    JSON.stringify(reviewList).slice(0, 200));
  const reviewDropped = c.text(await c.rpc("tools/call", {
    name: "figma_review",
    arguments: { action: "drop", id: reviewSaved.id, dir: reviewDir },
  }));
  check("figma_review drop removes the bundle",
    reviewDropped.action === "drop" && reviewDropped.files.length === 3,
    JSON.stringify(reviewDropped).slice(0, 200));

  const reviewRegressedBase = c.text(await c.rpc("tools/call", {
    name: "figma_review",
    arguments: { action: "save", nodeId: "1:2", dir: reviewDir, rules: ["contrast"], suggest: false },
  }));
  const reviewRegressed = reportOf(await c.rpc("tools/call", {
    name: "figma_review",
    arguments: { action: "compare", id: reviewRegressedBase.id, nodeId: "1:3", dir: reviewDir, inline: false },
  }));
  check("figma_review calls a new finding a regression",
    reviewRegressed.status === "regressed" && reviewRegressed.regressions.total === 1 &&
      reviewRegressed.audit.new.total === 1 && reviewRegressed.audit.new.list[0].rule === "placeholder-text" &&
      reviewRegressed.visual.identical === true,
    JSON.stringify(reviewRegressed).slice(0, 260));

  const indexSeenBefore = seen.length;
  const index = c.text(await c.rpc("tools/call", {
    name: "figma_index",
    arguments: { maxNodes: 10, includeText: true },
  }));
  const indexReq = seen[indexSeenBefore];
  check("figma_index sends its cap and returns a flat index",
    indexReq.method === "index" && indexReq.params.maxNodes === 10 && indexReq.params.includeText === true &&
      index.schema === "index-v1" && index.nodes[0].path === "Actual / HUD",
    JSON.stringify(index).slice(0, 200));

  const searchSeenBefore = seen.length;
  const search = c.text(await c.rpc("tools/call", {
    name: "figma_search",
    arguments: { query: "hud", mode: "regex", types: ["FRAME"] },
  }));
  const searchReq = seen[searchSeenBefore];
  check("figma_search passes mode, types and query through and returns match metadata",
    searchReq.method === "search" && searchReq.params.mode === "regex" && searchReq.params.types[0] === "FRAME" &&
      search.schema === "search-v1" && search.matches[0].matchedIn[0] === "name",
    JSON.stringify(search).slice(0, 200));

  const dsSeenBefore = seen.length;
  const ds = c.text(await c.rpc("tools/call", {
    name: "figma_design_system",
    arguments: { include: ["styles"] },
  }));
  const dsReq = seen[dsSeenBefore];
  check("figma_design_system inventories styles without writing",
    dsReq.method === "design_system" && dsReq.params.include[0] === "styles" &&
      ds.schema === "design-system-v1" && ds.counts.styles === 1 && ds.styles[0].key === "style-key",
    JSON.stringify(ds).slice(0, 200));

  const dsPath = join(dir, "design-system.json");
  const exported = c.text(await c.rpc("tools/call", {
    name: "figma_design_system",
    arguments: { action: "export", path: dsPath, include: ["styles"] },
  }));
  const saved = JSON.parse(fs.readFileSync(dsPath, "utf8"));
  check("figma_design_system export writes a re-readable snapshot with a hash",
    exported.action === "export" && exported.bytes > 0 && /^[a-f0-9]{64}$/.test(exported.sha256) &&
      saved.schema === "design-system-v1" && saved.styles[0].name === "brand/primary",
    JSON.stringify(exported).slice(0, 200));

  const dsDiff = c.text(await c.rpc("tools/call", {
    name: "figma_design_system",
    arguments: { action: "diff", path: dsPath, include: ["styles"] },
  }));
  check("figma_design_system diff compares by stable key and reports no drift",
    dsDiff.action === "diff" && dsDiff.counts.added === 0 && dsDiff.counts.removed === 0 &&
      dsDiff.counts.changed === 0 && dsDiff.counts.unchanged === 1,
    JSON.stringify(dsDiff).slice(0, 200));

  const tokenPath = join(os.tmpdir(), "figma-local-bridge-tokens-e2e.json");
  try { fs.unlinkSync(tokenPath); } catch {}
  const tokenExport = c.text(await c.rpc("tools/call", {
    name: "figma_tokens",
    arguments: { action: "export", path: tokenPath },
  }));
  check("figma_tokens exports a figma-tokens/v1 document to disk",
    tokenExport.action === "export" && tokenExport.schema === "figma-tokens/v1" &&
      tokenExport.counts.variables === 1 && tokenExport.sha256.length === 64 &&
      fs.existsSync(tokenPath) && JSON.parse(fs.readFileSync(tokenPath, "utf8")).schema === "figma-tokens/v1",
    JSON.stringify(tokenExport).slice(0, 200));

  const tokenSeenBefore = seen.length;
  const tokenDry = c.text(await c.rpc("tools/call", {
    name: "figma_tokens",
    arguments: { action: "import", path: tokenPath, dryRun: true },
  }));
  const tokenReq = seen[tokenSeenBefore];
  check("figma_tokens dry run sends the parsed document and returns a planId plus fingerprint",
    tokenReq.method === "tokens" && tokenReq.params.action === "import" && tokenReq.params.dryRun === true &&
      tokenDry.status === "dry_run" && tokenDry.fingerprint === "token-fp" &&
      typeof tokenDry.planId === "string" && tokenDry.planId.length === 20 && tokenDry.sourceSha256.length === 64,
    JSON.stringify(tokenDry).slice(0, 240));

  const tokenApplied = c.text(await c.rpc("tools/call", {
    name: "figma_tokens",
    arguments: {
      action: "import", path: tokenPath, dryRun: false,
      planId: tokenDry.planId, expectedFingerprint: tokenDry.fingerprint,
    },
  }));
  check("figma_tokens applies with the dry-run planId and fingerprint",
    tokenApplied.status === "applied" && tokenApplied.appliedPlanId === tokenDry.planId &&
      tokenApplied.verification.ok === true,
    JSON.stringify(tokenApplied).slice(0, 200));

  const tokenMismatchSeen = seen.length;
  fs.appendFileSync(tokenPath, "\n");
  const tokenMismatch = await c.rpc("tools/call", {
    name: "figma_tokens",
    arguments: {
      action: "import", path: tokenPath, dryRun: false,
      planId: tokenDry.planId, expectedFingerprint: tokenDry.fingerprint,
    },
  });
  const tokenMismatchMsg = String(tokenMismatch.error?.message ?? tokenMismatch.result?.content?.[0]?.text ?? JSON.stringify(tokenMismatch));
  check("figma_tokens refuses a file that changed since the dry run before sending",
    /PLAN_MISMATCH/.test(tokenMismatchMsg) && seen.length === tokenMismatchSeen,
    tokenMismatchMsg.slice(0, 180));

  const tokenNoPlan = await c.rpc("tools/call", {
    name: "figma_tokens",
    arguments: { action: "import", path: tokenPath, dryRun: false, expectedFingerprint: "token-fp" },
  });
  const tokenNoPlanMsg = String(tokenNoPlan.error?.message ?? tokenNoPlan.result?.content?.[0]?.text ?? JSON.stringify(tokenNoPlan));
  check("figma_tokens apply requires the dry-run planId", /needs planId/.test(tokenNoPlanMsg), tokenNoPlanMsg.slice(0, 140));

  const tokenPrune = await c.rpc("tools/call", {
    name: "figma_tokens",
    arguments: {
      action: "import", path: tokenPath, dryRun: false, prune: true,
      planId: tokenDry.planId, expectedFingerprint: tokenDry.fingerprint,
    },
  });
  const tokenPruneMsg = String(tokenPrune.error?.message ?? tokenPrune.result?.content?.[0]?.text ?? JSON.stringify(tokenPrune));
  check("figma_tokens prune needs explicit destructive approval",
    /allowDestructive:true/.test(tokenPruneMsg), tokenPruneMsg.slice(0, 160));
  try { fs.unlinkSync(tokenPath); } catch {}

  const specSeenBefore = seen.length;
  const spec = c.text(await c.rpc("tools/call", {
    name: "figma_export_build_spec",
    arguments: { nodeId: "1:2", maxNodes: 25, svgFallback: false },
  }));
  const specReq = seen[specSeenBefore];
  check("figma_export_build_spec sends the root, cap and SVG fallback switch, and returns a build spec",
    specReq.method === "export_spec" && specReq.params.nodeId === "1:2" && specReq.params.maxNodes === 25 &&
      specReq.params.svgFallback === false &&
      spec.schema === "build-spec-export/v1" && spec.spec.key === "card" && spec.counts.nodes === 1,
    JSON.stringify(spec).slice(0, 200));

  // figma_motion_*: Motion is a plan/apply split too, but the plan fingerprint
  // is computed by the plugin from the node's live Motion state (the server
  // cannot see animationStyles or keyframes). The edge still defaults to a dry
  // run and refuses an apply without write access.
  const motionStyles = c.text(await c.rpc("tools/call", { name: "figma_motion_styles", arguments: {} }));
  check("figma_motion_styles returns Figma and custom styles",
    motionStyles.counts.figma === 1 && motionStyles.counts.custom === 1 && motionStyles.customStyles[0].id === "C:anim",
    JSON.stringify(motionStyles).slice(0, 160));

  const motionInspect = c.text(await c.rpc("tools/call", { name: "figma_motion_inspect", arguments: { nodeId: "1:2" } }));
  check("figma_motion_inspect returns applied styles, manual tracks and timelines",
    motionInspect.animationStyles[0].id === "A:1" && motionInspect.manualKeyframeTracks.OPACITY.keyframes[0].timelinePosition === 0 &&
      motionInspect.timelines[0].id === "TL:1",
    JSON.stringify(motionInspect).slice(0, 180));

  const motionSeenBefore = seen.length;
  const motionDry = c.text(await c.rpc("tools/call", {
    name: "figma_motion_apply_style",
    arguments: { nodeId: "1:2", styleId: "S:anim", duration: 0.6 },
  }));
  const motionDryReq = seen[motionSeenBefore];
  check("figma_motion_apply_style defaults to a dry run and sends no planId",
    motionDry.status === "dry_run" && motionDryReq.method === "motion_apply_style" &&
      motionDryReq.params.dryRun === true && motionDryReq.params.planId === undefined,
    JSON.stringify({ status: motionDry.status, params: motionDryReq.params }).slice(0, 220));

  const motionApplied = c.text(await c.rpc("tools/call", {
    name: "figma_motion_apply_style",
    arguments: { nodeId: "1:2", styleId: "S:anim", duration: 0.6, dryRun: false, planId: "motion-plan-test" },
  }));
  check("figma_motion_apply_style applies with the planId from the dry run",
    motionApplied.status === "applied" && motionApplied.mutated === true && motionApplied.planId === "motion-plan-test",
    JSON.stringify(motionApplied).slice(0, 180));

  const keyframeSeenBefore = seen.length;
  const keyframeDry = c.text(await c.rpc("tools/call", {
    name: "figma_motion_set_keyframes",
    arguments: {
      nodeId: "1:2",
      field: { type: "PROPERTY", name: "OPACITY" },
      track: {
        baseValue: { type: "FLOAT", value: 1 },
        keyframes: [
          { timelinePosition: 0, value: { type: "FLOAT", value: 0 } },
          { timelinePosition: 0.6, value: { type: "FLOAT", value: 1 }, easing: { type: "EASE_OUT" } },
        ],
      },
    },
  }));
  const keyframeReq = seen[keyframeSeenBefore];
  check("figma_motion_set_keyframes keeps the field, track and dry-run default intact",
    keyframeDry.status === "dry_run" && keyframeReq.params.field.name === "OPACITY" &&
      keyframeReq.params.track.keyframes.length === 2 && keyframeReq.params.track.baseValue.value === 1 &&
      keyframeReq.params.dryRun === true,
    JSON.stringify(keyframeReq.params).slice(0, 260));

  const durationDry = c.text(await c.rpc("tools/call", {
    name: "figma_motion_set_duration",
    arguments: { nodeId: "1:2", timelineId: "TL:1", duration: 2.5 },
  }));
  check("figma_motion_set_duration plans a timeline duration without writing",
    durationDry.status === "dry_run" && durationDry.plan.op === "motion_set_duration",
    JSON.stringify(durationDry).slice(0, 180));

  // figma_ops / figma_cancel: half the answer is the plugin's queue, half is what
  // THIS session is still waiting for. Both halves have to be in the reply, and
  // the cancel has to pass the plugin's refusal through instead of pretending.
  const opsReqBefore = seen.length;
  const ops = c.text(await c.rpc("tools/call", { name: "figma_ops", arguments: {} }));
  check("figma_ops merges the plugin's queue with this session's own calls",
    ops.plugin.running[0].opId === "op-run" && ops.plugin.queued[0].state === "queued" &&
    ops.plugin.recent[0].rev === 6 && Array.isArray(ops.thisClient.inFlight) && Array.isArray(ops.thisClient.abandoned) &&
    ops.file.key === "FILEKEY",
    JSON.stringify(ops).slice(0, 200));
  const opsReq = seen[opsReqBefore];
  check("figma_ops passes opId and recent through to the plugin", opsReq.method === "ops" && opsReq.params.recent === 10 && opsReq.params.opId === undefined);

  const opsOne = c.text(await c.rpc("tools/call", { name: "figma_ops", arguments: { opId: "op-done", recent: 3 } }));
  check("figma_ops reports a finished op's recorded answer — the thing a caller that timed out never saw",
    opsOne.opId === "op-done" && opsOne.record.ok === true && opsOne.record.rev === 6 && opsOne.record.result.nodes === 1,
    JSON.stringify(opsOne).slice(0, 200));
  check("figma_ops hoists the asked-about op instead of burying it", opsOne.op.opId === "op-done");
  check("figma_ops does not invent a lookup note when the op is known", opsOne.lookup === undefined, JSON.stringify(opsOne.lookup));

  const cancelOk = c.text(await c.rpc("tools/call", { name: "figma_cancel", arguments: { opId: "op-wait" } }));
  check("figma_cancel reports the stop, where it was in the queue, and the revision it did not move",
    cancelOk.cancelled === true && cancelOk.opId === "op-wait" && cancelOk.position === 0 && cancelOk.waitedMs === 900 && cancelOk.rev === 7,
    JSON.stringify(cancelOk));

  const cancelBad = await c.rpc("tools/call", { name: "figma_cancel", arguments: { opId: "op-run" } });
  const cancelBadMsg = String(cancelBad.error?.message ?? cancelBad.result?.content?.[0]?.text ?? JSON.stringify(cancelBad));
  check("a running call refuses to be cancelled, and the plugin's reason is what the agent sees",
    /OP_RUNNING/.test(cancelBadMsg) && /running right now/.test(cancelBadMsg), cancelBadMsg.slice(0, 140));

  plugin.close();
  await sleep(250);
  const opsOffline = c.text(await c.rpc("tools/call", { name: "figma_ops", arguments: {} }));
  check("figma_ops still answers with what this session knows when the plugin is gone",
    opsOffline.plugin === null && typeof opsOffline.pluginError === "string" && Array.isArray(opsOffline.thisClient.inFlight),
    JSON.stringify(opsOffline).slice(0, 160));

  c.kill(); daemon.kill();
  try { fs.unlinkSync(INFO); } catch {}
  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  process.exit(fail ? 1 : 0);
} catch (err) {
  process.stdout.write("ERROR: " + err.message + "\n");
  try { fs.unlinkSync(INFO); } catch {}
  daemon.kill();
  process.exit(1);
}
