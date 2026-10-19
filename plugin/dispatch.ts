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
 * 4. ABANDONED WORK. Writes are chained, so a call can sit in the queue for as
 *    long as the write ahead of it takes. The caller, meanwhile, has its own
 *    timeout: it gives up, the agent decides the edit failed and plans around
 *    that — and then the queued write runs anyway, at a revision nobody is
 *    watching. `cancel` is the way out, and it is deliberately narrow: it stops
 *    only ops that have NOT started (Figma cannot interrupt running code from
 *    inside the plugin), it answers the waiting caller at once instead of when
 *    the queue reaches the corpse, and the record says OP_CANCELLED without
 *    moving the revision, because nothing touched the document. `report` is the
 *    view that makes this usable: what is running, what is waiting, what just
 *    finished — the answer to "did that call that timed out ever run?".
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

/**
 * One tracked operation. `queued` is the only state `cancel` can act on, and the
 * only one where "nothing ran" is provable rather than hoped for.
 */
interface OpInfo {
  opId: string;
  method: string;
  /** Call identity — kept so a cancelled op can be recorded in the cache. */
  fp: string;
  state: "queued" | "running" | "done" | "cancelled";
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
  rev?: number;
  ok?: boolean;
  error?: string;
}

/** An operation as `report` describes it. Times are the plugin's clock. */
export interface OpSnapshot {
  opId: string;
  method: string;
  state: OpInfo["state"];
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
  /** Time spent waiting for the queue, end to end. */
  waitedMs: number;
  /** Time the call itself took, while running or once finished. */
  ranMs?: number;
  rev?: number;
  ok?: boolean;
  error?: string;
}

export interface OpsReport {
  running: OpSnapshot[];
  queued: OpSnapshot[];
  recent: OpSnapshot[];
  /** Operations seen since the plugin started; `recent` is the tail of them. */
  seen: number;
  /** How many recorded answers are still available for replay. */
  kept: number;
  note: string;
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

/** `1.4 s` — durations are read by people, and by agents quoting them. */
function secs(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(1) + " s";
}

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
  /** Tracked operations, oldest first; settled ones are pruned at the cap. */
  private ops = new Map<string, OpInfo>();
  /** Resolvers for operations still in the queue, so cancel() can answer now. */
  private answers = new Map<string, (record: OpRecord) => void>();
  /** Operations ever tracked, so a report can say how long the plugin has been busy. */
  private seen = 0;
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

