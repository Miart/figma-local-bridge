"use strict";
(() => {
  // code.ts
  var MARKER = "UNSPIKE-BUILD-2026-10-06-C";
  console.log("[" + MARKER + "] main started");
  figma.showUI('<!doctype html>\n<html>\n  <head>\n    <meta charset="utf-8" />\n    <style>\n      body {\n        margin: 0; padding: 12px; width: 420px;\n        font: 11px/1.6 ui-monospace, Menlo, monospace;\n        background: #1e1e1e; color: #e8e8e8;\n      }\n      h1 { font-size: 11px; text-transform: uppercase; color: #9a9a9a; margin: 0 0 8px; }\n      button { padding: 5px 10px; border: 1px solid #3d3d3d; border-radius: 4px;\n               background: #2a2a2a; color: #e8e8e8; font: inherit; cursor: pointer; margin: 0 4px 6px 0; }\n      button:hover { border-color: #4ec9a5; }\n      pre { background: #141414; border: 1px solid #3d3d3d; border-radius: 4px;\n            padding: 8px; margin-top: 8px; max-height: 320px; overflow: auto;\n            white-space: pre-wrap; font-size: 10px; }\n      .warn { color: #d9a441; }\n    </style>\n  </head>\n  <body>\n    <h1>Undo spike \u2014 commitUndo / triggerUndo</h1>\n    <p class="warn">Run this on a throwaway duplicate of a Figma file. It only touches nodes it creates itself.</p>\n    <button id="all">run all</button>\n    <button id="clean">cleanup</button>\n    <button id="hash">tree hash</button>\n    <div class="sep"></div>\n    <button id="fx6">fixture: 6 identical</button>\n    <button id="fxodd">fixture: 1 recoloured</button>\n    <button id="fxempty">fixture: empty file</button>\n    <pre id="out">waiting for plugin main thread\u2026</pre>\n    <p class="warn">build: UNSPIKE-UI-2026-10-06-C</p>\n    <script>\n      const out = document.getElementById("out");\n      let lines = [];\n      let heard = false;\n      const push = (s) => { lines.push(s); out.textContent = lines.join("\\n"); out.scrollTop = out.scrollHeight; };\n      window.onmessage = (ev) => {\n        // main -> ui: Figma adds the envelope, so we read event.data.pluginMessage\n        // directly. Wrapping on this side would give pluginMessage.pluginMessage.\n        const payload = ev.data && ev.data.pluginMessage;\n        if (payload && payload.log) { heard = true; push(payload.log); }\n      };\n      // UI -> main needs the { pluginMessage: ... } envelope; main -> UI gets it from Figma.\n      const send = (m) => parent.postMessage({ pluginMessage: m }, "*");\n\n      // Messages the main thread posts before this iframe finishes loading are\n      // DISCARDED, not queued. So the handshake is driven from here: we\n      // announce, and the main thread replies once we are provably listening.\n      push("UI loaded, announcing\u2026");\n      send({ run: "hello" });\n\n      document.getElementById("all").onclick = () => send({ run: "all" });\n      document.getElementById("clean").onclick = () => send({ run: "clean" });\n      document.getElementById("hash").onclick = () => send({ run: "hash" });\n      document.getElementById("fx6").onclick = () => send({ run: "fx", variant: "identical" });\n      document.getElementById("fxodd").onclick = () => send({ run: "fx", variant: "odd" });\n      document.getElementById("fxempty").onclick = () => send({ run: "clean" });\n\n      // Watchdog: if the main thread never answers, say so instead of sitting\n      // there looking like a dead button.\n      setTimeout(() => {\n        if (!heard) {\n          lines = ["UI announced itself but got no reply.",\n                   "The plugin main thread is not answering UI -> main.",\n                   "Check Figma Console (Plugins > Development > Open Console)",\n                   "for an exception in code.js, then reload the plugin."];\n          out.textContent = lines.join("\\n");\n        }\n      }, 4000);\n    <\/script>\n  </body>\n</html>', { width: 460, height: 520, themeColors: true });
  console.log("[" + MARKER + "] UI shown");
  function post(m) {
    try {
      figma.ui.postMessage(m);
    } catch (e) {
      console.log("post failed", e);
    }
  }
  function log(s) {
    post({ log: s });
  }
  var CAPS = {
    commitUndo: typeof figma.commitUndo === "function",
    triggerUndo: typeof figma.triggerUndo === "function",
    group: typeof figma.group === "function",
    dynamicPage: typeof figma.loadAllPagesAsync === "function"
  };
  function announce() {
    log("plugin main thread alive");
    log(
      "api: commitUndo=" + CAPS.commitUndo + " triggerUndo=" + CAPS.triggerUndo + " group=" + CAPS.group + " dynamicPage=" + CAPS.dynamicPage
    );
    try {
      log("editor: " + figma.editorType);
      log("page: " + figma.currentPage.name + " (" + figma.currentPage.children.length + " children)");
    } catch (e) {
      log("page access failed: " + String(e));
    }
    log("ready \u2014 press run all");
    console.log("[" + MARKER + "] ready sent");
  }
  async function buildFixture(variant) {
    const existing = figma.currentPage.findOne(
      (n) => n.type === "FRAME" && n.name === "FIXTURE"
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
    const makeEmblem = (parent, x, y) => {
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
    const makeBackdrop = (x, y, outer) => {
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
      g.x = x;
      g.y = y;
      return g;
    };
    for (let i = 0; i < 6; i++) {
      const recoloured = variant === "odd" && i === 4;
      makeBackdrop(
        40 + i % 3 * 380,
        40 + Math.floor(i / 3) * 260,
        recoloured ? { r: 0.15, g: 0.4, b: 0.6 } : { r: 0.09, g: 0.2, b: 0.3 }
      );
    }
    await sleep(80);
    const groups = figma.currentPage.findAll((n) => n.name === "Group 306").length;
    const emblems = figma.currentPage.findAll((n) => n.name === "Error Icon").length;
    log(`fixture "${variant}": FIXTURE with ${groups} x "Group 306", ${emblems} x "Error Icon"`);
    log(`  bridge selector: match {name:"Group 306", type:"GROUP"}, expectedCount=${groups}`);
  }
  figma.ui.onmessage = async (envelope) => {
    var _a;
    try {
      const msg = envelope && ((_a = envelope.pluginMessage) != null ? _a : envelope);
      if (!msg) return;
      if (msg.ping) {
        log("pong \u2014 ui\u2192main channel works");
        return;
      }
      if (!msg.run) return;
      if (msg.run === "hello") {
        log("ui\u2192main channel works");
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
  var CONTAINER = "UNDO_SPIKE";
  var sleep = (ms) => new Promise((r2) => setTimeout(r2, ms));
  function djb2(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = (h << 5) + h + str.charCodeAt(i) >>> 0;
    return h.toString(16).padStart(8, "0");
  }
  function hashSubtree(node, depth = 0, acc = []) {
    var _a, _b, _c, _d;
    try {
      acc.push(`${node.type}|${node.name}|${node.id}|${r(node.width)}x${r(node.height)}|${r((_b = (_a = node.absoluteBoundingBox) == null ? void 0 : _a.x) != null ? _b : -1)},${r((_d = (_c = node.absoluteBoundingBox) == null ? void 0 : _c.y) != null ? _d : -1)}`);
    } catch (e) {
      acc.push(`DEAD(${node.id})`);
      return djb2(acc.join("\n"));
    }
    if (depth < 6 && "children" in node) {
      let kids = [];
      try {
        kids = node.children;
      } catch (e) {
        return djb2(acc.join("\n"));
      }
      for (const c of kids) hashSubtree(c, depth + 1, acc);
    }
    return djb2(acc.join("\n"));
  }
  function hashPage() {
    try {
      return djb2(
        figma.currentPage.children.map((c) => `${c.type}|${c.name}|${c.id}|${r(c.width)}x${r(c.height)}`).join("\n")
      );
    } catch (e) {
      return "DEAD";
    }
  }
  async function resolve(id) {
    const n = await figma.getNodeByIdAsync(id);
    return n && n.type === "FRAME" ? n : null;
  }
  var r = (n) => Math.round(n * 100) / 100;
  function ensureContainer() {
    const existing = figma.currentPage.findOne(
      (n) => n.type === "FRAME" && n.name === CONTAINER
    );
    if (existing) return existing;
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
  function clearContainer(container) {
    let kids = [];
    try {
      kids = container.children.slice();
    } catch (e) {
      return;
    }
    for (const c of kids) {
      try {
        c.remove();
      } catch (e) {
      }
    }
  }
  function makeRect(container, name, y) {
    const r2 = figma.createRectangle();
    r2.name = name;
    r2.resize(80, 80);
    container.appendChild(r2);
    r2.x = 10;
    r2.y = y;
    return r2;
  }
  var results = [];
  async function runTest(name, mutate) {
    var _a;
    const fresh = ensureContainer();
    clearContainer(fresh);
    await sleep(150);
    const containerId = fresh.id;
    const container = (_a = await resolve(containerId)) != null ? _a : fresh;
    const before = hashSubtree(container);
    const beforePage = hashPage();
    let undoThrew = null;
    let undoReturnedPromise = null;
    let caught = "";
    try {
      figma.commitUndo();
      await mutate(container);
      throw new Error("INJECTED_FAILURE");
    } catch (err) {
      caught = String(err.message);
      try {
        figma.commitUndo();
        const ret = figma.triggerUndo();
        undoReturnedPromise = !!ret && typeof ret.then === "function";
        if (undoReturnedPromise) await ret;
      } catch (undoErr) {
        undoThrew = String(undoErr);
      }
    }
    await sleep(400);
    const afterNode = await resolve(containerId);
    const after = afterNode ? hashSubtree(afterNode) : "CONTAINER-GONE";
    const afterPage = hashPage();
    const rolledBack = after === before && afterPage === beforePage;
    let pageTop = "page-unreadable";
    let containerKids = -1;
    try {
      pageTop = figma.currentPage.children.map((c) => c.type[0] + ":" + c.name).join(",") || "(empty page)";
    } catch (e) {
      pageTop = "page-unreadable";
    }
    if (afterNode) {
      try {
        containerKids = afterNode.children.length;
      } catch (e) {
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
        undoThrew ? `UNDO THREW: ${undoThrew}` : ""
      ].filter(Boolean).join("  ")
    });
    log(`${rolledBack ? "PASS" : "FAIL"}  ${name}
      ${results[results.length - 1].note}`);
    return rolledBack;
  }
  var TESTS = [
    {
      name: "1. three createRectangle",
      async fn(c) {
        makeRect(c, "r1", 10);
        makeRect(c, "r2", 100);
        makeRect(c, "r3", 190);
      }
    },
    {
      name: "2. create + insertChild + remove",
      async fn(c) {
        const a = makeRect(c, "victim", 10);
        makeRect(c, "donor", 100);
        a.remove();
      }
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
        makeRect(c, "x1", 60);
        makeRect(c, "x2", 150).remove();
      }
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
      }
    }
  ];
  async function runAll() {
    results.length = 0;
    log("=== undo spike ===");
    if (!CAPS.commitUndo || !CAPS.triggerUndo) {
      log("ABORT: this Figma build does not expose commitUndo/triggerUndo");
      log("  commitUndo=" + CAPS.commitUndo + " triggerUndo=" + CAPS.triggerUndo);
      log("  the undo-boundary design cannot be validated here \u2014 stop and report.");
      return;
    }
    for (const t of TESTS) {
      try {
        await runTest(t.name, t.fn);
      } catch (err) {
        log(`ERROR in ${t.name}: ${String(err)}`);
      }
    }
    await fixtureGroupToComponent();
    await probeEmptyCommit();
    const failed = results.filter((r2) => r2.rolledBack === false);
    log("");
    log(failed.length === 0 ? `ALL ${results.length} ROLLBACK TESTS PASSED` : `${failed.length}/${results.length} FAILED`);
  }
  async function fixtureGroupToComponent() {
    var _a;
    const fresh = ensureContainer();
    clearContainer(fresh);
    const c = (_a = await resolve(fresh.id)) != null ? _a : fresh;
    const r2 = makeRect(c, "g_rect", 20);
    const f = figma.createFrame();
    f.name = "g_frame";
    f.resize(40, 40);
    c.appendChild(f);
    f.appendChild(r2);
    const g = figma.group([f], c);
    g.name = "fixture_group";
    let outcome = "";
    try {
      const cloned = g.clone();
      c.appendChild(cloned);
      const comp = figma.createComponentFromNode(cloned);
      comp.name = "group_based_component";
      outcome = `OK \u2014 GROUP cloned and promoted, component ${comp.id}`;
      results.push({ name: "5. GROUP -> clone -> createComponentFromNode", rolledBack: null, note: outcome });
    } catch (err) {
      outcome = `THREW \u2014 ${String(err)}`;
      results.push({ name: "5. GROUP -> clone -> createComponentFromNode", rolledBack: null, note: outcome });
    }
    log(`${outcome.startsWith("OK") ? "PASS" : "FAIL"}  5. GROUP -> clone -> createComponentFromNode
      ${outcome}`);
    clearContainer(c);
  }
  async function probeEmptyCommit() {
    var _a;
    const fresh = ensureContainer();
    clearContainer(fresh);
    await sleep(150);
    const id = fresh.id;
    const c = (_a = await resolve(id)) != null ? _a : fresh;
    const before = hashSubtree(c);
    figma.commitUndo();
    const ret = figma.triggerUndo();
    const isPromise = !!ret && typeof ret.then === "function";
    if (isPromise) await ret;
    await sleep(400);
    const afterNode = await resolve(id);
    const after = afterNode ? hashSubtree(afterNode) : "CONTAINER-GONE";
    const stable = before === after;
    log(
      `INFO  6. empty commitUndo + triggerUndo: tree ${stable ? "unchanged" : "CHANGED " + before + "->" + after}, triggerUndo returns promise: ${isPromise}`
    );
    log("INFO  -> now press Cmd+Z once in Figma. If it undoes something of yours, an empty commitUndo is a visible step.");
  }
  function cleanup() {
    const c = figma.currentPage.findOne((n) => n.type === "FRAME" && n.name === CONTAINER);
    if (c) {
      c.remove();
      log("removed " + CONTAINER);
    } else {
      log("nothing to clean");
    }
  }
})();
