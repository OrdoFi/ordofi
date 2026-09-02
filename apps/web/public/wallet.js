/**
 * Shared wallet flow for the app pages: EIP-6963 discovery, a picker, a
 * small account sheet (address, balance, disconnect), silent reconnect to
 * the last wallet, and the two helpers every page needs — a JSON-RPC call
 * through rpc.ordofi.network and "send this and wait for the receipt".
 *
 * Usage:
 *   import { wallet } from "/wallet.js";
 *   await wallet.init(chain);              // chain from /api/trade/chain
 *   wallet.onChange(() => render());
 *   wallet.bindButton(document.getElementById("nav-connect"));
 *   const hash = await wallet.send({ to, data, value });
 */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LS = "ordofi.wallet";

const INSTALL = [
  { name: "MetaMask", sub: "metamask.io", url: "https://metamask.io/download" },
  { name: "Rabby", sub: "rabby.io", url: "https://rabby.io" },
  { name: "Coinbase Wallet", sub: "coinbase.com/wallet", url: "https://www.coinbase.com/wallet/downloads" },
];

const CSS = `
.wm-modal{position:fixed;inset:0;background:rgba(25,24,23,.4);display:none;align-items:flex-start;justify-content:center;padding-top:12vh;z-index:300}
.wm-modal.open{display:flex}
.wm-sheet{background:var(--card);border:1px solid var(--border);width:420px;max-width:calc(100vw - 32px)}
.wm-h{padding:14px 18px;border-bottom:1px solid var(--border);font-weight:700;display:flex;justify-content:space-between;font-family:var(--display)}
.wm-h .x{cursor:pointer;color:var(--muted);font-weight:400}
.wm-row{display:flex;align-items:center;gap:12px;padding:12px 18px;cursor:pointer;border-bottom:1px solid var(--border);color:inherit;text-decoration:none}
.wm-row:last-child{border-bottom:none}
.wm-row:hover{background:var(--bg-elev)}
.wm-ic{width:30px;height:30px;background:var(--bg-elev);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-family:var(--mono);overflow:hidden;flex:none}
.wm-ic img{width:100%;height:100%;object-fit:contain}
.wm-main{flex:1}.wm-name{font-weight:600;font-size:13.5px}.wm-sub,.wm-go{font-family:var(--mono);font-size:10px;color:var(--muted)}
.wm-note{padding:14px 18px;color:var(--muted);font-size:12.5px;line-height:1.5}
.wm-acct{padding:18px}
.wm-addr{font-family:var(--mono);font-size:13px;display:flex;justify-content:space-between;align-items:center;gap:10px}
.wm-addr button{font:inherit;font-size:11px;background:none;border:1px solid var(--border);padding:4px 8px;cursor:pointer;color:var(--text-dim)}
.wm-kv{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}
.wm-kv div{border:1px solid var(--border);padding:10px 12px}
.wm-kv .k{font-family:var(--mono);font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.wm-kv .v{font-family:var(--mono);font-size:14px;margin-top:3px}
.wm-acts{display:flex;gap:8px;margin-top:14px}
.wm-acts button,.wm-acts a{flex:1;font:inherit;font-size:12.5px;padding:9px;border:1px solid var(--border);background:#fff;cursor:pointer;text-align:center;color:var(--text-dim);text-decoration:none}
.wm-acts .danger{color:var(--danger);border-color:var(--danger)}
`;

class Wallet {
  constructor() {
    this.chain = null; this.provider = null; this.account = null; this.info = null;
    this.found = new Map(); this.listeners = new Set(); this.buttons = new Set();
    window.addEventListener("eip6963:announceProvider", (e) => {
      const d = e.detail; if (!d?.info?.rdns || !d.provider) return;
      this.found.set(d.info.rdns, d);
      if (this.modal?.classList.contains("open") && this.modalKind === "pick") this.renderPicker();
      if (!this.account) this.tryReconnect(d);
    });
    window.dispatchEvent(new Event("eip6963:requestProvider"));
  }

