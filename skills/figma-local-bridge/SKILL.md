# figma-local-bridge — operating guide

The bridge drives the Figma desktop app through a plugin panel. This is the
part that tool schemas cannot say: which file a call lands in, what `rev` and
`replayed` mean, and which failure may be retried. The schemas stay
authoritative about arguments.

## Which file a call lands in

Every tool takes an optional `fileKey`.

- Call `figma_ping` first when you do not know what is open: it reports the
  daemon, the active page and every connected file (`fileKey` + name).
- **One** file connected: `fileKey` may be omitted.
- **Several** files connected: a call without `fileKey` is **refused before it
  is sent**, with the list of candidates. Pass the key — never guess and never
  "pick the most recent". A file that has never been saved gets a session key
  like `unsaved-a1b2c3d4`.
- An unroutable request is answered immediately. A timeout therefore means the
  plugin is connected but slow, not that the wrong file was addressed.

## rev, replayed, and what may be retried

Every answer that came from the plugin carries two facts on its envelope:

- `rev` — the document revision the answer was produced at. It advances on
  failed writes too: a write that failed and rolled back is **not** the state
  you last saw. Identical screenshot bytes with a higher `rev` mean Figma's
  export cache is stale, not that your edit did nothing.
- `replayed` — the answer came from the plugin's `opId` cache, so the method
  did **not** run again. Retries reuse the same `opId` by design: a replay is
  safe, and it is proof that nothing was applied twice.

When an error says a call `may or may not have been applied`, do **not** retry
blindly — re-check with `figma_inspect` and only then decide. When it says the
call was `not sent`, retrying is free.

`FIGMA_BRIDGE_OFFLINE` means the plugin is not running: say so and stop instead
of looping on retries.

`FIGMA_BRIDGE_UNKNOWN_FILE` means the key is not (or no longer) connected — an
unsaved file's key changes when its panel reloads. Do not retry the same key:
the error lists what is connected, take one of those.

## Writes

Mutations are serialized by the bridge, one at a time, because Figma's undo
barrier is global. Prefer the specific tools over raw code:

- `figma_inspect` with `compareWith` answers `EQUIVALENT` / `DIFFERENT` /
  `INCONCLUSIVE` *before* you mutate.
- `figma_replace_repeated_with_component` is transactional and refuses unless
  every target is provably equivalent; run it with `dryRun: true` first.
- `figma_use` is the raw Plugin API. It requires `allowDestructive: true` and a
  `scopeNodeId` naming the only subtree it may touch (unless `allowPageWide`);
  anything created, deleted, reparented or altered outside that scope is rolled
  back, and page-global changes (variables, styles) need `allowGlobalChanges`.
  One call = one undo step. Return the ids you create and keep calls small.
- Work that escapes the call (a fire-and-forget promise) escapes the diff too —
  a timeout does **not** roll back, and the error says so.
- Writes can be off: `FIGMA_BRIDGE_WRITE=0` leaves the mutating tools
  unregistered, and `figma_use` additionally needs `FIGMA_BRIDGE_DESTRUCTIVE=1`.

## The snippet standard library (`flb`)

`use_figma` runs its body with three arguments: `figma`, `console` and `flb`.
`flb` is not a second API — it is the Plugin API with this manifest's traps
named (`plugin/helpers.ts`), so a snippet does not rediscover them by failing:

- the manifest declares `"documentAccess": "dynamic-page"`, where
  `figma.getNodeById` **throws**. `await flb.byId(id)` uses the async form and
  says when an id belongs to another file.
- `flb.find({within, name, match, type})` and `flb.one(...)` search descendants
  (`match` is a RegExp or a pattern string). Neither will answer with a silently
  truncated list; `one` refuses an ambiguous pick and names what else matched.
- `flb.bbox(node, {render: true})` returns **absolute** bounds. `render: true`
  is what is actually drawn — shadows and strokes included — and that is what
  packing sprites has to use, because layout bounds stop at the node's box. A
  node with nothing to draw reports layout bounds and says the render bounds
  were null.
