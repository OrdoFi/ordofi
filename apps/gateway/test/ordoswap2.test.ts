import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, encodeErrorResult, encodeFunctionResult, type Hex } from "viem";
import { V3_FACTORY, encodePath } from "@ordofi/core/arb";
import {
  NATIVE,
  ORDO_SWAP2_ABI,
  RECLAIM_GAS_BASE,
  RECLAIM_GAS_PER_LEG,
  USDG,
  WETH,
  candidateRoutes,
  chooseReclaim,
  decodeQuote,
  legFor,
  poolsFor,
  quoteSwap,
  reclaimCandidates,
  sizeLadder,
  type Pool,
} from "../src/ordoswap2.ts";

const ORDO: Hex = "0xfe2f0fb0c00d19786a8abf98d4b1f1ac8763b167";
const GME: Hex = "0x1b0e319c6a659f002271b69db8a7df2f911c153e";
const SWAP: Hex = "0x00000000000000000000000000000000000000aa";
const USER: Hex = "0x00000000000000000000000000000000000000ee";
const HOOK: Hex = "0xcf8f482e998d18793414d10c9fc48fc8277ab8cc";

/** V4 index with ORDO's real pools and a hookless ETH/USDG pool. */
const ALL_V4 = [
  { poolId: "0x3b84", currency0: NATIVE, currency1: ORDO, fee: 8388608, tickSpacing: 200, hooks: HOOK },
  { poolId: "0x4366", currency0: NATIVE, currency1: ORDO, fee: 200000, tickSpacing: 2000, hooks: NATIVE },
  { poolId: "0xe067", currency0: USDG, currency1: ORDO, fee: 40000, tickSpacing: 400, hooks: NATIVE },
  { poolId: "0x2410", currency0: NATIVE, currency1: USDG, fee: 100, tickSpacing: 1, hooks: NATIVE },
];
const v4 = {
  v4PoolsForPair(a: string, b: string) {
    const x = a.toLowerCase(), y = b.toLowerCase();
    return ALL_V4.filter((p) => (p.currency0 === x && p.currency1 === y) || (p.currency0 === y && p.currency1 === x));
  },
};

test("a pair with hundreds of pools is cut to the busiest few before anything is simulated", async () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ poolId: `0x${i.toString(16).padStart(4, "0")}`, currency0: NATIVE, currency1: USDG, fee: 3000 + i, tickSpacing: 60, hooks: NATIVE }));
  const src = {
    v4PoolsForPair: () => many,
    poolSwapsSince: (pools: string[]) => new Map(pools.filter((_, i) => i % 100 === 7).map((p, i) => [p, 1000 - i])),
  };
  const pools = await poolsFor(factoryRpc(), src, WETH, USDG);
  const v4pools = pools.filter((p) => p.venue === "v4");
  assert.equal(v4pools.length, 3, "only the pools with swaps in the last day survive");
  assert.deepEqual(v4pools.map((p) => p.id), ["v4:0x0007", "v4:0x006b", "v4:0x00cf"]);
});

/** V3 factory: WETH/USDG at 100 and 500, WETH/GME at 3000; ORDO has no V3 pool. */
function factoryRpc(extra?: (method: string, params: unknown[]) => Promise<unknown> | undefined) {
  return async (method: string, params: unknown[]): Promise<unknown> => {
    if (method === "eth_gasPrice") return "0x3b9aca00";
    if (method === "eth_call") {
      const { to, data } = params[0] as { to: Hex; data: Hex };
      if (to.toLowerCase() === V3_FACTORY) {
        const [x, y, fee] = decodeFunctionData({
          abi: [{ type: "function", name: "getPool", inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }], outputs: [{ type: "address" }], stateMutability: "view" }],
          data,
        }).args as [Hex, Hex, number];
        const pair = [x.toLowerCase(), y.toLowerCase()].sort().join(":");
        const pools: Record<string, number[]> = { [[WETH, USDG].sort().join(":")]: [100, 500], [[WETH, GME].sort().join(":")]: [3000] };
        return (pools[pair] ?? []).includes(fee) ? `0x${"1".padStart(64, "0")}` : `0x${"0".repeat(64)}`;
      }
    }
    const r = extra?.(method, params);
    if (r !== undefined) return r;
    throw new Error(`unexpected ${method} to ${JSON.stringify(params[0]).slice(0, 60)}`);
  };
}

test("a pair's markets are its V3 tiers and its V4 pools, with ether spelled both ways", async () => {
  const pools = await poolsFor(factoryRpc(), v4, WETH, ORDO);
  assert.deepEqual(pools.map((p) => [p.venue, p.fee, p.hooked]), [["v4", 8388608, true], ["v4", 200000, false]]);
  const eu = await poolsFor(factoryRpc(), v4, WETH, USDG);
  assert.deepEqual(eu.map((p) => `${p.venue}:${p.fee}`), ["v3:100", "v3:500", "v4:100"]);
  assert.deepEqual(await poolsFor(factoryRpc(), null, WETH, ORDO), [], "no V4 index, no V4 pools");
});

