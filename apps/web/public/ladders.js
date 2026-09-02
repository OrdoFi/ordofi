/**
 * Position cards for ladders held in OrdoLadderManager, grouped by token,
 * with every action a holder has: claim fees, add liquidity (with a shape
 * for what is added), partial withdraw (pick bins), close, close all, and a
 * PnL card image to share. Used by the pool page and the Positions page.
 */
import { wallet, rejected } from "/wallet.js";

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const usd = (n, d) => n == null || !isFinite(n) ? "—" : (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: d ?? (Math.abs(n) >= 1000 ? 0 : 2), minimumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 });
export const num = (n, d = 2) => n == null || !isFinite(Number(n)) ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
export const fmtPx = (p) => p == null || !isFinite(p) ? "—" : p >= 1000 ? p.toLocaleString(undefined, { maximumFractionDigits: 2 }) : p >= 1 ? p.toFixed(4) : p >= 0.01 ? p.toFixed(6) : p.toExponential(3);
export const fmtBig = (n) => n == null || !isFinite(n) ? "—" : n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : n.toFixed(2);
export const formatUnits = (v, d, dp = 6) => { const s = BigInt(v ?? 0).toString().padStart(d + 1, "0"); const i = s.slice(0, -d) || "0", f = s.slice(-d).slice(0, dp).replace(/0+$/, ""); return f ? `${i}.${f}` : i; };
export const parseUnits = (s, d) => { const [i, f = ""] = String(s || "0").trim().replace(/,/g, "").split("."); if (!/^\d*$/.test(i) || !/^\d*$/.test(f)) return null; return BigInt((i || "0") + f.slice(0, d).padEnd(d, "0")); };
const EXPLORER = "https://robinhoodchain.blockscout.com";
const txLink = (h) => `<a href="${EXPLORER}/tx/${h}" target="_blank" rel="noopener">${h.slice(0, 10)}…</a>`;
const SHAPE_NAME = { spot: "Spot", curve: "Curve", bidask: "Bid-Ask" };
export const SHAPE_DESC = {
  spot: "Even across the whole range. No view on where price settles.",
  curve: "Heaviest in the middle. For when you expect price to stay near here.",
  bidask: "Heaviest furthest from the current price. Converts as price walks through it, so it works as a ladder.",
};

