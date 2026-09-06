/**
 * Why a transaction would fail, in words.
 *
 * When a wallet estimates gas or a dapp calls eth_call and the call reverts,
 * the node answers with the revert's ABI-encoded data and, at best, the text
 * "execution reverted". MetaMask shows whatever message the RPC returns. So
 * the user reads `0x8f6d…` or "this transaction is likely to fail", and has
 * no idea whether to raise slippage, approve a token, or top up.
 *
 * We already carry the revert data through the gateway. This decodes it: the
 * two standard shapes (`Error(string)`, `Panic(uint256)`), the strings the
 * routers people use actually emit, and the custom errors of the contracts a
 * swap on this chain touches — OpenZeppelin tokens, Permit2, Uniswap V4's
 * PoolManager, and ours. Anything unknown keeps its selector so nothing is
 * hidden; anything known becomes a sentence with the numbers in it.
 */
import { decodeErrorResult, formatUnits, parseAbi, type Hex } from "viem";

const KNOWN = parseAbi([
  // OpenZeppelin ERC-20 (v5)
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC20InvalidReceiver(address receiver)",
  "error ERC20InvalidSender(address sender)",
  "error ERC20InvalidSpender(address spender)",
  // Permit2
  "error AllowanceExpired(uint256 deadline)",
  "error InsufficientAllowance(uint256 amount)",
  "error InvalidNonce()",
  "error SignatureExpired(uint256 signatureDeadline)",
  // Uniswap V4 PoolManager / periphery
  "error PoolNotInitialized()",
  "error SwapAmountCannotBeZero()",
  "error PriceLimitAlreadyExceeded(uint160 sqrtPriceCurrentX96, uint160 sqrtPriceLimitX96)",
  "error PriceLimitOutOfBounds(uint160 sqrtPriceLimitX96)",
  "error CurrencyNotSettled()",
  "error ManagerLocked()",
  "error HookCallFailed()",
  "error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)",
  "error V4TooMuchRequested(uint256 maxAmountInRequested, uint256 amountRequested)",
  "error DeadlinePassed(uint256 deadline)",
  // Ordo
  "error TooLittleReceived(uint256 amountOut, uint256 minimum)",
  "error InsufficientGasForReclaim(uint256 left, uint256 needed)",
  "error LimitNotMet(bytes32 orderHash, uint256 buyAmount, uint256 minBuyAmount)",
  "error Expired(bytes32 orderHash)",
  "error NonceUsed(address owner, uint256 nonce)",
  "error LegMismatch(uint256 index, address produced, address declared)",
  "error FloatTouched(uint256 before, uint256 after_)",
  "error FeeAboveCap(address token, uint256 fee, uint256 cap)",
  "error ContractLostFunds(address token, uint256 before, uint256 after_)",
  "error BadSignature(bytes32 orderHash)",
]);

/** The revert strings routers and tokens actually emit, and what they mean to a person. */
const STRINGS: [RegExp, string][] = [
  [/^Too little received$/i, "Slippage too tight: the swap would return less than your minimum. Raise slippage a little or reduce the amount."],
  [/^Too much requested$/i, "Slippage too tight: the swap would cost more than your maximum. Raise slippage a little or reduce the amount."],
  [/^Transaction too old$/i, "This quote has expired. Refresh and try again."],
  [/^STF$/, "A token transfer into the pool failed. Usually the token is not approved for the router, or the balance is short."],
  [/^TF$/, "A token transfer failed. Usually the balance is short, or the token blocks transfers."],
  [/^SPL$/, "The swap would push the price past the pool's limit. Reduce the amount."],
  [/^IIA$/, "Insufficient input amount: the token sent less than the pool expected. Fee-on-transfer tokens do this; try a smaller amount."],
  [/^LOK$/, "The pool is locked by another operation in this same transaction."],
  [/^ERC20: transfer amount exceeds balance$/i, "Insufficient token balance for this transfer."],
  [/^ERC20: insufficient allowance$/i, "The token is not approved for this contract. Approve it first."],
  [/^ERC20: transfer amount exceeds allowance$/i, "The token is not approved for this amount. Approve it first."],
  [/^ERC20: burn amount exceeds balance$/i, "Insufficient token balance."],
  [/^UniswapV2: INSUFFICIENT_OUTPUT_AMOUNT$/, "Slippage too tight: the swap would return less than your minimum. Raise slippage a little or reduce the amount."],
  [/^UniswapV2: INSUFFICIENT_LIQUIDITY$/, "The pool does not have enough liquidity for this amount."],
  [/^UniswapV2: EXPIRED$/, "This quote has expired. Refresh and try again."],
];

