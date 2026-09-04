import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HANDOFF_METHODS, MOBILE_WALLETS, pairingLink } from "../src/wallets.ts";

describe("mobile wallets", () => {
  it("gives every wallet a distinct id", () => {
    const ids = MOBILE_WALLETS.map((w) => w.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("pairs over https, because the app may not be installed", () => {
    // A custom scheme here would show "cannot open page" to someone who has
    // never used the wallet, instead of offering to install it.
    for (const w of MOBILE_WALLETS) assert.ok(w.pair.startsWith("https://"), w.id);
  });

  it("reopens over a scheme, because failing silently is the point", () => {
    for (const w of MOBILE_WALLETS) {
      assert.ok(/^[a-z]+:\/\/$/.test(w.open), w.id);
      assert.ok(!w.open.startsWith("http"), w.id);
    }
  });

  it("carries the pairing uri encoded, in a slot each link actually has", () => {
    for (const w of MOBILE_WALLETS) assert.ok(w.pair.includes("{uri}"), w.id);
    const uri = "wc:7f9c@2?relay-protocol=irn&symKey=abc%2Bdef";
    const link = pairingLink(MOBILE_WALLETS[0], uri);
    // The wc: URI has its own & and = and must survive as one query value.
    assert.ok(link.includes(encodeURIComponent(uri)));
    assert.equal(new URL(link).searchParams.get("uri"), uri);
  });

  it("hands the phone over for what a person has to see, and nothing else", () => {
    const m = new Set<string>(HANDOFF_METHODS);
    assert.ok(m.has("eth_sendTransaction"));
    assert.ok(m.has("personal_sign"));
    assert.ok(m.has("wallet_addEthereumChain"));
    // Reads happen on every quote. Switching apps for one would make the page
    // unusable, and none of them put anything on the wallet's screen.
    for (const read of ["eth_chainId", "eth_accounts", "eth_call", "eth_getBalance", "eth_blockNumber"]) {
      assert.ok(!m.has(read), read);
    }
  });
});
