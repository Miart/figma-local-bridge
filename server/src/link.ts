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
 * How many Figma files one daemon serves at once. A ceiling exists at all so a
 * runaway loop of panels (or a bug) cannot grow the routing table forever; 16 is
 * far past what anyone works with, and a panel that hits it is told exactly why.
 */
const MAX_FILES = 16;

/** One connected Figma window, addressed by the file it serves. */
interface PluginEntry {
  ws: WebSocket;
  /** figma.root.name — for error messages and the files list, nothing else. */
  name: string;
  /** false for a file that was never saved (the plugin mints the session key). */
  saved: boolean;
}

/**
 * Daemon side. Holds ONE WebSocket per connected Figma file and fans envelopes
 * out to every connected MCP client. Only plugin connections are token-gated;
 * MCP clients authenticate with a shared key read from the session file.
 *
 * Multi-file: the daemon used to hold a single plugin slot, so the second Figma
 * window was refused with 4409 and the user had to close the first. The slot is
 * now a map keyed by fileKey — still ONE process, ONE port, ONE token, but a
 * request can name the file it is for. A request that names no file is routed
 * only when exactly one is connected; otherwise it is answered with an error
 * (never guessed), listing what IS connected.
 */
export class Daemon {
  private servers: WebSocketServer[] = [];
  /** MCP clients, each with the namespace its request ids carry (see broadcast). */
  private mcpClients = new Map<WebSocket, string | null>();
  /**
   * Connected files, keyed by fileKey. A missing fileKey (an older plugin
   * build, or a hand-written probe) registers under "" and behaves as the
   * single legacy file.
   */
  private plugins = new Map<string, PluginEntry>();
  private handlers = new Set<(e: Envelope) => void>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(private info: DaemonInfo) {}

  /** Class-level logger — `onConnection` has its own local one. */
  private say = (...a: unknown[]) =>
    process.stderr.write("[conn] " + a.join(" ") + "\n");

