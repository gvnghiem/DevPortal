/* ansible-ui.js — Ansible Playground UI for DevPortal (drives AnsibleSim). */
(function () {
"use strict";
const A = window.AnsibleSim;
const css = document.createElement("style");
css.textContent = `
#anView{display:none;flex-direction:column;background:var(--pbg);color:var(--text);font-size:12.5px;overflow:hidden}
#anView.on{display:flex}
#anView .anbar{display:flex;gap:7px;align-items:center;flex-wrap:wrap;padding:7px 10px;border-bottom:1px solid var(--line);background:var(--panel)}
#anView .anbar button{padding:4px 10px;border-radius:7px;border:1px solid var(--line);background:transparent;color:var(--text);cursor:pointer;font:inherit}
#anView .anbar button:hover{border-color:var(--accent);color:var(--accent)}
#anView .anbar button.go{background:var(--accent);border-color:var(--accent);color:var(--accent-text)}
#anView .anbar button:disabled{opacity:.45;cursor:default}
#anView .anbar label{display:flex;gap:5px;align-items:center;color:var(--muted);font-size:12px}
#anView .anbar input[type=text]{width:120px;background:transparent;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:3px 6px;font:inherit}
#anView .anbar select{background:transparent;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:2px 4px;font:inherit}
#anView .anbar .sp{flex:1}
#anView .anchip{font-size:11px;padding:2px 9px;border-radius:99px;border:1px solid var(--line);color:var(--muted)}
#anView .anchip[data-s=ok]{color:var(--ok);border-color:var(--ok)}#anView .anchip[data-s=err]{color:var(--err);border-color:var(--err)}#anView .anchip[data-s=run]{color:var(--accent);border-color:var(--accent)}
#anCmd{padding:5px 12px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;border-bottom:1px solid var(--line);color:var(--muted);white-space:nowrap;overflow:auto}
#anCmd span{color:var(--text)}
#anInvWrap{display:none;border-bottom:1px solid var(--line);background:var(--editor)}
#anInvWrap.on{display:block}
#anInvWrap textarea{display:block;width:100%;height:118px;box-sizing:border-box;background:transparent;color:var(--text);border:0;outline:0;padding:8px 12px;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;resize:vertical}
#anInvWrap .h{padding:4px 12px 0;font-size:11px;color:var(--muted)}
#anStage{flex:none;max-height:46%;overflow:auto;padding:12px;display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px;align-content:start;border-bottom:1px solid var(--line)}
.anh{border:1px solid var(--line);border-radius:12px;padding:10px 12px;background:var(--panel);transition:border-color .25s,box-shadow .25s,opacity .25s;position:relative;cursor:pointer}
.anh.off{opacity:.38}
.anh .t{display:flex;justify-content:space-between;align-items:center;font-weight:600}
.anh .ip{color:var(--muted);font:11px ui-monospace,monospace}
.anh .gr{margin:4px 0 6px;display:flex;gap:4px;flex-wrap:wrap}.anh .gr i{font-style:normal;font-size:10px;padding:1px 7px;border-radius:99px;background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--accent)}
.anh .st{font-size:11.5px;min-height:16px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.anh .dots{display:flex;gap:3px;flex-wrap:wrap;margin-top:7px;min-height:9px}
.anh .dots b{width:9px;height:9px;border-radius:3px;background:var(--line)}
.anh .dots b.ok{background:var(--ok)}.anh .dots b.changed{background:var(--warn)}.anh .dots b.skipped{background:var(--muted);opacity:.5}.anh .dots b.failed,.anh .dots b.unreachable{background:var(--err)}.anh .dots b.ignored{background:var(--err);opacity:.5}
.anh[data-s=run]{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent),0 0 16px color-mix(in srgb,var(--accent) 35%,transparent)}
.anh[data-s=ok]{border-color:var(--ok)}.anh[data-s=changed]{border-color:var(--warn)}.anh[data-s=failed],.anh[data-s=unreachable]{border-color:var(--err)}
.anh .spin{display:none;width:11px;height:11px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:anspin .7s linear infinite}
.anh[data-s=run] .spin{display:inline-block}
@keyframes anspin{to{transform:rotate(360deg)}}
.anh .det{display:none;margin-top:8px;padding-top:7px;border-top:1px dashed var(--line);font:11px/1.5 ui-monospace,Menlo,monospace;color:var(--muted);white-space:pre-wrap;word-break:break-word}
.anh.open .det{display:block}
.anh .det b{color:var(--text);font-weight:600}
#anProg{display:flex;gap:10px;align-items:center;padding:5px 12px;border-bottom:1px solid var(--line);font-size:11.5px;color:var(--muted)}
#anProg .pbar{flex:1;height:5px;min-height:0;padding:0;border:0;border-radius:99px;background:var(--line);overflow:hidden;display:block;position:static}#anProg .pbar i{display:block;height:100%;width:0;background:var(--accent);transition:width .25s}
#anTask{color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:55%}
#anLog{flex:1;min-height:90px;overflow:auto;background:var(--editor);font:11.5px/1.5 ui-monospace,Menlo,Consolas,monospace;padding:6px 12px;white-space:pre}
#anLog div.ok{color:var(--ok)}#anLog div.changed{color:var(--warn)}#anLog div.skip{color:#22d3ee}#anLog div.err{color:var(--err)}#anLog div.ban{color:var(--accent);font-weight:600}#anLog div.sys{color:var(--muted)}#anLog div.rec{color:var(--text)}
`;
document.head.appendChild(css);

let api = null, view = null, els = {}, active = false, token = 0, busy = false, paused = false;
let state = loadState(), inv = null, invText = localStorage.getItem("devportal.ans.inv") || A.DEFAULT_INVENTORY;
let cur = {}; // host -> dots
const SK = "devportal.ans.state";
function loadState() { try { const j = JSON.parse(localStorage.getItem(SK) || "null"); if (j && j.hosts) return j; } catch (e) {} return A.newState(); }
function saveState() { try { localStorage.setItem(SK, JSON.stringify(state)); } catch (e) {} }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = x => String(x).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function mount(a) {
  api = a;
  const wrap = document.getElementById("frameWrap");
  view = document.createElement("div"); view.id = "anView";
  view.innerHTML =
    '<div class="anbar">' +
    '<button data-c="run" class="go" title="ansible-playbook playbook.yml">▶ run playbook</button>' +
    '<button data-c="check" title="ansible-playbook --check (dry run: nothing changes)">--check</button>' +
    '<button data-c="ping" title="ansible all -m ping">ping all</button>' +
    '<button data-c="inv" title="Show / edit the inventory">inventory</button>' +
    '<button data-c="reset" title="Throw away every host\'s simulated state (fresh servers)">reset hosts</button>' +
    '<label>tags <input type="text" id="anTags" placeholder="web,db" spellcheck="false"></label>' +
    '<label>-e <input type="text" id="anExtra" placeholder="env=prod x=1" spellcheck="false"></label>' +
    '<label>speed <select id="anSpeed"><option value="1">1×</option><option value="3" selected>3×</option><option value="10">10×</option><option value="0">instant</option></select></label>' +
    '<span class="sp"></span><span class="anchip" id="anStatus" data-s="idle">idle</span></div>' +
    '<div id="anCmd">$ ansible-playbook <span>-i inventory.ini playbook.yml</span></div>' +
    '<div id="anInvWrap"><div class="h">inventory.ini — INI format with [groups], [group:vars] and [group:children]. Edits are saved in your browser.</div><textarea id="anInv" spellcheck="false"></textarea></div>' +
    '<div id="anStage"></div>' +
    '<div id="anProg"><span id="anCount">0 / 0 tasks</span><span id="anTask">—</span><div class="pbar"><i id="anBar"></i></div></div>' +
    '<div id="anLog"></div>';
  wrap.appendChild(view);
  ["anStage", "anLog", "anCmd", "anStatus", "anTags", "anExtra", "anSpeed", "anInv", "anInvWrap", "anCount", "anTask", "anBar"].forEach(i => els[i] = document.getElementById(i));
  els.anInv.value = invText;
  els.anInv.addEventListener("input", () => { invText = els.anInv.value; try { localStorage.setItem("devportal.ans.inv", invText); } catch (e) {} drawHosts(); });
  view.querySelectorAll(".anbar button[data-c]").forEach(b => b.onclick = () => {
    const c = b.dataset.c;
    if (c === "run") { api.showTab("preview"); runAll(); } else if (c === "check") { api.showTab("preview"); runAll({ check: true }); } else if (c === "ping") { api.showTab("preview"); runAll({ adhoc: true }); }
    else if (c === "inv") els.anInvWrap.classList.toggle("on"); else if (c === "reset") reset(true);
  });
  drawHosts();
}

function status(t, s) { els.anStatus.textContent = t; els.anStatus.dataset.s = s || "idle"; }
function setBusy(b) { busy = b; view.querySelectorAll('.anbar button[data-c]').forEach(x => { if (["run", "check", "ping", "reset"].includes(x.dataset.c)) x.disabled = b; }); if (!b) status("idle", "idle"); }

function parseInv() { try { inv = A.parseInventory(invText); return inv; } catch (e) { inv = null; return null; } }
const BASE_PKGS = new Set(["openssh-server", "python3", "bash", "cron", "coreutils"]);
function detail(h) {
  const st = state.hosts[h]; if (!st) return "<b>fresh server</b>\nnothing installed yet (apart from the base system)";
  const pk = Object.keys(st.pkgs).filter(p => !BASE_PKGS.has(p)), sv = Object.keys(st.svcs).filter(s => st.svcs[s].state === "started"), us = Object.keys(st.users).filter(u => !["root", "deploy"].includes(u));
  const fl = Object.keys(st.files).filter(f => !["/etc/hostname", "/etc/os-release"].includes(f));
  return "<b>packages</b>  " + (pk.map(p => esc(p) + " " + esc(String(st.pkgs[p]).split(/[-+~]/)[0])).join(", ") || "—") + "\n<b>running</b>   " + (sv.map(esc).join(", ") || "—") + "\n<b>users</b>     " + (us.map(esc).join(", ") || "—") +
    "\n<b>files</b>     " + (fl.length ? fl.slice(0, 8).map(esc).join("\n           ") + (fl.length > 8 ? "\n           … +" + (fl.length - 8) + " more" : "") : "—") + (Object.keys(st.cron).length ? "\n<b>cron</b>      " + Object.keys(st.cron).map(esc).join(", ") : "") + (st.ufwOn ? "\n<b>firewall</b>  ufw enabled (" + st.ufw.length + " rules)" : "");
}
function drawHosts(inPlay) {
  const I = parseInv();
  if (!I) { els.anStage.innerHTML = '<div style="color:var(--err);grid-column:1/-1">Inventory has a syntax error — open “inventory” to fix it.</div>'; return; }
  const open = new Set([...els.anStage.querySelectorAll(".anh.open")].map(e => e.dataset.h));
  els.anStage.innerHTML = Object.keys(I.hosts).map(h => {
    const hv = I.hostVars(h);
    return '<div class="anh' + (open.has(h) ? " open" : "") + '" data-h="' + esc(h) + '" data-s="idle"><div class="t"><span>🖥 ' + esc(h) + '</span><span class="spin"></span></div><div class="ip">' + esc(hv.ansible_host || h) + "</div>" +
      '<div class="gr">' + I.hosts[h].groups.map(g => "<i>" + esc(g) + "</i>").join("") + '</div><div class="st">idle</div><div class="dots"></div><div class="det">' + detail(h) + "</div></div>";
  }).join("");
  els.anStage.querySelectorAll(".anh").forEach(c => c.onclick = () => c.classList.toggle("open"));
}
const card = h => els.anStage.querySelector('.anh[data-h="' + (window.CSS && CSS.escape ? CSS.escape(h) : h) + '"]');
function setCard(h, s, text) { const c = card(h); if (!c) return; c.dataset.s = s; if (text !== undefined) c.querySelector(".st").textContent = text; }
function dot(h, cls) { const c = card(h); if (!c) return; const b = document.createElement("b"); b.className = cls; c.querySelector(".dots").appendChild(b); }
function refreshDetails() { els.anStage.querySelectorAll(".anh").forEach(c => { c.querySelector(".det").innerHTML = detail(c.dataset.h); }); }

function logLine(text, cls) { const d = document.createElement("div"); d.className = cls || ""; d.textContent = text === "" ? " " : text; els.anLog.appendChild(d); while (els.anLog.childElementCount > 1200) els.anLog.firstChild.remove(); els.anLog.scrollTop = els.anLog.scrollHeight; }
function cls(line) {
  if (/^(PLAY|TASK|RUNNING HANDLER) \[/.test(line) || /^PLAY RECAP/.test(line)) return "ban";
  if (/^ok:/.test(line)) return "ok"; if (/^changed:/.test(line)) return "changed"; if (/^skipping:/.test(line)) return "skip";
  if (/^(fatal|failed):|^ERROR|UNREACHABLE/.test(line)) return "err"; if (/^\.\.\.ignoring|^\[WARNING\]/.test(line)) return "changed";
  if (/^\S+\s+: ok=/.test(line)) return "rec"; return "";
}
function emit(line) {
  const c = cls(line); logLine(line, c);
  const lv = c === "ok" ? "ok" : c === "changed" ? "warn" : c === "err" ? "error" : c === "ban" ? "info" : c === "skip" ? "sys" : "log";
  api.addLine(lv + " an", line === "" ? " " : line);
}

function parseExtra(s) { const o = {}; (s.match(/(\w+)=("[^"]*"|'[^']*'|\S+)/g) || []).forEach(kv => { const i = kv.indexOf("="); let v = kv.slice(i + 1).replace(/^(['"])(.*)\1$/, "$2"); if (/^-?\d+$/.test(v)) v = +v; else if (/^(true|yes)$/i.test(v)) v = true; else if (/^(false|no)$/i.test(v)) v = false; o[kv.slice(0, i)] = v; }); return o; }

