/**
 * Semantic and placement snapshots (spec: SemanticSnapshotV1).
 *
 * THREE RULES THAT MATTER MORE THAN THE REST:
 *
 * 1. The hash is an INDEX, never the decision. Two snapshots that land in the
 *    same FNV bucket are still compared by deep equality on their canonical
 *    serialisation. A hash collision therefore cannot authorise a deletion.
 *
 * 2. Nothing is dropped as "default-equivalent". `opacity: 1`, `fills: []` and
 *    `effects: []` are written out explicitly, because they are real states.
 *    Dropping them would make the snapshot non-reproducible once Figma changes
 *    a default — and this snapshot gates DELETION of nodes.
 *
 * 3. Verdict is tri-state. `false` would conflate "we proved these differ" with
 *    "we cannot prove these match". Only the first may authorise a
 *    replacement; the second must stop the operation.
 *
 * Explicitly NOT part of the semantic snapshot (see placement snapshot):
 *   node id, parent id, absolute position, sibling index, constraints,
 *   layout props, and the surrounding backdrop.
 * This establishes LOCAL structural and styling equivalence. It does NOT
 * establish rendered equivalence under a different compositing context.
 */

export const SCHEMA = "semantic-v1";
export const NORMALIZER_VERSION = 1;

export type GeometryStatus = "EXACT" | "STRUCTURAL" | "INCONCLUSIVE";
export type Verdict = "EQUIVALENT" | "DIFFERENT" | "INCONCLUSIVE";

export type FingerprintPolicy = {
  /**
   * How far to trust vector/boolean geometry. V1 only ever *approves* on EXACT.
   */
  vectorGeometry: "exact" | "report-only";
  includeText: boolean;
  includeImageFills: boolean;
  includeVisibility: boolean;
};

export const STRICT: FingerprintPolicy = {
  vectorGeometry: "exact",
  includeText: true,
  includeImageFills: true,
  includeVisibility: true,
};

/** Text differences may later become instance overrides, so V2 can tolerate them. */
export const COMPONENTIZE: FingerprintPolicy = {
  vectorGeometry: "exact",
  includeText: false,
  includeImageFills: true,
  includeVisibility: true,
};

export interface ChildRef {
  type: string;
  rel: [unknown, unknown];
  fp: SemanticSnapshot;
}

export interface SemanticSnapshot {
  schemaVersion: string;
  normalizerVersion: number;
  nodeType: string;
  appearance: Record<string, unknown>;
  geometry: Record<string, unknown>;
  /** How much we trust the geometry above. */
  geometryStatus: GeometryStatus;
  /** Ordered — child order is meaningful. */
  children: ChildRef[];
  /**
   * True if this subtree contains a BOOLEAN_OPERATION. Boolean geometry is
   * compared as a tree, and a tree mismatch can never authorise a difference —
   * it only ever downgrades the verdict to INCONCLUSIVE.
   */
  hasBoolean: boolean;
  /** Diagnostics only. Never affects the verdict. */
  warnings: string[];
  /** Hash index only. Never the basis of a decision. */
  hash: string;
  /**
   * The same hash restricted to one dimension, so a reader can see WHICH part
   * of a node differs from another without a second `compareWith` round trip.
   *
   * `hash` alone cannot answer that: two nodes whose hash differs look equally
   * different whether the fill moved by one notch or the whole layout was
   * rebuilt. These three were declared in the plugin's `inspect` response from
   * the start, computed nothing, and serialised away as `undefined` — the
   * response advertised five fields and delivered two.
   *
   * Verdicts still come from `canonical` equality; never from these.
   */
  appearanceHash: string;
  geometryHash: string;
  childrenHash: string;
  /** Deterministic serialisation; the actual basis of deep equality. */
  canonical: string;
}

const MAX_DEPTH = 12;

// ---------------------------------------------------------------- canonical

const EPS = 1e-3;

function num(n: unknown): number | string {
  if (typeof n !== "number" || !isFinite(n)) return "n/a";
  const v = Math.round(n / EPS) * EPS;
  return Object.is(v, -0) ? 0 : v;
}

function hex(c: any): string {
  if (!c) return "#00000000";
  const h = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, "0");
  const a = typeof c.a === "number" ? c.a : 1;
  return "#" + h(c.r) + h(c.g) + h(c.b) + (a >= 1 ? "" : h(a));
}

