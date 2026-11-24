// @react — the classic React tutorial game, with time travel through the move history.

function Square({ value, onClick, win }) {
  return <button className={"sq" + (win ? " win" : "")} onClick={onClick}>{value}</button>;
}

const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
function calc(sq) {
  for (const [a, b, c] of LINES) if (sq[a] && sq[a] === sq[b] && sq[a] === sq[c]) return { who: sq[a], line: [a, b, c] };
  return null;
}

function Game() {
  const [history, setHistory] = useState([Array(9).fill(null)]);
  const [step, setStep] = useState(0);
  const squares = history[step];
  const result = calc(squares);
  const xNext = step % 2 === 0;

  function play(i) {
    if (squares[i] || result) return;
    const next = squares.slice(); next[i] = xNext ? "X" : "O";
    setHistory([...history.slice(0, step + 1), next]);
    setStep(step + 1);
  }
  const status = result ? "Winner: " + result.who + " 🎉" : step === 9 ? "Draw!" : "Next: " + (xNext ? "X" : "O");

  return (
    <div className="game">
      <div>
        <h2>Tic-tac-toe</h2>
        <div className="status">{status}</div>
        <div className="board">
          {squares.map((v, i) => <Square key={i} value={v} win={result && result.line.includes(i)} onClick={() => play(i)} />)}
        </div>
      </div>
      <ol>
        {history.map((_, m) => (
          <li key={m}><button className={m === step ? "cur" : ""} onClick={() => setStep(m)}>{m ? "Go to move #" + m : "Go to game start"}</button></li>
        ))}
      </ol>
    </div>
  );
}

const css = document.createElement("style");
css.textContent = `
  .game{display:flex;gap:40px;justify-content:center;margin:30px auto;font:15px system-ui,sans-serif;color:${THEME.fg}}
  h2{margin:0 0 6px;color:${THEME.accent}}.status{margin-bottom:10px;font-weight:600;min-height:22px}
  .board{display:grid;grid-template-columns:repeat(3,84px);gap:6px}
  .sq{height:84px;font-size:40px;font-weight:700;border-radius:12px;border:1px solid ${THEME.muted}88;background:transparent;color:inherit;cursor:pointer}
  .sq:hover{background:${THEME.accent}22}.sq.win{background:${THEME.ok};color:#fff}
  ol{margin:0;padding-left:20px}li button{margin:2px 0;padding:4px 10px;border-radius:8px;border:1px solid ${THEME.muted}66;background:transparent;color:inherit;cursor:pointer}
  li button.cur{background:${THEME.accent};color:#fff;border-color:${THEME.accent}}
`;
document.head.appendChild(css);
ReactDOM.createRoot(document.getElementById("root")).render(<Game />);
