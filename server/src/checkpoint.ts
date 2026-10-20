import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Checkpoints on disk, and the comparison that decides whether a restore worked.
 *
 * The document side lives in plugin/checkpoint.ts (dump + rebuild). This module
 * owns what only the server can do: keep a checkpoint as a FILE, name every
 * field in which two dumps differ, and summarize a dump for a human. "Restored"
 * is then a measurement — the subtree is dumped again afterwards and compared —
 * instead of a claim the writer makes about its own write.
 *
 * Numbers compare with a 0.01 tolerance: a value that round-trips through
 * Figma's float pipeline can come back a hundredth off, and reporting that as a
 * difference would bury the real ones.
 */

export const SCHEMA = "checkpoint-v1";

/** The structural contract the server relies on. plugin/checkpoint.ts defines it. */
export interface DumpNode {
  type: string;
  name: string;
  state: Record<string, unknown>;
  meta?: Record<string, unknown>;
  children?: DumpNode[];
  unsupported?: string;
}

export interface DumpEnvelope {
  schema: string;
  capturedAt?: string;
  rev?: number | null;
  file?: { key: string | null; name?: string };
  page?: { id: string; name: string };
  root?: { id: string; name: string; type: string };
  nodes?: number;
  truncated?: boolean;
  unsupported?: Array<{ path: string; type: string; why: string }>;
  limitations?: string[];
  fingerprint?: {
    hash: string;
    appearanceHash?: string;
    geometryHash?: string;
    childrenHash?: string;
    geometryStatus?: string;
  };
  dump: DumpNode;
}

export interface CheckpointRecord {
  id: string;
  fileKey: string;
  savedAt: string;
  schema: string;
  /** The document rev the dump was taken at; a later rev means the file moved on. */
  saveRev: number | null;
  digest: string;
  summary: DumpSummary;
  envelope: DumpEnvelope;
}

// ---------------------------------------------------------------- the dump contract

export function assertEnvelope(value: unknown): DumpEnvelope {
  const env = value as DumpEnvelope;
  if (!env || typeof env !== "object") throw new Error("the plugin returned no checkpoint (empty reply)");
  if (env.schema !== SCHEMA) {
    throw new Error(`the plugin answered with schema "${env.schema ?? "none"}" and this build reads "${SCHEMA}" — update the plugin (npm run build:plugin) or the server, they are out of step`);
  }
  if (!env.dump || typeof env.dump !== "object" || typeof env.dump.type !== "string") {
    throw new Error("the checkpoint has no dump tree — nothing to store or restore");
  }
  return env;
}