export const CSS = `
.lg{border:1px solid var(--border);background:var(--card);margin-bottom:16px}
.lg-h{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--border)}
.lg-h .ic{width:30px;height:30px;border-radius:50%;background:var(--accent-soft);color:var(--accent-dim);font-family:var(--mono);font-size:11px;display:flex;align-items:center;justify-content:center;overflow:hidden;flex:none}
.lg-h .ic img{width:100%;height:100%;object-fit:cover}
.lg-h b{font-family:var(--display);font-size:15px;letter-spacing:.02em}
.lg-h small{color:var(--muted);font-family:var(--mono);font-size:11px}
.lg-h a{color:var(--accent);font-size:12.5px;margin-left:auto;text-decoration:none}
.lg-h .closeall{white-space:nowrap;font:inherit;font-size:12px;padding:7px 14px;border:1px solid var(--text);background:var(--text);color:#fff;cursor:pointer;margin-left:12px}
.lg-h .closeall:disabled{opacity:.4;cursor:default}
.lc{padding:16px;border-bottom:1px solid var(--border)}
.lc:last-child{border-bottom:none}
.lc .tags{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.lc .tag{display:inline-block;font-family:var(--mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;padding:4px 9px;border:1px solid var(--border-light);color:var(--text-dim);border-radius:999px}
.lc .tag.in{border-color:#1e9e6a;color:#1e9e6a}.lc .tag.out{color:var(--muted)}.lc .tag.done{border-color:var(--text);color:var(--text)}
.lc .tags .bins{font-family:var(--mono);font-size:11px;color:var(--muted);margin-left:4px}
.lc .acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.lc .acts button{font-family:var(--mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase;padding:9px 14px;border:1px solid var(--border-light);background:#fff;color:var(--text);cursor:pointer;border-radius:999px}
.lc .acts button:hover{border-color:var(--accent);color:var(--accent)}
.lc .acts button:disabled{opacity:.4;cursor:default;border-color:var(--border);color:var(--muted)}
.lc .acts button.primary{background:var(--text);color:#fff;border-color:var(--text)}
.lc .acts button.primary:hover{background:var(--accent);border-color:var(--accent);color:#fff}
.lc .rng{display:flex;justify-content:space-between;margin-top:16px;font-family:var(--mono)}
.lc .rng b{font-size:15px;font-weight:600;display:block}.lc .rng small{color:var(--muted);font-size:11px;display:block}
.lc .cur{text-align:right;font-family:var(--mono);font-size:11px;color:var(--muted);margin-top:2px}
.lc .bars{position:relative;height:44px;margin:8px 0 14px;display:flex;align-items:flex-end;gap:2px}
.lc .bars i{flex:1;background:var(--accent-soft);border-top:2px solid var(--accent);display:block;min-height:3px}
.lc .bars i.closed{background:var(--bg-elev);border-top-color:var(--border-light)}
.lc .bars i.hit{background:var(--accent)}
.lc .bars em{position:absolute;top:-6px;bottom:-6px;width:2px;background:var(--text)}
.lc .kv{display:grid;grid-template-columns:1fr 1fr;gap:14px 18px}
.lc .kv .k{font-family:var(--mono);font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
.lc .kv .v{font-family:var(--mono);font-size:15px;margin-top:4px}
.lc .kv .v small{display:block;color:var(--muted);font-size:12px;margin-top:2px}
.up{color:#1e9e6a}.dn{color:var(--danger)}
.lc .res{font-family:var(--mono);font-size:11px;color:var(--muted);margin-top:10px;min-height:14px}
.lc .res a{color:var(--accent)}.lc .res.bad{color:var(--danger)}
.lempty{padding:26px 18px;color:var(--muted);font-size:13px}
/* dialogs */
.ld-modal{position:fixed;inset:0;background:rgba(25,24,23,.45);display:none;align-items:flex-start;justify-content:center;padding:8vh 16px;z-index:250;overflow:auto}
.ld-modal.open{display:flex}
.ld{background:var(--card);border:1px solid var(--border);width:560px;max-width:100%}
.ld .h{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid var(--border);font-family:var(--display);font-weight:700;font-size:15px}
.ld .h .x{cursor:pointer;color:var(--muted);font-weight:400}
.ld .b{padding:18px}
.ld p{color:var(--muted);font-size:13px;line-height:1.6;margin:0 0 14px}
.ld h4{font-family:var(--mono);font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin:16px 0 8px}
.ld .shapes{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.ld .shape{border:1px solid var(--border);background:#fff;padding:10px;cursor:pointer}
.ld .shape.on{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
.ld .shape b{display:block;font-size:12.5px}.ld .shape small{display:block;color:var(--muted);font-size:10.5px;line-height:1.4;margin-top:3px}
.ld .box{display:flex;align-items:center;gap:8px;background:var(--bg);border:1px solid var(--border);padding:9px 11px;margin-top:8px}
.ld .box input{flex:1;min-width:0;border:none;background:transparent;font-family:var(--mono);font-size:14px;color:var(--text);outline:none}
.ld .box .u{font-family:var(--mono);font-size:11px;color:var(--muted)}
.ld .box button{font:inherit;font-size:10.5px;font-family:var(--mono);color:var(--accent);background:none;border:none;cursor:pointer}
.ld .hint{font-family:var(--mono);font-size:10.5px;color:var(--muted);margin-top:4px}
.ld .binrow{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);cursor:pointer}
.ld .binrow:last-child{border-bottom:none}
.ld .binrow input{accent-color:var(--accent);width:16px;height:16px}
.ld .binrow .r{font-family:var(--mono);font-size:12px;flex:1}.ld .binrow .r small{display:block;color:var(--muted);font-size:10.5px}
.ld .binrow .a{font-family:var(--mono);font-size:12px;text-align:right}.ld .binrow .a small{display:block;color:var(--muted);font-size:10.5px}
.ld .foot{display:flex;gap:8px;justify-content:flex-end;margin-top:18px}
.ld .foot button{font:inherit;font-size:13px;padding:10px 18px;border:1px solid var(--border);background:#fff;cursor:pointer}
.ld .foot .go{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.ld .foot button:disabled{opacity:.45;cursor:default}
.ld .lands{border:1px solid var(--border);background:#fff;padding:10px 12px;margin-top:8px;font-family:var(--mono);font-size:11px;color:var(--muted);line-height:1.7}
.ld .lands canvas{width:100%;height:48px;display:block;margin-bottom:6px}
.ld .res{font-family:var(--mono);font-size:11px;color:var(--muted);margin-top:10px;min-height:14px}.ld .res a{color:var(--accent)}.ld .res.bad{color:var(--danger)}
.ld canvas.pnl{width:100%;display:block;border:1px solid var(--border)}
`;

