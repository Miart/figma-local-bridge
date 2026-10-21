/**
 * figma_review — a reproducible visual + audit baseline for iterating on one
 * subtree.
 *
 * The other verification tools answer one question each: figma_compare says
 * where pixels differ, figma_audit names design-system problems, figma_inspect
 * hashes the structure. An iteration needs the three answers next to the same
 * baseline, plus a delta: which findings are new, which are gone, and whether
 * the change is a regression or an improvement.
 *
 * Everything here is local. A baseline is a PNG, the audit report, the semantic
 * fingerprint and the parameters that produced them; it is never written into
 * the Figma document. The plugin is only asked to render, audit and inspect.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const SCHEMA = "figma-review/v1";
export const ENV_DIR = "FIGMA_BRIDGE_REVIEWS_DIR";

export interface Fingerprint {
  hash: string;
  appearanceHash?: string;
  geometryHash?: string;
  childrenHash?: string;
  geometryStatus?: string;
}

export interface AuditParams {
  rules: string[] | null;
  includeHidden: boolean;
  suggest: boolean;
  maxFindings: number;
  maxNodes: number;
}

export interface AuditReport {
  schema: string;
  scope?: { id: string; name: string; type: string };
  params: AuditParams;
  findings: any[];
  counts: { error: number; warning: number; info: number; total: number };
  byRule: Record<string, number>;
  suggestions?: unknown;
  nodesScanned?: number;
  truncated?: boolean;
  findingsTruncated?: number;
  warnings?: string[];
}

export interface ReviewRecord {
  schema: typeof SCHEMA;
  id: string;
  fileKey: string;
  createdAt: string;
  node: { id: string; name: string; type: string | null };
  scale: number;
  rev: { screenshot: number | null; audit: number | null; inspect: number | null };
  image: { file: string; width: number; height: number; bytes: number; sha256: string };
  audit: AuditReport;
  fingerprint: Fingerprint | null;
  warnings: string[];
}

export interface FindingEntry {
  key: string;
  finding: any;
}

export interface FindingDelta {
  added: FindingEntry[];
  resolved: FindingEntry[];
  changed: Array<{ key: string; before: any; after: any }>;
  unchanged: number;
}

export function reviewsDir(): string {
  const custom = process.env[ENV_DIR];
  if (custom && custom.trim()) return resolve(custom.trim());
  return join(homedir(), ".local/share/opencode/figma-bridge-reviews");
}

/** A file key or id as one safe path segment; never walks out of the store. */
export function storeKey(value: string): string {
  const folded = String(value).trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 80);
  if (!folded) throw new Error(`"${value}" is not usable as a review id or file key`);
  return folded;
}

/** Readable and sortable: 20261021-143012-splash-frame. */
export function reviewId(nodeName: string, now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const slug = String(nodeName).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return slug ? `${stamp}-${slug}` : stamp;
}

export function reviewDir(dir: string, fileKey: string): string {
  return join(dir, storeKey(fileKey));
}

export function reviewPath(dir: string, fileKey: string, id: string): string {
  return join(reviewDir(dir, fileKey), `${storeKey(id)}.json`);
}

export function imageName(id: string): string {
  return `${storeKey(id)}.png`;
}

export function diffName(id: string): string {
  return `${storeKey(id)}-diff.png`;
}

export function saveReview(dir: string, record: ReviewRecord): string {
  const sub = reviewDir(dir, record.fileKey);
  mkdirSync(sub, { recursive: true });
  const path = reviewPath(dir, record.fileKey, record.id);
  // A review whose JSON was cut off must not read back as a valid baseline.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2));
  renameSync(tmp, path);
  return path;
}

export function readReview(dir: string, fileKey: string, id: string): ReviewRecord {
  const path = reviewPath(dir, fileKey, id);
  if (!existsSync(path)) {
    const known = listReviews(dir, fileKey).map((r) => r.id);
    throw new Error(
      `no review "${id}" for this file (${path})` +
        (known.length ? `. Known: ${known.join(", ")}` : `. Save one with action "save" first.`),
    );
  }
  const record = JSON.parse(readFileSync(path, "utf8")) as ReviewRecord;
  if (!record || record.schema !== SCHEMA || !record.audit || !record.node?.id) {
    throw new Error(`${path} is not a ${SCHEMA} review`);
  }
  record.id = record.id || id;
  return record;
}

export function listReviews(dir: string, fileKey: string): ReviewRecord[] {
  const sub = reviewDir(dir, fileKey);
  if (!existsSync(sub)) return [];
  const out: ReviewRecord[] = [];
  for (const name of readdirSync(sub)) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(readFileSync(join(sub, name), "utf8")) as ReviewRecord;
      if (record?.schema === SCHEMA && record.audit && record.node?.id) out.push(record);
    } catch {
      // A foreign or half-written JSON file is not a review and is not an error.
    }
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** `latest`, an exact id, or any unambiguous prefix of one. */
export function resolveReviewId(dir: string, fileKey: string, wanted?: string): string {
  const known = listReviews(dir, fileKey);
  if (!known.length) throw new Error(`no reviews stored for this file yet (${reviewDir(dir, fileKey)})`);
  const want = String(wanted ?? "").trim();
  if (!want || want === "latest") return known[0].id;
  if (known.some((r) => r.id === want)) return want;
  const prefixed = known.filter((r) => r.id.startsWith(want));
  if (prefixed.length === 1) return prefixed[0].id;
  if (prefixed.length > 1) throw new Error(`"${want}" matches ${prefixed.length} reviews: ${prefixed.map((r) => r.id).join(", ")}`);
  throw new Error(`no review "${want}" for this file. Known: ${known.map((r) => r.id).join(", ")}`);
}

