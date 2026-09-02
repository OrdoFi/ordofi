import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { decodeEventLog, encodeFunctionData, decodeFunctionResult, toEventSelector } from "viem";
import { rpcFetch } from "@ordofi/core";
import { ANNOUNCER_ABI, ERC5564_ANNOUNCER, ERC6538_REGISTRY, ORDO_STEALTH_SEND, REGISTRY_ABI } from "@ordofi/core/stealth";

/**
 * The announcement feed the Stealth page scans against.
 *
 * Scanning has to happen in the browser, because deciding whether a payment is
 * yours requires the viewing key and that key must never leave the device. What
 * the server can do is spare every visitor from walking fifty million blocks:
 * it keeps the (small) list of announcements and hands the whole thing over.
 *
 * Publishing the list to everyone costs nothing. An announcement is public by
 * construction and reveals only an ephemeral public key and a one-time address;
 * without the viewing key it cannot be tied to any recipient.
 */

const DATA_DIR = process.env.ORDO_DATA_DIR ?? join(import.meta.dirname, "../../data");
const FILE = join(DATA_DIR, "stealth-announcements.json");
const ANNOUNCEMENT_TOPIC = toEventSelector("Announcement(uint256,address,address,bytes,bytes)");
const WINDOW = Number(process.env.ORDO_STEALTH_WINDOW ?? 9_000);
const MAX_CALLS_PER_TICK = Number(process.env.ORDO_STEALTH_CALLS ?? 40);

function load() {
  try {
    if (existsSync(FILE)) {
      const d = JSON.parse(readFileSync(FILE, "utf8"));
      if (Array.isArray(d.announcements) && Number.isFinite(d.scannedTo)) return d;
    }
  } catch { /* start over rather than serve nonsense */ }
  return { scannedFrom: null, scannedTo: null, announcements: [] };
}

function save(state) {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(state));
  } catch { /* the in-memory copy still serves */ }
}

let state = load();
let catchingUp = null;

const hexToNum = (h) => parseInt(h, 16);

/**
 * Where the announcer was deployed. Binary search on eth_getCode costs about
 * twenty archive calls once, and saves scanning the tens of millions of blocks
 * that existed before the contract did.
 */
