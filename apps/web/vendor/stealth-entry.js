/**
 * Everything the Stealth page needs, bundled and served from our own origin.
 *
 * This code handles spending keys. Pulling secp256k1 off a public CDN would
 * mean a single compromised script host could drain every stealth balance, so
 * the bundle is built from the same source the Node tests run against and
 * committed alongside the page.
 *
 * Build: npm run build:stealth
 */
export {
  ANNOUNCER_ABI,
  ERC5564_ANNOUNCER,
  ERC6538_REGISTRY,
  NATIVE_TOKEN,
  ORDO_STEALTH_SEND,
  STEALTH_SEND_ABI,
  STEALTH_FEE_BPS,
  stealthSplit,
  REGISTRY_ABI,
  SCHEME_ID,
  UNLOCK_MESSAGE,
  checkAnnouncement,
  computeStealthPrivateKey,
  decodeMetadata,
  encodeMetaAddress,
  encodeMetadata,
  fromPrivateKeys,
  generateStealthAddress,
  isNative,
  keysFromSignature,
  metaAddressBytes,
  parseMetaAddress,
  publicKeyToAddress,
} from "../../../packages/core/src/stealth.ts";

export {
  encodeFunctionData,
  formatEther,
  formatUnits,
  getAddress,
  isAddress,
  parseEther,
  parseUnits,
  serializeTransaction,
  keccak256,
} from "viem";

export { privateKeyToAccount } from "viem/accounts";