const PANICS: Record<number, string> = {
  0x01: "an assertion in the contract failed",
  0x11: "an arithmetic overflow or underflow in the contract — usually an amount larger than a balance",
  0x12: "a division by zero in the contract",
  0x21: "an invalid enum value",
  0x22: "corrupted storage",
  0x31: "pop on an empty array",
  0x32: "an array index out of bounds",
  0x41: "the contract ran out of memory",
  0x51: "a call to an uninitialised function",
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const num = (v: bigint, decimals = 18) => {
  const s = formatUnits(v, decimals);
  const n = Number(s);
  return Number.isFinite(n) && n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : s.replace(/(\.\d{6})\d+$/, "$1");
};

/** Amounts in a custom error come in the token's own units; without decimals they are shown raw with a note. */
function amount(v: bigint, decimals?: number): string {
  return decimals === undefined ? `${v.toString()} (smallest units)` : num(v, decimals);
}

/**
 * A slippage miss, as a sentence. With decimals, the two amounts; without,
 * the shortfall as a percentage — which needs no units and is the number the
 * user actually turns into a slippage setting.
 */
function slippage(got: bigint, wanted: bigint, ctx: RevertContext): string {
  const sym = ctx.symbol ? ` ${ctx.symbol}` : "";
  if (ctx.decimals !== undefined) {
    return `Slippage too tight: you'd receive ${num(got, ctx.decimals)}${sym} but asked for at least ${num(wanted, ctx.decimals)}. Raise slippage a little or reduce the amount.`;
  }
  if (wanted <= 0n) return "Slippage too tight: the swap would return less than your minimum. Raise slippage a little or reduce the amount.";
  const shortBps = ((wanted - got) * 10_000n) / wanted;
  const pct = Number(shortBps) / 100;
  if (pct >= 99) return "The swap would return almost nothing against your minimum — the quote is stale or the amounts are wrong. Refresh and try again.";
  return `Slippage too tight: you'd receive ${pct < 0.01 ? "under 0.01" : pct.toFixed(pct < 1 ? 2 : 1)}% less than your minimum. Set slippage to about ${Math.max(0.1, Math.ceil(pct * 10 + 1) / 10).toFixed(1)}% or reduce the amount.`;
}

export interface RevertContext {
  /** Decimals of the token the error is about, when the caller knows. */
  decimals?: number;
  /** Symbol of that token. */
  symbol?: string;
}

/**
 * A sentence for this revert, or null if the data is not a revert we can
 * read. The selector of an unknown custom error is kept in the sentence so
 * nothing is hidden; the raw data still travels in the error's `data`.
 */
export function explainRevert(data: unknown, ctx: RevertContext = {}): string | null {
  const hex = pickHex(data);
  if (!hex || hex.length < 10) return null;
  const sym = ctx.symbol ? ` ${ctx.symbol}` : "";

  let d: { errorName: string; args?: readonly unknown[] };
  try {
    d = decodeErrorResult({ abi: KNOWN, data: hex }) as { errorName: string; args?: readonly unknown[] };
  } catch {
    // Not one of ours; the standard shapes need no ABI.
    return standardShape(hex);
  }
  const a = (d.args ?? []) as any[];
  switch (d.errorName) {
    case "Error":
      return stringReason(String(a[0] ?? ""));
    case "Panic":
      return panicReason(Number(a[0] ?? 0));
    case "ERC20InsufficientBalance":
      return `Insufficient${sym} balance: you have ${amount(a[1], ctx.decimals)}, this needs ${amount(a[2], ctx.decimals)}.`;
    case "ERC20InsufficientAllowance":
      return `The token is not approved for this amount: ${short(a[0])} may spend ${amount(a[1], ctx.decimals)}, this needs ${amount(a[2], ctx.decimals)}. Approve it first.`;
    case "ERC20InvalidReceiver":
      return `The token refuses to be sent to ${short(a[0])}.`;
    case "ERC20InvalidSender":
    case "ERC20InvalidSpender":
      return `The token refuses this ${d.errorName === "ERC20InvalidSender" ? "sender" : "spender"} (${short(a[0])}).`;
    case "AllowanceExpired":
      return `Your Permit2 approval for this token expired at ${when(a[0])}. Approve it again.`;
    case "InsufficientAllowance":
      return `Your Permit2 approval covers only ${amount(a[0], ctx.decimals)} of this token. Approve more.`;
    case "InvalidNonce":
      return "This permit has already been used. Sign a fresh one.";
    case "SignatureExpired":
      return `This signature expired at ${when(a[0])}. Sign again.`;
    case "PoolNotInitialized":
      return "This pool does not exist yet.";
    case "SwapAmountCannotBeZero":
      return "The swap amount is zero.";
    case "PriceLimitAlreadyExceeded":
    case "PriceLimitOutOfBounds":
      return "The price limit on this swap is already past the pool's price. Refresh the quote.";
    case "CurrencyNotSettled":
    case "ManagerLocked":
      return "The pool's accounting did not balance inside this transaction — a routing bug, not something you did.";
    case "HookCallFailed":
      return "The pool's hook rejected this swap. The token's launchpad rules did not allow it.";
    case "V4TooLittleReceived":
      return slippage(a[1], a[0], ctx);
    case "V4TooMuchRequested":
      return `Slippage too tight: this would cost ${amount(a[1], ctx.decimals)}${sym}, more than your maximum of ${amount(a[0], ctx.decimals)}.`;
    case "DeadlinePassed":
      return `This quote expired at ${when(a[0])}. Refresh and try again.`;
    case "TooLittleReceived":
      return slippage(a[0], a[1], ctx);
    case "InsufficientGasForReclaim":
      return `Not enough gas for the back-run: ${a[0]} left, ${a[1]} needed. Raise the gas limit.`;
    case "LimitNotMet":
      return `The batch price does not reach your limit: it would fill ${amount(a[1], ctx.decimals)}${sym}, you asked for at least ${amount(a[2], ctx.decimals)}.`;
    case "Expired":
      return "This order has expired.";
    case "NonceUsed":
      return "This order's nonce was already used or cancelled.";
    case "BadSignature":
      return "The order's signature does not match its owner.";
    case "LegMismatch":
    case "FloatTouched":
    case "FeeAboveCap":
    case "ContractLostFunds":
      return `The route was refused by a safety check (${d.errorName}). Nothing was sent.`;
    default:
      return standardShape(hex) ?? `The contract reverted with ${d.errorName}.`;
  }
}

/** `Error(string)` and `Panic(uint256)` without needing them in the ABI list. */
function standardShape(hex: Hex): string | null {
  const sel = hex.slice(0, 10).toLowerCase();
  try {
    if (sel === "0x08c379a0") {
      const d = decodeErrorResult({ abi: parseAbi(["error Error(string)"]), data: hex });
      return stringReason(String((d.args as readonly unknown[])[0] ?? ""));
    }
    if (sel === "0x4e487b71") {
      const d = decodeErrorResult({ abi: parseAbi(["error Panic(uint256)"]), data: hex });
      return panicReason(Number((d.args as readonly unknown[])[0] ?? 0));
    }
  } catch {
    return null;
  }
  return hex === "0x" ? null : `The contract reverted (${sel}).`;
}

function stringReason(s: string): string {
  const t = s.trim();
  if (!t) return "The contract reverted without a reason.";
  for (const [re, why] of STRINGS) if (re.test(t)) return why;
  return `The contract reverted: "${t}".`;
}

function panicReason(code: number): string {
  return `The contract hit ${PANICS[code] ?? `panic 0x${code.toString(16)}`}.`;
}

function when(ts: unknown): string {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "an earlier time";
  const ago = Math.round(Date.now() / 1000 - n);
  return ago > 0 ? `${ago >= 3600 ? Math.round(ago / 3600) + "h" : ago >= 60 ? Math.round(ago / 60) + "m" : ago + "s"} ago` : "a time in the future";
}

/** Providers put revert bytes in several places; find them. */
function pickHex(data: unknown): Hex | null {
  const cands = [data, (data as { data?: unknown })?.data, (data as { originalError?: { data?: unknown } })?.originalError?.data];
  for (const c of cands) if (typeof c === "string" && /^0x[0-9a-fA-F]*$/.test(c)) return c as Hex;
  return null;
}

/**
 * The message a wallet should show: the decoded reason when there is one,
 * otherwise the upstream's own text. Provider branding ("see docs.provider.com")
 * is not a fact about the transaction and is trimmed.
 */
export function walletMessage(upstreamMessage: string, data: unknown, ctx: RevertContext = {}): string {
  const why = explainRevert(data, ctx);
  if (why) return why;
  return upstreamMessage.replace(/\s*[—-]?\s*see https?:\/\/\S+/i, "").trim();
}
