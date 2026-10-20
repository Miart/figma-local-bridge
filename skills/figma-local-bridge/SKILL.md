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

## Declarative editing: build, patch, batch

These three tools are the preferred way to change a tree. They resolve every
target and every resource **before** the first write, so a typo cannot leave
half a design applied.

- `figma_build` takes a `buildId` and a full tree. The root gets that id in
  `pluginData`; every node gets a stable key (`parent/slug#index` unless you
  supply one). Re-send the same buildId and it updates in place — never
  duplicates. `prune:true` makes the tree exact by deleting keyed children the
  spec no longer contains; protected nodes are skipped and reported. The tree
  also carries rotation (degrees), per-corner radii, stroke cap/join/miter,
  masks, layout grids, layout inclusion flags, text case/decoration/paragraph
  spacing, text hyperlinks (URL, or NODE by node id), and an exact `LINE`
  length.
- `figma_patch` takes a sparse tree under `rootNodeId`, `buildId` or
  `rootKey`. Children match by key. A missing key is refused unless
  `allowCreate:true`; a key under the wrong parent is refused rather than
  duplicated. `prune:true` deletes omitted keyed children at patched levels.
- `figma_batch_edit` takes up to 200 small ops on many targets in one
  transaction. Targets are `nodeId` or stable `key`. Ops: `set_text`,
  `set_name`/`rename`, `set_fill`, `set_stroke`, `resize`, `move`,
  `set_visible`, `set_opacity`, `set_rotation`, `set_layout`, `set_variant`,
  `set_constraints`, `duplicate`, `reparent`. Every target, font, paint style
  and variant property is resolved first; a failed op rolls the whole batch
  back unless `stopOnError:false`, which reports the exact failure and what
  did apply.

The safe sequence for all three:

1. Call with `dryRun:true` (the default). Read the plan, `planId`,
   `fingerprints` / `fingerprint`, and any warnings.
2. If the plan is right, call again with `dryRun:false`, the returned
   `planId`, and the returned fingerprint(s).
3. The apply refuses a different plan or a target that moved since the dry run
   **before** the plugin writes anything. A failed apply is rolled back and
   says so; never retry a blind write.

A batch cannot target a node created by an earlier `duplicate` in the same
batch — its key does not exist at plan time. Split that into two calls.
`figma_build` / `figma_patch` do not implicitly move a keyed node to another
parent; use `batch` with `reparent` when a move is intended.

To bring a hand-made tree into this language, `figma_export_build_spec`
returns a spec that `figma_build` accepts. It keeps keys that already exist,
derives the same key the build engine would for nodes without one, and turns
style/variable links into `fillStyle`/`strokeStyle`/`textStyle`/`effectStyle`
or `variable`. URL text links travel in the spec; a NODE link is exported with
a file-local warning, and mixed links are named. Read `unsupported` and
`warnings` before building it: an SVG source, a detached instance, an instance
interior, a mixed font or per-range text styling has no exact representation.
`truncated: true` means the spec is incomplete and must not be built as-is.

## Finding things, and checking the result

- `figma_index` returns a compact flat index of a page/subtree: id, stable
  key, name, type, path, depth, size, child count, build root. Use it to learn
  the shape before inspecting one subtree. It stops at `maxNodes` and says so.
- `figma_search` finds nodes by name, stable key or text — substring, regex or
  glob — with `types`, `keyPrefix` and `hasKey` filters. It returns the match
  fields, a text snippet and the path, not the whole tree.
- `figma_audit` is read-only. It reports duplicate keys, unkeyed nodes inside a
  built tree, literal fills/strokes that are neither a paint style nor a
  variable, text without a text style, placeholder copy, detached instances,
  WCAG AA contrast against the effective background, default names, and
  opt-in off-scale spacing/radius. A contrast finding is exact for solid text
  on a solid effective background; gradients/images are reported as unknown,
  not guessed.
- `figma_design_system` snapshots styles, variables (with modes and values) and
  components. `inventory` returns it, `export` writes a JSON file with a
  sha256, and `diff` compares that file to the live file by stable key. It is
  read-only: syncing values back into Figma still goes through the specific
  write tools.

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
  tree. **The node you passed in is dead afterwards**: Figma invalidates a
  detached instance, so even reading its `name` throws `The node with id … does
  not exist`. Carry on with the returned `root` (or `detached[i].frame`) — a
  snippet that kept the old node to report on later dies on the way out.
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

## Exporting for a build or the web: atlas, 9-slice, states, handoff

`figma_export_ui_atlas` takes the sheet you just built and returns ONE PNG plus a
manifest of rects **in that PNG's own pixels**, written next to it
(`.atlas.json`) and re-read from disk before the answer. Nothing is repacked: the
frame's direct children are the sprites, in their document order. What the
manifest refuses to hide:

- `sheet.sizeMatches: false` — Figma produced something other than
  `round(size × scale)`; the rects follow the FILE, and `exportWidth/Height` is
  what they are measured against.
- `overlaps`, `offSheet`, `bleed` — rects that overlap (an engine slicing by rect
  cannot tell whose pixel it is), sprites outside the image, and drawing that
  reaches past its own box (a shadow or a stroke the neighbouring cell cuts off).
- repeated names: keys become `coin#1`, `coin#2`; a child with no bounds at all
  lands in `skipped` with a reason instead of quietly missing.
- `basis: "nodeBox"` — the frame has a stroke, so the image is the frame's own
  box and the rects are measured from the node's top-left. Which box the image is
  is decided by the exported size, not assumed.