let styled = false;
function ensureStyle() { if (styled) return; styled = true; const st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st); }
async function api(path) { const r = await fetch(path, { cache: "no-store" }); const d = await r.json(); if (!r.ok || d.error) throw new Error(d.error ?? `HTTP ${r.status}`); return d; }

/** Orientation helpers: amounts come as token0/token1; the UI speaks base/quote. */
const baseAmt = (l, a0, a1) => BigInt(l.base.isToken0 ? a0 : a1);
const quoteAmt = (l, a0, a1) => BigInt(l.base.isToken0 ? a1 : a0);
const fmtBase = (l, a0, a1, dp = 6) => `${num(formatUnits(baseAmt(l, a0, a1), l.base.decimals, dp), dp)} ${esc(l.base.symbol)}`;
const fmtQuote = (l, a0, a1, dp = 6) => `${num(formatUnits(quoteAmt(l, a0, a1), l.quote.decimals, dp), dp)} ${esc(l.quote.symbol)}`;

/**
 * Render an owner's ladders into `container`. `opts.token` filters to one
 * token; `opts.includeClosed` keeps closed ladders (the Positions page shows
 * them in the calendar, not as cards). `opts.onChange` runs after any action lands.
 */
export function renderLadders(container, portfolio, opts = {}) {
  ensureStyle();
  let ladders = (portfolio?.ladders ?? []).filter((l) => opts.includeClosed || !l.closed);
  if (opts.token) ladders = ladders.filter((l) => l.base.address === opts.token || l.quote.address === opts.token);
  if (!ladders.length) { container.innerHTML = `<div class="lempty">${opts.emptyText ?? "No open positions yet."}</div>`; return; }
  const groups = new Map();
  for (const l of ladders) { const k = l.base.address; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(l); }
  container.innerHTML = [...groups.values()].map((ls) => {
    const b = ls[0].base;
    return `<div class="lg" data-token="${b.address}">
      <div class="lg-h"><div class="ic">${b.icon ? `<img src="${esc(b.icon)}" alt="" />` : esc(b.symbol.slice(0, 2))}</div><b>${esc(b.name ?? b.symbol).toUpperCase()}</b><small>${esc(b.symbol)}</small>
        ${opts.token ? "" : `<a href="/pools/${b.address}">open pool page →</a>`}<button class="closeall" data-ids="${ls.filter((l) => !l.closed).map((l) => l.id).join(",")}" ${ls.filter((l) => !l.closed).length > 1 ? "" : "disabled"}>Close all</button></div>
      ${ls.map((l) => card(l)).join("")}</div>`;
  }).join("");
  container.querySelectorAll("button[data-act]").forEach((btn) => btn.addEventListener("click", () => act(btn.dataset.act, portfolio.ladders.find((l) => l.id === btn.dataset.id), btn, opts)));
  container.querySelectorAll(".closeall").forEach((btn) => btn.addEventListener("click", () => closeAll(btn.dataset.ids.split(",").filter(Boolean), btn, opts)));
}

