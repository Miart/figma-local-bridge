/**
 * The agent-facing guide.
 *
 * The tool schemas say what the arguments are; they cannot say which file a
 * call lands in, what `rev` and `replayed` mean, or which failure may be
 * retried. That doctrine lives in `skills/figma-local-bridge/SKILL.md` at the
 * repository root — a file people can read and edit — and is served twice on
 * purpose:
 *
 *  - as `instructions` on the MCP handshake, which clients show the model at
 *    connect time;
 *  - as a resource (`figma-local://guide/skill`), which a client can request
 *    later, and which is the only way to reach clients that ignore the
 *    handshake instructions.
 *
 * Reading it from disk at startup means there is exactly one copy of the text.
 * If the file is missing (a `server/dist` copied without the repository), a
 * short inline fallback keeps the server useful instead of failing to start.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** server/dist (or server/src when run through a TS loader). */
const HERE = dirname(fileURLToPath(import.meta.url));

export const GUIDE_URI = "figma-local://guide/skill";
export const GUIDE_MIME = "text/markdown";

const FALLBACK = `# figma-local-bridge

Call figma_ping first when you do not know what is open. Every tool takes an
optional fileKey: with one file connected it may be omitted, with several a
call without it is refused before it is sent — pass the key, never guess.

Replies carry rev (the document revision; it advances on failed writes too) and
replayed (the answer came from the opId cache, so the method did not run again;
a replay is safe). After "may or may not have been applied", re-check with
figma_inspect before retrying; after "not sent", retrying is free.

Prefer figma_build/patch for a keyed tree and figma_batch_edit for many small
edits: all three default to dryRun:true, return a planId and fingerprints, and
refuse an apply whose plan or targets changed. figma_audit, figma_index,
figma_search, figma_design_system, figma_tokens and figma_export_build_spec are
read-only unless figma_tokens is applying an import. figma_tokens covers local
variables only: export, diff and a dry-run-first import with a planId, a live
fingerprint and one undo transaction; prune is opt-in and destructive.
The last one turns a live subtree back into a figma_build spec; read its
unsupported/warnings, and never build a result marked truncated.

Writes are serialized, so a call can wait behind another write for longer than
its caller waits. When one times out, figma_ops (opId from the error) says
whether it is still queued, running, or already finished and what it returned;
figma_cancel stops a queued write before it starts — a running one cannot be
interrupted. Neither tool writes, so both work when the bridge is read-only.

The same trail outlives the process: figma_journal reads a local append-only
file — every call sent, with timeout/dropped/late lines for the ones that did
not end cleanly — and needs neither the daemon nor the plugin.

Prefer figma_inspect (compareWith) and
figma_replace_repeated_with_component (dryRun first) over figma_use, which is
raw Plugin API behind allowDestructive + scopeNodeId, rolls back anything
outside the scope, and needs allowGlobalChanges for variables and styles.
Snippets get a third argument, flb (plugin/helpers.ts): byId/find/one, bbox,
clear, flatten, grid and text, which handle this manifest's traps —
getNodeById throws in dynamic-page mode, writing characters needs a loaded
font, and node.x is parent-relative while bbox() is absolute. Its write
helpers refuse an out-of-scope or other-page target before writing.

Exports for a build or the web: figma_export_ui_atlas (one PNG plus rects in
that file's pixels, with overlaps/off-sheet/bleed/duplicate names named, and
the file re-read from disk), figma_export_9slice (insets in file pixels plus
border-image values), figma_export_ui_states (one file per state, refusing to
guess which variant property names them, reporting byte-identical states) and
figma_export_web_handoff (previews, spec.json, tokens.json/css and a README that
names the limits: production HTML, image fills as files, gradient tokens,
embedded fonts, masks/effects not applied by the CSS, paragraph spacing/vertical
alignment; missing fonts are listed, not assumed, and a font whose check
ran past the time budget is called unchecked; the reply's timings name the
phase that took the time (walkMs walking, checkMs the font check, exportMs
rasterising); a bundle over 2,500 nodes or a preview over 24 MP is refused
with the numbers, before the export). All only read the document,
so they work with writes off.
`;

function readGuide(): string {
  try {
    return readFileSync(join(HERE, "../../skills/figma-local-bridge/SKILL.md"), "utf8");
  } catch {
    return FALLBACK;
  }
}

export const GUIDE = readGuide();

export function registerGuide(server: McpServer): void {
  server.registerResource(
    "guide",
    GUIDE_URI,
    {
      title: "figma-local-bridge — operating guide",
      description:
        "How to drive the bridge: fileKey rules, rev/replayed, what may be retried, figma_use scope and rollback, write gating.",
      mimeType: GUIDE_MIME,
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: GUIDE_MIME, text: GUIDE }],
    }),
  );
}