  async init(chain) {
    this.chain = chain;
    if (!document.getElementById("wm-style")) { const st = document.createElement("style"); st.id = "wm-style"; st.textContent = CSS; document.head.appendChild(st); }
    if (!this.modal) {
      this.modal = document.createElement("div"); this.modal.className = "wm-modal";
      this.modal.innerHTML = `<div class="wm-sheet"><div class="wm-h"><span id="wm-title">Connect a wallet</span><span class="x" id="wm-x">✕</span></div><div id="wm-body"></div></div>`;
      document.body.appendChild(this.modal);
      this.modal.querySelector("#wm-x").addEventListener("click", () => this.close());
      this.modal.addEventListener("click", (e) => { if (e.target === this.modal) this.close(); });
    }
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    // Silent reconnect: a wallet already authorised for this site answers
    // eth_accounts without a prompt.
    const last = localStorage.getItem(LS);
    if (last) { const e = this.list().find((w) => w.info.rdns === last); if (e) await this.tryReconnect(e); }
    return this;
  }

  async tryReconnect(entry) {
    if (this.account || localStorage.getItem(LS) !== entry.info.rdns) return;
    try {
      const accs = await entry.provider.request({ method: "eth_accounts" });
      if (accs?.length) { this.bind(entry); this.account = accs[0]; this.emit(); }
    } catch { /* not authorised */ }
  }

