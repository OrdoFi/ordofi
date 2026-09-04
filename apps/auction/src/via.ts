/**
 * What a browser sees at https://auction.ordofi.network/.
 *
 * The auction already issues signed acknowledgements and receipts and anchors
 * a Merkle root on-chain (receipts.ts, packages/core/src/receipt.ts), and
 * until now none of it was visible: the endpoints returned JSON to whoever
 * already knew they existed, and the root was a number nobody had ever seen.
 * An auction is only worth bidding into if an outsider can judge it, so this
 * page shows the rounds as they close — every bid, the winner, the second
 * price actually charged — and the command to check any of it independently.
 *
 * Self-contained, like the gateway's landing page: the auction is its own
 * origin and must not go blank because the app is down. Everything below the
 * fold is fetched from this same host.
 */
export function viaHtml(opts: {
  settlement: string;
  receiptLog: string;
  explorer: string;
  app: string;
  rpc: string;
  docs: string;
  /**
   * The searcher OrdoFi runs itself. Rounds it wins are marked, because a
   * round the operator won with its own bot is not the same fact as a round
   * an outsider won, and a page that shows them identically is telling the
   * reader something untrue about how much of this market exists yet.
   */
  houseSearcher: string;
}): string {
  const { settlement, receiptLog, explorer, app, rpc, docs, houseSearcher } = opts;
  const addr = (a: string) => (a ? `<a href="${explorer}/address/${a}" target="_blank" rel="noopener">${a.slice(0, 10)}…${a.slice(-6)}</a>` : "—");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Ordo VIA — the Verifiable Inclusion Auction on Robinhood Chain</title>
<meta name="description" content="Searchers bid for the right to back-run a transaction; the user whose transaction created it keeps 90% of what they pay. Every bid is signed, every round is published, and the whole history is anchored on-chain." />
<link rel="icon" type="image/png" sizes="32x32" href="${app}/favicon-32.png" />
<link href="https://fonts.googleapis.com/css2?family=Funnel+Display:wght@400;500;600;700&family=Inter:wght@400;500;600&family=Fira+Code:wght@400;500&display=swap" rel="stylesheet" />
<style>
  :root { --bg:#efeeea; --card:#f3f2ee; --border:#d8d5ce; --border2:#c6c2b9; --text:#1d1616; --dim:#3a3430; --muted:#6d6660; --accent:#ff6414; --accent2:#e35505; --soft:#ffe3d2; --ok:#1e9e6a; --bad:#c0392b;
    --mono:"Fira Code",ui-monospace,Menlo,monospace; --sans:Inter,-apple-system,sans-serif; --display:"Funnel Display",Inter,sans-serif; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:var(--bg); color:var(--text); font-family:var(--sans); line-height:1.6; -webkit-font-smoothing:antialiased; }
  a { color:inherit; text-decoration:none; }
  a:hover { color:var(--accent); }
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
  .status .v.ok { color:var(--ok); } .status .v.bad { color:var(--bad); }
  .summary { border:1px solid var(--border); border-top:none; padding:18px 24px; color:var(--dim); font-size:14.5px; }
  .summary b { font-weight:600; }
  table.quiet td { color:var(--muted); }
  .more { margin-top:14px; font-size:13.5px; color:var(--muted); }
  section { padding:60px 0; border-bottom:1px solid var(--border); }
  h2 { font-family:var(--display); font-weight:500; font-size:30px; letter-spacing:-.015em; margin-bottom:10px; }
  .lede { color:var(--muted); font-size:15.5px; max-width:680px; margin-bottom:26px; }
  table { width:100%; border-collapse:collapse; border:1px solid var(--border); background:var(--bg); font-size:13.5px; }
  th, td { text-align:left; padding:11px 15px; border-bottom:1px solid var(--border); vertical-align:top; }
  th { font-family:var(--mono); font-size:10.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); font-weight:500; }
  tr:last-child td { border-bottom:none; }
  td.mono, .mono { font-family:var(--mono); font-size:12.5px; }
  .empty { padding:34px 18px; text-align:center; color:var(--muted); font-size:14.5px; border:1px dashed var(--border2); }
  pre { background:var(--card); border:1px solid var(--border); padding:18px 20px; overflow-x:auto; font-family:var(--mono); font-size:12.5px; line-height:1.75; }
  pre .c { color:var(--muted); }
  .grid3 { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); border:1px solid var(--border); }
  .grid3 > div { padding:26px 24px; border-right:1px solid var(--border); }
  .grid3 > div:last-child { border-right:none; }
  .grid3 .n { font-family:var(--mono); font-size:22px; color:var(--accent); margin-bottom:12px; }
  .grid3 h4 { font-family:var(--display); font-size:18px; font-weight:600; margin-bottom:8px; }
  .grid3 p { color:var(--muted); font-size:14px; }
  p code, td code, li code { font-family:var(--mono); font-size:.9em; background:var(--soft); color:var(--accent2); padding:1px 5px; }
  .split { display:grid; grid-template-columns:1fr 1fr; gap:36px; align-items:start; }
  .split p { color:var(--muted); font-size:15px; margin-bottom:14px; }
  .split h3 { font-family:var(--display); font-size:20px; font-weight:600; margin-bottom:10px; }
  .roadmap li { list-style:none; padding:14px 0 14px 0; border-bottom:1px solid var(--border); display:flex; gap:16px; align-items:baseline; }
  .roadmap li:last-child { border-bottom:none; }
  .tag { font-family:var(--mono); font-size:10px; letter-spacing:.08em; text-transform:uppercase; padding:2px 7px; border:1px solid var(--border2); color:var(--muted); white-space:nowrap; }
  .tag.live { color:var(--ok); border-color:var(--ok); }
  .tag.house { color:var(--accent2); border-color:var(--accent2); margin-left:6px; }
  .roadmap b { font-family:var(--display); font-weight:600; font-size:16px; }
  .roadmap span.d { color:var(--muted); font-size:14px; }
  footer { padding:34px 0 60px; font-size:13px; color:var(--muted); display:flex; justify-content:space-between; gap:20px; flex-wrap:wrap; }
  @media (max-width:860px) { .status { grid-template-columns:repeat(2,minmax(0,1fr)); } .grid3 { grid-template-columns:1fr; } .split { grid-template-columns:1fr; } .hide-s { display:none; } }
  @media (max-width:600px) { nav .links { gap:14px; font-size:13px; } .logo { font-size:19px; } }
  /* Narrower than this the four links reach the logo; the two that matter stay. */
  @media (max-width:430px) { nav .links a:nth-child(n+3) { display:none; } }
