// @react — a searchable, sortable data table (useMemo for derived data, controlled inputs, custom hook).

const DATA = [
  ["Python", "Guido van Rossum", 1991, 28.1], ["JavaScript", "Brendan Eich", 1995, 17.5], ["Java", "James Gosling", 1995, 12.4],
  ["C++", "Bjarne Stroustrup", 1985, 10.3], ["C", "Dennis Ritchie", 1972, 9.5], ["TypeScript", "Anders Hejlsberg", 2012, 6.2],
  ["Rust", "Graydon Hoare", 2010, 3.1], ["Go", "Griesemer, Pike, Thompson", 2009, 2.7], ["Ruby", "Yukihiro Matsumoto", 1995, 1.9],
  ["Swift", "Chris Lattner", 2014, 1.6], ["Kotlin", "JetBrains", 2011, 1.4], ["Bash", "Brian Fox", 1989, 1.1],
].map(([name, creator, year, share]) => ({ name, creator, year, share }));

function useDebounced(value, ms) {                      // a custom hook
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

function App() {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState({ key: "share", dir: -1 });
  const query = useDebounced(q, 150);
  const rows = useMemo(() => {
    const f = DATA.filter(r => (r.name + r.creator).toLowerCase().includes(query.toLowerCase()));
    return f.sort((a, b) => (a[sort.key] > b[sort.key] ? 1 : -1) * sort.dir);
  }, [query, sort]);
  const max = Math.max(...DATA.map(r => r.share));
  const head = (key, label) => (
    <th onClick={() => setSort(s => ({ key, dir: s.key === key ? -s.dir : 1 }))}>
      {label} {sort.key === key ? (sort.dir > 0 ? "▲" : "▼") : ""}
    </th>
  );
  return (
    <div className="ex">
      <h2>Language explorer <small>{rows.length} of {DATA.length}</small></h2>
      <input autoFocus placeholder="Search name or creator…" value={q} onChange={e => setQ(e.target.value)} />
      <table>
        <thead><tr>{head("name", "Language")}{head("creator", "Creator")}{head("year", "Year")}{head("share", "Share")}</tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.name}>
              <td><b>{r.name}</b></td><td>{r.creator}</td><td>{r.year}</td>
              <td><div className="bar"><i style={{ width: (r.share / max * 100) + "%" }} /></div> {r.share}%</td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan="4" className="none">No matches 🤷</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

const s = document.createElement("style");
s.textContent = `
  .ex{max-width:760px;margin:24px auto;padding:0 16px;font:14px system-ui,sans-serif;color:${THEME.fg}}
  h2{color:${THEME.accent};margin:0 0 10px}h2 small{color:${THEME.muted};font-weight:400;font-size:13px}
  input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid ${THEME.muted}88;background:transparent;color:inherit;margin-bottom:12px}
  table{width:100%;border-collapse:collapse}th{text-align:left;cursor:pointer;color:${THEME.muted};padding:8px;border-bottom:1px solid ${THEME.muted}66;user-select:none}
  th:hover{color:${THEME.fg}}td{padding:8px;border-bottom:1px solid ${THEME.muted}22}.none{text-align:center;color:${THEME.muted}}
  .bar{display:inline-block;width:90px;height:8px;border-radius:99px;background:${THEME.muted}33;vertical-align:middle;margin-right:6px}
  .bar i{display:block;height:100%;border-radius:99px;background:${THEME.accent}}
`;
document.head.appendChild(s);
ReactDOM.createRoot(document.getElementById("root")).render(<App />);
