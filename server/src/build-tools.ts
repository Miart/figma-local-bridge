import { createHash } from "node:crypto";
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

// ---------------------------------------------------------------- schema

const paintSchema = z.union([
  z.string().describe("A colour: #rrggbb, #rrggbbaa, rgb(...) or rgba(...)"),
  z
    .object({
      type: z.string().optional(),
      color: z.string().optional(),
      opacity: z.number().min(0).max(1).optional(),
      variable: z.string().optional().describe("Local colour variable name or id"),
      imageHash: z.string().optional(),
      videoHash: z.string().optional(),
      scaleMode: z.enum(["FILL", "FIT", "CROP", "TILE"]).optional(),
      imageTransform: z.array(z.array(z.number())).optional().describe("IMAGE crop transform (CROP only)"),
      videoTransform: z.array(z.array(z.number())).optional().describe("VIDEO crop transform (CROP only)"),
      scalingFactor: z.number().optional().describe("IMAGE tile scaling (TILE only)"),
      rotation: z.number().optional().describe("IMAGE rotation in degrees"),
      filters: z
        .object({
          exposure: z.number().optional(),
          contrast: z.number().optional(),
          saturation: z.number().optional(),
          temperature: z.number().optional(),
          tint: z.number().optional(),
          highlights: z.number().optional(),
          shadows: z.number().optional(),
        })
        .passthrough()
        .optional(),
      visible: z.boolean().optional().describe("false keeps the paint in the stack but hidden"),
      blendMode: z.string().optional(),
      stops: z.array(z.object({ at: z.number(), color: z.string() })).optional(),
      gradientTransform: z.array(z.array(z.number())).optional(),
    })
    .passthrough(),
]);

const fontSchema = z.union([
  z.string().describe('"Inter/Regular" or "Inter:Regular"'),
  z.object({ family: z.string(), style: z.string().optional() }),
]);

const layoutSchema = z
  .object({
    mode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]).optional(),
    gap: z.number().min(0).optional(),
    counterAxisSpacing: z.number().min(0).optional(),
    padding: z
      .union([
        z.number().min(0),
        z.array(z.number().min(0)).min(1).max(4),
        z.object({
          top: z.number().min(0).optional(),
          right: z.number().min(0).optional(),
          bottom: z.number().min(0).optional(),
          left: z.number().min(0).optional(),
        }),
      ])
      .optional(),
    align: z.enum(["MIN", "CENTER", "MAX", "SPACE_BETWEEN"]).optional(),
    crossAlign: z.enum(["MIN", "CENTER", "MAX", "BASELINE"]).optional(),
    wrap: z.enum(["NO_WRAP", "WRAP"]).optional(),
    clipsContent: z.boolean().optional(),
    grow: z.number().optional(),
    alignSelf: z.enum(["INHERIT", "STRETCH", "MIN", "CENTER", "MAX"]).optional(),
    absolute: z.boolean().optional(),
    positioning: z.enum(["AUTO", "ABSOLUTE"]).optional(),
    sizing: z
      .object({
        horizontal: z.enum(["FIXED", "HUG", "FILL", "AUTO"]).optional(),
        vertical: z.enum(["FIXED", "HUG", "FILL", "AUTO"]).optional(),
        primaryAxis: z.enum(["FIXED", "HUG", "FILL", "AUTO"]).optional(),
        counterAxis: z.enum(["FIXED", "HUG", "FILL", "AUTO"]).optional(),
      })
      .optional(),
    minWidth: z.number().min(0).optional(),
    maxWidth: z.number().min(0).optional(),
    minHeight: z.number().min(0).optional(),
    maxHeight: z.number().min(0).optional(),
  })
  .passthrough();

const layoutGridSchema = z
  .object({
    pattern: z.enum(["COLUMNS", "ROWS", "GRID"]),
    visible: z.boolean().optional(),
    color: z.string().optional().describe("A colour with optional alpha; default is 10% red"),
    alignment: z.enum(["MIN", "MAX", "CENTER", "STRETCH"]).optional(),
    gutterSize: z.number().min(0).optional(),
    offset: z.number().min(0).optional(),
    count: z.number().int().min(1).optional(),
    sectionSize: z.number().positive().optional(),
  })
  .passthrough();

const textVariableRef = z.string().min(1).nullable();
const textVariableSchema = z
  .object({
    fontFamily: textVariableRef.optional(),
    fontStyle: textVariableRef.optional(),
    fontWeight: textVariableRef.optional(),
    fontSize: textVariableRef.optional(),
    letterSpacing: textVariableRef.optional(),
    lineHeight: textVariableRef.optional(),
    paragraphSpacing: textVariableRef.optional(),
    paragraphIndent: textVariableRef.optional(),
  })
  .passthrough();

