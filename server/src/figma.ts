import crypto from "node:crypto";
import type { Link, Envelope } from "./link.js";
import { BridgeOffline, BridgeNotPaired } from "./websocket.js";

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
  /** Logical call this attempt belongs to, for the drop message. */
  opId: string;
  method: string;
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

/**
 * RPC client over a Link. Behaves identically whether this process is the
 * daemon (BridgeLink) or a client attached to it (DaemonLink).
 */
export class FigmaClient {
  private pending = new Map<string, Pending>();
  private selection: SelectionState | null = null;
  private linked = false;
  private waiters = new Set<() => void>();

  constructor(private link: Link) {
    link.subscribe((env) => this.onEnvelope(env));
  }

  /** Rejects every in-flight request. Used when the plugin goes away. */
  private failAll(reason: string) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(
        p.sent
          ? new BridgeOffline(
              `the Figma plugin disconnected while ${p.method} was in flight (op ${p.opId}). ` +
                `It may or may not have been applied; the retry carries the same opId so the plugin ` +
                `replays the recorded answer instead of running it twice. ${reason}`,
            )
          : new BridgeOffline(`the Figma plugin disconnected before ${p.method} was sent (op ${p.opId}). ${reason}`),
      );
      this.pending.delete(id);
    }
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
    if (env.event === "link") {
      const was = this.linked;
      this.linked = !!env.connected;
      if (was && !this.linked) {
        // The plugin dropped. Fail in-flight calls NOW rather than letting them
        // hang until their own timeout: a dropped plugin used to turn every
        // request in progress into a 30-115s stall, with a generic timeout
        // message that hid the real cause.
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
      this.selection = null;
      // Fail in-flight calls immediately instead of leaving the agent on a
      // 30s timeout.
      this.failAll("The bridge link is down.");
      return;
    }
    if (env.event === "selection") {
      this.selection = {
        page: env.page as SelectionState["page"],
        selection: env.selection as SelectionState["selection"],
        at: Date.now(),
      };
      return;
    }
    if (env.id === null || env.id === undefined) return;

    const pending = this.pending.get(String(env.id));
    if (!pending) return;
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

  get lastSelection() {
    return this.selection;
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
        return await this.callOnce<T>(method, params, timeoutMs, opId);
      } catch (err) {
        // Nothing was ever sent — callOnce already waited its grace. Retrying
        // now would just spend the same two seconds again and then report the
        // same state; the agent may as well learn right away.
        if (err instanceof BridgeNotPaired) throw err;
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
  ): Promise<CallMeta<T>> {
    await this.ensureLinked(opId, method);

    const id = crypto.randomBytes(8).toString("hex");
    const promise = new Promise<Envelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`bridge timeout after ${timeoutMs}ms on ${method} (op ${opId})`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        sent: false,
        opId,
        method,
      });
    });

    const entry = this.pending.get(id)!;
    try {
      this.link.send({ id, method, params, opId });
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