test("a leg through a V4 ether pool pays native ether and picks its direction from the key", () => {
  const hooked: Pool = { venue: "v4", a: WETH, b: ORDO, fee: 8388608, key: { currency0: NATIVE, currency1: ORDO, fee: 8388608, tickSpacing: 200, hooks: HOOK }, hooked: true, id: "v4:x" };
  const buy = legFor(hooked, WETH);
  assert.equal(buy.venue, 1);
  assert.equal(buy.zeroForOne, true, "ether is currency0; buying ORDO is zero→one");
  const sell = legFor(hooked, ORDO);
  assert.equal(sell.zeroForOne, false);
  const v3: Pool = { venue: "v3", a: WETH, b: GME, fee: 3000, id: "v3:y" };
  assert.equal(legFor(v3, GME).path, encodePath([GME, WETH], [3000]), "a V3 leg is a single-hop path from the input");
});

test("routes: direct markets plus two hops through ether or USDG, across venues", async () => {
  const routes = await candidateRoutes(factoryRpc(), v4, WETH, ORDO);
  const labels = routes.map((r) => r.hops.map((h) => `${h.venue}:${h.fee}`).join(" "));
  assert.deepEqual(labels, [
    "v4:8388608", // direct, hooked
    "v4:200000", // direct, plain
    "v3:100 v4:40000", // WETH→USDG on V3, USDG→ORDO on V4
    "v3:500 v4:40000",
    "v4:100 v4:40000", // WETH→USDG on V4, USDG→ORDO on V4
  ]);
  assert.equal(routes[2].legs[0].venue, 0);
  assert.equal(routes[2].legs[1].venue, 1);
  assert.equal(routes[2].legs[1].zeroForOne, true, "USDG is currency0 of the USDG/ORDO pool");
});

test("back-run candidates for a buy: every other market of the pair, and the USDG detour", () => {
  const hooked: Pool = { venue: "v4", a: WETH, b: ORDO, fee: 8388608, key: { currency0: NATIVE, currency1: ORDO, fee: 8388608, tickSpacing: 200, hooks: HOOK }, hooked: true, id: "h" };
  const plain: Pool = { venue: "v4", a: WETH, b: ORDO, fee: 200000, key: { currency0: NATIVE, currency1: ORDO, fee: 200000, tickSpacing: 2000, hooks: NATIVE }, id: "p" };
  const usdgPool: Pool = { venue: "v4", a: USDG, b: ORDO, fee: 40000, key: { currency0: USDG, currency1: ORDO, fee: 40000, tickSpacing: 400, hooks: NATIVE }, id: "u" };
  const eu: Pool = { venue: "v3", a: WETH, b: USDG, fee: 100, id: "eu" };
  const cands = reclaimCandidates(hooked, ORDO, true, [hooked, plain], [usdgPool], eu);
  assert.deepEqual(
    cands.map((r) => r.hops.map((h) => `${h.tokenIn.slice(0, 6)}→${h.tokenOut.slice(0, 6)}@${h.venue}`).join(" ")),
    [
      `${WETH.slice(0, 6)}→${ORDO.slice(0, 6)}@v4 ${ORDO.slice(0, 6)}→${WETH.slice(0, 6)}@v4`, // buy on plain, sell into hooked
      `${WETH.slice(0, 6)}→${USDG.slice(0, 6)}@v3 ${USDG.slice(0, 6)}→${ORDO.slice(0, 6)}@v4 ${ORDO.slice(0, 6)}→${WETH.slice(0, 6)}@v4`,
    ],
  );
  assert.equal(cands[0].legs[1].zeroForOne, false, "the sell into the hooked pool is one→zero");
  // Selling is the mirror: sell into the swapped pool first is wrong — buy there, sell elsewhere.
  const sells = reclaimCandidates(hooked, ORDO, false, [hooked, plain], [], undefined);
  assert.equal(sells[0].hops[0].venue, "v4");
  assert.equal(sells[0].pools[0].id, "h", "buy on the pool the user just sold into");
  assert.equal(sells[0].pools[1].id, "p");
});

test("the reclaim ships only when the user's share clears the gas of its legs three times over", () => {
  const gasPrice = 1_000_000_000n;
  const route = { pools: [], legs: [{ venue: 1, path: "0x" as Hex, key: { currency0: NATIVE, currency1: ORDO, fee: 1, tickSpacing: 1, hooks: NATIVE }, zeroForOne: true }, { venue: 1, path: "0x" as Hex, key: { currency0: NATIVE, currency1: ORDO, fee: 1, tickSpacing: 1, hooks: NATIVE }, zeroForOne: false }], hops: [] };
  const gas = (RECLAIM_GAS_BASE + RECLAIM_GAS_PER_LEG * 2n) * gasPrice;
  assert.equal(chooseReclaim([{ route, size: 1n, profit: gas * 3n }], gasPrice, 1000n), null);
  const r = chooseReclaim([{ route, size: 1n, profit: gas * 4n }], gasPrice, 1000n)!;
  assert.equal(r.gasUnits, RECLAIM_GAS_BASE + RECLAIM_GAS_PER_LEG * 2n);
  assert.equal(r.minProfit, gas * 2n);
  assert.deepEqual(sizeLadder(1000n, 10_000n), [50n, 100n, 250n, 500n, 1000n]);
});

