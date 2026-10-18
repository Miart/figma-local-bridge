/// <reference types="@figma/plugin-typings" />

/**
 * Command engine.
 *
 * One high-level command, executed inside ONE figma.ui.onmessage handler so the
 * Plugin API can roll the whole thing back if anything throws. Verified by the
 * spike: commitUndo/triggerUndo do give a real transaction boundary for
 * createComponentFromNode + createInstance + remove.
 *
 * Working recipe (from the spike):
 *
 *   commitUndo()          <- baseline
 *   resolve / snapshot / validate
 *   mutate
 *   verify postconditions
 *      OK   -> commitUndo()                 <- new baseline
 *      FAIL -> commitUndo(); triggerUndo()  <- back to baseline
 *
 * triggerUndo() is SYNCHRONOUS (verified: returns undefined, not a Promise).
 *
 * No fuzzy matching. A target is used only if its semantic snapshot matches the
 * canonical one exactly; EQUIVALENT is required, DIFFERENT and INCONCLUSIVE both
 * block the whole cohort. That asymmetry is deliberate: this command deletes
 * originals, so a false refusal is recoverable and a false approval is not.
 */

import {
  snapshot, compare, explain, cohort, placement, placementDelta,
  STRICT, COMPONENTIZE,
  type SemanticSnapshot, type Verdict,
} from "./fingerprint";

const COMPONENT_KEY_DATA = "localBridge.componentKey";
const MASTER_CONTAINER = "__LocalBridgeComponents";

type Selector = { name?: string; type?: string };

type Preserve = { position?: boolean; size?: boolean; constraints?: boolean; name?: boolean };

export interface ReplaceParams {
  sourceId: string;
  match?: Selector;
  /**
   * How many nodes `match` must select IN TOTAL, source included. A mismatch is
   * refused before anything is touched — this is the guard against "there are
   * six of these" being false because a node was renamed or deleted.
   */
  expectedCount?: number;
  componentKey: string;
  componentName?: string;
  policy?: "strict" | "componentize";
  preserve?: Preserve;
  dryRun?: boolean;
}

