/**
 * Consequence checking for `figma_use`, as pure functions.
 *
 * WHY THIS IS A SEPARATE MODULE: the decision that matters — "did this
 * arbitrary code touch something it was not allowed to touch?" — is pure data
 * in, data out. It lives here with no reference to the `figma` global, so it can
 * be imported and tested in plain Node. Keeping it inside tools.ts would have
 * meant the only way to test it was to run Figma, and untested scope enforcement
 * is exactly the kind of thing that looks fine and protects nothing.
 *
 * Arbitrary Plugin API code cannot be sandboxed: `figma` is handed to it whole,
 * and any filter on reachable functions is defeated by
 * `figma.currentPage.findAll(n => n.remove())`. So the code is not inspected —
 * the CONSEQUENCES are. The tree is indexed before and after, the diff names
 * exactly which node ids were created, deleted, reparented or altered, and
 * anything outside the declared subtree is a violation the caller rolls back.
 *
 * Deletion, the case that actually destroys a design file, is the easiest one to
 * catch: a deleted id is simply absent from the "after" index, so the code
 * cannot hide it.
 *
 * HONEST LIMITS — all real, none fixable by more effort here:
 *   - Async work that lands after the diff (fire-and-forget promises) escapes.
 *   - Edits inside an existing node are seen only via `signature` (type, name,
 *     child count, text length), not pixel-exact.
 *   - Variables, styles and paints are page-global and belong to no subtree, so
 *     they are counted separately and reported as global changes.
 * This is "detect and undo", never "prevent".
 */

export type Entry = { sig: string; parent: string | null };
export type TreeIndex = Map<string, Entry>;
export type Globals = Record<string, number>;

/**
 * Cheap enough to run twice on any page; specific enough to name a change.
 *
 * Geometry is part of the signature on purpose. Without it, moving or resizing
 * a node produced an identical signature and the diff reported `changed: 0` —
 * which reads as "the call did nothing" when in fact it moved half the
 * document. It also means a node dragged out of its declared scope used to be
 * invisible to containment checking.
 *
 * `childCount` may be passed in when the caller has already read `n.children`
 * for its own traversal. Under `documentAccess: "dynamic-page"` a property read
 * on a node that is not yet hydrated can force a load, so touching the child
 * list once per node is the difference between a snappy call and a stalling one.
 */
export function signature(n: any, childCount?: number): string {
  const kids = childCount === undefined ? (n.children ? n.children.length : 0) : childCount;
  let sig = n.type + " " + (n.name ?? "") + " c" + kids;
  if (n.type === "TEXT") sig += " t" + String(n.characters ?? "").length;
  // Nodes that cannot report a box (a PAGE has no position) simply omit it.
  try {
    if (Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.width) && Number.isFinite(n.height)) {
      sig += " @" + Math.round(n.x) + "," + Math.round(n.y) + " " + Math.round(n.width) + "x" + Math.round(n.height);
    }
  } catch {
    /* no geometry on this node type */
  }
  return sig;
}

/** Indexes a node and its descendants. `root` may be a PAGE. */
export function indexTree(root: any): TreeIndex {
  const idx: TreeIndex = new Map();
  const visit = (n: any, parentId: string | null) => {
    const kids = n.children;
    idx.set(n.id, { sig: signature(n, kids ? kids.length : 0), parent: parentId });
    if (kids) for (let i = 0; i < kids.length; i++) visit(kids[i], n.id);
  };
  // The root may be a subtree, not the page: its own parent is still part of the
  // index because containment checking walks up from a changed id. Every other
  // parent id comes from the traversal, so the hot loop does not read
  // `n.parent` again for each node.
  visit(root, root.parent ? root.parent.id : null);
  return idx;
}

/** Page-global state that no node subtree can contain. */
export function indexGlobals(figmaApi: any): Globals {
  return {
    variables: figmaApi && figmaApi.variables ? figmaApi.variables.length : 0,
    localStyles:
      figmaApi && typeof figmaApi.getLocalStyles === "function"
        ? figmaApi.getLocalStyles().length
        : 0,
    paints: figmaApi && figmaApi.paints ? figmaApi.paints.length : 0,
  };
}

export function diffTrees(before: TreeIndex, after: TreeIndex) {
  const added: string[] = [];
  const changed: string[] = [];
  for (const [id, e] of after) {
    const b = before.get(id);
    if (!b) added.push(id);
    else if (b.sig !== e.sig || b.parent !== e.parent) changed.push(id);
  }
  const removed: string[] = [];
  for (const id of before.keys()) if (!after.has(id)) removed.push(id);
  return { added, removed, changed };
}

