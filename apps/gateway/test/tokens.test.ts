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
  assert.equal(meme.icon, null);
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