  list() {
    const out = [...this.found.values()];
    if (!out.length && window.ethereum) {
      const w = window.ethereum;
      out.push({ info: { rdns: "injected", name: w.isRabby ? "Rabby" : w.isCoinbaseWallet ? "Coinbase Wallet" : w.isMetaMask ? "MetaMask" : "Browser wallet", icon: null }, provider: w });
    }
    return out;
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const b of this.buttons) b.textContent = this.account ? short(this.account) : "Connect"; for (const fn of this.listeners) { try { fn(this.account); } catch (e) { console.error(e); } } }

  /** The nav button: opens the picker when disconnected, the account sheet when connected. */
  bindButton(el) {
    if (!el) return;
    this.buttons.add(el);
    el.textContent = this.account ? short(this.account) : "Connect";
    el.addEventListener("click", (e) => { e.preventDefault(); this.account ? this.openAccount() : this.openPicker(); });
  }

  open(kind, title) { this.modalKind = kind; this.modal.querySelector("#wm-title").textContent = title; this.modal.classList.add("open"); }
  close() { this.modal.classList.remove("open"); }

  openPicker() { window.dispatchEvent(new Event("eip6963:requestProvider")); this.open("pick", "Connect a wallet"); this.renderPicker(); }
  renderPicker() {
    const body = this.modal.querySelector("#wm-body"), found = this.list(), last = localStorage.getItem(LS);
    body.innerHTML = found.length
      ? found.map((w) => `<div class="wm-row" role="button" tabindex="0" data-r="${esc(w.info.rdns)}"><div class="wm-ic">${w.info.icon ? `<img src="${esc(w.info.icon)}" alt="" />` : esc(w.info.name[0])}</div><div class="wm-main"><div class="wm-name">${esc(w.info.name)}</div><div class="wm-sub">${w.info.rdns === last ? "last used" : "detected"}</div></div><div class="wm-go">connect ›</div></div>`).join("")
      : `<div class="wm-note">No wallet detected in this browser. Install one, then reload.</div>` + INSTALL.map((w) => `<a class="wm-row" href="${w.url}" target="_blank" rel="noopener"><div class="wm-ic">${w.name[0]}</div><div class="wm-main"><div class="wm-name">${w.name}</div><div class="wm-sub">${w.sub}</div></div><div class="wm-go">install ›</div></a>`).join("");
    body.querySelectorAll(".wm-row[data-r]").forEach((r) => r.addEventListener("click", () => { const e = this.list().find((w) => w.info.rdns === r.dataset.r); if (e) this.connectWith(e); }));
  }

  async connectWith(entry) {
    this.close();
    const accs = await entry.provider.request({ method: "eth_requestAccounts" });
    if (!accs?.length) throw new Error("no account returned");
    this.bind(entry); this.account = accs[0];
    localStorage.setItem(LS, entry.info.rdns);
    await this.ensureChain().catch(() => {});
    this.emit();
  }

  bind(entry) {
    if (this.provider?.removeListener) { this.provider.removeListener("accountsChanged", this._onAccounts); this.provider.removeListener("chainChanged", this._onChain); }
    this.provider = entry.provider; this.info = entry.info;
    this._onAccounts = (a) => { this.account = a?.[0] ?? null; if (!this.account) localStorage.removeItem(LS); this.emit(); };
    this._onChain = () => this.emit();
    this.provider.on?.("accountsChanged", this._onAccounts);
    this.provider.on?.("chainChanged", this._onChain);
  }

  async disconnect() {
    try { await this.provider?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }); } catch { /* not every wallet supports it */ }
    localStorage.removeItem(LS); this.account = null; this.close(); this.emit();
  }

  async ensureChain() {
    const c = this.chain;
    if ((await this.provider.request({ method: "eth_chainId" })) === c.idHex) return;
    try { await this.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: c.idHex }] }); }
    catch { await this.provider.request({ method: "wallet_addEthereumChain", params: [{ chainId: c.idHex, chainName: c.name + " · OrdoFi protected", rpcUrls: [c.rpc], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, blockExplorerUrls: [c.explorer] }] }); }
  }

  async openAccount() {
    this.open("acct", "Wallet");
    const body = this.modal.querySelector("#wm-body");
    body.innerHTML = `<div class="wm-acct"><div class="wm-addr"><span>${esc(this.account)}</span><button id="wm-copy">copy</button></div>
      <div class="wm-kv"><div><div class="k">Balance</div><div class="v" id="wm-bal">…</div></div><div><div class="k">Network</div><div class="v" id="wm-net">…</div></div></div>
      <div class="wm-acts"><a href="${esc(this.chain.explorer)}/address/${esc(this.account)}" target="_blank" rel="noopener">Explorer ↗</a><button id="wm-switch">Switch wallet</button><button class="danger" id="wm-dc">Disconnect</button></div></div>`;
    body.querySelector("#wm-copy").addEventListener("click", () => navigator.clipboard.writeText(this.account));
    body.querySelector("#wm-switch").addEventListener("click", () => this.openPicker());
    body.querySelector("#wm-dc").addEventListener("click", () => this.disconnect());
    try {
      const [bal, cid] = await Promise.all([this.rpc("eth_getBalance", [this.account, "latest"]), this.provider.request({ method: "eth_chainId" })]);
      body.querySelector("#wm-bal").textContent = (Number(BigInt(bal)) / 1e18).toFixed(5) + " ETH";
      body.querySelector("#wm-net").textContent = cid === this.chain.idHex ? this.chain.name : `wrong network (${parseInt(cid, 16)})`;
    } catch { /* cosmetic */ }
  }

  async rpc(method, params) {
    const r = await fetch(this.chain.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }) });
    const d = await r.json(); if (d.error) throw new Error(d.error.message); return d.result;
  }

  async waitFor(hash, seconds = 120) {
    for (let i = 0; i < seconds; i++) {
      await sleep(1000);
      const r = await this.rpc("eth_getTransactionReceipt", [hash]).catch(() => null);
      if (r) { if (r.status !== "0x1") throw new Error("transaction reverted"); return r; }
    }
    throw new Error(`not confirmed in ${seconds}s`);
  }

  /** Sign through the wallet, then wait for the block. Returns the receipt with `.hash`. */
  async send({ to, data, value }, onSent) {
    if (!this.account) throw new Error("connect a wallet first");
    await this.ensureChain();
    const tx = { from: this.account, to, data: data ?? "0x" };
    if (value && BigInt(value) > 0n) tx.value = "0x" + BigInt(value).toString(16);
    const hash = await this.provider.request({ method: "eth_sendTransaction", params: [tx] });
    onSent?.(hash);
    const rec = await this.waitFor(hash);
    rec.hash = hash;
    return rec;
  }

  /** ERC-20 allowance check + approve if short. */
  async ensureAllowance(token, spender, amount, onSent) {
    const sel = "0xdd62ed3e" + this.account.slice(2).padStart(64, "0") + spender.slice(2).padStart(64, "0");
    const cur = BigInt(await this.rpc("eth_call", [{ to: token, data: sel }, "latest"]));
    if (cur >= BigInt(amount)) return null;
    const data = "0x095ea7b3" + spender.slice(2).padStart(64, "0") + "f".repeat(64);
    return this.send({ to: token, data }, onSent);
  }
}

export const wallet = new Wallet();
export const rejected = (e) => e?.code === 4001 || /rejected|denied/i.test(e?.message ?? "");
