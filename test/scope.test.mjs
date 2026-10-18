/**
 * Unit tests for scope enforcement — the shipped module, not a copy.
 *
 * figma_use hands the agent the whole Plugin API and cannot be sandboxed, so the
 * only defence is: index the tree, run the code, diff, and roll back anything
 * outside the subtree the caller declared. Deletion is the case that destroys a
 * design file, and it is the easiest to catch — a deleted id is simply missing
 * from the "after" index, so the code cannot conceal it.
 *
 * These import plugin/scope.ts directly. They used to be a reimplementation of
 * the logic, which proved nothing about the code that actually runs in Figma.
 */
import { indexTree, indexGlobals, enforceScope } from "../plugin/scope.mjs";

let pass = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; process.stdout.write(`PASS  ${name}\n`); }
  else { fails.push(name); process.stdout.write(`FAIL  ${name}${detail ? "  — " + detail : ""}\n`); }
};

// ---------------------------------------------------------------- fixtures

let n = 0;
const mk = (type, name, parent) => {
  const node = { id: type[0] + ++n, type, name, characters: "", children: [], parent };
  // Pages have no box; everything else does. Mirroring that keeps the fixtures
  // honest about which node types can report geometry.
  if (type !== "PAGE") Object.assign(node, { x: 0, y: 0, width: 100, height: 100 });
  return node;
};

function tree() {
  const page = mk("PAGE", "Page 1", null);
  const safe = mk("FRAME", "SAFE", page); page.children.push(safe);
  const other = mk("FRAME", "OTHER", page); page.children.push(other);
  const deep = mk("FRAME", "DEEP", safe); safe.children.push(deep);
  const leaf = mk("RECTANGLE", "leaf", deep); deep.children.push(leaf);
  const victim = mk("RECTANGLE", "victim", other); other.children.push(victim);
  return { page, safe, other, deep, leaf, victim };
}

const G = () => ({ variables: 0, localStyles: 0, paints: 0 });

/** Runs `fn` against the tree and returns the verdict. */
function run(t, fn, opts = {}) {
  const before = indexTree(t.page);
  const beforeGlobals = G();
  fn();
  return enforceScope({
    before,
    after: indexTree(t.page),
    beforeGlobals,
    afterGlobals: { ...beforeGlobals },
    scopeRootId: opts.scope === undefined ? t.safe.id : opts.scope,
    pageWide: !!opts.pageWide,
    allowGlobalChanges: !!opts.allowGlobal,
    pageSwitched: opts.pageSwitched,
  });
}

const scoped = (extra = {}) => ({ scope: null, ...extra });

// ---------------------------------------------------------------- the core

{
  const t = tree();
  const v = run(t, () => {});
  check("a call that changed nothing passes", v.ok, v.violations.join("; "));
  check("no-op reports an empty effect set",
    v.effects.added === 0 && v.effects.removed === 0 && v.effects.changed === 0);
}

{
  const t = tree();
  const v = run(t, () => {
    const f = mk("RECTANGLE", "new", t.safe);
    t.safe.children.push(f);
  });
  check("creating a node INSIDE the scope is allowed", v.ok, v.violations.join("; "));
  check("…and is counted", v.effects.added === 1, "added=" + v.effects.added);
}

{
  const t = tree();
  const v = run(t, () => {
    const f = mk("RECTANGLE", "stray", t.page);
    t.page.children.push(f);
  });
  check("creating a node OUTSIDE the scope is REFUSED", !v.ok);
  check("…and says which node", v.violations.join(" ").includes("added"), v.violations.join("; "));
}

{
  const t = tree();
  const v = run(t, () => {
    // The destructive case: wipe an unrelated frame.
    t.page.children = t.page.children.filter((c) => c !== t.other);
  });
  check("deleting a node OUTSIDE the scope is REFUSED", !v.ok);
  // OTHER and its child both vanish from the reachable tree, and the page's own
  // child count changes — all three must be named, not just the root of the cut.
  check("…and names every node the cut took, plus the parent it changed",
    v.effects.removed === 2 && v.effects.changed === 1 &&
      v.violations.join(" ").includes("removed"),
    `removed=${v.effects.removed} changed=${v.effects.changed} ${v.violations.join("; ")}`);
}

{
  const t = tree();
  const v = run(t, () => {
    t.leaf.name = "renamed";
  });
  check("renaming a node INSIDE the scope is allowed and counted",
    v.ok && v.effects.changed === 1, `${v.ok} changed=${v.effects.changed}`);
}

{
  const t = tree();
  const v = run(t, () => {
    t.victim.name = "renamed";
  });
  check("renaming a node OUTSIDE the scope is REFUSED", !v.ok);
}

{
  const t = tree();
  // Reparenting a scoped node out of the scope must be caught: it is a delete
  // from the scope's point of view even though the node still exists.
  const v = run(t, () => {
    t.deep.parent = t.other;
    t.safe.children = t.safe.children.filter((c) => c !== t.deep);
    t.other.children.push(t.deep);
  });
  check("reparenting a node OUT of the scope is REFUSED", !v.ok,
    v.violations.join("; "));
}

{
  const t = tree();
  const v = run(t, () => {
    t.deep.parent = t.other;
    t.safe.children = t.safe.children.filter((c) => c !== t.deep);
    t.other.children.push(t.deep);
  }, { pageWide: true });
  check("…unless the caller declared allowPageWide", v.ok, v.violations.join("; "));
}

