/**
 * Edge mode: a gateway placed near users, away from the database.
 *
 * Wallets spend most of their calls on things that never change or change
 * once a block, and those are answered from memory wherever the process runs;
 * the point of an edge is to run that memory 15 ms from the user instead of
 * 150. Everything else — keys, rate limits, protected sends, the auction, the
 * ledger of what was routed — depends on state that lives with the origin
 * gateway, so the edge forwards those requests to it verbatim and hands the
 * answer back untouched. One code path, one place where the important things
 * happen; the edge is a cache with an address.
 */

export const ORIGIN_TIMEOUT_MS = 30_000;

/** Headers an edge passes on so the origin sees the request as the client made it. */
const FORWARDED = ["x-api-key", "authorization", "cf-connecting-ip", "user-agent"] as const;

export type Headers = Record<string, string | string[] | undefined>;

/**
 * The headers for a forwarded request. The client's address travels as
 * cf-connecting-ip, which is what the origin keys anonymous limits on; if the
 * request did not carry one (the edge was reached directly, not through the
 * CDN), the address the edge established is used. The origin's proxy strips
 * this header from peers it does not know, so the edge's address must be on
 * its list — see deploy/Caddyfile.
 */
export function forwardHeaders(incoming: Headers, clientIp: string): Record<string, string> {
  const out: Record<string, string> = { "content-type": "application/json" };
  for (const name of FORWARDED) {
    const v = incoming[name];
    const s = Array.isArray(v) ? v[0] : v;
    if (s) out[name] = s;
  }
  if (!out["cf-connecting-ip"] && clientIp && clientIp !== "unknown") out["cf-connecting-ip"] = clientIp;
  return out;
}

export interface OriginReply {
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * One JSON-RPC call to the origin. The reply is returned as the origin made
 * it — its result or its error, code and data intact — so the wallet cannot
 * tell which gateway answered. A transport failure becomes a -32000 like any
 * other unreachable upstream; the edge never retries a forwarded request,
 * because it does not know whether it was a send.
 */
export async function callOrigin(
  origin: string,
  method: string,
  params: unknown[],
  id: unknown,
  headers: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<OriginReply> {
  let res: Response;
  try {
    res = await fetchImpl(origin, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(ORIGIN_TIMEOUT_MS),
    });
  } catch (e) {
    return { error: { code: -32000, message: `origin gateway unreachable — ${(e as Error).message}` } };
  }
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    return { error: { code: -32000, message: `origin gateway answered ${res.status} without JSON` } };
  }
  if (body && typeof body === "object" && "error" in body && body.error) {
    const e = body.error;
    return { error: { code: typeof e.code === "number" ? e.code : -32000, message: String(e.message ?? "error"), data: e.data } };
  }
  return { result: body?.result };
}