/**
 * Deterministic serialisation. Only object KEYS are sorted; arrays are never
 * reordered, because fills/strokes/effects/children are indexed and
 * order-sensitive in Figma's own API.
 */
function canon(value: unknown): string {
  if (value === undefined) return "u";
  if (value === null) return "n";
  if (typeof value === "boolean") return value ? "T" : "F";
  if (typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canon).join(",") + "]";
  const obj = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(obj)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canon(obj[k]))
      .join(",") +
    "}"
  );
}

/** FNV-1a 64. Cheap bucket index; equality is always decided by `canonical`. */
export function hashString(s: string): string {
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * PRIME) & MASK;
  }
  return h.toString(16).padStart(16, "0");
}

// ---------------------------------------------------------------- paints

const EMPTY_PAINTS: unknown[] = [];

function paints(list: any, policy: FingerprintPolicy, warn: (m: string) => void): unknown[] {
  if (!Array.isArray(list)) return EMPTY_PAINTS;
  return list.map((p: any) => {
    switch (p.type) {
      case "SOLID":
        return { t: "SOLID", c: hex(p.color), o: num(p.opacity ?? 1) };
      case "IMAGE":
        return policy.includeImageFills
          ? { t: "IMAGE", scale: p.scaleMode ?? "FILL", src: p.imageHash ?? null, o: num(p.opacity ?? 1) }
          : { t: "IMAGE" };
      case "GRADIENT":
        return {
          t: "GRADIENT",
          kind: p.gradientType,
          stops: (p.gradientStops || []).map((s: any) => ({ pos: num(s.position), c: hex(s.color) })),
          transform: p.gradientTransform ?? null,
          o: num(p.opacity ?? 1),
        };
      default:
        warn("paint type not covered: " + p.type);
        return { t: p.type ?? "UNKNOWN" };
    }
  });
}

function effects(list: any, warn: (m: string) => void): unknown[] {
  if (!Array.isArray(list)) return EMPTY_PAINTS;
  return list.map((e: any) => {
    switch (e.type) {
      case "DROP_SHADOW":
      case "INNER_SHADOW":
        return {
          t: e.type,
          c: hex(e.color),
          o: num(e.opacity ?? 1),
          off: [num(e.offset?.x ?? 0), num(e.offset?.y ?? 0)],
          blur: num(e.radius ?? 0),
          spread: e.spread === undefined ? 0 : num(e.spread),
        };
      case "LAYER_BLUR":
      case "BACKGROUND_BLUR":
        return { t: e.type, r: num(e.radius ?? 0) };
      default:
        warn("effect type not covered: " + e.type);
        return { t: e.type ?? "UNKNOWN" };
    }
  });
}

/**
 * Corners as a tagged union. Figma returns `figma.mixed` for cornerRadius when
 * corners differ; the four individual radii then carry the real values.
 */
function corners(node: any): Record<string, unknown> {
  const r = node.cornerRadius;
  const isMixed = r !== null && typeof r === "object";
  if (!isMixed && typeof r === "number") {
    return { mode: "uniform", radius: num(r) };
  }
  const hasIndividual =
    typeof node.topLeftRadius === "number" ||
    typeof node.topRightRadius === "number" ||
    typeof node.bottomLeftRadius === "number" ||
    typeof node.bottomRightRadius === "number";
  if (hasIndividual) {
    return {
      mode: "individual",
      topLeft: num(node.topLeftRadius ?? 0),
      topRight: num(node.topRightRadius ?? 0),
      bottomRight: num(node.bottomRightRadius ?? 0),
      bottomLeft: num(node.bottomLeftRadius ?? 0),
    };
  }
  return { mode: "mixed", uniform: null };
}

// ---------------------------------------------------------------- geometry

function scalarGeometry(node: any): { geo: Record<string, unknown>; status: GeometryStatus } {
  const geo: Record<string, unknown> = { w: num(node.width), h: num(node.height), rot: num(node.rotation ?? 0) };
  if (node.type === "ELLIPSE") geo.ellipse = true;
  if (node.type === "LINE") geo.line = true;
  return { geo, status: "EXACT" };
}

