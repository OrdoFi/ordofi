/**
 * Sequencer feed relay.
 *
 * Robinhood Chain's sequencer publishes every message it accepts on a public
 * WebSocket. It is worth being exact about what that buys, because it is less
 * than it looks and this file used to claim more.
 *
 * Measured 2026-09-05: the feed is not ahead of the RPC. Its sequence number
 * is the L2 block number, and by the time a frame reaches us that block is
 * already queryable — ten out of ten sampled transactions were present in a
 * block on the first eth_getTransactionByHash issued after the feed announced
 * them. There is no pre-confirmation view here to trade on, because this chain
 * has no mempool to have one.
 *
 * Two things will mislead anyone who measures this. A fresh connection replays
 * a backlog, about a minute behind and catching up at roughly ten times real
 * time, so every transaction looks "already mined" for the first few seconds
 * for the wrong reason; wait for the sequence number to reach the head first.
 * And comparing feed arrival against an RPC round trip measures the round
 * trip, which is why the apparent "lead" is always about one RTT.
 *
 * What the feed does give is push instead of poll: a block's transactions
 * arrive without waiting for the next poll to come round, which is worth up to
 * one block interval and no more.
 *
 * The relay maintains one upstream connection, decodes each Nitro broadcast
 * message down to its raw signed transactions, and fans them out to every
 * connected searcher with the relay's receive timestamp attached. Decoding
 * happens once here rather than in every searcher, and the timestamp lets a
 * searcher measure their own edge honestly.
 *
 * Nitro framing, from nitro's arbos/parse.go: a broadcast message carries an
 * L1 header whose kind 3 means "L2 message". The l2Msg payload's first byte is
 * its own kind — 4 is one signed transaction, 3 is a batch of length-prefixed
 * sub-messages, each of which starts with another kind byte.
 */
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { keccak256, type Hex } from "viem";
import { ENDPOINTS } from "@ordofi/core";

const FEED_URL = process.env.ORDO_FEED_URL ?? ENDPOINTS.sequencerFeed ?? "";
const L1_KIND_L2_MESSAGE = 3;
const L2_KIND_BATCH = 3;
const L2_KIND_SIGNED_TX = 4;

export interface RelayedTx {
  hash: Hex;
  /** Raw signed transaction, ready to simulate against. */
  raw: Hex;
}

export interface FeedStats {
  upstream: "connected" | "connecting" | "disconnected" | "unconfigured";
  clients: number;
  sequencerMessages: number;
  txsRelayed: number;
  lastSequenceNumber: number | null;
  reconnects: number;
}

const stats: FeedStats = {
  upstream: "unconfigured",
  clients: 0,
  sequencerMessages: 0,
  txsRelayed: 0,
  lastSequenceNumber: null,
  reconnects: 0,
};

export function feedStats(): FeedStats {
  return { ...stats };
}

/** Splits a Nitro l2Msg into raw signed transactions. Unknown kinds are skipped. */
export function decodeL2Msg(l2Msg: Uint8Array): Uint8Array[] {
  if (l2Msg.length < 2) return [];
  const kind = l2Msg[0];
  const body = l2Msg.subarray(1);

  if (kind === L2_KIND_SIGNED_TX) return [body];

  if (kind === L2_KIND_BATCH) {
    // Sub-messages are length-prefixed with a big-endian uint64 — verified
    // against the live feed, where a batch reads
    //   03 | 00000000000000b4 | 04 | 02f8b0…
    // i.e. kind, 8-byte length 180, then a SignedTx sub-message.
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const txs: Uint8Array[] = [];
    let off = 0;
    while (off + 8 <= body.length) {
      const len = Number(view.getBigUint64(off));
      off += 8;
      if (len <= 0 || off + len > body.length) break;
      const sub = body.subarray(off, off + len);
      off += len;
      if (sub.length > 1 && sub[0] === L2_KIND_SIGNED_TX) txs.push(sub.subarray(1));
    }
    return txs;
  }

  return [];
}

const toHex = (b: Uint8Array): Hex =>
  ("0x" + Buffer.from(b).toString("hex")) as Hex;

/**
 * Returns a detached WebSocketServer. Attaching it to the HTTP server is the
 * caller's job via a single shared upgrade router: two instances bound with
 * ({ server, path }) each see every upgrade, and the one that does not own
 * the path writes an HTTP 400 into a socket the other already upgraded —
 * which a client reports as the memorably useless "RSV1 must be clear".
 */
export function createFeedRelay(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    stats.clients = wss.clients.size;
    ws.send(
      JSON.stringify({
        type: "welcome",
        feed: FEED_URL || null,
        note: "raw signed transactions from the sequencer feed, decoded once, timestamped on receipt",
      }),
    );
    ws.on("close", () => (stats.clients = wss.clients.size));
    ws.on("error", () => (stats.clients = wss.clients.size));
  });

  if (!FEED_URL) {
    console.log("OrdoFi auction | feed relay=off (no ORDO_FEED_URL)");
    return wss;
  }

  const fanout = (payload: string) => {
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  };

  let backoffMs = 1000;

  const connect = () => {
    stats.upstream = "connecting";
    const upstream = new WebSocket(FEED_URL);

    upstream.on("open", () => {
      stats.upstream = "connected";
      backoffMs = 1000;
      console.log(`[feed] connected to ${FEED_URL}`);
    });

    upstream.on("message", (raw: RawData) => {
      const receivedAt = Date.now();
      let parsed: any;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const messages = parsed?.messages;
      if (!Array.isArray(messages)) return;

      for (const m of messages) {
        const seq = m?.sequenceNumber ?? null;
        const inner = m?.message?.message;
        if (!inner || inner.header?.kind !== L1_KIND_L2_MESSAGE || !inner.l2Msg) continue;

        stats.sequencerMessages++;
        if (typeof seq === "number") stats.lastSequenceNumber = seq;

        let txs: RelayedTx[];
        try {
          txs = decodeL2Msg(Buffer.from(inner.l2Msg, "base64")).map((t) => ({
            hash: keccak256(toHex(t)),
            raw: toHex(t),
          }));
        } catch {
          continue;
        }
        if (txs.length === 0) continue;

        stats.txsRelayed += txs.length;
        fanout(
          JSON.stringify({
            type: "feed_txs",
            sequenceNumber: seq,
            blockNumber: inner.header?.blockNumber ?? null,
            timestamp: inner.header?.timestamp ?? null,
            receivedAt,
            txs,
          }),
        );
      }
    });

    const scheduleReconnect = () => {
      if (stats.upstream === "disconnected") return; // already queued by the other handler
      stats.upstream = "disconnected";
      stats.reconnects++;
      setTimeout(connect, backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30_000);
    };

    upstream.on("close", scheduleReconnect);
    upstream.on("error", (e) => {
      console.error(`[feed] upstream error: ${e.message}`);
      scheduleReconnect();
    });
  };

  connect();
  console.log(`OrdoFi auction | feed relay=on · WS /feed <- ${FEED_URL}`);
  return wss;
}