function card(l) {
  const open = l.bins.filter((b) => b.open);
  const mx = Math.max(...open.map((b) => b.usd), 1e-9);
  const f = Math.min(1, Math.max(0, (Math.log(l.price) - Math.log(l.minPrice)) / (Math.log(l.maxPrice) - Math.log(l.minPrice) || 1)));
  const fees = Number(l.unclaimed0) + Number(l.unclaimed1) > 0;
  const bins = l.bins.slice().sort((a, b) => a.priceLower - b.priceLower);
  return `<div class="lc" data-id="${l.id}">
    <div class="tags"><span class="tag ${l.closed ? "done" : l.inRange ? "in" : "out"}">${l.closed ? "closed" : l.inRange ? "in range" : "out of range"}</span><span class="tag">${SHAPE_NAME[l.shape] ?? l.shape}</span><span class="tag">V3 · ${(l.fee / 1e4).toFixed(2)}%</span><span class="bins">${l.openBins}${l.openBins !== l.binCount ? `/${l.binCount}` : ""} bins</span></div>
    ${l.closed ? "" : `<div class="acts">
      <button data-act="pnl" data-id="${l.id}">PnL card</button>
      <button data-act="collect" data-id="${l.id}" ${fees ? "" : "disabled"}>Claim fees</button>
      <button data-act="add" data-id="${l.id}">Add liquidity</button>
      <button data-act="partial" data-id="${l.id}" ${l.openBins > 1 ? "" : "disabled"}>Partial withdraw</button>
      <button data-act="close" data-id="${l.id}" class="primary">Close</button></div>`}
    <div class="rng"><div><b>${fmtPx(l.minPrice)}</b><small>${l.quote.usdPerToken ? usd(l.minPrice * l.quote.usdPerToken) : ""}</small></div><div style="text-align:right"><b>${fmtPx(l.maxPrice)}</b><small>${l.quote.usdPerToken ? usd(l.maxPrice * l.quote.usdPerToken) : ""}</small></div></div>
    <div class="cur">${l.priceUsd ? usd(l.priceUsd) : fmtPx(l.price)} ›</div>
    <div class="bars">${bins.map((b) => `<i class="${!b.open ? "closed" : b.inRange ? "hit" : ""}" style="height:${b.open ? Math.max(6, (b.usd / mx) * 100) : 6}%" title="${fmtPx(b.priceLower)} – ${fmtPx(b.priceUpper)}"></i>`).join("")}<em style="left:${(f * 100).toFixed(2)}%"></em></div>
    <div class="kv">
      <div><div class="k">Value</div><div class="v">${usd(l.valueUsd)}<small>${fmtBase(l, l.held0, l.held1, 4)} · ${fmtQuote(l, l.held0, l.held1)}</small></div></div>
      <div><div class="k">Holdings</div><div class="v">${fmtBase(l, l.held0, l.held1, 4)}<small>${fmtQuote(l, l.held0, l.held1)}</small></div></div>
      <div><div class="k">Unclaimed fees</div><div class="v">${fees ? usd(l.unclaimedUsd, 4) : "—"}${fees ? `<small>${fmtBase(l, l.unclaimed0, l.unclaimed1)} · ${fmtQuote(l, l.unclaimed0, l.unclaimed1)}</small>` : ""}</div></div>
      <div><div class="k">Claimed fees</div><div class="v">${l.claimedUsd > 0 ? usd(l.claimedUsd, 4) : "—"}</div></div>
      <div><div class="k">PnL</div><div class="v ${l.pnlUsd >= 0 ? "up" : "dn"}">${l.pnlUsd >= 0 ? "+" : ""}${usd(l.pnlUsd)}<small class="${l.pnlUsd >= 0 ? "up" : "dn"}">${l.pnlPct == null ? "" : (l.pnlPct >= 0 ? "+" : "") + (l.pnlPct * 100).toFixed(2) + "%"}</small></div></div>
      <div><div class="k">Gas paid</div><div class="v">${usd(l.gasUsd)}<small>${num(l.gasEth, 6)} ETH · net ${l.netUsd >= 0 ? "+" : ""}${usd(l.netUsd)}</small></div></div>
    </div>
    <div class="res" id="lres-${l.id}"></div></div>`;
}

// ------------------------------------------------------------------ actions

function res(id, html, bad) { const el = document.getElementById(`lres-${id}`); if (el) { el.innerHTML = html; el.className = "res" + (bad ? " bad" : ""); } }
const fail = (e) => rejected(e) ? "Rejected in the wallet — nothing happened." : esc(e?.message ?? e);

