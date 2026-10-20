/// <reference types="@figma/plugin-typings" />

/**
 * Multi-target edit with one plan, one undo boundary and one report.
 *
 * Build/patch is the right tool when the caller knows the desired tree. Batch
 * is for the other half of real work: "these eleven labels need this copy",
 * "these three cards move into the new row". It resolves every target and every
 * font/style BEFORE writing, so a typo in op 9 cannot leave ops 1-8 applied
 * without the caller being told.
 *
 * Targets are nodeId or stable key. A key is the better identity: ids change
 * when a node is recreated, keys are stored in pluginData and survive.
 */

import {
  KEY_DATA, PROTECTED_DATA, parseColor, fontSpec, hyperlinkFromSpec, applyContainerLayout, applyChildLayout,
} from "./ui-build";
import { snapshot, STRICT } from "./fingerprint";

export const BATCH_SCHEMA = "batch-v1";
export const MAX_OPS = 200;

type Json = any;

const isObj = (v: any) => !!v && typeof v === "object" && !Array.isArray(v);
const errMsg = (e: any) => String(e && e.message ? e.message : e);

const OPS = new Set([
  "set_text", "set_name", "rename", "set_fill", "set_stroke", "resize", "move",
  "set_visible", "set_opacity", "set_rotation", "set_layout", "set_variant", "set_constraints",
  "duplicate", "reparent",
]);

function slug(value: string): string {
  return String(value || "node")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "node";
}

/** A clone is a new subtree: its descendants need fresh keys under newKey. */
function rekeyClone(node: any, parentKey: string): void {
  (node.children || []).forEach((child: any, index: number) => {
    const key = `${parentKey}/${slug(child.name)}#${index}`;
    child.setPluginData(KEY_DATA, key);
    rekeyClone(child, key);
  });
}

function solid(value: any): any {
  if (isObj(value) && value.variable !== undefined) {
    throw new Error("batch fills do not resolve variables; use figma_patch for a bound variable paint");
  }
  if (isObj(value) && value.type === "IMAGE") {
    if (!value.imageHash) throw new Error("IMAGE paint needs imageHash");
    return { type: "IMAGE", imageHash: String(value.imageHash), scaleMode: value.scaleMode || "FILL" };
  }
  if (isObj(value) && value.type && String(value.type).startsWith("GRADIENT")) {
    const stops = (value.stops || []).map((s: any) => ({
      position: Math.max(0, Math.min(1, Number(s.at ?? s.position ?? 0))),
      color: parseColor(s.color),
    }));
    if (stops.length < 2) throw new Error(`${value.type} needs at least two stops`);
    return {
      type: value.type,
      gradientStops: stops,
      gradientTransform: value.gradientTransform || [[1, 0, 0], [0, 1, 0]],
    };
  }
  const c = parseColor(isObj(value) && value.color !== undefined ? value.color : value);
  return {
    type: "SOLID",
    color: { r: c.r, g: c.g, b: c.b },
    opacity: isObj(value) && value.opacity !== undefined ? Number(value.opacity) : c.a,
  };
}

