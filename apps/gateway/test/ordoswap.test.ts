import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, encodeErrorResult, encodeFunctionResult, type Hex } from "viem";
import { FEES, QUOTER_V2, V3_FACTORY, encodePath } from "@ordofi/core/arb";
import {
  ORDO_SWAP_ABI,
  RECLAIM_GAS,
  USDG,
  WETH,
  candidateCycles,
  chooseReclaim,
  decodeQuote,
  quoteSwap,
  sizeLadder,
} from "../src/ordoswap.ts";

const GME: Hex = "0x1b0e319c6a659f002271b69db8a7df2f911c153e";
const ORDO: Hex = "0x00000000000000000000000000000000000000aa";
const USER: Hex = "0x00000000000000000000000000000000000000ee";
const POOL: Hex = "0x00000000000000000000000000000000000000f0";

test("a buy on one tier is closed by buying elsewhere and selling into that tier", () => {
  const cycles = candidateCycles(GME, 3000, true, [500, 3000], [], undefined, "GME");
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].label, "GME 500→3000");
  assert.equal(cycles[0].path, encodePath([WETH, GME, WETH], [500, 3000]));
});

test("a sell is the mirror image, and the USDG leg is added when that depth exists", () => {
  const cycles = candidateCycles(GME, 3000, false, [500, 3000], [500], 100, "GME");
  assert.deepEqual(
    cycles.map((c) => c.label),
    ["GME 3000→500", "WETH@3000→GME→USDG@500"],
  );
  assert.equal(cycles[1].path, encodePath([WETH, GME, USDG, WETH], [3000, 500, 100]));
});

test("a pair with one tier and no USDG depth opens nothing", () => {
  assert.deepEqual(candidateCycles(GME, 3000, true, [3000], [], undefined), []);
});

test("the ladder is bounded by the float and by the swap, and never repeats a size", () => {
  assert.deepEqual(sizeLadder(1000n, 10_000n), [50n, 100n, 250n, 500n, 1000n]);
  assert.deepEqual(sizeLadder(10_000n, 1000n), [50n, 100n, 250n, 500n, 1000n], "capped at the swap size");
  assert.deepEqual(sizeLadder(0n, 1000n), []);
  assert.deepEqual(sizeLadder(10n, 1000n), [1n, 2n, 5n, 10n], "tiny floats collapse duplicate rungs");
});

test("a QuoteResult revert decodes; anything else is null", () => {
  const ok = encodeErrorResult({ abi: ORDO_SWAP_ABI, errorName: "QuoteResult", args: [123n, 45n, "0x"] });
  assert.deepEqual(decodeQuote(ok), { amountOut: 123n, profit: 45n, failed: false });
  const failed = encodeErrorResult({ abi: ORDO_SWAP_ABI, errorName: "QuoteResult", args: [123n, 0n, "0xdeadbeef"] });
  assert.equal(decodeQuote(failed)?.failed, true);
  assert.equal(decodeQuote(encodeErrorResult({ abi: ORDO_SWAP_ABI, errorName: "BadPath" })), null);
  assert.equal(decodeQuote("0x08c379a0"), null);
});

test("the reclaim only ships when the user's share clears its gas three times over", () => {
  const cycle = { path: "0x01" as Hex, label: "x" };
  const gasPrice = 1_000_000_000n; // 1 gwei
  const gas = RECLAIM_GAS * gasPrice;
  assert.equal(chooseReclaim([], gasPrice, 1000n), null, "nothing to choose");
  assert.equal(chooseReclaim([{ cycle, size: 1n, profit: 0n }], gasPrice, 1000n), null, "zero is not a profit");
  assert.equal(chooseReclaim([{ cycle, size: 1n, profit: gas * 3n }], gasPrice, 1000n), null, "90% of 3× gas is under 3× gas");
  const r = chooseReclaim(
    [
      { cycle, size: 1n, profit: gas * 4n },
      { cycle: { path: "0x02" as Hex, label: "better" }, size: 2n, profit: gas * 10n },
    ],
    gasPrice,
    1000n,
  );
  assert.ok(r);
  assert.equal(r.label, "better", "the most profitable candidate wins");
  assert.equal(r.amountIn, 2n);
  assert.equal(r.minProfit, gas * 5n, "half the simulated profit, since that is above the gas floor");
});

