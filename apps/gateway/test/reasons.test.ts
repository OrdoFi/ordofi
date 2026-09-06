import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeErrorResult, parseAbi } from "viem";
import { explainRevert, walletMessage } from "../src/reasons.ts";

const enc = (sig: string, args: unknown[]) => {
  const abi = parseAbi([sig]);
  const name = /error (\w+)/.exec(sig)![1];
  return encodeErrorResult({ abi, errorName: name, args });
};

test("Error(string) from the routers people use becomes advice, not a token", () => {
  assert.equal(explainRevert(enc("error Error(string)", ["Too little received"])), "Slippage too tight: the swap would return less than your minimum. Raise slippage a little or reduce the amount.");
  assert.equal(explainRevert(enc("error Error(string)", ["Transaction too old"])), "This quote has expired. Refresh and try again.");
  assert.equal(explainRevert(enc("error Error(string)", ["STF"])), "A token transfer into the pool failed. Usually the token is not approved for the router, or the balance is short.");
  assert.equal(explainRevert(enc("error Error(string)", ["Something bespoke"])), 'The contract reverted: "Something bespoke".');
});

test("Panic codes are named", () => {
  assert.match(explainRevert(enc("error Panic(uint256)", [0x11n]))!, /overflow or underflow/);
  assert.match(explainRevert(enc("error Panic(uint256)", [0x12n]))!, /division by zero/);
});

test("OpenZeppelin balance and allowance errors carry the numbers, in the token's units when known", () => {
  const bal = enc("error ERC20InsufficientBalance(address,uint256,uint256)", ["0x1111111111111111111111111111111111111111", 12_400_000n, 25_000_000n]);
  assert.equal(explainRevert(bal, { decimals: 6, symbol: "USDG" }), "Insufficient USDG balance: you have 12.4, this needs 25.");
  assert.match(explainRevert(bal)!, /12400000 \(smallest units\)/, "no decimals: raw, and says so");
  const allow = enc("error ERC20InsufficientAllowance(address,uint256,uint256)", ["0x2222222222222222222222222222222222222222", 0n, 5n * 10n ** 18n]);
  assert.match(explainRevert(allow, { decimals: 18 })!, /not approved .* may spend 0, this needs 5\. Approve it first/);
});

test("Ordo's own errors read as slippage and limits", () => {
  const tlr = enc("error TooLittleReceived(uint256,uint256)", [41_120n * 10n ** 18n, 41_500n * 10n ** 18n]);
  assert.equal(explainRevert(tlr, { decimals: 18, symbol: "X" }), "Slippage too tight: you'd receive 41,120 X but asked for at least 41,500. Raise slippage a little or reduce the amount.");
  const lim = enc("error LimitNotMet(bytes32,uint256,uint256)", [`0x${"11".repeat(32)}`, 9n * 10n ** 17n, 10n ** 18n]);
  assert.match(explainRevert(lim, { decimals: 18 })!, /would fill 0\.9, you asked for at least 1/);
});

test("Uniswap V4 errors", () => {
  assert.equal(explainRevert(enc("error HookCallFailed()", [])), "The pool's hook rejected this swap. The token's launchpad rules did not allow it.");
  const v4 = enc("error V4TooLittleReceived(uint256,uint256)", [100n, 90n]);
  assert.equal(explainRevert(v4), "Slippage too tight: you'd receive 10.0% less than your minimum. Set slippage to about 10.1% or reduce the amount.");
  const tiny = enc("error V4TooLittleReceived(uint256,uint256)", [10_000n, 9_955n]);
  assert.match(explainRevert(tiny)!, /0\.45% less than your minimum\. Set slippage to about 0\.6%/, "the number a user turns into a setting");
  const stale = enc("error V4TooLittleReceived(uint256,uint256)", [10n ** 27n, 10n ** 21n]);
  assert.match(explainRevert(stale)!, /almost nothing.*stale/);
});

test("unknown selectors are kept, never hidden; non-reverts are null", () => {
  assert.equal(explainRevert("0xdeadbeef00000000000000000000000000000000000000000000000000000000000000ff"), "The contract reverted (0xdeadbeef).");
  assert.equal(explainRevert("0x"), null);
  assert.equal(explainRevert(undefined), null);
  assert.equal(explainRevert({ nested: true }), null);
});

test("walletMessage prefers the decoded reason and strips provider branding otherwise", () => {
  assert.equal(walletMessage("execution reverted", enc("error Error(string)", ["Too little received"])), "Slippage too tight: the swap would return less than your minimum. Raise slippage a little or reduce the amount.");
  assert.equal(walletMessage("Block range limit exceeded, see https://docs.chainstack.com/limits", undefined), "Block range limit exceeded,");
  assert.equal(walletMessage("execution reverted", undefined), "execution reverted");
});

test("argument-less token errors: USDG's InsufficientFunds and friends", () => {
  assert.equal(explainRevert("0x356680b7"), "Insufficient token balance for this transaction.");
  assert.equal(explainRevert("0x356680b7", { symbol: "USDG" }), "Insufficient USDG balance for this transaction.");
  assert.equal(explainRevert("0x13be252b"), "The token is not approved for this contract. Approve it first.");
  assert.match(explainRevert("0x8199f5f3")!, /Slippage too tight/);
});
