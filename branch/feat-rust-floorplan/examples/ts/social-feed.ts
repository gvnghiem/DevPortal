// A mini social network page: compose, like, repost, reply, follow, filter. All state is in memory.

interface Author { handle: string; name: string; color: string; bio: string }
interface Post { id: number; by: string; text: string; time: string; likes: number; reposts: number; replies: string[]; liked: boolean; tag: string }

const authors: Record<string, Author> = {
  ada:   { handle: "ada",   name: "Ada Lovelace",  color: "#a78bfa", bio: "First programmer. Analytical Engine fan." },
  linus: { handle: "linus", name: "Linus T.",      color: "#34d399", bio: "Kernel hacker. Opinions: strong." },
  grace: { handle: "grace", name: "Grace Hopper",  color: "#f59e0b", bio: "Found the first bug. Taped it in the log." },
  you:   { handle: "you",   name: "You",           color: "#60a5fa", bio: "Learning in public with DevPortal." },
};
let nextId = 5;
let posts: Post[] = [
  { id: 4, by: "grace", text: "Reminder: the most dangerous phrase in computing is “we've always done it this way”. 🪲", time: "2m", likes: 128, reposts: 31, replies: [], liked: false, tag: "career" },
  { id: 3, by: "linus", text: "Talk is cheap. Show me the (compiling) code. Also: please run the tests before pushing.", time: "18m", likes: 342, reposts: 77, replies: ["ada: Tests first, then talk. 😄"], liked: false, tag: "code" },
  { id: 2, by: "ada",   text: "Today I taught a loom to compute Bernoulli numbers. The poetry of programming is that it weaves thought. ✨", time: "1h", likes: 509, reposts: 120, replies: [], liked: true, tag: "history" },
  { id: 1, by: "you",   text: "Hello DevPortal! My first post from the TypeScript playground. 👋", time: "3h", likes: 12, reposts: 1, replies: [], liked: false, tag: "code" },
];
const following = new Set<string>(["ada"]);
let filter = "all";
const tags = ["all", "code", "career", "history"];

const css = `
.sn{font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;color:#e7e9ee;background:#0f1419;min-height:100%}
.sn .wrap{max-width:980px;margin:0 auto;display:grid;grid-template-columns:200px 1fr 260px;gap:0}
.sn aside{padding:16px 12px;position:sticky;top:0;align-self:start}
.sn .brand{font-size:24px;font-weight:800;padding:6px 12px 14px;color:#60a5fa}
.sn .nav a{display:block;padding:11px 14px;border-radius:99px;font-size:17px;cursor:pointer;color:#e7e9ee}
.sn .nav a.on{font-weight:700;background:#1d2733}.sn .nav a:hover{background:#192330}
.sn main{border-left:1px solid #2f3640;border-right:1px solid #2f3640;min-height:100vh}
.sn header{position:sticky;top:0;background:#0f1419ee;backdrop-filter:blur(8px);padding:14px 16px;font-weight:700;font-size:19px;border-bottom:1px solid #2f3640;z-index:2}
.av{width:42px;height:42px;border-radius:50%;display:grid;place-items:center;font-weight:700;color:#0f1419;flex:none}
.comp{display:flex;gap:12px;padding:14px 16px;border-bottom:1px solid #2f3640}
.comp textarea{flex:1;background:transparent;border:0;outline:0;color:inherit;font:inherit;resize:none;min-height:56px}
.comp .bar{display:flex;justify-content:space-between;align-items:center;color:#71767b;font-size:13px}
.post{display:flex;gap:12px;padding:14px 16px;border-bottom:1px solid #2f3640}
.post:hover{background:#131a22}.post .b{flex:1;min-width:0}
.post .n{font-weight:700}.post .m{color:#71767b}
.post .t{margin:2px 0 8px;white-space:pre-wrap;word-wrap:break-word}
.tag{color:#60a5fa;font-size:12px}
.acts{display:flex;gap:30px;color:#71767b;font-size:13px}
.acts button{background:none;border:0;color:inherit;cursor:pointer;font:inherit;padding:4px 0}
.acts button:hover{color:#60a5fa}.acts .like.on{color:#f43f5e}
.reply{margin-top:8px;padding:8px 12px;border-left:2px solid #2f3640;color:#a0a6ad;font-size:13px}
.btn{background:#60a5fa;color:#0f1419;border:0;border-radius:99px;padding:8px 18px;font-weight:700;cursor:pointer}
.btn:disabled{opacity:.4;cursor:default}
.tabs{display:flex;border-bottom:1px solid #2f3640}.tabs a{flex:1;text-align:center;padding:13px;cursor:pointer;color:#71767b;font-weight:600}
.tabs a.on{color:#e7e9ee;box-shadow:inset 0 -3px #60a5fa}
.box{background:#16202a;border-radius:16px;padding:14px;margin-bottom:14px}.box h4{margin:0 0 10px;font-size:18px}
.sug{display:flex;gap:10px;align-items:center;padding:8px 0}.sug .who{flex:1;min-width:0}.sug small{color:#71767b;display:block}
.fol{background:transparent;border:1px solid #536471;color:#e7e9ee;border-radius:99px;padding:6px 14px;font-weight:600;cursor:pointer}
.fol.on{background:#e7e9ee;color:#0f1419}
@media(max-width:760px){.sn .wrap{grid-template-columns:1fr}.sn aside{display:none}}
`;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const avatar = (a: Author) => `<div class="av" style="background:${a.color}">${a.name[0]}</div>`;

