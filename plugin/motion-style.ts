/**
 * Applying and removing Motion animation styles.
 *
 * One command per file keeps the state fingerprint and the readback in the same
 * place as the write they guard; the dispatcher in motion.ts stays trivial.
 */
import {
  canonical, clean, customStyles, fail, figmaStyles, finite, gatePlan, identity,
  needMethod, planEnvelope, readState, resolveNode, stateFingerprint,
  type Json, type MotionTransact,
} from "./motion-core";

function optionalSeconds(v: any, name: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    fail("MOTION_INVALID", `${name} must be a finite number >= 0 seconds`);
  }
  return v;
}

async function resolveStyle(figma: any, p: Json): Promise<Json> {
  const styleId = typeof p.styleId === "string" ? p.styleId : "";
  if (!styleId) fail("MOTION_INVALID", "styleId is required");
  const want = p.type === "FIGMA" || p.type === "CUSTOM" ? p.type : null;
  const native = figmaStyles(figma).find((s: any) => s.styleId === styleId) || null;
  const customList = await customStyles(figma);
  const custom = customList.styles.find((s: any) => s.id === styleId) || null;

  if (want === "FIGMA" && !native) fail("MOTION_STYLE_NOT_FOUND", `no Figma animation style ${styleId}`);
  if (want === "CUSTOM") {
    if (!customList.available) {
      fail("MOTION_UNAVAILABLE", `local custom animation styles are unavailable: ${customList.warning || "no API"}`);
    }
    if (!custom) fail("MOTION_STYLE_NOT_FOUND", `no local custom animation style ${styleId}`);
  }
  if (!want && !native && !custom) {
    if (!customList.available) {
      fail("MOTION_UNAVAILABLE", `style ${styleId} is not a Figma style, and local custom styles are unavailable: ${customList.warning || "no API"}`);
    }
    fail("MOTION_STYLE_NOT_FOUND", `no animation style ${styleId} in this file`);
  }

  const type = want || (native ? "FIGMA" : "CUSTOM");
  const style = type === "FIGMA" ? native : custom;
  return { type, styleId, name: style && style.name ? style.name : null, style };
}

function configFor(style: Json, p: Json): Json {
  const timelineOffset = optionalSeconds(p.timelineOffset, "timelineOffset");
  if (style.type === "CUSTOM") {
    if (p.duration !== undefined) fail("MOTION_INVALID", "a custom animation style does not take a duration");
    if (p.props !== undefined) fail("MOTION_INVALID", "a custom animation style does not take props");
    return { type: "CUSTOM", ...(timelineOffset === undefined ? {} : { timelineOffset }) };
  }
  const duration = optionalSeconds(p.duration, "duration");
  if (p.props !== undefined) {
    if (!p.props || typeof p.props !== "object" || Array.isArray(p.props)) {
      fail("MOTION_INVALID", "props must be an object keyed by animation-style property");
    }
  }
  const props = p.props === undefined ? undefined : clean(p.props);
  return {
    type: "FIGMA",
    ...(duration === undefined ? {} : { duration }),
    ...(timelineOffset === undefined ? {} : { timelineOffset }),
    ...(props === undefined ? {} : { props }),
  };
}