test("QuoteResult decodes; other reverts are null", () => {
  const ok = encodeErrorResult({ abi: ORDO_SWAP2_ABI, errorName: "QuoteResult", args: [7n, 3n, "0x"] });
  assert.deepEqual(decodeQuote(ok), { amountOut: 7n, profit: 3n, failed: false });
  assert.equal(decodeQuote("0x08c379a0")?.failed, undefined);
});

test("an ether-in swap of ORDO is priced across venues and comes back with calldata for the best one", async () => {
  // quote(): the hooked pool returns more ORDO; the plain one less; a reclaim across them makes 0.01 ETH.
  const rpc = factoryRpc((method, params) => {
    if (method !== "eth_call") return undefined;
    const { to, data, value } = params[0] as { to: Hex; data: Hex; value?: Hex };
    if (to.toLowerCase() !== SWAP) return undefined;
    const fn = decodeFunctionData({ abi: ORDO_SWAP2_ABI, data });
    if (fn.functionName === "float") return encodeFunctionResult({ abi: ORDO_SWAP2_ABI, functionName: "float", result: 10n ** 18n });
    if (fn.functionName === "protocolBps") return encodeFunctionResult({ abi: ORDO_SWAP2_ABI, functionName: "protocolBps", result: 1000 });
    if (fn.functionName === "quote") {
      assert.equal(value, `0x${(10n ** 17n).toString(16)}`, "the swap size travels as value");
      const [legs, , reclaim] = fn.args as [{ venue: number; key: { fee: number } }[], bigint, { legs: unknown[]; amountIn: bigint }];
      const out = legs.length === 1 && legs[0].key.fee === 8388608 ? 90_000n * 10n ** 18n : legs.length === 1 ? 80_000n * 10n ** 18n : 70_000n * 10n ** 18n;
      const profit = reclaim.legs.length ? (reclaim.amountIn * 10n) / 100n : 0n;
      const err = new Error("execution reverted") as Error & { data: Hex };
      err.data = encodeErrorResult({ abi: ORDO_SWAP2_ABI, errorName: "QuoteResult", args: [out, profit, "0x"] });
      throw err;
    }
    return undefined;
  });
  const q = await quoteSwap({ tokenIn: WETH, tokenOut: ORDO, amountIn: 10n ** 17n, amountOutMinimum: 0n, recipient: USER, nativeOut: false }, { rpc, ordoSwap: SWAP, v4 });
  assert.equal(BigInt(q.amountOut), 90_000n * 10n ** 18n, "the hooked pool won on price");
  assert.deepEqual(q.route.map((h) => `${h.venue}:${h.fee}`), ["v4:8388608"]);
  assert.ok(q.reclaim, "a reclaim across the two ETH pools is attached");
  assert.equal(BigInt(q.reclaim.amountIn), 10n ** 17n, "the biggest rung, capped at the swap size, was the most profitable");
  assert.equal(BigInt(q.reclaim.profit), 10n ** 16n);
  assert.equal(BigInt(q.reclaim.surplusToUser), 9n * 10n ** 15n);
  assert.ok(BigInt(q.gas) > RECLAIM_GAS_BASE + RECLAIM_GAS_PER_LEG * 2n, "the gas hint covers the reclaim");
  const d = decodeFunctionData({ abi: ORDO_SWAP2_ABI, data: q.data });
  assert.equal(d.functionName, "swap");
  const [legs, amountIn, , recipient, nativeOut, reclaim] = d.args as [{ venue: number; zeroForOne: boolean }[], bigint, bigint, Hex, boolean, { legs: unknown[]; gas: bigint }];
  assert.equal(legs.length, 1);
  assert.equal(legs[0].venue, 1);
  assert.equal(legs[0].zeroForOne, true);
  assert.equal(amountIn, 10n ** 17n);
  assert.equal(recipient.toLowerCase(), USER);
  assert.equal(nativeOut, false);
  assert.equal(reclaim.legs.length, 2);
  assert.equal(reclaim.gas, RECLAIM_GAS_BASE + RECLAIM_GAS_PER_LEG * 2n);
});

test("bad input is refused before anything is simulated", async () => {
  const rpc = factoryRpc();
  const base = { tokenIn: WETH, tokenOut: ORDO, amountIn: 1n, amountOutMinimum: 0n, recipient: USER, nativeOut: false };
  await assert.rejects(quoteSwap({ ...base, tokenOut: WETH }, { rpc, ordoSwap: SWAP, v4 }), /same/);
  await assert.rejects(quoteSwap({ ...base, amountIn: 0n }, { rpc, ordoSwap: SWAP, v4 }), /positive/);
  await assert.rejects(quoteSwap({ ...base, tokenOut: GME, nativeOut: true }, { rpc, ordoSwap: SWAP, v4 }), /nativeOut/);
  await assert.rejects(quoteSwap({ ...base, tokenIn: GME, tokenOut: WETH }, { rpc, ordoSwap: SWAP, v4 }), /from/);
});