/**
 * Vector/boolean geometry.
 *
 * `vectorNetwork` is the complete representation; `vectorPaths` alone is
 * partial, so it is never treated as authoritative.
 *
 * BOOLEAN_OPERATION is compared as its boolean TREE (operation + ordered
 * children, recursively) rather than by recomputing the resulting outline.
 * Consequence, deliberately conservative: `Union(A,B,C)` vs `Union(C,A,B)`
 * yields INCONCLUSIVE, never a false "equal".
 */
function vectorGeometry(
  node: any,
  policy: FingerprintPolicy,
  warn: (m: string) => void,
): { geo: Record<string, unknown>; status: GeometryStatus } {
  if (node.type === "BOOLEAN_OPERATION") {
    const op = node.booleanOperation ?? "UNKNOWN";
    warn("boolean compared as tree: " + op);
    return {
      geo: { kind: "boolean", op, children: (node.children || []).length },
      status: "EXACT",
    };
  }

  const net = node.vectorNetwork;
  if (net) {
    return {
      geo: {
        kind: "network",
        verts: net.verts?.length ?? 0,
        segments: net.segments?.length ?? 0,
        regions: net.regions?.length ?? 0,
        digest: hashString(canon(net)),
      },
      status: "EXACT",
    };
  }

  const paths = node.vectorPaths;
  if (paths && paths.length) {
    // Partial representation: usable as a bucketing hint, never as proof.
    warn("vectorPaths is partial; treating geometry as STRUCTURAL");
    return { geo: { kind: "paths-partial", digest: hashString(canon(paths)) }, status: "STRUCTURAL" };
  }

  warn("no geometry representation available");
  return { geo: { kind: "none" }, status: "INCONCLUSIVE" };
}

function geometryFor(node: any, policy: FingerprintPolicy, warn: (m: string) => void) {
  if (node.type === "VECTOR" || node.type === "BOOLEAN_OPERATION") return vectorGeometry(node, policy, warn);
  const { geo, status } = scalarGeometry(node);
  geo.w = num(node.width);
  geo.h = num(node.height);
  if (node.type === "BOOLEAN_OPERATION") return { geo, status };
  return { geo, status };
}

// ---------------------------------------------------------------- snapshot

/**
 * Child offset within the parent's own bounding box.
 *
 * Falls back to the parent-relative x/y only when absolute geometry is missing,
 * which keeps old snapshots reproducible instead of silently becoming null.
 * The subtraction happens on RAW floats and is rounded once by `num`, so no
 * float noise leaks in from rounding two absolute coordinates separately.
 */
function relOffset(parent: any, child: any): [number | string, number | string] {
  const cb = child.absoluteBoundingBox;
  const pb = parent.absoluteBoundingBox;
  if (cb && pb && typeof cb.x === "number" && typeof pb.x === "number") {
    return [num(cb.x - pb.x), num(cb.y - pb.y)];
  }
  return [num(child.x ?? 0), num(child.y ?? 0)];
}

