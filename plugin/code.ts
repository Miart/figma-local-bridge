/// <reference types="@figma/plugin-typings" />

/**
 * Figma Local Bridge — plugin side.
 *
 * Speaks JSON-RPC over the ui.html WebSocket. The socket itself lives in the UI
 * iframe (this sandbox has no DOM); this file relays via postMessage and does
 * the Plugin API work.
 *
 * Deliberately a VERY small surface: three high-level tools, no primitives.
 * `create_instance`, `remove`, `append_child` and friends exist as functions
 * inside the command engine but are NOT exposed to the agent, because they are
 * how a coding agent accidentally destroys a design file.
 *
 * TRANSACTIONALITY: every command is dispatched from inside a single
 * figma.ui.onmessage handler, so a throw reverts the whole message. The engine
 * additionally manages an explicit commitUndo/triggerUndo boundary — verified by
 * the spike, which proved that pair really does roll back
 * createComponentFromNode + createInstance + remove.
 */

declare const __html__: string;

type Json = any;

/**
 * The panel window.
 *
 * Its height is not fixed any more: the UI measures what it rendered and asks
 * for a window that fits (figma.ui.resize). Hiding the mascot is worth ~120px,
 * the error line ~20, and neither should leave dead space behind. Width never
 * changes; the height is clamped here, because the UI cannot know Figma's
 * limits, and reseeded from clientStorage, because the first frame should
 * already be the right size instead of jumping on every reload.
 */
const UI_WIDTH = 320;
const UI_MIN_H = 140;
const UI_MAX_H = 900;
const UI_H_OPEN = 310; // the first frame's guess; the UI reports the real height

let petHidden = false;

/**
 * Fit the window to a height the panel measured.
 *
 * Figma applies these asynchronously, and a request that lands while an earlier
 * one is still in flight can be overridden by it — which is what "hide the pet
 * a few times and the window stops shrinking" turned out to be: the last
 * request was correct, the window just kept the height of a resize that was
 * already on its way. So the same height is re-asserted once, shortly after,
 * unless a newer request has arrived in the meantime.
 */
let fitTimer: ReturnType<typeof setTimeout> | null = null;
let fitHeight = 0;

function fitWindow(h: number): void {
  fitHeight = h;
  figma.ui.resize(UI_WIDTH, h);
  if (fitTimer) clearTimeout(fitTimer);
  fitTimer = setTimeout(() => {
    fitTimer = null;
    if (fitHeight === h) figma.ui.resize(UI_WIDTH, h);
  }, 200);
}

// Shown synchronously, before the first await: the manifest already declares a
// UI file, and creating ours after an await made Figma tear down that first UI
// and build a second one — two instances booting, two sockets, and a window
// whose size came from the manifest rather than from these options.
figma.showUI(__html__, { width: UI_WIDTH, height: UI_H_OPEN, themeColors: true });

// The mascot switch cannot be known synchronously (clientStorage is async), so
// the panel starts with the mascot and this push hides it a moment later. The
// UI re-measures after hiding, and the window follows on its own.
figma.clientStorage.getAsync("flb.petHidden").then(
  (stored) => {
    petHidden = !!stored;
    post({ event: "pet", hidden: petHidden });
  },
  () => {},
);

function post(m: Json): void {
  try {
    figma.ui.postMessage(m); // Figma adds the pluginMessage envelope itself
  } catch (e) {
    console.log("post failed", e);
  }
}
const log = (s: string) => post({ log: s });

import { replaceRepeatedWithComponent, type ReplaceParams } from "./commands";
import { toolMethods, MUTATING_METHODS } from "./tools";
import { snapshot, compare, explain, STRICT, COMPONENTIZE } from "./fingerprint";
import { bump, current } from "./rev";
import { Dispatcher } from "./dispatch";

const CAPS = { write: true };

/**
 * Methods that write to the document, so the dispatcher can run them strictly
 * one at a time. The undo boundary (`figma.commitUndo()` / `triggerUndo()`) is
 * global: two writes in flight at once can undo each other's work. Add every new
 * mutating method here — MUTATING_METHODS covers the parity tools, this adds the
 * one implemented in this file.
 */
const MUTATING = new Set<string>([...MUTATING_METHODS, "replace_repeated_with_component"]);

