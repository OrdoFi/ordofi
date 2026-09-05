/**
 * `ordo_explain(txHash)` — what a transaction actually did, in a sentence.
 *
 * A receipt is a list of logs. Every explorer shows you the logs. Almost
 * nobody can read them, and the one question anyone actually has — what left
 * my wallet and what arrived — is the one the receipt does not answer. It
 * takes decoding a Transfer topic, knowing which of the two indexed addresses
 * is you, finding the token's decimals, and doing it again for every leg of a
 * swap.
 *
 * So this does that. Given a hash it returns the net movement per asset for
 * whoever sent it, the venues involved, any allowance granted, what the gas
 * cost, and a line of English. No token list required: symbols and decimals
 * are read from the tokens the transaction actually touched, which is a
 * handful, and cached.
 */
import { formatUnits, type Hex } from "viem";

export type Rpc = (method: string, params: unknown[]) => Promise<any>;

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const V3_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const V4_SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const V2_SWAP = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
/** WETH wrapping and unwrapping, which is movement people do not expect to see. */
const DEPOSIT = "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c";
const WITHDRAWAL = "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65";

const NAME_OF = "0x06fdde03";
const SYMBOL_OF = "0x95d89b41";
const DECIMALS_OF = "0x313ce567";
const UNLIMITED = 2n ** 255n;

const addr = (topic: string): Hex => ("0x" + topic.slice(26)).toLowerCase() as Hex;
const low = (s: string): string => s.toLowerCase();

export interface TokenMeta {
  symbol: string;
  decimals: number;
}

/**
 * Token metadata, read from the chain and kept.
 *
 * A symbol never changes, so this only ever grows, and a transaction touches
 * two or three tokens. Anything that will not answer is remembered as unknown
 * rather than asked about again.
 */
export class TokenInfo {
  private known = new Map<string, TokenMeta>();

  constructor(private readonly rpc: Rpc) {}

  async of(token: string): Promise<TokenMeta> {
    const key = low(token);
    const hit = this.known.get(key);
    if (hit) return hit;
    const [sym, dec] = await Promise.all([
      this.rpc("eth_call", [{ to: key, data: SYMBOL_OF }, "latest"]).catch(() => null),
      this.rpc("eth_call", [{ to: key, data: DECIMALS_OF }, "latest"]).catch(() => null),
    ]);
    const meta: TokenMeta = {
      symbol: decodeString(sym) || key.slice(0, 8),
      decimals: dec && dec !== "0x" ? Number(BigInt(dec)) : 18,
    };
    this.known.set(key, meta);
    return meta;
  }
}

/** ABI strings are length-prefixed; some tokens return a bytes32 instead. */
export function decodeString(ret: string | null): string {
  if (!ret || ret === "0x") return "";
  const body = ret.slice(2);
  try {
    if (body.length >= 128) {
      const len = Number(BigInt("0x" + body.slice(64, 128)));
      if (len > 0 && len <= 64) {
        const raw = Buffer.from(body.slice(128, 128 + len * 2), "hex").toString("utf8");
        // eslint-disable-next-line no-control-regex
        return raw.replace(/\u0000/g, "").trim();
      }
    }
    // bytes32: trailing zeros, no length prefix.
    const raw = Buffer.from(body.slice(0, 64), "hex").toString("utf8");
    // eslint-disable-next-line no-control-regex
    return raw.replace(/\u0000/g, "").trim();
  } catch {
    return "";
  }
}

export interface Movement {
  asset: string;
  symbol: string;
  /** Signed, from the sender's point of view. Negative left the wallet. */
  amount: string;
  raw: string;
}

export interface Explanation {
  hash: string;
  status: "success" | "reverted";
  block: number;
  from: string;
  to: string | null;
  /** What the sender ended up with, per asset. The answer to "what happened". */
  youPaid: Movement[];
  youReceived: Movement[];
  /** Allowances the transaction granted. The thing worth noticing after the fact. */
  approvals: { token: string; symbol: string; spender: string; unlimited: boolean; amount: string }[];
  venues: string[];
  gasEth: string;
  /** One line, in English. */
  summary: string;
}

/** Net movement per asset for one address, from a receipt's logs plus the native value. */
export function netFor(
  who: string,
  logs: { address: string; topics: string[]; data: string }[],
  nativeValue: bigint,
): Map<string, bigint> {
  const me = low(who);
  const net = new Map<string, bigint>();
  const add = (asset: string, delta: bigint) => net.set(asset, (net.get(asset) ?? 0n) + delta);

  if (nativeValue > 0n) add("eth", -nativeValue);

  for (const l of logs) {
    const t0 = low(l.topics?.[0] ?? "");
    const token = low(l.address);
    if (t0 === TRANSFER && l.topics.length >= 3) {
      const from = addr(l.topics[1]);
      const to = addr(l.topics[2]);
      const amount = l.data && l.data !== "0x" ? BigInt(l.data.slice(0, 66)) : 0n;
      if (from === me) add(token, -amount);
      if (to === me) add(token, amount);
    } else if (t0 === WITHDRAWAL && l.topics.length >= 2 && addr(l.topics[1]) === me) {
      // Unwrapping returns ether that no Transfer log records.
      add("eth", BigInt(l.data.slice(0, 66)));
    } else if (t0 === DEPOSIT && l.topics.length >= 2 && addr(l.topics[1]) === me) {
      add("eth", -BigInt(l.data.slice(0, 66)));
    }
  }
  return net;
}

