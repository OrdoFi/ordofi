/**
 * What a browser sees at https://rpc.ordofi.network/live: the chain, arriving.
 *
 * The WebSocket endpoint is the most useful thing this gateway does and the
 * hardest to believe from a sentence, because "we push instead of you polling"
 * reads like every other RPC's marketing. So this page does not describe it.
 * It opens the same socket any wallet would, subscribes to newHeads and logs
 * with no key, and puts what comes back on the screen. A block every 100 ms is
 * a thing you have to watch to understand.
 *
 * Deliberately plain: one file, no framework, no build, native WebSocket. If
 * this page works, the endpoint works, and a developer can read the twenty
 * lines at the bottom and have the same thing running in their own app.
 */
import { toEventSelector } from "viem";

/** The events worth naming on the tape. Everything else shows its selector. */
const KNOWN: [string, string][] = [
  ["Transfer", "Transfer(address,address,uint256)"],
  ["Approval", "Approval(address,address,uint256)"],
  ["Swap V3", "Swap(address,address,int256,int256,uint160,uint128,int24)"],
  ["Swap V4", "Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"],
  ["Sync", "Sync(uint112,uint112)"],
  ["Swap V2", "Swap(address,uint256,uint256,uint256,uint256,address)"],
  ["Mint", "Mint(address,address,int24,int24,uint128,uint256,uint256)"],
  ["Burn", "Burn(address,int24,int24,uint128,uint256,uint256)"],
  ["Deposit", "Deposit(address,uint256)"],
  ["Withdrawal", "Withdrawal(address,uint256)"],
];

