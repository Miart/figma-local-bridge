/**
 * Link: a bidirectional JSON envelope channel.
 *
 * Two implementations, because the WebSocket must be owned by exactly ONE
 * process (the daemon) while opencode spawns one MCP process per working
 * directory:
 *
 *   BridgeLink  — in-process, when this process IS the daemon
 *   DaemonLink  — connects to the running daemon as a client
 *
 * Interface-only so FigmaClient does not care which one it has.
 */

import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { BridgeOffline, BridgeNotPaired } from "./websocket.js";

export type Envelope = { id: string | null; [k: string]: unknown };

export interface Link {
  send(env: Envelope): void;
  subscribe(handler: (env: Envelope) => void): () => void;
  get connected(): boolean;
  close(): void;
}

/** Wraps an existing in-process bridge as a Link. */
export class BridgeLink implements Link {
  constructor(private bridge: {
    send(env: Envelope): void;
    subscribe(handler: (env: Envelope) => void): () => void;
    connected: boolean;
    close(): void;
  }) {}

  send(env: Envelope) {
    this.bridge.send(env);
  }
  subscribe(handler: (env: Envelope) => void) {
    return this.bridge.subscribe(handler);
  }
  get connected() {
    return this.bridge.connected;
  }
  close() {
    this.bridge.close();
  }
}

export interface DaemonInfo {
  ws: string;
  pluginToken: string;
  clientKey: string;
  pid: number;
  startedAt: number;
}

/**
 * Client side: connects to the running daemon and speaks the same envelope
 * protocol. Request ids are namespaced per client so two MCP processes cannot
 * collide on the broadcast channel.
 */
export class DaemonLink implements Link {
  private ws: WebSocket | null = null;
  private handlers = new Set<(e: Envelope) => void>();
  private pending = new Map<string, (env: Envelope) => void>();
  private closedByUs = false;
  private retry: NodeJS.Timeout | null = null;
  private attempt = 0;

  constructor(
    private info: DaemonInfo,
    private clientId = randomUUID().slice(0, 8),
    /** Re-read on every reconnect: the daemon mints a fresh clientKey on start. */
    private infoPath?: string,
  ) {}

  /**
   * Picks up a restarted daemon's address and key. Required, not optional: a
   * daemon restart mints a NEW clientKey, so reconnecting with the value read at
   * process start is refused with 4403 and the client stays dead forever.
   */
  private refreshInfo() {
    if (!this.infoPath) return;
    const fresh = readDaemonInfo(this.infoPath);
    if (!fresh) return;
    if (fresh.pid === this.info.pid) return;
    this.info = fresh;
  }

  connect(): void {
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    this.refreshInfo();
    // Rebuild the URL properly — regexing a full ws:// string eats the host.
    const u = new URL(this.info.ws);
    u.searchParams.delete("token");
    u.searchParams.set("role", "mcp");
    u.searchParams.set("key", this.info.clientKey);
    u.searchParams.set("cid", this.clientId);

    const ws = new WebSocket(u.toString());
    this.ws = ws;

    ws.on("message", (data) => {
      let env: Envelope;
      try {
        env = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (env.event) {
        for (const h of this.handlers) h(env);
        return;
      }
      if (env.id == null) {
        for (const h of this.handlers) h(env);
        return;
      }
      // Strip the client namespace so ids look like the plugin's original ids.
      const bare = String(env.id).replace(new RegExp("^" + this.clientId + ":"), "");
      for (const h of this.handlers) h({ ...env, id: bare });
    });

    ws.on("open", () => {
      this.attempt = 0;
      // Deliberately does NOT guess `connected` here. Whether a plugin is paired
      // is daemon state; the daemon sends the authoritative answer in the same
      // frame it registers us. Guessing from our own socket state was wrong in
      // both directions — it claimed "connected" with no plugin at all, and it
      // could not recover when the plugin had paired before this process started.
      for (const h of this.handlers) h({ id: null, event: "linkattached" });
    });

    ws.on("close", () => {
      for (const h of this.handlers) h({ id: null, event: "link", connected: false });
      // The daemon is the long-lived process; it restarts (crash, kickstart) far
      // more often than the editor respawns us. Without this, one daemon restart
      // orphans every MCP process until the user restarts their editor.
      if (!this.closedByUs) {
        const delay = Math.min(1000 * 2 ** this.attempt++, 10_000);
        this.retry = setTimeout(() => this.connect(), delay);
      }
    });

    ws.on("error", () => {
      /* surfaced through close */
    });
  }

  send(env: Envelope) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new BridgeOffline();
    this.ws.send(JSON.stringify({ ...env, id: env.id == null ? null : `${this.clientId}:${env.id}` }));
  }

