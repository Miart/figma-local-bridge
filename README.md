# Figma Local Bridge

**Unofficial local MCP bridge for Figma Desktop.** Drives the real plugin API from any MCP client (OpenCode, Claude Code, Cursor, …) over a single local daemon — read and edit the open file, take screenshots, export assets, inspect variables, search the design system. **No Dev/Full seat required.**

> Not affiliated with Figma, Inc.

## Why this exists

Figma's official MCP server (Dev Mode, `127.0.0.1:3845`) requires a Dev/Full seat on Professional+. This project ships its own Figma plugin instead: the manifest uses `editorType: ["figma", "figjam"]` rather than `devid`, so it runs in an ordinary editor window. Everything stays local — a WebSocket on `127.0.0.1`, no cloud, no API keys, no telemetry.

## Architecture

```
Figma Desktop ──WebSocket──▶ daemon (port 8787, one per machine)
                                  ▲
                                  │ WebSocket client
            ┌─────────────────────┼─────────────────────┐
      MCP process           MCP process           MCP process
      (workspace A)         (workspace B)         (workspace C)
            ▲
            │ stdio
      OpenCode / Claude / Cursor
```

The daemon exists for three concrete reasons:

- the Figma plugin pairs with **one socket per open file**, and Figma's manifest CSP can only allowlist **fixed** origins, so the port cannot be ephemeral;
- MCP clients spawn one server process **per workspace** — on a fixed port, they would collide;
- one token, one plugin import: the second Figma window costs nothing extra.

**One daemon = one port = one token = one plugin import — for up to 16 open files at once.**

## Repo layout

| Path | What |
|---|---|
| `server/src/` | stdio MCP server, daemon (WebSocket hub), link state, tool implementations |
| `plugin/` | Figma plugin: `code.ts` bundled to `code.js` by esbuild, UI panel, dispatcher, scope guard |
| `skills/figma-local-bridge/SKILL.md` | the agent-facing operating guide, served both as MCP `instructions` and as a resource |
| `scripts/mascot.py` | the ASCII octopus the panel ships: the art lives on the panel's own 21x10 grid, and its JS block is emitted from here, never hand-edited |
| `scripts/mcp-smoke.mjs` | `npm run smoke`: build smoke test with no Figma and no daemon |
| `test/` | unit tests (`node --test`) and e2e tests against a real daemon / WebSocket / MCP client |
| `spike/` | the first prototype, kept for history |

## Quick start

Requirements: **Node.js 20+** (developed on v25) and the **Figma Desktop app**. Developed on macOS; the Node side is cross-platform.

```sh
git clone git@github.com:Miart/figma-local-bridge.git
cd figma-local-bridge
npm install
npm run build
npm run daemon        # keep it running; log: /tmp/figma-bridge-daemon.log
```

1. **Import the plugin** (once): in Figma → *Plugins → Development → Import plugin from manifest…* → `<repo>/plugin/manifest.json`. (`npm run build` must have run first — `plugin/code.js` is generated and not committed.)
2. **Run the plugin**: *Plugins → Development → Figma Local Bridge*.
3. The panel asks for the daemon token — copy it from `~/.local/share/opencode/figma-bridge-daemon.json` and paste it **once**. It is kept in `figma.clientStorage`, and the plugin reconnects by itself on every launch. The port is fixed by `plugin/manifest.json` (`networkAccess.devAllowedDomains`) — the panel cannot change it.
4. **Point your MCP client** at `server/dist/index.js` (stdio). Example (opencode):

```jsonc
"figmaBridge": {
  "type": "local",
  "command": ["node", "/path/to/figma-local-bridge/server/dist/index.js"],
  "environment": {
    "FIGMA_BRIDGE_PORT": "8787",
    "FIGMA_BRIDGE_WRITE": "1",
    "FIGMA_BRIDGE_DESTRUCTIVE": "0"
  }
}
```

