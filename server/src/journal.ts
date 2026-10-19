/**
 * The journal: a local append-only record of every call this bridge SENT to a
 * Figma plugin, and how each one ended.
 *
 * `figma_ops` already answers "what happened to the call that timed out?" — but
 * only while the client process remembers it AND the plugin is still paired.
 * The two facts that matter most are exactly the ones that outlive that memory:
 *
 *   - a timeout whose answer never came ("may or may not have been applied");
 *   - a process that died with a call in flight — the send line is on disk, no
 *     terminal line follows it, and nothing else in the system still knows.
 *
 * JSONL is enough for both, and nothing bigger is recorded: method names,
 * target ids, revisions and outcomes. Snippets, text content and image data
 * never reach this file — a log that leaks them would be worse than no log.
 *
 * Two rules the rest of the system leans on:
 *
 *   - appendJournal NEVER throws into a call path. A journal that breaks a tool
 *     is worse than no journal; a failure is remembered (journalStatus) and
 *     surfaced by the figma_journal tool instead of being swallowed silently.
 *   - lines are additive. New fields may appear; existing ones keep their
 *     meaning, so a reader written today keeps working.
 *
 * Several MCP client processes (one per editor window) append to the same
 * file. Each line is written with one O_APPEND write, so lines do not
 * interleave; per-process buffering is deliberately not used. Rotation keeps
 * the active file plus two older segments (~6 MB); a rotation raced by two
 * processes at once can drop one older segment early, but never corrupts a
 * line.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Where the journal lives. Overridable so tests never touch the real home dir. */
export const ENV_DIR = "FIGMA_BRIDGE_JOURNAL_DIR";
/** `FIGMA_BRIDGE_JOURNAL=0` switches recording off (the file is left alone). */
export const ENV_OFF = "FIGMA_BRIDGE_JOURNAL";

/** The active segment, and the two it rotates into, newest first. */
export const SEGMENTS = ["ops.jsonl", "ops.1.jsonl", "ops.2.jsonl"] as const;

/** Rotation threshold. Three segments bound the journal at ~6 MB. */
export const MAX_BYTES = 2 * 1024 * 1024;

/** Read cap, so a hand-planted giant file cannot be read into memory whole. */
const READ_CAP_BYTES = 8 * 1024 * 1024;

/** Which request fields travel with a `send` line. Everything else — above all
 * `code`, `text` and `base64` — is payload and never recorded. */
const TARGET_KEYS = [
  "nodeId",
  "scopeNodeId",
  "parentId",
  "targetNodeId",
  "sourceId",
  "action",
  "dryRun",
  "allowDestructive",
  "allowPartial",
  "allowPageWide",
  "description",
] as const;

export interface JournalConfig {
  enabled: boolean;
  dir: string;
}

export function journalConfig(env: NodeJS.ProcessEnv = process.env): JournalConfig {
  const custom = env[ENV_DIR];
  return {
    enabled: env[ENV_OFF] !== "0",
    dir: custom && custom.trim() ? resolve(custom.trim()) : join(homedir(), ".local/share/opencode/figma-bridge-journal"),
  };
}

export interface JournalError {
  at: string;
  path: string;
  error: string;
}

/** The last append failure in THIS process, for figma_journal to report. */
let lastError: JournalError | null = null;

export function journalStatus(): JournalConfig & { lastError: JournalError | null } {
  return { ...journalConfig(), lastError };
}

/** One line to record. `at` and `pid` are stamped by appendJournal. */
export interface JournalEntry {
  event: "send" | "retry" | "ok" | "failed" | "timeout" | "dropped" | "late";
  opId: string;
  method: string;
  file: string | null;
  [k: string]: unknown;
}

export interface AppendResult {
  path: string;
  error?: string;
}

/**
 * Append one line. Returns null when the journal is switched off; a write
 * failure comes back as `{ path, error }` and is also remembered in
 * journalStatus(). It never throws.
 */
export function appendJournal(
  entry: JournalEntry,
  opts: { dir?: string; maxBytes?: number } = {},
): AppendResult | null {
  const cfg = journalConfig();
  if (!cfg.enabled) return null;
  const dir = resolve(opts.dir ?? cfg.dir);
  const path = join(dir, SEGMENTS[0]);
  try {
    mkdirSync(dir, { recursive: true });
    rotateIfNeeded(dir, opts.maxBytes ?? MAX_BYTES);
    // `at` and `pid` are stamped here and win over anything the caller passed:
    // the timestamp belongs to the moment of recording, not to the caller.
    const line = JSON.stringify({ ...entry, at: new Date().toISOString(), pid: process.pid }) + "\n";
    appendFileSync(path, line);
    return { path };
  } catch (err) {
    const failure: JournalError = { at: new Date().toISOString(), path, error: String((err as Error)?.message || err) };
    lastError = failure;
    return { path, error: failure.error };
  }
}

/**
 * Shift the segments when the active one has grown past `maxBytes`:
 * ops.2 is dropped, ops.1 → ops.2, ops → ops.1; the next append recreates ops.
 *
 * Each rename is atomic; the sequence is not, and two processes crossing the
 * threshold in the same instant can drop one older segment ahead of schedule.
 * That is accepted: losing the oldest lines early beats a lock protocol around
 * a log.
 */
