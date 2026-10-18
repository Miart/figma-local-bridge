// Unit tests for the fingerprint module. No Figma: nodes are synthetic.
// This snapshot gates DELETION, so the conservative paths are the ones under
// test — an over-permissive bug here destroys a design file.
import {
  SCHEMA, NORMALIZER_VERSION, hashString, snapshot, compare, explain, cohort, placement, placementDelta,
  STRICT, COMPONENTIZE,
} from "../plugin/fingerprint.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; process.stdout.write(`PASS  ${name}\n`); }
  else { fail++; process.stdout.write(`FAIL  ${name}${detail ? "  — " + detail : ""}\n`); }
};

// ---------------------------------------------------------------- fixtures

function node(o = {}) {
  // `origin` models "this node sits inside a parent that starts here". Real
  // Figma keeps absoluteBoundingBox consistent with the tree, and the semantic
  // snapshot reads it to locate children inside their parent — so a fixture
  // whose children's absolute box ignores the parent's move would exercise an
  // impossible state and hide real bugs.
  const [ox, oy] = o.origin ?? [0, 0];
  return {
    type: o.type ?? "RECTANGLE",
    name: o.name ?? "node",
    id: o.id ?? "1:1",
    x: o.x ?? 0, y: o.y ?? 0,
    width: o.w ?? 100, height: o.h ?? 50,
    rotation: o.rotation ?? 0,
    opacity: o.opacity ?? 1,
    blendMode: o.blendMode ?? "NORMAL",
    fills: o.fills ?? [{ type: "SOLID", color: { r: 0.086, g: 0.196, b: 0.29 }, opacity: 1 }],
    strokes: o.strokes ?? [],
    strokeWeight: o.strokeWeight ?? 0,
    strokeAlign: o.strokeAlign ?? "INSIDE",
    strokeDashes: o.strokeDashes ?? [],
    cornerRadius: o.cornerRadius ?? 0,
    effects: o.effects ?? [],
    visible: o.visible ?? true,
    absoluteBoundingBox: {
      x: (o.ax ?? o.x ?? 0) + ox,
      y: (o.ay ?? o.y ?? 0) + oy,
      width: o.w ?? 100,
      height: o.h ?? 50,
    },
    children: o.children ?? [],
    constraints: o.constraints ?? { horizontal: "MIN", vertical: "MIN" },
    layoutSizingHorizontal: o.layoutSizingHorizontal ?? "FIXED",
    layoutSizingVertical: o.layoutSizingVertical ?? "FIXED",
    relativeTransform: o.relativeTransform ?? [[1, 0, o.x ?? 0], [0, 1, o.y ?? 0]],
    parent: o.parent ?? null,
    ...(o.extra || {}),
  };
}

// A GROUP has no coordinate space of its own: moving the group moves its
// children, which is why the child is given the group's origin.
const backdrop = (id, childOver = {}, over = {}) =>
  node({
    type: "GROUP", name: "Group 306", id, w: 1085, h: 1198,
    children: [
      node({
        name: "Rectangle 7905", x: 22, y: 25, w: 1078, h: 1173,
        origin: [over.ax ?? 0, over.ay ?? 0],
        ...childOver,
      }),
    ],
    ...over,
  });

// ---------------------------------------------------------------- versioning

const base = snapshot(backdrop("A"));
check("snapshot carries schema + normalizer version",
  base.schemaVersion === SCHEMA && base.normalizerVersion === NORMALIZER_VERSION);

// ---------------------------------------------------------------- THE property

check("identical backdrops at different absolute positions are EQUIVALENT",
  compare(snapshot(backdrop("A", {}, { ax: 25633, ay: -5523 })), snapshot(backdrop("B", {}, { ax: 999, ay: 40000 }))) === "EQUIVALENT");

check("id and parent are excluded from the snapshot",
  compare(snapshot(backdrop("A")), snapshot({ ...backdrop("ZZZ"), parent: { id: "5:5", type: "FRAME", name: "F", children: [] } })) === "EQUIVALENT");

check("constraints are excluded from the semantic snapshot",
  compare(snapshot(backdrop("A")), snapshot(backdrop("B", {}, { constraints: { horizontal: "MAX", vertical: "STRETCH" } }))) === "EQUIVALENT");