export function snapshot(node: any, policy: FingerprintPolicy = STRICT, depth = 0): SemanticSnapshot {
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);

  const appearance: Record<string, unknown> = {
    opacity: num(node.opacity ?? 1),
    blendMode: node.blendMode ?? "NORMAL",
    fills: paints(node.fills, policy, warn),
    strokes: paints(node.strokes, policy, warn),
    strokeWeight: num(node.strokeWeight ?? 0),
    strokeAlign: node.strokeAlign ?? "INSIDE",
    strokeDashes: Array.isArray(node.strokeDashes) ? node.strokeDashes.map(num) : [],
    corners: corners(node),
    effects: effects(node.effects, warn),
  };

  if (policy.includeVisibility) appearance.visible = node.visible !== false;

  if (node.type === "TEXT") {
    const fn = node.fontName;
    const mixed = !fn || typeof fn !== "object" || !("family" in fn);
    appearance.font = mixed ? "mixed" : { family: fn.family, style: fn.style };
    appearance.fontSize = num(node.fontSize);
    appearance.letterSpacing = node.letterSpacing ? num(node.letterSpacing.value) : 0;
    appearance.textAlign = node.textAlignHorizontal ?? "LEFT";
    if (policy.includeText) appearance.text = node.characters;
  }

  const { geo, status: geometryStatus } = geometryFor(node, policy, warn);

  const children: ChildRef[] = [];
  if ("children" in node && Array.isArray(node.children) && node.children.length && depth < MAX_DEPTH) {
    for (const child of node.children) {
      const fp = snapshot(child, policy, depth + 1);
      children.push({
        type: child.type,
        // Offset inside the PARENT'S OWN BOUNDS, not parent-relative x/y.
        // `child.x` is relative to the parent, so for six sibling groups under
        // one parent it is just their grid slot — which made every laid-out
        // cohort INCONCLUSIVE and blocked the mutation unconditionally.
        // absoluteBoundingBox minus the parent's box is invariant under moving
        // the whole assembly, while still catching children being rearranged
        // inside it, which is what the semantic snapshot is for.
        rel: relOffset(node, child),
        fp,
      });
      for (const w of fp.warnings) warnings.push(`children[${children.length - 1}] ${child.name}: ${w}`);
    }
  }

  const structural = {
    schemaVersion: SCHEMA,
    normalizerVersion: NORMALIZER_VERSION,
    nodeType: node.type,
    appearance,
    geometry: geo,
    geometryStatus,
    children: children.map((c) => ({ type: c.type, rel: c.rel, canonical: c.fp.canonical })),
  };

  const canonical = canon(structural);
  const hasBoolean = node.type === "BOOLEAN_OPERATION" || children.some((c) => c.fp.hasBoolean);

  return {
    schemaVersion: SCHEMA,
    normalizerVersion: NORMALIZER_VERSION,
    nodeType: node.type,
    appearance,
    geometry: geo,
    geometryStatus,
    children,
    hasBoolean,
    warnings,
    hash: hashString(canonical),
    // Per-dimension hashes so `inspect` can say WHICH part differs instead of
    // only that something does. Verdicts still come from `canonical` alone.
    appearanceHash: hashString(canon(structural.appearance)),
    geometryHash: hashString(canon(structural.geometry)),
    childrenHash: hashString(canon(structural.children)),
    canonical,
  };
}

/**
 * A destination fingerprint: the semantic snapshot plus the container layout
 * that decides where a new child lands. The semantic snapshot deliberately
 * excludes layout props, because local equivalence must not depend on flow.
 * A move or a variant insertion asks a different question, so it needs both.
 */
export function containerFingerprint(node: any): string {
  const layout = {
    layoutMode: node.layoutMode ?? null,
    layoutWrap: node.layoutWrap ?? null,
    primaryAxisSizingMode: node.primaryAxisSizingMode ?? null,
    counterAxisSizingMode: node.counterAxisSizingMode ?? null,
    primaryAxisAlignItems: node.primaryAxisAlignItems ?? null,
    counterAxisAlignItems: node.counterAxisAlignItems ?? null,
    itemSpacing: node.itemSpacing ?? null,
    counterAxisSpacing: node.counterAxisSpacing ?? null,
    paddingLeft: node.paddingLeft ?? null,
    paddingRight: node.paddingRight ?? null,
    paddingTop: node.paddingTop ?? null,
    paddingBottom: node.paddingBottom ?? null,
    itemReverseZIndex: node.itemReverseZIndex ?? null,
    strokesIncludedInLayout: node.strokesIncludedInLayout ?? null,
    clipsContent: node.clipsContent ?? null,
    layoutSizingHorizontal: node.layoutSizingHorizontal ?? null,
    layoutSizingVertical: node.layoutSizingVertical ?? null,
    layoutGrids: node.layoutGrids ?? null,
    gridRowCount: node.gridRowCount ?? null,
    gridColumnCount: node.gridColumnCount ?? null,
    gridRowGap: node.gridRowGap ?? null,
    gridColumnGap: node.gridColumnGap ?? null,
  };
  return hashString(`${snapshot(node, STRICT).hash}|${JSON.stringify(layout)}`);
}

// ---------------------------------------------------------------- verdicts

function collectStatuses(s: SemanticSnapshot, acc: Set<GeometryStatus>): void {
  acc.add(s.geometryStatus);
  for (const c of s.children) collectStatuses(c.fp, acc);
}

/**
 * The decision. `canonical` equality is the proof; the hash was never consulted.
 * INCONCLUSIVE wins over DIFFERENT, because a false refusal is survivable and a
 * false approval deletes someone's design.
 */
