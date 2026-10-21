import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  CloudClient,
  CloudError,
  readCloudConfig,
} from "../server/dist/cloud.js";
import { capabilitiesReport } from "../server/dist/capabilities.js";

async function start(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ url: req.url, headers: req.headers });
    handler(req, res, calls.length);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    calls,
    async stop() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const json = (res, value, status = 200, headers = {}) => {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
};

test("cloud config is explicit, credential-safe and validates the transport", () => {
  const off = readCloudConfig({});
  assert.equal(off.enabled, false);
  assert.equal(off.configured, false);
  assert.equal(off.apiBase, "https://api.figma.com");
  assert.match(off.reason, /FIGMA_CLOUD=1/);

  const tokenOnly = readCloudConfig({ FIGMA_CLOUD_TOKEN: "pat-token" });
  assert.equal(tokenOnly.enabled, false);
  assert.equal(tokenOnly.configured, true);
  assert.match(tokenOnly.reason, /Cloud adapter is off/);

  const pat = readCloudConfig({ FIGMA_CLOUD: "1", FIGMA_CLOUD_TOKEN: "pat-token" });
  assert.equal(pat.enabled, true);
  assert.equal(pat.tokenKind, "pat");
  assert.equal(pat.token, "pat-token");
  assert.equal(pat.allowLocalHttp, false);

  const oauth = readCloudConfig({ FIGMA_CLOUD: "1", FIGMA_CLOUD_OAUTH_TOKEN: "oauth-token" });
  assert.equal(oauth.enabled, true);
  assert.equal(oauth.tokenKind, "oauth");

  const both = readCloudConfig({
    FIGMA_CLOUD: "1",
    FIGMA_CLOUD_TOKEN: "pat-token",
    FIGMA_CLOUD_OAUTH_TOKEN: "oauth-token",
  });
  assert.equal(both.enabled, false);
  assert.match(both.reason, /only one/);

  const disabled = readCloudConfig({ FIGMA_CLOUD: "0", FIGMA_CLOUD_TOKEN: "pat-token" });
  assert.equal(disabled.enabled, false);
  assert.match(disabled.reason, /FIGMA_CLOUD=0/);

  const insecure = readCloudConfig({
    FIGMA_CLOUD: "1",
    FIGMA_CLOUD_TOKEN: "pat-token",
    FIGMA_CLOUD_API_BASE: "http://127.0.0.1:9876",
  });
  assert.equal(insecure.enabled, false);
  assert.match(insecure.reason, /must use https/);

  const local = readCloudConfig({
    FIGMA_CLOUD: "1",
    FIGMA_CLOUD_TOKEN: "pat-token",
    FIGMA_CLOUD_API_BASE: "http://127.0.0.1:9876/",
    FIGMA_CLOUD_INSECURE: "1",
  });
  assert.equal(local.enabled, true);
  assert.equal(local.apiBase, "http://127.0.0.1:9876");
  assert.equal(local.allowLocalHttp, true);

  const badTimeout = readCloudConfig({
    FIGMA_CLOUD: "1",
    FIGMA_CLOUD_TOKEN: "pat-token",
    FIGMA_CLOUD_TIMEOUT_MS: "10",
  });
  assert.equal(badTimeout.enabled, false);
  assert.match(badTimeout.reason, /TIMEOUT_MS/);

  const report = capabilitiesReport({ read: true, write: true, destructive: false }, pat);
  assert.equal(report.cloud.available, true);
  assert.equal(report.cloud.mode, "read-only");
  assert.equal(report.cloud.tokenType, "pat");
  assert.ok(report.cloud.tools.includes("figma_cloud_get_file"));
  assert.ok(report.cloud.reads.includes("images"));
  assert.ok(report.cloud.features.includes("create_new_file"));
  assert.equal(JSON.stringify(report).includes("pat-token"), false);
});

