import crypto from "node:crypto";
import type { Link, Envelope } from "./link.js";
import { BridgeOffline, BridgeNotPaired, BridgeNotRouted } from "./websocket.js";

/**
 * How long a call waits for the link before giving up.
 *
 * Bounded on purpose. Figma unloads the plugin UI when the app is backgrounded
 * and nothing brings it back until the user refocuses — waiting 15 s (and then
 * again in the retry loop) turned every offline tool call into a 30 s stall
 * whose error blamed the wrong thing. Two seconds covers the flap this is
 * actually for: the plugin re-pairs a few hundred ms after a reload, and
 * DaemonLink retries its socket after ~1 s.
 */
const LINK_GRACE_MS = 2000;

interface Pending {
  resolve: (env: Envelope) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  /** False until the request is on the wire; tells "never sent" from "maybe ran". */
  sent: boolean;
  /** When this attempt began waiting — what `figma_ops` reports as the wait. */
  since: number;
  /** Logical call this attempt belongs to, for the drop message. */
  opId: string;
  method: string;
  /** fileKey this request was routed to, when it was known before sending. */
  file: string | undefined;
}

/**
 * What the plugin stamps around a result. `rev` is the document revision the
 * answer belongs to (enough to tell a stale screenshot from an unchanged
 * document), and `replayed` says the method did NOT run again — the answer came
 * from the plugin's opId cache. Both live on the envelope, not inside the
 * result, which is why call() has a meta-returning twin.
 */
export interface CallMeta<T> {
  result: T;
  rev: number | null;
  replayed: boolean;
}

export interface SelectionState {
  page: { id: string; name: string };
  selection: Array<{ id: string; name: string; type: string }>;
  at: number;
}

/** A call this client is still waiting for. */
export interface ClientOp {
  opId: string;
  method: string;
  file: string | undefined;
  waitedMs: number;
  /** False while the request is still being written to the socket. */
  sent: boolean;
}

/**
 * A call whose caller gave up — its own timeout fired — and, if it ever arrived,
 * the answer that came back afterwards.
 *
 * Kept because it is the difference between "may or may not have been applied"
 * and a fact. The plugin may be finishing the very write the caller abandoned;
 * `figma_ops` reports it, and while the plugin still has it queued `figma_cancel`
 * can stop it before it writes.
 */
export interface AbandonedOp {
  opId: string;
  method: string;
  file: string | undefined;
  /** How long the call was waited for before giving up. */
  waitedMs: number;
  timedOutAt: number;
  /** Filled in when the late envelope arrives; null if it never did. */
  answer: { ok: boolean; rev: number | null; error?: string } | null;
}

/** One connected Figma file, as the daemon reports it. */
export interface FileInfo {
  fileKey: string;
  name: string;
  saved: boolean;
}

/** `"Name" (key)` for every connected file — the phrase all errors share. */
const describeFiles = (files: FileInfo[]) =>
  files.map((f) => `"${f.name}" (${f.fileKey || "no key"})`).join(", ");

/**
 * RPC client over a Link. Behaves identically whether this process is the
 * daemon (BridgeLink) or a client attached to it (DaemonLink).
 */
export class FigmaClient {
  private pending = new Map<string, Pending>();
  /**
   * Calls that timed out, by transport id, newest last. Bounded: this is a
   * diagnostic trail for "what happened to the op that timed out?", not a log.
   */
  private abandoned = new Map<string, AbandonedOp & { id: string }>();
  /**
   * Most recent selection per file — the plugin pushes selectionchange, so this
   * is answered from memory. Key `` "" `` holds pushes that carry no file
   * identity (the legacy in-process bridge).
   */
  private selections = new Map<string, SelectionState>();
  /** Files the daemon reports as connected. The daemon is the authority. */
  private connectedFiles: FileInfo[] = [];
  private linked = false;
  private waiters = new Set<() => void>();

  constructor(private link: Link) {
    link.subscribe((env) => this.onEnvelope(env));
  }

