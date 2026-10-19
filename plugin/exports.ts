/**
 * Export artefacts: an atlas sheet plus the rects that describe it, a 9-slice
 * descriptor, and the states of a component as separate files.
 *
 * WHY THIS IS NOT SNIPPET ARITHMETIC. A manifest that is one pixel off is worse
 * than no manifest at all: the engine slices the neighbouring sprite and nobody
 * can see why. So every number here is tied to the FILE that was produced — the
 * rects are computed in the exported image's own pixels (the PNG's IHDR is read,
 * not assumed), a mismatch between what scale predicted and what the exporter
 * wrote is reported, and the things that make a sheet unsliceable are NAMED:
 * overlapping rects, rects outside the image, drawing that bleeds out of its own
 * box, coordinates that had to be rounded, and names that repeat.
 *
 * Pure: it takes plain facts (ids, names, absolute boxes, sizes) and returns
 * plain objects, so the whole thing is unit-tested against fixtures
 * (test/exports.test.mjs). plugin/tools.ts gathers the facts and the bytes;
 * server/src/export-tools.ts writes the files and checks them again on disk.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Bleed {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Sprite names repeat in real files; report the count, key the entries. */
export const MAX_OVERLAP_REPORT = 10;
/** Above this many sprites the pairwise overlap scan is skipped, and says so. */
export const MAX_OVERLAP_SCAN = 1500;

/**
 * The pixel size a PNG really has, read from its IHDR.
 *
 * Figma's exporter does not always produce exactly `round(size × scale)`, and
 * the manifest has to describe the file that exists. Returns null when the
 * bytes are not a PNG — which is itself a fact the caller reports.
 */
export function pngSize(bytes: Uint8Array | null | undefined): { width: number; height: number } | null {
  if (!bytes || bytes.length < 24) return null;
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return null;
  const tag = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (tag !== "IHDR") return null;
  const be32 = (o: number) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  return { width: be32(16), height: be32(20) };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const isInt = (n: number) => Math.abs(n - Math.round(n)) < 1e-6;

/**
 * Stable keys for a list of layer names, counting in document order.
 *
 * Two sprites named "coin" must not become one entry keyed "coin" — the second
 * is "coin#2", and the count is reported so the caller can rename the layers
 * instead of shipping a manifest nobody can map back to the file.
 */
function keyed(names: string[]): { keys: string[]; duplicateNames: number } {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  // A key must never equal a name that repeats — "coin#2" as a real layer name
  // is not far-fetched, and a key that means two things is worse than no key.
  // Every disambiguated key therefore carries a number, and collisions keep
  // counting up.
  const seen = new Map<string, number>();
  const used = new Set<string>();
  const keys = names.map((n) => {
    if ((counts.get(n) ?? 0) === 1 && !used.has(n)) {
      used.add(n);
      return n;
    }
    let i = (seen.get(n) ?? 0) + 1;
    let key = `${n}#${i}`;
    while (used.has(key)) key = `${n}#${++i}`;
    seen.set(n, i);
    used.add(key);
    return key;
  });
  let duplicateNames = 0;
  for (const c of counts.values()) if (c > 1) duplicateNames++;
  return { keys, duplicateNames };
}

// ---------------------------------------------------------------- atlas

export interface AtlasSpriteFact {
  id: string;
  name: string;
  /** Absolute layout box. */
  box: Rect;
  /** Absolute render box, when it differs from the layout box (shadows, strokes). */
  render?: Rect | null;
  visible?: boolean;
}

export interface AtlasInput {
  sheetId: string;
  sheetName: string;
  /** Absolute layout box of the sheet frame. */
  sheet: Rect;
  /** Direct children of the sheet, in document order. */
  sprites: AtlasSpriteFact[];
  scale: number;
  /** The size of the PNG that was actually produced, when it is known. */
  exportSize?: { width: number; height: number } | null;
  /** Which box the image is: the node's own box, or its bounding box. */
  basis?: "boundingBox" | "nodeBox" | "unmatched" | null;
}

export interface AtlasSprite {
  key: string;
  id: string;
  name: string;
  /** In the EXPORTED image's pixels — the same space the file uses. */
  rect: Rect;
  /** How far the sprite draws beyond its own box, in export pixels. */
  bleed?: Bleed;
}

export interface AtlasManifest {
  sheet: {
    id: string;
    name: string;
    scale: number;
    width: number;
    height: number;
    exportWidth: number;
    exportHeight: number;
    expectedWidth: number;
    expectedHeight: number;
    /** False when the exporter produced something other than width × scale. */
    sizeMatches: boolean;
    /** Which box the image is: the frame's own box, or its bounding box. */
    basis: "boundingBox" | "nodeBox" | "unmatched";
  };
  sprites: AtlasSprite[];
  verification: {
    rounded: number;
    overlaps: number;
    offSheet: number;
    duplicateNames: number;
    bleed: number;
    hidden: number;
    overlapScan: "full" | "skipped";
  };
  warnings: string[];
}

export function atlasManifest(input: AtlasInput): AtlasManifest {
  const { sheet, scale, sprites } = input;
  const warnings: string[] = [];

  // Edges are converted first and rects built from the SAME rounded edges, so
  // two adjacent sprites tile: rounding each rect's width separately would
  // leave a one-pixel seam or overlap between them.
  const edges = sprites.map((s) => ({
    x1: (s.box.x - sheet.x) * scale,
    y1: (s.box.y - sheet.y) * scale,
    x2: (s.box.x + s.box.width - sheet.x) * scale,
    y2: (s.box.y + s.box.height - sheet.y) * scale,
  }));
  let rounded = 0;
  for (const e of edges) for (const v of [e.x1, e.y1, e.x2, e.y2]) if (!isInt(v)) rounded++;

  const { keys, duplicateNames } = keyed(sprites.map((s) => s.name));
  if (duplicateNames) {
    warnings.push(
      `${duplicateNames} sprite name(s) repeat — entries are keyed "name#1", "name#2" in document order; ` +
        `rename the layers if the engine looks sprites up by name`,
    );
  }

  const expectedWidth = Math.round(sheet.width * scale);
  const expectedHeight = Math.round(sheet.height * scale);
  const actual = input.exportSize ?? null;
  const exportWidth = actual ? actual.width : expectedWidth;
  const exportHeight = actual ? actual.height : expectedHeight;
  const sizeMatches = !actual || (actual.width === expectedWidth && actual.height === expectedHeight);
  if (!sizeMatches) {
    warnings.push(
      `the exporter wrote ${actual?.width}x${actual?.height} but ${round2(sheet.width)}x${round2(sheet.height)} at ${scale}x ` +
        `predicts ${expectedWidth}x${expectedHeight} — the rects below are in the file's pixels (${exportWidth}x${exportHeight})`,
    );
  }
  if (rounded) warnings.push(`${rounded} sprite edge(s) were not integral at ${scale}x and were rounded to the nearest pixel`);

  const basis = input.basis ?? "boundingBox";
  if (basis === "nodeBox") {
    warnings.push(
      `the frame has a stroke, and the image is the frame's own box rather than its bounding box: ` +
        `the rects are measured from the node's top-left, matching the image`,
    );
  } else if (basis === "unmatched") {
    warnings.push(
      `the exported image matches neither the frame's box nor its bounding box at ${scale}x — ` +
        `the rects may be offset; export a plain frame with no stroke`,
    );
  }

  const hidden = sprites.filter((s) => s.visible === false).length;
  if (hidden) {
    warnings.push(
      `${hidden} sprite(s) are hidden in the file — they are still in this manifest, and their rects ` +
        `will be whatever is behind them in the image`,
    );
  }

  const items: AtlasSprite[] = sprites.map((s, i) => {
    const e = edges[i];
    const x = Math.round(e.x1);
    const y = Math.round(e.y1);
    const out: AtlasSprite = {
      key: keys[i],
      id: s.id,
      name: s.name,
      rect: { x, y, width: Math.round(e.x2) - x, height: Math.round(e.y2) - y },
    };
    if (s.render) {
      // Anything drawn outside the layout box is cut off by the neighbouring
      // cell (or by the image edge): a fact the artist needs, not an error.
      const left = (s.box.x - s.render.x) * scale;
      const top = (s.box.y - s.render.y) * scale;
      const right = (s.render.x + s.render.width - (s.box.x + s.box.width)) * scale;
      const bottom = (s.render.y + s.render.height - (s.box.y + s.box.height)) * scale;
      if (Math.max(left, top, right, bottom) > 0.5) {
        out.bleed = { left: round2(Math.max(0, left)), top: round2(Math.max(0, top)), right: round2(Math.max(0, right)), bottom: round2(Math.max(0, bottom)) };
      }
    }
    return out;
  });

  const bleed = items.filter((s) => s.bleed).length;
  if (bleed) {
    const first = items.filter((s) => s.bleed).slice(0, 3)
      .map((s) => `${s.key} (${Math.max(s.bleed!.left, s.bleed!.top, s.bleed!.right, s.bleed!.bottom)}px)`);
    warnings.push(
      `${bleed} sprite(s) draw outside their own box: ${first.join(", ")}${bleed > 3 ? ", …" : ""} — ` +
        `a shadow or a stroke reaching into the next cell will be cut off there`,
    );
  }

  const offList = items.filter(
    (s) => s.rect.x < 0 || s.rect.y < 0 || s.rect.x + s.rect.width > exportWidth || s.rect.y + s.rect.height > exportHeight,
  );
  if (offList.length) {
    warnings.push(
      `${offList.length} sprite(s) fall outside the exported image (${exportWidth}x${exportHeight}): ` +
        offList.slice(0, 3).map((s) => `${s.key} at ${s.rect.x},${s.rect.y} ${s.rect.width}x${s.rect.height}`).join("; ") +
        `${offList.length > 3 ? ", …" : ""}`,
    );
  }

  let overlaps = 0;
  const scan: "full" | "skipped" = items.length > MAX_OVERLAP_SCAN ? "skipped" : "full";
  if (scan === "full") {
    const pairs: string[] = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i].rect;
        const b = items[j].rect;
        if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) {
          overlaps++;
          if (pairs.length < MAX_OVERLAP_REPORT) pairs.push(`${items[i].key} ∩ ${items[j].key}`);
        }
      }
    }
    if (overlaps) {
      warnings.push(
        `${overlaps} pair(s) of rects overlap: ${pairs.join(", ")}${overlaps > pairs.length ? ", …" : ""} — ` +
          `an engine that slices by rect cannot tell which sprite a pixel belongs to`,
      );
    }
  } else {
    warnings.push(`overlap check skipped: ${items.length} sprites is above the ${MAX_OVERLAP_SCAN} pairwise scan`);
  }

  return {
    sheet: {
      id: input.sheetId,
      name: input.sheetName,
      scale,
      width: round2(sheet.width),
      height: round2(sheet.height),
      exportWidth,
      exportHeight,
      expectedWidth,
      expectedHeight,
      sizeMatches,
      basis: input.basis ?? "boundingBox",
    },
    sprites: items,
    verification: { rounded, overlaps, offSheet: offList.length, duplicateNames, bleed, hidden, overlapScan: scan },
    warnings,
  };
}