export function compare(a: SemanticSnapshot, b: SemanticSnapshot): Verdict {
  if (a.schemaVersion !== b.schemaVersion || a.normalizerVersion !== b.normalizerVersion) {
    return "INCONCLUSIVE";
  }
  if (a.canonical === b.canonical) {
    const statuses = new Set<GeometryStatus>();
    collectStatuses(a, statuses);
    collectStatuses(b, statuses);
    if (statuses.has("INCONCLUSIVE")) return "INCONCLUSIVE";
    if (statuses.has("STRUCTURAL")) return "INCONCLUSIVE";
    return "EQUIVALENT";
  }
  // A boolean tree mismatch (e.g. Union(A,B,C) vs Union(C,A,B)) can render
  // identically. We must not claim DIFFERENT, so downgrade instead.
  if (a.hasBoolean || b.hasBoolean) return "INCONCLUSIVE";
  // Structurally different. If the divergence is confined to geometry we only
  // compared partially, we cannot prove they differ either.
  if (divergenceConfinedToUntrustedGeometry(a, b)) return "INCONCLUSIVE";
  return "DIFFERENT";
}

/**
 * True only when the divergence can be attributed to geometry we did NOT fully
 * extract.
 *
 * Appearance/styling is captured completely, so a style difference is TRUSTED:
 * it must yield DIFFERENT, never INCONCLUSIVE. Only geometry whose extraction
 * was partial (vectorPaths-only, no representation at all) can excuse a
 * mismatch.
 */
function divergenceConfinedToUntrustedGeometry(a: SemanticSnapshot, b: SemanticSnapshot): boolean {
  if (a.children.length !== b.children.length) return false;
  for (let i = 0; i < a.children.length; i++) {
    const ca = a.children[i], cb = b.children[i];
    if (ca.type !== cb.type) return false;
    if (ca.rel.join(",") !== cb.rel.join(",")) return false;
    if (ca.fp.canonical === cb.fp.canonical) continue;
    if (ca.fp.geometryStatus === "EXACT" && cb.fp.geometryStatus === "EXACT") return false;
    if (!divergenceConfinedToUntrustedGeometry(ca.fp, cb.fp)) return false;
  }
  // Styles are fully captured, so any styling difference is a real difference.
  if (canon(a.appearance) !== canon(b.appearance)) return false;
  return a.geometryStatus !== "EXACT" || b.geometryStatus !== "EXACT";
}

/** Human-readable divergence. Never emits a bare "mismatch". */
export function explain(a: SemanticSnapshot, b: SemanticSnapshot, path = ""): string[] {
  const out: string[] = [];
  const label = path || "node";
  if (canon(a.appearance) !== canon(b.appearance)) {
    out.push(`${label}.appearance differs`);
    walk(a.appearance, b.appearance, `${label}.appearance`, out);
  }
  if (canon(a.geometry) !== canon(b.geometry)) {
    out.push(`${label}.geometry differs (status ${a.geometryStatus}/${b.geometryStatus})`);
    walk(a.geometry, b.geometry, `${label}.geometry`, out);
  }
  if (a.children.length !== b.children.length) {
    out.push(`${label}: child count ${a.children.length} -> ${b.children.length}`);
  }
  const n = Math.min(a.children.length, b.children.length);
  for (let i = 0; i < n; i++) {
    const ca = a.children[i], cb = b.children[i];
    if (ca.rel.join(",") !== cb.rel.join(",")) {
      out.push(`${label}.children[${i}] rel offset: [${ca.rel}] -> [${cb.rel}]`);
    }
    if (ca.fp.canonical !== cb.fp.canonical) {
      out.push(...explain(ca.fp, cb.fp, `${label}.children[${i}](${ca.type})`));
    }
  }
  return out;
}