test("the smallest reclaim that ships still leaves room: half its profit is above the gas floor", () => {
  const cycle = { path: "0x01" as Hex, label: "x" };
  const gasPrice = 1_000_000_000n;
  const gas = RECLAIM_GAS * gasPrice;
  // The thinnest profit that passes the 3× gate. Half of it must still exceed
  // gas grossed up for the split, so the on-chain minimum is never below what
  // covers the user's gas — the floor in chooseReclaim is belt-and-braces.
  const thinnest = (gas * 3n * 10_000n) / 9000n + 1n;
  const r = chooseReclaim([{ cycle, size: 1n, profit: thinnest }], gasPrice, 1000n)!;
  assert.equal(r.minProfit, thinnest / 2n);
  assert.ok(r.minProfit > (gas * 10_000n) / 9000n);
});

/** A fake chain: WETH/GME has tiers 500 and 3000, the float is 1 ETH, quote() answers per size. */
function fakeRpc(opts: { profitFor: (size: bigint) => bigint; amountOut: bigint; float?: bigint }) {
  const calls: { method: string; params: unknown[] }[] = [];
  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    calls.push({ method, params });
    if (method === "eth_gasPrice") return "0x3b9aca00"; // 1 gwei
    if (method !== "eth_call") throw new Error(`unexpected ${method}`);
    const { to, data, value } = params[0] as { to: Hex; data: Hex; value?: Hex };
    if (to.toLowerCase() === V3_FACTORY) {
      const [, , fee] = decodeFunctionData({
        abi: [{ type: "function", name: "getPool", inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }], outputs: [{ type: "address" }], stateMutability: "view" }],
        data,
      }).args as [Hex, Hex, number];
      const a = ((decodeFunctionData({
        abi: [{ type: "function", name: "getPool", inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }], outputs: [{ type: "address" }], stateMutability: "view" }],
        data,
      }).args as [Hex, Hex, number])[1]).toLowerCase();
      const has = a === GME ? [500, 3000].includes(fee) : a === USDG ? fee === 100 : false;
      return has ? `0x${POOL.slice(2).padStart(64, "0")}` : `0x${"0".repeat(64)}`;
    }
    if (to.toLowerCase() === ORDO) {
      const fn = decodeFunctionData({ abi: ORDO_SWAP_ABI, data });
      if (fn.functionName === "float") return encodeFunctionResult({ abi: ORDO_SWAP_ABI, functionName: "float", result: opts.float ?? 10n ** 18n });
      if (fn.functionName === "protocolBps") return encodeFunctionResult({ abi: ORDO_SWAP_ABI, functionName: "protocolBps", result: 1000 });
      if (fn.functionName === "quote") {
        assert.equal(value, `0x${(10n ** 18n).toString(16)}`, "the swap size travels as value");
        const [, , reclaim] = fn.args as [Hex, bigint, { path: Hex; amountIn: bigint; minProfit: bigint }];
        const err = new Error("execution reverted") as Error & { data: Hex };
        err.data = encodeErrorResult({
          abi: ORDO_SWAP_ABI,
          errorName: "QuoteResult",
          args: [opts.amountOut, reclaim.amountIn === 0n ? 0n : opts.profitFor(reclaim.amountIn), "0x"],
        });
        throw err;
      }
    }
    throw new Error(`unexpected call to ${to}`);
  };
  return { rpc, calls };
}