- `flb.clear(node)` removes the children and returns what was removed.
- `flb.flatten(node)` detaches every instance in the subtree, outermost first
  (Figma's own `detachInstance`, so overrides survive) — the flat-sprite step.
  It throws if anything could not be detached instead of reporting a half-flat
  tree.
- `flb.grid(nodes, {parent, cell, columns, gap, origin, fit})` arranges nodes in
  uniform cells — the atlas layout. `origin` and the returned cell boxes are
  ABSOLUTE document coordinates; `cell` defaults to the largest render bounds;
  `fit: true` scales sprites DOWN into their cells (never up). It refuses the
  three cases where placement would quietly not happen: an auto-layout parent
  (unless the children are `layoutPositioning = "ABSOLUTE"`), a node that cannot
  be resized (an INSTANCE — flatten it first; a HUG-sized frame), and nodes
  living in different parents.
- `await flb.text(content, {parent, x, y, size, font, fills})` loads the font
  before writing characters — the step whose absence reads as a font error.
  `fills: "#ffcc00"` becomes a paint through `figma.util.solidPaint`.
- The write helpers refuse a target **outside the declared scope**, and a node
  on **another page** (the scope guard indexes one page), *before* writing: a
  call that would be rolled back at the end fails at the line that caused it.

An atlas, end to end, in one call:

```js
const sheet = flb.one({ name: "Atlas" });
const sprites = flb.find({ type: "INSTANCE", match: "^sym_" }).map((s) => flb.flatten(s).root);
flb.clear(sheet);
const placed = flb.grid(sprites, { parent: sheet, cell: 128, columns: 4, fit: true });
return { cells: placed.cells, resized: placed.resized, notes: placed.notes };
```

## Reading

- `figma_get_metadata` is the cheap way to find ids; `figma_inspect` gives the
  structure and a semantic fingerprint; `figma_get_layout_tree` returns
  absolute geometry for a whole subtree in one call.
- `figma_download_assets` writes bytes to disk and returns paths — prefer it
  over moving base64 through the conversation.
- `figma_get_selection` is answered from memory (the plugin pushes selection
  changes), so it costs no round trip. `figma_set_selection` also pans the
  viewport, which is the only way to move the user's cursor.
- `figma_compare` checks a render against a PNG on disk (a mockup, an earlier
  export, another node written out with `figma_download_assets`) and reports
  **where** it differs, not just whether: differing area, bounding box (in the
  reference's own pixels), largest clusters, plus a heatmap. It is how a rebuild
  is proven to have landed instead of eyeballed — and a size mismatch is a
  finding, while a clean 2×/3×/4× ratio means you passed the wrong `scale`.

## A call that timed out, and the write nobody is waiting for

Writes are chained in the plugin: a write waits behind the write ahead of it.
Its caller does not wait that long — and when the caller gives up, the queued
write still runs. That is the one case where an edit lands after everyone has
stopped watching, so it has its own two tools.

- `figma_ops` answers "what is still going to write?": per file, the call that
  is `running`, the writes `queued` behind it, and what finished `recently` —
  plus, for this session, the calls it is still waiting for and the ones it gave
  up on. A timeout error names its `opId`: pass that to `figma_ops` to get the
  operation's state and the answer recorded for it. That settles a call that
  timed out — "it finished at rev 412 with this result" — instead of leaving
  "may or may not have been applied" standing.
- `figma_cancel` stops a call whose state is `queued`: nothing of it has run, its
  caller is answered at once with OP_CANCELLED, and the revision does not move
  because the document did not. A `running` call is refused with OP_RUNNING —
  Figma runs plugin code to the end and nothing can interrupt it from inside the
  plugin. OP_DONE means it already ran, and the message names the revision.
- Both are read-only and work in a read-only bridge: cancelling only ever
  prevents a write, never causes one.

## Checkpoints — the substitute for an undo stack

Figma's undo barrier is global and one step deep, so "put it back" cannot be a
saved undo step. `figma_checkpoint` is a description plus a rebuild:

- `action: "save"` records a subtree as data (`nodeId`; a page is refused) into
  one JSON file per file key. The reply carries a `summary` and the
  `limitations` a rebuild cannot carry — instance interiors, per-run text
  styling, variable bindings, component identity. Read them before telling
  anyone the subtree will come back exactly.
- `action: "show"` diffs the live subtree against the file field by field and
  reports the semantic fingerprint next to it. That is how "has this drifted
  already?" gets answered before a rebuild is chosen.
- `action: "restore"` replaces the target's children from the checkpoint in ONE
  transaction. It is a **dry run by default** and names what would be deleted
  and created; a real rebuild needs `dryRun: false`, `allowDestructive: true`
  and a bridge started with `FIGMA_BRIDGE_DESTRUCTIVE=1`.
- Afterwards the server dumps the subtree **again** and diffs it against the
  checkpoint: `verification.verified: true` means no field differs. When it is
  false, `verification.diff` names every field with both values and
  `verification.notes` says which differences checkpoint-v1 knows it causes
  (HUG sizing, per-run text). Say so — never call a rebuild "restored" when it
  is not.
- Refused with a reason: a truncated dump (restoring it would delete whatever
  the dump never reached), a `GROUP` / `INSTANCE` / page target, and node types
  checkpoint-v1 cannot rebuild — unless `allowPartial: true`, which rebuilds the
  rest and lists every skipped node.
- Recording is cheap: take a checkpoint before a risky rebuild of a subtree,
  then `show` or `compare` to judge the result, and keep its `id` so a restore
  is one call away.

## The panel

The plugin panel is decoration plus status: the mascot's mood, the status line
and the chips (`page`, selection, MCP sessions, call count) restate the same
facts in different ways. No task should depend on interpreting the mascot.
