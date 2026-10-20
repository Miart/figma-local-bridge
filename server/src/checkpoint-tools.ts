import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FigmaClient } from "./figma.js";
import { figmaNodeId } from "./node-id.js";
import { fileKeyParam } from "./file-key.js";
import { BridgeOffline } from "./websocket.js";
import {
  SCHEMA, assertEnvelope, checkpointsDir, checkpointId, digest, diffDumps, dropCheckpoint, filePath,
  listCheckpoints, listFilesWithCheckpoints, readCheckpoint, resolveId, saveCheckpoint, summarize,
  type CheckpointRecord, type DumpEnvelope,
} from "./checkpoint.js";

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BridgeOffline) throw new Error(err.message);
    throw err;
  }
}

const content = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
/** A dump of a 2000-node subtree is a big reply; the interesting part is the list. */
const fold = <T,>(list: T[], limit: number) =>
  list.length <= limit ? list : [...list.slice(0, limit), `… ${list.length - limit} more` as unknown as T];

/**
 * figma_checkpoint — the alternative to UNDO, which the Plugin API does not have.
 *
 * A checkpoint is a DESCRIPTION of a subtree plus a REBUILD, so this tool is
 * built around one question: how does the caller find out what the rebuild did
 * not reproduce? Three ways, all of them measurements rather than promises:
 *
 *   - the SAVE carries a summary and the plugin's own limitations list, so the
 *     blind spots travel with the file;
 *   - SHOW compares the live subtree against the saved one field by field, and
 *     reports the semantic fingerprint next to the field diff — the fingerprint
 *     answers "same picture", the fields answer "which property";
 *   - RESTORE is a DRY RUN unless the caller says otherwise, then dumps the
 *     subtree again and diffs it against what it was asked to produce. It
 *     reports `verified: true` only when that diff is empty.
 *
 * It also refuses a restore that would churn the document: if the subtree
 * already matches the checkpoint, there is nothing to rebuild.
 */