    const mutating = this.opts.mutating.has(req.method);
    // Tracked BEFORE the call is dispatched, so a cancel that arrives while this
    // is still waiting in the queue finds it. Calls without an opId are not
    // tracked: there is no id to name them by, and no retry to protect.
    if (opId) this.track(opId, req.method, fp, mutating);
    const work = () => this.execute(req, opId, fp);
    const started = mutating ? this.serialised(opId, work) : work();

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
      rev: this.current(),
    };
  }

  /**
   * Chains `work` after the current tail of the mutation queue.
   *
   * The queued call gets its own promise, resolved either by the work or by
   * `cancel`. That split matters: a cancelled call has to answer its caller NOW,
   * not when the queue finally reaches a corpse it is going to skip.
   */
  private serialised(opId: string, work: () => Promise<OpRecord>): Promise<OpRecord> {
    let answer!: (record: OpRecord) => void;
    const promise = new Promise<OpRecord>((resolve) => {
      answer = resolve;
    });
    if (opId) this.answers.set(opId, answer);

    const start = (): Promise<void> => {
      const info = opId ? this.ops.get(opId) : undefined;
      // cancel() has already answered this one; it must not run, and the queue
      // moves straight on to whatever is behind it.
      if (info && info.state === "cancelled") return Promise.resolve();
      if (info) {
        info.state = "running";
        info.startedAt = Date.now();
      }
      return work().then(
        (record) => {
          if (opId) this.answers.delete(opId);
          answer(record);
        },
        // execute() turns every failure into a record, so this is unreachable —
        // and it stays because the alternative to an unreachable branch here is
        // a caller that waits for an answer nobody will send.
        (err) => {
          if (opId) this.answers.delete(opId);
          answer({ ok: false, error: { message: String((err && err.message) || err) }, rev: this.current() });
        },
      );
    };

    // Both callbacks are `start`: the queue must move on whether the previous
    // mutation succeeded or failed.
    this.tail = this.tail.then(start, start).then(
      () => undefined,
      () => undefined,
    );
    return promise;
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
    if (opId) {
      this.remember(opId, { method: req.method, fp, record });
      const info = this.ops.get(opId);
      // A cancelled op never gets here (its work was not run), and a live one
      // must stop claiming to be live: `report` is what the agent uses to decide
      // whether a call it abandoned is still going to write.
      if (info && info.state !== "cancelled") {
        info.state = "done";
        info.endedAt = Date.now();
        info.rev = record.rev;
        info.ok = record.ok;
        if (!record.ok) info.error = record.error?.message;
      }
    }
    return record;
  }

  // ------------------------------------------------------------- operations

  /**
   * What is running, what is waiting for the queue, and what finished recently.
   *
   * This answers a question the bridge used to leave open: a write queued behind
   * another write may have been abandoned by its caller (its own timeout fired)
   * long before the queue reached it. Here it is visible — and still
   * cancellable while its state is `queued`.
   */
  report(recentLimit = 10): OpsReport {
    const now = Date.now();
    const running: OpSnapshot[] = [];
    const queued: OpSnapshot[] = [];
    const recent: OpSnapshot[] = [];
    for (const info of this.ops.values()) {
      const snap = this.snapshot(info, now);
      if (info.state === "running") running.push(snap);
      else if (info.state === "queued") queued.push(snap);
      else recent.push(snap);
    }
    recent.reverse(); // newest first: the last thing the plugin did is what is asked about
    return {
      running,
      queued,
      recent: recent.slice(0, Math.max(0, recentLimit)),
      seen: this.seen,
      kept: this.cache.size,
      note:
        "Only calls that carried an opId appear here — the MCP server sends one per logical call, so a fire-and-forget message never shows up. " +
        "`queued` means the call has not started and figma_cancel can still stop it. " +
        "A `running` call cannot be interrupted from inside the plugin: Figma runs the code to the end, and the answer is recorded when it does.",
    };
  }

  /** The recorded answer for an opId, for settling a call whose caller gave up. */
  answer(opId: string): OpRecord | null {
    return this.cache.get(opId)?.record ?? null;
  }

  /**
   * Stop an operation that has not started yet.
   *
   * Only `queued` is cancellable, and that is a fact about Figma rather than a
   * preference: plugin code runs to completion, so a call that has begun cannot
   * be taken back — pretending otherwise would leave a half-applied edit nobody
   * is tracking. A queued call provably did nothing, so stopping it is safe, and
   * its answer says exactly that.
   */
  cancel(opId: string): { opId: string; method: string; waitedMs: number; position: number } {
    const now = Date.now();
    const info = this.ops.get(opId);
    if (!info) {
      throw new Error(
        `OP_UNKNOWN: no operation "${opId}" is tracked here, so nothing was cancelled. Live: ${this.live()}. ` +
          `Recent: ${this.recentLine()}. A call sent without an opId cannot be named this way — check the document instead (figma_inspect).`,
      );
    }
    if (info.state === "running") {
      throw new Error(
        `OP_RUNNING: op ${opId} (${info.method}) is running right now — ${secs(now - (info.startedAt ?? now))} in — ` +
          `and Figma runs plugin code to the end, so it cannot be interrupted from inside the plugin. Nothing was cancelled. ` +
          `Its answer will be recorded when it finishes: figma_ops shows it, and re-sending the same opId replays that answer instead of running the call again.`,
      );
    }
    if (info.state === "done" || info.state === "cancelled") {
      const outcome =
        info.state === "cancelled"
          ? "was cancelled while it was still queued, so it never ran"
          : `finished ${secs(now - (info.endedAt ?? now))} ago at rev ${info.rev ?? "?"} (${info.ok ? "ok" : `failed: ${info.error ?? "no message"}`})`;
      throw new Error(
        `OP_DONE: op ${opId} (${info.method}) ${outcome} — there is nothing left to cancel. ` +
          `If you need to know what it did, ask figma_ops for op ${opId}.`,
      );
    }

    // Queued: it provably has not run. Answer its caller immediately — the whole
    // point is that nobody should be waiting on work that will not happen — and
    // record the refusal under the opId, so a retry of the same logical call
    // replays the cancellation instead of starting it.
    let position = 0;
    for (const other of this.ops.values()) {
      if (other === info) break;
      if (other.state === "queued") position++;
    }
    const waitedMs = now - info.queuedAt;
    info.state = "cancelled";
    info.endedAt = now;
    info.ok = false;
    info.error = `OP_CANCELLED: op ${opId} (${info.method}) was cancelled while it was still queued — nothing of it ran.`;
    const record: OpRecord = {
      ok: false,
      error: { message: info.error },
      // Nothing ran, so the document did not move: read the counter, do not
      // advance it (same reasoning as OPID_REUSED above).
      rev: this.current(),
    };
    this.remember(opId, { method: info.method, fp: info.fp, record });
    const answer = this.answers.get(opId);
    if (answer) {
      this.answers.delete(opId);
      answer(record);
    }
    return { opId, method: info.method, waitedMs, position };
  }

  // ------------------------------------------------------------------ state

  private track(opId: string, method: string, fp: string, mutating: boolean) {
    const now = Date.now();
    this.seen++;
    this.ops.set(opId, {
      opId,
      method,
      fp,
      // A read is already running by the time we get here; a write would be
      // lying if it said so — it has not been near the document yet.
      state: mutating ? "queued" : "running",
      queuedAt: now,
      ...(mutating ? {} : { startedAt: now }),
    });
    const limit = this.opts.limit ?? DEFAULT_LIMIT;
    if (this.ops.size > limit) {
      // Settled entries only: a queued or running op is live state, and dropping
      // one would make `report` say an edit is gone that is still coming.
      for (const [id, info] of this.ops) {
        if (this.ops.size <= Math.floor(limit / 2)) break;
        if (info.state === "done" || info.state === "cancelled") this.ops.delete(id);
      }
    }
  }

  private snapshot(info: OpInfo, now: number): OpSnapshot {
    const started = info.startedAt;
    const ended = info.endedAt ?? now;
    return {
      opId: info.opId,
      method: info.method,
      state: info.state,
      queuedAt: info.queuedAt,
      ...(started !== undefined ? { startedAt: started } : {}),
      ...(info.endedAt !== undefined ? { endedAt: info.endedAt } : {}),
      waitedMs: (started ?? now) - info.queuedAt,
      ...(started !== undefined ? { ranMs: ended - started } : {}),
      ...(info.rev !== undefined ? { rev: info.rev } : {}),
      ...(info.ok !== undefined ? { ok: info.ok } : {}),
      ...(info.error !== undefined ? { error: info.error } : {}),
    };
  }

  /** Live ops as `id (method)`, for an error that has to say what it does know. */
  private live(): string {
    const out: string[] = [];
    for (const info of this.ops.values()) {
      if (info.state === "queued" || info.state === "running") out.push(`${info.opId} (${info.method}, ${info.state})`);
    }
    return out.length ? out.join(", ") : "none";
  }

  private recentLine(): string {
    const out: string[] = [];
    for (const info of this.ops.values()) {
      if (info.state === "done" || info.state === "cancelled") out.push(`${info.opId} (${info.method})`);
    }
    const tail = out.slice(-3).reverse();
    return tail.length ? tail.join(", ") + " — the oldest entries are pruned first" : "none";
  }

  private current(): number {
    return this.opts.peek ? this.opts.peek() : this.opts.bump();
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
