/* ansible-sim.js — an Ansible playbook simulator for DevPortal.
 * Parses YAML playbooks + INI inventories, evaluates a Jinja2 subset, and "runs" tasks against
 * simulated hosts (packages, services, files, users…). Nothing leaves the browser; no real SSH.
 * window.AnsibleSim = { parseYaml, parseInventory, newState, run, DEFAULT_INVENTORY }
 */
(function () {
"use strict";

class AErr extends Error { constructor(m, line) { super(m); this.line = line; } }
const lines = new WeakMap();                       // object -> source line
const lineOf = o => (o && typeof o === "object" && lines.get(o)) || 0;

/* ───────────────────────── YAML subset ───────────────────────── */
function parseYaml(text) {
  const raw = text.replace(/\r/g, "").split("\n");
  const L = [];
  raw.forEach((l, i) => {
    if (/^\s*#/.test(l) || /^\s*$/.test(l)) { L.push({ blank: true, text: l, n: i + 1, ind: 0 }); return; }
    if (/^---\s*$/.test(l) || /^\.\.\.\s*$/.test(l)) return;
    L.push({ ind: l.match(/^ */)[0].length, text: l.trim(), n: i + 1, raw: l });
  });
  if (/^\s*\t/.test(text)) { const i = raw.findIndex(l => /^\s*\t/.test(l)); throw new AErr("found character that cannot start any token (tabs are not allowed for indentation)", i + 1); }
  let p = 0;
  const skipBlank = () => { while (p < L.length && L[p].blank) p++; };
  const stripComment = s => { let q = null; for (let i = 0; i < s.length; i++) { const c = s[i]; if (q) { if (c === "\\" && q === '"') i++; else if (c === q) q = null; } else if (c === '"' || c === "'") { if (i === 0 || /[\s:\[{,-]/.test(s[i - 1])) q = c; } else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd(); } return s; };
  function scalar(s, n) {
    s = s.trim();
    if (s === "" || s === "~" || s === "null" || s === "Null" || s === "NULL") return null;
    if (/^(true|True|TRUE|yes|Yes|YES|on|On|ON)$/.test(s)) return true;
    if (/^(false|False|FALSE|no|No|NO|off|Off|OFF)$/.test(s)) return false;
    if (/^[-+]?\d+$/.test(s)) return parseInt(s, 10);
    if (/^0o?[0-7]+$/.test(s)) return s;                        // file modes stay strings, e.g. 0644
    if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return parseFloat(s);
    if (s[0] === '"') { if (s.length < 2 || s[s.length - 1] !== '"') throw new AErr("found unexpected end of stream while scanning a quoted scalar", n); return s.slice(1, -1).replace(/\\(n|t|"|\\|\/|r|e|0)/g, (m, c) => ({ n: "\n", t: "\t", '"': '"', "\\": "\\", "/": "/", r: "\r", e: "\x1b", 0: "\0" }[c])); }
    if (s[0] === "'") { if (s.length < 2 || s[s.length - 1] !== "'") throw new AErr("found unexpected end of stream while scanning a quoted scalar", n); return s.slice(1, -1).replace(/''/g, "'"); }
    if (s[0] === "[" || (s[0] === "{" && !s.startsWith("{{") && !s.startsWith("{%"))) return flow(s, n);
    if (s[0] === "&" || s[0] === "*") throw new AErr("YAML anchors and aliases are not supported by this simulator", n);
    return s;
  }
  function flow(s, n) {
    let i = 0;
    const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
    function val() {
      ws();
      if (s[i] === "[") { i++; const a = []; ws(); if (s[i] === "]") { i++; return a; } for (;;) { a.push(val()); ws(); if (s[i] === ",") { i++; ws(); if (s[i] === "]") { i++; return a; } continue; } if (s[i] === "]") { i++; return a; } throw new AErr("did not find expected ',' or ']' in flow sequence", n); } }
      if (s[i] === "{") { i++; const o = {}; ws(); if (s[i] === "}") { i++; return o; } for (;;) { ws(); const k = key(); ws(); if (s[i] !== ":") throw new AErr("did not find expected ':' in flow mapping", n); i++; o[k] = val(); ws(); if (s[i] === ",") { i++; ws(); if (s[i] === "}") { i++; return o; } continue; } if (s[i] === "}") { i++; return o; } throw new AErr("did not find expected ',' or '}' in flow mapping", n); } }
      if (s[i] === '"' || s[i] === "'") { const q = s[i]; let j = i + 1; while (j < s.length && s[j] !== q) { if (s[j] === "\\" && q === '"') j++; j++; } const t = s.slice(i, j + 1); i = j + 1; return scalar(t, n); }
      let j = i; let depth = 0; while (j < s.length) { const c = s[j]; if (c === "{" && s[j + 1] === "{") { const e = s.indexOf("}}", j); j = e < 0 ? s.length : e + 2; continue; } if (depth === 0 && /[,\]}]/.test(c)) break; if (c === "[" ) depth++; if (c === "]") depth--; j++; }
      const t = s.slice(i, j); i = j; return scalar(t, n);
    }
    function key() { if (s[i] === '"' || s[i] === "'") { const q = s[i]; let j = i + 1; while (s[j] !== q && j < s.length) j++; const k = s.slice(i + 1, j); i = j + 1; return k; } let j = i; while (j < s.length && s[j] !== ":" && s[j] !== "," && s[j] !== "}") j++; const k = s.slice(i, j).trim(); i = j; return k; }
    const v = val(); ws(); if (i < s.length) throw new AErr("did not find expected <document end> after flow collection", n); return v;
  }
  function blockScalar(head, ind, n) {   // head like "|", ">-", "|+"
    const folded = head[0] === ">", chomp = /-/.test(head) ? "strip" : /\+/.test(head) ? "keep" : "clip";
    const out = []; let base = -1;
    while (p < L.length) {
      const l = L[p];
      if (l.blank) { out.push(base >= 0 && (l.raw || "").length > base ? (l.raw || "").slice(base) : ""); p++; continue; }
      if (l.ind <= ind) break;
      if (base < 0) base = l.ind;
      out.push(l.raw.slice(base)); p++;
    }
    while (out.length && out[out.length - 1] === "") { if (chomp === "keep") break; out.pop(); }
    let t = folded ? out.join("\n").replace(/([^\n])\n(?=[^\n ])/g, "$1 ") : out.join("\n");
    if (chomp !== "strip" && out.length) t += "\n";
    return t;
  }
  function parseBlock(ind) {
    skipBlank(); if (p >= L.length) return null;
    const l = L[p];
    if (l.ind < ind) return null;
    if (l.text === "-" || l.text.startsWith("- ")) return parseSeq(l.ind);
    if (/^("[^"]*"|'[^']*'|[^\s"'\[{#][^:]*?|\S+):(\s|$)/.test(l.text) || /^"[^"]*":/.test(l.text)) return parseMap(l.ind);
    p++; return scalar(stripComment(l.text), l.n);
  }
  function parseSeq(ind) {
    const arr = []; lines.set(arr, L[p].n);
    for (;;) {
      skipBlank(); if (p >= L.length) break;
      const l = L[p]; if (l.ind !== ind || !(l.text === "-" || l.text.startsWith("- "))) break;
      const rest = l.text === "-" ? "" : stripComment(l.text.slice(2)).trim();
      if (rest === "") { p++; skipBlank(); const v = p < L.length && L[p].ind > ind ? parseBlock(ind + 1) : null; arr.push(v); continue; }
      if (/^("[^"]*"|'[^']*'|[A-Za-z0-9_.\-\/]+):(\s|$)/.test(rest) && !rest.startsWith("{{")) {
        // map inside a sequence item: re-interpret this line as a map line at deeper indent
        const sub = ind + 2 + (l.text.slice(1).match(/^ */)[0].length - 1);
        L[p] = { ind: ind + 2, text: rest, n: l.n, raw: " ".repeat(ind + 2) + rest, tail: true };
        // continuation lines of this item are indented > ind; map keys must align at ind+2
        arr.push(parseMapAt(ind + 2, l.n)); continue;
      }
      if (/^[|>][-+]?\d*$/.test(rest)) { p++; arr.push(blockScalar(rest, ind, l.n)); continue; }
      p++; arr.push(scalar(rest, l.n));
    }
    return arr;
  }
  function parseMapAt(ind, n) { const m = parseMap(ind); return m; }
  function parseMap(ind) {
    const obj = {}; lines.set(obj, L[p].n);
    for (;;) {
      skipBlank(); if (p >= L.length) break;
      const l = L[p];
      if (l.ind < ind) break;
      if (l.ind > ind) { if (l.tail) { /* normalised first line */ } else throw new AErr("mapping values are not allowed in this context (check your indentation)", l.n); }
      if (l.text === "-" || l.text.startsWith("- ")) { if (l.ind === ind) break; }
      const m = /^("(?:[^"\\]|\\.)*"|'[^']*'|[^\s:][^:]*?|[^\s]+?):(?:\s+(.*))?$/.exec(l.text.replace(/\s+#.*$/, m0 => m0));
      if (!m) throw new AErr("could not find expected ':'", l.n);
      let key = m[1]; if (key[0] === '"' || key[0] === "'") key = key.slice(1, -1);
      let rest = m[2] === undefined ? "" : stripComment(m[2]).trim();
      p++;
      lines.set(obj, lines.get(obj) || l.n);
      if (key in obj) throw new AErr("found duplicate key '" + key + "'", l.n);
      if (rest === "") {
        skipBlank();
        if (p < L.length && (L[p].ind > ind || (L[p].ind === ind && (L[p].text === "-" || L[p].text.startsWith("- "))))) obj[key] = parseBlock(L[p].ind);
        else obj[key] = null;
      } else if (/^[|>][-+]?\d*$/.test(rest)) obj[key] = blockScalar(rest, ind, l.n);
      else {
        // plain multi-line continuation
        let v = rest;
        if (!/^["'\[{]/.test(v)) { while (p < L.length && !L[p].blank && L[p].ind > ind && !/^[A-Za-z0-9_."'-]+:(\s|$)/.test(L[p].text) && L[p].text[0] !== "-") { v += " " + stripComment(L[p].text); p++; } }
        else if (/^[\[{]/.test(v) && !flowComplete(v)) { while (p < L.length && !flowComplete(v)) { v += " " + stripComment(L[p].text); p++; } }
        obj[key] = scalar(v, l.n);
      }
      if (obj[key] && typeof obj[key] === "object" && !lines.get(obj[key])) lines.set(obj[key], l.n);
    }
    return obj;
  }
  function flowComplete(s) { let d = 0, q = null; for (const c of s) { if (q) { if (c === q) q = null; continue; } if (c === '"' || c === "'") q = c; else if (c === "[" || c === "{") d++; else if (c === "]" || c === "}") d--; } return d <= 0; }
  skipBlank(); if (p >= L.length) return null;
  const v = parseBlock(0); skipBlank();
  if (p < L.length) throw new AErr("did not find expected key (check your indentation near here)", L[p].n);
  return v;
}

/* ───────────────────────── Jinja2 subset ───────────────────────── */
class Undefined { constructor(name) { this.name = name; } toString() { return ""; } }
const isUndef = v => v instanceof Undefined;
function truthy(v) { if (isUndef(v)) return false; if (v === null || v === undefined || v === false || v === 0 || v === "") return false; if (Array.isArray(v)) return v.length > 0; if (typeof v === "object") return Object.keys(v).length > 0; return true; }
function str(v) {
  if (isUndef(v)) throw new AErr("'" + v.name + "' is undefined");
  if (v === null || v === undefined) return "";
  if (v === true) return "True"; if (v === false) return "False";
  if (Array.isArray(v) || typeof v === "object") return pyRepr(v);
  return String(v);
}
function pyRepr(v) {
  if (v === null || v === undefined) return "None"; if (v === true) return "True"; if (v === false) return "False";
  if (typeof v === "string") return "'" + v.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  if (typeof v === "object") return "{" + Object.keys(v).map(k => pyRepr(k) + ": " + pyRepr(v[k])).join(", ") + "}";
  return String(v);
}
function toJson(v, indent, level) {          // python-style json.dumps (", " and ": " separators)
  level = level || 0;
  if (v === null || v === undefined || isUndef(v)) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v !== "object") return String(v);
  const pad = indent ? "\n" + " ".repeat(indent * (level + 1)) : "", end = indent ? "\n" + " ".repeat(indent * level) : "";
  if (Array.isArray(v)) { if (!v.length) return "[]"; return "[" + pad + v.map(x => toJson(x, indent, level + 1)).join("," + (indent ? pad : " ")) + end + "]"; }
  const ks = Object.keys(v); if (!ks.length) return "{}";
  return "{" + pad + ks.map(k => JSON.stringify(k) + ": " + toJson(v[k], indent, level + 1)).join("," + (indent ? pad : " ")) + end + "}";
}

const STR_METHODS = {
  startswith: (s, p) => s.startsWith(p), endswith: (s, p) => s.endsWith(p), upper: s => s.toUpperCase(), lower: s => s.toLowerCase(),
  strip: (s, c) => (c ? s.replace(new RegExp("^[" + c + "]+|[" + c + "]+$", "g"), "") : s.trim()), lstrip: s => s.trimStart(), rstrip: s => s.trimEnd(),
  split: (s, d) => (d === undefined ? s.trim().split(/\s+/) : s.split(d)), replace: (s, a, b) => s.split(a).join(b), capitalize: s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(),
  title: s => s.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase()), join: (s, l) => l.join(s), find: (s, x) => s.indexOf(x), count: (s, x) => s.split(x).length - 1,
  isdigit: s => /^\d+$/.test(s), isalpha: s => /^[A-Za-z]+$/.test(s), format: function (s) { const a = [].slice.call(arguments, 1); let i = 0; return s.replace(/\{\}/g, () => a[i++]); },
  zfill: (s, n) => s.padStart(n, "0"), ljust: (s, n) => s.padEnd(n), rjust: (s, n) => s.padStart(n)
};
const DICT_METHODS = { items: o => Object.keys(o).map(k => [k, o[k]]), keys: o => Object.keys(o), values: o => Object.keys(o).map(k => o[k]), get: (o, k, d) => (k in o ? o[k] : (d === undefined ? null : d)) };
function tokenizeExpr(s) {
  const toks = []; const re = /\s*(?:(\d+\.\d+|\d+)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|([A-Za-z_][A-Za-z0-9_]*)|(==|!=|<=|>=|\/\/|\*\*|[-+*\/%<>()\[\]{},.:|~=]))/y;
  let m; re.lastIndex = 0; const t = s.trimEnd();
  while (re.lastIndex < t.length) {
    const at = re.lastIndex; m = re.exec(t);
    if (!m) throw new AErr("unexpected character '" + t[at] + "' in expression: " + s);
    if (m[1] !== undefined) toks.push({ t: "num", v: parseFloat(m[1]) });
    else if (m[2] !== undefined) toks.push({ t: "str", v: m[2].slice(1, -1).replace(/\\(.)/g, (x, c) => c === "n" ? "\n" : c === "t" ? "\t" : c) });
    else if (m[3] !== undefined) toks.push({ t: "id", v: m[3] });
    else toks.push({ t: "op", v: m[4] });
  }
  return toks;
}
function evalExpr(src, ctx) {
  const toks = tokenizeExpr(src); let p = 0;
  const pk = () => toks[p], nx = () => toks[p++];
  const isOp = v => pk() && pk().t === "op" && pk().v === v;
  const isId = v => pk() && pk().t === "id" && pk().v === v;
  function expect(v) { if (!isOp(v)) throw new AErr("expected '" + v + "' in expression: " + src); p++; }
  function parseTernary() {
    const v = parseOr();
    if (isId("if")) { p++; const c = parseOr(); let e = null; if (isId("else")) { p++; e = parseTernary(); } return truthy(c) ? v : (e === null ? new Undefined("") : e); }
    return v;
  }
  function parseOr() { let l = parseAnd(); while (isId("or")) { p++; const r = parseAnd(); l = truthy(l) ? l : r; } return l; }
  function parseAnd() { let l = parseNot(); while (isId("and")) { p++; const r = parseNot(); l = truthy(l) ? r : l; } return l; }
  function parseNot() { if (isId("not")) { p++; return !truthy(parseNot()); } return parseCmp(); }
  function parseCmp() {
    let l = parseConcat();
    for (;;) {
      const t = pk(); if (!t) break;
      if (t.t === "op" && ["==", "!=", "<", ">", "<=", ">="].includes(t.v)) { p++; const r = parseConcat(); l = cmp(t.v, l, r); }
      else if (t.t === "id" && t.v === "in") { p++; const r = parseConcat(); l = contains(r, l); }
      else if (t.t === "id" && t.v === "not" && toks[p + 1] && toks[p + 1].v === "in") { p += 2; const r = parseConcat(); l = !contains(r, l); }
      else if (t.t === "id" && t.v === "is") { p++; let neg = false; if (isId("not")) { p++; neg = true; } const name = nx().v; let args = []; if (isOp("(")) { p++; if (!isOp(")")) for (;;) { args.push(parseTernary()); if (isOp(",")) { p++; continue; } break; } expect(")"); } else if (pk() && (pk().t === "num" || pk().t === "str")) args = [nx().v]; const r = jtest(name, l, args); l = neg ? !r : r; }
      else break;
    }
    return l;
  }
  const contains = (c, x) => (isUndef(c) ? false : typeof c === "string" ? String(c).includes(str(x)) : Array.isArray(c) ? c.some(y => cmp("==", y, x)) : c && typeof c === "object" ? str(x) in c : false);
  function cmp(op, a, b) {
    if (isUndef(a) || isUndef(b)) { if (op === "==" || op === "!=") { const eq = isUndef(a) && isUndef(b); return op === "==" ? eq : !eq; } throw new AErr("'" + (isUndef(a) ? a.name : b.name) + "' is undefined"); }
    const eqv = (x, y) => (typeof x === "object" && x !== null) || (typeof y === "object" && y !== null) ? JSON.stringify(x) === JSON.stringify(y) : (typeof x === "number" && typeof y === "string" && y.trim() !== "" && !isNaN(y) ? x === +y : x === y);
    switch (op) { case "==": return eqv(a, b); case "!=": return !eqv(a, b); case "<": return a < b; case ">": return a > b; case "<=": return a <= b; case ">=": return a >= b; }
  }
  function parseConcat() { let l = parseAdd(); while (isOp("~")) { p++; const r = parseAdd(); l = str(l) + str(r); } return l; }
  function parseAdd() { let l = parseMul(); while (isOp("+") || isOp("-")) { const o = nx().v; const r = parseMul(); if (isUndef(l) || isUndef(r)) throw new AErr("'" + (isUndef(l) ? l.name : r.name) + "' is undefined"); l = o === "+" ? (Array.isArray(l) && Array.isArray(r) ? l.concat(r) : l + r) : l - r; } return l; }
  function parseMul() { let l = parseUnary(); while (isOp("*") || isOp("/") || isOp("%") || isOp("//") || isOp("**")) { const o = nx().v; const r = parseUnary(); l = o === "*" ? l * r : o === "/" ? l / r : o === "%" ? l % r : o === "//" ? Math.floor(l / r) : Math.pow(l, r); } return l; }
  function parseUnary() { if (isOp("-")) { p++; return -parseUnary(); } if (isOp("+")) { p++; return +parseUnary(); } return parseFilter(); }
  function parseFilter() {
    let v = parsePostfix();
    while (isOp("|")) {
      p++; const name = nx().v; let args = [], kw = {};
      if (isOp("(")) { p++; if (!isOp(")")) for (;;) { if (pk() && pk().t === "id" && toks[p + 1] && toks[p + 1].v === "=" && !(toks[p + 2] && toks[p + 2].v === "=")) { const k = nx().v; p++; kw[k] = parseTernary(); } else args.push(parseTernary()); if (isOp(",")) { p++; continue; } break; } expect(")"); }
      v = jfilter(name, v, args, kw);
    }
    return v;
  }
  function parsePostfix() {
    let v = parsePrimary();
    for (;;) {
      if (isOp(".")) { p++; const k = nx().v; v = getAttr(v, k); }
      else if (isOp("[")) { p++; const k = parseTernary(); expect("]"); v = getItem(v, k); }
      else if (isOp("(") && typeof v === "function") { p++; const a = []; if (!isOp(")")) for (;;) { a.push(parseTernary()); if (isOp(",")) { p++; continue; } break; } expect(")"); v = v.apply(null, a); }
      else break;
    }
    return v;
  }
  function getAttr(v, k) {
    if (isUndef(v)) throw new AErr("'" + v.name + "' is undefined");
    if (typeof v === "string" && STR_METHODS[k]) return function () { return STR_METHODS[k].apply(null, [v].concat([].slice.call(arguments))); };
    if (Array.isArray(v) && k === "count") return function (x) { return v.filter(y => y === x).length; };
    if (v && typeof v === "object" && !Array.isArray(v) && DICT_METHODS[k] && !(k in v)) return function () { return DICT_METHODS[k].apply(null, [v].concat([].slice.call(arguments))); };
    if (v === null || v === undefined) return new Undefined(k);
    if (typeof v === "object" && !Array.isArray(v)) return k in v ? v[k] : new Undefined(k);
    if (Array.isArray(v) && k === "length") return v.length;
    return new Undefined(k);
  }
  function getItem(v, k) {
    if (isUndef(v)) throw new AErr("'" + v.name + "' is undefined");
    if (v === null || v === undefined) return new Undefined(String(k));
    if (Array.isArray(v) || typeof v === "string") { const i = typeof k === "number" ? (k < 0 ? v.length + k : k) : parseInt(k, 10); return v[i] === undefined ? new Undefined(String(k)) : v[i]; }
    return k in v ? v[k] : new Undefined(String(k));
  }
  function parsePrimary() {
    const t = nx(); if (!t) throw new AErr("unexpected end of expression: " + src);
    if (t.t === "num" || t.t === "str") return t.v;
    if (t.t === "op") {
      if (t.v === "(") { const v = parseTernary(); expect(")"); return v; }
      if (t.v === "[") { const a = []; if (!isOp("]")) for (;;) { a.push(parseTernary()); if (isOp(",")) { p++; if (isOp("]")) break; continue; } break; } expect("]"); return a; }
      if (t.v === "{") { const o = {}; if (!isOp("}")) for (;;) { const k = parseTernary(); expect(":"); o[str(k)] = parseTernary(); if (isOp(",")) { p++; if (isOp("}")) break; continue; } break; } expect("}"); return o; }
      throw new AErr("unexpected '" + t.v + "' in expression: " + src);
    }
    switch (t.v) {
      case "true": case "True": return true; case "false": case "False": return false; case "none": case "None": case "null": return null;
      case "range": return function (a, b, c) { const r = []; if (b === undefined) { b = a; a = 0; } c = c || 1; for (let i = a; c > 0 ? i < b : i > b; i += c) r.push(i); return r; };
      case "lookup": return function (kind, a) { if (kind === "env") return ({ HOME: "/home/deploy", USER: "deploy" })[a] || ""; throw new AErr("lookup plugin '" + kind + "' is not supported in the simulator"); };
      case "dict": return function (x) { return x || {}; };
      case "now": return function () { return new Date().toISOString(); };
    }
    if (t.v in ctx) return ctx[t.v];
    return new Undefined(t.v);
  }
  const r = parseTernary();
  if (p < toks.length) throw new AErr("unexpected '" + (toks[p].v) + "' in expression: " + src);
  return r;
}
function jtest(name, v, args) {
  switch (name) {
    case "defined": return !isUndef(v); case "undefined": return isUndef(v); case "none": return v === null; case "string": return typeof v === "string";
    case "number": return typeof v === "number"; case "integer": return Number.isInteger(v); case "float": return typeof v === "number" && !Number.isInteger(v);
    case "mapping": return v !== null && typeof v === "object" && !Array.isArray(v); case "iterable": case "sequence": return Array.isArray(v) || typeof v === "string";
    case "boolean": return typeof v === "boolean"; case "truthy": return truthy(v); case "falsy": return !truthy(v);
    case "even": return v % 2 === 0; case "odd": return v % 2 === 1; case "divisibleby": return v % args[0] === 0;
    case "success": case "succeeded": return !!v && !v.failed && !v.skipped; case "failed": case "failure": return !!v && !!v.failed;
    case "changed": return !!v && !!v.changed; case "skipped": case "skip": return !!v && !!v.skipped;
    case "match": return new RegExp("^" + args[0]).test(String(v)); case "search": return new RegExp(args[0]).test(String(v));
    case "version": { const cmpv = (a, b) => { const A = String(a).split(".").map(Number), B = String(b).split(".").map(Number); for (let i = 0; i < Math.max(A.length, B.length); i++) { const d = (A[i] || 0) - (B[i] || 0); if (d) return d; } return 0; }; const c = cmpv(v, args[0]), op = args[1] || "=="; return op === ">=" || op === "ge" ? c >= 0 : op === ">" || op === "gt" ? c > 0 : op === "<=" || op === "le" ? c <= 0 : op === "<" || op === "lt" ? c < 0 : op === "!=" || op === "ne" ? c !== 0 : c === 0; }
    case "in": return Array.isArray(args[0]) ? args[0].includes(v) : String(args[0]).includes(String(v));
    case "file": case "directory": case "exists": return false;
  }
  throw new AErr("No test named '" + name + "'");
}
function jfilter(name, v, a, kw) {
  const need = () => { if (isUndef(v)) throw new AErr("'" + v.name + "' is undefined"); };
  switch (name) {
    case "default": case "d": return (isUndef(v) || (a[1] === true && !truthy(v))) ? (a[0] === undefined ? "" : a[0]) : v;
    case "mandatory": if (isUndef(v)) throw new AErr(a[0] || "Mandatory variable '" + v.name + "' not defined."); return v;
    case "upper": need(); return str(v).toUpperCase(); case "lower": need(); return str(v).toLowerCase();
    case "capitalize": need(); return str(v).charAt(0).toUpperCase() + str(v).slice(1).toLowerCase(); case "title": need(); return str(v).replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
    case "trim": need(); return str(v).trim(); case "length": case "count": need(); return typeof v === "object" && v !== null && !Array.isArray(v) ? Object.keys(v).length : v.length;
    case "int": { const n = parseInt(v, 10); return isNaN(n) ? (a[0] === undefined ? 0 : a[0]) : n; } case "float": { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
    case "string": need(); return str(v); case "bool": return typeof v === "string" ? /^(true|yes|on|1)$/i.test(v) : !!v;
    case "join": need(); return (Array.isArray(v) ? v : [v]).map(str).join(a[0] === undefined ? "" : a[0]);
    case "split": need(); return str(v).split(a[0] === undefined ? /\s+/ : a[0]);
    case "replace": need(); return str(v).split(a[0]).join(a[1]);
    case "regex_replace": need(); return str(v).replace(new RegExp(a[0], "g"), String(a[1]).replace(/\\(\d)/g, "$$$1"));
    case "regex_search": { need(); const m = new RegExp(a[0]).exec(str(v)); return m ? m[0] : ""; }
    case "first": need(); return v[0]; case "last": need(); return v[v.length - 1];
    case "sort": need(); return v.slice().sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)); case "unique": need(); return v.filter((x, i) => v.findIndex(y => JSON.stringify(y) === JSON.stringify(x)) === i);
    case "list": need(); return typeof v === "string" ? v.split("") : Array.isArray(v) ? v : Object.keys(v); case "reverse": need(); return typeof v === "string" ? v.split("").reverse().join("") : v.slice().reverse();
    case "min": need(); return Math.min(...v); case "max": need(); return Math.max(...v); case "sum": need(); return v.reduce((s, x) => s + x, 0); case "abs": return Math.abs(v);
    case "round": return +(+v).toFixed(a[0] || 0); case "length_is": return v.length === a[0];
    case "to_json": return toJson(v); case "to_nice_json": return toJson(v, 4); case "from_json": return JSON.parse(v);
    case "to_yaml": case "to_nice_yaml": return yamlOut(v, 0).replace(/\n$/, "") + "\n";
    case "quote": return "'" + str(v).replace(/'/g, "'\"'\"'") + "'";
    case "basename": return str(v).split("/").filter(Boolean).pop() || ""; case "dirname": { const s = str(v), i = s.lastIndexOf("/"); return i <= 0 ? (i === 0 ? "/" : "") : s.slice(0, i); }
    case "flatten": need(); return v.reduce((r, x) => r.concat(Array.isArray(x) ? x : [x]), []);
    case "map": { need(); if (kw.attribute !== undefined) return v.map(x => x[kw.attribute]); return v.map(x => jfilter(a[0], x, a.slice(1), {})); }
    case "select": case "reject": { need(); const keep = name === "select"; return v.filter(x => (a[0] ? jtest(a[0], x, a.slice(1)) : truthy(x)) === keep); }
    case "selectattr": case "rejectattr": { need(); const keep = name === "selectattr"; return v.filter(x => (a[1] ? jtest(a[1], x[a[0]], a.slice(2)) : truthy(x[a[0]])) === keep); }
    case "combine": return Object.assign({}, v, ...a);
    case "dict2items": return Object.keys(v).map(k => ({ key: k, value: v[k] }));
    case "items2dict": { const o = {}; v.forEach(x => o[x.key] = x.value); return o; }
    case "ternary": return truthy(v) ? a[0] : a[1];
    case "b64encode": return btoa(str(v)); case "b64decode": return atob(str(v));
    case "hash": case "password_hash": return "$6$simulated$" + btoa(str(v)).slice(0, 22);
    case "ipaddr": return v; case "type_debug": return Array.isArray(v) ? "list" : v === null ? "NoneType" : typeof v === "object" ? "dict" : typeof v === "number" ? (Number.isInteger(v) ? "int" : "float") : typeof v === "boolean" ? "bool" : "str";
    case "items": return Object.keys(v).map(k => [k, v[k]]);
  }
  throw new AErr("No filter named '" + name + "'");
}
function yamlOut(v, ind) {
  const pad = " ".repeat(ind);
  if (Array.isArray(v)) return v.length ? v.map(x => pad + "- " + (typeof x === "object" && x !== null ? yamlOut(x, ind + 2).trimStart() : yamlScalar(x)) + (typeof x === "object" && x !== null ? "" : "\n")).join("").replace(/\n\n/g, "\n") : pad + "[]\n";
  if (v && typeof v === "object") return Object.keys(v).length ? Object.keys(v).map(k => pad + k + ":" + (typeof v[k] === "object" && v[k] !== null && (Array.isArray(v[k]) ? v[k].length : Object.keys(v[k]).length) ? "\n" + yamlOut(v[k], ind + 2) : " " + (typeof v[k] === "object" && v[k] !== null ? (Array.isArray(v[k]) ? "[]" : "{}") : yamlScalar(v[k])) + "\n")).join("") : pad + "{}\n";
  return pad + yamlScalar(v) + "\n";
}
const yamlScalar = v => (v === null ? "null" : typeof v === "string" ? (/^[\w./@-]+$/.test(v) && !/^(true|false|yes|no|null|\d+)$/i.test(v) ? v : JSON.stringify(v)) : String(v));

/* template text with {{ }} / {% %} / {# #} */
function render(tpl, ctx, wantRaw) {
  if (typeof tpl !== "string") return tpl;
  if (!tpl.includes("{{") && !tpl.includes("{%") && !tpl.includes("{#")) return tpl;
  const single = /^\s*\{\{([\s\S]*?)\}\}\s*$/.exec(tpl);
  if (single && !/\}\}[\s\S]*\{\{/.test(single[1]) && !tpl.includes("{%")) {
    const v = evalExpr(single[1], ctx);
    if (isUndef(v)) throw new AErr("'" + v.name + "' is undefined");
    return v;
  }
  return renderBlocks(tpl, ctx);
}
function renderBlocks(src, ctx) {
  const toks = []; const re = /\{\{([\s\S]*?)\}\}|\{%-?\s*([\s\S]*?)\s*-?%\}|\{#[\s\S]*?#\}/g; let last = 0, m;
  while ((m = re.exec(src))) { if (m.index > last) toks.push({ t: "txt", v: src.slice(last, m.index) }); if (m[1] !== undefined) toks.push({ t: "var", v: m[1] }); else if (m[2] !== undefined) toks.push({ t: "stmt", v: m[2] }); last = re.lastIndex; }
  if (last < src.length) toks.push({ t: "txt", v: src.slice(last) });
  let i = 0;
  function block(stop) {
    const out = [];
    while (i < toks.length) {
      const k = toks[i];
      if (k.t === "txt") { out.push(k.v); i++; continue; }
      if (k.t === "var") { const v = evalExpr(k.v, ctx); out.push(str(v)); i++; continue; }
      const w = k.v.split(/\s+/)[0];
      if (stop.includes(w)) return { out: out.join(""), end: w };
      if (w === "if") {
        let cond = truthy(evalExpr(k.v.slice(2), ctx)), done = cond, res = ""; i++;
        let b = block(["elif", "else", "endif"]); if (cond) res = b.out;
        while (b.end !== "endif") {
          if (b.end === "elif") { const c = !done && truthy(evalExpr(toks[i].v.slice(4), ctx)); i++; b = block(["elif", "else", "endif"]); if (c) { res = b.out; done = true; } }
          else { i++; b = block(["endif"]); if (!done) res = b.out; done = true; }
        }
        i++; out.push(res); continue;
      }
      if (w === "for") {
        const m2 = /^for\s+(\w+)(?:\s*,\s*(\w+))?\s+in\s+([\s\S]+)$/.exec(k.v); if (!m2) throw new AErr("bad for statement: " + k.v);
        let coll = evalExpr(m2[3], ctx); if (isUndef(coll)) throw new AErr("'" + coll.name + "' is undefined");
        const items = Array.isArray(coll) ? coll.map(x => [x]) : Object.keys(coll).map(kk => [kk, coll[kk]]);
        const start = ++i; let res = "", endIdx = start;
        items.forEach((it, idx) => { i = start; const sub = Object.assign({}, ctx); if (m2[2]) { sub[m2[1]] = it[0]; sub[m2[2]] = it[1]; } else sub[m2[1]] = it[0]; sub.loop = { index: idx + 1, index0: idx, first: idx === 0, last: idx === items.length - 1, length: items.length }; const save = ctx; const b = withCtx(sub, () => block(["endfor"])); res += b.out; endIdx = i; });
        if (!items.length) { const b = block(["endfor"]); endIdx = i; }
        i = endIdx + 1; out.push(res); continue;
      }
      if (w === "set") { const m2 = /^set\s+(\w+)\s*=\s*([\s\S]+)$/.exec(k.v); ctx[m2[1]] = evalExpr(m2[2], ctx); i++; continue; }
      throw new AErr("unknown template statement: " + k.v);
    }
    if (stop.length) throw new AErr("unexpected end of template (missing {% " + stop[stop.length - 1] + " %})");
    return { out: out.join(""), end: null };
  }
  function withCtx(sub, fn) { const keys = Object.keys(sub), saved = {}; keys.forEach(k => { saved[k] = ctx[k]; ctx[k] = sub[k]; }); try { return fn(); } finally { keys.forEach(k => { if (saved[k] === undefined) delete ctx[k]; else ctx[k] = saved[k]; }); } }
  return block([]).out;
}
function deepRender(v, ctx) {
  if (typeof v === "string") return render(v, ctx);
  if (Array.isArray(v)) return v.map(x => deepRender(x, ctx));
  if (v && typeof v === "object") { const o = {}; Object.keys(v).forEach(k => { o[k] = deepRender(v[k], ctx); }); return o; }
  return v;
}
function evalCond(c, ctx) {
  if (c === undefined || c === null) return true;
  if (typeof c === "boolean") return c;
  if (Array.isArray(c)) return c.every(x => evalCond(x, ctx));
  if (typeof c === "number") return !!c;
  const s = String(c).replace(/^\{\{\s*([\s\S]*?)\s*\}\}$/, "$1");
  const v = evalExpr(s, ctx);
  if (isUndef(v)) throw new AErr("The conditional check '" + c + "' failed. The error was: error while evaluating conditional (" + c + "): '" + v.name + "' is undefined");
  return truthy(v);
}

/* ───────────────────────── inventory ───────────────────────── */
const DEFAULT_INVENTORY = `# inventory.ini — simulated hosts (nothing real is contacted)
[webservers]
web1 ansible_host=10.0.1.11
web2 ansible_host=10.0.1.12

[dbservers]
db1 ansible_host=10.0.2.21

[production:children]
webservers
dbservers

[all:vars]
ansible_user=deploy
ansible_python_interpreter=/usr/bin/python3

[webservers:vars]
http_port=80
`;
function parseInventory(text) {
  const groups = { all: { hosts: [], children: [], vars: {} }, ungrouped: { hosts: [], children: [], vars: {} } }; const hosts = {};
  let cur = "ungrouped", mode = "hosts";
  const val = s => { s = s.trim(); if (/^-?\d+$/.test(s)) return +s; if (/^(true|True|yes)$/.test(s)) return true; if (/^(false|False|no)$/.test(s)) return false; return s.replace(/^(['"])(.*)\1$/, "$2"); };
  text.replace(/\r/g, "").split("\n").forEach((raw, idx) => {
    const l = raw.replace(/\s+#.*$/, "").trim(); if (!l || l[0] === "#" || l[0] === ";") return;
    let m = /^\[([^\]:]+)(?::(vars|children))?\]$/.exec(l);
    if (m) { cur = m[1]; mode = m[2] || "hosts"; if (!groups[cur]) groups[cur] = { hosts: [], children: [], vars: {} }; return; }
    if (l[0] === "[") throw new AErr("Invalid section entry: '" + l + "'", idx + 1);
    if (mode === "vars") { const kv = l.split("="); groups[cur].vars[kv[0].trim()] = val(kv.slice(1).join("=")); return; }
    if (mode === "children") { if (!groups[l]) groups[l] = { hosts: [], children: [], vars: {} }; groups[cur].children.push(l); return; }
    const parts = l.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g); const name = parts[0];
    const hv = {}; parts.slice(1).forEach(kv => { const i = kv.indexOf("="); if (i < 0) throw new AErr("Expected key=value host variable assignment, got: " + kv, idx + 1); hv[kv.slice(0, i)] = val(kv.slice(i + 1)); });
    if (!hosts[name]) hosts[name] = { name, vars: {}, groups: [] };
    Object.assign(hosts[name].vars, hv);
    if (!groups[cur].hosts.includes(name)) groups[cur].hosts.push(name);
  });
  // flatten children
  const members = g => { const s = new Set(groups[g].hosts); groups[g].children.forEach(c => { if (groups[c]) members(c).forEach(h => s.add(h)); }); return [...s]; };
  Object.keys(hosts).forEach(h => { if (!groups.all.hosts.includes(h)) groups.all.hosts.push(h); });
  const resolved = {}; Object.keys(groups).forEach(g => { resolved[g] = g === "all" ? Object.keys(hosts) : members(g); });
  Object.keys(hosts).forEach(h => { hosts[h].groups = Object.keys(groups).filter(g => g !== "all" && g !== "ungrouped" && resolved[g].includes(h)); });
  const parents = {}; Object.keys(groups).forEach(g => groups[g].children.forEach(c => { (parents[c] = parents[c] || []).push(g); }));
  function hostVars(h) {
    const out = {}; const chain = g => { (parents[g] || []).forEach(chain); Object.assign(out, groups[g].vars); };
    Object.assign(out, groups.all.vars); hosts[h].groups.forEach(chain); Object.assign(out, hosts[h].vars); return out;
  }
  return { hosts, groups, resolved, hostVars };
}
function matchHosts(pattern, inv) {
  const all = Object.keys(inv.hosts); let res = null; const warn = [];
  const expand = p => { if (p === "all" || p === "*") return all.slice(); if (inv.resolved[p]) return inv.resolved[p].slice(); if (inv.hosts[p]) return [p]; if (/[*?]/.test(p)) { const re = new RegExp("^" + p.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"); const m = all.filter(h => re.test(h)); if (m.length) return m; Object.keys(inv.resolved).forEach(g => { if (re.test(g)) inv.resolved[g].forEach(h => m.push(h)); }); return [...new Set(m)]; } warn.push(p); return []; };
  String(pattern).split(/[:,]/).map(s => s.trim()).filter(Boolean).forEach(p => {
    if (p[0] === "!") { const ex = expand(p.slice(1)); res = (res || all.slice()).filter(h => !ex.includes(h)); }
    else if (p[0] === "&") { const ex = expand(p.slice(1)); res = (res || all.slice()).filter(h => ex.includes(h)); }
    else res = [...new Set((res || []).concat(expand(p)))];
  });
  return { hosts: res || [], warn };
}

/* ───────────────────────── simulated hosts ───────────────────────── */
const CATALOG = {
  nginx: { v: "1.24.0-2ubuntu7", svc: ["nginx"], files: { "/etc/nginx/nginx.conf": "user www-data;\nworker_processes auto;\nhttp { include /etc/nginx/sites-enabled/*; }\n", "/var/www/html/index.nginx-debian.html": "<h1>Welcome to nginx!</h1>\n" }, dirs: ["/etc/nginx", "/var/www/html", "/etc/nginx/sites-available", "/etc/nginx/sites-enabled"] },
  apache2: { v: "2.4.58-1ubuntu8", svc: ["apache2"], files: { "/etc/apache2/apache2.conf": "ServerRoot /etc/apache2\n" }, dirs: ["/etc/apache2", "/var/www/html"] },
  postgresql: { v: "15.4-0ubuntu1", svc: ["postgresql"], files: { "/etc/postgresql/15/main/postgresql.conf": "port = 5432\n" }, dirs: ["/etc/postgresql"] },
  "redis-server": { v: "7.0.15-1", svc: ["redis-server"], files: { "/etc/redis/redis.conf": "port 6379\nbind 127.0.0.1\n" }, dirs: ["/etc/redis"] },
  "mysql-server": { v: "8.0.36-0ubuntu0", svc: ["mysql"], files: {}, dirs: ["/etc/mysql"] },
  "docker.io": { v: "24.0.7-0ubuntu4", svc: ["docker"], files: {}, dirs: [] },
  haproxy: { v: "2.8.5-1", svc: ["haproxy"], files: { "/etc/haproxy/haproxy.cfg": "global\n  daemon\n" }, dirs: ["/etc/haproxy"] },
  memcached: { v: "1.6.24-1", svc: ["memcached"], files: {}, dirs: [] },
  ufw: { v: "0.36.2-6", svc: ["ufw"], files: {}, dirs: [] }, fail2ban: { v: "1.0.2-3", svc: ["fail2ban"], files: {}, dirs: ["/etc/fail2ban"] },
  git: { v: "1:2.43.0-1", svc: [] }, curl: { v: "8.5.0-2", svc: [] }, vim: { v: "2:9.1.0016-1", svc: [] }, htop: { v: "3.3.0-4", svc: [] }, unzip: { v: "6.0-28", svc: [] },
  tree: { v: "2.1.1-2", svc: [] }, wget: { v: "1.21.4-1", svc: [] }, jq: { v: "1.7.1-3", svc: [] }, nano: { v: "7.2-2", svc: [] }, "net-tools": { v: "2.10-0.1", svc: [] },
  nodejs: { v: "18.19.1+dfsg", svc: [] }, "python3-pip": { v: "24.0+dfsg-1", svc: [] }, "build-essential": { v: "12.10ubuntu1", svc: [] }, certbot: { v: "2.9.0-1", svc: [] }, openssl: { v: "3.0.13-0ubuntu3", svc: [] },
  rsync: { v: "3.2.7-1", svc: [] }, tmux: { v: "3.4-1", svc: [] }, ntp: { v: "1:4.2.8p15", svc: ["ntp"] }, chrony: { v: "4.5-1", svc: ["chrony"] }
};
const ALIAS = { httpd: "apache2", "mariadb-server": "mysql-server", docker: "docker.io", redis: "redis-server", postgresql15: "postgresql", "python3-pip": "python3-pip", pip: "python3-pip" };
const PORTS = { nginx: [80, 443], apache2: [80], postgresql: [5432], "redis-server": [6379], mysql: [3306], haproxy: [80], memcached: [11211], ssh: [22] };

function newHost(name, octet) {
  return {
    pkgs: { "openssh-server": "1:9.6p1-3", python3: "3.12.3-0ubuntu2", bash: "5.2.21-2", cron: "3.0pl1-184", coreutils: "9.4-3" },
    svcs: { ssh: { state: "started", enabled: true }, cron: { state: "started", enabled: true } },
    files: { "/etc/hostname": { c: name + "\n", m: "0644", o: "root", t: "file" }, "/etc/os-release": { c: 'PRETTY_NAME="Ubuntu 24.04 LTS"\n', m: "0644", o: "root", t: "file" } },
    dirs: { "/": 1, "/etc": 1, "/var": 1, "/var/www": 0, "/tmp": 1, "/opt": 1, "/home": 1, "/home/deploy": 1, "/usr": 1, "/usr/local": 1, "/root": 1, "/srv": 1, "/var/log": 1, "/var/lib": 1 },
    users: { root: { uid: 0, groups: ["root"], shell: "/bin/bash" }, deploy: { uid: 1000, groups: ["deploy", "sudo"], shell: "/bin/bash" } },
    groups: { root: 1, sudo: 1, deploy: 1 }, cron: {}, ufw: [], facts: {}, hostname: name, reboots: 0, ts: 0
  };
}
function newState() { return { hosts: {} }; }
function hostState(state, name) { return state.hosts[name] || (state.hosts[name] = newHost(name)); }

const NEEDS_ROOT = new Set(["apt", "yum", "dnf", "package", "service", "systemd", "user", "group", "hostname", "reboot", "ufw", "cron_system", "pip_system"]);
const SYSTEM_DIR = /^\/(etc|var|usr|opt|root|srv|lib|boot|sbin|bin)(\/|$)/;
const MODS = ["ping", "debug", "set_fact", "setup", "apt", "yum", "dnf", "package", "service", "systemd", "copy", "template", "file", "lineinfile", "blockinfile", "user", "group", "command", "shell", "raw", "script", "stat", "git", "pip", "uri", "get_url", "wait_for", "assert", "fail", "pause", "cron", "hostname", "reboot", "ufw", "meta", "include_vars", "unarchive", "replace", "apt_repository", "apt_key", "authorized_key", "sysctl", "timezone", "synchronize", "docker_container", "mount", "find", "slurp", "fetch", "known_hosts", "systemd_service", "dnf5", "import_tasks", "include_tasks", "import_playbook", "set_stats", "add_host", "group_by"];

/* ───────────────────────── the runner ───────────────────────── */
function banner(kind, name) { const s = kind + " [" + name + "] "; return s + "*".repeat(Math.max(3, 79 - s.length)); }

function run(playText, invText, state, opts) {
  opts = opts || {};
  const out = { ok: true, timeline: [], recap: [], text: [], state: null, errors: [], rc: 0 };
  const log = t => out.text.push(t);
  let plays, inv;
  try { inv = parseInventory(invText); } catch (e) { return fail("ERROR! Unable to parse inventory: " + e.message + (e.line ? "  (line " + e.line + ")" : "")); }
  try { plays = parseYaml(playText); } catch (e) { return fail("ERROR! We were unable to read either as JSON nor YAML.\nSyntax Error while loading YAML.\n  " + e.message + "\n\nThe error appears to be in 'playbook.yml': line " + (e.line || "?") + "\n"); }
  if (plays === null) return fail("ERROR! playbook is empty — add a list of plays starting with '- hosts: ...'");
  if (!Array.isArray(plays)) return fail("ERROR! A playbook must be a list of plays, got a " + (typeof plays === "object" ? "dict" : "scalar") + " instead\n\nThe error appears to be in 'playbook.yml': line 1");
  state = JSON.parse(JSON.stringify(state || newState()));
  const extra = opts.extraVars || {}; const tagsOnly = opts.tags && opts.tags.length ? opts.tags : null, skipTags = opts.skipTags || [];
  const check = !!opts.check;
  const recap = {}; const bump = (h, k) => { (recap[h] = recap[h] || { ok: 0, changed: 0, unreachable: 0, failed: 0, skipped: 0, rescued: 0, ignored: 0 })[k]++; };
  const ensure = h => { recap[h] = recap[h] || { ok: 0, changed: 0, unreachable: 0, failed: 0, skipped: 0, rescued: 0, ignored: 0 }; };
  function fail(msg) { out.ok = false; out.rc = 4; out.errors.push(msg); out.timeline.push({ k: "error", text: msg }); out.text.push(msg); return out; }

  try {
    // static validation first (like ansible-playbook's parse step)
    plays.forEach((pl, i) => {
      if (!pl || typeof pl !== "object" || Array.isArray(pl)) throw new AErr("A playbook must be a list of plays; item " + (i + 1) + " is not a dictionary", lineOf(plays));
      if (pl.import_playbook) throw new AErr("import_playbook is not supported in the simulator", lineOf(pl));
      if (pl.hosts === undefined) throw new AErr("the field 'hosts' is required but was not set", lineOf(pl));
      ["pre_tasks", "tasks", "post_tasks", "handlers"].forEach(sec => { if (pl[sec] !== undefined && pl[sec] !== null && !Array.isArray(pl[sec])) throw new AErr("A play's '" + sec + "' must be a list of tasks", lineOf(pl)); });
      if (pl.roles) throw new AErr("roles are not supported in the simulator — put the tasks inline", lineOf(pl));
      validateTasks([].concat(pl.pre_tasks || [], pl.tasks || [], pl.post_tasks || [], pl.handlers || []));
    });
  } catch (e) { if (e instanceof AErr) return fail("ERROR! " + e.message + "\n\nThe error appears to be in 'playbook.yml': line " + (e.line || "?") + "\n"); throw e; }

  function taskModule(t) {
    const ctl = new Set(["name", "when", "loop", "with_items", "with_list", "with_dict", "with_fileglob", "register", "notify", "tags", "become", "become_user", "ignore_errors", "ignore_unreachable", "changed_when", "failed_when", "vars", "environment", "delegate_to", "run_once", "loop_control", "args", "listen", "check_mode", "no_log", "until", "retries", "delay", "block", "rescue", "always", "any_errors_fatal", "when_changed", "become_method", "connection", "diff", "throttle", "timeout", "remote_user", "module_defaults", "collections", "async", "poll", "debugger", "ansible.builtin.meta"]);
    const keys = Object.keys(t).filter(k => !ctl.has(k)); return keys;
  }
  function validateTasks(list) {
    list.forEach(t => {
      if (!t || typeof t !== "object" || Array.isArray(t)) throw new AErr("a task must be a dictionary", lineOf(list));
      if (t.block) { validateTasks([].concat(t.block || [], t.rescue || [], t.always || [])); return; }
      const keys = taskModule(t);
      if (keys.length === 0) throw new AErr("no module/action detected in task.", lineOf(t));
      if (keys.length > 1) throw new AErr("conflicting action statements: " + keys.join(", "), lineOf(t));
      const mod = keys[0].split(".").pop();
      if (!MODS.includes(mod)) throw new AErr("couldn't resolve module/action '" + keys[0] + "'. This often indicates a misspelling, missing collection, or incorrect module path.", lineOf(t));
      if (["import_tasks", "include_tasks", "include_vars"].includes(mod) && mod !== "include_vars") throw new AErr(mod + " needs extra files, which the simulator doesn't have — put the tasks inline", lineOf(t));
    });
  }

  const globalFacts = {};
  plays.forEach((pl, pi) => {
    const pname = render(String(pl.name === undefined ? "" : pl.name), {}) ;
    const m = matchHosts(render(String(pl.hosts), extra), inv);
    m.warn.forEach(w => log("[WARNING]: Could not match supplied host pattern, ignoring: " + w));
    if (opts.limit) { const lim = matchHosts(opts.limit, inv); m.hosts = m.hosts.filter(h => lim.hosts.includes(h)); }
    log("\n" + banner("PLAY", pname)); log("");
    out.timeline.push({ k: "play", name: pname, hosts: m.hosts.slice(), banner: banner("PLAY", pname) });
    if (!m.hosts.length) { log("skipping: no hosts matched"); out.timeline.push({ k: "note", text: "skipping: no hosts matched" }); return; }
    // per-host runtime
    const rt = {}; let up = [];
    m.hosts.forEach(h => {
      const hv = inv.hostVars(h);
      rt[h] = { vars: Object.assign({}, hv, pl.vars || {}), facts: {}, reg: {}, set: {}, notified: new Set(), ranHandlers: new Set(), failed: false, unreachable: false, st: hostState(state, h), hv };
      ensure(h);
    });
    // static play-level var rendering happens lazily in ctx()
    function hostCtx(h, extraVars) {
      const r = rt[h], base = {};
      Object.assign(base, r.vars, r.facts, r.reg, r.set, extraVars || {}, extra);
      base.inventory_hostname = h; base.inventory_hostname_short = h.split(".")[0];
      base.ansible_host = r.hv.ansible_host || h; base.ansible_user = r.hv.ansible_user || "deploy";
      base.groups = Object.assign({}, inv.resolved); base.group_names = inv.hosts[h].groups; base.playbook_dir = "/home/user/playbooks"; base.ansible_check_mode = check;
      base.ansible_version = { full: "2.17.4", major: 2, minor: 17 }; base.ansible_play_hosts = m.hosts.filter(x => !rt[x].failed && !rt[x].unreachable); base.ansible_play_batch = base.ansible_play_hosts;
      base.hostvars = {}; m.hosts.forEach(x => { base.hostvars[x] = Object.assign({}, rt[x].vars, rt[x].facts, rt[x].set, { inventory_hostname: x, ansible_host: rt[x].hv.ansible_host || x }); });
      if (r.facts.ansible_facts) base.ansible_facts = r.facts.ansible_facts;
      // lazily render play vars that reference other vars
      Object.keys(r.vars).forEach(k => { if (typeof r.vars[k] === "string" && r.vars[k].includes("{{") && !(k in r.set)) { try { base[k] = render(r.vars[k], base); } catch (e) { base[k] = new Undefined(k); } } });
      return base;
    }
    const become0 = pl.become === true || pl.become === "yes";
    function runTask(t, h, ctxVars, handler) { return execTask(t, h, ctxVars, handler, become0); }

    // --- facts
    function gather() {
      const res = [];
      m.hosts.forEach(h => {
        const r = rt[h], idx = Object.keys(inv.hosts).indexOf(h);
        if (/^(down|offline)|unreachable|-down$/.test(h) || r.hv.ansible_host === "unreachable") { r.unreachable = true; res.push({ host: h, st: "unreachable", text: ["fatal: [" + h + "]: UNREACHABLE! => {\"changed\": false, \"msg\": \"Failed to connect to the host via ssh: ssh: connect to host " + (r.hv.ansible_host || h) + " port 22: Connection timed out\", \"unreachable\": true}"], dur: 6000 }); bump(h, "unreachable"); return; }
        const f = { ansible_hostname: h, ansible_fqdn: h + ".example.com", ansible_os_family: "Debian", ansible_distribution: "Ubuntu", ansible_distribution_version: "24.04", ansible_distribution_release: "noble", ansible_architecture: "x86_64", ansible_kernel: "6.8.0-45-generic", ansible_processor_vcpus: 2, ansible_memtotal_mb: 3912, ansible_default_ipv4: { address: r.hv.ansible_host || "10.0.0." + (10 + idx), interface: "eth0", gateway: "10.0.0.1" }, ansible_date_time: { date: new Date().toISOString().slice(0, 10), time: new Date().toISOString().slice(11, 19), iso8601: new Date().toISOString(), epoch: String(Math.floor(Date.now() / 1000)), year: String(new Date().getFullYear()) }, ansible_pkg_mgr: "apt", ansible_user_id: r.hv.ansible_user || "deploy", ansible_python_version: "3.12.3", ansible_service_mgr: "systemd", ansible_nodename: h };
        r.facts = Object.assign({}, f, { ansible_facts: Object.assign({}, f) });
        res.push({ host: h, st: "ok", text: ["ok: [" + h + "]"], dur: 900 + idx * 120 }); bump(h, "ok");
      });
      pushTask("Gathering Facts", res);
    }
    function pushTask(name, results, handler, tag) {
      const hb = banner(handler ? "RUNNING HANDLER" : "TASK", name);
      log(hb); results.forEach(r => r.text.forEach(l => log(l))); log("");
      out.timeline.push({ k: "task", name, banner: hb, results, handler: !!handler, tag });
    }

    function execList(list, handlerPhase) {
      list.forEach(t => {
        if (t.block) { execBlock(t); return; }
        if (taskModule(t)[0].split(".").pop() === "meta") { const a = String(t[taskModule(t)[0]]); if (a === "flush_handlers") flushHandlers(); else if (a === "end_play") { m.hosts.forEach(h => { rt[h].ended = true; }); } return; }
        if (!tagOk(t)) return;
        const live = m.hosts.filter(h => !rt[h].failed && !rt[h].unreachable && !rt[h].ended);
        if (!live.length) return;
        runOne(t, live, false);
      });
    }
    function tagOk(t) {
      const tg = [].concat(t.tags || []).concat(pl.tags || []); const always = tg.includes("always");
      if (tagsOnly && !always && !tg.some(x => tagsOnly.includes(x))) return false;
      if (skipTags.length && tg.some(x => skipTags.includes(x))) return false; return true;
    }
    function runOne(t, live, handler) {
      const key = taskModule(t)[0];
      let tname; try { tname = t.name !== undefined ? String(render(String(t.name), hostCtx(live[0]))) : key; } catch (e) { tname = String(t.name); }
      const results = [];
      live.forEach(h => {
        const r = rt[h];
        if (r.failed || r.unreachable) return;
        const rs = execTask(t, h, null, handler, become0);
        rs.forEach(x => results.push(x));
      });
      pushTask(tname, results, handler, null);
    }
    function execBlock(b) {
      const live = m.hosts.filter(h => !rt[h].failed && !rt[h].unreachable && !rt[h].ended);
      if (!live.length) return;
      // run block tasks; for hosts that fail inside, run rescue; then always
      const failedHere = new Set();
      const runSeq = (list, phase) => list.forEach(t => {
        if (t.block) { execBlock(t); return; }
        if (!tagOk(t)) return;
        const hs = m.hosts.filter(h => !rt[h].unreachable && (phase === "always" ? true : phase === "rescue" ? failedHere.has(h) : !failedHere.has(h) && !rt[h].failed));
        if (!hs.length) return;
        const key = taskModule(t)[0]; let tname = t.name !== undefined ? String(t.name) : key; try { tname = String(render(tname, hostCtx(hs[0]))); } catch (e) {}
        const results = []; hs.forEach(h => { if (phase === "rescue" && !failedHere.has(h)) return; const r = rt[h]; const was = r.failed; if (phase === "rescue" || phase === "always") r.failed = false; const rs = execTask(Object.assign({}, t, b.become !== undefined && t.become === undefined ? { become: b.become } : {}), h, null, false, become0 || b.become === true); rs.forEach(x => results.push(x)); if (phase === "block" && r.failed) { r.failed = false; failedHere.add(h); r.blockFailed = true; } if (phase === "always" && was) r.failed = true; });
        pushTask(tname, results, false, null);
      });
      runSeq(b.block || [], "block");
      if (b.rescue && failedHere.size) { failedHere.forEach(h => { recap[h].failed = Math.max(0, recap[h].failed - 1); }); runSeq(b.rescue, "rescue"); failedHere.forEach(h => { if (!rt[h].failed) bump(h, "rescued"); }); }
      else failedHere.forEach(h => { rt[h].failed = true; });
      if (b.always) runSeq(b.always, "always");
    }
    function flushHandlers() {
      const hlist = (pl.handlers || []);
      hlist.forEach(hd => {
        const names = [].concat(hd.listen || [], hd.name === undefined ? [] : [String(hd.name)]);
        const hosts = m.hosts.filter(h => !rt[h].failed && !rt[h].unreachable && names.some(n => rt[h].notified.has(n)) && !rt[h].ranHandlers.has(hd));
        if (!hosts.length) return;
        const key = taskModule(hd)[0]; const tname = hd.name !== undefined ? String(hd.name) : key; const results = [];
        hosts.forEach(h => { rt[h].ranHandlers.add(hd); names.forEach(n => rt[h].notified.delete(n)); execTask(hd, h, null, true, become0).forEach(x => results.push(x)); });
        pushTask(tname, results, true, null);
      });
    }

    /* the heart: one task on one host (with loops) */
    function execTask(t, h, _unused, handler, become) {
      const r = rt[h], key = taskModule(t)[0], mod = key.split(".").pop(); const results = [];
      const tvars = t.vars ? t.vars : {};
      const mkctx = (extraV) => { const c = hostCtx(h, Object.assign({}, tvars && Object.keys(tvars).length ? safeRenderVars(tvars, hostCtx(h)) : {}, extraV || {})); return c; };
      function safeRenderVars(v, c) { const o = {}; Object.keys(v).forEach(k => { try { o[k] = deepRender(v[k], c); } catch (e) { o[k] = v[k]; } }); return o; }
      let items = null, labelKey = null, loopVar = "item";
      try {
        const loopSrc = t.loop !== undefined ? t.loop : t.with_items !== undefined ? t.with_items : t.with_list !== undefined ? t.with_list : t.with_dict !== undefined ? t.with_dict : undefined;
        if (loopSrc !== undefined) {
          let v = deepRender(loopSrc, mkctx()); if (isUndef(v)) throw new AErr("'" + v.name + "' is undefined");
          if (t.with_dict !== undefined && v && !Array.isArray(v)) v = Object.keys(v).map(k => ({ key: k, value: v[k] }));
          if (t.with_items !== undefined && Array.isArray(v)) v = v.reduce((a, x) => a.concat(Array.isArray(x) ? x : [x]), []);
          if (!Array.isArray(v)) throw new AErr("Invalid data passed to 'loop', it requires a list, got this instead: " + str(v) + ". Hint: If you passed a list/dict of just one element, try adding wantlist=True to your lookup invocation or use q/query instead of lookup.");
          items = v; if (t.loop_control) { if (t.loop_control.loop_var) loopVar = t.loop_control.loop_var; labelKey = t.loop_control.label; }
        }
      } catch (e) { return [fatalRes(h, t, e.message, "failed")]; }
      const once = (item, idx, isLoop) => {
        const ex = {}; if (isLoop) { ex[loopVar] = item; if (t.loop_control && t.loop_control.index_var) ex[t.loop_control.index_var] = idx; ex.ansible_loop = { index: idx + 1, index0: idx, first: idx === 0, last: idx === items.length - 1, length: items.length }; }
        const ctx = mkctx(ex);
        const lab = isLoop ? " (item=" + (labelKey ? str(render(labelKey, ctx)) : itemLabel(item)) + ")" : "";
        // when
        try { if (!evalCond(t.when, ctx)) return { host: h, st: "skipped", text: ["skipping: [" + h + "]" + (isLoop ? " => (item=" + (labelKey ? str(render(labelKey, ctx)) : itemLabel(item)) + ")" : "")], dur: 40, data: { skipped: true, changed: false, skip_reason: "Conditional result was False", false_condition: String(t.when) } }; }
        catch (e) { return fatalRes(h, t, String(e.message).startsWith("The conditional") ? e.message : "The conditional check '" + String(t.when) + "' failed. The error was: " + e.message, "failed", lab); }
        // args
        let args;
        try { args = normalizeArgs(mod, t[key], t.args, ctx); } catch (e) { return fatalRes(h, t, "The task includes an option with an undefined variable. The error was: " + e.message, "failed", lab); }
        // privilege
        const tBecome = t.become !== undefined ? (t.become === true || t.become === "yes") : become;
        const isRoot = (ctx.ansible_user === "root"); const needRoot = needsRoot(mod, args);
        let res;
        if (needRoot && !tBecome && !isRoot) res = privFail(mod, args);
        else { try { res = simulate(mod, args, h, r, ctx, check, t, tBecome || isRoot); } catch (e) { if (e instanceof AErr) res = { failed: true, changed: false, msg: e.message }; else throw e; } }
        if (res.skipCheck && check) res = { skipped: true, changed: false, msg: "Command would have run if not in check mode", skip_reason: "Conditional result was False" };
        // changed_when / failed_when
        const rctx = Object.assign({}, ctx, { [t.register || "__r"]: res });
        try {
          if (t.changed_when !== undefined) res.changed = evalCond(t.changed_when, rctx);
          if (t.failed_when !== undefined) { res.failed = evalCond(t.failed_when, rctx); if (res.failed) res.failed_when_result = true; }
        } catch (e) { res = { failed: true, changed: false, msg: "The conditional check '" + (t.failed_when || t.changed_when) + "' failed. The error was: " + e.message }; }
        if (t.register && !isLoop) r.reg[t.register] = res;
        // output
        const ign = t.ignore_errors === true || t.ignore_errors === "yes";
        let text = [], st;
        if (res.skipped) { st = "skipped"; text = ["skipping: [" + h + "]" + (isLoop ? " => (item=" + (labelKey ? str(render(labelKey, ctx)) : itemLabel(item)) + ")" : "")]; }
        else if (res.failed) {
          st = ign ? "ignored" : "failed";
          const js = toJson(cleanRes(res, isLoop ? item : undefined, loopVar));
          text = [(isLoop ? "failed: [" + h + "] (item=" + (labelKey ? str(render(labelKey, ctx)) : itemLabel(item)) + ") => " : "fatal: [" + h + "]: FAILED! => ") + js];
          if (ign) text.push("...ignoring");
        } else {
          st = res.changed ? "changed" : "ok";
          const head = (res.changed ? "changed" : "ok") + ": [" + h + "]" + (isLoop ? " => (item=" + (labelKey ? str(render(labelKey, ctx)) : itemLabel(item)) + ")" : "");
          if (mod === "debug") {
            const shown = res._dbg; text = [head + " => " + (isLoop ? "" : "") + toJson(shown, 4)];
          } else text = [head];
        }
        if (!res.skipped && !res.failed && res.changed && t.notify) { [].concat(t.notify).forEach(n => { try { r.notified.add(String(render(String(n), ctx))); } catch (e) { r.notified.add(String(n)); } }); }
        return { host: h, st, text, dur: res.dur || 300, data: res, item: isLoop ? item : undefined, lab };
      };
      if (items === null) {
        let tries = 1, delay = 0; if (t.until !== undefined) { tries = t.retries === undefined ? 3 : +t.retries; delay = +(t.delay || 5); }
        let x = once(undefined, 0, false);
        if (t.until !== undefined) { let n = 1; while (n < tries && x.st !== "skipped") { let ok = false; try { ok = evalCond(t.until, Object.assign(mkctx(), { [t.register || "__r"]: x.data })); } catch (e) {} if (ok) break; x.text.unshift("FAILED - RETRYING: [" + h + "]: " + (t.name || key) + " (" + (tries - n) + " retries left)."); n++; x = Object.assign(once(undefined, 0, false), { text: x.text.slice(0, 1).concat(once(undefined, 0, false).text) }); } }
        finalize(x, results);
      } else {
        const subs = []; items.forEach((it, i) => { const x = once(it, i, true); subs.push(x); });
        const anyFail = subs.some(x => x.st === "failed" || x.st === "ignored"), anyChange = subs.some(x => x.st === "changed");
        if (t.register) r.reg[t.register] = { changed: anyChange, failed: subs.some(x => x.st === "failed"), msg: "All items completed", results: subs.map(x => Object.assign({}, x.data, { item: x.item })), skipped: subs.length > 0 && subs.every(x => x.st === "skipped") };
        subs.forEach(x => { finalize(x, results, true); });
        if (!items.length) { results.push({ host: h, st: "skipped", text: ["skipping: [" + h + "] => {\"changed\": false, \"skipped_reason\": \"No items in the list\"}"], dur: 30 }); bump(h, "skipped"); }
      }
      return results;
    }
    function finalize(x, results, isLoop) {
      const h = x.host, r = rt[h];
      if (x.st === "skipped") bump(h, "skipped");
      else if (x.st === "changed") { bump(h, "ok"); bump(h, "changed"); }
      else if (x.st === "ok") bump(h, "ok");
      else if (x.st === "ignored") { bump(h, "ignored"); }
      else if (x.st === "failed") { bump(h, "failed"); r.failed = true; }
      results.push(x);
    }
    function fatalRes(h, t, msg, st, lab) { bump(h, "failed"); const ign = t.ignore_errors === true; if (ign) { recap[h].failed--; recap[h].ignored++; } else rt[h].failed = true; return { host: h, st: ign ? "ignored" : "failed", text: ["fatal: [" + h + "]: FAILED! => " + toJson({ msg })].concat(ign ? ["...ignoring"] : []), dur: 100, data: { failed: true, msg } }; }

    // ---- run the play
    const hasFacts = pl.gather_facts !== false && pl.gather_facts !== "no";
    if (hasFacts) gather();
    // fact-gathering unreachable hosts bump handled; failures
    const sections = [pl.pre_tasks || [], pl.tasks || [], pl.post_tasks || []];
    sections.forEach((sec, si) => { execList(sec); if (si === 0 || si === 1 || si === 2) flushHandlers(); });
    log(""); out.timeline.push({ k: "playend" });
  });

  // recap
  log(banner("PLAY RECAP", "").replace("[] ", "").replace("PLAY RECAP ", "PLAY RECAP "));
  const names = Object.keys(recap); const w = Math.max(26, ...names.map(n => n.length));
  const rows = names.map(n => { const c = recap[n]; return { host: n, c }; });
  rows.forEach(r => { r.line = r.host.padEnd(w) + " : ok=" + String(r.c.ok).padEnd(4) + " changed=" + String(r.c.changed).padEnd(4) + " unreachable=" + String(r.c.unreachable).padEnd(4) + " failed=" + String(r.c.failed).padEnd(4) + " skipped=" + String(r.c.skipped).padEnd(4) + " rescued=" + String(r.c.rescued).padEnd(4) + " ignored=" + r.c.ignored; log(r.line); });
  out.recap = rows; out.timeline.push({ k: "recap", rows });
  out.rc = rows.some(r => r.c.failed) ? 2 : rows.some(r => r.c.unreachable) ? 4 : 0;
  out.ok = out.rc === 0; out.state = check ? JSON.parse(JSON.stringify(opts.state0 || state)) : state;
  if (check) out.state = null;
  return out;
}
const itemLabel = it => (it !== null && typeof it === "object" ? pyRepr(it) : str(it));
function cleanRes(res, item, loopVar) { const o = Object.assign({}, res); delete o.dur; delete o._dbg; delete o.skipCheck; if (item !== undefined) o[loopVar] = item; if (!("changed" in o)) o.changed = false; const ordered = { changed: !!o.changed }; Object.keys(o).forEach(k => { if (k !== "changed" && k !== "failed") ordered[k] = o[k]; }); return ordered; }

function normalizeArgs(mod, raw, extraArgs, ctx) {
  let a;
  if (raw === null || raw === undefined) a = {};
  else if (typeof raw === "string") {
    if (["command", "shell", "raw", "script"].includes(mod)) a = { _raw: render(raw, ctx) };
    else { a = {}; const s = render(raw, ctx); const re = /([\w]+)=("([^"]*)"|'([^']*)'|(\S*))/g; let m, any = false; while ((m = re.exec(s))) { any = true; a[m[1]] = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5]; } if (!any) a = { _raw: s }; }
  } else if (typeof raw === "object") a = deepRender(raw, ctx);
  else a = { _raw: raw };
  if (extraArgs) Object.assign(a, deepRender(extraArgs, ctx));
  if (typeof a.cmd === "string" && (mod === "command" || mod === "shell")) a._raw = a.cmd;
  Object.keys(a).forEach(k => { if (typeof a[k] === "string" && /^(yes|true)$/i.test(a[k]) && ["update_cache", "enabled", "create", "recurse", "backup", "force", "remote_src", "append", "create_home", "system", "daemon_reload", "insertafter_flag"].includes(k)) a[k] = true; if (typeof a[k] === "string" && /^(no|false)$/i.test(a[k]) && ["update_cache", "enabled", "create", "recurse", "backup", "force", "append"].includes(k)) a[k] = false; });
  return a;
}
function needsRoot(mod, a) {
  if (["apt", "yum", "dnf", "package", "service", "systemd", "systemd_service", "user", "group", "hostname", "reboot", "ufw", "apt_repository", "sysctl", "timezone", "mount"].includes(mod)) return true;
  if (["copy", "template", "file", "lineinfile", "blockinfile", "get_url", "replace", "unarchive"].includes(mod)) { const p = a.dest || a.path || a.name; return typeof p === "string" && SYSTEM_DIR.test(p); }
  if (mod === "cron") return a.user === "root" || !!a.cron_file;
  return false;
}
function privFail(mod, a) {
  let msg;
  if (["apt", "yum", "dnf", "package"].includes(mod)) msg = "Failed to lock apt for exclusive operation: Failed to lock directory /var/lib/apt/lists/: E:Could not open lock file /var/lib/apt/lists/lock - open (13: Permission denied)";
  else if (["service", "systemd", "systemd_service"].includes(mod)) msg = "Unable to " + (a.state || "manage") + " service " + (a.name || "") + ": Failed to " + (a.state === "stopped" ? "stop" : "start") + " " + (a.name || "") + ".service: Interactive authentication required.\nSee system logs and 'systemctl status " + (a.name || "") + ".service' for details.";
  else if (mod === "user" || mod === "group") msg = "useradd: Permission denied.\nuseradd: cannot lock /etc/passwd; try again later.";
  else if (mod === "hostname" || mod === "reboot" || mod === "ufw") msg = "Permission denied: root privileges are required";
  else msg = "[Errno 13] Permission denied: '" + (a.dest || a.path || a.name) + "'";
  return { failed: true, changed: false, msg: msg + "  (hint: add `become: true`)" };
}
const modeOf = m => (m === undefined || m === null ? undefined : (typeof m === "number" ? m.toString(8).padStart(4, "0") : String(m).padStart(4, "0")));
const asList = v => (v === undefined || v === null ? [] : Array.isArray(v) ? v : String(v).split(",").map(s => s.trim()).filter(Boolean));
function ensureDir(st, path) { const parts = path.split("/").filter(Boolean); let cur = ""; parts.forEach(p => { cur += "/" + p; if (!st.dirs[cur]) st.dirs[cur] = 1; }); }
function parentDirOk(st, path) { const i = path.lastIndexOf("/"); const d = i <= 0 ? "/" : path.slice(0, i); return !!st.dirs[d] || d === "/"; }
function fingerprint(o) { const s = JSON.stringify(o); let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(16); }

function simulate(mod, a, h, r, ctx, check, task, become) {
  const st = r.st; const res = { changed: false, dur: 250 };
  const apply = fn => { if (!check) fn(); };
  const resolvePkg = n => ALIAS[n] || n;
  switch (mod) {
    case "ping": res.ping = a.data || "pong"; res.dur = 120; return res;
    case "setup": res.dur = 800; return res;
    case "debug": {
      res.dur = 40;
      if (a.var !== undefined) { const v = evalExpr(String(a.var), ctx); res._dbg = { [a.var]: isUndef(v) ? "VARIABLE IS NOT DEFINED!" : v }; }
      else res._dbg = { msg: a.msg === undefined ? "Hello world!" : a.msg };
      return res;
    }
    case "set_fact": { Object.keys(a).forEach(k => { if (k === "cacheable") return; r.set[k] = a[k]; }); res.ansible_facts = Object.assign({}, a); res.dur = 30; return res; }
    case "assert": {
      const th = asList(a.that).length ? [].concat(a.that) : []; res.dur = 30;
      for (const c of th) { if (!evalCond(c, ctx)) { return { failed: true, changed: false, assertion: String(c), evaluated_to: false, msg: a.fail_msg || a.msg || "Assertion failed" }; } }
      res.msg = a.success_msg || "All assertions passed"; res._dbg = { changed: false, msg: res.msg }; return res;
    }
    case "fail": return { failed: true, changed: false, msg: a.msg === undefined ? "Failed as requested from task" : a.msg };
    case "pause": res.dur = 400; res.delta = a.seconds || a.minutes * 60 || 0; res.user_input = ""; return res;
    case "apt": case "yum": case "dnf": case "dnf5": case "package": {
      const names = asList(a.name || a.pkg || a.package), state = a.state || "present"; res.dur = 2500;
      if (a.update_cache && mod === "apt") { res.cache_updated = true; res.cache_update_time = Math.floor(Date.now() / 1000); if (!names.length) { res.changed = !st.cacheUpdatedRecently; apply(() => { st.cacheUpdatedRecently = true; }); res.dur = 2000; return res; } }
      if (a.upgrade || (a.name === "*" && state === "latest")) { res.changed = true; res.dur = 5000; return res; }
      if (!names.length) return { failed: true, changed: false, msg: "one of the following is required: name, deb, upgrade" };
      const changedPk = [], msgs = [];
      for (const raw of names) {
        const n = resolvePkg(String(raw).replace(/[=<>].*$/, ""));
        if (state === "absent" || state === "removed") { if (st.pkgs[n]) { changedPk.push(n); apply(() => { removePkg(st, n); }); } continue; }
        if (!CATALOG[n]) { if (st.pkgs[n]) continue; return { failed: true, changed: false, msg: mod === "apt" ? "No package matching '" + raw + "' is available" : "No package " + raw + " available.", rc: 100 }; }
        if (!st.pkgs[n]) { changedPk.push(n); apply(() => installPkg(st, n)); }
        else if (state === "latest" && !st.latest) { /* assume latest already */ }
      }
      res.changed = changedPk.length > 0; res.dur = 800 + changedPk.length * 2200;
      if (res.changed) { res.stdout = (state === "absent" ? "Removing " : "Setting up ") + changedPk.join(", ") + " ..."; res.stdout_lines = [res.stdout]; }
      return res;
    }
    case "service": case "systemd": case "systemd_service": {
      const name = String(a.name || "").replace(/\.service$/, ""); res.dur = 700; if (!name) return { failed: true, changed: false, msg: "name is required" };
      if (a.daemon_reload && !name) { res.changed = false; return res; }
      const sv = st.svcs[name];
      if (!sv) { if (a.state === undefined && a.enabled === undefined) return res; return { failed: true, changed: false, msg: "Could not find the requested service " + name + ": host" }; }
      const want = a.state, wantEn = a.enabled; let ch = false;
      const sn = { state: sv.state, enabled: sv.enabled };
      if (want === "started" && sv.state !== "started") { ch = true; sn.state = "started"; }
      if (want === "stopped" && sv.state !== "stopped") { ch = true; sn.state = "stopped"; }
      if (want === "restarted") { ch = true; sn.state = "started"; }
      if (want === "reloaded") { ch = true; if (sv.state !== "started") return { failed: true, changed: false, msg: "Unable to reload service " + name + ": " + name + ".service is not active, cannot reload." }; }
      if (wantEn !== undefined && !!wantEn !== !!sv.enabled) { ch = true; sn.enabled = !!wantEn; }
      if (ch && sn.state === "started" && PORTS[name] && !(name in (st.brokenSvc || {}))) { /* ok */ }
      apply(() => { st.svcs[name] = sn; });
      res.changed = ch; res.name = name; res.state = sn.state; res.enabled = sn.enabled; res.status = { ActiveState: sn.state === "started" ? "active" : "inactive", UnitFileState: sn.enabled ? "enabled" : "disabled" };
      return res;
    }
    case "copy": case "template": {
      const dest = a.dest; if (!dest) return { failed: true, changed: false, msg: "missing required arguments: dest" };
      let content, srcDesc = a.src;
      if (mod === "template") {
        if (a.content !== undefined) content = String(a.content);
        else { if (!a.src) return { failed: true, changed: false, msg: "missing required arguments: src" }; content = "# Ansible managed — rendered from " + a.src + "\n# vars fingerprint: " + fingerprint(Object.keys(ctx).filter(k => !/^(hostvars|groups|ansible_(facts|play|date)|inventory_hostname_short)/.test(k) && typeof ctx[k] !== "object").sort().map(k => [k, ctx[k]])) + "\n"; }
      } else content = a.content !== undefined ? (typeof a.content === "object" ? toJson(a.content, 4) + "\n" : String(a.content)) : "# contents of " + (a.src || "file") + "\n";
      const destIsDir = /\/$/.test(dest) || st.dirs[dest.replace(/\/$/, "")] && !st.files[dest];
      const path = destIsDir ? dest.replace(/\/$/, "") + "/" + String(a.src || "file").split("/").pop().replace(/\.j2$/, "") : dest;
      if (!check && !parentDirOk(st, path)) return { failed: true, changed: false, msg: "Destination directory " + path.slice(0, path.lastIndexOf("/")) + " does not exist" };
      const ex = st.files[path], mode = modeOf(a.mode) || (ex && ex.m) || "0644", owner = a.owner || (ex && ex.o) || (a.owner === undefined ? "root" : "root");
      const changed = !ex || ex.c !== content || (a.mode !== undefined && ex.m !== mode) || (a.owner !== undefined && ex.o !== owner);
      if (a.force === false && ex) { res.changed = false; return res; }
      apply(() => { if (changed) st.files[path] = { c: content, m: mode, o: owner, t: "file" }; });
      res.changed = changed; res.dest = path; res.mode = mode; res.owner = owner; res.size = content.length; res.state = "file"; res.checksum = fingerprint(content); if (a.validate) res.dur += 200; res.dur += 200; return res;
    }
    case "file": {
      const path = a.path || a.dest || a.name; if (!path) return { failed: true, changed: false, msg: "missing required arguments: path" };
      const state = a.state || "file", mode = modeOf(a.mode); res.path = path; res.dur = 200;
      if (state === "directory") {
        const had = !!st.dirs[path]; if (!had && !a.recurse && !parentDirOk(st, path) && !path.startsWith("/home") ) { /* ansible creates parents */ }
        apply(() => { ensureDir(st, path); if (mode) st.dirs["__m" + path] = mode; });
        const mch = mode && st.dirs["__m" + path] !== mode; res.changed = !had || !!mch; res.state = "directory"; res.mode = mode || "0755"; res.owner = a.owner || "root"; return res;
      }
      if (state === "touch") { const ex = st.files[path]; apply(() => { if (!ex) st.files[path] = { c: "", m: mode || "0644", o: a.owner || "root", t: "file" }; else if (mode) ex.m = mode; }); res.changed = true; res.state = "file"; return res; }
      if (state === "absent") { const had = !!st.files[path] || !!st.dirs[path]; apply(() => { delete st.files[path]; Object.keys(st.dirs).filter(d => d === path || d.startsWith(path + "/")).forEach(d => delete st.dirs[d]); Object.keys(st.files).filter(f => f.startsWith(path + "/")).forEach(f => delete st.files[f]); }); res.changed = had; res.state = "absent"; return res; }
      if (state === "link") { const ex = st.files[path]; const same = ex && ex.t === "link" && ex.c === a.src; apply(() => { st.files[path] = { c: a.src, m: "0777", o: "root", t: "link" }; }); res.changed = !same; res.dest = path; res.src = a.src; res.state = "link"; return res; }
      const ex = st.files[path]; if (!ex) return { failed: true, changed: false, path, state: "absent", msg: "file (" + path + ") is absent, cannot continue" };
      const ch = (mode && ex.m !== mode) || (a.owner && ex.o !== a.owner); apply(() => { if (mode) ex.m = mode; if (a.owner) ex.o = a.owner; }); res.changed = !!ch; res.state = "file"; return res;
    }
    case "lineinfile": case "blockinfile": case "replace": {
      const path = a.path || a.dest; if (!path) return { failed: true, changed: false, msg: "missing required arguments: path" };
      let f = st.files[path]; res.dur = 220;
      if (!f) { if (a.create || (mod === "blockinfile" && a.create)) { f = { c: "", m: "0644", o: "root", t: "file" }; } else return { failed: true, changed: false, msg: "Destination " + path + " does not exist !", rc: 257 }; }
      let c = f.c, changed = false;
      if (mod === "lineinfile") {
        const present = (a.state || "present") !== "absent"; const re = a.regexp ? new RegExp(String(a.regexp)) : null; const ls = c === "" ? [] : c.replace(/\n$/, "").split("\n");
        if (present) {
          if (a.line === undefined) return { failed: true, changed: false, msg: "one of the following is required: line" };
          let idx = re ? ls.map((l, i) => re.test(l) ? i : -1).filter(i => i >= 0).pop() : ls.indexOf(a.line);
          if (idx !== undefined && idx >= 0) { if (ls[idx] !== a.line) { ls[idx] = a.line; changed = true; } }
          else if (re && false) { }
          else { if (a.insertbefore === "BOF") ls.unshift(a.line); else ls.push(a.line); changed = true; }
        } else { const keep = ls.filter(l => !(re ? re.test(l) : l === a.line)); if (keep.length !== ls.length) { changed = true; ls.length = 0; keep.forEach(x => ls.push(x)); } }
        c = ls.length ? ls.join("\n") + "\n" : "";
      } else if (mod === "blockinfile") {
        const marker = (a.marker || "# {mark} ANSIBLE MANAGED BLOCK"), b0 = marker.replace("{mark}", "BEGIN"), b1 = marker.replace("{mark}", "END");
        const block = b0 + "\n" + String(a.block === undefined ? "" : a.block).replace(/\n$/, "") + "\n" + b1 + "\n";
        const re = new RegExp(b0.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\\s\\S]*?" + b1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\n?");
        if ((a.state || "present") === "absent") { if (re.test(c)) { c = c.replace(re, ""); changed = true; } }
        else if (re.test(c)) { if (c.match(re)[0] !== block) { c = c.replace(re, block); changed = true; } } else { c = c + (c && !c.endsWith("\n") ? "\n" : "") + block; changed = true; }
      } else { const re = new RegExp(a.regexp, "g"); const nc = c.replace(re, a.replace === undefined ? "" : a.replace); if (nc !== c) { changed = true; c = nc; } }
      apply(() => { if (changed || !st.files[path]) st.files[path] = Object.assign(f, { c }); });
      res.changed = changed; res.msg = changed ? (mod === "lineinfile" ? "line added" : "block inserted") : ""; if (!changed) delete res.msg; res.backup = ""; return res;
    }
    case "user": {
      const name = a.name; if (!name) return { failed: true, changed: false, msg: "missing required arguments: name" }; res.dur = 500;
      const ex = st.users[name]; const state = a.state || "present";
      if (state === "absent") { res.changed = !!ex; apply(() => { delete st.users[name]; }); res.name = name; res.state = "absent"; return res; }
      const groups = asList(a.groups), g = a.group, shell = a.shell;
      for (const gg of groups) if (!st.groups[gg]) return { failed: true, changed: false, msg: "Group " + gg + " does not exist" };
      const nu = ex ? { uid: ex.uid, groups: ex.groups.slice(), shell: ex.shell } : { uid: 1001 + Object.keys(st.users).length - 2, groups: [g || name], shell: shell || "/bin/sh" };
      let ch = !ex;
      if (shell && nu.shell !== shell) { nu.shell = shell; ch = true; }
      if (groups.length) { if (a.append) { groups.forEach(x => { if (!nu.groups.includes(x)) { nu.groups.push(x); ch = true; } }); } else if (JSON.stringify(groups.slice().sort()) !== JSON.stringify(nu.groups.filter(x => x !== (g || name)).sort())) { nu.groups = [g || name].concat(groups); ch = true; } }
      apply(() => { st.users[name] = nu; if (!ex) { st.groups[name] = 1; if (a.create_home !== false) ensureDir(st, "/home/" + name); } });
      res.changed = ch; res.name = name; res.uid = nu.uid; res.shell = nu.shell; res.groups = nu.groups.join(","); res.home = "/home/" + name; res.state = "present"; return res;
    }
    case "group": { const name = a.name; res.dur = 300; const had = !!st.groups[name]; if ((a.state || "present") === "absent") { res.changed = had; apply(() => { delete st.groups[name]; }); } else { res.changed = !had; apply(() => { st.groups[name] = 1; }); } res.name = name; return res; }
    case "command": case "shell": case "raw": case "script": {
      const cmd = a._raw === undefined ? (a.argv ? a.argv.join(" ") : "") : a._raw; res.cmd = cmd; res.dur = 350;
      if (!cmd) return { failed: true, changed: false, msg: "no command given", rc: 256 };
      if (a.creates && (st.files[a.creates] || st.dirs[a.creates])) return { changed: false, skipped: true, msg: "Did not run command since '" + a.creates + "' exists", rc: 0, stdout: "skipped, since " + a.creates + " exists", cmd };
      if (a.removes && !(st.files[a.removes] || st.dirs[a.removes])) return { changed: false, skipped: true, msg: "Did not run command since '" + a.removes + "' does not exist", rc: 0, cmd };
      if (check && !task.check_mode) return { skipCheck: true };
      const o = fakeCommand(cmd.trim(), h, r, st, ctx, apply);
      res.rc = o.rc; res.stdout = o.out; res.stderr = o.err || ""; res.stdout_lines = o.out === "" ? [] : o.out.split("\n"); res.stderr_lines = res.stderr ? res.stderr.split("\n") : []; res.changed = o.changed !== false; res.delta = "0:00:00.0" + (10 + (cmd.length % 80));
      if (o.rc !== 0) { res.failed = true; res.msg = "non-zero return code"; }
      return res;
    }
    case "stat": { const p = a.path; res.dur = 80; const f = st.files[p], d = st.dirs[p]; res.stat = f ? { exists: true, isdir: false, isreg: f.t === "file", islnk: f.t === "link", mode: f.m, size: f.c.length, pw_name: f.o, checksum: fingerprint(f.c) } : d ? { exists: true, isdir: true, isreg: false, mode: "0755", pw_name: "root" } : { exists: false }; return res; }
    case "slurp": { const f = st.files[a.src]; if (!f) return { failed: true, changed: false, msg: "file not found: " + a.src }; res.content = btoa(f.c); res.encoding = "base64"; return res; }
    case "git": {
      const dest = a.dest; res.dur = 1800; if (!a.repo || !dest) return { failed: true, changed: false, msg: "missing required arguments: dest, repo" };
      if (/nonexistent|invalid/.test(a.repo)) return { failed: true, changed: false, msg: "Failed to clone: repository '" + a.repo + "' not found", rc: 128 };
      const ex = st.dirs[dest + "/.git"]; const ch = !ex; apply(() => { ensureDir(st, dest + "/.git"); st.files[dest + "/README.md"] = { c: "# " + a.repo.split("/").pop().replace(/\.git$/, "") + "\n", m: "0644", o: "root", t: "file" }; }); res.changed = ch; res.after = fingerprint(a.repo + (a.version || "HEAD")).padEnd(40, "0").slice(0, 40); res.before = ch ? null : res.after; return res;
    }
    case "pip": { const names = asList(a.name || a.requirements); res.dur = 1500; const ch = names.filter(n => !(st.pip || {})[n]); apply(() => { st.pip = st.pip || {}; ch.forEach(n => st.pip[n] = "1.0.0"); }); res.changed = ch.length > 0 && (a.state || "present") !== "absent"; return res; }
    case "uri": case "get_url": {
      const url = a.url; res.dur = 600; if (!url) return { failed: true, changed: false, msg: "missing required arguments: url" };
      const bad = /fail|404|invalid|nonexistent/.test(url); const code = bad ? (/404/.test(url) ? 404 : 500) : 200;
      if (mod === "get_url") { if (bad) return { failed: true, changed: false, msg: "Request failed", status_code: code, url }; const ex = st.files[a.dest]; apply(() => { st.files[a.dest] = { c: "# downloaded from " + url + "\n", m: modeOf(a.mode) || "0644", o: "root", t: "file" }; }); res.changed = !ex; res.dest = a.dest; res.status_code = 200; return res; }
      const expect = asList(a.status_code).length ? asList(a.status_code).map(Number) : [200];
      res.status = code; res.url = url; res.content_type = "text/html"; res.msg = "OK (1024 bytes)"; if (a.return_content) res.content = "<html><body>OK</body></html>";
      if (!expect.includes(code)) { return { failed: true, changed: false, status: code, url, msg: "Status code was " + code + " and not " + expect.join(", ") + ": HTTP Error " + code + ": " + (code === 404 ? "Not Found" : "Internal Server Error") }; }
      res.changed = false; return res;
    }
    case "wait_for": {
      res.dur = 900; if (a.path) { if (st.files[a.path] || st.dirs[a.path]) return res; return { failed: true, changed: false, elapsed: a.timeout || 300, msg: "Timeout when waiting for file " + a.path }; }
      if (a.port !== undefined) { const port = Number(a.port), up = Object.keys(PORTS).some(s => PORTS[s].includes(port) && st.svcs[s] && st.svcs[s].state === "started"); if ((a.state || "started") === "stopped" ? !up : up) { res.elapsed = 1; return res; } return { failed: true, changed: false, elapsed: a.timeout || 300, msg: "Timeout when waiting for " + (a.host || "127.0.0.1") + ":" + port }; }
      res.elapsed = a.timeout || 1; return res;
    }
    case "cron": { const name = a.name || a.job; res.dur = 250; if ((a.state || "present") === "absent") { res.changed = !!st.cron[name]; apply(() => { delete st.cron[name]; }); return res; } const spec = [a.minute || "*", a.hour || "*", a.day || "*", a.month || "*", a.weekday || "*"].join(" ") + " " + a.job; const ch = st.cron[name] !== spec; apply(() => { st.cron[name] = spec; }); res.changed = ch; res.jobs = [name]; return res; }
    case "hostname": { const ch = st.hostname !== a.name; apply(() => { st.hostname = a.name; st.files["/etc/hostname"] = { c: a.name + "\n", m: "0644", o: "root", t: "file" }; }); res.changed = ch; res.name = a.name; return res; }
    case "reboot": { res.dur = 4000; if (check) { res.changed = true; return res; } apply(() => { st.reboots++; Object.keys(st.svcs).forEach(s => { if (st.svcs[s].enabled) st.svcs[s].state = "started"; }); }); res.changed = true; res.elapsed = 38; res.rebooted = true; return res; }
    case "ufw": { res.dur = 250; const rule = (a.rule || "") + " " + (a.port || "") + "/" + (a.proto || "tcp"); const state = a.state; if (state === "enabled" || state === "disabled") { const ch = st.ufwOn !== (state === "enabled"); apply(() => { st.ufwOn = state === "enabled"; }); res.changed = ch; return res; } const has = st.ufw.includes(rule); apply(() => { if (!has) st.ufw.push(rule); }); res.changed = !has; return res; }
    case "meta": return res;
    case "unarchive": { res.dur = 900; const ex = st.dirs[a.dest]; apply(() => ensureDir(st, a.dest)); res.changed = true; res.dest = a.dest; return res; }
    case "apt_repository": case "apt_key": case "authorized_key": case "sysctl": case "timezone": case "known_hosts": case "mount": { const key = mod + ":" + JSON.stringify(a); const had = (st.misc || {})[key]; apply(() => { st.misc = st.misc || {}; st.misc[key] = 1; }); res.changed = !had; res.dur = 300; return res; }
    case "synchronize": case "docker_container": case "fetch": case "find": case "include_vars": case "set_stats": case "add_host": case "group_by": res.changed = mod === "synchronize" || mod === "docker_container"; res.dur = 500; if (mod === "find") { res.files = []; res.matched = 0; } return res;
  }
  throw new AErr("module '" + mod + "' is not supported by the simulator");
}
function installPkg(st, n) {
  const c = CATALOG[n]; st.pkgs[n] = c.v; (c.dirs || []).forEach(d => ensureDir(st, d));
  Object.keys(c.files || {}).forEach(f => { st.files[f] = { c: c.files[f], m: "0644", o: "root", t: "file" }; });
  (c.svc || []).forEach(s => { st.svcs[s] = { state: "started", enabled: true }; });
}
function removePkg(st, n) { const c = CATALOG[n] || {}; delete st.pkgs[n]; (c.svc || []).forEach(s => { delete st.svcs[s]; }); }
function fakeCommand(cmd, h, r, st, ctx, apply) {
  const c = cmd.replace(/^\s*(sudo\s+)?/, ""); let m;
  if ((m = /^echo\s+(.*)$/s.exec(c))) { let o = m[1].replace(/\s*(>>?)\s*(\S+)\s*$/, (x, op, p) => { apply(() => { const f = st.files[p]; const t = "x"; }); return ""; }); const redir = /\s(>>?)\s*(\S+)\s*$/.exec(c); const txt = m[1].replace(/\s*>>?\s*\S+\s*$/, "").replace(/^(['"])(.*)\1$/s, "$2"); if (redir) { apply(() => { const p = redir[2], ex = st.files[p]; st.files[p] = { c: (redir[1] === ">>" && ex ? ex.c : "") + txt + "\n", m: "0644", o: "root", t: "file" }; }); return { rc: 0, out: "" }; } return { rc: 0, out: txt, changed: true }; }
  if (/^hostname(\s+-f)?$/.test(c)) return { rc: 0, out: st.hostname, changed: true };
  if (/^whoami$/.test(c)) return { rc: 0, out: ctx.ansible_user || "deploy", changed: true };
  if (/^uptime/.test(c)) return { rc: 0, out: " 10:42:17 up 3 days,  4:12,  1 user,  load average: 0.08, 0.03, 0.01", changed: true };
  if (/^date/.test(c)) return { rc: 0, out: new Date().toString().slice(0, 28), changed: true };
  if (/^uname/.test(c)) return { rc: 0, out: /-a/.test(c) ? "Linux " + st.hostname + " 6.8.0-45-generic #45-Ubuntu SMP x86_64 GNU/Linux" : "Linux", changed: true };
  if (/^id(\s|$)/.test(c)) return { rc: 0, out: "uid=1000(deploy) gid=1000(deploy) groups=1000(deploy),27(sudo)", changed: true };
  if (/^df/.test(c)) return { rc: 0, out: "Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1        39G  9.4G   28G  26% /", changed: true };
  if (/^free/.test(c)) return { rc: 0, out: "               total        used        free\nMem:            3912        1204        2102", changed: true };
  if ((m = /^cat\s+(\S+)$/.exec(c))) { const f = st.files[m[1]]; return f ? { rc: 0, out: f.c.replace(/\n$/, ""), changed: true } : { rc: 1, out: "", err: "cat: " + m[1] + ": No such file or directory" }; }
  if ((m = /^ls\s*(-\S+\s+)?(\S*)$/.exec(c))) { const p = (m[2] || ".").replace(/\/$/, "") || "/"; const kids = new Set(); Object.keys(st.files).concat(Object.keys(st.dirs)).forEach(x => { if (x.startsWith(p + "/")) kids.add(x.slice(p.length + 1).split("/")[0]); }); if (!st.dirs[p] && !kids.size) return { rc: 2, out: "", err: "ls: cannot access '" + p + "': No such file or directory" }; return { rc: 0, out: [...kids].filter(k => !k.startsWith("__m")).sort().join("\n"), changed: true }; }
  if ((m = /^(?:systemctl\s+(is-active|status|is-enabled)\s+(\S+))$/.exec(c))) { const sv = st.svcs[m[2].replace(/\.service$/, "")]; if (m[1] === "is-active") return sv && sv.state === "started" ? { rc: 0, out: "active", changed: true } : { rc: 3, out: "inactive" }; if (m[1] === "is-enabled") return sv && sv.enabled ? { rc: 0, out: "enabled", changed: true } : { rc: 1, out: "disabled" }; return sv ? { rc: sv.state === "started" ? 0 : 3, out: "● " + m[2] + ".service\n   Active: " + (sv.state === "started" ? "active (running)" : "inactive (dead)"), changed: true } : { rc: 4, out: "", err: "Unit " + m[2] + ".service could not be found." }; }
  if ((m = /^(nginx|apache2|git|python3|node|psql|redis-server|docker)\s+(-v|--version|-V)$/.exec(c))) { const pk = ALIAS[m[1]] || (m[1] === "node" ? "nodejs" : m[1] === "psql" ? "postgresql" : m[1]); if (!st.pkgs[pk]) return { rc: 127, out: "", err: "/bin/sh: 1: " + m[1] + ": not found" }; return { rc: 0, out: m[1] + " version " + (st.pkgs[pk] || "").split(/[-+]/)[0], changed: true }; }
  if (/^(true|:)$/.test(c)) return { rc: 0, out: "", changed: true };
  if (/^false$/.test(c)) return { rc: 1, out: "" };
  if ((m = /^exit\s+(\d+)$/.exec(c))) return { rc: +m[1], out: "" };
  if ((m = /^(touch|mkdir(?:\s+-p)?)\s+(\S+)$/.exec(c))) { apply(() => { if (m[1].startsWith("mkdir")) ensureDir(st, m[2]); else st.files[m[2]] = st.files[m[2]] || { c: "", m: "0644", o: "root", t: "file" }; }); return { rc: 0, out: "", changed: true }; }
  if ((m = /^(?:rm(?:\s+-\w+)?)\s+(\S+)$/.exec(c))) { apply(() => { delete st.files[m[1]]; }); return { rc: 0, out: "", changed: true }; }
  if (/^sleep\s+\d+/.test(c) || /^sync$/.test(c)) return { rc: 0, out: "", changed: true };
  if (/^(curl|wget)\s/.test(c)) return { rc: 0, out: "<html><body>OK</body></html>", changed: true };
  return { rc: 0, out: "", changed: true };
}

window.AnsibleSim = { parseYaml, parseInventory, newState, run, DEFAULT_INVENTORY, matchHosts, toJson, banner };
})();
