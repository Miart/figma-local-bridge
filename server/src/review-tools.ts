import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FigmaClient } from "./figma.js";
import { figmaNodeId } from "./node-id.js";
import { fileKeyParam } from "./file-key.js";
import { BridgeOffline } from "./websocket.js";
import { decodePng, diffImages, heatmapPng, pngSize } from "./compare.js";
import { scaleHint } from "./compare-tools.js";
import { AUDIT_RULE_IDS } from "./audit-tools.js";
import {
  SCHEMA,
  diffFindings,
  diffName,
  dropReview,
  imageName,
  isProblem,
  listReviews,
  nextSteps,
  readReview,
  resolveReviewId,
  reviewDir,
  reviewId,
  reviewPath,
  reviewsDir,
  reviewStatus,
  saveReview,
  sha256_16,
  storeKey,
  type AuditParams,
  type AuditReport,
  type Fingerprint,
  type ReviewRecord,
} from "./review.js";

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BridgeOffline) throw new Error(err.message);
    throw err;
  }
}

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });

interface FileTarget {
  /** Stable directory key for local review files. An unsaved/blank key uses "unsaved". */
  storage: string;
  /** Routing key sent to the plugin; undefined lets the daemon pick the only file. */
  route: string | undefined;
}

function fileTargetOf(client: FigmaClient, explicit?: string): FileTarget {
  if (explicit && explicit.trim()) return { storage: explicit.trim(), route: explicit.trim() };
  const files = client.files;
  if (files.length === 1) {
    const key = String(files[0].fileKey || "").trim();
    return { storage: key || "unsaved", route: key || undefined };
  }
  if (files.length > 1) {
    throw new Error(`more than one file is connected — pass fileKey to pick which file's reviews to use: ${files.map((f) => f.fileKey || "unsaved").join(", ")}`);
  }
  throw new Error("no file is connected, so a review cannot be anchored to a file — open the Figma plugin or pass fileKey");
}

interface Captured {
  png: Buffer;
  node: { id: string; name: string; type: string | null };
  audit: AuditReport;
  fingerprint: Fingerprint | null;
  revs: { screenshot: number | null; audit: number | null; inspect: number | null };
  warnings: string[];
}