async function act(kind, l, btn, opts) {
  if (!l) return;
  if (kind === "pnl") return pnlCard(l);
  if (kind === "add") return addDialog(l, opts);
  if (kind === "partial") return partialDialog(l, opts);
  btn.disabled = true;
  try {
    const c = await api(`/api/pools/${kind}?id=${l.id}`);
    res(l.id, "Confirm in your wallet…");
    const r = await wallet.send(c, (h) => res(l.id, `${kind === "close" ? "Closing" : "Claiming"} ${txLink(h)}…`));
    res(l.id, `${kind === "close" ? "Closed" : "Claimed"} · ${txLink(r.hash)}`);
    setTimeout(() => opts.onChange?.(), 1200);
  } catch (e) { res(l.id, fail(e), true); btn.disabled = false; }
}

async function closeAll(ids, btn, opts) {
  if (!ids.length) return;
  btn.disabled = true;
  try {
    const c = await api(`/api/pools/close-many?ids=${ids.join(",")}`);
    res(ids[0], "Confirm in your wallet…");
    const r = await wallet.send(c, (h) => res(ids[0], `Closing ${ids.length} positions ${txLink(h)}…`));
    res(ids[0], `Closed ${ids.length} positions · ${txLink(r.hash)}`);
    setTimeout(() => opts.onChange?.(), 1200);
  } catch (e) { res(ids[0], fail(e), true); btn.disabled = false; }
}

// ------------------------------------------------------------------ dialogs

let modal;
function dialog(title, body) {
  ensureStyle();
  if (!modal) {
    modal = document.createElement("div"); modal.className = "ld-modal";
    modal.innerHTML = `<div class="ld"><div class="h"><span id="ld-title"></span><span class="x" id="ld-x">✕</span></div><div class="b" id="ld-body"></div></div>`;
    document.body.appendChild(modal);
    modal.querySelector("#ld-x").addEventListener("click", closeDialog);
    modal.addEventListener("click", (e) => { if (e.target === modal) closeDialog(); });
  }
  modal.querySelector("#ld-title").textContent = title;
  modal.querySelector("#ld-body").innerHTML = body;
  modal.classList.add("open");
  return modal.querySelector("#ld-body");
}
export function closeDialog() { modal?.classList.remove("open"); }

async function balancesOf(l) {
  try {
    const d = await api(`/api/trade/balances?address=${wallet.account}`);
    const find = (addr) => d.tokens.find((t) => t.address === (addr === "0x0bd7d308f8e1639fab988df18a8011f41eacad73" ? "eth" : addr))?.amount ?? 0;
    return { base: find(l.base.address), quote: find(l.quote.address) };
  } catch { return null; }
}