{
  // Deleting the scope root itself makes containment unprovable.
  const t = tree();
  const v = run(t, () => {
    t.page.children = t.page.children.filter((c) => c !== t.safe);
  });
  check("destroying the scope root is REFUSED", !v.ok);
  check("…because containment cannot be proven",
    v.violations.join(" ").includes("scope root"), v.violations.join("; "));
}

{
  // page-wide run that deletes the scope root: pageWide means the caller opted
  // out, so it stands.
  const t = tree();
  const v = run(t, () => {
    t.page.children = t.page.children.filter((c) => c !== t.safe);
  }, { pageWide: true });
  check("pageWide with a deleted root is allowed", v.ok, v.violations.join("; "));
}

// ---------------------------------------------------------------- globals

{
  const before = G();
  const after = { ...G(), variables: 3 };
  const t = tree();
  const v = enforceScope({
    before: indexTree(t.page), after: indexTree(t.page),
    beforeGlobals: before, afterGlobals: after,
    scopeRootId: t.safe.id, pageWide: false, allowGlobalChanges: false,
  });
  check("variable/style changes are REFUSED by default", !v.ok,
    v.violations.join("; "));
  check("…and are reported with before/after counts",
    v.effects.globals && /0 -> 3/.test(v.effects.globals.variables),
    JSON.stringify(v.effects.globals));
}

{
  const t = tree();
  const v = enforceScope({
    before: indexTree(t.page), after: indexTree(t.page),
    beforeGlobals: G(), afterGlobals: { ...G(), paints: 2 },
    scopeRootId: t.safe.id, pageWide: false, allowGlobalChanges: true,
  });
  check("…unless allowGlobalChanges is set", v.ok, v.violations.join("; "));
}

{
  check("indexGlobals tolerates a figma object with nothing on it",
    JSON.stringify(indexGlobals({})) === JSON.stringify({ variables: 0, localStyles: 0, paints: 0 }),
    JSON.stringify(indexGlobals({})));
  check("indexGlobals reads the real counters",
    indexGlobals({ variables: [1, 2], getLocalStyles: () => [1], paints: [1, 2, 3] }).paints === 3);
}

// ---------------------------------------------------------------- reporting

{
  const t = tree();
  const v = run(t, () => {
    for (let i = 0; i < 20; i++) {
      const f = mk("RECTANGLE", "s" + i, t.page);
      t.page.children.push(f);
    }
  });
  check("a large out-of-scope sweep is REFUSED", !v.ok);
  check("…and the message is truncated, not a 20-item dump",
    v.violations.join(" ").includes("more)"), v.violations.join(" ").slice(0, 160));
}

// ---------------------------------------------------------------- geometry

{
  // The signature used to be type + name + child count + text length, so moving
  // or resizing a node produced an identical signature and the diff reported
  // `changed: 0`. To an agent that reads exactly like "the call did nothing".
  const t = tree();
  const v = run(t, () => { t.leaf.x = 640; });
  check("moving a node is reported as a change", v.effects.changed === 1, `changed=${v.effects.changed}`);
  check("…and moving inside the declared scope still passes", v.ok, v.violations.join("; "));
}

{
  const t = tree();
  const v = run(t, () => { t.leaf.width = 300; t.leaf.height = 180; });
  check("resizing a node is reported as a change", v.effects.changed === 1, `changed=${v.effects.changed}`);
}

{
  // A node dragged out of the subtree it was declared to live in is exactly the
  // case that used to slip through: same name, same type, same child count.
  const t = tree();
  const v = run(t, () => {
    t.other.children.push(t.leaf);
    t.deep.children = t.deep.children.filter((c) => c !== t.leaf);
    t.leaf.parent = t.other;
  });
  check("a node moved out of the declared scope is REFUSED", !v.ok, v.ok ? "passed when it should not" : "");
}

{
  const t = tree();
  const v = run(t, () => {
    t.other.children.push(t.victim);
    t.leaf.children.push(t.victim);
    t.victim.parent = t.leaf;
  });
  check("…and the violation names it as a reparent", !v.ok && /changed|r_t/.test(v.violations.join(" ")));
}

{
  // Pages carry no x/y, so the signature must not pretend they do — an "NaN"
  // suffix would still compare equal between two pages, but it pollutes every
  // signature and hides the real geometry from a reader.
  const t = tree();
  const idx = indexTree(t.page);
  check("a node without a box is indexed without a bogus one",
    !idx.get(t.page.id).sig.includes("NaN"), idx.get(t.page.id).sig);
  check("a node with a box records it", idx.get(t.leaf.id).sig.includes("100x100"), idx.get(t.leaf.id).sig);
}

// ---------------------------------------------------------------- page switch

{
  // The bypass this closes: use_figma indexes ONE page, and the snippet may call
  // figma.setCurrentPageAsync(). Edits it then makes on the other page are
  // invisible to every check here, because the before/after indexes describe the
  // page it left. A round trip (switch away, edit, switch back) leaves the
  // indexed page byte-identical, so only the event can catch it.
  const t = tree();
  const v = run(t, () => {}, { pageSwitched: true });
  check("a page switch during the call is REFUSED even when this page is untouched",
    !v.ok && /current page changed/.test(v.violations.join(" ")), v.violations.join("; "));

  const clean = run(t, () => {});
  check("…and the same untouched call passes without the switch", clean.ok, clean.violations.join("; "));

  const wide = run(t, () => {}, { pageSwitched: true, pageWide: true });
  check("a page switch is refused even with allowPageWide",
    !wide.ok && /current page changed/.test(wide.violations.join(" ")), wide.violations.join("; "));
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log("failed: " + fails.join(", ")); process.exitCode = 1; }