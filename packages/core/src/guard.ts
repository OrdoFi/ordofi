/**
 * Proof of delivery for transactions the server builds and a user signs.
 *
 * On 2026-09-02 the trade API handed a wallet calldata that swapped 900 USDG
 * and then sent the resulting 0.376 ETH to address(1). The calldata was
 * well-formed, the transaction succeeded, and nobody had checked where the
 * money ended up. This module makes that check mandatory: before a quote's
 * `tx` leaves the server it is executed with eth_simulateV1 from the trader's
 * own address, and the quote only carries a `tx` if
 *
 *   1. the transaction succeeds,
 *   2. the trader's balance of every expected asset rises by at least the
 *      promised minimum,
 *   3. the trader pays no more than the quoted input, and
 *   4. nothing — ETH or tokens — lands on an address nobody controls.
 *
 * It is deliberately independent of how the calldata was encoded: it does not
 * decode anything, it measures balances. An encoder bug of any shape fails
 * here, on the server, instead of in someone's wallet.
 *
 * Fails closed. If no upstream can simulate, the answer is "not proven" and
 * the caller must not offer the transaction.
 */
import type { Hex } from "viem";
import { RPC_HEADERS, rpcUrls } from "./index.ts";

export type Asset = Hex | "eth";

export interface Expectation {
  asset: Asset;
  /** The holder must end up with at least this much more than before. */
  min: bigint;
}

export interface Payment {
  asset: Asset;
  /** The holder may end up with at most this much less than before. */
  max: bigint;
}

export interface DeliveryRequest {
  /** The account that will sign and send. */
  from: Hex;
  tx: { to: Hex; data: Hex; value?: bigint };
  /** Simulated first, in the same block, so a missing allowance is not a failure. */
  approval?: { token: Hex; spender: Hex; amount: bigint } | null;
  expect?: Expectation[];
  pay?: Payment[];
  /**
   * Contracts that must not keep any of these assets (e.g. the router, whose
   * unwrap is supposed to forward everything to the trader).
   */
  mustNotRetain?: { holder: Hex; asset: Asset }[];
}

export interface Leak {
  to: Hex;
  asset: Asset;
  amount: bigint;
}

export interface DeliveryProof {
  ok: boolean;
  /** Why it is not ok, in words a UI can show. Undefined when ok. */
  reason?: string;
  /** The simulation itself could not be run; nothing is known either way. */
  unavailable?: boolean;
  reverted?: string;
  received: { asset: Asset; amount: bigint; min: bigint }[];
  paid: { asset: Asset; amount: bigint; max: bigint }[];
  leaks: Leak[];
  retained: Leak[];
  gasUsed: bigint;
  /** Which upstream answered. */
  via?: string;
}

/** Nothing sent here can ever be spent again. */
export const BLACKHOLES: readonly Hex[] = [
  "0x0000000000000000000000000000000000000000",
  "0x0000000000000000000000000000000000000001",
  "0x0000000000000000000000000000000000000002",
  "0x0000000000000000000000000000000000000003",
  "0x0000000000000000000000000000000000000004",
  "0x0000000000000000000000000000000000000005",
  "0x0000000000000000000000000000000000000006",
  "0x0000000000000000000000000000000000000007",
  "0x0000000000000000000000000000000000000008",
  "0x0000000000000000000000000000000000000009",
  "0x000000000000000000000000000000000000000a",
  "0x000000000000000000000000000000000000dead",
];

/**
 * A contract that returns `address(calldata[4:36]).balance`, injected with a
 * state override so ETH balances can be read inside the simulated block.
 * Bytecode: PUSH1 4, CALLDATALOAD, BALANCE, PUSH1 0, MSTORE, PUSH1 32, PUSH1 0, RETURN.
 */
export const BALANCE_READER: Hex = "0x00000000000000000000000000000000000ba1a0";
const BALANCE_READER_CODE = "0x6004353160005260206000f3";
const BALANCE_OF_SELECTOR = "0x70a08231";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const APPROVE_SELECTOR = "0x095ea7b3";

/** Public endpoints known to serve eth_simulateV1, tried after the configured ones. */
const SIMULATE_FALLBACKS = ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood-rpc.publicnode.com"];

const pad = (v: string | bigint, size = 32): string => {
  const h = typeof v === "bigint" ? v.toString(16) : v.toLowerCase().replace(/^0x/, "");
  return h.padStart(size * 2, "0");
};
const isEth = (a: Asset): a is "eth" => a === "eth";
const sameAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

