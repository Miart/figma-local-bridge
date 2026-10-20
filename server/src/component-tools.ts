import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FigmaClient } from "./figma.js";
import { figmaNodeIds, figmaNodeId } from "./node-id.js";
import { fileKeyParam } from "./file-key.js";
import { BridgeOffline } from "./websocket.js";
import type { Capabilities } from "./tools.js";
import { planIdOf } from "./build-tools.js";

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

export function registerComponentTools(server: McpServer, client: FigmaClient, caps: Capabilities) {
  server.tool(
    "figma_swap_component",
    "Swap one or more INSTANCEs to another main component in ONE transaction, preserving the overrides that still fit. " +
      "The dry run (default) compares the old and new structures and returns, per target: a fingerprint of the instance and the target component, an exact or name-remapped path for every direct layer override, mapped component properties (by display name and type), root-level instance overrides (custom name, resized geometry, opacity, fills/strokes/effects and style links, layout placement) and every named loss. " +
      "Apply with the returned planId and expectedFingerprints; it refuses a document that moved, a lossy swap unless allowLoss:true, and a library component whose structure could not be checked unless allowUnverified:true. " +
      "Variant properties are not replayed — the chosen target component decides them. A layer whose node type changed, a missing layer, a changed nested component and a SLOT property are reported, never applied to a guessed layer. " +
      "A target nested inside another INSTANCE is refused: that is an override of the outer instance, not an independent swap. The apply is one undo step; a failure rolls the whole call back, and the report says what rolled back. " +
      "Plugin API swapComponent is the mechanism; Figma's own override heuristics are re-checked, not trusted.",
    {
      nodeIds: figmaNodeIds("nodeIds", 50).describe("INSTANCE targets (1–50). Their current main components may differ."),
      componentId: figmaNodeId("componentId").optional().describe("A local COMPONENT to swap to"),
      componentKey: z.string().min(1).max(400).optional().describe("A local or library COMPONENT key; a library key is imported on apply"),
      componentName: z
        .string()
        .min(1)
        .max(400)
        .optional()
        .describe("Exact local COMPONENT or COMPONENT_SET name; ambiguous names are refused"),
      componentSetId: figmaNodeId("componentSetId").optional().describe("A local COMPONENT_SET; combine with variantProperties to pick a variant"),
      componentSetKey: z
        .string()
        .min(1)
        .max(400)
        .optional()
        .describe("A local or library COMPONENT_SET key; combine with variantProperties to pick a variant"),
      variantProperties: z
        .record(z.string())
        .optional()
        .describe('Variant selector for a component set, e.g. {"Size":"L","Tone":"Dark"}. Omit for the default variant.'),
      preserveRootOverrides: z
        .boolean()
        .default(true)
        .describe("Reapply custom name, size, opacity, paints, effects, layout placement and style links that differ from the old main component"),
      preserveSize: z
        .boolean()
        .default(true)
        .describe("Keep an instance that was manually resized at its old size; false adopts the new component's size"),
      allowLoss: z
        .boolean()
        .default(false)
        .describe("Apply even when the dry run named a layer/property loss; the same losses are then reported"),
      allowUnverified: z
        .boolean()
        .default(false)
        .describe("Apply a library component whose structure could not be compared before import"),
      dryRun: z.boolean().default(true).describe("TRUE (default): compare and fingerprint only. FALSE: apply in one undo transaction."),
      expectedFingerprints: z
        .record(z.string())
        .optional()
        .describe("Required on apply: nodeId -> fingerprint from the dry run, covering the instance state and target component. A changed target is refused before writing."),
      planId: z
        .string()
        .optional()
        .describe("The planId returned by figma_swap_component; if supplied on apply, a different request is refused before it is sent"),
      fileKey: fileKeyParam,
    },
    async (a) =>
      guard(async () => {
        const refs = [a.componentId, a.componentKey, a.componentName, a.componentSetId, a.componentSetKey].filter(
          (v) => v !== undefined && v !== null && v !== "",
        );
        if (refs.length !== 1) {
          throw new Error("figma_swap_component needs exactly one of componentId, componentKey, componentName, componentSetId or componentSetKey");
        }
        if (a.variantProperties !== undefined && !a.componentSetId && !a.componentSetKey && !a.componentName) {
          throw new Error("variantProperties can only be used with componentSetId, componentSetKey or a component-set name");
        }
        if (a.dryRun === false && !caps.write) {
          throw new Error(
            "figma_swap_component cannot apply: the bridge is registered in read-only mode (FIGMA_BRIDGE_WRITE=0). dryRun:true still works.",
          );
        }
        const pid = planIdOf(a);
        if (a.dryRun === false && a.planId && a.planId !== pid) {
          throw new Error(
            `PLAN_MISMATCH: this swap request hashes to ${pid}, not ${a.planId}. It changed since the dry run; run figma_swap_component with dryRun:true again.`,
          );
        }
        const result: any = await client.call("swap_component", { ...a, planId: pid }, 180_000);
        return content({ ...result, planId: pid });
      }),
  );
}
