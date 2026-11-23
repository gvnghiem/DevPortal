// @react — React 18 runs right here (JSX is compiled in the browser by Babel).
// React hooks are in scope: useState, useEffect, useRef, useMemo, useReducer, useCallback.

function Counter() {
  const [n, setN] = useState(0);
  return (
    <div className="card">
      <h3>Counter</h3>
      <div className="big">{n}</div>
      <button onClick={() => setN(n - 1)}>−</button>{" "}
      <button onClick={() => setN(0)}>reset</button>{" "}
      <button className="p" onClick={() => setN(n + 1)}>+</button>
    </div>
  );
}

function Todos() {
  const [items, setItems] = useState([
    { id: 1, text: "Learn JSX", done: true },
    { id: 2, text: "Build a component", done: false },
    { id: 3, text: "Ship it", done: false },
  ]);
  const [text, setText] = useState("");
  const left = items.filter(i => !i.done).length;
  const add = e => {
    e.preventDefault();
    if (!text.trim()) return;
    setItems([...items, { id: Date.now(), text: text.trim(), done: false }]);
    setText("");
  };
  return (
    <div className="card">
      <h3>Todos <small>({left} left)</small></h3>
      <form onSubmit={add}>
        <input value={text} onChange={e => setText(e.target.value)} placeholder="What needs doing?" />
        <button className="p">Add</button>
      </form>
      <ul>
        {items.map(i => (
          <li key={i.id} className={i.done ? "done" : ""}>
            <label>
              <input type="checkbox" checked={i.done}
                onChange={() => setItems(items.map(x => x.id === i.id ? { ...x, done: !x.done } : x))} />
              {" "}{i.text}
            </label>
            <a onClick={() => setItems(items.filter(x => x.id !== i.id))}>✕</a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {                       // effect with cleanup
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <div className="clock">{now.toLocaleTimeString()}</div>;
}

function App() {
  return (
    <div className="wrap">
      <h2>React in DevPortal <Clock /></h2>
      <div className="grid"><Counter /><Todos /></div>
    </div>
  );
}

const style = document.createElement("style");
style.textContent = `
  .wrap{max-width:760px;margin:24px auto;padding:0 16px;font:15px system-ui,sans-serif;color:${THEME.fg}}
  h2{display:flex;justify-content:space-between;align-items:center;color:${THEME.accent}}
  .clock{font:14px ui-monospace,monospace;color:${THEME.muted}}
  .grid{display:grid;grid-template-columns:1fr 1.6fr;gap:16px}
  .card{padding:16px;border:1px solid ${THEME.muted}55;border-radius:14px;background:${THEME.bg}}
  .card h3{margin:0 0 10px} .card h3 small{color:${THEME.muted};font-weight:400}
  .big{font-size:54px;font-weight:700;margin-bottom:8px}
  button{padding:7px 12px;border-radius:8px;border:1px solid ${THEME.muted}88;background:transparent;color:inherit;cursor:pointer}
  button.p{background:${THEME.accent};border-color:${THEME.accent};color:#fff}
  input[type=text],input:not([type]){padding:7px 10px;border-radius:8px;border:1px solid ${THEME.muted}88;background:transparent;color:inherit;margin-right:6px}
  ul{list-style:none;padding:0;margin:12px 0 0} li{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid ${THEME.muted}33}
  li.done label{text-decoration:line-through;opacity:.55} li a{cursor:pointer;color:${THEME.err}}
`;
document.head.appendChild(style);
ReactDOM.createRoot(document.getElementById("root")).render(<App />);
console.log("React", React.version, "mounted");
