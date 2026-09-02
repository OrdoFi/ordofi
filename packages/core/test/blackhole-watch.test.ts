import { strict as assert } from "node:assert";
import test from "node:test";
import { BLACKHOLES } from "../src/guard.ts";
import { diffBlackholes, formatAlert, readBlackholes, startBlackholeWatch } from "../src/blackhole-watch.ts";

const fakeRpc = (balances: Record<string, bigint>, block = 0x1000) => async (method: string, params: unknown[]) => {
  if (method === "eth_blockNumber") return "0x" + block.toString(16);
  if (method === "eth_getBalance") return "0x" + (balances[String(params[0]).toLowerCase()] ?? 0n).toString(16);
  throw new Error("unexpected " + method);
};

test("reads every black hole at one block", async () => {
  const r = await readBlackholes(fakeRpc({ [BLACKHOLES[1]]: 5n }));
  assert.equal(r.block, 0x1000);
  assert.equal(r.balances.size, BLACKHOLES.length);
  assert.equal(r.balances.get(BLACKHOLES[1]), 5n);
});

test("only an increase is an alert; steady or falling balances are not", () => {
  const prev = new Map<string, bigint>([[BLACKHOLES[1], 10n], [BLACKHOLES[2], 10n], [BLACKHOLES[3], 10n]]);
  const next = { block: 7, balances: new Map<string, bigint>([[BLACKHOLES[1], 12n], [BLACKHOLES[2], 10n], [BLACKHOLES[3], 9n], [BLACKHOLES[4], 1n]]) };
  const alerts = diffBlackholes(prev, next);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].address, BLACKHOLES[1]);
  assert.equal(alerts[0].delta, 2n);
  assert.match(formatAlert(alerts[0]), /BLACK HOLE FUNDED/);
});

test("the watcher fires the alert callback when a balance grows between ticks", async () => {
  const balances: Record<string, bigint> = { [BLACKHOLES[1]]: 4n * 10n ** 18n };
  const seen: string[] = [];
  const quiet = { log: () => {}, error: (m: string) => seen.push("ERR " + m) };
  const stop = startBlackholeWatch({ intervalMs: 20, rpc: fakeRpc(balances), onAlert: (a) => { seen.push(`${a.address}:${a.delta}`); }, log: quiet });
  await new Promise((r) => setTimeout(r, 30));
  balances[BLACKHOLES[1]] += 376n * 10n ** 15n;
  await new Promise((r) => setTimeout(r, 60));
  stop();
  assert.ok(seen.includes(`${BLACKHOLES[1]}:${376n * 10n ** 15n}`), JSON.stringify(seen));
});
