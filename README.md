# Figma Local Bridge

**Unofficial local MCP bridge for Figma Desktop.** Drives the real plugin API from any MCP client (OpenCode, Claude Code, Cursor, …) over a single local daemon — read and edit the open file, take screenshots, export assets, inspect variables, search the design system. **No Dev/Full seat required.**

> Русская версия с подробными инженерными заметками: [README.ru.md](README.ru.md). Not affiliated with Figma, Inc.

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

- the Figma plugin pairs with **exactly one** socket;
- Figma's manifest CSP can only allowlist **fixed** origins, so the port cannot be ephemeral;
- MCP clients spawn one server process **per workspace** — on a fixed port, they would collide.

**One daemon = one socket = one port = one token = one plugin import.**

## Repo layout

| Path | What |
|---|---|
| `server/src/` | stdio MCP server, daemon (WebSocket hub), link state, tool implementations |
| `plugin/` | Figma plugin: `code.ts` bundled to `code.js` by esbuild, UI panel, dispatcher, scope guard |
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

Don't run a second bridge instance: the plugin pairs with one socket, and a second daemon evicts the first (`4409 already paired`).

### What the plugin panel shows

| Row | Meaning |
|---|---|
| status | `connected` / `offline — retrying in Ns` / `token rejected` / `another Figma window holds the plugin slot` |
| `page`, `selection` | what is open and selected right now — pushed by the plugin, so it stays live even without a connection |
| `mcp` | how many MCP sessions are attached (0 = no client is bound) |
| `last` | the last call error (full text in the tooltip) |
| counter (top right) | how many calls went through; turns red after an error |

## Tools

17 tools mirroring Figma's official server, plus 4 local ones — 21 in total.

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
| `figma_ping` | Health check: verifies the plugin is paired, reports the active page |
| `figma_get_selection` | Current selection, answered from memory — the plugin pushes selection changes, so this costs no round trip |
| `figma_inspect` | Compact structure + semantic fingerprint; `compareWith` returns `EQUIVALENT` / `DIFFERENT` / `INCONCLUSIVE` *before* you mutate |
| `figma_replace_repeated_with_component` | Replaces repeated identical nodes with instances of one master component, in a single transactional call. Refuses unless every target is provably equivalent; try `dryRun: true` first |

Not available through a plugin (cloud-only in the official server): `create_new_file`, `generate_figma_design`, `generate_diagram`, `export_video`, shaders, Weave, cloud Code Connect sync.

## Safety model

The bridge edits real design files with an agent at the wheel, so most of the engineering went into making failure modes *visible* instead of silent:

- **Idempotent retries.** `opId` is minted once per logical call and reused by every attempt (`server/src/figma.ts`). The plugin keeps a bounded `opId → result` cache and, on a repeat, replays the recorded answer (`replayed: true`) without touching the document. A repeat arriving while the first attempt is still running **joins it** instead of running the snippet twice.
- **Serialized mutations.** Figma's undo barrier is global — two mutations in flight roll each other back. Mutating methods are chained one at a time (`plugin/dispatch.ts`); reads stay parallel. `rev` bumps on success *and* failure.
- **Honest disconnects.** An error distinguishes `disconnected before <method> was sent` (safe to retry) from `may or may not have been applied` (retried under the same `opId`, so a replay cannot apply code twice).
- **Fast-fail offline.** A call waits one 2-second grace period (`LINK_GRACE_MS`) for a reconnecting plugin, then fails with a precise reason. A request that was never sent is not retried at all.
- **Scope guard + fingerprint diff.** `figma_use` runs against a scoped, fingerprint-checked node set and is rolled back if the document drifts outside the scope. Switching pages inside a call is refused (`currentpagechange`): one call per page, or `figma_set_page` first.
- **Timeouts don't roll back.** A `Promise.race` stops waiting, but the snippet keeps running and may still write — the message says exactly that instead of pretending "(rolled back)".
- **Stale screenshots are detectable.** Figma caches exports. `rev` travels in the caption, so identical bytes with a higher `rev` means the render is stale, not that the edit did nothing.
- **Gated writes.** `FIGMA_BRIDGE_WRITE=0` makes the bridge read-only; `figma_use` additionally needs `FIGMA_BRIDGE_DESTRUCTIVE=1` and an explicit scope.

The full journal of failure modes met in practice (symptom → cause → fix) lives in the Russian notes: [README.ru.md](README.ru.md).

## Development

```sh
npm run build      # plugin (esbuild) + server (tsc)
npm run typecheck  # server + plugin (with @figma/plugin-typings)
npm test           # rebuilds artifacts, then unit + e2e with --test-concurrency=1
```

`npm test` rebuilds `server/dist` and `plugin/*.mjs` first because the tests import the built modules — a test running against a stale artifact passes on code Figma will never execute. The suites run serially (`--test-concurrency=1`): e2e tests spin up real daemons on real ports and share one token file, and parallel runs make them flaky by construction.

Current suites: **143 unit checks** (`commands`, `fingerprint`, `scope`, `retry`, `offline`, `dispatch`, `daemoninfo`, `use-figma.gate`, `use-figma.safety`) and **47 e2e checks** (`daemon`, `link-state`, `mcp`, `tools`).

## Troubleshooting

| Symptom | Cause |
|---|---|
| `FIGMA_BRIDGE_OFFLINE` | The plugin is not running in Figma, or the daemon is down |
| `figma_ping` → `connected: false` | The plugin is not paired |
| The daemon won't start | Port 8787 is busy — `lsof -nP -iTCP:8787 -sTCP:LISTEN` |
| `4409 already paired` | A second bridge instance; kill the extra process |
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
