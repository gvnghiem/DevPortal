// Async + discriminated unions — the compiler narrows each branch for you.
// Results are logged to the Console AND drawn in the preview.

type Loading = { status: "loading" };
type Success<T> = { status: "success"; data: T; ms: number };
type Failure = { status: "error"; error: string; retryable: boolean };
type Result<T> = Loading | Success<T> | Failure;

interface User { id: number; name: string; role: "admin" | "editor" | "viewer" }

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function fetchUser(id: number): Promise<Result<User>> {
  const t0 = Date.now();
  await wait(250 + Math.random() * 350);                 // pretend network
  if (id === 13) return { status: "error", error: "Unlucky number: server said 500", retryable: true };
  if (id > 20) return { status: "error", error: "User " + id + " not found", retryable: false };
  const roles: User["role"][] = ["admin", "editor", "viewer"];
  return { status: "success", ms: Date.now() - t0, data: { id, name: "User #" + id, role: roles[id % 3] } };
}

function describe(r: Result<User>): string {
  switch (r.status) {                                    // exhaustive switch: add a case and TS complains
    case "loading": return "⏳ loading…";
    case "success": return "✅ " + r.data.name + " (" + r.data.role + ") in " + r.ms + "ms";
    case "error":   return "❌ " + r.error + (r.retryable ? "  — will retry" : "");
  }
}

// ---- tiny UI -------------------------------------------------------------
const app = document.getElementById("app")!;
app.style.pointerEvents = "auto";
app.innerHTML = `<style>
  .box{max-width:560px;margin:28px auto;font:14px/1.5 system-ui,sans-serif;color:${THEME.fg}}
  h2{margin:0 0 4px;color:${THEME.accent}} p{margin:0 0 14px;color:${THEME.muted}}
  .row{display:flex;gap:10px;align-items:center;padding:10px 12px;margin:6px 0;border:1px solid ${THEME.muted}55;border-radius:10px;background:${THEME.bg}}
  .row b{min-width:58px} .ok{border-color:${THEME.ok}} .bad{border-color:${THEME.err}} .wait{opacity:.7}
  button{margin-top:10px;padding:8px 14px;border-radius:8px;border:0;background:${THEME.accent};color:#fff;cursor:pointer;font-weight:600}
</style><div class="box"><h2>Async + discriminated unions</h2><p>Each row is a <code>Result&lt;User&gt;</code>. Try the button to run it again.</p><div id="rows"></div><button id="again">Run again</button></div>`;

const rows = document.getElementById("rows")!;
async function load(ids: number[]) {
  rows.innerHTML = "";
  const els = ids.map(id => {
    const d = document.createElement("div");
    d.className = "row wait"; d.innerHTML = "<b>id " + id + "</b><span>" + describe({ status: "loading" }) + "</span>";
    rows.appendChild(d); return d;
  });
  const results = await Promise.all(ids.map(fetchUser));
  results.forEach((r, i) => {
    els[i].className = "row " + (r.status === "success" ? "ok" : "bad");
    els[i].lastElementChild!.textContent = describe(r);
    console.log("id", ids[i], "→", describe(r));
  });
  const okCount = results.filter(r => r.status === "success").length;
  console.log(okCount + " of " + results.length + " succeeded");
}
document.getElementById("again")!.addEventListener("click", () => load([1, 2, 13, 42, 7]));
load([1, 2, 13, 42, 7]);