check("relative child offset IS significant",
  compare(snapshot(backdrop("A")), snapshot(backdrop("B", { x: 30 }))) === "DIFFERENT");

check("child size change is DIFFERENT",
  compare(snapshot(backdrop("A")), snapshot(backdrop("B", { w: 900 }))) === "DIFFERENT");

// hash is an index, not the decision
check("equal snapshots share a hash index",
  snapshot(backdrop("A")).hash === snapshot(backdrop("B")).hash);

check("canonical equality is what compare() uses (hash ignored)",
  compare(
    { ...snapshot(backdrop("A")), hash: "deadbeefdeadbeef" },
    { ...snapshot(backdrop("B")), hash: "ffffffffffffffff" },
  ) === "EQUIVALENT");

check("hashString is stable and 16 hex chars",
  hashString("abc") === hashString("abc") && /^[0-9a-f]{16}$/.test(hashString("abc")));

// ---------------------------------------------------------------- defaults are explicit

const withOpacity = snapshot(node({ opacity: 1 }));
const noOpacity = snapshot(node({ opacity: undefined, extra: { opacity: undefined } }));
check("opacity:1 is serialised explicitly, not dropped",
  withOpacity.canonical.includes('"opacity":1'));

const emptyFills = snapshot(node({ fills: [] }));
check("fills:[] is a meaningful state, preserved",
  emptyFills.canonical.includes('"fills":[]'));

// ---------------------------------------------------------------- divergence reporting

const recoloured = snapshot(backdrop("B", { fills: [{ type: "SOLID", color: { r: 0.098, g: 0.227, b: 0.333 }, opacity: 1 }] }));
const why = explain(snapshot(backdrop("A")), recoloured);
check("explain names the specific child", why.some((w) => w.includes("children[0]")));
check("explain names the exact diverging field",
  why.some((w) => w.includes("fills[0].c") && w.includes("#16324a") && w.includes("#193a55")),
  why.filter((w) => w.includes("fills")).join(" | "));

// ---------------------------------------------------------------- corners

const uniform = snapshot(node({ cornerRadius: 12 }));
// figma.mixed is a symbol; the four individual radii carry the real values.
const individual = snapshot(node({
  extra: {
    cornerRadius: Symbol("mixed"),
    topLeftRadius: 12, topRightRadius: 4, bottomRightRadius: 8, bottomLeftRadius: 0,
  },
}));
check("uniform corners serialise as mode=uniform",
  uniform.canonical.includes('"mode":"uniform"') && uniform.canonical.includes('"radius":12'));
check("mixed corners fall back to the four individual radii",
  individual.canonical.includes('"mode":"individual"') && individual.canonical.includes('"topRight":4'));
check("uniform 12 != individual mix", compare(uniform, individual) === "DIFFERENT");

// ---------------------------------------------------------------- vector / boolean

const vecExact = (id) => snapshot(node({ type: "VECTOR", id, extra: { vectorNetwork: { verts: [1, 2, 3], segments: [1, 2], regions: [[0, 1, 2, 3]] }, vectorPaths: null } }));
check("two vectorNodes with identical networks are EQUIVALENT",
  compare(vecExact("V1"), vecExact("V2")) === "EQUIVALENT");

const vecDiff = snapshot(node({ type: "VECTOR", extra: { vectorNetwork: { verts: [1, 2, 9], segments: [1, 2], regions: [[0, 1, 2, 3]] }, vectorPaths: null } }));
check("vectorNetworks that differ are DIFFERENT", compare(vecExact("V1"), vecDiff) === "DIFFERENT");

// vectorPaths only: partial representation must never authorise
const pathsOnly = (id, d = "d0") => snapshot(node({ type: "VECTOR", id, extra: { vectorPaths: [{ data: d }], vectorNetwork: null } }));
check("vectorPaths-only is STRUCTURAL, so identical paths do NOT yield EQUIVALENT",
  compare(pathsOnly("P1"), pathsOnly("P2")) === "INCONCLUSIVE",
  compare(pathsOnly("P1"), pathsOnly("P2")));