// ---------------------------------------------------------------- 9-slice

export interface InsetBox {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface NineSliceInput {
  width: number;
  height: number;
  /** Explicit insets in DESIGN pixels. */
  insets?: InsetBox | null;
  /** Absolute boxes: the frame, and a child named `9slice` when there is one. */
  guide?: { sheet: Rect; guide: Rect } | null;
  scale: number;
  /** The size of the PNG that was actually produced, when it is known. */
  exportSize?: { width: number; height: number } | null;
}

export interface NineSliceDescriptor {
  design: { width: number; height: number; insets: InsetBox };
  exported: { width: number; height: number; insets: InsetBox };
  /** The stretchable middle, in export pixels. */
  middle: { width: number; height: number };
  /** `border-image-slice: top right bottom left` — in the exported image's pixels. */
  cssBorderImageSlice: string;
  warnings: string[];
}

/**
 * The insets of a 9-slice sprite, from explicit numbers or from a child layer
 * named `9slice` (the rectangle the designer drew where the middle should
 * stretch). Anything that would make the middle impossible is refused with the
 * numbers that caused it.
 */
export function nineSliceDescriptor(input: NineSliceInput): NineSliceDescriptor {
  const { width, height, scale } = input;
  let insets = input.insets ?? null;
  const warnings: string[] = [];

  if (!insets) {
    if (!input.guide) {
      throw new Error(
        "9-slice: no insets given and no child named \"9slice\" to read them from — draw a rectangle " +
          "where the middle should stretch, or pass insets {top, right, bottom, left}",
      );
    }
    const { sheet, guide } = input.guide;
    insets = {
      top: Math.round((guide.y - sheet.y) * 100) / 100,
      left: Math.round((guide.x - sheet.x) * 100) / 100,
      right: Math.round((sheet.x + sheet.width - (guide.x + guide.width)) * 100) / 100,
      bottom: Math.round((sheet.y + sheet.height - (guide.y + guide.height)) * 100) / 100,
    };
    if (Math.min(insets.top, insets.right, insets.bottom, insets.left) < -0.01) {
      throw new Error(
        `9-slice: the "9slice" child sticks out of the frame (top ${insets.top}, right ${insets.right}, ` +
          `bottom ${insets.bottom}, left ${insets.left}) — it must sit inside it`,
      );
    }
  }
  insets = { top: Math.max(0, insets.top), right: Math.max(0, insets.right), bottom: Math.max(0, insets.bottom), left: Math.max(0, insets.left) };

  if (!(width > 0) || !(height > 0)) throw new Error("9-slice: the frame has no size");
  if (insets.left + insets.right >= width || insets.top + insets.bottom >= height) {
    throw new Error(
      `9-slice: insets ${insets.top}/${insets.right}/${insets.bottom}/${insets.left} leave no middle in ` +
        `${round2(width)}x${round2(height)} — left+right and top+bottom must each be smaller than the frame`,
    );
  }

  const px: InsetBox = {
    top: Math.round(insets.top * scale),
    right: Math.round(insets.right * scale),
    bottom: Math.round(insets.bottom * scale),
    left: Math.round(insets.left * scale),
  };
  // The middle is measured against the FILE, not against what scale predicted:
  // Figma's exporter is allowed to round the frame size differently, and CSS
  // slices are read against the image that actually shipped.
  const expectedW = Math.max(1, Math.round(width * scale));
  const expectedH = Math.max(1, Math.round(height * scale));
  const outW = input.exportSize ? input.exportSize.width : expectedW;
  const outH = input.exportSize ? input.exportSize.height : expectedH;
  if (input.exportSize && (outW !== expectedW || outH !== expectedH)) {
    warnings.push(
      `the exporter wrote ${outW}x${outH} but ${round2(width)}x${round2(height)} at ${scale}x predicts ` +
        `${expectedW}x${expectedH} — the slice numbers below are in the file's pixels`,
    );
  }
  const middle = { width: outW - px.left - px.right, height: outH - px.top - px.bottom };
  if (middle.width < 1 || middle.height < 1) {
    warnings.push(
      `at ${scale}x the stretchable middle is ${middle.width}x${middle.height} px — the corners leave nothing to stretch; ` +
        `export at a higher scale or make the frame bigger`,
    );
  }
  if (px.left + px.right >= outW || px.top + px.bottom >= outH) {
    warnings.push(`the exported corners (${px.left}+${px.right} px wide, ${px.top}+${px.bottom} px tall) cover the whole image`);
  }

  return {
    design: { width: round2(width), height: round2(height), insets },
    exported: { width: outW, height: outH, insets: px },
    middle,
    cssBorderImageSlice: `${px.top} ${px.right} ${px.bottom} ${px.left}`,
    warnings,
  };
}

// ---------------------------------------------------------------- states

export interface StateChildFact {
  id: string;
  name: string;
  type: string;
  width: number;
  height: number;
  visible?: boolean;
  /** Variant properties of a variant component, when it is one. */
  variantProperties?: Record<string, string> | null;
}

export interface StateListInput {
  /** The container: a COMPONENT_SET of variants, or a frame/group of layers. */
  nodeType: string;
  /** Property names declared by a COMPONENT_SET. */
  variantPropertyNames?: string[] | null;
  /** Which property names the states; required when the set has several. */
  property?: string | null;
  children: StateChildFact[];
}

export interface StateEntry {
  key: string;
  name: string;
  id: string;
  width: number;
  height: number;
  visible: boolean;
  /** The variant property value this state came from, when it did. */
  value?: string;
}

export interface StateList {
  /** The variant property the names came from, or null when layer names were used. */
  property: string | null;
  states: StateEntry[];
  warnings: string[];
}

/**
 * Which layers are the states, and what each one is called.
 *
 * A COMPONENT_SET names its variants by property (State=hover, …), and when the
 * set declares exactly ONE property the names come from it without asking,
 * because that is a fact about the set, not a guess. Several properties, and the
 * caller has to say which one names the states — otherwise "hover" and "Size=L"
 * would both be plausible and one of them would be wrong.
 */
export function stateList(input: StateListInput): StateList {
  const warnings: string[] = [];
  const children = input.children;
  if (!children.length) throw new Error(`states: ${input.nodeType} has no children to export as states`);

  const declared = (input.variantPropertyNames ?? []).filter(Boolean);
  const anyVariant = children.some((c) => c.variantProperties && Object.keys(c.variantProperties).length);
  let property: string | null = null;
  let values: (string | null)[] = children.map(() => null);

  if (anyVariant) {
    if (input.property) {
      if (!declared.length || !declared.includes(input.property)) {
        throw new Error(
          `states: the variants do not declare a property "${input.property}" — the set has ` +
            `${declared.length ? declared.map((d) => `"${d}"`).join(", ") : "none"}`,
        );
      }
      property = input.property;
    } else if (declared.length === 1) {
      property = declared[0];
    } else if (declared.length > 1) {
      throw new Error(
        `states: the set declares ${declared.length} variant properties (${declared.map((d) => `"${d}"`).join(", ")}) — ` +
          `pass property to say which one names the states`,
      );
    }
    if (property) {
      values = children.map((c) => (c.variantProperties ? c.variantProperties[property as string] ?? null : null));
      const missing = children.filter((c, i) => values[i] === null);
      if (missing.length) {
        warnings.push(
          `${missing.length} child(ren) do not carry "${property}" (${missing.slice(0, 3).map((c) => c.name).join(", ")}) — ` +
            `their layer names are used`,
        );
      }
    }
  } else if (input.property) {
    throw new Error(
      `states: nothing here is a variant, so there is no property "${input.property}" to name the states with — ` +
        `the layer names are used instead (drop the property argument)`,
    );
  }

  const names = children.map((c, i) => values[i] ?? c.name);
  const { keys, duplicateNames } = keyed(names);
  if (duplicateNames) {
    warnings.push(
      `${duplicateNames} state name(s) repeat — entries are keyed "name#1", "name#2" in child order; ` +
        `an engine that switches on the name needs them distinct`,
    );
  }
  const hidden = children.filter((c) => c.visible === false).length;
  if (hidden) warnings.push(`${hidden} state(s) are hidden in the file; they are exported, but the design hides them`);

  return {
    property,
    states: children.map((c, i) => ({
      key: keys[i],
      name: names[i],
      id: c.id,
      width: round2(c.width),
      height: round2(c.height),
      visible: c.visible !== false,
      ...(values[i] !== null ? { value: values[i] as string } : {}),
    })),
    warnings,
  };
}

// ---------------------------------------------------------------- web handoff

/**
 * A web handoff is a FOLDER a developer opens: a preview, a flat spec of every
 * layer, tokens as JSON and CSS, and a README that says what the bundle is not.
 *
 * The failure this module exists to prevent is a spec that looks authoritative
 * and is quietly wrong: a "remaining" colour invented for a gradient, a text
 * style averaged over ranges that have no single style, a font silently assumed
 * to be installed, a hidden layer that the preview never showed. So every fact
 * either comes from the document or is named as missing — and the preview is
 * declared the appearance ground truth, not the generated CSS.
 *
 * Pure: it takes plain facts and returns plain objects. plugin/tools.ts walks
 * the document and checks fonts; server/src/export-tools.ts writes the files
 * and re-reads them. The tests drive this module directly.
 */

export interface HandoffColor {
  r: number;
  g: number;
  b: number;
  /** 0..1; already includes the paint's opacity for solids and text. */
  a?: number;
}

export interface HandoffPaint {
  type: string;
  color?: HandoffColor | null;
  /** Gradient stops keep their own alpha; the paint opacity is in `opacity`. */
  stops?: Array<{ at: number; color: HandoffColor }> | null;
  opacity?: number | null;
  imageHash?: string | null;
  scaleMode?: string | null;
}

export interface HandoffTextStyleFacts {
  font?: { family: string; style: string } | null;
  fontSize?: number | null;
  lineHeight?: { unit: string; value: number } | null;
  letterSpacing?: { unit: string; value: number } | null;
  color?: HandoffColor | null;
  /** Figma's UPPER / LOWER / TITLE / SMALL_CAPS values; ORIGINAL is omitted. */
  textCase?: string | null;
  /** UNDERLINE or STRIKETHROUGH; NONE is omitted. */
  textDecoration?: string | null;
}

export interface HandoffTextSegment extends HandoffTextStyleFacts {
  characters: string;
}

export interface HandoffText extends HandoffTextStyleFacts {
  characters: string;
  align?: string | null;
  /** True when the layer has no single font/size/colour for its whole text. */
  mixed?: boolean;
  /** Per-range facts, when the text is mixed and Figma could report them. */
  segments?: HandoffTextSegment[] | null;
}

export interface HandoffEffect {
  type: string;
  radius?: number;
  offset?: [number, number];
  spread?: number;
  color?: string;
}

export interface HandoffNodeFact {
  id: string;
  parentId: string | null;
  depth: number;
  name: string;
  type: string;
  visible: boolean;
  /** Design pixels relative to the frame's bounding-box origin; null when empty. */
  box: Rect | null;
  /** Relative render bounds when they differ from `box` (shadows, strokes). */
  render?: Rect | null;
  /** Degrees; the box is still the axis-aligned bounds. */
  rotation?: number;
  opacity?: number;
  blend?: string | null;
  radius?: number | number[] | null;
  fills?: HandoffPaint[] | "mixed" | null;
  /** The paint style bound to `fills`, when one is. */
  fillStyle?: string | null;
  strokes?: HandoffPaint[] | "mixed" | null;
  strokeStyle?: string | null;
  strokeWeight?: number | number[] | "mixed" | null;
  strokeAlign?: string | null;
  effects?: HandoffEffect[] | "mixed" | null;
  effectStyle?: string | null;
  isMask?: boolean;
  clips?: boolean;
  constraints?: { horizontal: string; vertical: string } | null;
  layout?: {
    mode: string;
    itemSpacing?: number | null;
    padding?: { top: number; right: number; bottom: number; left: number };
  } | null;
  text?: HandoffText | null;
  /** The text style bound to the layer, when one is. */
  textStyle?: string | null;
}

export interface HandoffFrameFact {
  id: string;
  name: string;
  type: string;
  width: number;
  height: number;
  fileKey?: string | null;
}

export interface HandoffPreviewFact {
  scale: number;
  width: number;
  height: number;
  /** Which box the exporter actually produced. */
  basis?: "boundingBox" | "nodeBox" | "unmatched" | null;
}

export interface HandoffFontCheck {
  checked: number;
  skipped: number;
}

export interface HandoffInput {
  frame: HandoffFrameFact;
  nodes: HandoffNodeFact[];
  /** The scale of the second preview; 1 means only preview.png. */
  scale: number;
  previews: HandoffPreviewFact[];
  missingFonts?: string[];
  /** Font styles the time-boxed check could not confirm either way. */
  uncheckedFonts?: string[];
  fontCheck?: HandoffFontCheck | null;
  rev?: number | null;
}

export interface HandoffBundle {
  spec: any;
  tokens: any;
  css: string;
  readme: string;
  warnings: string[];
  counts: { nodes: number; colors: number; fonts: number; textStyles: number; spacing: number };
}

const channel = (v: number) => Math.max(0, Math.min(255, Math.round((Number(v) || 0) * 255)));
const alpha01 = (v: number | undefined) => Math.max(0, Math.min(1, v === undefined || v === null ? 1 : Number(v)));
const cssNum = (n: number) => String(Math.round(n * 1000) / 1000);

/** Identity of a colour at 8-bit channels and 3 decimals of alpha. */
function colorKey(c: HandoffColor): string {
  return `${channel(c.r)},${channel(c.g)},${channel(c.b)},${Math.round(alpha01(c.a) * 1000) / 1000}`;
}

function colorHex(c: HandoffColor): string {
  const h = (v: number) => channel(v).toString(16).padStart(2, "0");
  return "#" + h(c.r) + h(c.g) + h(c.b);
}

function cssColor(c: HandoffColor): string {
  const a = alpha01(c.a);
  if (a >= 1) return colorHex(c);
  return `rgba(${channel(c.r)}, ${channel(c.g)}, ${channel(c.b)}, ${cssNum(a)})`;
}

/**
 * A CSS-safe token fragment. Style names are arbitrary ("Brand / Primary 500",
 * "Заголовок"), so anything non-ASCII collapses to a separator and a name that
 * would start with a digit gets a prefix. The caller keeps a numeric fallback
 * for names that end up empty.
 */
export function handoffSlug(s: string): string {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

const cssFamily = (family: string) => `${JSON.stringify(family)}, sans-serif`;

const FONT_WEIGHTS: Record<string, number> = {
  thin: 100,
  hairline: 100,
  "extra light": 200,
  "ultra light": 200,
  light: 300,
  regular: 400,
  normal: 400,
  book: 400,
  medium: 500,
  "semi bold": 600,
  semibold: 600,
  "demi bold": 600,
  bold: 700,
  "extra bold": 800,
  extrabold: 800,
  "ultra bold": 800,
  black: 900,
  heavy: 900,
};

/** CSS weight for a Figma style name ("Semi Bold Italic" → 600), or null. */
/**
 * A preview above this many pixels is refused before the export. The byte cap
 * refuses after the fact; this refuses before it, because Figma's rasteriser is
 * fast for a UI frame and slow for a poster: the live runs spent ~4 minutes on
 * a 25.6 MP pair, close to the bridge's own timeout. The cap is on the pixels
 * the export is asked for, the same round(w x scale) x round(h x scale) the
 * preview check uses.
 */
export const HANDOFF_MAX_PIXELS = 24_000_000;

/** Pixels the rasteriser will be asked for at this scale. */
export function handoffPreviewPixels(width: number, height: number, scale: number): number {
  return Math.round(width * scale) * Math.round(height * scale);
}

/** The largest integer scale in 1..scale whose raster fits `max`, or null when even 1x does not. */
export function handoffFittingScale(
  width: number,
  height: number,
  scale: number,
  max: number = HANDOFF_MAX_PIXELS,
): number | null {
  for (let s = Math.floor(scale); s >= 1; s--) {
    if (handoffPreviewPixels(width, height, s) <= max) return s;
  }
  return null;
}

/**
 * A refusal message when the requested scale cannot be rendered within the
 * pixel cap — or null when it can. The message names the raster that would be
 * asked for and the largest scale that fits, so the caller changes one argument
 * instead of guessing.
 */
export function handoffPreviewRefusal(
  width: number,
  height: number,
  scale: number,
  max: number = HANDOFF_MAX_PIXELS,
): string | null {
  const px = (s: number) => handoffPreviewPixels(width, height, s);
  const mp = (n: number) => `${(n / 1e6).toFixed(1)} MP`;
  if (px(1) > max) {
    return (
      `the 1x preview would be ${Math.round(width)}x${Math.round(height)} = ${mp(px(1))}, over the ${mp(max)} cap — ` +
      `pick a smaller frame`
    );
  }
  if (px(scale) > max) {
    const fit = handoffFittingScale(width, height, scale, max) as number;
    return (
      `the ${scale}x preview would be ${Math.round(width * scale)}x${Math.round(height * scale)} = ${mp(px(scale))}, ` +
      `over the ${mp(max)} cap — pass scale: ${fit} (${mp(px(fit))}) or pick a smaller frame`
    );
  }
  return null;
}

export function handoffFontWeight(style: string): number | null {
  const key = String(style || "")
    .toLowerCase()
    .replace(/italic|oblique/g, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return FONT_WEIGHTS[key] ?? null;
}

const isItalic = (style: string) => /italic|oblique/i.test(String(style || ""));

const ALIGN: Record<string, string> = { LEFT: "left", CENTER: "center", RIGHT: "right", JUSTIFIED: "justify" };
function textAlignCss(align: string | null | undefined): string | null {
  return align ? ALIGN[align] ?? null : null;
}

function lineHeightCss(lh: { unit: string; value: number } | null | undefined): string | null {
  if (!lh) return null;
  if (lh.unit === "PIXELS") return `${cssNum(lh.value)}px`;
  if (lh.unit === "PERCENT") return `${cssNum(lh.value)}%`;
  if (lh.unit === "AUTO") return "normal";
  return null;
}

function letterSpacingCss(ls: { unit: string; value: number } | null | undefined): string | null {
  if (!ls) return null;
  if (ls.unit === "PIXELS") return Math.abs(ls.value) < 1e-6 ? "0" : `${cssNum(ls.value)}px`;
  if (ls.unit === "PERCENT") return `${cssNum(ls.value)}%`;
  return null;
}

function textCaseCss(v: string | null | undefined): string | null {
  if (v === "UPPER") return "text-transform: uppercase;";
  if (v === "LOWER") return "text-transform: lowercase;";
  if (v === "TITLE") return "text-transform: capitalize;";
  if (v === "SMALL_CAPS") return "font-variant-caps: small-caps;";
  if (v === "SMALL_CAPS_FORCED") return "font-variant-caps: all-small-caps;";
  return null;
}

function textDecorationCss(v: string | null | undefined): string | null {
  if (v === "UNDERLINE") return "text-decoration: underline;";
  if (v === "STRIKETHROUGH") return "text-decoration: line-through;";
  return null;
}

const fontKey = (f: { family: string; style: string } | null | undefined) => (f ? `${f.family}\u0000${f.style}` : "");
const unitKey = (u: { unit: string; value: number } | null | undefined) =>
  u ? `${u.unit}:${round2(u.value)}` : "";

function textKey(t: HandoffText): string {
  return [
    fontKey(t.font),
    t.fontSize ?? "",
    unitKey(t.lineHeight),
    unitKey(t.letterSpacing),
    t.align ?? "",
    t.textCase ?? "",
    t.textDecoration ?? "",
  ].join("|");
}

function fontFact(f: { family: string; style: string }): any {
  const weight = handoffFontWeight(f.style);
  return {
    family: f.family,
    style: f.style,
    ...(weight !== null ? { weight } : {}),
    ...(isItalic(f.style) ? { italic: true } : {}),
  };
}

function specPaint(p: HandoffPaint, colorNameByKey: Map<string, string>): any {
  if (p.type === "SOLID" && p.color) {
    const token = colorNameByKey.get(colorKey(p.color));
    return { type: "SOLID", color: cssColor(p.color), ...(token ? { token } : {}) };
  }
  if (p.type.startsWith("GRADIENT")) {
    return {
      type: p.type,
      stops: (p.stops ?? []).map((s) => ({ at: round2(s.at), color: cssColor(s.color) })),
      ...(p.opacity !== undefined && p.opacity !== null && p.opacity < 1 ? { opacity: round2(p.opacity) } : {}),
    };
  }
  if (p.type === "IMAGE") {
    return {
      type: "IMAGE",
      ...(p.imageHash ? { imageHash: p.imageHash } : {}),
      ...(p.scaleMode ? { scaleMode: p.scaleMode } : {}),
    };
  }
  return { type: p.type };
}

function specText(t: HandoffText, styleToken: string | null, colorNameByKey: Map<string, string>): any {
  const out: any = { characters: t.characters };
  if (t.align) out.align = t.align;
  if (t.mixed) {
    out.mixed = true;
    out.segments = (t.segments ?? []).map((s) => {
      const seg: any = { characters: s.characters };
      if (s.font) seg.font = fontFact(s.font);
      if (s.fontSize !== undefined && s.fontSize !== null) seg.fontSize = round2(s.fontSize);
      if (s.lineHeight) seg.lineHeight = { unit: s.lineHeight.unit, value: round2(s.lineHeight.value) };
      if (s.letterSpacing) seg.letterSpacing = { unit: s.letterSpacing.unit, value: round2(s.letterSpacing.value) };
      if (s.color) {
        const token = colorNameByKey.get(colorKey(s.color));
        seg.color = cssColor(s.color);
        if (token) seg.token = token;
      }
      if (s.textCase && s.textCase !== "ORIGINAL") seg.textCase = s.textCase;
      if (s.textDecoration && s.textDecoration !== "NONE") seg.textDecoration = s.textDecoration;
      return seg;
    });
    return out;
  }
  if (t.font) out.font = fontFact(t.font);
  if (t.fontSize !== undefined && t.fontSize !== null) out.fontSize = round2(t.fontSize);
  if (t.lineHeight) out.lineHeight = { unit: t.lineHeight.unit, value: round2(t.lineHeight.value) };
  if (t.letterSpacing) out.letterSpacing = { unit: t.letterSpacing.unit, value: round2(t.letterSpacing.value) };
  if (t.color) {
    const token = colorNameByKey.get(colorKey(t.color));
    out.color = cssColor(t.color);
    if (token) out.token = token;
  }
  if (t.textCase && t.textCase !== "ORIGINAL") out.textCase = t.textCase;
  if (t.textDecoration && t.textDecoration !== "NONE") out.textDecoration = t.textDecoration;
  if (styleToken) out.styleToken = styleToken;
  return out;
}

function sameRect(a: Rect | null | undefined, b: Rect | null | undefined): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 &&
    Math.abs(a.width - b.width) < 0.01 && Math.abs(a.height - b.height) < 0.01;
}

export function webHandoff(input: HandoffInput): HandoffBundle {
  const { frame, nodes } = input;
  const warnings: string[] = [];

  let gradients = 0;
  let images = 0;
  let unknownPaints = 0;
  let mixedFills = 0;
  let mixedEffects = 0;
  let effectNodes = 0;
  let masks = 0;
  let hidden = 0;
  let rotated = 0;
  let noBox = 0;
  let mixedText = 0;
  let mixedTextWithoutSegments = 0;
  let incompleteText = 0;
  let negativeSpacing = 0;

  interface ColorGroup {
    color: HandoffColor;
    styles: Set<string>;
    uses: number;
    where: Set<string>;
  }
  const colorGroups = new Map<string, ColorGroup>();
  const useColor = (c: HandoffColor | null | undefined, style: string | null | undefined, where: string) => {
    if (!c) return;
    const key = colorKey(c);
    let g = colorGroups.get(key);
    if (!g) {
      g = { color: { r: c.r, g: c.g, b: c.b, a: alpha01(c.a) }, styles: new Set(), uses: 0, where: new Set() };
      colorGroups.set(key, g);
    }
    if (style) g.styles.add(style);
    g.uses++;
    g.where.add(where);
  };

  const countPaint = (p: HandoffPaint) => {
    if (p.type === "SOLID") return;
    if (p.type.startsWith("GRADIENT")) gradients++;
    else if (p.type === "IMAGE") images++;
    else unknownPaints++;
  };

  for (const n of nodes) {
    if (Array.isArray(n.fills)) {
      for (const p of n.fills) {
        if (p.type === "SOLID") useColor(p.color, n.fillStyle, "fill");
        countPaint(p);
      }
    } else if (n.fills === "mixed") mixedFills++;

    if (Array.isArray(n.strokes)) {
      for (const p of n.strokes) {
        if (p.type === "SOLID") useColor(p.color, n.strokeStyle, "stroke");
        countPaint(p);
      }
    } else if (n.strokes === "mixed") mixedFills++;

    if (n.text) {
      useColor(n.text.color, n.fillStyle, "text");
      for (const s of n.text.segments ?? []) useColor(s.color, null, "text");
      if (n.text.mixed) {
        mixedText++;
        if (!n.text.segments) mixedTextWithoutSegments++;
      } else if (!n.text.font || n.text.fontSize === undefined || n.text.fontSize === null) {
        incompleteText++;
      }
    }

    if (n.effects === "mixed") mixedEffects++;
    else if (Array.isArray(n.effects) && n.effects.length) effectNodes++;
    if (n.isMask) masks++;
    if (!n.visible) hidden++;
    if (n.rotation !== undefined && Math.abs(n.rotation) > 0.01) rotated++;
    if (!n.box) noBox++;
  }

  // ------------------------------------------------------------ colour tokens
  const colors: Record<string, any> = {};
  const colorNameByKey = new Map<string, string>();
  const usedColorNames = new Set<string>();
  const styleToColorKeys = new Map<string, Set<string>>();
  for (const [key, g] of colorGroups) {
    for (const s of g.styles) {
      let set = styleToColorKeys.get(s);
      if (!set) {
        set = new Set();
        styleToColorKeys.set(s, set);
      }
      set.add(key);
    }
  }

  let colorIndex = 0;
  let colorRenames = 0;
  let multiStyleValues = 0;
  for (const [key, g] of colorGroups) {
    colorIndex++;
    const styles = [...g.styles].sort();
    if (styles.length > 1) multiStyleValues++;
    let name = styles.length === 1 ? handoffSlug(styles[0]) : "";
    if (!name) name = `color-${colorIndex}`;
    if (/^[0-9]/.test(name)) name = `c-${name}`;
    if (usedColorNames.has(name)) {
      colorRenames++;
      let base = `color-${colorIndex}`;
      let n = base;
      let i = 2;
      while (usedColorNames.has(n)) n = `${base}-${i++}`;
      name = n;
    }
    usedColorNames.add(name);
    const alpha = alpha01(g.color.a);
    colors[name] = {
      value: cssColor(g.color),
      hex: colorHex(g.color),
      ...(alpha < 1 ? { alpha: Math.round(alpha * 1000) / 1000 } : {}),
      cssVar: `--color-${name}`,
      uses: g.uses,
      ...(styles.length ? { styles } : {}),
      usedFor: [...g.where].sort(),
    };
    colorNameByKey.set(key, name);
  }
  let sharedStyleColors = 0;
  for (const keys of styleToColorKeys.values()) if (keys.size > 1) sharedStyleColors++;

  // ------------------------------------------------------------ text tokens
  interface TextGroup {
    text: HandoffText;
    style: string | null;
    uses: number;
    styleConflict: boolean;
  }
  const textGroups = new Map<string, TextGroup>();
  for (const n of nodes) {
    const t = n.text;
    if (!t || t.mixed || !t.font || t.fontSize === undefined || t.fontSize === null) continue;
    const key = textKey(t);
    let g = textGroups.get(key);
    if (!g) {
      g = { text: t, style: n.textStyle ?? null, uses: 0, styleConflict: false };
      textGroups.set(key, g);
    } else if (g.style && n.textStyle && g.style !== n.textStyle) {
      g.styleConflict = true;
    }
    g.uses++;
  }

  const text: Record<string, any> = {};
  const textTokenByKey = new Map<string, string>();
  const usedTextNames = new Set<string>();
  let textIndex = 0;
  let textRenames = 0;
  for (const [key, g] of textGroups) {
    textIndex++;
    const label = g.styleConflict ? null : g.style;
    let name = label ? handoffSlug(label) : "";
    if (!name) name = `text-${textIndex}`;
    if (/^[0-9]/.test(name)) name = `t-${name}`;
    if (usedTextNames.has(name)) {
      textRenames++;
      let base = `text-${textIndex}`;
      let n = base;
      let i = 2;
      while (usedTextNames.has(n)) n = `${base}-${i++}`;
      name = n;
    }
    usedTextNames.add(name);
    const font = g.text.font!;
    const weight = handoffFontWeight(font.style);
    const entry: any = {
      name,
      cssClass: name,
      font: fontFact(font),
      uses: g.uses,
      ...(g.text.fontSize !== undefined && g.text.fontSize !== null ? { size: round2(g.text.fontSize) } : {}),
      ...(g.text.lineHeight ? { lineHeight: { unit: g.text.lineHeight.unit, value: round2(g.text.lineHeight.value) } } : {}),
      ...(g.text.letterSpacing ? { letterSpacing: { unit: g.text.letterSpacing.unit, value: round2(g.text.letterSpacing.value) } } : {}),
      ...(g.text.align ? { align: g.text.align } : {}),
      ...(g.text.textCase && g.text.textCase !== "ORIGINAL" ? { textCase: g.text.textCase } : {}),
      ...(g.text.textDecoration && g.text.textDecoration !== "NONE" ? { textDecoration: g.text.textDecoration } : {}),
      ...(label ? { style: label } : {}),
      ...(weight === null ? { weightKnown: false } : {}),
    };
    text[name] = entry;
    textTokenByKey.set(key, name);
  }

  // ------------------------------------------------------------ font tokens
  interface FontGroup {
    family: string;
    style: string;
    uses: number;
  }
  const fontGroups = new Map<string, FontGroup>();
  const noteFont = (f: { family: string; style: string } | null | undefined) => {
    if (!f) return;
    const key = fontKey(f);
    let g = fontGroups.get(key);
    if (!g) {
      g = { family: f.family, style: f.style, uses: 0 };
      fontGroups.set(key, g);
    }
    g.uses++;
  };
  for (const n of nodes) {
    if (!n.text) continue;
    noteFont(n.text.font);
    for (const s of n.text.segments ?? []) noteFont(s.font);
  }

  const fonts: Record<string, any> = {};
  const familyVars = new Map<string, string>();
  const familyOrder: { family: string; varName: string }[] = [];
  const usedFamilyVars = new Set<string>();
  const usedFontNames = new Set<string>();
  const unknownWeightStyles: string[] = [];
  let fontIndex = 0;
  for (const g of fontGroups.values()) {
    fontIndex++;
    let familyVar = familyVars.get(g.family);
    if (!familyVar) {
      let fslug = handoffSlug(g.family) || `font-${fontIndex}`;
      if (/^[0-9]/.test(fslug)) fslug = `f-${fslug}`;
      let candidate = `--font-family-${fslug}`;
      let i = 2;
      while (usedFamilyVars.has(candidate)) candidate = `--font-family-${fslug}-${i++}`;
      familyVar = candidate;
      usedFamilyVars.add(candidate);
      familyVars.set(g.family, candidate);
      familyOrder.push({ family: g.family, varName: candidate });
    }
    let fname = `${handoffSlug(g.family) || "font"}-${handoffSlug(g.style) || "style"}`;
    if (/^[0-9]/.test(fname)) fname = `f-${fname}`;
    if (usedFontNames.has(fname)) {
      let base = `font-${fontIndex}`;
      let n = base;
      let i = 2;
      while (usedFontNames.has(n)) n = `${base}-${i++}`;
      fname = n;
    }
    usedFontNames.add(fname);
    const weight = handoffFontWeight(g.style);
    if (weight === null) unknownWeightStyles.push(g.style);
    fonts[fname] = {
      name: fname,
      family: g.family,
      style: g.style,
      ...(weight !== null ? { weight } : {}),
      ...(isItalic(g.style) ? { italic: true } : {}),
      familyVar,
      ...(weight !== null ? { weightVar: `--font-weight-${fname}` } : {}),
      uses: g.uses,
    };
  }

  // ------------------------------------------------------------ spacing tokens
  const spacingValues = new Set<number>();
  const noteSpacing = (v: number | null | undefined) => {
    if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) < 1e-6) return;
    if (v < 0) negativeSpacing++;
    else spacingValues.add(round2(v));
  };
  for (const n of nodes) {
    if (!n.layout) continue;
    noteSpacing(n.layout.itemSpacing);
    if (n.layout.padding) {
      noteSpacing(n.layout.padding.top);
      noteSpacing(n.layout.padding.right);
      noteSpacing(n.layout.padding.bottom);
      noteSpacing(n.layout.padding.left);
    }
  }
  const spacing: Record<string, number> = {};
  for (const v of [...spacingValues].sort((a, b) => a - b)) {
    spacing[`space-${String(v).replace(".", "-")}`] = v;
  }

