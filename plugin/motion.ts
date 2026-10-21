/**
 * Motion command dispatcher.
 *
 * The commands themselves are split by what they do — catalogue, inspect,
 * styles, keyframes, duration — so each one keeps its own plan and readback
 * together. This file exists only so tools.ts has one import and one switch.
 */
import { fail, type Json, type MotionTransact } from "./motion-core";
import { motionInspect, motionStyles } from "./motion-read";
import { motionApplyStyle, motionRemoveStyle } from "./motion-style";
import { motionRemoveKeyframes, motionSetKeyframes } from "./motion-keyframes";
import { motionSetDuration } from "./motion-duration";

export async function runMotion(
  figma: any,
  method: string,
  p: Json,
  transact: MotionTransact,
): Promise<Json> {
  switch (method) {
    case "motion_styles": return motionStyles(figma);
    case "motion_inspect": return motionInspect(figma, p);
    case "motion_apply_style": return motionApplyStyle(figma, p, transact);
    case "motion_remove_style": return motionRemoveStyle(figma, p, transact);
    case "motion_set_keyframes": return motionSetKeyframes(figma, p, transact);
    case "motion_remove_keyframes": return motionRemoveKeyframes(figma, p, transact);
    case "motion_set_duration": return motionSetDuration(figma, p, transact);
    default: return fail("MOTION_UNKNOWN_METHOD", `unknown Motion method ${method}`);
  }
}
