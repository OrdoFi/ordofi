/**
 * What the edge may answer on its own, and for how long. This is the gateway's
 * fast path (apps/gateway/src/fastpath.ts) restated for the Worker: the two
 * must agree, because a wallet cannot tell which of them answered.
 *
 * Only plain reads are ever considered. A send or an ordo_* method is passed
 * to the origin untouched, always, in the exact request the client made.
 */

/** Millisecond block time on Robinhood Chain; a cache this short is exact enough for any wallet. */
export const BLOCK_MS = 100;

const HEAD_TAGS = new Set(["latest", "pending", "safe", "finalized"]);

/** Reads that may be issued twice without changing anything, and so may be coalesced and cached. */
export const IDEMPOTENT_READS = new Set([
  "eth_blockNumber",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
]);

/** Constants of the deployment. */
export function staticAnswer(method, chainId) {
  switch (method) {
    case "eth_chainId":
      return "0x" + chainId.toString(16);
    case "net_version":
      return String(chainId);
    default:
      return undefined;
  }
}

/**
 * How long a result may be reused, in ms; 0 means do not cache. Mirrors the
 * gateway, with one extra guard: a transaction that has been seen but not yet
 * mined (no block number) is not a fact yet and is not kept.
 */
export function cacheTtlMs(method, params, result) {
  switch (method) {
    case "eth_blockNumber":
      return BLOCK_MS;
    case "eth_gasPrice":
    case "eth_maxPriorityFeePerGas":
    case "eth_feeHistory":
      return 1_000;
    case "eth_getBlockByNumber": {
      const tag = String(params[0] ?? "latest").toLowerCase();
      return HEAD_TAGS.has(tag) ? BLOCK_MS : result == null ? 0 : 60_000;
    }
    case "eth_getBlockByHash":
      return result == null ? 0 : 60_000;
    case "eth_getTransactionReceipt":
      return result == null ? 0 : 10 * 60_000;
    case "eth_getTransactionByHash":
      return result == null || result.blockNumber == null ? 0 : 10 * 60_000;
    default:
      return 0;
  }
}

/**
 * Whether an answer to this request may come from the edge at all. Sends and
 * ordo_* methods never do; nor does anything when the request carries a key
 * and the operator wants keyed traffic to always reach the origin (keys have
 * their own limits and their own accounting there).
 */
export function isPlainRead(method) {
  return typeof method === "string" && method !== "eth_sendRawTransaction" && !method.startsWith("ordo_");
}

export function cacheKey(method, params) {
  return method + ":" + JSON.stringify(params ?? []);
}

/**
 * Bounded TTL cache with in-flight coalescing, per isolate. Insertion order is
 * the eviction order; entries mostly expire on their own.
 */
export class MicroCache {
  constructor(maxEntries = 5_000, now = Date.now) {
    this.entries = new Map();
    this.inflight = new Map();
    this.maxEntries = maxEntries;
    this.now = now;
  }

  get(key) {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key, value, ttlMs) {
    if (ttlMs <= 0) return;
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  /** Run `load` once for concurrent callers of the same key; a rejection is shared and cached by nobody. */
  async through(key, load, ttl) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = (async () => {
      try {
        const v = await load();
        this.set(key, v, ttl(v));
        return v;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  get size() {
    return this.entries.size;
  }
}

/**
 * Split a batch into what the edge answers now and what must go to the origin.
 * Returns the answered results by position (undefined where the origin is
 * needed) and the list of messages to forward, in their original order.
 */
export function splitBatch(batch, chainId, lookup) {
  const answered = new Array(batch.length);
  const forward = [];
  const forwardIndex = [];
  batch.forEach((msg, i) => {
    const method = msg?.method;
    const params = Array.isArray(msg?.params) ? msg.params : [];
    if (isPlainRead(method)) {
      const fixed = staticAnswer(method, chainId);
      if (fixed !== undefined) {
        answered[i] = { jsonrpc: "2.0", id: msg.id, result: fixed };
        return;
      }
      if (IDEMPOTENT_READS.has(method)) {
        const hit = lookup(cacheKey(method, params));
        if (hit !== undefined) {
          answered[i] = { jsonrpc: "2.0", id: msg.id, result: hit };
          return;
        }
      }
    }
    forward.push(msg);
    forwardIndex.push(i);
  });
  return { answered, forward, forwardIndex };
}
