// Daemon descriptors live in a shared directory, so a previous run leaves one
// behind. Every e2e "wait until the daemon is up" loop polls that file, and a
// stale descriptor answers it at once — with the pid and port of a process
// that is gone. The test then connects before the daemon it just spawned has
// bound its port, and fails for a reason that has nothing to do with the code
// under test. Call this before spawning, unless the descriptor lives in a
// fresh temp directory (journal.e2e does that).
import fs from "node:fs";

export function freshDescriptor(path) {
  try {
    fs.rmSync(path, { force: true });
  } catch {}
}
