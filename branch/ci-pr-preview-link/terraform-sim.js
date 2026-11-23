/* terraform-sim.js
 * A mock Terraform engine for the DevPortal playground. No real cloud calls are made.
 * Pieces: HCL parser -> expression evaluator -> config validation -> planner -> apply scheduler,
 * plus Terraform-style text rendering (plan diffs, diagnostics) and a table of mock provider resources.
 */
(function (root) {
"use strict";

const UNKNOWN = Object.freeze({ __unknown: true });
const isU = v => v === UNKNOWN;
const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v) && !isU(v);

class HclError extends Error {
  constructor(summary, line, detail) { super(summary); this.summary = summary; this.line = line; this.detail = detail || ""; }
}
class EvalErr extends Error {
  constructor(summary, detail) { super(summary); this.summary = summary; this.detail = detail || ""; }
}

/* ───────────────────────── helpers ───────────────────────── */
function deepEq(a, b) {
  if (isU(a) || isU(b)) return false;
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEq(x, b[i]));
  if (typeof a === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every(k => k in b && deepEq(a[k], b[k]));
  }
  return false;
}
function hasUnknown(v) {
  if (isU(v)) return true;
  if (Array.isArray(v)) return v.some(hasUnknown);
  if (isObj(v)) return Object.values(v).some(hasUnknown);
  return false;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const pad = n => " ".repeat(n);
function fmtDur(s) { s = Math.round(s); return s < 60 ? s + "s" : Math.floor(s / 60) + "m" + (s % 60) + "s"; }

/* ───────────────────────── HCL parser ───────────────────────── */
class Parser {
  constructor(src, lineBase) { this.s = src; this.i = 0; this.depth = 0; this.lineBase = lineBase || 0; }
  line(pos) {
    const end = pos == null ? this.i : pos; let n = this.lineBase + 1;
    for (let k = 0; k < end && k < this.s.length; k++) if (this.s.charCodeAt(k) === 10) n++;
    return n;
  }
  err(msg, pos, detail) { throw new HclError(msg, this.line(pos), detail); }
  eof() { return this.i >= this.s.length; }
  ws(nl) {
    for (;;) {
      const c = this.s[this.i];
      if (c === " " || c === "\t" || c === "\r") { this.i++; continue; }
      if (c === "\n") { if (nl) { this.i++; continue; } return; }
      if (c === "#" || (c === "/" && this.s[this.i + 1] === "/")) { while (this.i < this.s.length && this.s[this.i] !== "\n") this.i++; continue; }
      if (c === "/" && this.s[this.i + 1] === "*") {
        const e = this.s.indexOf("*/", this.i + 2);
        if (e < 0) this.err("Unterminated comment", this.i, "The /* comment has no closing */.");
        this.i = e + 2; continue;
      }
      return;
    }
  }
  w() { this.ws(this.depth > 0); }
  ident() { const m = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(this.s.slice(this.i, this.i + 200)); return m ? m[0] : null; }

  parseBody(inBlock) {
    const attrs = {}, blocks = [];
    for (;;) {
      this.ws(true);
      if (this.eof()) {
        if (inBlock) this.err("Unclosed configuration block", this.i, "There is no closing brace for this block before the end of the file.");
        break;
      }
      if (inBlock && this.s[this.i] === "}") { this.i++; break; }
      const start = this.i, name = this.ident();
      if (!name) this.err("Argument or block definition required", this.i, "An argument or block definition is required here.");
      this.i += name.length; this.ws(false);
      const line = this.line(start);
      if (this.s[this.i] === "=" && this.s[this.i + 1] !== "=") {
        this.i++; this.ws(false);
        const expr = this.parseExpr();
        if (attrs[name]) this.err("Attribute redefined", start, 'The argument "' + name + '" was already set. Each argument may be set only once.');
        attrs[name] = { expr, line };
        this.ws(false);
        const e = this.s[this.i];
        if (e !== undefined && e !== "\n" && !(inBlock && e === "}"))
          this.err("Missing newline after argument", this.i, "An argument definition must end with a newline.");
      } else {
        const labels = [];
        for (;;) {
          this.ws(false);
          const ch = this.s[this.i];
          if (ch === '"') labels.push(this.simpleString());
          else if (ch === "{") break;
          else { const id = this.ident(); if (id) { labels.push(id); this.i += id.length; } else this.err("Invalid block definition", this.i, 'Either a quoted string block label or an opening brace ("{") is expected here.'); }
        }
        this.i++;
        blocks.push({ type: name, labels, body: this.parseBody(true), line });
      }
    }
    return { attrs, blocks };
  }
  simpleString() {
    const start = this.i; this.i++; let out = "";
    while (this.i < this.s.length && this.s[this.i] !== '"') {
      if (this.s[this.i] === "\n") this.err("Unterminated string", start);
      if (this.s[this.i] === "\\") this.i++;
      out += this.s[this.i++];
    }
    if (this.s[this.i] !== '"') this.err("Unterminated string", start);
    this.i++; return out;
  }

  /* expressions */
  parseExpr() { return this.parseCond(); }
  parseCond() {
    const c = this.parseBin(0); this.w();
    if (this.s[this.i] === "?") {
      this.i++; this.depth++;
      const a = this.parseExpr(); this.w();
      if (this.s[this.i] !== ":") this.err("Invalid conditional expression", this.i, 'The conditional operator requires a ":" between the two result expressions.');
      this.i++;
      const b = this.parseExpr(); this.depth--;
      return { t: "cond", c, a, b };
    }
    return c;
  }
  parseBin(level) {
    const LV = [["||"], ["&&"], ["==", "!="], ["<=", ">=", "<", ">"], ["+", "-"], ["*", "/", "%"]];
    if (level >= LV.length) return this.parseUnary();
    let l = this.parseBin(level + 1);
    for (;;) {
      this.w();
      const op = LV[level].find(o => this.s.startsWith(o, this.i));
      if (!op) return l;
      if (op === "<" && this.s[this.i + 1] === "<") return l;
      this.i += op.length; this.w();
      l = { t: "bin", op, l, r: this.parseBin(level + 1) };
    }
  }
  parseUnary() {
    this.w();
    const c = this.s[this.i];
    if (c === "!" && this.s[this.i + 1] !== "=") { this.i++; return { t: "un", op: "!", e: this.parseUnary() }; }
    if (c === "-") { this.i++; return { t: "un", op: "-", e: this.parseUnary() }; }
    return this.parsePostfix();
  }
  parsePostfix() {
    let e = this.parsePrimary();
    for (;;) {
      const save = this.i; this.w();
      const c = this.s[this.i];
      if (c === ".") {
        if (this.s[this.i + 1] === "*") { this.i += 2; e = this.splat(e); continue; }
        const m = /^\.([A-Za-z_][A-Za-z0-9_-]*|\d+)/.exec(this.s.slice(this.i, this.i + 100));
        if (!m) { this.i = save; return e; }
        this.i += m[0].length; e = { t: "attr", obj: e, name: m[1], line: this.line() }; continue;
      }
      if (c === "[") {
        const sm = /^\[\s*\*\s*\]/.exec(this.s.slice(this.i, this.i + 30));
        if (sm) { this.i += sm[0].length; e = this.splat(e); continue; }
        this.i++; this.depth++; this.w();
        const k = this.parseExpr(); this.w();
        if (this.s[this.i] !== "]") this.err("Missing close bracket on index", this.i, 'The index operator must end with a closing bracket ("]").');
        this.i++; this.depth--; e = { t: "idx", obj: e, key: k }; continue;
      }
      this.i = save; return e;
    }
  }
  splat(obj) {
    const ops = [];
    for (;;) {
      const m = /^\.([A-Za-z_][A-Za-z0-9_-]*)/.exec(this.s.slice(this.i, this.i + 100));
      if (m) { this.i += m[0].length; ops.push({ name: m[1] }); continue; }
      if (this.s[this.i] === "[" && !/^\[\s*\*/.test(this.s.slice(this.i, this.i + 10))) {
        this.i++; this.depth++; const k = this.parseExpr(); this.w();
        if (this.s[this.i] !== "]") this.err("Missing close bracket on index", this.i);
        this.i++; this.depth--; ops.push({ key: k }); continue;
      }
      return { t: "splat", obj, ops };
    }
  }
  parsePrimary() {
    this.w();
    const c = this.s[this.i], start = this.i;
    if (c === undefined) this.err("Missing expression", start, "Expected an expression but found the end of the file.");
    if (c === '"') return this.parseString();
    if (c === "<" && this.s[this.i + 1] === "<") return this.parseHeredoc();
    if (/\d/.test(c)) { const m = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.s.slice(this.i, this.i + 40)); this.i += m[0].length; return { t: "lit", v: parseFloat(m[0]) }; }
    if (c === "(") {
      this.i++; this.depth++; const e = this.parseExpr(); this.w();
      if (this.s[this.i] !== ")") this.err("Unbalanced parentheses", this.i, 'Expected a closing parenthesis (")").');
      this.i++; this.depth--; return e;
    }
    if (c === "[") return this.parseList();
    if (c === "{") return this.parseObject();
    const name = this.ident();
    if (name) {
      this.i += name.length;
      if (name === "true") return { t: "lit", v: true };
      if (name === "false") return { t: "lit", v: false };
      if (name === "null") return { t: "lit", v: null };
      if (this.s[this.i] === "(") return this.parseCall(name, start);
      return { t: "id", name, line: this.line(start) };
    }
    this.err("Invalid expression", start, "Expected the start of an expression, but found an invalid expression token.");
  }
  parseCall(name, start) {
    this.i++; this.depth++;
    const args = [];
    for (;;) {
      this.w();
      if (this.s[this.i] === ")") { this.i++; break; }
      args.push(this.parseExpr()); this.w();
      if (this.s[this.i] === ",") { this.i++; continue; }
      if (this.s[this.i] === ")") { this.i++; break; }
      this.err("Missing argument separator", this.i, "Function arguments must be separated by commas.");
    }
    this.depth--; return { t: "call", name, args, line: this.line(start) };
  }
  parseList() {
    this.i++; this.depth++; this.w();
    if (/^for\b/.test(this.s.slice(this.i, this.i + 4))) { const f = this.parseFor("]"); this.depth--; return f; }
    const items = [];
    for (;;) {
      this.w();
      if (this.s[this.i] === "]") { this.i++; break; }
      items.push(this.parseExpr()); this.w();
      if (this.s[this.i] === ",") { this.i++; continue; }
      if (this.s[this.i] === "]") { this.i++; break; }
      this.err("Missing item separator", this.i, "Expected a comma to mark the beginning of the next item.");
    }
    this.depth--; return { t: "list", items };
  }
  parseObject() {
    this.i++; this.depth++; this.w();
    if (/^for\b/.test(this.s.slice(this.i, this.i + 4))) { const f = this.parseFor("}"); this.depth--; return f; }
    const entries = [];
    for (;;) {
      this.w();
      if (this.s[this.i] === "}") { this.i++; break; }
      let key;
      const c = this.s[this.i];
      if (c === "(") { this.i++; key = this.parseExpr(); this.w(); if (this.s[this.i] !== ")") this.err("Unbalanced parentheses", this.i); this.i++; }
      else if (c === '"') key = this.parseString();
      else { const id = this.ident(); if (!id) this.err("Invalid object key", this.i, "Expected an attribute name or a quoted string as the object key."); this.i += id.length; key = { t: "lit", v: id }; }
      this.w();
      if (this.s[this.i] !== "=" && this.s[this.i] !== ":") this.err("Missing key/value separator", this.i, 'Expected an equals sign ("=") to mark the beginning of the attribute value.');
      this.i++;
      const value = this.parseExpr(); this.w();
      entries.push({ k: key, v: value });
      if (this.s[this.i] === ",") this.i++;
    }
    this.depth--; return { t: "obj", entries };
  }
  parseFor(close) {
    this.i += 3; this.w();
    let k = this.ident(); this.i += k.length; this.w();
    let v = null;
    if (this.s[this.i] === ",") { this.i++; this.w(); v = this.ident(); this.i += v.length; this.w(); }
    if (!this.s.startsWith("in", this.i)) this.err("Invalid 'for' expression", this.i, 'Expected the "in" keyword.');
    this.i += 2;
    const coll = this.parseExpr(); this.w();
    if (this.s[this.i] !== ":") this.err("Invalid 'for' expression", this.i, 'Expected a colon (":") after the collection.');
    this.i++;
    let keyExpr = null, valExpr;
    if (close === "}") {
      keyExpr = this.parseExpr(); this.w();
      if (!this.s.startsWith("=>", this.i)) this.err("Invalid 'for' expression", this.i, 'Expected "=>" between the key and value expressions.');
      this.i += 2;
    }
    valExpr = this.parseExpr(); this.w();
    let cond = null;
    if (/^if\b/.test(this.s.slice(this.i, this.i + 3))) { this.i += 2; cond = this.parseExpr(); this.w(); }
    if (this.s[this.i] !== close) this.err("Invalid 'for' expression", this.i, 'Expected the closing "' + close + '".');
    this.i++;
    return { t: "for", obj: close === "}", kv: v ? [k, v] : [null, k], coll, keyExpr, valExpr, cond };
  }
  tplFromRaw(raw, baseLine, escapes) {
    const parts = []; let buf = "", j = 0;
    while (j < raw.length) {
      const c = raw[j];
      if (escapes && c === "\\") {
        const n = raw[j + 1]; j += 2;
        buf += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "\r" : n; continue;
      }
      if (c === "$" && raw[j + 1] === "$" && raw[j + 2] === "{") { buf += "${"; j += 3; continue; }
      if (c === "$" && raw[j + 1] === "{") {
        let d = 1, k = j + 2;
        while (k < raw.length && d > 0) {
          const ch = raw[k];
          if (ch === '"') { k++; while (k < raw.length && raw[k] !== '"') { if (raw[k] === "\\") k++; k++; } }
          else if (ch === "{") d++; else if (ch === "}") d--;
          k++;
        }
        if (d > 0) throw new HclError("Unclosed template interpolation sequence", baseLine, 'There is no closing brace for the "${" sequence.');
        if (buf) { parts.push(buf); buf = ""; }
        const sub = new Parser(raw.slice(j + 2, k - 1), baseLine - 1); sub.depth = 1;
        const e = sub.parseExpr(); sub.w();
        if (!sub.eof()) sub.err("Invalid template interpolation", sub.i, "Extra characters after the interpolation expression.");
        parts.push(e); j = k; continue;
      }
      buf += c; j++;
    }
    if (buf || !parts.length) parts.push(buf);
    if (parts.length === 1 && typeof parts[0] === "string") return { t: "lit", v: parts[0] };
    return { t: "tpl", parts };
  }
  parseString() {
    const start = this.i; this.i++;
    let j = this.i, raw = "";
    while (j < this.s.length && this.s[j] !== '"') {
      if (this.s[j] === "\n") this.err("Unterminated template string", start, "No closing quote was found for this string.");
      if (this.s[j] === "\\") { raw += this.s[j] + (this.s[j + 1] || ""); j += 2; continue; }
      if (this.s[j] === "$" && this.s[j + 1] === "{") {          // copy interpolation verbatim (may contain quotes)
        let d = 0;
        do {
          const ch = this.s[j];
          if (ch === "{") d++; else if (ch === "}") d--;
          else if (ch === '"') { raw += ch; j++; while (j < this.s.length && this.s[j] !== '"') { if (this.s[j] === "\\") { raw += this.s[j]; j++; } raw += this.s[j]; j++; } }
          raw += this.s[j]; j++;
        } while (d > 0 && j < this.s.length);
        continue;
      }
      raw += this.s[j]; j++;
    }
    if (this.s[j] !== '"') this.err("Unterminated template string", start, "No closing quote was found for this string.");
    this.i = j + 1;
    return this.tplFromRaw(raw, this.line(start), true);
  }
  parseHeredoc() {
    const start = this.i;
    const m = /^<<(-?)([A-Za-z_][A-Za-z0-9_]*)\r?\n/.exec(this.s.slice(this.i, this.i + 100));
    if (!m) this.err("Invalid heredoc", this.i, 'A heredoc must start with "<<" followed by a delimiter and a newline.');
    const indent = m[1] === "-", tag = m[2];
    let p = this.i + m[0].length; const lines = [];
    for (;;) {
      if (p >= this.s.length) this.err("Unterminated heredoc", start, 'The heredoc is missing its closing "' + tag + '" line.');
      let e = this.s.indexOf("\n", p); if (e < 0) e = this.s.length;
      const ln = this.s.slice(p, e).replace(/\r$/, "");
      p = e + 1;
      if (ln.trim() === tag) break;
      lines.push(ln);
    }
    this.i = p - 1;
    let body = lines;
    if (indent) { const ind = Math.min(...lines.filter(l => l.trim()).map(l => l.match(/^\s*/)[0].length), 1e9); body = lines.map(l => l.slice(ind === 1e9 ? 0 : ind)); }
    return this.tplFromRaw(body.join("\n") + "\n", this.line(start) + 1, false);
  }
}
function parseHcl(src) { return new Parser(src, 0).parseBody(false); }

/* ───────────────────────── expression evaluation ───────────────────────── */
const SPECIAL_ROOTS = new Set(["var", "local", "data", "each", "count", "path", "terraform", "self", "module"]);

function toStr(v) {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null || v === undefined) return "";
  throw new EvalErr("Invalid template interpolation value", "Cannot include the given value in a string template: string required.");
}
function getAttr(v, name, ctx) {
  if (isU(v)) return UNKNOWN;
  if (v && v.__root) {
    switch (v.__root) {
      case "var": return ctx.getVar(name);
      case "local": return ctx.getLocal(name);
      case "data": return { __dtype: name };
      case "each": { if (!ctx.each) throw new EvalErr("Invalid reference", 'The "each" object can be used only in "resource" blocks, and only when the "for_each" argument is set.'); return ctx.each[name]; }
      case "count": { if (!ctx.count) throw new EvalErr("Invalid reference", 'The "count" object can be used only in "resource" blocks, and only when the "count" argument is set.'); return ctx.count[name]; }
      case "path": return name === "module" || name === "root" ? "." : name === "cwd" ? "/workspace" : UNKNOWN;
      case "terraform": return name === "workspace" ? "default" : UNKNOWN;
      default: throw new EvalErr("Unsupported reference", "References to " + v.__root + " are not supported in the simulator.");
    }
  }
  if (v && v.__rtype) return ctx.getResource(v.__rtype, name);
  if (v && v.__dtype) return ctx.getData(v.__dtype, name);
  if (Array.isArray(v)) { if (/^\d+$/.test(name)) return v[+name]; throw new EvalErr("Unsupported attribute", 'This value does not have any attributes.'); }
  if (isObj(v)) {
    if (name in v) return v[name];
    throw new EvalErr("Unsupported attribute", 'This object does not have an attribute named "' + name + '".');
  }
  throw new EvalErr("Unsupported attribute", "Can't access attributes on a primitive-typed value.");
}
function getIndex(v, k) {
  if (isU(v) || isU(k)) return UNKNOWN;
  if (Array.isArray(v)) {
    if (typeof k !== "number") throw new EvalErr("Invalid index", "The given key does not identify an element in this collection value: a number is required.");
    if (k < 0 || k >= v.length) throw new EvalErr("Invalid index", "The given key does not identify an element in this collection value.");
    return v[k];
  }
  if (isObj(v)) {
    if (k in v) return v[k];
    throw new EvalErr("Invalid index", "The given key does not identify an element in this collection value.");
  }
  throw new EvalErr("Invalid index", "This value does not support indexing.");
}
function numArg(v, name) {
  if (typeof v !== "number") { const n = Number(v); if (v === "" || isNaN(n)) throw new EvalErr("Invalid function argument", "Invalid value for " + name + ": a number is required."); return n; }
  return v;
}
function evalNode(n, ctx) {
  switch (n.t) {
    case "lit": return n.v;
    case "tpl": {
      let s = "";
      for (const p of n.parts) {
        if (typeof p === "string") { s += p; continue; }
        const v = evalNode(p, ctx); if (isU(v)) return UNKNOWN; s += toStr(v);
      }
      return s;
    }
    case "list": return n.items.map(i => evalNode(i, ctx));
    case "obj": {
      const o = {};
      for (const e of n.entries) { const k = evalNode(e.k, ctx); if (isU(k)) return UNKNOWN; o[toStr(k)] = evalNode(e.v, ctx); }
      return o;
    }
    case "id": {
      if (ctx.scope && n.name in ctx.scope) return ctx.scope[n.name];
      if (SPECIAL_ROOTS.has(n.name)) return { __root: n.name };
      return { __rtype: n.name };
    }
    case "attr": return getAttr(evalNode(n.obj, ctx), n.name, ctx);
    case "idx": {
      const o = evalNode(n.obj, ctx), k = evalNode(n.key, ctx);
      if (o && (o.__rtype || o.__dtype || o.__root) && typeof k === "string") return getAttr(o, k, ctx);
      return getIndex(o, k);
    }
    case "splat": {
      let o = evalNode(n.obj, ctx);
      if (isU(o)) return UNKNOWN;
      if (o === null) return [];
      let items = Array.isArray(o) ? o : isObj(o) ? Object.values(o) : [o];
      return items.map(it => {
        let cur = it;
        for (const op of n.ops) cur = op.name !== undefined ? getAttr(cur, op.name, ctx) : getIndex(cur, evalNode(op.key, ctx));
        return cur;
      });
    }
    case "un": {
      const v = evalNode(n.e, ctx); if (isU(v)) return UNKNOWN;
      return n.op === "!" ? !v : -numArg(v, "operand");
    }
    case "bin": {
      if (n.op === "&&" || n.op === "||") {
        const l = evalNode(n.l, ctx);
        if (!isU(l)) { if (n.op === "&&" && !l) return false; if (n.op === "||" && l) return true; }
        const r = evalNode(n.r, ctx);
        if (isU(l) || isU(r)) return UNKNOWN;
        return n.op === "&&" ? !!(l && r) : !!(l || r);
      }
      const l = evalNode(n.l, ctx), r = evalNode(n.r, ctx);
      if (isU(l) || isU(r)) return UNKNOWN;
      switch (n.op) {
        case "==": return deepEq(l, r);
        case "!=": return !deepEq(l, r);
        case "<": return numArg(l, "left") < numArg(r, "right");
        case ">": return numArg(l, "left") > numArg(r, "right");
        case "<=": return numArg(l, "left") <= numArg(r, "right");
        case ">=": return numArg(l, "left") >= numArg(r, "right");
        case "+": return numArg(l, "left") + numArg(r, "right");
        case "-": return numArg(l, "left") - numArg(r, "right");
        case "*": return numArg(l, "left") * numArg(r, "right");
        case "/": return numArg(l, "left") / numArg(r, "right");
        case "%": return numArg(l, "left") % numArg(r, "right");
      }
      break;
    }
    case "cond": {
      const c = evalNode(n.c, ctx); if (isU(c)) return UNKNOWN;
      return evalNode(c ? n.a : n.b, ctx);
    }
    case "for": {
      const coll = evalNode(n.coll, ctx); if (isU(coll)) return UNKNOWN;
      const entries = Array.isArray(coll) ? coll.map((v, i) => [i, v]) : isObj(coll) ? Object.entries(coll) : null;
      if (!entries) throw new EvalErr("Iteration over non-iterable value", "A value of type " + typeof coll + " cannot be used as the collection in a 'for' expression.");
      const out = n.obj ? {} : [];
      for (const [k, v] of entries) {
        const child = Object.assign(Object.create(ctx), { scope: Object.assign({}, ctx.scope) });
        if (n.kv[0]) child.scope[n.kv[0]] = k;
        child.scope[n.kv[1]] = v;
        if (n.cond) { const c = evalNode(n.cond, child); if (isU(c)) return UNKNOWN; if (!c) continue; }
        if (n.obj) { const kk = evalNode(n.keyExpr, child); if (isU(kk)) return UNKNOWN; out[toStr(kk)] = evalNode(n.valExpr, child); }
        else out.push(evalNode(n.valExpr, child));
      }
      return out;
    }
    case "call": {
      if (n.name === "try") {
        for (const a of n.args) { try { const v = evalNode(a, ctx); return v; } catch (e) { if (!(e instanceof EvalErr)) throw e; } }
        throw new EvalErr("Error in function call", "All expressions in try() failed.");
      }
      if (n.name === "can") { try { evalNode(n.args[0], ctx); return true; } catch (e) { if (e instanceof EvalErr) return false; throw e; } }
      const fn = FN[n.name];
      if (!fn) throw new EvalErr("Call to unknown function", 'There is no function named "' + n.name + '".');
      const args = n.args.map(a => evalNode(a, ctx));
      if (n.name !== "coalesce" && args.some(isU)) return UNKNOWN;
      return fn(args, ctx);
    }
  }
  throw new EvalErr("Unsupported expression", "The simulator can't evaluate this expression.");
}