function paintList(value: any): any[] {
  if (value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map(solid);
}

async function findTextStyle(ctx: any, ref: string): Promise<any> {
  const styles = await ctx.getLocalTextStylesAsync();
  const hits = styles.filter((s: any) => s.id === ref || s.key === ref || s.name === ref);
  if (hits.length > 1) throw new Error(`text style "${ref}" is ambiguous: ${hits.map((s: any) => s.id).join(", ")}`);
  if (!hits.length) throw new Error(`text style "${ref}" not found`);
  return hits[0];
}

async function findPaintStyle(ctx: any, ref: string): Promise<any> {
  const styles = await ctx.getLocalPaintStylesAsync();
  const hits = styles.filter((s: any) => s.id === ref || s.key === ref || s.name === ref);
  if (hits.length > 1) throw new Error(`paint style "${ref}" is ambiguous: ${hits.map((s: any) => s.id).join(", ")}`);
  if (!hits.length) throw new Error(`paint style "${ref}" not found`);
  return hits[0];
}

function byKey(ctx: any, key: string): any[] {
  const out: any[] = [];
  const visit = (n: any) => {
    try { if (n.getPluginData(KEY_DATA) === key) out.push(n); } catch { /* ignore */ }
    for (const c of n.children || []) visit(c);
  };
  visit(ctx.currentPage);
  return out;
}

async function targetOf(ctx: any, op: Json, index: number): Promise<any> {
  if (op.nodeId) {
    const n = await ctx.getNodeByIdAsync(String(op.nodeId));
    if (!n) throw new Error(`op[${index}]: node not found: ${op.nodeId}`);
    if (n.removed === true) throw new Error(`op[${index}]: node ${op.nodeId} has been removed`);
    return n;
  }
  if (op.key) {
    const hits = byKey(ctx, String(op.key));
    if (!hits.length) throw new Error(`op[${index}]: no node with key "${op.key}" on the current page`);
    if (hits.length > 1) throw new Error(`op[${index}]: key "${op.key}" is ambiguous (${hits.map((n) => n.id).join(", ")})`);
    return hits[0];
  }
  throw new Error(`op[${index}]: needs nodeId or key`);
}

function targetRef(n: any): Json {
  let key = "";
  try { key = n.getPluginData(KEY_DATA) || ""; } catch { key = ""; }
  return { id: n.id, name: n.name, type: n.type, key };
}

function protect(n: any): void {
  try {
    if (n.getPluginData(PROTECTED_DATA) === "1") {
      throw new Error(`node ${n.id} ("${n.name}") is protected; batch will not change it`);
    }
  } catch (e: any) {
    if (String(e && e.message).includes("protected")) throw e;
  }
}

function assertType(n: any, type: string, op: string, index: number): void {
  if (n.type !== type) throw new Error(`op[${index}] ${op}: ${n.id} is ${n.type}, not ${type}`);
}

async function preflightText(ctx: any, op: Json, n: any, index: number): Promise<Json> {
  assertType(n, "TEXT", op.op, index);
  if (op.text !== undefined && typeof op.text !== "string") throw new Error(`op[${index}].text must be a string`);
  if (op.hyperlink !== undefined) hyperlinkFromSpec(op.hyperlink, `op[${index}].hyperlink`);
  if (op.font !== undefined && !fontSpec(op.font)) throw new Error(`op[${index}].font must be "Family/Style" or {family,style}`);
  if (op.font !== undefined && op.textStyle !== undefined) {
    throw new Error(`op[${index}]: font and textStyle are exclusive; a text style already carries a font`);
  }
  const explicitFont: any = op.font !== undefined ? fontSpec(op.font) : null;
  let textStyle: any = null;
  if (op.textStyle !== undefined) textStyle = await findTextStyle(ctx, String(op.textStyle));

  // Load the font that will actually be changed. An explicit font wins over a
  // style; otherwise the style's font, then the node's own font. A missing font
  // fails here, before the undo baseline, not halfway through an apply.
  if (explicitFont) await ctx.loadFontAsync(explicitFont);
  else if (textStyle) await ctx.loadFontAsync(textStyle.fontName);
  else if (n.fontName && n.fontName !== ctx.mixed) await ctx.loadFontAsync(n.fontName);
  else if (n.fontName === ctx.mixed && typeof n.getRangeAllFontNames === "function") {
    const len = typeof n.characters === "string" ? n.characters.length : 0;
    if (len > 0) for (const f of n.getRangeAllFontNames(0, len) || []) await ctx.loadFontAsync(f);
  }
  return { textStyle, font: explicitFont };
}

function layoutPreflight(n: any, op: Json, index: number): void {
  if (!("layoutMode" in n)) throw new Error(`op[${index}] set_layout: ${n.id} is ${n.type}, which has no auto-layout`);
  const l = op.layout;
  if (!isObj(l)) throw new Error(`op[${index}].layout must be an object`);
  if (l.mode !== undefined && !["NONE", "HORIZONTAL", "VERTICAL"].includes(String(l.mode))) {
    throw new Error(`op[${index}].layout.mode must be NONE, HORIZONTAL or VERTICAL`);
  }
}

function stableKeyForClone(ctx: any, newKey: string): any | null {
  const hits = byKey(ctx, newKey);
  if (hits.length > 1) throw new Error(`duplicate newKey "${newKey}" is ambiguous: ${hits.map((n) => n.id).join(", ")}`);
  return hits[0] || null;
}

function reparentPreflight(target: any, parent: any, index: number): void {
  if (!parent || !("appendChild" in parent)) throw new Error(`op[${index}] reparent: parent cannot accept children`);
  if (parent.type === "INSTANCE") throw new Error(`op[${index}] reparent: an INSTANCE cannot accept children`);
  if (parent.id === target.id) throw new Error(`op[${index}] reparent: a node cannot be its own parent`);
  let p = parent;
  while (p) {
    if (p.id === target.id) throw new Error(`op[${index}] reparent: cannot move a node inside its own descendant`);
    p = p.parent;
  }
}

async function planOp(ctx: any, op: Json, index: number): Promise<Json> {
  if (!isObj(op) || typeof op.op !== "string") throw new Error(`op[${index}] must have an op`);
  if (!OPS.has(op.op)) throw new Error(`op[${index}]: unsupported op "${op.op}"`);
  const target = await targetOf(ctx, op, index);
  protect(target);
  const plan: Json = {
    index,
    op: op.op,
    target: targetRef(target),
    status: "planned",
    warnings: [],
  };

  switch (op.op) {
    case "set_text": {
      const resolved = await preflightText(ctx, op, target, index);
      plan.fontSpec = resolved.font;
      plan.font = resolved.font ? `${resolved.font.family}/${resolved.font.style}` : "existing";
      plan.textStyleId = resolved.textStyle ? resolved.textStyle.id : null;
      plan.textStyle = resolved.textStyle ? resolved.textStyle.name : null;
      break;
    }
    case "set_name":
    case "rename":
      if (typeof op.name !== "string" || !op.name.trim()) throw new Error(`op[${index}].name must be a non-empty string`);
      break;
    case "set_fill":
      if (!("fills" in target)) throw new Error(`op[${index}] set_fill: ${target.id} cannot take fills`);
      if (op.fills !== undefined && op.fillStyle !== undefined) throw new Error(`op[${index}]: fills and fillStyle are exclusive`);
      if (op.fills === undefined && op.fillStyle === undefined) throw new Error(`op[${index}]: set_fill needs fills or fillStyle`);
      if (op.fillStyle !== undefined) plan.style = (await findPaintStyle(ctx, String(op.fillStyle))).name;
      else paintList(op.fills);
      break;
    case "set_stroke":
      if (!("strokes" in target)) throw new Error(`op[${index}] set_stroke: ${target.id} cannot take strokes`);
      if (op.strokes !== undefined && op.strokeStyle !== undefined) throw new Error(`op[${index}]: strokes and strokeStyle are exclusive`);
      if (op.strokes === undefined && op.strokeStyle === undefined && op.strokeWeight === undefined) {
        throw new Error(`op[${index}]: set_stroke needs strokes, strokeStyle or strokeWeight`);
      }
      if (op.strokeStyle !== undefined) plan.style = (await findPaintStyle(ctx, String(op.strokeStyle))).name;
      if (op.strokes !== undefined) paintList(op.strokes);
      if (op.strokeWeight !== undefined && (!Number.isFinite(Number(op.strokeWeight)) || Number(op.strokeWeight) < 0)) {
        throw new Error(`op[${index}].strokeWeight must be >= 0`);
      }
      break;
    case "resize":
      if (!Number.isFinite(Number(op.width)) || Number(op.width) <= 0 || !Number.isFinite(Number(op.height)) || Number(op.height) <= 0) {
        throw new Error(`op[${index}]: resize needs positive width and height`);
      }
      if (!("resize" in target)) throw new Error(`op[${index}] resize: ${target.id} cannot be resized`);
      if ("layoutMode" in target && target.layoutMode !== "NONE") {
        plan.warnings.push("frame uses auto-layout; resize may be overridden by its sizing rules");
      }
      break;
    case "move":
      if (!Number.isFinite(Number(op.x)) || !Number.isFinite(Number(op.y))) throw new Error(`op[${index}]: move needs numeric x and y`);
      if (target.parent && "layoutMode" in target.parent && target.parent.layoutMode !== "NONE" && op.absolute !== true) {
        plan.warnings.push("parent uses auto-layout; set absolute:true to place this node explicitly");
      }
      break;
    case "set_visible":
      if (typeof op.visible !== "boolean") throw new Error(`op[${index}].visible must be boolean`);
      break;
    case "set_opacity":
      if (!Number.isFinite(Number(op.opacity)) || Number(op.opacity) < 0 || Number(op.opacity) > 1) {
        throw new Error(`op[${index}].opacity must be between 0 and 1`);
      }
      break;
    case "set_rotation":
      if (!Number.isFinite(Number(op.rotation))) throw new Error(`op[${index}].rotation must be a finite number`);
      if (!("rotation" in target)) throw new Error(`op[${index}] set_rotation: ${target.id} has no rotation`);
      break;
    case "set_layout":
      layoutPreflight(target, op, index);
      break;
    case "set_variant": {
      assertType(target, "INSTANCE", op.op, index);
      if (!isObj(op.properties) || !Object.keys(op.properties).length) throw new Error(`op[${index}].properties must be a non-empty object`);
      const defs = target.componentProperties || {};
      const bad = Object.keys(op.properties).filter((k) => !Object.keys(defs).includes(k));
      if (bad.length) {
        throw new Error(
          `op[${index}] set_variant: component has no ${bad.length === 1 ? "property" : "properties"} ${bad.join(", ")}. ` +
            `Available: ${Object.keys(defs).join(", ") || "(none)"}`,
        );
      }
      break;
    }
    case "set_constraints":
      if (!("constraints" in target)) throw new Error(`op[${index}] set_constraints: ${target.id} has no constraints`);
      if (!isObj(op.constraints)) throw new Error(`op[${index}].constraints must be an object`);
      break;
    case "duplicate": {
      if (!op.newKey || typeof op.newKey !== "string" || /\s/.test(op.newKey)) {
        throw new Error(`op[${index}] duplicate: newKey must be a non-empty string with no whitespace`);
      }
      if (!("clone" in target)) throw new Error(`op[${index}] duplicate: ${target.id} cannot be cloned`);
      if (target.parent && target.parent.type === "INSTANCE") {
        throw new Error(`op[${index}] duplicate: a layer inside an instance cannot be cloned independently`);
      }
      const existing = stableKeyForClone(ctx, op.newKey);
      if (existing) {
        plan.status = "noop";
        plan.existingNodeId = existing.id;
        plan.warnings.push(`newKey "${op.newKey}" already exists; duplicate is a no-op`);
      }
      if (op.parentId) {
        const parent = await ctx.getNodeByIdAsync(String(op.parentId));
        reparentPreflight(existing || target, parent, index);
        plan.parent = targetRef(parent);
      }
      break;
    }
    case "reparent": {
      if (!op.parentId) throw new Error(`op[${index}] reparent: parentId is required`);
      const parent = await ctx.getNodeByIdAsync(String(op.parentId));
      reparentPreflight(target, parent, index);
      plan.parent = targetRef(parent);
      if (target.parent && "layoutMode" in parent && parent.layoutMode !== "NONE") {
        plan.warnings.push("target parent uses auto-layout; the node will be positioned absolutely");
      }
      break;
    }
  }
  return plan;
}

async function applyOp(ctx: any, op: Json, target: any, plan: Json): Promise<Json> {
  switch (op.op) {
    case "set_text": {
      if (plan.textStyleId) {
        const st = await findTextStyle(ctx, String(plan.textStyleId));
        await ctx.loadFontAsync(st.fontName);
        target.textStyleId = st.id;
      } else if (plan.fontSpec) {
        await ctx.loadFontAsync(plan.fontSpec);
        target.fontName = plan.fontSpec;
      } else if (op.text !== undefined) {
        // Editing characters requires the node's own font to be loaded. A mixed
        // node needs every run loaded, or Figma refuses the write.
        if (target.fontName && target.fontName !== ctx.mixed) await ctx.loadFontAsync(target.fontName);
        else if (typeof target.getRangeAllFontNames === "function") {
          const len = typeof target.characters === "string" ? target.characters.length : 0;
          if (len > 0) for (const f of target.getRangeAllFontNames(0, len) || []) await ctx.loadFontAsync(f);
        }
      }
      if (op.text !== undefined) target.characters = String(op.text);
      if (op.hyperlink !== undefined) target.hyperlink = hyperlinkFromSpec(op.hyperlink, `op.hyperlink`);
      if (op.fontSize !== undefined) target.fontSize = Number(op.fontSize);
      if (op.textAutoResize !== undefined) target.textAutoResize = op.textAutoResize;
      return { ...plan, status: "updated", nodeId: target.id };
    }
    case "set_name":
    case "rename":
      target.name = String(op.name);
      return { ...plan, status: "updated", nodeId: target.id };
    case "set_fill":
      if (op.fillStyle !== undefined) target.fillStyleId = (await findPaintStyle(ctx, String(op.fillStyle))).id;
      else target.fills = paintList(op.fills);
      return { ...plan, status: "updated", nodeId: target.id };
    case "set_stroke":
      if (op.strokeStyle !== undefined) target.strokeStyleId = (await findPaintStyle(ctx, String(op.strokeStyle))).id;
      if (op.strokes !== undefined) target.strokes = paintList(op.strokes);
      if (op.strokeWeight !== undefined) target.strokeWeight = Number(op.strokeWeight);
      if (op.strokeAlign !== undefined) target.strokeAlign = op.strokeAlign;
      return { ...plan, status: "updated", nodeId: target.id };
    case "resize":
      target.resize(Number(op.width), Number(op.height));
      return { ...plan, status: "updated", nodeId: target.id };
    case "move":
      if (op.absolute === true && "layoutPositioning" in target) target.layoutPositioning = "ABSOLUTE";
      target.x = Number(op.x);
      target.y = Number(op.y);
      return { ...plan, status: "updated", nodeId: target.id };
    case "set_visible":
      target.visible = !!op.visible;
      return { ...plan, status: "updated", nodeId: target.id };
    case "set_opacity":
      target.opacity = Number(op.opacity);
      return { ...plan, status: "updated", nodeId: target.id };
    case "set_rotation":
      target.rotation = Number(op.rotation);
      return { ...plan, status: "updated", nodeId: target.id };
    case "set_layout":
      applyContainerLayout(target, op.layout, "before");
      applyChildLayout(target, op.layout);
      applyContainerLayout(target, op.layout, "after");
      return { ...plan, status: "updated", nodeId: target.id };
    case "set_variant":
      target.setProperties(op.properties);
      return { ...plan, status: "updated", nodeId: target.id };
    case "set_constraints":
      target.constraints = op.constraints;
      return { ...plan, status: "updated", nodeId: target.id };
    case "duplicate": {
      if (plan.status === "noop" && plan.existingNodeId) {
        return { ...plan, status: "noop", nodeId: plan.existingNodeId };
      }
      let parent = op.parentId ? await ctx.getNodeByIdAsync(String(op.parentId)) : target.parent;
      if (!parent) throw new Error(`duplicate: source has no parent and no parentId was given`);
      const clone = target.clone();
      clone.setPluginData(KEY_DATA, op.newKey);
      rekeyClone(clone, op.newKey);
      parent.appendChild(clone);
      if (op.name !== undefined) clone.name = String(op.name);
      if (op.x !== undefined || op.y !== undefined) {
        clone.x = Number(op.x ?? clone.x);
        clone.y = Number(op.y ?? clone.y);
      }
      return { ...plan, status: "created", nodeId: clone.id, sourceNodeId: target.id };
    }
    case "reparent": {
      const parent = await ctx.getNodeByIdAsync(String(op.parentId));
      if (!parent) throw new Error(`reparent: parent ${op.parentId} not found`);
      const before = op.preserveAbsolute !== false ? target.absoluteBoundingBox : null;
      if ("layoutPositioning" in target && "layoutMode" in parent && parent.layoutMode !== "NONE") {
        target.layoutPositioning = "ABSOLUTE";
      }
      parent.insertChild(Number(op.index ?? parent.children.length), target);
      if (before && target.absoluteBoundingBox) {
        const after = target.absoluteBoundingBox;
        target.x += before.x - after.x;
        target.y += before.y - after.y;
      }
      return { ...plan, status: "updated", nodeId: target.id };
    }
  }
  throw new Error(`unsupported op ${op.op}`);
}

export async function runBatch(ctx: any, params: Json): Promise<Json> {
  const t0 = Date.now();
  const ops = params && Array.isArray(params.ops) ? params.ops : [];
  if (!ops.length) throw new Error("batch needs at least one op");
  if (ops.length > MAX_OPS) throw new Error(`batch has ${ops.length} ops; the limit is ${MAX_OPS}`);
  const dryRun = params.dryRun !== false;
  const stopOnError = params.stopOnError !== false;

  // Preflight: resolve every target, every font, every style and every
  // component property before the undo baseline. A failure here writes nothing.
  const plan: Json[] = [];
  const targets = new Map<string, any>();
  const fingerprints: Record<string, string> = {};
  for (let i = 0; i < ops.length; i++) {
    const p = await planOp(ctx, ops[i], i);
    plan.push(p);
    if (p.target && p.target.id) {
      const n = await ctx.getNodeByIdAsync(p.target.id);
      if (n && n.removed !== true) {
        targets.set(n.id, n);
        fingerprints[n.id] = snapshot(n, STRICT).hash;
      }
    }
  }

  if (params.expectedFingerprints && isObj(params.expectedFingerprints)) {
    const mismatch: Json[] = [];
    for (const id of Object.keys(params.expectedFingerprints)) {
      if (fingerprints[id] !== params.expectedFingerprints[id]) {
        mismatch.push({ nodeId: id, expected: params.expectedFingerprints[id], actual: fingerprints[id] || null });
      }
    }
    if (mismatch.length) {
      return {
        status: "refused",
        reason: "FINGERPRINT_MISMATCH",
        message: "The document changed since the plan was made. Run figma_batch_edit with dryRun:true again.",
        mismatch,
        ms: { plan: Date.now() - t0 },
      };
    }
  }

  if (dryRun) {
    return {
      status: "dry_run",
      schema: BATCH_SCHEMA,
      ops: plan,
      fingerprints,
      ms: { plan: Date.now() - t0 },
    };
  }

  ctx.commitUndo();
  let wrote = false;
  const mark = () => { if (!wrote) { wrote = true; ctx.commitUndo(); } };
  const results: Json[] = [];
  try {
    for (let i = 0; i < ops.length; i++) {
      const p = plan[i];
      try {
        const n = await ctx.getNodeByIdAsync(p.target.id);
        if (!n || n.removed === true) throw new Error(`target ${p.target.id} disappeared between plan and apply`);
        mark();
        results.push(await applyOp(ctx, ops[i], n, p));
      } catch (e) {
        const failed = { ...p, status: "failed", error: errMsg(e) };
        results.push(failed);
        if (stopOnError) throw new Error(`op[${i}] ${ops[i].op} failed: ${errMsg(e)}`);
      }
    }
    ctx.commitUndo();
    const failures = results.filter((r) => r.status === "failed");
    const after: Record<string, string> = {};
    for (const id of targets.keys()) {
      const n = await ctx.getNodeByIdAsync(id);
      if (n && n.removed !== true) after[id] = snapshot(n, STRICT).hash;
    }
    return {
      status: failures.length ? "partial" : "applied",
      schema: BATCH_SCHEMA,
      ops: results,
      fingerprints: { before: fingerprints, after },
      applied: results.filter((r) => r.status !== "failed" && r.status !== "noop").length,
      failed: failures.length,
      warnings: results.flatMap((r) => r.warnings || []),
      ms: { plan: Date.now() - t0, apply: Date.now() - t0 },
    };
  } catch (e) {
    if (wrote) {
      try { ctx.commitUndo(); ctx.triggerUndo(); } catch { /* ignore */ }
    }
    throw new Error(errMsg(e) + (wrote ? " (rolled back)" : ""));
  }
}
