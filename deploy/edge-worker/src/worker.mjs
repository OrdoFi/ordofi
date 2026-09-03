/**
 * rpc.ordofi.network at the edge.
 *
 * Runs in every Cloudflare city in front of the gateway. Wallets spend most of
 * their calls on things that never change or change once a block — chain id,
 * block number, the head block, gas, fee history, mined receipts — and the
 * gateway already answers those from memory. This runs that memory 10–30 ms
 * from the user instead of a continent away. Everything else, and every send,
 * goes to the origin in the request the client made, headers included, and
 * the origin's answer comes back untouched: keys, limits, protection, the
 * auction and the ledger of what was routed all stay in one place.
 *
 * deploy: npx wrangler deploy  (from this directory; see wrangler.toml)
 */
import { IDEMPOTENT_READS, MicroCache, cacheKey, cacheTtlMs, splitBatch } from "./policy.mjs";

const cache = new MicroCache();

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-api-key, authorization",
  "access-control-allow-methods": "POST, GET, OPTIONS",
};

function json(body, edge, extra = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "x-ordo-edge": edge, ...CORS, ...extra },
  });
}

/**
 * The origin's response with a note of what the edge did. The runtime hands us
 * the body already decoded, so the origin's encoding headers no longer
 * describe it; the edge compresses again for the client on its own.
 */
function annotate(res, edge) {
  const out = new Response(res.body, res);
  out.headers.set("x-ordo-edge", edge);
  out.headers.delete("content-encoding");
  out.headers.delete("content-length");
  return out;
}

/** Forward some messages to the origin with the client's headers (key, address, agent) intact. */
async function forwardToOrigin(request, messages, single) {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  const body = JSON.stringify(single ? messages[0] : messages);
  return fetch(new Request(request.url, { method: "POST", headers, body }));
}

export default {
  async fetch(request, env) {
    // Only JSON-RPC over POST is the edge's business. The landing page,
    // /health, /metrics, CORS preflight and anything odd belong to the origin.
    if (request.method !== "POST") return annotate(await fetch(request), "pass");

    const chainId = Number(env.CHAIN_ID ?? 4663);
    const keyed = request.headers.has("x-api-key") || request.headers.has("authorization");
    if (!keyed && env.ALLOW_ANON === "0") return annotate(await fetch(request), "pass");

    const text = await request.clone().text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return annotate(await fetch(request), "pass");
    }
    const isBatch = Array.isArray(payload);
    const batch = isBatch ? payload : [payload];
    if (batch.length === 0) return annotate(await fetch(request), "pass");

    const { answered, forward, forwardIndex } = splitBatch(batch, chainId, (k) => cache.get(k));

    // Everything answered here: no origin round trip at all.
    if (forward.length === 0) return json(isBatch ? answered : answered[0], "hit");

    // Nothing answered here: the client's request goes through as it is.
    if (forward.length === batch.length) {
      const res = await forwardAndRemember(request, forward, !isBatch, request);
      return annotate(res, "pass");
    }

    // A mix: the misses go to the origin as a smaller batch, the answers merge
    // back into their original positions.
    const res = await forwardAndRemember(request, forward, false);
    let replies;
    try {
      replies = await res.clone().json();
    } catch {
      return annotate(res, "pass");
    }
    if (!Array.isArray(replies)) return annotate(res, "pass");
    replies.forEach((r, j) => (answered[forwardIndex[j]] = r));
    return json(answered, "mixed");
  },
};

/**
 * Send messages to the origin. A lone idempotent read is coalesced with any
 * identical read in flight and its answer is remembered for the method's
 * window; anything else is forwarded as-is and only its idempotent members are
 * remembered on the way back. A send is forwarded exactly once and never
 * remembered.
 */
async function forwardAndRemember(request, messages, single, original = null) {
  const lone = messages.length === 1 ? messages[0] : null;
  const loneParams = Array.isArray(lone?.params) ? lone.params : [];
  if (lone && IDEMPOTENT_READS.has(lone.method)) {
    const key = cacheKey(lone.method, loneParams);
    try {
      const result = await cache.through(
        key,
        async () => {
          const res = await forwardToOrigin(request, [lone], true);
          const body = await res.json();
          if (body && body.error) throw Object.assign(new Error("origin error"), { body, status: res.status });
          return body?.result;
        },
        (v) => cacheTtlMs(lone.method, loneParams, v),
      );
      return json(single ? { jsonrpc: "2.0", id: lone.id, result } : [{ jsonrpc: "2.0", id: lone.id, result }], "pass");
    } catch (e) {
      // The origin's own error, or an unreadable reply: hand the client what the origin said.
      if (e && e.body) return json(single ? { ...e.body, id: lone.id } : [{ ...e.body, id: lone.id }], "pass");
      return original ? fetch(original) : forwardToOrigin(request, [lone], single);
    }
  }
  // The whole request when it is the whole request: byte for byte what the client sent.
  const res = original ? await fetch(original) : await forwardToOrigin(request, messages, single);
  // Remember what can be remembered, without touching the response.
  try {
    const body = await res.clone().json();
    const replies = Array.isArray(body) ? body : [body];
    replies.forEach((r, i) => {
      const m = messages[i];
      if (!m || !IDEMPOTENT_READS.has(m.method) || !r || r.error) return;
      const params = Array.isArray(m.params) ? m.params : [];
      cache.set(cacheKey(m.method, params), r.result, cacheTtlMs(m.method, params, r.result));
    });
  } catch {
    // not JSON; nothing to remember
  }
  return res;
}
