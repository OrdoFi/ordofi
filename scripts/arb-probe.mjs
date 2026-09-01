// Read-only probe of the cross-fee-tier arbitrage surface. No key, no sends —
// it simulates the same WETH -> token -> WETH cycles the arb bot trades and
// prints any positive round-trip edge, so we can see whether the strategy has
// anything to bite on right now.
import { encodeFunctionData, decodeFunctionResult, encodePacked, formatEther, parseEther } from "viem";
import { rpcFetch } from "@ordofi/core";

const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const QUOTER_V2 = "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7";
const ZERO = "0x0000000000000000000000000000000000000000";
const FEES = [100, 500, 3000, 10000];

const FACTORY_ABI = [{ type: "function", name: "getPool", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }], outputs: [{ type: "address" }] }];
const QUOTER_ABI = [{ type: "function", name: "quoteExactInput", stateMutability: "nonpayable", inputs: [{ type: "bytes" }, { type: "uint256" }], outputs: [{ type: "uint256" }, { type: "uint160[]" }, { type: "uint32[]" }, { type: "uint256" }] }];

const call = async (to, data) => rpcFetch("eth_call", [{ to, data }, "latest"]);
function encodePath(tokens, fees) {
  const types = [], values = [];
  tokens.forEach((t, i) => { types.push("address"); values.push(t); if (i < fees.length) { types.push("uint24"); values.push(fees[i]); } });
  return encodePacked(types, values);
}

// The actively-traded set, as reported by our own token endpoint.
const ACTIVE = [
  ["0x5fc5360d0400a0fd4f2af552add042d716f1d168", "USDG"],
  ["0x020bfc650a365f8bb26819deaabf3e21291018b4", "CASHCAT"],
  ["0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", "NVDA"],
  ["0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea", "SPCX"],
  ["0x39dbed3a2bd333467115de45665cc57f813c4571", "PONS"],
  ["0xaf3d76f1834a1d425780943c99ea8a608f8a93f9", "AAPL"],
  ["0x322f0929c4625ed5bad873c95208d54e1c003b2d", "TSLA"],
  ["0x117cc2133c37b721f49de2a7a74833232b3b4c0c", "SPY"],
  ["0xe93237c50d904957cf27e7b1133b510c669c2e74", "MSFT"],
  ["0xe934e36a439c94017b64a3fece66af12099abf50", "STONKBROKER"],
  ["0x1b0e319c6a659f002271b69db8a7df2f911c153e", "GME"],
  ["0x96765066f6a040a21eb027167d2315b707c82633", "RVH"],
  ["0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31", "VIRTUAL"],
  ["0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e", "GLD"],
  ["0xd5f3879160bc7c32ebb4dc785f8a4f505888de68", "QQQ"],
  ["0x5e81213613b6b86eab4c6c50d718d34359459786", "TTWO"],
  ["0x8005d266423c7ea827372c9c864491e5786600ea", "LLY"],
  ["0x2e8c31162b855a2ffa90f6f8634643ad6f111e18", "AI"],
  ["0x05a3d1cd21d0c88145e82600e62e7e496e0f222b", "AMC"],
];
async function mids() {
  return ACTIVE.map(([address, symbol]) => ({ address, symbol }));
}

async function poolTiers(a, b) {
  const tiers = [];
  for (const fee of FEES) {
    try {
      const out = await call(V3_FACTORY, encodeFunctionData({ abi: FACTORY_ABI, functionName: "getPool", args: [a, b, fee] }));
      if (decodeFunctionResult({ abi: FACTORY_ABI, functionName: "getPool", data: out }).toLowerCase() !== ZERO) tiers.push(fee);
    } catch {}
  }
  return tiers;
}

async function quote(tokens, fees, amt) {
  try {
    const out = await call(QUOTER_V2, encodeFunctionData({ abi: QUOTER_ABI, functionName: "quoteExactInput", args: [encodePath(tokens, fees), amt] }));
    return decodeFunctionResult({ abi: QUOTER_ABI, functionName: "quoteExactInput", data: out })[0];
  } catch { return null; }
}

const head = parseInt(await rpcFetch("eth_blockNumber", []), 16);
console.log(`probing at block ${head}`);
const universe = await mids();
const sizes = ["0.0005", "0.002", "0.008", "0.03"].map((s) => parseEther(s));
const wins = [];
let crossN = 0, triN = 0;

// WETH<->USDG tiers, reused as the first/last hop of triangular cycles.
const wethUsdgTiers = await poolTiers(WETH, USDG);

for (const { address, symbol } of universe) {
  const wethTiers = await poolTiers(WETH, address);

  // 1. cross-tier: WETH -fA-> M -fB-> WETH
  for (const fA of wethTiers) for (const fB of wethTiers) {
    if (fA === fB) continue;
    crossN++;
    for (const amt of sizes) {
      const out = await quote([WETH, address, WETH], [fA, fB], amt);
      if (out && out > amt) wins.push({ kind: "x", label: `${symbol} ${fA}->${fB}`, amt, gross: out - amt });
    }
  }

  // 2. triangular via USDG: WETH -> USDG -> M -> WETH and the reverse
  if (address === USDG) continue;
  const usdgTiers = await poolTiers(USDG, address);
  if (!usdgTiers.length || !wethTiers.length || !wethUsdgTiers.length) continue;
  const wu = wethUsdgTiers[0];
  for (const fu of usdgTiers) for (const fw of wethTiers) {
    triN += 2;
    for (const amt of sizes) {
      const fwd = await quote([WETH, USDG, address, WETH], [wu, fu, fw], amt);
      if (fwd && fwd > amt) wins.push({ kind: "tri", label: `WETH>USDG>${symbol}>WETH ${wu}/${fu}/${fw}`, amt, gross: fwd - amt });
      const rev = await quote([WETH, address, USDG, WETH], [fw, fu, wu], amt);
      if (rev && rev > amt) wins.push({ kind: "tri", label: `WETH>${symbol}>USDG>WETH ${fw}/${fu}/${wu}`, amt, gross: rev - amt });
    }
  }
}

console.log(`checked ${crossN} cross-tier + ${triN} triangular cycles across ${universe.length} mids`);
wins.sort((a, b) => (a.gross > b.gross ? -1 : 1));
if (!wins.length) console.log("no positive round-trip edge at any probed size right now");
for (const w of wins.slice(0, 15)) console.log(`  +${formatEther(w.gross)} ETH  [${w.kind}]  ${w.label}  size ${formatEther(w.amt)} ETH`);
