/**
 * The approval that empties a wallet, refused before it is signed away.
 *
 * The send path already refuses two things: a transaction that would revert,
 * and one that would pay an address nobody controls. Neither is how people
 * actually lose their money. They lose it to an approval — a transaction that
 * moves nothing at the time, costs a few cents of gas, succeeds, and hands a
 * stranger the right to take a token balance whenever they choose. Weeks can
 * pass between the signature and the theft, which is exactly why a warning in
 * a wallet does not work: there is nothing alarming on screen, so people click
 * through.
 *
 * One shape of it is not a judgement call. `approve(spender, 2^256-1)` where
 * `spender` has no code is a grant of an unlimited allowance to a plain wallet.
 * A contract needs an allowance to move your tokens on your behalf; a person
 * with an allowance can only do one thing with it, which is call transferFrom
 * and take them. No dapp needs this. Every drainer asks for exactly this.
 *
 * So that is what this refuses, and only that. The narrowness is the point:
 *
 *   - unlimited, not merely large. A specific allowance to a person can be an
 *     OTC trade, and that is theirs to make.
 *   - codeless, not unrecognised. We keep no list of good spenders — a
 *     blocklist is always behind, and an allowlist would refuse every protocol
 *     we have not heard of, which is most of them.
 *   - never the sender's own address, which grants nothing.
 *
 * The one honest false positive is a contract that has not been deployed yet,
 * addressed ahead of time through CREATE2. It is rare, it is refused, and
 * `ordo_sendRawTransaction` with `{ "allowUnlimitedApproval": true }` sends it
 * anyway — a caller who knows what the address will be can say so.
 */
import type { Hex } from "viem";
import { RpcError } from "./errors.js";

export type Upstream = (method: string, params: unknown[]) => Promise<any>;

/** approve(address,uint256) */
const APPROVE = "0x095ea7b3";
/** increaseAllowance(address,uint256) — the same grant, phrased as a delta. */
const INCREASE_ALLOWANCE = "0x39509351";
/** setApprovalForAll(address,bool) — the NFT equivalent, and always unlimited. */
const SET_APPROVAL_FOR_ALL = "0xa22cb465";

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * An allowance large enough that the exact number stopped mattering.
 *
 * Drainers ask for 2^256-1; some request 2^255 or a token's total supply so the
 * figure a wallet displays looks less alarming. Anything past half the word is
 * more than any real balance, so treating it as unlimited costs nothing and
 * closes the dodge.
 */
export const UNLIMITED = 2n ** 255n;

export interface ApprovalGrant {
  kind: "approve" | "increaseAllowance" | "setApprovalForAll";
  /** Who is being given the right to move the sender's tokens. */
  spender: Hex;
  /** The allowance granted. `setApprovalForAll(true)` is every token, so: unlimited. */
  amount: bigint;
  unlimited: boolean;
}

const word = (data: string, i: number): string => data.slice(10 + i * 64, 10 + (i + 1) * 64);

/**
 * Read an approval out of calldata, or null if this transaction is not one.
 *
 * Deliberately strict about length: a truncated call is not something to
 * interpret, and a call with trailing bytes is not one of these three.
 */
export function decodeApproval(data: string | undefined): ApprovalGrant | null {
  if (!data || data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase();
  const args = (data.length - 10) / 64;
  if (args !== 2) return null;

  const spender = ("0x" + word(data, 0).slice(24)).toLowerCase() as Hex;
  if (!/^0x[0-9a-f]{40}$/.test(spender)) return null;
  const raw = word(data, 1);
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) return null;

  if (selector === SET_APPROVAL_FOR_ALL) {
    const on = BigInt("0x" + raw) !== 0n;
    // Revoking is always safe; only the grant is worth stopping.
    if (!on) return null;
    return { kind: "setApprovalForAll", spender, amount: UNLIMITED, unlimited: true };
  }
  if (selector !== APPROVE && selector !== INCREASE_ALLOWANCE) return null;

  const amount = BigInt("0x" + raw);
  return {
    kind: selector === APPROVE ? "approve" : "increaseAllowance",
    spender,
    amount,
    unlimited: amount >= UNLIMITED,
  };
}

export interface ApprovalVerdict {
  grant: ApprovalGrant;
  /** What to tell the sender. */
  reason: string;
}

/**
 * Whether this transaction hands an unlimited allowance to something that
 * cannot be a protocol.
 *
 * Costs one `eth_getCode`, and only for a transaction that is an approval at
 * all — an ordinary send or swap never reaches the lookup. If the lookup fails
 * the transaction goes through: an upstream hiccup must not become a refusal.
 */
export async function checkApproval(
  upstream: Upstream,
  tx: { to?: Hex | null; data?: Hex },
  from: Hex,
): Promise<ApprovalVerdict | null> {
  const grant = decodeApproval(tx.data);
  if (!grant) return null;
  if (!grant.unlimited) return null;
  // Granting to yourself gives away nothing.
  if (grant.spender === from.toLowerCase()) return null;

  if (grant.spender === ZERO) {
    return {
      grant,
      reason: "the spender is the zero address, which cannot hold or spend anything",
    };
  }

  let code: string;
  try {
    code = (await upstream("eth_getCode", [grant.spender, "latest"])) as string;
  } catch {
    return null; // we could not check; not a reason to refuse
  }
  if (code && code !== "0x") return null; // a contract: this is ordinary dapp behaviour

  return {
    grant,
    reason:
      grant.kind === "setApprovalForAll"
        ? `it would let ${grant.spender} — a plain wallet, not a contract — transfer every one of your NFTs in this collection, at any time`
        : `it would let ${grant.spender} — a plain wallet, not a contract — take your entire balance of this token, at any time`,
  };
}

/** The refusal, in the same shape as the send path's other two. */
export function approvalRefusal(v: ApprovalVerdict, token: Hex | null): RpcError {
  return new RpcError(
    -32000,
    `ordo: transaction would grant an unlimited token allowance to a wallet, not submitted — ${v.reason}. ` +
      `This is how approval drains work: nothing moves now, and the allowance is spent later. ` +
      `If you meant to do this (an address that is not deployed yet, for instance), resend with ordo_sendRawTransaction and { "allowUnlimitedApproval": true }.`,
    {
      ordoProtected: true,
      check: "unlimitedApproval",
      token,
      spender: v.grant.spender,
      kind: v.grant.kind,
      spenderHasCode: false,
    },
  );
}