/**
 * Idempotency for retried calls.
 *
 * Figma tears the plugin down and brings it back several times a second in a
 * heavy document. The client cannot tell whether a call that died with the
 * socket was applied before the plugin went, so it retries — and a retried
 * `use_figma` re-runs the same snippet, leaving a duplicate of everything it
 * created. That is not hypothetical: it is how a dozen stray components ended
 * up in the document.
 *
 * The client therefore sends one `opId` per *logical* call, stable across its
 * retries, and the dispatcher answers a repeat from its cache — or, if the first
 * attempt is STILL RUNNING, from that same promise — instead of executing it
 * twice. Bounded so a long session cannot grow it without limit; entries are
 * dropped oldest-first, which only costs a re-execution for calls older than the
 * cap. See plugin/dispatch.ts.
 */

/**
 * Identity of the file this panel serves.
 *
 * figma.fileKey is undefined until the file is first saved, so an unsaved file
 * gets a session key instead. The daemon routes requests by this key and uses it
 * to tell two open Figma windows apart; the key never reaches Figma itself.
 * Computed at handshake time, so a file saved mid-session reports its real key
 * the next time the plugin reloads.
 */
const UNSAVED_KEY = "unsaved-" + Math.random().toString(36).slice(2, 10);

function fileMeta(): Json {
  return { key: figma.fileKey || UNSAVED_KEY, name: figma.root.name };
}

function announce(): void {
  post({ event: "handshake", ok: true, write: CAPS.write, file: fileMeta() });
  // Push the session state on load as well as on change. `selectionchange` only
  // fires on an actual change, so without this the panel's page and selection
  // rows sat on "—" from the moment it opened until the user clicked something.
  post(selectionEvent());
  try {
    log("bridge plugin ready");
  } catch {
    /* the UI may not be listening yet; it re-asks with hello */
  }
}

/** The page/selection snapshot the panel renders and the MCP side caches. */
function selectionEvent(): Json {
  return {
    id: null,
    event: "selection",
    page: { id: figma.currentPage.id, name: figma.currentPage.name },
    selection: figma.currentPage.selection.map((n) => ({ id: n.id, name: n.name, type: n.type })),
  };
}

// ---------------------------------------------------------------- helpers

async function get(id: string): Promise<SceneNode | null> {
  return (await figma.getNodeByIdAsync(id)) as SceneNode | null;
}