// BOOLEAN: compared as a tree, not an outline
const glowKid = (id, over = {}) => node({ type: "RECTANGLE", name: "glow", id, w: 130, h: 130, ...over });
const hexKid = (id, over = {}) => node({ type: "RECTANGLE", name: "hex", id, w: 100, h: 100, fills: [{ type: "SOLID", color: { r: 0.9, g: 0.2, b: 0.2 }, opacity: 1 }], ...over });
const boolUnion = (id, kids) => snapshot(node({
  type: "BOOLEAN_OPERATION", name: "Union", id,
  extra: { booleanOperation: "UNION", children: kids },
}));
const boolA = boolUnion("B1", [glowKid("g1"), hexKid("h1")]);
const boolSame = boolUnion("B2", [glowKid("g2"), hexKid("h2")]);
const boolReordered = boolUnion("B3", [hexKid("h3"), glowKid("g3")]);
check("boolean with identical tree is EQUIVALENT", compare(boolA, boolSame) === "EQUIVALENT");
check("boolean with reordered children is INCONCLUSIVE, never 'equal'",
  compare(boolA, boolReordered) === "INCONCLUSIVE", compare(boolA, boolReordered));
check("boolean with reordered children is not DIFFERENT either",
  compare(boolA, boolReordered) !== "DIFFERENT");

const boolRecoloured = boolUnion("B4", [glowKid("g4", { fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 1 }, opacity: 1 }] }), hexKid("h4")]);
check("recoloured boolean child still downgrades to INCONCLUSIVE, never DIFFERENT",
  compare(boolA, boolRecoloured) === "INCONCLUSIVE", compare(boolA, boolRecoloured));

const noGeometry = snapshot(node({ type: "VECTOR", extra: { vectorPaths: null, vectorNetwork: null } }));
check("no geometry representation is INCONCLUSIVE",
  compare(noGeometry, noGeometry) === "INCONCLUSIVE");

// ---------------------------------------------------------------- policy

const txt = (s) => node({
  type: "TEXT", name: "t",
  extra: {
    characters: s,
    fontName: { family: "Inter", style: "Bold" },
    fontSize: 24, letterSpacing: { value: 0 }, textAlignHorizontal: "LEFT",
  },
});
check("STRICT surfaces text differences", compare(snapshot(txt("TEXT A"), STRICT), snapshot(txt("TEXT B"), STRICT)) === "DIFFERENT");
check("COMPONENTIZE tolerates text differences", compare(snapshot(txt("TEXT A"), COMPONENTIZE), snapshot(txt("TEXT B"), COMPONENTIZE)) === "EQUIVALENT");

// ---------------------------------------------------------------- cohort

const clean = cohort("A", ["A", "B", "C"].map((id) => ({ id, name: "Group 306", fp: snapshot(backdrop(id, {}, { ax: id.charCodeAt(0) * 100 })) })));
check("cohort of identical backdrops is EQUIVALENT", clean.verdict === "EQUIVALENT" && clean.equivalent.length === 3, JSON.stringify(clean.verdict));

const withOdd = cohort("A", [
  { id: "A", name: "G", fp: snapshot(backdrop("A")) },
  { id: "B", name: "G", fp: snapshot(backdrop("B")) },
  { id: "C", name: "G", fp: snapshot(backdrop("C", { fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1 }] })) },
]);
check("one recoloured member makes the cohort DIFFERENT",
  withOdd.verdict === "DIFFERENT" && withOdd.different.length === 1 && withOdd.different[0].id === "C");
check("the divergent member carries an actionable reason",
  withOdd.different[0].why.some((w) => w.includes("fills")));

// Same node type on both sides, but one side's geometry cannot be fully
// extracted: the realistic "we cannot prove it" case.
const vagueCohort = cohort("V1", [
  { id: "V1", name: "Icon", fp: vecExact("V1") },
  { id: "V2", name: "Icon", fp: pathsOnly("V2") },
]);
check("an INCONCLUSIVE member blocks the whole cohort (no implicit replace)",
  vagueCohort.verdict === "INCONCLUSIVE" && vagueCohort.inconclusive.length === 1,
  `${vagueCohort.verdict} diff=${vagueCohort.different.length} inc=${vagueCohort.inconclusive.length}`);

