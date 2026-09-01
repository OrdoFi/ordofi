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
  /** Methods anonymous callers may use when allowAnon is on. */
  anonMethods: new Set([
    "eth_chainId",
    "eth_blockNumber",
    "eth_gasPrice",
    "eth_getBalance",
    "eth_call",
    "eth_getBlockByNumber",
    "eth_getTransactionReceipt",
    "eth_getTransactionByHash",
    "net_version",
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
