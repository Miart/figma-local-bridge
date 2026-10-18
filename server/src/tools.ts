import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FigmaClient } from "./figma.js";
import { BridgeOffline } from "./websocket.js";
import { registerParityTools } from "./parity-tools.js";

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
 * Three tools, not ten. No create_instance / remove / append_child: primitives
 * are how an agent accidentally destroys a design file. Everything mutating is
 * funnelled through one command that validates, snapshots, mutates and verifies.
 */
export function registerTools(server: McpServer, client: FigmaClient, caps: Capabilities) {
  server.tool(
    "figma_ping",
    "Health check. Verifies the plugin is paired and reports the active page.",
    {},
    async () =>
      guard(async () => {
        if (!client.connected) return content({ connected: false });
        const res = await client.call<Record<string, unknown>>("ping");
        return content({ connected: true, ...res });
      }),
  );

  server.tool(
    "figma_get_selection",
    "Current selection. Answered from memory — the plugin pushes selectionchange, so this costs no round trip into Figma.",
    {},
    async () =>
      guard(async () => {
        const cached = client.lastSelection;
        if (cached) return content({ source: "pushed", ...cached });
        const live = await client.call<Record<string, unknown>>("get_selection");
        return content({ source: "query", ...live });
      }),
  );

  server.tool(
    "figma_inspect",
    "Inspect a node: compact structure plus its semantic fingerprint. Pass compareWith to get EQUIVALENT / DIFFERENT / INCONCLUSIVE against other nodes BEFORE asking for any mutation.",
    {
      nodeId: z.string().optional().describe("Defaults to the current selection"),
      depth: z.number().int().min(0).max(3).default(1),
      policy: z.enum(["strict", "componentize"]).default("strict"),
      compareWith: z.array(z.string()).optional().describe("Node ids to compare against"),
    },
    async (a) =>
      guard(async () => content(await client.call("inspect", { ...a, policy: a.policy }))),
  );

  registerParityTools(server, client, caps);

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
      sourceId: z.string().describe("Canonical node; it is CLONED into a master, never mutated"),
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
    },
    async (a) =>
      guard(async () => content(await client.call("replace_repeated_with_component", a as any, 120_000))),
  );
}