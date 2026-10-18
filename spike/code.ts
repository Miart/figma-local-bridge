/// <reference types="@figma/plugin-typings" />

/**
 * UNDO SPIKE — kills the one unknown the whole bridge design depends on:
 * does `figma.commitUndo()` / `figma.triggerUndo()` give us a real transaction
 * boundary for the exact operation mix we care about
 * (createComponentFromNode -> createInstance -> insertChild -> remove)?
 *
 * There is deliberately no MCP here. Run it on a throwaway duplicate of a file.
 * Everything it creates lives inside a single container named UNDO_SPIKE, and
 * nothing outside that container is ever touched.
 */

declare const __html__: string;

type Json = any;

// BUILD MARKER — if this does not appear in Figma's console, Figma is running
// a different code.js than the one we just wrote.
const MARKER = "UNSPIKE-BUILD-2026-10-06-C";
console.log("[" + MARKER + "] main started");

figma.showUI(__html__, { width: 460, height: 520, themeColors: true });
console.log("[" + MARKER + "] UI shown");

// figma.ui.postMessage(obj) is delivered to the iframe as
// event.data.pluginMessage === obj. Figma adds the envelope itself, so do NOT
// wrap here (double-wrapping made the UI see pluginMessage.pluginMessage).
function post(m: Json): void {
  try {
    figma.ui.postMessage(m);
  } catch (e) {
    console.log("post failed", e);
  }
}
function log(s: string): void {
  post({ log: s });
}

const CAPS = {
  commitUndo: typeof (figma as Json).commitUndo === "function",
  triggerUndo: typeof (figma as Json).triggerUndo === "function",
  group: typeof (figma as Json).group === "function",
  dynamicPage: typeof (figma as Json).loadAllPagesAsync === "function",
};

function announce(): void {
  log("plugin main thread alive");
  log(
    "api: commitUndo=" + CAPS.commitUndo +
      " triggerUndo=" + CAPS.triggerUndo +
      " group=" + CAPS.group +
      " dynamicPage=" + CAPS.dynamicPage,
  );
  try {
    log("editor: " + figma.editorType);
    log("page: " + figma.currentPage.name + " (" + figma.currentPage.children.length + " children)");
  } catch (e) {
    log("page access failed: " + String(e));
  }
  log("ready — press run all");
  console.log("[" + MARKER + "] ready sent");
}

// ---------------------------------------------------------------- fixture

/**
 * Synthetic fixture builder. Deliberately lives in the spike, not the bridge:
 * this is test scaffolding, and the bridge's MCP surface must never grow a
 * "create nodes" primitive.
 *
 * Mirrors the real target: a GROUP backdrop holding two rounded rects, a header
 * frame and an Error Icon whose content includes a real BOOLEAN_OPERATION —
 * which is exactly the shape that makes the semantic fingerprint answer
 * INCONCLUSIVE instead of proving equivalence.
 */
