import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * OrdoFi's index.
 *
 * The Explorer previously answered every request by re-reading NDJSON files and
 * re-scanning contract logs from chain head, which is fine for a few hundred
 * rows and falls over at real volume — the cost of a page load grew with the
 * lifetime of the deployment.
 *
 * This is deliberately SQLite via `node:sqlite`: no daemon to run, no
 * dependency to install, and a single file that can be copied off the box.
 * Writes are idempotent so a watcher that restarts mid-block and replays it
 * does not duplicate rows, which matters because the watcher checkpoints
 * coarsely and is expected to be restarted.
 */

export interface ArbRow {
  txHash: string;
  block: number;
  timestamp: number;
  sender: string;
  pools: string[];
  profitToken?: string;
  profitWei?: string;
  profitIsQuote?: boolean;
  gasPaidWei?: string;
}

export interface SettlementRow {
  opportunityId: string;
  searcher: string;
  chargeWei: string;
  userAddress: string;
  appAddress: string;
  txHash?: string;
  createdAt: number;
}

export interface AuctionRow {
  opportunityId: string;
  createdAt: number;
  pools: string[];
  bidCount: number;
  winner?: string;
  clearingPriceWei?: string;
  userTxHash?: string;
  backrunTxHash?: string;
}

export class OrdoStore {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    // WAL keeps the Explorer's reads from blocking the watcher's writes.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS arbs (
        tx_hash TEXT PRIMARY KEY,
        block INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        sender TEXT NOT NULL,
        pools TEXT NOT NULL,
        pool_count INTEGER NOT NULL,
        profit_token TEXT,
        profit_wei TEXT,
        profit_is_quote INTEGER NOT NULL DEFAULT 0,
        gas_paid_wei TEXT
      );
      CREATE INDEX IF NOT EXISTS arbs_block ON arbs(block DESC);
      CREATE INDEX IF NOT EXISTS arbs_sender ON arbs(sender);

      CREATE TABLE IF NOT EXISTS arb_pools (
        tx_hash TEXT NOT NULL,
        pool TEXT NOT NULL,
        PRIMARY KEY (tx_hash, pool)
      );
      CREATE INDEX IF NOT EXISTS arb_pools_pool ON arb_pools(pool);

      CREATE TABLE IF NOT EXISTS auctions (
        opportunity_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        pools TEXT NOT NULL,
        bid_count INTEGER NOT NULL DEFAULT 0,
        winner TEXT,
        clearing_price_wei TEXT,
        user_tx_hash TEXT,
        backrun_tx_hash TEXT
      );
      CREATE INDEX IF NOT EXISTS auctions_created ON auctions(created_at DESC);

      CREATE TABLE IF NOT EXISTS settlements (
        opportunity_id TEXT PRIMARY KEY,
        searcher TEXT NOT NULL,
        charge_wei TEXT NOT NULL,
        user_address TEXT NOT NULL,
        app_address TEXT NOT NULL,
        tx_hash TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS settlements_created ON settlements(created_at DESC);
      CREATE INDEX IF NOT EXISTS settlements_app ON settlements(app_address);

      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  insertArbs(rows: ArbRow[]): void {
    if (rows.length === 0) return;
    const arb = this.db.prepare(
      `INSERT OR IGNORE INTO arbs
       (tx_hash, block, timestamp, sender, pools, pool_count, profit_token, profit_wei, profit_is_quote, gas_paid_wei)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const pool = this.db.prepare(`INSERT OR IGNORE INTO arb_pools (tx_hash, pool) VALUES (?, ?)`);
    this.db.exec("BEGIN");
    try {
      for (const r of rows) {
        arb.run(
          r.txHash,
          r.block,
          r.timestamp,
          r.sender,
          JSON.stringify(r.pools),
          r.pools.length,
          r.profitToken ?? null,
          r.profitWei ?? null,
          r.profitIsQuote ? 1 : 0,
          r.gasPaidWei ?? null,
        );
        for (const p of r.pools) pool.run(r.txHash, p);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  upsertAuction(row: AuctionRow): void {
    this.db
      .prepare(
        `INSERT INTO auctions (opportunity_id, created_at, pools, bid_count, winner, clearing_price_wei, user_tx_hash, backrun_tx_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(opportunity_id) DO UPDATE SET
           bid_count = excluded.bid_count,
           winner = excluded.winner,
           clearing_price_wei = excluded.clearing_price_wei,
           user_tx_hash = excluded.user_tx_hash,
           backrun_tx_hash = excluded.backrun_tx_hash`,
      )
      .run(
        row.opportunityId,
        row.createdAt,
        JSON.stringify(row.pools),
        row.bidCount,
        row.winner ?? null,
        row.clearingPriceWei ?? null,
        row.userTxHash ?? null,
        row.backrunTxHash ?? null,
      );
  }

  insertSettlement(row: SettlementRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO settlements
         (opportunity_id, searcher, charge_wei, user_address, app_address, tx_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.opportunityId,
        row.searcher,
        row.chargeWei,
        row.userAddress,
        row.appAddress,
        row.txHash ?? null,
        row.createdAt,
      );
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`)
      .run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare(`SELECT v FROM meta WHERE k = ?`).get(key) as { v?: string } | undefined;
    return row?.v ?? null;
  }

  /**
   * Swaps are counted rather than stored. They run into the tens of thousands
   * per hour and nothing queries an individual swap — only the headline total —
   * so a counter buys the same number for a fraction of the write cost.
   */
  addSwaps(n: number): void {
    if (n <= 0) return;
    this.db
      .prepare(
        `INSERT INTO meta (k, v) VALUES ('swaps', ?)
         ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(meta.v AS INTEGER) + ? AS TEXT)`,
      )
      .run(String(n), n);
  }

  swapCount(): number {
    return Number(this.getMeta("swaps") ?? 0);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  totals(): { arbs: number; searchers: number; pools: number; settlements: number } {
    const q = (sql: string) => Number((this.db.prepare(sql).get() as any)?.n ?? 0);
    return {
      arbs: q("SELECT COUNT(*) n FROM arbs"),
      searchers: q("SELECT COUNT(DISTINCT sender) n FROM arbs"),
      pools: q("SELECT COUNT(DISTINCT pool) n FROM arb_pools"),
      settlements: q("SELECT COUNT(*) n FROM settlements"),
    };
  }

  recentArbs(limit = 40): ArbRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM arbs ORDER BY block DESC LIMIT ?`)
      .all(limit) as any[];
    return rows.map((r) => ({
      txHash: r.tx_hash,
      block: r.block,
      timestamp: r.timestamp,
      sender: r.sender,
      pools: JSON.parse(r.pools),
      profitToken: r.profit_token ?? undefined,
      profitWei: r.profit_wei ?? undefined,
      profitIsQuote: Boolean(r.profit_is_quote),
      gasPaidWei: r.gas_paid_wei ?? undefined,
    }));
  }

  topSearchers(limit = 10): { address: string; count: number }[] {
    return (
      this.db
        .prepare(`SELECT sender address, COUNT(*) count FROM arbs GROUP BY sender ORDER BY count DESC LIMIT ?`)
        .all(limit) as any[]
    ).map((r) => ({ address: r.address, count: Number(r.count) }));
  }

  topPools(limit = 10): { pool: string; count: number }[] {
    return (
      this.db
        .prepare(`SELECT pool, COUNT(*) count FROM arb_pools GROUP BY pool ORDER BY count DESC LIMIT ?`)
        .all(limit) as any[]
    ).map((r) => ({ pool: r.pool, count: Number(r.count) }));
  }

  /** Block range and wall-clock span actually covered by the index. */
  window(): { minBlock: number; maxBlock: number; spanHours: number } {
    const r = this.db
      .prepare(`SELECT MIN(block) lo, MAX(block) hi, MIN(timestamp) t0, MAX(timestamp) t1 FROM arbs`)
      .get() as any;
    const spanHours = r?.t1 && r?.t0 ? (Number(r.t1) - Number(r.t0)) / 3600 : 0;
    return { minBlock: Number(r?.lo ?? 0), maxBlock: Number(r?.hi ?? 0), spanHours };
  }

  recentSettlements(limit = 20): SettlementRow[] {
    return (
      this.db.prepare(`SELECT * FROM settlements ORDER BY created_at DESC LIMIT ?`).all(limit) as any[]
    ).map((r) => ({
      opportunityId: r.opportunity_id,
      searcher: r.searcher,
      chargeWei: r.charge_wei,
      userAddress: r.user_address,
      appAddress: r.app_address,
      txHash: r.tx_hash ?? undefined,
      createdAt: r.created_at,
    }));
  }

  /** Total settled value credited to one app, for its portal view. */
  appEarnings(appAddress: string): { settlements: number; totalChargedWei: string } {
    const r = this.db
      .prepare(`SELECT COUNT(*) n, COALESCE(SUM(CAST(charge_wei AS INTEGER)), 0) s FROM settlements WHERE app_address = ?`)
      .get(appAddress.toLowerCase()) as any;
    return { settlements: Number(r?.n ?? 0), totalChargedWei: String(r?.s ?? "0") };
  }

  close(): void {
    this.db.close();
  }
}
