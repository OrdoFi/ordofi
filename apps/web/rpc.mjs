import { decodeFunctionResult, encodeFunctionData } from "viem";
import { rpcFetch, rpcUrls, RPC_HEADERS } from "@ordofi/core";

/** One eth_call, decoded. `from` matters for calls whose answer depends on the caller (a ladder's collect preview). */
export async function call(to, abi, functionName, args = [], from) {
  const req = { to, data: encodeFunctionData({ abi, functionName, args }) };
  if (from) req.from = from;
  const data = await rpcFetch("eth_call", [req, "latest"]);
  return decodeFunctionResult({ abi, functionName, data });
}

/**
 * Many eth_calls in few HTTP round trips. The upstream counts each call in a
 * batch against its per-second limit, so a busy pool's thousand ticks go over
 * in chunks with a breath between them rather than as one wall.
 */
const BATCH = 120, LANES = 4;
export async function batchCall(items) {
  if (items.length <= BATCH) return batchOnce(items);
  // Chunks go a few at a time: a token with six hundred spam pools should not
  // cost six round trips in a row, and the upstreams in use take this rate.
  const chunks = [];
  for (let i = 0; i < items.length; i += BATCH) chunks.push(items.slice(i, i + BATCH));
  const out = new Array(chunks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(LANES, chunks.length) }, async () => {
    while (next < chunks.length) { const i = next++; out[i] = await batchOnce(chunks[i]); }
  }));
  return out.flat();
}
async function batchOnce(items) {
  if (!items.length) return [];
  const out = new Array(items.length).fill(undefined);
  const data = items.map((it) => encodeFunctionData({ abi: it.abi, functionName: it.fn, args: it.args ?? [] }));
  // A revert is an answer; anything else — throttling, a challenge page, a dead
  // host — is not, and the items still open go to the next upstream as a batch.
  const isRevert = (err) => /revert|execution|invalid opcode|out of gas/i.test(err?.message ?? "");
  let open = items.map((_, i) => i);
  for (const url of rpcUrls()) {
    if (!open.length) break;
    const body = open.map((i) => ({ jsonrpc: "2.0", id: i + 1, method: "eth_call", params: [{ to: items[i].to, data: data[i] }, "latest"] }));
    let arr;
    try {
      const r = await fetch(url, { method: "POST", headers: RPC_HEADERS, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
      arr = await r.json();
    } catch { continue; }
    if (!Array.isArray(arr)) continue;
    const byId = new Map(arr.map((x) => [x.id, x]));
    const still = [];
    for (const i of open) {
      const res = byId.get(i + 1);
      if (res?.result != null) { try { out[i] = decodeFunctionResult({ abi: items[i].abi, functionName: items[i].fn, data: res.result }); } catch { out[i] = null; } }
      else if (res?.error && isRevert(res.error)) out[i] = null;
      else still.push(i);
    }
    open = still;
  }
  // Whatever every upstream refused as part of a batch is asked once more on its
  // own, all at once, through the rotating fetcher; only then does it stay null.
  await Promise.all(open.map(async (i) => { out[i] = await call(items[i].to, items[i].abi, items[i].fn, items[i].args ?? []).catch(() => null); }));
  return out;
}
