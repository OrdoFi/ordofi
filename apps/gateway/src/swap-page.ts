/**
 * What a browser sees at https://rpc.ordofi.network/swap.
 *
 * Ordo Swap is a contract and an RPC method, which is nothing a person can
 * click. This page is where it lives: what it does, the contract it is, what
 * it has paid back so far (read live from the chain via /swap/stats), and
 * the one call that uses it. Same shell as the RPC landing page; self-contained
 * for the same reason.
 */
export function swapHtml(opts: { address: string; explorer: string; rpc: string; app: string; docs: string; proofTx: string }): string {
  const { address, explorer, rpc, app, docs, proofTx } = opts;
  const short = (a: string) => `${a.slice(0, 10)}…${a.slice(-6)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Ordo Swap — the swap that keeps its own MEV · Robinhood Chain</title>
<meta name="description" content="Every swap on Robinhood Chain leaks value to the bot that lands behind it. Ordo Swap runs that back-run inside your own transaction and pays the surplus to you. Live on mainnet." />
<link rel="icon" type="image/png" sizes="32x32" href="${app}/favicon-32.png" />
<link href="https://fonts.googleapis.com/css2?family=Funnel+Display:wght@400;500;600;700&family=Inter:wght@400;500;600&family=Fira+Code:wght@400;500&display=swap" rel="stylesheet" />
<style>
  :root { --bg:#efeeea; --card:#f3f2ee; --border:#d8d5ce; --border2:#c6c2b9; --text:#1d1616; --dim:#3a3430; --muted:#6d6660; --accent:#ff6414; --accent2:#e35505; --soft:#ffe3d2; --ok:#1e9e6a; --bad:#c0392b;
    --mono:"Fira Code",ui-monospace,Menlo,monospace; --sans:Inter,-apple-system,sans-serif; --display:"Funnel Display",Inter,sans-serif; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:var(--bg); color:var(--text); font-family:var(--sans); line-height:1.6; -webkit-font-smoothing:antialiased; }
  a { color:inherit; text-decoration:none; } a:hover { color:var(--accent); }
  ::selection { background:var(--accent); color:#fff; }
  .wrap { max-width:1040px; margin:0 auto; padding:0 28px; }
  nav { border-bottom:1px solid var(--border); position:sticky; top:0; background:rgba(239,238,234,.9); backdrop-filter:blur(12px); z-index:5; }
  nav .wrap { display:flex; align-items:center; justify-content:space-between; height:60px; }
  .logo { font-family:var(--display); font-weight:700; font-size:22px; display:flex; align-items:baseline; gap:7px; }
  .logo span { font-family:var(--mono); font-size:10px; font-weight:500; color:var(--accent); letter-spacing:.14em; text-transform:uppercase; border:1px solid var(--accent); padding:2px 6px; transform:translateY(-4px); }
  nav .links { display:flex; gap:22px; font-size:14px; color:var(--dim); }
  header { padding:72px 0 44px; border-bottom:1px solid var(--border); }
  .eyebrow { font-family:var(--mono); font-size:11.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--accent); margin-bottom:22px; }
  .eyebrow::before { content:"[ "; } .eyebrow::after { content:" ]"; }
  h1 { font-family:var(--display); font-weight:500; font-size:clamp(38px,5.6vw,64px); line-height:1.05; letter-spacing:-.02em; max-width:20ch; margin-bottom:22px; }
  h1 em { font-style:normal; color:var(--accent); }
  .sub { color:var(--muted); font-size:17px; max-width:640px; }
  .status { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); border:1px solid var(--border); border-top:none; }
  .status > div { padding:22px 24px; border-right:1px solid var(--border); }
  .status > div:last-child { border-right:none; }
  .status .k { font-family:var(--mono); font-size:10.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
  .status .v { font-family:var(--display); font-size:26px; font-weight:500; margin-top:6px; letter-spacing:-.01em; }
  .status .v small { font-family:var(--mono); font-size:11px; color:var(--muted); font-weight:400; display:block; margin-top:5px; line-height:1.5; }
  .status .v.ok { color:var(--ok); }
  section { padding:60px 0; border-bottom:1px solid var(--border); }
  h2 { font-family:var(--display); font-weight:500; font-size:30px; letter-spacing:-.015em; margin-bottom:10px; }
  .lede { color:var(--muted); font-size:15.5px; max-width:680px; margin-bottom:26px; }
  .grid3 { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); border:1px solid var(--border); }
  .grid3 > div { padding:26px 24px; border-right:1px solid var(--border); }
  .grid3 > div:last-child { border-right:none; }
  .grid3 .n { font-family:var(--mono); font-size:22px; color:var(--accent); margin-bottom:12px; }
  .grid3 h4 { font-family:var(--display); font-size:18px; font-weight:600; margin-bottom:8px; }
  .grid3 p { color:var(--muted); font-size:14px; }
  p code, td code, li code { font-family:var(--mono); font-size:.9em; background:var(--soft); color:var(--accent2); padding:1px 5px; }
  table { width:100%; border-collapse:collapse; border:1px solid var(--border); background:var(--bg); font-size:13.5px; }
  th, td { text-align:left; padding:11px 15px; border-bottom:1px solid var(--border); vertical-align:top; }
  th { font-family:var(--mono); font-size:10.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); font-weight:500; }
  tr:last-child td { border-bottom:none; }
  .mono { font-family:var(--mono); font-size:12.5px; }
  .empty { padding:34px 18px; text-align:center; color:var(--muted); font-size:14.5px; border:1px dashed var(--border2); }
  pre { background:var(--card); border:1px solid var(--border); padding:18px 20px; overflow-x:auto; font-family:var(--mono); font-size:12.5px; line-height:1.75; }
  pre .c { color:var(--muted); } pre .s { color:var(--accent2); }
  .proof { border:1px solid var(--accent); background:var(--soft); padding:22px 24px; margin-top:26px; }
  .proof b { font-family:var(--display); font-size:17px; display:block; margin-bottom:6px; }
  .proof p { color:var(--dim); font-size:14.5px; }
  .split { display:grid; grid-template-columns:1fr 1fr; gap:36px; align-items:start; }
  .split p { color:var(--muted); font-size:15px; margin-bottom:14px; }
  .split h3 { font-family:var(--display); font-size:20px; font-weight:600; margin-bottom:10px; }
  footer { padding:34px 0 60px; font-size:13px; color:var(--muted); display:flex; justify-content:space-between; gap:20px; flex-wrap:wrap; }
  @media (max-width:860px) { .status { grid-template-columns:repeat(2,minmax(0,1fr)); } .grid3 { grid-template-columns:1fr; } .split { grid-template-columns:1fr; } .hide-s { display:none; } }
  @media (max-width:600px) { nav .links { gap:14px; font-size:13px; } .logo { font-size:19px; } }
  @media (max-width:430px) { nav .links a:nth-child(n+3) { display:none; } }
</style>
</head>
<body>
<nav><div class="wrap">
  <a class="logo" href="${app}">ordo <span>swap</span></a>
  <div class="links"><a href="${rpc}">rpc</a><a href="${docs}">docs</a><a href="https://auction.ordofi.network">via</a><a href="${app}">app</a></div>
</div></nav>

<header><div class="wrap">
  <div class="eyebrow">Live on Robinhood Chain</div>
  <h1>The swap that <em>keeps its own MEV.</em></h1>
  <p class="sub">Every swap on this chain pushes a price, and the transaction that lands 100 ms behind it pockets the difference — about $40,000 a day, measured. Ordo Swap runs that back-run <em>inside your own transaction</em>, so there is nothing behind you to take, and pays the surplus to you. No searchers, no auction, no race. It is in the transaction.</p>
</div></header>

<div class="wrap"><div class="status">
  <div><div class="k">Returned to users</div><div class="v ok" id="st-user">—</div></div>
  <div><div class="k">Swaps</div><div class="v" id="st-swaps">—</div></div>
  <div><div class="k">Back-runs reclaimed</div><div class="v" id="st-reclaims">—</div></div>
  <div><div class="k">Contract</div><div class="v mono" style="font-size:15px"><a href="${explorer}/address/${address}" target="_blank" rel="noopener">${short(address)}</a><small>owner-withdrawable float only · 90% of surplus to the user</small></div></div>
</div></div>

<section><div class="wrap">
  <h2>How one transaction does it</h2>
  <div class="grid3">
    <div><div class="n">01</div><h4>Your swap</h4><p>Exactly your input is pulled and swapped through Uniswap V3 with your own slippage floor. Output goes straight to you. The contract's capital is never an input to your leg.</p></div>
    <div><div class="n">02</div><h4>Its back-run</h4><p>Your swap moved one fee tier of the pair away from the others. In the same transaction the contract trades its own float around that gap — buy on the tier you left cheap, sell into the one you left dear — and the round trip must return more than it put in or it does not run.</p></div>
    <div><div class="n">03</div><h4>Your surplus</h4><p>What the round trip made is split on-chain: 90% to you, 10% stays in the float. If the gap closed before inclusion, the back-run is skipped and your swap still lands. It can never fail because of the reclaim.</p></div>
  </div>
  <div class="proof">
    <b>First one on mainnet</b>
    <p>0.075 ETH → 177.37 USDG on the 1% tier, then bought back on the 0.01% tier and sold into the gap: <b style="display:inline;font-size:inherit">0.001204 ETH back to the sender</b>, same block. <a class="mono" href="${explorer}/tx/${proofTx}" target="_blank" rel="noopener" style="color:var(--accent)">${short(proofTx)} →</a></p>
  </div>
</div></section>

<section><div class="wrap">
  <h2>Recent reclaims</h2>
  <p class="lede">Every back-run the contract has run, newest first, read from its <code>Reclaimed</code> events. Swaps that opened no gap worth closing are not listed here: they were just swaps.</p>
  <div id="rows"><div class="empty">loading…</div></div>
</div></section>

<section><div class="wrap">
  <h2>Use it</h2>
  <p class="lede">One RPC call returns the transaction to send: the swap you asked for with the best reclaim attached, or with none and the reason. Sign it, send it. Works with any wallet that lets a dapp set the gas limit.</p>
  <pre><span class="c"># quote: what you would get, and what would come back</span>
curl -X POST ${rpc} -H <span class="s">'content-type: application/json'</span> -d <span class="s">'{
  "jsonrpc":"2.0","id":1,"method":"ordo_quoteSwap",
  "params":[{
    "tokenIn":  "0x0bd7d308f8e1639fab988df18a8011f41eacad73",   <span class="c">// WETH</span>
    "tokenOut": "0x5fc5360d0400a0fd4f2af552add042d716f1d168",   <span class="c">// USDG</span>
    "fee": 10000, "amountIn": "0x11c37937e080000",             <span class="c">// 0.08 ETH</span>
    "amountOutMinimum": "0x0", "recipient": "0xYOU", "nativeOut": false
  }]
}'</span>

<span class="c"># → { to, data, value, amountOut, reclaim: { label, profit, surplusToUser, … } | null, note? }
# send { to, data, value } from your wallet. Set gas explicitly (600k is plenty):
# a bare eth_estimateGas finds the smallest gas that does not revert, and that is
# the path where the reclaim starves and is skipped.</span></pre>
  <div class="split" style="margin-top:36px">
    <div>
      <h3>For apps</h3>
      <p>Replace your router call with <code>ordo_quoteSwap</code> and send what it returns. Your users keep the back-run on every swap large enough to have one; on the rest nothing changes. No key required.</p>
      <p><a href="${docs}" style="color:var(--accent)">Integration docs →</a></p>
    </div>
    <div>
      <h3>What is proven</h3>
      <p>The reclaim path must start and end at WETH and the router enforces <code>amountOut ≥ amountIn + minProfit</code>, so the float cannot shrink. Exactly <code>amountIn</code> is pulled from you and approved for that one swap. The split is a constant on the contract, not a decision made afterwards. <a href="https://github.com/OrdoFi/ordo/blob/main/contracts/src/OrdoSwap.sol" target="_blank" rel="noopener" style="color:var(--accent)">Source →</a></p>
    </div>
  </div>
</div></section>

<div class="wrap"><footer>
  <span>© 2026 OrdoFi Labs · not affiliated with Robinhood Markets, Inc.</span>
  <span>contract <a href="${explorer}/address/${address}" target="_blank" rel="noopener" class="mono">${short(address)}</a> &nbsp;·&nbsp; <a href="/swap/stats">/swap/stats</a> &nbsp;·&nbsp; <a href="/health">/health</a></span>
</footer></div>

<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const ETHUSD = 2523;
  const eth = (wei) => Number(BigInt(wei)) / 1e18;
  const usd = (wei) => "$" + (eth(wei) * ETHUSD).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const short = (h) => h.slice(0, 8) + "…" + h.slice(-4);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  async function refresh() {
    const s = await fetch("/swap/stats").then((r) => r.json()).catch(() => null);
    if (!s) return;
    $("st-user").innerHTML = usd(s.toUserWei) + "<small>" + eth(s.toUserWei).toFixed(6) + " ETH · since deploy</small>";
    $("st-swaps").innerHTML = s.swaps.toLocaleString() + "<small>through the contract</small>";
    $("st-reclaims").innerHTML = s.reclaims.toLocaleString() + "<small>" + (s.skipped ? s.skipped + " skipped (gap closed first)" : "none skipped") + "</small>";
    if (!s.recent.length) {
      $("rows").innerHTML = '<div class="empty">No reclaims yet in the scanned range.</div>';
      return;
    }
    const rows = s.recent.map((r) => "<tr>" +
      '<td class="mono"><a href="${explorer}/tx/' + esc(r.tx) + '" target="_blank" rel="noopener">' + short(r.tx) + "</a></td>" +
      '<td class="mono hide-s">' + short(r.recipient) + "</td>" +
      "<td>" + eth(r.profitWei).toFixed(6) + " ETH</td>" +
      '<td style="color:var(--ok)">' + eth(r.toUserWei).toFixed(6) + " ETH <span class=\\"mono\\" style=\\"color:var(--muted)\\">" + usd(r.toUserWei) + "</span></td>" +
      '<td class="mono hide-s" style="color:var(--muted)">' + r.block.toLocaleString() + "</td>" +
      "</tr>").join("");
    $("rows").innerHTML = "<table><thead><tr><th>Tx</th><th class=\\"hide-s\\">User</th><th>Reclaimed</th><th>To the user</th><th class=\\"hide-s\\">Block</th></tr></thead><tbody>" + rows + "</tbody></table>";
  }
  refresh();
  setInterval(refresh, 20000);
})();
</script>
</body>
</html>`;
}