/* functions */
const maskOf = len => len === 0 ? 0 : ((~0 << (32 - len)) >>> 0);
function ip2n(ip) {
  const p = String(ip).split(".").map(Number);
  if (p.length !== 4 || p.some(x => !(x >= 0 && x <= 255))) throw new EvalErr("Invalid function argument", 'Invalid IP address "' + ip + '".');
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}
const n2ip = n => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
function parseCidr(c) {
  const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(String(c));
  if (!m || +m[2] > 32) throw new EvalErr("Invalid function argument", 'Invalid CIDR expression: "' + c + '" is not a valid CIDR block.');
  return { base: ip2n(m[1]), len: +m[2] };
}
const FN = {
  length: ([a]) => typeof a === "string" || Array.isArray(a) ? a.length : isObj(a) ? Object.keys(a).length : (() => { throw new EvalErr("Invalid function argument", "argument must be a string, a collection type, or a structural type."); })(),
  lower: ([a]) => String(a).toLowerCase(),
  upper: ([a]) => String(a).toUpperCase(),
  title: ([a]) => String(a).replace(/\b\w/g, c => c.toUpperCase()),
  trimspace: ([a]) => String(a).trim(),
  chomp: ([a]) => String(a).replace(/[\r\n]+$/, ""),
  replace: ([s, a, b]) => String(s).split(a).join(b),
  substr: ([s, o, l]) => String(s).substr(o < 0 ? s.length + o : o, l < 0 ? s.length : l),
  startswith: ([s, p]) => String(s).startsWith(p),
  endswith: ([s, p]) => String(s).endsWith(p),
  join: ([sep, l]) => l.map(toStr).join(sep),
  split: ([sep, s]) => String(s).split(sep),
  format: ([f, ...a]) => { let i = 0; return String(f).replace(/%(-?\d*)(?:\.(\d+))?([sdvfq%])/g, (m, w, p, t) => { if (t === "%") return "%"; const v = a[i++]; let r = t === "f" ? Number(v).toFixed(p === undefined ? 6 : +p) : t === "q" ? JSON.stringify(String(v)) : t === "d" ? String(Math.trunc(Number(v))) : (typeof v === "object" ? JSON.stringify(v) : String(v)); const wn = parseInt(w || "0", 10); if (wn) r = wn < 0 ? r.padEnd(-wn) : (t === "s" || t === "v" ? r.padStart(wn) : r.padStart(wn, w[0] === "0" ? "0" : " ")); return r; }); },
  formatlist: ([f, ...ls]) => { const n = Math.max(...ls.map(l => Array.isArray(l) ? l.length : 1)); return Array.from({ length: n }, (_, i) => FN.format([f, ...ls.map(l => Array.isArray(l) ? l[i] : l)])); },
  concat: a => [].concat(...a),
  flatten: ([l]) => { const o = []; (function f(x) { x.forEach(i => Array.isArray(i) ? f(i) : o.push(i)); })(l); return o; },
  element: ([l, i]) => l[((i % l.length) + l.length) % l.length],
  lookup: ([m, k, d]) => (isObj(m) && k in m) ? m[k] : (d !== undefined ? d : (() => { throw new EvalErr("Invalid function argument", 'Invalid value for "inputMap" parameter: lookup failed to find key "' + k + '".'); })()),
  merge: a => Object.assign({}, ...a.filter(x => x !== null)),
  keys: ([m]) => Object.keys(m).sort(),
  values: ([m]) => Object.keys(m).sort().map(k => m[k]),
  contains: ([l, v]) => l.some(x => deepEq(x, v)),
  distinct: ([l]) => l.filter((x, i) => l.findIndex(y => deepEq(x, y)) === i),
  sort: ([l]) => [...l].sort(),
  reverse: ([l]) => [...l].reverse(),
  slice: ([l, a, b]) => l.slice(a, b),
  range: a => { const [s, e, st] = a.length === 1 ? [0, a[0], 1] : [a[0], a[1], a[2] || 1]; const o = []; for (let i = s; st > 0 ? i < e : i > e; i += st) o.push(i); return o; },
  zipmap: ([k, v]) => Object.fromEntries(k.map((x, i) => [x, v[i]])),
  tolist: ([l]) => Array.isArray(l) ? l : Object.values(l),
  toset: ([l]) => [...new Set(l)].sort(),
  tomap: ([m]) => m,
  tostring: ([v]) => toStr(v),
  tonumber: ([v]) => numArg(v, "value"),
  tobool: ([v]) => v === "true" ? true : v === "false" ? false : !!v,
  one: ([l]) => l.length === 0 ? null : l[0],
  coalesce: a => { for (const x of a) if (!isU(x) && x !== null && x !== "") return x; return a.some(isU) ? UNKNOWN : null; },
  min: a => Math.min(...a.flat()), max: a => Math.max(...a.flat()),
  ceil: ([n]) => Math.ceil(n), floor: ([n]) => Math.floor(n), abs: ([n]) => Math.abs(n),
  cidrsubnet: ([prefix, nb, nn]) => {
    const { base, len } = parseCidr(prefix), nl = len + nb;
    if (nl > 32) throw new EvalErr("Invalid function argument", "Invalid CIDR expression: not enough remaining address space for a subnet with a prefix of " + nl + " bits after " + prefix + ".");
    if (nn < 0 || nn >= Math.pow(2, nb)) throw new EvalErr("Invalid function argument", "prefix extension of " + nb + " does not accommodate a subnet numbered " + nn + ".");
    return n2ip(((base & maskOf(len)) >>> 0) + nn * Math.pow(2, 32 - nl)) + "/" + nl;
  },
  cidrhost: ([prefix, h]) => { const { base, len } = parseCidr(prefix); return n2ip(((base & maskOf(len)) >>> 0) + h); },
  jsonencode: ([v]) => JSON.stringify(v),
  jsondecode: ([s]) => JSON.parse(s),
  base64encode: ([s]) => typeof btoa === "function" ? btoa(unescape(encodeURIComponent(s))) : Buffer.from(s).toString("base64"),
  md5: ([s]) => { let h = 0; for (const c of String(s)) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0; return (h >>> 0).toString(16).padStart(8, "0").repeat(4); },
  sha256: ([s]) => FN.md5([s]).repeat(2),
  file: ([p]) => "<contents of " + p + ">",
  timestamp: () => "2025-01-15T12:00:00Z",
  uuid: () => "5a3b9c1e-2f4d-4e6a-8b7c-1d2e3f4a5b6c",
  regex: ([p, s]) => { const m = new RegExp(p).exec(s); if (!m) throw new EvalErr("Invalid function argument", "Pattern did not match any part of the given string."); return m[1] !== undefined ? m[1] : m[0]; }
};

