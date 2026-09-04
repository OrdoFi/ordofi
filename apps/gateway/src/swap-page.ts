/**
 * What a browser sees at https://rpc.ordofi.network/swap: the swap itself.
 *
 * A card like the app's Stealth Send — pick tokens, type an amount, and the
 * quote comes back as you type with the MEV that would come back to you shown
 * next to the price. Connect a wallet, one click, and the receipt shows what
 * you received and what the back-run returned. Below it, what the contract has
 * paid out so far (live from /swap/stats), how it works, and the API.
 *
 * Self-contained: vanilla JS against this same origin's JSON-RPC and any
 * EIP-1193 wallet, no build step, no dependency on the app being up.
 */
import { toEventSelector } from "viem";
import { SWAP_EVENTS } from "./swapstats.js";

export function swapHtml(opts: { address: string; explorer: string; rpc: string; app: string; docs: string; proofTx: string }): string {
  const { address, explorer, rpc, app, docs, proofTx } = opts;
  const short = (a: string) => `${a.slice(0, 10)}…${a.slice(-6)}`;
  const TOPIC_RECLAIMED = toEventSelector(SWAP_EVENTS[1]);
  const TOPIC_SWAPPED = toEventSelector(SWAP_EVENTS[0]);
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
  :root { --bg:#efeeea; --card:#f3f2ee; --border:#d8d5ce; --border2:#c6c2b9; --text:#1d1616; --dim:#3a3430; --muted:#6d6660; --accent:#ff6414; --accent2:#e35505; --soft:#ffe3d2; --ok:#1e9e6a; --okbg:#e6f6ee; --bad:#c0392b; --lime:#b8ff3c;
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
  nav .links { display:flex; gap:22px; font-size:14px; color:var(--dim); align-items:center; }
  .navbtn { font-family:var(--sans); font-size:13px; padding:7px 14px; border:1px solid var(--border2); background:transparent; cursor:pointer; color:var(--text); }
  .navbtn:hover { border-color:var(--text); }
  .navbtn.on { font-family:var(--mono); font-size:12px; border-color:var(--ok); color:var(--ok); }
  .navbtn.on .x { margin-left:8px; color:var(--muted); font-size:11px; }
  .navbtn.on:hover { border-color:var(--bad); color:var(--bad); }
  .navbtn.on:hover .x { color:var(--bad); }

  header { padding:56px 0 48px; border-bottom:1px solid var(--border); }
  .hero { display:grid; grid-template-columns:1.05fr 1fr; gap:48px; align-items:start; }
  .eyebrow { font-family:var(--mono); font-size:11.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--accent); margin-bottom:22px; }
  .eyebrow::before { content:"[ "; } .eyebrow::after { content:" ]"; }
  h1 { font-family:var(--display); font-weight:500; font-size:clamp(36px,4.6vw,56px); line-height:1.05; letter-spacing:-.02em; margin-bottom:20px; }
  h1 em { font-style:normal; color:var(--accent); }
  .sub { color:var(--muted); font-size:16px; max-width:520px; }
  .sub em { color:var(--dim); font-style:italic; }
  .proofline { margin-top:26px; font-family:var(--mono); font-size:12px; color:var(--muted); line-height:1.7; }
  .proofline a { color:var(--accent); }

  /* ---- the card ---- */
  .card { background:#fff; border:1px solid var(--border); padding:26px 28px 24px; position:relative; box-shadow:0 1px 0 rgba(0,0,0,.02); }
  .card h2 { font-family:var(--display); font-size:20px; font-weight:600; letter-spacing:-.01em; display:flex; justify-content:space-between; align-items:center; }
  .gear { font-family:var(--mono); font-size:11px; color:var(--muted); cursor:pointer; border:1px solid var(--border); padding:3px 8px; }
  .gear:hover { border-color:var(--text); color:var(--text); }
  .slip { display:none; gap:6px; margin-top:10px; }
  .slip.open { display:flex; }
  .slip button { font-family:var(--mono); font-size:11px; padding:4px 9px; border:1px solid var(--border); background:#fff; cursor:pointer; color:var(--muted); }
  .slip button.on { border-color:var(--text); color:var(--text); }
  label.f { display:flex; justify-content:space-between; font-size:12px; color:var(--dim); margin:18px 0 7px; }
  label.f .bal { font-family:var(--mono); font-size:11px; color:var(--muted); }
  label.f .bal b { color:var(--accent); cursor:pointer; font-weight:500; margin-left:6px; }
  .box { display:flex; align-items:center; gap:10px; background:var(--bg); border:1px solid var(--border); padding:12px 14px; transition:border-color .15s; }
  .box:focus-within { border-color:var(--text); }
  .box input { flex:1; min-width:0; border:none; background:transparent; font-family:var(--mono); font-size:22px; color:var(--text); outline:none; }
  .box input::placeholder { color:var(--border2); }
  .box .ro { flex:1; font-family:var(--mono); font-size:22px; color:var(--text); min-height:33px; transition:opacity .2s; }
  .box .ro.dim { color:var(--border2); }
  .box .ro.busy { opacity:.35; background:linear-gradient(90deg, transparent 0%, rgba(0,0,0,.05) 50%, transparent 100%); background-size:200% 100%; animation:shimmer 1.1s linear infinite; }
  @keyframes shimmer { from { background-position:200% 0 } to { background-position:-200% 0 } }
  .pill { display:flex; align-items:center; gap:7px; border:1px solid var(--border); background:#fff; padding:6px 10px 6px 8px; font-size:13px; font-weight:600; position:relative; white-space:nowrap; }
  .pill .ico { width:22px; height:22px; flex:none; border-radius:50%; background:var(--soft); color:var(--accent2); font-family:var(--mono); font-size:9px; display:flex; align-items:center; justify-content:center; font-weight:600; overflow:hidden; }
  .pill .ico img { width:100%; height:100%; display:block; }
  .pill select { position:absolute; inset:0; opacity:0; cursor:pointer; width:100%; }
  .flip { display:flex; justify-content:center; margin:-6px 0; position:relative; z-index:1; }
  .flip button { width:34px; height:34px; border:1px solid var(--border); background:#fff; cursor:pointer; font-size:16px; color:var(--dim); transition:transform .35s cubic-bezier(.2,.8,.2,1), border-color .15s; }
  .flip button:hover { border-color:var(--text); }
  .flip button.spin { transform:rotate(180deg); }
  .usd { font-family:var(--mono); font-size:10.5px; color:var(--muted); text-align:right; margin-top:6px; min-height:14px; }

  .mev { margin-top:16px; border:1px solid var(--border); padding:12px 14px; display:flex; justify-content:space-between; align-items:center; gap:12px; transition:all .3s; }
  .mev .l { font-size:13px; color:var(--dim); }
  .mev .l small { display:block; font-family:var(--mono); font-size:10.5px; color:var(--muted); margin-top:2px; }
  .mev .r { font-family:var(--mono); font-size:15px; color:var(--muted); text-align:right; }
  .mev.yes { border-color:var(--ok); background:var(--okbg); animation:pop .45s cubic-bezier(.2,.9,.3,1.3); }
  .mev.yes .r { color:var(--ok); font-weight:600; }
  .mev.yes .r small { display:block; font-size:10.5px; font-weight:400; color:var(--ok); opacity:.8; }
  @keyframes pop { 0% { transform:scale(.97); opacity:.6 } 60% { transform:scale(1.015) } 100% { transform:scale(1); opacity:1 } }

  .rows { margin-top:12px; }
  .row { display:flex; justify-content:space-between; align-items:center; padding:6px 0; font-size:12.5px; color:var(--muted); }
  .row .v { font-family:var(--mono); font-size:12px; color:var(--dim); }

  .go { width:100%; margin-top:18px; padding:15px; font-family:var(--sans); font-size:15px; font-weight:600; background:var(--text); color:#fff; border:1px solid var(--text); cursor:pointer; position:relative; overflow:hidden; transition:background .15s, transform .08s; }
  .go:hover:not(:disabled) { background:#000; }
  .go:active:not(:disabled) { transform:translateY(1px); }
  .go:disabled { opacity:.4; cursor:default; }
  .go.busy::after { content:""; position:absolute; left:-40%; top:0; bottom:0; width:40%; background:linear-gradient(90deg, transparent, rgba(255,255,255,.18), transparent); animation:sweep 1.1s linear infinite; }
  @keyframes sweep { to { left:100% } }
  .go .spin { display:inline-block; width:12px; height:12px; border:2px solid rgba(255,255,255,.35); border-top-color:#fff; border-radius:50%; animation:rot .7s linear infinite; vertical-align:-2px; margin-right:8px; }
  @keyframes rot { to { transform:rotate(360deg) } }

  .result { margin-top:14px; font-family:var(--mono); font-size:11.5px; color:var(--muted); line-height:1.65; min-height:16px; }
  .result a { color:var(--accent); }
  .result.bad { color:var(--bad); }
  .done { margin-top:14px; border:1px solid var(--ok); background:var(--okbg); padding:16px 18px; animation:pop .5s cubic-bezier(.2,.9,.3,1.3); }
  .done b { font-family:var(--display); font-size:17px; display:block; color:var(--text); }
  .done .big { font-family:var(--mono); font-size:22px; color:var(--ok); font-weight:600; margin:6px 0 2px; }
  .done p { font-size:12.5px; color:var(--dim); }
  .done a { color:var(--accent); font-family:var(--mono); font-size:11.5px; }
  .tick { display:inline-flex; width:22px; height:22px; border-radius:50%; background:var(--ok); color:#fff; align-items:center; justify-content:center; font-size:13px; margin-right:8px; vertical-align:-5px; animation:pop .5s .1s both; }

  /* ---- below the fold ---- */
  .status { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); border:1px solid var(--border); border-top:none; }
  .status > div { padding:22px 24px; border-right:1px solid var(--border); }
  .status > div:last-child { border-right:none; }
  .status .k { font-family:var(--mono); font-size:10.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
  .status .v { font-family:var(--display); font-size:26px; font-weight:500; margin-top:6px; letter-spacing:-.01em; }
  .status .v small { font-family:var(--mono); font-size:11px; color:var(--muted); font-weight:400; display:block; margin-top:5px; line-height:1.5; }
  .status .v.ok { color:var(--ok); }
  section { padding:60px 0; border-bottom:1px solid var(--border); }
  h2.s { font-family:var(--display); font-weight:500; font-size:30px; letter-spacing:-.015em; margin-bottom:10px; }
  .lede { color:var(--muted); font-size:15.5px; max-width:680px; margin-bottom:26px; }
  .grid3 { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); border:1px solid var(--border); }
  .grid3 > div { padding:26px 24px; border-right:1px solid var(--border); }
  .grid3 > div:last-child { border-right:none; }
  .grid3 .n { font-family:var(--mono); font-size:22px; color:var(--accent); margin-bottom:12px; }
  .grid3 h4 { font-family:var(--display); font-size:18px; font-weight:600; margin-bottom:8px; }
  .grid3 p { color:var(--muted); font-size:14px; }
  p code, td code { font-family:var(--mono); font-size:.9em; background:var(--soft); color:var(--accent2); padding:1px 5px; }
  table { width:100%; border-collapse:collapse; border:1px solid var(--border); background:var(--bg); font-size:13.5px; }
  th, td { text-align:left; padding:11px 15px; border-bottom:1px solid var(--border); vertical-align:top; }
  th { font-family:var(--mono); font-size:10.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); font-weight:500; }
  tr:last-child td { border-bottom:none; }
  .mono { font-family:var(--mono); font-size:12.5px; }
  .empty { padding:34px 18px; text-align:center; color:var(--muted); font-size:14.5px; border:1px dashed var(--border2); }
  pre { background:var(--card); border:1px solid var(--border); padding:18px 20px; overflow-x:auto; font-family:var(--mono); font-size:12.5px; line-height:1.75; }
  pre .c { color:var(--muted); } pre .s { color:var(--accent2); }
  footer { padding:34px 0 60px; font-size:13px; color:var(--muted); display:flex; justify-content:space-between; gap:20px; flex-wrap:wrap; }

  .modal { position:fixed; inset:0; background:rgba(25,24,23,.4); display:none; align-items:flex-start; justify-content:center; padding-top:12vh; z-index:200; }
  .modal.open { display:flex; }
  .sheet { background:var(--card); border:1px solid var(--border); width:420px; max-width:calc(100vw - 32px); }
  .sheet .mh { padding:14px 18px; border-bottom:1px solid var(--border); font-weight:700; display:flex; justify-content:space-between; }
  .sheet .x { cursor:pointer; color:var(--muted); }
  .wrow { display:flex; align-items:center; gap:12px; padding:13px 18px; cursor:pointer; border-bottom:1px solid var(--border); }
  .wrow:hover { background:#fff; }
  .wrow img { width:28px; height:28px; }
  .wrow .n { font-weight:600; font-size:13.5px; }
  .wnote { padding:13px 18px; font-size:11.5px; color:var(--muted); line-height:1.6; }

  @media (max-width:900px) { .hero { grid-template-columns:1fr; gap:32px; } header { padding:40px 0 40px; } .status { grid-template-columns:repeat(2,minmax(0,1fr)); } .grid3 { grid-template-columns:1fr; } .hide-s { display:none; } }
  @media (max-width:600px) { nav .links { gap:12px; font-size:13px; } .logo { font-size:19px; } .card { padding:20px 18px 18px; } }
  @media (max-width:430px) { nav .links a:nth-child(n+3) { display:none; } }
</style>
</head>
<body>
<nav><div class="wrap">
  <a class="logo" href="${app}">ordo <span>swap</span></a>
  <div class="links"><a href="${rpc}">rpc</a><a href="https://auction.ordofi.network">via</a><a href="${docs}">docs</a><a href="${app}">app</a><button class="navbtn" id="nav-connect">Connect</button></div>
</div></nav>

<header><div class="wrap"><div class="hero">
  <div>
    <div class="eyebrow">Live on Robinhood Chain</div>
    <h1>The swap that <em>keeps its own MEV.</em></h1>
    <p class="sub">Every swap on this chain pushes a price, and the transaction that lands 100 ms behind it pockets the difference — about $40,000 a day, measured. Ordo Swap runs that back-run <em>inside your own transaction</em>, so there is nothing behind you to take, and pays the surplus to you. No searchers, no auction, no race.</p>
    <div class="proofline">first one on mainnet: 0.075 ETH → USDG, <b style="color:var(--ok)">+0.001204 ETH back</b> to the sender, same block<br /><a href="${explorer}/tx/${proofTx}" target="_blank" rel="noopener">${short(proofTx)} →</a></div>
  </div>

  <div class="card" id="card">
    <h2>Swap <span class="gear" id="gear">slippage <span id="slip-v">0.5%</span></span></h2>
    <div class="slip" id="slip"><button data-v="0.1">0.1%</button><button data-v="0.5" class="on">0.5%</button><button data-v="1">1%</button><button data-v="3">3%</button></div>

    <label class="f"><span>You pay</span><span class="bal" id="bal-in"></span></label>
    <div class="box">
      <input id="amt" placeholder="0.0" inputmode="decimal" autocomplete="off" />
      <div class="pill"><span class="ico" id="ico-in"></span><span id="sym-in">ETH</span> ▾<select id="tok-in"></select></div>
    </div>
    <div class="usd" id="usd-in"></div>

    <div class="flip"><button id="flip" title="flip">↕</button></div>

    <label class="f"><span>You receive</span><span class="bal" id="bal-out"></span></label>
    <div class="box"><div class="ro dim" id="recv">0.0</div><div class="pill"><span class="ico" id="ico-out"></span><span id="sym-out">USDG</span> ▾<select id="tok-out"></select></div></div>
    <div class="usd" id="usd-out"></div>

    <div class="mev" id="mev">
      <div class="l">MEV back to you<small id="mev-note">type an amount</small></div>
      <div class="r" id="mev-v">—</div>
    </div>

    <div class="rows">
      <div class="row"><span>Rate</span><span class="v" id="rate">—</span></div>
      <div class="row"><span>Minimum received</span><span class="v" id="minout">—</span></div>
      <div class="row"><span>Route</span><span class="v" id="route">—</span></div>
    </div>

    <button class="go" id="go">Connect wallet</button>
    <div class="result" id="result"></div>
    <div id="done"></div>
  </div>
</div></div></header>

<div class="wrap"><div class="status">
  <div><div class="k">Returned to users</div><div class="v ok" id="st-user">—</div></div>
  <div><div class="k">Swaps</div><div class="v" id="st-swaps">—</div></div>
  <div><div class="k">Back-runs reclaimed</div><div class="v" id="st-reclaims">—</div></div>
  <div><div class="k">Contract</div><div class="v mono" style="font-size:15px"><a href="${explorer}/address/${address}" target="_blank" rel="noopener">${short(address)}</a><small>90% of surplus to the user · float only owner-withdrawable</small></div></div>
</div></div>

<section><div class="wrap">
  <h2 class="s">How one transaction does it</h2>
  <div class="grid3">
    <div><div class="n">01</div><h4>Your swap</h4><p>Exactly your input is pulled and swapped through Uniswap V3 with your own slippage floor. Output goes straight to you. The contract's capital is never an input to your leg.</p></div>
    <div><div class="n">02</div><h4>Its back-run</h4><p>Your swap moved one fee tier of the pair away from the others. In the same transaction the contract trades its own float around that gap — buy on the tier you left cheap, sell into the one you left dear — and the round trip must return more than it put in or it does not run.</p></div>
    <div><div class="n">03</div><h4>Your surplus</h4><p>What the round trip made is split on-chain: 90% to you, 10% stays in the float. If the gap closed before inclusion, the back-run is skipped and your swap still lands. It can never fail because of the reclaim.</p></div>
  </div>
</div></section>

<section><div class="wrap">
  <h2 class="s">Recent reclaims</h2>
  <p class="lede">Every back-run the contract has run, newest first, read from its <code>Reclaimed</code> events. Swaps that opened no gap worth closing are not listed: they were just swaps.</p>
  <div id="rows"><div class="empty">loading…</div></div>
</div></section>

<section><div class="wrap">
  <h2 class="s">Use it from your own app</h2>
  <p class="lede">One RPC call returns the transaction to send: the swap with the best reclaim attached, or with none and the reason. This page is just a client of it.</p>
  <pre>curl -X POST ${rpc} -H <span class="s">'content-type: application/json'</span> -d <span class="s">'{
  "jsonrpc":"2.0","id":1,"method":"ordo_quoteSwap",
  "params":[{ "tokenIn":"0x0bd7…ad73", "tokenOut":"0x5fc5…d168", "fee":10000,
              "amountIn":"0x11c37937e080000", "amountOutMinimum":"0x0",
              "recipient":"0xYOU", "nativeOut":false }]
}'</span>
<span class="c"># → { to, data, value, amountOut, reclaim: { label, profit, surplusToUser, … } | null, note? }
# Send { to, data, value } with an explicit gas limit (650k). A bare eth_estimateGas finds the
# smallest gas that does not revert — which is the path where the reclaim starves and is skipped.</span></pre>
  <p class="lede" style="margin-top:18px">Contract source: <a href="https://github.com/OrdoFi/ordo/blob/main/contracts/src/OrdoSwap.sol" target="_blank" rel="noopener" style="color:var(--accent)">OrdoSwap.sol →</a> &nbsp;·&nbsp; <a href="${docs}" style="color:var(--accent)">Integration docs →</a></p>
</div></section>

<div class="wrap"><footer>
  <span>© 2026 OrdoFi Labs · not affiliated with Robinhood Markets, Inc.</span>
  <span>contract <a href="${explorer}/address/${address}" target="_blank" rel="noopener" class="mono">${short(address)}</a> &nbsp;·&nbsp; <a href="/swap/stats">/swap/stats</a> &nbsp;·&nbsp; <a href="/health">/health</a></span>
</footer></div>

<div class="modal" id="wm"><div class="sheet"><div class="mh">Connect a wallet<span class="x" id="wm-x">✕</span></div><div id="wm-list"></div><div class="wnote">Any EIP-1193 wallet. The page will add Robinhood Chain with rpc.ordofi.network as its RPC if it is missing.</div></div></div>

<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const RPC = location.origin;
  const SWAP = ${JSON.stringify(address)};
  const EXPLORER = ${JSON.stringify(explorer)};
  const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
  const CHAIN_HEX = "0x1237";
  const TOPIC_RECLAIMED = ${JSON.stringify(TOPIC_RECLAIMED)};
  const TOPIC_SWAPPED = ${JSON.stringify(TOPIC_SWAPPED)};
  const ETHUSD = 2523;
  const FEES = [100, 500, 3000, 10000];

  // ETH is native in and out: the contract wraps on the way in and unwraps on the way out.
  const TOKENS = {
    ETH:  { address: WETH, native: true, decimals: 18, img: ${JSON.stringify(app + "/token-eth.png")} },
    USDG: { address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", decimals: 6, img: ${JSON.stringify(app + "/token-usdg.png")} },
    GME:  { address: "0x1b0e319c6a659f002271b69db8a7df2f911c153e" },
    NVDA: { address: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec" },
    GOOGL:{ address: "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3" },
    AAPL: { address: "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9" },
    TSLA: { address: "0x322f0929c4625ed5bad873c95208d54e1c003b2d" },
    SPY:  { address: "0x117cc2133c37b721f49de2a7a74833232b3b4c0c" },
    GLD:  { address: "0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e" },
    PONS: { address: "0x39dbed3a2bd333467115de45665cc57f813c4571" },
  };
  let tokIn = "ETH", tokOut = "USDG", slippageBps = 50n;
  let provider = null, account = null, quote = null, quoting = 0, busy = false;
  const decimalsCache = new Map();

  // ---- rpc ------------------------------------------------------------
  let rid = 0;
  const rpc = async (method, params) => {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method, params }) });
    const j = await r.json();
    if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data });
    return j.result;
  };
  const hex = (n) => "0x" + BigInt(n).toString(16);
  const pad = (a) => "0".repeat(24) + a.slice(2).toLowerCase();
  async function decimalsOf(sym) {
    const t = TOKENS[sym];
    if (t.decimals !== undefined) return t.decimals;
    if (decimalsCache.has(sym)) return decimalsCache.get(sym);
    const d = Number(BigInt(await rpc("eth_call", [{ to: t.address, data: "0x313ce567" }, "latest"])));
    decimalsCache.set(sym, d); t.decimals = d; return d;
  }
  async function balanceOf(sym) {
    if (!account) return null;
    const t = TOKENS[sym];
    if (t.native) return BigInt(await rpc("eth_getBalance", [account, "latest"]));
    return BigInt(await rpc("eth_call", [{ to: t.address, data: "0x70a08231" + pad(account) }, "latest"]));
  }
  async function allowance(sym) {
    const t = TOKENS[sym];
    return BigInt(await rpc("eth_call", [{ to: t.address, data: "0xdd62ed3e" + pad(account) + pad(SWAP) }, "latest"]));
  }

  // ---- formatting -------------------------------------------------------
  const units = (wei, d) => Number(BigInt(wei)) / 10 ** d;
  const fmt = (x, max = 6) => x === 0 ? "0" : x < 0.000001 ? x.toExponential(2) : x.toLocaleString(undefined, { maximumFractionDigits: x < 1 ? max : x < 1000 ? 4 : 2 });
  const usd = (x) => "$" + x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const shortHash = (h) => h.slice(0, 10) + "…" + h.slice(-6);
  const parseAmt = (s, d) => { if (!/^\\d*\\.?\\d*$/.test(s) || s === "" || s === ".") return null; const [i, f = ""] = s.split("."); return BigInt((i || "0") + f.slice(0, d).padEnd(d, "0")); };

  // Count-up animation for the receive box.
  let tween = null;
  function tweenTo(el, target, decimals) {
    const from = Number(el.dataset.v || 0), start = performance.now(), dur = 380;
    cancelAnimationFrame(tween);
    const step = (t) => { const p = Math.min(1, (t - start) / dur), e = 1 - Math.pow(1 - p, 3); const v = from + (target - from) * e; el.textContent = fmt(v, decimals > 6 ? 6 : decimals); if (p < 1) tween = requestAnimationFrame(step); else el.dataset.v = String(target); };
    tween = requestAnimationFrame(step);
  }

  // Rough USD for the hint lines: ETH via constant, USDG 1:1, stocks via their ETH quote.
  let lastEthPerOut = null;
  function usdOf(sym, amount, ethPer) {
    if (sym === "ETH") return amount * ETHUSD;
    if (sym === "USDG") return amount;
    return ethPer ? amount * ethPer * ETHUSD : null;
  }

  // ---- tokens ui --------------------------------------------------------
  function paintToken(side, sym) {
    const t = TOKENS[sym];
    $("sym-" + side).textContent = sym;
    const ico = $("ico-" + side);
    ico.innerHTML = t.img ? '<img src="' + t.img + '" alt="" />' : sym.slice(0, 3);
    const sel = $("tok-" + side);
    sel.innerHTML = Object.keys(TOKENS).map((s) => '<option value="' + s + '"' + (s === sym ? " selected" : "") + ">" + s + "</option>").join("");
  }
  async function paintBalances() {
    for (const [side, sym] of [["in", tokIn], ["out", tokOut]]) {
      const el = $("bal-" + side);
      if (!account) { el.textContent = ""; continue; }
      try {
        const [b, d] = await Promise.all([balanceOf(sym), decimalsOf(sym)]);
        el.innerHTML = "balance " + fmt(units(b, d)) + (side === "in" ? " <b id=\\"max\\">max</b>" : "");
        if (side === "in") $("max").onclick = () => { $("amt").value = String(units(b, d) - (TOKENS[sym].native ? 0.0005 : 0)).replace(/^-.*$/, "0"); onInput(); };
      } catch { el.textContent = ""; }
    }
  }

  // ---- quoting ------------------------------------------------------------
  let debounce = null;
  function onInput() { clearTimeout(debounce); debounce = setTimeout(requote, 220); setBusy(true); }
  function setBusy(on) { $("recv").classList.toggle("busy", on && !!$("amt").value); }

  async function requote() {
    const id = ++quoting;
    quote = null;
    // Never show the previous pair's numbers under a new one, even for a moment.
    $("rate").textContent = "…"; $("minout").textContent = "…"; $("route").textContent = tokIn + " → " + tokOut;
    $("usd-out").textContent = "";
    $("mev").classList.remove("yes"); $("mev-v").textContent = "…"; $("mev-note").textContent = "quoting every pool";
    paintButton();
    const dIn = await decimalsOf(tokIn), dOut = await decimalsOf(tokOut);
    const amountIn = parseAmt($("amt").value, dIn);
    if (!amountIn || amountIn === 0n) { resetQuote(); return; }
    const inT = TOKENS[tokIn], outT = TOKENS[tokOut];
    if (inT.address === outT.address) { resetQuote("same token"); return; }
    const base = { tokenIn: inT.address, tokenOut: outT.address, amountIn: hex(amountIn), amountOutMinimum: "0x0", recipient: account || "0x000000000000000000000000000000000000dEaD", nativeOut: !!outT.native };
    if (!inT.native && account) base.from = account;
    if (!inT.native && !account) base.from = "0x000000000000000000000000000000000000dEaD";
    // Every tier at once; the best price wins, the reclaim breaks ties.
    const tries = await Promise.all(FEES.map((fee) => rpc("ordo_quoteSwap", [{ ...base, fee }]).then((q) => ({ fee, q })).catch(() => null)));
    if (id !== quoting) return;
    const ok = tries.filter(Boolean).filter((t) => BigInt(t.q.amountOut) > 0n);
    setBusy(false);
    if (!ok.length) { resetQuote("no pool for this pair"); return; }
    // What the user ends up with: the output plus the surplus, both in the
    // output token. A pool with a slightly worse price and a back-run attached
    // beats a pool with the best price and nothing behind it.
    const score = (t) => {
      const out = BigInt(t.q.amountOut);
      if (!t.q.reclaim) return out;
      const surplusWei = BigInt(t.q.reclaim.surplusToUser); // ETH
      if (outT.native) return out + surplusWei;
      if (inT.native) return out + (surplusWei * out) / amountIn; // ETH → out at this quote's own rate
      return out;
    };
    ok.sort((a, b) => { const d = score(b) - score(a); return d > 0n ? 1 : d < 0n ? -1 : 0; });
    const best = ok[0];
    quote = { ...best.q, fee: best.fee, amountIn, dIn, dOut };
    paintQuote();
  }

  function resetQuote(note) {
    quoting++;
    setBusy(false);
    const recv = $("recv"); recv.textContent = "0.0"; recv.classList.add("dim"); recv.dataset.v = "0";
    $("usd-in").textContent = ""; $("usd-out").textContent = "";
    $("rate").textContent = "—"; $("minout").textContent = "—"; $("route").textContent = "—";
    const m = $("mev"); m.classList.remove("yes"); $("mev-v").textContent = "—"; $("mev-note").textContent = note || "type an amount";
    paintButton();
  }

  function paintQuote() {
    const q = quote; if (!q) return;
    const out = units(q.amountOut, q.dOut), inn = units(q.amountIn, q.dIn);
    const recv = $("recv"); recv.classList.remove("dim"); tweenTo(recv, out, q.dOut);
    // ETH per unit of the out token, for USD hints on stock tokens.
    const ethPerOut = tokIn === "ETH" ? inn / out : tokOut === "ETH" ? null : lastEthPerOut;
    if (tokIn === "ETH") lastEthPerOut = ethPerOut;
    const uIn = usdOf(tokIn, inn, tokOut === "ETH" ? out / inn : null), uOut = usdOf(tokOut, out, ethPerOut);
    $("usd-in").textContent = uIn != null ? "≈ " + usd(uIn) : ""; $("usd-out").textContent = uOut != null ? "≈ " + usd(uOut) : "";
    $("rate").textContent = "1 " + tokIn + " = " + fmt(out / inn) + " " + tokOut;
    const minOut = (BigInt(q.amountOut) * (10000n - slippageBps)) / 10000n;
    $("minout").textContent = fmt(units(minOut, q.dOut)) + " " + tokOut;
    $("route").textContent = tokIn + " → " + tokOut + " · " + (q.fee / 10000) + "% pool" + (q.reclaim ? " + back-run" : "");
    const m = $("mev");
    if (q.reclaim) {
      const eth = units(q.reclaim.surplusToUser, 18);
      m.classList.add("yes");
      $("mev-v").innerHTML = "+" + fmt(eth) + " ETH<small>" + usd(eth * ETHUSD) + " · " + q.reclaim.label.replace(/^0x[0-9a-f]{6}/, tokIn === "ETH" ? tokOut : tokIn) + "</small>";
      $("mev-note").textContent = "paid to you in the same transaction";
    } else {
      m.classList.remove("yes");
      $("mev-v").textContent = "none";
      $("mev-note").textContent = q.note || "this swap opens no gap worth closing";
    }
    paintButton();
  }

  // ---- button -------------------------------------------------------------
  let needsApprove = false;
  async function paintButton() {
    const go = $("go");
    go.classList.remove("busy");
    if (busy) return;
    if (!account) { go.textContent = "Connect wallet"; go.disabled = false; return; }
    if (!quote) { go.textContent = $("amt").value ? "Quoting…" : "Enter an amount"; go.disabled = true; return; }
    const bal = await balanceOf(tokIn).catch(() => null);
    if (bal !== null && bal < quote.amountIn) { go.textContent = "Insufficient " + tokIn; go.disabled = true; return; }
    needsApprove = false;
    if (!TOKENS[tokIn].native) {
      const a = await allowance(tokIn).catch(() => 0n);
      if (a < quote.amountIn) { needsApprove = true; go.textContent = "Approve " + tokIn; go.disabled = false; return; }
    }
    go.textContent = quote.reclaim ? "Swap and keep the MEV" : "Swap";
    go.disabled = false;
  }

  async function go() {
    if (!account) return openWallets();
    if (!quote || busy) return;
    const btn = $("go"); busy = true; btn.disabled = true; btn.classList.add("busy");
    $("result").className = "result"; $("result").textContent = ""; $("done").innerHTML = "";
    try {
      if (needsApprove) {
        btn.innerHTML = '<span class="spin"></span>Confirm approval in your wallet…';
        const h = await provider.request({ method: "eth_sendTransaction", params: [{ from: account, to: TOKENS[tokIn].address, data: "0x095ea7b3" + pad(SWAP) + "f".repeat(64) }] });
        btn.innerHTML = '<span class="spin"></span>Approving…';
        await waitReceipt(h);
        busy = false; await requote(); await paintButton(); return;
      }
      // Re-quote right before sending so the reclaim is against the freshest state.
      await requote(); if (!quote) throw new Error("quote expired, try again");
      const minOut = (BigInt(quote.amountOut) * (10000n - slippageBps)) / 10000n;
      const q = await rpc("ordo_quoteSwap", [{ tokenIn: TOKENS[tokIn].address, tokenOut: TOKENS[tokOut].address, fee: quote.fee, amountIn: hex(quote.amountIn), amountOutMinimum: hex(minOut), recipient: account, nativeOut: !!TOKENS[tokOut].native, ...(TOKENS[tokIn].native ? {} : { from: account }) }]);
      btn.innerHTML = '<span class="spin"></span>Confirm in your wallet…';
      const hash = await provider.request({ method: "eth_sendTransaction", params: [{ from: account, to: q.to, data: q.data, value: q.value, gas: q.reclaim ? "0x9eb10" : "0x493e0" }] });
      btn.innerHTML = '<span class="spin"></span>Swapping…';
      $("result").innerHTML = 'sent · <a href="' + EXPLORER + "/tx/" + hash + '" target="_blank" rel="noopener">' + shortHash(hash) + "</a>";
      const rec = await waitReceipt(hash);
      if (rec.status !== "0x1") throw new Error("the transaction reverted");
      // Read what actually happened off the receipt.
      let got = null, back = null;
      for (const l of rec.logs) {
        if (l.address.toLowerCase() !== SWAP.toLowerCase()) continue;
        const w = l.data.slice(2).match(/.{64}/g).map((x) => BigInt("0x" + x));
        if (l.topics[0] === TOPIC_SWAPPED) got = w[3];
        if (l.topics[0] === TOPIC_RECLAIMED) back = w[1];
      }
      const outStr = got !== null ? fmt(units(got, quote.dOut)) + " " + tokOut : "done";
      $("done").innerHTML = '<div class="done"><b><span class="tick">✓</span>Received ' + outStr + "</b>" +
        (back ? '<div class="big">+' + fmt(units(back, 18)) + " ETH back</div><p>The back-run ran inside your transaction and paid you " + usd(units(back, 18) * ETHUSD) + " that would have gone to a bot.</p>" :
                '<p style="margin-top:6px">No back-run this time' + (quote.reclaim ? " — the gap closed before inclusion, so it was skipped and cost you nothing." : " — this swap opened no gap worth closing.") + "</p>") +
        '<p style="margin-top:8px"><a href="' + EXPLORER + "/tx/" + hash + '" target="_blank" rel="noopener">' + shortHash(hash) + " →</a></p></div>";
      $("result").textContent = "";
      $("amt").value = ""; resetQuote();
      paintBalances(); refreshStats();
    } catch (e) {
      const msg = e && (e.code === 4001 || /rejected|denied/i.test(e.message || "")) ? "cancelled in wallet" : (e.message || String(e)).slice(0, 160);
      $("result").className = "result bad"; $("result").textContent = msg;
    } finally {
      busy = false; btn.classList.remove("busy"); paintButton();
    }
  }
  async function waitReceipt(hash) {
    for (let i = 0; i < 400; i++) {
      const r = await rpc("eth_getTransactionReceipt", [hash]).catch(() => null);
      if (r) return r;
      await new Promise((res) => setTimeout(res, 300));
    }
    throw new Error("still pending — check the explorer");
  }

  // ---- wallet -------------------------------------------------------------
  const found = new Map();
  window.addEventListener("eip6963:announceProvider", (e) => { found.set(e.detail.info.uuid, e.detail); });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  function openWallets() {
    const list = [...found.values()];
    if (list.length === 0 && window.ethereum) return connect(window.ethereum);
    if (list.length === 1) return connect(list[0].provider);
    if (list.length === 0) { $("result").className = "result bad"; $("result").textContent = "no wallet found — install MetaMask or Rabby"; return; }
    $("wm-list").innerHTML = list.map((d, i) => '<div class="wrow" data-i="' + i + '"><img src="' + d.info.icon + '" alt="" /><div class="n">' + d.info.name + "</div></div>").join("");
    $("wm-list").querySelectorAll(".wrow").forEach((el) => el.onclick = () => { $("wm").classList.remove("open"); connect(list[Number(el.dataset.i)].provider); });
    $("wm").classList.add("open");
  }
  const onAccounts = (a) => { account = a[0] || null; if (!account) disconnect(); else onConnected(); };
  const onChain = () => ensureChain().catch(() => {});
  async function connect(p) {
    try {
      const accs = await p.request({ method: "eth_requestAccounts" });
      provider = p; account = accs[0];
      await ensureChain();
      p.on && p.on("accountsChanged", onAccounts);
      p.on && p.on("chainChanged", onChain);
      onConnected();
    } catch (e) {
      $("result").className = "result bad"; $("result").textContent = (e.message || String(e)).slice(0, 140);
    }
  }
  /**
   * Forget the wallet. EIP-1193 has no "disconnect" a page can call; what a
   * page can do is drop its reference and ask the wallet to revoke the site
   * permission where that is supported (MetaMask), so the next Connect asks
   * again instead of silently reusing the old grant.
   */
  async function disconnect() {
    const p = provider;
    provider = null; account = null;
    if (p) {
      p.removeListener && p.removeListener("accountsChanged", onAccounts);
      p.removeListener && p.removeListener("chainChanged", onChain);
      try { await p.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }); } catch { /* not every wallet supports it */ }
    }
    $("result").className = "result"; $("result").textContent = ""; $("done").innerHTML = "";
    onConnected();
  }
  async function ensureChain() {
    const cur = await provider.request({ method: "eth_chainId" });
    if (cur === CHAIN_HEX) return;
    try { await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] }); }
    catch (e) {
      if (e.code !== 4902 && !/unrecognized|not added|4902/i.test(e.message || "")) throw e;
      await provider.request({ method: "wallet_addEthereumChain", params: [{ chainId: CHAIN_HEX, chainName: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [${JSON.stringify(rpc)}], blockExplorerUrls: [EXPLORER] }] });
    }
  }
  function onConnected() {
    const b = $("nav-connect");
    if (account) { b.innerHTML = account.slice(0, 6) + "…" + account.slice(-4) + '<span class="x">✕</span>'; b.classList.add("on"); b.title = "disconnect"; }
    else { b.textContent = "Connect"; b.classList.remove("on"); b.title = ""; }
    paintBalances(); if ($("amt").value) requote(); else paintButton();
  }

  // ---- stats ------------------------------------------------------------------
  async function refreshStats() {
    const s = await fetch("/swap/stats").then((r) => r.json()).catch(() => null);
    if (!s) return;
    const eth = (wei) => Number(BigInt(wei)) / 1e18;
    $("st-user").innerHTML = usd(eth(s.toUserWei) * ETHUSD) + "<small>" + eth(s.toUserWei).toFixed(6) + " ETH · since deploy</small>";
    $("st-swaps").innerHTML = s.swaps.toLocaleString() + "<small>through the contract</small>";
    $("st-reclaims").innerHTML = s.reclaims.toLocaleString() + "<small>" + (s.skipped ? s.skipped + " skipped (gap closed first)" : "none skipped") + "</small>";
    if (!s.recent.length) { $("rows").innerHTML = '<div class="empty">No reclaims yet.</div>'; return; }
    $("rows").innerHTML = "<table><thead><tr><th>Tx</th><th class=\\"hide-s\\">User</th><th>Reclaimed</th><th>To the user</th><th class=\\"hide-s\\">Block</th></tr></thead><tbody>" +
      s.recent.map((r) => "<tr><td class=\\"mono\\"><a href=\\"" + EXPLORER + "/tx/" + r.tx + "\\" target=\\"_blank\\" rel=\\"noopener\\">" + shortHash(r.tx) + "</a></td><td class=\\"mono hide-s\\">" + shortHash(r.recipient) + "</td><td>" + eth(r.profitWei).toFixed(6) + " ETH</td><td style=\\"color:var(--ok)\\">" + eth(r.toUserWei).toFixed(6) + " ETH <span class=\\"mono\\" style=\\"color:var(--muted)\\">" + usd(eth(r.toUserWei) * ETHUSD) + "</span></td><td class=\\"mono hide-s\\" style=\\"color:var(--muted)\\">" + r.block.toLocaleString() + "</td></tr>").join("") +
      "</tbody></table>";
  }

  // ---- wire up ----------------------------------------------------------------
  paintToken("in", tokIn); paintToken("out", tokOut);
  $("amt").addEventListener("input", onInput);
  $("tok-in").addEventListener("change", (e) => { tokIn = e.target.value; if (tokIn === tokOut) { tokOut = tokIn === "ETH" ? "USDG" : "ETH"; paintToken("out", tokOut); } paintToken("in", tokIn); paintBalances(); onInput(); });
  $("tok-out").addEventListener("change", (e) => { tokOut = e.target.value; if (tokIn === tokOut) { tokIn = tokOut === "ETH" ? "USDG" : "ETH"; paintToken("in", tokIn); } paintToken("out", tokOut); paintBalances(); onInput(); });
  $("flip").addEventListener("click", () => { $("flip").classList.toggle("spin"); [tokIn, tokOut] = [tokOut, tokIn]; paintToken("in", tokIn); paintToken("out", tokOut); if (quote) $("amt").value = fmt(units(quote.amountOut, quote.dOut)).replace(/,/g, ""); paintBalances(); onInput(); });
  $("gear").addEventListener("click", () => $("slip").classList.toggle("open"));
  $("slip").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { $("slip").querySelectorAll("button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); slippageBps = BigInt(Math.round(Number(b.dataset.v) * 100)); $("slip-v").textContent = b.dataset.v + "%"; if (quote) paintQuote(); }));
  $("go").addEventListener("click", go);
  $("nav-connect").addEventListener("click", () => account ? disconnect() : openWallets());
  $("wm-x").addEventListener("click", () => $("wm").classList.remove("open"));
  $("wm").addEventListener("click", (e) => { if (e.target === $("wm")) $("wm").classList.remove("open"); });
  refreshStats(); setInterval(refreshStats, 20000);
  paintButton();
})();
</script>
</body>
</html>`;
}