function walk(a: unknown, b: unknown, path: string, out: string[]): void {
  if (out.length > 30) return;
  if (canon(a) === canon(b)) return;
  const aObj = a && typeof a === "object";
  const bObj = b && typeof b === "object";
  if (!aObj || !bObj || Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path}: ${canon(a)} -> ${canon(b)}`);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}[length]: ${a.length} -> ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) walk(a[i], b[i], `${path}[${i}]`, out);
    return;
  }
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const va = (a as any)[k], vb = (b as any)[k];
    if (va === undefined && vb === undefined) continue;
    if (va === undefined || vb === undefined) {
      out.push(`${path}.${k}: ${canon(va)} -> ${canon(vb)}`);
      continue;
    }
    walk(va, vb, `${path}.${k}`, out);
  }
}

// ---------------------------------------------------------------- cohort

export interface CohortVerdict {
  verdict: Verdict;
  equivalent: Array<{ id: string; name: string }>;
  different: Array<{ id: string; name: string; why: string[] }>;
  inconclusive: Array<{ id: string; name: string; why: string[] }>;
  warnings: string[];
}

/**
 * All-or-nothing by design. A single INCONCLUSIVE member blocks the cohort:
 * the caller may narrow the target set and retry, but nothing is replaced
 * implicitly.
 */
export function cohort(canonicalId: string, entries: Array<{ id: string; name: string; fp: SemanticSnapshot }>): CohortVerdict {
  const src = entries.find((e) => e.id === canonicalId) ?? entries[0];
  if (!src) {
    return { verdict: "INCONCLUSIVE", equivalent: [], different: [], inconclusive: [], warnings: ["empty cohort"] };
  }
  const warnings: string[] = [];
  if (src.fp.geometryStatus !== "EXACT") {
    warnings.push(`canonical source geometry is ${src.fp.geometryStatus}, not EXACT`);
  }

  const equivalent: CohortVerdict["equivalent"] = [];
  const different: CohortVerdict["different"] = [];
  const inconclusive: CohortVerdict["inconclusive"] = [];

  for (const e of entries) {
    if (e.id === src.id) {
      equivalent.push({ id: e.id, name: e.name });
      continue;
    }
    const v = compare(src.fp, e.fp);
    if (v === "EQUIVALENT") equivalent.push({ id: e.id, name: e.name });
    else if (v === "DIFFERENT") different.push({ id: e.id, name: e.name, why: explain(src.fp, e.fp) });
    else inconclusive.push({ id: e.id, name: e.name, why: explain(src.fp, e.fp) });
  }

  const verdict: Verdict = different.length ? "DIFFERENT" : inconclusive.length ? "INCONCLUSIVE" : "EQUIVALENT";
  return { verdict, equivalent, different, inconclusive, warnings };
}

// ---------------------------------------------------------------- placement

export interface PlacementSnapshot {
  parent: { id: string; type: string; name: string } | null;
  parentLayoutMode: string | null;
  index: number;
  /** Position in the parent's coordinate space. Ignored under auto layout. */
  x: number | string;
  y: number | string;
  relativeTransform: unknown;
  constraints: unknown;
  layoutAlign: string | null;
  layoutGrow: number | null;
  layoutPositioning: string | null;
  layoutSizingHorizontal: string | null;
  layoutSizingVertical: string | null;
  layoutWrap: string | null;
  w: number | string;
  h: number | string;
  minW: number | string | null;
  maxW: number | string | null;
  minH: number | string | null;
  maxH: number | string | null;
  abs: unknown;
  canonical: string;
}

/** "Did THIS target move or change behaviour between validate and mutate?" */
export function placement(node: any): PlacementSnapshot {
  const parent = node.parent;
  const index = parent && "children" in parent ? parent.children.indexOf(node) : -1;
  const pick = (k: string, d: any = null) => (k in node ? (node[k] ?? d) : d);
  const abs = node.absoluteBoundingBox;

  const snap: PlacementSnapshot = {
    parent: parent ? { id: parent.id, type: parent.type, name: parent.name } : null,
    parentLayoutMode: parent && "layoutMode" in parent ? parent.layoutMode ?? "NONE" : null,
    index,
    x: num(node.x ?? 0),
    y: num(node.y ?? 0),
    relativeTransform: node.relativeTransform ?? null,
    constraints: node.constraints ?? null,
    layoutAlign: pick("layoutAlign"),
    layoutGrow: pick("layoutGrow"),
    layoutPositioning: pick("layoutPositioning"),
    layoutSizingHorizontal: pick("layoutSizingHorizontal"),
    layoutSizingVertical: pick("layoutSizingVertical"),
    layoutWrap: pick("layoutWrap"),
    w: num(node.width),
    h: num(node.height),
    minW: "minWidth" in node ? num(node.minWidth) : null,
    maxW: "maxWidth" in node ? num(node.maxWidth) : null,
    minH: "minHeight" in node ? num(node.minHeight) : null,
    maxH: "maxHeight" in node ? num(node.maxHeight) : null,
    abs: abs ? [num(abs.x), num(abs.y), num(abs.width), num(abs.height)] : null,
    canonical: "",
  };
  snap.canonical = canon(snap as unknown as Record<string, unknown>);
  return snap;
}

/**
 * Post-condition. Compares only invariants that MUST survive a replacement.
 * abs is compared with a looser epsilon than scalar layout values because
 * auto-layout can legitimately land sub-pixel differently.
 *
 * `skipIndex` / `onlyIndex` exist because the command proves its replacements in
 * two passes. While the originals are still present each instance sits one slot
 * to the LEFT of its final index, so asserting index then would fail on a
 * perfectly correct replacement; after the removals it is the only thing left
 * worth checking. Splitting it avoids either a false alarm or a skipped check.
 */
export function placementDelta(
  before: PlacementSnapshot,
  after: PlacementSnapshot,
  opts?: { skipIndex?: boolean; onlyIndex?: boolean },
): string[] {
  const out: string[] = [];
  const eq = (a: unknown, b: unknown, path: string, eps: number) => {
    if (typeof a === "number" && typeof b === "number") {
      if (Math.abs(a - b) > eps) out.push(`${path}: ${a} -> ${b}`);
      return;
    }
    if (canon(a) !== canon(b)) out.push(`${path}: ${canon(a)} -> ${canon(b)}`);
  };

  if (canon(before.parent) !== canon(after.parent)) out.push(`parent changed: ${canon(before.parent)} -> ${canon(after.parent)}`);
  if (!opts?.skipIndex && before.index !== after.index) out.push(`index: ${before.index} -> ${after.index}`);
  if (opts?.onlyIndex) return out;

  const autoLayout = !!before.parentLayoutMode && before.parentLayoutMode !== "NONE";
  if (!autoLayout) {
    // With no auto layout the parent does not own position, so x/y IS the
    // placement. Comparing only absoluteBoundingBox would miss a shift.
    eq(before.x, after.x, "x", 0.05);
    eq(before.y, after.y, "y", 0.05);
  }

  eq(before.w, after.w, "width", 0.05);
  eq(before.h, after.h, "height", 0.05);

  // Auto-layout and constraint properties are compared ONLY when both sides
  // actually have them. A GROUP has no layoutWrap/layoutAlign/constraints at
  // all, while the INSTANCE that replaces it does, with defaults. Comparing a
  // property that does not exist on the original against a default on the
  // replacement is not a placement regression — it is the cost of changing node
  // type — and reporting it made every single replacement fail its own
  // postcondition. Absence on both sides is equal; a real value change is still
  // caught because then both sides are present.
  const both = (a: unknown, b: unknown) => a !== null && a !== undefined && b !== null && b !== undefined;
  if (both(before.constraints, after.constraints) && canon(before.constraints) !== canon(after.constraints)) {
    out.push(`constraints: ${canon(before.constraints)} -> ${canon(after.constraints)}`);
  }
  for (const k of ["layoutAlign", "layoutGrow", "layoutPositioning", "layoutSizingHorizontal", "layoutSizingVertical", "layoutWrap"] as const) {
    if (both(before[k], after[k]) && canon(before[k]) !== canon(after[k])) {
      out.push(`${k}: ${canon(before[k])} -> ${canon(after[k])}`);
    }
  }
  if (autoLayout) {
    // Auto layout owns position, so only extent is comparable.
    const bb = Array.isArray(before.abs) ? before.abs.slice(2) : null;
    const ba = Array.isArray(after.abs) ? after.abs.slice(2) : null;
    if (canon(bb) !== canon(ba)) out.push(`abs extent: ${canon(bb)} -> ${canon(ba)}`);
  } else if (canon(before.abs) !== canon(after.abs)) {
    out.push(`absoluteBoundingBox: ${canon(before.abs)} -> ${canon(after.abs)}`);
  }
  return out;
}