/* ───────────────────────── reference collection ───────────────────────── */
function chainOf(n) {                        // flatten id.attr.attr[idx] -> {root, steps}
  const steps = [];
  let cur = n;
  while (cur.t === "attr" || cur.t === "idx") { steps.unshift(cur.t === "attr" ? { name: cur.name } : { key: cur.key }); cur = cur.obj; }
  return cur.t === "id" ? { root: cur.name, steps, line: cur.line } : null;
}
function walk(n, scope, out, line) {
  if (!n || typeof n !== "object") return;
  switch (n.t) {
    case "lit": return;
    case "tpl": n.parts.forEach(p => typeof p !== "string" && walk(p, scope, out, line)); return;
    case "list": n.items.forEach(i => walk(i, scope, out, line)); return;
    case "obj": n.entries.forEach(e => { walk(e.k, scope, out, line); walk(e.v, scope, out, line); }); return;
    case "id": case "attr": case "idx": {
      const ch = chainOf(n);
      if (ch) {
        if (!scope.has(ch.root)) out.refs.push({ root: ch.root, a: ch.steps[0] && ch.steps[0].name, b: ch.steps[1] && ch.steps[1].name, line: ch.line || line });
        ch.steps.forEach(s => s.key && walk(s.key, scope, out, line));
      } else { walk(n.obj, scope, out, line); if (n.key) walk(n.key, scope, out, line); }
      return;
    }
    case "splat": walk(n.obj, scope, out, line); n.ops.forEach(o => o.key && walk(o.key, scope, out, line)); return;
    case "un": walk(n.e, scope, out, line); return;
    case "bin": walk(n.l, scope, out, line); walk(n.r, scope, out, line); return;
    case "cond": walk(n.c, scope, out, line); walk(n.a, scope, out, line); walk(n.b, scope, out, line); return;
    case "call": out.calls.push({ name: n.name, line: n.line }); n.args.forEach(a => walk(a, scope, out, line)); return;
    case "for": {
      walk(n.coll, scope, out, line);
      const s2 = new Set(scope); if (n.kv[0]) s2.add(n.kv[0]); s2.add(n.kv[1]);
      walk(n.keyExpr, s2, out, line); walk(n.valExpr, s2, out, line); walk(n.cond, s2, out, line); return;
    }
  }
}

/* ───────────────────────── mock provider registry ───────────────────────── */
const CAT = { network: "#4f8cf0", compute: "#ff9900", storage: "#3fa34d", db: "#8b5cf6", security: "#e11d48", iam: "#d4a000", lb: "#14b8a6", serverless: "#f97316", other: "#8a93a6" };
const PROVIDERS = {
  aws: ["hashicorp/aws", "5.74.0"], azurerm: ["hashicorp/azurerm", "4.9.0"], google: ["hashicorp/google", "6.11.0"],
  random: ["hashicorp/random", "3.6.3"], null: ["hashicorp/null", "3.2.3"], local: ["hashicorp/local", "2.5.2"],
  tls: ["hashicorp/tls", "4.0.6"], kubernetes: ["hashicorp/kubernetes", "2.33.0"], helm: ["hashicorp/helm", "2.16.0"],
  http: ["hashicorp/http", "3.4.5"], archive: ["hashicorp/archive", "2.6.0"], time: ["hashicorp/time", "0.12.1"],
  cloudflare: ["cloudflare/cloudflare", "4.46.0"], github: ["integrations/github", "6.3.1"]
};
const R = {};
function def(type, d) {
  const short = type.split("_").slice(1).join("-");
  R[type] = Object.assign({
    label: type.split("_").slice(1).join(" "), cat: "other", icon: "📦", req: [], forceNew: [], defaults: {},
    ck: ["id"], dur: [1, 4], computed: (c, g) => ({ id: g.id(short + "-") })
  }, d);
}
const wrapName = (c, g, p) => c.name || c.bucket || (p + g.hex(10));

def("aws_vpc", { label: "VPC", cat: "network", icon: "🌐", req: ["cidr_block"], forceNew: ["cidr_block", "instance_tenancy"], dur: [2, 5],
  defaults: { enable_dns_support: true, enable_dns_hostnames: false, instance_tenancy: "default" },
  ck: ["arn", "default_network_acl_id", "default_route_table_id", "default_security_group_id", "dhcp_options_id", "id", "main_route_table_id", "owner_id"],
  computed: (c, g) => { const id = g.id("vpc-"); return { id, arn: g.arn("ec2", "vpc/" + id), owner_id: g.acct, default_security_group_id: g.id("sg-"), main_route_table_id: g.id("rtb-"), default_route_table_id: g.id("rtb-"), default_network_acl_id: g.id("acl-"), dhcp_options_id: g.id("dopt-") }; } });
def("aws_subnet", { label: "Subnet", cat: "network", icon: "🔀", req: ["vpc_id", "cidr_block"], forceNew: ["vpc_id", "cidr_block", "availability_zone"], dur: [2, 5],
  defaults: { map_public_ip_on_launch: false }, ck: ["arn", "id", "owner_id"],
  computed: (c, g) => { const id = g.id("subnet-"); return { id, arn: g.arn("ec2", "subnet/" + id), owner_id: g.acct }; } });
def("aws_internet_gateway", { label: "Internet Gateway", cat: "network", icon: "🚪", dur: [2, 6], ck: ["arn", "id", "owner_id"],
  computed: (c, g) => { const id = g.id("igw-"); return { id, arn: g.arn("ec2", "internet-gateway/" + id), owner_id: g.acct }; } });
def("aws_eip", { label: "Elastic IP", cat: "network", icon: "📍", dur: [1, 3], defaults: { domain: "vpc" }, ck: ["allocation_id", "id", "private_ip", "public_dns", "public_ip"],
  computed: (c, g) => { const id = g.id("eipalloc-"), ip = g.pubip(); return { id, allocation_id: id, public_ip: ip, private_ip: g.privip(), public_dns: "ec2-" + ip.replace(/\./g, "-") + ".compute-1.amazonaws.com" }; } });
def("aws_nat_gateway", { label: "NAT Gateway", cat: "network", icon: "🔁", req: ["subnet_id"], forceNew: ["subnet_id", "allocation_id"], dur: [25, 55], ck: ["id", "network_interface_id", "private_ip", "public_ip"],
  computed: (c, g) => ({ id: g.id("nat-"), network_interface_id: g.id("eni-"), private_ip: g.privip(), public_ip: g.pubip() }) });
def("aws_route_table", { label: "Route Table", cat: "network", icon: "🗺️", dur: [1, 3], ck: ["arn", "id", "owner_id"],
  computed: (c, g) => { const id = g.id("rtb-"); return { id, arn: g.arn("ec2", "route-table/" + id), owner_id: g.acct }; } });
def("aws_route", { label: "Route", cat: "network", icon: "➡️", req: ["route_table_id"], dur: [1, 2], ck: ["id", "origin", "state"],
  computed: (c, g) => ({ id: "r-" + g.id("rtb-", 8) + g.digits(10), origin: "CreateRoute", state: "active" }) });
def("aws_route_table_association", { label: "Route Table Association", cat: "network", icon: "🔗", req: ["route_table_id"], forceNew: ["route_table_id", "subnet_id", "gateway_id"], dur: [1, 2],
  computed: (c, g) => ({ id: g.id("rtbassoc-") }) });
def("aws_security_group", { label: "Security Group", cat: "security", icon: "🛡️", forceNew: ["name", "vpc_id", "description"], dur: [1, 4], defaults: { revoke_rules_on_delete: false, description: "Managed by Terraform" },
  ck: ["arn", "id", "owner_id"], computed: (c, g) => { const id = g.id("sg-"); return { id, arn: g.arn("ec2", "security-group/" + id), owner_id: g.acct }; } });
def("aws_security_group_rule", { label: "SG Rule", cat: "security", icon: "🛡️", req: ["type", "from_port", "to_port", "protocol", "security_group_id"], dur: [1, 2], computed: (c, g) => ({ id: "sgrule-" + g.digits(10) }) });
def("aws_key_pair", { label: "Key Pair", cat: "security", icon: "🗝️", dur: [1, 2], ck: ["arn", "fingerprint", "id", "key_pair_id"],
  computed: (c, g) => { const n = c.key_name || "terraform-" + g.hex(8); return { id: n, arn: g.arn("ec2", "key-pair/" + n), key_pair_id: g.id("key-"), fingerprint: g.hex(32).replace(/(..)(?=.)/g, "$1:") }; } });
def("aws_instance", { label: "EC2 Instance", cat: "compute", icon: "🖥️", req: ["ami", "instance_type"], forceNew: ["ami", "subnet_id", "availability_zone", "key_name"], dur: [14, 38],
  defaults: { monitoring: false, ebs_optimized: false }, ck: ["arn", "id", "instance_state", "primary_network_interface_id", "private_dns", "private_ip", "public_dns", "public_ip"],
  computed: (c, g) => { const id = g.id("i-"), pip = "10.0." + g.int(0, 3) + "." + g.int(5, 250), ip = g.pubip(); return { id, arn: g.arn("ec2", "instance/" + id), instance_state: "running", primary_network_interface_id: g.id("eni-"), private_ip: pip, private_dns: "ip-" + pip.replace(/\./g, "-") + "." + g.region + ".compute.internal", public_ip: ip, public_dns: "ec2-" + ip.replace(/\./g, "-") + ".compute-1.amazonaws.com" }; } });
