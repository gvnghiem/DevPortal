/* langs-extra.js — example programs for the TypeScript and Rust playgrounds. */
(function () {
"use strict";
const BT = String.fromCharCode(96);
const T = s => s.replace(/@\{/g, "${").replace(/§/g, BT);

window.TS_EXAMPLES = {
"✦ New (blank)": "",
"Hello, TypeScript": T(`// Types are erased when your code runs — try breaking one to see the editor stay quiet,
// then run: syntax errors are reported with line numbers.
interface User {
  id: number;
  name: string;
  tags?: string[];
}

function greet(user: User): string {
  return §Hello, @{user.name}! You are #@{user.id}.§;
}

const users: User[] = [
  { id: 1, name: "Ada", tags: ["math"] },
  { id: 2, name: "Linus" },
];

users.forEach(u => console.log(greet(u)));

// Generics
function first<T>(items: T[]): T | undefined {
  return items[0];
}
console.log(first([10, 20, 30]), first<string>([]));

// Unions + narrowing
type Shape = { kind: "circle"; r: number } | { kind: "rect"; w: number; h: number };
const area = (s: Shape): number => (s.kind === "circle" ? Math.PI * s.r ** 2 : s.w * s.h);
console.log("areas:", area({ kind: "circle", r: 2 }).toFixed(2), area({ kind: "rect", w: 3, h: 4 }));
`),
"Async + discriminated unions": T(`type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function fetchScore(name: string): Promise<Result<number>> {
  await sleep(200);
  if (name.length < 3) return { ok: false, error: "name too short: " + name };
  return { ok: true, value: name.length * 11 };
}

async function main(): Promise<void> {
  const names = ["Ada", "Al", "Grace"];
  const results = await Promise.all(names.map(fetchScore));
  results.forEach((r, i) => {
    if (r.ok) console.log(names[i], "->", r.value);
    else console.warn(r.error);
  });
  const total = results.reduce((sum, r) => (r.ok ? sum + r.value : sum), 0);
  console.info("total score:", total);
}

main();
`),
"Canvas: typed particles": T(`declare const THEME: { bg: string; fg: string; accent: string; accent2: string; fade(a: number): string };

interface Particle { x: number; y: number; vx: number; vy: number; r: number; hue: number }

const cv = document.getElementById("canvas") as HTMLCanvasElement;
const ctx = cv.getContext("2d")!;
const W = cv.width, H = cv.height;

const ps: Particle[] = Array.from({ length: 70 }, () => ({
  x: Math.random() * W, y: Math.random() * H,
  vx: (Math.random() - 0.5) * 2, vy: (Math.random() - 0.5) * 2,
  r: 2 + Math.random() * 3, hue: Math.random() * 60 + 160,
}));

function step(): void {
  ctx.fillStyle = THEME.fade(0.25);
  ctx.fillRect(0, 0, W, H);
  for (const p of ps) {
    p.x = (p.x + p.vx + W) % W;
    p.y = (p.y + p.vy + H) % H;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fillStyle = §hsl(@{p.hue} 90% 60%)§;
    ctx.fill();
  }
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
    const d = Math.hypot(ps[i].x - ps[j].x, ps[i].y - ps[j].y);
    if (d < 90) {
      ctx.strokeStyle = THEME.accent;
      ctx.globalAlpha = 1 - d / 90;
      ctx.beginPath(); ctx.moveTo(ps[i].x, ps[i].y); ctx.lineTo(ps[j].x, ps[j].y); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
  requestAnimationFrame(step);
}
step();
console.log("particles:", ps.length);
`),
"Classes, generics & DOM": T(`class Stack<T> {
  private items: T[] = [];
  push(item: T): this { this.items.push(item); return this; }
  pop(): T | undefined { return this.items.pop(); }
  get size(): number { return this.items.length; }
  toArray(): readonly T[] { return this.items; }
}

const s = new Stack<string>().push("a").push("b").push("c");
console.log("size", s.size, "top", s.pop());

enum Level { Low, Mid, High }
console.log(Level[Level.Mid], Level.High);

const app = document.getElementById("app") as HTMLDivElement;
app.style.cssText = "padding:24px;font:16px system-ui";
app.innerHTML = "<h2>Typed Stack</h2>";
const list = document.createElement("ul");
s.toArray().forEach((x: string) => {
  const li = document.createElement("li");
  li.textContent = x.toUpperCase();
  list.appendChild(li);
});
app.appendChild(list);
`)
};
window.TS_GROUPS = {
  "New": ["✦ New (blank)"],
  "Basics": ["Hello, TypeScript", "Async + discriminated unions"],
  "Visual": ["Canvas: typed particles", "Classes, generics & DOM"]
};

window.RUST_EXAMPLES = {
"✦ New (blank)": "",
"Hello, Rust": T(`fn main() {
    let name = "DevPortal";
    println!("Hello from {}!", name);

    let squares: Vec<u32> = (1..=5).map(|n| n * n).collect();
    println!("squares = {:?}", squares);
    println!("sum = {}", squares.iter().sum::<u32>());
}
`),
"Structs, traits & enums": T(`use std::fmt;

#[derive(Debug)]
enum Shape {
    Circle { r: f64 },
    Rect { w: f64, h: f64 },
}

trait Area {
    fn area(&self) -> f64;
}

impl Area for Shape {
    fn area(&self) -> f64 {
        match self {
            Shape::Circle { r } => std::f64::consts::PI * r * r,
            Shape::Rect { w, h } => w * h,
        }
    }
}

impl fmt::Display for Shape {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Shape::Circle { r } => write!(f, "circle(r={})", r),
            Shape::Rect { w, h } => write!(f, "rect({}x{})", w, h),
        }
    }
}

fn main() {
    let shapes = vec![Shape::Circle { r: 2.0 }, Shape::Rect { w: 3.0, h: 4.5 }];
    for s in &shapes {
        println!("{:<14} area = {:.2}", s.to_string(), s.area());
    }
    let total: f64 = shapes.iter().map(|s| s.area()).sum();
    println!("total area = {:.2}", total);
}
`),
"Ownership & Result": T(`use std::collections::HashMap;
use std::num::ParseIntError;

fn parse_pair(s: &str) -> Result<(String, i32), ParseIntError> {
    let mut parts = s.split('=');
    let key = parts.next().unwrap_or("").trim().to_string();
    let val: i32 = parts.next().unwrap_or("").trim().parse()?;
    Ok((key, val))
}

fn main() {
    let lines = ["apples = 3", "pears = 7", "plums = many", "figs = 12"];
    let mut stock: HashMap<String, i32> = HashMap::new();

    for line in lines.iter() {
        match parse_pair(line) {
            Ok((k, v)) => { stock.insert(k, v); }
            Err(e) => println!("skipping {:?}: {}", line, e),
        }
    }

    let mut keys: Vec<_> = stock.keys().cloned().collect();
    keys.sort();
    for k in keys {
        println!("{k}: {}", stock[&k]);
    }

    // Ownership: s is moved into 'moved', so we clone to keep using it.
    let s = String::from("hello");
    let moved = s.clone();
    println!("{} {}", s, moved);
}
`),
"Primes & timing": T(`use std::time::Instant;

fn sieve(n: usize) -> Vec<usize> {
    let mut is_prime = vec![true; n + 1];
    is_prime[0] = false;
    if n >= 1 { is_prime[1] = false; }
    let mut i = 2;
    while i * i <= n {
        if is_prime[i] {
            let mut j = i * i;
            while j <= n { is_prime[j] = false; j += i; }
        }
        i += 1;
    }
    is_prime.iter().enumerate().filter(|(_, &p)| p).map(|(i, _)| i).collect()
}

fn main() {
    let start = Instant::now();
    let primes = sieve(1_000_000);
    println!("{} primes below 1,000,000", primes.len());
    println!("last five: {:?}", &primes[primes.len() - 5..]);
    println!("took {:?}", start.elapsed());
}
`),
"Compile error: borrow checker": T(`// This does NOT compile — the compiler output shows up in the Console, like cargo would print it.
fn main() {
    let s = String::from("hello");
    let t = s;            // ownership moves to t
    println!("{}", s);    // error[E0382]: borrow of moved value: 's'
    println!("{}", t);
}
`)
};
window.RUST_GROUPS = {
  "New": ["✦ New (blank)"],
  "Basics": ["Hello, Rust", "Primes & timing"],
  "Language tour": ["Structs, traits & enums", "Ownership & Result"],
  "Errors": ["Compile error: borrow checker"]
};
})();