// ------------------------------------------------- laid-out cohorts
//
// Regression: `child.x`/`child.y` are parent-relative, so six sibling groups
// under one parent serialised with their own grid slot baked into the snapshot.
// Every laid-out cohort then came back INCONCLUSIVE and the mutation was blocked
// unconditionally — on a perfect six-of-six. Position belongs to the placement
// snapshot; the semantic snapshot may only use offsets that survive translating
// the whole assembly.

/** A GROUP at grid slot (gx,gy) whose children sit at fixed offsets inside it. */
const slotted = (id, gx, gy) => {
  const kid = (name, kx, ky, w, h, over = {}) =>
    node({ type: "RECTANGLE", name, id: `${id}-${name}`, w, h,
           x: gx + kx, y: gy + ky, ax: gx + kx, ay: gy + ky, ...over });
  return node({
    type: "GROUP", name: "Group 306", id, x: gx, y: gy, ax: gx, ay: gy,
    w: 292, h: 192,
    children: [kid("outer", 4, 4, 292, 192), kid("inner", 8, 8, 284, 184)],
  });
};

const slots = [[0, 0], [380, 0], [760, 0], [0, 260], [380, 260], [760, 260]];
const laid = slots.map(([gx, gy], i) => snapshot(slotted("L" + i, gx, gy)));

let allEquiv = true;
const slotWhy = [];
for (let i = 1; i < laid.length; i++) {
  const v = compare(laid[0], laid[i]);
  if (v !== "EQUIVALENT") {
    allEquiv = false;
    slotWhy.push("L" + i + "=" + v + ": " + explain(laid[0], laid[i]).slice(0, 2).join("; "));
  }
}
check("six identical groups at DIFFERENT grid slots are EQUIVALENT", allEquiv, slotWhy.join(" | "));

// The fix must not turn into a blanket "ignore position": moving a child INSIDE
// the parent is a real structural difference and must still be caught.
const shuffled = snapshot(node({
  type: "GROUP", name: "Group 306", id: "LS", x: 0, y: 0, ax: 0, ay: 0, w: 292, h: 192,
  children: [
    node({ type: "RECTANGLE", name: "inner", id: "LS-b", w: 284, h: 184, x: 8, y: 8, ax: 8, ay: 8 }),
    node({ type: "RECTANGLE", name: "outer", id: "LS-a", w: 292, h: 192, x: 4, y: 4, ax: 4, ay: 4 }),
  ],
}));
check("children reordered inside the parent is still DIFFERENT",
  compare(laid[0], shuffled) === "DIFFERENT",
  compare(laid[0], shuffled) + " " + explain(laid[0], shuffled).slice(0, 2).join("; "));

const innerShifted = snapshot(node({
  type: "GROUP", name: "Group 306", id: "LM", x: 0, y: 0, ax: 0, ay: 0, w: 292, h: 192,
  children: [
    node({ type: "RECTANGLE", name: "outer", id: "LM-a", w: 292, h: 192, x: 20, y: 20, ax: 20, ay: 20 }),
    node({ type: "RECTANGLE", name: "inner", id: "LM-b", w: 284, h: 184, x: 24, y: 24, ax: 24, ay: 24 }),
  ],
}));
check("children shifted WITHIN the parent is still DIFFERENT",
  compare(laid[0], innerShifted) === "DIFFERENT",
  compare(laid[0], innerShifted) + " " + explain(laid[0], innerShifted).slice(0, 2).join("; "));

// ---------------------------------------------------------------- placement

const parentNode = { id: "9:9", type: "FRAME", name: "Frame", layoutMode: "NONE", children: [] };
const a = node({ id: "A", x: 10, y: 20, parent: parentNode });
parentNode.children = [a];
const p1 = placement(a);
const a2 = node({ id: "A2", x: 10, y: 20, parent: parentNode });
parentNode.children = [a2];
const p2 = placement(a2);
check("placement ignores node id", placementDelta(p1, p2).filter((d) => !d.startsWith("parent")).length === 0,
  placementDelta(p1, p2).join(" | "));