export function canonical(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        const child = (v as Record<string, unknown>)[k];
        if (child !== undefined) out[k] = walk(child);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

/** A digest of the dump alone, so two checkpoints can be told apart at a glance. */
export function digest(dump: DumpNode): string {
  return "sha256:" + createHash("sha256").update(canonical(dump)).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------- the diff

export interface Difference {
  path: string;
  before: unknown;
  after: unknown;
  /** Which side the field was missing from: a field that appeared or vanished. */
  absent?: "before" | "after";
}

export interface DiffReport {
  identical: boolean;
  total: number;
  differences: Difference[];
  truncated: boolean;
  /** Why a difference is expected, where checkpoint-v1 knows the reason. */
  notes: string[];
}

const EPS = 0.01;
const isPlain = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const eq = (a: unknown, b: unknown) => (num(a) && num(b) ? Math.abs((a as number) - (b as number)) <= EPS : false);

/**
 * Field-level comparison of two dumps of the same scope.
 *
 * `meta` is deliberately not compared: it carries style ids and variable
 * aliases whose re-linking is reported by the restore itself, and may be
 * unavailable in the current file. Comparing it here would drown the unknown
 * field differences in a known, already-named condition.
 */
export function diffDumps(a: DumpNode, b: DumpNode, opts: { limit?: number } = {}): DiffReport {
  const all: Difference[] = [];
  const push = (path: string, before: unknown, after: unknown, absent?: Difference["absent"]) => {
    all.push({ path, before: before === undefined ? null : before, after: after === undefined ? null : after, ...(absent ? { absent } : {}) });
  };

  const value = (av: unknown, bv: unknown, path: string) => {
    if (av === undefined && bv === undefined) return;
    if (Array.isArray(av) || Array.isArray(bv)) {
      const aa = Array.isArray(av) ? av : [];
      const ba = Array.isArray(bv) ? bv : [];
      if (!Array.isArray(av) || !Array.isArray(bv)) return push(path, av, bv, !Array.isArray(av) ? "before" : "after");
      if (aa.length !== ba.length) push(`${path}.length`, aa.length, ba.length);
      for (let i = 0; i < Math.min(aa.length, ba.length); i++) value(aa[i], ba[i], `${path}[${i}]`);
      return;
    }
    if (isPlain(av) && isPlain(bv)) {
      const keys = new Set([...Object.keys(av as object), ...Object.keys(bv as object)]);
      for (const k of [...keys].sort()) {
        const x = (av as Record<string, unknown>)[k];
        const y = (bv as Record<string, unknown>)[k];
        if (x === undefined && y === undefined) continue;
        if (x === undefined || y === undefined) push(`${path}.${k}`, x, y, x === undefined ? "before" : "after");
        else value(x, y, `${path}.${k}`);
      }
      return;
    }
    if (eq(av, bv)) return;
    if (canonical(av) !== canonical(bv)) push(path, av, bv);
  };

  const node = (x: DumpNode, y: DumpNode, path: string) => {
    if (x.type !== y.type) push(`${path}.type`, x.type, y.type);
    if (x.name !== y.name) push(`${path}.name`, x.name, y.name);
    if (!!x.unsupported !== !!y.unsupported) push(`${path}.unsupported`, x.unsupported ?? null, y.unsupported ?? null);
    value(x.state ?? {}, y.state ?? {}, `${path}.state`);
    const xc = x.children ?? [];
    const yc = y.children ?? [];
    if (xc.length !== yc.length) push(`${path}.children.length`, xc.length, yc.length);
    for (let i = 0; i < Math.min(xc.length, yc.length); i++) node(xc[i], yc[i], `${path}.children[${i}]`);
  };

  node(a, b, "$");

  const limit = opts.limit ?? 200;
  return {
    identical: all.length === 0,
    total: all.length,
    differences: all.slice(0, limit),
    truncated: all.length > limit,
    notes: annotateDiffs(all),
  };
}

/**
 * The differences checkpoint-v1 can explain. Everything else is a difference
 * nobody predicted, which is exactly what the caller needs to look at.
 */
function annotateDiffs(diffs: Difference[]): string[] {
  const notes = new Set<string>();
  for (const d of diffs) {
    if (d.path.includes(".state.size")) notes.add("size: an auto-layout (HUG) frame owns its own size — the rebuild does not resize it, so a size difference there is the layout, not the rebuild");
    if (d.path.includes(".state.pos")) notes.add("position: inside an auto-layout parent the layout places children; a recorded position is not restored there");
    if (d.path.includes(".state.text.runs")) notes.add("runs: checkpoint-v1 writes one font per text node and does not rebuild per-run styling");
    if (d.path.endsWith(".children.length")) notes.add("children: the subtree has a different number of children — read `skipped` and `created` in the restore report");
  }
  return [...notes];
}

// ---------------------------------------------------------------- the summary

export interface DumpSummary {
  nodes: number;
  maxDepth: number;
  byType: Record<string, number>;
  texts: number;
  characters: number;
  images: number;
  instances: number;
  unsupported: Array<{ path: string; type: string; why: string }>;
  /** Text nodes whose fonts are mixed: the rebuild writes one font instead. */
  multiRunTexts: number;
  mixedFonts: number;
  /** Nodes whose style ids, variable bindings or explicit modes live in meta. */
  metaOnly: number;
  /** Nodes carrying node-level variable bindings (paint aliases travel in state). */
  variableBindings: number;
  /** Nodes carrying explicit variable modes. */
  variableModes: number;
  fonts: string[];
}

export function summarize(dump: DumpNode): DumpSummary {
  const s: DumpSummary = {
    nodes: 0, maxDepth: 0, byType: {}, texts: 0, characters: 0, images: 0, instances: 0,
    unsupported: [], multiRunTexts: 0, mixedFonts: 0, metaOnly: 0, variableBindings: 0, variableModes: 0, fonts: [],
  };
  const fonts = new Set<string>();
  const walk = (n: DumpNode, depth: number, path: string) => {
    s.nodes++;
    s.maxDepth = Math.max(s.maxDepth, depth);
    s.byType[n.type] = (s.byType[n.type] ?? 0) + 1;
    if (n.unsupported) s.unsupported.push({ path, type: n.type, why: n.unsupported });
    if (n.meta) {
      s.metaOnly++;
      if (n.meta.variableBindings) s.variableBindings++;
      if (n.meta.variableModes) s.variableModes++;
    }
    const st = (n.state ?? {}) as Record<string, any>;
    if (Array.isArray(st.fills)) for (const p of st.fills) if (p && p.type === "IMAGE") s.images++;
    if (n.type === "TEXT") {
      s.texts++;
      const t = st.text ?? {};
      s.characters += String(t.characters ?? "").length;
      if (t.runs > 1) s.multiRunTexts++;
      if (t.font === "mixed") s.mixedFonts++;
      else if (t.font && t.font.family) fonts.add(`${t.font.family} ${t.font.style ?? ""}`.trim());
    }
    if (n.type === "INSTANCE") s.instances++;
    (n.children ?? []).forEach((c, i) => walk(c, depth + 1, `${path}.children[${i}]`));
  };
  walk(dump, 0, "$");
  s.fonts = [...fonts].sort();
  return s;
}

// ---------------------------------------------------------------- the store

export const ENV_DIR = "FIGMA_BRIDGE_CHECKPOINTS_DIR";

/** Where checkpoints live. Overridable so tests never touch the real home dir. */
export function checkpointsDir(): string {
  const custom = process.env[ENV_DIR];
  if (custom && custom.trim()) return resolve(custom.trim());
  return join(homedir(), ".local/share/opencode/figma-bridge-checkpoints");
}

/**
 * A file key as a directory name. Figma's keys are alphanumeric, but an unsaved
 * file answers to a session key and a caller can pass anything, so everything
 * that is not obviously safe is folded to "-" — a key must never be able to walk
 * out of the checkpoints directory.
 */
export function storeKey(fileKey: string): string {
  const folded = String(fileKey).trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 80);
  if (!folded) throw new Error(`"${fileKey}" is not usable as a file key for storing checkpoints`);
  return folded;
}

/** Readable and sortable: 20261019-141230-splash-frame. */
export function checkpointId(nodeName: string, now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const slug = String(nodeName).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return slug ? `${stamp}-${slug}` : stamp;
}

export function filePath(dir: string, fileKey: string, id: string): string {
  return join(dir, storeKey(fileKey), `${storeKey(id)}.json`);
}

export function saveCheckpoint(dir: string, record: CheckpointRecord): string {
  const path = filePath(dir, record.fileKey, record.id);
  mkdirSync(join(dir, storeKey(record.fileKey)), { recursive: true });
  // Written through a temp name: a checkpoint that dies half-written would be
  // read back as a valid-looking file with a truncated dump.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2));
  renameSync(tmp, path);
  return path;
}

export function readCheckpoint(dir: string, fileKey: string, id: string): CheckpointRecord {
  const path = filePath(dir, fileKey, id);
  if (!existsSync(path)) {
    const known = listCheckpoints(dir, fileKey).map((c) => c.id);
    throw new Error(
      `no checkpoint "${id}" for this file (${path})` +
        (known.length ? `. Known: ${known.join(", ")}` : `. Nothing saved for this file yet — save one with action "save" before rebuilding.`),
    );
  }
  const rec = JSON.parse(readFileSync(path, "utf8")) as CheckpointRecord;
  if (!rec || rec.schema !== SCHEMA || !rec.envelope?.dump) throw new Error(`${path} is not a ${SCHEMA} checkpoint`);
  rec.id = rec.id ?? id;
  return rec;
}

export function listCheckpoints(dir: string, fileKey: string): CheckpointRecord[] {
  const sub = join(dir, storeKey(fileKey));
  if (!existsSync(sub)) return [];
  const out: CheckpointRecord[] = [];
  for (const name of readdirSync(sub)) {
    if (!name.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(readFileSync(join(sub, name), "utf8")) as CheckpointRecord;
      if (rec?.schema === SCHEMA && rec.envelope?.dump) out.push(rec);
    } catch {
      /* a file that is not a checkpoint is not listed, and not an error either */
    }
  }
  return out.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
}

/** Every file that has checkpoints, for the case where nothing is connected. */
export function listFilesWithCheckpoints(dir: string): Array<{ fileKey: string; count: number; newest: string }> {
  if (!existsSync(dir)) return [];
  const out: Array<{ fileKey: string; count: number; newest: string }> = [];
  for (const name of readdirSync(dir)) {
    const sub = join(dir, name);
    try {
      if (!statSync(sub).isDirectory()) continue;
    } catch {
      continue;
    }
    const records = listCheckpoints(dir, name);
    if (records.length) out.push({ fileKey: name, count: records.length, newest: records[0].savedAt });
  }
  return out.sort((a, b) => (a.newest < b.newest ? 1 : -1));
}

export function dropCheckpoint(dir: string, fileKey: string, id: string): string {
  const path = filePath(dir, fileKey, id);
  // readCheckpoint throws with the list of what IS there, which is a better
  // answer than a silent success on a typo.
  if (!existsSync(path)) readCheckpoint(dir, fileKey, id);
  rmSync(path);
  return path;
}

/** `latest`, an exact id, or any unambiguous prefix of one. */
export function resolveId(dir: string, fileKey: string, wanted: string): string {
  const known = listCheckpoints(dir, fileKey);
  if (!known.length) {
    throw new Error(`no checkpoints stored for this file yet (${join(dir, storeKey(fileKey))})`);
  }
  const want = String(wanted ?? "").trim();
  if (!want || want === "latest") return known[0].id;
  if (known.some((c) => c.id === want)) return want;
  const prefixed = known.filter((c) => c.id.startsWith(want));
  if (prefixed.length === 1) return prefixed[0].id;
  if (prefixed.length > 1) {
    throw new Error(`"${want}" matches ${prefixed.length} checkpoints: ${prefixed.map((c) => c.id).join(", ")}`);
  }
  throw new Error(`no checkpoint "${want}" for this file. Known: ${known.map((c) => c.id).join(", ")}`);
}