/** Compact read model. Never the raw Plugin API object. */
function describe(node: SceneNode, depth: number): Json {
  const parent = node.parent as any;
  const out: Json = {
    id: node.id,
    type: node.type,
    name: node.name,
    size: [round(node.width), round(node.height)],
    parent: parent
      ? {
          id: parent.id,
          name: parent.name,
          type: parent.type,
          layoutMode: "layoutMode" in parent ? parent.layoutMode ?? "NONE" : null,
        }
      : null,
  };
  if ("x" in node) out.position = [round(node.x), round(node.y)];
  if ("constraints" in node) out.constraints = node.constraints;
  if (node.type === "TEXT") out.text = node.characters;
  if (depth > 0 && "children" in node) {
    out.children = (node.children as SceneNode[])
      .slice(0, 200)
      .map((c) => describe(c, depth - 1));
  }
  return out;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------- tools

const methods: Record<string, (p: Json) => Promise<Json>> = {
  /**
   * Read-only health check. Also the handshake response, which is how the plugin
   * proves the main thread is alive without waiting for a tool call.
   */
  async ping() {
    return {
      ok: true,
      editor: figma.editorType,
      page: { id: figma.currentPage.id, name: figma.currentPage.name },
      writeEnabled: CAPS.write,
      nodesOnPage: figma.currentPage.children.length,
    };
  },

  /**
   * Selection, pushed from selectionchange so the MCP side can answer from
   * memory. Falls back to a direct read if no push has arrived yet.
   */
  async get_selection() {
    const sel = figma.currentPage.selection;
    return {
      page: { id: figma.currentPage.id, name: figma.currentPage.name },
      selection: sel.map((n) => ({ id: n.id, name: n.name, type: n.type })),
    };
  },

  /**
   * Inspect. Returns structure plus the semantic fingerprint, so an agent can
   * see whether a node is provably equivalent to something else BEFORE asking
   * for a mutation.
   */
  async inspect(p: Json) {
    const nodeId = p.nodeId || (figma.currentPage.selection[0] && figma.currentPage.selection[0].id);
    if (!nodeId) return { error: "no nodeId given and nothing is selected" };

    const node = await get(nodeId);
    if (!node) return { error: "node not found: " + nodeId };

    const policy = p.policy === "componentize" ? COMPONENTIZE : STRICT;
    const fp = snapshot(node as any, policy);

    const out: Json = {
      node: describe(node, p.depth === undefined ? 1 : p.depth),
      fingerprint: {
        hash: fp.hash,
        appearanceHash: fp.appearanceHash,
        geometryHash: fp.geometryHash,
        childrenHash: fp.childrenHash,
        geometryStatus: fp.geometryStatus,
      },
      warnings: fp.warnings,
    };

    if (Array.isArray(p.compareWith) && p.compareWith.length) {
      const others: Json[] = [];
      for (const id of p.compareWith) {
        const other = await get(id);
        if (!other) {
          others.push({ id, verdict: "NOT_FOUND" });
          continue;
        }
        const ofp = snapshot(other as any, policy);
        const verdict = compare(fp, ofp);
        others.push({ id, verdict, why: verdict === "EQUIVALENT" ? [] : explain(fp, ofp) });
      }
      out.compared = others;
    }

    return out;
  },

  /**
   * The single mutating command. Resolves a cohort, refuses to touch anything
   * unless every member is provably equivalent, replaces them with instances of
   * a freshly created master, and verifies the result before committing.
   */
  async replace_repeated_with_component(p: ReplaceParams) {
    return replaceRepeatedWithComponent(p);
  },

  // Figma-MCP-parity tools (use_figma, get_metadata, get_design_context, ...).
  ...toolMethods,
};

// ---------------------------------------------------------------- wiring

/**
 * One dispatcher for the whole plugin: it owns the opId cache, coalesces a
 * retry of a call that is still running, and keeps mutating methods from
 * interleaving. See plugin/dispatch.ts for why each of those matters.
 */
const dispatcher = new Dispatcher({
  run: (method, params) => {
    const fn = methods[method];
    if (!fn) throw new Error("unknown method: " + method);
    return fn(params);
  },
  mutating: MUTATING,
  bump,
  peek: current,
});

figma.ui.onmessage = async (envelope: Json) => {
  // ui -> main: the UI supplies the pluginMessage envelope itself.
  const msg = envelope && (envelope.pluginMessage ?? envelope);
  if (!msg) return;

  if (msg.uiReady) {
    announce();
    // Belt and braces for the body attribute openUi() injected: if that replace
    // ever misses (a UI with no plain <body> tag), the push still gets there.
    post({ event: "pet", hidden: petHidden });
    // The UI sandbox has no localStorage; hand the saved token back.
    figma.clientStorage.getAsync("flb.token").then(
      (token) => post({ event: "token", token: token || "" }),
      () => post({ event: "token", token: "" }),
    );
    return;
  }
  if (msg.saveToken !== undefined) {
    figma.clientStorage.setAsync("flb.token", String(msg.saveToken)).catch(() => {});
    return;
  }
  if (msg.savePetHidden !== undefined) {
    petHidden = !!msg.savePetHidden;
    figma.clientStorage.setAsync("flb.petHidden", petHidden).catch(() => {});
    return;
  }
  // The UI measured its own content. Clamp and fit the window to it.
  if (typeof msg.uiHeight === "number" && isFinite(msg.uiHeight)) {
    const h = Math.max(UI_MIN_H, Math.min(UI_MAX_H, Math.round(msg.uiHeight)));
    try {
      fitWindow(h);
    } catch (e) {
      console.log("resize failed", e);
    }
    return;
  }
  if (msg.pluginReady !== undefined) {
    post({ event: "link", connected: !!msg.pluginReady });
    return;
  }

  const raw = msg.bridgeMessage;
  if (!raw) return;

  let req: Json;
  try {
    req = JSON.parse(typeof raw === "string" ? raw : raw);
  } catch {
    return;
  }
  if (!req || !req.id || !req.method) return;

  post(await dispatcher.handle({ id: req.id, method: req.method, opId: req.opId, params: req.params }));
};

// Selection is pushed rather than polled, so get_selection costs no round trip.
figma.on("selectionchange", () => post(selectionEvent()));