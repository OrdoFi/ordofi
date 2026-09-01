/**
 * Clear the measurement index without losing anything that cannot be measured
 * again.
 *
 * Correcting an attribution rule means every arb already recorded was recorded
 * under the old one, so the index has to be rebuilt from the chain. Deleting
 * the database file does that — and also throws away the settlements and API
 * keys living in the same file. Settlements are the record that the revenue
 * loop closed on mainnet; the auction writes its NDJSON copy *before*
 * submitting, so it carries no transaction hash and cannot restore them.
 * Twice in one afternoon the site went back to claiming zero settlements
 * because of this.
 *
 * Arbs and swap counts are re-derivable from the chain. Settlements and API
 * keys are not, so they stay.
 *
 *   node --import tsx scripts/reset-index.mjs            # dry run
 *   node --import tsx scripts/reset-index.mjs --yes
 */
import { OrdoStore } from "@ordofi/store";

const DB = process.env.ORDO_DB ?? "data/ordo.db";
const CONFIRMED = process.argv.includes("--yes");

const store = new OrdoStore(DB);
const before = {
  ...store.totals(),
  swaps: store.swapCount(),
  apiKeys: store.apiKeyCount(),
};

console.log(`Index at ${DB}`);
console.log(`  arbs        ${before.arbs.toLocaleString()}   (will be cleared)`);
console.log(`  pools       ${before.pools.toLocaleString()}   (will be cleared)`);
console.log(`  swaps       ${before.swaps.toLocaleString()}   (will be cleared)`);
console.log(`  settlements ${before.settlements.toLocaleString()}   (kept)`);
console.log(`  api keys    ${before.apiKeys.toLocaleString()}   (kept)`);

if (!CONFIRMED) {
  console.log("\nDry run. Pass --yes to clear, then delete data/checkpoint.json and");
  console.log("restart the watcher with ORDO_BACKFILL set to how far back to rebuild.");
  store.close();
  process.exit(0);
}

store.clearMeasurements();
const after = { ...store.totals(), swaps: store.swapCount() };
console.log(`\nCleared. arbs=${after.arbs} pools=${after.pools} swaps=${after.swaps}`);
console.log(`Kept ${after.settlements} settlement(s).`);
console.log("\nNow delete data/checkpoint.json and restart the watcher.");
store.close();