async function buildFixture(variant: string): Promise<void> {
  const existing = figma.currentPage.findOne(
    (n) => n.type === "FRAME" && n.name === "FIXTURE",
  );
  if (existing) existing.remove();

  const root = figma.createFrame();
  root.name = "FIXTURE";
  root.resize(1200, 900);
  root.fills = [{ type: "SOLID", color: { r: 0.05, g: 0.05, b: 0.06 } }];
  root.x = 0;
  root.y = 0;

  const DARK = { r: 0.086, g: 0.196, b: 0.29 };
  const RED = { r: 0.85, g: 0.2, b: 0.2 };

  const makeEmblem = (parent: FrameNode, x: number, y: number): FrameNode => {
    const f = figma.createFrame();
    f.name = "Error Icon";
    f.resize(148, 148);
    f.fills = [];
    parent.appendChild(f);
    f.x = x;
    f.y = y;

    const glow = figma.createPolygon();
    glow.name = "Outer Glow";
    glow.pointCount = 6;
    glow.resize(130, 130);
    glow.fills = [{ type: "SOLID", color: { r: 0.4, g: 0.1, b: 0.1 }, opacity: 0.4 }];
    f.appendChild(glow);
    glow.x = 9;
    glow.y = 9;

    const hex = figma.createPolygon();
    hex.name = "Hexagon";
    hex.pointCount = 6;
    hex.resize(100, 100);
    hex.fills = [{ type: "SOLID", color: DARK }];
    f.appendChild(hex);
    hex.x = 24;
    hex.y = 24;

    const a = figma.createRectangle();
    const b = figma.createRectangle();
    a.resize(40, 40);
    b.resize(40, 40);
    a.fills = [{ type: "SOLID", color: RED }];
    b.fills = [{ type: "SOLID", color: RED }];
    f.appendChild(a);
    f.appendChild(b);
    a.x = 40;
    a.y = 40;
    b.x = 68;
    b.y = 68;
    const union = figma.union([a, b], f);
    if (union) {
      union.name = "Union";
      union.x = 55;
      union.y = 55;
    }
    return f;
  };

  const makeBackdrop = (x: number, y: number, outer: any): SceneNode => {
    // Children go straight into root, then get grouped. An earlier version used
    // a temporary holder frame and removed it afterwards — which also removed
    // the group, because Figma deletes descendants with the parent.
    const o = figma.createRectangle();
    o.name = "Rectangle 7905";
    o.resize(292, 192);
    o.cornerRadius = 8;
    o.fills = [{ type: "SOLID", color: outer }];
    root.appendChild(o);
    o.x = x + 4;
    o.y = y + 4;

    const i = figma.createRectangle();
    i.name = "Rectangle 7904";
    i.resize(284, 184);
    i.cornerRadius = 6;
    i.fills = [{ type: "SOLID", color: { r: 0.04, g: 0.05, b: 0.06 } }];
    root.appendChild(i);
    i.x = x + 8;
    i.y = y + 8;

    const h = figma.createFrame();
    h.name = "Frame 158";
    h.resize(200, 24);
    h.fills = [];
    root.appendChild(h);
    h.x = x + 50;
    h.y = y + 20;

    const emblem = makeEmblem(root, x + 140, y + 10);

    const g = figma.group([o, i, h, emblem], root);
    if (!g) throw new Error("figma.group returned nothing");
    g.name = "Group 306";
    // grouping preserves absolute positions; move the whole group into its cell
    g.x = x;
    g.y = y;
    return g;
  };

  for (let i = 0; i < 6; i++) {
    const recoloured = variant === "odd" && i === 4;
    makeBackdrop(
      40 + (i % 3) * 380,
      40 + Math.floor(i / 3) * 260,
      recoloured ? { r: 0.15, g: 0.4, b: 0.6 } : { r: 0.09, g: 0.2, b: 0.3 },
    );
  }

  await sleep(80);
  const groups = figma.currentPage.findAll((n) => n.name === "Group 306").length;
  const emblems = figma.currentPage.findAll((n) => n.name === "Error Icon").length;
  log(`fixture "${variant}": FIXTURE with ${groups} x "Group 306", ${emblems} x "Error Icon"`);
  log(`  bridge selector: match {name:"Group 306", type:"GROUP"}, expectedCount=${groups}`);
}

// IMPORTANT: the message handler is registered FIRST. Everything below is
// function declarations (hoisted), so referencing them from here is safe, and a
// failure anywhere in the rest of the module cannot leave the UI deaf.
figma.ui.onmessage = async (envelope: Json) => {
  try {
    // UI -> main is also wrapped; Figma drops un-enveloped messages.
    const msg = envelope && (envelope.pluginMessage ?? envelope);
    if (!msg) return;
    if (msg.ping) { log("pong — ui→main channel works"); return; }
    if (!msg.run) return;
    // Handshake: the UI announces itself because anything we posted before the
    // iframe loaded is discarded. Reply only now.
    if (msg.run === "hello") {
      log("ui→main channel works");
      announce();
      return;
    }
    if (msg.run === "fx") return await buildFixture(msg.variant || "identical");
    if (msg.run === "all") await runAll();
    else if (msg.run === "clean") cleanup();
    else if (msg.run === "hash") log("page hash: " + hashPage());
  } catch (err) {
    log("FATAL " + String(err));
  }
};