  // ------------------------------------------------------------ warnings
  if (gradients) warnings.push(`${gradients} gradient fill(s) are not colour tokens — the values are in spec.json`);
  if (images) warnings.push(`${images} image fill(s) are not written as separate files — the preview shows them and spec.json keeps each imageHash`);
  if (unknownPaints) warnings.push(`${unknownPaints} paint(s) of an unknown type are kept as their type only`);
  if (mixedFills) warnings.push(`${mixedFills} mixed paint list(s) are recorded as "mixed" — the document has no single value to name`);
  if (mixedEffects) warnings.push(`${mixedEffects} mixed effect list(s) are recorded as "mixed"`);
  if (effectNodes) warnings.push(`${effectNodes} node(s) carry effects — they are listed in spec.json, not applied by tokens.css`);
  if (masks) warnings.push(`${masks} node(s) are masks — spec.json records isMask; the preview shows the masked result`);
  if (hidden) warnings.push(`${hidden} hidden node(s) are in the spec but not in the preview`);
  if (rotated) warnings.push(`${rotated} node(s) are rotated — box is the axis-aligned bounds and rotation is recorded`);
  if (noBox) warnings.push(`${noBox} node(s) have no box (empty) — box is null in spec.json`);
  if (mixedText) warnings.push(`${mixedText} text node(s) mix fonts, sizes, colours, case or decoration per range — spec.json carries segments`);
  if (mixedTextWithoutSegments) warnings.push(`${mixedTextWithoutSegments} mixed text node(s) did not report segments — only their characters are recorded`);
  if (incompleteText) warnings.push(`${incompleteText} text node(s) have no uniform font/size and are not text tokens`);
  if (negativeSpacing) warnings.push(`${negativeSpacing} negative spacing value(s) are in spec.json but not in spacing tokens`);
  if (multiStyleValues) warnings.push(`${multiStyleValues} colour value(s) are used by more than one paint style — named color-N`);
  if (sharedStyleColors) warnings.push(`${sharedStyleColors} paint style name(s) are bound to more than one colour — those tokens fall back to color-N`);
  if (colorRenames) warnings.push(`${colorRenames} colour token name(s) collided — renamed to color-N`);
  if (textRenames) warnings.push(`${textRenames} text token name(s) collided — renamed to text-N`);
  if (unknownWeightStyles.length) {
    warnings.push(
      `${unknownWeightStyles.length} font style(s) have no CSS weight mapping: ${[...new Set(unknownWeightStyles)].slice(0, 6).join(", ")} — their classes omit font-weight`,
    );
  }
  const missing = input.missingFonts ?? [];
  if (missing.length) {
    warnings.push(
      `${missing.length} font style(s) could not be loaded: ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ", …" : ""} — ` +
        `the tokens name them, but a browser without them will substitute`,
    );
  }
  const unchecked = input.uncheckedFonts ?? [];
  if (unchecked.length) {
    warnings.push(
      `${unchecked.length} font style(s) were not confirmed within the check's time budget: ` +
        `${unchecked.slice(0, 6).join(", ")}${unchecked.length > 6 ? ", …" : ""} — ` +
        `the tokens name them; whether this machine can render them is unknown`,
    );
  }
  if (input.fontCheck && input.fontCheck.skipped > 0) {
    warnings.push(`${input.fontCheck.skipped} font style(s) were not checked for availability`);
  }