export function liveHtml(opts: {
  chainId: number;
  explorer: string;
  app: string;
  docs: string;
  /** Only to write the endpoint into the page; the page itself uses its own origin. */
  rpc?: string;
}): string {
  const { chainId, explorer, app, docs } = opts;
  const rpc = opts.rpc ?? "https://rpc.ordofi.network";
  const names: Record<string, string> = {};
  for (const [label, sig] of KNOWN) names[toEventSelector(sig)] = label;
  const wsUrl = rpc.replace(/^http/, "ws");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#efeeea" />
<title>Robinhood Chain, live — a block every 100ms over wss://rpc.ordofi.network</title>
<meta name="description" content="Robinhood Chain streaming in your browser: every block and every log, pushed over a WebSocket as they happen. No API key, no signup. The chain's own RPC is HTTP only." />
<link rel="icon" type="image/png" sizes="32x32" href="${app}/favicon-32.png" />
<link href="https://fonts.googleapis.com/css2?family=Funnel+Display:wght@400;500;600;700&family=Inter:wght@400;500;600&family=Fira+Code:wght@400;500&display=swap" rel="stylesheet" />
<style>
  :root { --bg:#efeeea; --card:#f3f2ee; --border:#d8d5ce; --border2:#c6c2b9; --text:#1d1616; --dim:#3a3430; --muted:#6d6660; --accent:#ff6414; --ok:#1e9e6a; --bad:#c0392b;
    --mono:"Fira Code",ui-monospace,Menlo,monospace; --sans:Inter,-apple-system,sans-serif; --display:"Funnel Display",Inter,sans-serif; }
  * { margin:0; padding:0; box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  html { -webkit-text-size-adjust:100%; }
  body { background:var(--bg); color:var(--text); font-family:var(--sans); line-height:1.6; -webkit-font-smoothing:antialiased; overflow-x:hidden; }
  a { color:inherit; text-decoration:none; } a:hover { color:var(--accent); }
  .wrap { max-width:1040px; margin:0 auto; padding:0 28px; }
  nav { border-bottom:1px solid var(--border); position:sticky; top:0; background:rgba(239,238,234,.9); backdrop-filter:blur(12px); z-index:5; }
  nav .wrap { display:flex; align-items:center; justify-content:space-between; height:60px; }
  .logo { font-family:var(--display); font-weight:700; font-size:22px; display:flex; align-items:baseline; gap:7px; }
  .logo span { font-family:var(--mono); font-size:10px; font-weight:500; color:var(--accent); letter-spacing:.14em; text-transform:uppercase; border:1px solid var(--accent); padding:2px 6px; transform:translateY(-4px); }
  nav .links { display:flex; gap:22px; font-size:14px; color:var(--dim); align-items:center; }

  header { padding:48px 0 34px; border-bottom:1px solid var(--border); }
  .eyebrow { font-family:var(--mono); font-size:11.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--accent); margin-bottom:20px; }
  .eyebrow::before { content:"[ "; } .eyebrow::after { content:" ]"; }
  h1 { font-family:var(--display); font-weight:500; font-size:clamp(34px,4.4vw,52px); line-height:1.05; letter-spacing:-.02em; margin-bottom:18px; }
  h1 em { font-style:normal; color:var(--accent); }
  .sub { color:var(--muted); font-size:16px; max-width:660px; }
  .sub b { color:var(--dim); font-weight:600; }

  .strip { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); border:1px solid var(--border); border-bottom:none; margin-top:30px; background:var(--card); }
  .strip > div { padding:14px 16px; border-right:1px solid var(--border); border-bottom:1px solid var(--border); }
  .strip > div:last-child { border-right:none; }
  .strip .k { font-family:var(--mono); font-size:10.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin-bottom:5px; }
  .strip .v { font-family:var(--mono); font-size:19px; font-weight:500; font-variant-numeric:tabular-nums; }
  .dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--muted); margin-right:7px; vertical-align:middle; }
  .dot.on { background:var(--ok); animation:pulse 2s ease-in-out infinite; }
  .dot.off { background:var(--bad); }
  @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:.35 } }

  .panes { display:grid; grid-template-columns:1fr 1.25fr; gap:26px; padding:34px 0 10px; }
  .pane h2 { font-family:var(--display); font-size:18px; font-weight:600; display:flex; justify-content:space-between; align-items:baseline; margin-bottom:4px; }
  .pane h2 small { font-family:var(--mono); font-size:11px; color:var(--muted); font-weight:400; }
  .pane .lede { color:var(--muted); font-size:13px; margin-bottom:12px; }
  .feed { border:1px solid var(--border); background:#fff; height:430px; overflow:hidden; position:relative; }
  .feed .empty { padding:22px 16px; color:var(--muted); font-family:var(--mono); font-size:12px; }
  .row { display:flex; align-items:center; gap:10px; padding:9px 14px; border-bottom:1px solid var(--border); font-family:var(--mono); font-size:12px; animation:slide .28s ease-out; }
  @keyframes slide { from { opacity:0; transform:translateY(-7px) } to { opacity:1; transform:none } }
  .row .n { font-weight:500; font-variant-numeric:tabular-nums; }
  .row .tag { font-size:10px; padding:1px 6px; border:1px solid var(--border2); color:var(--muted); white-space:nowrap; }
  .row .tag.hot { border-color:var(--accent); color:var(--accent); }
  .row .grow { margin-left:auto; color:var(--muted); white-space:nowrap; }
  .row .addr { color:var(--dim); }
  .bar { height:3px; background:var(--accent); opacity:.22; margin-top:5px; }

  section.how { border-top:1px solid var(--border); padding:38px 0 46px; margin-top:26px; }
  section.how h2 { font-family:var(--display); font-size:22px; font-weight:600; margin-bottom:8px; }
  section.how .lede { color:var(--muted); font-size:15px; max-width:700px; margin-bottom:18px; }
  pre { background:var(--card); border:1px solid var(--border); padding:16px 18px; overflow-x:auto; font-family:var(--mono); font-size:12.5px; line-height:1.75; }
  pre .c { color:var(--muted); } pre .s { color:var(--accent); } pre .k { color:var(--dim); font-weight:600; }
  footer { padding:26px 0 56px; font-size:13px; color:var(--muted); display:flex; justify-content:space-between; gap:18px; flex-wrap:wrap; border-top:1px solid var(--border); }

  @media (max-width:900px) {
    .wrap { padding:0 16px; }
    header { padding:30px 0 26px; }
    .panes { grid-template-columns:1fr; gap:22px; padding-top:26px; }
    .strip { grid-template-columns:repeat(2,minmax(0,1fr)); }
    .feed { height:340px; }
    nav .links a { display:none; }
  }
</style>
</head>
<body>

<nav><div class="wrap">
  <a class="logo" href="/">ordo<span>live</span></a>
  <div class="links"><a href="/">rpc</a><a href="/swap">swap</a><a href="https://auction.ordofi.network">via</a><a href="${docs}">docs</a><a href="${app}">app</a></div>
</div></nav>

<header><div class="wrap">
  <div class="eyebrow">chain ${chainId} · wss://${rpc.replace(/^https?:\/\//, "")}</div>
  <h1>Robinhood Chain, <em>as it happens</em>.</h1>
  <p class="sub">A block every 100 milliseconds, pushed to this page over a WebSocket the moment the chain produces it. <b>Nothing here polls.</b> The chain's own RPC is HTTP only — it has no <code>eth_subscribe</code> at all — and the providers that do have one want an account first. This is open, keyless, and running in your browser right now.</p>
  <div class="strip">
    <div><div class="k">Connection</div><div class="v"><span class="dot" id="dot"></span><span id="state">opening…</span></div></div>
    <div><div class="k">Block height</div><div class="v" id="height">—</div></div>
    <div><div class="k">Blocks / second</div><div class="v" id="bps">—</div></div>
    <div><div class="k">Logs / second</div><div class="v" id="lps">—</div></div>
  </div>
</div></header>

<div class="wrap"><div class="panes">
  <div class="pane">
    <h2>Blocks <small id="bcount">newHeads</small></h2>
    <p class="lede">Every header, in order, as the sequencer produces it.</p>
    <div class="feed" id="blocks"><div class="empty">waiting for the first block…</div></div>
  </div>
  <div class="pane">
    <h2>Events <small id="lcount">logs</small></h2>
    <p class="lede">Every log the chain emits — swaps, transfers, everything.</p>
    <div class="feed" id="logs"><div class="empty">waiting for the first log…</div></div>
  </div>
</div></div>

<section class="how"><div class="wrap">
  <h2>The same thing, in your app</h2>
  <p class="lede">This page has no dependencies and no API key. It opens the socket below, sends two subscriptions, and renders what arrives — which is all there is to it.</p>
<pre><span class="c">// nothing to install, nothing to sign up for</span>
<span class="k">const</span> ws = <span class="k">new</span> WebSocket(<span class="s">"${wsUrl}"</span>);
ws.onopen = () =&gt; {
  ws.send(JSON.stringify({ jsonrpc: <span class="s">"2.0"</span>, id: 1, method: <span class="s">"eth_subscribe"</span>, params: [<span class="s">"newHeads"</span>] }));
  ws.send(JSON.stringify({ jsonrpc: <span class="s">"2.0"</span>, id: 2, method: <span class="s">"eth_subscribe"</span>, params: [<span class="s">"logs"</span>, {}] }));
};
ws.onmessage = (e) =&gt; console.log(JSON.parse(e.data).params.result);

<span class="c">// or with viem, if you would rather not hold the socket yourself</span>
<span class="k">const</span> client = createPublicClient({ chain, transport: webSocket(<span class="s">"${wsUrl}"</span>) });
client.watchBlocks({ onBlock: (b) =&gt; console.log(b.number) });</pre>
  <p class="lede" style="margin-top:16px">Ordinary calls travel on the same socket, so <code>eth_call</code>, <code>eth_getBalance</code> and a revert-protected <code>eth_sendRawTransaction</code> all work without opening a second connection. Details in the <a href="${docs}#gateway" style="color:var(--accent)">docs</a>.</p>
</div></section>

<div class="wrap"><footer>
  <span>© 2026 OrdoFi Labs · not affiliated with Robinhood Markets, Inc.</span>
  <span><a href="/">rpc.ordofi.network</a> &nbsp;·&nbsp; <a href="/health">/health</a> &nbsp;·&nbsp; <a href="${explorer}" target="_blank" rel="noopener">explorer</a></span>
</footer></div>

<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const NAMES = ${JSON.stringify(names)};
  const EXPLORER = ${JSON.stringify(explorer)};
  const MAX_ROWS = 24;
  const short = (a) => a.slice(0, 8) + "…" + a.slice(-4);
  const num = (n) => n.toLocaleString("en-US");

  let subBlocks = null, subLogs = null;
  let blockTimes = [], logTimes = [], lastBlockAt = 0;
  let pendingBlocks = [], pendingLogs = [], painting = false;

  function setState(text, cls) {
    $("state").textContent = text;
    $("dot").className = "dot" + (cls ? " " + cls : "");
  }

  // Rendering is batched into a frame: at ten blocks and a few hundred logs a
  // second, touching the DOM per message is what would make this page stutter,
  // not the network.
  function schedule() {
    if (painting) return;
    painting = true;
    requestAnimationFrame(() => {
      painting = false;
      flush("blocks", pendingBlocks); pendingBlocks = [];
      flush("logs", pendingLogs); pendingLogs = [];
      paintStats();
    });
  }

  function flush(id, rows) {
    if (!rows.length) return;
    const box = $(id);
    const empty = box.querySelector(".empty");
    if (empty) empty.remove();
    const frag = document.createDocumentFragment();
    for (const html of rows.slice(-MAX_ROWS)) {
      const el = document.createElement("div");
      el.className = "row";
      el.innerHTML = html;
      frag.appendChild(el);
    }
    box.insertBefore(frag, box.firstChild);
    while (box.children.length > MAX_ROWS) box.removeChild(box.lastChild);
  }

  function paintStats() {
    const now = Date.now();
    blockTimes = blockTimes.filter((t) => now - t < 5000);
    logTimes = logTimes.filter((t) => now - t < 5000);
    $("bps").textContent = blockTimes.length ? (blockTimes.length / 5).toFixed(1) : "—";
    $("lps").textContent = logTimes.length ? Math.round(logTimes.length / 5) : "—";
  }

  function onBlock(h) {
    const n = parseInt(h.number, 16);
    const txs = 0; // headers carry no transaction list; gas is the useful signal
    const gas = parseInt(h.gasUsed ?? "0x0", 16);
    const limit = parseInt(h.gasLimit ?? "0x1", 16);
    const now = Date.now();
    const gap = lastBlockAt ? now - lastBlockAt : 0;
    lastBlockAt = now;
    blockTimes.push(now);
    $("height").textContent = num(n);
    const pctFull = Math.min(100, (gas / Math.max(limit, 1)) * 100);
    pendingBlocks.push(
      '<span class="n">' + num(n) + '</span>' +
      '<span class="tag">' + (gas > 999999 ? (gas / 1e6).toFixed(2) + "M" : num(gas)) + ' gas</span>' +
      '<span class="grow">' + (gap ? "+" + gap + "ms" : "") + '</span>' +
      '<div class="bar" style="width:' + pctFull.toFixed(1) + '%"></div>'
    );
    schedule();
  }

  function onLog(l) {
    logTimes.push(Date.now());
    const topic = (l.topics && l.topics[0]) || "";
    const name = NAMES[topic];
    pendingLogs.push(
      '<span class="tag' + (name && name.startsWith("Swap") ? " hot" : "") + '">' + (name || (topic ? topic.slice(0, 10) : "anonymous")) + "</span>" +
      '<a class="addr" href="' + EXPLORER + "/address/" + l.address + '" target="_blank" rel="noopener">' + short(l.address) + "</a>" +
      '<span class="grow">' + num(parseInt(l.blockNumber, 16)) + "</span>"
    );
    schedule();
  }

  let backoff = 500;
  function connect() {
    setState("connecting…", "");
    const ws = new WebSocket(location.origin.replace(/^http/, "ws"));

    ws.onopen = () => {
      backoff = 500;
      setState("live", "on");
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newHeads"] }));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_subscribe", params: ["logs", {}] }));
    };

    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      for (const msg of Array.isArray(m) ? m : [m]) {
        if (msg.id === 1) { subBlocks = msg.result; continue; }
        if (msg.id === 2) { subLogs = msg.result; continue; }
        if (msg.method !== "eth_subscription") continue;
        const { subscription, result } = msg.params;
        if (subscription === subBlocks) onBlock(result);
        else if (subscription === subLogs) onLog(result);
      }
    };

    // A dropped socket should look like a dropped socket, then come back.
    const again = () => {
      setState("reconnecting…", "off");
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 10000);
    };
    ws.onclose = again;
    ws.onerror = () => ws.close();
  }

  setInterval(paintStats, 1000);
  connect();
})();
</script>
</body>
</html>`;
}