export function registerCheckpointTools(server: McpServer, client: FigmaClient, caps: { destructive: boolean }) {
  server.tool(
    "figma_checkpoint",
    "Save a subtree as data, compare it against the live document, and rebuild it — the alternative to an undo stack the Plugin API does not offer. " +
      'action "save" writes an inspectable JSON file; "show" diffs the live subtree against it; "restore" replaces the target\'s children from it in ONE transaction, dry run first, and verifies itself by dumping the subtree again. ' +
      "Refuses what it cannot promise: node types it cannot rebuild, truncated dumps, a group or instance target, and any restore not asked for out loud. A save says what a checkpoint-v1 rebuild does not carry (an INSTANCE's interior structure beyond its direct overrides, and component identity); direct per-layer overrides are captured and replayed by path after the main component is re-instantiated, and style ids and node-level and run-level variable bindings are re-linked when still present. Every missing link or stale override path is reported.",
    {
      action: z.enum(["save", "show", "list", "drop", "restore"]).describe("save | show (compare live, read-only) | list | drop (a local file) | restore (dry run unless dryRun: false)"),
      nodeId: figmaNodeId("nodeId").optional().describe("The subtree root. save: defaults to the selection; show/restore: defaults to the checkpoint's own root"),
      id: z.string().optional().describe('Checkpoint id; an unambiguous prefix is enough, and "latest" (the default) is the newest for this file'),
      name: z.string().optional().describe("save: a label for the id (defaults to the node name)"),
      dir: z.string().optional().describe("Where checkpoints live; defaults to ~/.local/share/opencode/figma-bridge-checkpoints"),
      maxNodes: z.number().int().min(1).max(20000).optional().describe("save: node cap; a truncated checkpoint cannot be restored"),
      compare: z.boolean().optional().describe("show: compare against the live subtree (default true). false reads the file only"),
      dryRun: z.boolean().optional().describe("restore: default TRUE. false performs the rebuild (also needs allowDestructive and a bridge started with destructive writes)"),
      allowPartial: z.boolean().optional().describe("restore: rebuild what can be rebuilt and list the rest as skipped, instead of refusing"),
      allowDestructive: z.boolean().optional().describe("restore: required for a real rebuild — it deletes the target's current children"),
      force: z.boolean().optional().describe("restore: rebuild even when the subtree already matches the checkpoint"),
      fileKey: fileKeyParam,
    },
    async (a) =>
      guard(async () => {
        const dir = a.dir ? resolve(a.dir) : checkpointsDir();

        const liveDump = async (nodeId: string | undefined) => {
          const { result, rev } = await client.callWithMeta<DumpEnvelope>(
            "checkpoint_dump",
            { nodeId, maxNodes: a.maxNodes, fileKey: a.fileKey },
            180_000,
          );
          return { env: assertEnvelope(result), rev: rev ?? null };
        };

        /** Which file key the checkpoint store is keyed by. */
        const keyOf = (explicit?: string | null): string => {
          if (explicit) return explicit;
          if (a.fileKey) return a.fileKey;
          const files = client.files;
          if (files.length === 1) return files[0].fileKey;
          throw new Error(
            files.length
              ? `more than one file is connected — pass fileKey to pick which file's checkpoints to use: ${files.map((f) => f.fileKey).join(", ")}`
              : "no file is connected, so there is no key to look checkpoints up by — pass fileKey, or run action \"list\" with none to see every file that has checkpoints",
          );
        };

        const metaOf = (rec: CheckpointRecord) => ({
          id: rec.id,
          savedAt: rec.savedAt,
          saveRev: rec.saveRev,
          digest: rec.digest,
          root: rec.envelope.root ?? null,
          page: rec.envelope.page ?? null,
          nodes: rec.summary.nodes,
          truncated: rec.envelope.truncated === true,
          unsupported: rec.summary.unsupported.length,
          byType: rec.summary.byType,
        });

        switch (a.action) {
          // ---------------------------------------------------------- save
          case "save": {
            const { env, rev } = await liveDump(a.nodeId);
            const fileKey = keyOf(env.file?.key ?? null);
            const label = a.name ?? env.root?.name ?? "checkpoint";
            let id = checkpointId(label);
            for (let n = 2; n < 100 && existsSync(filePath(dir, fileKey, id)); n++) id = `${checkpointId(label)}-${n}`;
            const record: CheckpointRecord = {
              id,
              fileKey,
              savedAt: new Date().toISOString(),
              schema: SCHEMA,
              saveRev: rev ?? env.rev ?? null,
              digest: digest(env.dump),
              summary: summarize(env.dump),
              envelope: env,
            };
            const path = saveCheckpoint(dir, record);
            const s = record.summary;
            const caption =
              `saved "${id}": ${s.nodes} node(s) at rev ${record.saveRev ?? "?"} -> ${path}` +
              (env.truncated ? `\nTRUNCATED at the node cap: this checkpoint cannot be restored (restoring it would delete the nodes the dump never reached).` : "") +
              (s.unsupported.length
                ? `\n${s.unsupported.length} node(s) checkpoint-v1 cannot rebuild: ` +
                  fold(s.unsupported.map((u) => `${u.path} (${u.type})`), 5).join(", ") +
                  `\nA restore refuses unless allowPartial: true, and then rebuilds everything else.`
                : "") +
              (s.metaOnly ? `\n${s.metaOnly} node(s) carry style ids, variable bindings or explicit modes: a restore re-links each when it still exists and reports every one that does not.` : "");
            return content(
              caption +
                "\n\n" +
                JSON.stringify(
                  {
                    action: "save",
                    id,
                    path,
                    fileKey,
                    digest: record.digest,
                    saveRev: record.saveRev,
                    capturedAt: env.capturedAt ?? null,
                    root: env.root ?? null,
                    truncated: env.truncated === true,
                    summary: s,
                    limitations: env.limitations ?? [],
                  },
                  null,
                  2,
                ),
            );
          }

          // ---------------------------------------------------------- list
          case "list": {
            const explicit = a.fileKey ?? (client.files.length === 1 ? client.files[0].fileKey : null);
            if (explicit) {
              const records = listCheckpoints(dir, explicit);
              return content({
                action: "list",
                dir,
                fileKey: explicit,
                count: records.length,
                checkpoints: records.map(metaOf),
                note: records.length ? undefined : "nothing saved for this file yet — action \"save\" before a rebuild",
              });
            }
            return content({
              action: "list",
              dir,
              files: listFilesWithCheckpoints(dir),
              note:
                client.files.length === 0
                  ? "nothing is connected, so this lists every file that has checkpoints (keyed by the fileKey the plugin reported when they were saved)"
                  : "more than one file is connected — pass fileKey to see one file's checkpoints",
            });
          }

          // ---------------------------------------------------------- show
          case "show": {
            const fileKey = keyOf();
            const id = resolveId(dir, fileKey, a.id ?? "latest");
            const rec = readCheckpoint(dir, fileKey, id);
            const base = {
              action: "show",
              id,
              path: filePath(dir, fileKey, id),
              savedAt: rec.savedAt,
              saveRev: rec.saveRev,
              digest: rec.digest,
              root: rec.envelope.root ?? null,
              summary: rec.summary,
              limitations: rec.envelope.limitations ?? [],
            };
            if (a.compare === false) return content({ ...base, compared: false });
            const { env, rev } = await liveDump(a.nodeId ?? rec.envelope.root?.id);
            const diff = diffDumps(rec.envelope.dump, env.dump, { limit: 100 });
            const savedFp = rec.envelope.fingerprint?.hash ?? null;
            const liveFp = env.fingerprint?.hash ?? null;
            const caption =
              `"${id}" vs the live document at rev ${rev ?? "?"}: ` +
              (diff.identical
                ? `field-identical (${rec.summary.nodes} node(s) compared)`
                : `${diff.total} field(s) differ`) +
              (savedFp && liveFp ? `; semantic fingerprint ${savedFp === liveFp ? "matches" : "differs"}` : "");
            return content(
              caption +
                "\n\n" +
                JSON.stringify(
                  {
                    ...base,
                    compared: true,
                    liveRev: rev,
                    identical: diff.identical,
                    differences: diff.total,
                    diff: fold(diff.differences, 40),
                    notes: diff.notes,
                    fingerprint: { saved: savedFp, live: liveFp, same: savedFp !== null && savedFp === liveFp },
                    live: { nodes: env.nodes ?? null, truncated: env.truncated === true, unsupported: (env.unsupported ?? []).length },
                  },
                  null,
                  2,
                ),
            );
          }

          // ---------------------------------------------------------- drop
          case "drop": {
            const fileKey = keyOf();
            const id = resolveId(dir, fileKey, a.id ?? "latest");
            const path = dropCheckpoint(dir, fileKey, id);
            return content({ action: "drop", id, path, dropped: true, note: "the document was not touched — only the checkpoint file" });
          }

          // ------------------------------------------------------- restore
          case "restore": {
            const before = await liveDump(a.nodeId);
            const fileKey = keyOf(before.env.file?.key ?? null);
            const id = resolveId(dir, fileKey, a.id ?? "latest");
            const rec = readCheckpoint(dir, fileKey, id);
            const rootId = rec.envelope.root?.id ?? a.nodeId;
            const drift = diffDumps(rec.envelope.dump, before.env.dump, { limit: 100 });
            const path = filePath(dir, fileKey, id);

            const wet = a.dryRun === false;
            if (wet && !caps.destructive) {
              throw new Error(
                "REFUSED: a restore writes to the document, and this bridge runs without destructive writes (FIGMA_BRIDGE_DESTRUCTIVE is not 1). " +
                  "The dry run (the default) shows exactly what the rebuild would replace, and `show` says how far the subtree has drifted.",
              );
            }
            if (wet && a.allowDestructive !== true) {
              throw new Error(
                `REFUSED: restoring "${id}" deletes the current children of ${rec.envelope.root?.name ?? rootId} and rebuilds them. Pass allowDestructive: true to say so out loud, or leave dryRun unset for the dry run.`,
              );
            }
            if (drift.identical && !a.force && wet) {
              return content(
                `nothing to restore: the subtree already matches "${id}" field for field (${rec.summary.nodes} node(s), rev ${before.rev ?? "?"}).` +
                  `\nRe-run with force: true if you want the rebuild anyway — for instance to re-apply a component's key.` +
                  "\n\n" +
                  JSON.stringify({ action: "restore", id, path, alreadyMatches: true, rebuilt: false, drift: { identical: true, differences: 0 }, summary: rec.summary }, null, 2),
              );
            }

            const { result: report, rev: restoreRev } = await client.callWithMeta<any>(
              "checkpoint_restore",
              {
                nodeId: rootId,
                dump: rec.envelope.dump,
                truncated: rec.envelope.truncated === true,
                allowPartial: a.allowPartial === true,
                dryRun: !wet,
                allowDestructive: a.allowDestructive === true,
                fileKey: a.fileKey,
              },
              240_000,
            );

            let verification: unknown = null;
            let verified = false;
            let afterRev: number | null = null;
            if (wet) {
              const after = await liveDump(rootId);
              afterRev = after.rev;
              const check = diffDumps(rec.envelope.dump, after.env.dump, { limit: 100 });
              const savedFp = rec.envelope.fingerprint?.hash ?? null;
              const afterFp = after.env.fingerprint?.hash ?? null;
              verified = check.identical;
              verification = {
                verified,
                differences: check.total,
                diff: fold(check.differences, 40),
                notes: check.notes,
                fingerprint: { saved: savedFp, live: afterFp, same: savedFp !== null && savedFp === afterFp },
                nodes: after.env.nodes ?? null,
              };
            }

            const caption =
              `restore "${id}" -> ${rec.envelope.root?.name ?? rootId}: ` +
              (wet
                ? verified
                  ? `rebuilt and verified field-identical (${report.created} created, ${report.removed} removed, rev ${restoreRev ?? "?"})`
                  : `REBUILT BUT NOT IDENTICAL: ${(verification as any).differences} field(s) differ from the checkpoint (rev ${restoreRev ?? "?"}) — see verification.diff`
                : `dry run: ${report.removed} child(ren) would be removed, ${report.created} node(s) would be created (nothing was written)`) +
              (drift.identical ? "" : `\nThe subtree had drifted from the checkpoint in ${drift.total} field(s); drift.diff lists them.`) +
              (!wet ? `\nRun again with dryRun: false and allowDestructive: true to perform it.` : "") +
              (report.skipped.length ? `\n${report.skipped.length} node(s) skipped.` : "") +
              (report.fontsUnavailable.length ? `\nFonts unavailable: ${report.fontsUnavailable.join(", ")} (the text came back in the fallback font).` : "") +
              (report.bindingsDropped.length ? `\n${report.bindingsDropped.length} paint(s) came back by value: their variable bindings are gone.` : "") +
              ((report.bindingsRestored?.length ?? 0) ? `\n${report.bindingsRestored.length} node-level variable binding(s) restored.` : "") +
              ((report.bindingsMissing?.length ?? 0) ? `\n${report.bindingsMissing.length} node-level variable binding(s) could not be restored; their recorded values are still in place.` : "") +
              ((report.modesRestored?.length ?? 0) ? `\n${report.modesRestored.length} explicit variable mode(s) restored.` : "") +
              ((report.modesMissing?.length ?? 0) ? `\n${report.modesMissing.length} explicit variable mode(s) could not be restored.` : "") +
              ((report.stylesRestored?.length ?? 0) ? `\n${report.stylesRestored.length} style link(s) restored.` : "") +
              ((report.stylesMissing?.length ?? 0) ? `\n${report.stylesMissing.length} style link(s) could not be restored; their values came back unlinked.` : "") +
              ((report.overridesRestored?.length ?? 0) ? `\n${report.overridesRestored.length} direct instance override(s) replayed by path.` : "") +
              ((report.overridesMissing?.length ?? 0) ? `\n${report.overridesMissing.length} direct instance override(s) no longer match the main component and were skipped.` : "") +
              ((report.overridesUnsupported?.length ?? 0) ? `\n${report.overridesUnsupported.length} direct instance override(s) carry field(s) this version cannot rebuild; they are named in the report.` : "");

            return content(
              caption +
                "\n\n" +
                JSON.stringify(
                  {
                    action: "restore",
                    id,
                    path,
                    dryRun: !wet,
                    rebuilt: wet,
                    alreadyMatches: false,
                    checkpoint: { savedAt: rec.savedAt, saveRev: rec.saveRev, digest: rec.digest, nodes: rec.summary.nodes },
                    target: report.target ?? null,
                    removed: report.removed,
                    created: report.created,
                    wouldRemove: report.wouldRemove ?? undefined,
                    skipped: fold(report.skipped ?? [], 20),
                    fontsUnavailable: report.fontsUnavailable ?? [],
                    bindingsDropped: fold(report.bindingsDropped ?? [], 20),
                    bindingsRestored: fold(report.bindingsRestored ?? [], 20),
                    bindingsMissing: fold(report.bindingsMissing ?? [], 20),
                    modesRestored: fold(report.modesRestored ?? [], 20),
                    modesMissing: fold(report.modesMissing ?? [], 20),
                    stylesRestored: fold(report.stylesRestored ?? [], 20),
                    stylesMissing: fold(report.stylesMissing ?? [], 20),
                    propertiesFailed: fold(report.propertiesFailed ?? [], 20),
                    notes: fold(report.notes ?? [], 20),
                    drift: { identical: drift.identical, differences: drift.total, diff: fold(drift.differences, 25), notes: drift.notes },
                    verification,
                    rev: { before: before.rev, restore: restoreRev ?? null, after: afterRev },
                  },
                  null,
                  2,
                ),
            );
          }
        }
      }),
  );
}
