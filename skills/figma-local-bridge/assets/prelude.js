// ============================================================================
// figma-local-bridge — SAFE SNIPPET PRELUDE (paste at the top of every
// figma_use code string). Plain JS only: no import/require/process/fs.
// Purpose: remove the recurring failure classes seen in real sessions:
//   - solidPaint() fed a number / object / undefined
//   - text set with `.text` instead of `.characters`
//   - font not loaded before fontName/fontSize/characters
//   - frame.resize() after primaryAxisSizingMode="AUTO" (forces FIXED)
//   - resizing a frame scales its children (constraints) -> knob/fill drift
//   - PaintStyle.fills (must be .paints)
//   - fillStyleId / mainComponent / getNodeById sync access under dynamic-page
//   - one bad value rolls back the WHOLE snippet
// ============================================================================

// ---- 1. COLOR TOKENS: hex strings, validated, converted on demand ----------
const HEX = {
  bgMain: "#03110B", bgPanel: "#0A1E14", bgElement: "#10291C",
  textMain: "#A3EFB0", textAccent: "#AAFFB4", borderMain: "#277F50",
  textSecondary: "#669A78", fillActive: "#285A38", sliderEmpty: "#0D1F17",
  glow: "#3E8E59", black: "#000000",
};
/** @param {string} keyOrHex token name or a "#RRGGBB" literal */
function paint(keyOrHex) {
  const hex = HEX[keyOrHex] || keyOrHex;
  if (typeof hex !== "string" || hex[0] !== "#") {
    throw new Error("paint(): expected a hex string or a known token, got " +
      JSON.stringify(keyOrHex) + " (known: " + Object.keys(HEX).join(",") + ")");
  }
  return figma.util.solidPaint(hex);
}
// Preflight: call BEFORE any write. Fails fast with the offending key.
function preflight(keys) {
  for (const k of keys) {
    if (typeof HEX[k] !== "string") throw new Error("preflight(): unknown color token " + k);
  }
}

// ---- 2. FONTS: load once, then write text with the right property ----------
const _loaded = {};
async function font(family, style) {
  const key = family + "/" + style;
  if (!_loaded[key]) {
    await figma.loadFontAsync({ family: family, style: style }); // NOT loadFontAsync("Name")
    _loaded[key] = true;
  }
}
/** Safe text node. `label` goes to `.characters` (never `.text`). */
async function txt(label, o) {
  o = o || {};
  const family = o.family || "Space Mono";
  const weight = o.weight || "Bold";
  await font(family, weight);
  const t = figma.createText();
  t.fontName = { family: family, style: weight };
  t.characters = label;               // <- the fix for empty text nodes
  t.name = o.name || String(label).replace(/\n/g, " ");
  t.fontSize = o.size || 16;
  t.fills = [paint(o.color || "textMain")];
  t.textAutoResize = o.hug === false ? "HEIGHT" : "WIDTH_AND_HEIGHT";
  if (o.width) { t.textAutoResize = "HEIGHT"; t.resize(o.width, t.height); }
  if (o.align) t.textAlignHorizontal = o.align;
  return t;
}