So the order is: build the sheet (`flb.grid`), read `verification` and
`warnings`, and only then wire the engine up — the rects in the reply are what
the engine needs; the JSON on disk is what a build pipeline reads.

`figma_export_9slice` returns insets in the file's pixels, the stretchable
middle, and CSS values ready for `border-image` (`borderImageSlice` in image
pixels, `borderImageWidth` in design pixels — the pair a `@2x` image needs).
Insets come from `insets` or from a child layer named exactly `9slice`; insets
that leave no middle are refused with the numbers that caused them.

`figma_export_ui_states` writes one file per state. A `COMPONENT_SET` names them
by its variant property — the only one it declares, or the one passed as
`property`; several properties without `property` is a refusal that lists them,
because `State=hover` and `Size=L` are both plausible names and one would be a
lie. A frame names states by layer name. States with **identical bytes** are
reported: a hover that draws exactly like normal is usually a variant that is not
what its name says, and this is the cheapest place to find that out.

`figma_export_web_handoff` writes the folder a web developer opens:
`preview.png` (1x) plus `preview@Nx.png`, `spec.json` (flat, document order —
every layer's box relative to the frame, text, paints, effects and layout
fields), `tokens.json`/`tokens.css` (solid colours named by their paint styles
when one value has one style, fonts, text classes, spacing) and a `README.md`
that says what the bundle is **not**: production HTML, responsive layout,
image fills as separate files, gradient tokens, embedded fonts, masks and
effects applied by the CSS, paragraph spacing or vertical alignment. A colour
bound to several styles, a gradient, an
image fill or a mixed text layer is never averaged into an invented value: it
is named as missing, or carried as stops/segments. `handoff.json` keeps the
hashes and counts, every file is re-read from disk, and one call owns one
folder — it refuses to reuse it for another node. Above 2,500 nodes, 24 MP per
preview or 8 MiB per PNG it refuses rather than truncating; lower the scale or
pick a smaller frame. The 24 MP preflight runs before the rasteriser: a preview
that would take minutes is named, with the largest scale that fits
(`pass scale: 1 (6.4 MP)`), instead of burning the bridge's timeout. A font that the document uses but the machine cannot load is listed in
the README; it is not assumed present. That check is time-boxed (2 s per
style, 12 s in total), because loading a font this machine does not have is a
network round trip that can take minutes: a style that does not answer in time
is listed separately as **unchecked** — whether the machine can render it is
unknown, and the bundle says so instead of implying either way. The reply
divides the time by phase — `walkMs` reading the tree, `checkMs` the check
above, `exportMs` rasterising — so a call that took minutes names the phase
that took them; a cold font service lands in `exportMs` even when the check
already called the style unchecked.

All four are reads of the document (usable with `FIGMA_BRIDGE_WRITE=0`), and
their files go to `outDir`, a temp directory by default.

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
- When the process that timed out is gone — or the plugin was reloaded, taking
  its opId cache with it — `figma_journal` is the part of the trail that
  survives: a local append-only file with every call this bridge sent, its
  `send`/`ok`/`failed`/`timeout`/`retry`/`dropped`/`late` lines, the revision
  and the target. `unsettled: true` shows only the calls that did not end
  cleanly. It never records code, text or images — method names, target ids,
  revisions and outcomes only — so `figma_use`'s `description` is the one place
  a human note enters it. Edits a human makes in Figma are not in the file, and
  neither is a call refused before sending: nothing was sent, nothing changed.

## Checkpoints — the substitute for an undo stack

Figma's undo barrier is global and one step deep, so "put it back" cannot be a
saved undo step. `figma_checkpoint` is a description plus a rebuild:

- `action: "save"` records a subtree as data (`nodeId`; a page is refused) into
  one JSON file per file key. The reply carries a `summary` and the
  `limitations` a rebuild cannot carry — instance interiors, per-run text
  styling and mixed hyperlinks, component identity. Read them before telling
  anyone the subtree will come back exactly.
- `action: "show"` diffs the live subtree against the file field by field and
  reports the semantic fingerprint next to it. That is how "has this drifted
  already?" gets answered before a rebuild is chosen.
- `action: "restore"` replaces the target's children from the checkpoint in ONE
  transaction. It is a **dry run by default** and names what would be deleted
  and created; a real rebuild needs `dryRun: false`, `allowDestructive: true`
  and a bridge started with `FIGMA_BRIDGE_DESTRUCTIVE=1`.
- Style ids, node-level variable bindings and explicit variable modes travel in
  `meta`. Restore re-links a style, variable, collection or mode when it still
  exists and reports every one that does not: `stylesMissing`, `bindingsMissing`
  and `modesMissing`. The recorded value is written either way, so a missing link
  leaves a correct-looking but unlinked node instead of a missing colour or size.
- Paint-level variable bindings travel with the paint. They survive when their
  variable exists; when it does not, the paint returns by value and
  `bindingsDropped` names it. Per-range text bindings are not rebuilt (the text
  runs are not either); `bindingsMissing` names them instead of flattening them.
- A whole-text hyperlink is saved and restored by value. A NODE link stays
  file-local; mixed per-run links are named as a loss, not flattened to one.
- Afterwards the server dumps the subtree **again** and diffs it against the
  checkpoint: `verification.verified: true` means no field differs. When it is
  false, `verification.diff` names every field with both values and
  `verification.notes` says which differences checkpoint-v1 knows it causes
  (HUG sizing, per-run text, mixed hyperlinks). Say so — never call a rebuild
  "restored" when it is not.
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