  /**
   * Rejects every in-flight request matching `match`. Used when a plugin goes
   * away: ALL of them when the daemon link itself dropped, only the named
   * file's when one file disconnected while its neighbours stayed — a call to a
   * file that is still there must not be shot down by the one next to it.
   *
   * `noRetry` is for the per-file case: the file's own slot is gone, so
   * re-sending to it cannot reach anything, and the retry loop's message
   * ("nothing was sent") would be wrong about the attempt that DID go out. The
   * rejection is marked so callWithMeta hands it straight to the agent.
   */
  private failWhere(match: (p: Pending) => boolean, reason: string, noRetry = false) {
    for (const [id, p] of this.pending) {
      if (!match(p)) continue;
      clearTimeout(p.timer);
      const err = p.sent
        ? noRetry
          ? new BridgeOffline(
              `${reason} ${p.method} was in flight (op ${p.opId}) and may or may not have been applied — ` +
                `re-check the document (rev / figma_inspect) before running it again.`,
            )
          : new BridgeOffline(
              `the Figma plugin disconnected while ${p.method} was in flight (op ${p.opId}). ` +
                `It may or may not have been applied; the retry carries the same opId so the plugin ` +
                `replays the recorded answer instead of running it twice. ${reason}`,
            )
        : noRetry
          ? new BridgeOffline(`${reason} ${p.method} was not sent (op ${p.opId}).`)
          : new BridgeOffline(`the Figma plugin disconnected before ${p.method} was sent (op ${p.opId}). ${reason}`);
      if (noRetry) (err as Error & { bridgeNoRetry?: boolean }).bridgeNoRetry = true;
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private failAll(reason: string) {
    this.failWhere(() => true, reason);
  }

  /**
   * Resolves once the plugin is paired again, or after the timeout. Always
   * resolves — the caller re-reads `connected`, because "the link came back" is
   * not the same as "the plugin is there".
   */
  private waitForLink(timeoutMs: number): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        // Remove the waiter when the TIMEOUT fires, not only when wakeWaiters
        // drains the set: a client that only ever times out used to collect one
        // dead closure per call.
        this.waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.waiters.add(finish);
    });
  }

  private wakeWaiters() {
    // Copy: finish() removes itself from the set.
    for (const r of [...this.waiters]) r();
  }

  private onEnvelope(env: Envelope) {
    if (env.event === "files") {
      // The daemon's authoritative list of connected files. Kept verbatim so a
      // tool can either route by fileKey or tell the agent what to choose from.
      const list = Array.isArray(env.files) ? (env.files as Array<Partial<FileInfo>>) : [];
      this.connectedFiles = list
        .filter((f) => f && typeof f.fileKey === "string")
        .map((f) => ({ fileKey: String(f.fileKey), name: String(f.name ?? ""), saved: f.saved === true }));
      return;
    }
    if (env.event === "file") {
      const file = String(env.fileKey ?? "");
      if (env.connected) return;
      // ONE file went away. Fail only the calls aimed at it (plus calls sent
      // before the list arrived, which cannot be attributed) and drop its
      // remembered selection; the other files stay usable. No retry — see
      // failWhere.
      this.selections.delete(file);
      this.failWhere(
        (p) => p.file === file || p.file === undefined,
        `file ${file ? `"${file}"` : "(no key)"} disconnected.`,
        true,
      );
      return;
    }
    if (env.event === "link") {
      const was = this.linked;
      this.linked = !!env.connected;
      if (was && !this.linked) {
        // The plugin dropped. Fail in-flight calls NOW rather than letting them
        // hang until their own timeout: a dropped plugin used to turn every
        // request in progress into a 30-115s stall, with a generic timeout
        // message that hid the real cause.
        this.connectedFiles = [];
        this.selections.clear();
        this.failAll("It is reconnecting.");
        return;
      }
      if (this.linked) this.wakeWaiters();
      return;
    }
    if (env.event === "paired") {
      // startBridge (in-process mode) reports the plugin as "paired", not
      // "link connected:true". Same state, different word — without this the
      // in-process client sat at linked=false while a healthy plugin waited.
      this.linked = true;
      this.wakeWaiters();
      return;
    }
    if (env.event === "disconnected") {
      this.linked = false;
      this.selections.clear();
      this.connectedFiles = [];
      // Fail in-flight calls immediately instead of leaving the agent on a
      // 30s timeout.
      this.failAll("The bridge link is down.");
      return;
    }
    if (env.event === "selection") {
      this.selections.set(String(env.file ?? ""), {
        page: env.page as SelectionState["page"],
        selection: env.selection as SelectionState["selection"],
        at: Date.now(),
      });
      return;
    }
    if (env.id === null || env.id === undefined) return;

    const pending = this.pending.get(String(env.id));
    if (!pending) {
      // A LATE ANSWER to a call whose timeout already fired. The caller is gone,
      // so nothing is resolved — but the fact is kept: "may or may not have been
      // applied" is precisely what figma_ops exists to settle.
      const abandoned = this.abandoned.get(String(env.id));
      if (abandoned) {
        abandoned.answer = {
          ok: env.ok === true,
          rev: typeof env.rev === "number" ? env.rev : null,
          ...(env.ok === true
            ? {}
            : { error: String(((env.error as { message?: string } | undefined) || {}).message || "plugin error") }),
        };
      }
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(String(env.id));

    if (env.ok) pending.resolve(env);
    else {
      const err = env.error as { message?: string } | undefined;
      pending.reject(new Error(String((err && err.message) || "plugin error")));
    }
  }

  get connected() {
    return this.linked && this.link.connected;
  }

  /** Connected Figma files, as the daemon last reported them. */
  get files(): FileInfo[] {
    return this.connectedFiles;
  }

  /** Calls this client is still waiting for, newest last. */
  inFlightOps(): ClientOp[] {
    const now = Date.now();
    const out: ClientOp[] = [];
    for (const p of this.pending.values()) {
      out.push({ opId: p.opId, method: p.method, file: p.file, waitedMs: now - p.since, sent: p.sent });
    }
    return out;
  }

  /** Calls whose timeout fired, and any answer that arrived afterwards. */
  abandonedOps(): AbandonedOp[] {
    return [...this.abandoned.values()].map(({ id: _id, ...rest }) => rest);
  }

  /**
   * Remember a call nobody is waiting for any more. The transport id stays the
   * key, because that is what a late envelope carries — the opId is the caller's
   * name for the call and is what a tool or a cancel refers to.
   */
  private rememberAbandoned(entry: AbandonedOp & { id: string }) {
    this.abandoned.set(entry.id, entry);
    const limit = 20;
    while (this.abandoned.size > limit) {
      const oldest = this.abandoned.keys().next().value;
      if (oldest === undefined) break;
      this.abandoned.delete(oldest);
    }
  }

  /**
   * The selection the plugin pushed for a file, answered from memory.
   *
   * With several files connected and no fileKey this refuses (like every other
   * file-scoped read) instead of guessing which window the user meant.
   */
  lastSelection(fileKey?: string): SelectionState | null {
    const file = this.resolveFile(fileKey);
    if (file !== undefined) return this.selections.get(file) ?? null;
    if (this.selections.size === 1) return [...this.selections.values()][0];
    return null;
  }

  /**
   * Which file a call targets, or undefined to let the daemon pick (it routes
   * to the only file and refuses when there are several).
   *
   * The refusal is repeated here, with the list, so the agent hears it BEFORE
   * anything is sent — a guess at this point would silently edit the wrong
   * file, and the daemon's own check would arrive too late to prevent it.
   *
   * Both refusals are BridgeNotRouted, not "offline": the bridge is up and
   * other files are being served, so the honest reading is "this call was not
   * routed", and the message has to say what to pass instead.
   */
  private resolveFile(requested?: string): string | undefined {
    if (requested) {
      if (this.connectedFiles.length && !this.connectedFiles.some((f) => f.fileKey === requested)) {
        throw new BridgeNotRouted(
          `FIGMA_BRIDGE_UNKNOWN_FILE — no Figma plugin is connected for fileKey "${requested}", so nothing was sent. ` +
            `Connected files: ${describeFiles(this.connectedFiles)}. ` +
            `An unsaved file's key changes when its panel reloads — re-run figma_ping and retry with one of these keys.`,
        );
      }
      return requested;
    }
    if (this.connectedFiles.length === 1) return this.connectedFiles[0].fileKey;
    if (this.connectedFiles.length > 1) {
      throw new BridgeNotRouted(
        `FIGMA_BRIDGE_FILE_KEY_REQUIRED — more than one Figma file is connected, so nothing was sent — pass fileKey to choose one: ` +
          `${describeFiles(this.connectedFiles)}.`,
      );
    }
    return undefined;
  }

  async call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30_000,
  ): Promise<T> {
    return (await this.callWithMeta<T>(method, params, timeoutMs)).result;
  }

  /**
   * call(), plus the facts the plugin stamps on the envelope: `rev` and whether
   * this answer was replayed from the opId cache instead of executing again.
   * A tool that reports them to the agent lets it tell "the edit did nothing"
   * from "the render is stale", which are otherwise indistinguishable.
   */
  async callWithMeta<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30_000,
  ): Promise<CallMeta<T>> {
    // `fileKey` in params is ROUTING metadata, not payload: it is consumed
    // here and never forwarded, because a plugin only ever serves the one file
    // it runs in. Tools pass their arguments through unchanged either way.
    const { fileKey, ...payload } = params as Record<string, unknown> & { fileKey?: unknown };
    const requested = typeof fileKey === "string" && fileKey ? fileKey : undefined;
    // Throws BridgeNotPaired (immediately, no retry) when the target is
    // ambiguous or unknown — see resolveFile.
    const file = this.resolveFile(requested);

    // Figma can tear the plugin down and bring it back several times a second
    // in a heavy document. A single attempt has a good chance of landing in
    // the gap, so a dropped connection is not a failure — it is a retry.
    //
    // The opId is minted ONCE here and reused by every attempt. That is what
    // makes retrying safe: the plugin remembers what it already did for this
    // id and replays the recorded answer, so a call that half-ran before the
    // socket died cannot run a second time and duplicate its own work.
    const opId = crypto.randomBytes(8).toString("hex");
    // The retry loop swallows the first, most informative failure. Keep it: if
    // the retries run out, the operator still needs to know whether the work
    // may already be in the document.
    let firstDrop: string | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.callOnce<T>(method, payload, timeoutMs, opId, file);
      } catch (err) {
        // Nothing was ever sent — callOnce already waited its grace. Retrying
        // now would just spend the same two seconds again and then report the
        // same state; the agent may as well learn right away. Same for a
        // failure that belongs to ONE file's slot (see failWhere): re-sending
        // cannot reach anything, and the message already tells the whole story.
        if (err instanceof BridgeNotPaired || (err as { bridgeNoRetry?: boolean } | null)?.bridgeNoRetry) throw err;
        const drop = err instanceof BridgeOffline || /disconnected/i.test(String((err as Error)?.message || err));
        if (!drop) throw err;
        if (!firstDrop) firstDrop = String((err as Error)?.message || err);
        // Wait for the plugin to pair again, then try the same call under the
        // same opId.
        await this.waitForLink(LINK_GRACE_MS);
        if (!this.connected) {
          throw new BridgeNotPaired(
            `${firstDrop}\nThe plugin did not come back within ${LINK_GRACE_MS} ms, so ${method} was ` +
              `not re-sent (op ${opId}).`,
          );
        }
      }
    }
    throw new BridgeOffline(`${firstDrop}\nGave up on ${method} after 5 attempts (op ${opId}).`);
  }

  /**
   * Bounded wait for a usable link, then fail with the exact state.
   *
   * Split into two questions because they have different answers and different
   * messages: is there a transport at all (link.connected), and is a plugin
   * paired on it (this.linked)?
   */
  private async ensureLinked(opId: string, method: string): Promise<void> {
    if (this.connected) return;
    if (!this.link.connected) {
      await this.waitForLink(LINK_GRACE_MS);
      if (!this.link.connected) {
        throw new BridgeNotPaired(
          `the client has no socket to the bridge daemon; ${method} was not sent (op ${opId}).`,
        );
      }
    }
    if (!this.linked) {
      await this.waitForLink(LINK_GRACE_MS);
      if (!this.connected) {
        throw new BridgeNotPaired(
          `no Figma plugin is paired with the bridge; ${method} was not sent (op ${opId}).`,
        );
      }
    }
  }

  private async callOnce<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    opId: string,
    file: string | undefined,
  ): Promise<CallMeta<T>> {
    await this.ensureLinked(opId, method);

    const id = crypto.randomBytes(8).toString("hex");
    const promise = new Promise<Envelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          // The caller is giving up, but the plugin may not be: keep the call
          // visible so a late answer lands somewhere instead of nowhere.
          this.rememberAbandoned({
            id,
            opId,
            method,
            file,
            waitedMs: Date.now() - p.since,
            timedOutAt: Date.now(),
            answer: null,
          });
        }
        reject(
          new Error(
            `bridge timeout after ${timeoutMs}ms on ${method} (op ${opId}) — the plugin may still be running it. ` +
              `figma_ops shows whether it is queued or running (and figma_cancel can stop it while it is still queued); ` +
              `figma_ops with opId "${opId}" reports the answer if it finished after this timeout.`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        sent: false,
        since: Date.now(),
        opId,
        method,
        file,
      });
    });

    const entry = this.pending.get(id)!;
    try {
      this.link.send({ id, method, params, opId, ...(file ? { file } : {}) });
      entry.sent = true;
    } catch (err) {
      const p = this.pending.get(id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(id);
      }
      throw err;
    }
    const env = await promise;
    return {
      result: env.result as T,
      rev: typeof env.rev === "number" ? env.rev : null,
      replayed: env.replayed === true,
    };
  }
}