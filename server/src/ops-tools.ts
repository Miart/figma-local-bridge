import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AbandonedOp, ClientOp, FigmaClient } from "./figma.js";
import { fileKeyParam } from "./file-key.js";
import { BridgeNotPaired, BridgeOffline } from "./websocket.js";

/**
 * figma_ops / figma_cancel — what the plugin is doing, and the one way to stop
 * something that has not started.
 *
 * The gap these close is not hypothetical. Writes are chained in the plugin, so
 * a call can wait behind another write for as long as that one takes — while its
 * own caller has a timeout. The caller gives up, the agent concludes the edit
 * failed and plans around that, and then the queued write runs anyway, at a
 * revision nobody is watching. Two ordinary sessions on one file are enough.
 *
 * `figma_ops` answers the question that used to be unanswerable: is that call
 * still going to write, is it running right now, or did it finish after its
 * caller stopped listening — and what did it return? Half of the answer is the
 * plugin's (its queue and its recorded answers), half is this client's (which
 * calls it gave up on, and whether a late answer arrived). The reply says which
 * half said what.
 *
 * `figma_cancel` stops an operation that has NOT started. That is the whole of
 * its power and it is deliberate: Figma runs plugin code to completion, so a
 * call that has begun cannot be taken back, and a tool that pretended otherwise
 * would leave half-applied edits nobody is tracking. A queued call provably did
 * nothing, so stopping it is safe — its caller is answered immediately with
 * OP_CANCELLED and the revision does not move, because the document did not.
 *
 * Neither tool writes to the document, so both are registered in read-only mode
 * as well: "what is still running?" and "stop it" are exactly what a caller
 * wants when it is not allowed to write anything itself.
 */
export function registerOpsTools(server: McpServer, client: FigmaClient) {
  server.tool(
    "figma_ops",
    "What the Figma plugin is doing right now, per file: the call that is RUNNING, the writes QUEUED behind it, and what finished recently — plus, for this MCP session, the calls it is still waiting for and the ones it gave up on. Pass an opId (timeout errors name it) to get that operation's state and its recorded answer, which is how a call that timed out is settled without re-reading the document. Read-only.",
    {
      opId: z
        .string()
        .optional()
        .describe("Ask about one operation: its state, and the answer recorded for it (what a caller that timed out never saw)"),
      recent: z
        .number()
        .int()
        .min(0)
        .max(50)
        .default(10)
        .describe("How many finished operations to list, newest first"),
      fileKey: fileKeyParam,
    },
    async (a) => {
      const wanted = (entry: { file: string | undefined }) => !a.fileKey || entry.file === a.fileKey;
      const inFlight: ClientOp[] = client.inFlightOps().filter(wanted);
      const abandoned: AbandonedOp[] = client.abandonedOps().filter(wanted);

      let plugin: unknown = null;
      let why: string | null = null;
      try {
        plugin = await client.call("ops", { opId: a.opId, recent: a.recent, fileKey: a.fileKey }, 20_000);
      } catch (err) {
        // The plugin may be gone, busy, or an older build that has no `ops`
        // method at all. None of that makes the local half untrue, and the
        // reason is reported verbatim instead of being turned into a failure.
        if (err instanceof BridgeOffline || err instanceof BridgeNotPaired || err instanceof Error) {
          why = String((err as Error).message ?? err);
        } else {
          throw err;
        }
      }

      const p = (plugin ?? {}) as Record<string, any>;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                file: p.file ?? null,
                ...(a.opId ? { opId: a.opId, op: p.op ?? null, record: p.record ?? null, ...(p.lookup ? { lookup: p.lookup } : {}) } : {}),
                ...(why ? { pluginError: why } : {}),
                thisClient: { inFlight, abandoned },
                plugin: plugin
                  ? { running: p.running, queued: p.queued, recent: p.recent, seen: p.seen, kept: p.kept, note: p.note }
                  : null,
                note:
                  "`queued` means the call has not started: figma_cancel can still stop it, and nothing of it has run. " +
                  "A `running` call cannot be interrupted, and `recent` is where a call that finished after its caller gave up shows up — with the answer it returned. " +
                  "This view is the live half and dies with the processes; figma_journal has the same trail durably, including calls this process has already forgotten.",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "figma_cancel",
    "Stop a Figma operation that has NOT started (state `queued` in figma_ops) — the write a caller abandoned while it waited behind another write. Its caller is answered immediately with OP_CANCELLED and the document revision does not move, because nothing of it ran. A running call cannot be interrupted (Figma runs plugin code to completion): the refusal says which of OP_RUNNING / OP_DONE / OP_UNKNOWN it is, and OP_DONE names the revision the call actually reached. Read-only: cancelling only ever prevents a write.",
    {
      opId: z.string().describe("Operation to stop, as figma_ops lists it or as a timeout error named it"),
      fileKey: fileKeyParam,
    },
    async (a) => {
      const { result, rev } = await client.callWithMeta<Record<string, unknown>>("cancel", { opId: a.opId, fileKey: a.fileKey }, 20_000);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                cancelled: true,
                rev: rev ?? null,
                ...result,
                note:
                  "It was still queued, so nothing of it ran; the revision is unchanged, and a retry of the same opId replays the cancellation instead of starting the call.",
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
