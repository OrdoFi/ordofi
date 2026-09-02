/**
 * On 2026-09-02 a trader swapped 900 USDG for ETH through the app and the ETH
 * went to 0x0000000000000000000000000000000000000001: the calldata ended with
 * unwrapWETH9(amountMinimum, MSG_SENDER), and SwapRouter02 only resolves that
 * sentinel inside the swap functions, never in unwrapWETH9. These tests pin
 * the calldata shape so that overload can never be emitted again.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { decodeFunctionData, encodePacked, toFunctionSelector } from "viem";
import {
  ADDRESS_THIS,
  MSG_SENDER,
  ROUTER_ABI,
  UNWRAP_TO_RECIPIENT_SELECTOR,
  UNWRAP_TO_SENDER_SELECTOR,
  encodeExactInputSwap,
} from "../src/router.ts";

const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const RAM = "0x5173d45a1191ee33cbb7d8c7e65f21b04ed54802";

const usdgToWeth = encodePacked(["address", "uint24", "address"], [USDG, 100, WETH]);
const usdgToRam = encodePacked(["address", "uint24", "address", "uint24", "address"], [USDG, 500, WETH, 10000, RAM]);

const SELECTOR_LEN = 10; // "0x" + 4 bytes
const selectorsIn = (calls: readonly `0x${string}`[]) => calls.map((c) => c.slice(0, SELECTOR_LEN).toLowerCase());

function decodeMulticall(data: `0x${string}`) {
  const outer = decodeFunctionData({ abi: ROUTER_ABI, data });
  assert.equal(outer.functionName, "multicall");
  const [deadline, calls] = outer.args as readonly [bigint, readonly `0x${string}`[]];
  return { deadline, calls };
}

test("selectors match SwapRouter02", () => {
  assert.equal(toFunctionSelector("unwrapWETH9(uint256)"), UNWRAP_TO_SENDER_SELECTOR);
  assert.equal(toFunctionSelector("unwrapWETH9(uint256,address)"), UNWRAP_TO_RECIPIENT_SELECTOR);
});

test("the ABI cannot encode a recipient for unwrapWETH9", () => {
  const unwraps = ROUTER_ABI.filter((f) => f.name === "unwrapWETH9");
  assert.equal(unwraps.length, 1);
  assert.deepEqual(unwraps[0].inputs.map((i) => i.type), ["uint256"]);
});

test("native-ETH output: exactInput parks WETH in the router, then unwrapWETH9(min) pays msg.sender", () => {
  const data = encodeExactInputSwap({ path: usdgToWeth, amountIn: 900_000_000n, amountOutMinimum: 374_000_000_000_000_000n, nativeOut: true, deadline: 1_788_361_500n });
  const { deadline, calls } = decodeMulticall(data);
  assert.equal(deadline, 1_788_361_500n);
  assert.equal(calls.length, 2);

  const swap = decodeFunctionData({ abi: ROUTER_ABI, data: calls[0] });
  assert.equal(swap.functionName, "exactInput");
  const [params] = swap.args as readonly [{ path: string; recipient: string; amountIn: bigint; amountOutMinimum: bigint }];
  assert.equal(params.recipient.toLowerCase(), ADDRESS_THIS);
  assert.equal(params.path.toLowerCase(), usdgToWeth.toLowerCase());
  assert.equal(params.amountIn, 900_000_000n);
  assert.equal(params.amountOutMinimum, 374_000_000_000_000_000n);

  const unwrap = decodeFunctionData({ abi: ROUTER_ABI, data: calls[1] });
  assert.equal(unwrap.functionName, "unwrapWETH9");
  assert.deepEqual(unwrap.args, [374_000_000_000_000_000n]);
  assert.equal(calls[1].slice(0, SELECTOR_LEN), UNWRAP_TO_SENDER_SELECTOR);
  assert.equal(calls[1].length, SELECTOR_LEN + 64, "one word of arguments: no recipient");

  // The exact shape that burned the funds must be absent everywhere.
  assert.ok(!selectorsIn(calls).includes(UNWRAP_TO_RECIPIENT_SELECTOR));
  assert.ok(!data.toLowerCase().includes(UNWRAP_TO_RECIPIENT_SELECTOR.slice(2)));
});

test("token output: a single exactInput to MSG_SENDER, nothing to unwrap", () => {
  const data = encodeExactInputSwap({ path: usdgToRam, amountIn: 10_000_000n, amountOutMinimum: 75_000_000_000_000_000_000n, nativeOut: false, deadline: 1_788_361_000n });
  const { calls } = decodeMulticall(data);
  assert.equal(calls.length, 1);
  const swap = decodeFunctionData({ abi: ROUTER_ABI, data: calls[0] });
  assert.equal(swap.functionName, "exactInput");
  const [params] = swap.args as readonly [{ recipient: string }];
  assert.equal(params.recipient.toLowerCase(), MSG_SENDER);
  assert.ok(!data.toLowerCase().includes(UNWRAP_TO_RECIPIENT_SELECTOR.slice(2)));
});
