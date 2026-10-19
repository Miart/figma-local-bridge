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