export async function motionApplyStyle(figma: any, p: Json, transact: MotionTransact): Promise<Json> {
  const node = await resolveNode(figma, p);
  needMethod(node, "applyAnimationStyle");
  const style = await resolveStyle(figma, p);
  const config = configFor(style, p);
  const state = readState(node);
  const plan = {
    op: "apply_style",
    target: identity(node),
    style: { styleId: style.styleId, name: style.name, type: style.type },
    config,
    state: stateFingerprint(state),
  };
  const gate = gatePlan(p, plan);
  const current = {
    animationStyles: state.animationStyles.map((s: any) => ({ id: s.id, type: s.type, name: s.name })),
    timelines: state.timelines,
  };
  if (gate.dryRun) return planEnvelope(gate, { current });

  return transact(async (mark) => {
    mark();
    const appliedStyleId = node.applyAnimationStyle(style.styleId, config);
    if (typeof appliedStyleId !== "string" || !appliedStyleId) {
      fail("MOTION_VERIFY_FAILED", "applyAnimationStyle did not return an applied style id");
    }
    const after = readState(node);
    const applied = after.animationStyles.find((s: any) => s.id === appliedStyleId);
    if (!applied) {
      fail("MOTION_VERIFY_FAILED", `applyAnimationStyle returned ${appliedStyleId}, but the node does not list it afterwards`);
    }
    if (applied.type !== style.type) {
      fail("MOTION_VERIFY_FAILED", `applied style type read back as ${applied.type}, expected ${style.type}`);
    }
    if (applied.styleId !== style.styleId) {
      fail("MOTION_VERIFY_FAILED", `applied styleId read back as ${applied.styleId}, expected ${style.styleId}`);
    }
    for (const prior of state.animationStyles) {
      if (!after.animationStyles.some((s: any) => s.id === prior.id)) {
        fail("MOTION_VERIFY_FAILED", `applying a style removed the previously applied style ${prior.id}`);
      }
    }
    if (config.duration !== undefined &&
        (!finite(applied.duration) || Math.abs(applied.duration - config.duration) > 1e-6)) {
      fail("MOTION_VERIFY_FAILED", `duration read back as ${applied.duration}, expected ${config.duration}`);
    }
    if (config.timelineOffset !== undefined &&
        (!finite(applied.timelineOffset) || Math.abs(applied.timelineOffset - config.timelineOffset) > 1e-6)) {
      fail("MOTION_VERIFY_FAILED", `timelineOffset read back as ${applied.timelineOffset}, expected ${config.timelineOffset}`);
    }
    for (const key of Object.keys(config.props || {})) {
      if (canonical(applied.props && applied.props[key]) !== canonical(config.props[key])) {
        fail("MOTION_VERIFY_FAILED", `property "${key}" read back differently from the plan`);
      }
    }
    return planEnvelope(gate, {
      mutated: true,
      appliedStyleId,
      appliedStyle: clean(applied),
      readback: {
        animationStyles: after.animationStyles.map((s: any) => ({ id: s.id, type: s.type, name: s.name, duration: s.duration, timelineOffset: s.timelineOffset })),
        timelines: after.timelines,
      },
    });
  });
}

export async function motionRemoveStyle(figma: any, p: Json, transact: MotionTransact): Promise<Json> {
  const node = await resolveNode(figma, p);
  needMethod(node, "removeAnimationStyle");
  const appliedStyleId = typeof p.appliedStyleId === "string" ? p.appliedStyleId : "";
  if (!appliedStyleId) fail("MOTION_INVALID", "appliedStyleId is required (read it from figma_motion_inspect)");
  const state = readState(node);
  const current = state.animationStyles.find((s: any) => s.id === appliedStyleId) || null;
  const plan = {
    op: "remove_style",
    target: identity(node),
    appliedStyleId,
    current: current ? clean(current) : null,
    state: stateFingerprint(state),
  };
  const gate = gatePlan(p, plan);
  if (gate.dryRun) return planEnvelope(gate, { wouldChange: !!current });
  if (!current) return planEnvelope(gate, { mutated: false, removed: false, note: "no such applied style; the plan is a no-op" });

  return transact(async (mark) => {
    mark();
    node.removeAnimationStyle(appliedStyleId);
    const after = readState(node);
    if (after.animationStyles.some((s: any) => s.id === appliedStyleId)) {
      fail("MOTION_VERIFY_FAILED", `style ${appliedStyleId} is still listed after removeAnimationStyle`);
    }
    for (const prior of state.animationStyles) {
      if (prior.id !== appliedStyleId && !after.animationStyles.some((s: any) => s.id === prior.id)) {
        fail("MOTION_VERIFY_FAILED", `removing ${appliedStyleId} also removed the applied style ${prior.id}`);
      }
    }
    return planEnvelope(gate, { mutated: true, removed: true, appliedStyleId, readback: { animationStyles: after.animationStyles } });
  });
}