def("aws_lb", { label: "Load Balancer", cat: "lb", icon: "⚖️", forceNew: ["name", "load_balancer_type", "internal"], dur: [45, 95], defaults: { load_balancer_type: "application", internal: false },
  ck: ["arn", "arn_suffix", "dns_name", "id", "vpc_id", "zone_id"],
  computed: (c, g) => { const n = c.name || "tf-lb-" + g.hex(6), suffix = "app/" + n + "/" + g.hex(16), arn = g.arn("elasticloadbalancing", "loadbalancer/" + suffix); return { id: arn, arn, arn_suffix: suffix, dns_name: n + "-" + g.digits(10) + "." + g.region + ".elb.amazonaws.com", zone_id: "Z35SXDOTRQ7X7K", vpc_id: g.id("vpc-") }; } });
def("aws_lb_target_group", { label: "Target Group", cat: "lb", icon: "🎯", req: ["port", "protocol"], forceNew: ["name", "port", "protocol", "vpc_id", "target_type"], dur: [1, 4], ck: ["arn", "arn_suffix", "id"],
  computed: (c, g) => { const n = c.name || "tf-tg-" + g.hex(6), suffix = "targetgroup/" + n + "/" + g.hex(16), arn = g.arn("elasticloadbalancing", suffix); return { id: arn, arn, arn_suffix: suffix }; } });
def("aws_lb_listener", { label: "LB Listener", cat: "lb", icon: "👂", req: ["load_balancer_arn"], dur: [1, 4], ck: ["arn", "id"],
  computed: (c, g) => { const arn = g.arn("elasticloadbalancing", "listener/app/lb/" + g.hex(16) + "/" + g.hex(16)); return { id: arn, arn }; } });
def("aws_lb_target_group_attachment", { label: "TG Attachment", cat: "lb", icon: "📎", req: ["target_group_arn", "target_id"], dur: [1, 2], computed: (c, g) => ({ id: "arn:attachment-" + g.hex(20) }) });
def("aws_s3_bucket", { label: "S3 Bucket", cat: "storage", icon: "🪣", forceNew: ["bucket", "bucket_prefix"], dur: [1, 4], defaults: { force_destroy: false },
  ck: ["arn", "bucket", "bucket_domain_name", "bucket_regional_domain_name", "hosted_zone_id", "id", "region"],
  check: c => { const b = c.bucket; if (typeof b !== "string") return null; if (b.length < 3 || b.length > 63 || /[^a-z0-9.-]/.test(b)) return "InvalidBucketName: The specified bucket is not valid."; if (["test", "my-bucket", "bucket", "demo", "terraform", "logs", "data", "backup"].includes(b)) return "BucketAlreadyExists: The requested bucket name is not available. The bucket namespace is shared by all users of the system. Please select a different name and try again."; return null; },
  computed: (c, g) => { const n = c.bucket || "terraform-" + g.digits(18); return { id: n, bucket: n, arn: "arn:aws:s3:::" + n, region: g.region, bucket_domain_name: n + ".s3.amazonaws.com", bucket_regional_domain_name: n + ".s3." + g.region + ".amazonaws.com", hosted_zone_id: "Z3AQBSTGFYJSTF" }; } });
["aws_s3_bucket_versioning", "aws_s3_bucket_public_access_block", "aws_s3_bucket_server_side_encryption_configuration", "aws_s3_bucket_policy", "aws_s3_bucket_lifecycle_configuration", "aws_s3_bucket_ownership_controls", "aws_s3_bucket_acl"].forEach(t =>
  def(t, { label: t.replace("aws_s3_bucket_", "S3 ").replace(/_/g, " "), cat: "storage", icon: "🪣", req: ["bucket"], dur: [1, 3], computed: (c, g) => ({ id: typeof c.bucket === "string" ? c.bucket : g.id("s3cfg-") }) }));
def("aws_s3_object", { label: "S3 Object", cat: "storage", icon: "📄", req: ["bucket", "key"], dur: [1, 3], ck: ["etag", "id", "version_id"], computed: (c, g) => ({ id: c.key, etag: g.hex(32), version_id: "null" }) });
def("aws_db_subnet_group", { label: "DB Subnet Group", cat: "db", icon: "🗄️", req: ["subnet_ids"], dur: [1, 3], ck: ["arn", "id"],
  computed: (c, g) => { const n = c.name || "tf-" + g.hex(10); return { id: n, arn: g.arn("rds", "subgrp:" + n) }; } });
def("aws_db_instance", { label: "RDS Instance", cat: "db", icon: "🗄️", req: ["instance_class", "engine"], forceNew: ["engine", "identifier", "username"], dur: [70, 150],
  defaults: { multi_az: false, storage_encrypted: false }, ck: ["address", "arn", "endpoint", "hosted_zone_id", "id", "port", "resource_id", "status"],
  computed: (c, g) => { const n = c.identifier || "tf-" + g.hex(10), port = /mysql|maria/.test(c.engine) ? 3306 : 5432, addr = n + ".c" + g.hex(12) + "." + g.region + ".rds.amazonaws.com"; const rid = "db-" + g.hex(26).toUpperCase(); return { id: rid, resource_id: rid, arn: g.arn("rds", "db:" + n), address: addr, port, endpoint: addr + ":" + port, status: "available", hosted_zone_id: "Z2R2ITUGPM61AM" }; } });
def("aws_iam_role", { label: "IAM Role", cat: "iam", icon: "🔑", req: ["assume_role_policy"], forceNew: ["name"], dur: [1, 3], ck: ["arn", "create_date", "id", "unique_id"],
  computed: (c, g) => { const n = c.name || "terraform-" + g.hex(10); return { id: n, arn: "arn:aws:iam::" + g.acct + ":role/" + n, unique_id: "AROA" + g.hex(17).toUpperCase(), create_date: "2025-01-15T12:00:00Z" }; } });
def("aws_iam_policy", { label: "IAM Policy", cat: "iam", icon: "📜", req: ["policy"], forceNew: ["name"], dur: [1, 3], ck: ["arn", "id", "policy_id"],
  computed: (c, g) => { const arn = "arn:aws:iam::" + g.acct + ":policy/" + (c.name || "terraform-" + g.hex(10)); return { id: arn, arn, policy_id: "ANPA" + g.hex(17).toUpperCase() }; } });
def("aws_iam_role_policy_attachment", { label: "Policy Attachment", cat: "iam", icon: "📎", req: ["role", "policy_arn"], forceNew: ["role", "policy_arn"], dur: [1, 2], computed: (c, g) => ({ id: (c.role || "role") + "-" + g.digits(20) }) });
def("aws_iam_instance_profile", { label: "Instance Profile", cat: "iam", icon: "🪪", dur: [1, 3], ck: ["arn", "id", "unique_id"],
  computed: (c, g) => { const n = c.name || "terraform-" + g.hex(10); return { id: n, arn: "arn:aws:iam::" + g.acct + ":instance-profile/" + n, unique_id: "AIPA" + g.hex(17).toUpperCase() }; } });
def("aws_lambda_function", { label: "Lambda Function", cat: "serverless", icon: "λ", req: ["function_name", "role"], forceNew: ["function_name"], dur: [6, 16],
  defaults: { memory_size: 128, timeout: 3 }, ck: ["arn", "id", "invoke_arn", "last_modified", "qualified_arn", "version"],
  computed: (c, g) => { const arn = g.arn("lambda", "function:" + c.function_name); return { id: c.function_name, arn, qualified_arn: arn + ":$LATEST", invoke_arn: "arn:aws:apigateway:" + g.region + ":lambda:path/2015-03-31/functions/" + arn + "/invocations", version: "$LATEST", last_modified: "2025-01-15T12:00:00.000+0000" }; } });
def("aws_lambda_permission", { label: "Lambda Permission", cat: "serverless", icon: "🔓", req: ["action", "function_name", "principal"], dur: [1, 2], computed: (c, g) => ({ id: c.statement_id || "AllowExecution" }) });
def("aws_dynamodb_table", { label: "DynamoDB Table", cat: "db", icon: "🧮", req: ["name", "hash_key"], forceNew: ["name", "hash_key", "range_key"], dur: [5, 14], defaults: { billing_mode: "PROVISIONED" }, ck: ["arn", "id", "stream_arn"],
  computed: (c, g) => ({ id: c.name, arn: g.arn("dynamodb", "table/" + c.name), stream_arn: "" }) });
def("aws_cloudwatch_log_group", { label: "Log Group", cat: "other", icon: "📈", forceNew: ["name"], dur: [1, 2], defaults: { retention_in_days: 0 }, ck: ["arn", "id"],
  computed: (c, g) => { const n = c.name || "tf-" + g.hex(8); return { id: n, arn: g.arn("logs", "log-group:" + n) }; } });
def("aws_apigatewayv2_api", { label: "API Gateway", cat: "serverless", icon: "🔌", req: ["name", "protocol_type"], dur: [1, 4], ck: ["api_endpoint", "arn", "execution_arn", "id"],
  computed: (c, g) => { const id = g.hex(10); return { id, api_endpoint: "https://" + id + ".execute-api." + g.region + ".amazonaws.com", arn: g.arn("apigateway", "/apis/" + id), execution_arn: g.arn("execute-api", id) }; } });
def("aws_sns_topic", { label: "SNS Topic", cat: "serverless", icon: "📣", dur: [1, 2], ck: ["arn", "id", "owner"], computed: (c, g) => { const arn = g.arn("sns", c.name || "tf-" + g.hex(8)); return { id: arn, arn, owner: g.acct }; } });
def("aws_sqs_queue", { label: "SQS Queue", cat: "serverless", icon: "📬", dur: [1, 3], ck: ["arn", "id", "url"],
  computed: (c, g) => { const n = c.name || "tf-" + g.hex(8), url = "https://sqs." + g.region + ".amazonaws.com/" + g.acct + "/" + n; return { id: url, url, arn: g.arn("sqs", n) }; } });
def("aws_route53_zone", { label: "Route 53 Zone", cat: "network", icon: "🧭", req: ["name"], dur: [3, 8], ck: ["arn", "id", "name_servers", "zone_id"],
  computed: (c, g) => { const id = "Z" + g.digits(12); return { id, zone_id: id, arn: "arn:aws:route53:::hostedzone/" + id, name_servers: ["ns-1.awsdns-01.org", "ns-2.awsdns-02.co.uk", "ns-3.awsdns-03.com", "ns-4.awsdns-04.net"] }; } });
def("aws_route53_record", { label: "Route 53 Record", cat: "network", icon: "🧭", req: ["zone_id", "name", "type"], dur: [10, 28], computed: (c, g) => ({ id: (c.zone_id || "Z") + "_" + c.name + "_" + c.type }) });
def("azurerm_resource_group", { label: "Resource Group", cat: "other", icon: "📦", req: ["name", "location"], forceNew: ["name", "location"], dur: [1, 4], computed: (c, g) => ({ id: "/subscriptions/" + g.sub + "/resourceGroups/" + c.name }) });
def("azurerm_virtual_network", { label: "Virtual Network", cat: "network", icon: "🌐", req: ["name", "resource_group_name", "location", "address_space"], forceNew: ["name", "resource_group_name", "location"], dur: [4, 12], ck: ["guid", "id"],
  computed: (c, g) => ({ id: "/subscriptions/" + g.sub + "/resourceGroups/" + c.resource_group_name + "/providers/Microsoft.Network/virtualNetworks/" + c.name, guid: g.uuid() }) });
def("azurerm_subnet", { label: "Subnet", cat: "network", icon: "🔀", req: ["name", "resource_group_name", "virtual_network_name", "address_prefixes"], forceNew: ["name", "resource_group_name", "virtual_network_name"], dur: [3, 9],
  computed: (c, g) => ({ id: "/subscriptions/" + g.sub + "/resourceGroups/" + c.resource_group_name + "/providers/Microsoft.Network/virtualNetworks/" + c.virtual_network_name + "/subnets/" + c.name }) });
def("azurerm_public_ip", { label: "Public IP", cat: "network", icon: "📍", req: ["name", "resource_group_name", "location", "allocation_method"], dur: [3, 8], ck: ["id", "ip_address"],
  computed: (c, g) => ({ id: "/subscriptions/" + g.sub + "/resourceGroups/" + c.resource_group_name + "/providers/Microsoft.Network/publicIPAddresses/" + c.name, ip_address: g.pubip() }) });
def("azurerm_network_interface", { label: "NIC", cat: "network", icon: "🔌", req: ["name", "resource_group_name", "location"], dur: [4, 10], ck: ["id", "private_ip_address"],
  computed: (c, g) => ({ id: "/subscriptions/" + g.sub + "/resourceGroups/" + c.resource_group_name + "/providers/Microsoft.Network/networkInterfaces/" + c.name, private_ip_address: g.privip() }) });
def("azurerm_linux_virtual_machine", { label: "Linux VM", cat: "compute", icon: "🖥️", req: ["name", "resource_group_name", "location", "size"], forceNew: ["name", "resource_group_name", "location"], dur: [30, 75],
  ck: ["id", "private_ip_address", "public_ip_address", "virtual_machine_id"],
  computed: (c, g) => ({ id: "/subscriptions/" + g.sub + "/resourceGroups/" + c.resource_group_name + "/providers/Microsoft.Compute/virtualMachines/" + c.name, virtual_machine_id: g.uuid(), private_ip_address: g.privip(), public_ip_address: g.pubip() }) });