  const basisWarned = new Set<string>();
  for (const p of input.previews) {
    const w = Math.round(frame.width * p.scale);
    const h = Math.round(frame.height * p.scale);
    if (p.width !== w || p.height !== h) {
      warnings.push(
        `the ${p.scale}x preview is ${p.width}x${p.height} while ${round2(frame.width)}x${round2(frame.height)} at ${p.scale}x predicts ` +
          `${w}x${h} — the preview is the file that exists; spec boxes are design pixels`,
      );
    }
    if (p.basis === "nodeBox" && !basisWarned.has("nodeBox")) {
      basisWarned.add("nodeBox");
      warnings.push(`the preview is the frame's own box rather than its bounding box — spec boxes are relative to the bounding box and may be offset`);
    }
    if (p.basis === "unmatched" && !basisWarned.has("unmatched")) {
      basisWarned.add("unmatched");
      warnings.push(`the preview matches neither the frame's box nor its bounding box — its origin may not match spec.json`);
    }
  }
  if (!input.previews.some((p) => p.scale === 1)) warnings.push(`no 1x preview was produced — preview.png is missing`);

  // ------------------------------------------------------------ spec
  const specNodes = nodes.map((n) => {
    const out: any = { id: n.id, parent: n.parentId, depth: n.depth, name: n.name, type: n.type, box: n.box ? { ...n.box } : null };
    if (n.render && !sameRect(n.render, n.box)) out.render = { ...n.render };
    if (!n.visible) out.visible = false;
    if (n.rotation !== undefined && Math.abs(n.rotation) > 0.01) out.rotation = round2(n.rotation);
    if (n.opacity !== undefined && n.opacity < 0.999) out.opacity = round2(n.opacity);
    if (n.blend && n.blend !== "PASS_THROUGH" && n.blend !== "NORMAL") out.blend = n.blend;
    if (n.radius !== undefined && n.radius !== null) out.radius = Array.isArray(n.radius) ? n.radius.map(round2) : round2(n.radius);
    if (n.fills === "mixed") out.fills = "mixed";
    else if (Array.isArray(n.fills) && n.fills.length) out.fills = n.fills.map((p) => specPaint(p, colorNameByKey));
    if (n.strokes === "mixed") out.strokes = "mixed";
    else if (Array.isArray(n.strokes) && n.strokes.length) out.strokes = n.strokes.map((p) => specPaint(p, colorNameByKey));
    if (n.strokeWeight !== undefined && n.strokeWeight !== null) {
      out.strokeWeight = Array.isArray(n.strokeWeight) ? n.strokeWeight.map(round2) : n.strokeWeight === "mixed" ? "mixed" : round2(n.strokeWeight);
    }
    if (n.strokeAlign) out.strokeAlign = n.strokeAlign;
    if (n.effects === "mixed") out.effects = "mixed";
    else if (Array.isArray(n.effects) && n.effects.length) out.effects = n.effects;
    if (n.isMask) out.mask = true;
    if (n.clips) out.clip = true;
    if (n.constraints && (n.constraints.horizontal !== "MIN" || n.constraints.vertical !== "MIN")) {
      out.constraints = { horizontal: n.constraints.horizontal, vertical: n.constraints.vertical };
    }
    if (n.layout) {
      out.layout = {
        mode: n.layout.mode,
        ...(n.layout.itemSpacing !== undefined && n.layout.itemSpacing !== null ? { itemSpacing: round2(n.layout.itemSpacing) } : {}),
        ...(n.layout.padding ? { padding: { ...n.layout.padding } } : {}),
      };
    }
    if (n.text) out.text = specText(n.text, n.text.mixed ? null : textTokenByKey.get(textKey(n.text)) ?? null, colorNameByKey);
    const styles: any = {};
    if (n.fillStyle) styles.fill = n.fillStyle;
    if (n.strokeStyle) styles.stroke = n.strokeStyle;
    if (n.textStyle) styles.text = n.textStyle;
    if (n.effectStyle) styles.effect = n.effectStyle;
    if (Object.keys(styles).length) out.styles = styles;
    return out;
  });

