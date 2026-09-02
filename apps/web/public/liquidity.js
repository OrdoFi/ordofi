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
.lq-results .ic { width: 24px; height: 24px; border-radius: 50%; background: var(--accent-soft); color: var(--accent-dim); font-family: var(--mono); font-size: 10px; display: flex; align-items: center; justify-content: center; overflow: hidden; flex: none; }
.lq-results .ic img { width: 100%; height: 100%; object-fit: cover; }
.lq-results b { font-size: 13px; }
.lq-results small { color: var(--muted); font-size: 11.5px; margin-left: 6px; }
.lq-results .r { margin-left: auto; font-family: var(--mono); font-size: 11.5px; color: var(--muted); white-space: nowrap; }
.lq-results .none { padding: 14px; color: var(--muted); font-size: 12.5px; }
.lq-stats { display: flex; border: 1px solid var(--border); background: var(--card); }
.lq-stats div { padding: 9px 16px; border-right: 1px solid var(--border); min-width: 118px; }
.lq-stats div:last-child { border-right: none; }
.lq-stats .k { font-family: var(--mono); font-size: 9.5px; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; white-space: nowrap; }
.lq-stats .v { font-family: var(--mono); font-size: 15px; margin-top: 2px; white-space: nowrap; }
@media (max-width: 1100px) { .lq { grid-template-columns: 1fr 1fr; } .lq-stats { grid-column: 1 / -1; overflow-x: auto; } }
@media (max-width: 640px) { .lq { grid-template-columns: 1fr; } .lq-rail a { flex: 1; justify-content: center; padding: 11px 6px; } }
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
    v[0].textContent = int(p.totalPositions); v[0].title = `${p.openPositions ?? 0} open · ${p.stakes ?? 0} stake${p.stakes === 1 ? "" : "s"}`;
    v[1].textContent = usd(p.totalFeesUsd); v[1].title = "Fees earned by liquidity providers, valued the day they were collected";
    v[2].textContent = usd(p.tvlUsd); v[2].title = "Value in open positions and stakes right now";
    v[3].textContent = usd(p.ethUsd, 2);
  };
  const refresh = () => api("/api/pools/platform").then(paint).catch(() => {});
  refresh(); setInterval(refresh, 60_000);

  // Search: debounced, keyboard-navigable, tokens then stakes.
  const box = root.querySelector("#lq-search"), q = root.querySelector("#lq-q"), out = root.querySelector("#lq-results");
  let t = null, seq = 0, sel = -1;
  const close = () => { box.classList.remove("open"); sel = -1; };
  const render = (d) => {
    const rows = [];
    if (d.tokens.length) { rows.push(`<h6>Tokens</h6>`); for (const x of d.tokens) rows.push(`<a href="/pools/${x.token}"><div class="ic" data-i="${esc((x.symbol ?? "?").slice(0, 2))}">${x.icon ? `<img src="${esc(x.icon)}" alt="" referrerpolicy="no-referrer" onerror="this.parentElement.textContent=this.parentElement.dataset.i" />` : esc((x.symbol ?? "?").slice(0, 2))}</div><span><b>${esc(x.symbol)}</b><small>${esc(x.name ?? "")}</small></span><span class="r">${usd(x.marketCapUsd)} MC</span></a>`); }
    if (d.stakes.length) { rows.push(`<h6>Stakes</h6>`); for (const x of d.stakes) rows.push(`<a href="/stakes?vault=${x.vault}"><div class="ic" data-i="${esc((x.symbol ?? "?").slice(0, 2))}">${x.icon ? `<img src="${esc(x.icon)}" alt="" referrerpolicy="no-referrer" onerror="this.parentElement.textContent=this.parentElement.dataset.i" />` : esc((x.symbol ?? "?").slice(0, 2))}</div><span><b>${esc(x.symbol)}</b><small>stake · ${(x.rate7d * 100).toFixed(1)}% 7d</small></span><span class="r">${usd(x.tvlUsd)} TVL</span></a>`); }
    out.innerHTML = rows.length ? rows.join("") : `<div class="none">Nothing matches “${esc(q.value.trim())}”.</div>`;
    box.classList.add("open"); sel = -1;
  };
  q.addEventListener("input", () => {
    clearTimeout(t);
    const v = q.value.trim();
    if (!v) { close(); return; }
    t = setTimeout(async () => { const my = ++seq; try { const d = await api(`/api/pools/search?q=${encodeURIComponent(v)}`); if (my === seq) render(d); } catch { /* quiet */ } }, 160);
  });
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