async function runAll(opt) {
  if (busy) return; opt = opt || {};
  const my = ++token;
  els.anLog.innerHTML = ""; drawHosts(); setBusy(true); status("running", "run");
  const tags = els.anTags.value.split(",").map(s => s.trim()).filter(Boolean), extra = parseExtra(els.anExtra.value);
  const playbook = opt.adhoc ? "- name: Ping all hosts (ad-hoc)\n  hosts: all\n  gather_facts: false\n  tasks:\n    - name: ping\n      ansible.builtin.ping:\n" : api.getCode();
  els.anCmd.innerHTML = "$ ansible-playbook <span>-i inventory.ini " + (opt.adhoc ? "(ad-hoc ping)" : "playbook.yml") + (opt.check ? " --check" : "") + (tags.length ? " --tags " + tags.join(",") : "") + (els.anExtra.value.trim() ? ' -e "' + esc(els.anExtra.value.trim()) + '"' : "") + "</span>";
  api.addLine("sys an", "$ ansible-playbook -i inventory.ini " + (opt.adhoc ? "(ad-hoc ping)" : "playbook.yml") + (opt.check ? " --check" : ""));
  let res;
  try { res = A.run(playbook, invText, state, { check: !!opt.check, tags: tags.length ? tags : null, extraVars: extra }); }
  catch (e) { res = { ok: false, timeline: [{ k: "error", text: "ERROR! internal simulator error: " + e.message }], rc: 1 }; }
  const speed = +els.anSpeed.value;
  const T = res.timeline, tasksTotal = T.filter(x => x.k === "task").length; let done = 0;
  els.anCount.textContent = "0 / " + tasksTotal + " tasks"; els.anBar.style.width = "0";
  const scale = ms => speed === 0 ? 0 : Math.min(1400, ms / speed);
  for (const ev of T) {
    if (my !== token) return;
    if (ev.k === "error") { ev.text.split("\n").forEach(l => emit(l)); continue; }
    if (ev.k === "note") { emit(ev.text); continue; }
    if (ev.k === "play") {
      emit(""); emit(ev.banner); emit("");
      els.anStage.querySelectorAll(".anh").forEach(c => { c.querySelector(".dots").innerHTML = ""; const inP = ev.hosts.includes(c.dataset.h); c.classList.toggle("off", !inP); c.dataset.s = "idle"; c.querySelector(".st").textContent = inP ? "waiting…" : "not in this play"; });
      await sleep(scale(300)); continue;
    }
    if (ev.k === "playend") { continue; }
    if (ev.k === "task") {
      emit(ev.banner); els.anTask.textContent = ev.name;
      ev.results.forEach(r => setCard(r.host, "run", (ev.handler ? "handler: " : "") + ev.name));
      const longest = Math.max(100, ...ev.results.map(r => r.dur || 200));
      await sleep(scale(longest));
      if (my !== token) return;
      for (const r of ev.results) {
        r.text.forEach(l => emit(l));
        const c = r.st === "changed" ? "changed" : r.st === "ok" ? "ok" : r.st === "skipped" ? "skipped" : r.st === "unreachable" ? "unreachable" : r.st === "ignored" ? "ignored" : "failed";
        dot(r.host, c);
        setCard(r.host, r.st === "failed" ? "failed" : r.st === "unreachable" ? "unreachable" : r.st === "changed" ? "changed" : r.st === "ok" ? "ok" : "idle", (r.st === "failed" ? "✕ " : r.st === "unreachable" ? "✕ unreachable: " : r.st === "changed" ? "● changed: " : r.st === "skipped" ? "· skipped: " : "✓ ") + ev.name);
        if (speed) await sleep(scale(90));
      }
      emit(""); done++; els.anCount.textContent = done + " / " + tasksTotal + " tasks"; els.anBar.style.width = (tasksTotal ? done / tasksTotal * 100 : 100) + "%";
      continue;
    }
    if (ev.k === "recap") {
      emit("PLAY RECAP " + "*".repeat(68));
      const w = Math.max(26, ...ev.rows.map(r => r.host.length));
      ev.rows.forEach(r => emit(r.line));
      ev.rows.forEach(r => { const c = r.c; setCard(r.host, c.unreachable ? "unreachable" : c.failed ? "failed" : c.changed ? "changed" : "ok", c.unreachable ? "unreachable" : c.failed ? "failed (" + c.failed + ")" : "ok=" + c.ok + "  changed=" + c.changed); });
    }
  }
  if (my !== token) return;
  if (res.state && !opt.check) { state = res.state; saveState(); }
  refreshDetails();
  els.anTask.textContent = opt.check ? "dry run — nothing was changed" : "done";
  const rc = res.rc || 0; status(rc === 0 ? "ok" : "rc=" + rc, rc === 0 ? "ok" : "err");
  busy = false; setBusy(false); status(rc === 0 ? (opt.check ? "check ok" : "ok") : "rc=" + rc, rc === 0 ? "ok" : "err");
}

function reset(announce) { token++; state = A.newState(); saveState(); els.anLog.innerHTML = ""; setBusy(false); drawHosts(); els.anTask.textContent = "—"; els.anCount.textContent = "0 / 0 tasks"; els.anBar.style.width = "0"; if (announce) { logLine("All hosts reset to a fresh install — packages, files, users and services are gone.", "sys"); } }

window.ANUI = {
  mount, runAll: () => runAll(),
  activate() { active = true; view.classList.add("on"); drawHosts(); },
  deactivate() { active = false; view.classList.remove("on"); token++; if (busy) setBusy(false); },
  onEdit() { },
  stop() { token++; if (busy) { setBusy(false); logLine("■ stopped by user (hosts keep whatever had already changed in the previous run)", "sys"); status("stopped", "idle"); } },
  resetState() { reset(false); },
  setInventory(t) { invText = t; if (els.anInv) { els.anInv.value = t; } try { localStorage.setItem("devportal.ans.inv", t); } catch (e) {} if (view) drawHosts(); },
  onExample(title, invOverride) { this.setInventory(invOverride || A.DEFAULT_INVENTORY); }
};
})();