  subscribe(handler: (e: Envelope) => void) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  get connected() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  close() {
    this.closedByUs = true;
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
  }

  get isClosedByUs() {
    return this.closedByUs;
  }
}

/**
 * Stand-in for a daemon that is not running at all (no descriptor file): there
 * is nothing to connect to and nothing to wait for. send() says so immediately
 * instead of letting every tool call wait out the link grace and then report the
 * wrong cause — the old version built a DaemonLink pointed at port 0, which is
 * not an address any socket will ever answer.
 */
export class OfflineLink implements Link {
  send(): never {
    throw new BridgeNotPaired("the bridge daemon is not running, so nothing was sent.");
  }
  subscribe(): () => void {
    return () => {};
  }
  get connected() {
    return false;
  }
  close() {
    /* nothing to close */
  }
}

/**
 * Daemon side. Holds THE WebSocket to the plugin and fans envelopes out to every
 * connected MCP client. Only the plugin connection is token-gated; MCP clients
 * authenticate with a shared key read from the session file.
 */
export class Daemon {
  private servers: WebSocketServer[] = [];
  /** MCP clients, each with the namespace its request ids carry (see broadcast). */
  private mcpClients = new Map<WebSocket, string | null>();
  private plugin: WebSocket | null = null;
  private handlers = new Set<(e: Envelope) => void>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(private info: DaemonInfo) {}

  /** Class-level logger — `onConnection` has its own local one. */
  private say = (...a: unknown[]) =>
    process.stderr.write("[conn] " + a.join(" ") + "\n");

