/**
 * Figma Motion (Beta), plugin side.
 *
 * The API is optional at runtime: an older Figma build has no `figma.motion`
 * and no `applyAnimationStyle` on a node. Every entry point probes first and
 * fails with `MOTION_UNAVAILABLE`; it never substitutes a local animation or
 * writes pluginData that merely looks like Motion.
 *
 * Writes follow the bridge's contract: a dry run returns a planId computed from
 * the operation AND a fingerprint of the node's current Motion state, apply
 * requires that exact planId, and the write is read back before it is reported
 * as verified. Callers may not use a plan produced against a different state.
 */

export type Json = any;
export type MotionTransact = <T>(fn: (mark: () => void) => Promise<T>) => Promise<T>;

export const PROPERTY_FIELDS = new Set([
  "CORNER_RADIUS", "STROKE_WEIGHT", "STACK_SPACING", "STACK_PADDING_LEFT",
  "STACK_PADDING_TOP", "STACK_PADDING_RIGHT", "STACK_PADDING_BOTTOM", "WIDTH",
  "HEIGHT", "RECTANGLE_TOP_LEFT_CORNER_RADIUS", "RECTANGLE_TOP_RIGHT_CORNER_RADIUS",
  "RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS", "RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS",
  "BORDER_TOP_WEIGHT", "BORDER_BOTTOM_WEIGHT", "BORDER_LEFT_WEIGHT",
  "BORDER_RIGHT_WEIGHT", "STACK_COUNTER_SPACING", "OPACITY", "GRID_ROW_GAP",
  "GRID_COLUMN_GAP", "TRANSLATION_X", "TRANSLATION_Y", "TRANSLATION_XY",
  "ROTATION", "SCALE_X", "SCALE_Y", "SCALE_XY", "PATH_TRIM_START", "PATH_TRIM_END",
]);
export const EFFECT_FIELDS = new Set([
  "OFFSET_X", "OFFSET_Y", "RADIUS", "SPREAD", "COLOR", "REFRACTION_RADIUS",
  "SPECULAR_ANGLE", "SPECULAR_INTENSITY", "CHROMATIC_ABERRATION", "SPLAY",
  "REFRACTION_INTENSITY", "START_RADIUS", "NOISE_SIZE_X", "NOISE_SIZE_Y",
  "DENSITY", "EFFECT_OPACITY", "SECONDARY_COLOR",
]);
export const EASING_TYPES = new Set([
  "EASE_IN", "EASE_OUT", "EASE_IN_AND_OUT", "LINEAR", "EASE_IN_BACK",
  "EASE_OUT_BACK", "EASE_IN_AND_OUT_BACK", "CUSTOM_CUBIC_BEZIER", "GENTLE",
  "QUICK", "BOUNCY", "SLOW", "CUSTOM_SPRING", "HOLD",
]);
export const VALUE_TYPES = new Set([
  "FLOAT", "COLOR", "TEXT_DATA", "VECTOR", "BOOL", "CIRCLE", "LINE",
  "CIRCLE_POINT", "COLOR_POINT",
]);

export const errMsg = (e: any) => String(e && e.message ? e.message : e);
export const fail = (code: string, message: string): never => {
  const e: any = new Error(`${code}: ${message}`);
  e.code = code;
  throw e;
};
export const clean = (v: any): any => {
  if (v === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return null;
  }
};
export const finite = (v: any): boolean => typeof v === "number" && Number.isFinite(v);

export function canonical(v: any): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const o = v as Record<string, any>;
  return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort()
    .map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
}

export function hash(s: string): string {
  // Two independent 32-bit FNV-style lanes: a 64-bit plan/state id, not the
  // 32-bit id a single lane would give. This is not a security boundary, but a
  // plan collision would apply the wrong write, so 8 hex characters is too few.
  let a = 2166136261;
  let b = 2166136261 ^ 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619);
    b = Math.imul(b ^ c, 2246822519);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

export function planOf(plan: any): string {
  return "motion-" + hash(canonical(plan));
}

export function motionApi(figma: any): any {
  const api = figma && (figma as any).motion;
  if (!api || typeof api.figmaAnimationStyles !== "function") {
    fail(
      "MOTION_UNAVAILABLE",
      "this Figma build does not expose figma.motion.figmaAnimationStyles(); Motion is Beta and may be absent or disabled in this session",
    );
  }
  return api;
}

export function figmaStyles(figma: any): any[] {
  const api = motionApi(figma);
  try {
    const styles = api.figmaAnimationStyles();
    if (!Array.isArray(styles)) {
      fail("MOTION_UNAVAILABLE", "figma.motion.figmaAnimationStyles() did not return an array");
    }
    return styles;
  } catch (e: any) {
    if (e && e.code) throw e;
    return fail("MOTION_UNAVAILABLE", `figma.motion is present but cannot list animation styles (${errMsg(e)})`);
  }
}

