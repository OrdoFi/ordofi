/**
 * Uniswap SwapRouter02 on Robinhood Chain — the one place that encodes swap
 * calldata for the web app and the house bots.
 *
 * SwapRouter02 has two recipient sentinels: MSG_SENDER (address(1)) and
 * ADDRESS_THIS (address(2)). They are resolved ONLY inside the swap functions
 * (exactInput*, exactOutput*, swapExactTokensForTokens, ...). The payment
 * helpers inherited from v3-periphery — unwrapWETH9(uint256,address),
 * sweepToken(address,uint256,address), refundETH — take their recipient
 * literally, so a sentinel there sends the money to a precompile nobody
 * controls. A trader lost 0.376 ETH that way on 2026-09-02 (tx
 * 0x83762837ee2c1a285b65598724baaddf4e6182ed5b0ae66eb5ca67b18ffd2364).
 *
 * The ABI below therefore exposes only the overloads that pay msg.sender.
 * Do not add unwrapWETH9(uint256,address) or sweepToken(address,uint256,address)
 * back without a real, caller-supplied recipient.
 */
import { encodeFunctionData, type Hex } from "viem";

/** SwapRouter02 (canonical Robinhood Chain deployment). */
export const ROUTER: Hex = "0xcaf681a66d020601342297493863e78c959e5cb2";
/** Resolved to msg.sender by the swap functions — and by nothing else. */
export const MSG_SENDER: Hex = "0x0000000000000000000000000000000000000001";
/** Resolved to the router itself by the swap functions — and by nothing else. */
export const ADDRESS_THIS: Hex = "0x0000000000000000000000000000000000000002";

/** unwrapWETH9(uint256): pays msg.sender. */
export const UNWRAP_TO_SENDER_SELECTOR = "0x49616997";
/** unwrapWETH9(uint256,address): pays the literal address. Never emitted here. */
export const UNWRAP_TO_RECIPIENT_SELECTOR = "0x49404b7c";

export const ROUTER_ABI = [
  {
    type: "function",
    name: "multicall",
    stateMutability: "payable",
    inputs: [
      { type: "uint256", name: "deadline" },
      { type: "bytes[]", name: "data" },
    ],
    outputs: [{ type: "bytes[]" }],
  },
  {
    type: "function",
    name: "exactInput",
    stateMutability: "payable",
    inputs: [
      {
        type: "tuple",
        name: "params",
        components: [
          { type: "bytes", name: "path" },
          { type: "address", name: "recipient" },
          { type: "uint256", name: "amountIn" },
          { type: "uint256", name: "amountOutMinimum" },
        ],
      },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "unwrapWETH9",
    stateMutability: "payable",
    inputs: [{ type: "uint256", name: "amountMinimum" }],
    outputs: [],
  },
] as const;

export interface ExactInputSwap {
  /** Packed V3 path: token, fee, token, ... Must end in WETH when nativeOut. */
  path: Hex;
  amountIn: bigint;
  amountOutMinimum: bigint;
  /** Pay the trader in native ETH instead of the path's last token. */
  nativeOut: boolean;
  /** Unix seconds. */
  deadline: bigint;
}

/**
 * multicall(deadline, [exactInput, unwrapWETH9?]) whose proceeds go to
 * msg.sender, so the calldata is safe to build without knowing the wallet.
 *
 * Token output: exactInput pays MSG_SENDER, which the router resolves.
 * Native output: exactInput parks the WETH in the router (ADDRESS_THIS), then
 * unwrapWETH9(amountMinimum) withdraws it and pays msg.sender in ETH.
 */
export function encodeExactInputSwap(swap: ExactInputSwap): Hex {
  const exactInput = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "exactInput",
    args: [
      {
        path: swap.path,
        recipient: swap.nativeOut ? ADDRESS_THIS : MSG_SENDER,
        amountIn: swap.amountIn,
        amountOutMinimum: swap.amountOutMinimum,
      },
    ],
  });
  const calls: Hex[] = [exactInput];
  if (swap.nativeOut) {
    calls.push(encodeFunctionData({ abi: ROUTER_ABI, functionName: "unwrapWETH9", args: [swap.amountOutMinimum] }));
  }
  return encodeFunctionData({ abi: ROUTER_ABI, functionName: "multicall", args: [swap.deadline, calls] });
}