  const counts = {
    nodes: nodes.length,
    colors: Object.keys(colors).length,
    fonts: Object.keys(fonts).length,
    textStyles: Object.keys(text).length,
    spacing: Object.keys(spacing).length,
  };

  const spec: any = {
    schema: "figma-web-handoff-spec/v1",
    source: { fileKey: frame.fileKey ?? null, nodeId: frame.id, name: frame.name, type: frame.type, rev: input.rev ?? null },
    space: { units: "px", origin: "top-left of the frame's bounding box", yDown: true },
    frame: { id: frame.id, name: frame.name, type: frame.type, width: round2(frame.width), height: round2(frame.height) },
    counts,
    nodes: specNodes,
    warnings,
  };

  // ------------------------------------------------------------ tokens + css
  const tokens: any = {
    schema: "figma-web-handoff-tokens/v1",
    colors,
    fonts,
    text,
    spacing,
  };

  const css: string[] = [];
  const revNote = input.rev !== undefined && input.rev !== null ? `, rev ${input.rev}` : "";
  css.push(`/* Web handoff tokens — ${frame.name} (${frame.id})${revNote}. Generated by figma-local-bridge. */`);
  css.push(":root {");
  for (const t of Object.values(colors) as any[]) css.push(`  ${t.cssVar}: ${t.value};`);
  for (const f of familyOrder) css.push(`  ${f.varName}: ${cssFamily(f.family)};`);
  for (const f of Object.values(fonts) as any[]) if (f.weightVar) css.push(`  ${f.weightVar}: ${f.weight};`);
  for (const [name, value] of Object.entries(spacing)) css.push(`  --${name}: ${cssNum(value as number)}px;`);
  css.push("}");
  for (const [name, t] of Object.entries(text) as Array<[string, any]>) {
    const familyVar = familyVars.get(t.font.family);
    css.push("");
    css.push(`/* ${t.style ? t.style : name} */`);
    css.push(`.${name} {`);
    if (familyVar) css.push(`  font-family: var(${familyVar});`);
    if (t.font.weight !== undefined) css.push(`  font-weight: ${t.font.weight};`);
    if (t.font.italic) css.push(`  font-style: italic;`);
    if (t.size !== undefined) css.push(`  font-size: ${cssNum(t.size)}px;`);
    const lh = lineHeightCss(t.lineHeight);
    if (lh) css.push(`  line-height: ${lh};`);
    const ls = letterSpacingCss(t.letterSpacing);
    if (ls) css.push(`  letter-spacing: ${ls};`);
    const align = textAlignCss(t.align);
    if (align) css.push(`  text-align: ${align};`);
    const transform = textCaseCss(t.textCase);
    if (transform) css.push(`  ${transform}`);
    const decoration = textDecorationCss(t.textDecoration);
    if (decoration) css.push(`  ${decoration}`);
    css.push("}");
  }