async function addDialog(l, opts) {
  let shape = "spot", plan = null, seq = 0;
  const b = dialog("Add liquidity", `
    <p><b>${esc(l.base.symbol)} / ${esc(l.quote.symbol)}</b> · ${fmtPx(l.minPrice)} – ${fmtPx(l.maxPrice)} ${esc(l.quote.symbol)} · ${l.openBins} bins</p>
    <h4>Shape of what you're adding</h4>
    <div class="shapes">${["spot", "curve", "bidask"].map((s) => `<div class="shape ${s === shape ? "on" : ""}" role="button" tabindex="0" data-s="${s}"><b>${SHAPE_NAME[s]}</b><small>${SHAPE_DESC[s]}</small></div>`).join("")}</div>
    <h4>Amount</h4>
    <div class="box"><input id="ld-base" placeholder="0.0" inputmode="decimal" /><span class="u">${esc(l.base.symbol)}</span><button id="ld-max-b">max</button></div><div class="hint" id="ld-bal-b"></div>
    <div class="box"><input id="ld-quote" placeholder="0.0" inputmode="decimal" /><span class="u">${esc(l.quote.symbol)}</span><button id="ld-max-q">max</button></div><div class="hint" id="ld-bal-q"></div>
    <h4>How it lands</h4><div class="lands" id="ld-lands">Enter an amount.</div>
    <div class="foot"><button id="ld-cancel">Cancel</button><button class="go" id="ld-go" disabled>Add liquidity</button></div><div class="res" id="ld-res"></div>`);
  const $ = (id) => b.querySelector("#" + id);
  const side = l.price <= l.minPrice ? "base" : l.price >= l.maxPrice ? "quote" : null;
  if (side === "base") { $("ld-quote").disabled = true; $("ld-bal-q").textContent = "range is above the price · not needed"; }
  if (side === "quote") { $("ld-base").disabled = true; $("ld-bal-b").textContent = "range is below the price · not needed"; }
  const bal = await balancesOf(l);
  if (bal) { if (side !== "quote") $("ld-bal-b").textContent = `balance ${num(bal.base, 6)}`; if (side !== "base") $("ld-bal-q").textContent = `balance ${num(bal.quote, 6)}`; }
  $("ld-max-b").addEventListener("click", () => { if (bal) { $("ld-base").value = bal.base; replan(); } });
  $("ld-max-q").addEventListener("click", () => { if (bal) { $("ld-quote").value = Math.max(0, bal.quote - (l.quote.symbol === "ETH" ? 0.002 : 0)); replan(); } });
  b.querySelectorAll(".shape").forEach((el) => el.addEventListener("click", () => { shape = el.dataset.s; b.querySelectorAll(".shape").forEach((x) => x.classList.toggle("on", x === el)); replan(); }));
  $("ld-base").addEventListener("input", replan); $("ld-quote").addEventListener("input", replan);
  $("ld-cancel").addEventListener("click", closeDialog);
  async function replan() {
    const my = ++seq;
    const ba = parseUnits($("ld-base").value, l.base.decimals) ?? 0n, qa = parseUnits($("ld-quote").value, l.quote.decimals) ?? 0n;
    if (ba === 0n && qa === 0n) { plan = null; $("ld-lands").textContent = "Enter an amount."; $("ld-go").disabled = true; return; }
    try {
      const p = await api(`/api/pools/plan-add?id=${l.id}&shape=${shape}&baseAmount=${ba}&quoteAmount=${qa}`);
      if (my !== seq) return;
      plan = p;
      if (!p.tx) { $("ld-lands").textContent = "Nothing lands: this range needs the other token."; $("ld-go").disabled = true; return; }
      const mx = Math.max(...p.rungs.map((r) => r.weight));
      $("ld-lands").innerHTML = `<canvas id="ld-cv" width="600" height="96"></canvas>fills <b>${p.filled}</b> of ${p.bins} bins · uses ${num(formatUnits(p.baseTotal, l.base.decimals), 6)} ${esc(l.base.symbol)} + ${num(formatUnits(p.quoteTotal, l.quote.decimals), 6)} ${esc(l.quote.symbol)}${p.tx.approve ? " · needs an approval first" : ""}`;
      const cv = $("ld-cv"), ctx = cv.getContext("2d"), W = cv.width, H = cv.height;
      p.rungs.slice().sort((x, y) => x.priceLower - y.priceLower).forEach((r, i) => { const w = W / p.rungs.length, h = (r.weight / mx) * (H - 4); ctx.fillStyle = r.side === "both" ? "#ff6414" : "rgba(255,100,20,.5)"; ctx.fillRect(i * w + 2, H - h, w - 4, h); });
      $("ld-go").disabled = false;
    } catch (e) { if (my === seq) { $("ld-lands").textContent = e.message; $("ld-go").disabled = true; } }
  }
  $("ld-go").addEventListener("click", async () => {
    if (!plan?.tx) return;
    $("ld-go").disabled = true;
    const r = $("ld-res");
    try {
      if (plan.tx.approve) { r.textContent = `Approve ${esc(l.base.symbol)} in your wallet…`; await wallet.ensureAllowance(plan.tx.approve.token, plan.tx.approve.spender, plan.tx.approve.amount, (h) => { r.innerHTML = `Approving ${txLink(h)}…`; }); }
      await replan();
      r.textContent = "Confirm in your wallet…";
      const rec = await wallet.send(plan.tx, (h) => { r.innerHTML = `Adding ${txLink(h)}…`; });
      r.innerHTML = `Added · ${txLink(rec.hash)}`;
      setTimeout(() => { closeDialog(); opts.onChange?.(); }, 900);
    } catch (e) { r.innerHTML = fail(e); r.className = "res bad"; $("ld-go").disabled = false; }
  });
}

