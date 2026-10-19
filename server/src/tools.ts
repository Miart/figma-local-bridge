import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FigmaClient } from "./figma.js";
import { figmaNodeId, figmaNodeIds } from "./node-id.js";
import { fileKeyParam } from "./file-key.js";
import { BridgeOffline } from "./websocket.js";
import { registerParityTools } from "./parity-tools.js";
import { registerCompareTool } from "./compare-tools.js";
import { registerCheckpointTools } from "./checkpoint-tools.js";
import { registerOpsTools } from "./ops-tools.js";

export interface Capabilities {
  read: boolean;
  write: boolean;
  destructive: boolean;
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BridgeOffline) throw new Error(err.message);
    throw err;
  }
}

const content = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

/**
 * A handful of tools, not ten: ping, get_selection, inspect, compare, and one
 * mutating command. No create_instance / remove / append_child — primitives are
 * how an agent accidentally destroys a design file. Everything mutating is
 * funnelled through one command that validates, snapshots, mutates and verifies.
 */
export function registerTools(server: McpServer, client: FigmaClient, caps: Capabilities) {
  server.tool(
    "figma_ping",
    "Health check. Verifies the plugin is paired, reports the active page, and lists the connected files (fileKey + name) so calls can be routed when several are open.",
    { fileKey: fileKeyParam },
    async (a) =>
      guard(async () => {
        const files = client.files;
        if (!client.connected) return content({ connected: false, files });
        // With several files open this tool must NOT fail the way every other
        // file-scoped tool does — it is exactly the tool an agent calls to
        // learn which fileKey to pass, so it answers with the list instead.
        if (!a.fileKey && files.length > 1) {
          return content({
            connected: true,
            files,
            note: "more than one file is connected — pass fileKey to the tool you are about to call",
          });
        }
        const res = await client.call<Record<string, unknown>>("ping", { fileKey: a.fileKey });
        return content({ connected: true, files, ...res });
      }),
  );

  server.tool(
    "figma_get_selection",
    "Current selection. Answered from memory — the plugin pushes selectionchange, so this costs no round trip into Figma. With several files connected, pass fileKey.",
    { fileKey: fileKeyParam },
    async (a) =>
      guard(async () => {
        const cached = client.lastSelection(a.fileKey);
        if (cached) return content({ source: "pushed", ...cached });
        const live = await client.call<Record<string, unknown>>("get_selection", { fileKey: a.fileKey });
        return content({ source: "query", ...live });
      }),
  );

  server.tool(
    "figma_inspect",
    "Inspect a node: compact structure plus its semantic fingerprint. Pass compareWith to get EQUIVALENT / DIFFERENT / INCONCLUSIVE against other nodes BEFORE asking for any mutation.",
    {
      nodeId: figmaNodeId().optional().describe("Defaults to the current selection"),
      depth: z.number().int().min(0).max(3).default(1),
      policy: z.enum(["strict", "componentize"]).default("strict"),
      compareWith: figmaNodeIds("compareWith").optional().describe("Node ids to compare against"),
      fileKey: fileKeyParam,
    },
    async (a) =>
      guard(async () => content(await client.call("inspect", { ...a, policy: a.policy }))),
  );

  registerParityTools(server, client, caps);
  // Read-only, and useful precisely when nothing should be written: registered
  // in both modes.
  registerCompareTool(server, client);
  // Same reasoning: save/show/list/drop and the dry run are read-only. Only a
  // real rebuild writes, and it checks `caps.destructive` at call time.
  registerCheckpointTools(server, client, caps);
  // "What is still running, and can I stop it?" — the read half is read-only,
  // and the cancel half only ever prevents a write, so both belong here too.
  registerOpsTools(server, client);

  if (!caps.write) {
    server.tool(
      "figma_replace_repeated_with_component",
      "UNAVAILABLE: the bridge is registered in read-only mode (FIGMA_BRIDGE_WRITE=0).",
      {},
      async () => content({ status: "unavailable", reason: "write mode disabled in opencode config" }),
    );
    return;
  }

  server.tool(
    "figma_replace_repeated_with_component",
    "Replace a repeated group of identical nodes with instances of one master component, in a single transactional call. Refuses to act unless every target is provably equivalent (COUNT_MISMATCH / TARGETS_NOT_EQUIVALENT / TARGETS_NOT_PROVABLE all abort with mutated:false). Verifies placement afterwards and rolls back on failure. Run with dryRun:true first.",
    {
      sourceId: figmaNodeId("sourceId").describe("Canonical node; it is CLONED into a master, never mutated"),
      componentKey: z.string().describe("Idempotency key; an existing master with this key is reused"),
      componentName: z.string().optional(),
      match: z
        .object({ name: z.string().optional(), type: z.string().optional() })
        .optional()
        .describe("Selector for the cohort. Exact name+type only — no fuzzy matching."),
      expectedCount: z.number().int().min(1).optional().describe("Abort if the selector matches a different number"),
      policy: z.enum(["strict", "componentize"]).default("strict"),
      dryRun: z.boolean().default(true).describe("Preview: resolves and validates, mutates nothing"),
      preserve: z
        .object({
          position: z.boolean().default(true),
          size: z.boolean().default(true),
          constraints: z.boolean().default(true),
          name: z.boolean().default(true),
        })
        .optional(),
      fileKey: fileKeyParam,
    },
    async (a) =>
      guard(async () => content(await client.call("replace_repeated_with_component", a as any, 120_000))),
  );
}