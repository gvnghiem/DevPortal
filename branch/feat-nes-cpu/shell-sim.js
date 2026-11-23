/* shell-sim.js — a bash-subset interpreter running on an in-memory filesystem.
 * Nothing here touches the real machine: files, processes and the network are all simulated.
 * window.ShellSim = { newFS, run(script, session, opts) -> events[], newSession(fs) , tree(fs) }
 */
(function () {
"use strict";

/* ───────────────────────── virtual filesystem ───────────────────────── */
const D = (c, m) => ({ t: "d", c: c || {}, m: m || 0o755 });
const F = (d, m) => ({ t: "f", d: d, m: m || 0o644 });

function newFS() {
  return D({
    home: D({ user: D({
      "notes.txt": F("Buy milk\nCall Alice\nFinish the DevPortal shell demo\nBuy bread\nRead about pipes\n"),
      "todo.md": F("# TODO\n- [x] learn ls\n- [ ] learn grep\n- [ ] learn awk\n"),
      "welcome.sh": F("#!/bin/bash\necho \"Welcome, $USER!\"\n", 0o755),
      data: D({
        "people.csv": F("name,city,age\nAlice,Paris,31\nBob,Berlin,25\nCarla,Paris,42\nDmitri,Moscow,37\nEve,Berlin,29\nFrank,Paris,51\n"),
        "words.txt": F("banana\napple\ncherry\napple\nbanana\napple\ndate\nelderberry\nfig\ncherry\n"),
        "access.log": F(
          "10.0.0.1 - - [21/Nov/2026:10:00:01] \"GET /index.html HTTP/1.1\" 200 1043\n" +
          "10.0.0.2 - - [21/Nov/2026:10:00:03] \"GET /about.html HTTP/1.1\" 200 512\n" +
          "10.0.0.1 - - [21/Nov/2026:10:00:07] \"POST /login HTTP/1.1\" 302 0\n" +
          "10.0.0.3 - - [21/Nov/2026:10:00:09] \"GET /missing HTTP/1.1\" 404 128\n" +
          "10.0.0.2 - - [21/Nov/2026:10:00:12] \"GET /index.html HTTP/1.1\" 200 1043\n" +
          "10.0.0.4 - - [21/Nov/2026:10:00:15] \"GET /api/items HTTP/1.1\" 500 77\n" +
          "10.0.0.1 - - [21/Nov/2026:10:00:18] \"GET /index.html HTTP/1.1\" 200 1043\n" +
          "10.0.0.3 - - [21/Nov/2026:10:00:21] \"GET /missing HTTP/1.1\" 404 128\n")
      }),
      projects: D({ demo: D({ "README.md": F("# Demo\nA tiny project.\n"), src: D({ "main.c": F("int main(){return 0;}\n"), "util.c": F("// helpers\n") }) }) })
    }) }),
    etc: D({ hostname: F("devportal\n"), "os-release": F("NAME=\"DevPortal Linux\"\nVERSION=\"1.0 (simulated)\"\n") }),
    tmp: D(), usr: D({ bin: D() }), var: D({ log: D() }), dev: D({ null: F("") })
  });
}
const HOME = "/home/user";

function splitPath(p) { return p.split("/").filter(Boolean); }
function normalize(path, cwd) {
  if (path === "~" || path.startsWith("~/")) path = HOME + path.slice(1);
  const parts = (path.startsWith("/") ? [] : splitPath(cwd));
  splitPath(path).forEach(s => { if (s === "..") parts.pop(); else if (s !== ".") parts.push(s); });
  return "/" + parts.join("/");
}
function lookup(fs, abs) {
  let n = fs;
  for (const s of splitPath(abs)) { if (!n || n.t !== "d" || !(s in n.c)) return null; n = n.c[s]; }
  return n;
}
function parentOf(fs, abs) {
  const parts = splitPath(abs), name = parts.pop();
  return { dir: lookup(fs, "/" + parts.join("/")), name, abs };
}
function treeLines(fs, abs, prefix, out, depth) {
  const n = lookup(fs, abs); if (!n || n.t !== "d") return;
  Object.keys(n.c).sort().forEach(k => {
    const c = n.c[k];
    out.push({ path: (abs === "/" ? "" : abs) + "/" + k, name: k, dir: c.t === "d", depth: depth });
    if (c.t === "d") treeLines(fs, (abs === "/" ? "" : abs) + "/" + k, prefix, out, depth + 1);
  });
}

/* ───────────────────────── lexer ───────────────────────── */
class ShellError extends Error {}
const OPS = ["&&", "||", ";;", "<<<", "<<-", "<<", ">>", "&>", ">&", "|", ";", "&", "(", ")", "<", ">"];

function lex(src) {
  const toks = []; let i = 0; const n = src.length; const pend = [];
  function skipBody() {
    while (pend.length) {
      const h = pend.shift(); let body = "";
      for (;;) {
        if (i >= n) break;
        let j = src.indexOf("\n", i); if (j < 0) j = n;
        const line = src.slice(i, j); i = Math.min(n, j + 1);
        if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
        body += (h.strip ? line.replace(/^\t+/, "") : line) + "\n";
      }
      h.tok.body = body; h.tok.quoted = h.quoted;
    }
  }
  while (i < n) {
    const c = src[i];
    if (c === "\n") { toks.push({ t: "nl" }); i++; skipBody(); continue; }
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    if (c === "\\" && src[i + 1] === "\n") { i += 2; continue; }
    if (c === "#") { while (i < n && src[i] !== "\n") i++; continue; }
    let fd = null;
    const m = /^(\d+)(?=[<>])/.exec(src.slice(i, i + 4));
    if (m) { fd = +m[1]; i += m[1].length; }
    const op = OPS.find(o => src.startsWith(o, i));
    if (op) {
      i += op.length;
      const tok = { t: "op", v: op, fd: fd, s: i - op.length, e: i };
      toks.push(tok);
      if (op === "<<" || op === "<<-") {
        while (src[i] === " " || src[i] === "\t") i++;
        let d = "", q = false;
        while (i < n && !/[\s;&|<>()]/.test(src[i])) {
          if (src[i] === "'" || src[i] === '"') { q = true; i++; continue; }
          d += src[i++];
        }
        pend.push({ tok, delim: d, quoted: q, strip: op === "<<-" });
      }
      continue;
    }
    // word
    let w = ""; const w0 = i;
    while (i < n) {
      const ch = src[i];
      if (/[ \t\r\n]/.test(ch) || (OPS.some(o => src.startsWith(o, i)) && ch !== "(" ) ) break;
      if (ch === "(" || ch === ")") {
        if (ch === ")" ) break;
        break;
      }
      if (ch === "\\") { w += ch + (src[i + 1] || ""); i += 2; continue; }
      if (ch === "'") { const j = src.indexOf("'", i + 1); if (j < 0) throw new ShellError("unexpected EOF while looking for matching `''"); w += src.slice(i, j + 1); i = j + 1; continue; }
      if (ch === '"') {
        let j = i + 1;
        while (j < n && src[j] !== '"') { if (src[j] === "\\") j++; else if (src[j] === "$" && src[j + 1] === "(") j = matchParen(src, j + 1); j++; }
        if (j >= n) throw new ShellError("unexpected EOF while looking for matching `\"'");
        w += src.slice(i, j + 1); i = j + 1; continue;
      }
      if (ch === "`") { const j = src.indexOf("`", i + 1); if (j < 0) throw new ShellError("unexpected EOF while looking for matching ``'"); w += src.slice(i, j + 1); i = j + 1; continue; }
      if (ch === "$" && src[i + 1] === "(") { const j = matchParen(src, i + 1); w += src.slice(i, j + 1); i = j + 1; continue; }
      if (ch === "$" && src[i + 1] === "{") { const j = src.indexOf("}", i); if (j < 0) throw new ShellError("bad substitution"); w += src.slice(i, j + 1); i = j + 1; continue; }
      if (ch === "(" ) break;
      w += ch; i++;
    }
    // array assignment  a=(x y z)  — glue the parenthesised list to the word
    if (/^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test(w) && src[i] === "(") {
      const j = matchParen(src, i); w += src.slice(i, j + 1); i = j + 1;
    }
    if (w === "" && i < n && !/[ \t\r\n]/.test(src[i])) { i++; continue; }
    if (w !== "") toks.push({ t: "w", v: w, s: w0, e: i });
  }
  return toks;
}
function matchParen(s, i) {   // s[i] === "(" ; returns index of matching ")"
  let d = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === "'") { j = s.indexOf("'", j + 1); if (j < 0) break; continue; }
    if (c === '"') { j++; while (j < s.length && s[j] !== '"') { if (s[j] === "\\") j++; j++; } continue; }
    if (c === "\\") { j++; continue; }
    if (c === "(") d++;
    else if (c === ")") { d--; if (d === 0) return j; }
  }
  throw new ShellError("unexpected EOF while looking for matching `)'");
}

/* ───────────────────────── parser ───────────────────────── */
const KW = new Set(["if", "then", "elif", "else", "fi", "for", "in", "do", "done", "while", "until", "case", "esac", "function", "{", "}", "!"]);

function parse(toks) {
  let p = 0;
  const peek = () => toks[p];
  const isW = (t, v) => t && t.t === "w" && (v === undefined || t.v === v);
  const isOp = (t, v) => t && t.t === "op" && t.v === v;
  function skipNl() { while (peek() && (peek().t === "nl" || isOp(peek(), ";"))) p++; }
  function expectKw(v) {
    skipNl();
    if (!isW(peek(), v)) throw new ShellError("syntax error: expected `" + v + "'" + (peek() ? " near `" + (peek().v || "newline") + "'" : " but reached end of input"));
    p++;
  }
  function parseList(stop) {      // until a stop keyword / ) / ;;
    const items = [];
    for (;;) {
      skipNl();
      const t = peek();
      if (!t) break;
      if (t.t === "w" && stop && stop.includes(t.v)) break;
      if (t.t === "op" && (t.v === ")" || t.v === ";;")) break;
      const t0 = p, node = parseAndOr();
      if (toks[t0] && toks[p - 1] && toks[t0].s !== undefined && toks[p - 1].e !== undefined) node.src = [toks[t0].s, toks[p - 1].e];
      items.push(node);
    }
    return { k: "list", items };
  }
  function parseAndOr() {
    let left = parsePipeline();
    for (;;) {
      const t = peek();
      if (isOp(t, "&&") || isOp(t, "||")) { p++; while (peek() && peek().t === "nl") p++; const right = parsePipeline(); left = { k: "andor", op: t.v, l: left, r: right }; }
      else break;
    }
    if (isOp(peek(), "&")) p++;       // background jobs run in the foreground here
    return left;
  }
  function parsePipeline() {
    let neg = false;
    if (isW(peek(), "!")) { neg = true; p++; }
    const cmds = [parseCommand()];
    while (isOp(peek(), "|")) { p++; while (peek() && peek().t === "nl") p++; cmds.push(parseCommand()); }
    return { k: "pipe", cmds, neg };
  }
  function parseRedirs(node) {
    node.redirs = node.redirs || [];
    while (peek() && peek().t === "op" && [">", ">>", "<", "<<", "<<-", "<<<", ">&", "&>"].includes(peek().v)) {
      const o = peek(); p++;
      if (o.v === "<<" || o.v === "<<-") { node.redirs.push({ op: "<<", tok: o }); continue; }
      const tgt = peek();
      if (!isW(tgt)) throw new ShellError("syntax error near unexpected token `" + (tgt ? (tgt.v || "newline") : "newline") + "'");
      p++; node.redirs.push({ op: o.v, fd: o.fd, target: tgt.v });
    }
    return node;
  }
  function parseCommand() {
    const t = peek();
    if (!t) throw new ShellError("syntax error: unexpected end of input");
    if (isW(t, "if")) {
      p++; const cond = parseList(["then"]); expectKw("then");
      const then = parseList(["elif", "else", "fi"]); const elifs = []; let els = null;
      for (;;) {
        skipNl();
        if (isW(peek(), "elif")) { p++; const c = parseList(["then"]); expectKw("then"); elifs.push({ c, b: parseList(["elif", "else", "fi"]) }); }
        else if (isW(peek(), "else")) { p++; els = parseList(["fi"]); }
        else break;
      }
      expectKw("fi");
      return parseRedirs({ k: "if", cond, then, elifs, els });
    }
    if (isW(t, "while") || isW(t, "until")) {
      p++; const cond = parseList(["do"]); expectKw("do"); const body = parseList(["done"]); expectKw("done");
      return parseRedirs({ k: "while", until: t.v === "until", cond, body });
    }
    if (isW(t, "for")) {
      p++; const v = peek(); if (!isW(v)) throw new ShellError("syntax error near `for'"); p++;
      if (v.v.startsWith("((")) throw new ShellError("C-style for loops are not supported — use: for i in $(seq 1 5)");
      let words = null;
      skipNlOnly();
      if (isW(peek(), "in")) { p++; words = []; while (peek() && peek().t === "w" && !(peek().v === "do")) words.push(toks[p++].v); }
      skipNl(); expectKw("do"); const body = parseList(["done"]); expectKw("done");
      return parseRedirs({ k: "for", name: v.v, words, body });
    }
    if (isW(t, "case")) {
      p++; const word = toks[p++]; skipNl(); expectKw("in"); const cases = [];
      for (;;) {
        skipNl();
        if (isW(peek(), "esac")) { p++; break; }
        if (isOp(peek(), "(")) p++;
        const pats = [];
        for (;;) { const w = toks[p++]; if (!isW(w)) throw new ShellError("syntax error in case"); pats.push(w.v); if (isOp(peek(), "|")) { p++; continue; } break; }
        if (!isOp(peek(), ")")) throw new ShellError("syntax error: expected `)' in case"); p++;
        const body = parseList(["esac"]); cases.push({ pats, body });
        if (isOp(peek(), ";;")) p++;
      }
      return parseRedirs({ k: "case", word: word.v, cases });
    }
    if (isW(t, "{")) { p++; const body = parseList(["}"]); expectKw("}"); return parseRedirs({ k: "group", body }); }
    if (isOp(t, "(")) { p++; const body = parseList(); if (!isOp(peek(), ")")) throw new ShellError("syntax error: expected `)'"); p++; return parseRedirs({ k: "sub", body }); }
    if (isW(t, "function")) {
      p++; const name = toks[p++].v; if (isOp(peek(), "(") && isOp(toks[p + 1], ")")) p += 2;
      skipNl(); return { k: "func", name, body: parseCommand() };
    }
    // name() { ... }
    if (t.t === "w" && isOp(toks[p + 1], "(") && isOp(toks[p + 2], ")")) {
      p += 3; skipNl(); return { k: "func", name: t.v, body: parseCommand() };
    }
    // [[ ... ]]
    if (isW(t, "[[")) {
      p++; const ws = ["["];
      while (peek() && !isW(peek(), "]]")) { const x = toks[p++]; ws.push(x.t === "w" ? x.v : x.v); }
      if (!peek()) throw new ShellError("unexpected EOF while looking for `]]'");
      p++; ws.push("]");
      return parseRedirs({ k: "simple", words: ws, assigns: [], redirs: [], dbl: true });
    }
    // simple command
    const node = { k: "simple", words: [], assigns: [], redirs: [] };
    for (;;) {
      const x = peek();
      if (!x) break;
      if (x.t === "w") {
        if (!node.words.length && /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(x.v)) { node.assigns.push(x.v); p++; continue; }
        if (!node.words.length && KW.has(x.v) && x.v !== "!" ) break;
        node.words.push(x.v); p++; continue;
      }
      if (x.t === "op" && [">", ">>", "<", "<<", "<<-", "<<<", ">&", "&>"].includes(x.v)) { parseRedirs(node); continue; }
      break;
    }
    if (!node.words.length && !node.assigns.length && !node.redirs.length) throw new ShellError("syntax error near unexpected token `" + (peek() ? (peek().v || "newline") : "newline") + "'");
    return node;
  }
  function skipNlOnly() { while (peek() && peek().t === "nl") p++; }
  const list = parseList();
  if (p < toks.length) throw new ShellError("syntax error near unexpected token `" + (toks[p].v || "newline") + "'");
  return list;
}

