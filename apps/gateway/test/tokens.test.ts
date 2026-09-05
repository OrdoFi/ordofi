import { test } from "node:test";
import assert from "node:assert/strict";
import { TokenList, isStock, toPicker } from "../src/tokens.ts";

const raw = [
  { address: "0x0BD7D308f8E1639FAb988df18A8011f41EAcAD73", symbol: "WETH", name: "WETH", decimals: 18, usdPerToken: 2456.4, icon: "https://assets.coingecko.com/x.png", swaps24h: 3_700_000, tiers: { eth: [], usdg: [100, 500] } },
  { address: "0x1b0e319c6a659f002271b69db8a7df2f911c153e", symbol: "GME", name: "GameStop Corp. • Robinhood Tokenized Stock", decimals: 18, usdPerToken: 23.1, icon: "https://cdn.robinhood.com/ncw_assets/logos/0x1b0e.png", swaps24h: 91_638, tiers: { eth: [500, 3000], usdg: [100] } },
  { address: "0x385f4f8ae47651ce5f58f5265395a669f8281e18", symbol: "MEME", name: "A Meme Coin", decimals: 18, usdPerToken: 0.0497, icon: null, swaps24h: 441_725, tiers: { eth: [], usdg: [] } },
  { address: "0x385f4f8ae47651ce5f58f5265395a669f8281e18", symbol: "MEME", name: "duplicate", decimals: 18 },
  { address: "not-an-address", symbol: "BAD", name: "bad", decimals: 18 },
  { address: "0x00000000000000000000000000000000000000aa", symbol: "NODEC", name: "no decimals" },
];

test("stocks are Robinhood's tokenized ones, by name or by logo host", () => {
  assert.equal(isStock(raw[1]), true);
  assert.equal(isStock(raw[0]), false);
  assert.equal(isStock({ name: "x", icon: "https://cdn.robinhood.com/ncw_assets/logos/y.png" }), true);
});

test("the picker list is compact, ranked by activity, deduplicated, and honest about routability", () => {
  const p = toPicker(raw);
  assert.deepEqual(p.map((t) => t.symbol), ["WETH", "MEME", "GME"], "by swaps, duplicates and junk dropped");
  const gme = p.find((t) => t.symbol === "GME")!;
  assert.equal(gme.address, "0x1b0e319c6a659f002271b69db8a7df2f911c153e", "lowercased");
  assert.equal(gme.name, "GameStop Corp.", "the Robinhood suffix is trimmed");
  assert.equal(gme.stock, true);
  assert.equal(gme.v3, true);
  const meme = p.find((t) => t.symbol === "MEME")!;
  assert.equal(meme.v3, false, "no V3 pool: listed, but the page will say not yet");
  assert.equal(meme.stock, false);
  assert.equal(meme.icon, null, "no logo published: the picker draws one from the address");
});

test("ORDO wears our own mark, which no list publishes, and caps come from the cap source", () => {
  const ordo = "0xfe2f0fb0c00d19786a8abf98d4b1f1ac8763b167";
  const [t] = toPicker([{ address: ordo, symbol: "ORDO", name: "OrdoFi", decimals: 18, icon: null, swaps24h: 1055 }], null, {
    get: (a) => (a === ordo ? 23_100_000 : null),
  });
  assert.equal(t.icon, "https://app.ordofi.network/favicon-192.png");
  assert.equal(t.mcap, 23_100_000);
  assert.equal(toPicker([{ address: ordo, symbol: "ORDO", decimals: 18, swaps24h: 1 }])[0].mcap, null, "no cap source, no cap");
});

test("the V4 index is asked once for the whole list, not once per token", () => {
  // The store is synchronous. A query per token held the event loop for five
  // seconds every minute on the real list, both replicas at once, and Caddy
  // answered "no upstreams available" while it did.
  const asked: string[][] = [];
  const v4 = {
    v4CurrenciesAmong(addresses: string[]) {
      asked.push(addresses);
      return new Set(["0x385f4f8ae47651ce5f58f5265395a669f8281e18"]);
    },
  };
  const p = toPicker(raw, v4);
  assert.equal(asked.length, 1, "one question for the list");
  assert.ok(!asked[0].includes("not-an-address"), "and only about things that could be tokens");
  assert.equal(p.find((t) => t.symbol === "MEME")!.v4, true);
  assert.equal(p.find((t) => t.symbol === "GME")!.v4, false);
});

test("a V4 index that throws costs the flag, not the list", () => {
  const v4 = { v4CurrenciesAmong: () => { throw new Error("db is busy"); } };
  const p = toPicker(raw, v4);
  assert.equal(p.length, 3);
  assert.equal(p.find((t) => t.symbol === "MEME")!.v4, false);
  assert.equal(p.find((t) => t.symbol === "WETH")!.v4, true, "a base is routable whatever the index says");
});

test("a broken or empty source keeps the last good list", async () => {
  let body: unknown = raw;
  let status = 200;
  const fetchImpl = (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const list = new TokenList("https://x/tokens", fetchImpl);
  await list.refresh();
  assert.equal(list.size(), 3);
  body = [];
  await list.refresh();
  assert.equal(list.size(), 3, "an empty answer is not believed");
  status = 500;
  await assert.rejects(list.refresh(), /500/);
  assert.equal(list.size(), 3);
  assert.equal(JSON.parse(list.body()).tokens.length, 3);
});