  // ------------------------------------------------------------ readme
  const previewNames = input.previews.map((p) => (p.scale === 1 ? "preview.png" : `preview@${p.scale}x.png`));
  const lines: string[] = [];
  lines.push(`# Web handoff — ${frame.name}`);
  lines.push("");
  lines.push(
    `Source: node \`${frame.id}\` (${frame.type})${frame.fileKey ? ` in \`${frame.fileKey}\`` : ""}${revNote}. ` +
      `Generated by figma-local-bridge.`,
  );
  lines.push("");
  lines.push(
    "This folder is a specification for a developer, not production HTML. The preview is the appearance " +
      "ground truth; `spec.json` and `tokens.*` are the numbers behind it.",
  );
  lines.push("");
  lines.push("## Files");
  lines.push("");
  lines.push("| File | What |");
  lines.push("| --- | --- |");
  for (let i = 0; i < input.previews.length; i++) {
    const p = input.previews[i];
    lines.push(`| ${previewNames[i]} | the frame at ${p.scale}x (${p.width}×${p.height}) |`);
  }
  lines.push("| spec.json | flat layer list, in document order: boxes, text, paints, effects, layout fields |");
  lines.push("| tokens.json | colours, fonts, text styles and spacing as structured data |");
  lines.push("| tokens.css | the same tokens as CSS custom properties, plus one class per text style |");
  lines.push("| handoff.json | this bundle's manifest: file hashes, sizes, counts and warnings. It does not list itself — a file cannot contain its own hash; the tool reply carries `manifestSha256_16` |");
  lines.push("");
  lines.push("## Space");
  lines.push("");
  lines.push(
    "All boxes in `spec.json` are design pixels, origin at the top-left of the frame's bounding box, y down. " +
      "They are absolute positions on the frame, not an auto-layout reconstruction; a rotated node's box is its " +
      "axis-aligned bounds and `rotation` is recorded separately. `radius` is one number, or " +
      "`[top-left, top-right, bottom-right, bottom-left]`.",
  );
  lines.push("");
  lines.push("## Tokens");
  lines.push("");
  lines.push(
    "A colour is named by its paint style when one value belongs to exactly one style; otherwise it is " +
      "`color-N`. Text classes are named by their text style, or `text-N`; fonts are `<family>-<style>`; " +
      "spacing is named by value (`space-16`). A name collision is renamed, never merged.",
  );
  lines.push("");
  lines.push("## What is here");
  lines.push("");
  lines.push(`- ${counts.nodes} node(s) in document order, flat, with \`parent\` and \`depth\`.`);
  lines.push(`- ${counts.colors} colour token(s), ${counts.textStyles} text style(s), ${counts.fonts} font style(s), ${counts.spacing} spacing token(s).`);
  lines.push("- Text content, with per-range segments when a layer mixes fonts, sizes, colours, case or decoration.");
  lines.push("- Effects, blend modes, masks and constraints as data — visible, but not applied by the CSS.");
  lines.push("");
  lines.push("## What is not here");
  lines.push("");
  lines.push("- Production HTML/CSS and responsive behaviour: positions are absolute, as in the frame.");
  lines.push("- Image fills as separate files; the preview contains them and `spec.json` keeps each `imageHash`.");
  lines.push("- Gradient colours as tokens; the gradient values are in `spec.json`.");
  lines.push("- Masks and blend modes applied by `tokens.css`; it only defines variables and text classes.");
  lines.push("- Paragraph spacing/indent, vertical text alignment and OpenType features are not reproduced by `tokens.css`; the preview is the ground truth for those.");
  lines.push("- Embedded fonts; a browser without a named font will substitute its own.");
  lines.push("");
  lines.push("## Warnings");
  lines.push("");
  if (warnings.length) for (const w of warnings) lines.push(`- ${w}`);
  else lines.push("No warnings: every fact the bundle carries was available in the document.");
  lines.push("");

  return { spec, tokens, css: css.join("\n") + "\n", readme: lines.join("\n"), warnings, counts };
}