def("azurerm_storage_account", { label: "Storage Account", cat: "storage", icon: "🪣", req: ["name", "resource_group_name", "location", "account_tier", "account_replication_type"], forceNew: ["name", "resource_group_name", "location"], dur: [18, 40],
  check: c => (typeof c.name === "string" && !/^[a-z0-9]{3,24}$/.test(c.name)) ? "StorageAccountNameInvalid: " + c.name + " is not a valid storage account name. Storage account name must be between 3 and 24 characters in length and use numbers and lower-case letters only." : null,
  ck: ["id", "primary_blob_endpoint", "primary_access_key"], computed: (c, g) => ({ id: "/subscriptions/" + g.sub + "/resourceGroups/" + c.resource_group_name + "/providers/Microsoft.Storage/storageAccounts/" + c.name, primary_blob_endpoint: "https://" + c.name + ".blob.core.windows.net/", primary_access_key: g.hex(44) }) });
def("google_compute_network", { label: "VPC Network", cat: "network", icon: "🌐", req: ["name"], forceNew: ["name"], dur: [8, 20], ck: ["gateway_ipv4", "id", "self_link"],
  computed: (c, g) => ({ id: "projects/" + g.project + "/global/networks/" + c.name, self_link: "https://www.googleapis.com/compute/v1/projects/" + g.project + "/global/networks/" + c.name, gateway_ipv4: "" }) });
def("google_compute_subnetwork", { label: "Subnetwork", cat: "network", icon: "🔀", req: ["name", "ip_cidr_range", "network"], forceNew: ["name", "ip_cidr_range", "network", "region"], dur: [10, 25], ck: ["gateway_address", "id", "self_link"],
  computed: (c, g) => ({ id: "projects/" + g.project + "/regions/" + (c.region || "us-central1") + "/subnetworks/" + c.name, self_link: "https://www.googleapis.com/compute/v1/projects/" + g.project + "/regions/us-central1/subnetworks/" + c.name, gateway_address: "10.0.0.1" }) });
def("google_compute_instance", { label: "Compute Instance", cat: "compute", icon: "🖥️", req: ["name", "machine_type"], forceNew: ["name", "machine_type", "zone"], dur: [14, 32], ck: ["cpu_platform", "id", "instance_id", "self_link"],
  computed: (c, g) => ({ id: "projects/" + g.project + "/zones/" + (c.zone || "us-central1-a") + "/instances/" + c.name, instance_id: g.digits(19), cpu_platform: "Intel Broadwell", self_link: "https://www.googleapis.com/compute/v1/projects/" + g.project + "/zones/us-central1-a/instances/" + c.name }) });
def("google_storage_bucket", { label: "Storage Bucket", cat: "storage", icon: "🪣", req: ["name", "location"], forceNew: ["name", "location"], dur: [1, 4], ck: ["id", "self_link", "url"],
  check: c => (typeof c.name === "string" && ["test", "my-bucket", "bucket", "demo"].includes(c.name)) ? "googleapi: Error 409: Your previous request to create the named bucket succeeded and you already own it., conflict" : null,
  computed: (c, g) => ({ id: c.name, url: "gs://" + c.name, self_link: "https://www.googleapis.com/storage/v1/b/" + c.name }) });
def("google_compute_firewall", { label: "Firewall Rule", cat: "security", icon: "🛡️", req: ["name", "network"], dur: [6, 16], ck: ["id", "self_link"], computed: (c, g) => ({ id: "projects/" + g.project + "/global/firewalls/" + c.name, self_link: "https://www.googleapis.com/compute/v1/projects/" + g.project + "/global/firewalls/" + c.name }) });
const PETS = { a: ["able", "active", "bold", "brave", "calm", "clever", "eager", "fancy", "gentle", "happy", "jolly", "keen", "lucky", "mighty", "noble", "proud", "quiet", "rapid", "smart", "witty", "growing", "sharp"], n: ["ant", "bat", "bear", "bee", "cat", "crab", "deer", "duck", "eagle", "fox", "frog", "goat", "hawk", "koala", "lemur", "lizard", "mole", "otter", "panda", "pony", "seal", "tiger", "whale", "wolf"] };
def("random_pet", { label: "Random Pet", icon: "🎲", dur: [0.1, 0.4], computed: (c, g) => { const len = c.length || 2, w = []; for (let i = 0; i < len - 1; i++) w.push(PETS.a[g.int(0, PETS.a.length - 1)]); w.push(PETS.n[g.int(0, PETS.n.length - 1)]); return { id: (c.prefix ? c.prefix + (c.separator || "-") : "") + w.join(c.separator || "-") }; } });
def("random_id", { label: "Random ID", icon: "🎲", req: ["byte_length"], dur: [0.1, 0.4], ck: ["b64_std", "b64_url", "dec", "hex", "id"],
  computed: (c, g) => { const hex = g.hex(c.byte_length * 2); return { id: hex.slice(0, 22), hex, dec: String(parseInt(hex.slice(0, 12), 16)), b64_url: hex.slice(0, 22), b64_std: hex.slice(0, 22) + "==" }; } });
def("random_password", { label: "Random Password", icon: "🎲", req: ["length"], dur: [0.1, 0.4], ck: ["bcrypt_hash", "id", "result"], computed: (c, g) => ({ id: "none", result: g.hex(c.length || 16).slice(0, c.length || 16), bcrypt_hash: "$2a$10$" + g.hex(53) }) });
def("random_string", { label: "Random String", icon: "🎲", req: ["length"], dur: [0.1, 0.4], ck: ["id", "result"], computed: (c, g) => { const s = g.hex(c.length || 8).slice(0, c.length || 8); return { id: s, result: s }; } });
def("null_resource", { label: "Null Resource", icon: "⚪", dur: [0.1, 0.5], computed: (c, g) => ({ id: g.digits(18) }) });
def("local_file", { label: "Local File", icon: "📄", req: ["filename"], dur: [0.1, 0.5], computed: (c, g) => ({ id: g.hex(40) }) });
function typeDef(type) {
  if (R[type]) return R[type];
  const pre = type.split("_")[0];
  const cat = /(vpc|network|subnet|vnet|gateway|route|dns)/.test(type) ? "network" : /(instance|vm|compute|cluster|node|server)/.test(type) ? "compute" : /(bucket|storage|disk|volume)/.test(type) ? "storage" : /(db|sql|database|table|redis|cache)/.test(type) ? "db" : /(security|firewall|iam|role|policy|key)/.test(type) ? "security" : "other";
  const icon = { network: "🌐", compute: "🖥️", storage: "🪣", db: "🗄️", security: "🛡️", other: "📦" }[cat];
  const d = Object.assign({}, R.null_resource, { label: type.split("_").slice(1).join(" ") || type, cat, icon, generic: true, dur: [1, 6], computed: (c, g) => ({ id: g.id(type.split("_").slice(1).join("-").slice(0, 12) + "-") }) });
  return (R[type] = d);
}

const DATA = {
  aws_ami: (c, g) => ({ id: "ami-0c55b159cbfafe1f0", image_id: "ami-0c55b159cbfafe1f0", name: "ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-20241109", architecture: "x86_64", owner_id: "099720109477", root_device_type: "ebs", creation_date: "2024-11-09T00:00:00.000Z" }),
  aws_availability_zones: (c, g) => ({ id: g.region, names: ["a", "b", "c"].map(x => g.region + x), zone_ids: ["use1-az1", "use1-az2", "use1-az3"] }),
  aws_caller_identity: (c, g) => ({ id: g.acct, account_id: g.acct, arn: "arn:aws:iam::" + g.acct + ":user/demo", user_id: "AIDAEXAMPLEUSERID123" }),
  aws_region: (c, g) => ({ id: g.region, name: g.region, description: "US East (N. Virginia)" }),
  aws_partition: () => ({ id: "aws", partition: "aws", dns_suffix: "amazonaws.com" }),
  aws_vpc: (c, g) => ({ id: "vpc-0d1e2f3a4b5c6d7e8", cidr_block: "172.31.0.0/16", default: true }),
  aws_subnets: (c, g) => ({ id: g.region, ids: ["subnet-0aa1b2c3d4e5f6a7b", "subnet-0bb1b2c3d4e5f6a7b", "subnet-0cc1b2c3d4e5f6a7b"] }),
  aws_iam_policy_document: () => ({ id: "2690255455", json: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "sts:AssumeRole" }] }, null, 2) }),
  azurerm_client_config: (c, g) => ({ id: "client-config", client_id: g.uuid(), tenant_id: g.uuid(), subscription_id: g.sub, object_id: g.uuid() }),
  google_client_config: (c, g) => ({ id: "projects/" + g.project, project: g.project, region: "us-central1" })
};

