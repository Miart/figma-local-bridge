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
  /** How many answers to keep for retries. */
  limit?: number;
}

const DEFAULT_LIMIT = 200;

export class Dispatcher {
  private cache = new Map<string, OpRecord>();
  private inflight = new Map<string, Promise<OpRecord>>();
  /** Tail of the mutation queue. Never rejects — see serialised(). */
  private tail: Promise<void> = Promise.resolve();

  constructor(private opts: DispatcherOptions) {}

  /**
   * Handles one request. Never rejects: a failure comes back as a failed Reply,
   * so the caller has exactly one shape to post.
   */
  async handle(req: Request): Promise<Reply> {
    const opId = typeof req.opId === "string" && req.opId ? req.opId : "";

    if (opId) {
      const recorded = this.cache.get(opId);
      if (recorded) return { id: req.id, ...recorded, replayed: true };
      const running = this.inflight.get(opId);
      // The attempt that is already running will post its own reply; this one
      // gets the same answer under its own transport id.
      if (running) return { id: req.id, ...(await running), replayed: true };
    }

    const work = () => this.execute(req, opId);
    const started = this.opts.mutating.has(req.method) ? this.serialised(work) : work();

    if (opId) {
      this.inflight.set(opId, started);
      void started.finally(() => {
        // Only clear the entry this dispatch installed: a later logical call
        // could not have reused the id, but a cleared-and-reused one would make
        // a stale removal drop a live entry.
        if (this.inflight.get(opId) === started) this.inflight.delete(opId);
      });
    }

    return { id: req.id, ...(await started) };
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

  private async execute(req: Request, opId: string): Promise<OpRecord> {
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
    if (opId) this.remember(opId, record);
    return record;
  }

  private remember(opId: string, record: OpRecord) {
    const limit = this.opts.limit ?? DEFAULT_LIMIT;
    if (this.cache.size >= limit) {
      // Oldest first. Evicting only costs a re-execution for a call older than
      // the cap, which is why the cap can be generous.
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(opId, record);
  }
}
