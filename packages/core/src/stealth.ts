import { secp256k1 } from "@noble/curves/secp256k1";
import { concatHex, getAddress, keccak256, pad, toHex, type Hex } from "viem";

/**
 * ERC-5564 stealth addresses for Robinhood Chain.
 *
 * The problem this solves is narrow and worth stating precisely. Every transfer
 * on this chain is public: amount, sender, recipient, forever. Publishing one
 * address to be paid at therefore publishes your whole balance and payment
 * history to anyone who has it. Stealth addresses fix exactly that and nothing
 * else — the payer derives a brand new address for every payment, one only the
 * recipient can spend from, so the payments are unlinkable to the published
 * identity even though each of them is still fully public.
 *
 * What it is not: a mixer. No funds are pooled, nothing is shared between
 * users, and there is no anonymity set to hide inside. The sender is as visible
 * as ever. This is recipient privacy, the same construction Umbra and Fluidkey
 * use, and it is unilateral — it needs no permission and no counterparty.
 *
 * The scheme (SECP256k1 with view tags, scheme id 1):
 *
 *   The recipient holds two keys, spending (p_spend) and viewing (p_view), and
 *   publishes the two public keys as one meta-address.
 *
 *   To pay, the sender rolls an ephemeral key r, computes the shared secret
 *   S = r * P_view, and derives the stealth address from P_spend + h(S) * G.
 *   They publish r * G — the ephemeral public key — in an Announcement event.
 *
 *   To find it, the recipient recomputes S = p_view * R for each announcement
 *   and checks whether the derived address matches. Only the holder of p_spend
 *   can produce the private key p_spend + h(S), so the viewing key can be given
 *   to a watcher without giving away the ability to spend.
 *
 * The view tag is the first byte of h(S). It is published alongside, and lets a
 * scanner discard 255 of every 256 announcements with one hash instead of a
 * full point addition, which is the difference between scanning being instant
 * and scanning being a chore.
 */

/** ERC-5564 SECP256k1 with view tags. */
export const SCHEME_ID = 1n;

/**
 * The message whose signature is the stealth account.
 *
 * Every byte of it is load-bearing: change one and every user's keys change
 * with it, and their funds become unreachable through this app. It is versioned
 * so that if it ever must change, the old account can still be recovered.
 */
export const UNLOCK_MESSAGE =
  "OrdoFi Stealth\n\nSign to derive your stealth keys for Robinhood Chain.\n\n" +
  "This signature is free, costs no gas, and never moves funds. It is the only\n" +
  "thing that can recreate your stealth account, so only sign it on ordofi.network.\n\nVersion: 1";

/** Canonical singletons, at the same addresses on every chain they exist on. */
export const ERC5564_ANNOUNCER = "0x55649E01B5Df198D18D95b5cc5051630cfD45564" as const;
export const ERC6538_REGISTRY = "0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538" as const;

/** Sentinel used in announcement metadata for the chain's native currency. */
export const NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as const;

