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
| `scripts/mascot.py` | generates the ASCII octopus in the panel (its art block is emitted, never hand-edited) |
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
| `FIGMA_BRIDGE_DESTRUCTIVE` | `0` | `1` — allow `figma_use` (raw Plugin API snippets) |

Don't run a second bridge instance: the port is fixed, so the second daemon exits with `EADDRINUSE` (see Troubleshooting).

### Several files at once

Run the plugin in each Figma file you want to drive — every panel connects to the same daemon, which holds one socket per file, keyed by `fileKey` (a file that was never saved gets a session key like `unsaved-a1b2c3d4`). Up to **16 files**; a panel beyond that is refused with `4413` and says so.

- `figma_ping` lists the connected files (`fileKey` + name) — it is the tool to call when you do not know which files are open.
- Every tool takes an optional `fileKey`. With **one** file connected it may be omitted; with **several**, a call without `fileKey` is **refused before anything is sent**, listing the candidates. Guessing here would edit the wrong file.
- The daemon routes by file and answers an unroutable request with an error immediately — never a timeout.
- One file disconnecting fails only its own in-flight calls; the others keep working. Re-opening the plugin in the same file replaces its old socket (old panel gets `4409`).

### What the plugin panel shows

| Row | Meaning |
|---|---|
| mascot | decorative only: an ASCII octopus whose mood follows the link — asleep while offline, shuffling while connecting, blinking when idle, winking when you click the canvas, upset after a failed call. It reacts (hop / shake) to what happened; the status line below always carries the same facts in words. `hide pet` / `show pet` in the footer switches it off for good (stored per user in `figma.clientStorage`) |
| window height | the panel measures what it rendered and asks Figma to fit the window to it, so hiding the mascot (~120px) or showing the error line (~20px) never leaves dead space behind. If Figma drops the resize, the panel re-asks on its own until the window matches the content |
| status | `connected` / `offline — retrying in Ns` / `token rejected` / `another panel is serving this file — press reconnect to take over` / `all 16 file slots are taken — retrying in Ns` |
| chips: `page`, selection | what is open and selected right now — pushed by the plugin, so it stays live even without a connection; hover a chip for the full list |
| chip: `mcp` | how many MCP sessions are attached (0 = no client is bound) |
| chip: calls | how many calls went through; turns red after an error |
| error line | the last call error (full text in the tooltip) |

## Tools

17 tools mirroring Figma's official server, plus 5 local ones — 22 in total.

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
| `figma_use` | Arbitrary Plugin API snippet under scope protection; the answer carries `rev`, `replayed`, `ms` and `nodes` |

**Local additions:**

| Tool | What it does |
|---|---|
| `figma_ping` | Health check: verifies the plugin is paired, reports the active page, and lists the connected files (`fileKey` + name) |
| `figma_get_selection` | Current selection, answered from memory — the plugin pushes selection changes, so this costs no round trip |
| `figma_get_layout_tree` | Absolute geometry of a whole subtree in one call: per node `absoluteTransform` (2×3 matrix), absolute layout and render bounds, clip flag. Document-absolute space — the one a PNG export uses — so a rebuild (atlas, sprite sheet) can be checked against a capture without one `get_node` per layer. Geometry and screenshot stay separate calls (`atomicWithScreenshot: false`): snapshot, then capture, then compare `rev` |
| `figma_inspect` | Compact structure + semantic fingerprint; `compareWith` returns `EQUIVALENT` / `DIFFERENT` / `INCONCLUSIVE` *before* you mutate |
| `figma_replace_repeated_with_component` | Replaces repeated identical nodes with instances of one master component, in a single transactional call. Refuses unless every target is provably equivalent; try `dryRun: true` first |

Not available through a plugin (cloud-only in the official server): `create_new_file`, `generate_figma_design`, `generate_diagram`, `export_video`, shaders, Weave, cloud Code Connect sync.

## Safety model

The bridge edits real design files with an agent at the wheel, so most of the engineering went into making failure modes *visible* instead of silent:

- **Idempotent retries.** `opId` is minted once per logical call and reused by every attempt (`server/src/figma.ts`). The plugin keeps a bounded `opId → result` cache and, on a repeat, replays the recorded answer (`replayed: true`) without touching the document. A repeat arriving while the first attempt is still running **joins it** instead of running the snippet twice.
- **A key names one call.** The cache stores a fingerprint of the method and arguments it answered (`plugin/dispatch.ts`), so a *different* call sent under a used `opId` is refused (`OPID_REUSED`) instead of being handed the first call's answer — the one path that could report a write that never happened. Key order does not change a call, so a retry re-encoded by another JSON writer still replays.
- **Serialized mutations.** Figma's undo barrier is global — two mutations in flight roll each other back. Mutating methods are chained one at a time (`plugin/dispatch.ts`); reads stay parallel. `rev` bumps on success *and* failure.
- **Honest disconnects.** An error distinguishes `disconnected before <method> was sent` (safe to retry) from `may or may not have been applied` (retried under the same `opId`, so a replay cannot apply code twice).
- **Fast-fail offline.** A call waits one 2-second grace period (`LINK_GRACE_MS`) for a reconnecting plugin, then fails with a precise reason. A request that was never sent is not retried at all.
- **No guessing between files.** With several files connected, a call without `fileKey` is refused client-side *before* the request is sent — both the client (`server/src/figma.ts`) and the daemon (`server/src/link.ts`) check independently, and both name the connected files. A wrong file here is a wrong edit, so neither side ever "picks the most recent".
- **Scope guard + fingerprint diff.** `figma_use` runs against a scoped, fingerprint-checked node set and is rolled back if the document drifts outside the scope. Switching pages inside a call is refused (`currentpagechange`): one call per page, or `figma_set_page` first.
- **Timeouts don't roll back.** A `Promise.race` stops waiting, but the snippet keeps running and may still write — the message says exactly that instead of pretending "(rolled back)".
- **Stale screenshots are detectable.** Figma caches exports. `rev` travels in the caption, so identical bytes with a higher `rev` means the render is stale, not that the edit did nothing.
- **Gated writes.** `FIGMA_BRIDGE_WRITE=0` makes the bridge read-only; `figma_use` additionally needs `FIGMA_BRIDGE_DESTRUCTIVE=1` and an explicit scope.

## Development

```sh
npm run build      # plugin (esbuild) + server (tsc)
npm run typecheck  # server + plugin (with @figma/plugin-typings)
npm run smoke      # does server/dist start, speak MCP and fail offline? ~3s, no Figma
npm test           # rebuilds artifacts, then unit + e2e with --test-concurrency=1
```

`npm run smoke` is the fast question — it spawns the built server against a scratch info file (so it takes the offline branch even when a real bridge is running), checks the handshake, the guide, the tool surface and the offline path, and prints one line per check. `npm test` is the slow one: the whole chain against a simulated plugin.

`npm test` rebuilds `server/dist` and `plugin/*.mjs` first because the tests import the built modules — a test running against a stale artifact passes on code Figma will never execute. The suites run serially (`--test-concurrency=1`): e2e tests spin up real daemons on real ports and share one token file, and parallel runs make them flaky by construction.

Current suites: **172 unit checks** — 59 `node:test` cases plus 113 harness checks (`commands`, `fingerprint`, `scope`, `use-figma.gate`) — and **76 e2e checks** (`daemon` 12, `link-state` 8, `mcp` 16, `multifile` 23, `tools` 17; the per-file summaries add up to 68 because `link-state` prints its checks without one).

## Troubleshooting

| Symptom | Cause |
|---|---|
| `FIGMA_BRIDGE_OFFLINE` | The plugin is not running in Figma, or the daemon is down |
| `figma_ping` → `connected: false` | The plugin is not paired |
| The daemon won't start | Port 8787 is busy — `lsof -nP -iTCP:8787 -sTCP:LISTEN` |
| `4409 replaced by a newer socket` | Another panel took this file's slot (plugin reloaded, or the file is open in two windows). Press *reconnect* in the panel you want to keep |
| `4413 too many files (max 16)` | The daemon already serves 16 files — close a panel |
| `4403 bad key` | The daemon restarted with a new `clientKey` — restart your MCP client |
| `4401 bad token` | The token in the plugin doesn't match `figma-bridge-daemon.secret` |

Liveness check: `lsof -nP -iTCP:8787 | grep -i figma` — empty output means the plugin is not paired.

## Limitations

- `indexTree` walks the whole page per call. On very large pages, split the work — the cache cannot be incremental because the user edits the file in parallel.
- Figma caches screenshot exports; `rev` makes stale renders visible, but there is no way to force a redraw from the Plugin API.
- `figma_use` hands you the full plugin API: it is a notice-and-rollback guard, not a sandbox. Code that runs after the call returns (fire-and-forget promises) escapes the diff; a timeout therefore does **not** roll back and says so.
- Figma unloads the plugin UI when the app is backgrounded. In-flight calls are cancelled immediately (instead of hanging until their timeout), and the bridge reconnects on its own when you return.

## License

MIT — see [LICENSE](LICENSE). Unofficial project, not affiliated with Figma, Inc.