  /**
   * Pings the plugin socket so a dead one is detected instead of lingering.
   *
   * Figma unloads plugin UIs when the app is backgrounded, and the browser
   * tears the socket down without a close frame (code 1005). The plugin then
   * reconnects, but a half-frozen iframe can also leave the socket open while
   * silent — that one is invisible from here and every call into it hangs.
   * A ping that gets no pong means the peer is gone: terminate it and let the
   * plugin pair again.
   */
  private startHeartbeat() {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      const p = this.plugin as any;
      if (!p || p.readyState !== WebSocket.OPEN) return;
      if (p._alive === false) {
        this.say("plugin heartbeat missed — terminating dead socket");
        try { p.terminate(); } catch { /* ignore */ }
        return;
      }
      p._alive = false;
      try { p.ping(); } catch { /* ignore */ }
    }, 15000);
    if (typeof (this.heartbeat as any).unref === "function") (this.heartbeat as any).unref();
  }

  async listen(port: number, hosts: string[]): Promise<void> {
    for (const host of hosts) {
      const wss = new WebSocketServer({ host, port });
      await new Promise<void>((resolve, reject) => {
        wss.once("error", reject);
        wss.once("listening", () => resolve());
      });
      wss.on("connection", (socket: WebSocket, req: IncomingMessage) =>
        this.onConnection(socket, req),
      );
      this.servers.push(wss);
    }
  }

  private onConnection(socket: WebSocket, req: IncomingMessage) {
    const url = new URL(req.url || "/", "http://localhost");
    const role = url.searchParams.get("role");
    const peer = req.socket.remoteAddress || "?";
    const log = (...a: unknown[]) =>
      process.stderr.write("[conn] " + a.join(" ") + "\n");
    log(`in role=${role} peer=${peer} mcpClients=${this.mcpClients.size}`);

    if (role === "plugin") {
      if (url.searchParams.get("token") !== this.info.pluginToken) {
        log("refuse plugin: bad token");
        socket.close(4401, "bad token");
        return;
      }
      if (this.plugin && this.plugin.readyState === WebSocket.OPEN) {
        log("refuse plugin: slot already held (4409)");
        socket.close(4409, "already paired");
        return;
      }
      this.plugin = socket;
      (socket as any)._alive = true;
      socket.on("pong", () => { (socket as any)._alive = true; });
      this.startHeartbeat();
      log("plugin PAIRED");
      this.broadcast({ id: null, event: "link", connected: true });
      // A freshly opened panel must not claim "no MCP session" until the next
      // connection event happens to fire.
      this.notifyPluginClients();
      socket.on("message", (data) => {
        // Only the socket that currently holds the slot may speak. A plugin UI
        // that is being torn down leaves its socket behind for a moment, and
        // its stale replies used to be accepted as if they came from the live
        // plugin.
        if (this.plugin !== socket) return;
        const env = this.parse(data);
        if (env) {
          for (const h of this.handlers) h(env);
          this.broadcast(env);
        }
      });
      socket.on("close", (code, reason) => {
        const wasOurs = this.plugin === socket;
        if (wasOurs) this.plugin = null;
        log(
          `plugin CLOSE code=${code} reason=${String(reason || "")} wasHolder=${wasOurs}`,
        );
        if (wasOurs) this.broadcast({ id: null, event: "link", connected: false });
      });
      socket.on("error", (e) => log("plugin error " + (e as Error).message));
      return;
    }

    if (role === "mcp") {
      if (url.searchParams.get("key") !== this.info.clientKey) {
        log("refuse mcp: bad key");
        socket.close(4403, "bad key");
        return;
      }
      this.mcpClients.set(socket, url.searchParams.get("cid"));
      // Answer the CURRENT state immediately. Without this a client that starts
      // after the plugin paired waits forever for an event that already fired,
      // and reports the file as empty/offline while the plugin is live.
      socket.send(JSON.stringify({ id: null, event: "link", connected: this.hasPlugin }));
      this.notifyPluginClients();
      socket.on("message", (data) => {
        const env = this.parse(data);
        if (!env) return;
        // Requests from MCP clients go only to the plugin.
        if (env.id != null && this.plugin && this.plugin.readyState === WebSocket.OPEN) {
          this.plugin.send(data.toString());
        }
      });
      socket.on("close", () => {
        this.mcpClients.delete(socket);
        this.notifyPluginClients();
      });
      socket.on("error", () => {});
      return;
    }

    socket.close(4400, "unknown role");
  }

  private parse(data: unknown): Envelope | null {
    try {
      return JSON.parse(String(data));
    } catch {
      return null;
    }
  }

  /**
   * Sends an envelope to the MCP client it belongs to.
   *
   * A request id is namespaced by the sending client (`<cid>:<id>`, see
   * DaemonLink.send), and the plugin echoes that id in its reply — so a reply
   * can be addressed to its owner instead of broadcast. That distinction
   * matters at 100 kB: every base64 screenshot used to be parsed by every MCP
   * process attached to the daemon, including sessions working on other files.
   *
   * Falls back to broadcasting whenever the id carries no known namespace:
   * events, and anything a client sent without one. Sending one frame too many
   * is a wasted parse; dropping an answer would be a hung call.
   */
  private broadcast(env: Envelope) {
    const raw = JSON.stringify(env);
    const cid = env.id == null ? null : String(env.id).split(":")[0];
    for (const [client, clientCid] of this.mcpClients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (cid && clientCid && cid !== clientCid) continue;
      client.send(raw);
    }
  }

  /**
   * Tells the plugin how many MCP sessions are attached, so its panel can show
   * it. The plugin has no other way to learn this: it only ever sees its own
   * replies, and "is opencode actually attached to this file" is the first
   * question when a tool call does nothing.
   */
  private notifyPluginClients() {
    const p = this.plugin;
    if (!p || p.readyState !== WebSocket.OPEN) return;
    try {
      p.send(JSON.stringify({ id: null, event: "clients", count: this.mcpClients.size }));
    } catch {
      /* the socket went away between the check and the send */
    }
  }

  onEvent(h: (e: Envelope) => void) {
    this.handlers.add(h);
  }

  get hasPlugin() {
    return !!this.plugin && this.plugin.readyState === WebSocket.OPEN;
  }

  close() {
    for (const w of this.servers) w.close();
  }
}

/** Reads the daemon descriptor written by the daemon process. */
export function readDaemonInfo(path: string): DaemonInfo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path, "utf8"));
    // Every field is load-bearing. `ws` is dialled, `clientKey` authenticates,
    // and `pid` decides whether a reconnect is needed (see DaemonLink.refreshInfo):
    // a descriptor with pid undefined would compare as "changed" on every single
    // refresh and thrash. A file half-written by a daemon that was killed
    // mid-write must read as ABSENT — the caller then reports "no daemon"
    // instead of dialling a URL built from undefined.
    if (typeof raw.ws !== "string" || !raw.ws) return null;
    if (typeof raw.pluginToken !== "string" || !raw.pluginToken) return null;
    if (typeof raw.clientKey !== "string" || !raw.clientKey) return null;
    if (!Number.isFinite(raw.pid) || !Number.isFinite(raw.startedAt)) return null;
    return raw as DaemonInfo;
  } catch {
    return null;
  }
}