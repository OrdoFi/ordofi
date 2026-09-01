import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { parseTransaction, recoverTransactionAddress, type TransactionSerialized } from "viem";
import { ENDPOINTS, SWAP_TOPICS } from "@ordofi/core";
import { extractSwapHints, hintLevelFromEnv, simulateTx } from "@ordofi/core/simulate";
import { appendFileSync } from "node:fs";
import { Auction, toResult } from "./auctioneer.js";
import { bondingEnabled, checkBond } from "./bonds.js";
import { RebateLedger, REBATE_SPLIT } from "./ledger.js";
import { settlementEnabled, submitSettlement } from "./settle.js";
import { feedStats, startFeedRelay } from "./feedrelay.js";
import {
  acknowledge,
  anchoringEnabled,
  auctioneerAddress,
  currentRoot,
  getReceipt,
  publishReceipt,
  receiptsEnabled,
  recentReceipts,
} from "./receipts.js";
import type { Bid, Opportunity, SettlementRecord } from "./types.js";

const PORT = Number(process.env.ORDO_AUCTION_PORT ?? 8548);
const UPSTREAM = ENDPOINTS.rpc;
const DATA_DIR = process.env.ORDO_DATA_DIR ?? join(import.meta.dirname, "../../../data");
const ledger = new RebateLedger(join(DATA_DIR, "rebates.ndjson"));
const settlementsFile = join(DATA_DIR, "settlements.ndjson");
const SETTLEMENT_ADDRESS = process.env.ORDO_SETTLEMENT_ADDRESS ?? "";
const HINT_LEVEL = hintLevelFromEnv();

let upstreamId = 0;
async function upstream(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(UPSTREAM, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++upstreamId, method, params }),
  });
  const body = (await res.json()) as any;
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

const searchers = new Set<WebSocket>();
const activeAuctions = new Map<string, Auction>();
const stats = { opportunities: 0, bids: 0, rejectedBids: 0, dispatched: 0, backruns: 0, settled: 0 };

