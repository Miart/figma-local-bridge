import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FigmaClient } from "./figma.js";
import { figmaNodeId } from "./node-id.js";
import { fileKeyParam } from "./file-key.js";
import { BridgeOffline } from "./websocket.js";
import type { Capabilities } from "./tools.js";

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BridgeOffline) throw new Error(err.message);
    throw err;
  }
}

const content = (v: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }],
});

const VALUE_TYPES = [
  "FLOAT", "COLOR", "TEXT_DATA", "VECTOR", "BOOL", "CIRCLE", "LINE",
  "CIRCLE_POINT", "COLOR_POINT",
] as const;

const EASING_TYPES = [
  "EASE_IN", "EASE_OUT", "EASE_IN_AND_OUT", "LINEAR", "EASE_IN_BACK",
  "EASE_OUT_BACK", "EASE_IN_AND_OUT_BACK", "CUSTOM_CUBIC_BEZIER", "GENTLE",
  "QUICK", "BOUNCY", "SLOW", "CUSTOM_SPRING", "HOLD", "VARIABLE_ALIAS",
] as const;

const motionValue = z
  .object({
    type: z.enum(VALUE_TYPES).describe("The value type Figma expects for this field"),
    value: z
      .any()
      .describe("FLOAT: number; COLOR: {r,g,b,a}; VECTOR: {x,y}; BOOL: boolean; TEXT_DATA: string; CIRCLE/LINE/CIRCLE_POINT/COLOR_POINT: their point object"),
  })
  .passthrough();

const easing = z
  .object({
    type: z.enum(EASING_TYPES),
    easingFunctionCubicBezier: z
      .object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() })
      .optional()
      .describe("Required for CUSTOM_CUBIC_BEZIER"),
    easingFunctionSpring: z
      .object({ bounce: z.number().min(0).max(1) })
      .optional()
      .describe("Required for CUSTOM_SPRING"),
    id: z.string().optional().describe("For type VARIABLE_ALIAS: the easing variable id"),
  })
  .passthrough();

const keyframe = z
  .object({
    id: z.string().optional().describe("Existing keyframe id to update; omit for a new keyframe"),
    timelinePosition: z.number().min(0).describe("Position on the timeline, in seconds"),
    value: motionValue,
    easing: easing.optional(),
  })
  .passthrough();

const keyframeField = z
  .object({
    type: z.enum(["PROPERTY", "INDEXED_ITEM"]),
    name: z.string().optional().describe("PROPERTY only: e.g. OPACITY, TRANSLATION_X, SCALE_XY, ROTATION"),
    collection: z.enum(["fills", "strokes", "effects"]).optional().describe("INDEXED_ITEM only"),
    index: z.number().int().min(0).optional().describe("INDEXED_ITEM only: zero-based paint or effect index"),
    field: z.string().optional().describe("INDEXED_ITEM effects only: e.g. RADIUS, COLOR, OFFSET_X"),
    propertyId: z.string().optional().describe("INDEXED_ITEM only: component-property id inside a paint or effect"),
  })
  .passthrough();

const track = z
  .object({
    id: z.string().optional().describe("Existing manual track id to update; omit for a new track"),
    baseValue: motionValue.optional().describe("Value the track starts from; same type as every keyframe"),
    keyframes: z.array(keyframe).min(1).max(1000),
  })
  .passthrough();

const nodeId = figmaNodeId("nodeId").optional().describe("Defaults to the current single selection");

const writeArgs = {
  dryRun: z.boolean().default(true).describe("TRUE (default): plan only, no document write. FALSE: apply in one undo transaction."),
  planId: z
    .string()
    .optional()
    .describe("The planId returned by the dry run. Apply is refused if the arguments or the node's Motion state changed."),
  fileKey: fileKeyParam,
};