/* ───────────────────────── config loading + validation ───────────────────────── */
function typeOf(node) {
  if (!node) return "string";
  if (node.t === "id") return node.name;
  if (node.t === "call") return node.name;
  return "string";
}
function loadConfig(src) {
  const lines = src.split("\n");
  const cfg = { src, lines, providers: {}, required: {}, backend: null, variables: {}, locals: {}, resources: {}, data: {}, outputs: {}, order: [], errors: [], ok: true };
  let tree;
  try { tree = parseHcl(src); }
  catch (e) {
    if (e instanceof HclError) { cfg.errors.push({ summary: e.summary, detail: e.detail, line: e.line, ctx: "" }); cfg.ok = false; return cfg; }
    throw e;
  }
  const err = (summary, detail, line, ctx, addr) => cfg.errors.push({ summary, detail, line, ctx: ctx || "", addr });
  for (const b of tree.blocks) {
    const ctxStr = b.type + b.labels.map(l => ' "' + l + '"').join("");
    switch (b.type) {
      case "terraform": {
        const rp = b.body.blocks.find(x => x.type === "required_providers");
        if (rp) for (const [k, a] of Object.entries(rp.body.attrs)) {
          let source = null, version = null;
          if (a.expr.t === "obj") for (const e of a.expr.entries) { const key = e.k.v; if (key === "source" && e.v.t === "lit") source = e.v.v; if (key === "version" && e.v.t === "lit") version = e.v.v; }
          cfg.required[k] = { source, version };
        }
        const be = b.body.blocks.find(x => x.type === "backend"); if (be) cfg.backend = be.labels[0];
        break;
      }
      case "provider": cfg.providers[b.labels[0]] = { body: b.body, line: b.line }; break;
      case "variable": {
        if (cfg.variables[b.labels[0]]) { err("Duplicate variable declaration", 'A variable named "' + b.labels[0] + '" was already declared at line ' + cfg.variables[b.labels[0]].line + ". Variable names must be unique within a module.", b.line, ctxStr); break; }
        cfg.variables[b.labels[0]] = { name: b.labels[0], line: b.line, defaultExpr: b.body.attrs.default ? b.body.attrs.default.expr : null, type: typeOf(b.body.attrs.type && b.body.attrs.type.expr), sensitive: b.body.attrs.sensitive && b.body.attrs.sensitive.expr.v === true };
        break;
      }
      case "locals": for (const [k, a] of Object.entries(b.body.attrs)) { if (cfg.locals[k]) err("Duplicate local value definition", 'A local value named "' + k + '" was already defined at line ' + cfg.locals[k].line + ".", a.line, "locals"); else cfg.locals[k] = { expr: a.expr, line: a.line }; } break;
      case "resource": case "data": {
        if (b.labels.length !== 2) { err("Invalid " + b.type + " block", "A " + b.type + " block requires exactly two labels: a type and a name.", b.line, ctxStr); break; }
        const [type, name] = b.labels, key = (b.type === "data" ? "data." : "") + type + "." + name, store = b.type === "data" ? cfg.data : cfg.resources;
        if (store[type + "." + name]) { err("Duplicate " + b.type + ' "' + type + '" configuration', "A " + b.type + ' "' + type + '" named "' + name + '" was already declared at line ' + store[type + "." + name].line + ". Resource names must be unique per type in each module.", b.line, ctxStr); break; }
        const attrs = {}; const meta = {};
        for (const [k, a] of Object.entries(b.body.attrs)) {
          if (k === "count") meta.count = a.expr; else if (k === "for_each") meta.forEach = a.expr; else if (k === "depends_on") meta.dependsOn = a.expr; else if (k === "provider") meta.provider = a.expr; else attrs[k] = a;
        }
        const nested = {};
        for (const nb of b.body.blocks) {
          if (nb.type === "lifecycle") { meta.lifecycle = nb.body; continue; }
          if (nb.type === "provisioner" || nb.type === "connection" || nb.type === "dynamic") continue;
          (nested[nb.type] = nested[nb.type] || []).push(nb);
        }
        store[type + "." + name] = { type, name, key, mode: b.type === "data" ? "data" : "managed", attrs, nested, meta, line: b.line, ctx: ctxStr };
        cfg.order.push((b.type === "data" ? "data:" : "") + type + "." + name);
        break;
      }
      case "output": cfg.outputs[b.labels[0]] = { name: b.labels[0], line: b.line, expr: b.body.attrs.value && b.body.attrs.value.expr, sensitive: b.body.attrs.sensitive && b.body.attrs.sensitive.expr.v === true, ctx: ctxStr }; if (!b.body.attrs.value) err("Missing required argument", 'The argument "value" is required, but no definition was found.', b.line, ctxStr); break;
      case "module": err("Module not supported", "Modules are not supported by the playground simulator. Inline the resources into this file instead.", b.line, ctxStr); break;
      default: err("Unsupported block type", 'Blocks of type "' + b.type + '" are not expected here.', b.line, ctxStr);
    }
  }
  /* reference checks, function checks, required args */
  const bodyRefs = (r, outs) => {
    const exprs = [];
    const add = (e, line) => exprs.push([e, line]);
    Object.values(r.attrs).forEach(a => add(a.expr, a.line));
    const rec = nb => { Object.values(nb.body.attrs).forEach(a => add(a.expr, a.line)); nb.body.blocks.forEach(rec); };
    Object.values(r.nested).flat().forEach(rec);
    ["count", "forEach", "dependsOn"].forEach(k => r.meta[k] && add(r.meta[k], r.line));
    if (r.meta.lifecycle) Object.values(r.meta.lifecycle.attrs).forEach(a => add(a.expr, a.line));
    return exprs;
  };
  const check = (expr, line, ctxStr, outRefs) => {
    const out = { refs: [], calls: [] };
    walk(expr, new Set(), out, line);
    for (const c of out.calls) if (!FN[c.name] && c.name !== "try" && c.name !== "can") err("Call to unknown function", 'There is no function named "' + c.name + '".', c.line || line, ctxStr);
    for (const r of out.refs) {
      const L = r.line || line;
      if (r.root === "var") { if (!cfg.variables[r.a]) err("Reference to undeclared input variable", 'An input variable with the name "' + r.a + '" has not been declared. This variable can be declared with a variable "' + r.a + '" {} block.', L, ctxStr); }
      else if (r.root === "local") { if (!cfg.locals[r.a]) err("Reference to undeclared local value", 'A local value with the name "' + r.a + '" has not been declared.', L, ctxStr); else outRefs.push({ local: r.a }); }
      else if (r.root === "data") { if (r.b && !cfg.data[r.a + "." + r.b]) err("Reference to undeclared resource", 'A data resource "' + r.a + '" "' + r.b + '" has not been declared in the root module.', L, ctxStr); else outRefs.push({ block: "data:" + r.a + "." + r.b }); }
      else if (r.root === "module") err("Reference to undeclared module", 'No module call named "' + r.a + '" is declared in the root module.', L, ctxStr);
      else if (!SPECIAL_ROOTS.has(r.root)) {
        if (r.a && !cfg.resources[r.root + "." + r.a]) err("Reference to undeclared resource", 'A managed resource "' + r.root + '" "' + r.a + '" has not been declared in the root module.', L, ctxStr, r.root + "." + r.a);
        else if (r.a) outRefs.push({ block: r.root + "." + r.a });
      }
    }
  };
  cfg.deps = {}; cfg.localDeps = {};
  for (const [k, l] of Object.entries(cfg.locals)) { const o = []; check(l.expr, l.line, "locals", o); cfg.localDeps[k] = o; }
  for (const [k, v] of Object.entries(cfg.variables)) if (v.defaultExpr) check(v.defaultExpr, v.line, 'variable "' + k + '"', []);
  for (const pr of Object.values(cfg.providers)) Object.values(pr.body.attrs).forEach(a => check(a.expr, a.line, "provider", []));
  for (const store of [cfg.resources, cfg.data]) for (const r of Object.values(store)) {
    const o = [];
    for (const [e, line] of bodyRefs(r)) check(e, line, r.ctx, o);
    r.refs = o;
    if (r.mode === "managed") {
      const d = typeDef(r.type);
      for (const a of d.req) if (!(a in r.attrs) && !r.nested[a]) err("Missing required argument", 'The argument "' + a + '" is required, but no definition was found.', r.line, r.ctx, r.type + "." + r.name);
    }
  }
  for (const o of Object.values(cfg.outputs)) if (o.expr) { const refs = []; check(o.expr, o.line, o.ctx, refs); o.refs = refs; }
  /* dependency graph among blocks */
  const expand = (refs, seen = new Set()) => {
    const out = new Set();
    for (const r of refs) {
      if (r.block) out.add(r.block);
      else if (r.local && !seen.has(r.local)) { seen.add(r.local); expand(cfg.localDeps[r.local] || [], seen).forEach(x => out.add(x)); }
    }
    return out;
  };
  cfg.expandRefs = expand;
  for (const store of [cfg.resources, cfg.data]) for (const r of Object.values(store)) {
    const set = expand(r.refs || []);
    if (r.meta.dependsOn) {
      const o = { refs: [], calls: [] }; walk(r.meta.dependsOn, new Set(), o, r.line);
      o.refs.forEach(x => { if (x.a && cfg.resources[x.root + "." + x.a]) set.add(x.root + "." + x.a); });
    }
    set.delete((r.mode === "data" ? "data:" : "") + r.type + "." + r.name);
    cfg.deps[(r.mode === "data" ? "data:" : "") + r.type + "." + r.name] = [...set];
  }
  /* cycles */
  const color = {};
  const stack = [];
  (function dfs() {
    const visit = k => {
      if (color[k] === 2) return false;
      if (color[k] === 1) { const cyc = stack.slice(stack.indexOf(k)).map(s => s.replace("data:", "data.")); err("Cycle: " + cyc.join(", "), "A dependency cycle was found between these resources; Terraform can't determine a safe order to create them.", (cfg.resources[k] || cfg.data[k.replace("data:", "")] || {}).line || 1, ""); return true; }
      color[k] = 1; stack.push(k);
      for (const d of cfg.deps[k] || []) if (cfg.deps[d] && visit(d)) return true;
      stack.pop(); color[k] = 2; return false;
    };
    for (const k of Object.keys(cfg.deps)) if (visit(k)) break;
  })();
  cfg.errors.sort((a, b) => (a.line || 0) - (b.line || 0));
  cfg.ok = cfg.errors.length === 0;
  return cfg;
}
function formatDiagnostic(d, cfg) {
  const out = ["╷", "│ Error: " + d.summary, "│"];
  if (d.line) {
    out.push("│   on main.tf line " + d.line + (d.ctx ? ", in " + d.ctx : "") + ":");
    out.push("│   " + d.line + ": " + (cfg.lines[d.line - 1] || "").replace(/\s+$/, ""));
    out.push("│");
  }
  if (d.detail) String(d.detail).split("\n").forEach(l => out.push("│ " + l));
  out.push("╵");
  return out;
}

/* ───────────────────────── state & generators ───────────────────────── */
function newState() { return { version: 4, serial: 0, resources: {}, outputs: {} }; }
function makeGen(rng, env) {
  const g = {
    region: env.region || "us-east-1", acct: "123456789012", sub: "00000000-1111-2222-3333-444444444444", project: env.project || "my-project",
    int: (a, b) => a + Math.floor(rng() * (b - a + 1)),
    hex: n => { let s = ""; while (s.length < n) s += Math.floor(rng() * 16).toString(16); return s; },
    digits: n => { let s = ""; while (s.length < n) s += Math.floor(rng() * 10); return s; },
    id: (prefix, n) => prefix + g.hex(n || 17),
    arn: (svc, res) => "arn:aws:" + svc + ":" + g.region + ":" + g.acct + ":" + res,
    pubip: () => g.int(3, 54) + "." + g.int(1, 254) + "." + g.int(1, 254) + "." + g.int(1, 254),
    privip: () => "10.0." + g.int(0, 3) + "." + g.int(5, 250),
    uuid: () => [g.hex(8), g.hex(4), "4" + g.hex(3), "a" + g.hex(3), g.hex(12)].join("-")
  };
  return g;
}

/* ───────────────────────── planning ───────────────────────── */
function mockVar(v) {
  switch (v.type) {
    case "number": return 1; case "bool": return true;
    case "list": case "set": return ["demo"]; case "map": case "object": return { demo: "value" };
    default: return "demo-" + v.name;
  }
}
function evalBody(r, ctx) {
  const attrs = {}, blockKeys = [];
  for (const [k, a] of Object.entries(r.attrs)) attrs[k] = evalNode(a.expr, ctx);
  const evalNested = nb => {
    const o = {};
    for (const [k, a] of Object.entries(nb.body.attrs)) o[k] = evalNode(a.expr, ctx);
    const groups = {};
    nb.body.blocks.forEach(x => (groups[x.type] = groups[x.type] || []).push(x));
    for (const [t, arr] of Object.entries(groups)) o[t] = arr.map(evalNested);
    return o;
  };
  for (const [t, arr] of Object.entries(r.nested)) { attrs[t] = arr.map(evalNested); blockKeys.push(t); }
  return { attrs, blockKeys };
}
function regionFrom(cfg, ctx, provName) {
  const p = cfg.providers[provName]; const out = {};
  if (p) for (const [k, a] of Object.entries(p.body.attrs)) { try { const v = evalNode(a.expr, ctx); if (!isU(v)) out[k] = v; } catch (e) { /* ignore */ } }
  return out;
}
function plan(cfg, state, env) {
  env = env || {};
  const rng = env.rng || mulberry32(1234);
  const P = { changes: [], outputs: [], dataReads: [], mockVars: [], vars: {}, errors: [], summary: { add: 0, change: 0, destroy: 0 }, dataValues: {}, graph: { nodes: [], edges: [] } };
  const vars = P.vars;
  const baseCtx = { vars, scope: null,
    getVar(n) { if (!(n in vars)) throw new EvalErr("Reference to undeclared input variable", 'An input variable with the name "' + n + '" has not been declared.'); return vars[n]; },
    getLocal(n) { return localVal(n); }, getResource() { throw new EvalErr("Invalid reference", "Resource attributes can't be used here."); }, getData() { throw new EvalErr("Invalid reference", "Data attributes can't be used here."); } };
  const localMemo = {}, PEND = {};
  function localVal(n) {
    if (n in localMemo) { if (localMemo[n] === PEND) throw new EvalErr("Cycle in local values", 'Local value "' + n + '" depends on itself.'); return localMemo[n]; }
    const l = cfg.locals[n]; if (!l) throw new EvalErr("Reference to undeclared local value", 'A local value with the name "' + n + '" has not been declared.');
    localMemo[n] = PEND; localMemo[n] = evalNode(l.expr, ctx0); return localMemo[n];
  }
  let ctx0 = baseCtx;
  const gctx = () => ({ region: P.region, project: P.project });
  try {
    for (const [n, v] of Object.entries(cfg.variables)) {
      if (env.vars && n in env.vars) vars[n] = env.vars[n];
      else if (v.defaultExpr) vars[n] = evalNode(v.defaultExpr, baseCtx);
      else { vars[n] = mockVar(v); P.mockVars.push({ name: n, value: vars[n] }); }
    }
    const aws = regionFrom(cfg, baseCtx, "aws"), goog = regionFrom(cfg, baseCtx, "google");
    P.region = aws.region || "us-east-1"; P.project = goog.project || "my-project";
    const g = makeGen(rng, gctx());
    P.provider = { region: P.region };

    /* instance expansion */
    const blocks = {}, plannedBlocks = {};
    const expandInstances = r => {
      if (r.meta.count) {
        const n = evalNode(r.meta.count, ctx0);
        if (isU(n)) throw new EvalErr("Invalid count argument", 'The "count" value depends on resource attributes that cannot be determined until apply, so Terraform cannot predict how many instances will be created.');
        if (typeof n !== "number" || n < 0) throw new EvalErr("Invalid count argument", 'The given "count" argument value is unsuitable: a non-negative number is required.');
        return { mode: "count", insts: Array.from({ length: n }, (_, i) => ({ key: i, count: { index: i } })) };
      }
      if (r.meta.forEach) {
        const v = evalNode(r.meta.forEach, ctx0);
        if (isU(v)) throw new EvalErr("Invalid for_each argument", 'The "for_each" map includes keys derived from resource attributes that cannot be determined until apply.');
        if (Array.isArray(v)) return { mode: "map", insts: v.map(x => ({ key: toStr(x), each: { key: toStr(x), value: x } })) };
        if (isObj(v)) return { mode: "map", insts: Object.entries(v).map(([k, x]) => ({ key: k, each: { key: k, value: x } })) };
        throw new EvalErr("Invalid for_each argument", 'The given "for_each" argument value is unsuitable: the "for_each" argument must be a map, or set of strings.');
      }
      return { mode: "single", insts: [{ key: null }] };
    };
    const instAddr = (r, key) => r.type + "." + r.name + (key === null ? "" : typeof key === "number" ? "[" + key + "]" : '["' + key + '"]');
    const shape = (b, get) => {
      if (b.mode === "single") return get(b.insts[0]);
      if (b.mode === "count") return b.insts.map(get);
      const o = {}; b.insts.forEach(i => (o[i.key] = get(i))); return o;
    };
    const ctx = Object.assign(Object.create(baseCtx), {
      getResource(type, name) {
        const bk = type + "." + name;
        if (!cfg.resources[bk]) throw new EvalErr("Reference to undeclared resource", 'A managed resource "' + type + '" "' + name + '" has not been declared in the root module.');
        const pb = plannedBlocks[bk]; if (!pb) throw new EvalErr("Dependency order error", bk + " has not been planned yet.");
        return shape(pb, i => i.attrs);
      },
      getData(type, name) {
        const bk = type + "." + name;
        if (!cfg.data[bk]) throw new EvalErr("Reference to undeclared resource", 'A data resource "' + type + '" "' + name + '" has not been declared in the root module.');
        const pb = P.dataValues[bk]; if (!pb) throw new EvalErr("Dependency order error", "data." + bk + " has not been read yet.");
        return shape(pb, i => i.attrs);
      }
    });
    ctx0 = ctx;

    /* topological order */
    const all = [...cfg.order];
    const ordered = []; const seen = new Set();
    const visit = k => { if (seen.has(k)) return; seen.add(k); (cfg.deps[k] || []).forEach(d => cfg.deps[d] && visit(d)); ordered.push(k); };
    all.forEach(visit);

    for (const bk of ordered) {
      const isData = bk.startsWith("data:"), key = isData ? bk.slice(5) : bk;
      const r = (isData ? cfg.data : cfg.resources)[key];
      const exp = expandInstances(r);
      const stored = [];
      const dependsBlocks = cfg.deps[bk] || [];
      for (const inst of exp.insts) {
        const ictx = Object.assign(Object.create(ctx), { each: inst.each || null, count: inst.count || null });
        const addr = (isData ? "data." : "") + instAddr(r, inst.key);
        let ev;
        try { ev = evalBody(r, ictx); }
        catch (e) { if (e instanceof EvalErr) { e.line = r.line; e.ctx = r.ctx; e.addr = addr; } throw e; }
        if (isData) {
          const attrs = Object.assign({}, (DATA[r.type] || ((c, gg) => ({ id: gg.id(r.type.split("_").slice(1).join("-") + "-") })))(ev.attrs, g), ev.attrs);
          stored.push({ key: inst.key, attrs });
          P.dataReads.push({ addr, block: key, type: r.type, name: r.name, id: attrs.id, attrs, dur: 0.4 + rng() });
          continue;
        }
        const d = typeDef(r.type);
        const existing = state.resources[addr];
        const cfgAttrs = ev.attrs;
        const ch = { addr, block: bk, type: r.type, name: r.name, key: inst.key, mode: "managed", line: r.line, ctx: r.ctx, blockKeys: ev.blockKeys, deps: dependsBlocks.filter(x => !x.startsWith("data:")), each: inst.each || null, count: inst.count || null, cfg: cfgAttrs };
        const unknownComputed = () => { const o = {}; d.ck.forEach(k => { o[k] = UNKNOWN; }); return o; };
        if (!existing) {
          ch.action = "create"; ch.before = null;
          ch.after = Object.assign({}, d.defaults, unknownComputed(), cfgAttrs);
        } else {
          const before = existing.attrs, changed = [], replaceKeys = [];
          for (const k of Object.keys(cfgAttrs)) if (!deepEq(cfgAttrs[k], before[k])) { changed.push(k); if (d.forceNew.includes(k)) replaceKeys.push(k); }
          for (const k of existing.cfgKeys || []) if (!(k in cfgAttrs)) { changed.push(k); if (d.forceNew.includes(k)) replaceKeys.push(k); }
          ch.before = before; ch.changedKeys = changed; ch.replaceKeys = replaceKeys;
          if (!changed.length) { ch.action = "noop"; ch.after = Object.assign({}, before, cfgAttrs); }
          else if (replaceKeys.length) { ch.action = "replace"; ch.after = Object.assign({}, d.defaults, unknownComputed(), cfgAttrs); }
          else {
            ch.action = "update"; ch.after = Object.assign({}, before, cfgAttrs);
            (existing.cfgKeys || []).forEach(k => { if (!(k in cfgAttrs)) delete ch.after[k]; });
          }
        }
        P.changes.push(ch);
        stored.push({ key: inst.key, attrs: ch.after });
      }
      const rec = { mode: exp.mode, insts: stored };
      if (isData) P.dataValues[key] = rec; else plannedBlocks[key] = rec;
    }
    /* orphans: in state but not in config */
    const wanted = new Set(P.changes.map(c => c.addr));
    const orphanOrder = Object.keys(state.resources);
    for (const addr of orphanOrder) if (!wanted.has(addr)) {
      const s = state.resources[addr];
      P.changes.push({ addr, block: s.block, type: s.type, name: s.name, key: s.key, mode: "managed", action: "delete", before: s.attrs, after: null, deps: s.deps || [], orphan: true, line: 0, blockKeys: s.blockKeys || [] });
    }
    for (const c of P.changes) {
      if (c.action === "create") P.summary.add++;
      else if (c.action === "update") P.summary.change++;
      else if (c.action === "delete") P.summary.destroy++;
      else if (c.action === "replace") { P.summary.add++; P.summary.destroy++; }
    }
    /* outputs */
    for (const o of Object.values(cfg.outputs)) {
      if (!o.expr) continue;
      let v;
      try { v = evalNode(o.expr, ctx); } catch (e) { if (e instanceof EvalErr) { e.line = o.line; e.ctx = o.ctx; } throw e; }
      const had = o.name in state.outputs, prev = state.outputs[o.name];
      let action = !had ? "create" : (deepEq(prev, v) ? "noop" : "update");
      P.outputs.push({ name: o.name, value: v, before: prev, action, sensitive: !!o.sensitive });
    }
    for (const n of Object.keys(state.outputs)) if (!cfg.outputs[n]) P.outputs.push({ name: n, value: null, before: state.outputs[n], action: "delete", sensitive: false });
  } catch (e) {
    if (e instanceof EvalErr) { P.errors.push({ summary: e.summary, detail: e.detail, line: e.line, ctx: e.ctx, addr: e.addr }); P.failed = true; }
    else throw e;
  }
  P.hasChanges = P.changes.some(c => c.action !== "noop") || P.outputs.some(o => o.action !== "noop");
  return P;
}

