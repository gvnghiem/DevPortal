/* sql-ui.js — SQL playground view for DevPortal (window.SQLUI, same contract as TFUI/ANUI/SHUI).
 * The database engine runs inside a sandboxed iframe (no network, no same-origin access) and only talks to
 * this page through postMessage. Engine files are fetched here and handed over as data, so a runaway
 * query can be killed by simply removing the iframe. Each dialect is one entry in ENGINES. */
(function () {
"use strict";
const CDN = {
  sqlite: { js: ["https://cdn.jsdelivr.net/npm/sql.js@1.12.0/dist/sql-wasm.js", "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.12.0/sql-wasm.js", "https://unpkg.com/sql.js@1.12.0/dist/sql-wasm.js"],
            sha384: { js: "1fHJox8K973mCCD3PTAOc0ljrAGXD2VeK8zf+vNIdx55pWPULNlpxKMkU8bF4nUd", wasm: "R/MwdqDq6/VfWyY+p8u2RAFr+3gVOgzxeJqDeDxCnpQaVqOc9tEFLu4wdQfoDpb5" },
            wasm: ["https://cdn.jsdelivr.net/npm/sql.js@1.12.0/dist/sql-wasm.wasm", "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.12.0/sql-wasm.wasm", "https://unpkg.com/sql.js@1.12.0/dist/sql-wasm.wasm"] }
};
const ROW_LIMIT = 500, QUERY_TIMEOUT = 15000;

/* ── engine code that runs INSIDE the sandboxed iframe (serialised with toString) ── */
function sqliteEngine() {
  var SQL = null, db = null;
  function reply(id, body) { parent.postMessage(Object.assign({ sqlr: true, id: id }, body), "*"); }
  function open() { if (db) db.close(); db = new SQL.Database(); }
  function cell(v) { return v instanceof Uint8Array ? "<blob " + v.length + " bytes>" : v; }
  function run(sql, fresh, limit) {
    if (fresh || !db) open();
    var out = [], t0 = performance.now();
    try {
      var it = db.iterateStatements(sql);
      for (var st of it) {
        var text = st.getSQL().replace(/^(\s*--[^\n]*\n)+/, "").trim(), cols = st.getColumnNames(), rows = [], cut = false;
        if (cols.length) { while (st.step()) { if (rows.length >= limit) { cut = true; break; } rows.push(st.get().map(cell)); } }
        else st.step();
        var kind = (text.match(/^\s*(?:--[^\n]*\n\s*)*(\w+)/) || [, ""])[1].toUpperCase();
        out.push({ sql: text, cols: cols, rows: rows, cut: cut, modified: /^(INSERT|UPDATE|DELETE|REPLACE)$/.test(kind) ? db.getRowsModified() : null, kind: kind });
      }
    } catch (e) { out.push({ err: String(e.message || e) }); }
    return { results: out, ms: Math.round(performance.now() - t0) };
  }
  function schema() {
    var items = [];
    [["main", "sqlite_master"], ["temp", "sqlite_temp_master"]].forEach(function (p) {
      var r = db.exec("select type, name from " + p[1] + " where type in ('table','view') and name not like 'sqlite_%' order by name");
      (r[0] ? r[0].values : []).forEach(function (row) {
        var cols = db.exec("pragma " + (p[0] === "temp" ? "temp." : "") + "table_info(\"" + String(row[1]).replace(/"/g, '""') + "\")");
        items.push({ name: row[1], kind: row[0], temp: p[0] === "temp", cols: (cols[0] ? cols[0].values : []).map(function (c) { return { n: c[1], t: c[2], pk: !!c[5] }; }) });
      });
    });
    return items;
  }
  window.addEventListener("message", function (e) {
    var m = e.data; if (e.source !== parent || !m || !m.sqlq) return;
    (async function () {
      try {
        if (m.t === "init") {
          var mod = { exports: {} };
          new Function("module", "exports", m.js)(mod, mod.exports);
          SQL = await mod.exports({ wasmBinary: new Uint8Array(m.wasm) });
          open(); reply(m.id, { ok: true, version: db.exec("select sqlite_version()")[0].values[0][0] });
        } else if (m.t === "run") { var r = run(m.sql, m.fresh, m.limit); r.schema = schema(); reply(m.id, r); }
        else if (m.t === "schema") reply(m.id, { schema: db ? schema() : [] });
        else if (m.t === "reset") { open(); reply(m.id, { ok: true }); }
      } catch (err) { reply(m.id, { fatal: String(err.message || err) }); }
    })();
  });
}
const ENGINES = {
  sqlite: { label: "SQLite", note: "SQLite 3 (sql.js)", fn: sqliteEngine, libs: true }
};

/* ── view ── */
const css = document.createElement("style");
css.textContent = `
#sqView{display:none;flex-direction:column;background:var(--pbg);color:var(--text);font-size:12.5px;overflow:hidden}
#sqView.on{display:flex}
#sqView .sqbar{display:flex;gap:7px;align-items:center;flex-wrap:wrap;padding:7px 10px;border-bottom:1px solid var(--line);background:var(--panel)}
#sqView .sqbar button,#sqView .sqbar select{padding:4px 10px;border-radius:7px;border:1px solid var(--line);background:transparent;color:var(--text);cursor:pointer;font:inherit}
#sqView .sqbar button.go{background:var(--accent);border-color:var(--accent);color:var(--accent-text)}
#sqView .sqbar button:disabled{opacity:.45;cursor:default}
#sqView .sqbar label{display:flex;gap:5px;align-items:center;color:var(--muted);font-size:12px}
#sqView .sp{flex:1}
#sqView .sqchip{font-size:11px;padding:2px 9px;border-radius:99px;border:1px solid var(--line);color:var(--muted)}
#sqView .sqchip[data-s=ok]{color:var(--ok);border-color:var(--ok)}#sqView .sqchip[data-s=err]{color:var(--err);border-color:var(--err)}#sqView .sqchip[data-s=run]{color:var(--accent);border-color:var(--accent)}
#sqBody{flex:1;min-height:0;display:flex}
#sqSide{width:190px;flex:none;overflow:auto;border-right:1px solid var(--line);padding:8px;font-size:12px;background:var(--panel)}
#sqSide h4{margin:0 0 6px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
#sqSide .t{margin-bottom:8px}#sqSide .t b{display:block;cursor:pointer}#sqSide .t b i{font-style:normal;font-size:10px;color:var(--accent);margin-left:4px}
#sqSide .c{padding-left:10px;color:var(--muted);font:11px ui-monospace,Menlo,monospace;white-space:nowrap}#sqSide .c u{text-decoration:none;color:var(--warn)}
#sqMain{flex:1;min-width:0;display:flex;flex-direction:column}
#sqOut{flex:1;overflow:auto;padding:10px 12px}
.sqres{margin-bottom:14px}
.sqres .q{font:11.5px ui-monospace,Menlo,monospace;color:var(--muted);white-space:pre-wrap;word-break:break-word;max-height:3.6em;overflow:hidden;margin-bottom:4px}
.sqres .msg{font-size:12px}.sqres .msg.ok{color:var(--ok)}.sqres .msg.err{color:var(--err);white-space:pre-wrap}
.sqres .tw{overflow:auto;max-height:340px;border:1px solid var(--line);border-radius:8px}
.sqres table{border-collapse:collapse;font:12px ui-monospace,Menlo,monospace;min-width:100%}
.sqres th{position:sticky;top:0;background:var(--panel);text-align:left;padding:4px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
.sqres td{padding:3px 10px;border-bottom:1px solid color-mix(in srgb,var(--line) 50%,transparent);white-space:pre}
.sqres td.n{text-align:right;color:var(--accent)}.sqres td.z{color:var(--muted);font-style:italic}
.sqres .foot{font-size:11px;color:var(--muted);margin-top:3px}
#sqAd{display:flex;gap:6px;align-items:center;padding:6px 10px;border-top:1px solid var(--line);background:var(--panel)}
#sqAd input{flex:1;background:transparent;color:var(--text);border:0;outline:0;font:12.5px ui-monospace,Menlo,monospace}
#sqEmpty{color:var(--muted);padding:24px;text-align:center;line-height:1.7}
`;
document.head.appendChild(css);

let api = null, view, els = {}, frame = null, ready = null, seq = 0, pending = new Map(), busy = false, token = 0;
let dialect = (function () { try { const d = localStorage.getItem("devportal.sql.dialect"); return ENGINES[d] ? d : "sqlite"; } catch (e) { return "sqlite"; } })();
const libCache = {};
const esc = x => String(x).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function sha384(buf) {
  if (!(window.crypto && crypto.subtle)) throw new Error("the integrity check needs a secure page (https, localhost or file://)");
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-384", buf)))); }
/* every downloaded engine file is checked against a pinned SHA-384 before it is ever executed */
async function fetchFirst(urls, kind, expect) {
  let last;
  for (const u of urls) {
    try {
      const r = await fetch(u); if (!r.ok) { last = new Error("HTTP " + r.status); continue; }
      const buf = await r.arrayBuffer();
      if (await sha384(buf) !== expect) { last = new Error("integrity check failed for " + u); continue; }
      return kind === "buf" ? buf : new TextDecoder().decode(buf);
    } catch (e) { last = e; }
  }
  throw new Error("couldn't download the database engine (" + (last && last.message) + ") — SQL needs internet access the first time");
}
async function engineLibs(d) {
  if (!libCache[d]) { const c = CDN[d]; libCache[d] = Promise.all([fetchFirst(c.js, "text", c.sha384.js), fetchFirst(c.wasm, "buf", c.sha384.wasm)]).catch(e => { delete libCache[d]; throw e; }); }
  return libCache[d];
}
function killEngine(why) {
  if (frame) { frame.remove(); frame = null; }
  ready = null;
  pending.forEach(p => p.reject(new Error(why || "engine stopped"))); pending.clear();
}
function post(msg, transfer) {
  return new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject });
    frame.contentWindow.postMessage(Object.assign({ sqlq: true, id }, msg), "*", transfer || []);
  });
}
window.addEventListener("message", e => {
  const d = e.data;
  if (!d || !d.sqlr || !frame || e.source !== frame.contentWindow) return;
  const p = pending.get(d.id); if (!p) return; pending.delete(d.id);
  d.fatal ? p.reject(new Error(d.fatal)) : p.resolve(d);
});
function startEngine() {
  if (ready) return ready;
  const mine = ready = (async () => {
    status("loading " + ENGINES[dialect].label + "…", "run");
    const [js, wasm] = await engineLibs(dialect);
    if (ready !== mine) throw new Error("engine stopped");
    frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");       // no same-origin, no forms, no popups: pure compute
    frame.style.display = "none";
    const loaded = new Promise(r => { frame.onload = r; });
    frame.srcdoc = "<!DOCTYPE html><meta charset=utf-8><script>(" + ENGINES[dialect].fn.toString() + ")();<\/script>";
    view.appendChild(frame); await loaded;
    const info = await post({ t: "init", js, wasm }, []);
    return info;
  })();
  ready.catch(() => { if (ready === mine) ready = null; });
  return ready;
}
async function ask(msg) {
  await startEngine();
  const timer = setTimeout(() => killEngine("Query ran longer than " + QUERY_TIMEOUT / 1000 + " s, so the engine was stopped and the database reset."), QUERY_TIMEOUT);
  try { return await post(msg); } finally { clearTimeout(timer); }
}