async function partialDialog(l, opts) {
  const open = l.bins.filter((b) => b.open).sort((a, b) => b.priceLower - a.priceLower);
  const b = dialog("Withdraw part of this position", `
    <p>This position is ${l.openBins} bins. Take any of them out and the rest stay open and keep earning. Whatever you take comes out with its fees, and the bins you leave keep theirs.</p>
    <div style="display:flex;justify-content:flex-end"><button id="ld-clear" style="font:inherit;font-size:11px;background:none;border:none;color:var(--accent);cursor:pointer">clear</button></div>
    ${open.map((bn) => `<label class="binrow"><input type="checkbox" data-i="${bn.index}" /><span class="r">${fmtPx(bn.priceLower)} – ${fmtPx(bn.priceUpper)} ${esc(l.quote.symbol)}<small>${l.quote.usdPerToken ? `${usd(bn.priceLower * l.quote.usdPerToken)} – ${usd(bn.priceUpper * l.quote.usdPerToken)}` : ""}${bn.inRange ? " · at the price" : ""}</small></span><span class="a">${bn.side === "both" ? "both" : bn.side === (l.base.isToken0 ? "token0" : "token1") ? `all ${esc(l.base.symbol)}` : `all ${esc(l.quote.symbol)}`}<small>${usd(bn.usd, 2)} · ${bn.side === (l.base.isToken0 ? "token0" : "token1") ? fmtBase(l, bn.amount0, bn.amount1, 5) : fmtQuote(l, bn.amount0, bn.amount1, 6)}</small></span></label>`).join("")}
    <div class="foot"><button id="ld-cancel">Cancel</button><button class="go" id="ld-go" disabled>Partial withdraw</button></div><div class="res" id="ld-res"></div>`);
  const $ = (id) => b.querySelector("#" + id);
  const chosen = () => [...b.querySelectorAll("input[type=checkbox]:checked")].map((x) => x.dataset.i);
  const sync = () => { const n = chosen().length; $("ld-go").disabled = n === 0 || n >= open.length; $("ld-go").textContent = n >= open.length ? "That is everything — use Close" : n ? `Withdraw ${n} bin${n > 1 ? "s" : ""}` : "Partial withdraw"; };
  b.querySelectorAll("input[type=checkbox]").forEach((c) => c.addEventListener("change", sync));
  $("ld-clear").addEventListener("click", () => { b.querySelectorAll("input[type=checkbox]").forEach((c) => (c.checked = false)); sync(); });
  $("ld-cancel").addEventListener("click", closeDialog);
  $("ld-go").addEventListener("click", async () => {
    const idx = chosen(); if (!idx.length) return;
    $("ld-go").disabled = true;
    const r = $("ld-res");
    try {
      const c = await api(`/api/pools/close-bins?id=${l.id}&indices=${idx.join(",")}`);
      r.textContent = "Confirm in your wallet…";
      const rec = await wallet.send(c, (h) => { r.innerHTML = `Withdrawing ${txLink(h)}…`; });
      r.innerHTML = `Withdrawn · ${txLink(rec.hash)}`;
      setTimeout(() => { closeDialog(); opts.onChange?.(); }, 900);
    } catch (e) { r.innerHTML = fail(e); r.className = "res bad"; sync(); }
  });
}

// ------------------------------------------------------------------ PnL card

