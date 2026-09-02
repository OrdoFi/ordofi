/**
 * What a browser sees at https://rpc.ordofi.network/.
 *
 * JSON-RPC lives on POST; a human clicking the URL from a tweet used to get an
 * empty 405. This page explains the endpoint, adds it to the visitor's wallet
 * in one click, and proves it is alive by calling itself from the page.
 * Self-contained on purpose: the gateway is its own origin and must not
 * depend on the app being up.
 */
export function landingHtml(opts: { chainId: number; explorer: string; docs: string; portal: string; app: string }): string {
  const { chainId, explorer, docs, portal, app } = opts;
  const chainIdHex = "0x" + chainId.toString(16);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>rpc.ordofi.network — OrdoFi protected RPC for Robinhood Chain</title>
<meta name="description" content="A drop-in, MEV-protected JSON-RPC endpoint for Robinhood Chain (chain id ${chainId}). Every transaction is simulated before it ships and delivered privately to the sequencer." />
<link rel="icon" type="image/png" sizes="32x32" href="${app}/favicon-32.png" />
<link rel="apple-touch-icon" href="${app}/apple-touch-icon.png" />
<link href="https://fonts.googleapis.com/css2?family=Funnel+Display:wght@400;500;600;700&family=Inter:wght@400;500;600&family=Fira+Code:wght@400;500&display=swap" rel="stylesheet" />
<style>
  :root { --bg:#efeeea; --card:#f3f2ee; --elev:#eae8e3; --border:#d8d5ce; --border2:#c6c2b9; --text:#1d1616; --dim:#3a3430; --muted:#6d6660; --accent:#ff6414; --accent2:#e35505; --soft:#ffe3d2; --ok:#1e9e6a; --bad:#c0392b;
    --mono:"Fira Code",ui-monospace,Menlo,monospace; --sans:Inter,-apple-system,sans-serif; --display:"Funnel Display",Inter,sans-serif; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:var(--bg); color:var(--text); font-family:var(--sans); line-height:1.6; -webkit-font-smoothing:antialiased; }
  a { color:inherit; text-decoration:none; }
  ::selection { background:var(--accent); color:#fff; }
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
  h1 { font-family:var(--display); font-weight:500; font-size:clamp(38px,5.6vw,68px); line-height:1.04; letter-spacing:-.02em; max-width:18ch; margin-bottom:22px; }
  h1 em { font-style:normal; color:var(--accent); }
  .sub { color:var(--muted); font-size:17px; max-width:600px; margin-bottom:30px; }
  .cta { display:flex; gap:12px; flex-wrap:wrap; align-items:center; }
  .btn { display:inline-flex; align-items:center; gap:8px; padding:11px 20px; background:var(--accent); color:#fff; border:1px solid var(--accent); font-weight:600; font-size:14px; cursor:pointer; font-family:var(--sans); transition:background .15s; }
  .btn:hover { background:var(--accent2); }
  .btn.ghost { background:transparent; color:var(--text); border-color:var(--border2); }
  .btn.ghost:hover { border-color:var(--text); }
  .cta .note { font-family:var(--mono); font-size:11.5px; color:var(--muted); }
  .status { display:grid; grid-template-columns:repeat(4,1fr); border:1px solid var(--border); border-top:none; }
  .status > div { padding:22px 24px; border-right:1px solid var(--border); }
  .status > div:last-child { border-right:none; }
  .status .k { font-family:var(--mono); font-size:10.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
  .status .v { font-family:var(--display); font-size:26px; font-weight:500; margin-top:6px; letter-spacing:-.01em; }
  .status .v small { font-family:var(--mono); font-size:11px; color:var(--muted); font-weight:400; margin-left:6px; }
  .status .v.ok { color:var(--ok); } .status .v.bad { color:var(--bad); }
  section { padding:64px 0; border-bottom:1px solid var(--border); }
  h2 { font-family:var(--display); font-weight:500; font-size:30px; letter-spacing:-.015em; margin-bottom:26px; }
  .grid3 { display:grid; grid-template-columns:repeat(3,1fr); border:1px solid var(--border); }
  .grid3 > div { padding:28px 26px; border-right:1px solid var(--border); background:var(--bg); }
  .grid3 > div:last-child { border-right:none; }
  .grid3 .n { font-family:var(--mono); font-size:24px; color:var(--accent); margin-bottom:14px; }
  .grid3 h4 { font-family:var(--display); font-size:19px; font-weight:600; margin-bottom:8px; }
  .grid3 p { color:var(--muted); font-size:14.5px; }
  .grid3 code, p code, td code { font-family:var(--mono); font-size:.9em; background:var(--soft); color:var(--accent2); padding:1px 5px; }
  .two { display:grid; grid-template-columns:1fr 1fr; gap:40px; align-items:start; }
  table { width:100%; border-collapse:collapse; border:1px solid var(--border); background:var(--bg); font-size:14px; }
  th, td { text-align:left; padding:11px 15px; border-bottom:1px solid var(--border); vertical-align:top; }
  th { font-family:var(--mono); font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--text); background:var(--elev); font-weight:500; width:38%; }
  td { color:var(--dim); font-family:var(--mono); font-size:13px; word-break:break-all; }
  td .copy { float:right; font-size:11px; color:var(--accent); cursor:pointer; margin-left:10px; }
  pre { background:#191512; border:1px solid #2c2620; color:#e3ddd2; font-family:var(--mono); font-size:12.5px; line-height:1.7; padding:22px; overflow-x:auto; white-space:pre-wrap; word-break:break-word; }
  pre .c { color:#837a6d; } pre .k { color:#ff8347; } pre .s { color:#d8c07a; }
  .lede { color:var(--muted); font-size:15.5px; max-width:640px; margin:-14px 0 26px; }
  footer { padding:36px 0 40px; display:flex; justify-content:space-between; gap:16px; flex-wrap:wrap; font-family:var(--mono); font-size:12px; color:#8a847a; }
  footer a { color:var(--muted); } footer a:hover { color:var(--accent); }
  @media (max-width:860px) { .status, .grid3 { grid-template-columns:1fr 1fr; } .status > div:nth-child(2n), .grid3 > div:nth-child(2n) { border-right:none; } .status > div, .grid3 > div { border-bottom:1px solid var(--border); } .two { grid-template-columns:1fr; } nav .links { display:none; } }
  @media (max-width:560px) { .status, .grid3 { grid-template-columns:1fr; } .status > div, .grid3 > div { border-right:none; } header { padding:48px 0 36px; } }
</style>
</head>
<body>
<nav><div class="wrap">
  <a class="logo" href="${app}">ordo<span>rpc</span></a>
  <div class="links"><a href="${app}/trade">Trade</a><a href="${app}/explorer">Explorer</a><a href="${portal}">Get a key</a><a href="${docs}">Docs</a></div>
</div></nav>

<header><div class="wrap">
  <div class="eyebrow">rpc.ordofi.network · chain ${chainId}</div>
  <h1>The <em>protected</em> RPC for Robinhood Chain.</h1>
  <p class="sub">A drop-in JSON-RPC endpoint. Point any wallet at it and every transaction is simulated before it ships, delivered privately to the sequencer, and, with a rebate key, run through OrdoFi's backrun auction so the value it creates flows back to you.</p>
  <div class="cta">
    <button class="btn" id="add">Add to wallet</button>
    <a class="btn ghost" href="${docs}#gateway">Read the gateway docs</a>
    <span class="note" id="add-note">one click · MetaMask, Rabby, Rainbow and any EIP-3085 wallet</span>
  </div>
</div></header>

<div class="wrap"><div class="status">
  <div><div class="k">Endpoint</div><div class="v" id="st-status">checking…</div></div>
  <div><div class="k">Chain head</div><div class="v" id="st-head">—</div></div>
  <div><div class="k">Round trip</div><div class="v" id="st-rtt">—</div></div>
  <div><div class="k">Routed through here</div><div class="v" id="st-routed">—</div></div>
</div></div>

<section><div class="wrap">
  <h2>What happens to a transaction here</h2>
  <div class="grid3">
    <div><div class="n">01</div><h4>Simulated first</h4><p>Every <code>eth_sendRawTransaction</code> is executed from the recovered sender against the current state before it is forwarded. If it would revert, it is rejected with code <code>-32000</code> and never reaches the sequencer, so you do not pay gas for a guaranteed failure. If it would succeed but pay ETH or tokens to an address nobody controls — a precompile, the zero or dead address, the classic <code>unwrapWETH9(…, address(1))</code> mistake — it is rejected the same way, whichever app built the calldata.</p></div>
    <div><div class="n">02</div><h4>Delivered privately</h4><p>Robinhood Chain has no public mempool, but a public RPC still sees your intent before the sequencer does. Through OrdoFi it is held and handed straight to the sequencer, with nothing broadcast on the way.</p></div>
    <div><div class="n">03</div><h4>Backrun pays you</h4><p>With a key that carries a rebate address, transactions that move a pool go through a sealed-bid, second-price auction for the right to rebalance it. The clearing price is charged on-chain and 90% comes back as rebates.</p></div>
  </div>
</div></section>

<section><div class="wrap two">
  <div>
    <h2>Network parameters</h2>
    <p class="lede">Add these manually in any wallet, or use the button above.</p>
    <table>
      <tr><th>Network name</th><td>Robinhood Chain</td></tr>
      <tr><th>RPC URL</th><td>https://rpc.ordofi.network <span class="copy" data-c="https://rpc.ordofi.network">copy</span></td></tr>
      <tr><th>Chain ID</th><td>${chainId} <span style="color:var(--muted)">(${chainIdHex})</span></td></tr>
      <tr><th>Currency</th><td>ETH</td></tr>
      <tr><th>Block explorer</th><td>${explorer.replace(/^https?:\/\//, "")}</td></tr>
      <tr><th>Auth</th><td>none for wallets · <code>x-api-key</code> for auction routing &amp; bundles</td></tr>
      <tr><th>Rate limit</th><td>600 req/min per IP anonymous · per key otherwise</td></tr>
    </table>
  </div>
  <div>
    <h2>From code</h2>
    <p class="lede">Standard <code>eth_*</code> methods pass through. OrdoFi adds <code>ordo_simulate</code>, <code>ordo_sendPrivateTransaction</code>, <code>ordo_sendBundle</code> and <code>ordo_bundlerInfo</code>.</p>
<pre><span class="c"># dry-run a signed transaction, no key needed</span>
curl https://rpc.ordofi.network <span class="k">\\</span>
  -H <span class="s">'content-type: application/json'</span> <span class="k">\\</span>
  -d <span class="s">'{"jsonrpc":"2.0","id":1,"method":"ordo_simulate","params":["0x02f8…"]}'</span>

<span class="c"># route order flow through the auction with your key</span>
curl https://rpc.ordofi.network <span class="k">\\</span>
  -H <span class="s">'x-api-key: ordo_…'</span> -H <span class="s">'content-type: application/json'</span> <span class="k">\\</span>
  -d <span class="s">'{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x02f8…"]}'</span></pre>
    <p class="lede" style="margin-top:18px">Keys are self-served at <a href="${portal}" style="color:var(--accent)">${portal.replace(/^https?:\/\//, "")}</a>; the full method reference, error codes and bundle semantics are in the <a href="${docs}#gateway" style="color:var(--accent)">docs</a>.</p>
  </div>
</div></section>

<footer class="wrap">
  <span>© 2026 OrdoFi Labs · not affiliated with Robinhood Markets, Inc.</span>
  <span><a href="${app}">app</a> &nbsp;·&nbsp; <a href="/health">/health</a> &nbsp;·&nbsp; <a href="/metrics">/metrics</a> &nbsp;·&nbsp; <a href="${docs}">docs</a></span>
</footer>

<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const rpc = async (method, params = []) => {
    const r = await fetch(location.origin, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return d.result;
  };
  const fmtUp = (s) => s >= 86400 ? (s / 86400).toFixed(1) + "d" : s >= 3600 ? (s / 3600).toFixed(1) + "h" : Math.round(s / 60) + "m";
  async function probe() {
    const t0 = performance.now();
    try {
      const [chain, head] = await Promise.all([rpc("eth_chainId"), rpc("eth_blockNumber")]);
      const rtt = Math.round(performance.now() - t0);
      const ok = chain === "${chainIdHex}";
      $("st-status").textContent = ok ? "live" : "wrong chain";
      $("st-status").className = "v " + (ok ? "ok" : "bad");
      $("st-head").innerHTML = parseInt(head, 16).toLocaleString() + "<small>0.1s blocks</small>";
      $("st-rtt").innerHTML = rtt + "<small>ms from here</small>";
    } catch (e) {
      $("st-status").textContent = "unreachable"; $("st-status").className = "v bad";
    }
    try {
      const d = await (await fetch("${app}/api/routed")).json();
      if (d.available) {
        const usd = (n) => "$" + Number(n).toLocaleString(undefined, { maximumFractionDigits: n >= 1000 ? 0 : 2 });
        $("st-routed").innerHTML = usd(d.volumeUsd) + "<small>" + Number(d.transactions.confirmed).toLocaleString() + " tx</small>";
      }
    } catch { /* cosmetic */ }
  }
  probe(); setInterval(probe, 10000);

  $("add").addEventListener("click", async () => {
    const eth = window.ethereum;
    if (!eth) { $("add-note").textContent = "no wallet detected — add the parameters below manually"; return; }
    try {
      await eth.request({ method: "wallet_addEthereumChain", params: [{
        chainId: "${chainIdHex}", chainName: "Robinhood Chain · OrdoFi protected",
        rpcUrls: ["https://rpc.ordofi.network"], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        blockExplorerUrls: ["${explorer}"],
      }] });
      $("add-note").textContent = "added — your wallet now routes through OrdoFi";
    } catch (e) {
      $("add-note").textContent = (e && e.message ? e.message : "cancelled").slice(0, 90);
    }
  });
  document.querySelectorAll(".copy").forEach((el) => el.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(el.dataset.c); el.textContent = "copied"; setTimeout(() => (el.textContent = "copy"), 1200); } catch { /* clipboard blocked */ }
  }));
})();
</script>
</body>
</html>`;
}