async function capture(
  client: FigmaClient,
  routeKey: string | undefined,
  nodeId: string | undefined,
  opts: { scale: number; rules?: string[]; includeHidden: boolean; suggest: boolean; maxFindings: number; maxNodes: number },
): Promise<Captured> {
  const shot = await client.callWithMeta<any>(
    "get_screenshot",
    { nodeId, format: "PNG", scale: opts.scale, ...(routeKey ? { fileKey: routeKey } : {}) },
    90_000,
  );
  const result = shot.result;
  if (!result || typeof result.base64 !== "string" || !result.base64) {
    throw new Error("the plugin did not return a PNG for this node");
  }
  const png = Buffer.from(result.base64, "base64");
  if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) throw new Error("the plugin returned something that is not a PNG");
  const size = pngSize(png);
  if (!size) throw new Error("the plugin returned a PNG whose dimensions cannot be read");
  const capturedNodeId = String(result.nodeId || nodeId || "");
  if (!capturedNodeId) throw new Error("the plugin did not name the node it rendered");

  const auditMeta = await client.callWithMeta<any>(
    "audit",
    {
      rootNodeId: capturedNodeId,
      ...(opts.rules ? { rules: opts.rules } : {}),
      includeHidden: opts.includeHidden,
      suggest: opts.suggest,
      maxFindings: opts.maxFindings,
      maxNodes: opts.maxNodes,
      ...(routeKey ? { fileKey: routeKey } : {}),
    },
    120_000,
  );
  const audit = auditMeta.result;
  if (!audit || !Array.isArray(audit.findings)) throw new Error("the plugin returned an audit without a findings array");

  let fingerprint: Fingerprint | null = null;
  let inspectRev: number | null = null;
  const warnings: string[] = [];
  try {
    const inspectMeta = await client.callWithMeta<any>(
      "inspect",
      { nodeId: capturedNodeId, depth: 1, policy: "strict", ...(routeKey ? { fileKey: routeKey } : {}) },
      60_000,
    );
    inspectRev = inspectMeta.rev;
    if (inspectMeta.result?.fingerprint?.hash) fingerprint = inspectMeta.result.fingerprint as Fingerprint;
    else warnings.push(`structure fingerprint unavailable: ${inspectMeta.result?.error || "inspect returned no fingerprint"}`);
  } catch (e) {
    warnings.push(`structure fingerprint unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }

  const revs = {
    screenshot: shot.rev ?? null,
    audit: auditMeta.rev ?? null,
    inspect: inspectRev,
  };
  const present = [revs.screenshot, revs.audit, revs.inspect].filter((n): n is number => typeof n === "number");
  if (new Set(present).size > 1) {
    throw new Error(
      `the document changed during capture (rev ${present.join(" → ")}); the image, audit and structure would not describe one state — retry when the file is quiet`,
    );
  }

  return {
    png,
    node: {
      id: capturedNodeId,
      name: String(result.name || audit.scope?.name || "node"),
      type: audit.scope?.type ? String(audit.scope.type) : null,
    },
    audit: {
      schema: String(audit.schema || ""),
      params: {
        rules: opts.rules ?? null,
        includeHidden: opts.includeHidden,
        suggest: opts.suggest,
        maxFindings: opts.maxFindings,
        maxNodes: opts.maxNodes,
      },
      findings: audit.findings,
      counts: audit.counts || { error: 0, warning: 0, info: 0, total: 0 },
      byRule: audit.byRule || {},
      ...(audit.suggestions === undefined ? {} : { suggestions: audit.suggestions }),
      ...(audit.nodesScanned === undefined ? {} : { nodesScanned: audit.nodesScanned }),
      ...(audit.truncated === undefined ? {} : { truncated: audit.truncated }),
      ...(audit.findingsTruncated === undefined ? {} : { findingsTruncated: audit.findingsTruncated }),
      ...(Array.isArray(audit.warnings) ? { warnings: audit.warnings } : {}),
    },
    fingerprint,
    revs,
    warnings,
  };
}

function auditParamsFrom(record: ReviewRecord): AuditParams {
  return record.audit.params;
}

function publicFinding(f: any) {
  return f;
}

function capped(list: any[]) {
  return { total: list.length, list: list.slice(0, 20).map(publicFinding) };
}

/** The count delta is complete even when the finding lists are truncated. */
function countDelta(before: any, after: any) {
  const a = before || {};
  const b = after || {};
  const one = (k: string) => Number(b[k] || 0) - Number(a[k] || 0);
  return { error: one("error"), warning: one("warning"), info: one("info"), total: one("total") };
}

export function registerReviewTools(server: McpServer, client: FigmaClient) {
  server.tool(
    "figma_review",
    "A reproducible iteration harness for one subtree: save a visual + audit + structure baseline, edit, then compare the live node and see exactly what changed. " +
      'action "save" writes a local PNG plus the audit findings and the semantic fingerprint. "compare" re-renders, re-audits and re-inspects, diffs the pixels, and reports new/resolved/changed findings, severity deltas, size/fingerprint changes and a verdict: unchanged, changed, improved or regressed. ' +
      "A new error/warning or a size change is a regression; resolved problems are an improvement; a visual or structural difference without either is a neutral change. " +
      "The document is never written: only local review files. Use `figma_compare` when the reference is a mockup rather than an earlier iteration.",
    {
      action: z.enum(["save", "compare", "list", "drop"]).describe("save a baseline | compare the live node against it | list | drop local files"),
      nodeId: figmaNodeId("nodeId").optional().describe("save: node to capture (defaults to the selection); compare: defaults to the baseline's node"),
      id: z.string().optional().describe('compare/drop: review id; "latest" (the default) is the newest for this file'),
      name: z.string().optional().describe("save: a label for the id (defaults to the node name)"),
      dir: z.string().optional().describe("Where reviews live; defaults to ~/.local/share/opencode/figma-bridge-reviews"),
      scale: z.number().min(0.1).max(4).optional().describe("save: export scale (default 1); compare: defaults to the baseline's scale"),
      tolerance: z.number().int().min(0).max(64).default(8).describe("compare: per-channel difference that still counts as equal"),
      rules: z
        .array(z.enum(AUDIT_RULE_IDS))
        .min(1)
        .optional()
        .describe("save: audit rules; compare always uses the baseline's rules so the delta means the same thing"),
      includeHidden: z.boolean().default(false).describe("save: audit hidden layers too"),
      suggest: z.boolean().default(true).describe("save: attach exact local style/variable candidates to findings"),
      maxFindings: z.number().int().min(1).max(5000).default(200).describe("save: findings cap"),
      maxNodes: z.number().int().min(1).max(10000).default(2000).describe("save: audit node cap"),
      inline: z.boolean().default(true).describe("compare: return the heatmap as an image"),
      fileKey: fileKeyParam,
    },
    async (a) =>
      guard(async () => {
        const dir = a.dir ? resolve(a.dir) : reviewsDir();
        const target = fileTargetOf(client, a.fileKey);
        const fileKey = target.storage;

        if (a.action === "save") {
          const scale = a.scale ?? 1;
          const captureResult = await capture(client, target.route, a.nodeId, {
            scale,
            rules: a.rules,
            includeHidden: a.includeHidden,
            suggest: a.suggest,
            maxFindings: a.maxFindings,
            maxNodes: a.maxNodes,
          });
          const size = pngSize(captureResult.png);
          if (!size) throw new Error("cannot read the captured PNG size");
          const nodeName = captureResult.node.name;
          let id = reviewId(a.name ?? nodeName);
          for (let n = 2; n < 100 && existsSync(reviewPath(dir, fileKey, id)); n++) id = `${reviewId(a.name ?? nodeName)}-${n}`;
          const sub = reviewDir(dir, fileKey);
          mkdirSync(sub, { recursive: true });
          const image = imageName(id);
          const imagePath = join(sub, image);
          writeFileSync(imagePath, captureResult.png);
          const back = readFileSync(imagePath);
          if (sha256_16(back) !== sha256_16(captureResult.png)) throw new Error(`the review image on disk does not match what was captured: ${imagePath}`);
          const record: ReviewRecord = {
            schema: SCHEMA,
            id,
            fileKey,
            createdAt: new Date().toISOString(),
            node: captureResult.node,
            scale,
            rev: captureResult.revs,
            image: { file: image, width: size.width, height: size.height, bytes: back.length, sha256: sha256_16(back) },
            audit: captureResult.audit,
            fingerprint: captureResult.fingerprint,
            warnings: captureResult.warnings,
          };
          const path = saveReview(dir, record);
          return text({
            action: "save",
            id,
            path,
            imagePath,
            fileKey,
            createdAt: record.createdAt,
            node: record.node,
            scale,
            rev: record.rev,
            image: record.image,
            audit: {
              schema: record.audit.schema,
              counts: record.audit.counts,
              byRule: record.audit.byRule,
              findings: record.audit.findings.length,
              truncated: record.audit.truncated === true,
              findingsTruncated: record.audit.findingsTruncated || 0,
              warnings: record.audit.warnings || [],
            },
            fingerprint: record.fingerprint,
            warnings: record.warnings,
          });
        }

        if (a.action === "list") {
          const reviews = listReviews(dir, fileKey);
          return text({
            action: "list",
            dir: reviewDir(dir, fileKey),
            fileKey,
            count: reviews.length,
            reviews: reviews.map((r) => ({
              id: r.id,
              createdAt: r.createdAt,
              node: r.node,
              scale: r.scale,
              rev: r.rev,
              image: { ...r.image, path: join(reviewDir(dir, fileKey), r.image.file) },
              audit: { counts: r.audit.counts, truncated: r.audit.truncated === true },
              fingerprint: r.fingerprint,
            })),
            note: reviews.length ? undefined : 'nothing saved for this file yet — action "save" makes a baseline',
          });
        }

        if (a.action === "drop") {
          const dropped = dropReview(dir, fileKey, a.id ?? "latest");
          return text({ action: "drop", ...dropped });
        }

        const id = resolveReviewId(dir, fileKey, a.id);
        const record = readReview(dir, fileKey, id);
        const imagePath = join(reviewDir(dir, fileKey), record.image.file);
        if (!existsSync(imagePath)) throw new Error(`the baseline image is missing: ${imagePath}`);
        const baselinePng = readFileSync(imagePath);
        if (sha256_16(baselinePng) !== record.image.sha256) {
          throw new Error(`the baseline image changed on disk (${imagePath}); refusing to compare against a file that is not the saved baseline`);
        }
        const baseline = decodePng(baselinePng);
        const params = auditParamsFrom(record);
        const captureResult = await capture(client, target.route, a.nodeId ?? record.node.id, {
          scale: a.scale ?? record.scale,
          rules: params.rules ?? undefined,
          includeHidden: params.includeHidden,
          suggest: params.suggest,
          maxFindings: params.maxFindings,
          maxNodes: params.maxNodes,
        });
        const render = decodePng(captureResult.png);
        const report = diffImages(baseline, render, a.tolerance);
        const heatmapPath = join(reviewDir(dir, fileKey), diffName(id));
        const heatmap = heatmapPng(baseline, render, a.tolerance);
        writeFileSync(heatmapPath, heatmap);

        const delta = diffFindings(record.audit.findings, captureResult.audit.findings);
        const addedProblems = delta.added.filter((e) => isProblem(e.finding));
        const resolvedProblems = delta.resolved.filter((e) => isProblem(e.finding));
        const currentFp = captureResult.fingerprint;
        const fingerprintEqual =
          record.fingerprint && currentFp ? record.fingerprint.hash === currentFp.hash : null;
        const status = reviewStatus({
          visualIdentical: report.identical,
          sizeMismatch: report.sizeMismatch,
          fingerprintEqual,
          added: delta.added.map((e) => e.finding),
          resolved: delta.resolved.map((e) => e.finding),
          changed: delta.changed,
        });
        const hints = nextSteps({
          status,
          added: delta.added.map((e) => e.finding),
          resolved: delta.resolved.map((e) => e.finding),
          changedCount: delta.changed.length,
          visualIdentical: report.identical,
          sizeMismatch: report.sizeMismatch,
          fingerprintEqual,
          baselineTruncated: record.audit.truncated === true,
          currentTruncated: captureResult.audit.truncated === true,
        });
        const warnings = [
          ...record.warnings,
          ...captureResult.warnings,
          ...(record.audit.warnings || []),
          ...(captureResult.audit.warnings || []),
        ];
        if (!record.fingerprint || !currentFp) warnings.push("structure comparison incomplete: one side has no fingerprint");
        if (record.rev.screenshot !== null && captureResult.revs.screenshot !== null && record.rev.screenshot === captureResult.revs.screenshot && !report.identical) {
          warnings.push("the document rev did not change but the pixels did; Figma's export cache may be stale — retry the render");
        }
        if (record.audit.truncated === true || captureResult.audit.truncated === true) {
          warnings.push("an audit was truncated; new/resolved lists may be incomplete even though the counts are complete");
        }
        const sizeHint = scaleHint(report.reference, report.render);
        if (sizeHint) hints.unshift(sizeHint);

        const summary = {
          action: "compare",
          id,
          status,
          baseline: {
            id: record.id,
            createdAt: record.createdAt,
            path: reviewPath(dir, fileKey, record.id),
            node: record.node,
            rev: record.rev,
            scale: record.scale,
          },
          current: {
            nodeId: captureResult.node.id,
            name: captureResult.node.name,
            type: captureResult.node.type,
            rev: captureResult.revs,
          },
          visual: {
            identical: report.identical,
            different: report.different,
            total: report.total,
            ratioPercent: Number((report.ratio * 100).toFixed(2)),
            tolerance: report.tolerance,
            maxDelta: report.maxDelta,
            meanDelta: Number(report.meanDelta.toFixed(1)),
            sizeMismatch: report.sizeMismatch,
            bbox: report.bbox,
            clusters: report.clusters,
            clustersTotal: report.clustersTotal,
            baseline: { path: imagePath, size: report.reference },
            render: { size: report.render, scale: a.scale ?? record.scale },
            heatmap: heatmapPath,
          },
          structure: {
            fingerprintEqual,
            baseline: record.fingerprint,
            current: currentFp,
          },
          audit: {
            params,
            baseline: {
              counts: record.audit.counts,
              nodesScanned: record.audit.nodesScanned,
              truncated: record.audit.truncated === true,
              findingsTruncated: record.audit.findingsTruncated || 0,
            },
            current: {
              schema: captureResult.audit.schema,
              counts: captureResult.audit.counts,
              byRule: captureResult.audit.byRule,
              nodesScanned: captureResult.audit.nodesScanned,
              truncated: captureResult.audit.truncated === true,
              findingsTruncated: captureResult.audit.findingsTruncated || 0,
            },
            delta: countDelta(record.audit.counts, captureResult.audit.counts),
            new: capped(delta.added.map((e) => e.finding)),
            resolved: capped(delta.resolved.map((e) => e.finding)),
            changed: { total: delta.changed.length, list: delta.changed.slice(0, 20).map((e) => ({ key: e.key, before: e.before, after: e.after })) },
            unchanged: delta.unchanged,
            complete: record.audit.truncated !== true && captureResult.audit.truncated !== true,
          },
          regressions: { total: addedProblems.length, list: addedProblems.slice(0, 20).map((e) => e.finding) },
          improvements: { total: resolvedProblems.length, list: resolvedProblems.slice(0, 20).map((e) => e.finding) },
          next: hints,
          warnings,
        };
        const caption =
          `${status.toUpperCase()} — ${report.identical ? "pixels identical" : `${report.different} px differ (${summary.visual.ratioPercent}%)`}` +
          `, ${delta.added.length} new / ${delta.resolved.length} resolved / ${delta.changed.length} changed finding(s)` +
          `, rev ${captureResult.revs.screenshot ?? "?"} — heatmap: ${heatmapPath}`;
        return {
          content: [
            { type: "text" as const, text: `${caption}\n\n${JSON.stringify(summary, null, 2)}` },
            ...(a.inline ? [{ type: "image" as const, data: heatmap.toString("base64"), mimeType: "image/png" }] : []),
          ],
        };
      }),
  );
}