/* ───────────────────────── apply (event generator) ───────────────────────── */
function makeApplyCtx(cfg, state, P) {
  const vars = P.vars;
  const base = { vars, scope: null,
    getVar(n) { if (!(n in vars)) throw new EvalErr("Reference to undeclared input variable", n); return vars[n]; },
    getLocal(n) { const l = cfg.locals[n]; if (!l) throw new EvalErr("Reference to undeclared local value", n); return evalNode(l.expr, ctx); } };
  const instancesOf = bk => Object.values(state.resources).filter(s => s.block === bk);
  const shapeFor = (r, list, getter) => {
    const mode = r.meta.count ? "count" : r.meta.forEach ? "map" : "single";
    if (mode === "single") { if (!list.length) throw new EvalErr("Dependency not ready", r.type + "." + r.name + " has not been created."); return getter(list[0]); }
    if (mode === "count") return list.sort((a, b) => a.key - b.key).map(getter);
    const o = {}; list.forEach(s => (o[s.key] = getter(s))); return o;
  };
  const ctx = Object.assign(Object.create(base), {
    getResource(type, name) {
      const r = cfg.resources[type + "." + name];
      if (!r) throw new EvalErr("Reference to undeclared resource", type + "." + name);
      return shapeFor(r, instancesOf(type + "." + name), s => new Proxy(s.attrs, { get: (t, k) => k in t ? t[k] : (typeof k === "string" && k.slice(0, 2) !== "__" ? "mock-" + k.replace(/_/g, "-") + "-" + type.length + name.length : undefined) }));
    },
    getData(type, name) {
      const dv = P.dataValues[type + "." + name];
      if (!dv) throw new EvalErr("Data not read", type + "." + name);
      if (dv.mode === "single") return dv.insts[0].attrs;
      if (dv.mode === "count") return dv.insts.map(i => i.attrs);
      const o = {}; dv.insts.forEach(i => (o[i.key] = i.attrs)); return o;
    }
  });
  return ctx;
}
function finishOp(op, cfg, state, P, rng, elapsed) {
  const ch = op.change, r = cfg.resources[ch.block];
  if (op.kind === "delete") { delete state.resources[ch.addr]; return { id: ch.before && ch.before.id }; }
  const d = typeDef(r.type);
  const ctx = makeApplyCtx(cfg, state, P);
  const ictx = Object.assign(Object.create(ctx), { each: ch.each || null, count: ch.count || null });
  const ev = evalBody(r, ictx);
  const cfgAttrs = ev.attrs;
  if (d.check) { const msg = d.check(cfgAttrs); if (msg) { const e = new EvalErr(msg, ""); e.apply = true; throw e; } }
  const gen = makeGen(rng, { region: P.region, project: P.project });
  let attrs;
  if (op.kind === "create") attrs = Object.assign({}, d.defaults, d.computed(cfgAttrs, gen), cfgAttrs);
  else attrs = Object.assign({}, state.resources[ch.addr].attrs, cfgAttrs);
  state.resources[ch.addr] = { type: ch.type, name: ch.name, key: ch.key, block: ch.block, attrs, cfgKeys: Object.keys(cfgAttrs), deps: ch.deps || [], blockKeys: ev.blockKeys };
  return { id: attrs.id };
}
function* applyGen(cfg, state, P, env) {
  env = env || {};
  const rng = env.rng || mulberry32(99);
  const par = env.parallelism || 10;
  const ops = [];
  const byAddr = {};
  for (const ch of P.changes) {
    if (ch.action === "noop") continue;
    if (ch.action === "replace") {
      const del = { id: ch.addr + ":delete", addr: ch.addr, kind: "delete", change: ch, replace: true, waitFor: [] };
      const cre = { id: ch.addr + ":create", addr: ch.addr, kind: "create", change: ch, replace: true, waitFor: [del.id] };
      ops.push(del, cre); byAddr[ch.addr] = { del, cre, block: ch.block };
    } else {
      const op = { id: ch.addr + ":" + ch.action, addr: ch.addr, kind: ch.action === "update" ? "update" : ch.action, change: ch, waitFor: [] };
      ops.push(op); byAddr[ch.addr] = { [op.kind === "delete" ? "del" : "cre"]: op, block: ch.block };
    }
  }
  const blockOps = {};   // block -> ops that finish a create/update
  const blockDel = {};   // block -> delete ops
  for (const e of Object.values(byAddr)) {
    if (e.cre) (blockOps[e.block] = blockOps[e.block] || []).push(e.cre);
    if (e.del) (blockDel[e.block] = blockDel[e.block] || []).push(e.del);
  }
  for (const op of ops) {
    const ch = op.change;
    if (op.kind === "delete") {
      // wait for deletion of anything that depends on this block
      for (const other of ops) if (other.kind === "delete" && other !== op && (other.change.deps || []).includes(ch.block)) op.waitFor.push(other.id);
    } else {
      for (const dep of ch.deps || []) (blockOps[dep] || []).forEach(o => op.waitFor.push(o.id));
    }
  }
  const pending = ops.slice(), running = []; const done = new Set(); let t = 0, failed = false;
  const dur = op => { const d = typeDef(op.change.type); let v = d.dur[0] + rng() * (d.dur[1] - d.dur[0]); if (op.kind === "delete") v *= 0.5; if (op.kind === "update") v *= 0.6; return d.dur[1] < 1 ? v : Math.max(1, Math.round(v)); };
  while (pending.length || running.length) {
    while (!failed && running.length < par) {
      const i = pending.findIndex(o => o.waitFor.every(w => done.has(w)));
      if (i < 0) break;
      const op = pending.splice(i, 1)[0];
      const d = dur(op);
      running.push({ op, start: t, end: t + d, nextStill: t + 10 });
      yield { type: "start", t, op, addr: op.addr, kind: op.kind };
    }
    if (!running.length) break;
    let best = null, bestT = Infinity, still = false;
    for (const r of running) {
      if (r.end < bestT || (r.end === bestT && !still)) { best = r; bestT = r.end; still = false; }
      if (r.nextStill < r.end && r.nextStill < bestT) { best = r; bestT = r.nextStill; still = true; }
    }
    t = bestT;
    if (still) { best.nextStill += 10; yield { type: "still", t, op: best.op, addr: best.op.addr, kind: best.op.kind, elapsed: t - best.start, id: best.op.kind !== "create" ? (best.op.change.before && best.op.change.before.id) : null }; continue; }
    running.splice(running.indexOf(best), 1);
    const el = t - best.start;
    try {
      const res = finishOp(best.op, cfg, state, P, rng, el);
      done.add(best.op.id);
      yield { type: "done", t, op: best.op, addr: best.op.addr, kind: best.op.kind, elapsed: el, id: res.id };
    } catch (e) {
      if (!(e instanceof EvalErr)) throw e;
      failed = true;
      yield { type: "error", t, op: best.op, addr: best.op.addr, kind: best.op.kind, elapsed: el, error: { summary: e.apply ? (best.op.kind === "create" ? "creating " : "updating ") + (R[best.op.change.type].label) + " (" + (best.op.change.cfg && (best.op.change.cfg.bucket || best.op.change.cfg.name) || best.op.change.name) + "): " + e.summary : e.summary, detail: e.detail, line: best.op.change.line, ctx: best.op.change.ctx, addr: best.op.addr } };
    }
  }
  // finalize outputs
  if (!failed) {
    state.outputs = {};
    const ctx = makeApplyCtx(cfg, state, P);
    for (const o of Object.values(cfg.outputs)) { try { state.outputs[o.name] = evalNode(o.expr, ctx); } catch (e) { if (!(e instanceof EvalErr)) throw e; } }
  }
  state.serial++;
  yield { type: "finish", t, failed, outputs: state.outputs };
}

