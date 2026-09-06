/**
 * OrdoBatch (contracts/src/OrdoBatch.sol), as the batcher sees it: the calls it
 * makes, the revert it reads, and the EIP-712 shape users sign.
 */
import { parseAbi, type Hex } from "viem";

export const BATCH_ABI = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct Leg { uint8 venue; bytes path; PoolKey key; bool zeroForOne; }",
  "struct Interaction { Leg[] legs; uint256 amountIn; }",
  "struct Price { address token; uint256 price; }",
  "struct Order { address owner; address receiver; address sellToken; address buyToken; uint256 sellAmount; uint256 minBuyAmount; uint32 validTo; uint256 nonce; bytes32 appData; }",
  "function settle(Order[] orders, bytes[] signatures, Price[] prices, Interaction[] interactions)",
  "function simulate(Order[] orders, Price[] prices, Interaction[] interactions)",
  "function orderHash(Order o) view returns (bytes32)",
  "function nonceUsed(address owner, uint256 nonce) view returns (bool)",
  "function escrowed(bytes32 orderHash) view returns (uint256)",
  "function solver() view returns (address)",
  "function maxFeeBps() view returns (uint16)",
  "error SimResult(address[] tokens, int256[] delta, uint256[] owed, uint256[] buyAmounts)",
  "error LimitNotMet(bytes32 orderHash, uint256 buyAmount, uint256 minBuyAmount)",
  "error ContractLostFunds(address token, uint256 before, uint256 after_)",
  "error FeeAboveCap(address token, uint256 fee, uint256 cap)",
  "error NonceUsed(address owner, uint256 nonce)",
  "error Expired(bytes32 orderHash)",
  "error BadSignature(bytes32 orderHash)",
  "event Trade(bytes32 indexed orderHash, address indexed owner, address sellToken, address buyToken, uint256 sellAmount, uint256 buyAmount, bytes32 appData)",
  "event Settled(address indexed solver, uint256 orders, uint256 interactions)",
  "event Fee(address indexed token, uint256 amount)",
]);

export const ERC20_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
]);

export const ORDER_TYPES = {
  Order: [
    { name: "owner", type: "address" },
    { name: "receiver", type: "address" },
    { name: "sellToken", type: "address" },
    { name: "buyToken", type: "address" },
    { name: "sellAmount", type: "uint256" },
    { name: "minBuyAmount", type: "uint256" },
    { name: "validTo", type: "uint32" },
    { name: "nonce", type: "uint256" },
    { name: "appData", type: "bytes32" },
  ],
} as const;

export function domain(chainId: number, verifyingContract: Hex) {
  return { name: "OrdoBatch", version: "1", chainId, verifyingContract } as const;
}
