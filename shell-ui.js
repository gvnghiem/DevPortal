/* shell-ui.js — Shell Playground UI for DevPortal (drives ShellSim).
 * A simulated bash terminal on a throw-away virtual filesystem — it never touches your real machine.
 */
(function () {
"use strict";
const S = window.ShellSim;

const css = document.createElement("style");
css.textContent = `
#shView{display:none;flex-direction:column;background:var(--pbg);color:var(--text);font-size:12.5px;overflow:hidden}
#shView.on{display:flex}
#shView .shbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:7px 10px;border-bottom:1px solid var(--line);background:var(--panel)}
#shView .shbar button{padding:4px 10px;border-radius:7px;border:1px solid var(--line);background:transparent;color:var(--text);cursor:pointer;font:inherit}
#shView .shbar button:hover{border-color:var(--accent);color:var(--accent)}
#shView .shbar button:disabled{opacity:.45;cursor:default}
#shView .shbar label{display:flex;gap:5px;align-items:center;color:var(--muted);font-size:12px}
#shView .shbar select{background:transparent;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:2px 4px;font:inherit}
#shView .shbar .sp{flex:1}
#shView .shchip{font-size:11px;padding:2px 9px;border-radius:99px;border:1px solid var(--line);color:var(--muted)}
#shView .shchip[data-s=ok]{color:var(--ok);border-color:var(--ok)}#shView .shchip[data-s=err]{color:var(--err);border-color:var(--err)}#shView .shchip[data-s=run]{color:var(--accent);border-color:var(--accent)}
#shView .shbody{flex:1;display:flex;min-height:0}
#shTree{width:190px;flex:none;overflow:auto;border-right:1px solid var(--line);padding:6px 4px;background:var(--panel);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
#shTree h4{margin:2px 6px 6px;font:600 11px system-ui,sans-serif;letter-spacing:.06em;color:var(--muted);text-transform:uppercase}
#shTree div{padding:2px 6px;border-radius:5px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#shTree div:hover{background:color-mix(in srgb,var(--accent) 18%,transparent)}
#shTree .d{color:var(--accent)}#shTree .cur{background:color-mix(in srgb,var(--accent) 28%,transparent)}
@media (max-width:760px){#shTree{display:none}}
#shTerm{flex:1;display:flex;flex-direction:column;min-width:0;background:var(--editor)}
#shOut{flex:1;overflow:auto;padding:10px 14px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
#shOut .pr{color:var(--ok)}#shOut .pp{color:var(--accent)}#shOut .cmd{color:var(--text);font-weight:600}#shOut .er{color:var(--err)}#shOut .sys{color:var(--muted)}
#shIn{display:flex;gap:8px;align-items:center;padding:7px 14px;border-top:1px solid var(--line);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px}
#shIn .pr{color:var(--ok);white-space:nowrap}#shIn .pp{color:var(--accent)}
#shIn input{flex:1;background:transparent;border:0;outline:0;color:var(--text);font:inherit;min-width:0}
`;
document.head.appendChild(css);

let api = null, view = null, els = {}, active = false, token = 0, busy = false;
let fs = loadFS(), ses = S.newSession(fs), hist = [], hi = 0;
const FSKEY = "devportal.sh.fs";
function loadFS() { try { const j = JSON.parse(localStorage.getItem(FSKEY) || "null"); if (j && j.t === "d") return j; } catch (e) {} return S.newFS(); }
function saveFS() { try { localStorage.setItem(FSKEY, JSON.stringify(fs)); } catch (e) {} }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = x => String(x).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function promptText(cw) { cw = cw || ses.cwd; const d = cw === S.HOME ? "~" : cw.startsWith(S.HOME + "/") ? "~" + cw.slice(S.HOME.length) : cw; return { u: "user@devportal", d }; }
function promptHtml(cw) { const p = promptText(cw); return '<span class="pr">' + p.u + '</span>:<span class="pp">' + esc(p.d) + "</span>$ "; }

function mount(a) {
  api = a;
  const wrap = document.getElementById("frameWrap");
  view = document.createElement("div"); view.id = "shView";
  view.innerHTML =
    '<div class="shbar">' +
    '<button data-c="run" title="Run the script in the editor">▶ run script</button>' +
    '<button data-c="clear" title="Clear the terminal">clear</button>' +
    '<button data-c="reset" title="Restore the original virtual filesystem">reset filesystem</button>' +
    '<label title="Start every run from the original files, so examples always behave the same"><input type="checkbox" id="shFresh" checked> fresh files each run</label>' +
    '<label><input type="checkbox" id="shEcho" checked> show commands</label>' +
    '<label>speed <select id="shSpeed"><option value="60">slow</option><option value="20" selected>normal</option><option value="4">fast</option><option value="0">instant</option></select></label>' +
    '<span class="sp"></span><span class="shchip" id="shStatus" data-s="idle">idle</span></div>' +
    '<div class="shbody"><div id="shTree"></div><div id="shTerm"><div id="shOut"></div>' +
    '<div id="shIn"><span id="shPrompt"></span><input id="shInput" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="type a command, e.g. ls -l  (↑ for history)"></div></div></div>';
  wrap.appendChild(view);
  ["shTree", "shOut", "shPrompt", "shInput", "shStatus", "shFresh", "shEcho", "shSpeed"].forEach(i => els[i] = document.getElementById(i));
  view.querySelectorAll(".shbar button[data-c]").forEach(b => b.onclick = () => { const c = b.dataset.c; if (c === "run") { api.showTab("preview"); runAll(); } else if (c === "clear") clearTerm(); else if (c === "reset") reset(true); });
  els.shInput.addEventListener("keydown", e => {
    if (e.key === "Enter") { const v = els.shInput.value; els.shInput.value = ""; if (v.trim()) { hist.push(v); hi = hist.length; } interactive(v); }
    else if (e.key === "ArrowUp") { if (hi > 0) els.shInput.value = hist[--hi] || ""; e.preventDefault(); }
    else if (e.key === "ArrowDown") { hi = Math.min(hist.length, hi + 1); els.shInput.value = hist[hi] || ""; e.preventDefault(); }
    else if (e.key === "l" && e.ctrlKey) { clearTerm(); e.preventDefault(); }
    else if (e.key === "Tab") { e.preventDefault(); complete(); }
  });
  els.shOut.addEventListener("click", () => { if (!getSelection().toString()) els.shInput.focus(); });
  welcome(); refresh();
}

function complete() {
  const v = els.shInput.value, m = /(\S*)$/.exec(v), w = m[1], i = w.lastIndexOf("/");
  const dir = i >= 0 ? w.slice(0, i + 1) : "", base = w.slice(i + 1);
  const n = S.lookup(fs, S.normalize(dir || ".", ses.cwd)); if (!n || n.t !== "d") return;
  const c = Object.keys(n.c).filter(k => k.startsWith(base));
  if (c.length === 1) els.shInput.value = v.slice(0, v.length - w.length) + dir + c[0] + (n.c[c[0]].t === "d" ? "/" : " ");
  else if (c.length > 1) { line('<span class="sys">' + esc(c.join("  ")) + "</span>"); }
}

function status(t, s) { els.shStatus.textContent = t; els.shStatus.dataset.s = s || "idle"; }
function setBusy(b) { busy = b; view.querySelector('[data-c="run"]').disabled = b; els.shInput.disabled = b; if (!b) status("idle", "idle"); }
function scroll() { els.shOut.scrollTop = els.shOut.scrollHeight; }
function line(html) { const d = document.createElement("div"); d.innerHTML = html; els.shOut.appendChild(d); while (els.shOut.childElementCount > 1500) els.shOut.firstChild.remove(); scroll(); return d; }
function welcome() { els.shOut.innerHTML = ""; line('<span class="sys">DevPortal Shell — a simulated bash on a virtual filesystem. Nothing here touches your real machine.\nTry: ls, cat notes.txt, grep -c GET data/access.log, or press ▶ Run to execute the script on the left.</span>'); }
function clearTerm() { els.shOut.innerHTML = ""; carry = null; }

/* ANSI colours → spans */
const ANSI = { 30: "#6b7280", 31: "var(--err)", 32: "var(--ok)", 33: "var(--warn)", 34: "#60a5fa", 35: "#c084fc", 36: "#22d3ee", 37: "var(--text)" };
function ansi(text) {
  let out = "", open = false;
  text.split(/(\x1b\[[0-9;]*m)/).forEach(p => {
    const m = /^\x1b\[([0-9;]*)m$/.exec(p);
    if (!m) { out += esc(p); return; }
    if (open) { out += "</span>"; open = false; }
    const codes = m[1].split(";").map(Number); let st = "";
    codes.forEach(c => { if (ANSI[c]) st += "color:" + ANSI[c] + ";"; else if (c === 1) st += "font-weight:700;"; else if (c === 4) st += "text-decoration:underline;"; });
    if (st) { out += '<span style="' + st + '">'; open = true; }
  });
  return out + (open ? "</span>" : "");
}

/* output rendering: stdout/stderr chunks append to the current line */
let carry = null;     // {el, kind} open (unterminated) line
function putText(kind, text) {
  if (text.includes("\x1bc")) { clearTerm(); text = text.split("\x1bc").pop(); }
  const parts = text.split("\n");
  parts.forEach((seg, i) => {
    if (!carry) { if (seg === "" && i === parts.length - 1) return; carry = { el: line(""), kind }; }
    const span = document.createElement("span"); span.className = kind === "err" ? "er" : ""; span.innerHTML = ansi(seg);
    carry.el.appendChild(span);
    if (i < parts.length - 1) { if (!carry.el.textContent) carry.el.innerHTML = "&nbsp;"; carry = null; }
  });
  scroll();
}
function closeLine() { carry = null; }

/* console tab mirror (line-buffered) */
const cbuf = { out: "", err: "" };
function consoleFeed(kind, text) {
  cbuf[kind] += text;
  let i; while ((i = cbuf[kind].indexOf("\n")) >= 0) { const l = cbuf[kind].slice(0, i); cbuf[kind] = cbuf[kind].slice(i + 1); api.addLine((kind === "err" ? "error" : "log") + " sh", l.replace(/\x1b\[[0-9;]*m|\x1bc/g, "") || " "); }
}
function consoleFlush() { ["out", "err"].forEach(k => { if (cbuf[k]) { api.addLine((k === "err" ? "error" : "log") + " sh", cbuf[k].replace(/\x1b\[[0-9;]*m|\x1bc/g, "")); cbuf[k] = ""; } }); }

async function play(events, my, delay) {
  for (const ev of events) {
    if (my !== token) return false;
    if (ev.k === "cmd") {
      closeLine();
      const L = ev.text.split("\n");
      const html = L.map((l, i) => (i === 0 ? promptHtml(ev.cwd) : "&gt; ") + '<span class="cmd">' + esc(l) + "</span>").join("\n");
      line(html); api.addLine("sys sh", "$ " + L[0] + (L.length > 1 ? " …" : ""));
      if (delay) await sleep(delay * 6);
    } else {
      putText(ev.k, ev.text); consoleFeed(ev.k, ev.text);
      if (delay) await sleep(delay * Math.min(3, Math.max(1, (ev.text.match(/\n/g) || []).length)));
    }
  }
  closeLine(); consoleFlush();
  return true;
}

async function runAll() {
  if (busy) return;
  const my = ++token;
  if (els.shFresh.checked) { fs = S.newFS(); }
  ses = S.newSession(fs);
  clearTerm();
  const code = api.getCode();
  setBusy(true); status("running", "run");
  const t0 = performance.now();
  let events;
  try { events = S.run(code, ses, { echo: els.shEcho.checked, maxSteps: 80000 }); }
  catch (e) { events = [{ k: "err", text: "bash: internal error: " + e.message + "\n" }]; }
  const ok = await play(events, my, +els.shSpeed.value);
  if (my !== token) { return; }
  saveFS(); refresh();
  const st = ses.status;
  line('<span class="sys">[process exited with code ' + st + "]</span>");
  api.addLine((st === 0 ? "ok" : "error-cont") + " sh", "[process exited with code " + st + "]");
  status("exit " + st, st === 0 ? "ok" : "err"); busy = false; view.querySelector('[data-c="run"]').disabled = false; els.shInput.disabled = false;
  els.shInput.focus({ preventScroll: true });
}

function interactive(cmd) {
  if (busy) return;
  closeLine();
  line(promptHtml() + '<span class="cmd">' + esc(cmd) + "</span>");
  if (!cmd.trim()) return;
  let events;
  try { events = S.run(cmd, ses, {}); } catch (e) { events = [{ k: "err", text: "bash: internal error: " + e.message + "\n" }]; }
  events.forEach(ev => { putText(ev.k, ev.text); consoleFeed(ev.k, ev.text); });
  closeLine(); consoleFlush(); saveFS(); refresh();
  els.shPrompt.innerHTML = promptHtml();
}

function refresh() {
  els.shPrompt.innerHTML = promptHtml();
  const rows = []; S.treeLines(fs, "/home/user", "", rows, 0);
  els.shTree.innerHTML = "<h4>~ /home/user</h4>" + rows.slice(0, 200).map(r => '<div class="' + (r.dir ? "d" : "") + (ses.cwd === r.path ? " cur" : "") + '" data-p="' + esc(r.path) + '" data-d="' + (r.dir ? 1 : 0) + '" style="padding-left:' + (6 + r.depth * 12) + 'px" title="' + esc(r.path) + '">' + (r.dir ? "▸ " : "· ") + esc(r.name) + "</div>").join("");
  els.shTree.querySelectorAll("div[data-p]").forEach(d => d.onclick = () => { if (busy) return; const p = d.dataset.p; interactive(d.dataset.d === "1" ? "cd " + p : "cat " + p); els.shInput.focus(); });
}

function reset(announce) {
  token++; setBusy(false); fs = S.newFS(); ses = S.newSession(fs); saveFS(); clearTerm(); welcome(); refresh();
  if (announce) line('<span class="sys">Filesystem restored to its original state.</span>');
}

window.SHUI = {
  mount, runAll,
  activate() { active = true; view.classList.add("on"); refresh(); },
  deactivate() { active = false; view.classList.remove("on"); token++; if (busy) setBusy(false); },
  onEdit() { },
  stop() { token++; if (busy) { setBusy(false); line('<span class="sys">^C  (stopped)</span>'); status("stopped", "idle"); } },
  resetState() { reset(false); }
};
})();
