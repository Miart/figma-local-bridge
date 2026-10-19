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
    "figma_compare", "figma_checkpoint", "figma_ops", "figma_cancel"];
  const missing = expected.filter((n) => !tools.includes(n));
  check("all parity tools are registered", missing.length === 0, "missing: " + missing.join(","));

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
      case "get_screenshot": return ok({ nodeId: "1:2", name: "Card", format: env.params.format, scale: env.params.scale, bytes: 70, width: 1, height: 1, base64: PNG_1x1 });
      case "export_nodes": return ok({ files: [{ nodeId: "1:2", name: "Card/Hero", format: "PNG", bytes: 70, base64: PNG_1x1 }, { nodeId: "9:9", error: "not found or not exportable" }] });
      case "use_figma":
        if (env.params.code.includes("throw")) return fail("boom (rolled back)\nconsole output before the error:\nhi");
        // `replayed` is what the plugin stamps on a retry served from its opId
        // cache; rev is stamped by every reply (plugin/rev.ts).
        return ok({ ok: true, result: { id: "5:5" }, logs: ["hello"], changed: true, ms: { code: 12, index: 345, total: 360 }, nodes: { before: 3, after: 4 } },
          env.params.code.includes("replayed") ? { replayed: true, rev: 8 } : undefined);
      case "import_images": return ok({ created: env.params.files.map((f) => ({ name: f.name, bytes: Buffer.from(f.base64, "base64").length })) });
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