test("cloud client sends the PAT header and exact GET parameters", async () => {
  const mock = await start((req, res) => {
    json(res, { name: "Cloud File" }, 200, { "x-figma-request-id": "req-1" });
  });
  try {
    const config = readCloudConfig({
      FIGMA_CLOUD: "1",
      FIGMA_CLOUD_TOKEN: "super-secret",
      FIGMA_CLOUD_API_BASE: mock.base,
      FIGMA_CLOUD_INSECURE: "1",
    });
    const client = new CloudClient(config);
    const result = await client.getFile({
      fileKey: "abc123",
      nodeIds: ["1:2", "3:4"],
      depth: 2,
      geometry: true,
      pluginData: "shared",
      maxBytes: 10_000,
    });
    assert.deepEqual(result.data, { name: "Cloud File" });
    assert.equal(result.requestId, "req-1");
    assert.ok(result.bytes > 0);

    const call = mock.calls[0];
    const url = new URL(call.url, mock.base);
    assert.equal(url.pathname, "/v1/files/abc123");
    assert.equal(url.searchParams.get("ids"), "1:2,3:4");
    assert.equal(url.searchParams.get("depth"), "2");
    assert.equal(url.searchParams.get("geometry"), "paths");
    assert.equal(url.searchParams.get("plugin_data"), "shared");
    assert.equal(call.headers["x-figma-token"], "super-secret");
    assert.match(call.headers["user-agent"], /^figma-local-bridge\//);
  } finally {
    await mock.stop();
  }
});

test("cloud client uses OAuth Bearer auth and keeps token out of errors", async () => {
  const mock = await start((req, res) => {
    if (req.url.startsWith("/v1/me")) json(res, { id: "u1", handle: "tester" });
    else json(res, { status: 401, err: "Invalid token super-secret" }, 401);
  });
  try {
    const config = readCloudConfig({
      FIGMA_CLOUD: "1",
      FIGMA_CLOUD_OAUTH_TOKEN: "super-secret",
      FIGMA_CLOUD_API_BASE: mock.base,
      FIGMA_CLOUD_INSECURE: "1",
    });
    const client = new CloudClient(config);
    const me = await client.me();
    assert.equal(me.data.handle, "tester");
    assert.equal(mock.calls[0].headers.authorization, "Bearer super-secret");

    await assert.rejects(
      () => client.getFile({ fileKey: "nope", maxBytes: 10_000 }),
      (err) => {
        assert.ok(err instanceof CloudError);
        assert.equal(err.code, "CLOUD_UNAUTHORIZED");
        assert.equal(err.status, 401);
        const serialised = JSON.stringify(err.toJSON());
        assert.equal(serialised.includes("super-secret"), false);
        assert.match(serialised, /\[redacted\]/);
        return true;
      },
    );
  } finally {
    await mock.stop();
  }
});

test("cloud client maps rate limits, oversized bodies, timeouts and non-JSON replies", async () => {
  const mock = await start((req, res) => {
    if (req.url.includes("limited")) {
      json(res, { status: 429, err: "Slow down" }, 429, { "retry-after": "7" });
    } else if (req.url.includes("slow")) {
      setTimeout(() => {
        if (res.destroyed) return;
        try { json(res, { ok: true }); } catch { /* client already timed out */ }
      }, 500);
    } else if (req.url.includes("chunked")) {
      // No Content-Length: the cap must still stop reading at maxBytes.
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"payload":"');
      for (let i = 0; i < 12; i++) res.write("x".repeat(512));
      res.end('"}');
    } else if (req.url.includes("large")) {
      json(res, { payload: "x".repeat(10_000) });
    } else {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("not json");
    }
  });
  try {
    const config = readCloudConfig({
      FIGMA_CLOUD: "1",
      FIGMA_CLOUD_TOKEN: "secret",
      FIGMA_CLOUD_API_BASE: mock.base,
      FIGMA_CLOUD_INSECURE: "1",
    });
    const client = new CloudClient(config);

    await assert.rejects(
      () => client.getFile({ fileKey: "limited", maxBytes: 100_000 }),
      (err) => err instanceof CloudError && err.code === "CLOUD_RATE_LIMITED" && err.retryAfterSeconds === 7,
    );
    await assert.rejects(
      () => client.getFile({ fileKey: "large", maxBytes: 1_000 }),
      (err) => err instanceof CloudError && err.code === "CLOUD_RESPONSE_TOO_LARGE" && err.maxBytes === 1_000,
    );
    await assert.rejects(
      () => client.getFile({ fileKey: "chunked", maxBytes: 2_000 }),
      (err) => err instanceof CloudError && err.code === "CLOUD_RESPONSE_TOO_LARGE" && err.maxBytes === 2_000,
    );
    await assert.rejects(
      () => client.getFile({ fileKey: "plain", maxBytes: 100_000 }),
      (err) => err instanceof CloudError && err.code === "CLOUD_BAD_RESPONSE",
    );
    const impatient = new CloudClient({ ...config, timeoutMs: 100 });
    await assert.rejects(
      () => impatient.getFile({ fileKey: "slow", maxBytes: 100_000 }),
      (err) => err instanceof CloudError && err.code === "CLOUD_TIMEOUT",
    );
  } finally {
    await mock.stop();
  }
});


test("cloud image download is token-free, https-only and capped while streaming", async () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const mock = await start((req, res) => {
    if (req.url === "/asset.png") {
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": png.length,
        "x-amz-request-id": "img-1",
      });
      return res.end(png);
    }
    if (req.url === "/redirect.png") {
      res.writeHead(302, { location: "/asset.png" });
      return res.end();
    }
    if (req.url === "/missing.png") {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found");
    }
    if (req.url === "/big.png") {
      const body = Buffer.alloc(2_000, 1);
      res.writeHead(200, { "content-type": "image/png", "content-length": body.length });
      return res.end(body);
    }
    if (req.url === "/chunked.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.write(Buffer.alloc(700, 1));
      res.write(Buffer.alloc(700, 1));
      return res.end();
    }
    if (req.url === "/slow.png") {
      setTimeout(() => {
        if (res.destroyed) return;
        try { res.writeHead(200, { "content-type": "image/png" }); res.end(png); } catch { /* gone */ }
      }, 500);
      return;
    }
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("unexpected");
  });
  try {
    const config = readCloudConfig({
      FIGMA_CLOUD: "1",
      FIGMA_CLOUD_TOKEN: "super-secret",
      FIGMA_CLOUD_API_BASE: mock.base,
      FIGMA_CLOUD_INSECURE: "1",
    });
    const client = new CloudClient(config);
    const downloaded = await client.downloadImage(`${mock.base}/asset.png`, 1_000);
    assert.equal(downloaded.bytes, png.length);
    assert.deepEqual(downloaded.data, png);
    assert.equal(downloaded.contentType, "image/png");
    assert.equal(downloaded.requestId, "img-1");
    const assetCall = mock.calls.find((c) => c.url === "/asset.png");
    assert.ok(assetCall);
    assert.equal(assetCall.headers["x-figma-token"], undefined);
    assert.equal(assetCall.headers.authorization, undefined);
    assert.match(assetCall.headers["user-agent"], /^figma-local-bridge\//);

    await assert.rejects(
      () => client.downloadImage("http://example.com/asset.png", 1_000),
      (err) => err instanceof CloudError && err.code === "CLOUD_DOWNLOAD_BLOCKED",
    );
    await assert.rejects(
      () => client.downloadImage(`${mock.base}/redirect.png`, 1_000),
      (err) => err instanceof CloudError && err.code === "CLOUD_DOWNLOAD_BLOCKED",
    );
    await assert.rejects(
      () => client.downloadImage(`${mock.base}/missing.png`, 1_000),
      (err) => err instanceof CloudError && err.code === "CLOUD_NOT_FOUND" && err.status === 404,
    );
    await assert.rejects(
      () => client.downloadImage(`${mock.base}/big.png`, 1_000),
      (err) => err instanceof CloudError && err.code === "CLOUD_RESPONSE_TOO_LARGE" && err.maxBytes === 1_000,
    );
    await assert.rejects(
      () => client.downloadImage(`${mock.base}/chunked.png`, 1_000),
      (err) => err instanceof CloudError && err.code === "CLOUD_RESPONSE_TOO_LARGE" && err.maxBytes === 1_000,
    );
    const impatient = new CloudClient({ ...config, timeoutMs: 100 });
    await assert.rejects(
      () => impatient.downloadImage(`${mock.base}/slow.png`, 1_000),
      (err) => err instanceof CloudError && err.code === "CLOUD_TIMEOUT",
    );
  } finally {
    await mock.stop();
  }
});