/** Which venues a receipt touched, named. */
export function venuesIn(logs: { topics: string[] }[]): string[] {
  const seen = new Set<string>();
  for (const l of logs) {
    const t = low(l.topics?.[0] ?? "");
    if (t === V4_SWAP) seen.add("Uniswap V4");
    else if (t === V3_SWAP) seen.add("Uniswap V3");
    else if (t === V2_SWAP) seen.add("Uniswap V2");
  }
  return [...seen];
}

const fmt = (v: bigint, decimals: number): string => {
  const s = formatUnits(v < 0n ? -v : v, decimals);
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  if (n === 0) return "0";
  if (n < 0.000001) return n.toExponential(2);
  return n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : 4 });
};

export async function explain(rpc: Rpc, info: TokenInfo, hash: string): Promise<Explanation> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("ordo_explain: expected a transaction hash");
  const [tx, rc] = await Promise.all([
    rpc("eth_getTransactionByHash", [hash]),
    rpc("eth_getTransactionReceipt", [hash]),
  ]);
  if (!tx) throw new Error("ordo_explain: no such transaction");
  if (!rc) throw new Error("ordo_explain: not mined yet");

  const from = low(tx.from);
  const logs = (rc.logs ?? []) as { address: string; topics: string[]; data: string }[];
  const net = netFor(from, logs, BigInt(tx.value ?? "0x0"));

  const paid: Movement[] = [];
  const got: Movement[] = [];
  for (const [asset, delta] of net) {
    if (delta === 0n) continue;
    const meta = asset === "eth" ? { symbol: "ETH", decimals: 18 } : await info.of(asset);
    const m: Movement = { asset, symbol: meta.symbol, amount: fmt(delta, meta.decimals), raw: delta.toString() };
    (delta < 0n ? paid : got).push(m);
  }

  const approvals: Explanation["approvals"] = [];
  for (const l of logs) {
    if (low(l.topics?.[0] ?? "") !== APPROVAL || l.topics.length < 3) continue;
    if (addr(l.topics[1]) !== from) continue;
    const amount = l.data && l.data !== "0x" ? BigInt(l.data.slice(0, 66)) : 0n;
    const meta = await info.of(l.address);
    approvals.push({
      token: low(l.address),
      symbol: meta.symbol,
      spender: addr(l.topics[2]),
      unlimited: amount >= UNLIMITED,
      amount: fmt(amount, meta.decimals),
    });
  }

  const gasWei = BigInt(rc.gasUsed ?? "0x0") * BigInt(rc.effectiveGasPrice ?? tx.gasPrice ?? "0x0");
  const venues = venuesIn(logs);

  return {
    hash,
    status: rc.status === "0x1" ? "success" : "reverted",
    block: Number(BigInt(rc.blockNumber ?? "0x0")),
    from,
    to: tx.to ? low(tx.to) : null,
    youPaid: paid,
    youReceived: got,
    approvals,
    venues,
    gasEth: formatUnits(gasWei, 18),
    summary: summarise({ status: rc.status === "0x1", paid, got, approvals, venues, to: tx.to ? low(tx.to) : null }),
  };
}

/** The sentence. Written so the common cases read like something a person would say. */
export function summarise(x: {
  status: boolean;
  paid: Movement[];
  got: Movement[];
  approvals: Explanation["approvals"];
  venues: string[];
  to: string | null;
}): string {
  if (!x.status) return "This transaction reverted. Nothing moved except the gas.";
  const list = (m: Movement[]) => m.map((v) => `${v.amount} ${v.symbol}`).join(" and ");
  const via = x.venues.length ? ` through ${x.venues.join(" and ")}` : "";

  if (x.paid.length && x.got.length) return `Swapped ${list(x.paid)} for ${list(x.got)}${via}.`;
  if (x.approvals.length) {
    const a = x.approvals[0];
    return a.unlimited
      ? `Granted ${a.spender} permission to spend an unlimited amount of your ${a.symbol}. Nothing moved.`
      : `Granted ${a.spender} permission to spend ${a.amount} ${a.symbol}. Nothing moved.`;
  }
  if (x.paid.length) return `Sent ${list(x.paid)}${x.to ? ` to ${x.to}` : ""}.`;
  if (x.got.length) return `Received ${list(x.got)}${via}.`;
  return "Succeeded, but moved none of your assets — a contract call that changed something other than balances.";
}