</style>
</head>
<body>
<nav><div class="wrap">
  <a class="logo" href="${app}">ordo <span>via</span></a>
  <div class="links"><a href="${rpc}">rpc</a><a href="${docs}">docs</a><a href="/receipts">receipts</a><a href="${app}">app</a></div>
</div></nav>

<header><div class="wrap">
  <div class="eyebrow">Verifiable Inclusion Auction</div>
  <h1>If there is nothing to extract, <em>nothing is extracted.</em></h1>
  <p class="sub">Every transaction through Ordo is simulated, then offered to bonded searchers. Most wallet sends have no back-run in them — the auction closes empty, the transaction still lands, and the user is charged nothing extra. When a searcher does bid, 90% of what they pay goes to the person whose transaction created it. Every outcome is signed and anchored on-chain, including the empty ones.</p>
</div></header>

<div class="wrap"><div class="status">
  <div><div class="k">Taken from users</div><div class="v ok" id="st-taken">—</div></div>
  <div><div class="k">Receipts published</div><div class="v" id="st-count">—</div></div>
  <div><div class="k">Anchored on-chain</div><div class="v" id="st-anchored">—</div></div>
  <div><div class="k">Searchers watching</div><div class="v" id="st-searchers">—</div></div>
</div>
<div class="summary" id="st-summary">loading…</div></div>

<section><div class="wrap">
  <h2>What closed</h2>
  <p class="lede">A sold round shows the winner and the second price they were charged. An unsold round is the common case on this flow: a searcher looked, found nothing worth paying for, and the user's transaction went out as it was. Rounds won by <span class="tag house">house</span> were won by the searcher OrdoFi runs itself — those are us bidding, not a market clearing.</p>
  <div id="rounds"><div class="empty">loading…</div></div>
</div></section>

<section><div class="wrap">
  <h2>Check it yourself</h2>
  <p class="lede">The point of publishing bids is that someone can catch us. No account, no trust:</p>
  <pre><span class="c"># the whole history, and how much of it is already immutable on-chain</span>
curl ${"https://auction.ordofi.network"}/receipts/root

<span class="c"># one round, every bid in it</span>
curl ${"https://auction.ordofi.network"}/receipts/&lt;opportunityId&gt;

