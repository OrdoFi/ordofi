import { RpcError } from "./errors.js";
import type { ApiKey } from "./config.js";
import type { Upstream } from "./protect.js";
import { protectAndSend } from "./protect.js";

/**
 * Order-flow routing.
 *
 * Without this, pointing a wallet at the gateway bought revert protection and
 * nothing else — the transaction went straight to the sequencer, no auction ran,
 * and no rebate was ever owed. Apps had to call the auction's /submit on a
 * separate endpoint to earn anything, which is a trap nobody discovers until
 * they ask where their money is.
 *
 * Now a key configured for order flow gets both from one endpoint: the
 * transaction is auctioned for its backrun rights and dispatched, and the
 * rebate is attributed to that key's address.
 *
 * The auction is never allowed to become a single point of failure for a user's
 * transaction. If it is unreachable, slow, or fails to dispatch, the send falls
 * back to the protected direct path — a missed rebate is an acceptable loss, a
 * dropped transaction is not.
 */

const AUCTION_URL = process.env.ORDO_AUCTION_URL ?? "http://localhost:8548";
const TIMEOUT_MS = Number(process.env.ORDO_AUCTION_TIMEOUT_MS ?? 3000);

export interface RouteOutcome {
  txHash: string;
  /** True when the auction handled it; false when we fell back to direct send. */
  auctioned: boolean;
  reason?: string;
}

export function auctionConfigured(): boolean {
  return Boolean(AUCTION_URL);
}

/**
 * Submit through the auction, falling back to a protected direct send.
 * Always resolves to a transaction hash or throws — callers get standard
 * `eth_sendRawTransaction` semantics either way.
 */
export async function routeOrderFlow(
  upstream: Upstream,
  rawTx: string,
  apiKey: ApiKey,
): Promise<RouteOutcome> {
  try {
    const res = await fetch(`${AUCTION_URL.replace(/\/$/, "")}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rawTx,
        originLabel: apiKey.label,
        ...(apiKey.rebateAddress ? { rebateAddress: apiKey.rebateAddress } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) throw new Error(`auction HTTP ${res.status}`);
    const body = (await res.json()) as any;

    const txHash: string | undefined = body?.result?.userTxHash;
    if (!txHash) {
      // The auction ran but couldn't broadcast; surface its reason rather than
      // silently double-sending a transaction that may already be in flight.
      throw new RpcError(-32000, `ordo: ${body?.userError ?? "auction did not dispatch the transaction"}`);
    }
    return { txHash, auctioned: true };
  } catch (err) {
    if (err instanceof RpcError) throw err;
    const reason = (err as Error).message;
    const txHash = await protectAndSend(upstream, rawTx);
    return { txHash, auctioned: false, reason };
  }
}