export function rotateIfNeeded(dir: string, maxBytes: number = MAX_BYTES): boolean {
  const active = join(dir, SEGMENTS[0]);
  let size: number;
  try {
    size = statSync(active).size;
  } catch {
    return false;
  }
  if (size < maxBytes) return false;
  try {
    rmSync(join(dir, SEGMENTS[2]), { force: true });
  } catch {
    /* the oldest segment may not exist */
  }
  try {
    renameSync(join(dir, SEGMENTS[1]), join(dir, SEGMENTS[2]));
  } catch {
    /* ditto for the middle one */
  }
  try {
    renameSync(active, join(dir, SEGMENTS[1]));
  } catch {
    /* a racing process may have rotated first — keep appending instead */
  }
  return true;
}

/** The request fields worth keeping for a `send` line: where a call pointed,
 * what it was allowed to touch, and the one-line description figma_use takes
 * "for the log". Strings are clipped; unknown params are never copied. */
export function journalTargets(params: unknown): Record<string, unknown> {
  const p = (params ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of TARGET_KEYS) {
    const v = p[k];
    if (typeof v === "string" && v) out[k] = clip(v, k === "description" ? 200 : 80);
    else if (typeof v === "boolean" || typeof v === "number") out[k] = v;
  }
  return out;
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

export interface JournalRead {
  enabled: boolean;
  dir: string;
  files: Array<{ name: string; bytes: number; modifiedAt: string }>;
  entries: Array<Record<string, unknown>>;
  /** Matching lines in everything that was read, before the `last` cut. */
  matching: number;
  scannedLines: number;
  /** Lines that were not JSON — counted, not fatal. */
  skippedLines: number;
  /** The newest file ends mid-line: the writer died between a write and its flush. */
  partialTail: boolean;
  bytesRead: number;
  /** The read cap was hit; older lines were not looked at. */
  truncated: boolean;
  lastError: JournalError | null;
}

export interface ReadOptions {
  dir?: string;
  last?: number;
  fileKey?: string;
  method?: string;
  /** Only the lines whose call did not end with a clean answer: `timeout`,
   * `dropped` and `late`. */
  unsettled?: boolean;
}

const UNSETTLED = new Set(["timeout", "dropped", "late"]);

/**
 * The tail of the journal for a reader: every segment is read (bounded by
 * READ_CAP_BYTES), lines are filtered, and the last `last` matches come back
 * oldest-first so the story reads in order.
 */
export function readJournal(opts: ReadOptions = {}): JournalRead {
  const cfg = journalConfig();
  const dir = resolve(opts.dir ?? cfg.dir);
  const last = Math.max(1, Math.min(500, opts.last ?? 50));

  const files: JournalRead["files"] = [];
  let scannedLines = 0;
  let skippedLines = 0;
  let bytesRead = 0;
  let partialTail = false;
  let truncated = false;
  // One bucket per segment, lines in file order; buckets are concatenated
  // oldest-segment-first at the end.
  const buckets: Array<Array<Record<string, unknown>>> = SEGMENTS.map(() => []);

  for (const [i, name] of SEGMENTS.entries()) {
    const path = join(dir, name);
    let raw: string;
    let bytes: number;
    let modifiedAt: string;
    try {
      const st = statSync(path);
      bytes = st.size;
      modifiedAt = new Date(st.mtimeMs).toISOString();
    } catch {
      continue; // a segment that was never created
    }
    files.push({ name, bytes, modifiedAt });

    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const budget = READ_CAP_BYTES - bytesRead;
    if (Buffer.byteLength(raw, "utf8") > budget) {
      // A giant segment (a hand-grown file?) — take its tail only and say so,
      // instead of allocating the whole thing.
      raw = Buffer.from(raw).subarray(-Math.max(0, budget)).toString("utf8");
      const nl = raw.indexOf("\n");
      raw = nl >= 0 ? raw.slice(nl + 1) : "";
      truncated = true;
    }
    bytesRead += Buffer.byteLength(raw, "utf8");

    // A file that does not end with a newline ends mid-write; the fragment is
    // dropped and named, not reported as a corrupt line.
    if (raw.length && !raw.endsWith("\n")) {
      partialTail = true;
      raw = raw.slice(0, raw.lastIndexOf("\n") + 1);
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      scannedLines++;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        skippedLines++;
        continue;
      }
      if (opts.fileKey && entry.file !== opts.fileKey) continue;
      if (opts.method && entry.method !== opts.method) continue;
      if (opts.unsettled && !UNSETTLED.has(String(entry.event))) continue;
      buckets[i].push(entry);
    }
  }

  // SEGMENTS is newest-first; the story is oldest-first.
  const matches: Array<Record<string, unknown>> = [];
  for (let i = SEGMENTS.length - 1; i >= 0; i--) matches.push(...buckets[i]);
  const matching = matches.length;

  return {
    enabled: cfg.enabled,
    dir,
    files,
    entries: matches.slice(-last),
    matching,
    scannedLines,
    skippedLines,
    partialTail,
    bytesRead,
    truncated,
    lastError,
  };
}
