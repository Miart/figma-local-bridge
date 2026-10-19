import { z } from "zod";

/**
 * The two shapes the Plugin API hands out:
 *
 *   - top-level node:           "4029:12345"
 *   - child inside an instance: "I12740:17806;12740:17793" (deeper: "…;…")
 *
 * The hyphenated form ("4029-12345") is what Figma URLs carry, so agents paste
 * it constantly and every call gets "node not found" from a plugin that could
 * never resolve it. Refusing it at the tool edge costs one message and says
 * what is actually wrong.
 */
export const FIGMA_NODE_ID_PATTERN = /^(?:\d+:\d+|I\d+:\d+(?:;\d+:\d+)+)$/;

const EXPLAIN =
  "a Figma node id looks like '4029:12345' (or 'I12740:17806;12740:17793' for a " +
  "child inside an instance). Hyphenated ids from Figma URLs ('4029-12345') do not " +
  "resolve: replace the hyphen with a colon.";

/** Validated node id. `what` names the field, since tools accept several. */
export function figmaNodeId(what = "nodeId") {
  return z.string().regex(FIGMA_NODE_ID_PATTERN, { message: `${what} must be ${EXPLAIN}` });
}

/** Non-empty list of validated node ids. */
export function figmaNodeIds(what = "nodeIds", max = 100) {
  return z.array(figmaNodeId(what)).min(1).max(max);
}
