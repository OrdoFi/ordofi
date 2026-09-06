/**
 * What a browser sees at https://batch.ordofi.network/.
 *
 * The API lives on POST /order; a person arriving from a link used to get
 * `{"error":"not found"}`. This page says what the thing is, shows it working
 * from this host's own endpoints, and puts the integration on one screen.
 * Self-contained: nothing here depends on the app being up.
 */
export function batchHtml(opts: { contract: string; explorer: string; rpc: string; app: string; docs: string; windowMs: number; feeBps: number; maxFeeBps: number }): string {
  const { contract, explorer, rpc, app, docs, windowMs, feeBps, maxFeeBps } = opts;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Ordo Batch — netting for Robinhood Chain</title>
<meta name="description" content="Opposite trades on the same token meet each other before touching the pool. Only the difference pays price impact. Signed intents in, one settlement per pair per ${windowMs} ms." />
<link rel="icon" type="image/png" sizes="32x32" href="${app}/favicon-32.png" />
<link href="https://fonts.googleapis.com/css2?family=Funnel+Display:wght@400;500;600;700&family=Inter:wght@400;500;600&family=Fira+Code:wght@400;500&display=swap" rel="stylesheet" />
<style>
  :root { --bg:#efeeea; --card:#f3f2ee; --elev:#eae8e3; --border:#d8d5ce; --border2:#c6c2b9; --text:#1d1616; --dim:#3a3430; --muted:#6d6660; --accent:#ff6414; --accent2:#e35505; --soft:#ffe3d2; --ok:#1e9e6a; --bad:#c0392b;
    --mono:"Fira Code",ui-monospace,Menlo,monospace; --sans:Inter,-apple-system,sans-serif; --display:"Funnel Display",Inter,sans-serif; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:var(--bg); color:var(--text); font-family:var(--sans); line-height:1.6; -webkit-font-smoothing:antialiased; }
  a { color:inherit; text-decoration:none; }
  .wrap { max-width:1040px; margin:0 auto; padding:0 28px; }
  nav { border-bottom:1px solid var(--border); position:sticky; top:0; background:rgba(239,238,234,.9); backdrop-filter:blur(12px); z-index:5; }
  nav .wrap { display:flex; align-items:center; justify-content:space-between; height:60px; }
  .logo { font-family:var(--display); font-weight:700; font-size:22px; display:flex; align-items:baseline; gap:7px; }
  .logo span { font-family:var(--mono); font-size:10px; font-weight:500; color:var(--accent); letter-spacing:.14em; text-transform:uppercase; border:1px solid var(--accent); padding:2px 6px; transform:translateY(-4px); }
  nav .links { display:flex; gap:22px; font-size:14px; color:var(--dim); }
  nav .links a:hover { color:var(--accent); }
  header { padding:72px 0 44px; border-bottom:1px solid var(--border); }
  .eyebrow { font-family:var(--mono); font-size:11.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--accent); margin-bottom:22px; }
  .eyebrow::before { content:"[ "; } .eyebrow::after { content:" ]"; }
  h1 { font-family:var(--display); font-weight:500; font-size:clamp(38px,5.6vw,68px); line-height:1.04; letter-spacing:-.02em; max-width:20ch; margin-bottom:22px; }
  h1 em { font-style:normal; color:var(--accent); }
  .sub { color:var(--muted); font-size:17px; max-width:640px; margin-bottom:30px; }
  .status { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); border:1px solid var(--border); border-top:none; background:var(--card); }
  .status > div { padding:22px 24px; border-right:1px solid var(--border); }
  .status > div:last-child { border-right:none; }
  .status .k { font-family:var(--mono); font-size:10.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
  .status .v { font-family:var(--display); font-size:24px; font-weight:500; margin-top:6px; letter-spacing:-.01em; color:var(--accent); }
  .status .v small { display:block; font-family:var(--mono); font-size:11px; color:var(--muted); font-weight:400; margin-top:5px; line-height:1.5; }
  .status .v.ok { color:var(--ok); }
  section { padding:64px 0; border-bottom:1px solid var(--border); }
  h2 { font-family:var(--display); font-weight:500; font-size:30px; letter-spacing:-.015em; margin-bottom:26px; }
  .grid3 { display:grid; grid-template-columns:repeat(3,1fr); border:1px solid var(--border); }
  .grid3 > div { padding:28px 26px; border-right:1px solid var(--border); background:var(--bg); }
  .grid3 > div:last-child { border-right:none; }
  .grid3 .n { font-family:var(--mono); font-size:24px; color:var(--accent); margin-bottom:14px; }
  .grid3 h4 { font-family:var(--display); font-size:19px; font-weight:600; margin-bottom:8px; }
  .grid3 p, .lede { color:var(--muted); font-size:14.5px; }
  code, td code { font-family:var(--mono); font-size:.9em; background:var(--soft); color:var(--accent2); padding:1px 5px; }
  .two { display:grid; grid-template-columns:1fr 1fr; gap:40px; align-items:start; }
  table { width:100%; border-collapse:collapse; border:1px solid var(--border); background:var(--bg); font-size:13.5px; }
  th, td { text-align:left; padding:10px 14px; border-bottom:1px solid var(--border); vertical-align:top; }
  th { font-family:var(--mono); font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--text); background:var(--elev); font-weight:500; }
  td { color:var(--dim); font-family:var(--mono); font-size:12.5px; word-break:break-all; }
  td a { color:var(--accent); }
  pre { background:#191512; border:1px solid #2c2620; color:#e3ddd2; font-family:var(--mono); font-size:12.5px; line-height:1.7; padding:22px; overflow-x:auto; white-space:pre-wrap; word-break:break-word; }
  pre .c { color:#837a6d; } pre .k { color:#ff8347; } pre .s { color:#d8c07a; }
  .lede { font-size:15.5px; max-width:640px; margin:-14px 0 26px; }
  .tag { display:inline-block; font-family:var(--mono); font-size:10.5px; padding:1px 6px; border:1px solid var(--border2); color:var(--muted); }
  .tag.net { border-color:var(--ok); color:var(--ok); }
  footer { padding:36px 0 40px; display:flex; justify-content:space-between; gap:16px; flex-wrap:wrap; font-family:var(--mono); font-size:12px; color:#8a847a; }
  footer a { color:var(--muted); } footer a:hover { color:var(--accent); }
  @media (max-width:860px) { .status, .grid3 { grid-template-columns:1fr 1fr; } .status > div:nth-child(2n), .grid3 > div:nth-child(2n) { border-right:none; } .status > div, .grid3 > div { border-bottom:1px solid var(--border); } .two { grid-template-columns:1fr; } nav .links { display:none; } }
  @media (max-width:560px) { .status, .grid3 { grid-template-columns:1fr; } .status > div, .grid3 > div { border-right:none; } header { padding:48px 0 36px; } }
</style>
</head>
<body>
<nav><div class="wrap">
  <a class="logo" href="${app}">ordo<span>batch</span></a>
  <div class="links"><a href="${rpc}">RPC</a><a href="${rpc}/swap">Swap</a><a href="https://auction.ordofi.network">VIA</a><a href="${docs}">Docs</a></div>
</div></nav>

<header><div class="wrap">
  <div class="eyebrow">batch.ordofi.network · Robinhood Chain</div>
  <h1>Opposite trades meet <em>before</em> they touch the pool.</h1>
  <p class="sub">On a thin pool a $500 buy moves the price 38%, and the seller one block later moves it back. Both paid for the round trip. Ordo Batch holds orders for ${windowMs} ms, nets buyers against sellers of the same token, and sends only the difference to the AMM. Everyone in a batch clears at one price.</p>
</div></header>

<div class="wrap">
  <div class="status">
    <div><div class="k">Batcher</div><div class="v" id="st-status">checking…</div></div>
    <div><div class="k">Settlements</div><div class="v" id="st-batches">—<small>on-chain, since deploy</small></div></div>
    <div><div class="k">Orders filled</div><div class="v" id="st-filled">—<small id="st-netted">— met a counterparty</small></div></div>
    <div><div class="k">Window</div><div class="v">${windowMs} ms<small>${windowMs / 100} blocks of flow per batch</small></div></div>
  </div>
</div>

<section><div class="wrap">
  <h2>What happens to an order</h2>
  <div class="grid3">
    <div><div class="n">01</div><h4>Sign, don't send</h4><p>An order is an EIP-712 intent: sell exactly this much of one token for at least that much of another, valid for a few seconds. No transaction, no gas. Paying in ether? <code>depositOrder</code> escrows it in the contract and the deposit itself is the authorisation.</p></div>
    <div><div class="n">02</div><h4>Net, then route</h4><p>Every ${windowMs} ms the batcher takes each pair's orders together. Buyers and sellers cancel out peer-to-peer; the residual is priced against the real AMM by simulating the settlement, and the clearing price is set from that answer. Nothing is guessed.</p></div>
    <div><div class="n">03</div><h4>One price, checked on-chain</h4><p>The contract pays every order at the same rate per token, enforces every limit, and then checks per token that it neither lost funds nor kept more than ${maxFeeBps} bps of what passed through. The fee is ${feeBps} bps of the improvement, taken only when the batch beat the pool. An order nobody met goes to the pool at the pool's own price and pays nothing: Batch is never worse than the pool.</p></div>
  </div>
</div></section>

<section><div class="wrap">
  <h2>Recent settlements</h2>
  <p class="lede">From this host's own ledger. <span class="tag net">netted</span> means at least one order met a counterparty instead of the pool.</p>
  <table id="batches"><tr><th>When</th><th>Pair</th><th>Orders</th><th>Netted</th><th>Residual</th><th>Tx</th></tr><tr><td colspan="6" style="color:var(--muted)">loading…</td></tr></table>
</div></section>

<section><div class="wrap two">
  <div>
    <h2>Integrate</h2>
    <p class="lede">Three calls. The order shape is the contract's <code>Order</code> struct; the domain is <code>OrdoBatch</code> v1 on chain 4663 at the contract address.</p>
    <table>
      <tr><th>Contract</th><td><a href="${explorer}/address/${contract}">${contract}</a></td></tr>
      <tr><th>Post an order</th><td>POST <code>/order</code> — <code>{ order, signature }</code>; empty signature for a deposited order</td></tr>
      <tr><th>Status</th><td>GET <code>/order/:hash</code> → pending · settling · filled · rejected · expired</td></tr>
      <tr><th>Health</th><td>GET <code>/health</code> · <code>/stats</code> · <code>/batches</code></td></tr>
      <tr><th>Ether in</th><td><code>depositOrder(order){ value }</code> with <code>sellToken = WETH</code>; refund after <code>validTo</code></td></tr>
      <tr><th>Ether out</th><td><code>buyToken = 0x0</code></td></tr>
      <tr><th>Approval</th><td>ERC-20 sells: approve the contract once</td></tr>
    </table>
  </div>
  <div>
    <h2>From code</h2>
<pre><span class="c">// viem — sign an intent and post it</span>
<span class="k">const</span> order = {
  owner, receiver: <span class="s">"0x0000000000000000000000000000000000000000"</span>,
  sellToken: WETH, buyToken: TOKEN,
  sellAmount: <span class="s">"2000000000000000"</span>,   <span class="c">// 0.002 ETH, as WETH</span>
  minBuyAmount: <span class="s">"0"</span>,              <span class="c">// your slippage floor</span>
  validTo: now + 30, nonce: Date.now(),
  appData: <span class="s">"0x…"</span>,                <span class="c">// your app id, 32 bytes</span>
};
<span class="k">const</span> signature = <span class="k">await</span> wallet.signTypedData({
  domain: { name: <span class="s">"OrdoBatch"</span>, version: <span class="s">"1"</span>, chainId: 4663, verifyingContract: <span class="s">"${contract}"</span> },
  types: { Order: [ …owner, receiver, sellToken, buyToken, sellAmount, minBuyAmount, validTo(uint32), nonce, appData(bytes32) ] },
  primaryType: <span class="s">"Order"</span>, message: order,
});
<span class="k">const</span> { orderHash } = <span class="k">await</span> fetch(<span class="s">"https://batch.ordofi.network/order"</span>, {
  method: <span class="s">"POST"</span>, headers: { <span class="s">"content-type"</span>: <span class="s">"application/json"</span> },
  body: JSON.stringify({ order, signature }),
}).then(r =&gt; r.json());
<span class="c">// then poll /order/{orderHash} — filled in about a window</span></pre>
  </div>
</div></section>

<footer class="wrap">
  <span>© 2026 OrdoFi Labs · not affiliated with Robinhood Markets, Inc.</span>
  <span><a href="${app}">app</a> &nbsp;·&nbsp; <a href="/health">/health</a> &nbsp;·&nbsp; <a href="/stats">/stats</a> &nbsp;·&nbsp; <a href="/batches">/batches</a></span>
</footer>

<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
  const names = { "0x0bd7d308f8e1639fab988df18a8011f41eacad73": "ETH", "0x5fc5360d0400a0fd4f2af552add042d716f1d168": "USDG", "0xfe2f0fb0c00d19786a8abf98d4b1f1ac8763b167": "ORDO" };
  const name = (a) => names[a] ?? short(a);
  const ago = (t) => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? Math.round(s) + "s ago" : s < 3600 ? Math.round(s / 60) + "m ago" : s < 86400 ? (s / 3600).toFixed(1) + "h ago" : (s / 86400).toFixed(1) + "d ago"; };
  const units = (wei, tok) => { const n = Number(BigInt(wei)) / (tok === "USDG" ? 1e6 : 1e18); return n === 0 ? "0" : n < 0.001 ? n.toExponential(2) : n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 4 : 2 }); };
  async function refresh() {
    try {
      const h = await (await fetch("/health", { signal: AbortSignal.timeout(4000) })).json();
      $("st-status").textContent = h.status === "ok" ? "live" : h.status;
      $("st-status").className = "v " + (h.status === "ok" ? "ok" : "");
      $("st-batches").innerHTML = h.stats.batches.toLocaleString() + "<small>on-chain, since deploy</small>";
      $("st-filled").innerHTML = h.stats.filled.toLocaleString() + "<small>" + h.stats.netted.toLocaleString() + " met a counterparty</small>";
    } catch { $("st-status").textContent = "unreachable"; }
    try {
      const { batches } = await (await fetch("/batches", { signal: AbortSignal.timeout(4000) })).json();
      const rows = batches.filter((b) => b.ok).slice(0, 20).map((b) => {
        const a = name(b.tokenA), c = name(b.tokenB);
        const netted = BigInt(b.nettedA) > 0n;
        const residual = BigInt(b.residualA) > 0n ? units(b.residualA, a) + " " + a : units(b.residualB, c) + " " + c;
        return "<tr><td>" + ago(b.at) + "</td><td>" + a + " / " + c + "</td><td>" + b.orders + "</td><td>" + (netted ? '<span class="tag net">netted</span> ' + units(b.nettedA, a) + " " + a : '<span class="tag">pool only</span>') + "</td><td>" + residual + "</td><td><a href=\\"${explorer}/tx/" + b.txHash + "\\">" + short(b.txHash) + "</a></td></tr>";
      });
      $("batches").innerHTML = "<tr><th>When</th><th>Pair</th><th>Orders</th><th>Netted</th><th>Residual</th><th>Tx</th></tr>" + (rows.length ? rows.join("") : '<tr><td colspan="6" style="color:var(--muted)">no settlements since this process started</td></tr>');
    } catch { /* cosmetic */ }
  }
  refresh(); setInterval(refresh, 10000);
})();
</script>
</body>
</html>`;
}