function status(t, s) { els.status.textContent = t; els.status.dataset.s = s || "idle"; }
function setBusy(b) { busy = b; view.querySelectorAll(".sqbar button[data-c]").forEach(x => { x.disabled = b && x.dataset.c !== "stop"; }); }

function cellHtml(v) {
  if (v === null) return '<td class="z">NULL</td>';
  if (typeof v === "number") return '<td class="n">' + v + "</td>";
  return "<td>" + esc(v) + "</td>";
}
function renderResults(res) {
  let html = "";
  res.forEach(r => {
    if (r.err) { html += '<div class="sqres"><div class="msg err">✕ ' + esc(r.err) + "</div></div>"; api.addLine("error sql", r.err); return; }
    html += '<div class="sqres"><div class="q">' + esc(r.sql) + "</div>";
    if (r.cols.length) {
      html += '<div class="tw"><table><thead><tr>' + r.cols.map(c => "<th>" + esc(c) + "</th>").join("") + "</tr></thead><tbody>" + r.rows.map(row => "<tr>" + row.map(cellHtml).join("") + "</tr>").join("") + "</tbody></table></div>" +
        '<div class="foot">' + r.rows.length + (r.cut ? "+" : "") + " row" + (r.rows.length === 1 ? "" : "s") + (r.cut ? " (showing the first " + ROW_LIMIT + ")" : "") + "</div>";
      api.addLine("ok sql", r.kind + " → " + r.rows.length + " row(s)");
    } else {
      const m = r.modified !== null ? r.modified + " row(s) affected" : "OK";
      html += '<div class="msg ok">✓ ' + esc(r.kind) + " · " + m + "</div>"; api.addLine("ok sql", r.kind + " · " + m);
    }
    html += "</div>";
  });
  els.out.innerHTML = html || '<div id="sqEmpty">Nothing to run — write some SQL.</div>';
}
function renderSchema(items) {
  els.side.innerHTML = "<h4>Schema</h4>" + (items.length ? items.map(t => '<div class="t"><b data-t="' + esc(t.name) + '" title="SELECT * FROM ' + esc(t.name) + '">' + esc(t.name) + (t.temp ? "<i>temp</i>" : "") + (t.kind === "view" ? "<i>view</i>" : "") + "</b>" +
    t.cols.map(c => '<div class="c">' + (c.pk ? "<u>🔑</u> " : "") + esc(c.n) + " " + esc(c.t || "") + "</div>").join("") + "</div>").join("") : '<div style="color:var(--muted)">no tables yet</div>');
  els.side.querySelectorAll("b[data-t]").forEach(b => b.onclick = () => adhoc('SELECT * FROM "' + b.dataset.t.replace(/"/g, '""') + '" LIMIT 100;'));
}

async function execute(sql, fresh, toConsoleOnError) {
  if (busy) return; const my = ++token;
  setBusy(true); status("running", "run");
  try {
    const r = await ask({ t: "run", sql, fresh, limit: ROW_LIMIT });
    if (my !== token) return;
    renderResults(r.results);
    renderSchema(r.schema || []);
    const failed = r.results.some(x => x.err);
    status((failed ? "error" : "ok") + " · " + r.ms + " ms", failed ? "err" : "ok");
    if (failed && toConsoleOnError) api.showTab("console");
  } catch (e) {
    if (my !== token) return;
    els.out.innerHTML = '<div class="sqres"><div class="msg err">✕ ' + esc(e.message) + "</div></div>"; api.addLine("error sql", e.message); status("error", "err"); if (toConsoleOnError) api.showTab("console");
  } finally { if (my === token) setBusy(false); }
}
const runAll = () => { api.showTab("preview"); return execute(api.getCode(), els.fresh.checked, true); };
function adhoc(sql) { if (sql.trim()) execute(sql, false); }

function mount(a) {
  api = a;
  view = document.createElement("div"); view.id = "sqView";
  view.innerHTML = '<div class="sqbar"><button data-c="run" class="go" title="Run the whole script">▶ run script</button>' +
    '<select id="sqDialect" title="SQL dialect">' + Object.keys(ENGINES).map(k => '<option value="' + k + '">' + ENGINES[k].label + "</option>").join("") + "</select>" +
    '<label title="Start from an empty database on every run, so scripts are repeatable"><input type="checkbox" id="sqFresh" checked> fresh database each run</label>' +
    '<button data-c="stop">stop</button><button data-c="reset" title="Drop everything and start over">reset database</button><span class="sp"></span><span class="sqchip" id="sqStatus" data-s="idle">idle</span></div>' +
    '<div id="sqBody"><div id="sqSide"></div><div id="sqMain"><div id="sqOut"><div id="sqEmpty">Press <b>Run</b> to execute the script.<br>Temp tables, CTEs and window functions all work. Click a table on the left to browse it.</div></div>' +
    '<div id="sqAd"><span style="color:var(--muted)">sql&gt;</span><input id="sqLine" spellcheck="false" placeholder="ad-hoc query against the current database, e.g. SELECT count(*) FROM sqlite_master"></div></div></div>';
  document.getElementById("frameWrap").appendChild(view);
  els = { out: view.querySelector("#sqOut"), side: view.querySelector("#sqSide"), status: view.querySelector("#sqStatus"), fresh: view.querySelector("#sqFresh"), line: view.querySelector("#sqLine"), dialect: view.querySelector("#sqDialect") };
  els.dialect.value = dialect;
  els.dialect.onchange = () => setDialect(els.dialect.value, true);
  els.line.addEventListener("keydown", e => { if (e.key === "Enter") { const v = els.line.value; els.line.value = ""; adhoc(v); } });
  view.querySelector('[data-c="run"]').onclick = runAll;
  view.querySelector('[data-c="stop"]').onclick = () => stop();
  view.querySelector('[data-c="reset"]').onclick = () => { reset(); els.out.innerHTML = '<div id="sqEmpty">Database reset.</div>'; };
  renderSchema([]);
}
function setDialect(d, fromUser) {
  if (!ENGINES[d] || d === dialect) return;
  token++; killEngine("dialect changed"); dialect = d; els.dialect.value = d; setBusy(false);
  try { localStorage.setItem("devportal.sql.dialect", d); } catch (e) {}
  renderSchema([]); status("idle", "idle");
  if (fromUser) els.out.innerHTML = '<div id="sqEmpty">Switched to ' + esc(ENGINES[d].note) + ". Press Run.</div>";
}
function stop() { token++; killEngine("stopped"); setBusy(false); status("stopped", "idle"); renderSchema([]); els.out.insertAdjacentHTML("afterbegin", '<div class="sqres"><div class="msg err">■ stopped — the database was reset</div></div>'); }
function reset() { token++; killEngine("reset"); setBusy(false); status("idle", "idle"); renderSchema([]); }

window.SQLUI = {
  mount, runAll,
  activate() { view.classList.add("on"); },
  deactivate() { view.classList.remove("on"); token++; setBusy(false); },
  onEdit() {},
  stop, resetState: reset,
  /* examples start with "-- dialect: sqlite" so choosing one selects the matching engine */
  onExample(code) { const m = /^\s*--\s*dialect:\s*(\w+)/i.exec(code || ""); if (m && ENGINES[m[1].toLowerCase()]) setDialect(m[1].toLowerCase(), false); }
};
})();
