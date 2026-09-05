import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, parseAbi, type Hex } from "viem";
import { UNLIMITED, checkApproval, decodeApproval } from "../src/approvals.ts";

const ERC20 = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function increaseAllowance(address spender, uint256 added) returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

const TOKEN = "0x0bd7d308f8e1639fab988df18a8011f41eacad73" as Hex;
const DRAINER = "0xeed311af4b78d8b9c142082504c1f6e21041f709" as Hex;
const ROUTER = "0xcaf681a66d020601342297493863e78c959e5cb2" as Hex;
const ME = "0x9fdc67823988bf7acc68acd8c547e39b21162f65" as Hex;
const MAX = 2n ** 256n - 1n;

const approve = (spender: Hex, amount: bigint) =>
  encodeFunctionData({ abi: ERC20, functionName: "approve", args: [spender, amount] });

/** An upstream where only `contracts` have code. */
const chain = (contracts: Hex[]) => {
  const set = new Set(contracts.map((c) => c.toLowerCase()));
  let lookups = 0;
  const upstream = async (method: string, params: unknown[]) => {
    if (method !== "eth_getCode") throw new Error(`unexpected ${method}`);
    lookups++;
    return set.has(String(params[0]).toLowerCase()) ? "0x60806040" : "0x";
  };
  return { upstream, lookups: () => lookups };
};

describe("reading an approval out of calldata", () => {
  it("finds an unlimited approve", () => {
    const g = decodeApproval(approve(DRAINER, MAX))!;
    assert.equal(g.kind, "approve");
    assert.equal(g.spender, DRAINER);
    assert.equal(g.unlimited, true);
  });

  it("treats anything past half the word as unlimited, so the dodge does not work", () => {
    // A drainer asking for 2^255 rather than 2^256-1 shows a smaller number in
    // a wallet, and is still more than any balance will ever be.
    assert.equal(decodeApproval(approve(DRAINER, UNLIMITED))!.unlimited, true);
    assert.equal(decodeApproval(approve(DRAINER, UNLIMITED - 1n))!.unlimited, false);
  });

  it("sees a finite approval as finite", () => {
    const g = decodeApproval(approve(ROUTER, 10n ** 18n))!;
    assert.equal(g.unlimited, false);
    assert.equal(g.amount, 10n ** 18n);
  });

  it("reads increaseAllowance, which grants the same thing", () => {
    const d = encodeFunctionData({ abi: ERC20, functionName: "increaseAllowance", args: [DRAINER, MAX] });
    assert.equal(decodeApproval(d)!.kind, "increaseAllowance");
    assert.equal(decodeApproval(d)!.unlimited, true);
  });

  it("reads setApprovalForAll as unlimited, because it is", () => {
    const on = encodeFunctionData({ abi: ERC20, functionName: "setApprovalForAll", args: [DRAINER, true] });
    assert.equal(decodeApproval(on)!.unlimited, true);
    // Revoking is the opposite of dangerous.
    const off = encodeFunctionData({ abi: ERC20, functionName: "setApprovalForAll", args: [DRAINER, false] });
    assert.equal(decodeApproval(off), null);
  });

  it("is not interested in anything else", () => {
    assert.equal(decodeApproval(encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [DRAINER, MAX] })), null);
    assert.equal(decodeApproval("0x"), null);
    assert.equal(decodeApproval(undefined), null);
    assert.equal(decodeApproval("0x095ea7b3"), null, "a selector with no arguments is not an approval");
    assert.equal(decodeApproval(approve(DRAINER, MAX) + "deadbeef"), null, "trailing bytes: not this call");
  });
});

describe("the verdict", () => {
  it("refuses an unlimited allowance to a plain wallet", async () => {
    const { upstream } = chain([TOKEN]); // the spender has no code
    const v = await checkApproval(upstream, { to: TOKEN, data: approve(DRAINER, MAX) }, ME);
    assert.ok(v, "this is the shape every approval drain takes");
    assert.match(v.reason, /plain wallet, not a contract/);
    assert.match(v.reason, /entire balance/);
  });

  it("allows an unlimited allowance to a contract — that is ordinary dapp behaviour", async () => {
    const { upstream } = chain([TOKEN, ROUTER]);
    assert.equal(await checkApproval(upstream, { to: TOKEN, data: approve(ROUTER, MAX) }, ME), null);
  });

  it("allows a finite allowance to a wallet, which is the sender's business", async () => {
    // An OTC trade with a person is a real thing; a specific number is consent.
    const { upstream, lookups } = chain([TOKEN]);
    assert.equal(await checkApproval(upstream, { to: TOKEN, data: approve(DRAINER, 500n) }, ME), null);
    assert.equal(lookups(), 0, "and it costs nothing to decide");
  });

  it("costs no upstream call for a transaction that is not an approval", async () => {
    const { upstream, lookups } = chain([TOKEN]);
    const transfer = encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [ROUTER, 1n] });
    assert.equal(await checkApproval(upstream, { to: TOKEN, data: transfer }, ME), null);
    assert.equal(lookups(), 0, "the common path must not pay for this");
  });

  it("ignores an approval to yourself, which grants nothing", async () => {
    const { upstream, lookups } = chain([TOKEN]);
    assert.equal(await checkApproval(upstream, { to: TOKEN, data: approve(ME, MAX) }, ME), null);
    assert.equal(lookups(), 0);
  });

  it("refuses the zero address without needing to look it up", async () => {
    const { upstream, lookups } = chain([TOKEN]);
    const zero = ("0x" + "0".repeat(40)) as Hex;
    const v = await checkApproval(upstream, { to: TOKEN, data: approve(zero, MAX) }, ME);
    assert.ok(v);
    assert.match(v.reason, /zero address/);
    assert.equal(lookups(), 0);
  });

  it("sends the transaction when the check itself cannot be made", async () => {
    // An upstream hiccup must not become a refusal; failing open is right when
    // the alternative is blocking a transaction we know nothing bad about.
    const broken = async () => {
      throw new Error("upstream busy");
    };
    assert.equal(await checkApproval(broken, { to: TOKEN, data: approve(DRAINER, MAX) }, ME), null);
  });

  it("recognises the sender when the wallet reports it checksummed", async () => {
    // Calldata decodes lowercase; `from` arrives however the caller wrote it.
    const { upstream } = chain([TOKEN]);
    const checksummed = "0x9fdC67823988bf7AcC68aCd8c547E39b21162F65" as Hex;
    assert.equal(
      await checkApproval(upstream, { to: TOKEN, data: approve(ME, MAX) }, checksummed),
      null,
      "still you, so nothing is granted away",
    );
  });
});
