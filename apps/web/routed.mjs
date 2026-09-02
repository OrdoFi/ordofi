import { rpcFetch } from "@ordofi/core";
import { ethUsd, getTokenInfo, toWhole } from "@ordofi/core/pricing";
import { tradeTokens } from "./trade.mjs";

/**
 * Turns "a hash went through rpc.ordofi.network" into a number on the front
 * page.
 *
 * The gateway records the hash the instant it forwards. This job fetches the
 * receipt and prices what the *sender* moved: native ETH attached to the call
 * plus every ERC-20 the sender transferred out. That is the notional value of
 * the transaction from the user's side — a swap counts once at what they paid,
 * an approval counts as zero, a reverted transaction counts as zero. Nothing
 * inflates it: no double counting of both legs of a swap, no crediting
 * transfers the sender merely received.
 */

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const PENDING_GRACE_MS = 15 * 60_000;

/** USD per whole token: the quote-asset pricer first, then the terminal's token list. */
async function priceOf(store, token) {
  try {
    const info = await getTokenInfo(token);
    if (info?.usdPerToken) return { usd: info.usdPerToken, decimals: info.decimals };
  } catch { /* fall through */ }
  try {
    const t = (await tradeTokens(store)).find((x) => x.address === token);
    if (t?.usdPerToken) return { usd: t.usdPerToken, decimals: t.decimals };
  } catch { /* unpriced */ }
  return null;
}

async function valueMoved(store, receipt, sender, valueWei) {
  const usdEth = await ethUsd().catch(() => null);
  let usd = 0;
  if (valueWei > 0n && usdEth) usd += toWhole(valueWei, 18) * usdEth;
  if (!sender) return usd;
  const from = sender.toLowerCase().slice(2).padStart(64, "0");
  const out = new Map();
  for (const log of receipt.logs ?? []) {
    if (log.topics?.[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics.length < 3) continue;
    if (log.topics[1].slice(2).toLowerCase() !== from) continue;
    const token = log.address.toLowerCase();
    out.set(token, (out.get(token) ?? 0n) + BigInt(log.data === "0x" ? 0 : log.data));
  }
  for (const [token, amount] of out) {
    if (token === WETH && usdEth) { usd += toWhole(amount, 18) * usdEth; continue; }
    const p = await priceOf(store, token);
    if (p) usd += toWhole(amount, p.decimals) * p.usd; // unpriced tokens add nothing rather than a guess
  }
  return usd;
}

let busy = false;

/** Resolve a batch of pending rows. Cheap to call often; a no-op when idle. */
export async function resolveRouted(store) {
  if (!store || busy) return;
  busy = true;
  try {
    const rows = store.unresolvedRouted(40);
    for (const row of rows) {
      let receipt = null;
      try {
        receipt = await rpcFetch("eth_getTransactionReceipt", [row.txHash]);
      } catch { continue; }
      if (!receipt) {
        // A hash that never lands within the grace period was dropped or
        // replaced. It stays counted as submitted, never as volume.
        if (Date.now() - row.submittedAt > PENDING_GRACE_MS) store.resolveRouted(row.txHash, { status: -1 });
        continue;
      }
      const ok = receipt.status === "0x1";
      const volumeUsd = ok ? await valueMoved(store, receipt, row.sender, BigInt(row.valueWei ?? "0")) : 0;
      store.resolveRouted(row.txHash, { status: ok ? 1 : 0, block: parseInt(receipt.blockNumber, 16), volumeUsd });
    }
  } finally {
    busy = false;
  }
}

export function routedSummary(store) {
  if (!store) return { available: false };
  const t = store.routedTotals();
  return {
    available: true,
    endpoint: "https://rpc.ordofi.network",
    since: t.firstAt ? new Date(t.firstAt).toISOString() : null,
    transactions: { submitted: t.submitted, confirmed: t.confirmed, reverted: t.reverted, pending: t.pending, confirmed24h: t.confirmed24h },
    volumeUsd: Math.round(t.volumeUsd * 100) / 100,
    volume24hUsd: Math.round(t.volume24hUsd * 100) / 100,
    recent: store.recentRouted(20),
    note: "Volume is the USD value the sender moved in each confirmed transaction: ETH attached plus tokens transferred out. Reverted and dropped transactions count as zero.",
  };
}
