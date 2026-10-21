/**
 * Timeline duration.
 *
 * A timeline belongs to the containing top-level frame; the node and the
 * timeline id are both checked, because setting a duration on a stale id after
 * the frame was renamed or rebuilt must not look like success.
 */
import {
  clean, fail, finite, gatePlan, identity, needMethod, planEnvelope, readState,
  resolveNode, stateFingerprint, type Json, type MotionTransact,
} from "./motion-core";

export async function motionSetDuration(figma: any, p: Json, transact: MotionTransact): Promise<Json> {
  const node = await resolveNode(figma, p);
  needMethod(node, "setTimelineDuration");
  const timelineId = typeof p.timelineId === "string" ? p.timelineId : "";
  if (!timelineId) fail("MOTION_INVALID", "timelineId is required (read it from figma_motion_inspect)");
  if (!finite(p.duration) || p.duration < 0) {
    fail("MOTION_INVALID", "duration must be a finite number >= 0 seconds");
  }
  const state = readState(node);
  const timeline = state.timelines.find((t: any) => t.id === timelineId);
  if (!timeline) {
    fail(
      "MOTION_TIMELINE_NOT_FOUND",
      `node ${node.id} does not list timeline ${timelineId}; inspect the top-level frame and use its timeline id`,
    );
  }
  const plan = {
    op: "set_duration",
    target: identity(node),
    timeline: { id: timeline.id, currentDuration: timeline.duration },
    duration: p.duration,
    state: stateFingerprint(state),
  };
  const gate = gatePlan(p, plan);
  if (gate.dryRun) return planEnvelope(gate, { current: clean(timeline) });

  return transact(async (mark) => {
    mark();
    node.setTimelineDuration(timelineId, p.duration);
    const after = readState(node).timelines.find((t: any) => t.id === timelineId);
    if (!after) fail("MOTION_VERIFY_FAILED", `timeline ${timelineId} is gone after setTimelineDuration`);
    if (!finite(after.duration) || Math.abs(after.duration - p.duration) > 1e-6) {
      fail("MOTION_VERIFY_FAILED", `duration read back as ${after.duration}s, expected ${p.duration}s`);
    }
    return planEnvelope(gate, { mutated: true, timeline: clean(after), readback: { timelines: readState(node).timelines } });
  });
}
