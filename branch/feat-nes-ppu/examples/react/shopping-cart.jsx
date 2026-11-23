// @react — useReducer + useMemo: a tiny shop with a cart.

const PRODUCTS = [
  { id: "kb", name: "Mechanical keyboard", price: 129, emoji: "⌨️" },
  { id: "ms", name: "Ergonomic mouse", price: 79, emoji: "🖱️" },
  { id: "mo", name: "4K monitor", price: 389, emoji: "🖥️" },
  { id: "hp", name: "Noise-cancelling headphones", price: 249, emoji: "🎧" },
  { id: "dk", name: "Standing desk", price: 549, emoji: "🪑" },
  { id: "cf", name: "Coffee for the team", price: 24, emoji: "☕" },
];

function cartReducer(state, action) {
  switch (action.type) {
    case "add": return { ...state, [action.id]: (state[action.id] || 0) + 1 };
    case "dec": {
      const q = (state[action.id] || 0) - 1;
      const next = { ...state };
      if (q <= 0) delete next[action.id]; else next[action.id] = q;
      return next;
    }
    case "clear": return {};
    default: throw new Error("unknown action " + action.type);
  }
}

function App() {
  const [cart, dispatch] = useReducer(cartReducer, {});
  const [promo, setPromo] = useState("");
  const lines = useMemo(() => PRODUCTS.filter(p => cart[p.id]).map(p => ({ ...p, qty: cart[p.id] })), [cart]);
  const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const discount = promo.toUpperCase() === "DEV10" ? subtotal * 0.1 : 0;
  const total = subtotal - discount;
  useEffect(() => { console.log("cart changed:", JSON.stringify(cart)); }, [cart]);

  return (
    <div className="shop">
      <section>
        <h2>🛍️ DevShop</h2>
        <div className="products">
          {PRODUCTS.map(p => (
            <div className="prod" key={p.id}>
              <div className="em">{p.emoji}</div>
              <div className="nm">{p.name}</div>
              <div className="pr">${p.price}</div>
              <button className="p" onClick={() => dispatch({ type: "add", id: p.id })}>Add to cart</button>
            </div>
          ))}
        </div>
      </section>
      <aside>
        <h3>Cart {lines.length ? <button onClick={() => dispatch({ type: "clear" })}>clear</button> : null}</h3>
        {lines.length === 0 && <p className="mut">Your cart is empty.</p>}
        {lines.map(l => (
          <div className="line" key={l.id}>
            <span>{l.emoji} {l.name}</span>
            <span className="qty">
              <button onClick={() => dispatch({ type: "dec", id: l.id })}>−</button> {l.qty}
              <button onClick={() => dispatch({ type: "add", id: l.id })}>+</button>
            </span>
            <b>${l.price * l.qty}</b>
          </div>
        ))}
        <input placeholder="Promo code (try DEV10)" value={promo} onChange={e => setPromo(e.target.value)} />
        <div className="sum"><span>Subtotal</span><span>${subtotal.toFixed(2)}</span></div>
        {discount > 0 && <div className="sum ok"><span>Promo DEV10</span><span>−${discount.toFixed(2)}</span></div>}
        <div className="sum tot"><span>Total</span><span>${total.toFixed(2)}</span></div>
        <button className="p full" disabled={!lines.length} onClick={() => { console.log("checkout", total); dispatch({ type: "clear" }); }}>Checkout</button>
      </aside>
    </div>
  );
}

const st = document.createElement("style");
st.textContent = `
  .shop{display:grid;grid-template-columns:1fr 300px;gap:20px;max-width:980px;margin:20px auto;padding:0 16px;font:14px system-ui,sans-serif;color:${THEME.fg}}
  @media(max-width:720px){.shop{grid-template-columns:1fr}}
  h2{margin:0 0 12px;color:${THEME.accent}} h3{display:flex;justify-content:space-between;margin:0 0 10px}
  .products{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px}
  .prod{padding:14px;border:1px solid ${THEME.muted}55;border-radius:14px;text-align:center}
  .em{font-size:38px}.nm{margin:6px 0;min-height:36px}.pr{font-weight:700;margin-bottom:8px}
  aside{padding:16px;border:1px solid ${THEME.muted}55;border-radius:14px;align-self:start;position:sticky;top:12px;background:${THEME.bg}}
  .line{display:grid;grid-template-columns:1fr auto auto;gap:8px;padding:6px 0;border-bottom:1px solid ${THEME.muted}33;align-items:center}
  .qty button{padding:0 7px}.mut{color:${THEME.muted}}
  .sum{display:flex;justify-content:space-between;padding:4px 0}.sum.ok{color:${THEME.ok}}.tot{font-size:18px;font-weight:700;border-top:1px solid ${THEME.muted}55;margin-top:6px;padding-top:8px}
  input{width:100%;box-sizing:border-box;margin:10px 0;padding:8px;border-radius:8px;border:1px solid ${THEME.muted}88;background:transparent;color:inherit}
  button{padding:6px 11px;border-radius:8px;border:1px solid ${THEME.muted}88;background:transparent;color:inherit;cursor:pointer}
  button.p{background:${THEME.accent};border-color:${THEME.accent};color:#fff}button.full{width:100%;margin-top:8px;padding:10px}button:disabled{opacity:.4}
`;
document.head.appendChild(st);
ReactDOM.createRoot(document.getElementById("root")).render(<App />);
