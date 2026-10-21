/**
 * Manual keyframe tracks: set and remove.
 *
 * The field/value rules live in motion-values.ts; this file only gates the
 * plan, opens the transaction, writes, and reads the track back. A keyframe that
 * Figma silently clamps or reorders must fail here rather than be reported as
 * applied.
 */
import {
  clean, fail, gatePlan, identity, needMethod, planEnvelope, readState,
  resolveNode, stateFingerprint, type Json, type MotionTransact,
} from "./motion-core";
import { normalizeField, normalizeTrack, trackFor, verifyTrack } from "./motion-values";

export async function motionSetKeyframes(figma: any, p: Json, transact: MotionTransact): Promise<Json> {
  const node = await resolveNode(figma, p);
  needMethod(node, "applyManualKeyframeTrack");
  const field = normalizeField(p.field);
  const track = normalizeTrack(p.track);
  const state = readState(node);
  const current = trackFor(node, field);
  const plan = {
    op: "set_keyframes",
    target: identity(node),
    field,
    track,
    current: current ? clean(current) : null,
    state: stateFingerprint(state),
  };
  const gate = gatePlan(p, plan);
  if (gate.dryRun) return planEnvelope(gate, { current: current ? clean(current) : null });

  return transact(async (mark) => {
    mark();
    node.applyManualKeyframeTrack(field, track);
    const readback = verifyTrack(node, field, track);
    return planEnvelope(gate, {
      mutated: true,
      field,
      readback,
      timelines: readState(node).timelines,
    });
  });
}

export async function motionRemoveKeyframes(figma: any, p: Json, transact: MotionTransact): Promise<Json> {
  const node = await resolveNode(figma, p);
  needMethod(node, "removeManualKeyframeTrack");
  const field = normalizeField(p.field);
  const state = readState(node);
  const current = trackFor(node, field);
  const plan = {
    op: "remove_keyframes",
    target: identity(node),
    field,
    current: current ? clean(current) : null,
    state: stateFingerprint(state),
  };
  const gate = gatePlan(p, plan);
  if (gate.dryRun) return planEnvelope(gate, { wouldChange: !!current });
  if (!current) return planEnvelope(gate, { mutated: false, removed: false, note: "there is no manual track on this field; the plan is a no-op" });

  return transact(async (mark) => {
    mark();
    node.removeManualKeyframeTrack(field);
    if (trackFor(node, field)) {
      fail("MOTION_VERIFY_FAILED", "the manual track is still present after removeManualKeyframeTrack");
    }
    return planEnvelope(gate, { mutated: true, removed: true, field, timelines: readState(node).timelines });
  });
}