/* ───────────────────────── text rendering ───────────────────────── */
const SIGN_W = { "+": "+", "-": "-", "~": "~", " ": " " };
function prim(v) {
  if (isU(v)) return "(known after apply)";
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}
function valStr(v, ind, sign, quoteKeys) {
  if (isU(v) || v === null || v === undefined || typeof v !== "object") return prim(v);
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    return "[\n" + v.map(x => pad(ind + 4) + sign + " " + valStr(x, ind + 4, sign, quoteKeys) + ",").join("\n") + "\n" + pad(ind + 2) + "]";
  }
  const keys = Object.keys(v).sort();
  if (!keys.length) return "{}";
  const q = k => quoteKeys ? JSON.stringify(k) : k, w = Math.max(...keys.map(k => q(k).length));
  return "{\n" + keys.map(k => pad(ind + 4) + sign + " " + q(k).padEnd(w) + " = " + valStr(v[k], ind + 4, sign, quoteKeys)).join("\n") + "\n" + pad(ind + 2) + "}";
}
function blockLines(name, arr, ind, sign) {
  const out = [];
  for (const b of arr) {
    out.push(pad(ind) + sign + " " + name + " {");
    const keys = Object.keys(b).sort(), flat = keys.filter(k => !(Array.isArray(b[k]) && b[k].length && isObj(b[k][0]))), w = Math.max(0, ...flat.map(k => k.length));
    flat.forEach(k => out.push(pad(ind + 4) + sign + " " + k.padEnd(w) + " = " + valStr(b[k], ind + 4, sign, true)));
    keys.filter(k => !flat.includes(k)).forEach(k => out.push(...blockLines(k, b[k], ind + 4, sign)));
    out.push(pad(ind + 2) + "}");
  }
  return out;
}
function diffVal(key, a, b, ind, w, mark) {
  // returns lines for a changed attribute
  const left = pad(ind) + "~ " + String(key).padEnd(w) + " = ";
  const sfx = mark ? " # forces replacement" : "";
  if (isObj(a) && isObj(b) && !isU(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort(); const kw = Math.max(...keys.map(k => JSON.stringify(k).length));
    const out = [left + "{"]; let hidden = 0;
    for (const k of keys) {
      const q = JSON.stringify(k).padEnd(kw);
      if (!(k in b)) out.push(pad(ind + 4) + "- " + q + " = " + prim(a[k]) + " -> null");
      else if (!(k in a)) out.push(pad(ind + 4) + "+ " + q + " = " + prim(b[k]));
      else if (!deepEq(a[k], b[k])) out.push(pad(ind + 4) + "~ " + q + " = " + prim(a[k]) + " -> " + prim(b[k]));
      else hidden++;
    }
    if (hidden) out.push(pad(ind + 6) + "# (" + hidden + " unchanged element" + (hidden > 1 ? "s" : "") + " hidden)");
    out.push(pad(ind + 2) + "}" + sfx);
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const out = [left + "["];
    a.forEach(x => { if (!b.some(y => deepEq(x, y))) out.push(pad(ind + 4) + "- " + valStr(x, ind + 4, "-") + ","); else out.push(pad(ind + 6) + valStr(x, ind + 4, " ") + ","); });
    b.forEach(x => { if (!a.some(y => deepEq(x, y))) out.push(pad(ind + 4) + "+ " + valStr(x, ind + 4, "+") + ","); });
    out.push(pad(ind + 2) + "]" + sfx);
    return out;
  }
  return [left + prim(a) + " -> " + prim(b) + sfx];
}
function renderChange(ch) {
  const d = typeDef(ch.type), a = ch.action;
  const out = [];
  const header = { create: "will be created", update: "will be updated in-place", delete: "will be destroyed", replace: "must be replaced" }[a];
  out.push("  # " + ch.addr + " " + header);
  const sym = { create: "+", update: "~", delete: "-", replace: "-/+" }[a];
  out.push((sym.length === 3 ? sym : "  " + sym) + ' resource "' + ch.type + '" "' + ch.name + '" {');
  const bk = new Set(ch.blockKeys || []);
  if (a === "create") {
    const attrs = Object.assign({}, ch.after);
    const flat = Object.keys(attrs).filter(k => !bk.has(k)).sort(), w = Math.max(0, ...flat.map(k => k.length));
    flat.forEach(k => out.push("      + " + k.padEnd(w) + " = " + valStr(attrs[k], 6, "+", true)));
    [...bk].sort().forEach(k => out.push(...blockLines(k, attrs[k] || [], 6, "+")));
  } else if (a === "delete") {
    const attrs = ch.before || {};
    const flat = Object.keys(attrs).filter(k => !bk.has(k)).sort(), w = Math.max(0, ...flat.map(k => k.length));
    flat.forEach(k => out.push("      - " + k.padEnd(w) + " = " + valStr(attrs[k], 6, "-", true) + " -> null"));
    [...bk].sort().forEach(k => out.push(...blockLines(k, attrs[k] || [], 6, "-")));
  } else {
    const before = ch.before || {}, after = ch.after || {};
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(k => !bk.has(k)).sort();
    const w = Math.max(0, ...keys.map(k => k.length));
    let hidden = 0;
    for (const k of keys) {
      const mark = (ch.replaceKeys || []).includes(k);
      const unknownNew = isU(after[k]);
      const isChanged = !deepEq(before[k], after[k]) || (a === "replace" && unknownNew);
      if (a === "update" && !isChanged) { if (k === "id") out.push("        " + k.padEnd(w) + " = " + prim(before[k])); else hidden++; continue; }
      if (a === "replace" && !isChanged) { if (k === "id") out.push("        " + k.padEnd(w) + " = " + prim(before[k])); else hidden++; continue; }
      if (!(k in after) || after[k] === undefined) out.push("      - " + k.padEnd(w) + " = " + valStr(before[k], 6, "-", true) + " -> null");
      else if (!(k in before)) out.push("      + " + k.padEnd(w) + " = " + valStr(after[k], 6, "+", true));
      else out.push(...diffVal(k, before[k], after[k], 6, w, mark));
    }
    [...bk].sort().forEach(k => { if (!deepEq(before[k], after[k])) out.push(...blockLines(k, after[k] || [], 6, "~")); });
    if (hidden) out.push("        # (" + hidden + " unchanged attribute" + (hidden > 1 ? "s" : "") + " hidden)");
  }
  out.push("    }");
  return out;
}
function planHeader(P) {
  const has = x => P.changes.some(c => c.action === x);
  const lines = ["Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:"];
  if (has("create")) lines.push("  + create");
  if (has("update")) lines.push("  ~ update in-place");
  if (has("delete")) lines.push("  - destroy");
  if (has("replace")) lines.push("-/+ destroy and then create replacement");
  lines.push("", "Terraform will perform the following actions:", "");
  return lines;
}
function planSummary(P) {
  const s = P.summary;
  return "Plan: " + s.add + " to add, " + s.change + " to change, " + s.destroy + " to destroy.";
}
function outputChangeLines(P) {
  const ch = P.outputs.filter(o => o.action !== "noop");
  if (!ch.length) return [];
  const w = Math.max(...ch.map(o => o.name.length));
  const out = ["", "Changes to Outputs:"];
  const show = (o, v) => o.sensitive ? "(sensitive value)" : valStr(v, 2, "+", true);
  for (const o of ch) {
    if (o.action === "create") out.push("  + " + o.name.padEnd(w) + " = " + show(o, o.value));
    else if (o.action === "delete") out.push("  - " + o.name.padEnd(w) + " = " + prim(o.before) + " -> null");
    else out.push("  ~ " + o.name.padEnd(w) + " = " + (o.sensitive ? "(sensitive value)" : prim(o.before) + " -> " + prim(o.value)));
  }
  return out;
}
function outputsText(outputs, cfg) {
  const names = Object.keys(outputs);
  if (!names.length) return ["The state file either has no outputs defined, or all the defined outputs are empty. Please define an output in your configuration with the `output` keyword and run `terraform refresh` for it to become available."];
  return names.sort().map(n => n + " = " + ((cfg && cfg.outputs[n] && cfg.outputs[n].sensitive) ? "<sensitive>" : fmtOut(outputs[n])));
}
function fmtOut(v, ind) {
  ind = ind || 0;
  if (v === null || typeof v !== "object") return prim(v);
  if (Array.isArray(v)) return v.length ? "[\n" + v.map(x => pad(ind + 2) + fmtOut(x, ind + 2) + ",").join("\n") + "\n" + pad(ind) + "]" : "[]";
  const k = Object.keys(v).sort(); const w = Math.max(...k.map(x => JSON.stringify(x).length));
  return k.length ? "{\n" + k.map(x => pad(ind + 2) + JSON.stringify(x).padEnd(w) + " = " + fmtOut(v[x], ind + 2)).join("\n") + "\n" + pad(ind) + "}" : "{}";
}
function providerList(cfg) {
  const names = new Set(Object.keys(cfg.required));
  Object.keys(cfg.providers).forEach(p => names.add(p));
  Object.values(cfg.resources).forEach(r => names.add(r.type.split("_")[0]));
  Object.values(cfg.data).forEach(r => names.add(r.type.split("_")[0]));
  return [...names].map(n => {
    const req = cfg.required[n] || {}, def = PROVIDERS[n] || ["hashicorp/" + n, "1.0.0"];
    return { name: n, source: req.source || def[0], version: def[1], constraint: req.version || null };
  });
}
function initSteps(cfg) {
  const s = [];
  s.push({ text: "Initializing the backend..." });
  if (cfg.backend) s.push({ text: "", }, { text: 'Successfully configured the backend "' + cfg.backend + '"! Terraform will automatically', }, { text: "use this backend unless the backend configuration changes." });
  s.push({ text: "" }, { text: "Initializing provider plugins..." });
  for (const p of providerList(cfg)) {
    s.push({ text: "- Finding " + (p.constraint ? p.source + ' versions matching "' + p.constraint + '"...' : "latest version of " + p.source + "..."), provider: p.name, kind: "find" });
    s.push({ text: "- Installing " + p.source + " v" + p.version + "...", provider: p.name, kind: "install" });
    s.push({ text: "- Installed " + p.source + " v" + p.version + " (signed by HashiCorp)", provider: p.name, kind: "done" });
  }
  s.push({ text: "" },
    { text: "Terraform has created a lock file .terraform.lock.hcl to record the provider" },
    { text: "selections it made above. Include this file in your version control repository" },
    { text: "so that Terraform can guarantee to make the same selections by default when" },
    { text: 'you run "terraform init" in the future.' }, { text: "" },
    { text: "Terraform has been successfully initialized!", cls: "ok" }, { text: "" },
    { text: 'You may now begin working with Terraform. Try running "terraform plan" to see' },
    { text: "any changes that are required for your infrastructure. All Terraform commands" },
    { text: "should now work." }, { text: "" },
    { text: "If you ever set or change modules or backend configuration for Terraform," },
    { text: "rerun this command to reinitialize your working directory. If you forget, other" },
    { text: "commands will detect it and remind you to do so if necessary." });
  return s;
}
function stateList(state) { return Object.keys(state.resources).sort(); }

/* graph for the diagram: one node per instance, edges between blocks' instances */
function graphOf(cfg, state, P) {
  const nodes = [], edges = [], byBlock = {};
  const add = (id, o) => { const n = Object.assign({ id }, o); nodes.push(n); (byBlock[o.block] = byBlock[o.block] || []).push(n); return n; };
  const changeBy = {}; (P && P.changes || []).forEach(c => (changeBy[c.addr] = c));
  const seen = new Set();
  const label = (r, key) => r.name + (key === null || key === undefined ? "" : typeof key === "number" ? "[" + key + "]" : "[" + key + "]");
  const wantedAddrs = new Set();
  if (P && !P.failed) {
    for (const c of P.changes) {
      const r = cfg.resources[c.block];
      add(c.addr, { block: c.block, type: c.type, name: r ? label(r, c.key) : label({ name: c.name }, c.key), mode: "managed", action: c.action, exists: !!state.resources[c.addr] });
      seen.add(c.addr); wantedAddrs.add(c.addr);
    }
    for (const rd of P.dataReads) { add("data." + rd.addr.replace(/^data\./, ""), { block: "data:" + rd.block, type: rd.type, name: label(cfg.data[rd.block], null), mode: "data", action: "read", exists: true }); }
  } else {
    // draft view straight from config (counts when evaluable)
    for (const [bk, r] of Object.entries(cfg.resources)) {
      let keys = [null];
      try {
        if (r.meta.count && r.meta.count.t === "lit") keys = Array.from({ length: r.meta.count.v }, (_, i) => i);
        else if (r.meta.forEach && r.meta.forEach.t === "list" && r.meta.forEach.items.every(i => i.t === "lit")) keys = r.meta.forEach.items.map(i => String(i.v));
        else if (r.meta.forEach && r.meta.forEach.t === "obj") keys = r.meta.forEach.entries.map(e => String(e.k.v));
        else if (r.meta.count) keys = [0];
        else if (r.meta.forEach) keys = ["each"];
      } catch (e) { /* keep default */ }
      keys.forEach(k => {
        const addr = r.type + "." + r.name + (k === null ? "" : typeof k === "number" ? "[" + k + "]" : '["' + k + '"]');
        add(addr, { block: bk, type: r.type, name: label(r, k), mode: "managed", action: state.resources[addr] ? "exists" : "config", exists: !!state.resources[addr] });
        seen.add(addr);
      });
    }
    for (const [bk, r] of Object.entries(cfg.data)) add("data." + bk, { block: "data:" + bk, type: r.type, name: r.name, mode: "data", action: "read", exists: true });
    for (const [addr, s] of Object.entries(state.resources)) if (!seen.has(addr)) add(addr, { block: s.block, type: s.type, name: s.name + (s.key === null || s.key === undefined ? "" : "[" + s.key + "]"), mode: "managed", action: "orphan", exists: true });
  }
  // deps (block level) -> instance edges
  const depsOf = n => {
    if (cfg.deps[n.block]) return cfg.deps[n.block];
    const s = state.resources[n.id]; return s ? (s.deps || []) : [];
  };
  for (const n of nodes) for (const d of depsOf(n)) for (const t of byBlock[d] || []) edges.push({ from: t.id, to: n.id });
  return { nodes, edges };
}

root.TFSim = { UNKNOWN, isU, parse: parseHcl, loadConfig, formatDiagnostic, newState, plan, applyGen, renderChange, planHeader, planSummary, outputChangeLines, outputsText, initSteps, providerList, stateList, graphOf, typeDef, CAT, R, DATA, HclError, EvalErr, fmtDur, mulberry32, deepEq, FN, evalNode, hasUnknown };
if (typeof module !== "undefined" && module.exports) module.exports = root.TFSim;
})(typeof window !== "undefined" ? window : globalThis);