Without the plugin running, the MCP server still starts and every tool answers `FIGMA_BRIDGE_OFFLINE` — fast, with a precise reason, instead of hanging for 30–115 seconds.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `FIGMA_BRIDGE_PORT` | from `plugin/manifest.json` (`8787`) | Daemon port |
| `FIGMA_BRIDGE_HOSTS` | `127.0.0.1,::1` | Interfaces to listen on |
| `FIGMA_BRIDGE_INFO_FILE` | `~/.local/share/opencode/figma-bridge-daemon.json` | State file: pid, port, `clientKey`, plugin token |
| `FIGMA_BRIDGE_TOKEN_FILE` | `~/.local/share/opencode/figma-bridge-daemon.secret` | Persistent plugin token (`0600`) |
| `FIGMA_BRIDGE_WRITE` | `1` | `0` — read-only: mutation tools are not even registered |
| `FIGMA_BRIDGE_DESTRUCTIVE` | `0` | `1` — allow `figma_use` (raw Plugin API snippets) and a real `figma_checkpoint` restore |
| `FIGMA_BRIDGE_CHECKPOINTS_DIR` | `~/.local/share/opencode/figma-bridge-checkpoints` | Where `figma_checkpoint` keeps its files, one directory per `fileKey` |
| `FIGMA_BRIDGE_JOURNAL_DIR` | `~/.local/share/opencode/figma-bridge-journal` | Where the journal keeps `ops.jsonl` (plus two rotated segments) |
| `FIGMA_BRIDGE_JOURNAL` | `1` | `0` — stop recording new journal lines; what is already on disk stays readable |

Don't run a second bridge instance: the port is fixed, so the second daemon exits with `EADDRINUSE` (see Troubleshooting).

### Several files at once

Run the plugin in each Figma file you want to drive — every panel connects to the same daemon, which holds one socket per file, keyed by `fileKey` (a file that was never saved gets a session key like `unsaved-a1b2c3d4`, which it keeps for as long as the document is open, panel reloads included). Up to **16 files**; a panel beyond that is refused with `4413` and says so.

- `figma_ping` lists the connected files (`fileKey` + name) — it is the tool to call when you do not know which files are open.
- Every tool takes an optional `fileKey`. With **one** file connected it may be omitted; with **several**, a call without `fileKey` is **refused before anything is sent**, listing the candidates. Guessing here would edit the wrong file.
- The daemon routes by file and answers an unroutable request with an error immediately — never a timeout.
- One file disconnecting fails only its own in-flight calls; the others keep working. Re-opening the plugin in the same file replaces its old socket (old panel gets `4409`).

### What the plugin panel shows

| Row | Meaning |
|---|---|
| mascot | decorative only: an ASCII octopus whose mood follows the link — asleep while offline, shuffling while connecting, blinking when idle, winking when you click the canvas, upset after a failed call. It reacts (hop / shake) to what happened, and answers a tap on itself with a hop and a beaming face; the status line below always carries the same facts in words. `hide pet` / `show pet` in the footer switches it off for good (stored per user in `figma.clientStorage`) |
| window height | the panel measures what it rendered and asks Figma to fit the window to it, so hiding the mascot (~120px) or showing the error line (~20px) never leaves dead space behind. If Figma drops the resize, the panel re-asks on its own until the window matches the content |
| status | `connected` / `offline — retrying in Ns` / `token rejected` / `another panel is serving this file — press reconnect to take over` / `all 16 file slots are taken — retrying in Ns` |
| chips: `page`, selection | what is open and selected right now — pushed by the plugin, so it stays live even without a connection; hover a chip for the full list |
| chip: `mcp` | how many MCP sessions are attached (0 = no client is bound) |
| chip: calls | how many calls went through; turns red after an error |
| error line | the last call error (full text in the tooltip) |

## Tools

17 tools mirroring Figma's official server, plus 14 local ones — 31 in total.

Every tool also accepts an optional `fileKey` to choose among several open Figma files; with one file it can be omitted, with several a call that omits it is refused and lists the connected files (`figma_ping` shows the same list).

The server also ships an **operating guide** — `fileKey` routing, what `rev` and `replayed` mean, which failure may be retried, what `figma_use` rolls back. It travels as `instructions` on the MCP handshake *and* as the resource `figma-local://guide/skill`, so a client that ignores handshake instructions can still fetch it. Both are read at startup from `skills/figma-local-bridge/SKILL.md`, which is the file to edit (a `server/dist` copied without the repo falls back to a short inline version).

**Parity with the official Figma MCP server:**

