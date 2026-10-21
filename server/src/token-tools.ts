import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FigmaClient } from "./figma.js";
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

const MAX_FILE_BYTES = 16 * 1024 * 1024;

function readDocument(path: string): { document: any; sourceSha256: string; bytes: number } {
  let stat;
  try {
    stat = statSync(path);
  } catch (e: any) {
    throw new Error(`cannot read token document at ${path}: ${e && e.message ? e.message : e}`);
  }
  if (!stat.isFile()) throw new Error(`${path} is not a file`);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`${path} is ${stat.size} bytes; the token document limit is ${MAX_FILE_BYTES}`);
  const text = readFileSync(path, "utf8");
  let document: any;
  try {
    document = JSON.parse(text);
  } catch (e: any) {
    throw new Error(`cannot parse token JSON at ${path}: ${e && e.message ? e.message : e}`);
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`${path} is not a JSON object`);
  }
  return {
    document,
    sourceSha256: createHash("sha256").update(text).digest("hex"),
    bytes: Buffer.byteLength(text),
  };
}

export function registerTokenTools(server: McpServer, client: FigmaClient, caps: Capabilities) {
  server.tool(
    "figma_tokens",
    "Export, diff or sync the file's local variables as a design-token document. " +
      '"export" writes figma-tokens/v1 with every collection, mode, value, description and alias; "diff" compares a document with the live file; "import" (dry run by default) creates missing collections, modes and variables, updates values/descriptions, and verifies every mode after writing. ' +
      "A plain DTCG tree is accepted on import with collection/mode (default Tokens / Mode 1); supported types are color, number, dimension (px is dropped into a unitless FLOAT), string, boolean, fontFamily and fontWeight. Unsupported DTCG types block the import instead of being dropped. " +
      "Import is one undo transaction and requires the fingerprint from a dry run plus the planId; a changed file or changed live variables is refused before writing. A remote/library alias carries remote:true and its live variable id; only an unchanged binding is preserved, never rebound by name. prune is off by default and, when enabled, deletes only variables in the named collections and only with allowDestructive:true; aliases pointing at a pruned variable block the plan. Modes that the document does not name are preserved for existing variables and filled from the default managed mode for new variables, with that fact in the plan.",
    {
      action: z.enum(["export", "diff", "import"]).default("export").describe("export: write the live variables to path | diff: compare path with live | import: dry run or apply path"),
      path: z.string().min(1).describe("export: destination JSON; diff/import: the token document to read"),
      collection: z.string().optional().describe("Plain DTCG import: destination collection name (default Tokens)"),
      mode: z.string().optional().describe("Plain DTCG import: destination mode name (default Mode 1)"),
      prune: z
        .boolean()
        .default(false)
        .describe("Import: delete variables absent from the document in the named collections. Off by default."),
      allowDestructive: z
        .boolean()
        .default(false)
        .describe("Import + prune: confirms variable deletion. Node bindings to deleted variables will break."),
      dryRun: z.boolean().default(true).describe("Import: TRUE (default) plans and fingerprints; FALSE applies."),
      expectedFingerprint: z
        .string()
        .optional()
        .describe("Import apply: the fingerprint returned by the dry run; required when dryRun:false."),
      planId: z
        .string()
        .optional()
        .describe("Import apply: the planId returned by the dry run; required when dryRun:false."),
      maxChanges: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .default(500)
        .describe("Maximum changes listed in the reply; counts stay complete and truncation is reported."),
      fileKey: fileKeyParam,
    },
    async (a) =>
      guard(async () => {
        if (a.action !== "export" && a.action !== "diff" && a.action !== "import") {
          throw new Error(`unknown figma_tokens action ${a.action}`);
        }
        if (a.dryRun === false && a.action !== "import") {
          throw new Error("dryRun:false only applies to figma_tokens action \"import\"");
        }
        if (a.action === "import" && a.dryRun === false && !caps.write) {
          throw new Error(
            "figma_tokens cannot apply: the bridge is registered in read-only mode (FIGMA_BRIDGE_WRITE=0). dryRun:true still works.",
          );
        }
        if (a.action === "import" && a.dryRun === false && a.prune && !a.allowDestructive) {
          throw new Error("figma_tokens prune needs allowDestructive:true on apply; run a dry run first to see exactly which variables would be deleted.");
        }
        if (a.action === "import" && a.dryRun === false && a.prune && !caps.destructive) {
          throw new Error(
            "figma_tokens cannot prune: the bridge is started without FIGMA_BRIDGE_DESTRUCTIVE=1. dryRun:true still shows the plan.",
          );
        }

        if (a.action === "export") {
          const path = resolve(a.path);
          const result: any = await client.call("tokens", { action: "export", fileKey: a.fileKey }, 180_000);
          if (!result || !result.document || typeof result.document !== "object" || Array.isArray(result.document)) {
            throw new Error("the plugin returned no token document; nothing was written");
          }
          const document = {
            ...(result.document && typeof result.document === "object" ? result.document : {}),
            exportedAt: new Date().toISOString(),
          };
          const text = JSON.stringify(document, null, 2) + "\n";
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, text);
          return content({
            action: "export",
            path,
            schema: result.schema,
            bytes: Buffer.byteLength(text),
            sha256: createHash("sha256").update(text).digest("hex"),
            counts: result.counts ?? {},
            warnings: result.warnings ?? [],
          });
        }

        const path = resolve(a.path);
        const { document, sourceSha256, bytes } = readDocument(path);
        const callArgs = {
          action: a.action,
          document,
          collection: a.collection,
          mode: a.mode,
          prune: a.prune,
          allowDestructive: a.allowDestructive,
          dryRun: a.dryRun,
          expectedFingerprint: a.expectedFingerprint,
          maxChanges: a.maxChanges,
          fileKey: a.fileKey,
        };
        // planIdOf deliberately drops fileKey (the build tools resolve it in
        // the plugin). For tokens the target file is part of what the caller
        // approved, so mix it back in here.
        const planId = createHash("sha256")
          .update(
            planIdOf({
              action: a.action,
              collection: a.collection,
              mode: a.mode,
              prune: a.prune,
              allowDestructive: a.allowDestructive,
              sourceSha256,
            }) + ":" + String(a.fileKey ?? ""),
          )
          .digest("hex")
          .slice(0, 20);
        if (a.action === "import" && a.dryRun === false) {
          if (!a.expectedFingerprint) {
            throw new Error("figma_tokens apply needs expectedFingerprint from a dry run; run import with dryRun:true first.");
          }
          if (!a.planId) {
            throw new Error("figma_tokens apply needs planId from a dry run; run import with dryRun:true first.");
          }
          if (a.planId !== planId) {
            throw new Error(
              `PLAN_MISMATCH: this token import hashes to ${planId}, not ${a.planId}. The file or options changed since the dry run; run figma_tokens import with dryRun:true again.`,
            );
          }
        }

        const result: any = await client.call("tokens", callArgs, 240_000);
        if (!result || typeof result !== "object") {
          throw new Error("the plugin returned no token result");
        }
        return content({
          action: a.action,
          path,
          sourceSha256,
          bytes,
          ...(a.action === "import" ? { planId, ...(a.dryRun === false ? { appliedPlanId: planId } : {}) } : {}),
          ...result,
        });
      }),
  );
}