const app = document.getElementById("app")!;
app.style.pointerEvents = "auto";
let draft = "";

function postHtml(p: Post): string {
  const a = authors[p.by];
  return `<article class="post" data-id="${p.id}">${avatar(a)}<div class="b">
    <div><span class="n">${a.name}</span> <span class="m">@${a.handle} · ${p.time}</span></div>
    <div class="t">${esc(p.text)}</div><span class="tag">#${p.tag}</span>
    <div class="acts"><button data-a="reply">💬 ${p.replies.length}</button><button data-a="repost">🔁 ${p.reposts}</button><button data-a="like" class="like ${p.liked ? "on" : ""}">${p.liked ? "❤️" : "🤍"} ${p.likes}</button></div>
    ${p.replies.map(r => `<div class="reply">${esc(r)}</div>`).join("")}</div></article>`;
}
function view(): void {
  const list = posts.filter(p => filter === "all" || p.tag === filter);
  const sug = Object.values(authors).filter(a => a.handle !== "you");
  app.innerHTML = `<style>${css}</style><div class="sn"><div class="wrap">
  <aside><div class="brand">◉ Chirp</div><div class="nav"><a class="on">🏠 Home</a><a>🔎 Explore</a><a>🔔 Notifications</a><a>✉️ Messages</a><a>👤 Profile</a></div></aside>
  <main><header>Home</header>
    <div class="comp">${avatar(authors.you)}<div style="flex:1"><textarea id="draft" maxlength="140" placeholder="What is happening?!">${esc(draft)}</textarea>
      <div class="bar"><span id="cnt">${140 - draft.length}</span><button class="btn" id="send" ${draft.trim() ? "" : "disabled"}>Chirp</button></div></div></div>
    <div class="tabs">${tags.map(t => `<a data-f="${t}" class="${filter === t ? "on" : ""}">${t === "all" ? "For you" : "#" + t}</a>`).join("")}</div>
    ${list.length ? list.map(postHtml).join("") : '<p style="padding:30px;text-align:center;color:#71767b">Nothing here yet.</p>'}</main>
  <aside><div class="box"><h4>Who to follow</h4>${sug.map(a => `<div class="sug">${avatar(a)}<div class="who"><b>${a.name}</b><small>${esc(a.bio)}</small></div>
    <button class="fol ${following.has(a.handle) ? "on" : ""}" data-u="${a.handle}">${following.has(a.handle) ? "Following" : "Follow"}</button></div>`).join("")}</div>
  <div class="box"><h4>Trending</h4><div class="sug"><div class="who"><b>#TypeScript</b><small>12.4K chirps</small></div></div><div class="sug"><div class="who"><b>#DevPortal</b><small>Trending in Tech</small></div></div></div></aside>
  </div></div>`;
  const ta = document.getElementById("draft") as HTMLTextAreaElement;
  ta.addEventListener("input", () => { draft = ta.value; document.getElementById("cnt")!.textContent = String(140 - draft.length); (document.getElementById("send") as HTMLButtonElement).disabled = !draft.trim(); });
  document.getElementById("send")!.addEventListener("click", () => {
    const text = draft.trim(); if (!text) return;
    const tag = (text.match(/#(\w+)/) || [, "code"])[1]!.toLowerCase();
    if (!tags.includes(tag)) tags.push(tag);
    posts.unshift({ id: nextId++, by: "you", text, time: "now", likes: 0, reposts: 0, replies: [], liked: false, tag });
    draft = ""; console.log("posted:", text); view();
  });
  app.querySelectorAll<HTMLElement>("[data-f]").forEach(el => el.addEventListener("click", () => { filter = el.dataset.f!; view(); }));
  app.querySelectorAll<HTMLElement>("[data-u]").forEach(el => el.addEventListener("click", () => {
    const u = el.dataset.u!; following.has(u) ? following.delete(u) : following.add(u);
    console.log("following:", [...following].join(", ") || "nobody"); view();
  }));
  app.querySelectorAll<HTMLElement>("article [data-a]").forEach(el => el.addEventListener("click", () => {
    const id = Number(el.closest("article")!.getAttribute("data-id")); const p = posts.find(x => x.id === id)!;
    switch (el.dataset.a) {
      case "like": p.liked = !p.liked; p.likes += p.liked ? 1 : -1; break;
      case "repost": p.reposts++; console.log("reposted", id); break;
      case "reply": p.replies.push("you: Great point!"); break;
    }
    view();
  }));
}
view();
console.log("feed ready:", posts.length, "posts");
