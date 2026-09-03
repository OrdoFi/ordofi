/**
 * The protected RPC refuses transactions that would revert. Since 2026-09-02 it
 * also refuses transactions that would succeed while paying an address nobody
 * controls, whoever built the calldata.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { BALANCE_READER, BLACKHOLES } from "@ordofi/core/guard";
import { protectAndSend } from "../src/protect.js";

const ROUTER = "0xcaf681a66d020601342297493863e78c959e5cb2";
const signer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const word = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");

async function rawTo(to: string, data: `0x${string}`, value = 0n): Promise<string> {
  return signer.signTransaction({ chainId: 46630, to: to as `0x${string}`, data, value, gas: 300_000n, maxFeePerGas: 10n ** 8n, maxPriorityFeePerGas: 0n, nonce: 1, type: "eip1559" });
}

/** An upstream whose simulated block makes address(1) richer by `burned` wei. */
function upstreamWith(opts: { burned?: bigint; noSimulate?: boolean; revert?: boolean }) {
  const calls: string[] = [];
  const upstream = async (method: string, params: unknown[]): Promise<any> => {
    calls.push(method);
    if (method === "eth_call") {
      if (opts.revert) throw new Error("execution reverted: Too little received");
      return "0x";
    }
    if (method === "eth_sendRawTransaction") return "0xhash";
    if (method === "eth_simulateV1") {
      if (opts.noSimulate) throw new Error("the method eth_simulateV1 does not exist/is not available");
      const sim: any[] = (params[0] as any).blockStateCalls[0].calls;
      const txIndex = sim.findIndex((c) => c.from);
      return [{
        calls: sim.map((c, i) => {
          if (i === txIndex) {
            if (opts.revert) return { status: "0x0", gasUsed: "0x5208", returnData: "0x", error: { message: "execution reverted: Too little received" }, logs: [] };
            return { status: "0x1", gasUsed: "0x1e848", logs: [] };
          }
          const holder = "0x" + c.data.slice(-40);
          const afterTx = i > txIndex;
          let bal = 0n;
          if (c.to.toLowerCase() === BALANCE_READER && holder === BLACKHOLES[1]) bal = 10n ** 18n + (afterTx ? opts.burned ?? 0n : 0n);
          return { status: "0x1", gasUsed: "0x0", returnData: word(bal), logs: [] };
        }),
      }];
    }
    throw new Error("unexpected " + method);
  };
  return { upstream, calls };
}

test("a transaction that pays address(1) is refused with the leak spelled out", async () => {
  const raw = await rawTo(ROUTER, "0x5ae401dc");
  const { upstream, calls } = upstreamWith({ burned: 376n * 10n ** 15n });
  await assert.rejects(protectAndSend(upstream, raw), (e: any) => {
    assert.equal(e.code, -32000);
    assert.match(e.message, /address nobody controls/);
    assert.equal(e.data.ordoProtected, true);
    assert.deepEqual(e.data.leaks, [{ to: BLACKHOLES[1], asset: "eth", amount: (376n * 10n ** 15n).toString() }]);
    return true;
  });
  assert.ok(!calls.includes("eth_sendRawTransaction"), "never reached the sequencer");
});

test("a clean transaction is forwarded after one simulation: two upstream calls, not three", async () => {
  const raw = await rawTo(ROUTER, "0x5ae401dc");
  const { upstream, calls } = upstreamWith({});
  assert.equal(await protectAndSend(upstream, raw), "0xhash");
  assert.deepEqual(calls, ["eth_simulateV1", "eth_sendRawTransaction"]);
});

test("an upstream without eth_simulateV1 falls back to eth_call for revert protection and the send goes through", async () => {
  const raw = await rawTo(ROUTER, "0x5ae401dc");
  const { upstream, calls } = upstreamWith({ noSimulate: true });
  assert.equal(await protectAndSend(upstream, raw), "0xhash");
  assert.deepEqual(calls, ["eth_simulateV1", "eth_call", "eth_sendRawTransaction"]);
});

test("a revert is refused by the same simulation, before anything reaches the sequencer", async () => {
  const raw = await rawTo(ROUTER, "0x5ae401dc");
  const { upstream, calls } = upstreamWith({ revert: true });
  await assert.rejects(protectAndSend(upstream, raw), (e: any) => {
    assert.equal(e.code, -32000);
    assert.match(e.message, /would revert.*Too little received/);
    assert.equal(e.data.ordoProtected, true);
    return true;
  });
  assert.deepEqual(calls, ["eth_simulateV1"]);
});

test("a revert on an upstream that cannot simulate is still caught by eth_call", async () => {
  const raw = await rawTo(ROUTER, "0x5ae401dc");
  const { upstream, calls } = upstreamWith({ noSimulate: true, revert: true });
  await assert.rejects(protectAndSend(upstream, raw), /would revert/);
  assert.deepEqual(calls, ["eth_simulateV1", "eth_call"]);
});
