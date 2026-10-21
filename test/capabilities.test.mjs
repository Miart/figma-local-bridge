import test from "node:test";
import assert from "node:assert/strict";
import { CLOUD_FEATURES, capabilitiesReport } from "../server/dist/capabilities.js";
import { SERVER_VERSION } from "../server/dist/version.js";

test("capability report names the mode and refuses to promise cloud features", () => {
  const readOnly = capabilitiesReport({ read: true, write: false, destructive: false });
  assert.equal(readOnly.server.version, SERVER_VERSION);
  assert.equal(readOnly.local.mode, "read-only");
  assert.equal(readOnly.local.write, false);
  assert.equal(readOnly.cloud.available, false);
  assert.match(readOnly.cloud.reason, /not proxied or simulated/);
  assert.ok(readOnly.cloud.features.includes("create_new_file"));
  assert.ok(readOnly.cloud.features.includes("weave_run_model"));

  const guarded = capabilitiesReport({ read: true, write: true, destructive: false });
  assert.equal(guarded.local.mode, "write");
  const full = capabilitiesReport({ read: true, write: true, destructive: true });
  assert.equal(full.local.mode, "write+destructive");
  assert.deepEqual(full.cloud.features, [...CLOUD_FEATURES]);
});