const DEFAULT_PRESERVE: Required<Preserve> = {
  position: true, size: true, constraints: true, name: true,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(id: string): Promise<SceneNode | null> {
  return (await figma.getNodeByIdAsync(id)) as SceneNode | null;
}

// ---------------------------------------------------------------- resolve

function childSignature(n: SceneNode): string[] {
  if (!("children" in n)) return [];
  return (n.children as SceneNode[])
    .map((c) => c.type + ":" + c.name + "@" + Math.round(c.width) + "x" + Math.round(c.height))
    .sort();
}

/** Deterministic: exact name+type match only. No fuzzy scoring, no confidence. */
/**
 * Collects nodes matching the selector. `root` may be a PAGE: a page is a
 * container and never a target, but resuming over the whole page is exactly
 * what the retry path needs, so it must be accepted here rather than cast.
 */
function findBySelector(root: SceneNode | PageNode, sel: Selector): SceneNode[] {
  const out: SceneNode[] = [];
  const visit = (n: SceneNode | PageNode) => {
    if (n.type === "PAGE") {
      // never a match — only descend
    } else if (sel.name !== undefined && n.name !== sel.name) {
      // keep descending: children may still match
    } else if (sel.type !== undefined && n.type !== sel.type) {
      // keep descending
    } else {
      out.push(n);
    }
    if ("children" in n) for (const c of n.children as SceneNode[]) visit(c);
  };
  visit(root);
  return out;
}

function findMaster(key: string): BaseNode | null {
  const hits = figma.currentPage.findAll(
    (n) => n.type === "COMPONENT" && n.getPluginData(COMPONENT_KEY_DATA) === key,
  );
  return hits.length ? (hits[0] as BaseNode) : null;
}

/**
 * An INSTANCE whose main component is `master`.
 *
 * This is the whole of the idempotency check, and it needs no extra bookkeeping:
 * the instance already holds a reference to its master, and the master carries
 * componentKey in plugin data. So "is this one of ours?" is answered by the
 * document itself rather than by a second marker we could forget to write.
 *
 * The master is a COMPONENT, not an INSTANCE, so it never matches itself even
 * when the search scope is the whole page.
 */
async function isInstanceOf(node: SceneNode, master: BaseNode | null): Promise<boolean> {
  if (!master || node.type !== "INSTANCE") return false;
  const m = await (node as any).getMainComponentAsync();
  return !!m && m.id === master.id;
}

async function instancesOfMaster(master: BaseNode, root: SceneNode | PageNode): Promise<SceneNode[]> {
  const found = (root as any).findAll(() => true) as SceneNode[];
  const out: SceneNode[] = [];
  for (const n of found) {
    if (await isInstanceOf(n, master)) out.push(n);
  }
  return out;
}

async function ensureMasterContainer(): Promise<FrameNode> {
  const found = figma.currentPage.findOne(
    (n) => n.type === "FRAME" && n.name === MASTER_CONTAINER,
  ) as FrameNode | null;
  if (found) return found;

  let maxX = 0;
  for (const c of figma.currentPage.children) maxX = Math.max(maxX, c.x + c.width);
  const f = figma.createFrame();
  f.name = MASTER_CONTAINER;
  f.x = maxX + 600;
  f.y = 0;
  f.resize(400, 400);
  f.fills = [];
  f.clipsContent = false;
  f.setPluginData("localBridge.purpose", "masters created by the local bridge");
  return f;
}

// ---------------------------------------------------------------- the command

export async function replaceRepeatedWithComponent(p: ReplaceParams) {
  const policy = p.policy === "componentize" ? COMPONENTIZE : STRICT;
  const preserve = { ...DEFAULT_PRESERVE, ...(p.preserve || {}) };
  const dryRun = !!p.dryRun;

  // ---- 1. resolve the canonical source -------------------------------
  // The source is NOT spared any more: it becomes an instance like every other
  // cohort member and its original is deleted, so the file ends up as master + N
  // instances with no stray GROUP left behind. That stray was the reason a
  // second run broke — the selector no longer matched anything.
  //
  // Because the source can now be consumed, sourceId may point at a node a
  // previous run deleted. Fall back to the existing master in that case.
  const knownMaster = findMaster(p.componentKey);
  const source = await get(p.sourceId);
  const sourceGone = !source || (await isInstanceOf(source, knownMaster));

  if (sourceGone && !knownMaster) {
    return {
      status: "failed",
      reason: "SOURCE_NOT_FOUND",
      nodeId: p.sourceId,
      mutated: false,
      detail:
        `source ${p.sourceId} does not exist and no component with key "${p.componentKey}" is on the page, ` +
        "so there is nothing to resume. Nothing was changed.",
    };
  }
  if (sourceGone && !p.match) {
    return {
      status: "failed",
      reason: "SELECTOR_REQUIRED",
      mutated: false,
      detail:
        `source ${p.sourceId} is already an instance of this master, so it cannot supply a selector. ` +
        "Pass match explicitly to describe the cohort for a repeat run.",
    };
  }

  // ---- 2. resolve the target cohort ----------------------------------
  const anchor = sourceGone ? knownMaster! : source!;
  // When the source is gone the anchor is the master, whose parent is the
  // bridge's own __LocalBridgeComponents container — searching THAT would find
  // no instances and report an empty cohort, which reads as "nothing to do"
  // while three instances sit in the design. Resume over the whole page instead.
  const root: SceneNode | PageNode = sourceGone
    ? figma.currentPage
    : anchor.parent && anchor.parent.type !== "DOCUMENT"
      ? (anchor.parent as SceneNode)
      : figma.currentPage;

  const sel: Selector = p.match || { name: anchor.name, type: anchor.type };
  // expectedCount counts what the SELECTOR matched, source included. Counting
  // only the post-filter targets made "expectedCount: 6" fail on six real nodes
  // and the message contradicted itself ("matched 5" for a selector that
  // matched 6), because the source is filtered out AFTER selection.
  const matched = findBySelector(root, sel);

  // Idempotency (your steps 2-4): the cohort is the selector matches PLUS the
  // instances of this master already in scope. That is what makes a repeat run
  // see the full set even though the selector alone now matches nothing.
  const alreadyInstances = knownMaster ? await instancesOfMaster(knownMaster, root) : [];
  const seen = new Set<string>();
  const cohortNodes: SceneNode[] = [];
  for (const n of matched.concat(alreadyInstances)) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    cohortNodes.push(n);
  }

  if (p.expectedCount !== undefined && cohortNodes.length !== p.expectedCount) {
    return {
      status: "failed",
      reason: "COUNT_MISMATCH",
      expected: p.expectedCount,
      found: cohortNodes.length,
      mutated: false,
      detail:
        `selector matched ${matched.length} and ${alreadyInstances.length} of this master's instances are ` +
        `already in place, for ${cohortNodes.length} in total; expected ${p.expectedCount}. Nothing was changed.`,
    };
  }

  // Everything is already ours: answer plainly instead of pretending to work.
  const allOurs =
    cohortNodes.length > 0 &&
    (await Promise.all(cohortNodes.map((n) => isInstanceOf(n, knownMaster)))).every(Boolean);
  if (allOurs) {
    return {
      status: "already_done",
      mutated: false,
      componentKey: p.componentKey,
      component: knownMaster ? { id: knownMaster.id, name: knownMaster.name } : null,
      count: cohortNodes.length,
      instances: cohortNodes.map((n) => ({ id: n.id, name: n.name })),
      detail:
        `all ${cohortNodes.length} node(s) in scope are already instances of ` +
        `"${knownMaster && knownMaster.name}". Nothing was changed.`,
    };
  }

  // Only nodes that are NOT yet instances need replacing. Anything already done
  // is left exactly as it is, which is what makes an interrupted run resumable.
  const targets: SceneNode[] = [];
  for (const n of cohortNodes) {
    if (!(await isInstanceOf(n, knownMaster))) targets.push(n);
  }

  // The named source still has to be in the cohort, or the caller is describing
  // a different set of nodes than the one they named. Checked BEFORE the
  // "nothing to replace" exit, otherwise an empty cohort hides the mistake.
  if (!sourceGone && !targets.some((n) => n.id === source!.id)) {
    return {
      status: "failed",
      reason: "SOURCE_NOT_IN_COHORT",
      mutated: false,
      detail:
        `selector (${sel.type} "${sel.name}") matched ${matched.length} node(s) but not the source ` +
        `${source!.id} "${source!.name}". Nothing was changed.`,
    };
  }

  if (!targets.length) {
    return {
      status: "already_done",
      mutated: false,
      componentKey: p.componentKey,
      count: cohortNodes.length,
      detail: "nothing left to replace. Nothing was changed.",
    };
  }

  // Canonical is one of the targets, never the master: a master is a COMPONENT
  // and a target is a GROUP, so comparing their snapshots would report DIFFERENT
  // on nodeType alone and refuse a perfectly good run.
  const canonicalNode = targets.find((n) => n.id === source!.id) || targets[0];
  const canonicalFp = snapshot(canonicalNode as any, policy);
  const canonicalSig = childSignature(canonicalNode);

  // ---- 3. equivalence gate -------------------------------------------
  const entries = [{ id: canonicalNode.id, name: canonicalNode.name, fp: canonicalFp }].concat(
    targets
      .filter((n) => n.id !== canonicalNode.id)
      .map((n) => ({ id: n.id, name: n.name, fp: snapshot(n as any, policy) })),
  );
  const report = cohort(canonicalNode.id, entries);

  const structuralMismatch = targets.filter((n) => {
    const sig = childSignature(n);
    return sig.length !== canonicalSig.length || !sig.every((s, i) => s === canonicalSig[i]);
  });
  if (structuralMismatch.length) {
    return {
      status: "failed",
      reason: "STRUCTURE_MISMATCH",
      mutated: false,
      nodes: structuralMismatch.map((n) => n.id),
      detail: "child signatures differ from the canonical source",
    };
  }

  if (report.verdict !== "EQUIVALENT") {
    return {
      status: "failed",
      reason: report.verdict === "INCONCLUSIVE" ? "TARGETS_NOT_PROVABLE" : "TARGETS_NOT_EQUIVALENT",
      mutated: false,
      divergent: report.different,
      inconclusive: report.inconclusive,
      warnings: report.warnings,
      detail:
        report.verdict === "INCONCLUSIVE"
          ? "At least one target could not be proven equivalent. Refusing to replace — a false refusal is recoverable, a false approval deletes design work."
          : "Targets differ from the canonical source. Nothing was changed.",
    };
  }

  const plan = {
    status: dryRun ? "dry_run" : "planned",
    componentKey: p.componentKey,
    canonical: { id: canonicalNode.id, name: canonicalNode.name, type: canonicalNode.type },
    targets: targets.map((n) => ({ id: n.id, name: n.name })),
    targetCount: targets.length,
    alreadyInstances: alreadyInstances.length,
    fingerprint: canonicalFp.hash,
    geometryStatus: canonicalFp.geometryStatus,
    existingMaster: !!knownMaster,
    mutations: dryRun ? 0 : targets.length + (knownMaster ? 0 : 1),
  };

  if (dryRun) return plan;

  // ---- 4. baseline ----------------------------------------------------
  figma.commitUndo();

  const createdNodeIds: string[] = [];
  const removedNodeIds: string[] = [];
  const rolledBack: string[] = [];

  try {
    // ---- 5. master: clone the canonical node, never mutate an original ----
    let master = knownMaster as ComponentNode | null;
    if (master) {
      master.name = p.componentName || master.name;
    } else {
      const clone = (canonicalNode as SceneNode).clone();
      master = figma.createComponentFromNode(clone as any) as ComponentNode;
      master.name = p.componentName || canonicalNode.name;
      master.setPluginData(COMPONENT_KEY_DATA, p.componentKey);

      const container = await ensureMasterContainer();
      container.appendChild(master);
      master.x = 40;
      master.y = 40;
      createdNodeIds.push(master.id);
    }

    // ---- 6. snapshot placement before mutating ------------------------
    const before = new Map<string, ReturnType<typeof placement>>();
    for (const n of targets) {
      const live = await get(n.id);
      if (!live) throw new Error(`target ${n.id} vanished before mutation`);
      before.set(n.id, placement(live));
    }

    // ---- 7. create every replacement FIRST, delete nothing yet --------
    // Each instance is inserted immediately before its own original, so once the
    // originals go the instances land on exactly the original indices. Deleting
    // as we went would mean trusting undo for the design work; this way the
    // originals are still intact while the replacements are being proven.
    const pairs: Array<{ originalId: string; instanceId: string }> = [];
    for (const n of targets) {
      const live = await get(n.id);
      if (!live) throw new Error(`target ${n.id} vanished during mutation`);
      const parent = live.parent as any;
      if (!parent || !("insertChild" in parent)) throw new Error(`target ${n.id}: parent cannot accept children`);
      if (parent.type === "INSTANCE") throw new Error(`target ${n.id}: parent is an INSTANCE`);

      const idx = parent.children.indexOf(live);
      const isAuto = !!parent.layoutMode && parent.layoutMode !== "NONE";

      const inst = master.createInstance();
      if (preserve.size) inst.resize(live.width, live.height);
      if (preserve.name) inst.name = live.name;

      if (idx >= 0) parent.insertChild(idx, inst);
      else parent.appendChild(inst);

      if (isAuto) {
        inst.layoutSizingHorizontal = "FIXED";
        inst.layoutSizingVertical = "FIXED";
      } else if (preserve.position) {
        inst.x = live.x;
        inst.y = live.y;
      }
      if (preserve.constraints && (live as any).constraints) {
        inst.constraints = { ...(live as any).constraints };
      }

      createdNodeIds.push(inst.id);
      pairs.push({ originalId: live.id, instanceId: inst.id });
    }

    // ---- 8. prove the replacements BEFORE anything is deleted ---------
    // References do not survive a rollback, so everything is re-resolved by id.
    await sleep(80);

    const findings: Array<{ nodeId: string; diff: string[] }> = [];
    for (const pair of pairs) {
      const inst = await get(pair.instanceId);
      if (!inst) {
        findings.push({ nodeId: pair.instanceId, diff: ["instance missing after mutation"] });
        continue;
      }
      // The synchronous `mainComponent` getter THROWS under
      // documentAccess: dynamic-page ("Cannot call with documentAccess:
      // dynamic-page"), which the manifest declares. Reading it here aborted
      // every run at the postcondition stage — after the instances were already
      // created and the originals removed — so the command always rolled back.
      const instMain = await (inst as any).getMainComponentAsync();
      if (instMain?.id !== master.id) {
        findings.push({
          nodeId: inst.id,
          diff: ["mainComponent is not the created master: got " + (instMain ? instMain.id : "none")],
        });
        continue;
      }
      const snap = before.get(pair.originalId)!;
      // Sibling index is deliberately not compared yet: the originals are still
      // present, so every instance sits one slot to the left of where it will
      // finally land. Index is asserted after the removals instead, still inside
      // this same undo step.
      const diff = placementDelta(snap, placement(inst), { skipIndex: true });
      if (diff.length) findings.push({ nodeId: inst.id, diff });
    }

    if (findings.length) {
      rolledBack.push(...findings.map((f) => f.nodeId));
      // Postcondition failed: undo the whole command.
      figma.commitUndo();
      figma.triggerUndo();
      await sleep(60);
      return {
        status: "rolled_back",
        reason: "postcondition_failed",
        mutated: false,
        findings,
        detail: "reverted to the pre-command state",
      };
    }

    // ---- 9. now the originals can go, canonical node last -------------
    // Every replacement has been proven, and all of this is still one undo step,
    // so an exception below lands in the same handler and reverts as a unit.
    const ordered = pairs.slice().sort((a, b) =>
      a.originalId === canonicalNode.id ? 1 : b.originalId === canonicalNode.id ? -1 : 0,
    );
    for (const pair of ordered) {
      const live = await get(pair.originalId);
      if (!live) throw new Error(`original ${pair.originalId} vanished before removal`);
      live.remove();
      removedNodeIds.push(pair.originalId);
    }

    // ---- 10. final assertion on the real end state --------------------
    await sleep(60);
    const finalFindings: Array<{ nodeId: string; diff: string[] }> = [];
    for (const pair of pairs) {
      const inst = await get(pair.instanceId);
      if (!inst) {
        finalFindings.push({ nodeId: pair.instanceId, diff: ["instance missing after removal"] });
        continue;
      }
      const snap = before.get(pair.originalId)!;
      const diff = placementDelta(snap, placement(inst), { onlyIndex: true });
      if (diff.length) finalFindings.push({ nodeId: inst.id, diff });
    }
    if (finalFindings.length) {
      rolledBack.push(...finalFindings.map((f) => f.nodeId));
      figma.commitUndo();
      figma.triggerUndo();
      await sleep(60);
      return {
        status: "rolled_back",
        reason: "postcondition_failed",
        mutated: false,
        findings: finalFindings,
        detail: "replacements did not land on the original positions; reverted",
      };
    }

    // ---- 11. success: new baseline -----------------------------------
    figma.commitUndo();
    return {
      status: "ok",
      mutated: true,
      component: { id: master.id, name: master.name, key: p.componentKey, reused: !!knownMaster },
      createdNodeIds,
      removedNodeIds,
      replaced: pairs.length,
      alreadyInstances: alreadyInstances.length,
      detail: `${pairs.length} node(s) replaced with instances of ${master.name}`,
    };
  } catch (err) {
    // Anything thrown here lands in one handler, so the Plugin API reverts the
    // message as a unit. Be explicit anyway rather than relying on that.
    try {
      figma.commitUndo();
      figma.triggerUndo();
    } catch {
      /* best effort */
    }
    return {
      status: "rolled_back",
      reason: "exception",
      mutated: false,
      detail: String(err && (err as Error).message ? (err as Error).message : err),
      createdNodeIds,
      removedNodeIds,
    };
  }
}