export async function customStyles(
  figma: any,
): Promise<{ styles: any[]; available: boolean; warning: string | null }> {
  if (typeof figma.getLocalCustomAnimationStylesAsync !== "function") {
    return {
      styles: [],
      available: false,
      warning: "this Figma build does not expose local custom animation styles",
    };
  }
  try {
    const styles = await figma.getLocalCustomAnimationStylesAsync();
    return { styles: Array.isArray(styles) ? styles : [], available: true, warning: null };
  } catch (e: any) {
    return {
      styles: [],
      available: false,
      warning: `custom animation styles could not be read (${errMsg(e)})`,
    };
  }
}

export function needMethod(node: any, name: string): void {
  if (!node || typeof node[name] !== "function") {
    fail(
      "MOTION_UNAVAILABLE",
      `${node && node.type ? node.type : "this node"} does not expose ${name}(); Motion is not available for it in this Figma build`,
    );
  }
}

export function identity(node: any): Json {
  return { id: node.id, name: node.name, type: node.type };
}

export async function resolveNode(figma: any, p: Json): Promise<any> {
  const id = p.nodeId || (figma.currentPage.selection[0] && figma.currentPage.selection[0].id);
  if (!id) fail("MOTION_INVALID", "nodeId is required (or select a node first)");
  const node = await figma.getNodeByIdAsync(String(id));
  if (!node) fail("MOTION_NODE_NOT_FOUND", `no node ${id} in this file`);
  if (node.type === "PAGE" || node.type === "DOCUMENT") {
    fail("MOTION_INVALID", `a ${node.type} cannot carry Motion; pass a scene node`);
  }
  return node;
}

export function readState(node: any): Json {
  try {
    const styles = node.animationStyles;
    if (!Array.isArray(styles)) {
      fail("MOTION_UNAVAILABLE", `${node.type} does not expose animationStyles`);
    }
    const manual = node.manualKeyframeTracks;
    const animations = node.animations;
    const timelines = node.timelines;
    if (!manual || typeof manual !== "object" || Array.isArray(manual)) {
      fail("MOTION_UNAVAILABLE", `${node.type} does not expose manualKeyframeTracks`);
    }
    if (!animations || typeof animations !== "object" || Array.isArray(animations)) {
      fail("MOTION_UNAVAILABLE", `${node.type} does not expose animations`);
    }
    if (!Array.isArray(timelines)) {
      fail("MOTION_UNAVAILABLE", `${node.type} does not expose timelines`);
    }
    return {
      animationStyles: clean(styles) || [],
      manualKeyframeTracks: clean(manual) || {},
      animations: clean(animations) || {},
      timelines: clean(timelines) || [],
    };
  } catch (e: any) {
    if (e && e.code) throw e;
    fail("MOTION_UNAVAILABLE", `Motion state could not be read from this ${node.type} (${errMsg(e)})`);
  }
}

export function stateFingerprint(state: Json): string {
  return "state-" + hash(canonical({
    styles: state.animationStyles,
    manual: state.manualKeyframeTracks,
    timelines: state.timelines,
  }));
}

/**
 * A dry run returns the plan; an apply must present the same planId. The plan
 * contains the state fingerprint, so a document that moved since the dry run is
 * refused before the transaction opens.
 */
export function gatePlan(p: Json, plan: Json): { dryRun: boolean; planId: string; plan: Json } {
  const planId = planOf(plan);
  if (p.dryRun !== false) return { dryRun: true, planId, plan };
  if (typeof p.planId !== "string" || !p.planId) {
    fail("MOTION_PLAN_REQUIRED", `pass dryRun:false with the planId returned by the dry run (${planId})`);
  }
  if (p.planId !== planId) {
    fail(
      "MOTION_PLAN_MISMATCH",
      `this operation now hashes to ${planId}, not ${p.planId}; the arguments or the node's Motion state changed since the dry run`,
    );
  }
  return { dryRun: false, planId, plan };
}

export function planEnvelope(gate: { dryRun: boolean; planId: string; plan: Json }, extra: Json = {}): Json {
  if (gate.dryRun) {
    return {
      schema: "motion-plan-v1",
      status: "dry_run",
      dryRun: true,
      planId: gate.planId,
      plan: gate.plan,
      note: "No document write. Pass dryRun:false and this planId to apply.",
      ...extra,
    };
  }
  return { schema: "motion-plan-v1", status: "applied", dryRun: false, planId: gate.planId, ...extra };
}

