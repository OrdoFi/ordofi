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
const BATCH = 120;
export async function batchCall(items) {
  if (items.length <= BATCH) return batchOnce(items);
  const out = [];
  for (let i = 0; i < items.length; i += BATCH) {
    if (i) await new Promise((r) => setTimeout(r, 350));
    out.push(...(await batchOnce(items.slice(i, i + BATCH))));
  }
  return out;
}
async function batchOnce(items) {
  if (!items.length) return [];
  const url = rpcUrls()[0];
  const body = items.map((it, i) => ({ jsonrpc: "2.0", id: i + 1, method: "eth_call", params: [{ to: it.to, data: encodeFunctionData({ abi: it.abi, functionName: it.fn, args: it.args ?? [] }) }, "latest"] }));
  try {
    const r = await fetch(url, { method: "POST", headers: RPC_HEADERS, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    const arr = await r.json();
    if (!Array.isArray(arr)) throw new Error("no batch");
    const byId = new Map(arr.map((x) => [x.id, x]));
    const out = items.map((it, i) => {
      const res = byId.get(i + 1);
      if (!res || res.error) return undefined;
      try { return decodeFunctionResult({ abi: it.abi, functionName: it.fn, data: res.result }); } catch { return null; }
    });
    // An item the upstream refused (throttled mid-batch, mostly) is asked again on
    // its own through the rotating fetcher, so a busy second cannot make a deep pool
    // read as empty. Only a genuine revert — or every upstream failing — stays null.
    for (let i = 0; i < out.length; i++) {
      if (out[i] !== undefined) continue;
      out[i] = await call(items[i].to, items[i].abi, items[i].fn, items[i].args ?? []).catch(() => null);
    }
    return out;
  } catch {
    const out = [];
    for (const it of items) out.push(await call(it.to, it.abi, it.fn, it.args ?? []).catch(() => null));
    return out;
  }
}
