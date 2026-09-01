import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
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

export interface ApiKeyRow {
  label: string;
  rebateAddress?: string;
  mode: "auction" | "direct";
  rateLimit: number;
  createdAt: number;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

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

      -- Per-pool minute candles, recorded live by the watcher from the swap
      -- events it already decodes. Public RPCs cap eth_getLogs at 10k results,
      -- which the busiest pool here exceeds in half an hour; recording the
      -- tape as it happens is the only way to chart it without owning a node.
      -- Prices are raw token1-per-token0 floats; orientation and decimal
      -- scaling belong to the reader, which knows the tokens.
      CREATE TABLE IF NOT EXISTS candles (
        pool TEXT NOT NULL,
        bucket INTEGER NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        vol0 REAL NOT NULL DEFAULT 0,
        vol1 REAL NOT NULL DEFAULT 0,
        swaps INTEGER NOT NULL DEFAULT 0,
        first_block INTEGER NOT NULL,
        last_block INTEGER NOT NULL,
        PRIMARY KEY (pool, bucket)
      );

      -- Self-serve gateway credentials. Only a hash is stored: the database
      -- leaking must not leak the keys themselves.
      CREATE TABLE IF NOT EXISTS api_keys (
        key_hash TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        rebate_address TEXT,
        mode TEXT NOT NULL,
        rate_limit INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
    `);
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Mints a gateway credential. The plaintext key exists only in the return
   * value — what persists is its SHA-256, so issuance is the one moment it
   * can ever be shown.
   */
  issueApiKey(opts: { label?: string; rebateAddress?: string; rateLimit?: number }): {
    key: string;
    record: ApiKeyRow;
  } {
    const label = (opts.label ?? "self-serve").trim().slice(0, 40) || "self-serve";
    const rebateAddress = opts.rebateAddress?.toLowerCase();
    if (rebateAddress && !/^0x[0-9a-f]{40}$/.test(rebateAddress)) {
      throw new Error("rebateAddress is not an address");
    }
    const key = "ordo_" + randomBytes(18).toString("hex");
    const record: ApiKeyRow = {
      label,
      rebateAddress,
      // A key with somewhere to send rebates defaults into the auction; one
      // without can only want protection.
      mode: rebateAddress ? "auction" : "direct",
      rateLimit: opts.rateLimit ?? 600,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO api_keys (key_hash, label, rebate_address, mode, rate_limit, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(sha256(key), label, rebateAddress ?? null, record.mode, record.rateLimit, record.createdAt);
    return { key, record };
  }

  /** Looks up a presented key by its hash. Disabled keys do not resolve. */
  findApiKey(presented: string): ApiKeyRow | null {
    const row = this.db
      .prepare(
        `SELECT label, rebate_address, mode, rate_limit, created_at
         FROM api_keys WHERE key_hash = ? AND enabled = 1`,
      )
      .get(sha256(presented)) as
      | { label: string; rebate_address: string | null; mode: string; rate_limit: number; created_at: number }
      | undefined;
    if (!row) return null;
    return {
      label: row.label,
      rebateAddress: row.rebate_address ?? undefined,
      mode: row.mode as "auction" | "direct",
      rateLimit: row.rate_limit,
      createdAt: row.created_at,
    };
  }

  apiKeyCount(): number {
    const r = this.db.prepare(`SELECT COUNT(*) c FROM api_keys WHERE enabled = 1`).get() as { c: number };
    return r.c;
  }

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

  /**
   * Drop everything re-derivable from the chain, keeping everything that is
   * not. Correcting an attribution rule invalidates every arb already
   * recorded, but settlements and API keys were never measurements — deleting
   * the database file to rebuild the index took them with it and the site went
   * back to reporting no settlements at all.
   */
  clearMeasurements(): void {
    this.db.exec(`
      DELETE FROM arb_pools;
      DELETE FROM arbs;
      DELETE FROM meta WHERE k = 'swaps';
    `);
  }

  /** Exact totals over on-chain settlements this auction has submitted. */
  settlementTotals(): { settlements: number; totalChargeWei: bigint } {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) c, COALESCE(SUM(CAST(charge_wei AS INTEGER)), 0) s
         FROM settlements WHERE tx_hash IS NOT NULL`,
      )
      .get() as { c: number; s: number | bigint };
    return { settlements: r.c, totalChargeWei: BigInt(r.s) };
  }

  /**
   * Everything an outbound pitch needs about a set of pools: how contested
   * they are, by whom, and how much of the extracted value was denominated in
   * something we can actually price. An empty pool list means the whole chain.
   *
   * Profit is returned per token, never pre-summed. Different quote tokens
   * have different decimals and different dollar values — adding raw wei
   * across them and calling the result ETH turns six-decimal stablecoin units
   * into ether and inflates the total by orders of magnitude. Valuation
   * belongs with the caller that knows each token's decimals.
   *
   * Only quote-denominated profit appears here at all. Most arbitrage books
   * out in long-tail tokens this cannot value, so any total built from it is
   * a floor.
   */
  poolLeakage(pools: string[] = []): {
    arbs: number;
    searchers: number;
    pricedArbs: number;
    profitByToken: { token: string; wei: bigint; arbs: number }[];
    firstBlock: number | null;
    lastBlock: number | null;
    topSearchers: { address: string; count: number }[];
    topPools: { pool: string; count: number }[];
  } {
    // Pools are stored exactly as the logs emitted them, and callers paste
    // checksummed addresses out of block explorers, so both sides are folded
    // rather than assuming either is already lowercase.
    const lower = pools.map((p) => p.toLowerCase());
    const filter = lower.length
      ? `WHERE a.tx_hash IN (SELECT tx_hash FROM arb_pools WHERE LOWER(pool) IN (${lower.map(() => "?").join(",")}))`
      : "";

    const head = this.db
      .prepare(
        `SELECT COUNT(*) arbs,
                COUNT(DISTINCT a.sender) searchers,
                COALESCE(SUM(a.profit_is_quote), 0) pricedArbs,
                MIN(a.block) lo, MAX(a.block) hi
         FROM arbs a ${filter}`,
      )
      .get(...lower) as { arbs: number; searchers: number; pricedArbs: number; lo: number | null; hi: number | null };

    // SUM() over a TEXT wei column would overflow a double, so the priced
    // rows are accumulated as BigInt in JS instead — and grouped by token,
    // since summing across tokens is meaningless.
    const priced = this.db
      .prepare(
        `SELECT a.profit_token t, a.profit_wei w FROM arbs a
         ${filter}${filter ? " AND" : " WHERE"} a.profit_is_quote = 1`,
      )
      .all(...lower) as { t: string | null; w: string | null }[];

    const byToken = new Map<string, { wei: bigint; arbs: number }>();
    for (const row of priced) {
      if (!row.t || !row.w) continue;
      const key = row.t.toLowerCase();
      const cur = byToken.get(key) ?? { wei: 0n, arbs: 0 };
      cur.wei += BigInt(row.w);
      cur.arbs++;
      byToken.set(key, cur);
    }
    const profitByToken = [...byToken.entries()]
      .map(([token, v]) => ({ token, wei: v.wei, arbs: v.arbs }))
      .sort((a, b) => b.arbs - a.arbs);

    const topSearchers = (
      this.db
        .prepare(
          `SELECT a.sender address, COUNT(*) count FROM arbs a ${filter}
           GROUP BY a.sender ORDER BY count DESC LIMIT 10`,
        )
        .all(...lower) as any[]
    ).map((r) => ({ address: r.address as string, count: Number(r.count) }));

    const topPools = (
      this.db
        .prepare(
          `SELECT p.pool pool, COUNT(*) count FROM arb_pools p
           ${lower.length ? `WHERE LOWER(p.pool) IN (${lower.map(() => "?").join(",")})` : ""}
           GROUP BY p.pool ORDER BY count DESC LIMIT 10`,
        )
        .all(...lower) as any[]
    ).map((r) => ({ pool: r.pool as string, count: Number(r.count) }));

    return {
      arbs: head.arbs,
      searchers: head.searchers,
      pricedArbs: Number(head.pricedArbs),
      profitByToken,
      firstBlock: head.lo,
      lastBlock: head.hi,
      topSearchers,
      topPools,
    };
  }

  /**
   * Merge swap price points into minute candles. The watcher processes blocks
   * concurrently, so points arrive out of order; open/close are guarded by
   * block bounds rather than arrival order. Replayed blocks after a restart
   * re-add their volume — a bounded, cosmetic inflation the chart can live
   * with, unlike losing idempotency on the tables that count money.
   */
  upsertCandles(
    points: { pool: string; bucket: number; price: number; vol0: number; vol1: number; block: number }[],
  ): void {
    if (points.length === 0) return;
    // Collapse per (pool, bucket) first so one SQL row carries each group.
    const groups = new Map<
      string,
      { pool: string; bucket: number; open: number; high: number; low: number; close: number; vol0: number; vol1: number; swaps: number; first: number; last: number; firstPrice: number; lastPrice: number }
    >();
    for (const p of points) {
      const key = `${p.pool}:${p.bucket}`;
      const g = groups.get(key);
      if (!g) {
        groups.set(key, {
          pool: p.pool, bucket: p.bucket, open: p.price, high: p.price, low: p.price, close: p.price,
          vol0: p.vol0, vol1: p.vol1, swaps: 1, first: p.block, last: p.block, firstPrice: p.price, lastPrice: p.price,
        });
        continue;
      }
      g.high = Math.max(g.high, p.price);
      g.low = Math.min(g.low, p.price);
      g.vol0 += p.vol0;
      g.vol1 += p.vol1;
      g.swaps++;
      if (p.block <= g.first) { g.first = p.block; g.open = p.price; }
      if (p.block >= g.last) { g.last = p.block; g.close = p.price; }
      groups.set(key, g);
    }
    const stmt = this.db.prepare(
      `INSERT INTO candles (pool, bucket, open, high, low, close, vol0, vol1, swaps, first_block, last_block)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(pool, bucket) DO UPDATE SET
         open = CASE WHEN excluded.first_block < candles.first_block THEN excluded.open ELSE candles.open END,
         close = CASE WHEN excluded.last_block > candles.last_block THEN excluded.close ELSE candles.close END,
         high = MAX(candles.high, excluded.high),
         low = MIN(candles.low, excluded.low),
         vol0 = candles.vol0 + excluded.vol0,
         vol1 = candles.vol1 + excluded.vol1,
         swaps = candles.swaps + excluded.swaps,
         first_block = MIN(candles.first_block, excluded.first_block),
         last_block = MAX(candles.last_block, excluded.last_block)`,
    );
    this.db.exec("BEGIN");
    try {
      for (const g of groups.values()) {
        stmt.run(g.pool.toLowerCase(), g.bucket, g.open, g.high, g.low, g.close, g.vol0, g.vol1, g.swaps, g.first, g.last);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  candlesFor(pool: string, fromBucket: number): {
    bucket: number; open: number; high: number; low: number; close: number;
    vol0: number; vol1: number; swaps: number;
  }[] {
    return (
      this.db
        .prepare(
          `SELECT bucket, open, high, low, close, vol0, vol1, swaps FROM candles
           WHERE pool = ? AND bucket >= ? ORDER BY bucket ASC`,
        )
        .all(pool.toLowerCase(), fromBucket) as any[]
    ).map((r) => ({
      bucket: Number(r.bucket), open: r.open, high: r.high, low: r.low, close: r.close,
      vol0: r.vol0, vol1: r.vol1, swaps: Number(r.swaps),
    }));
  }

  /**
   * One row per pool that traded since `sinceBucket`: first open, last close,
   * extremes, volume and swap count over the window. This is what a market
   * list needs, and reading it here means the terminal can rank hundreds of
   * pairs without a single RPC call.
   */
  marketStats(sinceBucket: number): {
    pool: string; open: number; high: number; low: number; close: number;
    vol0: number; vol1: number; swaps: number; firstBucket: number; lastBucket: number;
  }[] {
    return (
      this.db
        .prepare(
          `WITH w AS (
             SELECT pool, MIN(bucket) fb, MAX(bucket) lb, MAX(high) high, MIN(low) low,
                    SUM(vol0) vol0, SUM(vol1) vol1, SUM(swaps) swaps
             FROM candles WHERE bucket >= ? GROUP BY pool)
           SELECT w.pool, f.open, w.high, w.low, l.close, w.vol0, w.vol1, w.swaps, w.fb, w.lb
           FROM w
           JOIN candles f ON f.pool = w.pool AND f.bucket = w.fb
           JOIN candles l ON l.pool = w.pool AND l.bucket = w.lb
           ORDER BY w.swaps DESC`,
        )
        .all(sinceBucket) as any[]
    ).map((r) => ({
      pool: r.pool, open: r.open, high: r.high, low: r.low, close: r.close,
      vol0: r.vol0, vol1: r.vol1, swaps: Number(r.swaps),
      firstBucket: Number(r.fb), lastBucket: Number(r.lb),
    }));
  }

  /** The tape is a rolling window, not an archive; old buckets cost disk. */
  pruneCandles(olderThanBucket: number): number {
    const r = this.db.prepare(`DELETE FROM candles WHERE bucket < ?`).run(olderThanBucket);
    return Number(r.changes ?? 0);
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

  /**
   * Every arbitrage that touched one pool, with its booked profit. Exists for
   * singleton venues (Uniswap V4 keeps every pool inside one contract), where
   * the address alone says nothing and the caller needs the transactions to
   * attribute flow any deeper.
   */
  arbsTouchingPool(pool: string): {
    txHash: string;
    profitToken?: string;
    profitWei?: string;
    profitIsQuote: boolean;
  }[] {
    return (
      this.db
        .prepare(
          `SELECT a.tx_hash, a.profit_token, a.profit_wei, a.profit_is_quote
           FROM arbs a
           WHERE a.tx_hash IN (SELECT tx_hash FROM arb_pools WHERE LOWER(pool) = ?)
           ORDER BY a.block DESC`,
        )
        .all(pool.toLowerCase()) as any[]
    ).map((r) => ({
      txHash: r.tx_hash,
      profitToken: r.profit_token ?? undefined,
      profitWei: r.profit_wei ?? undefined,
      profitIsQuote: Boolean(r.profit_is_quote),
    }));
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
