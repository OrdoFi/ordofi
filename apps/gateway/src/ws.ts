/**
 * The WebSocket side of the gateway.
 *
 * Two things arrive on this socket and both have to work. A client may open it
 * purely to subscribe, and a client may open it and then send every call it
 * has down the same pipe — ethers' WebSocketProvider and viem's webSocket
 * transport both do the latter, and an endpoint that only understood
 * eth_subscribe would break them on the first eth_call. So everything that is
 * not a subscription goes through the same function the HTTP path uses: same
 * keys, same limits, same protection, same answers. This file is the socket
 * and the two methods that only exist on one.
 *
 * eth_subscribe and eth_unsubscribe never reach that function, and they are
 * open to anonymous callers even though filters are not. The reason is what
 * they cost: a subscription is an entry in a map, and the poller behind it
 * runs at the same rate whether one client is listening or a thousand. What
 * has to be bounded is the number of sockets and the number of subscriptions
 * on each, and that is what the caps below are.
 */

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { Hub, type HeadWatcher, type Kind, parseLogFilter } from "./subscribe.js";

export interface WsMetrics {
  inc(name: string, labels?: Record<string, string>): void;
}

export interface WsDeps {
  /** The per-message pipeline the HTTP path uses. */
  answer(msg: any, req: { headers: IncomingMessage["headers"]; socket?: { remoteAddress?: string } }): Promise<any>;
  clientIp(req: { headers: IncomingMessage["headers"]; socket?: { remoteAddress?: string } }): string;
  hub: Hub;
  watcher: HeadWatcher;
  metrics: WsMetrics;
  maxConnsPerIp: number;
  maxSubsPerConn: number;
  /** True once SIGTERM has been seen: refuse new sockets, close the open ones. */
  stopping(): boolean;
}

const KINDS = new Set<Kind>(["newHeads", "logs"]);
/** How often we prove a socket is still there. Nothing else keeps a dead one honest. */
const PING_MS = 30_000;

export interface WsHandle {
  /** Open sockets right now. */
  clients(): number;
  /** Tell every client we are going away, then let the http server close. */
  drain(): void;
}

export function attachWs(server: Server, deps: WsDeps): WsHandle {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  const perIp = new Map<string, number>();
  const alive = new WeakMap<WebSocket, boolean>();

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? "/").split(/[?#]/, 1)[0] || "/";
    // The JSON-RPC endpoint is the origin root over http, so it is the root
    // here too; /ws is accepted because people expect it to exist.
    if (path !== "/" && path !== "/ws") return void socket.destroy();
    if (deps.stopping()) return void reject(socket, 503, "gateway is draining");

    const ip = deps.clientIp(req);
    if ((perIp.get(ip) ?? 0) >= deps.maxConnsPerIp) {
      deps.metrics.inc("ws_rejected_total", { reason: "per_ip" });
      return void reject(socket, 429, `too many websocket connections from this address (${deps.maxConnsPerIp})`);
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const ip = deps.clientIp(req);
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    alive.set(ws, true);
    deps.metrics.inc("ws_connections_total");
    ws.on("pong", () => alive.set(ws, true));

    const sink = { send: (payload: string) => ws.send(payload) };

    ws.on("message", async (data) => {
      let payload: any;
      try {
        payload = JSON.parse(String(data));
      } catch {
        return ws.send(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
      }
      const batch = Array.isArray(payload) ? payload : [payload];
      const out = await Promise.all(batch.map((msg) => one(msg)));
      // A notification (no id) gets no reply, and a batch of only those gets
      // nothing at all rather than an empty array.
      const keep = out.filter((r) => r !== undefined);
      if (!keep.length) return;
      ws.send(JSON.stringify(Array.isArray(payload) ? keep : keep[0]));
    });

    ws.on("close", () => {
      const left = (perIp.get(ip) ?? 1) - 1;
      if (left > 0) perIp.set(ip, left);
      else perIp.delete(ip);
      deps.hub.drop(sink);
      settle();
    });
    ws.on("error", () => ws.close());

    async function one(msg: any): Promise<any> {
      const method = msg?.method ?? "";
      const id = msg?.id;
      const reply = (body: object) => (id === undefined ? undefined : { jsonrpc: "2.0", id, ...body });

      if (method === "eth_subscribe") {
        const params: unknown[] = Array.isArray(msg.params) ? msg.params : [];
        const kind = String(params[0] ?? "");
        const known = KINDS.has(kind as Kind);
        deps.metrics.inc("ws_subscribe_total", { kind: known ? kind : "unsupported" });
        if (!known) {
          // newPendingTransactions is the one people ask for next. This chain
          // has no public mempool — transactions are ordered first-come by the
          // sequencer and there is nothing pending to watch — so saying no is
          // the honest answer rather than a subscription that never fires.
          return reply({
            error: {
              code: -32601,
              message: `eth_subscribe("${kind}") is not supported; this endpoint offers newHeads and logs${
                kind === "newPendingTransactions" ? " (this chain has no public mempool to watch)" : ""
              }`,
            },
          });
        }
        if (deps.hub.countOf(sink) >= deps.maxSubsPerConn) {
          return reply({
            error: { code: -32005, message: `too many subscriptions on one connection (${deps.maxSubsPerConn})` },
          });
        }
        const sub = deps.hub.add(sink, kind as Kind, kind === "logs" ? parseLogFilter(params[1]) : null);
        settle();
        return reply({ result: sub });
      }

      if (method === "eth_unsubscribe") {
        const params: unknown[] = Array.isArray(msg.params) ? msg.params : [];
        const ok = deps.hub.remove(sink, String(params[0] ?? ""));
        settle();
        return reply({ result: ok });
      }

      const answered = await deps.answer(msg, req);
      return id === undefined ? undefined : answered;
    }
  });

  /**
   * The poller exists for the subscribers, so it starts with the first one and
   * stops with the last. Nobody listening costs nothing.
   */
  function settle(): void {
    const wanted = deps.hub.wantsHeads || deps.hub.wantsLogs;
    if (wanted && !deps.watcher.running) deps.watcher.start();
    else if (!wanted && deps.watcher.running) deps.watcher.stop();
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, PING_MS);
  heartbeat.unref();

  return {
    clients: () => wss.clients.size,
    drain() {
      clearInterval(heartbeat);
      deps.watcher.stop();
      // 1001 "going away" is the code a client should reconnect on, which is
      // what every library does with it. Saying nothing and dropping the
      // socket looks like a network fault and gets backed off instead.
      for (const ws of wss.clients) {
        try {
          ws.close(1001, "gateway restarting");
        } catch {
          ws.terminate();
        }
      }
    },
  };
}

function reject(socket: Duplex, code: number, message: string): void {
  const text = `HTTP/1.1 ${code} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`;
  try {
    socket.write(text);
  } catch {
    /* the peer is already gone */
  }
  socket.destroy();
}
