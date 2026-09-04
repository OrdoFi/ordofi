/**
 * What OrdoSwap has done so far, read off the chain.
 *
 * Every swap through the contract emits `Swapped`, and every reclaim that ran
 * emits `Reclaimed` with the split. This tallies both from the deploy block
 * forward, a few thousand blocks at a time, and keeps the last handful of
 * reclaims for the page. The position and totals are written to the data
 * directory after each pass, so a restart picks up where it left off instead
 * of re-reading a growing history from the deploy block every time.
 *
 * It counts every deployment, not just the live one. Redeploying the contract
 * does not undo the swaps the last one made, and a page that resets to zero on
 * a version bump is telling the reader something untrue about the product —
 * the more so when the transaction it offers as proof was made by the version
 * it stopped counting. `address` is the contract a new swap goes through;
 * `addresses` is everything the totals cover. The events are identical across
 * versions, so one `eth_getLogs` filtered on the whole set does the work of
 * one, and the tally is the sum.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { decodeEventLog, parseAbi, toEventSelector, type Hex } from "viem";

export const SWAP_EVENTS = parseAbi([
  "event Swapped(address indexed sender, address indexed recipient, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)",
  "event Reclaimed(address indexed recipient, uint256 profit, uint256 toUser, uint256 toProtocol)",
  "event ReclaimSkipped(address indexed recipient, bytes reason)",
]);
const TOPIC_SWAPPED = toEventSelector(SWAP_EVENTS[0]);
const TOPIC_RECLAIMED = toEventSelector(SWAP_EVENTS[1]);
const TOPIC_SKIPPED = toEventSelector(SWAP_EVENTS[2]);

export interface ReclaimRow {
  tx: Hex;
  block: number;
  recipient: Hex;
  profitWei: string;
  toUserWei: string;
  toProtocolWei: string;
}

export interface SwapTotals {
  /** The contract a swap goes through today, and the one the page links to. */
  address: Hex;
  /** Every deployment the totals cover, current first. */
  addresses: Hex[];
  fromBlock: number;
  scannedTo: number;
  swaps: number;
  reclaims: number;
  skipped: number;
  profitWei: string;
  toUserWei: string;
  toProtocolWei: string;
  recent: ReclaimRow[];
  updatedAt: number;
}

export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

interface Log {
  address: string;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
}

export class SwapStats {
  private t: SwapTotals;
  private running = false;

  constructor(
    private readonly rpc: Rpc,
    address: Hex | Hex[],
    fromBlock: number,
    private readonly file: string | null,
    private readonly chunk = 5_000,
    private readonly maxChunksPerPass = 40,
  ) {
    const addresses = (Array.isArray(address) ? address : [address]).map((a) => a.toLowerCase() as Hex).filter((a, i, all) => all.indexOf(a) === i);
    this.t = {
      address: addresses[0],
      addresses,
      fromBlock,
      scannedTo: fromBlock - 1,
      swaps: 0,
      reclaims: 0,
      skipped: 0,
      profitWei: "0",
      toUserWei: "0",
      toProtocolWei: "0",
      recent: [],
      updatedAt: 0,
    };
    this.load();
  }

  totals(): SwapTotals {
    return this.t;
  }

  /** Read new blocks. Bounded per call so a long gap is caught up over a few passes, not one. */
  async refresh(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const head = Number(await this.rpc("eth_blockNumber", []));
      let passes = 0;
      while (this.t.scannedTo < head && passes++ < this.maxChunksPerPass) {
        const from = this.t.scannedTo + 1;
        const to = Math.min(from + this.chunk - 1, head);
        const logs = (await this.rpc("eth_getLogs", [
          { address: this.t.addresses, fromBlock: hex(from), toBlock: hex(to) },
        ])) as Log[];
        for (const l of logs) this.ingest(l);
        this.t.scannedTo = to;
      }
      this.t.updatedAt = Date.now();
      this.save();
    } finally {
      this.running = false;
    }
  }

  /** Exposed for tests and for the page's live tail. */
  ingest(l: Log): void {
    const topic = l.topics[0];
    if (topic === TOPIC_SWAPPED) {
      this.t.swaps++;
    } else if (topic === TOPIC_RECLAIMED) {
      const { args } = decodeEventLog({ abi: SWAP_EVENTS, eventName: "Reclaimed", data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      this.t.reclaims++;
      this.t.profitWei = (BigInt(this.t.profitWei) + args.profit).toString();
      this.t.toUserWei = (BigInt(this.t.toUserWei) + args.toUser).toString();
      this.t.toProtocolWei = (BigInt(this.t.toProtocolWei) + args.toProtocol).toString();
      this.t.recent.unshift({
        tx: l.transactionHash,
        block: Number(l.blockNumber),
        recipient: args.recipient,
        profitWei: args.profit.toString(),
        toUserWei: args.toUser.toString(),
        toProtocolWei: args.toProtocol.toString(),
      });
      if (this.t.recent.length > 50) this.t.recent.length = 50;
    } else if (topic === TOPIC_SKIPPED) {
      this.t.skipped++;
    }
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8")) as SwapTotals;
      // A different set of contracts means a different history, and the saved
      // position would skip the blocks the newcomer lived in. Start over.
      const was = (saved.addresses ?? (saved.address ? [saved.address] : [])).map((a) => a.toLowerCase()).sort().join(",");
      if (was === [...this.t.addresses].sort().join(",")) this.t = { ...this.t, ...saved, addresses: this.t.addresses, address: this.t.address };
    } catch {
      /* unreadable: rescan from the deploy block */
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.t));
    } catch (e) {
      console.warn(`gateway | could not save swap stats: ${(e as Error).message}`);
    }
  }
}

const hex = (n: number): Hex => `0x${n.toString(16)}`;
