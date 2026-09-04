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
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#efeeea" />
<title>Ordo Swap — the swap that keeps its own MEV · Robinhood Chain</title>
<meta name="description" content="Every swap on Robinhood Chain leaks value to the bot that lands behind it. Ordo Swap runs that back-run inside your own transaction and pays the surplus to you. Live on mainnet." />
<link rel="icon" type="image/png" sizes="32x32" href="${app}/favicon-32.png" />
<link href="https://fonts.googleapis.com/css2?family=Funnel+Display:wght@400;500;600;700&family=Inter:wght@400;500;600&family=Fira+Code:wght@400;500&display=swap" rel="stylesheet" />
<style>
  :root { --bg:#efeeea; --card:#f3f2ee; --border:#d8d5ce; --border2:#c6c2b9; --text:#1d1616; --dim:#3a3430; --muted:#6d6660; --accent:#ff6414; --accent2:#e35505; --soft:#ffe3d2; --ok:#1e9e6a; --okbg:#e6f6ee; --bad:#c0392b; --lime:#b8ff3c;
    --mono:"Fira Code",ui-monospace,Menlo,monospace; --sans:Inter,-apple-system,sans-serif; --display:"Funnel Display",Inter,sans-serif; }
  * { margin:0; padding:0; box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  html { -webkit-text-size-adjust:100%; }
  body { background:var(--bg); color:var(--text); font-family:var(--sans); line-height:1.6; -webkit-font-smoothing:antialiased; overflow-x:hidden; }
  body.lock { overflow:hidden; }
  #rows { overflow-x:auto; -webkit-overflow-scrolling:touch; }
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
  .pill { display:flex; align-items:center; gap:7px; border:1px solid var(--border); background:#fff; padding:6px 10px 6px 8px; font-size:13px; font-weight:600; white-space:nowrap; cursor:pointer; font-family:var(--sans); color:var(--text); transition:border-color .15s, transform .08s; }
  .pill:hover { border-color:var(--text); }
  .pill:active { transform:scale(.98); }
  .pill .chev { color:var(--muted); font-size:11px; }
  .ico { width:22px; height:22px; flex:none; border-radius:50%; background:var(--soft); color:var(--accent2); font-family:var(--mono); font-size:9px; display:flex; align-items:center; justify-content:center; font-weight:600; overflow:hidden; }
  .ico img { width:100%; height:100%; display:block; object-fit:cover; }

  /* ---- token picker ---- */
  .picker { position:fixed; inset:0; background:rgba(25,24,23,.45); display:none; align-items:flex-start; justify-content:center; padding-top:8vh; z-index:300; }
  .picker.open { display:flex; }
  .psheet { background:#fff; border:1px solid var(--border); width:460px; max-width:calc(100vw - 24px); max-height:82vh; display:flex; flex-direction:column; animation:rise .22s cubic-bezier(.2,.9,.3,1.1); }
  @keyframes rise { from { transform:translateY(10px); opacity:0 } to { transform:none; opacity:1 } }
  .psheet .ph { padding:16px 18px 12px; border-bottom:1px solid var(--border); }
  .psheet .ph .t { display:flex; justify-content:space-between; align-items:center; font-family:var(--display); font-weight:600; font-size:17px; margin-bottom:12px; }
  .psheet .x { cursor:pointer; color:var(--muted); font-size:15px; padding:2px 6px; }
  .psheet .x:hover { color:var(--text); }
  .search { display:flex; align-items:center; gap:10px; border:1px solid var(--border); background:var(--bg); padding:10px 12px; }
  .search:focus-within { border-color:var(--text); }
  .search input { flex:1; border:none; background:transparent; outline:none; font-family:var(--sans); font-size:14px; color:var(--text); }
  .search input::placeholder { color:var(--muted); }
  .search .q { color:var(--muted); font-size:13px; }
  .tabs { display:flex; gap:0; margin-top:12px; border:1px solid var(--border); }
  .tabs button { flex:1; padding:9px; font-family:var(--sans); font-size:13px; font-weight:600; background:transparent; border:none; cursor:pointer; color:var(--muted); border-right:1px solid var(--border); }
  .tabs button:last-child { border-right:none; }
  .tabs button.on { background:var(--text); color:#fff; }
  .plist { overflow-y:auto; flex:1; }
  .trow { display:flex; align-items:center; gap:12px; padding:11px 18px; cursor:pointer; border-bottom:1px solid var(--border); }
  .trow:hover { background:var(--card); }
  .trow.off { opacity:.45; cursor:default; }
  .trow .ico { width:32px; height:32px; font-size:11px; }
  .trow .m { flex:1; min-width:0; }
  .trow .sy { font-weight:600; font-size:14px; display:flex; align-items:center; gap:8px; }
  .trow .nm { font-size:12px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .trow .px { font-family:var(--mono); font-size:12px; color:var(--dim); text-align:right; }
  .trow .px small { display:block; color:var(--muted); font-size:10.5px; }
  .tag { font-family:var(--mono); font-size:9.5px; letter-spacing:.06em; text-transform:uppercase; padding:1px 6px; border:1px solid var(--border2); color:var(--muted); font-weight:500; white-space:nowrap; }
  .tag.soon { border-color:var(--accent); color:var(--accent); }
  .tag.v4 { border-color:#7a5cff; color:#7a5cff; }
  .pempty { padding:28px 18px; text-align:center; color:var(--muted); font-size:13.5px; }
  .pempty .spin { display:inline-block; width:14px; height:14px; border:2px solid var(--border2); border-top-color:var(--text); border-radius:50%; animation:rot .7s linear infinite; vertical-align:-2px; margin-right:8px; }
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

  @media (max-width:900px) {
    .wrap { padding:0 16px; }
    header { padding:14px 0 30px; }
    /* On a phone you came to swap: the card first, the pitch under it. */
    .hero { grid-template-columns:minmax(0,1fr); gap:26px; }
    .hero > .card { order:-1; }
    .eyebrow { margin-bottom:12px; }
    h1 { font-size:clamp(28px,8vw,38px); max-width:none; }
    .sub { font-size:14.5px; }
    .proofline { font-size:11px; }
    .card { padding:18px 16px 16px; }
    .card h2 { font-size:19px; }
    label.f { margin-top:14px; }
    .box { padding:12px 12px; }
    .box input, .box .ro { font-size:20px; }
    .pill { min-height:42px; padding:8px 10px 8px 8px; }
    .flip button { width:44px; height:44px; font-size:18px; }
    .slip button { padding:8px 12px; font-size:12px; }
    .mev { padding:12px; }
    .go { padding:16px; font-size:16px; }
    .status { grid-template-columns:repeat(2,minmax(0,1fr)); }
    .status > div { padding:16px; }
    .status > div:nth-child(2) { border-right:none; }
    .status > div:nth-child(n+3) { border-top:1px solid var(--border); }
    .status .v { font-size:22px; }
    section { padding:40px 0; }
    h2.s { font-size:24px; }
    .grid3 { grid-template-columns:1fr; }
    .grid3 > div { border-right:none; border-bottom:1px solid var(--border); }
    .grid3 > div:last-child { border-bottom:none; }
    .hide-s { display:none; }
    #rows table { min-width:440px; }
    pre { font-size:11.5px; padding:14px; }
    footer { flex-direction:column; gap:8px; }
    /* The picker rises from the bottom and fills the screen, the way a phone expects. */
    .picker { align-items:flex-end; padding:0; }
    .psheet { width:100%; max-width:100%; height:88dvh; max-height:88dvh; padding-bottom:env(safe-area-inset-bottom); animation:up .25s cubic-bezier(.2,.9,.3,1.05); }
    @keyframes up { from { transform:translateY(28px); opacity:0 } to { transform:none; opacity:1 } }
    .psheet .ph { padding:14px 16px 10px; }
    .search { padding:12px; }
    .search input { font-size:16px; }
    .tabs button { padding:11px; }
    .trow { padding:13px 16px; }
    .trow .ico { width:34px; height:34px; }
    .modal { align-items:flex-end; padding:0; }
    .sheet { width:100%; max-width:100%; padding-bottom:env(safe-area-inset-bottom); }
    .wrow { padding:15px 18px; }
  }
  @media (max-width:600px) { nav .links { gap:12px; font-size:13px; } .logo { font-size:19px; } .navbtn { padding:8px 12px; } }
  @media (max-width:430px) { nav .links a { display:none; } }
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
      <button class="pill" id="pick-in" type="button"><span class="ico" id="ico-in"></span><span id="sym-in">ETH</span><span class="chev">▾</span></button>
    </div>
    <div class="usd" id="usd-in"></div>

    <div class="flip"><button id="flip" title="flip">↕</button></div>

    <label class="f"><span>You receive</span><span class="bal" id="bal-out"></span></label>
    <div class="box"><div class="ro dim" id="recv">0.0</div><button class="pill" id="pick-out" type="button"><span class="ico" id="ico-out"></span><span id="sym-out">USDG</span><span class="chev">▾</span></button></div>
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
    <div><div class="n">01</div><h4>Your swap</h4><p>Exactly your input is pulled and swapped through Uniswap V3 or V4 — including hooked launchpad pools — with your own slippage floor. Output goes straight to you. The contract's capital is never an input to your leg.</p></div>
    <div><div class="n">02</div><h4>Its back-run</h4><p>Your swap moved one market of the pair away from the others — another fee tier, or another venue. In the same transaction the contract trades its own float around that gap — buy on the tier you left cheap, sell into the one you left dear — and the round trip must return more than it put in or it does not run.</p></div>
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

<div class="picker" id="picker"><div class="psheet">
  <div class="ph">
    <div class="t"><span>Select a token</span><span class="x" id="pk-x">✕</span></div>
    <div class="search"><span class="q">⌕</span><input id="pk-q" placeholder="Paste any contract address or search by name" autocomplete="off" spellcheck="false" /></div>
    <div class="tabs"><button data-tab="stocks" id="tab-stocks">Stocks</button><button data-tab="tokens" class="on" id="tab-tokens">Tokens</button></div>
  </div>
  <div class="plist" id="pk-list"><div class="pempty"><span class="spin"></span>loading tokens…</div></div>
</div></div>

<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const RPC = location.origin;
  const SWAP = ${JSON.stringify(address)};
  const EXPLORER = ${JSON.stringify(explorer)};
  const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
  const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
  const CHAIN_HEX = "0x1237";
  const TOPIC_RECLAIMED = ${JSON.stringify(TOPIC_RECLAIMED)};
  const TOPIC_SWAPPED = ${JSON.stringify(TOPIC_SWAPPED)};
  const FALLBACK_ETHUSD = 2523;
  const DEAD = "0x000000000000000000000000000000000000dEaD";

  // ---- token registry ------------------------------------------------------
  // Every token the chain has, from /swap/tokens, plus anything pasted by address.
  // ETH is native in and out: the contract wraps on the way in and unwraps out.
  const ETH = { address: WETH, native: true, symbol: "ETH", name: "Ether", decimals: 18, icon: ${JSON.stringify(app + "/token-eth.png")}, usd: null, stock: false, v3: true, v4: true };
  const registry = new Map(); // address -> token (WETH's slot is the ERC-20 WETH; ETH is separate)
  let ranked = [];             // tokens in activity order, for the picker
  let listReady = false;
  const byAddr = (a) => (a.toLowerCase() === WETH ? ETH : registry.get(a.toLowerCase()));
  function ethUsd() { return ETH.usd || FALLBACK_ETHUSD; }

  async function loadTokens() {
    try {
      const r = await fetch("/swap/tokens").then((x) => x.json());
      for (const t of r.tokens) registry.set(t.address, t);
      const w = registry.get(WETH);
      if (w) { ETH.usd = w.usd; ETH.icon = ETH.icon || w.icon; }
      const u = registry.get(USDG);
      if (u) { u.icon = u.icon || ${JSON.stringify(app + "/token-usdg.png")}; }
      ranked = r.tokens;
      listReady = true;
      if (tokIn.address === WETH && tokIn.native) tokIn = ETH;
      paintToken("in", tokIn); paintToken("out", tokOut);
      if ($("picker").classList.contains("open")) renderPicker();
    } catch (e) {
      $("pk-list").innerHTML = '<div class="pempty">could not load the token list — paste an address instead</div>';
    }
  }

  let tokIn = ETH;
  let tokOut = { address: USDG, symbol: "USDG", name: "Global Dollar", decimals: 6, icon: ${JSON.stringify(app + "/token-usdg.png")}, usd: 1, stock: false, v3: true, v4: true };
  let slippageBps = 50n;
  let provider = null, account = null, quote = null, quoting = 0, busy = false;

  // ---- rpc ------------------------------------------------------------------
  let rid = 0;
  const rpc = async (method, params) => {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method, params }) });
    const j = await r.json();
    if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data });
    return j.result;
  };
  const hex = (n) => "0x" + BigInt(n).toString(16);
  const pad = (a) => "0".repeat(24) + a.slice(2).toLowerCase();
  const str = (ret) => { try { const len = Number(BigInt("0x" + ret.slice(66, 130))); return decodeURIComponent(ret.slice(130, 130 + len * 2).replace(/(..)/g, "%$1")).replace(/\\0/g, ""); } catch { return ""; } };
  async function balanceOf(t) {
    if (!account) return null;
    if (t.native) return BigInt(await rpc("eth_getBalance", [account, "latest"]));
    return BigInt(await rpc("eth_call", [{ to: t.address, data: "0x70a08231" + pad(account) }, "latest"]));
  }
  async function allowance(t) { return BigInt(await rpc("eth_call", [{ to: t.address, data: "0xdd62ed3e" + pad(account) + pad(SWAP) }, "latest"])); }

  /** A token we have never seen: read it off the chain. Null if it is not an ERC-20. */
  async function lookupToken(addr) {
    const a = addr.toLowerCase();
    if (byAddr(a)) return byAddr(a);
    try {
      const [sym, name, dec] = await Promise.all([
        rpc("eth_call", [{ to: a, data: "0x95d89b41" }, "latest"]),
        rpc("eth_call", [{ to: a, data: "0x06fdde03" }, "latest"]),
        rpc("eth_call", [{ to: a, data: "0x313ce567" }, "latest"]),
      ]);
      const t = { address: a, symbol: str(sym).slice(0, 12) || a.slice(0, 8), name: str(name).slice(0, 60) || "Unknown token", decimals: Number(BigInt(dec)), icon: null, usd: null, stock: false, v3: true, v4: true, custom: true };
      registry.set(a, t);
      return t;
    } catch { return null; }
  }

  // ---- formatting -------------------------------------------------------------
  const units = (wei, d) => Number(BigInt(wei)) / 10 ** d;
  const fmt = (x, max = 6) => x === 0 ? "0" : Math.abs(x) < 0.000001 ? x.toExponential(2) : x.toLocaleString(undefined, { maximumFractionDigits: x < 1 ? max : x < 1000 ? 4 : 2 });
  const usd = (x) => "$" + x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const shortHash = (h) => h.slice(0, 10) + "…" + h.slice(-6);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  // "0,001" is how half of Europe types a thousandth. Commas are decimals here.
  const parseAmt = (s, d) => { s = String(s).trim().replace(/\\s/g, ""); s = s.includes(".") ? s.replace(/,/g, "") : s.replace(",", "."); if (!/^\\d*\\.?\\d*$/.test(s) || s === "" || s === ".") return null; const [i, f = ""] = s.split("."); const v = BigInt((i || "0") + f.slice(0, d).padEnd(d, "0")); return v > 0n ? v : null; };
  const avatar = (t, cls = "ico") => '<span class="' + cls + '">' + (t.icon ? '<img src="' + esc(t.icon) + '" alt="" onerror="this.parentNode.textContent=\\'' + esc(t.symbol.slice(0, 3)) + '\\'" />' : esc(t.symbol.slice(0, 3))) + "</span>";

  // Count-up animation for the receive box.
  let tween = null;
  function tweenTo(el, target, decimals) {
    const from = Number(el.dataset.v || 0), start = performance.now(), dur = 380;
    cancelAnimationFrame(tween);
    const step = (t) => { const p = Math.min(1, (t - start) / dur), e = 1 - Math.pow(1 - p, 3); const v = from + (target - from) * e; el.textContent = fmt(v, decimals > 6 ? 6 : decimals); if (p < 1) tween = requestAnimationFrame(step); else el.dataset.v = String(target); };
    tween = requestAnimationFrame(step);
  }

  // ---- tokens ui ----------------------------------------------------------------
  function paintToken(side, t) {
    $("sym-" + side).textContent = t.symbol;
    $("ico-" + side).outerHTML = avatar(t).replace('class="ico"', 'class="ico" id="ico-' + side + '"');
  }
  async function paintBalances() {
    for (const [side, t] of [["in", tokIn], ["out", tokOut]]) {
      const el = $("bal-" + side);
      if (!account) { el.textContent = ""; continue; }
      try {
        const b = await balanceOf(t);
        el.innerHTML = "balance " + fmt(units(b, t.decimals)) + (side === "in" ? ' <b id="max">max</b>' : "");
        if (side === "in") $("max").onclick = () => { const v = units(b, t.decimals) - (t.native ? 0.0005 : 0); $("amt").value = v > 0 ? String(v) : "0"; onInput(); };
      } catch { el.textContent = ""; }
    }
  }

  // ---- picker -------------------------------------------------------------------
  let pickSide = "in", tab = "tokens";
  function openPicker(side) {
    pickSide = side;
    $("pk-q").value = "";
    tab = (side === "in" ? tokIn : tokOut).stock ? "stocks" : "tokens";
    $("tab-stocks").classList.toggle("on", tab === "stocks"); $("tab-tokens").classList.toggle("on", tab === "tokens");
    $("picker").classList.add("open"); document.body.classList.add("lock");
    renderPicker();
    // Focus the search on a desktop; on a phone that would throw the keyboard over half the list.
    if (!matchMedia("(max-width:900px)").matches) setTimeout(() => $("pk-q").focus(), 30);
  }
  function closePicker() { $("picker").classList.remove("open"); document.body.classList.remove("lock"); }
  const priceCell = (t) => t.usd != null ? '<div class="px">' + (t.usd >= 1 ? usd(t.usd) : "$" + t.usd.toPrecision(3)) + (t.swaps24h ? "<small>" + t.swaps24h.toLocaleString() + " swaps/24h</small>" : "") + "</div>" : "";
  const routable = (t) => !!(t.v3 || t.v4);
  const row = (t) => '<div class="trow' + (routable(t) ? "" : " off") + '" data-a="' + t.address + (t.native ? "|eth" : "") + '">' + avatar(t) +
    '<div class="m"><div class="sy">' + esc(t.symbol) + (t.stock ? '<span class="tag">stock</span>' : "") + (!t.v3 && t.v4 ? '<span class="tag v4">V4</span>' : "") + (routable(t) ? "" : '<span class="tag soon">no pool</span>') + (t.custom ? '<span class="tag">custom</span>' : "") + '</div><div class="nm">' + esc(t.name) + "</div></div>" + priceCell(t) + "</div>";
  async function renderPicker() {
    const q = $("pk-q").value.trim();
    const list = $("pk-list");
    if (/^0x[0-9a-fA-F]{40}$/.test(q)) {
      list.innerHTML = '<div class="pempty"><span class="spin"></span>looking up ' + esc(q.slice(0, 10)) + "…</div>";
      const t = await lookupToken(q);
      if ($("pk-q").value.trim() !== q) return;
      list.innerHTML = t ? row(t) + (t.custom ? '<div class="pempty" style="text-align:left;font-size:12px">Not in our list — read from the chain. If it has no Uniswap V3 or V4 pool the quote will say so.</div>' : "") : '<div class="pempty">no ERC-20 at that address</div>';
      return;
    }
    if (!listReady) { list.innerHTML = '<div class="pempty"><span class="spin"></span>loading tokens…</div>'; return; }
    const needle = q.toLowerCase();
    let items = ranked.filter((t) => (tab === "stocks") === !!t.stock);
    if (tab === "tokens") items = [ETH, ...items.filter((t) => t.address !== WETH)];
    if (needle) items = items.filter((t) => t.symbol.toLowerCase().includes(needle) || t.name.toLowerCase().includes(needle) || t.address.startsWith(needle));
    // Routable first within the same activity order; the rest listed so search still finds them.
    items = [...items.filter(routable), ...items.filter((t) => !routable(t))];
    const shown = items.slice(0, needle ? 60 : 120);
    list.innerHTML = shown.length ? shown.map(row).join("") + (items.length > shown.length ? '<div class="pempty">' + (items.length - shown.length).toLocaleString() + " more — keep typing</div>" : "") : '<div class="pempty">nothing matches</div>';
  }
  function pick(t) {
    if (!routable(t)) return;
    const other = pickSide === "in" ? tokOut : tokIn;
    if (pickSide === "in") tokIn = t; else tokOut = t;
    if (other.address === t.address && other.native === t.native) { if (pickSide === "in") tokOut = t.native || t.address === WETH ? registry.get(USDG) || tokOut : ETH; else tokIn = t.native || t.address === WETH ? registry.get(USDG) || tokIn : ETH; }
    paintToken("in", tokIn); paintToken("out", tokOut);
    closePicker(); paintBalances(); onInput();
  }

  // ---- quoting -------------------------------------------------------------------
  let debounce = null;
  function onInput() { clearTimeout(debounce); debounce = setTimeout(requote, 200); setBusy(true); }
  function setBusy(on) { $("recv").classList.toggle("busy", on && !!$("amt").value); }
  const feeLabel = (h) => h.venue === "v4" ? (h.fee === 8388608 ? "V4 · hook" : "V4 " + (h.fee / 10000) + "%") : (h.fee / 10000) + "%";
  const routeLabel = (route) => route.map((h, i) => (i === 0 ? sym(h.tokenIn) : "") + " → " + sym(h.tokenOut) + " " + feeLabel(h)).join("");
  const sym = (a) => { const t = registry.get(a.toLowerCase()); return a.toLowerCase() === WETH ? (tokIn.native && tokIn.address === WETH ? "ETH" : tokOut.native && tokOut.address === WETH ? "ETH" : "WETH") : t ? t.symbol : a.slice(0, 6); };

  async function requote() {
    const id = ++quoting;
    quote = null;
    $("rate").textContent = "…"; $("minout").textContent = "…"; $("route").textContent = tokIn.symbol + " → " + tokOut.symbol;
    $("usd-out").textContent = "";
    $("mev").classList.remove("yes"); $("mev-v").textContent = "…"; $("mev-note").textContent = "finding the best route";
    paintButton();
    const amountIn = parseAmt($("amt").value, tokIn.decimals);
    if (!amountIn) { resetQuote($("amt").value ? "that is not a number" : undefined); return; }
    if (tokIn.address === tokOut.address && !!tokIn.native === !!tokOut.native) { resetQuote("same token"); return; }
    const inn = units(amountIn, tokIn.decimals);
    $("usd-in").textContent = tokIn.usd != null ? "≈ " + usd(inn * tokIn.usd) : "";
    // An estimate from list prices, instantly, dimmed, while the real route is quoted.
    if (tokIn.usd != null && tokOut.usd) { const recv = $("recv"); recv.classList.remove("dim"); recv.classList.add("busy"); tweenTo(recv, (inn * tokIn.usd) / tokOut.usd, tokOut.decimals); }
    const req = { tokenIn: tokIn.address, tokenOut: tokOut.address, amountIn: hex(amountIn), amountOutMinimum: "0x0", recipient: account || DEAD, nativeOut: !!tokOut.native };
    if (!tokIn.native) req.from = account || DEAD;
    // Two requests at once: the price alone comes back in one round trip and is
    // painted immediately; the full answer with the back-run search replaces it.
    const fast = rpc("ordo_quoteSwap", [{ ...req, skipReclaim: true }]).catch(() => null);
    const full = rpc("ordo_quoteSwap", [req]);
    fast.then((q) => {
      if (id !== quoting || quote || !q || BigInt(q.amountOut) === 0n) return;
      quote = { ...q, amountIn, provisional: true };
      paintQuote();
      $("mev-v").textContent = "…"; $("mev-note").textContent = "checking what comes back…";
    });
    let q;
    try { q = await full; }
    catch (e) { if (id !== quoting) return; resetQuote(/no route/i.test(e.message) ? "no pool connects these two tokens" : e.message.slice(0, 90)); return; }
    if (id !== quoting) return;
    setBusy(false);
    if (BigInt(q.amountOut) === 0n) { resetQuote("no route for this pair right now"); return; }
    quote = { ...q, amountIn };
    paintQuote();
  }

  function resetQuote(note) {
    quoting++;
    setBusy(false);
    const recv = $("recv"); recv.textContent = "0.0"; recv.classList.add("dim"); recv.classList.remove("busy"); recv.dataset.v = "0";
    $("usd-in").textContent = ""; $("usd-out").textContent = "";
    $("rate").textContent = "—"; $("minout").textContent = "—"; $("route").textContent = "—";
    const m = $("mev"); m.classList.remove("yes"); $("mev-v").textContent = "—"; $("mev-note").textContent = note || "type an amount";
    paintButton();
  }

  function paintQuote() {
    const q = quote; if (!q) return;
    const out = units(q.amountOut, tokOut.decimals), inn = units(q.amountIn, tokIn.decimals);
    const recv = $("recv"); recv.classList.remove("dim", "busy"); tweenTo(recv, out, tokOut.decimals);
    const uOut = tokOut.usd != null ? out * tokOut.usd : tokIn.usd != null ? inn * tokIn.usd : null;
    $("usd-out").textContent = uOut != null ? "≈ " + usd(uOut) : "";
    $("rate").textContent = "1 " + tokIn.symbol + " = " + fmt(out / inn) + " " + tokOut.symbol;
    const minOut = (BigInt(q.amountOut) * (10000n - slippageBps)) / 10000n;
    $("minout").textContent = fmt(units(minOut, tokOut.decimals)) + " " + tokOut.symbol;
    $("route").textContent = routeLabel(q.route) + (q.reclaim ? " + back-run" : "");
    const m = $("mev");
    if (q.reclaim) {
      const eth = units(q.reclaim.surplusToUser, 18);
      m.classList.add("yes");
      $("mev-v").innerHTML = "+" + fmt(eth) + " ETH<small>" + usd(eth * ethUsd()) + " · " + esc(q.reclaim.label) + "</small>";
      $("mev-note").textContent = "paid to you in the same transaction";
    } else {
      m.classList.remove("yes");
      $("mev-v").textContent = "none";
      $("mev-note").textContent = q.note || "this swap opens no gap worth closing";
    }
    paintButton();
  }

  // ---- button ----------------------------------------------------------------------
  let needsApprove = false;
  async function paintButton() {
    const go = $("go");
    go.classList.remove("busy");
    if (busy) return;
    if (!account) { go.textContent = "Connect wallet"; go.disabled = false; return; }
    if (!quote) { go.textContent = parseAmt($("amt").value, 18) ? "Quoting…" : "Enter an amount"; go.disabled = true; return; }
    const bal = await balanceOf(tokIn).catch(() => null);
    if (bal !== null && bal < quote.amountIn) { go.textContent = "Insufficient " + tokIn.symbol; go.disabled = true; return; }
    needsApprove = false;
    if (!tokIn.native) {
      const a = await allowance(tokIn).catch(() => 0n);
      if (a < quote.amountIn) { needsApprove = true; go.textContent = "Approve " + tokIn.symbol; go.disabled = false; return; }
    }
    if (quote.provisional) { go.textContent = "Checking for MEV…"; go.disabled = true; return; }
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
        const h = await provider.request({ method: "eth_sendTransaction", params: [{ from: account, to: tokIn.address, data: "0x095ea7b3" + pad(SWAP) + "f".repeat(64) }] });
        btn.innerHTML = '<span class="spin"></span>Approving…';
        await waitReceipt(h);
        busy = false; await requote(); await paintButton(); return;
      }
      // Re-quote right before sending so the reclaim is against the freshest state.
      await requote(); if (!quote) throw new Error("quote expired, try again");
      const minOut = (BigInt(quote.amountOut) * (10000n - slippageBps)) / 10000n;
      const req = { tokenIn: tokIn.address, tokenOut: tokOut.address, amountIn: hex(quote.amountIn), amountOutMinimum: hex(minOut), recipient: account, nativeOut: !!tokOut.native };
      if (!tokIn.native) req.from = account;
      const q = await rpc("ordo_quoteSwap", [req]);
      btn.innerHTML = '<span class="spin"></span>Confirm in your wallet…';
      const hash = await provider.request({ method: "eth_sendTransaction", params: [{ from: account, to: q.to, data: q.data, value: q.value, gas: q.gas }] });
      btn.innerHTML = '<span class="spin"></span>Swapping…';
      $("result").innerHTML = 'sent · <a href="' + EXPLORER + "/tx/" + hash + '" target="_blank" rel="noopener">' + shortHash(hash) + "</a>";
      const rec = await waitReceipt(hash);
      if (rec.status !== "0x1") throw new Error("the transaction reverted");
      let got = null, back = null;
      for (const l of rec.logs) {
        if (l.address.toLowerCase() !== SWAP.toLowerCase()) continue;
        const w = l.data.slice(2).match(/.{64}/g).map((x) => BigInt("0x" + x));
        if (l.topics[0] === TOPIC_SWAPPED) got = w[3];
        if (l.topics[0] === TOPIC_RECLAIMED) back = w[1];
      }
      const outStr = got !== null ? fmt(units(got, tokOut.decimals)) + " " + tokOut.symbol : "done";
      $("done").innerHTML = '<div class="done"><b><span class="tick">✓</span>Received ' + outStr + "</b>" +
        (back ? '<div class="big">+' + fmt(units(back, 18)) + " ETH back</div><p>The back-run ran inside your transaction and paid you " + usd(units(back, 18) * ethUsd()) + " that would have gone to a bot.</p>" :
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

  // ---- wallet ----------------------------------------------------------------------
  const found = new Map();
  window.addEventListener("eip6963:announceProvider", (e) => { found.set(e.detail.info.uuid, e.detail); });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  function openWallets() {
    const list = [...found.values()];
    if (list.length === 0 && window.ethereum) return connect(window.ethereum);
    if (list.length === 1) return connect(list[0].provider);
    if (list.length === 0) {
      const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
      $("result").className = "result bad";
      $("result").innerHTML = mobile
        ? 'no wallet in this browser — <a href="https://metamask.app.link/dapp/' + location.host + location.pathname + '">open in MetaMask</a> or use your wallet\u2019s built-in browser'
        : "no wallet found — install MetaMask or Rabby";
      return;
    }
    $("wm-list").innerHTML = list.map((d, i) => '<div class="wrow" data-i="' + i + '"><img src="' + d.info.icon + '" alt="" /><div class="n">' + esc(d.info.name) + "</div></div>").join("");
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

  // ---- stats ----------------------------------------------------------------------------
  async function refreshStats() {
    const s = await fetch("/swap/stats").then((r) => r.json()).catch(() => null);
    if (!s) return;
    const eth = (wei) => Number(BigInt(wei)) / 1e18;
    $("st-user").innerHTML = usd(eth(s.toUserWei) * ethUsd()) + "<small>" + eth(s.toUserWei).toFixed(6) + " ETH · since deploy</small>";
    $("st-swaps").innerHTML = s.swaps.toLocaleString() + "<small>through the contract</small>";
    $("st-reclaims").innerHTML = s.reclaims.toLocaleString() + "<small>" + (s.skipped ? s.skipped + " skipped (gap closed first)" : "none skipped") + "</small>";
    if (!s.recent.length) { $("rows").innerHTML = '<div class="empty">No reclaims yet.</div>'; return; }
    $("rows").innerHTML = '<table><thead><tr><th>Tx</th><th class="hide-s">User</th><th>Reclaimed</th><th>To the user</th><th class="hide-s">Block</th></tr></thead><tbody>' +
      s.recent.map((r) => '<tr><td class="mono"><a href="' + EXPLORER + "/tx/" + r.tx + '" target="_blank" rel="noopener">' + shortHash(r.tx) + '</a></td><td class="mono hide-s">' + shortHash(r.recipient) + "</td><td>" + eth(r.profitWei).toFixed(6) + ' ETH</td><td style="color:var(--ok)">' + eth(r.toUserWei).toFixed(6) + ' ETH <span class="mono" style="color:var(--muted)">' + usd(eth(r.toUserWei) * ethUsd()) + '</span></td><td class="mono hide-s" style="color:var(--muted)">' + r.block.toLocaleString() + "</td></tr>").join("") +
      "</tbody></table>";
  }

  // ---- wire up -------------------------------------------------------------------------------
  paintToken("in", tokIn); paintToken("out", tokOut);
  loadTokens();
  $("amt").addEventListener("input", onInput);
  $("pick-in").addEventListener("click", () => openPicker("in"));
  $("pick-out").addEventListener("click", () => openPicker("out"));
  $("pk-x").addEventListener("click", closePicker);
  $("picker").addEventListener("click", (e) => { if (e.target === $("picker")) closePicker(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closePicker(); $("wm").classList.remove("open"); } });
  $("pk-q").addEventListener("input", renderPicker);
  $("pk-q").addEventListener("paste", () => setTimeout(renderPicker, 0));
  $("tab-stocks").addEventListener("click", () => { tab = "stocks"; $("tab-stocks").classList.add("on"); $("tab-tokens").classList.remove("on"); renderPicker(); });
  $("tab-tokens").addEventListener("click", () => { tab = "tokens"; $("tab-tokens").classList.add("on"); $("tab-stocks").classList.remove("on"); renderPicker(); });
  $("pk-list").addEventListener("click", (e) => { const r = e.target.closest(".trow"); if (!r || r.classList.contains("off")) return; const [a, flag] = r.dataset.a.split("|"); pick(flag === "eth" ? ETH : registry.get(a)); });
  $("flip").addEventListener("click", () => { $("flip").classList.toggle("spin"); [tokIn, tokOut] = [tokOut, tokIn]; paintToken("in", tokIn); paintToken("out", tokOut); if (quote) $("amt").value = fmt(units(quote.amountOut, tokIn.decimals)).replace(/,/g, ""); paintBalances(); onInput(); });
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