function broadcastHint(opp: Opportunity): void {
  const msg = JSON.stringify({ type: "opportunity", opportunity: opp });
  for (const ws of searchers) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

/**
 * Build the redacted hint from a raw user tx.
 *
 * The transaction is simulated with `eth_simulateV1`, whose logs name the pools
 * it will actually move — including pools reached through a router nobody has
 * catalogued. Only the pool, its shape and its direction are broadcast; the
 * calldata, the amounts and the sender never leave this process at the default
 * hint level.
 *
 * Simulation is best-effort by construction. The public endpoint rate limits,
 * and a hint is worth less than the order flow it describes, so a failed
 * simulation degrades to the target address rather than rejecting the submit.
 */
async function buildHint(rawTx: string): Promise<Opportunity["hint"]> {
  const tx = parseTransaction(rawTx as TransactionSerialized);
  const data = (tx.data ?? "0x") as string;
  const base = {
    to: tx.to ?? null,
    selector: data.length >= 10 ? data.slice(0, 10) : null,
    value: "0x" + (tx.value ?? 0n).toString(16),
    level: HINT_LEVEL,
  };

  if (HINT_LEVEL === "minimal") {
    return { ...base, poolsTouched: [], swaps: [], simulated: false };
  }

  try {
    const sim = await simulateTx(upstream, rawTx, { fundSender: true });
    if (!sim.ok || sim.degraded) {
      return {
        ...base,
        poolsTouched: tx.to ? [tx.to.toLowerCase()] : [],
        swaps: [],
        simulated: false,
      };
    }
    const swaps = extractSwapHints(sim.logs, HINT_LEVEL);
    return {
      ...base,
      poolsTouched: [...new Set(swaps.map((s) => s.pool))],
      swaps,
      simulated: true,
    };
  } catch {
    return { ...base, poolsTouched: tx.to ? [tx.to.toLowerCase()] : [], swaps: [], simulated: false };
  }
}

async function handleSubmit(body: any): Promise<any> {
  const receivedAt = Date.now();
  const rawTx: string = body?.rawTx;
  if (!rawTx?.startsWith("0x")) throw new Error("rawTx (signed user transaction) required");

  const originLabel: string = body?.originLabel ?? "anon";
  const originRebateAddress: string | undefined = body?.rebateAddress;

  const hint = await buildHint(rawTx);

  const opp: Opportunity = {
    id: randomUUID(),
    createdAt: Date.now(),
    hint,
    originLabel,
    originRebateAddress,
  };

  const auction = new Auction(opp);
  activeAuctions.set(opp.id, auction);
  stats.opportunities++;
  broadcastHint(opp);

  // Wait for the sealed-bid window to close, then dispatch.
  const outcome = await auction.settled;
  activeAuctions.delete(opp.id);

  // Published before dispatch so the record of what was decided does not
  // depend on whether the transactions that follow succeed.
  const receipt = await publishReceipt(
    opp.id,
    auction.allBids,
    outcome.winner?.searcher ?? null,
    outcome.clearingPriceWei.toString(),
  );

  let userTxHash: string | undefined;
  let backrunTxHash: string | undefined;
  let userError: string | undefined;

  // Dispatch user tx and (if any) winning backrun back-to-back in the same tick.
  // On an FCFS chain adjacency is probabilistic; sequencer integration (Phase 3)
  // makes it guaranteed.
  //
  // The user's transaction *is* delayed, by exactly the auction window
  // (ORDO_AUCTION_WINDOW_MS, 200ms by default) — the bid window has to close
  // before there is a backrun to place behind it. That cost is real and is
  // reported to the caller as `auctionDelayMs` rather than hidden. Both sends
  // are fault-isolated: a broadcast failure is reported but never discards the
  // auction result or blocks the other leg.
  const sends: Promise<void>[] = [];
  sends.push(
    upstream("eth_sendRawTransaction", [rawTx])
      .then((h) => {
        userTxHash = h;
      })
      .catch((e) => {
        userError = (e as Error).message;
      }),
  );
  if (outcome.winner) {
    sends.push(
      upstream("eth_sendRawTransaction", [outcome.winner.backrunRawTx])
        .then((h) => {
          backrunTxHash = h;
          stats.backruns++;
        })
        .catch(() => {
          /* backrun may revert if the race is lost; user tx is unaffected */
        }),
    );
  }
  await Promise.all(sends);
  stats.dispatched++;

  const result = toResult(opp, outcome, auction.bidCount, { userTxHash, backrunTxHash });

  let ledgerEntry;
  let settlementRecord: SettlementRecord | null = null;
  let settlementTxHash: string | undefined;
  if (outcome.winner && outcome.clearingPriceWei > 0n) {
    ledgerEntry = ledger.record(result, outcome.winner, originRebateAddress);

    // Produce a settlement-ready record. Once ORDO_SETTLEMENT_ADDRESS points at
    // a deployed OrdoSettlement contract and an auctioneer key is configured,
    // these records are what get submitted on-chain (settle()) to debit the
    // searcher's bond and credit the user/app/protocol rebate splits.
    // The rebate belongs to the trader who signed the order, so credit the
    // recovered sender of the user transaction rather than an app label.
    let userAddress = "0x0000000000000000000000000000000000000000";
    try {
      userAddress = await recoverTransactionAddress({ serializedTransaction: rawTx as TransactionSerialized });
    } catch {
      /* fall back to the zero address; the app/protocol split still settles */
    }

    settlementRecord = {
      opportunityId: opp.id,
      searcher: outcome.winner.searcher,
      maxAmountWei: outcome.winner.bidWei,
      chargeWei: outcome.clearingPriceWei.toString(),
      user: userAddress,
      app: originRebateAddress ?? "0x0000000000000000000000000000000000000000",
      searcherSig: outcome.winner.bidSig,
      createdAt: Date.now(),
    };
    appendFileSync(settlementsFile, JSON.stringify(settlementRecord) + "\n");

    // Close the loop on-chain when a deployed contract + auctioneer key exist.
    if (settlementEnabled()) {
      try {
        const txHash = await submitSettlement(settlementRecord);
        if (txHash) {
          settlementTxHash = txHash;
          stats.settled++;
          console.log(`[settle] ${opp.id.slice(0, 8)} charged ${outcome.clearingPriceWei} wei — ${txHash}`);
        }
      } catch (e) {
        console.error(`[settle] failed for ${opp.id.slice(0, 8)}: ${(e as Error).message}`);
      }
    }
  }

  return {
    result,
    rebate: ledgerEntry ?? null,
    settlement: settlementRecord,
    settlementTxHash: settlementTxHash ?? null,
    receipt,
    settlementContract: SETTLEMENT_ADDRESS || null,
    userError: userError ?? null,
    /** What holding the transaction for the bid window actually cost, in ms. */
    auctionDelayMs: Date.now() - receivedAt,
    hint: { level: opp.hint.level, simulated: opp.hint.simulated, pools: opp.hint.poolsTouched.length },
  };
}

const server = createServer((req, res) => {
  const url = req.url ?? "/";

  if (req.method === "GET" && url.startsWith("/receipts")) {
    const json = (body: unknown, code = 200) => {
      res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(body));
    };
    if (url === "/receipts/root") return json({ ...currentRoot(), auctioneer: auctioneerAddress() });
    if (url === "/receipts" || url.startsWith("/receipts?")) {
      const n = Number(new URL(url, "http://x").searchParams.get("n") ?? 20);
      return json({ auctioneer: auctioneerAddress(), receipts: recentReceipts(n) });
    }
    const id = url.slice("/receipts/".length);
    const found = getReceipt(id);
    return found
      ? json({ auctioneer: auctioneerAddress(), receipt: found })
      : json({ error: "no receipt for that opportunity" }, 404);
  }

  if (req.method === "GET" && url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", searchers: searchers.size, stats }));
    return;
  }
  if (req.method === "GET" && url === "/feed/stats") {
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(feedStats()));
    return;
  }

  if (req.method === "GET" && url === "/stats") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        { stats, connectedSearchers: searchers.size, rebateSplit: REBATE_SPLIT, owedRebates: ledger.balances() },
        null,
        2,
      ),
    );
    return;
  }
  if (req.method === "POST" && url === "/submit") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      res.setHeader("content-type", "application/json");
      try {
        const out = await handleSubmit(JSON.parse(raw));
        res.end(JSON.stringify(out));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    });
    return;
  }
  res.writeHead(404).end();
});

