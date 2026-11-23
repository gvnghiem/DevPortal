// A live stock-market dashboard with simulated prices. Pick a ticker to see its chart.
// (Prices are a random walk — pure fiction, great for practice.)

interface Stock { sym: string; name: string; price: number; open: number; hist: number[]; vol: number }
const mk = (sym: string, name: string, p: number, vol: number): Stock => ({ sym, name, price: p, open: p, vol, hist: Array.from({ length: 60 }, () => p) });
const stocks: Stock[] = [
  mk("NVDA", "Nvidia Corp", 912.4, 0.012), mk("AAPL", "Apple Inc", 189.3, 0.006), mk("MSFT", "Microsoft", 421.8, 0.006),
  mk("TSLA", "Tesla Inc", 176.2, 0.014), mk("AMZN", "Amazon.com", 183.5, 0.008), mk("GOOG", "Alphabet", 164.9, 0.007),
  mk("META", "Meta Platforms", 502.6, 0.009), mk("NFLX", "Netflix", 611.0, 0.01),
];
const indices = [{ n: "S&P 500", v: 5234.2, o: 5234.2 }, { n: "NASDAQ", v: 16410.5, o: 16410.5 }, { n: "DOW", v: 39127.1, o: 39127.1 }];
let sel = "NVDA"; let paused = false; let tick = 0;

const app = document.getElementById("app")!;
app.style.pointerEvents = "auto";
const css = `
.mk{font:14px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;background:#0b0f14;color:#dbe2ea;min-height:100%;padding:16px}
.mk h1{font-size:18px;margin:0;display:flex;align-items:center;gap:10px}.dot{width:9px;height:9px;border-radius:50%;background:#22c55e;box-shadow:0 0 10px #22c55e;animation:p 1.2s infinite}
@keyframes p{50%{opacity:.3}}
.mk .top{display:flex;gap:12px;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap}
.idx{display:flex;gap:10px;flex-wrap:wrap}.idx div{background:#121922;border:1px solid #1e2935;border-radius:10px;padding:8px 14px;min-width:130px}
.idx small{color:#7d8a99;display:block}
.up{color:#22c55e}.dn{color:#ef4444}
.cols{display:grid;grid-template-columns:minmax(300px,1.1fr) 1.4fr;gap:14px}
@media(max-width:820px){.cols{grid-template-columns:1fr}}
.card{background:#121922;border:1px solid #1e2935;border-radius:12px;overflow:hidden}
table{width:100%;border-collapse:collapse}th{font-weight:600;color:#7d8a99;font-size:12px;text-align:right;padding:9px 12px;border-bottom:1px solid #1e2935}
th:first-child,td:first-child{text-align:left}td{padding:9px 12px;text-align:right;border-bottom:1px solid #18212c;font-variant-numeric:tabular-nums}
tr.row{cursor:pointer}tr.row:hover{background:#17212d}tr.sel{background:#1b2838!important}
td b{display:block;color:#fff}td small{color:#7d8a99}
.chart{padding:14px}.chart .big{font-size:32px;font-weight:700;font-variant-numeric:tabular-nums}
.chart .sub{color:#7d8a99;margin-bottom:8px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:10px}.stats div{background:#0e141b;border-radius:8px;padding:8px 10px}.stats small{color:#7d8a99;display:block}
button{background:#1b2838;color:#dbe2ea;border:1px solid #2a3a4e;border-radius:8px;padding:7px 12px;cursor:pointer}button:hover{background:#243348}
.mv{display:flex;gap:10px;margin-top:14px}.mv .card{flex:1;padding:12px}.mv h3{margin:0 0 8px;font-size:13px;color:#7d8a99}.mv div.l{display:flex;justify-content:space-between;padding:3px 0}
`;
const f2 = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (s: Stock) => ((s.price - s.open) / s.open) * 100;
const cls = (n: number) => (n >= 0 ? "up" : "dn");
const sgn = (n: number) => (n >= 0 ? "+" : "") + f2(n);