export const ANNOUNCER_ABI = [
  {
    type: "function",
    name: "announce",
    stateMutability: "nonpayable",
    inputs: [
      { name: "schemeId", type: "uint256" },
      { name: "stealthAddress", type: "address" },
      { name: "ephemeralPubKey", type: "bytes" },
      { name: "metadata", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "Announcement",
    inputs: [
      { name: "schemeId", type: "uint256", indexed: true },
      { name: "stealthAddress", type: "address", indexed: true },
      { name: "caller", type: "address", indexed: true },
      { name: "ephemeralPubKey", type: "bytes", indexed: false },
      { name: "metadata", type: "bytes", indexed: false },
    ],
  },
] as const;

export const REGISTRY_ABI = [
  {
    type: "function",
    name: "registerKeys",
    stateMutability: "nonpayable",
    inputs: [
      { name: "schemeId", type: "uint256" },
      { name: "stealthMetaAddress", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "stealthMetaAddressOf",
    stateMutability: "view",
    inputs: [
      { name: "registrant", type: "address" },
      { name: "schemeId", type: "uint256" },
    ],
    outputs: [{ type: "bytes" }],
  },
] as const;

const N = secp256k1.CURVE.n;

export interface StealthKeys {
  spendingPrivateKey: Hex;
  viewingPrivateKey: Hex;
  spendingPublicKey: Hex;
  viewingPublicKey: Hex;
  metaAddress: string;
}

const hexToBytes = (h: Hex | string): Uint8Array => {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};

const bytesToHex = (b: Uint8Array): Hex =>
  ("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")) as Hex;

/** A scalar in [1, n-1]. Reducing mod n keeps a hash usable as a key. */
function toScalar(h: Hex): bigint {
  const v = BigInt(h) % N;
  if (v === 0n) throw new Error("degenerate scalar");
  return v;
}

const scalarToHex = (v: bigint): Hex => pad(toHex(v), { size: 32 });

/** The 20-byte address of an uncompressed public key. */
export function publicKeyToAddress(uncompressed: Uint8Array): Hex {
  const body = uncompressed.length === 65 ? uncompressed.slice(1) : uncompressed;
  return getAddress(("0x" + keccak256(bytesToHex(body)).slice(-40)) as Hex);
}

/**
 * Both keys from one wallet signature.
 *
 * Deriving from a signature rather than storing new keys means the account is
 * recoverable from the wallet alone: nothing to back up, nothing to lose. ECDSA
 * in every wallet is deterministic (RFC 6979), so the same wallet signing the
 * same message always reproduces the same stealth account.
 */
export function keysFromSignature(signature: Hex): StealthKeys {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("expected a 65-byte signature");
  const seed = keccak256(signature);
  const spending = toScalar(keccak256(concatHex([seed, "0x00"])));
  const viewing = toScalar(keccak256(concatHex([seed, "0x01"])));
  return fromPrivateKeys(scalarToHex(spending), scalarToHex(viewing));
}

export function fromPrivateKeys(spendingPrivateKey: Hex, viewingPrivateKey: Hex): StealthKeys {
  const spendingPublicKey = bytesToHex(secp256k1.getPublicKey(hexToBytes(spendingPrivateKey), true));
  const viewingPublicKey = bytesToHex(secp256k1.getPublicKey(hexToBytes(viewingPrivateKey), true));
  return {
    spendingPrivateKey,
    viewingPrivateKey,
    spendingPublicKey,
    viewingPublicKey,
    metaAddress: encodeMetaAddress(spendingPublicKey, viewingPublicKey),
  };
}

/** `st:rho:0x<33-byte spending key><33-byte viewing key>`. */
export function encodeMetaAddress(spendingPublicKey: Hex, viewingPublicKey: Hex): string {
  return `st:rho:0x${spendingPublicKey.slice(2)}${viewingPublicKey.slice(2)}`;
}

/**
 * Accepts our own prefix and the `st:eth:` one other tools emit: the keys are
 * plain secp256k1 either way, so refusing a Fluidkey meta-address would be
 * pedantry rather than safety.
 */
export function parseMetaAddress(meta: string): { spendingPublicKey: Hex; viewingPublicKey: Hex } {
  const body = meta.trim().replace(/^st:[a-z0-9]+:/i, "");
  if (!/^0x[0-9a-fA-F]{132}$/.test(body)) throw new Error("not a stealth meta-address");
  const spendingPublicKey = ("0x" + body.slice(2, 68)) as Hex;
  const viewingPublicKey = ("0x" + body.slice(68, 134)) as Hex;
  for (const k of [spendingPublicKey, viewingPublicKey]) {
    try {
      secp256k1.ProjectivePoint.fromHex(k.slice(2));
    } catch {
      throw new Error("meta-address contains a key that is not on the curve");
    }
  }
  return { spendingPublicKey, viewingPublicKey };
}

/** Raw bytes of the meta-address, which is what ERC-6538 stores. */
export function metaAddressBytes(spendingPublicKey: Hex, viewingPublicKey: Hex): Hex {
  return concatHex([spendingPublicKey, viewingPublicKey]);
}

/** h(S), where S is the shared secret point. Both sides must agree exactly. */
function sharedSecretHash(privateKey: Hex, publicKey: Hex): Hex {
  const shared = secp256k1.getSharedSecret(hexToBytes(privateKey), hexToBytes(publicKey), true);
  // Drop the parity prefix and hash the x-coordinate, matching the reference
  // ERC-5564 implementation so addresses agree with other wallets.
  return keccak256(bytesToHex(shared.slice(1)));
}

export interface StealthPayment {
  stealthAddress: Hex;
  ephemeralPublicKey: Hex;
  viewTag: number;
}

/** Derive a fresh one-time address to pay a meta-address at. */
export function generateStealthAddress(
  metaAddress: string,
  ephemeralPrivateKey?: Hex,
): StealthPayment & { ephemeralPrivateKey: Hex } {
  const { spendingPublicKey, viewingPublicKey } = parseMetaAddress(metaAddress);
  const ephemeral = ephemeralPrivateKey ?? bytesToHex(secp256k1.utils.randomPrivateKey());
  const hashed = sharedSecretHash(ephemeral, viewingPublicKey);
  const stealthPoint = secp256k1.ProjectivePoint.fromHex(spendingPublicKey.slice(2)).add(
    secp256k1.ProjectivePoint.BASE.multiply(toScalar(hashed)),
  );
  return {
    stealthAddress: publicKeyToAddress(stealthPoint.toRawBytes(false)),
    ephemeralPublicKey: bytesToHex(secp256k1.getPublicKey(hexToBytes(ephemeral), true)),
    ephemeralPrivateKey: ephemeral,
    viewTag: Number("0x" + hashed.slice(2, 4)),
  };
}

/**
 * Is this announcement ours?
 *
 * The view tag is one byte, so roughly one foreign announcement in 256 passes
 * it. It is a filter, never proof: the address we derive is compared against
 * the address that was actually announced, and only an exact match counts. The
 * announced address is therefore a required argument rather than something the
 * caller is trusted to check afterwards.
 */
export function checkAnnouncement(
  keys: Pick<StealthKeys, "viewingPrivateKey" | "spendingPublicKey">,
  announcement: { stealthAddress: string; ephemeralPublicKey: Hex; viewTag?: number },
): Hex | null {
  let hashed: Hex;
  try {
    hashed = sharedSecretHash(keys.viewingPrivateKey, announcement.ephemeralPublicKey);
  } catch {
    return null; // not a point on the curve; not addressed to anyone
  }
  if (announcement.viewTag !== undefined && Number("0x" + hashed.slice(2, 4)) !== announcement.viewTag) return null;
  const stealthPoint = secp256k1.ProjectivePoint.fromHex(keys.spendingPublicKey.slice(2)).add(
    secp256k1.ProjectivePoint.BASE.multiply(toScalar(hashed)),
  );
  const derived = publicKeyToAddress(stealthPoint.toRawBytes(false));
  return derived.toLowerCase() === announcement.stealthAddress.toLowerCase() ? derived : null;
}

/** The key that can spend a stealth address. Requires the spending key. */
export function computeStealthPrivateKey(
  keys: Pick<StealthKeys, "spendingPrivateKey" | "viewingPrivateKey">,
  ephemeralPublicKey: Hex,
): Hex {
  const hashed = sharedSecretHash(keys.viewingPrivateKey, ephemeralPublicKey);
  const key = (BigInt(keys.spendingPrivateKey) + toScalar(hashed)) % N;
  if (key === 0n) throw new Error("degenerate stealth key");
  return scalarToHex(key);
}

export interface AnnouncementMetadata {
  viewTag: number;
  token: Hex;
  amount: bigint;
}

/**
 * Metadata layout: view tag, then what was actually sent.
 *
 * ERC-5564 leaves the bytes after the view tag to the application. Describing
 * the transfer here means a recipient's scan can show "0.5 ETH" straight from
 * the event, instead of probing every candidate address for a balance.
 */
export function encodeMetadata({ viewTag, token, amount }: AnnouncementMetadata): Hex {
  return concatHex([
    pad(toHex(viewTag), { size: 1 }),
    getAddress(token) as Hex,
    pad(toHex(amount), { size: 32 }),
  ]);
}

export function decodeMetadata(metadata: Hex): AnnouncementMetadata | null {
  const body = metadata.startsWith("0x") ? metadata.slice(2) : metadata;
  if (body.length < 2) return null;
  const viewTag = parseInt(body.slice(0, 2), 16);
  if (body.length < 2 + 40 + 64) return { viewTag, token: NATIVE_TOKEN, amount: 0n };
  return {
    viewTag,
    token: getAddress("0x" + body.slice(2, 42)) as Hex,
    amount: BigInt("0x" + body.slice(42, 106)),
  };
}

export const isNative = (token: string): boolean => token.toLowerCase() === NATIVE_TOKEN.toLowerCase();