export function diffGlobals(before: Globals, after: Globals): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(after)) {
    if (before[k] !== after[k]) out[k] = `${before[k]} -> ${after[k]}`;
  }
  return out;
}

/**
 * True when `id` lies inside the declared scope. Walks parent links in the AFTER
 * index so it works for ids that did not exist before the call; ids that were in
 * the scope before are accepted directly, because a moved node's new ancestors
 * may no longer resolve.
 */
export function withinScope(
  id: string,
  after: TreeIndex,
  scopeRootId: string,
  beforeScope: Set<string>,
): boolean {
  let cur: string | null = id;
  let guard = 0;
  while (cur && guard++ < 100_000) {
    if (cur === scopeRootId) return true;
    if (beforeScope.has(cur)) return true;
    const e = after.get(cur);
    if (!e) return false;
    cur = e.parent;
  }
  return false;
}

export type ScopeVerdict = {
  ok: boolean;
  /** Human-readable reasons, safe to hand straight to an agent. */
  violations: string[];
  effects: {
    added: number;
    removed: number;
    changed: number;
    scope: string;
    globals?: Record<string, string>;
  };
};

/**
 * The decision. Pure: give it both indexes and the declared intent, and it says
 * whether the call may stand.
 *
 * `pageWide` disables scope containment entirely; `allowGlobalChanges` permits
 * variables/styles/paints edits. Both must be explicit at the call site.
 */
export function enforceScope(o: {
  before: TreeIndex;
  after: TreeIndex;
  beforeGlobals: Globals;
  afterGlobals: Globals;
  scopeRootId: string | null;
  pageWide: boolean;
  allowGlobalChanges: boolean;
  /**
   * True when `currentpagechange` fired while the code was running. A page
   * switch is the one way to write something the diff cannot see: this call
   * indexes ONE page, and `figma.setCurrentPageAsync()` moves the ground under
   * it — the code can edit another page, switch back, and leave both indexes
   * identical. A round trip is still caught, because the event fires.
   */
  pageSwitched?: boolean;
}): ScopeVerdict {
  const diff = diffTrees(o.before, o.after);
  const globals = diffGlobals(o.beforeGlobals, o.afterGlobals);
  const violations: string[] = [];

  if (o.pageSwitched) {
    violations.push(
      "the current page changed during the call (figma.setCurrentPageAsync): edits made on the " +
        "other page are outside this guard's index and cannot be verified",
    );
  }

  // A scope root that no longer exists means containment cannot be proven at
  // all, so nothing inside it can be vouched for. Irrelevant under pageWide,
  // where there is no declared scope to violate in the first place.
  const scopeLost = !o.pageWide && !!o.scopeRootId && !o.after.has(o.scopeRootId);
  if (scopeLost) violations.push(`scope root ${o.scopeRootId} no longer exists`);

  let outside: string[] = [];
  if (!o.pageWide && o.scopeRootId && !scopeLost) {
    const beforeScope = new Set<string>();
    for (const [id, e] of o.before) {
      if (e.parent === o.scopeRootId) beforeScope.add(id);
      // walk up so nested descendants count too
      let cur: string | null = e.parent;
      let guard = 0;
      while (cur && guard++ < 100_000) {
        if (cur === o.scopeRootId) { beforeScope.add(id); break; }
        const pe = o.before.get(cur);
        if (!pe) break;
        cur = pe.parent;
      }
    }
    beforeScope.add(o.scopeRootId);

    const test = (id: string) => !withinScope(id, o.after, o.scopeRootId!, beforeScope);
    const kind = (ids: string[], label: string) => {
      for (const id of ids) if (test(id)) outside.push(`${label} ${id}`);
    };
    kind(diff.added, "added");
    kind(diff.removed, "removed");
    kind(diff.changed, "changed");
    if (outside.length) {
      violations.push(
        "touched outside the declared scope: " +
          outside.slice(0, 12).join(", ") +
          (outside.length > 12 ? ` (+${outside.length - 12} more)` : ""),
      );
    }
  }

  if (!o.allowGlobalChanges && Object.keys(globals).length) {
    violations.push("changed page-global state (variables/styles/paints): " + JSON.stringify(globals));
  }

  return {
    ok: violations.length === 0,
    violations,
    effects: {
      added: diff.added.length,
      removed: diff.removed.length,
      changed: diff.changed.length,
      scope: o.scopeRootId || "page-wide",
      globals: Object.keys(globals).length ? globals : undefined,
    },
  };
}