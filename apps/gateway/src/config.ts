import { randomBytes } from "node:crypto";

export interface ApiKey {
  key: string;
  label: string;
  /** Requests per minute. 0 = unlimited. */
  rateLimit: number;
  /** Optional rebate destination for order-flow revenue sharing. */
  rebateAddress?: string;
  /**
   * How `eth_sendRawTransaction` is handled for this key.
   * - `auction` — routed through the order-flow auction, so the key earns rebates.
   * - `direct`  — revert-protected, sent straight to the sequencer, no rebate.
   * Defaults to `auction` when a rebate address is configured.
   */
  mode: "auction" | "direct";
}

/**
 * API keys are loaded from ORDO_API_KEYS as a comma-separated list of
 * `key:label:rateLimit:rebateAddress:mode` records. The last two are optional;
 * a key with a rebate address defaults to `auction` mode, otherwise `direct`.
 *
 * In development, if none are provided, a single ephemeral key is minted and
 * logged so the gateway is usable out of the box. A public, unauthenticated
 * tier is allowed for read-only methods when ORDO_ALLOW_ANON=1.
 */
export function loadApiKeys(): Map<string, ApiKey> {
  const raw = process.env.ORDO_API_KEYS?.trim();
  const keys = new Map<string, ApiKey>();

  if (raw) {
    for (const record of raw.split(",")) {
      const [key, label = "unnamed", rate = "600", rebateAddress, mode] = record.split(":");
      if (!key) continue;
      const rebate = rebateAddress || undefined;
      keys.set(key, {
        key,
        label,
        rateLimit: Number(rate) || 0,
        rebateAddress: rebate,
        mode: mode === "auction" || mode === "direct" ? mode : rebate ? "auction" : "direct",
      });
    }
  }

  if (keys.size === 0) {
    const dev = "ordo_dev_" + randomBytes(12).toString("hex");
    keys.set(dev, { key: dev, label: "dev-ephemeral", rateLimit: 600, mode: "direct" });
    console.log(`gateway | no ORDO_API_KEYS set — minted ephemeral dev key:\n  ${dev}`);
  }

  return keys;
}

export const CONFIG = {
  port: Number(process.env.ORDO_PORT ?? 8547),
  allowAnon: process.env.ORDO_ALLOW_ANON === "1",
  /**
   * Upstream-bound requests per minute an anonymous IP may make. Requests the
   * gateway answers itself (chain id, cached head, mined receipts) cost nothing
   * and are not counted, so this bounds real upstream load, not wallet
   * chattiness. Sized for a dapp's users behind one office or carrier NAT
   * rather than a single wallet — a 429 to a legitimate user reads as "the RPC
   * is slow", and that costs more than the upstream calls it saves.
   */
  anonRateLimit: Number(process.env.ORDO_ANON_RATE_LIMIT ?? 3_000),
  /**
   * Sends per minute an anonymous IP may make. Each one costs a simulation
   * and a sequencer submission, and nobody legitimately signs more than one
   * transaction a second from one address for a minute straight.
   */
  anonSendRateLimit: Number(process.env.ORDO_ANON_SEND_RATE_LIMIT ?? 60),
  /**
   * Upstream requests one anonymous IP may have in flight at once (see
   * InflightCap). A wallet holds one or two; a hard-polling dapp perhaps ten.
   * A backfill script holding fifty is what this stops. 0 disables.
   */
  anonMaxInflight: Number(process.env.ORDO_ANON_MAX_INFLIGHT ?? 16),
  /**
   * Whether an anonymous send is routed through the auction.
   *
   * A wallet cannot attach an API key, so every person who added this endpoint
   * in MetaMask arrives anonymous — and until this existed their transactions
   * were sent direct, creating no opportunity, capturing nothing and paying
   * them nothing. They do not need a key to be paid: the auction recovers the
   * signer from the transaction and credits the user's 90% to that address.
   * The app's 5% still requires a key, because an app has to be named to be
   * paid. Set to 0 to return to direct sends for anonymous callers.
   */
  anonAuction: process.env.ORDO_ANON_AUCTION !== "0",
  /**
   * Hedges as a share of hedgeable reads over a rolling 10 s window (see
   * HedgeBudget). Above this the primary is on its own, because a primary that
   * is slow for everyone is saturated, not unlucky.
   */
  hedgeBudgetRatio: Number(process.env.ORDO_HEDGE_BUDGET ?? 0.1),
  /**
   * How long an idempotent read may wait on the primary upstream before the
   * same request is hedged to the next one. The median upstream answer is
   * ~80 ms; this only ever fires on the slow tail.
   */
  hedgeAfterMs: Number(process.env.ORDO_HEDGE_AFTER_MS ?? 150),
  chainId: Number(process.env.ORDO_CHAIN_ID ?? 4663),
  /**
   * Set on an edge deployment (a gateway placed near users, away from the
   * database): the URL of the origin gateway. The edge answers what it can
   * from memory and forwards everything else there verbatim, so keys, limits,
   * protection, the auction and the routed ledger all stay in one place.
   * Must reach the origin directly, not through the CDN, or the origin sees
   * the CDN's address as the client. Empty = this is the origin.
   */
  edgeOrigin: process.env.ORDO_EDGE_ORIGIN?.trim() || "",
  /**
   * Methods anonymous callers may use when allowAnon is on: everything a
   * wallet needs to function once the endpoint is added as its network RPC,
   * including a revert-protected send. Wallets cannot attach an API key
   * header, so without this the endpoint would be read-only for exactly the
   * users it exists for. Auction routing, bundles and the bundler stay keyed.
   * The list is every standard read of the eth_ and net_ namespaces that an
   * Arbitrum node answers (the uncle and proof methods included, so a library
   * that probes them gets the node's answer and not ours); what it leaves out
   * is debug_/trace_, filters and subscriptions, and eth_simulateV1, which are
   * expensive on the upstream and belong to keyed callers.
   */
  anonMethods: new Set([
    "eth_chainId",
    "net_version",
    "web3_clientVersion",
    "eth_blockNumber",
    "eth_syncing",
    "eth_gasPrice",
    "eth_maxPriorityFeePerGas",
    "eth_feeHistory",
    "eth_getBalance",
    "eth_getCode",
    "eth_getStorageAt",
    "eth_getTransactionCount",
    "eth_call",
    "eth_estimateGas",
    "eth_getLogs",
    "eth_getBlockByNumber",
    "eth_getBlockByHash",
    "eth_getBlockReceipts",
    "eth_getTransactionReceipt",
    "eth_getTransactionByHash",
    "eth_getTransactionByBlockNumberAndIndex",
    "eth_getTransactionByBlockHashAndIndex",
    "eth_getBlockTransactionCountByNumber",
    "eth_getBlockTransactionCountByHash",
    "eth_getUncleCountByBlockNumber",
    "eth_getUncleCountByBlockHash",
    "eth_getProof",
    "eth_createAccessList",
    "eth_accounts",
    "eth_protocolVersion",
    "net_listening",
    "eth_sendRawTransaction",
    "ordo_simulate",
  ]),
};

/** Simple fixed-window per-key rate limiter. */
export class RateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();

  check(key: string, limit: number): { ok: boolean; retryAfterMs: number } {
    if (limit <= 0) return { ok: true, retryAfterMs: 0 };
    const now = Date.now();
    const w = this.windows.get(key);
    if (!w || now >= w.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + 60_000 });
      return { ok: true, retryAfterMs: 0 };
    }
    if (w.count >= limit) return { ok: false, retryAfterMs: w.resetAt - now };
    w.count++;
    return { ok: true, retryAfterMs: 0 };
  }
}
