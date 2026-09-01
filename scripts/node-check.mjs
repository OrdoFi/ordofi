/**
 * Check whether a Robinhood Chain endpoint is good enough to build on.
 *
 * The public endpoint is not, and this prints exactly why: no archive state,
 * no `debug_*`, aggressive rate limiting, and a Cloudflare challenge for any
 * client that does not look like a browser. Point this at your own Nitro node
 * after it syncs and every line should flip.
 *
 * The latency section is the part that decides whether colocation worked. On a
 * first-come-first-served chain with no priority auction, round trip to the
 * sequencer is the entire competitive surface, so it is measured rather than
 * assumed.
 *
 *   node scripts/node-check.mjs [rpcUrl]
 */
const TARGET = process.argv[2] ?? process.env.ORDO_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const PUBLIC = "https://rpc.mainnet.chain.robinhood.com";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let id = 0;
async function call(url, method, params, { browserUA = false } = {}) {
  const started = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(browserUA ? { "user-agent": UA } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const text = await res.text();
  const ms = performance.now() - started;
  if (text.startsWith("<")) return { ms, error: `HTTP ${res.status}: bot challenge / not JSON` };
  const body = JSON.parse(text);
  return { ms, error: body.error?.message, result: body.result };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (label, ok, detail) => console.log(`  ${ok ? "ok  " : "FAIL"}  ${label.padEnd(30)} ${detail ?? ""}`);

console.log(`\nchecking ${TARGET}\n`);

// --- identity ---------------------------------------------------------------
const chain = await call(TARGET, "eth_chainId", [], { browserUA: true });
line("chain id", chain.result === "0x1237", chain.result ? `${parseInt(chain.result, 16)}` : chain.error);

const head = await call(TARGET, "eth_blockNumber", [], { browserUA: true });
const headNum = head.result ? parseInt(head.result, 16) : 0;
line("head", headNum > 0, headNum.toLocaleString());

// --- the three capabilities that matter --------------------------------------
await sleep(400);
const sim = await call(
  TARGET,
  "eth_simulateV1",
  [
    {
      blockStateCalls: [{ calls: [{ to: "0x0bd7d308f8e1639fab988df18a8011f41eacad73", data: "0x18160ddd" }] }],
      validation: false,
    },
    "latest",
  ],
  { browserUA: true },
);
line("eth_simulateV1 (log-level sim)", !sim.error, sim.error ?? "returns logs — pool hints work");

await sleep(400);
const trace = await call(TARGET, "debug_traceCall", [{ to: "0x0bd7d308f8e1639fab988df18a8011f41eacad73", data: "0x18160ddd" }, "latest", { tracer: "callTracer" }], { browserUA: true });
line("debug_traceCall", !trace.error, trace.error ?? "available — honest MEV attribution possible");

await sleep(400);
const oldBlock = "0x" + Math.max(1, headNum - 200_000).toString(16);
const archive = await call(TARGET, "eth_getBalance", ["0x0bd7d308f8e1639fab988df18a8011f41eacad73", oldBlock], {
  browserUA: true,
});
line("archive state (-200k blocks)", !archive.error, archive.error ?? "historical state present — fork tests work");

// --- does it tolerate a real client -------------------------------------------
await sleep(400);
const noUA = await call(TARGET, "eth_chainId", []);
line("serves non-browser clients", !noUA.error, noUA.error ?? "Foundry and viem can talk to it directly");

// --- burst tolerance ------------------------------------------------------------
const BURST = 20;
const burst = await Promise.all(Array.from({ length: BURST }, () => call(TARGET, "eth_blockNumber", [], { browserUA: true })));
const rejected = burst.filter((r) => r.error).length;
line(`burst of ${BURST} concurrent`, rejected === 0, rejected === 0 ? "none rejected" : `${rejected}/${BURST} rejected`);

// --- latency ----------------------------------------------------------------------
async function latency(url) {
  const samples = [];
  for (let i = 0; i < 12; i++) {
    const r = await call(url, "eth_blockNumber", [], { browserUA: true });
    if (!r.error) samples.push(r.ms);
    await sleep(150);
  }
  samples.sort((a, b) => a - b);
  return samples.length ? { p50: samples[Math.floor(samples.length / 2)], min: samples[0], n: samples.length } : null;
}

console.log("\nlatency (12 samples, sequential)");
const mine = await latency(TARGET);
console.log(mine ? `  target  p50 ${mine.p50.toFixed(1)}ms   min ${mine.min.toFixed(1)}ms` : "  target  no successful samples");

if (TARGET !== PUBLIC) {
  const pub = await latency(PUBLIC);
  if (mine && pub) {
    const delta = pub.p50 - mine.p50;
    console.log(`  public  p50 ${pub.p50.toFixed(1)}ms   min ${pub.min.toFixed(1)}ms`);
    console.log(
      `\n  ${delta > 0 ? `${delta.toFixed(1)}ms faster than the public endpoint` : `${(-delta).toFixed(1)}ms SLOWER than the public endpoint`}`,
    );
    console.log(
      "  Measured from wherever this script runs. The number that decides races",
    );
    console.log(
      "  is this same figure measured ON the node, against the sequencer — run",
    );
    console.log("  it there before believing colocation paid for itself.");
  }
}

console.log();
