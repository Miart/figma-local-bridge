// End-to-end test for the OPTIONAL read-only Figma REST adapter.
//
// It deliberately runs with no daemon and no plugin: the cloud tools are
// independent of the local bridge. A local mock API proves the auth header,
// query construction and error mapping without sending a credential anywhere.
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = "e2e-cloud-secret";
const ENTRY = "server/dist/index.js";
let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    pass++;
    process.stdout.write(`PASS  ${name}\n`);
  } else {
    fail++;
    process.stdout.write(`FAIL  ${name}${detail ? "  — " + detail : ""}\n`);
  }
};

const json = (res, value, status = 200, headers = {}) => {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
};

const calls = [];
const mock = http.createServer((req, res) => {
  calls.push({ url: req.url, headers: req.headers });
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/v1/me") {
    return json(res, { id: "user-1", handle: "tester", email: "tester@example.com" });
  }
  if (url.pathname === "/v1/files/abc123") {
    return json(res, { name: "Cloud File", document: { id: "0:0", name: "Document" } });
  }
  if (url.pathname === "/v1/files/abc123/nodes") {
    return json(res, { nodes: { "1:2": { document: { id: "1:2", name: "Card" } } } });
  }
  if (url.pathname === "/v1/images/abc123") {
    return json(res, { images: { "1:2": "https://cdn.example/card.png" } });
  }
  if (url.pathname === "/v1/files/forbidden") {
    return json(res, { status: 403, err: "Forbidden" }, 403);
  }
  return json(res, { status: 404, err: "Not found" }, 404);
});

await new Promise((resolve, reject) => {
  mock.once("error", reject);
  mock.listen(0, "127.0.0.1", resolve);
});
const { port } = mock.address();
const apiBase = `http://127.0.0.1:${port}`;
const scratch = mkdtempSync(join(tmpdir(), "figma-bridge-cloud-"));
const proc = spawn("node", [ENTRY], {
  env: {
    ...process.env,
    FIGMA_BRIDGE_INFO_FILE: join(scratch, "no-daemon.json"),
    FIGMA_BRIDGE_JOURNAL: "0",
    FIGMA_CLOUD: "1",
    FIGMA_CLOUD_TOKEN: TOKEN,
    FIGMA_CLOUD_API_BASE: apiBase,
    FIGMA_CLOUD_INSECURE: "1",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
proc.stderr.on("data", (d) => { stderr += d.toString(); });
let buf = "";
const pending = new Map();
let rpcId = 0;
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++rpcId;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`rpc timeout: ${method}`));
  }, 8_000);
  pending.set(id, (msg) => {
    clearTimeout(timer);
    resolve(msg);
  });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});

const text = (res) => String(res?.result?.content?.[0]?.text ?? "");
const parse = (res) => {
  try { return JSON.parse(text(res)); } catch { return null; }
};

