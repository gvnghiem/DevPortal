// A polished tech landing page, built in typed TypeScript. Toggle monthly / yearly pricing.

interface Feature { icon: string; title: string; text: string }
interface Plan { name: string; monthly: number; blurb: string; perks: string[]; hot?: boolean }

const features: Feature[] = [
  { icon: "⚡", title: "Instant deploys", text: "Push to main and your service is live worldwide in under 12 seconds." },
  { icon: "🛡️", title: "Secure by default", text: "Zero-trust networking, secrets vault and automatic TLS on every service." },
  { icon: "📈", title: "Autoscaling", text: "From 0 to 10,000 requests per second without touching a config file." },
  { icon: "🔍", title: "Live observability", text: "Traces, logs and metrics in one place, correlated automatically." },
  { icon: "🧩", title: "100+ integrations", text: "GitHub, GitLab, Slack, PagerDuty, Terraform and every major cloud." },
  { icon: "🤖", title: "AI assistant", text: "Ask why a deploy failed and get the fix as a pull request." },
];
const plans: Plan[] = [
  { name: "Hacker", monthly: 0, blurb: "For side projects", perks: ["3 services", "Community support", "Shared runners"] },
  { name: "Team", monthly: 29, blurb: "For growing teams", perks: ["Unlimited services", "Preview environments", "SSO", "Priority support"], hot: true },
  { name: "Scale", monthly: 99, blurb: "For production at scale", perks: ["Dedicated runners", "99.99% SLA", "Audit logs", "Solutions engineer"] },
];

const css = `
*{box-sizing:border-box}
.lp{font:16px/1.6 -apple-system,Segoe UI,Inter,system-ui,sans-serif;background:#070b16;color:#e6eaf5;min-height:100%}
.lp a{color:inherit;text-decoration:none}
nav{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:26px;padding:14px 6vw;backdrop-filter:blur(12px);background:#070b16cc;border-bottom:1px solid #ffffff14}
nav .logo{font-weight:800;font-size:20px;letter-spacing:-.5px}
nav .logo span{background:linear-gradient(90deg,#7c5cff,#27d3ff);-webkit-background-clip:text;color:transparent}
nav .links{display:flex;gap:22px;margin-left:12px;color:#9aa6c4;font-size:14px}
nav .links a:hover{color:#fff}
.btn{display:inline-block;padding:10px 18px;border-radius:10px;font-weight:600;font-size:14px;border:1px solid #ffffff25;cursor:pointer;color:#fff;background:transparent}
.btn.p{background:linear-gradient(90deg,#7c5cff,#27d3ff);border:0;color:#04101f}
nav .btn{margin-left:auto}
.hero{position:relative;text-align:center;padding:90px 6vw 70px;overflow:hidden}
.hero:before{content:"";position:absolute;left:50%;top:-180px;width:900px;height:900px;transform:translateX(-50%);background:radial-gradient(closest-side,#7c5cff55,transparent)}
.pill{display:inline-block;padding:5px 14px;border:1px solid #7c5cff77;border-radius:99px;font-size:12px;color:#b9a8ff;background:#7c5cff18}
.hero h1{position:relative;font-size:clamp(36px,6vw,68px);line-height:1.05;margin:18px auto 16px;max-width:900px;letter-spacing:-2px}
.hero h1 em{font-style:normal;background:linear-gradient(90deg,#7c5cff,#27d3ff);-webkit-background-clip:text;color:transparent}
.hero p{position:relative;max-width:620px;margin:0 auto 28px;color:#9aa6c4;font-size:18px}
.term{position:relative;max-width:560px;margin:44px auto 0;text-align:left;background:#0d1426;border:1px solid #ffffff1a;border-radius:14px;padding:16px 18px;font:13px/1.7 ui-monospace,Menlo,monospace;box-shadow:0 30px 80px #000a}
.term i{color:#27d3ff;font-style:normal}.term b{color:#3ddc97}
.sec{padding:70px 6vw}
.sec h2{text-align:center;font-size:34px;letter-spacing:-1px;margin:0 0 8px}
.sec .sub{text-align:center;color:#9aa6c4;margin-bottom:40px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:18px;max-width:1100px;margin:0 auto}
.card{padding:24px;border:1px solid #ffffff14;border-radius:16px;background:linear-gradient(180deg,#0e1730,#0a1124);transition:.2s}
.card:hover{transform:translateY(-4px);border-color:#7c5cff88}
.card .ic{font-size:26px;width:48px;height:48px;display:grid;place-items:center;border-radius:12px;background:#7c5cff22;margin-bottom:14px}
.card h3{margin:0 0 6px;font-size:18px}.card p{margin:0;color:#9aa6c4;font-size:14px}
.toggle{display:flex;justify-content:center;gap:10px;align-items:center;margin-bottom:30px;color:#9aa6c4}
.sw{width:50px;height:28px;border-radius:99px;background:#1a2547;position:relative;cursor:pointer;border:1px solid #ffffff22}
.sw:after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:linear-gradient(90deg,#7c5cff,#27d3ff);transition:.2s}
.sw.on:after{left:25px}
.save{color:#3ddc97;font-size:12px}
.price{font-size:44px;font-weight:800;letter-spacing:-2px}.price small{font-size:14px;color:#9aa6c4;font-weight:500;letter-spacing:0}
.plan.hot{border-color:#7c5cff;box-shadow:0 0 0 1px #7c5cff,0 20px 60px #7c5cff33}
.plan ul{list-style:none;padding:0;margin:18px 0 22px}.plan li{padding:5px 0;color:#c8d0e8;font-size:14px}.plan li:before{content:"✓ ";color:#3ddc97}
.plan .btn{width:100%;text-align:center}
.cta{margin:30px 6vw 0;padding:54px 6vw;text-align:center;border-radius:24px;background:linear-gradient(120deg,#2a1d7a,#0b5a78)}
.cta h2{margin:0 0 10px;font-size:34px}.cta p{margin:0 0 22px;color:#cfe}
footer{padding:40px 6vw;display:flex;justify-content:space-between;color:#6b7799;font-size:13px;flex-wrap:wrap;gap:10px}
`;

