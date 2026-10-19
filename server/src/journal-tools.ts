/**
 * figma_journal — the durable half of figma_ops.
 *
 * figma_ops answers "what is going on right now" from two memories that both
 * die: the client process's abandoned-call map and the plugin's opId cache.
 * The journal is the third memory — a local file the bridge appends to as it
 * sends each call (server/src/journal.ts), which survives both.
 *
 * The tool is a bounded reader: the tail of the file, filtered by file, method
 * or "only the calls that did not end cleanly". It reads from disk on every
 * call, so it also sees lines written by OTHER processes (one per editor
 * window), and it reports its own read facts (skipped lines, a partial tail,
 * the read cap) instead of pretending the file is always well-formed — a
 * journal being written while it is read is the normal case.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readJournal } from "./journal.js";

export function registerJournalTools(server: McpServer) {
  server.tool(
    "figma_journal",
    "The bridge's own history, from a local append-only JSONL file: every call it sent to a Figma plugin — method, target, outcome, revision — and above all the ones that did not end cleanly: `timeout` (the caller gave up), `dropped` (no answer at all: may or may not have been applied) and `late` (the answer that arrived after the caller stopped listening). It survives bridge and plugin restarts, which is exactly where figma_ops stops helping. Read-only and entirely local: snippets, text and images are never recorded — only method names, target ids, revisions and outcomes. Lives in ~/.local/share/opencode/figma-bridge-journal/ops.jsonl (FIGMA_BRIDGE_JOURNAL_DIR moves it, FIGMA_BRIDGE_JOURNAL=0 switches recording off).",
    {
      last: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .describe("How many matching lines to return, taken from the tail; returned oldest-first"),
      fileKey: z.string().optional().describe("Only entries for this fileKey"),
      method: z.string().optional().describe("Only entries for this plugin method (e.g. use_figma)"),
      unsettled: z
        .boolean()
        .optional()
        .describe("Only the calls that did not end with a clean answer: `timeout`, `dropped`, and `late`"),
    },
    async (a) => {
      const read = readJournal({
        last: a.last,
        fileKey: a.fileKey,
        method: a.method,
        unsettled: a.unsettled === true,
      });

      const why = read.enabled
        ? "The journal is written by every call this bridge sends; one line per event. " +
          "`send` with no terminal event for the same opId means the process died (or the attempt was dropped) " +
          "with the call in flight — it may have been applied; check the document. A `timeout` with no `late` " +
          "means the plugin never answered that attempt (still running, reloaded, or gone). Nothing a human did " +
          "in Figma is here, and a call refused before sending is not journaled — nothing was sent, nothing could change."
        : "The journal is switched off (FIGMA_BRIDGE_JOURNAL=0): nothing new is being recorded. Lines written before it was switched off are still shown.";
      const empty = read.entries.length === 0 ? " No matching lines yet — the file is created when the bridge sends its first call." : "";

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                enabled: read.enabled,
                dir: read.dir,
                files: read.files,
                entries: read.entries,
                read: {
                  matching: read.matching,
                  scannedLines: read.scannedLines,
                  skippedLines: read.skippedLines,
                  partialTail: read.partialTail,
                  bytesRead: read.bytesRead,
                  truncated: read.truncated,
                },
                lastError: read.lastError,
                note: why + empty,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