function spark(h: number[], w = 90, ht = 26): string {
  const lo = Math.min(...h), hi = Math.max(...h), rng = hi - lo || 1;
  const pts = h.map((v, i) => (i / (h.length - 1) * w).toFixed(1) + "," + (ht - ((v - lo) / rng) * (ht - 2) - 1).toFixed(1)).join(" ");
  const c = h[h.length - 1] >= h[0] ? "#22c55e" : "#ef4444";
  return `<svg width="${w}" height="${ht}"><polyline fill="none" stroke="${c}" stroke-width="1.6" points="${pts}"/></svg>`;
}
function bigChart(s: Stock): string {
  const W = 640, H = 220, lo = Math.min(...s.hist) * 0.999, hi = Math.max(...s.hist) * 1.001, rng = hi - lo || 1;
  const x = (i: number) => (i / (s.hist.length - 1)) * W, y = (v: number) => H - ((v - lo) / rng) * (H - 10) - 5;
  const line = s.hist.map((v, i) => x(i).toFixed(1) + "," + y(v).toFixed(1)).join(" ");
  const c = s.price >= s.open ? "#22c55e" : "#ef4444";
  const grid = [0, 1, 2, 3].map(i => `<line x1="0" x2="${W}" y1="${(i * H) / 3 + 1}" y2="${(i * H) / 3 + 1}" stroke="#1e2935"/>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">${grid}<polygon fill="${c}22" points="0,${H} ${line} ${W},${H}"/><polyline fill="none" stroke="${c}" stroke-width="2" points="${line}"/>
  <circle cx="${W}" cy="${y(s.price).toFixed(1)}" r="4" fill="${c}"/></svg>`;
}
function step(): void {
  tick++;
  for (const s of stocks) {
    const drift = (Math.random() - 0.495) * s.vol;
    s.price = Math.max(1, s.price * (1 + drift)); s.hist.push(s.price); if (s.hist.length > 60) s.hist.shift();
  }
  for (const i of indices) i.v *= 1 + (Math.random() - 0.495) * 0.0012;
}
function view(): void {
  const s = stocks.find(x => x.sym === sel)!;
  const sorted = [...stocks].sort((a, b) => pct(b) - pct(a));
  app.innerHTML = `<style>${css}</style><div class="mk"><div class="top"><h1><span class="dot"></span>MarketWatch <small style="color:#7d8a99;font-weight:400">simulated · tick ${tick}</small></h1>
    <div><button id="pz">${paused ? "▶ Resume" : "⏸ Pause"}</button></div></div>
    <div class="idx">${indices.map(i => { const c = ((i.v - i.o) / i.o) * 100; return `<div><small>${i.n}</small><b>${f2(i.v)}</b> <span class="${cls(c)}">${sgn(c)}%</span></div>`; }).join("")}</div>
    <div class="cols" style="margin-top:14px"><div class="card"><table><thead><tr><th>Symbol</th><th>Last</th><th>Chg %</th><th>Trend</th></tr></thead><tbody>
    ${stocks.map(t => `<tr class="row ${t.sym === sel ? "sel" : ""}" data-s="${t.sym}"><td><b>${t.sym}</b><small>${t.name}</small></td><td>${f2(t.price)}</td><td class="${cls(pct(t))}">${sgn(pct(t))}%</td><td>${spark(t.hist)}</td></tr>`).join("")}
    </tbody></table></div>
    <div class="card chart"><div><b>${s.sym}</b> <span style="color:#7d8a99">${s.name}</span></div><div class="big">$${f2(s.price)} <span class="${cls(pct(s))}" style="font-size:16px">${sgn(s.price - s.open)} (${sgn(pct(s))}%)</span></div>
    <div class="sub">Last 60 ticks</div>${bigChart(s)}
    <div class="stats"><div><small>Open</small>${f2(s.open)}</div><div><small>High</small>${f2(Math.max(...s.hist))}</div><div><small>Low</small>${f2(Math.min(...s.hist))}</div><div><small>Volatility</small>${(s.vol * 100).toFixed(1)}%</div></div></div></div>
    <div class="mv"><div class="card"><h3>TOP GAINERS</h3>${sorted.slice(0, 3).map(t => `<div class="l"><b>${t.sym}</b><span class="up">${sgn(pct(t))}%</span></div>`).join("")}</div>
    <div class="card"><h3>TOP LOSERS</h3>${sorted.slice(-3).reverse().map(t => `<div class="l"><b>${t.sym}</b><span class="dn">${sgn(pct(t))}%</span></div>`).join("")}</div></div></div>`;
  app.querySelectorAll<HTMLElement>("tr[data-s]").forEach(r => r.addEventListener("click", () => { sel = r.dataset.s!; console.log("selected", sel); view(); }));
  document.getElementById("pz")!.addEventListener("click", () => { paused = !paused; view(); });
}
for (let i = 0; i < 40; i++) step();               // warm up so charts start with some history
view();
setInterval(() => { if (!paused) { step(); view(); } }, 900);
console.log("market open — click a row to change the chart");
