// Attach to a node process that has the inspector enabled (SIGUSR1), take a
// CPU profile for N seconds, print the hottest functions by self time.
const secs = Number(process.argv[2] ?? 10);
const list = await (await fetch("http://127.0.0.1:9229/json")).json();
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
await new Promise((r) => (ws.onopen = r));
await send("Profiler.enable");
await send("Profiler.setSamplingInterval", { interval: 1000 });
await send("Profiler.start");
await new Promise((r) => setTimeout(r, secs * 1000));
const { profile } = await send("Profiler.stop");
ws.close();
const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map(); for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const total = profile.samples.length;
const self = new Map();
for (const s of profile.samples) self.set(s, (self.get(s) ?? 0) + 1);
const label = (n) => `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").slice(-2).join("/")}:${n.callFrame.lineNumber + 1}`;
console.log(`samples ${total} over ${secs}s (${(total / secs / 1000 * 100).toFixed(0)}% of one core busy)`);
console.log("--- top self time ---");
for (const [nid, c] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`${(100 * c / total).toFixed(1).padStart(5)}%  ${label(nodes.get(nid))}`);
// inclusive time: walk up from each sample
const incl = new Map();
for (const [nid, c] of self) { let cur = nid; const seen = new Set(); while (cur != null && !seen.has(cur)) { seen.add(cur); incl.set(cur, (incl.get(cur) ?? 0) + c); cur = parent.get(cur); } }
console.log("--- top inclusive (our code only) ---");
let limitLeft = 14;
for (const [nid, c] of [...incl.entries()].sort((a, b) => b[1] - a[1])) { const n = nodes.get(nid); if (!n.callFrame.url.includes("/app/") || n.callFrame.url.includes("node_modules")) continue; console.log(`${(100 * c / total).toFixed(1).padStart(5)}%  ${label(n)}`); if (--limitLeft === 0) break; }