// A GROUP has no layoutWrap / layoutAlign / constraints at all; an INSTANCE has
// all of them with defaults. Reporting "absent -> default" as a placement
// regression made every replacement fail its own postcondition and roll back.
{
  const grp = { id: "G1", type: "GROUP", name: "Group 306", parent: parentNode,
    x: 10, y: 20, width: 100, height: 50,
    absoluteBoundingBox: { x: 10, y: 20, width: 100, height: 50 },
    relativeTransform: [[1, 0, 10], [0, 1, 20]] };
  parentNode.children = [grp];
  const inst = {
    id: "I1", type: "INSTANCE", name: "Group 306", parent: parentNode,
    x: 10, y: 20, width: 100, height: 50,
    constraints: { horizontal: "MIN", vertical: "MIN" },
    layoutWrap: "NO_WRAP", layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED",
    absoluteBoundingBox: { x: 10, y: 20, width: 100, height: 50 },
    relativeTransform: [[1, 0, 10], [0, 1, 20]],
  };
  parentNode.children = [inst];
  // snapshot each while it really is the parent's only child, so sibling index
  // is meaningful on both sides
  parentNode.children = [grp];
  const beforeGrp = placement(grp);
  parentNode.children = [inst];
  const afterInst = placement(inst);
  const delta = placementDelta(beforeGrp, afterInst);
  check("a GROUP replaced by an INSTANCE at the same spot is NOT a regression",
    delta.length === 0, delta.join(" | "));
}

// …but a genuine change, when both sides have the property, is still caught.
{
  const f1 = { id: "F1", type: "FRAME", name: "F", parent: parentNode, x: 10, y: 20,
    constraints: { horizontal: "MIN", vertical: "MIN" }, layoutWrap: "NO_WRAP",
    width: 100, height: 50 };
  const f2 = { id: "F2", type: "FRAME", name: "F", parent: parentNode, x: 10, y: 20,
    constraints: { horizontal: "MAX", vertical: "MIN" }, layoutWrap: "NO_WRAP",
    width: 100, height: 50 };
  const delta = placementDelta(placement(f1), placement(f2));
  check("a real constraints change is still reported",
    delta.some((d) => d.startsWith("constraints")), delta.join(" | "));
}

const moved = node({ id: "A3", x: 40, y: 20, parent: parentNode, ax: 30 });
parentNode.children = [moved];
const dMoved = placementDelta(p1, placement(moved));
check("placement detects a moved node", dMoved.some((d) => d.startsWith("x") || d.startsWith("y")),
  dMoved.join(" | "));

const alParent = { id: "7:7", type: "FRAME", name: "Badge", layoutMode: "HORIZONTAL", children: [] };
const inAuto = node({ id: "A4", x: 999, y: 999, parent: alParent });
alParent.children = [inAuto];
const autoA = placement(inAuto);
const autoB = node({ id: "A5", x: -50, y: -50, parent: alParent, ax: -50 });
alParent.children = [autoB];
check("in auto layout, position is not compared — only extent",
  placementDelta(autoA, placement(autoB)).length === 0,
  placementDelta(autoA, placement(autoB)).join(" | "));

const resizedAuto = { ...inAuto, id: "A6", width: 10 };
check("in auto layout a size change IS still caught",
  placementDelta(autoA, placement(resizedAuto)).some((d) => d.startsWith("width")));

const reparented = node({ id: "A7", x: 10, y: 20, parent: { id: "0:0", type: "PAGE", name: "Page", children: [] } });
check("placement catches reparenting",
  placementDelta(p1, placement(reparented)).some((d) => d.startsWith("parent")));

const reordered = { ...parentNode, children: [node({ id: "Z" }), a] };
check("placement catches index change",
  placementDelta(p1, placement({ ...a, parent: reordered })).some((d) => d.startsWith("index")));

// ---------------------------------------------------------------- depth

let deep = node({ type: "RECTANGLE", name: "leaf", fills: [{ type: "SOLID", color: { r: 0.5, g: 0, b: 0 }, opacity: 1 }] });
for (let i = 0; i < 15; i++) deep = node({ name: "w" + i, children: [deep] });
let cursor = snapshot(deep), depthSeen = 0;
while (cursor.children.length) { cursor = cursor.children[0].fp; depthSeen++; }
check("recursion is bounded", depthSeen === 12, "depth " + depthSeen);

process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
process.exit(fail ? 1 : 0);