export function dropReview(dir: string, fileKey: string, id: string): { json: string; files: string[] } {
  const resolved = resolveReviewId(dir, fileKey, id);
  const sub = reviewDir(dir, fileKey);
  const json = reviewPath(dir, fileKey, resolved);
  const files: string[] = [];
  for (const name of [json, join(sub, imageName(resolved)), join(sub, diffName(resolved))]) {
    if (existsSync(name)) {
      rmSync(name);
      files.push(name);
    }
  }
  return { json, files };
}

export function sha256_16(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

/**
 * Findings are compared by what survived a rebuild, not by an id Figma may
 * change: a stable build key is the anchor when there is one. Duplicate-key
 * findings include the node id because two nodes deliberately share the key.
 */
export function findingKey(f: any): string {
  const anchor = f?.nodeKey ? `key:${String(f.nodeKey)}` : `id:${String(f?.nodeId)}`;
  const property = f?.property === undefined ? "" : `|property:${String(f.property)}`;
  const duplicate = f?.rule === "duplicate-key" ? `|node:${String(f?.nodeId)}` : "";
  return `${String(f?.rule)}|${anchor}${property}${duplicate}`;
}

/** Everything except the display path and the (possibly reassigned) node id. */
export function findingSignature(f: any): string {
  const { path: _path, nodeId: _nodeId, ...rest } = f || {};
  return JSON.stringify(rest);
}

function keyedFindings(findings: any[]): Map<string, any> {
  const out = new Map<string, any>();
  const seen = new Map<string, number>();
  for (const finding of findings || []) {
    const base = findingKey(finding);
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    out.set(count === 1 ? base : `${base}#${count}`, finding);
  }
  return out;
}

export function diffFindings(before: any[], after: any[]): FindingDelta {
  const a = keyedFindings(before);
  const b = keyedFindings(after);
  const added: FindingEntry[] = [];
  const resolved: FindingEntry[] = [];
  const changed: Array<{ key: string; before: any; after: any }> = [];
  let unchanged = 0;
  for (const [key, finding] of b) {
    if (!a.has(key)) added.push({ key, finding });
    else if (findingSignature(a.get(key)) !== findingSignature(finding)) changed.push({ key, before: a.get(key), after: finding });
    else unchanged++;
  }
  for (const [key, finding] of a) if (!b.has(key)) resolved.push({ key, finding });
  return { added, resolved, changed, unchanged };
}

export function isProblem(f: any): boolean {
  return f?.severity === "error" || f?.severity === "warning";
}

export type ReviewStatus = "unchanged" | "changed" | "improved" | "regressed";

/**
 * A new error or warning, or a size change, outranks everything else: it is the
 * one outcome an iteration must not walk past. A resolved problem is next. A
 * visual/structural difference without either is a neutral change.
 */
export function reviewStatus(input: {
  visualIdentical: boolean;
  sizeMismatch: boolean;
  fingerprintEqual: boolean | null;
  added: any[];
  resolved: any[];
  changed: any[];
}): ReviewStatus {
  if (input.sizeMismatch || input.added.some(isProblem)) return "regressed";
  if (input.resolved.some(isProblem)) return "improved";
  if (!input.visualIdentical || input.fingerprintEqual === false || input.added.length || input.resolved.length || input.changed.length) return "changed";
  return "unchanged";
}

/** The first few concrete things to do next, in priority order. */
export function nextSteps(input: {
  status: ReviewStatus;
  added: any[];
  resolved: any[];
  changedCount: number;
  visualIdentical: boolean;
  sizeMismatch: boolean;
  fingerprintEqual: boolean | null;
  baselineTruncated: boolean;
  currentTruncated: boolean;
}): string[] {
  const steps: string[] = [];
  const problems = input.added.filter(isProblem);
  if (input.sizeMismatch) {
    steps.push("The render and the baseline have different sizes: check `scale` and the node's size before judging pixels.");
  }
  if (problems.length) {
    const first = problems.slice(0, 3).map((f) => `${f.rule} at ${f.path || f.nodeId}: ${f.detail || "finding"}`);
    steps.push(`Fix ${problems.length} new error/warning finding(s): ${first.join("; ")}${problems.length > 3 ? "; …" : ""}.`);
  }
  if (input.resolved.length) {
    const first = input.resolved.slice(0, 3).map((f) => `${f.rule} at ${f.path || f.nodeId}`);
    steps.push(`Resolved: ${first.join("; ")}${input.resolved.length > 3 ? "; …" : ""}.`);
  }
  const infos = input.added.filter((f) => f?.severity === "info");
  if (infos.length) {
    steps.push(`${infos.length} new info finding(s): ${infos.slice(0, 3).map((f) => `${f.rule} at ${f.path || f.nodeId}`).join("; ")}${infos.length > 3 ? "; …" : ""}.`);
  }
  if (input.changedCount) {
    steps.push(`${input.changedCount} finding(s) changed in place — read the before/after values before deciding whether the change was intended.`);
  }
  if (input.baselineTruncated || input.currentTruncated) {
    steps.push("At least one audit was truncated: the finding delta may be incomplete — raise maxFindings and repeat before treating the review as complete.");
  }
  if (!input.visualIdentical) {
    steps.push("The pixels changed: open the heatmap and decide whether the visual change is intended.");
  }
  if (input.fingerprintEqual === false) {
    steps.push("The structure changed: decide whether the structural edit was intended.");
  }
  if (!steps.length && input.status === "unchanged") steps.push("No visual, audit or structural change.");
  return steps;
}