const textRunSchema = z
  .object({
    start: z.number().int().min(0).describe("Start character offset (inclusive, UTF-16)"),
    end: z.number().int().positive().describe("End character offset (exclusive)"),
    font: fontSchema.optional(),
    fontSize: z.number().positive().optional(),
    textStyle: z.string().min(1).nullable().optional().describe("Local text style name or id for this range; null clears the link"),
    fills: z.union([paintSchema, z.array(paintSchema)]).optional(),
    fillStyle: z.string().min(1).nullable().optional().describe("Local paint style name or id for this range; null clears the link"),
    variable: textVariableSchema.optional().describe("Text-field bindings for this range; null clears a binding inherited from the base"),
    textCase: z.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE", "SMALL_CAPS", "SMALL_CAPS_FORCED"]).optional(),
    textDecoration: z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional(),
    lineHeight: z.union([z.number(), z.object({ unit: z.string(), value: z.number() })]).optional(),
    letterSpacing: z.union([z.number(), z.object({ unit: z.string(), value: z.number() })]).optional(),
    hyperlink: z.object({ type: z.enum(["URL", "NODE"]), value: z.string().min(1) }).nullable().optional(),
  })
  .passthrough();

/**
 * The IR node. Kept deliberately structural: every field here has a direct
 * Plugin API counterpart. Anything that would require an agent to fall back to
 * arbitrary JS is either modelled (fills, layout, variants, overrides) or
 * refused with a reason by the plugin.
 */
const buildNodeSchema: z.ZodType<any> = z.lazy(() =>
  z
    .object({
      key: z.string().min(1).max(160).optional().describe("Stable engine identity. Omit to derive deterministically from the path."),
      type: z
        .string()
        .describe("FRAME | RECTANGLE | ELLIPSE | LINE | TEXT | INSTANCE | COMPONENT | SVG | BOOLEAN_OPERATION (RECT aliases RECTANGLE; BOOLEAN aliases BOOLEAN_OPERATION)"),
      booleanOperation: z
        .enum(["UNION", "SUBTRACT", "INTERSECT", "EXCLUDE"])
        .optional()
        .describe(
          "BOOLEAN_OPERATION only. Required when creating a boolean; omitted on a patch keeps the current operation. " +
            "The operation can be changed in place on an existing boolean.",
        ),
      name: z.string().optional(),
      text: z.string().optional(),
      font: fontSchema.optional(),
      fontSize: z.number().positive().optional(),
      textStyle: z.string().optional().describe("Local text style name or id"),
      textVariable: textVariableSchema.optional().describe("TEXT only. Bind base text fields to local variables; runs can override by range"),
      textAutoResize: z.enum(["NONE", "WIDTH_AND_HEIGHT", "HEIGHT", "TRUNCATE"]).optional(),
      textAlignHorizontal: z.enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]).optional(),
      textAlignVertical: z.enum(["TOP", "CENTER", "BOTTOM"]).optional(),
      lineHeight: z.union([z.number(), z.object({ unit: z.string(), value: z.number() })]).optional(),
      letterSpacing: z.union([z.number(), z.object({ unit: z.string(), value: z.number() })]).optional(),
      textCase: z.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE", "SMALL_CAPS", "SMALL_CAPS_FORCED"]).optional(),
      textDecoration: z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional(),
      paragraphSpacing: z.number().min(0).optional(),
      paragraphIndent: z.number().min(0).optional(),
      hyperlink: z
        .object({ type: z.enum(["URL", "NODE"]), value: z.string().min(1) })
        .nullable()
        .optional()
        .describe("TEXT only. A URL link, or a NODE link to a node id in the same file; null clears it on patch"),
      runs: z
        .array(textRunSchema)
        .max(200)
        .optional()
        .describe(
          "TEXT only. Ordered, non-overlapping character ranges with per-run font, size, text style, fills, fill style, variable bindings, case, decoration, line height, letter spacing or hyperlink. Omitted fields inherit the node's base text properties.",
        ),

      fills: z.union([paintSchema, z.array(paintSchema)]).optional(),
      strokes: z.union([paintSchema, z.array(paintSchema)]).optional(),
      fillStyle: z.string().optional().describe("Local paint style name or id"),
      strokeStyle: z.string().optional().describe("Local paint style name or id"),
      effectStyle: z.string().optional().describe("Local effect style name or id"),
      strokeWeight: z.number().min(0).optional(),
      strokeAlign: z.enum(["INSIDE", "OUTSIDE", "CENTER"]).optional(),
      strokeCap: z.enum(["NONE", "ROUND", "SQUARE", "ARROW_LINES", "ARROW_EQUILATERAL"]).optional(),
      strokeJoin: z.enum(["MITER", "BEVEL", "ROUND"]).optional(),
      strokeMiterLimit: z.number().min(0).optional(),
      dashPattern: z.array(z.number()).optional(),
      rotation: z.number().optional().describe("Degrees, clockwise; Figma's rotation property"),
      cornerRadius: z.number().min(0).optional(),
      topLeftRadius: z.number().min(0).optional(),
      topRightRadius: z.number().min(0).optional(),
      bottomRightRadius: z.number().min(0).optional(),
      bottomLeftRadius: z.number().min(0).optional(),
      cornerSmoothing: z.number().min(0).max(1).optional(),
      isMask: z.boolean().optional(),
      itemReverseZIndex: z.boolean().optional(),
      strokesIncludedInLayout: z.boolean().optional(),
      layoutGrids: z.array(layoutGridSchema).max(32).optional(),
      effects: z.array(z.any()).optional(),
      opacity: z.number().min(0).max(1).optional(),
      visible: z.boolean().optional(),
      locked: z.boolean().optional(),
      blendMode: z.string().optional(),
      constraints: z
        .object({ horizontal: z.string(), vertical: z.string() })
        .optional(),

      size: z
        .object({ width: z.number().positive(), height: z.number().positive() })
        .optional()
        .describe("A BOOLEAN_OPERATION derives its size from its operands; size on a boolean is ignored with a warning."),
      length: z.number().positive().optional().describe("LINE only: width in pixels; the build creates a horizontal line and rotation angles it"),
      position: z.object({ x: z.number(), y: z.number() }).optional(),
      layout: layoutSchema.optional(),

      componentId: figmaNodeId("componentId").optional(),
      componentKey: z.string().optional().describe("Published component key (library or local)"),
      componentName: z.string().optional().describe("Exact local component name; ambiguous names are refused"),
      componentSetKey: z.string().optional(),
      properties: z.record(z.union([z.string(), z.boolean()])).optional().describe("Instance component properties / variants"),
      overrides: z.record(z.any()).optional().describe("Map of layer name or key -> override, or an override with a path: [{name,index}, ...]. Fields: text, font, fontSize, textStyle, textCase, textDecoration, lineHeight, letterSpacing, paragraphSpacing, paragraphIndent, textAlignHorizontal/Vertical, textAutoResize, hyperlink, fills, strokes, fillStyle, strokeStyle, effectStyle, effects, visible, locked, opacity, blendMode, rotation, cornerRadius and per-corner radii, strokeWeight, size, name"),

      svg: z.string().optional(),
      protected: z.boolean().optional().describe("Refuse prune deletion of this node"),
      children: z.array(buildNodeSchema).optional(),
    })
    .passthrough(),
);