log("main thread: handler registered");

try {
  announce();
} catch (e) {
  log("announce failed: " + String(e));
}

const CONTAINER = "UNDO_SPIKE";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Kept as a plain declaration so a failure here cannot abort module evaluation.

// ---------------------------------------------------------------- hashing

function djb2(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/**
 * Structural fingerprint. Includes absolute position so a layout shift shows up.
 *
 * IMPORTANT: node references do NOT survive triggerUndo(). After a rollback the
 * container can still hold children objects that no longer exist, and touching
 * any property on them throws. So every read is guarded and dead nodes are
 * reported rather than crashing the measurement.
 */
function hashSubtree(node: SceneNode, depth = 0, acc: string[] = []): string {
  try {
    acc.push(`${node.type}|${node.name}|${node.id}|${r(node.width)}x${r(node.height)}|${r(node.absoluteBoundingBox?.x ?? -1)},${r(node.absoluteBoundingBox?.y ?? -1)}`);
  } catch (e) {
    acc.push(`DEAD(${node.id})`);
    return djb2(acc.join("\n"));
  }
  if (depth < 6 && "children" in node) {
    let kids: SceneNode[] = [];
    try {
      kids = node.children as SceneNode[];
    } catch {
      return djb2(acc.join("\n"));
    }
    for (const c of kids) hashSubtree(c, depth + 1, acc);
  }
  return djb2(acc.join("\n"));
}

/** Shallow page-level fingerprint: catches undo bleeding outside the container. */
function hashPage(): string {
  try {
    return djb2(
      figma.currentPage.children
        .map((c: SceneNode) => `${c.type}|${c.name}|${c.id}|${r(c.width)}x${r(c.height)}`)
        .join("\n"),
    );
  } catch {
    return "DEAD";
  }
}

/** Re-resolve by id. Mandatory after any rollback. */
async function resolve(id: string): Promise<FrameNode | null> {
  const n = (await figma.getNodeByIdAsync(id)) as FrameNode | null;
  return n && n.type === "FRAME" ? n : null;
}

const r = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- fixture

function ensureContainer(): FrameNode {
  const existing = figma.currentPage.findOne(
    (n) => n.type === "FRAME" && n.name === CONTAINER,
  ) as FrameNode | null;
  if (existing) return existing;

  // Place it clear of existing content so we never overlap user work.
  let maxX = 0;
  for (const c of figma.currentPage.children) maxX = Math.max(maxX, c.x + c.width);
  const f = figma.createFrame();
  f.name = CONTAINER;
  f.x = maxX + 400;
  f.y = 0;
  f.resize(400, 400);
  f.fills = [{ type: "SOLID", color: { r: 0.08, g: 0.08, b: 0.09 } }];
  f.clipsContent = false;
  return f;
}

function clearContainer(container: FrameNode) {
  let kids: SceneNode[] = [];
  try {
    kids = (container.children as SceneNode[]).slice();
  } catch {
    return;
  }
  for (const c of kids) {
    try {
      c.remove();
    } catch {
      /* already gone — expected after a rollback */
    }
  }
}

function makeRect(container: FrameNode, name: string, y: number) {
  const r = figma.createRectangle();
  r.name = name;
  r.resize(80, 80);
  container.appendChild(r);
  r.x = 10;
  r.y = y;
  return r;
}

// ---------------------------------------------------------------- runner

interface Result {
  name: string;
  rolledBack: boolean | null;
  note: string;
}

const results: Result[] = [];

async function runTest(name: string, mutate: (c: FrameNode) => Promise<void>) {
  const fresh = ensureContainer();
  clearContainer(fresh);
  await sleep(150);

  const containerId = fresh.id;
  const container = (await resolve(containerId)) ?? fresh;
  const before = hashSubtree(container);
  const beforePage = hashPage();

  let undoThrew: string | null = null;
  let undoReturnedPromise: boolean | null = null;
  let caught = "";

  try {
    figma.commitUndo();          // baseline checkpoint
    await mutate(container);
    throw new Error("INJECTED_FAILURE");   // force the failure path
  } catch (err) {
    caught = String((err as Error).message);
    try {
      // triggerUndo reverts the last COMMITTED step; close the mutation step first.
      figma.commitUndo();
      const ret: any = figma.triggerUndo();
      undoReturnedPromise = !!ret && typeof ret.then === "function";
      if (undoReturnedPromise) await ret;
    } catch (undoErr) {
      undoThrew = String(undoErr);
    }
  }

  await sleep(400);
  // References are invalid after a rollback — re-resolve before measuring.
  const afterNode = await resolve(containerId);
  const after = afterNode ? hashSubtree(afterNode) : "CONTAINER-GONE";
  const afterPage = hashPage();

  const rolledBack = after === before && afterPage === beforePage;

  // Decisive observation: is the container still on the page, and how many
  // children does it actually have? This separates "undone" from "rollback did
  // nothing", which a hash alone cannot distinguish.
  let pageTop = "page-unreadable";
  let containerKids = -1;
  try {
    pageTop = figma.currentPage.children
      .map((c: SceneNode) => c.type[0] + ":" + c.name)
      .join(",") || "(empty page)";
  } catch {
    pageTop = "page-unreadable";
  }
  if (afterNode) {
    try {
      containerKids = afterNode.children.length;
    } catch {
      containerKids = -1;
    }
  }

  results.push({
    name,
    rolledBack,
    note: [
      `before=${before}`,
      `after=${after}`,
      `containerOnPage=${afterNode ? "yes" : "no"}`,
      `containerChildren=${containerKids}`,
      `pageTop=[${pageTop}]`,
      undoReturnedPromise === null ? "" : `undoReturnsPromise=${undoReturnedPromise}`,
      undoThrew ? `UNDO THREW: ${undoThrew}` : "",
    ].filter(Boolean).join("  "),
  });
  log(`${rolledBack ? "PASS" : "FAIL"}  ${name}\n      ${results[results.length - 1].note}`);

  return rolledBack;
}

// ---------------------------------------------------------------- tests

const TESTS: Array<{ name: string; fn: (c: FrameNode) => Promise<void> }> = [
  {
    name: "1. three createRectangle",
    async fn(c) {
      makeRect(c, "r1", 10);
      makeRect(c, "r2", 100);
      makeRect(c, "r3", 190);
    },
  },
  {
    name: "2. create + insertChild + remove",
    async fn(c) {
      const a = makeRect(c, "victim", 10);
      makeRect(c, "donor", 100);
      a.remove();
    },
  },
  {
    name: "3. createComponentFromNode + 3 createInstance + 3 remove",
    async fn(c) {
      const src = makeRect(c, "source", 10);
      const frame = figma.createFrame();
      frame.name = "will_be_component";
      frame.resize(60, 60);
      c.appendChild(frame);
      frame.appendChild(src);
      frame.x = 10;
      frame.y = 280;

      const comp = figma.createComponentFromNode(frame);
      comp.name = "spike_component";

      for (let i = 0; i < 3; i++) {
        const inst = comp.createInstance();
        c.appendChild(inst);
        inst.x = 100 + i * 70;
        inst.y = 280;
      }
      // remove some pre-existing-ish nodes too
      makeRect(c, "x1", 60);
      makeRect(c, "x2", 150).remove();
    },
  },
  {
    name: "4. nested component inside a GROUP (clone caveat)",
    async fn(c) {
      const inner = makeRect(c, "inner", 10);
      const frame = figma.createFrame();
      frame.name = "inner_frame";
      frame.resize(50, 50);
      c.appendChild(frame);
      frame.appendChild(inner);

      const g = figma.group([frame], c);
      g.name = "spike_group";
      const cloned = g.clone();
      c.appendChild(cloned);
    },
  },
];

async function runAll() {
  results.length = 0;
  log("=== undo spike ===");
  if (!CAPS.commitUndo || !CAPS.triggerUndo) {
    log("ABORT: this Figma build does not expose commitUndo/triggerUndo");
    log("  commitUndo=" + CAPS.commitUndo + " triggerUndo=" + CAPS.triggerUndo);
    log("  the undo-boundary design cannot be validated here — stop and report.");
    return;
  }

  for (const t of TESTS) {
    try {
      await runTest(t.name, t.fn);
    } catch (err) {
      log(`ERROR in ${t.name}: ${String(err)}`);
    }
  }

  // Q: does GROUP -> clone -> createComponentFromNode actually work?
  await fixtureGroupToComponent();

  // Q: does an EMPTY commitUndo leave an observable step?
  await probeEmptyCommit();

  const failed = results.filter((r) => r.rolledBack === false);
  log("");
  log(failed.length === 0 ? `ALL ${results.length} ROLLBACK TESTS PASSED` : `${failed.length}/${results.length} FAILED`);
}

async function fixtureGroupToComponent() {
  const fresh = ensureContainer();
  clearContainer(fresh);
  const c = (await resolve(fresh.id)) ?? fresh;
  const r = makeRect(c, "g_rect", 20);
  const f = figma.createFrame();
  f.name = "g_frame";
  f.resize(40, 40);
  c.appendChild(f);
  f.appendChild(r);
  const g = figma.group([f], c);
  g.name = "fixture_group";

  let outcome = "";
  try {
    const cloned = g.clone();
    c.appendChild(cloned);
    const comp = figma.createComponentFromNode(cloned as any);
    comp.name = "group_based_component";
    outcome = `OK — GROUP cloned and promoted, component ${comp.id}`;
    results.push({ name: "5. GROUP -> clone -> createComponentFromNode", rolledBack: null, note: outcome });
  } catch (err) {
    outcome = `THREW — ${String(err)}`;
    results.push({ name: "5. GROUP -> clone -> createComponentFromNode", rolledBack: null, note: outcome });
  }
  log(`${outcome.startsWith("OK") ? "PASS" : "FAIL"}  5. GROUP -> clone -> createComponentFromNode\n      ${outcome}`);
  clearContainer(c);
}

async function probeEmptyCommit() {
  const fresh = ensureContainer();
  clearContainer(fresh);
  await sleep(150);
  const id = fresh.id;
  const c = (await resolve(id)) ?? fresh;
  const before = hashSubtree(c);
  figma.commitUndo();
  const ret: any = figma.triggerUndo();
  const isPromise = !!ret && typeof ret.then === "function";
  if (isPromise) await ret;
  await sleep(400);
  const afterNode = await resolve(id);
  const after = afterNode ? hashSubtree(afterNode) : "CONTAINER-GONE";
  const stable = before === after;
  log(
    `INFO  6. empty commitUndo + triggerUndo: tree ${stable ? "unchanged" : "CHANGED " + before + "->" + after}, ` +
      `triggerUndo returns promise: ${isPromise}`,
  );
  log("INFO  -> now press Cmd+Z once in Figma. If it undoes something of yours, an empty commitUndo is a visible step.");
}

function cleanup() {
  const c = figma.currentPage.findOne((n) => n.type === "FRAME" && n.name === CONTAINER) as FrameNode | null;
  if (c) {
    c.remove();
    log("removed " + CONTAINER);
  } else {
    log("nothing to clean");
  }
}