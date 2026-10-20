import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FigmaClient } from "./figma.js";
import { fileKeyParam } from "./file-key.js";
import { BridgeOffline } from "./websocket.js";
import { diffInventory } from "./design-system.js";

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

const INVENTORY_SCHEMA = "design-system-v1";

export function registerDesignSystemTools(server: McpServer, client: FigmaClient) {
  server.tool(
    "figma_design_system",
    "Export or diff the file's local design system as one comparable snapshot: paint/text/effect/grid styles, variable collections with modes and per-mode values, and components/component sets with their property definitions. " +
      '"inventory" returns the snapshot; "export" writes it to a JSON file and returns the path, byte count and sha256; "diff" compares that file with the live file and reports added/removed/changed by stable key, not by name. ' +
      "Read-only: it never creates or changes a style, variable or component.",
    {
      action: z.enum(["inventory", "export", "diff"]).default("inventory"),
      path: z.string().optional().describe("export: destination JSON; diff: the previous export to compare against"),
      include: z
        .array(z.enum(["styles", "variables", "components"]))
        .min(1)
        .optional()
        .describe("Sections to include; default all three"),
      maxItems: z.number().int().min(1).max(20000).default(2000).describe("Snapshot item cap; truncation is reported"),
      maxDiff: z.number().int().min(1).max(5000).default(200).describe("diff: list at most this many entries per bucket"),
      fileKey: fileKeyParam,
    },
    async (a) =>
      guard(async () => {
        if ((a.action === "export" || a.action === "diff") && !a.path) {
          throw new Error(`figma_design_system action "${a.action}" needs path`);
        }
        const inventory: any = await client.call(
          "design_system",
          { include: a.include, maxItems: a.maxItems, fileKey: a.fileKey },
          180_000,
        );

        if (a.action === "inventory") return content(inventory);

        const path = resolve(String(a.path));
        if (a.action === "export") {
          const document = {
            schema: INVENTORY_SCHEMA,
            exportedAt: new Date().toISOString(),
            file: inventory.file ?? null,
            include: inventory.include ?? ["styles", "variables", "components"],
            styles: inventory.styles ?? [],
            variables: inventory.variables ?? [],
            components: inventory.components ?? [],
            counts: inventory.counts ?? {},
            warnings: inventory.warnings ?? [],
          };
          const text = JSON.stringify(document, null, 2) + "\n";
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, text);
          const digest = createHash("sha256").update(text).digest("hex");
          return content({
            action: "export",
            path,
            bytes: Buffer.byteLength(text),
            sha256: digest,
            counts: document.counts,
            truncated: inventory.truncated === true,
            warnings: document.warnings,
          });
        }

        let previous: any;
        try {
          previous = JSON.parse(readFileSync(path, "utf8"));
        } catch (e: any) {
          throw new Error(`cannot read design-system JSON at ${path}: ${e && e.message ? e.message : e}`);
        }
        if (!previous || typeof previous !== "object") throw new Error(`${path} is not a design-system snapshot`);
        const diff = diffInventory(previous, inventory, a.maxDiff);
        return content({
          action: "diff",
          path,
          file: inventory.file ?? null,
          counts: diff.counts,
          sections: diff.sections,
          truncated: diff.truncated || inventory.truncated === true,
          warnings: [
            ...(previous.schema === INVENTORY_SCHEMA ? [] : [`previous file schema is ${previous.schema ?? "missing"}, expected ${INVENTORY_SCHEMA}`]),
            ...(inventory.truncated === true ? ["the live inventory was truncated; the diff describes only the items it reached"] : []),
            ...diff.warnings,
          ],
        });
      }),
  );
}
