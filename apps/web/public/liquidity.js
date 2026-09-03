/**
 * The chrome shared by Pools, Stakes and Positions: the three-way rail, the
 * "search tokens & stakes" box with live results, and the platform strip
 * (positions built, fees earned by LPs, value in open positions, ETH price).
 *
 *   import { mountShell } from "/liquidity.js";
 *   mountShell(document.getElementById("lq-shell"), { page: "pools" });
 */

const CSS = `
.lq { display: grid; grid-template-columns: auto minmax(220px, 1fr) auto; gap: 12px; align-items: stretch; margin-bottom: 22px; }
.lq-rail { display: flex; border: 1px solid var(--border); background: var(--card); }
.lq-rail a { display: flex; align-items: center; gap: 8px; padding: 0 16px; font-family: var(--mono); font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); border-right: 1px solid var(--border); text-decoration: none; }
.lq-rail a:last-child { border-right: none; }
.lq-rail a svg { width: 15px; height: 15px; }
.lq-rail a.here { color: var(--text); background: #fff; font-weight: 600; }
.lq-rail a:hover { color: var(--accent); }
.lq-search { position: relative; display: flex; align-items: center; gap: 10px; border: 1px solid var(--border); background: var(--card); padding: 0 14px; }
.lq-search svg { color: var(--muted); flex: none; }
.lq-search input { flex: 1; min-width: 0; border: none; background: none; font: inherit; font-family: var(--mono); font-size: 12.5px; letter-spacing: .05em; text-transform: uppercase; outline: none; color: var(--text); padding: 13px 0; }
.lq-search input::placeholder { color: var(--muted); }
.lq-results { display: none; position: absolute; top: calc(100% + 4px); left: -1px; right: -1px; background: #fff; border: 1px solid var(--border); box-shadow: 0 12px 34px rgba(0,0,0,.09); z-index: 40; max-height: 420px; overflow: auto; }
.lq-search.open .lq-results { display: block; }
.lq-results h6 { font-family: var(--mono); font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); padding: 10px 14px 6px; margin: 0; }
.lq-results a { display: flex; align-items: center; gap: 10px; padding: 9px 14px; text-decoration: none; color: var(--text); border-top: 1px solid var(--border-light, var(--border)); }
.lq-results a:hover, .lq-results a.sel { background: var(--bg-elev); }
.lq-results .tk-ic { width: 24px; height: 24px; font-size: 10px; }
.lq-results b { font-size: 13px; }
.lq-results small { color: var(--muted); font-size: 11.5px; margin-left: 6px; }
.lq-results .r { margin-left: auto; font-family: var(--mono); font-size: 11.5px; color: var(--muted); white-space: nowrap; }
.lq-results .none, .lq-results .wait { padding: 14px; color: var(--muted); font-size: 12.5px; }

/* Token avatar: the logo when one exists, otherwise a letter on a hue the address picks. */
.tk-ic { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%; flex: none; overflow: hidden; background: hsl(var(--h) 45% 90%); color: hsl(var(--h) 40% 32%); font-family: var(--mono); font-weight: 600; font-size: 11px; letter-spacing: 0; vertical-align: middle; }
.tk-ic img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; background: #fff; }
.lq-stats { display: flex; border: 1px solid var(--border); background: var(--card); }
.lq-stats div { padding: 9px 16px; border-right: 1px solid var(--border); min-width: 118px; }
.lq-stats div:last-child { border-right: none; }
.lq-stats .k { font-family: var(--mono); font-size: 9.5px; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; white-space: nowrap; }
.lq-stats .v { font-family: var(--mono); font-size: 15px; margin-top: 2px; white-space: nowrap; }
@media (max-width: 1100px) { .lq { grid-template-columns: 1fr 1fr; } .lq-stats { grid-column: 1 / -1; overflow-x: auto; } }
@media (max-width: 640px) {
  .lq { grid-template-columns: 1fr; }
  .lq-rail a { flex: 1; justify-content: center; padding: 11px 6px; }
  /* Four figures as a 2×2 grid: nothing on a phone should scroll sideways. */
  .lq-stats { display: grid; grid-template-columns: 1fr 1fr; overflow: hidden; }
  .lq-stats div { min-width: 0; padding: 8px 12px; }
  .lq-stats div:nth-child(2n) { border-right: none; }
  .lq-stats div:nth-child(-n+2) { border-bottom: 1px solid var(--border); }
  .lq-stats .v { font-size: 14px; }
  .lq-results { max-height: 60vh; }
}

/* motion shared by the liquidity pages */
@keyframes lq-shimmer { 0% { background-position: -400px 0; } 100% { background-position: 400px 0; } }
@keyframes lq-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes lq-flash { 0% { background: rgba(255,100,20,.18); } 100% { background: transparent; } }
@keyframes lq-pulse { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.9); opacity: .35; } }
.sk { display: inline-block; height: 12px; border-radius: 3px; background: linear-gradient(90deg, rgba(0,0,0,.05) 25%, rgba(0,0,0,.10) 50%, rgba(0,0,0,.05) 75%); background-size: 800px 100%; animation: lq-shimmer 1.3s linear infinite; }
.sk.w1 { width: 34%; } .sk.w2 { width: 55%; } .sk.w3 { width: 80%; } .sk.round { width: 26px; height: 26px; border-radius: 50%; }
.rise { animation: lq-rise .32s ease-out both; }
.rise-1 { animation-delay: .03s; } .rise-2 { animation-delay: .06s; } .rise-3 { animation-delay: .09s; } .rise-4 { animation-delay: .12s; } .rise-5 { animation-delay: .15s; } .rise-6 { animation-delay: .18s; } .rise-7 { animation-delay: .21s; } .rise-8 { animation-delay: .24s; }
.flash { animation: lq-flash 1.1s ease-out; }
.spark-dot { position: absolute; width: 7px; height: 7px; border-radius: 50%; transform: translate(-50%, -50%); animation: lq-pulse 1.6s ease-in-out infinite; pointer-events: none; }
.spark-dot::after { content: ""; position: absolute; inset: 1.5px; border-radius: 50%; background: inherit; }
.lq-busy { position: relative; color: transparent !important; }
.lq-busy::after { content: ""; position: absolute; left: 50%; top: 50%; width: 16px; height: 16px; margin: -8px 0 0 -8px; border-radius: 50%; border: 2px solid rgba(255,255,255,.35); border-top-color: #fff; animation: lq-spin .7s linear infinite; }
@keyframes lq-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .rise, .flash, .spark-dot, .sk { animation: none !important; } }
`;