export async function pnlCard(l) {
  const b = dialog("PnL card", `<canvas class="pnl" id="ld-pnl" width="1200" height="630"></canvas><div class="foot" style="justify-content:flex-start"><button id="ld-copy">Copy image</button><button id="ld-dl">Download image</button><span class="res" id="ld-res" style="align-self:center"></span></div>`);
  const cv = b.querySelector("#ld-pnl"), ctx = cv.getContext("2d"), W = cv.width, H = cv.height;
  // Background
  ctx.fillStyle = "#1d1616"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(255,255,255,.04)"; for (let x = 0; x < W; x += 40) for (let y = 0; y < H; y += 40) ctx.fillRect(x, y, 1, 1);
  const mono = "'Fira Code', ui-monospace, Menlo, monospace", disp = "'Funnel Display', Inter, sans-serif";
  ctx.fillStyle = "#fff"; ctx.font = `700 54px ${disp}`; ctx.fillText(`${l.base.symbol} / ${l.quote.symbol}`, 60, 110);
  const sub = `V3 · ${(l.fee / 1e4).toFixed(2)}% · ${l.binCount} bins · ${(SHAPE_NAME[l.shape] ?? l.shape).toLowerCase()}`;
  ctx.fillStyle = "#a39d94"; ctx.font = `18px ${mono}`; ctx.fillText(sub, 60, 145);
  ctx.fillStyle = "#ff6414"; ctx.font = `700 14px ${mono}`; ctx.fillText(l.closed ? "CLOSED" : "LIVE", 60 + ctx.measureText(sub).width * (18 / 14) + 18, 145);
  const pos = l.pnlUsd >= 0, col = pos ? "#3ddc97" : "#ff6b5b";
  ctx.fillStyle = col; ctx.font = `700 120px ${disp}`; ctx.fillText(`${pos ? "+" : "-"}${Math.abs((l.pnlPct ?? 0) * 100).toFixed(2)}%`, 60, 300);
  ctx.font = `600 36px ${mono}`; ctx.fillText(`${pos ? "▲ +" : "▼ -"}${usd(Math.abs(l.pnlUsd))}`, 64, 355);
  // Mini range chart: bins as bars, current price marker.
  const cx = 700, cy = 80, cw = 440, ch = 300;
  ctx.fillStyle = "#120f0f"; ctx.fillRect(cx, cy, cw, ch);
  const bins = l.bins.slice().sort((a, b) => a.priceLower - b.priceLower);
  const mx = Math.max(...bins.map((b) => b.usd), 1e-9), bw = cw / bins.length;
  bins.forEach((b, i) => { const h = b.open ? Math.max(6, (b.usd / mx) * (ch - 40)) : 6; ctx.fillStyle = b.open ? (b.inRange ? "#ff6414" : "rgba(255,100,20,.55)") : "rgba(255,255,255,.12)"; ctx.fillRect(cx + i * bw + 3, cy + ch - 20 - h, bw - 6, h); });
  const f = Math.min(1, Math.max(0, (Math.log(l.price) - Math.log(l.minPrice)) / (Math.log(l.maxPrice) - Math.log(l.minPrice) || 1)));
  ctx.fillStyle = "#fff"; ctx.fillRect(cx + f * cw - 1, cy + 10, 2, ch - 30);
  ctx.fillStyle = "#a39d94"; ctx.font = `13px ${mono}`; ctx.textAlign = "center"; ctx.fillText("PRICE", cx + f * cw, cy + ch - 4); ctx.textAlign = "left";
  // Facts
  const row = (k, v, x, y) => { ctx.fillStyle = "#6f6a62"; ctx.font = `12px ${mono}`; ctx.fillText(k.toUpperCase(), x, y); ctx.fillStyle = "#fff"; ctx.font = `600 22px ${mono}`; ctx.fillText(v, x, y + 30); };
  row("Deposited", usd(l.depositedUsd), 60, 450); row("Returned", usd(l.returnedUsd), 330, 450); row("Range", `${l.quote.usdPerToken ? usd(l.minPrice * l.quote.usdPerToken) : fmtPx(l.minPrice)} – ${l.quote.usdPerToken ? usd(l.maxPrice * l.quote.usdPerToken) : fmtPx(l.maxPrice)}`, 600, 450);
  const dt = (t) => new Date(t * 1000).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  row("Opened", dt(l.openedAt), 60, 540); row("Closed", l.closedAt ? dt(l.closedAt) : "still open", 330, 540); row("Gas paid", usd(l.gasUsd), 600, 540);
  ctx.fillStyle = "#ff6414"; ctx.font = `700 22px ${disp}`; ctx.fillText("ordo", 1000, 590); ctx.fillStyle = "#fff"; ctx.fillText("app", 1053, 590);
  ctx.fillStyle = "#6f6a62"; ctx.font = `12px ${mono}`; ctx.fillText("app.ordofi.network/pools", 900, 610);
  const blob = () => new Promise((r) => cv.toBlob(r, "image/png"));
  b.querySelector("#ld-copy").addEventListener("click", async () => { try { await navigator.clipboard.write([new ClipboardItem({ "image/png": await blob() })]); b.querySelector("#ld-res").textContent = "copied"; } catch (e) { b.querySelector("#ld-res").textContent = e.message; } });
  b.querySelector("#ld-dl").addEventListener("click", async () => { const a = document.createElement("a"); a.href = URL.createObjectURL(await blob()); a.download = `ordofi-${l.base.symbol}-${l.id}.png`; a.click(); });
}