interface SimCall {
  from?: Hex;
  to: Hex;
  data?: Hex;
  value?: Hex;
}

function balanceRead(holder: Hex, asset: Asset): SimCall {
  return isEth(asset)
    ? { to: BALANCE_READER, data: ("0x00000000" + pad(holder)) as Hex }
    : { to: asset, data: (BALANCE_OF_SELECTOR + pad(holder)) as Hex };
}

function readWord(call: { returnData?: string } | undefined): bigint {
  const d = call?.returnData;
  if (!d || d === "0x") return 0n;
  return BigInt(d.slice(0, 66));
}

export function describeProof(p: DeliveryProof): string {
  if (p.ok) return "delivery proven";
  return p.reason ?? "not proven";
}

/**
 * Run the transaction from `from` at head and measure who ended up with what.
 * Never throws: an unavailable simulator is reported as `{ ok: false, unavailable: true }`.
 */
export async function proveDelivery(
  req: DeliveryRequest,
  opts: {
    urls?: string[];
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    /** Bring your own eth_simulateV1 (e.g. a gateway's upstream); replaces the URL loop. */
    simulate?: (params: unknown[]) => Promise<unknown>;
  } = {},
): Promise<DeliveryProof> {
  const empty = (reason: string, extra: Partial<DeliveryProof> = {}): DeliveryProof => ({
    ok: false,
    reason,
    received: [],
    paid: [],
    leaks: [],
    retained: [],
    gasUsed: 0n,
    ...extra,
  });

  // Every (holder, asset) pair we read before and after, deduplicated.
  const trackedKeys = new Map<string, { holder: Hex; asset: Asset }>();
  const track = (holder: Hex, asset: Asset) => {
    const key = `${holder.toLowerCase()}:${isEth(asset) ? "eth" : asset.toLowerCase()}`;
    if (!trackedKeys.has(key)) trackedKeys.set(key, { holder, asset });
    return key;
  };
  const expectKeys = (req.expect ?? []).map((e) => ({ ...e, key: track(req.from, e.asset) }));
  const payKeys = (req.pay ?? []).map((p) => ({ ...p, key: track(req.from, p.asset) }));
  const retainKeys = (req.mustNotRetain ?? []).map((r) => ({ ...r, key: track(r.holder, r.asset) }));
  const holeKeys = BLACKHOLES.map((h) => ({ to: h, key: track(h, "eth") }));
  const tracked = [...trackedKeys.entries()];

  const reads = tracked.map(([, t]) => balanceRead(t.holder, t.asset));
  const calls: SimCall[] = [...reads];
  if (req.approval) {
    calls.push({
      from: req.from,
      to: req.approval.token,
      data: (APPROVE_SELECTOR + pad(req.approval.spender) + pad(req.approval.amount)) as Hex,
    });
  }
  const txIndex = calls.length;
  calls.push({
    from: req.from,
    to: req.tx.to,
    data: req.tx.data,
    ...(req.tx.value && req.tx.value > 0n ? { value: ("0x" + req.tx.value.toString(16)) as Hex } : {}),
  });
  calls.push(...reads);

  const params = [
    {
      blockStateCalls: [
        {
          stateOverrides: {
            [BALANCE_READER]: { code: BALANCE_READER_CODE },
            // Gas is not charged with validation off, but `value` must still be
            // covered; the deltas below are relative, so the amount is irrelevant.
            [req.from]: { balance: "0x3635c9adc5dea00000" }, // 1000 ETH
          },
          calls,
        },
      ],
      validation: false,
    },
    "latest",
  ];

  const urls = opts.simulate ? [] : [...new Set([...(opts.urls ?? rpcUrls()), ...SIMULATE_FALLBACKS])];
  const fetchImpl = opts.fetchImpl ?? fetch;
  let result: any = null;
  let via: string | undefined;
  let lastErr = "no upstream";
  if (opts.simulate) {
    try {
      const block: any = ((await opts.simulate(params)) as any)?.[0];
      if (Array.isArray(block?.calls) && block.calls.length === calls.length) {
        result = block.calls;
        via = "upstream";
      } else lastErr = "malformed simulation result";
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }
  for (const url of urls) {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: RPC_HEADERS,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_simulateV1", params }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
      const body: any = await res.json().catch(() => null);
      if (!body || body.error) {
        lastErr = body?.error?.message ?? `HTTP ${res.status}`;
        continue; // unsupported method, auth wall, throttle: ask the next one
      }
      const block = body.result?.[0];
      if (!Array.isArray(block?.calls) || block.calls.length !== calls.length) {
        lastErr = "malformed simulation result";
        continue;
      }
      result = block.calls;
      via = new URL(url).host;
      break;
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }
  if (!result) {
    return empty(`cannot verify this transaction right now (${lastErr}); it was not built`, { unavailable: true });
  }

  const txOut = result[txIndex];
  const gasUsed = BigInt(txOut?.gasUsed ?? "0x0");
  if (txOut?.status !== "0x1") {
    const why = txOut?.error?.message ?? (txOut?.returnData && txOut.returnData !== "0x" ? txOut.returnData : "reverted");
    return empty(`the transaction would revert: ${why}`, { reverted: String(why), gasUsed, via });
  }
  if (req.approval) {
    const ap = result[txIndex - 1];
    if (ap?.status !== "0x1") return empty("the approval would revert", { gasUsed, via });
  }

  const before = new Map<string, bigint>();
  const after = new Map<string, bigint>();
  tracked.forEach(([key], i) => {
    before.set(key, readWord(result[i]));
    after.set(key, readWord(result[txIndex + 1 + i]));
  });
  const delta = (key: string) => (after.get(key) ?? 0n) - (before.get(key) ?? 0n);

  const received = expectKeys.map((e) => ({ asset: e.asset, amount: delta(e.key), min: e.min }));
  const paid = payKeys.map((p) => ({ asset: p.asset, amount: -delta(p.key), max: p.max }));
  const retained: Leak[] = retainKeys
    .map((r) => ({ to: r.holder, asset: r.asset, amount: delta(r.key) }))
    .filter((r) => r.amount > 0n);

  const leaks: Leak[] = holeKeys
    .map((h) => ({ to: h.to, asset: "eth" as Asset, amount: delta(h.key) }))
    .filter((l) => l.amount > 0n);
  for (const log of txOut.logs ?? []) {
    if ((log.topics?.[0] ?? "").toLowerCase() !== TRANSFER_TOPIC || log.topics.length < 3) continue;
    const to = ("0x" + String(log.topics[2]).slice(-40)) as Hex;
    // Burns to address(0) are how WETH withdraws and how some tokens take fees;
    // every other black hole is a loss.
    if (sameAddr(to, BLACKHOLES[0])) continue;
    if (!BLACKHOLES.some((h) => sameAddr(h, to))) continue;
    const amount = log.data && log.data !== "0x" ? BigInt(log.data) : 0n;
    if (amount > 0n) leaks.push({ to, asset: log.address as Hex, amount });
  }

  const proof: DeliveryProof = { ok: true, received, paid, leaks, retained, gasUsed, via };
  const short = received.find((r) => r.amount < r.min);
  const over = paid.find((p) => p.amount > p.max);
  if (leaks.length) {
    proof.ok = false;
    proof.reason = `funds would be lost: ${leaks.map((l) => `${l.amount} of ${l.asset} to ${l.to}`).join(", ")}`;
  } else if (short) {
    proof.ok = false;
    proof.reason = `you would receive ${short.amount} of ${short.asset}, less than the promised ${short.min}`;
  } else if (over) {
    proof.ok = false;
    proof.reason = `you would pay ${over.amount} of ${over.asset}, more than the quoted ${over.max}`;
  } else if (retained.length) {
    proof.ok = false;
    proof.reason = `funds would be stuck: ${retained.map((r) => `${r.amount} of ${r.asset} in ${r.to}`).join(", ")}`;
  }
  return proof;
}

/** JSON-safe view for API responses. */
export function proofToJson(p: DeliveryProof) {
  const leak = (l: Leak) => ({ to: l.to, asset: l.asset, amount: l.amount.toString() });
  return {
    ok: p.ok,
    reason: p.reason ?? null,
    unavailable: p.unavailable ?? false,
    reverted: p.reverted ?? null,
    received: p.received.map((r) => ({ asset: r.asset, amount: r.amount.toString(), min: r.min.toString() })),
    paid: p.paid.map((r) => ({ asset: r.asset, amount: r.amount.toString(), max: r.max.toString() })),
    leaks: p.leaks.map(leak),
    retained: p.retained.map(leak),
    gasUsed: p.gasUsed.toString(),
    via: p.via ?? null,
  };
}
