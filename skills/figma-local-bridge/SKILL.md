---
name: figma-local-bridge
description: Drive the Figma Desktop file that is open locally through the figma-local-bridge MCP server. Use when a task mentions figma_ping, figma_inspect, figma_build, figma_patch, figma_batch_edit, figma_use, figma_index, figma_search, figma_motion_styles, Figma Motion, Figma Desktop automation, or a local Figma MCP bridge. Covers fileKey routing, guarded dry-run edits, dynamic-page API traps, flb helpers, review/checkpoint verification and the optional read-only cloud adapter.
---

# Figma Local Bridge

This is the short playbook. The complete operating guide is the MCP resource
`figma-local://guide/skill` and the file `skills/figma-local-bridge/GUIDE.md`;
read it before a complex rebuild, component swap, token import or handoff.

## First call

Call `figma_ping` when you do not know what is open. It returns:

- the connected files (`fileKey` + name) and the active page;
- `capabilities.local.mode` — `read-only`, `write` or `write+destructive`;
- `capabilities.cloud` — the optional REST adapter, normally off.

With **one** file connected, `fileKey` may be omitted. With **several**, a call
without it is refused before it is sent, listing the candidates. Pass the exact
key; never guess and never pick the most recent. An unsaved file keeps a session
key such as `unsaved-a1b2c3d4`.

## Read before write

- `figma_inspect` returns structure plus a semantic fingerprint; `compareWith`
  answers whether a subtree is equivalent before you mutate it.
  `includeFingerprint:false` skips the whole-subtree snapshot when only the
  structure is needed; a comparison still computes it.
- `figma_index` and `figma_search` are cheap page/subtree indexes. They do not
  return `component` metadata for instances; use `figma_inspect` or `flb.main`
  for one node.
- `figma_get_metadata` finds ids; `figma_get_layout_tree` gives absolute
  geometry for a whole subtree.
- `figma_review` saves a local visual + audit + structure baseline, then compares
  after an edit. Read `status`, `regressions` and `new`/`resolved`; a neutral
  `changed` is not an improvement.
- `figma_checkpoint` is the restore path (save/show/restore), not `review`.

## Writes

Mutating families default to `dryRun: true` and return a `planId` plus
fingerprints. Apply with the returned plan and fingerprint, never with a
hand-edited plan. One apply is one undo transaction.

- Prefer `figma_build` / `figma_patch` for a keyed tree.
- Prefer `figma_batch_edit` for many small edits on many targets.
- Use `figma_variant_set` for a variant matrix, not hand-renamed components.
- Use `figma_swap_component` with its dry run; read every named loss before
  applying.
- Use dedicated tools before `figma_use`.
- Motion is Figma Motion (Beta), not a local animation layer. Use the
  `figma_motion_*` tools only when `figma_ping` reports `motion.available`; a
  missing API is `MOTION_UNAVAILABLE`, never a workaround. Read with
  `figma_motion_inspect`, then apply with the dry-run `planId`. No Motion
  movie export exists in this bridge.

### `figma_use` (raw Plugin API)

It is destructive and requires all of:

- `allowDestructive: true`;
- a `scopeNodeId` naming the only subtree it may touch, or `allowPageWide:
  true` when the call really is page-wide;
- `allowGlobalChanges: true` only when variables or styles change.

Anything outside the scope is rolled back. One call is one undo step. Do not
switch pages inside the snippet; the scope guard watches the current page and
refuses the call. A timeout is **not** rolled back: the snippet is still running
and may still write. Use `figma_ops` with the error's `opId` to settle it;
`figma_cancel` only stops a call that is still queued.

## Dynamic-page traps

This manifest declares `"documentAccess": "dynamic-page"`. Code from older
Figma examples fails here:

- **Never** use `figma.getNodeById(...)`; it throws. Use `await flb.byId(id)`.
- **Never** read `node.mainComponent`; it throws, and Figma logs the error even
  if the snippet catches it. Use `await node.getMainComponentAsync()` or
  `await flb.main(node)`. A detached instance returns `null`.
- `figma.currentPage.findOne(...)` and `findAll(...)` need the page loaded. Use
  `flb.find({within, type, name, match})` / `flb.one(...)`; they refuse a page
  that was never loaded and refuse to return a silently truncated list.
- Writing to a TEXT node needs `figma.loadFontAsync(font)` first. Use
  `await flb.text(...)`, which loads the font before writing characters.
- `node.x` / `node.y` are parent-relative; `absoluteBoundingBox` and
  `flb.bbox(node, {render:true})` are absolute. Convert deliberately when
  packing sprites.
- An INSTANCE cannot be resized directly. Detach it first with `flb.flatten`;
  the node you passed in is dead afterwards, so carry on with the returned
  `root` / `frame`.
- `flb.clear(node)`, `flb.grid(...)` and `flb.text(...)` refuse an out-of-scope
  or other-page target before writing.

## Revisions, retries and files

Replies carry `rev` (the document revision; it moves on failed writes too) and
`replayed` (the answer came from the opId cache, so nothing ran twice; a replay
is safe). After "may or may not have been applied", re-check with
`figma_inspect` before retrying. After "not sent", retrying is free.

Writes are serialized. A call can wait behind another write longer than its
caller waits; `figma_ops` reports running/queued and the recorded answer.
`figma_journal` is the durable local trail across process restarts; it stores
method, target, revision and outcome, never snippets, text or images.

## Exports and local files

- `figma_export_ui_atlas` → one PNG plus a `.atlas.json` whose rects are in the
  PNG's own pixels; read `overlaps`, `offSheet`, `bleed` and `skipped`.
- `figma_export_9slice` → file-pixel insets and `border-image` values.
- `figma_export_ui_states` → one file per state; identical bytes are reported.
- `figma_export_web_handoff` → previews, `spec.json`, tokens and a README that
  names what the bundle cannot carry.
- `figma_tokens` handles local variables only; import is dry-run first, then
  apply with the returned plan and live fingerprint. Prune is opt-in and
  destructive.
- Exports and reviews write local files only; the Figma document is unchanged.

## Cloud boundary

The cloud adapter is off unless the process has `FIGMA_CLOUD=1` and exactly one
of `FIGMA_CLOUD_TOKEN` / `FIGMA_CLOUD_OAUTH_TOKEN`. It is read-only with respect
to Figma: file/node/image reads and local rendered-image downloads. It is not a
proxy for Figma-hosted AI, file creation, generative plugins, shaders, Weave or
the full Code Connect API. If a requested capability is missing, say so; do not
imitate it locally and call the result the same thing.
