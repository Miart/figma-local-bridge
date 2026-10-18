import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import crypto from "node:crypto";

export type Envelope = { id: string | null; [k: string]: unknown };

export interface Bridge {
  readonly token: string;
  readonly port: number;
  /** Loopback addresses actually bound (e.g. 127.0.0.1 and ::1). */
  readonly hosts: string[];
  readonly connected: boolean;
  /** Sends a request envelope to the paired plugin. Throws BridgeOffline. */
  send(env: Envelope): void;
  /** Subscribes to envelopes coming back from the plugin. Returns unsubscribe. */
  subscribe(handler: (env: Envelope) => void): () => void;
  waitForPlugin(timeoutMs?: number): Promise<void>;
  close(): void;
}

export class BridgeOffline extends Error {
  constructor(reason?: string) {
    super(
      "FIGMA_BRIDGE_OFFLINE — the local bridge plugin is not connected.\n" +
        'Open "Figma Local Bridge" in the target Figma file and keep it running.' +
        (reason ? "\n" + reason : ""),
    );
    this.name = "BridgeOffline";
  }
}

/**
 * The request never left this process: no plugin is paired, or the daemon that
 * would carry it is not reachable. Kept as a subclass of BridgeOffline so every
 * existing `instanceof` check keeps working, and so the message keeps the
 * FIGMA_BRIDGE_OFFLINE code that agents, docs and the e2e match on.
 *
 * The distinct name is what FigmaClient.call() uses to stop immediately: it has
 * already given the link its grace period, and a request that was never sent has
 * nothing to replay — retrying would only double the wait before the agent hears
 * the same thing.
 */
export class BridgeNotPaired extends BridgeOffline {
  constructor(reason?: string) {
    super(reason);
    this.name = "BridgeNotPaired";
  }
}

/**
 * WebSocket server for the plugin side.
 *
 * Listens on BOTH loopback families. `localhost` resolves to both 127.0.0.1 and
 * ::1, and a browser may try IPv6 first without falling back, so binding only
 * the IPv4 socket makes the plugin unreachable even though "localhost works"
 * from a Node client (Node tries both families).
 *
 * Session pairing: a token is minted per process start and printed to stderr
 * (stdout carries the MCP stdio protocol). Only one plugin may pair; a second
 * connection with the same token is refused. Without this, any local process —
 * including an npm postinstall — could drive the plugin and rewrite the file.
 */
export async function startBridge(port: number, host = "127.0.0.1"): Promise<Bridge> {
  const token = crypto.randomBytes(16).toString("hex");
  const handlers = new Set<(env: Envelope) => void>();
  const pairWaiters = new Set<() => void>();
  const servers: WebSocketServer[] = [];
  let plugin: WebSocket | null = null;

  const emit = (env: Envelope) => {
    for (const h of handlers) {
      try {
        h(env);
      } catch {
        /* a bad subscriber must not kill the socket */
      }
    }
  };

  const onConnection = (socket: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || "/", `http://${host}`);
    const presented = url.searchParams.get("token");

    if (presented !== token) {
      socket.close(4401, "bad token");
      return;
    }
    if (plugin && plugin.readyState === WebSocket.OPEN) {
      socket.close(4409, "already paired");
      return;
    }

    plugin = socket;
    emit({ id: null, event: "paired" });
    for (const w of pairWaiters) w();

    socket.on("message", (data) => {
      let env: Envelope;
      try {
        env = JSON.parse(data.toString());
      } catch {
        return;
      }
      emit(env);
    });

    socket.on("close", () => {
      if (plugin === socket) plugin = null;
      emit({ id: null, event: "disconnected" });
    });

    socket.on("error", () => {
      /* surfaced through close */
    });
  };

  const listen = (h: string) =>
    new Promise<WebSocketServer>((resolve, reject) => {
      // port 0 asks the OS for an ephemeral port; both listeners must share the
      // same one, so the first bind decides and the second reuses it.
      const wss = new WebSocketServer({ host: h, port });
      wss.once("error", reject);
      wss.once("listening", () => resolve(wss));
    });

  const first = await listen(host);
  servers.push(first);
  const boundPort = readPort(first, port);

  // Mirror on the other loopback family. Best-effort: one family is enough as
  // long as it is the one the browser picks.
  const alt = host === "127.0.0.1" ? "::1" : "127.0.0.1";
  try {
    const wss = new WebSocketServer({ host: alt, port: boundPort });
    await new Promise<void>((resolve, reject) => {
      wss.once("error", reject);
      wss.once("listening", () => resolve());
    });
    servers.push(wss);
  } catch {
    // IPv6 unavailable on this host — IPv4 alone is acceptable.
  }

  for (const wss of servers) wss.on("connection", onConnection);

  return {
    token,
    port: boundPort,
    hosts: servers.map((w) => readHost(w)).filter((h): h is string => !!h),
    get connected() {
      return !!plugin && plugin.readyState === WebSocket.OPEN;
    },
    send(env) {
      if (!plugin || plugin.readyState !== WebSocket.OPEN) throw new BridgeOffline();
      plugin.send(JSON.stringify(env));
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    waitForPlugin(timeoutMs = 0) {
      if (plugin && plugin.readyState === WebSocket.OPEN) return Promise.resolve();
      return new Promise((res, rej) => {
        // Self-removing: a waiter that resolved used to stay in the set until its
        // own timer fired (or forever, with no timeout), and was then re-invoked
        // on every later pairing.
        const waiter = () => {
          if (timer) clearTimeout(timer);
          pairWaiters.delete(waiter);
          res();
        };
        const timer = timeoutMs
          ? setTimeout(() => {
              pairWaiters.delete(waiter);
              rej(new BridgeOffline());
            }, timeoutMs)
          : null;
        pairWaiters.add(waiter);
      });
    },
    close() {
      for (const w of servers) w.close();
    },
  };
}

function readPort(wss: WebSocketServer, fallback: number): number {
  const a = wss.address();
  return a && typeof a === "object" ? a.port : fallback;
}

function readHost(wss: WebSocketServer): string | null {
  const a = wss.address();
  return a && typeof a === "object" ? a.address : null;
}