const ICONS = {
  pools: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 17l5-6 4 4 5-8 4 5"/></svg>`,
  stakes: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3 3 8l9 5 9-5-9-5z"/><path d="M3 12l9 5 9-5"/><path d="M3 16l9 5 9-5"/></svg>`,
  positions: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="6" width="18" height="13" rx="1"/><path d="M3 10h18M8 6V4M16 6V4"/></svg>`,
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const usd = (v, d) => v == null || !isFinite(v) ? "—" : v >= 1e9 ? "$" + (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? "$" + (v / 1e6).toFixed(2) + "M" : v >= 1e4 ? "$" + (v / 1e3).toFixed(1) + "K" : "$" + v.toLocaleString(undefined, { maximumFractionDigits: d ?? 2, minimumFractionDigits: d ?? 2 });
const int = (v) => v == null ? "—" : Number(v).toLocaleString();

let injected = false;
function inject() { if (injected) return; injected = true; const s = document.createElement("style"); s.textContent = CSS; document.head.appendChild(s); }
export function ensureMotionStyles() { inject(); }

/**
 * A token's avatar: its logo through /api/icon (fetched once by the server,
 * whatever the source), and until it arrives — or if there is none — the
 * first letter of the symbol on a colour derived from the address, so the
 * same token always looks the same. `cls` adds classes for sizing.
 */
export function tokenIcon(address, symbol, cls = "") {
  inject();
  const a = String(address ?? "").toLowerCase();
  const letter = (String(symbol ?? "?").replace(/[^A-Za-z0-9]/g, "")[0] ?? "?").toUpperCase();
  const hue = (parseInt(a.slice(2, 8), 16) || 0) % 360;
  const img = /^0x[0-9a-f]{40}$/.test(a) ? `<img src="/api/icon/${a}" alt="" loading="lazy" decoding="async" onerror="this.remove()" />` : "";
  return `<span class="tk-ic ${esc(cls)}" style="--h:${hue}" aria-hidden="true">${esc(letter)}${img}</span>`;
}

/** Placeholder table rows while a list loads: `cols` cells, the first with a round avatar. */
export function skeletonRows(rows, cols) {
  inject();
  return Array.from({ length: rows }, (_, i) => `<tr class="rise rise-${Math.min(i + 1, 8)}"><td><span class="sk round"></span> <span class="sk w2"></span></td>${Array.from({ length: cols - 1 }, () => `<td><span class="sk w${1 + ((i + cols) % 3)}"></span></td>`).join("")}</tr>`).join("");
}

/**
 * Sparkline with a soft area fill and a pulsing dot on the latest print — the
 * canvas draws the line, the dot is an element so it can animate cheaply.
 */
/**
 * Continue the current path through `pts` as a monotone cubic spline. Slopes are
 * Fritsch–Carlson, so the curve never overshoots a local high or low — a price
 * line must not draw a peak the market never printed.
 */
function curveThrough(ctx, pts) {
  const n = pts.length; if (n < 3) { for (let i = 1; i < n; i++) ctx.lineTo(pts[i][0], pts[i][1]); return; }
  const dx = [], dy = [], s = [];
  for (let i = 0; i < n - 1; i++) { dx.push(pts[i + 1][0] - pts[i][0] || 1e-9); dy.push(pts[i + 1][1] - pts[i][1]); s.push(dy[i] / dx[i]); }
  const m = [s[0]];
  for (let i = 1; i < n - 1; i++) m.push(s[i - 1] * s[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / s[i - 1] + (dx[i] + 2 * dx[i - 1]) / s[i]));
  m.push(s[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], h = dx[i] / 3;
    ctx.bezierCurveTo(x0 + h, y0 + m[i] * h, x1 - h, y1 - m[i + 1] * h, x1, y1);
  }
}

export function drawSpark(cv, closes, { lineWidth = 2.5, dot = true } = {}) {
  if (!cv || closes.length < 2) return;
  const ctx = cv.getContext("2d"), W = cv.width, H = cv.height, lo = Math.min(...closes), hi = Math.max(...closes);
  const up = closes.at(-1) >= closes[0], col = up ? "#1e9e6a" : "#c0392b";
  const pts = closes.map((v, i) => [(i / (closes.length - 1)) * W, H - 4 - ((v - lo) / (hi - lo || 1)) * (H - 8)]);
  ctx.clearRect(0, 0, W, H);
  const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, up ? "rgba(30,158,106,.22)" : "rgba(192,57,43,.22)"); g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(pts[0][0], H); ctx.lineTo(pts[0][0], pts[0][1]); curveThrough(ctx, pts); ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = col; ctx.lineWidth = lineWidth; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); curveThrough(ctx, pts); ctx.stroke();
  if (!dot) return;
  const host = cv.parentElement; if (!host) return;
  if (getComputedStyle(host).position === "static") host.style.position = "relative";
  let d = host.querySelector(":scope > .spark-dot"); if (!d) { d = document.createElement("span"); d.className = "spark-dot"; host.appendChild(d); }
  const r = cv.getBoundingClientRect(), hr = host.getBoundingClientRect();
  const [lx, ly] = pts.at(-1);
  d.style.background = col;
  d.style.left = `${r.left - hr.left + (lx / W) * r.width}px`; d.style.top = `${r.top - hr.top + (ly / H) * r.height}px`;
}

/** A button that shows a spinner while `work` runs and restores itself after. */
export async function busy(btn, work) {
  if (!btn) return work();
  const was = btn.disabled; btn.disabled = true; btn.classList.add("lq-busy");
  try { return await work(); } finally { btn.classList.remove("lq-busy"); btn.disabled = was; }
}

/** Set text and flash the element when the value actually changed. */
export function setLive(el, text) {
  if (!el || el.textContent === text) return;
  el.textContent = text; el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
}

/** Fetch JSON, tolerating a proxy or upstream that answers with plain text. */
async function api(path) {
  const r = await fetch(path, { cache: "no-store" });
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { throw new Error(`server unavailable (${r.status})`); }
  if (!r.ok || d.error) throw new Error(d.error ?? `HTTP ${r.status}`);
  return d;
}

export function mountShell(root, { page } = {}) {
  if (!root) return;
  inject();
  root.innerHTML = `
    <div class="lq">
      <nav class="lq-rail" aria-label="Liquidity">
        <a href="/pools" class="${page === "pools" ? "here" : ""}">${ICONS.pools}Pools</a>
        <a href="/stakes" class="${page === "stakes" ? "here" : ""}">${ICONS.stakes}Stakes</a>
        <a href="/positions" class="${page === "positions" ? "here" : ""}">${ICONS.positions}Positions</a>
      </nav>
      <div class="lq-search" id="lq-search">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input id="lq-q" placeholder="Search tokens & stakes" autocomplete="off" spellcheck="false" aria-label="Search tokens and stakes" />
        <div class="lq-results" id="lq-results"></div>
      </div>
      <div class="lq-stats" id="lq-stats" aria-label="Platform statistics">
        <div><div class="k">Total positions</div><div class="v">—</div></div>
        <div><div class="k">Total fees</div><div class="v">—</div></div>
        <div><div class="k">TVL</div><div class="v">—</div></div>
        <div><div class="k">ETH price</div><div class="v">—</div></div>
      </div>
    </div>`;

  const stats = root.querySelector("#lq-stats");
  const paint = (p) => {
    const v = stats.querySelectorAll(".v");
    setLive(v[0], int(p.totalPositions)); v[0].title = `${p.openPositions ?? 0} open · ${p.stakes ?? 0} stake${p.stakes === 1 ? "" : "s"}`;
    setLive(v[1], usd(p.totalFeesUsd)); v[1].title = "Fees earned by liquidity providers, valued the day they were collected";
    setLive(v[2], usd(p.tvlUsd)); v[2].title = "Value in open positions and stakes right now";
    setLive(v[3], usd(p.ethUsd, 2));
  };
  const refresh = () => api("/api/pools/platform").then(paint).catch(() => {});
  refresh(); setInterval(refresh, 60_000);

  // Search: the index comes down once (prefetched after the page settles) and
  // every keystroke is matched here, so results appear as fast as you type.
  const box = root.querySelector("#lq-search"), q = root.querySelector("#lq-q"), out = root.querySelector("#lq-results");
  // Two sizes: the tokens with a market come down after the page settles; the
  // long tail (every token with a pool) the first time someone types.
  let sel = -1, index = null;
  const loads = {};
  const low = (s) => String(s ?? "").toLowerCase();
  const loadIndex = (all = false) => loads[all] ??= api(`/api/pools/search-index${all ? "?all=1" : ""}`).then((d) => {
    if (index?.complete && !d.complete) return index;
    index = {
      complete: !!d.complete,
      tokens: d.tokens.map(([token, symbol, name, mc, vol]) => ({ token, symbol, name, mc, vol, s: low(symbol), n: low(name) })),
      stakes: (d.stakes ?? []).map(([vault, token, symbol, name, tvl, rate7d]) => ({ vault: low(vault), token, symbol, name, tvl, rate7d, s: low(symbol), n: low(name) })),
    };
    return index;
  }).catch(() => { delete loads[all]; return null; });
  const close = () => { box.classList.remove("open"); sel = -1; };
  // Exact symbol first, then symbol prefix, name prefix, then anything containing the
  // words; within a class the index's own order (volume, market cap, holders) holds.
  const rank = (x, needle) => x.s === needle ? 0 : x.s.startsWith(needle) ? 1 : x.n.startsWith(needle) ? 2 : x.s.includes(needle) || x.n.includes(needle) ? 3 : (x.token ?? "").includes(needle) || (x.vault ?? "").includes(needle) ? 4 : -1;
  const pick = (rows, needle, n) => rows.map((x) => [rank(x, needle), x]).filter(([r]) => r >= 0).sort((a, b) => a[0] - b[0]).slice(0, n).map(([, x]) => x);
  const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const render = () => {
    const raw = q.value.trim(), needle = raw.toLowerCase();
    if (!needle) { close(); return; }
    if (!index) { out.innerHTML = `<div class="wait">Loading…</div>`; box.classList.add("open"); return; }
    const tokens = pick(index.tokens, needle, 8), stakes = pick(index.stakes, needle, 5), rows = [];
    if (tokens.length) { rows.push(`<h6>Tokens</h6>`); for (const x of tokens) rows.push(`<a href="/pools/${x.token}" title="${x.token}">${tokenIcon(x.token, x.symbol)}<span><b>${esc(x.symbol)}</b><small>${esc(x.name)}</small></span><span class="r">${x.mc ? `${usd(x.mc)} MC` : short(x.token)}</span></a>`); }
    if (stakes.length) { rows.push(`<h6>Stakes</h6>`); for (const x of stakes) rows.push(`<a href="/stakes?vault=${x.vault}">${tokenIcon(x.token, x.symbol)}<span><b>${esc(x.symbol)}</b><small>stake · ${(x.rate7d * 100).toFixed(1)}% 7d</small></span><span class="r">${usd(x.tvl)} TVL</span></a>`); }
    out.innerHTML = rows.length ? rows.join("") : `<div class="none">Nothing matches “${esc(raw)}”.</div>`;
    box.classList.add("open"); sel = -1;
  };
  const rerender = () => { if (q.value.trim()) render(); };
  q.addEventListener("input", () => { render(); if (!index) loadIndex().then(rerender); if (!index?.complete) loadIndex(true).then(rerender); });
  q.addEventListener("focus", () => loadIndex(), { once: true });
  (window.requestIdleCallback ?? ((f) => setTimeout(f, 1500)))(() => loadIndex());
  q.addEventListener("keydown", (e) => {
    const links = [...out.querySelectorAll("a")];
    if (e.key === "Escape") { close(); q.blur(); }
    else if (e.key === "ArrowDown" && links.length) { e.preventDefault(); sel = (sel + 1) % links.length; links.forEach((a, i) => a.classList.toggle("sel", i === sel)); }
    else if (e.key === "ArrowUp" && links.length) { e.preventDefault(); sel = (sel - 1 + links.length) % links.length; links.forEach((a, i) => a.classList.toggle("sel", i === sel)); }
    else if (e.key === "Enter" && links.length) { e.preventDefault(); (links[Math.max(0, sel)] ?? links[0]).click(); }
  });
  q.addEventListener("focus", () => { if (q.value.trim() && out.innerHTML) box.classList.add("open"); });
  document.addEventListener("click", (e) => { if (!box.contains(e.target)) close(); });
  return { refresh };
}