| Tool | What it does |
|---|---|
| `figma_whoami` | User, open file, pages, viewport |
| `figma_get_metadata` | Sparse XML skeleton of a node — cheap, use it to find ids |
| `figma_get_design_context` | Full design description of a node for implementing it in code |
| `figma_get_screenshot` | PNG / JPG / SVG of a node (the caption carries `rev`) |
| `figma_get_variable_defs` | Variables used in a subtree |
| `figma_get_libraries` | Variable collections available from libraries |
| `figma_search_design_system` | Search components, styles, variables |
| `figma_get_figjam` | FigJam board: stickies, shapes, connectors, sections |
| `figma_get_code_connect_map` / `figma_add_code_connect_map` | Local Code Connect mappings |
| `figma_download_assets` / `figma_upload_assets` | Export / import assets |
| `figma_set_page` | Switch the active page |
| `figma_set_selection` | Select nodes **and pan the viewport to them** — the only way to move the user's cursor |
| `figma_get_font_inventory` | Fonts actually used by the file, with per-text-node counts |
| `figma_list_file_components_for_code_connect` | Inventory of every component in the file |
| `figma_use` | Arbitrary Plugin API snippet under scope protection; the answer carries `rev`, `replayed`, `ms` and `nodes`. A third argument, `flb`, is a snippet standard library for this manifest's traps — `byId` (`getNodeById` throws in dynamic-page mode), `find`/`one`, `bbox` (absolute layout or render bounds), `clear`, `flatten` (detach every instance), `grid` (uniform atlas cells at absolute coordinates), `text` (loads the font first) — and its write helpers refuse an out-of-scope or other-page target *before* writing |

**Local additions:**

