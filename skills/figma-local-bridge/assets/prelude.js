// ============================================================================
// figma-local-bridge — SAFE SNIPPET PRELUDE (paste at the top of every
// figma_use code string). Plain JS only: no import/require/process/fs.
// Purpose: remove the recurring failure classes seen in real sessions:
//   - solidPaint() fed a number / object / undefined
//   - text set with `.text` instead of `.characters`
//   - font not loaded before fontName/fontSize/characters
//   - frame.resize() after primaryAxisSizingMode="AUTO" (forces FIXED)
//   - resizing a frame scales its children (constraints) -> knob/fill drift
//   - resizing/moving a node INSIDE an instance (relative-transform / silent no-op)
//   - enum values written from memory (overflowDirection takes "VERTICAL";
//     an unknown option throws and rolls back the whole snippet)
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
/** Refuse geometry edits on an instance child with a readable error (not "relative-transform"). */
function assertGeometryEditable(node) {
  if (isInsideInstance(node)) {
    throw new Error("geometry is locked: '" + node.name + "' is inside an INSTANCE. " +
      "Instance children cannot be resized or moved; change the main component, use a variant, " +
      "or detach (flb.flatten) and edit the returned frame. Text/fills/visibility/opacity still override.");
  }
}
/** Resize that throws a named error on an instance child instead of a silent no-op. */
function setSize(node, w, h) { assertGeometryEditable(node); node.resize(w, h); return node; }
/** Move that throws a named error on an instance child instead of relative-transform. */
function moveTo(node, x, y) { assertGeometryEditable(node); node.x = x; node.y = y; return node; }
/** Resize that verifies the change instead of trusting a silent no-op. */
function resizeTo(node, w, h) {
  assertGeometryEditable(node);
  node.resize(w, h);
  if (Math.abs(node.width - w) > 0.5 || Math.abs(node.height - h) > 0.5) {
    throw new Error("resize() did not apply to '" + node.name + "' (" + node.width + "x" + node.height +
      " instead of " + w + "x" + h + "); do not assign .width/.height either — re-check the node type and layout mode");
  }
  return node;
}
/** Refuse putting a layer INTO an instance: Figma accepts no new children there. */
function assertAcceptsChildren(parent) {
  if (!parent) throw new Error("appendTo: no parent");
  if (parent.type === "INSTANCE") {
    throw new Error("'" + parent.name + "' is an INSTANCE and accepts no new layers. " +
      "Add the layer as an absolutely-positioned sibling (layoutPositioning='ABSOLUTE'), " +
      "put it in the main component, or expose it as a component property (INSTANCE_SWAP).");
  }
  return parent;
}
/** appendChild with the instance-parent trap named up front. */
function appendTo(parent, node) { assertAcceptsChildren(parent); parent.appendChild(node); return node; }

// ---- 6. ID / SELECTION HELPERS --------------------------------------------
async function findBySvgOrName(root, name) { return root.findOne((n) => n.name === name); }