async function deploymentBlock(head) {
  let lo = 0;
  let hi = head;
  const hasCode = async (n) => {
    const code = await rpcFetch("eth_getCode", [ERC5564_ANNOUNCER, "0x" + n.toString(16)]);
    return typeof code === "string" && code.length > 2;
  };
  if (!(await hasCode(head))) throw new Error("no announcer on this chain");
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await hasCode(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function decode(log) {
  const { args } = decodeEventLog({ abi: ANNOUNCER_ABI, eventName: "Announcement", topics: log.topics, data: log.data });
  return {
    block: hexToNum(log.blockNumber),
    txHash: log.transactionHash,
    logIndex: hexToNum(log.logIndex),
    schemeId: args.schemeId.toString(),
    stealthAddress: args.stealthAddress,
    caller: args.caller,
    ephemeralPublicKey: args.ephemeralPubKey,
    metadata: args.metadata,
  };
}

/**
 * Advance the feed by a bounded number of calls, so a cold start never blocks
 * a request and never monopolises the upstream. Progress is saved each tick.
 */
async function catchUp() {
  const head = hexToNum(await rpcFetch("eth_blockNumber", []));
  if (state.scannedTo == null) {
    const from = await deploymentBlock(head);
    state = { scannedFrom: from, scannedTo: from - 1, announcements: [] };
  }
  // Announcements are sparse, so these responses are almost always empty and
  // can all be in flight at once; the catch-up is minutes rather than hours.
  let cursor = state.scannedTo + 1;
  const ranges = [];
  for (let call = 0; call < MAX_CALLS_PER_TICK && cursor <= head; call++) {
    const to = Math.min(head, cursor + WINDOW - 1);
    ranges.push({ from: cursor, to });
    cursor = to + 1;
  }
  if (!ranges.length) return true;
  const found = [];
  const batches = await Promise.all(ranges.map((r) =>
    rpcFetch("eth_getLogs", [
      { address: ERC5564_ANNOUNCER, topics: [ANNOUNCEMENT_TOPIC], fromBlock: "0x" + r.from.toString(16), toBlock: "0x" + r.to.toString(16) },
    ]),
  ));
  for (const logs of batches) {
    for (const l of logs ?? []) {
      try { found.push(decode(l)); } catch { /* not a shape we understand */ }
    }
  }
  // Only advance once every window in the batch came back, so a failure part
  // way through re-reads rather than skipping announcements.
  state.scannedTo = ranges[ranges.length - 1].to;
  if (found.length) {
    const seen = new Set(state.announcements.map((a) => `${a.txHash}:${a.logIndex}`));
    for (const a of found) if (!seen.has(`${a.txHash}:${a.logIndex}`)) state.announcements.push(a);
    state.announcements.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
    console.log(`stealth | +${found.length} announcement(s) at block ${state.scannedTo}`);
  }
  state.head = head;
  save(state);
  return state.scannedTo >= head;
}

/**
 * Self-driving: the feed keeps reading until it reaches the head rather than
 * advancing only when someone loads the page, so the first visitor after a
 * deploy is not the one who pays for the catch-up.
 */
function kick() {
  if (catchingUp) return;
  catchingUp = catchUp()
    .then((caughtUp) => {
      if (!caughtUp) setTimeout(kick, 250);
      else if (state.scannedFrom != null) console.log(`stealth | feed current to block ${state.scannedTo} (${state.announcements.length} announcements)`);
    })
    .catch((e) => console.warn(`stealth | feed: ${e.message}`))
    .finally(() => { catchingUp = null; });
}

// Keep it fresh; announcements are what make funds discoverable.
setInterval(kick, 30_000).unref?.();

/** Announcements for the browser to scan, plus how far the feed has read. */
export async function stealthFeed({ since = 0 } = {}) {
  kick();
  // A cold feed has nothing to serve yet; wait for the first tick rather than
  // telling the user they have no payments.
  if (state.scannedTo == null && catchingUp) await catchingUp;
  const announcements = state.announcements.filter((a) => a.block >= since);
  return {
    announcer: ERC5564_ANNOUNCER,
    registry: ERC6538_REGISTRY,
    // Informational. The page pays only the contract compiled into its bundle
    // (packages/core/src/stealth.ts → npm run build:stealth); a different value
    // here is logged by the page and ignored, never followed.
    sender: process.env.ORDO_STEALTH_SEND_ADDRESS ?? ORDO_STEALTH_SEND,
    scannedFrom: state.scannedFrom,
    scannedTo: state.scannedTo,
    head: state.head ?? null,
    syncing: state.scannedTo == null || state.head == null || state.scannedTo < state.head,
    total: state.announcements.length,
    announcements,
  };
}

/** A registered meta-address for an ordinary address, if its owner published one. */
export async function stealthMetaFor(address, schemeId = 1n) {
  const data = encodeFunctionData({ abi: REGISTRY_ABI, functionName: "stealthMetaAddressOf", args: [address, schemeId] });
  const out = await rpcFetch("eth_call", [{ to: ERC6538_REGISTRY, data }, "latest"]);
  const bytes = decodeFunctionResult({ abi: REGISTRY_ABI, functionName: "stealthMetaAddressOf", data: out });
  if (!bytes || bytes.length < 4) return { address, metaAddress: null };
  const body = bytes.slice(2);
  if (body.length !== 132) return { address, metaAddress: null };
  return { address, metaAddress: `st:rho:0x${body}` };
}

/**
 * What a stealth address is actually holding. Metadata says what the sender
 * meant to send; this is what arrived and is still there.
 */
export async function stealthBalances(addresses, tokens) {
  const balanceOf = (token, owner) =>
    rpcFetch("eth_call", [{ to: token, data: "0x70a08231" + owner.slice(2).toLowerCase().padStart(64, "0") }, "latest"]);
  const out = [];
  for (const address of addresses.slice(0, 200)) {
    const [eth, ...erc20] = await Promise.all([
      rpcFetch("eth_getBalance", [address, "latest"]).catch(() => "0x0"),
      ...tokens.map((t) => balanceOf(t, address).catch(() => "0x0")),
    ]);
    out.push({
      address,
      eth: BigInt(eth ?? 0n).toString(),
      tokens: Object.fromEntries(tokens.map((t, i) => [t.toLowerCase(), BigInt(erc20[i] || "0x0").toString()])),
    });
  }
  return out;
}