// ---- 3. FRAMES: layoutMode first, then sizing modes, then resize -----------
/** @param {"H"|"V"|"NONE"} dir */
function mkFrame(name, o) {
  o = o || {};
  const f = figma.createFrame();
  f.name = name;
  const mode = o.dir === "V" ? "VERTICAL" : o.dir === "H" ? "HORIZONTAL" : "NONE";
  if (mode !== "NONE") {
    f.layoutMode = mode;                      // set BEFORE sizing modes
    if (o.gap != null) f.itemSpacing = o.gap;
    f.paddingLeft = o.pl != null ? o.pl : (o.pad || 0);
    f.paddingRight = o.pr != null ? o.pr : (o.pad || 0);
    f.paddingTop = o.pt != null ? o.pt : (o.pad || 0);
    f.paddingBottom = o.pb != null ? o.pb : (o.pad || 0);
    f.counterAxisAlignItems = o.cross || "MIN";
    f.primaryAxisAlignItems = o.main || "MIN";
    if (o.w && o.h) {                          // fixed box: FIXED both, then resize
      f.primaryAxisSizingMode = "FIXED";
      f.counterAxisSizingMode = "FIXED";
      f.resize(o.w, o.h);
    } else if (o.h) {                           // fixed cross size (e.g. tab height)
      f.counterAxisSizingMode = "FIXED";
      f.resize(f.width, o.h);
    } else {                                    // hug content
      f.primaryAxisSizingMode = "AUTO";
      f.counterAxisSizingMode = "AUTO";
    }
  } else if (o.w && o.h) { f.resize(o.w, o.h); }
  if (o.fill) f.fills = [paint(o.fill)];
  else if (mode !== "NONE") f.fills = [];       // auto-layout frames: no fill unless asked
  if (o.stroke) { f.strokes = [paint(o.stroke)]; f.strokeWeight = o.sw || 1; }
  if (o.radius) f.cornerRadius = o.radius;
  if (o.grow) f.layoutGrow = o.grow;
  if (o.stretch) f.layoutAlign = "STRETCH";
  return f;
}

/** Resize a frame WITHOUT scaling its children (children must be MIN/MIN). */
function resizeNoScale(frame, w, h) {
  for (const c of frame.children) {
    try { c.constraints = { horizontal: "MIN", vertical: "MIN" }; } catch (e) {}
  }
  frame.resize(w, h);
}

// ---- 4. STYLES: PaintStyle uses .paints; binding is ASYNC ------------------
function paintStyle(styles, name, hex) {
  let s = styles.find((x) => x.name === name);
  if (!s) { s = figma.createPaintStyle(); s.name = name; }
  s.paints = [figma.util.solidPaint(hex)];      // NOT .fills (that is a no-op -> null)
  return s;
}
async function bindFill(node, styleId) {
  if (typeof node.setFillStyleIdAsync === "function") await node.setFillStyleIdAsync(styleId);
}
async function bindStroke(node, styleId) {
  if (typeof node.setStrokeStyleIdAsync === "function") await node.setStrokeStyleIdAsync(styleId);
}

// ---- 5. DYNAMIC-PAGE SAFE ACCESSORS ---------------------------------------
async function byId(id) { return await figma.getNodeByIdAsync(id); } // getNodeById() throws
async function mainOf(instance) { return await instance.getMainComponentAsync(); } // .mainComponent throws
function safeRemove(node) {
  try { if (node && !node.removed) node.remove(); } catch (e) {}
}
/** Remove top-level roots only; never iterate a set whose parent you just removed. */
function removeTopLevel(pred) {
  for (const n of [...figma.currentPage.children]) if (pred(n)) safeRemove(n);
}
function isInsideInstance(node) {
  let p = node.parent;
  while (p) { if (p.type === "INSTANCE") return true; if (p.type === "PAGE") return false; p = p.parent; }
  return false;
}

// ---- 6. ID / SELECTION HELPERS --------------------------------------------
async function findBySvgOrName(root, name) { return root.findOne((n) => n.name === name); }

// ---- 7. INSTANCE TEXT OVERRIDE (per-instance label, safe) -----------------
async function setInstanceText(instance, newLabel, nodeName) {
  const t = nodeName
    ? instance.findOne((n) => n.type === "TEXT" && n.name === nodeName)
    : instance.findOne((n) => n.type === "TEXT");
  if (!t) throw new Error("setInstanceText(): no TEXT node in " + instance.name);
  await font(t.fontName.family, t.fontName.style);  // instance text still needs the font loaded
  t.characters = newLabel;
  return t;
}

// ============================================================================
// USAGE
//   preflight(["bgMain","textAccent"]);            // fail before any write
//   const t = await txt("SETTINGS", { size: 28, color: "textAccent" });
//   const f = mkFrame("Card", { dir: "V", gap: 12, pad: 20, fill: "bgPanel",
//                                stroke: "borderMain", radius: 10 });
//   const s = paintStyle(await figma.getLocalPaintStylesAsync(), "Color / bg", "#03110B");
//   await bindFill(f, s.id);
//   return "ok";
// ============================================================================
