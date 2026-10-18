/**
 * Integration test for the replace engine against a mock `figma`.
 *
 * Why a mock instead of Figma: this is the code that DELETES nodes. The unit
 * tests cover the fingerprint and the scope gate, but nothing covered the
 * command itself — so a single illegal API call (`instance.mainComponent`, which
 * throws outright under documentAccess: dynamic-page) sat in the postcondition
 * and made every real run fail after it had already created the instances and
 * removed the originals. The rollback hid it, so it looked like "the engine
 * refuses".
 *
 * The mock enforces the same constraint Figma does: dynamic-page forbids the
 * synchronous `mainComponent` getter, so a test that uses it fails here exactly
 * as it would in the app.
 */
import { replaceRepeatedWithComponent } from "../plugin/commands.mjs";

let pass = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; process.stdout.write(`PASS  ${name}\n`); }
  else { fails.push(name); process.stdout.write(`FAIL  ${name}${detail ? "  — " + detail : ""}\n`); }
};

// ------------------------------------------------------------------ mock figma

class N {
  constructor(type, name) {
    this.id = type[0] + ++serial;
    this.type = type;
    this.name = name;
    this.children = [];
    this.parent = null;
    this.x = 0; this.y = 0;
    this.width = 100; this.height = 50;
    this.rotation = 0; this.opacity = 1;
    this.blendMode = "NORMAL";
    this.visible = true;
    this.layoutMode = "NONE";
    // Faithfulness: a GROUP has NO constraints and NO auto-layout properties in
    // Figma, while an INSTANCE has all of them with defaults. A mock that gives
    // every node the same property set hides exactly the bug class where the
    // postcondition compares an absent property against a replacement's default.
    if (type !== "GROUP") {
      this.constraints = { horizontal: "MIN", vertical: "MIN" };
      this.layoutSizingHorizontal = "FIXED";
      this.layoutSizingVertical = "FIXED";
      this.layoutWrap = "NO_WRAP";
      this.layoutAlign = "INHERIT";
      this.layoutGrow = 0;
      this.layoutPositioning = "AUTO";
    }
    this.fills = [{ type: "SOLID", color: { r: 0.2, g: 0.2, b: 0.2 }, opacity: 1 }];
    this.strokes = []; this.strokeWeight = 0; this.strokeAlign = "INSIDE"; this.strokeDashes = [];
    this.cornerRadius = 0; this.effects = []; this.characters = "";
    this._data = {};
    all.push(this); // every node must be findable by id, as in Figma
  }
  // Figma's BaseNodeMixin finders. The engine uses them for master lookup.
  findAll(pred) {
    const out = [];
    if (pred(this)) out.push(this);
    const walk = (n) => { for (const c of n.children) { if (pred(c)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  findOne(pred) { return this.findAll(pred)[0] || null; }
  get absoluteBoundingBox() {
    return { x: this.x, y: this.y, width: this.width, height: this.height };
  }
  get relativeTransform() { return [[1, 0, this.x], [0, 1, this.y]]; }
  appendChild(c) { c.parent = this; this.children.push(c); }
  insertChild(i, c) { c.parent = this; this.children.splice(i, 0, c); }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
    const i = all.indexOf(this);
    if (i >= 0) all.splice(i, 1);
  }
  resize(w, h) { this.width = w; this.height = h; }
  setPluginData(k, v) { this._data[k] = v; }
  getPluginData(k) { return this._data[k] ?? ""; }
  clone() { const c = copyOf(this); c.parent = null; return c; }
  // dynamic-page: Figma makes the synchronous getter THROW, so a mock that
  // allows it would silently hide the exact bug this test exists for.
  get mainComponent() {
    throw new Error("Cannot call with documentAccess: dynamic-page. Use node.getMainComponentAsync instead.");
  }
  async getMainComponentAsync() { return this._main || null; }
  createInstance() {
    const i = new N("INSTANCE", this.name);
    i._main = this;
    return i;
  }
}

function copyOf(src) {
  const c = new N(src.type, src.name);
  Object.assign(c, {
    x: src.x, y: src.y, width: src.width, height: src.height,
    fills: JSON.parse(JSON.stringify(src.fills)),
  });
  for (const k of src.children) c.appendChild(copyOf(k));
  return c;
}

let serial = 0;
let all = [];
let undoLog = [];

const PAGE = new N("PAGE", "Page 1");

globalThis.figma = {
  get currentPage() { return PAGE; },
  ui: { postMessage() {} },
  mixed: Symbol("mixed"),
  async getNodeByIdAsync(id) { return all.find((n) => n.id === id) || null; },
  // Figma's createFrame() adds the frame to the CURRENT PAGE. The mock did not,
  // so the __LocalBridgeComponents container ended up outside the tree and
  // findMaster() could never see the master it had just created — which made
  // every idempotency test fail for a reason that did not exist in the product.
  createFrame() { const f = new N("FRAME", "Frame"); PAGE.appendChild(f); return f; },
  createComponentFromNode(node) {
    node.type = "COMPONENT";
    node._data = node._data || {};
    return node;
  },
  commitUndo() { undoLog.push("commit"); },
  triggerUndo() { undoLog.push("undo"); },
};

/** Three identical GROUPs side by side under one frame. */
function fixture(n = 3) {
  all = [PAGE];
  PAGE.children = [];
  serial = 0;
  const frame = new N("FRAME", "ROOT");
  PAGE.appendChild(frame);
  const groups = [];
  for (let i = 0; i < n; i++) {
    // A GROUP has no coordinate space of its own: its children live in the
    // grandparent's space, and its bounding box is the UNION of them. Setting
    // g.x to the grid slot instead is the classic mock mistake — it makes a
    // laid-out cohort look different purely because of where it sits, which is
    // precisely what the fingerprint is required to ignore.
    const gx = 40 + i * 380;
    const gy = 40;
    const g = new N("GROUP", "Group 306");
    const a = new N("RECTANGLE", "outer");
    const b = new N("RECTANGLE", "inner");
    g.appendChild(a);
    g.appendChild(b);
    a.x = gx + 4; a.y = gy + 4; a.width = 292; a.height = 192;
    b.x = gx + 8; b.y = gy + 8; b.width = 284; b.height = 184;
    // union of (4,4,292,192) and (8,8,284,184) relative to the slot
    g.x = gx + 4; g.y = gy + 4; g.width = 292; g.height = 192;
    frame.appendChild(g);
    groups.push(g);
  }
  return { frame, groups };
}

const run = async (params) => {
  undoLog = [];
  const r = await replaceRepeatedWithComponent({
    componentKey: "test/key",
    expectedCount: 3,
    ...params,
  });
  if (!r || typeof r !== "object") throw new Error("engine returned " + JSON.stringify(r));
  if (r.status === "failed") {
    process.stdout.write(`      [engine refused: ${r.reason} ${JSON.stringify(r.detail || r)}]\n`);
  }
  return r;
};

// ------------------------------------------------------------------ tests

{
  const { frame, groups } = fixture(3);
  const r = await run({ sourceId: groups[0].id, dryRun: true });
  check("dryRun performs no mutation", r.status === "dry_run" && r.mutations === 0, JSON.stringify(r.status));
  check("dryRun leaves every node in place",
    frame.children.length === 3 && groups.every((g) => g.parent === frame),
    "children=" + frame.children.length);
  check("dryRun opens no undo step", undoLog.length === 0, undoLog.join(","));
}

{
  const { frame, groups } = fixture(3);
  const r = await run({ sourceId: groups[0].id });
  check("a clean cohort of three is replaced", r.status === "done" || r.status === "ok", JSON.stringify(r.status));
  // The source is NOT spared: it becomes an instance like every other member and
  // its original is deleted, so the file ends as master + 3 instances with no
  // stray GROUP. The leftover GROUP used to read as unfinished work AND broke the
  // next run, because the selector no longer matched anything.
  check("ALL THREE became instances, including the source",
    frame.children.length === 3 && frame.children.every((c) => c.type === "INSTANCE"),
    frame.children.map((c) => c.type).join(","));
  check("…no GROUP is left behind", !frame.children.some((c) => c.type === "GROUP"),
    frame.children.map((c) => c.type).join(","));
  check("…a master component exists", all.some((n) => n.type === "COMPONENT"));
  check("…every original was removed, source included",
    r.removedNodeIds.length === 3 && r.removedNodeIds.includes(groups[0].id),
    JSON.stringify(r.removedNodeIds));
  check("…the source's id is gone from the tree", !all.some((n) => n.id === groups[0].id));
}

{
  // The regression: the postcondition used the synchronous mainComponent getter,
  // which throws under dynamic-page. It fired AFTER creating every instance and
  // removing every original, so every real run rolled back.
  const { frame, groups } = fixture(3);
  const r = await run({ sourceId: groups[0].id });
  check("postconditions do NOT trip the dynamic-page mainComponent ban",
    r.status !== "rolled_back",
    r.status + " " + (r.detail || ""));
  check("…so the command actually committed",
    frame.children.some((c) => c.type === "INSTANCE"), frame.children.map((c) => c.type).join(","));
}

{
  const { groups } = fixture(3);
  const r = await run({ sourceId: groups[0].id, expectedCount: 4 });
  check("a wrong expectedCount is refused before any write",
    r.reason === "COUNT_MISMATCH" && r.mutated === false, JSON.stringify(r));
  check("…and opens no undo step", undoLog.length === 0, undoLog.join(","));
}

{
  // One recoloured member must stop the whole cohort.
  const { groups } = fixture(3);
  groups[2].children[1].fills = [{ type: "SOLID", color: { r: 0.9, g: 0, b: 0 }, opacity: 1 }];
  const r = await run({ sourceId: groups[0].id });
  check("a recoloured member blocks the whole cohort",
    r.reason === "TARGETS_NOT_EQUIVALENT" && r.mutated === false,
    JSON.stringify({ status: r.status, reason: r.reason }));
  check("…and names the odd one out", JSON.stringify(r.divergent || r.different || "").includes(groups[2].id),
    JSON.stringify(r.divergent || r.different || r));
}

{
  const { groups } = fixture(2);
  const r = await run({ sourceId: groups[0].id, expectedCount: 2 });
  check("expectedCount counts the SOURCE too (2 groups -> ok)",
    r.status === "done" || r.status === "ok", JSON.stringify({ status: r.status, reason: r.reason }));
}

{
  const { groups } = fixture(3);
  const r = await run({ sourceId: groups[0].id, match: { name: "Nothing", type: "GROUP" }, expectedCount: undefined });
  check("a selector that does not contain the source is refused",
    r.reason === "SOURCE_NOT_IN_COHORT" && r.mutated === false,
    JSON.stringify({ status: r.status, reason: r.reason }));
}

{
  const { groups } = fixture(3);
  const r = await run({ sourceId: "9:999" });
  check("an unknown source id is refused", r.reason === "SOURCE_NOT_FOUND", JSON.stringify(r));
}

// ---------------------------------------------------------------- idempotency
//
// Your steps 1-4: the master is found by componentKey, the cohort is the
// selector matches PLUS this master's existing instances, and a run where every
// member is already ours answers already_done without touching the file. The
// "is it ours" question is answered by the document — an INSTANCE points at its
// master, and the master carries componentKey in plugin data — so there is no
// second marker that could be forgotten.

{
  const { frame, groups } = fixture(3);
  const first = await run({ sourceId: groups[0].id });
  check("run 1 replaces the whole cohort", first.status === "ok", first.status);
  const sigAfter1 = frame.children.map((c) => c.id).join(",");

  const second = await run({ sourceId: groups[0].id, match: { name: "Group 306", type: "INSTANCE" } });
  check("run 2 answers already_done", second.status === "already_done" && second.mutated === false,
    JSON.stringify({ status: second.status, detail: second.detail }));
  // run() clears undoLog, so "no undo step" means the log is still empty.
  check("run 2 opens no undo step", undoLog.length === 0, undoLog.join(","));
  check("run 2 changes nothing in the tree",
    frame.children.map((c) => c.id).join(",") === sigAfter1);
  check("run 2 counts the existing instances", second.count === 3, "count=" + second.count);
}

{
  // The source id is gone after run 1. A repeat run naming it must degrade to a
  // clear refusal, not a crash and not a silent re-creation.
  const { groups } = fixture(3);
  await run({ sourceId: groups[0].id });
  const again = await run({ sourceId: groups[0].id, match: { name: "Group 306", type: "INSTANCE" } });
  check("a repeat run naming the consumed source still resolves via the master",
    again.status === "already_done", JSON.stringify({ status: again.status, reason: again.reason }));
}

{
  // Interrupted run: some members are already instances, the rest are still the
  // original groups. Only the originals are touched.
  const { frame, groups } = fixture(3);
  await run({ sourceId: groups[0].id });

  // Put the last two back as plain groups to imitate a half-finished run.
  const master = all.find((n) => n.type === "COMPONENT");
  const survivors = frame.children.slice();
  const restored = [];
  for (let k = 0; k < 2; k++) {
    const g = new N("GROUP", "Group 306");
    const a = new N("RECTANGLE", "outer");
    const b = new N("RECTANGLE", "inner");
    g.appendChild(a); g.appendChild(b);
    a.x = 44 + k * 380; a.y = 44; a.width = 292; a.height = 192;
    b.x = 48 + k * 380; b.y = 48; b.width = 284; b.height = 184;
    g.x = a.x; g.y = a.y; g.width = 292; g.height = 192;
    frame.appendChild(g);
    restored.push(g);
  }
  const mixed = await run({ sourceId: restored[0].id, match: { name: "Group 306", type: "GROUP" }, expectedCount: undefined });
  check("a half-finished cohort resumes and finishes",
    mixed.status === "ok", JSON.stringify({ status: mixed.status, reason: mixed.reason, detail: mixed.detail }));
  check("…it replaced only the two remaining groups",
    mixed.replaced === 2, "replaced=" + mixed.replaced);
  check("…and every member is now an instance",
    frame.children.every((c) => c.type === "INSTANCE"),
    frame.children.map((c) => c.type).join(","));
  check("…the pre-existing instances were left alone",
    survivors.every((c) => frame.children.includes(c)), "an earlier instance disappeared");
  check("…the master was reused, not cloned again",
    all.filter((n) => n.type === "COMPONENT").length === 1 && !!master,
    "components=" + all.filter((n) => n.type === "COMPONENT").length);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log("failed: " + fails.join(", ")); process.exitCode = 1; }