let yearly = false;
const money = (n: number) => (n === 0 ? "$0" : "$" + n);

function render(): string {
  return `<style>${css}</style><div class="lp">
  <nav><a class="logo" href="#top"><span>◆</span> Nimbus</a><div class="links"><a href="#f">Features</a><a href="#p">Pricing</a><a href="#">Docs</a><a href="#">Blog</a></div><a class="btn p" href="#p">Start free</a></nav>
  <header class="hero" id="top"><span class="pill">✨ New · Nimbus AI now writes your runbooks</span>
    <h1>Ship software at the <em>speed of thought</em></h1>
    <p>The cloud platform that deploys, scales and observes your code — so your team can focus on the product, not the plumbing.</p>
    <a class="btn p" href="#p">Deploy your first app</a> <a class="btn" href="#f">See how it works</a>
    <div class="term"><i>$</i> nimbus deploy<br><b>✔</b> built in 4.1s<br><b>✔</b> 3 regions healthy<br><b>✔</b> live at <i>https://app.nimbus.dev</i></div></header>
  <section class="sec" id="f"><h2>Everything you need to run in production</h2><div class="sub">One platform, no glue code.</div>
    <div class="grid">${features.map(f => `<div class="card"><div class="ic">${f.icon}</div><h3>${f.title}</h3><p>${f.text}</p></div>`).join("")}</div></section>
  <section class="sec" id="p"><h2>Simple, honest pricing</h2><div class="sub">Start free. Upgrade when you grow.</div>
    <div class="toggle"><span>Monthly</span><div class="sw ${yearly ? "on" : ""}" id="sw"></div><span>Yearly <span class="save">save 20%</span></span></div>
    <div class="grid">${plans.map(p => {
      const price = yearly ? Math.round(p.monthly * 0.8) : p.monthly;
      return `<div class="card plan ${p.hot ? "hot" : ""}"><h3>${p.name}</h3><p>${p.blurb}</p><div class="price">${money(price)}<small> /mo</small></div>
      <ul>${p.perks.map(x => `<li>${x}</li>`).join("")}</ul><a class="btn ${p.hot ? "p" : ""}" href="#">${p.monthly ? "Choose " + p.name : "Get started"}</a></div>`;
    }).join("")}</div></section>
  <section class="cta"><h2>Your next deploy is 12 seconds away</h2><p>Join 40,000 teams shipping with Nimbus.</p><a class="btn p" href="#">Create free account</a></section>
  <footer><span>© 2026 Nimbus Cloud, Inc.</span><span>Privacy · Terms · Status</span></footer></div>`;
}

const root = document.getElementById("app")!;
root.style.pointerEvents = "auto";
function paint(): void {
  const scroll = root.scrollTop;
  root.innerHTML = render();
  root.scrollTop = scroll;
  document.getElementById("sw")!.addEventListener("click", () => { yearly = !yearly; console.log("billing:", yearly ? "yearly" : "monthly"); paint(); });
  root.querySelectorAll('a[href^="#"]').forEach(a => a.addEventListener("click", e => {
    e.preventDefault();
    const id = (a as HTMLAnchorElement).getAttribute("href")!.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  }));
}
paint();
console.log("landing page rendered:", features.length, "features,", plans.length, "plans");