// ---------------------------------------------------------------- plan id

/**
 * A plan id is a content hash of everything that determines the write, minus
 * the approval fields themselves. It is not security: it is a cheap way to stop
 * "I dry-ran one spec and applied another" from landing silently.
 */
function canonical(v: any): any {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) {
      if (v[k] !== undefined) out[k] = canonical(v[k]);
    }
    return out;
  }
  return v;
}

export function planIdOf(args: any): string {
  // Approval fields are not part of the spec. If the dry run returns a planId
  // and the caller applies with that id plus the returned fingerprint, the two
  // calls MUST hash the same thing; otherwise the safe workflow would always
  // look like a changed plan.
  const { dryRun, planId, fileKey, expectedFingerprint, expectedFingerprints, stopOnError, ...rest } = args || {};
  return createHash("sha256").update(JSON.stringify(canonical(rest))).digest("hex").slice(0, 20);
}

// ---------------------------------------------------------------- tools

export function registerBuildTools(server: McpServer, client: FigmaClient, caps: Capabilities) {
  server.tool(
    "figma_build",
    "Create or update a declarative, keyed UI tree in ONE transaction. The spec is validated and resolved (fonts, styles, local variables, components) before anything is written; every node gets a stable key in pluginData, so re-sending the same buildId updates instead of duplicating. " +
      "dryRun defaults to TRUE and returns a real plan plus a scope fingerprint. Pass dryRun:false with that fingerprint to apply. An existing root with the same buildId is patched in place; prune:true makes the tree exact by deleting keyed children the spec no longer contains. " +
      "An SVG leaf is created as a frame; re-sending it updates that frame in place, and a changed svg source replaces its interior while keeping the id and key. " +
      "A BOOLEAN_OPERATION is created from at least two operands in spec order (first operand is the subtract/intersect base) and can change its operation in place; its size is derived from the operands and is ignored. " +
      "Refuses type changes, ambiguous component names, unknown keys, position inside auto-layout, component swaps, and unsupported node types.",
    {
      buildId: z
        .string()
        .min(1)
        .max(160)
        .optional()
        .describe("Stable build scope. Defaults to root.key. Re-send the same id to update the same root."),
      mode: z.enum(["upsert", "create"]).default("upsert").describe("upsert: create or update by buildId; create: refuse if it exists"),
      parentId: figmaNodeId("parentId").optional().describe("Container for a new root; defaults to the current page"),
      root: buildNodeSchema.describe(
        "The tree. FRAME, COMPONENT and BOOLEAN_OPERATION may have children; an INSTANCE uses properties/overrides.",
      ),
      prune: z
        .boolean()
        .default(false)
        .describe("Delete keyed children not present in the spec, at every level. Protected nodes are skipped and reported."),
      dryRun: z.boolean().default(true).describe("TRUE (default): plan and validate only. FALSE: apply in one undo transaction."),
      expectedFingerprint: z
        .string()
        .optional()
        .describe("Scope fingerprint from a previous dry run. Apply refuses if the document has moved since."),
      planId: z
        .string()
        .optional()
        .describe("The planId returned by figma_build; if supplied on apply, a different spec is refused before it is sent."),
      fileKey: fileKeyParam,
    },
    async (a) =>
      guard(async () => {
        if (a.dryRun === false && !caps.write) {
          throw new Error("figma_build cannot apply: the bridge is registered in read-only mode (FIGMA_BRIDGE_WRITE=0). dryRun:true still works.");
        }
        const pid = planIdOf(a);
        if (a.dryRun === false && a.planId && a.planId !== pid) {
          throw new Error(
            `PLAN_MISMATCH: this spec hashes to ${pid}, not ${a.planId}. It changed since the dry run; run figma_build again with dryRun:true.`,
          );
        }
        const result: any = await client.call("build", { ...a, planId: pid }, 180_000);
        return content({ ...result, planId: pid });
      }),
  );

  server.tool(
    "figma_patch",
    "Update an existing keyed tree by stable key, in ONE transaction. A dry run is a real diff: it reports create/update/delete counts and a scope fingerprint without writing. " +
      "Missing keys are refused unless allowCreate:true; a key that lives under a different parent is refused rather than duplicated; prune:true deletes keyed children omitted from the patch at each patched level. An SVG leaf keeps its frame id and key while a changed svg source replaces its interior. A BOOLEAN_OPERATION patch may list only the operands it changes when prune is false; pruning a boolean requires at least two operands in the patch. A sparse boolean patch keeps the existing operand order and appends a new operand; send the complete ordered list with prune:true to enforce order. Text updates load their fonts before writing, and any failure rolls the whole patch back. " +
      "Target with rootNodeId, buildId or rootKey.",
    {
      rootNodeId: figmaNodeId("rootNodeId").optional().describe("The built root, by id"),
      buildId: z.string().min(1).max(160).optional().describe("The buildId stored on the root"),
      rootKey: z.string().min(1).max(160).optional().describe("The stable key stored on the root"),
      patch: buildNodeSchema.describe("Sparse tree: only supplied properties are applied. Children are matched by key."),
      allowCreate: z.boolean().default(false).describe("Create keys that are not present under the matched parent"),
      prune: z.boolean().default(false).describe("Delete keyed children omitted from the patch at each patched level"),
      dryRun: z.boolean().default(true).describe("TRUE (default): diff only. FALSE: apply in one undo transaction."),
      expectedFingerprint: z.string().optional(),
      planId: z.string().optional(),
      fileKey: fileKeyParam,
    },
    async (a) => {
      if (!a.rootNodeId && !a.buildId && !a.rootKey) {
        throw new Error("figma_patch needs one of rootNodeId, buildId or rootKey");
      }
      return guard(async () => {
        if (a.dryRun === false && !caps.write) {
          throw new Error("figma_patch cannot apply: the bridge is registered in read-only mode (FIGMA_BRIDGE_WRITE=0). dryRun:true still works.");
        }
        const pid = planIdOf(a);
        if (a.dryRun === false && a.planId && a.planId !== pid) {
          throw new Error(
            `PLAN_MISMATCH: this patch hashes to ${pid}, not ${a.planId}. It changed since the dry run; run figma_patch again with dryRun:true.`,
          );
        }
        const result: any = await client.call("patch", { ...a, planId: pid }, 180_000);
        return content({ ...result, planId: pid });
      });
    },
  );
}
