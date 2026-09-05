/**
 * eth_getLogs without the provider's range limit.
 *
 * Ask this chain's own RPC for logs over a wide range and it refuses:
 *
 *   {"code":-32602,"message":"Block range limit exceeded. See more details at
 *    https://docs.chainstack.com/docs/limits#evm-range-limits."}
 *
 * That is our upstream's limit and our upstream's brand, arriving at somebody
 * else's dapp through our endpoint. There is a second one underneath it —
 * "logs matched by query exceeds limit of 10000" — which is about how much
 * came back rather than how far we looked. Between them they were rejecting
 * about sixty queries a minute of real traffic.
 *
 * Neither is a fact about the chain. A range that is too wide for one request
 * is several requests, and the caller should not have to know that. So: try
 * the query as asked, and if the answer is one of those two refusals, halve
 * the range and ask again, down to a single block. The logs come back in block
 * order because the halves are walked in order.
 *
 * What this deliberately does not do is pretend to be free. A wide query costs
 * real upstream calls, so there is a hard budget on how many, and a query that
 * exhausts it is told exactly that instead of being quietly truncated — a short
 * answer that looks complete is worse than an error, because the caller will
 * believe it.
 *
 * The halving is sequential, not concurrent. Fanning out would be faster and
 * would also multiply the load we put on one upstream at the moment a client
 * asks for a year of history; these queries fail entirely today, so slow is
 * already an improvement.
 */
import { RpcError } from "./errors.js";

export type Rpc = (method: string, params: unknown[]) => Promise<any>;

export interface LogFilterParam {
  fromBlock?: string;
  toBlock?: string;
  blockHash?: string;
  address?: unknown;
  topics?: unknown;
}

/** The upstream is refusing because we looked too far, or because too much came back. */
export function isRangeRefusal(e: unknown): boolean {
  const m = ((e as { message?: string })?.message ?? "").toLowerCase();
  return (
    m.includes("block range") ||
    m.includes("range limit") ||
    m.includes("exceeds limit") ||
    m.includes("query returned more than") ||
    m.includes("too many results") ||
    m.includes("log response size exceeded") ||
    m.includes("range too large")
  );
}

const HEAD_TAGS = new Set(["latest", "pending", "safe", "finalized"]);

/** Block tags a caller may use, resolved to numbers so a range can be halved. */
export async function resolveRange(
  rpc: Rpc,
  filter: LogFilterParam,
): Promise<{ from: number; to: number } | null> {
  const tag = (v: string | undefined, fallback: "head" | "earliest"): "head" | number => {
    if (v === undefined || v === null || v === "") return fallback === "head" ? "head" : 0;
    const s = String(v).toLowerCase();
    if (HEAD_TAGS.has(s)) return "head";
    if (s === "earliest") return 0;
    const n = Number(s);
    return Number.isFinite(n) ? n : "head";
  };
  const a = tag(filter.fromBlock, "earliest");
  const b = tag(filter.toBlock, "head");
  if (a === "head" || b === "head") {
    const head = Number(await rpc("eth_blockNumber", []));
    if (!Number.isFinite(head)) return null;
    return { from: a === "head" ? head : a, to: b === "head" ? head : b };
  }
  return { from: a, to: b };
}

export interface WideOptions {
  /** Upstream requests one query may spend. A wide range is worth several; it is not worth hundreds. */
  maxCalls?: number;
  /** Logs one query may return, so a careless filter cannot exhaust memory. */
  maxLogs?: number;
}

const hex = (n: number): string => `0x${n.toString(16)}`;

/**
 * Answer `eth_getLogs` however wide it is, or say why not.
 *
 * A query the upstream accepts costs exactly one request, which is almost all
 * of them; only a refusal triggers the split.
 */
export async function getLogsWide(rpc: Rpc, filter: LogFilterParam, opts: WideOptions = {}): Promise<unknown[]> {
  const maxCalls = opts.maxCalls ?? 40;
  const maxLogs = opts.maxLogs ?? 150_000;

  // A query by block hash has no range to divide, and neither does one we
  // cannot read; either way it is the upstream's answer verbatim.
  if (filter.blockHash) return rpc("eth_getLogs", [filter]);

  const budget = { calls: 0 };
  const first = async () => {
    budget.calls++;
    return (await rpc("eth_getLogs", [filter])) as unknown[];
  };
  try {
    return await first();
  } catch (e) {
    if (!isRangeRefusal(e)) throw e;
  }

  const range = await resolveRange(rpc, filter);
  if (!range || range.to < range.from) throw new RpcError(-32602, "eth_getLogs: fromBlock is after toBlock");

  const out: unknown[] = [];
  await walk(rpc, filter, range.from, range.to, budget, maxCalls, maxLogs, out);
  return out;
}

async function walk(
  rpc: Rpc,
  filter: LogFilterParam,
  from: number,
  to: number,
  budget: { calls: number },
  maxCalls: number,
  maxLogs: number,
  out: unknown[],
): Promise<void> {
  if (budget.calls >= maxCalls) {
    throw new RpcError(
      -32005,
      `eth_getLogs: this range needed more than ${maxCalls} upstream queries to answer. Narrow the block range or add an address or topic filter — a partial answer would look complete, so none is returned.`,
    );
  }
  budget.calls++;
  let logs: unknown[];
  try {
    logs = (await rpc("eth_getLogs", [{ ...filter, fromBlock: hex(from), toBlock: hex(to) }])) as unknown[];
  } catch (e) {
    if (!isRangeRefusal(e)) throw e;
    if (from >= to) {
      // One block is as narrow as a range gets. If a single block still has
      // more logs than the upstream will return, splitting further is not
      // possible and the caller needs a filter, not patience.
      throw new RpcError(
        -32005,
        `eth_getLogs: block ${from} alone returns more logs than the upstream will serve. Add an address or topic filter.`,
      );
    }
    const mid = from + Math.floor((to - from) / 2);
    await walk(rpc, filter, from, mid, budget, maxCalls, maxLogs, out);
    await walk(rpc, filter, mid + 1, to, budget, maxCalls, maxLogs, out);
    return;
  }
  if (Array.isArray(logs)) {
    if (out.length + logs.length > maxLogs) {
      throw new RpcError(
        -32005,
        `eth_getLogs: this query matches more than ${maxLogs.toLocaleString("en-US")} logs. Narrow the range or add a filter.`,
      );
    }
    out.push(...logs);
  }
}
