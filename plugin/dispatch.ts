/**
 * Dispatch: idempotency and serialisation for incoming method calls.
 *
 * Two holes this closes, both of which can corrupt a document rather than
 * merely annoy:
 *
 * 1. IN FLIGHT. The client sends one `opId` per logical call and reuses it
 *    across retries, but the answer was only recorded once the method had
 *    RETURNED. A retry arriving while the first attempt was still running found
 *    an empty cache and executed the same `use_figma` snippet a second time,
 *    concurrently. Now the record is a Promise created at dispatch time: a retry
 *    joins the running call and gets its answer.
 *
 * 2. INTERLEAVING. `figma.commitUndo()` / `triggerUndo()` mark ONE global undo
 *    boundary. Two mutations in flight at once — two MCP sessions, or one
 *    session plus a UI-driven call — each mark and undo the other's work, so a
 *    call that fails and rolls back can revert the *other* call's edits. Writes
 *    are therefore chained: strictly one at a time. Reads stay concurrent; they
 *    can observe a half-applied state, but they cannot cause one.
 *
 * 3. KEY REUSE. An `opId` is an idempotency key, and nothing checked that it
 *    still named the SAME call. A sender that reused an id for a different
 *    method or different arguments got the first call's answer back — and
 *    believed the second had run, which for a write means believing an edit
 *    exists that was never made. The cache now keeps a fingerprint of the call
 *    it answered, and a mismatch is refused loudly instead of replayed.
 *
 * Deliberately free of any `figma` reference so it can be unit-tested outside
 * the plugin sandbox (see test/dispatch.test.mjs) — same reason as scope.ts.
 */

export interface Request {
  /** Transport id of THIS attempt; each retry carries a fresh one. */
  id: string;
  method: string;
  /** Stable across retries of one logical call. Absent on fire-and-forget calls. */
  opId?: string;
  params?: unknown;
}

/** The recorded answer to a logical call. Shared by every attempt that gets it. */
export interface OpRecord {
  ok: boolean;
  result?: unknown;
  error?: { message: string };
  rev: number;
}

/** A recorded answer, plus the identity of the call that produced it. */
interface Cached {
  method: string;
  fp: string;
  record: OpRecord;
}

/** An attempt that is still running: same identity, answer not written yet. */
interface Inflight {
  method: string;
  fp: string;
  promise: Promise<OpRecord>;
}

export interface Reply extends OpRecord {
  id: string;
  replayed?: boolean;
}

export interface DispatcherOptions {
  /** Runs the method. Throwing is how a method reports failure. */
  run: (method: string, params: any) => Promise<unknown>;
  /** Methods that write to the document; they are never run concurrently. */
  mutating: ReadonlySet<string>;
  /** Advances the completed-call counter (plugin/rev.ts). */
  bump: () => number;
  /** Reads the counter without advancing it (plugin/rev.ts `current`). */
  peek?: () => number;
  /** How many answers to keep for retries. */
  limit?: number;
}

const DEFAULT_LIMIT = 200;

/**
 * Identity of a logical call: its method and its arguments, with object key
 * order ignored — a retry can be written out by a different JSON encoder than
 * the attempt it repeats, and reordering keys does not change the call.
 */
export function fingerprint(method: string, params: unknown): string {
  return method + " " + canonical(params);
}

function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
}

export class Dispatcher {
  private cache = new Map<string, Cached>();
  private inflight = new Map<string, Inflight>();
  /** Tail of the mutation queue. Never rejects — see serialised(). */
  private tail: Promise<void> = Promise.resolve();

  constructor(private opts: DispatcherOptions) {}

  /**
   * Handles one request. Never rejects: a failure comes back as a failed Reply,
   * so the caller has exactly one shape to post.
   */
  async handle(req: Request): Promise<Reply> {
    const opId = typeof req.opId === "string" && req.opId ? req.opId : "";
    const fp = fingerprint(req.method, req.params);

    if (opId) {
      const recorded = this.cache.get(opId);
      if (recorded) {
        if (recorded.fp !== fp) return this.reused(req, opId, recorded.method);
        return { id: req.id, ...recorded.record, replayed: true };
      }
      const running = this.inflight.get(opId);
      // The attempt that is already running will post its own reply; this one
      // gets the same answer under its own transport id.
      if (running) {
        if (running.fp !== fp) return this.reused(req, opId, running.method);
        return { id: req.id, ...(await running.promise), replayed: true };
      }
    }

    const work = () => this.execute(req, opId, fp);
    const started = this.opts.mutating.has(req.method) ? this.serialised(work) : work();

    if (opId) {
      this.inflight.set(opId, { method: req.method, fp, promise: started });
      void started.finally(() => {
        // Only clear the entry this dispatch installed: a later logical call
        // could not have reused the id, but a cleared-and-reused one would make
        // a stale removal drop a live entry.
        if (this.inflight.get(opId)?.promise === started) this.inflight.delete(opId);
      });
    }

    return { id: req.id, ...(await started) };
  }

  /**
   * The id was already used for a DIFFERENT call. Neither replaying the old
   * answer (the caller would believe a call ran that never did) nor running the
   * new one (the key would stop meaning anything, and a retry of it would be
   * answered from the wrong record) is acceptable, so the attempt is refused and
   * the caller is told to mint a fresh id.
   */
  private reused(req: Request, opId: string, method: string): Reply {
    return {
      id: req.id,
      ok: false,
      error: {
        message:
          `OPID_REUSED: op ${opId} already answered a ${method} call and this is a ` +
          `${req.method} call with different arguments — nothing was replayed and ` +
          `nothing was run. Send this call under a fresh opId.`,
      },
      // Nothing ran, so the document did not move: read the counter, do not
      // advance it. A fabricated bump would make the next screenshot look
      // stale-but-valid.
      rev: this.opts.peek ? this.opts.peek() : this.opts.bump(),
    };
  }

  /** Chains `work` after the current tail of the mutation queue. */
  private serialised(work: () => Promise<OpRecord>): Promise<OpRecord> {
    // Both callbacks are `work`: the queue must move on whether the previous
    // mutation succeeded or failed.
    const next = this.tail.then(work, work);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async execute(req: Request, opId: string, fp: string): Promise<OpRecord> {
    let record: OpRecord;
    try {
      record = { ok: true, result: await this.opts.run(req.method, req.params ?? {}), rev: this.opts.bump() };
    } catch (err: any) {
      // rev advances on FAILURE too. A failed write may have mutated and then
      // rolled back, and a rolled-back document is not the state the agent last
      // screenshotted; treating it as unchanged would make the next screenshot
      // look stale-but-valid. Re-rendering is cheaper than a wrong conclusion.
      record = { ok: false, error: { message: String(err && err.message ? err.message : err) }, rev: this.opts.bump() };
    }
    if (opId) this.remember(opId, { method: req.method, fp, record });
    return record;
  }

  private remember(opId: string, entry: Cached) {
    const limit = this.opts.limit ?? DEFAULT_LIMIT;
    if (this.cache.size >= limit) {
      // Oldest first. Evicting only costs a re-execution for a call older than
      // the cap, which is why the cap can be generous.
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(opId, entry);
  }
}