<span class="c"># the strong one: rebuild the anchored root from the published receipts and
# compare it to what the contract holds. If we ever swapped a receipt out after
# publishing it, these two stop matching and there is nothing we can do about it.
# /receipts serves newest first; the tree is built oldest first, hence reverse().</span>
const rs = (await (await fetch("${"https://auction.ordofi.network"}/receipts?n=1000")).json()).receipts.reverse();
const { root, count } = await log.read.latest();          <span class="c">// ${"0x89926c06cad403fDDD481C599b2ce709EBC936B9"}</span>
merkleRoot(rs.slice(0, Number(count)).map(receiptHash)) === root

<span class="c"># what a searcher runs: the acknowledged bid must appear at the acknowledged
# amount, every listed bid must carry that searcher's own signature, and the
# winner must be the highest bidder charged the second-highest price</span>
auditReceipt(ack, receipt)   <span class="c">// packages/core/src/receipt.ts</span></pre>
</div></section>

<section><div class="wrap">
  <h2>What is actually proven</h2>
  <div class="grid3">
    <div><div class="n">01</div><h4>Bids cannot be invented</h4><p>Second price charges the winner what the runner-up bid, so inventing a runner-up is the operator's most profitable attack — and the arithmetic would still check out. Every listed bid carries the searcher's own EIP-712 signature, the same one <code>OrdoSettlement</code> demands before debiting their bond. We cannot forge it.</p></div>
    <div><div class="n">02</div><h4>Receipts cannot be swapped</h4><p>Signatures make one receipt unforgeable but not the set of them. A Merkle root over every receipt ever issued is committed to <code>OrdoReceiptLog</code>; the anchored prefix is immutable, and the gap to the published count bounds exactly what could still be retracted.</p></div>
    <div><div class="n">03</div><h4>The split is not ours to choose</h4><p>90% to the user whose transaction created the opportunity, 5% to the app that sent them, 5% to the treasury — enforced by the settlement contract and conserved to the wei, not applied by us afterwards.</p></div>
  </div>
</div></section>

<section><div class="wrap">
  <div class="split">
    <div>
      <h3>For searchers</h3>
      <p>Post a bond, connect to the feed, bid. You see the opportunity the moment the sequencer does — the auction relays the raw feed — and you can audit every round you lost to know it was lost honestly.</p>
      <p class="mono" style="font-size:12.5px">wss://auction.ordofi.network/searcher</p>
    </div>
    <div>
      <h3>For apps</h3>
      <p>Route your users through <span class="mono">rpc.ordofi.network</span> and 5% of everything captured on their transactions is yours, with the users keeping 90%. No key in your frontend is required for the user to be protected; the rebate is settled on-chain to the addresses in the receipt.</p>
      <p><a href="${docs}" style="color:var(--accent)">Integration docs →</a></p>
    </div>
  </div>
</div></section>

<section><div class="wrap">
  <h2>What comes next</h2>
  <p class="lede">Ordo VIA is the auction today. Three things extend it, and we would rather name them before they exist than pretend they already do.</p>
  <ul class="roadmap">
    <li><span class="tag live">live</span><div><b>The Auction.</b> <span class="d">Sealed-bid, second price, bonded searchers, signed receipts, anchored on-chain.</span></div></li>
    <li><span class="tag">planned</span><div><b>The Seal.</b> <span class="d">The gateway inside a trusted enclave with a published attestation, so "we do not read or reorder your transaction" becomes something you can verify instead of something we assert.</span></div></li>
    <li><span class="tag">planned</span><div><b>Routes.</b> <span class="d">An app defines the ordering policy for its own flow — a launch where buys are strictly time-ordered and no bundle interleaves, cancels ahead of fills, back-runs that must pay into the app's rebate pool.</span></div></li>
    <li><span class="tag">blocked</span><div><b>VIA Express.</b> <span class="d">Arbitrum's express lane sells immediate sequencing to an auction winner who may pass the advantage to transactions signed by others. Robinhood Chain has it switched off; if it opens, every transaction sent via Ordo skips the delay everyone else takes.</span></div></li>
  </ul>
</div></section>

<div class="wrap"><footer>
  <span>© 2026 OrdoFi Labs · not affiliated with Robinhood Markets, Inc.</span>
  <span>settlement ${addr(settlement)} &nbsp;·&nbsp; receipt log ${addr(receiptLog)} &nbsp;·&nbsp; <a href="/health">/health</a></span>
</footer></div>

<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const HOUSE = ${JSON.stringify(houseSearcher.toLowerCase())};
  const short = (h) => !h ? "—" : h.slice(0, 8) + "…" + h.slice(-4);
  const eth = (wei) => {
    try {
      const v = Number(BigInt(wei)) / 1e18;
      if (v === 0) return "0";
      return v < 0.00001 ? v.toExponential(2) : v.toFixed(v < 1 ? 6 : 4).replace(/0+$/, "").replace(/\\.$/, "");
    } catch { return "—"; }
  };
  const ago = (ms) => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  async function refresh() {
    const [root, health, list] = await Promise.all([
      fetch("/receipts/root").then((r) => r.json()).catch(() => null),
      fetch("/health").then((r) => r.json()).catch(() => null),
      fetch("/receipts?n=200").then((r) => r.json()).catch(() => null),
    ]);

    const rs = list && Array.isArray(list.receipts) ? list.receipts : [];
    const sold = rs.filter((r) => r.winner);
    const empty = rs.filter((r) => !r.winner);
    const takenWei = sold.reduce((n, r) => n + BigInt(r.clearingPriceWei || 0), 0n);

    if (root) {
      $("st-count").innerHTML = root.count.toLocaleString() + "<small>signed · root " + short(root.root) + "</small>";
      const gap = root.count - root.anchoredCount;
      $("st-anchored").innerHTML = root.anchoredCount.toLocaleString() +
        "<small>" + (gap > 0 ? gap + " not yet committed" : "the whole history") + "</small>";
    }
    $("st-taken").innerHTML = (takenWei === 0n ? "$0.00" : eth(takenWei.toString()) + " ETH") +
      "<small>" + (takenWei === 0n ? "no user was overcharged" : "second-price proceeds, this page") + "</small>";
    if (health) {
      const s = health.stats || {};
      $("st-searchers").innerHTML = (health.searchers ?? 0) +
        "<small>" + (s.bids ?? 0) + " bids · " + (s.settled ?? 0) + " settled</small>";
    }
    if (root) {
      const n = root.count;
      const a = root.anchoredCount;
      $("st-summary").innerHTML = "<b>" + n.toLocaleString() + " transactions</b> went through the auction. " +
        (sold.length ? sold.length + " had a bidder. " : "None of the recent ones had a bidder — typical for transfers and dust swaps. ") +
        a.toLocaleString() + " receipts are already immutable on-chain. Auctioneer " + short(root.auctioneer) + " signed every one.";
    }

    if (!rs.length) {
      $("rounds").innerHTML = '<div class="empty">No rounds have closed yet. Transactions sent through <span class="mono">rpc.ordofi.network</span> appear here as they settle.</div>';
      return;
    }

    const row = (r) => {
      const bids = Array.isArray(r.bids) ? r.bids : [];
      const top = bids.map((b) => eth(b.bidWei)).sort((a, b) => Number(b) - Number(a))[0];
      const isHouse = HOUSE && r.winner && r.winner.toLowerCase() === HOUSE;
      const outcome = r.winner
        ? short(r.winner) + (isHouse ? '<span class="tag house">house</span>' : "")
        : '<span style="color:var(--muted)">nothing extracted</span>';
      const bidCell = bids.length
        ? bids.length + '<span class="mono" style="color:var(--muted)"> · top ' + top + " ETH</span>"
        : "looked, passed";
      return "<tr>" +
        '<td class="mono"><a href="/receipts/' + esc(r.opportunityId) + '">' + short(r.opportunityId) + "</a></td>" +
        "<td>" + bidCell + "</td>" +
        '<td class="mono">' + outcome + "</td>" +
        "<td>" + (r.winner ? eth(r.clearingPriceWei) + " ETH" : "$0 extra") + "</td>" +
        '<td class="hide-s">' + (r.winner ? eth((BigInt(r.clearingPriceWei) * 90n / 100n).toString()) + " ETH" : "—") + "</td>" +
        '<td class="hide-s mono" style="color:var(--muted)">' + ago(r.closedAt) + "</td>" +
        "</tr>";
    };

    let html = "";
    if (sold.length) {
      html += "<table><thead><tr><th>Sold</th><th>Bids</th><th>Winner</th><th>Charged</th>" +
        '<th class="hide-s">To the user</th><th class="hide-s">Closed</th></tr></thead><tbody>' +
        sold.map(row).join("") + "</tbody></table>";
    }
    if (empty.length) {
      const shown = empty.slice(0, 8);
      const hidden = empty.length - shown.length;
      html += (sold.length ? '<p class="more">' + empty.length + " closed with nothing to extract — still signed, still on the log.</p>" : "") +
        '<table class="' + (sold.length ? "quiet" : "") + '"><thead><tr><th>Round</th><th>Searchers</th><th>Outcome</th><th>User paid</th>' +
        '<th class="hide-s">Rebate</th><th class="hide-s">Closed</th></tr></thead><tbody>' +
        shown.map(row).join("") + "</tbody></table>" +
        (hidden > 0 ? '<p class="more">' + hidden + " older empty rounds on <a href=\"/receipts\">/receipts</a>.</p>" : "");
    }
    $("rounds").innerHTML = html;
  }

  refresh();
  setInterval(refresh, 15000);
})();
</script>
</body>
</html>`;
}