test("a WETH-in swap that opens a gap comes back with the best reclaim attached", async () => {
  const gas = RECLAIM_GAS * 1_000_000_000n;
  // Profit grows with size up to half the float, then price impact eats it.
  const { rpc } = fakeRpc({ amountOut: 5000n, profitFor: (s) => (s <= 5n * 10n ** 17n ? s / 100n : gas) });
  const q = await quoteSwap(
    { tokenIn: WETH, tokenOut: GME, fee: 3000, amountIn: 10n ** 18n, amountOutMinimum: 4900n, recipient: USER, nativeOut: false },
    { rpc, ordoSwap: ORDO },
  );
  assert.equal(q.to, ORDO);
  assert.equal(q.value, `0x${(10n ** 18n).toString(16)}`);
  assert.equal(BigInt(q.amountOut), 5000n);
  assert.ok(q.reclaim, "a reclaim is attached");
  assert.equal(q.reclaim.label, `${GME.slice(0, 8)} 500→3000`);
  assert.equal(BigInt(q.reclaim.amountIn), 5n * 10n ** 17n, "the half-float rung was the most profitable");
  assert.equal(BigInt(q.reclaim.profit), 5n * 10n ** 15n);
  assert.equal(BigInt(q.reclaim.surplusToUser), (5n * 10n ** 15n * 9000n) / 10_000n);
  // And the calldata is the real thing.
  const decoded = decodeFunctionData({ abi: ORDO_SWAP_ABI, data: q.data });
  assert.equal(decoded.functionName, "swap");
  const [path, amountIn, minOut, recipient, nativeOut, reclaim] = decoded.args as [Hex, bigint, bigint, Hex, boolean, { path: Hex; amountIn: bigint; minProfit: bigint }];
  assert.equal(path, encodePath([WETH, GME], [3000]));
  assert.equal(amountIn, 10n ** 18n);
  assert.equal(minOut, 4900n, "the user's own slippage floor is passed through untouched");
  assert.equal(recipient.toLowerCase(), USER);
  assert.equal(nativeOut, false);
  assert.equal(reclaim.path, encodePath([WETH, GME, WETH], [500, 3000]));
  assert.equal(reclaim.minProfit, BigInt(q.reclaim.minProfit));
});

test("a swap that opens nothing worth the gas is still a valid swap, with no reclaim and a reason", async () => {
  const { rpc } = fakeRpc({ amountOut: 5000n, profitFor: () => 1n });
  const q = await quoteSwap(
    { tokenIn: WETH, tokenOut: GME, fee: 3000, amountIn: 10n ** 18n, amountOutMinimum: 0n, recipient: USER, nativeOut: false },
    { rpc, ordoSwap: ORDO },
  );
  assert.equal(q.reclaim, null);
  assert.match(q.note!, /does not cover the gas/);
  assert.equal(BigInt(q.amountOut), 5000n, "the swap's own output is still reported");
  const [, , , , , reclaim] = decodeFunctionData({ abi: ORDO_SWAP_ABI, data: q.data }).args as [Hex, bigint, bigint, Hex, boolean, { path: Hex; amountIn: bigint }];
  assert.equal(reclaim.amountIn, 0n, "the calldata carries no reclaim");
});

test("bad input is refused before anything is simulated", async () => {
  const { rpc, calls } = fakeRpc({ amountOut: 1n, profitFor: () => 0n });
  const base = { tokenIn: WETH, tokenOut: GME, fee: 3000, amountIn: 1n, amountOutMinimum: 0n, recipient: USER, nativeOut: false };
  await assert.rejects(quoteSwap({ ...base, tokenOut: WETH }, { rpc, ordoSwap: ORDO }), /same/);
  await assert.rejects(quoteSwap({ ...base, amountIn: 0n }, { rpc, ordoSwap: ORDO }), /positive/);
  await assert.rejects(quoteSwap({ ...base, fee: 123 }, { rpc, ordoSwap: ORDO }), /fee must be/);
  await assert.rejects(quoteSwap({ ...base, nativeOut: true }, { rpc, ordoSwap: ORDO }), /nativeOut/);
  assert.equal(calls.length, 0, "nothing hit the chain");
  assert.ok(FEES.includes(3000) && QUOTER_V2.startsWith("0x"));
});

test("a token-to-token swap is passed through as a plain swap in v1, without touching the chain", async () => {
  const { rpc, calls } = fakeRpc({ amountOut: 1n, profitFor: () => 0n });
  const q = await quoteSwap(
    { tokenIn: GME, tokenOut: USDG, fee: 500, amountIn: 10n, amountOutMinimum: 0n, recipient: USER, nativeOut: false, from: USER },
    { rpc, ordoSwap: ORDO },
  );
  assert.equal(q.reclaim, null);
  assert.match(q.note!, /WETH on one side/);
  assert.equal(q.value, "0x0");
  assert.equal(calls.length, 0);
});