export function registerMotionTools(server: McpServer, client: FigmaClient, caps: Capabilities) {
  server.tool(
    "figma_motion_styles",
    "Read-only Motion (Beta) catalogue: Figma animation styles and local custom animation styles, plus the animation playhead position. Every entry carries the id to pass to figma_motion_apply_style. On a Figma build without the Motion API this fails with MOTION_UNAVAILABLE; it does not return an empty catalogue that looks like a file with no styles.",
    { fileKey: fileKeyParam },
    async (a) => guard(async () => content(await client.call("motion_styles", { fileKey: a.fileKey }))),
  );

  server.tool(
    "figma_motion_inspect",
    "Read-only Motion (Beta) state of one node: applied animation styles, manual keyframe tracks, computed animations, timelines and which node-level Motion methods this build exposes. Use it before any Motion write; the ids and track shapes it returns are the inputs to the write tools.",
    { nodeId, fileKey: fileKeyParam },
    async (a) => guard(async () => content(await client.call("motion_inspect", a))),
  );

  server.tool(
    "figma_motion_apply_style",
    "Apply a Figma or custom animation style to a node (Motion Beta). dryRun defaults to TRUE and returns a planId plus the node's current styles/timelines. Apply with dryRun:false and that planId: the plugin re-reads the node, refuses a changed state, then verifies the applied style id, duration, offset and props by reading them back; any mismatch rolls the transaction back. A custom style accepts only timelineOffset, not duration or props.",
    {
      nodeId,
      styleId: z.string().min(1).describe("Figma styleId or custom style id from figma_motion_styles"),
      type: z.enum(["FIGMA", "CUSTOM"]).optional().describe("Style family; usually inferred from styleId, but explicit is safer"),
      duration: z.number().min(0).optional().describe("FIGMA style only: duration in seconds"),
      timelineOffset: z.number().min(0).optional().describe("Offset in seconds"),
      props: z.record(z.any()).optional().describe("FIGMA style only: values keyed by animation-style property"),
      ...writeArgs,
    },
    async (a) =>
      guard(async () => {
        if (a.dryRun === false && !caps.write) {
          throw new Error("figma_motion_apply_style cannot apply: the bridge is registered in read-only mode (FIGMA_BRIDGE_WRITE=0). dryRun:true still works.");
        }
        return content(await client.call("motion_apply_style", a, 120_000));
      }),
  );

  server.tool(
    "figma_motion_remove_style",
    "Remove one applied animation style by its applied instance id (not the style definition id) from a node (Motion Beta). dryRun defaults to TRUE. Removing a style that is not present is a verified no-op, not an error. Apply verifies the id is gone after the write and rolls back otherwise.",
    {
      nodeId,
      appliedStyleId: z.string().min(1).describe("The applied style's `id` from figma_motion_inspect"),
      ...writeArgs,
    },
    async (a) =>
      guard(async () => {
        if (a.dryRun === false && !caps.write) {
          throw new Error("figma_motion_remove_style cannot apply: the bridge is registered in read-only mode (FIGMA_BRIDGE_WRITE=0). dryRun:true still works.");
        }
        return content(await client.call("motion_remove_style", a, 120_000));
      }),
  );

  server.tool(
    "figma_motion_set_keyframes",
    "Set one manual keyframe track on a node (Motion Beta): a property such as OPACITY/TRANSLATION_X/SCALE_XY, a paint/stroke, or an effect field. The track carries baseValue and keyframes with timelinePosition in seconds; positions must be unique and all values in one track must share a type. dryRun defaults to TRUE; apply re-reads and verifies every keyframe's position, value and easing, then rolls back on any mismatch. This writes Motion data; it never fabricates a local animation.",
    {
      nodeId,
      field: keyframeField,
      track,
      ...writeArgs,
    },
    async (a) =>
      guard(async () => {
        if (a.dryRun === false && !caps.write) {
          throw new Error("figma_motion_set_keyframes cannot apply: the bridge is registered in read-only mode (FIGMA_BRIDGE_WRITE=0). dryRun:true still works.");
        }
        return content(await client.call("motion_set_keyframes", a, 120_000));
      }),
  );

  server.tool(
    "figma_motion_remove_keyframes",
    "Remove the manual keyframe track on one field of a node (Motion Beta). dryRun defaults to TRUE and reports the current track. Removing an absent track is a verified no-op. Apply verifies the field no longer has a manual track and rolls back otherwise.",
    {
      nodeId,
      field: keyframeField,
      ...writeArgs,
    },
    async (a) =>
      guard(async () => {
        if (a.dryRun === false && !caps.write) {
          throw new Error("figma_motion_remove_keyframes cannot apply: the bridge is registered in read-only mode (FIGMA_BRIDGE_WRITE=0). dryRun:true still works.");
        }
        return content(await client.call("motion_remove_keyframes", a, 120_000));
      }),
  );

  server.tool(
    "figma_motion_set_duration",
    "Set a Motion timeline's duration in seconds (Motion Beta). Pass the timeline id from figma_motion_inspect; the node must list that timeline. dryRun defaults to TRUE. Apply reads the timeline back and rolls back if Figma reports a different duration or the timeline disappears.",
    {
      nodeId,
      timelineId: z.string().min(1),
      duration: z.number().min(0).describe("Seconds"),
      ...writeArgs,
    },
    async (a) =>
      guard(async () => {
        if (a.dryRun === false && !caps.write) {
          throw new Error("figma_motion_set_duration cannot apply: the bridge is registered in read-only mode (FIGMA_BRIDGE_WRITE=0). dryRun:true still works.");
        }
        return content(await client.call("motion_set_duration", a, 120_000));
      }),
  );
}