| Tool | What it does |
|---|---|
| `figma_ping` | Health check: verifies the plugin is paired, reports the active page, and lists the connected files (`fileKey` + name) |
| `figma_get_selection` | Current selection, answered from memory — the plugin pushes selection changes, so this costs no round trip |
| `figma_get_layout_tree` | Absolute geometry of a whole subtree in one call: per node `absoluteTransform` (2×3 matrix), absolute layout and render bounds, clip flag. Document-absolute space — the one a PNG export uses — so a rebuild (atlas, sprite sheet) can be checked against a capture without one `get_node` per layer. Geometry and screenshot stay separate calls (`atomicWithScreenshot: false`): snapshot, then capture, then compare `rev` — and `figma_compare` for the pixels themselves |
| `figma_inspect` | Compact structure + semantic fingerprint; `compareWith` returns `EQUIVALENT` / `DIFFERENT` / `INCONCLUSIVE` *before* you mutate |
| `figma_compare` | Diff a live render against a PNG on disk — a mockup, an earlier export, or another node written out with `figma_download_assets`. The diff runs in the MCP server, so the document is never touched: it answers with the differing area, its bounding box **in the reference's own pixels** (top-left origin — the box can be cropped straight out of that PNG) and the largest clusters, and writes a heatmap PNG next to the reference. `tolerance` absorbs anti-aliasing; a size mismatch is reported rather than hidden, and a clean 2×/3×/4× ratio names the `scale` you meant |
| `figma_replace_repeated_with_component` | Replaces repeated identical nodes with instances of one master component, in a single transactional call. Refuses unless every target is provably equivalent; try `dryRun: true` first |
| `figma_checkpoint` | Undo, without an undo stack: `save` describes a subtree as data (one JSON file per file, under `~/.local/share/opencode/figma-bridge-checkpoints/<fileKey>/`), `show` diffs the live subtree against it field by field, `restore` replaces the target's children from it in **one** transaction — dry run by default — and then dumps the subtree again to *verify*: `verified: true` only when that second diff is empty. Refuses a truncated dump, a `GROUP`/`INSTANCE`/page target, and unsupported node types unless `allowPartial`; a save lists what a rebuild cannot carry (instance interiors, per-run text styling, bindings) so the losses travel with the data |
| `figma_ops` | What the plugin is doing per file: the call that is `running`, the writes `queued` behind it, and what finished `recently` — plus, for this session, the calls it is still waiting for and the ones it gave up on. With `opId` (a timeout error names it) it adds the answer recorded for that operation: that is how a call that timed out is settled without re-reading the document. Read-only, and answers even when the plugin is gone (with the local half and the reason) |
| `figma_cancel` | Stop an operation whose state is `queued` — a write whose caller has already given up, still waiting behind another write. Its caller is answered at once with `OP_CANCELLED` and `rev` does not move, because nothing of it ran; a retry of the same `opId` replays the cancellation instead of starting the call. `OP_RUNNING` (Figma runs plugin code to completion — nothing can interrupt it), `OP_DONE` (it already ran; the message names the revision) and `OP_UNKNOWN` are refusals, not failures. Read-only: cancelling only ever prevents a write |
| `figma_journal` | The durable half of `figma_ops`: the tail of a local append-only JSONL file — every call the bridge sent to a plugin, with method, target, revision and outcome, and the ones that did not end cleanly (`timeout`, `dropped`, `late`). Survives bridge and plugin restarts, which is exactly where `figma_ops` stops helping; filters by `fileKey` and `method`, and `unsettled: true` returns only the may-or-may-not trail. Read-only and entirely local; snippets, text and images are never recorded |
| `figma_export_ui_atlas` | A sprite sheet for a game build: **one** PNG plus a JSON manifest whose rects are in *that file's* pixels. The sheet frame's direct children are the sprites — nothing is repacked, the layout stays the designer's — and the manifest names what would make the sheet unsliceable: overlapping rects, sprites outside the image, drawing that bleeds out of its own cell, repeated names (keyed `coin#1`, `coin#2`), coordinates that had to be rounded, and a PNG whose size is not `round(sheet × scale)` (the rects follow the file, not the prediction). The file is re-read from disk before the answer, so the manifest cannot describe an image nobody wrote |
| `figma_export_9slice` | One sprite with its 9-slice insets: a PNG plus a descriptor — insets in the file's pixels, the stretchable middle, and CSS `border-image` values with slices in image pixels and widths in design pixels (which is what a `@2x` image needs). Pass `insets`, or leave a child layer named exactly `9slice` where the middle should stretch. Insets that leave no middle are refused with the numbers that caused it |
| `figma_export_ui_states` | The states of a button/component as one file per state, plus a manifest naming them. A `COMPONENT_SET` names its variants by property — the only one it declares, or the one you pass — and a frame names them by layer name; a set with several properties is refused until you say which one names the states. States whose **bytes are identical** are called out (a hover that draws exactly like normal is usually a variant that is not what its name says), and every file is re-read from disk: its size checked against the node, its hash recorded |
| `figma_export_web_handoff` | One folder for a web developer: `preview.png` (1x) plus `preview@Nx.png`, `spec.json` (flat, document order — every layer's box relative to the frame, text, paints, effects and layout fields), `tokens.json` and `tokens.css` (solid colours named by their paint styles when one value has one style, fonts, text classes, spacing), a `README.md` stating what the bundle is **not**, and `handoff.json` with hashes, counts and warnings. A colour bound to several styles, a gradient, an image fill or a mixed text layer is never averaged into an invented value: it is named as missing, or carried as segments/stops. One call writes one folder, refuses to reuse it for another node, and re-reads every file from disk. Read-only — it works with writes off; above 2,500 nodes or 8 MiB per preview it refuses instead of truncating |

Not available through a plugin (cloud-only in the official server): `create_new_file`, `generate_figma_design`, `generate_diagram`, `export_video`, shaders, Weave, cloud Code Connect sync.

## Safety model

The bridge edits real design files with an agent at the wheel, so most of the engineering went into making failure modes *visible* instead of silent:

- **Idempotent retries.** `opId` is minted once per logical call and reused by every attempt (`server/src/figma.ts`). The plugin keeps a bounded `opId → result` cache and, on a repeat, replays the recorded answer (`replayed: true`) without touching the document. A repeat arriving while the first attempt is still running **joins it** instead of running the snippet twice.
- **A key names one call.** The cache stores a fingerprint of the method and arguments it answered (`plugin/dispatch.ts`), so a *different* call sent under a used `opId` is refused (`OPID_REUSED`) instead of being handed the first call's answer — the one path that could report a write that never happened. Key order does not change a call, so a retry re-encoded by another JSON writer still replays.
- **Serialized mutations.** Figma's undo barrier is global — two mutations in flight roll each other back. Mutating methods are chained one at a time (`plugin/dispatch.ts`); reads stay parallel. `rev` bumps on success *and* failure.
- **Honest disconnects.** An error distinguishes `disconnected before <method> was sent` (safe to retry) from `may or may not have been applied` (retried under the same `opId`, so a replay cannot apply code twice).
- **An abandoned write does not land unseen.** Writes are chained, so a call can wait behind another write for longer than its caller is willing to wait — and when the timeout fires, the queued write would have run anyway, at a revision nobody was watching. Instead the call stays visible: `figma_ops` shows it `queued` (nothing of it has run), `running`, or finished *after* the caller gave up with the answer it returned; `figma_cancel` stops a `queued` one, answering its caller immediately with `OP_CANCELLED` and leaving `rev` untouched because the document did not move. A `running` call is refused loudly (`OP_RUNNING`) — Figma runs plugin code to completion, so any tool claiming to interrupt it would be lying.
- **The operations trail outlives the process.** `figma_ops` settles a timeout only while the client remembers the call and the plugin keeps its opId cache; a restart, a panel reload or a crash erases both. So every call the bridge *sends* is appended to a local JSONL journal — `send`, `ok`, `failed`, `timeout`, `retry`, `dropped`, `late` — with method, target, revision and outcome, and none of the payload (no snippets, text or images). `figma_journal` reads its tail and can show only the calls that did not end cleanly; a `send` with no terminal line names a call that was in flight when its process died, which is exactly the "may or may not have been applied" nothing else can answer after the fact.
- **Fast-fail offline.** A call waits one 2-second grace period (`LINK_GRACE_MS`) for a reconnecting plugin, then fails with a precise reason. A request that was never sent is not retried at all.
- **No guessing between files.** With several files connected, a call without `fileKey` is refused client-side *before* the request is sent — both the client (`server/src/figma.ts`) and the daemon (`server/src/link.ts`) check independently, and both name the connected files. A wrong file here is a wrong edit, so neither side ever "picks the most recent".
- **Scope guard + fingerprint diff.** `figma_use` runs against a scoped, fingerprint-checked node set and is rolled back if the document drifts outside the scope. Switching pages inside a call is refused (`currentpagechange`): one call per page, or `figma_set_page` first. The snippet's own helpers (`flb`) make the same judgement before a write: a target outside `scopeNodeId`, or on another page — which the one-page diff could not see — is refused at the line that caused it, not by the rollback at the end.
- **Timeouts don't roll back.** A `Promise.race` stops waiting, but the snippet keeps running and may still write — the message says exactly that instead of pretending "(rolled back)".
- **Stale screenshots are detectable.** Figma caches exports. `rev` travels in the caption, so identical bytes with a higher `rev` means the render is stale, not that the edit did nothing.
- **Exported artefacts describe the file that exists.** An atlas manifest that is one pixel off is worse than no manifest: the engine slices the neighbouring sprite and nothing in the build says why. So the plugin reads the PNG's IHDR and computes every rect in the file's own pixels (reporting a mismatch instead of assuming `round(size × scale)`), the server re-reads what landed on disk and compares it against the manifest, and the numbers that had to be rounded are counted and named. A frame with a stroke — where the image is the node's own box and not the bounding box the rects would otherwise be measured from — is detected from the exported size and reported rather than silently shifting every sprite. A web handoff follows the same rule one level up: its README and `handoff.json` name the things the bundle cannot carry — gradients as tokens, image fills as files, fonts as embedded bytes, masks and effects as applied CSS — and a font that is in the file but absent from the machine is listed instead of assumed.
- **Gated writes.** `FIGMA_BRIDGE_WRITE=0` makes the bridge read-only; `figma_use` additionally needs `FIGMA_BRIDGE_DESTRUCTIVE=1` and an explicit scope.
- **Checkpoints are measured, not promised.** `figma_checkpoint` has no undo stack to lean on (Figma's is global and one step deep), so it rebuilds a subtree from a recorded description — and says what a rebuild cannot reproduce: instance interiors, per-run text styling, variable bindings, component identity. A real rebuild needs `dryRun: false` *and* `allowDestructive: true` *and* a bridge started with destructive writes; after the write the server dumps the subtree **again** and diffs it against the checkpoint, so `verified: true` means "no field differs", and a difference nobody predicted is reported with its path instead of being called a success.

## Development

```sh
npm run build      # plugin (esbuild) + server (tsc)
npm run typecheck  # server + plugin (with @figma/plugin-typings)
npm run smoke      # does server/dist start, speak MCP and fail offline? ~3s, no Figma
npm test           # rebuilds artifacts, then unit + e2e with --test-concurrency=1
```

`npm run smoke` is the fast question — it spawns the built server against a scratch info file (so it takes the offline branch even when a real bridge is running), checks the handshake, the guide, the tool surface and the offline path, and prints one line per check. `npm test` is the slow one: the whole chain against a simulated plugin.

`npm test` rebuilds `server/dist` and `plugin/*.mjs` first because the tests import the built modules — a test running against a stale artifact passes on code Figma will never execute. The suites run serially (`--test-concurrency=1`): e2e tests spin up real daemons on real ports and share one token file, and parallel runs make them flaky by construction.

Current suites: **377 unit checks** — 155 `node:test` cases plus 222 harness checks (`commands` 29, `fingerprint` 42, `scope` 32, `use-figma.gate` 10, `checkpoint` 57, `checkpoint-store` 52) — and **173 e2e checks** (`daemon` 12, `link-state` 8, `mcp` 16, `multifile` 23, `tools` 30, `checkpoint` 32, `exports` 25, `journal` 27; the per-file summaries add up to 165 because `link-state` prints its checks without one).

## Troubleshooting

| Symptom | Cause |
|---|---|
| `FIGMA_BRIDGE_OFFLINE` | The plugin is not running in Figma, or the daemon is down |
| `FIGMA_BRIDGE_UNKNOWN_FILE` | The `fileKey` is not one of the connected files — an unsaved file's key changes when its panel reloads. The error lists the keys that exist: call `figma_ping` and retry with one of them instead of the same key |
| `FIGMA_BRIDGE_FILE_KEY_REQUIRED` | Several files are connected and no `fileKey` was given — the error lists them; pass one |
| `figma_ping` → `connected: false` | The plugin is not paired |
| The daemon won't start | Port 8787 is busy — `lsof -nP -iTCP:8787 -sTCP:LISTEN` |
| `4409 replaced by a newer socket` | Another panel took this file's slot (plugin reloaded, or the file is open in two windows). Press *reconnect* in the panel you want to keep |
| `4413 too many files (max 16)` | The daemon already serves 16 files — close a panel |
| `4403 bad key` | The daemon restarted with a new `clientKey` — restart your MCP client |
| `4401 bad token` | The token in the plugin doesn't match `figma-bridge-daemon.secret` |
| `figma_checkpoint restore` refused | Three separate gates, each with its own message: a real rebuild needs `dryRun: false`, `allowDestructive: true`, and a bridge started with `FIGMA_BRIDGE_DESTRUCTIVE=1`. Without them the default dry run still reports exactly what would be deleted and created |
| `figma_checkpoint restore` rebuilds but `verified: false` | The second dump differs from the checkpoint: read `verification.diff` (each entry has a path and both values) and `verification.notes`, which name the differences checkpoint-v1 knows it causes (HUG sizing, per-run text) |
| A write timed out — did it ever run? | The timeout error names its `opId`: `figma_ops {opId}` reports whether it is still `queued`, `running`, or finished after the timeout, with the answer recorded for it. `figma_cancel` stops it while it is still `queued`; `OP_RUNNING` and `OP_DONE` are refusals that say why it cannot be stopped — and `OP_DONE` names the revision the call actually reached |
| The bridge died or was restarted — what was in flight? | `figma_journal {unsettled: true}` reads the local journal: a `send` line with no terminal event for the same `opId` is a call that was in flight when its process died (it may have been applied), `timeout` is a caller that gave up, `dropped` got no answer at all, and `late` is the answer that arrived afterwards. It needs neither the daemon nor the plugin |

Liveness check: `lsof -nP -iTCP:8787 | grep -i figma` — empty output means the plugin is not paired.

## Limitations

- `indexTree` walks the whole page per call. On very large pages, split the work — the cache cannot be incremental because the user edits the file in parallel.
- Figma caches screenshot exports; `rev` makes stale renders visible, but there is no way to force a redraw from the Plugin API.
- `figma_use` hands you the full plugin API: it is a notice-and-rollback guard, not a sandbox. Code that runs after the call returns (fire-and-forget promises) escapes the diff; a timeout therefore does **not** roll back and says so.
- Figma unloads the plugin UI when the app is backgrounded. In-flight calls are cancelled immediately (instead of hanging until their timeout), and the bridge reconnects on its own when you return.
- A checkpoint is a rebuild, not a rollback. A restored `COMPONENT` is a new component (its instances do not follow), an `INSTANCE` shows its main component's *current* content, and per-run text styling is not rebuilt. Every one of those is reported by the tool rather than hidden — see the `limitations` list in a `save` reply.

## Versions

| Version | What it carries |
|---|---|
| `0.2.0` | Several Figma files at once (16 slots, an explicit `fileKey` on every tool), `figma_get_layout_tree`, `opId` idempotency with a replay cache, serialised mutations, per-side stroke weights and pinned variable modes, the operating guide as MCP `instructions` and as a resource, `npm run smoke`, and the panel that fits its own content — with the octopus redrawn on the panel's grid, at half the font size, answering a tap |
| `0.1.0` | The first cut: one daemon, one token, one Figma file, the tool surface, and the safety model |

## License

MIT — see [LICENSE](LICENSE). Unofficial project, not affiliated with Figma, Inc.