// Searcher WebSocket: receive opportunity hints, submit sealed bids.
const wss = new WebSocketServer({ server, path: "/searcher" });
startFeedRelay(server);
wss.on("connection", (ws) => {
  searchers.add(ws);
  ws.send(
    JSON.stringify({
      type: "welcome",
      swapTopics: SWAP_TOPICS,
      auctionWindowMs: Number(process.env.ORDO_AUCTION_WINDOW_MS ?? 200),
      hintLevel: HINT_LEVEL,
    }),
  );

  ws.on("message", (data) => {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "invalid json" }));
      return;
    }
    if (msg.type === "bid") {
      const bid: Bid = {
        opportunityId: msg.opportunityId,
        searcher: msg.searcher ?? "anon",
        bidWei: String(msg.bidWei ?? "0"),
        backrunRawTx: msg.backrunRawTx ?? "",
        bidSig: msg.bidSig,
        receivedAt: Date.now(),
      };
      const auction = activeAuctions.get(bid.opportunityId);
      if (!auction) {
        ws.send(JSON.stringify({ type: "bid_ack", accepted: false, reason: "unknown or closed auction" }));
        return;
      }

      // Only accept bids the searcher can actually pay for on-chain.
      void checkBond(bid.searcher, bid.bidWei).then((reason) => {
        if (reason) {
          stats.rejectedBids++;
          ws.send(JSON.stringify({ type: "bid_ack", opportunityId: bid.opportunityId, accepted: false, reason }));
          return;
        }
        const r = auction.submitBid(bid);
        if (r.accepted) stats.bids++;
        // The acknowledgement is the searcher's evidence that this bid, at
        // this amount, was received — worthless to them after the fact if we
        // only sent it on request.
        void (r.accepted ? acknowledge(bid) : Promise.resolve(null)).then((ack) =>
          ws.send(
            JSON.stringify({ type: "bid_ack", opportunityId: bid.opportunityId, ...r, ack }),
          ),
        );
      });
    }
  });

  ws.on("close", () => searchers.delete(ws));
  ws.on("error", () => searchers.delete(ws));
});

server.listen(PORT, () => {
  console.log(`OrdoFi auction | listening on :${PORT} | upstream=${UPSTREAM}`);
  console.log(`OrdoFi auction | POST /submit  GET /health /stats  WS /searcher`);
  console.log(`OrdoFi auction | rebate split user=${REBATE_SPLIT.user} app=${REBATE_SPLIT.app} protocol=${REBATE_SPLIT.protocol}`);
  console.log(
    `OrdoFi auction | bond gating=${bondingEnabled() ? "on" : "off (no ORDO_SETTLEMENT_ADDRESS)"} · ` +
      `on-chain settlement=${settlementEnabled() ? "on" : "off (needs ORDO_SETTLEMENT_ADDRESS + ORDO_AUCTIONEER_KEY)"}`,
  );
  console.log(
    `OrdoFi auction | verifiable receipts=${
      receiptsEnabled()
        ? `on (signed by ${auctioneerAddress()}) · GET /receipts /receipts/root`
        : "off (no ORDO_AUCTIONEER_KEY) — outcomes cannot be audited"
    } · on-chain anchoring=${anchoringEnabled() ? "on" : "off (no ORDO_RECEIPT_LOG_ADDRESS)"}`,
  );
});