  /**
   * Pings every plugin socket so a dead one is detected instead of lingering.
   *
   * Figma unloads plugin UIs when the app is backgrounded, and the browser
   * tears the socket down without a close frame (code 1005). The plugin then
   * reconnects, but a half-frozen iframe can also leave the socket open while
   * silent — that one is invisible from here and every call into it hangs.
   * A ping that gets no pong means the peer is gone: terminate it and let the
   * plugin pair again. Per socket, not globally: one frozen window must not
   * fail the files that are fine.
   */
  private startHeartbeat() {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const [key, entry] of this.plugins) {
        const p = entry.ws as any;
        if (p.readyState !== WebSocket.OPEN) continue;
        if (p._alive === false) {
          this.say(`plugin heartbeat missed — terminating dead socket (file ${key || "legacy"})`);
          try { p.terminate(); } catch { /* ignore */ }
          continue;
        }
        p._alive = false;
        try { p.ping(); } catch { /* ignore */ }
      }
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
      const fileKey = url.searchParams.get("fileKey") || "";
      const name = url.searchParams.get("name") || (fileKey ? fileKey : "legacy plugin");
      if (!this.plugins.has(fileKey) && this.plugins.size >= MAX_FILES) {
        log(`refuse plugin: already serving ${MAX_FILES} files`);
        socket.close(4413, `too many files (max ${MAX_FILES})`);
        return;
      }
      const previous = this.plugins.get(fileKey);
      if (previous && previous.ws !== socket && previous.ws.readyState === WebSocket.OPEN) {
        // A reloaded panel for the SAME file takes its own slot back. The old
        // socket is closed with 4409, and its close handler checks identity
        // before touching the map, so it cannot evict the new entry.
        log(`replace the older socket for file ${fileKey || "(no key)"}`);
        try { previous.ws.close(4409, "replaced by a newer socket"); } catch { /* it is going away */ }
      }
      this.plugins.set(fileKey, { ws: socket, name, saved: !!fileKey && !fileKey.startsWith("unsaved-") });
      (socket as any)._alive = true;
      socket.on("pong", () => { (socket as any)._alive = true; });
      this.startHeartbeat();
      log(`plugin PAIRED file=${fileKey || "(no key)"} name="${name}" files=${this.plugins.size}`);
      this.broadcast({ id: null, event: "file", fileKey, connected: true });
      this.broadcast({ id: null, event: "link", connected: true });
      this.broadcast(this.filesEvent());
      // A freshly opened panel must not claim "no MCP session" until the next
      // connection event happens to fire.
      this.notifyPluginClients();
      socket.on("message", (data) => {
        // Only the socket that CURRENTLY holds this file's slot may speak. A
        // plugin UI that is being torn down leaves its socket behind for a
        // moment, and its stale replies used to be accepted as if they came
        // from the live plugin — per file, so a replaced panel cannot answer
        // for the panel that took over.
        const entry = this.plugins.get(fileKey);
        if (!entry || entry.ws !== socket) return;
        const env = this.parse(data);
        if (env) {
          // The daemon, not the plugin, knows which file a frame belongs to
          // (it mapped the socket), so replies and pushed events carry `file`
          // without the plugin having to repeat itself.
          const stamped = fileKey && env.file === undefined ? { ...env, file: fileKey } : env;
          for (const h of this.handlers) h(stamped);
          this.broadcast(stamped);
        }
      });
      socket.on("close", (code, reason) => {
        const entry = this.plugins.get(fileKey);
        const wasOurs = !!entry && entry.ws === socket;
        if (wasOurs) this.plugins.delete(fileKey);
        if (wasOurs) {
          log(`plugin CLOSE code=${code} reason=${String(reason || "")} file=${fileKey || "(no key)"}`);
          this.broadcast({ id: null, event: "file", fileKey, connected: false });
          this.broadcast({ id: null, event: "link", connected: this.hasPlugin });
          this.broadcast(this.filesEvent());
        } else {
          log(`plugin CLOSE (superseded) code=${code} file=${fileKey || "(no key)"}`);
        }
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
      // and reports the file as empty/offline while the plugin is live. The
      // files list rides along, or the first tool call in a narrow window would
      // refuse with an empty list of candidates.
      socket.send(JSON.stringify({ id: null, event: "link", connected: this.hasPlugin }));
      socket.send(JSON.stringify(this.filesEvent()));
      this.notifyPluginClients();
      socket.on("message", (data) => {
        const env = this.parse(data);
        if (!env) return;
        // Requests from MCP clients go only to the plugin that serves the
        // named file (or the only file, when no file was named).
        if (env.id == null) return;
        const target = this.route(env.file);
        if (target) {
          target.send(data.toString());
          return;
        }
        // Unroutable: answer in the same envelope shape the plugin would use,
        // so the caller fails NOW with the reason instead of counting down a
        // timeout that blames the wrong thing. The id is echoed VERBATIM — it
        // carries the sender's namespace, which is how the reply finds its way
        // back through broadcast().
        socket.send(JSON.stringify({
          id: env.id,
          ok: false,
          error: { message: this.routeError(env.file) },
        }));
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

  /** The socket a request with this `file` must go to, or null when unroutable. */
  private route(file: unknown): WebSocket | null {
    const open = (e: PluginEntry | undefined) =>
      e && e.ws.readyState === WebSocket.OPEN ? e.ws : null;
    if (typeof file === "string" && file) return open(this.plugins.get(file));
    if (this.plugins.size === 1) return open([...this.plugins.values()][0]);
    return null;
  }

  /**
   * Why a request could not be routed, phrased so the agent can act: which
   * files exist, and what to pass. Never "did you mean X" — a wrong guess here
   * edits the wrong file.
   *
   * Only the first branch is an outage. The other two are calls the caller can
   * fix, so they carry their own codes instead of the FIGMA_BRIDGE_OFFLINE
   * prefix, which reads as "open the plugin" and sends the caller after the
   * wrong thing.
   */
  private routeError(file: unknown): string {
    if (!this.hasPlugin) {
      return "FIGMA_BRIDGE_OFFLINE — no Figma plugin is connected, so nothing was sent.";
    }
    if (typeof file === "string" && file) {
      return (
        `FIGMA_BRIDGE_UNKNOWN_FILE — no Figma plugin is connected for fileKey "${file}" — the request was not delivered. ` +
        `Connected files: ${this.describeFiles()} — re-run figma_ping and retry with one of these keys.`
      );
    }
    return (
      `FIGMA_BRIDGE_FILE_KEY_REQUIRED — no fileKey was given and more than one file is connected — the request was not delivered. ` +
      `Connected files: ${this.describeFiles()} — pass fileKey to choose one.`
    );
  }

  /** The connected files, stable order, for the `files` event and errors. */
  private fileList(): Array<{ fileKey: string; name: string; saved: boolean }> {
    return [...this.plugins.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([fileKey, e]) => ({ fileKey, name: e.name, saved: e.saved }));
  }

  private filesEvent(): Envelope {
    return { id: null, event: "files", files: this.fileList() };
  }

  /** `"Name" (key)` for every connected file — the phrase all errors share. */
  private describeFiles(): string {
    return this.fileList()
      .map((f) => `"${f.name}" (${f.fileKey || "no key"})`)
      .join(", ");
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
   * Tells every plugin how many MCP sessions are attached, so its panel can
   * show it. The plugin has no other way to learn this: it only ever sees its
   * own replies, and "is opencode actually attached to this file" is the first
   * question when a tool call does nothing. The count is global (a session is
   * attached to the daemon, not to one file) — that is the honest number.
   */
  private notifyPluginClients() {
    const raw = JSON.stringify({ id: null, event: "clients", count: this.mcpClients.size });
    for (const { ws } of this.plugins.values()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(raw);
      } catch {
        /* the socket went away between the check and the send */
      }
    }
  }

  onEvent(h: (e: Envelope) => void) {
    this.handlers.add(h);
  }

  get hasPlugin() {
    for (const e of this.plugins.values()) {
      if (e.ws.readyState === WebSocket.OPEN) return true;
    }
    return false;
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