/* ───────────────────────── glob / regex helpers ───────────────────────── */
function globToRe(g, whole) {
  let r = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "\\") { r += "\\" + (g[++i] || ""); continue; }
    if (c === "*") r += ".*";
    else if (c === "?") r += ".";
    else if (c === "[") { const j = g.indexOf("]", i + 2); if (j < 0) r += "\\["; else { let cls = g.slice(i + 1, j); if (cls[0] === "!") cls = "^" + cls.slice(1); r += "[" + cls + "]"; i = j; } }
    else r += c.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  return new RegExp(whole === false ? r : "^" + r + "$", "s");
}
const hasGlob = s => /(^|[^\\])[*?\[]/.test(s);
function posixToJs(re) {
  return re.replace(/\[\[:alpha:\]\]/g, "[A-Za-z]").replace(/\[\[:digit:\]\]/g, "[0-9]").replace(/\[\[:space:\]\]/g, "\\s")
    .replace(/\[\[:upper:\]\]/g, "[A-Z]").replace(/\[\[:lower:\]\]/g, "[a-z]").replace(/\[\[:alnum:\]\]/g, "[A-Za-z0-9]")
    .replace(/\[:alpha:\]/g, "A-Za-z").replace(/\[:digit:\]/g, "0-9").replace(/\[:space:\]/g, "\\s").replace(/\[:alnum:\]/g, "A-Za-z0-9").replace(/\[:upper:\]/g, "A-Z").replace(/\[:lower:\]/g, "a-z");
}
function mkRe(pat, ext, flags) {
  let s = posixToJs(pat);
  if (!ext) {   // basic regex: \( \) \{ \} \| \+ \? are special; bare ones are literal
    s = s.replace(/\\([(){}|+?])|([(){}|+?])/g, (m, esc, bare) => esc ? esc : "\\" + bare);
  }
  try { return new RegExp(s, flags || ""); } catch (e) { throw new ShellError("invalid regular expression: " + pat); }
}

/* ───────────────────────── arithmetic ───────────────────────── */
function arith(expr, getVar, setVar) {
  const s = expr; let i = 0;
  const ws = () => { while (s[i] === " ") i++; };
  function num() {
    ws();
    if (s[i] === "(") { i++; const v = assign(); ws(); i++; return v; }
    if (s[i] === "-") { i++; return -num(); }
    if (s[i] === "+") { i++; return num(); }
    if (s[i] === "!") { i++; return num() ? 0 : 1; }
    if (s[i] === "~") { i++; return ~num(); }
    let m = /^(0x[0-9a-fA-F]+|\d+)/.exec(s.slice(i));
    if (m) { i += m[0].length; return /^0x/i.test(m[0]) ? parseInt(m[0], 16) : (m[0].length > 1 && m[0][0] === "0" ? parseInt(m[0], 8) : parseInt(m[0], 10)); }
    m = /^\$?([A-Za-z_][A-Za-z0-9_]*)/.exec(s.slice(i));
    if (m) { i += m[0].length; return parseInt(getVar(m[1]), 10) || 0; }
    throw new ShellError("arithmetic syntax error: operand expected (error token is \"" + s.slice(i) + "\")");
  }
  const lvl = [["**"], ["*", "/", "%"], ["+", "-"], ["<<", ">>"], ["<=", ">=", "<", ">"], ["==", "!="], ["&"], ["^"], ["|"], ["&&"], ["||"]];
  function bin(k) {
    if (k < 0) return num();
    let l = k === 0 ? num() : bin(k - 1);
    for (;;) {
      ws(); let found = null;
      for (const o of lvl[k]) if (s.startsWith(o, i) && !(o === "*" && s[i + 1] === "*") && !(o === "<" && s[i + 1] === "<") && !(o === ">" && s[i + 1] === ">") && !(o === "&" && s[i + 1] === "&") && !(o === "|" && s[i + 1] === "|")) { found = o; break; }
      if (!found) return l; i += found.length;
      const r = k === 0 ? bin(0) : bin(k - 1);
      switch (found) {
        case "**": l = Math.pow(l, r); break; case "*": l *= r; break;
        case "/": if (r === 0) throw new ShellError("division by 0 (error token is \"" + s.slice(i - 1).trim() + "\")"); l = Math.trunc(l / r); break;
        case "%": if (r === 0) throw new ShellError("division by 0"); l %= r; break;
        case "+": l += r; break; case "-": l -= r; break; case "<<": l <<= r; break; case ">>": l >>= r; break;
        case "<=": l = l <= r ? 1 : 0; break; case ">=": l = l >= r ? 1 : 0; break; case "<": l = l < r ? 1 : 0; break; case ">": l = l > r ? 1 : 0; break;
        case "==": l = l === r ? 1 : 0; break; case "!=": l = l !== r ? 1 : 0; break;
        case "&": l &= r; break; case "^": l ^= r; break; case "|": l |= r; break; case "&&": l = l && r ? 1 : 0; break; case "||": l = l || r ? 1 : 0; break;
      }
    }
  }
  function assign() {
    ws();
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(\+\+|--|[-+*\/%]?=)(?!=)/.exec(s.slice(i));
    if (m) {
      i += m[0].length; const cur = parseInt(getVar(m[1]), 10) || 0; let v;
      if (m[2] === "++") v = cur + 1; else if (m[2] === "--") v = cur - 1;
      else { const r = assign(); v = m[2] === "=" ? r : m[2] === "+=" ? cur + r : m[2] === "-=" ? cur - r : m[2] === "*=" ? cur * r : m[2] === "/=" ? Math.trunc(cur / r) : cur % r; }
      setVar(m[1], String(v)); return v;
    }
    const post = /^([A-Za-z_][A-Za-z0-9_]*)(\+\+|--)/.exec(s.slice(i));
    if (post) { i += post[0].length; const cur = parseInt(getVar(post[1]), 10) || 0; setVar(post[1], String(cur + (post[2] === "++" ? 1 : -1))); return cur; }
    const v = bin(lvl.length - 1); ws();
    if (s[i] === "?") { i++; const a = assign(); ws(); i++; const b = assign(); return v ? a : b; }
    return v;
  }
  const r = assign(); ws();
  if (i < s.length) throw new ShellError("arithmetic syntax error in expression (error token is \"" + s.slice(i) + "\")");
  return r;
}

/* ───────────────────────── interpreter ───────────────────────── */
class Exit extends Error { constructor(c) { super("exit"); this.code = c; } }
class Ret extends Error { constructor(c) { super("return"); this.code = c; } }
class Brk extends Error { constructor(n, cont) { super("break"); this.n = n; this.cont = cont; } }

function newSession(fs) {
  return { fs, cwd: HOME, vars: { USER: "user", HOME: HOME, PWD: HOME, SHELL: "/bin/bash", HOSTNAME: "devportal", PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "en_US.UTF-8", IFS: " \t\n", OLDPWD: HOME, RANDOM: "0" }, exported: new Set(["USER", "HOME", "PWD", "SHELL", "PATH", "HOSTNAME", "LANG"]), funcs: {}, status: 0, args: [], script: "bash", clock: 0 };
}

function run(script, S, opts) {
  opts = opts || {};
  const events = [];
  const cap = { steps: 0, max: opts.maxSteps || 60000, outBytes: 0 };
  const emit = (k, text) => { cap.outBytes += text.length; if (cap.outBytes > 400000) throw new ShellError("output limit exceeded"); events.push(k === "cmd" ? { k, text, cwd: S.cwd } : { k, text }); };
  let ast;
  try { ast = parse(lex(script)); } catch (e) { if (e instanceof ShellError) { emit("err", "bash: " + e.message); S.status = 2; return events; } throw e; }
  const topIo = { in: null, out: t => emit("out", t), err: t => emit("err", t), tty: true };
  function go() {
    try {
      if (opts.echo) { for (const it of ast.items) { emit("cmd", it.src ? script.slice(it.src[0], it.src[1]) : ""); S.status = execNode(it, topIo); } }
      else execList(ast, topIo, true, script);
    }
    catch (e) {
      if (e instanceof Exit) S.status = e.code;
      else if (e instanceof ShellError) { emit("err", "bash: " + e.message); S.status = 1; }
      else if (e instanceof Ret || e instanceof Brk) { /* stray return/break */ }
      else throw e;
    }
    return events;
  }

  /* ---- variable access ---- */
  function getVar(name) {
    if (name === "?") return String(S.status);
    if (name === "#") return String(S.args.length);
    if (name === "0") return S.script;
    if (name === "$") return "4242";
    if (name === "RANDOM") return String(Math.floor(Math.random() * 32768));
    if (/^\d+$/.test(name)) return S.args[+name - 1] === undefined ? "" : S.args[+name - 1];
    const v = S.vars[name];
    if (Array.isArray(v)) return v[0] === undefined ? "" : v[0];
    return v === undefined ? "" : v;
  }
  const isSet = name => name in S.vars || (/^\d+$/.test(name) && S.args[+name - 1] !== undefined) || ["?", "#", "0", "$"].includes(name);
  function setVar(name, val) { S.vars[name] = val; }

  /* ---- word expansion ---- */
  function expandWord(raw, io, noSplit) {
    // returns array of fields
    const fields = []; let cur = "", pat = "", has = false;
    const push = () => { if (has || cur !== "") { fields.push({ text: cur, pat }); } cur = ""; pat = ""; has = false; };
    const addQuoted = t => { cur += t; pat += t.replace(/[\\*?\[]/g, "\\$&"); has = true; };
    const addUnq = (t, split) => {
      if (!split || noSplit) { cur += t; pat += t; return; }
      const ifs = S.vars.IFS === undefined ? " \t\n" : S.vars.IFS;
      let buf = "";
      for (const ch of t) {
        if (ifs.includes(ch)) { if (buf !== "") { cur += buf; pat += buf; buf = ""; } if (cur !== "" || has) push(); }
        else buf += ch;
      }
      if (buf !== "") { cur += buf; pat += buf; }
    };
    const s = raw; let i = 0;
    if (s[0] === "~" && (s.length === 1 || s[1] === "/")) { cur = HOME; pat = HOME; i = 1; }
    while (i < s.length) {
      const c = s[i];
      if (c === "\\") { const nx = s[i + 1] === undefined ? "\\" : s[i + 1]; cur += nx; pat += /[*?\[\\]/.test(nx) ? "\\" + nx : nx; has = true; i += 2; continue; }
      if (c === "'") { const j = s.indexOf("'", i + 1); addQuoted(s.slice(i + 1, j)); i = j + 1; continue; }
      if (c === '"') {
        let j = i + 1, body = "";
        while (j < s.length && s[j] !== '"') { if (s[j] === "\\") { body += s[j] + (s[j + 1] || ""); j += 2; continue; } if (s[j] === "$" && s[j + 1] === "(") { const e = matchParen(s, j + 1); body += s.slice(j, e + 1); j = e + 1; continue; } if (s[j] === "$" && s[j + 1] === "{") { const e = s.indexOf("}", j); body += s.slice(j, e + 1); j = e + 1; continue; } body += s[j++]; }
        has = true;
        // "$@" / "${arr[@]}" expand to separate fields
        if (body === "$@" || body === "$*" || /^\$\{[A-Za-z_][A-Za-z0-9_]*\[[@*]\]\}$/.test(body)) {
          const arr = body[1] === "{" ? (Array.isArray(S.vars[body.slice(2, body.indexOf("["))]) ? S.vars[body.slice(2, body.indexOf("["))] : [getVar(body.slice(2, body.indexOf("[")))]) : S.args;
          if (body === "$*") addQuoted(arr.join(" ")); else arr.forEach((a, k) => { if (k > 0) push(); addQuoted(a); has = true; });
        } else addQuoted(expandDq(body, io));
        i = j + 1; continue;
      }
      if (c === "$" || c === "`") { const r = expandDollar(s, i, io); i = r.i; if (r.arr) { r.arr.forEach((a, k) => { if (k > 0) push(); addUnq(a, true); }); } else addUnq(r.v, true); continue; }
      cur += c; pat += c; i++;
    }
    push();
    if (noSplit) return fields.length ? [fields.map(f => f.text).join("")] : [""];
    const out = [];
    for (const f of fields) {
      if (hasGlob(f.pat)) { const g = glob(f.pat); if (g.length) { out.push(...g); continue; } }
      out.push(f.text);
    }
    return out;
  }
  function expandDq(body, io) {
    let out = "", i = 0;
    while (i < body.length) {
      const c = body[i];
      if (c === "\\") { const nx = body[i + 1]; if (nx === "$" || nx === "`" || nx === '"' || nx === "\\") { out += nx; i += 2; continue; } if (nx === "\n") { i += 2; continue; } out += c; i++; continue; }
      if (c === "$" || c === "`") { const r = expandDollar(body, i, io); out += r.arr ? r.arr.join(" ") : r.v; i = r.i; continue; }
      out += c; i++;
    }
    return out;
  }
  function expandDollar(s, i, io) {
    if (s[i] === "`") { const j = s.indexOf("`", i + 1); return { v: cmdSubst(s.slice(i + 1, j), io), i: j + 1 }; }
    const nx = s[i + 1];
    if (nx === "(" && s[i + 2] === "(") {
      const e = matchParen(s, i + 1); const inner = s.slice(i + 3, e - 1);
      return { v: String(arith(expandDq(inner, io), getVar, setVar)), i: e + 1 };
    }
    if (nx === "(") { const e = matchParen(s, i + 1); return { v: cmdSubst(s.slice(i + 2, e), io), i: e + 1 }; }
    if (nx === "{") { const e = s.indexOf("}", i); return paramExp(s.slice(i + 2, e), io, e + 1); }
    const m = /^([A-Za-z_][A-Za-z0-9_]*|\d|[?#$@*!])/.exec(s.slice(i + 1));
    if (!m) return { v: "$", i: i + 1 };
    const name = m[1];
    if (name === "@" || name === "*") return { arr: S.args.slice(), v: S.args.join(" "), i: i + 1 + name.length };
    return { v: getVar(name), i: i + 1 + name.length };
  }
  function paramExp(body, io, next) {
    let m;
    if ((m = /^#([A-Za-z_][A-Za-z0-9_]*)\[[@*]\]$/.exec(body))) return { v: String(Array.isArray(S.vars[m[1]]) ? S.vars[m[1]].length : (m[1] in S.vars ? 1 : 0)), i: next };
    if ((m = /^#([A-Za-z_][A-Za-z0-9_]*|\d+|[@*])$/.exec(body))) return { v: String(m[1] === "@" || m[1] === "*" ? S.args.length : getVar(m[1]).length), i: next };
    if ((m = /^!([A-Za-z_][A-Za-z0-9_]*)\[[@*]\]$/.exec(body))) return { arr: (S.vars[m[1]] || []).map((_, k) => String(k)), v: "", i: next };
    if ((m = /^([A-Za-z_][A-Za-z0-9_]*)\[([^\]]+)\]$/.exec(body))) {
      const a = S.vars[m[1]];
      if (m[2] === "@" || m[2] === "*") { const arr = Array.isArray(a) ? a : (a === undefined ? [] : [a]); return { arr, v: arr.join(" "), i: next }; }
      const idx = arith(m[2], getVar, setVar); const arr = Array.isArray(a) ? a : (a === undefined ? [] : [a]);
      return { v: arr[idx] === undefined ? "" : arr[idx], i: next };
    }
    m = /^([A-Za-z_][A-Za-z0-9_]*|\d+|[?#$@*])(.*)$/s.exec(body);
    if (!m) throw new ShellError("${" + body + "}: bad substitution");
    const name = m[1], rest = m[2], val = getVar(name), set = isSet(name);
    if (rest === "") return { v: val, i: next };
    const arg = t => expandDq(t, io);
    let r;
    if ((r = /^:?-(.*)$/s.exec(rest))) return { v: (rest[0] === ":" ? (val !== "") : set) ? val : arg(r[1]), i: next };
    if ((r = /^:?=(.*)$/s.exec(rest))) { if (rest[0] === ":" ? val !== "" : set) return { v: val, i: next }; const d = arg(r[1]); setVar(name, d); return { v: d, i: next }; }
    if ((r = /^:?\+(.*)$/s.exec(rest))) return { v: (rest[0] === ":" ? val !== "" : set) ? arg(r[1]) : "", i: next };
    if ((r = /^:?\?(.*)$/s.exec(rest))) { if (rest[0] === ":" ? val !== "" : set) return { v: val, i: next }; throw new ShellError(name + ": " + (arg(r[1]) || "parameter null or not set")); }
    if ((r = /^(##|#)(.*)$/s.exec(rest))) { const re = globToRe(arg(r[2]), false); let best = null; for (let k = 0; k <= val.length; k++) { if (new RegExp("^(?:" + re.source + ")$", "s").test(val.slice(0, k))) { best = k; if (r[1] === "#") break; } } return { v: best === null ? val : val.slice(best), i: next }; }
    if ((r = /^(%%|%)(.*)$/s.exec(rest))) { const re = globToRe(arg(r[2]), false); let best = null; for (let k = val.length; k >= 0; k--) { if (new RegExp("^(?:" + re.source + ")$", "s").test(val.slice(k))) { best = k; if (r[1] === "%") break; } } return { v: best === null ? val : val.slice(0, best), i: next }; }
    if ((r = /^(\/\/|\/)([^\/]*)(?:\/(.*))?$/s.exec(rest))) { const re = globToRe(arg(r[2]), false); const g = new RegExp(re.source, r[1] === "//" ? "gs" : "s"); return { v: val.replace(g, () => arg(r[3] || "")), i: next }; }
    if ((r = /^\^\^$/.exec(rest))) return { v: val.toUpperCase(), i: next };
    if ((r = /^,,$/.exec(rest))) return { v: val.toLowerCase(), i: next };
    if ((r = /^\^$/.exec(rest))) return { v: val.charAt(0).toUpperCase() + val.slice(1), i: next };
    if ((r = /^:(-?\d+)(?::(-?\d+))?$/.exec(rest))) { let st = +r[1]; if (st < 0) st = Math.max(0, val.length + st); return { v: r[2] === undefined ? val.slice(st) : val.substr(st, +r[2]), i: next }; }
    throw new ShellError("${" + body + "}: bad substitution");
  }
  function cmdSubst(src, io) {
    let buf = "";
    const sub = { in: null, out: t => { buf += t; }, err: io.err, tty: false };
    const saveStatus = S.status;
    const saveVars = null;
    try { execList(parse(lex(src)), sub, false); } catch (e) { if (e instanceof Exit) { S.status = e.code; } else throw e; }
    return buf.replace(/\n+$/, "");
  }
  function glob(pattern) {
    const abs = pattern.startsWith("/");
    const segs = pattern.split("/");
    let bases = [abs ? "/" : S.cwd]; let prefix = abs ? [""] : [""];
    let results = [{ path: abs ? "/" : "", fs: abs ? "/" : S.cwd }];
    segs.forEach((seg, si) => {
      if (seg === "" && si === 0) return;
      const next = [];
      for (const r of results) {
        const dirAbs = r.fs;
        if (!hasGlob(seg)) {
          const lit = seg.replace(/\\(.)/g, "$1");
          const full = normalize(lit, dirAbs); const n = lookup(S.fs, full);
          if (n || si === segs.length - 1 && false) next.push({ path: (r.path === "" ? "" : r.path === "/" ? "/" : r.path + "/") + lit, fs: full });
          continue;
        }
        const d = lookup(S.fs, dirAbs); if (!d || d.t !== "d") continue;
        const re = globToRe(seg);
        Object.keys(d.c).sort().forEach(k => { if (k[0] === "." && seg[0] !== ".") return; if (re.test(k)) next.push({ path: (r.path === "" ? "" : r.path === "/" ? "/" : r.path + "/") + k, fs: normalize(k, dirAbs) }); });
      }
      results = next;
    });
    return results.map(r => r.path);
  }

  /* ---- execution ---- */
  function tick() { if (++cap.steps > cap.max) throw new ShellError("step limit exceeded — is there an infinite loop?"); }
  function execList(list, io, top, src) {
    let st = S.status;
    for (const it of list.items) {
      st = execNode(it, io);
      S.status = st;
    }
    return st;
  }
  function execNode(n, io) {
    tick();
    switch (n.k) {
      case "list": return execList(n, io);
      case "andor": { const l = execNode(n.l, io); S.status = l; if (n.op === "&&" ? l === 0 : l !== 0) return execNode(n.r, io); return l; }
      case "pipe": return execPipe(n, io);
      case "simple": return execSimple(n, io);
      case "func": S.funcs[n.name] = n.body; return 0;
      default: return withRedirs(n, io, io2 => execCompound(n, io2));
    }
  }
  function execPipe(n, io) {
    if (n.cmds.length === 1) { const st = execNode(n.cmds[0], io); return n.neg ? (st === 0 ? 1 : 0) : st; }
    let input = io.in, st = 0;
    n.cmds.forEach((c, i) => {
      const last = i === n.cmds.length - 1; let buf = "";
      const sub = { in: input, out: last ? io.out : t => { buf += t; }, err: io.err, tty: last ? io.tty : false };
      st = execNode(c, sub); S.status = st;
      input = last ? null : { text: buf, pos: 0 };
    });
    return n.neg ? (st === 0 ? 1 : 0) : st;
  }
  function withRedirs(n, io, fn) {
    if (!n.redirs || !n.redirs.length) return fn(io);
    let io2 = { in: io.in, out: io.out, err: io.err, tty: io.tty }; const finalize = [];
    for (const r of n.redirs) {
      if (r.op === "<<") { const body = r.tok.quoted ? r.tok.body : expandDq(r.tok.body.replace(/\\\n/g, ""), io).replace(/\\\n/g, ""); io2.in = { text: body, pos: 0 }; continue; }
      const target = expandWord(r.target, io, true)[0];
      if (r.op === "<<<") { io2.in = { text: target + "\n", pos: 0 }; continue; }
      if (r.op === "<") {
        const f = lookup(S.fs, normalize(target, S.cwd));
        if (!f) { io.err("bash: " + target + ": No such file or directory\n"); return 1; }
        if (f.t === "d") { io.err("bash: " + target + ": Is a directory\n"); return 1; }
        io2.in = { text: f.d, pos: 0 }; continue;
      }
      if (r.op === ">&") { if (target === "1" || target === "2") { if (r.fd === 2 || r.fd === null && false) io2.err = io2.out; else if (r.fd === 1 || r.fd === null) io2.out = io2.err; } continue; }
      const toErr = r.fd === 2, both = r.op === "&>"; const append = r.op === ">>";
      if (target === "/dev/null") { const nul = () => {}; if (both) { io2.out = nul; io2.err = nul; } else if (toErr) io2.err = nul; else { io2.out = nul; io2.tty = false; } continue; }
      const abs = normalize(target, S.cwd), pr = parentOf(S.fs, abs);
      if (!pr.dir || pr.dir.t !== "d") { io.err("bash: " + target + ": No such file or directory\n"); return 1; }
      const ex = pr.dir.c[pr.name];
      if (ex && ex.t === "d") { io.err("bash: " + target + ": Is a directory\n"); return 1; }
      const file = ex || (pr.dir.c[pr.name] = F("")); if (!append) file.d = "";
      const w = t => { file.d += t; };
      if (both) { io2.out = w; io2.err = w; io2.tty = false; } else if (toErr) io2.err = w; else { io2.out = w; io2.tty = false; }
    }
    return fn(io2);
  }
  function execCompound(n, io) {
    switch (n.k) {
      case "if": {
        if (execList(n.cond, io) === 0) return execList(n.then, io);
        for (const e of n.elifs) if (execList(e.c, io) === 0) return execList(e.b, io);
        return n.els ? execList(n.els, io) : 0;
      }
      case "while": {
        let st = 0, guard = 0;
        for (;;) {
          tick(); if (++guard > 100000) throw new ShellError("loop limit exceeded");
          const c = execList(n.cond, io); S.status = c;
          if (n.until ? c === 0 : c !== 0) break;
          try { st = execList(n.body, io); } catch (e) { if (e instanceof Brk) { if (e.n > 1) { e.n--; throw e; } if (e.cont) continue; break; } throw e; }
        }
        return st;
      }
      case "for": {
        let items = [];
        if (n.words === null) items = S.args.slice(); else n.words.forEach(w => items.push(...expandWord(w, io)));
        let st = 0;
        for (const it of items) {
          setVar(n.name, it);
          try { st = execList(n.body, io); } catch (e) { if (e instanceof Brk) { if (e.n > 1) { e.n--; throw e; } if (e.cont) continue; break; } throw e; }
        }
        return st;
      }
      case "case": {
        const w = expandWord(n.word, io, true)[0];
        for (const c of n.cases) for (const p of c.pats) {
          const pat = expandWord(p, io, true)[0];
          if (globToRe(pat.replace(/\*/g, "*")).test(w)) return execList(c.body, io);
        }
        return 0;
      }
      case "group": return execList(n.body, io);
      case "sub": {
        const savedVars = JSON.stringify(S.vars), savedCwd = S.cwd;
        try { return execList(n.body, io); }
        catch (e) { if (e instanceof Exit) return e.code; throw e; }
        finally { S.vars = JSON.parse(savedVars); S.cwd = savedCwd; }
      }
    }
    return 0;
  }
  function assign(a, local) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[([^\]]*)\])?(\+?)=(.*)$/s.exec(a);
    const name = m[1], idx = m[2], plus = m[3] === "+", raw = m[4];
    if (raw[0] === "(" && raw[raw.length - 1] === ")") {
      const inner = raw.slice(1, -1), words = [];
      try { lex(inner).forEach(t => { if (t.t === "w") words.push(...expandWord(t.v, topIo)); }); } catch (e) { throw e; }
      if (plus) { const cur = Array.isArray(S.vars[name]) ? S.vars[name] : (name in S.vars ? [S.vars[name]] : []); S.vars[name] = cur.concat(words); } else S.vars[name] = words;
      return;
    }
    const val = expandWord(raw, topIo, true)[0];
    if (idx !== undefined) { const arr = Array.isArray(S.vars[name]) ? S.vars[name] : (name in S.vars ? [S.vars[name]] : []); arr[arith(idx, getVar, setVar)] = val; S.vars[name] = arr; return; }
    if (plus) { const cur = getVar(name); S.vars[name] = /^-?\d+$/.test(cur) && /^-?\d+$/.test(val) && S.vars["__int_" + name] ? String(+cur + +val) : cur + val; return; }
    S.vars[name] = val;
  }
  function execSimple(n, io) {
    return withRedirs(n, io, io2 => {
      if (!n.words.length) { n.assigns.forEach(a => assign(a)); return 0; }
      let words = [];
      n.words.forEach(w => words.push(...expandWord(w, io2, !!n.dbl)));
      if (n.dbl) { /* [[ ]] */ }
      if (!words.length) { n.assigns.forEach(a => assign(a)); return 0; }
      const saved = {};
      n.assigns.forEach(a => { const nm = a.split("=")[0]; saved[nm] = S.vars[nm]; assign(a); });
      let st;
      try { st = callCommand(words[0], words.slice(1), io2, n.dbl); }
      finally { if (n.assigns.length) Object.keys(saved).forEach(k => { if (saved[k] === undefined) delete S.vars[k]; else S.vars[k] = saved[k]; }); }
      return st;
    });
  }
  function callCommand(name, args, io, dbl) {
    if (S.funcs[name]) {
      const saveArgs = S.args, saveLocals = S.locals; S.args = args; S.locals = {};
      cap.depth = (cap.depth || 0) + 1; if (cap.depth > 200) throw new ShellError("maximum function nesting level exceeded");
      try { return execNode(S.funcs[name], io); }
      catch (e) { if (e instanceof Ret) return e.code; throw e; }
      finally {
        cap.depth--; Object.keys(S.locals).forEach(k => { if (S.locals[k] === undefined) delete S.vars[k]; else S.vars[k] = S.locals[k]; });
        S.args = saveArgs; S.locals = saveLocals;
      }
    }
    if (BUILTINS[name]) return BUILTINS[name](args, io, dbl);
    if (name.includes("/")) {                // run a script file from the virtual FS
      const f = lookup(S.fs, normalize(name, S.cwd));
      if (!f) { io.err("bash: " + name + ": No such file or directory\n"); return 127; }
      if (f.t === "d") { io.err("bash: " + name + ": Is a directory\n"); return 126; }
      if (!(f.m & 0o100)) { io.err("bash: " + name + ": Permission denied\n"); return 126; }
      return runScript(f.d, [name].concat(args), io);
    }
    io.err("bash: " + name + ": command not found\n"); return 127;
  }
  function runScript(text, argv, io) {
    const saveArgs = S.args, saveName = S.script; S.args = argv.slice(1); S.script = argv[0];
    try { return execList(parse(lex(text)), io); }
    catch (e) { if (e instanceof Exit) return e.code; if (e instanceof ShellError) { io.err(argv[0] + ": " + e.message + "\n"); return 2; } throw e; }
    finally { S.args = saveArgs; S.script = saveName; }
  }

  /* ---- builtins & commands ---- */
  function readIn(io) { return io.in ? io.in.text.slice(io.in.pos) : ""; }
  function filesOrStdin(args, io, name, cb) {
    if (!args.length) return cb("-", readIn(io));
    let st = 0;
    for (const a of args) {
      if (a === "-") { cb("-", readIn(io)); continue; }
      const f = lookup(S.fs, normalize(a, S.cwd));
      if (!f) { io.err(name + ": " + a + ": No such file or directory\n"); st = 1; continue; }
      if (f.t === "d") { io.err(name + ": " + a + ": Is a directory\n"); st = 1; continue; }
      cb(a, f.d);
    }
    return st;
  }
  function parseOpts(args, spec) {          // spec: "abc" boolean flags, "n:" flags with value
    const o = {}, rest = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--") { rest.push(...args.slice(i + 1)); break; }
      if ((a.length > 1 && a[0] === "-" && /[A-Za-z]/.test(a[1]) && (/^-[A-Za-z0-9]+$/.test(a) || spec.includes(a[1] + ":"))) || (/^-\d+$/.test(a) && spec.includes("#"))) {
        if (/^-\d+$/.test(a)) { o.num = +a.slice(1); continue; }
        for (let j = 1; j < a.length; j++) {
          const ch = a[j], k = spec.indexOf(ch);
          if (k < 0) throw new ShellError("invalid option -- '" + ch + "'");
          if (spec[k + 1] === ":") { const v = a.slice(j + 1) || args[++i]; o[ch] = v; break; } else o[ch] = true;
        }
      } else rest.push(a);
    }
    return { o, rest };
  }
  const lines = t => { if (t === "") return []; const l = t.split("\n"); if (l[l.length - 1] === "") l.pop(); return l; };
  function fmtMode(n) { const t = n.t === "d" ? "d" : "-"; let s = t; for (let sh = 6; sh >= 0; sh -= 3) { const b = (n.m >> sh) & 7; s += (b & 4 ? "r" : "-") + (b & 2 ? "w" : "-") + (b & 1 ? "x" : "-"); } return s; }
  function sizeOf(n) { return n.t === "f" ? n.d.length : 4096; }
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function echoEsc(s) { return s.replace(/\\(n|t|r|\\|a|e|0[0-7]{0,3}|x[0-9a-fA-F]{1,2}|c)/g, (m, c) => c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c === "\\" ? "\\" : c === "a" ? "\x07" : c === "e" ? "\x1b" : c[0] === "x" ? String.fromCharCode(parseInt(c.slice(1), 16)) : c === "c" ? "" : String.fromCharCode(parseInt(c, 8))); }
  function fmtPrintf(fmt, args) {
    let ai = 0; const next = () => (ai < args.length ? args[ai++] : undefined);
    const once = () => fmt.replace(/%(?:%|([-+ 0#]*)(\d+|\*)?(?:\.(\d+))?([diouxXfeEgGcsb]))|\\(.)/gs, (m, fl, w, pr, cv, esc) => {
      if (m === "%%") return "%";
      if (esc !== undefined) return echoEsc("\\" + esc);
      fl = fl || ""; if (w === "*") w = next();
      let v = next(), out;
      switch (cv) {
        case "d": case "i": out = String(parseInt(v === undefined ? 0 : v, 10) || 0); if (fl.includes("+") && +out >= 0) out = "+" + out; break;
        case "u": out = String(Math.abs(parseInt(v, 10) || 0)); break;
        case "o": out = (parseInt(v, 10) || 0).toString(8); break; case "x": out = (parseInt(v, 10) || 0).toString(16); break; case "X": out = (parseInt(v, 10) || 0).toString(16).toUpperCase(); break;
        case "f": out = (parseFloat(v) || 0).toFixed(pr === undefined ? 6 : +pr); break;
        case "e": case "E": out = (parseFloat(v) || 0).toExponential(pr === undefined ? 6 : +pr); break;
        case "g": case "G": out = String(+(parseFloat(v) || 0).toPrecision(pr === undefined ? 6 : +pr || 1)); break;
        case "c": out = v === undefined ? "" : String(v)[0]; break;
        case "b": out = echoEsc(v === undefined ? "" : v); break;
        default: out = v === undefined ? "" : String(v); if (pr !== undefined) out = out.slice(0, +pr);
      }
      if (w) { const wn = +w; if (out.length < wn) out = fl.includes("-") ? out.padEnd(wn) : (fl.includes("0") && "dixXfeEgGu".includes(cv) ? (out[0] === "-" || out[0] === "+" ? out[0] + out.slice(1).padStart(wn - 1, "0") : out.padStart(wn, "0")) : out.padStart(wn)); }
      return out;
    });
    let res = once(); let guard = 0;
    while (ai > 0 && ai < args.length && guard++ < 1000) res += once();
    return res;
  }
  function testExpr(a, io, name) {
    a = a.slice();
    const fileOf = p => lookup(S.fs, normalize(p, S.cwd));
    function primary() {
      const x = a.shift();
      if (x === "!") return !primary();
      if (x === "(") { const v = orE(); a.shift(); return v; }
      if (a.length && ["=", "==", "!=", "-eq", "-ne", "-lt", "-le", "-gt", "-ge", "=~", "<", ">", "-nt", "-ot"].includes(a[0])) {
        const op = a.shift(), y = a.shift();
        const xi = parseInt(x, 10), yi = parseInt(y, 10);
        switch (op) {
          case "=": case "==": return name === "[[" ? globToRe(y).test(x) : x === y; case "!=": return name === "[[" ? !globToRe(y).test(x) : x !== y;
          case "-eq": return xi === yi; case "-ne": return xi !== yi; case "-lt": return xi < yi; case "-le": return xi <= yi; case "-gt": return xi > yi; case "-ge": return xi >= yi;
          case "=~": { const mm = mkRe(y, true).exec(x); if (mm) { S.vars.BASH_REMATCH = Array.from(mm, v => v || ""); } return !!mm; }
          case "<": return x < y; case ">": return x > y; default: return false;
        }
      }
      if (/^-[a-zA-Z]$/.test(x) && a.length) {
        const y = a.shift(), f = ["-f", "-d", "-e", "-r", "-w", "-x", "-s", "-L", "-h"].includes(x) ? fileOf(y) : null;
        switch (x) {
          case "-z": return y === ""; case "-n": return y !== "";
          case "-f": return !!f && f.t === "f"; case "-d": return !!f && f.t === "d"; case "-e": return !!f; case "-r": case "-w": return !!f;
          case "-x": return !!f && !!(f.m & 0o100); case "-s": return !!f && sizeOf(f) > 0; case "-L": case "-h": return false;
          default: throw new ShellError("unknown test operator " + x);
        }
      }
      return x !== undefined && x !== "";
    }
    function andE() { let v = primary(); while (a[0] === "-a" || a[0] === "&&") { a.shift(); const r = primary(); v = v && r; } return v; }
    function orE() { let v = andE(); while (a[0] === "-o" || a[0] === "||") { a.shift(); const r = andE(); v = v || r; } return v; }
    if (!a.length) return false;
    const r = orE(); if (a.length) throw new ShellError("too many arguments in test expression");
    return r;
  }

  const BUILTINS = {
    ":": () => 0, true: () => 0, false: () => 1,
    echo(args, io) {
      let nl = true, esc = false;
      while (args[0] && /^-[neE]+$/.test(args[0])) { const f = args.shift(); if (f.includes("n")) nl = false; if (f.includes("e")) esc = true; if (f.includes("E")) esc = false; }
      let s = args.join(" "); if (esc) s = echoEsc(s);
      io.out(s + (nl ? "\n" : "")); return 0;
    },
    printf(args, io) { if (!args.length) { io.err("printf: usage: printf format [arguments]\n"); return 2; } let a = args; if (a[0] === "-v") a = a.slice(2); io.out(fmtPrintf(a[0], a.slice(1))); return 0; },
    pwd(a, io) { io.out(S.cwd + "\n"); return 0; },
    cd(args, io) {
      let t = args[0] === undefined ? HOME : args[0] === "-" ? getVar("OLDPWD") : args[0];
      const abs = normalize(t, S.cwd), n = lookup(S.fs, abs);
      if (!n) { io.err("bash: cd: " + args[0] + ": No such file or directory\n"); return 1; }
      if (n.t !== "d") { io.err("bash: cd: " + args[0] + ": Not a directory\n"); return 1; }
      S.vars.OLDPWD = S.cwd; S.cwd = abs; S.vars.PWD = abs; if (args[0] === "-") io.out(abs + "\n"); return 0;
    },
    export(args, io) { args.forEach(a => { if (a.includes("=")) { assign(a); S.exported.add(a.split("=")[0]); } else S.exported.add(a); }); if (!args.length) Object.keys(S.vars).filter(k => S.exported.has(k)).sort().forEach(k => io.out("declare -x " + k + "=\"" + getVar(k) + "\"\n")); return 0; },
    unset(args) { args.forEach(a => { delete S.vars[a]; delete S.funcs[a]; }); return 0; },
    local(args) { args.forEach(a => { const nm = a.split("=")[0]; if (S.locals && !(nm in S.locals)) S.locals[nm] = S.vars[nm]; if (a.includes("=")) assign(a); else S.vars[nm] = ""; }); return 0; },
    declare(args, io) { const a = args.filter(x => !x.startsWith("-")); a.forEach(x => { if (x.includes("=")) assign(x); else if (!(x in S.vars)) S.vars[x] = ""; }); if (args.includes("-i")) a.forEach(x => { S.vars["__int_" + x.split("=")[0]] = "1"; }); return 0; },
    readonly(args) { args.forEach(a => { if (a.includes("=")) assign(a); }); return 0; },
    shift(args) { const n = +(args[0] || 1); S.args = S.args.slice(n); return 0; },
    set() { return 0; }, trap() { return 0; }, shopt() { return 0; }, umask() { return 0; }, alias() { return 0; }, hash() { return 0; },
    exit(args) { throw new Exit(args[0] === undefined ? S.status : (+args[0] & 255)); },
    return(args) { throw new Ret(args[0] === undefined ? S.status : (+args[0] & 255)); },
    break(args) { throw new Brk(+(args[0] || 1), false); },
    continue(args) { throw new Brk(+(args[0] || 1), true); },
    source(args, io) { return BUILTINS["."](args, io); },
    "."(args, io) {
      const f = lookup(S.fs, normalize(args[0] || "", S.cwd));
      if (!f || f.t !== "f") { io.err("bash: " + args[0] + ": No such file or directory\n"); return 1; }
      try { return execList(parse(lex(f.d)), io); } catch (e) { if (e instanceof ShellError) { io.err("bash: " + e.message + "\n"); return 2; } throw e; }
    },
    bash(args, io) {
      if (args[0] === "-c") return runScript(args[1] || "", ["bash"].concat(args.slice(2)), io);
      const f = lookup(S.fs, normalize(args[0] || "", S.cwd));
      if (!f || f.t !== "f") { io.err("bash: " + args[0] + ": No such file or directory\n"); return 127; }
      return runScript(f.d, args, io);
    },
    sh(args, io) { return BUILTINS.bash(args, io); },
    eval(args, io) { try { return execList(parse(lex(args.join(" "))), io); } catch (e) { if (e instanceof ShellError) { io.err("bash: eval: " + e.message + "\n"); return 2; } throw e; } },
    "[": (args, io, dbl) => { if (args[args.length - 1] !== "]") { io.err("bash: [: missing `]'\n"); return 2; } try { return testExpr(args.slice(0, -1), io, dbl ? "[[" : "[") ? 0 : 1; } catch (e) { if (e instanceof ShellError) { io.err("bash: [: " + e.message + "\n"); return 2; } throw e; } },
    test: (args, io) => { try { return testExpr(args, io, "test") ? 0 : 1; } catch (e) { if (e instanceof ShellError) { io.err("bash: test: " + e.message + "\n"); return 2; } throw e; } },
    read(args, io) {
      const o = parseOpts(args, "rsp:"); const names = o.rest.length ? o.rest : ["REPLY"];
      if (!io.in || io.in.pos >= io.in.text.length) return 1;
      let j = io.in.text.indexOf("\n", io.in.pos); let line; if (j < 0) { line = io.in.text.slice(io.in.pos); io.in.pos = io.in.text.length; } else { line = io.in.text.slice(io.in.pos, j); io.in.pos = j + 1; }
      if (!o.o.r) line = line.replace(/\\(.)/g, "$1");
      const ifs = S.vars.IFS === undefined ? " \t\n" : S.vars.IFS;
      const parts = []; let cur = "";
      if (names.length === 1) { S.vars[names[0]] = line.replace(/^[ \t]+|[ \t]+$/g, ""); return 0; }
      let k = 0; const t = line.replace(/^[ \t]+/, "");
      for (const ch of t) { if (ifs.includes(ch) && parts.length < names.length - 1) { if (cur !== "" || !/\s/.test(ch)) { parts.push(cur); cur = ""; } } else cur += ch; }
      parts.push(cur);
      names.forEach((nm, idx) => { S.vars[nm] = idx === names.length - 1 ? (parts.slice(idx).join(" ") || "").replace(/[ \t]+$/, "") : (parts[idx] || ""); });
      return 0;
    },
    type(args, io) { args.forEach(a => io.out(S.funcs[a] ? a + " is a function\n" : BUILTINS[a] ? a + " is a shell builtin\n" : COMMANDS.has(a) ? a + " is /usr/bin/" + a + "\n" : "bash: type: " + a + ": not found\n")); return 0; },
    command(args, io) { if (args[0] === "-v") { args.slice(1).forEach(a => { if (BUILTINS[a] || S.funcs[a]) io.out(a + "\n"); else if (COMMANDS.has(a)) io.out("/usr/bin/" + a + "\n"); }); return 0; } return callCommand(args[0], args.slice(1), io); },
    sudo(args, io) { return callCommand(args[0], args.slice(1), io); },
    env(args, io) { Object.keys(S.vars).filter(k => S.exported.has(k)).forEach(k => io.out(k + "=" + getVar(k) + "\n")); return 0; },
    printenv(args, io) { if (args.length) { const v = S.exported.has(args[0]) ? getVar(args[0]) : null; if (v === null) return 1; io.out(v + "\n"); return 0; } return BUILTINS.env(args, io); },
    help(a, io) { io.out("DevPortal simulated bash. Builtins: cd pwd echo printf export read test [ [[ source exit return shift local declare ...\nCommands: ls cat grep sed awk sort uniq cut tr head tail wc find mkdir rm cp mv touch chmod date seq xargs tee ...\n"); return 0; },
    sleep(args) { S.clock += (parseFloat(args[0]) || 0); return 0; },
    history() { return 0; }, clear(a, io) { io.out("\x1bc"); return 0; },
    whoami(a, io) { io.out("user\n"); return 0; }, id(a, io) { io.out("uid=1000(user) gid=1000(user) groups=1000(user),27(sudo)\n"); return 0; },
    hostname(a, io) { io.out("devportal\n"); return 0; },
    uname(args, io) { io.out(args.includes("-a") ? "Linux devportal 6.8.0-sim #1 SMP x86_64 GNU/Linux\n" : args.includes("-r") ? "6.8.0-sim\n" : args.includes("-m") ? "x86_64\n" : "Linux\n"); return 0; },
    uptime(a, io) { io.out(" 10:42:17 up 3 days,  4:12,  1 user,  load average: 0.08, 0.03, 0.01\n"); return 0; },
    date(args, io) {
      const d = new Date(); const pad = n => String(n).padStart(2, "0"); const f = args.find(a => a[0] === "+");
      const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      if (!f) { io.out(DAYS[d.getDay()] + " " + MONTHS[d.getMonth()] + " " + String(d.getDate()).padStart(2, " ") + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) + " UTC " + d.getFullYear() + "\n"); return 0; }
      io.out(f.slice(1).replace(/%([YmdHMSjyaAbBsFTZ%])/g, (m, c) => ({ Y: d.getFullYear(), m: pad(d.getMonth() + 1), d: pad(d.getDate()), H: pad(d.getHours()), M: pad(d.getMinutes()), S: pad(d.getSeconds()), y: String(d.getFullYear()).slice(2), a: DAYS[d.getDay()], A: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getDay()], b: MONTHS[d.getMonth()], B: d.toLocaleString("en", { month: "long" }), s: Math.floor(d / 1000), F: d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()), T: pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()), Z: "UTC", j: "001", "%": "%" })[c]) + "\n"); return 0;
    },
    curl(a, io) { io.err("curl: (6) Could not resolve host — the network is disabled in this simulator\n"); return 6; },
    wget(a, io) { io.err("wget: unable to resolve host address — the network is disabled in this simulator\n"); return 4; },
    ping(a, io) { io.err("ping: network is disabled in this simulator\n"); return 2; },
    ps(a, io) { io.out("  PID TTY          TIME CMD\n 4242 pts/0    00:00:00 bash\n 4310 pts/0    00:00:00 ps\n"); return 0; },
    df(a, io) { io.out("Filesystem     1K-blocks    Used Available Use% Mounted on\n/dev/sda1       41152736 9876544  29179040  26% /\ntmpfs            1024000       0   1024000   0% /dev/shm\n"); return 0; },
    free(a, io) { io.out("               total        used        free      shared  buff/cache   available\nMem:         8167848     2103244     4210392       10236     1854212     5772648\nSwap:        2097148           0     2097148\n"); return 0; },
    man(args, io) { io.out("No manual entry for " + (args[0] || "") + " (this is a simulator — try `help`)\n"); return 16; },
    which(args, io) { let st = 0; args.forEach(a => { if (BUILTINS[a] && !COMMANDS.has(a)) io.out(a + "\n"); else if (COMMANDS.has(a)) io.out("/usr/bin/" + a + "\n"); else st = 1; }); return st; },

    ls(args, io) {
      const { o, rest } = parseOpts(args, "alRh1dtrS"); const targets = rest.length ? rest : ["."]; let st = 0;
      const entry = (n, name) => {
        if (!o.l) return name + (n.t === "d" && false ? "/" : "");
        const sz = o.h ? humanSize(sizeOf(n)) : String(sizeOf(n)); const d = new Date(2026, 10, 21, 10, 0);
        return fmtMode(n) + " " + (n.t === "d" ? " 2" : " 1") + " user user " + sz.padStart(6) + " " + MONTHS[d.getMonth()] + " " + String(d.getDate()).padStart(2) + " " + "10:00 " + name;
      };
      const listDir = (abs, label, n, showHead) => {
        let names = Object.keys(n.c); if (!o.a) names = names.filter(k => k[0] !== "."); else names = [".", ".."].concat(names);
        names.sort((a, b) => a.localeCompare(b)); if (o.t) names.sort((a, b) => 0); if (o.r) names.reverse();
        if (showHead) io.out(label + ":\n");
        const ents = names.map(k => entry(k === "." || k === ".." ? D() : n.c[k], k));
        if (o.l) { io.out("total " + Math.ceil(names.length * 4) + "\n"); ents.forEach(e => io.out(e + "\n")); }
        else if (ents.length) io.out(ents.join(o["1"] || !io.tty ? "\n" : "  ") + "\n");
        if (o.R) names.forEach(k => { if (k !== "." && k !== ".." && n.c[k].t === "d") { io.out("\n"); listDir(abs + "/" + k, label + "/" + k, n.c[k], true); } });
      };
      const files = [], dirs = [];
      targets.forEach(t => { const abs = normalize(t, S.cwd), n = lookup(S.fs, abs); if (!n) { io.err("ls: cannot access '" + t + "': No such file or directory\n"); st = 2; } else if (n.t === "d" && !o.d) dirs.push([t, abs, n]); else files.push([t, n]); });
      files.forEach(f => io.out(entry(f[1], f[0]) + "\n"));
      dirs.forEach((d, i) => { if (i > 0 || files.length) io.out("\n"); listDir(d[1], d[0], d[2], targets.length > 1 || o.R); });
      return st;
    },
    cat(args, io) {
      const { o, rest } = parseOpts(args, "nAEs"); let ln = 1;
      return filesOrStdin(rest, io, "cat", (n, t) => { if (o.n) lines(t).forEach(l => io.out(String(ln++).padStart(6) + "\t" + l + "\n")); else io.out(t); }) || 0;
    },
    tac(args, io) { return filesOrStdin(args, io, "tac", (n, t) => lines(t).reverse().forEach(l => io.out(l + "\n"))) || 0; },
    mkdir(args, io) {
      const { o, rest } = parseOpts(args, "pv"); let st = 0;
      rest.forEach(a => {
        const abs = normalize(a, S.cwd), parts = splitPath(abs); let n = S.fs;
        parts.forEach((s, i) => {
          if (!n) return;
          if (!(s in n.c)) { if (i < parts.length - 1 && !o.p) { io.err("mkdir: cannot create directory '" + a + "': No such file or directory\n"); st = 1; n = null; return; } n.c[s] = D(); }
          else if (i === parts.length - 1 && !o.p) { io.err("mkdir: cannot create directory '" + a + "': File exists\n"); st = 1; }
          if (n) n = n.c[s];
        });
      });
      return st;
    },
    rmdir(args, io) { let st = 0; args.forEach(a => { const pr = parentOf(S.fs, normalize(a, S.cwd)), n = pr.dir && pr.dir.c[pr.name]; if (!n) { io.err("rmdir: failed to remove '" + a + "': No such file or directory\n"); st = 1; } else if (n.t !== "d") { io.err("rmdir: failed to remove '" + a + "': Not a directory\n"); st = 1; } else if (Object.keys(n.c).length) { io.err("rmdir: failed to remove '" + a + "': Directory not empty\n"); st = 1; } else delete pr.dir.c[pr.name]; }); return st; },
    touch(args, io) {
      let st = 0;
      args.filter(a => a[0] !== "-").forEach(a => {
        const abs = normalize(a, S.cwd), pr = parentOf(S.fs, abs);
        if (!pr.dir || pr.dir.t !== "d") { io.err("touch: cannot touch '" + a + "': No such file or directory\n"); st = 1; return; }
        if (!pr.dir.c[pr.name]) pr.dir.c[pr.name] = F("");
      });
      return st;
    },
    rm(args, io) {
      const { o, rest } = parseOpts(args, "rfiv"); let st = 0;
      rest.forEach(a => {
        const abs = normalize(a, S.cwd);
        if (abs === "/") { io.err("rm: it is dangerous to operate recursively on '/' (simulator says no)\n"); st = 1; return; }
        const pr = parentOf(S.fs, abs), n = pr.dir && pr.dir.c[pr.name];
        if (!n) { if (!o.f) { io.err("rm: cannot remove '" + a + "': No such file or directory\n"); st = 1; } return; }
        if (n.t === "d" && !o.r) { io.err("rm: cannot remove '" + a + "': Is a directory\n"); st = 1; return; }
        delete pr.dir.c[pr.name]; if (o.v) io.out("removed '" + a + "'\n");
      });
      return st;
    },
    cp(args, io) {
      const { o, rest } = parseOpts(args, "rRfv"); if (rest.length < 2) { io.err("cp: missing file operand\n"); return 1; }
      const dst = rest.pop(), dabs = normalize(dst, S.cwd), dn = lookup(S.fs, dabs); let st = 0;
      const clone = n => JSON.parse(JSON.stringify(n));
      if (rest.length > 1 && !(dn && dn.t === "d")) { io.err("cp: target '" + dst + "' is not a directory\n"); return 1; }
      rest.forEach(a => {
        const n = lookup(S.fs, normalize(a, S.cwd));
        if (!n) { io.err("cp: cannot stat '" + a + "': No such file or directory\n"); st = 1; return; }
        if (n.t === "d" && !(o.r || o.R)) { io.err("cp: -r not specified; omitting directory '" + a + "'\n"); st = 1; return; }
        if (dn && dn.t === "d") dn.c[a.split("/").filter(Boolean).pop()] = clone(n);
        else { const pr = parentOf(S.fs, dabs); if (!pr.dir) { io.err("cp: cannot create regular file '" + dst + "': No such file or directory\n"); st = 1; return; } pr.dir.c[pr.name] = clone(n); }
        if (o.v) io.out("'" + a + "' -> '" + dst + "'\n");
      });
      return st;
    },
    mv(args, io) {
      const { rest } = parseOpts(args, "fiv"); if (rest.length < 2) { io.err("mv: missing file operand\n"); return 1; }
      const dst = rest.pop(), dabs = normalize(dst, S.cwd), dn = lookup(S.fs, dabs); let st = 0;
      if (rest.length > 1 && !(dn && dn.t === "d")) { io.err("mv: target '" + dst + "' is not a directory\n"); return 1; }
      rest.forEach(a => {
        const sp = parentOf(S.fs, normalize(a, S.cwd)), n = sp.dir && sp.dir.c[sp.name];
        if (!n) { io.err("mv: cannot stat '" + a + "': No such file or directory\n"); st = 1; return; }
        delete sp.dir.c[sp.name];
        if (dn && dn.t === "d") dn.c[sp.name] = n; else { const dp = parentOf(S.fs, dabs); if (!dp.dir) { sp.dir.c[sp.name] = n; io.err("mv: cannot move '" + a + "' to '" + dst + "': No such file or directory\n"); st = 1; return; } dp.dir.c[dp.name] = n; }
      });
      return st;
    },
    chmod(args, io) {
      const m = args[0]; let st = 0;
      args.slice(1).forEach(a => {
        const n = lookup(S.fs, normalize(a, S.cwd)); if (!n) { io.err("chmod: cannot access '" + a + "': No such file or directory\n"); st = 1; return; }
        if (/^[0-7]{3,4}$/.test(m)) n.m = parseInt(m, 8);
        else { const mm = /^([ugoa]*)([-+=])([rwx]+)$/.exec(m); if (!mm) { io.err("chmod: invalid mode: '" + m + "'\n"); st = 1; return; } let bits = 0; for (const ch of mm[3]) bits |= ch === "r" ? 4 : ch === "w" ? 2 : 1; const who = mm[1] || "a"; let mask = 0; if (who.includes("u") || who.includes("a")) mask |= bits << 6; if (who.includes("g") || who.includes("a")) mask |= bits << 3; if (who.includes("o") || who.includes("a")) mask |= bits; n.m = mm[2] === "+" ? n.m | mask : mm[2] === "-" ? n.m & ~mask : mask; }
      });
      return st;
    },
    head(args, io) {
      const { o, rest } = parseOpts(args, "n:c:#"); const n = o.n !== undefined ? +o.n : o.num !== undefined ? o.num : 10;
      const multi = rest.length > 1;
      return filesOrStdin(rest, io, "head", (nm, t) => { if (multi) io.out("==> " + nm + " <==\n"); if (o.c !== undefined) io.out(t.slice(0, +o.c)); else lines(t).slice(0, n).forEach(l => io.out(l + "\n")); }) || 0;
    },
    tail(args, io) {
      const { o, rest } = parseOpts(args, "n:c:f#"); let n = o.n !== undefined ? o.n : o.num !== undefined ? o.num : 10; const multi = rest.length > 1;
      return filesOrStdin(rest, io, "tail", (nm, t) => { if (multi) io.out("==> " + nm + " <==\n"); const L = lines(t); const out = String(n)[0] === "+" ? L.slice(+String(n).slice(1) - 1) : L.slice(Math.max(0, L.length - +n)); out.forEach(l => io.out(l + "\n")); }) || 0;
    },
    wc(args, io) {
      const { o, rest } = parseOpts(args, "lwcm"); const all = !o.l && !o.w && !o.c && !o.m; const tot = [0, 0, 0];
      const fmt = (a, name) => { const parts = []; if (all || o.l) parts.push(a[0]); if (all || o.w) parts.push(a[1]); if (all || o.c || o.m) parts.push(a[2]); return (rest.length || !all ? parts.map(x => String(x).padStart(all ? 7 : 1)).join(" ") : parts.map(x => String(x).padStart(7)).join(" ")) + (name && name !== "-" ? " " + name : "") + "\n"; };
      const st = filesOrStdin(rest, io, "wc", (nm, t) => { const a = [(t.match(/\n/g) || []).length, (t.trim() ? t.trim().split(/\s+/).length : 0), t.length]; a.forEach((x, i) => tot[i] += x); io.out(fmt(a, nm)); });
      if (rest.length > 1) io.out(fmt(tot, "total"));
      return st || 0;
    },
    grep(args, io) {
      const { o, rest } = parseOpts(args, "invcrRlHhEeF:qwoA:B:C:s"); let pat = o.e !== undefined ? o.e : rest.shift();
      if (pat === undefined) { io.err("Usage: grep [OPTION]... PATTERNS [FILE]...\n"); return 2; }
      const fl = o.i ? "i" : ""; let re;
      if (o.F) re = new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), fl);
      else { if (o.w) pat = "\\b(?:" + pat + ")\\b"; re = mkRe(pat, !!o.E, fl); }
      let files = rest; if ((o.r || o.R) && !files.length) files = ["."];
      const expanded = [];
      files.forEach(f => { const abs = normalize(f, S.cwd), n = lookup(S.fs, abs); if (n && n.t === "d" && (o.r || o.R)) { const l = []; walk(abs, f === "." ? "." : f, l); l.forEach(x => expanded.push(x)); } else expanded.push([f, null]); });
      function walk(abs, disp, out) { const n = lookup(S.fs, abs); Object.keys(n.c).sort().forEach(k => { const c = n.c[k], p = abs === "/" ? "/" + k : abs + "/" + k, d = disp === "." ? k : disp + "/" + k; if (c.t === "d") walk(p, d, out); else out.push([d, c]); }); }
      const multi = (expanded.length > 1 || o.r || o.R) && !o.h; let found = false, st = 0;
      const doText = (name, t) => {
        let cnt = 0; const L = lines(t);
        L.forEach((l, i) => {
          const m = re.test(l); re.lastIndex = 0;
          if (m === !o.v) {
            cnt++; found = true; if (o.q) return;
            if (o.l || o.c) return;
            if (o.o) { const g = new RegExp(re.source, fl + "g"); (l.match(g) || []).forEach(x => io.out((multi ? name + ":" : "") + (o.n ? (i + 1) + ":" : "") + x + "\n")); }
            else io.out((multi ? name + ":" : "") + (o.n ? (i + 1) + ":" : "") + l + "\n");
          }
        });
        if (o.l && cnt) io.out(name + "\n"); if (o.c) io.out((multi ? name + ":" : "") + cnt + "\n");
      };
      if (!expanded.length) doText("(standard input)", readIn(io));
      else expanded.forEach(([f, node]) => {
        if (node) return doText(f, node.d);
        if (f === "-") return doText("(standard input)", readIn(io));
        const n = lookup(S.fs, normalize(f, S.cwd)); if (!n) { if (!o.s) io.err("grep: " + f + ": No such file or directory\n"); st = 2; return; }
        if (n.t === "d") { io.err("grep: " + f + ": Is a directory\n"); return; } doText(f, n.d);
      });
      return found ? 0 : (st || 1);
    },
    sort(args, io) {
      const { o, rest } = parseOpts(args, "rnuk:t:fhb"); let all = [];
      const st = filesOrStdin(rest, io, "sort", (n, t) => { all = all.concat(lines(t)); });
      const key = l => { if (o.k === undefined) return l; const f = o.t ? l.split(o.t) : l.trim().split(/\s+/); const k = f[+String(o.k).split(",")[0].replace(/[a-z]/g, "") - 1]; return k === undefined ? "" : k; };
      all.sort((a, b) => { const x = key(a), y = key(b); let c; if (o.n || o.h) c = (parseFloat(x) || 0) - (parseFloat(y) || 0); else c = o.f ? x.toLowerCase().localeCompare(y.toLowerCase()) : (x < y ? -1 : x > y ? 1 : 0); if (c === 0 && o.k !== undefined) c = a < b ? -1 : a > b ? 1 : 0; return o.r ? -c : c; });
      if (o.u) all = all.filter((l, i) => i === 0 || key(l) !== key(all[i - 1]) || (o.n ? false : false));
      all.forEach(l => io.out(l + "\n")); return st || 0;
    },
    uniq(args, io) {
      const { o, rest } = parseOpts(args, "cdui"); let L = [];
      const st = filesOrStdin(rest.slice(0, 1), io, "uniq", (n, t) => { L = lines(t); });
      const groups = []; L.forEach(l => { const g = groups[groups.length - 1]; const eq = g && (o.i ? g.l.toLowerCase() === l.toLowerCase() : g.l === l); if (eq) g.n++; else groups.push({ l, n: 1 }); });
      groups.forEach(g => { if (o.d && g.n < 2) return; if (o.u && g.n > 1) return; io.out((o.c ? String(g.n).padStart(7) + " " : "") + g.l + "\n"); }); return st || 0;
    },
    cut(args, io) {
      const { o, rest } = parseOpts(args, "d:f:c:"); const spec = o.f || o.c; if (!spec) { io.err("cut: you must specify a list of bytes, characters, or fields\n"); return 1; }
      const ranges = spec.split(",").map(r => { const m = /^(\d*)(-?)(\d*)$/.exec(r); return [m[1] ? +m[1] : 1, m[2] ? (m[3] ? +m[3] : Infinity) : (m[1] ? +m[1] : 1)]; });
      const inR = i => ranges.some(r => i >= r[0] && i <= r[1]); const d = o.d === undefined ? "\t" : o.d;
      return filesOrStdin(rest, io, "cut", (n, t) => lines(t).forEach(l => {
        if (o.c) { io.out(Array.from(l).filter((c, i) => inR(i + 1)).join("") + "\n"); return; }
        if (!l.includes(d)) { io.out(l + "\n"); return; }
        io.out(l.split(d).filter((c, i) => inR(i + 1)).join(d) + "\n");
      })) || 0;
    },
    tr(args, io) {
      const { o, rest } = parseOpts(args, "dsc"); const exp = s => s.replace(/\[:upper:\]/g, "A-Z").replace(/\[:lower:\]/g, "a-z").replace(/\[:digit:\]/g, "0-9").replace(/\[:alpha:\]/g, "A-Za-z").replace(/\[:space:\]/g, " \t\n").replace(/\[:alnum:\]/g, "A-Za-z0-9").replace(/\[:punct:\]/g, "!-/:-@\\[-`{-~").replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/([^\\])-([^\\])/g, (m, a, b) => { let r = ""; for (let c = a.charCodeAt(0); c <= b.charCodeAt(0); c++) r += String.fromCharCode(c); return r; });
      let a = exp(rest[0] || ""), b = exp(rest[1] || ""); let t = readIn(io);
      if (o.c) { const set = a; const keep = ch => set.includes(ch); t = Array.from(t).map(ch => keep(ch) || ch === "\n" ? ch : (o.d ? "" : b[b.length - 1] || ch)).join(""); }
      else if (o.d) t = Array.from(t).filter(ch => !a.includes(ch)).join("");
      else t = Array.from(t).map(ch => { const i = a.indexOf(ch); return i < 0 ? ch : (b[Math.min(i, b.length - 1)] === undefined ? ch : b[Math.min(i, b.length - 1)]); }).join("");
      if (o.s) { const set = (b || a); t = t.replace(/(.)\1+/gs, (m, c) => set.includes(c) ? c : m); }
      io.out(t); return 0;
    },
    tee(args, io) { const { o, rest } = parseOpts(args, "a"); const t = readIn(io); io.out(t); rest.forEach(a => { const abs = normalize(a, S.cwd), pr = parentOf(S.fs, abs); if (!pr.dir) return; const f = pr.dir.c[pr.name] || (pr.dir.c[pr.name] = F("")); f.d = (o.a ? f.d : "") + t; }); return 0; },
    seq(args, io) { const n = args.map(Number); let a = 1, s = 1, b; if (n.length === 1) b = n[0]; else if (n.length === 2) { a = n[0]; b = n[1]; } else { a = n[0]; s = n[1]; b = n[2]; } if (!s) return 1; const out = []; for (let x = a; s > 0 ? x <= b : x >= b; x += s) { out.push(x); if (out.length > 100000) break; } out.forEach(x => io.out(x + "\n")); return 0; },
    basename(args, io) { let b = args[0].replace(/\/+$/, "").split("/").pop() || "/"; if (args[1] && b.endsWith(args[1]) && b !== args[1]) b = b.slice(0, -args[1].length); io.out(b + "\n"); return 0; },
    dirname(args, io) { const p = args[0].replace(/\/+$/, ""); const i = p.lastIndexOf("/"); io.out((i < 0 ? "." : i === 0 ? "/" : p.slice(0, i)) + "\n"); return 0; },
    expr(args, io) { try { const e = args.join(" ").replace(/\\([()*])/g, "$1"); io.out(String(arith(e, getVar, setVar)) + "\n"); return 0; } catch (x) { io.err("expr: syntax error\n"); return 2; } },
    let(args) { let v = 0; args.forEach(a => { v = arith(a, getVar, setVar); }); return v ? 0 : 1; },
    yes(args, io) { const s = (args.join(" ") || "y") + "\n"; io.out(s.repeat(20)); return 0; },
    rev(args, io) { return filesOrStdin(args, io, "rev", (n, t) => lines(t).forEach(l => io.out(Array.from(l).reverse().join("") + "\n"))) || 0; },
    nl(args, io) { let i = 1; return filesOrStdin(args, io, "nl", (n, t) => lines(t).forEach(l => io.out(String(i++).padStart(6) + "\t" + l + "\n"))) || 0; },
    paste(args, io) { const { o, rest } = parseOpts(args, "d:s"); const d = o.d || "\t"; const cols = []; filesOrStdin(rest, io, "paste", (n, t) => cols.push(lines(t))); if (o.s) { cols.forEach(c => io.out(c.join(d) + "\n")); return 0; } const mx = Math.max(0, ...cols.map(c => c.length)); for (let i = 0; i < mx; i++) io.out(cols.map(c => c[i] === undefined ? "" : c[i]).join(d) + "\n"); return 0; },
    diff(args, io) { const a = lookup(S.fs, normalize(args[0], S.cwd)), b = lookup(S.fs, normalize(args[1], S.cwd)); if (!a || !b) { io.err("diff: No such file or directory\n"); return 2; } if (a.d === b.d) return 0; const A = lines(a.d), B = lines(b.d); const mx = Math.max(A.length, B.length); for (let i = 0; i < mx; i++) if (A[i] !== B[i]) { if (A[i] !== undefined) io.out("< " + A[i] + "\n"); if (A[i] !== undefined && B[i] !== undefined) io.out("---\n"); if (B[i] !== undefined) io.out("> " + B[i] + "\n"); } return 1; },
    stat(args, io) { let st = 0; args.forEach(a => { const n = lookup(S.fs, normalize(a, S.cwd)); if (!n) { io.err("stat: cannot statx '" + a + "': No such file or directory\n"); st = 1; return; } io.out("  File: " + a + "\n  Size: " + sizeOf(n) + "\tType: " + (n.t === "d" ? "directory" : "regular file") + "\nAccess: (" + n.m.toString(8).padStart(4, "0") + "/" + fmtMode(n) + ")  Uid: ( 1000/ user)\n"); }); return st; },
    tree(args, io) {
      const abs = normalize(args[0] || ".", S.cwd), n = lookup(S.fs, abs); if (!n) { io.err(args[0] + " [error opening dir]\n"); return 2; }
      io.out((args[0] || ".") + "\n"); let d = 0, f = 0;
      const walk = (node, pre) => { const ks = Object.keys(node.c).filter(k => k[0] !== ".").sort(); ks.forEach((k, i) => { const last = i === ks.length - 1; io.out(pre + (last ? "└── " : "├── ") + k + "\n"); if (node.c[k].t === "d") { d++; walk(node.c[k], pre + (last ? "    " : "│   ")); } else f++; }); };
      if (n.t === "d") walk(n, ""); io.out("\n" + d + " directories, " + f + " files\n"); return 0;
    },
    find(args, io) {
      let i = 0; const starts = []; while (i < args.length && args[i][0] !== "-" && args[i] !== "!" && args[i] !== "(") starts.push(args[i++]); if (!starts.length) starts.push(".");
      const preds = []; let action = null, maxd = Infinity, mind = 0;
      for (; i < args.length; i++) {
        const a = args[i];
        if (a === "-name" || a === "-iname") { const re = globToRe(args[++i]); const ci = a === "-iname"; const r2 = ci ? new RegExp(re.source, "is") : re; preds.push((n, nm) => r2.test(nm)); }
        else if (a === "-type") { const t = args[++i]; preds.push(n => (t === "d" ? n.t === "d" : n.t === "f")); }
        else if (a === "-maxdepth") maxd = +args[++i]; else if (a === "-mindepth") mind = +args[++i];
        else if (a === "-size") { const m = /^([+-]?)(\d+)([ckMG]?)$/.exec(args[++i]); const mul = { "": 512, c: 1, k: 1024, M: 1048576, G: 1073741824 }[m[3]]; preds.push(n => { const sz = n.t === "f" ? n.d.length : 4096; return m[1] === "+" ? sz > +m[2] * mul : m[1] === "-" ? sz < +m[2] * mul : Math.ceil(sz / mul) === +m[2]; }); }
        else if (a === "-empty") preds.push(n => (n.t === "f" ? n.d === "" : !Object.keys(n.c).length));
        else if (a === "-print") action = "print"; else if (a === "-delete") action = "delete";
        else if (a === "-exec") { const cmd = []; i++; while (i < args.length && args[i] !== ";" && args[i] !== "+") cmd.push(args[i++]); action = { exec: cmd }; }
        else if (a === "!" || a === "-not") { const nx = preds.length; /* negate next */ args[i + 1] && (function () { })(); preds.negateNext = true; }
        else if (a === "-o" || a === "-a" || a === "-and") { /* implicit and */ }
      }
      starts.forEach(st => {
        const abs = normalize(st, S.cwd), root = lookup(S.fs, abs); if (!root) { io.err("find: '" + st + "': No such file or directory\n"); return; }
        const visit = (n, p, disp, depth) => {
          const nm = disp.split("/").pop() || disp;
          if (depth >= mind && preds.every(f => f(n, nm))) {
            if (action && action.exec) { const c = action.exec.map(x => x === "{}" ? disp : x); callCommand(c[0], c.slice(1), io); }
            else if (action === "delete") { if (depth > 0) { const pr = parentOf(S.fs, p); delete pr.dir.c[pr.name]; } }
            else io.out(disp + "\n");
          }
          if (n.t === "d" && depth < maxd) Object.keys(n.c).sort().forEach(k => visit(n.c[k], (p === "/" ? "" : p) + "/" + k, disp + (disp.endsWith("/") ? "" : "/") + k, depth + 1));
        };
        visit(root, abs, st, 0);
      });
      return 0;
    },
    xargs(args, io) {
      const { o, rest } = parseOpts(args, "n:I:0"); const items = readIn(io).split(/\s+/).filter(Boolean); const cmd = rest.length ? rest : ["echo"];
      if (o.I) { items.forEach(it => callCommand(cmd[0], cmd.slice(1).map(x => x.split(o.I).join(it)), io)); return 0; }
      const n = o.n ? +o.n : items.length || 1; if (!items.length) { callCommand(cmd[0], cmd.slice(1), io); return 0; }
      for (let i = 0; i < items.length; i += n) callCommand(cmd[0], cmd.slice(1).concat(items.slice(i, i + n)), io); return 0;
    },
    sed(args, io) {
      const { o, rest } = parseOpts(args, "nie:Er"); const scripts = []; if (o.e !== undefined) scripts.push(o.e); else if (rest.length) scripts.push(rest.shift());
      const cmds = [];
      scripts.join("\n").split(/\n|;(?![^{]*})/).map(s => s.trim()).filter(Boolean).forEach(s => {
        let m = /^(?:(\d+|\$|\/(?:[^\/\\]|\\.)*\/)(?:,(\d+|\$|\/(?:[^\/\\]|\\.)*\/))?)?\s*(!?)\s*(s|d|p|q|y|a|i)(.*)$/s.exec(s);
        if (!m) throw new ShellError("sed: -e expression #1: unknown command: `" + s + "'");
        const c = { a1: m[1], a2: m[2], neg: !!m[3], cmd: m[4], rest: m[5] };
        if (c.cmd === "s") { const dl = c.rest[0]; const parts = []; let cur = "", k = 1; for (; k < c.rest.length; k++) { const ch = c.rest[k]; if (ch === "\\" && k + 1 < c.rest.length) { cur += ch + c.rest[++k]; continue; } if (ch === dl) { parts.push(cur); cur = ""; if (parts.length === 2) break; continue; } cur += ch; } const flags = c.rest.slice(k + 1).trim(); c.re = mkRe(parts[0].split("\\" + dl).join(dl), !!o.E, (flags.includes("g") ? "g" : "") + (flags.includes("i") || flags.includes("I") ? "i" : "")); c.rep = (parts[1] || "").split("\\" + dl).join(dl); c.p = flags.includes("p"); }
        if (c.cmd === "y") { const dl = c.rest[0]; const [a, b] = c.rest.slice(1).split(dl); c.map = [a, b]; }
        if (c.cmd === "a" || c.cmd === "i") c.text = c.rest.replace(/^\\?\s?/, "");
        cmds.push(c);
      });
      const addrOk = (a, ln, total, l) => a === undefined ? true : a === "$" ? ln === total : /^\d+$/.test(a) ? ln === +a : mkRe(a.slice(1, -1), !!o.E).test(l);
      const proc = (t, name) => {
        const L = lines(t), outL = []; const total = L.length; const ranges = cmds.map(() => ({ on: false }));
        for (let idx = 0; idx < L.length; idx++) {
          let l = L[idx], ln = idx + 1, deleted = false, printed = false, quit = false;
          for (let ci = 0; ci < cmds.length; ci++) {
            const c = cmds[ci]; let sel;
            if (c.a2 === undefined) sel = addrOk(c.a1, ln, total, l);
            else { const r = ranges[ci]; if (!r.on) { if (addrOk(c.a1, ln, total, l)) { r.on = true; sel = true; if (addrOk(c.a2, ln, total, l) && /^\d+$/.test(c.a2) === false && false) r.on = false; if (/^\d+$/.test(c.a2) && ln >= +c.a2) r.on = false; } else sel = false; } else { sel = true; if (addrOk(c.a2, ln, total, l)) r.on = false; } }
            if (c.neg) sel = !sel; if (!sel) continue;
            if (c.cmd === "d") { deleted = true; break; }
            if (c.cmd === "p") { outL.push(l); }
            if (c.cmd === "q") { quit = true; break; }
            if (c.cmd === "y") { l = Array.from(l).map(ch => { const k = c.map[0].indexOf(ch); return k < 0 ? ch : c.map[1][k]; }).join(""); }
            if (c.cmd === "a") { outL.push(null); outL.push({ after: c.text }); }
            if (c.cmd === "i") outL.push(c.text);
            if (c.cmd === "s") { const before = l; l = l.replace(c.re, (...mm) => { const groups = mm.slice(0, -2); return c.rep.replace(/\\(\d)|&|\\n|\\&/g, (x, d) => x === "&" ? groups[0] : x === "\\&" ? "&" : x === "\\n" ? "\n" : groups[+d] === undefined ? "" : groups[+d]); }); if (c.p && before !== l) outL.push(l); }
          }
          if (!deleted && !o.n) outL.push(l);
          if (outL.length && outL[outL.length - 1] === null) { /* marker for append */ }
          if (quit) break;
        }
        const res = []; outL.forEach(x => { if (x === null) return; if (x && x.after !== undefined) { res.push(x.after); return; } res.push(x); });
        return res.map(x => x + "\n").join("");
      };
      if (o.i) { let st = 0; rest.forEach(a => { const f = lookup(S.fs, normalize(a, S.cwd)); if (!f) { io.err("sed: can't read " + a + ": No such file or directory\n"); st = 2; return; } f.d = proc(f.d, a); }); return st; }
      return filesOrStdin(rest, io, "sed", (n, t) => io.out(proc(t, n))) || 0;
    },
    awk(args, io) {
      let fsep = null; const vars = {}; const rest = [];
      for (let i = 0; i < args.length; i++) { const a = args[i]; if (a === "-F") fsep = args[++i]; else if (a.startsWith("-F")) fsep = a.slice(2); else if (a === "-v") { const kv = args[++i].split("="); vars[kv[0]] = kv.slice(1).join("="); } else rest.push(a); }
      const prog = rest.shift(); if (prog === undefined) { io.err("usage: awk [-F fs] 'program' [file ...]\n"); return 2; }
      const rules = awkParse(prog); const V = Object.assign({ NR: 0, NF: 0, FS: fsep === null ? " " : fsep, OFS: " ", ORS: "\n" }, vars);
      if (fsep !== null) V.FS = fsep === "\\t" ? "\t" : fsep;
      let row = [""]; let exitNow = false;
      const ctx = { V, get: i => (i === 0 ? row[0] : row[i] === undefined ? "" : row[i]), out: t => io.out(t), setRow: r => { row = r; V.NF = r.length - 1; } };
      try {
        rules.filter(r => r.begin).forEach(r => awkRun(r.body, ctx));
        const handle = (name, t) => { for (const l of lines(t)) { V.NR++; const fields = V.FS === " " ? l.trim().split(/\s+/).filter(x => x !== "") : (V.FS.length === 1 ? l.split(V.FS) : l.split(mkRe(V.FS, true))); row = [l].concat(fields); V.NF = fields.length; for (const r of rules) { if (r.begin || r.end) continue; if (r.pat === null || awkTruthy(awkEval(r.pat, ctx))) { awkRun(r.body, ctx); } } } };
        const st = filesOrStdin(rest, io, "awk", handle);
        rules.filter(r => r.end).forEach(r => awkRun(r.body, ctx));
        return st || 0;
      } catch (e) { if (e instanceof ShellError) { io.err("awk: " + e.message + "\n"); return 2; } throw e; }
    },
    jq(a, io) { io.err("jq: not installed in this simulator\n"); return 127; },
    nano(a, io) { io.err("nano: interactive editors are not available — use echo/cat/printf with > redirection\n"); return 1; },
    vi(a, io) { return BUILTINS.nano(a, io); }, vim(a, io) { return BUILTINS.nano(a, io); }
  };
  const COMMANDS = new Set(Object.keys(BUILTINS).filter(k => !["cd", "export", "unset", "local", "declare", "readonly", "shift", "set", "trap", "shopt", "umask", "alias", "hash", "exit", "return", "break", "continue", "source", ".", "eval", ":", "true", "false", "[", "test", "read", "type", "command", "help"].includes(k)).concat(["true", "false", "test", "["]));

  /* ---- awk mini-language ---- */
  function awkParse(src) {
    const rules = []; let i = 0; const ws = () => { while (i < src.length && /[\s;]/.test(src[i])) i++; };
    function block() {   // at "{"
      let d = 0, j = i;
      for (; j < src.length; j++) { const c = src[j]; if (c === '"') { j++; while (j < src.length && src[j] !== '"') { if (src[j] === "\\") j++; j++; } } else if (c === "{") d++; else if (c === "}") { d--; if (d === 0) break; } }
      const body = src.slice(i + 1, j); i = j + 1; return body;
    }
    while (ws(), i < src.length) {
      if (src.startsWith("BEGIN", i)) { i += 5; ws(); rules.push({ begin: true, body: block() }); continue; }
      if (src.startsWith("END", i)) { i += 3; ws(); rules.push({ end: true, body: block() }); continue; }
      let pat = null;
      if (src[i] !== "{") { let j = i, d = 0; for (; j < src.length; j++) { const c = src[j]; if (c === "/" && (j === i || /[\s(!~&|,]/.test(src[j - 1]))) { j++; while (j < src.length && src[j] !== "/") { if (src[j] === "\\") j++; j++; } continue; } if (c === '"') { j++; while (j < src.length && src[j] !== '"') { if (src[j] === "\\") j++; j++; } continue; } if (c === "(") d++; if (c === ")") d--; if (c === "{" && d === 0) break; if (c === "\n" && d === 0) break; } pat = src.slice(i, j).trim(); i = j; ws(); }
      const body = i < src.length && src[i] === "{" ? block() : "print";
      rules.push({ pat: pat === null ? null : awkParseExpr(pat), body });
    }
    return rules;
  }
  function awkTruthy(v) { return typeof v === "number" ? v !== 0 : v !== "" && v !== "0" ; }
  function awkNum(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
  const exprCache = {};
  function awkParseExpr(src) {
    if (exprCache[src]) return exprCache[src];
    const toks = []; const re = /\s*(\d+\.?\d*|"(?:[^"\\]|\\.)*"|\/(?:[^\/\\]|\\.)+\/|\$|\+\+|--|\+=|-=|\*=|\/=|%=|==|!=|<=|>=|&&|\|\||!~|~|[-+*\/%<>!=(),?:\[\]^]|[A-Za-z_][A-Za-z0-9_]*)/y; let m; re.lastIndex = 0;
    while (re.lastIndex < src.length && (m = re.exec(src))) toks.push(m[1]);
    if (re.lastIndex < src.trimEnd().length) { /* trailing junk */ }
    let p = 0; const pk = () => toks[p], nx = () => toks[p++];
    function prim() {
      const t = nx(); if (t === undefined) throw new ShellError("syntax error in awk expression");
      if (t === "(") { const e = ternary(); nx(); return e; }
      if (t === "!") return { op: "!", a: prim() }; if (t === "-") return { op: "neg", a: prim() }; if (t === "+") return prim();
      if (t === "$") return { op: "field", a: prim() };
      if (t === "++" || t === "--") { const v = prim(); return { op: "preinc", d: t === "++" ? 1 : -1, v }; }
      if (/^\d/.test(t)) return { op: "num", v: parseFloat(t) };
      if (t[0] === '"') return { op: "str", v: t.slice(1, -1).replace(/\\(.)/g, (m, c) => c === "n" ? "\n" : c === "t" ? "\t" : c) };
      if (t[0] === "/") return { op: "re", v: mkRe(t.slice(1, -1), true) };
      if (/^[A-Za-z_]/.test(t)) {
        if (pk() === "(") { nx(); const a = []; if (pk() !== ")") { for (;;) { a.push(ternary()); if (pk() === ",") { nx(); continue; } break; } } nx(); return { op: "call", name: t, a }; }
        if (pk() === "[") { nx(); const k = ternary(); nx(); return { op: "idx", name: t, k }; }
        if (pk() === "++" || pk() === "--") { const d = nx() === "++" ? 1 : -1; return { op: "postinc", d, v: { op: "var", name: t } }; }
        return { op: "var", name: t };
      }
      throw new ShellError("unexpected token " + t + " in awk expression");
    }
    const levels = [["^"], ["*", "/", "%"], ["+", "-"], ["<", "<=", ">", ">=", "==", "!="], ["~", "!~"], ["&&"], ["||"]];
    function bin(k) {
      if (k < 0) return prim();
      let l = bin(k - 1);
      for (;;) {
        if (k === 2 || false) { }
        const t = pk(); if (levels[k].includes(t)) { nx(); const r = bin(k - 1); l = { op: "bin", o: t, l, r }; } else if (k === 2 && t !== undefined && /^[A-Za-z_"$\d(]/.test(t) && false) { } else break;
      }
      return l;
    }
    function concat() { let l = bin(levels.length - 1); while (pk() !== undefined && /^(?:["$\d]|[A-Za-z_])/.test(pk()) && !["in"].includes(pk())) { const r = bin(levels.length - 1); l = { op: "cat", l, r }; } return l; }
    function ternary() { const c = concat(); if (pk() === "?") { nx(); const a = ternary(); nx(); const b = ternary(); return { op: "tern", c, a, b }; } return c; }
    function assignE() { const l = ternary(); if (["=", "+=", "-=", "*=", "/=", "%="].includes(pk())) { const o = nx(); return { op: "asg", o, l, r: assignE() }; } return l; }
    const e = assignE(); exprCache[src] = e; return e;
  }
  function awkEval(e, c) {
    switch (e.op) {
      case "num": return e.v; case "str": return e.v;
      case "re": return c.get(0) !== undefined && e.v.test(c.get(0)) ? 1 : 0;
      case "var": { const v = c.V[e.name]; return v === undefined ? "" : v; }
      case "idx": { const a = c.V["__a_" + e.name] || {}; const v = a[awkStr(awkEval(e.k, c))]; return v === undefined ? "" : v; }
      case "field": return c.get(Math.floor(awkNum(awkEval(e.a, c))));
      case "neg": return -awkNum(awkEval(e.a, c)); case "!": return awkTruthy(awkEval(e.a, c)) ? 0 : 1;
      case "cat": return awkStr(awkEval(e.l, c)) + awkStr(awkEval(e.r, c));
      case "tern": return awkTruthy(awkEval(e.c, c)) ? awkEval(e.a, c) : awkEval(e.b, c);
      case "preinc": case "postinc": { const cur = awkNum(awkEval(e.v, c)); awkAssign(e.v, cur + e.d, c); return e.op === "preinc" ? cur + e.d : cur; }
      case "asg": { const r = awkEval(e.r, c); let v = r; if (e.o !== "=") { const cur = awkNum(awkEval(e.l, c)), rv = awkNum(r); v = e.o === "+=" ? cur + rv : e.o === "-=" ? cur - rv : e.o === "*=" ? cur * rv : e.o === "/=" ? cur / rv : cur % rv; } awkAssign(e.l, v, c); return v; }
      case "bin": {
        if (e.o === "&&") return awkTruthy(awkEval(e.l, c)) && awkTruthy(awkEval(e.r, c)) ? 1 : 0;
        if (e.o === "||") return awkTruthy(awkEval(e.l, c)) || awkTruthy(awkEval(e.r, c)) ? 1 : 0;
        if (e.o === "~" || e.o === "!~") { const s = awkStr(awkEval(e.l, c)); const rhs = e.r.op === "re" ? e.r.v : mkRe(awkStr(awkEval(e.r, c)), true); const m = rhs.test(s); return (e.o === "~" ? m : !m) ? 1 : 0; }
        const a = awkEval(e.l, c), b = awkEval(e.r, c);
        const numeric = x => typeof x === "number" || (x !== "" && !isNaN(Number(x)));
        switch (e.o) {
          case "+": return awkNum(a) + awkNum(b); case "-": return awkNum(a) - awkNum(b); case "*": return awkNum(a) * awkNum(b);
          case "/": if (awkNum(b) === 0) throw new ShellError("division by zero"); return awkNum(a) / awkNum(b); case "%": return awkNum(a) % awkNum(b); case "^": return Math.pow(awkNum(a), awkNum(b));
          default: { const useNum = numeric(a) && numeric(b); const x = useNum ? awkNum(a) : awkStr(a), y = useNum ? awkNum(b) : awkStr(b); return (e.o === "<" ? x < y : e.o === "<=" ? x <= y : e.o === ">" ? x > y : e.o === ">=" ? x >= y : e.o === "==" ? x === y : x !== y) ? 1 : 0; }
        }
      }
      case "call": {
        const a = e.a.map(x => awkEval(x, c)); const s0 = awkStr(a[0]);
        switch (e.name) {
          case "length": return e.a.length ? s0.length : c.get(0).length; case "toupper": return s0.toUpperCase(); case "tolower": return s0.toLowerCase();
          case "substr": { const st = Math.max(1, Math.floor(awkNum(a[1]))); return a[2] === undefined ? s0.slice(st - 1) : s0.substr(st - 1, Math.floor(awkNum(a[2]))); }
          case "index": return s0.indexOf(awkStr(a[1])) + 1; case "int": return Math.trunc(awkNum(a[0])); case "sqrt": return Math.sqrt(awkNum(a[0]));
          case "sprintf": return fmtPrintf(s0, a.slice(1).map(awkStr)); case "split": { const parts = s0.split(a[2] === undefined ? /\s+/ : awkStr(a[2])); const arr = {}; parts.forEach((x, i) => arr[i + 1] = x); if (e.a[1] && e.a[1].op === "var") c.V["__a_" + e.a[1].name] = arr; return parts.length; }
          case "sub": case "gsub": { const re = e.a[0].op === "re" ? e.a[0].v : mkRe(awkStr(a[0]), true); const g = new RegExp(re.source, e.name === "gsub" ? "g" : ""); const target = e.a[2] || { op: "field", a: { op: "num", v: 0 } }; const cur = awkStr(awkEval(target, c)); let n = 0; const res = cur.replace(g, m => { n++; return awkStr(a[1]).replace(/&/g, m); }); awkAssign(target, res, c); return n; }
          default: throw new ShellError("function " + e.name + " not defined");
        }
      }
    }
    return "";
  }
  function awkStr(v) { return typeof v === "number" ? (Number.isInteger(v) ? String(v) : String(+v.toPrecision(6))) : String(v); }
  function awkAssign(l, v, c) {
    if (l.op === "var") { c.V[l.name] = v; return; }
    if (l.op === "idx") { const k = "__a_" + l.name; c.V[k] = c.V[k] || {}; c.V[k][awkStr(awkEval(l.k, c))] = v; return; }
    if (l.op === "field") { const i = Math.floor(awkNum(awkEval(l.a, c))); const row = [c.get(0)]; for (let k = 1; k <= c.V.NF; k++) row.push(c.get(k)); if (i === 0) { c.setRow([awkStr(v)].concat(awkStr(v).trim().split(/\s+/))); return; } while (row.length <= i) row.push(""); row[i] = awkStr(v); row[0] = row.slice(1).join(c.V.OFS); c.setRow(row); return; }
  }
  function awkRun(body, c) {
    // split statements on ; or newline outside quotes/parens/braces
    const stmts = []; let d = 0, cur = "", q = null, rx = false;
    for (let i = 0; i < body.length; i++) { const ch = body[i]; if (q) { cur += ch; if (ch === "\\") cur += body[++i]; else if (ch === q) q = null; continue; } if (ch === '"') { q = ch; cur += ch; continue; } if (ch === "(" || ch === "{") d++; if (ch === ")" || ch === "}") d--; if ((ch === ";" || ch === "\n") && d === 0) { if (cur.trim()) stmts.push(cur.trim()); cur = ""; } else cur += ch; }
    if (cur.trim()) stmts.push(cur.trim());
    for (const s of stmts) awkStmt(s, c);
  }
  function awkStmt(s, c) {
    let m;
    if ((m = /^if\s*\(([\s\S]*?)\)\s*([\s\S]*?)(?:\s+else\s+([\s\S]*))?$/.exec(s)) && s.startsWith("if")) { if (awkTruthy(awkEval(awkParseExpr(m[1]), c))) awkRun(m[2].replace(/^\{|\}$/g, ""), c); else if (m[3]) awkRun(m[3].replace(/^\{|\}$/g, ""), c); return; }
    if ((m = /^for\s*\(\s*(\w+)\s+in\s+(\w+)\s*\)\s*([\s\S]*)$/.exec(s))) { const arr = c.V["__a_" + m[2]] || {}; Object.keys(arr).forEach(k => { c.V[m[1]] = k; awkRun(m[3].replace(/^\{|\}$/g, ""), c); }); return; }
    if ((m = /^printf\s*\(?([\s\S]*?)\)?$/.exec(s)) && s.startsWith("printf")) { const parts = awkSplitArgs(m[1]).map(x => awkEval(awkParseExpr(x), c)); c.out(fmtPrintf(awkStr(parts[0]), parts.slice(1).map(awkStr))); return; }
    if (s === "print" || s.startsWith("print ") || s.startsWith("print(")) {
      const argsrc = s.slice(5).trim(); let target = null; let a = argsrc;
      const gt = awkFindRedirect(a); if (gt >= 0) { a = a.slice(0, gt).trim(); }
      const parts = a ? awkSplitArgs(a.replace(/^\(([\s\S]*)\)$/, "$1")).map(x => awkStr(awkEval(awkParseExpr(x), c))) : [c.get(0)];
      c.out(parts.join(c.V.OFS) + c.V.ORS); return;
    }
    if (s === "next") throw new ShellError("next is not supported"); if (s.startsWith("exit")) throw new Exit(0);
    awkEval(awkParseExpr(s), c);
  }
  function awkSplitArgs(s) { const out = []; let d = 0, cur = "", q = null; for (let i = 0; i < s.length; i++) { const ch = s[i]; if (q) { cur += ch; if (ch === "\\") cur += s[++i]; else if (ch === q) q = null; continue; } if (ch === '"') { q = ch; cur += ch; continue; } if (ch === "(") d++; if (ch === ")") d--; if (ch === "," && d === 0) { out.push(cur.trim()); cur = ""; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; }
  function awkFindRedirect(s) { let q = null, d = 0; for (let i = 0; i < s.length; i++) { const ch = s[i]; if (q) { if (ch === "\\") i++; else if (ch === q) q = null; continue; } if (ch === '"') { q = ch; continue; } if (ch === "(") d++; if (ch === ")") d--; if (ch === ">" && d === 0 && s[i + 1] !== "=") return i; } return -1; }
  function humanSize(n) { return n < 1024 ? String(n) : n < 1048576 ? (n / 1024).toFixed(1).replace(/\.0$/, "") + "K" : (n / 1048576).toFixed(1) + "M"; }
  return go();
}

window.ShellSim = { newFS, newSession, run, lookup, normalize, HOME, treeLines, lex, parse };
})();
