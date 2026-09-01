/**
 * Prove the hint pipeline against a live Robinhood Chain pool.
 *
 * Builds a real Uniswap v4 swap (ether in, token out) through Agen's router,
 * signs it with a throwaway key, and replays it through `eth_simulateV1` with
 * the sender's balance overridden. The transaction is never broadcast.
 *
 * What this demonstrates is the thing the old hint builder could not do: the
 * transaction is addressed to a *router*, and the hint still names the pool
 * behind it, its shape, and which way it moves — read out of simulated logs
 * rather than guessed from `tx.to`.
 *
 * Replaying an already-mined transaction is not an option here: the public
 * endpoint keeps no archive state ("metadata is not found"), so a historical
 * transaction can only be replayed at head, where its deadline has expired and
 * its input tokens are already spent.
 *
 *   node --import tsx apps/auction/test-hints.mjs
 */
import { encodeFunctionData, serializeTransaction, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { extractSwapHints, simulateTx } from "@ordofi/core/simulate";

const RPC = process.env.ORDO_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const CHAIN_ID = 4663;

// A live v4 market on Robinhood Chain: ether is currency0, the token is
// currency1, and the hook sets the fee dynamically.
const ROUTER = "0xFaf5734973329797fCD032fa80a8277E906c187A";
const POOL_KEY = {
  currency0: "0x0000000000000000000000000000000000000000",
  currency1: "0xBe92b334E045Bbfd292a28e54f8C75aF2FC07bBE",
  fee: 8388608, // DYNAMIC_FEE_FLAG
  tickSpacing: 200,
  hooks: "0xcf8f482e998d18793414d10c9Fc48fC8277Ab8CC",
};

const SWAP_ABI = [
  {
    name: "swap",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "key",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint128" },
      { name: "minAmountOut", type: "uint128" },
      { name: "extra", type: "bytes" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
];

let id = 0;
async function rpc(method, params) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const body = await res.json();
    if (body.error?.code === 429 && attempt < 6) {
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
      continue;
    }
    if (body.error) throw new Error(body.error.message);
    return body.result;
  }
}

const account = privateKeyToAccount(keccak256(toHex("ordofi-hint-probe")));
const amountIn = 10n ** 16n; // 0.01 ether

const data = encodeFunctionData({
  abi: SWAP_ABI,
  functionName: "swap",
  args: [POOL_KEY, true, amountIn, 1n, "0x"],
});

const tx = {
  type: "eip1559",
  chainId: CHAIN_ID,
  nonce: 0,
  to: ROUTER,
  value: amountIn,
  data,
  gas: 800_000n,
  maxFeePerGas: 100_000_000n,
  maxPriorityFeePerGas: 0n,
};

const signature = await account.signTransaction(tx);

console.log("simulating a live v4 swap, never broadcast");
console.log(`  sender     ${account.address} (throwaway, balance overridden)`);
console.log(`  to         ${ROUTER}  <- a router, not a pool`);
console.log(`  selector   ${data.slice(0, 10)}`);
console.log(`  value      ${amountIn} wei\n`);

const sim = await simulateTx(rpc, signature, { fundSender: true });

console.log(`  simulated  ok=${sim.ok} degraded=${sim.degraded} logs=${sim.logs.length} gas=${sim.gasUsed}`);
if (!sim.ok) {
  console.log(`  revert     ${sim.revertReason}`);
  process.exit(1);
}

const pools = extractSwapHints(sim.logs, "pools");
const full = extractSwapHints(sim.logs, "full");
const minimal = extractSwapHints(sim.logs, "minimal");

console.log(`\nhint at level "minimal": ${minimal.length} pools (calldata shape only)`);
console.log(`hint at level "pools"  : ${pools.length} pools`);
for (const h of pools) {
  console.log(`  ${h.kind.padEnd(6)} ${h.pool} ${h.direction} id=${h.poolId?.slice(0, 18)}…`);
  if (h.amount0 !== undefined) console.log("    LEAK: amounts present at the pools level");
}
console.log(`hint at level "full"   : amounts disclosed`);
for (const h of full) console.log(`  ${h.kind.padEnd(6)} ${h.pool} ${h.amount0} / ${h.amount1}`);

const ok =
  pools.length > 0 &&
  pools.every((h) => h.direction && h.amount0 === undefined) &&
  full.every((h) => h.amount0 !== undefined) &&
  minimal.length === 0 &&
  pools[0].pool !== ROUTER.toLowerCase();

console.log(
  `\n${ok ? "PASS" : "FAIL"} — pool named from logs, direction decoded, amounts withheld unless level=full`,
);
process.exit(ok ? 0 : 1);
