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

## Reading

- `figma_get_metadata` is the cheap way to find ids; `figma_inspect` gives the
  structure and a semantic fingerprint; `figma_get_layout_tree` returns
  absolute geometry for a whole subtree in one call.
- `figma_download_assets` writes bytes to disk and returns paths — prefer it
  over moving base64 through the conversation.
- `figma_get_selection` is answered from memory (the plugin pushes selection
  changes), so it costs no round trip. `figma_set_selection` also pans the
  viewport, which is the only way to move the user's cursor.

## The panel

The plugin panel is decoration plus status: the mascot's mood, the status line
and the chips (`page`, selection, MCP sessions, call count) restate the same
facts in different ways. No task should depend on interpreting the mascot.