// ---- 7. RUNTIME ENUMS: validate BEFORE the write --------------------------
// An enum setter is validated by the runtime: one unknown string throws and the
// WHOLE snippet is rolled back, after every write before it is already done.
// Never type an enum literal from memory. `setEnum` repairs a known cross-API
// spelling (VERTICAL_SCROLLING -> VERTICAL, ROW -> HORIZONTAL), refuses a typo
// with the nearest accepted value, and otherwise assigns the value for the
// runtime to judge — so an older table never blocks a newer runtime value. The
// bridge's figma_use applies the same policy to `node.prop = "literal"` before
// the snippet is sent.
const ENUMS = {
  overflowDirection: ["NONE", "HORIZONTAL", "VERTICAL", "BOTH"],
  layoutMode: ["NONE", "HORIZONTAL", "VERTICAL", "GRID"],
  primaryAxisSizingMode: ["FIXED", "AUTO"],
  counterAxisSizingMode: ["FIXED", "AUTO"],
  layoutSizingHorizontal: ["FIXED", "HUG", "FILL"],
  layoutSizingVertical: ["FIXED", "HUG", "FILL"],
  layoutAlign: ["MIN", "CENTER", "MAX", "STRETCH", "INHERIT"],
  layoutPositioning: ["AUTO", "ABSOLUTE"],
  primaryAxisAlignItems: ["MIN", "MAX", "CENTER", "SPACE_BETWEEN", "SPACE_EVENLY", "SPACE_AROUND"],
  counterAxisAlignItems: ["MIN", "MAX", "CENTER", "BASELINE"],
  textAutoResize: ["NONE", "WIDTH_AND_HEIGHT", "HEIGHT", "TRUNCATE"],
  textAlignHorizontal: ["LEFT", "CENTER", "RIGHT", "JUSTIFIED"],
  textAlignVertical: ["TOP", "CENTER", "BOTTOM"],
  textCase: ["ORIGINAL", "UPPER", "LOWER", "TITLE", "SMALL_CAPS", "SMALL_CAPS_FORCED"],
  textDecoration: ["NONE", "UNDERLINE", "STRIKETHROUGH"],
  strokeAlign: ["CENTER", "INSIDE", "OUTSIDE"],
  strokeCap: ["NONE", "ROUND", "SQUARE", "ARROW_LINES", "ARROW_EQUILATERAL", "DIAMOND_FILLED", "TRIANGLE_FILLED", "CIRCLE_FILLED"],
  strokeJoin: ["MITER", "BEVEL", "ROUND"],
  scaleMode: ["FILL", "FIT", "CROP", "TILE"],
};
// Spellings borrowed from other layout APIs, repaired instead of rejected.
const ENUM_ALIASES = {
  overflowDirection: { VERTICAL_SCROLLING: "VERTICAL", HORIZONTAL_SCROLLING: "HORIZONTAL", VERTICAL_SCROLL: "VERTICAL", HORIZONTAL_SCROLL: "HORIZONTAL", SCROLLING: "VERTICAL" },
  layoutMode: { ROW: "HORIZONTAL", COLUMN: "VERTICAL" },
  primaryAxisSizingMode: { HUG: "AUTO" },
  counterAxisSizingMode: { HUG: "AUTO" },
  layoutSizingHorizontal: { AUTO: "HUG" },
  layoutSizingVertical: { AUTO: "HUG" },
  textAutoResize: { AUTO: "HEIGHT", WIDTH: "HEIGHT" },
  textAlignHorizontal: { START: "LEFT", END: "RIGHT", JUSTIFY: "JUSTIFIED" },
  textAlignVertical: { MIDDLE: "CENTER" },
  textCase: { CAPS: "UPPER", CAPITALIZE: "TITLE" },
};
/** Levenshtein distance, capped: only "is this a typo?" matters. */
function enumDistance(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 4;
  let prev = [];
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}
/**
 * Normalize, repair or reject an enum value without writing. A known cross-API
 * spelling is mapped to the runtime value; a near-miss throws with the accepted
 * list; anything else passes through for the runtime to validate.
 * @param {string} property
 * @param {string} value
 */
function enumValue(property, value) {
  const accepted = ENUMS[property];
  const normal = String(value).trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (!accepted) return normal; // property newer than this table: runtime decides
  const alias = ENUM_ALIASES[property] && ENUM_ALIASES[property][normal];
  if (alias) return alias;
  if (accepted.indexOf(normal) >= 0) return normal;
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of accepted) {
    const d = enumDistance(normal, candidate);
    if (d < bestDistance) { bestDistance = d; best = candidate; }
  }
  if (bestDistance <= 2) {
    throw new Error("enumValue(): " + property + "=" + JSON.stringify(value) + " looks like a typo; " +
      "did you mean " + JSON.stringify(best) + "? accepted: " + accepted.join(" | "));
  }
  return normal; // possibly a newer runtime value: the setter is authoritative
}
/** Assign an enum property after validation. Fails before writing, not mid-snippet. */
function setEnum(node, property, value) {
  node[property] = enumValue(property, value);
  return node;
}
/**
 * Make a frame scrollable. `clipsContent` must be on for scrolling to show.
 * Accepts "vertical", "VERTICAL", "VERTICAL_SCROLLING", and the rest.
 * @param {FrameNode} frame
 * @param {"none"|"horizontal"|"vertical"|"both"} dir
 */
function setOverflow(frame, dir) {
  const value = enumValue("overflowDirection", dir == null ? "vertical" : dir);
  if (value !== "NONE") frame.clipsContent = true; // scrolling is invisible without it
  frame.overflowDirection = value;                 // VERTICAL, never VERTICAL_SCROLLING
  return frame;
}

// ---- 8. INSTANCE TEXT OVERRIDE (per-instance label, safe) -----------------
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
//   setOverflow(f, "vertical");                    // clipsContent + VERTICAL (not VERTICAL_SCROLLING)
//   setEnum(t, "textAutoResize", "WIDTH_AND_HEIGHT"); // validated before assigning
//   return "ok";
// ============================================================================