try {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "cloud-e2e", version: "0" },
  });
  check("server starts with cloud enabled and no daemon", !!init.result,
    init.result ? `${init.result.serverInfo.name} ${init.result.serverInfo.version}` : JSON.stringify(init.error));
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await rpc("tools/list", {});
  const names = (list.result?.tools || []).map((t) => t.name);
  for (const wanted of ["figma_cloud_ping", "figma_cloud_get_file", "figma_cloud_get_nodes", "figma_cloud_get_image"]) {
    check(`${wanted} is registered only with the cloud opt-in`, names.includes(wanted));
  }
  check("cloud opt-in leaves the local surface in place", names.includes("figma_ping") && names.includes("figma_inspect"));

  const ping = parse(await rpc("tools/call", { name: "figma_ping", arguments: {} }));
  check("figma_ping reports the cloud adapter without a local daemon",
    ping?.connected === false && ping?.capabilities?.cloud?.available === true &&
      ping.capabilities.cloud.configured === true && ping.capabilities.cloud.mode === "read-only",
    JSON.stringify(ping?.capabilities?.cloud || null).slice(0, 160));
  check("figma_ping names the four cloud tools",
    ["figma_cloud_ping", "figma_cloud_get_file", "figma_cloud_get_nodes", "figma_cloud_get_image"]
      .every((n) => ping?.capabilities?.cloud?.tools?.includes(n)),
    JSON.stringify(ping?.capabilities?.cloud?.tools || []).slice(0, 160));

  const cloudPing = parse(await rpc("tools/call", { name: "figma_cloud_ping", arguments: {} }));
  check("figma_cloud_ping validates the token against /v1/me",
    cloudPing?.ok === true && cloudPing?.user?.handle === "tester" && cloudPing?.auth === "pat",
    JSON.stringify(cloudPing).slice(0, 160));

  const file = parse(await rpc("tools/call", {
    name: "figma_cloud_get_file",
    arguments: { fileKey: "abc123", nodeIds: ["1:2"], depth: 2 },
  }));
  check("figma_cloud_get_file returns REST JSON", file?.ok === true && file?.data?.name === "Cloud File",
    JSON.stringify(file).slice(0, 160));
  const fileCall = calls.find((c) => c.url.startsWith("/v1/files/abc123?"));
  const fileUrl = fileCall ? new URL(fileCall.url, apiBase) : null;
  check("cloud file request carries ids/depth and the PAT header",
    fileUrl?.searchParams.get("ids") === "1:2" && fileUrl?.searchParams.get("depth") === "2" &&
      fileCall?.headers["x-figma-token"] === TOKEN,
    fileCall ? fileCall.url : "no request");

  const nodes = parse(await rpc("tools/call", {
    name: "figma_cloud_get_nodes",
    arguments: { fileKey: "abc123", nodeIds: ["1:2"] },
  }));
  check("figma_cloud_get_nodes reads a node subtree", nodes?.ok === true && nodes?.data?.nodes?.["1:2"],
    JSON.stringify(nodes).slice(0, 160));

  const image = parse(await rpc("tools/call", {
    name: "figma_cloud_get_image",
    arguments: { fileKey: "abc123", nodeIds: ["1:2"], format: "png", scale: 2 },
  }));
  check("figma_cloud_get_image returns a temporary URL", image?.ok === true &&
    image?.data?.images?.["1:2"] === "https://cdn.example/card.png" &&
    /temporary/.test(image?.note || ""), JSON.stringify(image).slice(0, 160));
  const imageCall = calls.find((c) => c.url.startsWith("/v1/images/abc123?"));
  const imageUrl = imageCall ? new URL(imageCall.url, apiBase) : null;
  check("cloud image request carries format and scale",
    imageUrl?.searchParams.get("format") === "png" && imageUrl?.searchParams.get("scale") === "2",
    imageCall ? imageCall.url : "no request");

  const forbiddenRes = await rpc("tools/call", {
    name: "figma_cloud_get_file",
    arguments: { fileKey: "forbidden" },
  });
  const forbidden = parse(forbiddenRes);
  check("cloud failures keep the HTTP meaning", forbiddenRes?.result?.isError === true &&
    forbidden?.error?.code === "CLOUD_FORBIDDEN" && forbidden?.error?.status === 403,
    JSON.stringify(forbidden).slice(0, 160));
  check("the cloud token never appears in a tool reply or stderr",
    !text(forbiddenRes).includes(TOKEN) && !stderr.includes(TOKEN) && !JSON.stringify(ping).includes(TOKEN),
    "token leaked");
} catch (err) {
  fail++;
  process.stdout.write(`FAIL  cloud e2e threw  — ${err?.stack || err}\n`);
} finally {
  proc.kill();
  await new Promise((resolve) => setTimeout(resolve, 100));
  mock.closeAllConnections?.();
  await new Promise((resolve) => mock.close(resolve));
  rmSync(scratch, { recursive: true, force: true });
}

process.stdout.write(`\ncloud.e2e: ${pass} passed, ${fail} failed\n`);
if (fail) process.exitCode = 1;
