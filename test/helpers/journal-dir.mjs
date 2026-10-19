// Any test that drives a FigmaClient must never append to the journal of the
// person running it. Import this module before the first call: it points the
// journal at a per-process temp directory and removes it on exit.
//
// The e2e suites spawn the server themselves and set FIGMA_BRIDGE_JOURNAL=0 or
// their own directory; this covers unit tests and any client built in-process.

import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { ENV_DIR, ENV_OFF } from "../../server/dist/journal.js";

const dir = fs.mkdtempSync(join(os.tmpdir(), "figma-journal-test-"));
process.env[ENV_DIR] = dir;
delete process.env[ENV_OFF];

process.on("exit", () => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
});
