// devportal-app: floorplan
//! Home design planner — draw walls and rooms, drop doors, windows and furniture, read the measurements.
//! `model.rs` holds all the rules (and the tests); this file is the editor: tools, drawing, mouse and keyboard.
//!
//! Tools: V select · W wall · B room · D door · N window · F furniture.  R rotate · Del delete · G snap
//! · M dimensions · L demo apartment · X export SVG (to the Console) · Ctrl+Z / Ctrl+Y undo / redo.
//! Mouse wheel zooms, right/middle-drag pans.
pub mod model;

use dp::{keys, App, Cursor, Gfx, Mods, Pointer, PointerKind, Rgba};
use model::{fmt_len, furn_size, len, snap_p, OpenKind, Plan, Sel, CATALOG, P};

const PANEL_W: f32 = 100.0;
const STATUS_H: f32 = 26.0;
const SNAP: f32 = 0.5;

const BG: Rgba = Rgba::rgb(24, 27, 38);
const PANEL: Rgba = Rgba::rgb(33, 37, 52);
const PANEL_HI: Rgba = Rgba::rgb(58, 66, 96);
const ACCENT: Rgba = Rgba::rgb(255, 196, 61);
const TEXT: Rgba = Rgba::rgb(222, 228, 242);
const DIM: Rgba = Rgba::rgb(135, 145, 170);
const WALL: Rgba = Rgba::rgb(232, 235, 245);
const SELECT: Rgba = Rgba::rgb(80, 170, 255);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Tool { Select, Wall, Room, Door, Window, Furniture }

#[derive(Clone, Copy, PartialEq, Debug)]
enum Act { Tool(Tool), Undo, Redo, Delete, Snap, Dims, Demo, Export, New }

const BUTTONS: [(&str, Act); 14] = [
    ("Select  V", Act::Tool(Tool::Select)), ("Wall  W", Act::Tool(Tool::Wall)), ("Room  B", Act::Tool(Tool::Room)),
    ("Door  D", Act::Tool(Tool::Door)), ("Window  N", Act::Tool(Tool::Window)), ("Furniture  F", Act::Tool(Tool::Furniture)),
    ("Undo", Act::Undo), ("Redo", Act::Redo), ("Delete", Act::Delete),
    ("Snap  G", Act::Snap), ("Dims  M", Act::Dims), ("Demo  L", Act::Demo), ("SVG  X", Act::Export), ("New", Act::New),
];

#[derive(Clone, Debug)]
enum Drag { None, Furn { id: u32, off: P }, Wall { id: u32, last: P }, Opening { id: u32 }, Handle { wall: u32, end: u8 } }

pub struct Planner {
    w: f32, h: f32,
    plan: Plan, undo: Vec<Plan>, redo: Vec<Plan>,
    tool: Tool, kind: usize, rot: u8,
    sel: Sel, drag: Drag, drag_start: Option<Plan>,
    chain: Option<P>, room_start: Option<P>,
    mouse: P, scale: f32, ox: f32, oy: f32,
    snap_on: bool, dims: bool,
    note: String, pending_log: Option<String>,
}

impl Planner {
    pub fn new() -> Self {
        Planner {
            w: 800.0, h: 600.0, plan: Plan::sample(), undo: vec![], redo: vec![],
            tool: Tool::Select, kind: 0, rot: 0, sel: Sel::None, drag: Drag::None, drag_start: None,
            chain: None, room_start: None, mouse: (0.0, 0.0), scale: 20.0, ox: PANEL_W + 30.0, oy: 40.0,
            snap_on: true, dims: true, note: "Demo apartment loaded — pick a tool on the left".into(), pending_log: None,
        }
    }

    // ---------- coordinates ----------
    fn w2s(&self, p: P) -> P { (p.0 * self.scale + self.ox, p.1 * self.scale + self.oy) }
    fn s2w(&self, p: P) -> P { ((p.0 - self.ox) / self.scale, (p.1 - self.oy) / self.scale) }
    fn snapped(&self, p: P) -> P { if self.snap_on { snap_p(p, SNAP) } else { p } }
    fn in_canvas(&self, p: P) -> bool { p.0 >= PANEL_W && p.1 < self.h - STATUS_H }
    fn fit(&mut self) {
        let (cw, ch) = (self.w - PANEL_W - 40.0, self.h - STATUS_H - 60.0);
        self.scale = (cw / 24.0).min(ch / 16.0).clamp(10.0, 40.0);
        self.ox = PANEL_W + 20.0 + (cw - 24.0 * self.scale).max(0.0) / 2.0;
        self.oy = 30.0 + (ch - 16.0 * self.scale).max(0.0) / 2.0;
    }

    // ---------- history ----------
    /// Run an edit; keep an undo snapshot only if it really changed something.
    fn edit(&mut self, f: impl FnOnce(&mut Plan) -> bool) -> bool {
        let before = self.plan.clone();
        let changed = f(&mut self.plan);
        if changed && before != self.plan { self.undo.push(before); self.redo.clear(); if self.undo.len() > 100 { self.undo.remove(0); } true } else { self.plan = before; false }
    }
    fn do_undo(&mut self) { if let Some(p) = self.undo.pop() { self.redo.push(std::mem::replace(&mut self.plan, p)); self.sel = Sel::None; } }
    fn do_redo(&mut self) { if let Some(p) = self.redo.pop() { self.undo.push(std::mem::replace(&mut self.plan, p)); self.sel = Sel::None; } }

    // ---------- actions ----------
    fn set_tool(&mut self, t: Tool) {
        self.tool = t; self.chain = None; self.room_start = None; self.drag = Drag::None;
        if t != Tool::Select { self.sel = Sel::None; }
        self.note = match t {
            Tool::Select => "Click to select · drag to move · drag a wall's end handles · Del removes",
            Tool::Wall => "Click to start a wall, click again to add more · Esc or right-click to stop",
            Tool::Room => "Press, drag and release to draw a rectangular room (4 walls + area)",
            Tool::Door => "Hover a wall and click to place a 3 ft door",
            Tool::Window => "Hover a wall and click to place a 4 ft window",
            Tool::Furniture => "Pick an item, click to place · R rotates",
        }.into();
    }
    fn act(&mut self, a: Act) {
        match a {
            Act::Tool(t) => self.set_tool(t),
            Act::Undo => self.do_undo(),
            Act::Redo => self.do_redo(),
            Act::Delete => { let s = self.sel; if self.edit(|p| p.remove(s)) { self.sel = Sel::None; } }
            Act::Snap => { self.snap_on = !self.snap_on; self.note = format!("Snap to {} ft grid: {}", SNAP, if self.snap_on { "on" } else { "off" }); }
            Act::Dims => { self.dims = !self.dims; }
            Act::Demo => { self.edit(|p| { *p = Plan::sample(); true }); self.sel = Sel::None; self.fit(); self.note = "Demo apartment loaded".into(); }
            Act::New => { self.edit(|p| { *p = Plan::new(); true }); self.sel = Sel::None; self.note = "Empty plan — Ctrl+Z brings it back".into(); }
            Act::Export => {
                self.pending_log = Some(self.plan.export_svg());
                self.note = "SVG written to the Console tab — copy it into a .svg file".into();
            }
        }
    }
    fn rotate(&mut self) {
        match (self.tool, self.sel) {
            (_, Sel::Furn(id)) => { self.edit(|p| { p.rotate_furn(id); true }); }
            (Tool::Furniture, _) => self.rot = (self.rot + 1) % 4,
            _ => {}
        }
    }
    fn tol(&self) -> f32 { (7.0 / self.scale).max(0.25) }

    // ---------- layout ----------
    fn button_rect(i: usize) -> (f32, f32, f32, f32) {
        let gap = if i >= 6 { 12.0 } else { 0.0 };          // a visual break between tools and actions
        (8.0, 10.0 + i as f32 * 31.0 + gap, PANEL_W - 16.0, 27.0)
    }
    fn palette_rect(&self, i: usize) -> (f32, f32, f32, f32) {
        let (col, row) = ((i % 2) as f32, (i / 2) as f32);
        (PANEL_W + 8.0 + col * 108.0, 8.0 + row * 24.0 + 20.0, 104.0, 21.0)
    }
    fn button_at(p: P) -> Option<usize> {
        (0..BUTTONS.len()).find(|&i| { let (x, y, w, h) = Self::button_rect(i); p.0 >= x && p.0 <= x + w && p.1 >= y && p.1 <= y + h })
    }
    fn palette_at(&self, p: P) -> Option<usize> {
        if self.tool != Tool::Furniture { return None; }
        (0..CATALOG.len()).find(|&i| { let (x, y, w, h) = self.palette_rect(i); p.0 >= x && p.0 <= x + w && p.1 >= y && p.1 <= y + h })
    }
    fn over_palette(&self, p: P) -> bool { self.tool == Tool::Furniture && p.0 >= PANEL_W && p.0 <= PANEL_W + 224.0 && p.1 <= 8.0 + 6.0 * 24.0 + 26.0 }

    // ---------- drawing ----------
    fn draw_grid(&self, g: &mut dyn Gfx) {
        let (a, b) = (self.s2w((PANEL_W, 0.0)), self.s2w((self.w, self.h - STATUS_H)));
        let step = if self.scale >= 14.0 { 1.0 } else { 5.0 };
        let mut x = (a.0 / step).floor() * step;
        while x <= b.0 {
            let major = (x / 5.0).round() * 5.0 == x;
            let sx = self.w2s((x, 0.0)).0;
            g.line(sx, 0.0, sx, self.h - STATUS_H, 1.0, Rgba::rgba(255, 255, 255, if major { 26 } else { 10 }));
            x += step;
        }
        let mut y = (a.1 / step).floor() * step;
        while y <= b.1 {
            let major = (y / 5.0).round() * 5.0 == y;
            let sy = self.w2s((0.0, y)).1;
            g.line(PANEL_W, sy, self.w, sy, 1.0, Rgba::rgba(255, 255, 255, if major { 26 } else { 10 }));
            y += step;
        }
    }

    fn draw_plan(&self, g: &mut dyn Gfx) {
        let sc = self.scale;
        for r in &self.plan.rooms {
            let (x, y) = self.w2s((r.x, r.y));
            let hi = self.sel == Sel::Room(r.id);
            g.rect(x, y, r.w * sc, r.h * sc, if hi { Rgba::rgba(80, 170, 255, 40) } else { Rgba::rgba(120, 150, 220, 22) }, true);
            let c = self.w2s((r.x + r.w / 2.0, r.y + r.h / 2.0));
            g.text(&r.name, c.0 - r.name.len() as f32 * 3.4, c.1 - 2.0, 14.0, Rgba::rgba(200, 212, 240, 200));
            g.text(&format!("{:.0} sq ft", r.w * r.h), c.0 - 24.0, c.1 + 15.0, 11.0, Rgba::rgba(160, 175, 210, 190));
        }
        for f in &self.plan.furn {
            let (w, h) = furn_size(f);
            let (x, y) = self.w2s((f.x - w / 2.0, f.y - h / 2.0));
            let (cr, cg, cb) = CATALOG[f.kind].3;
            g.rect(x, y, w * sc, h * sc, Rgba::rgb(cr, cg, cb), true);
            g.rect(x, y, w * sc, h * sc, Rgba::rgba(0, 0, 0, 120), false);
            if w * sc > 46.0 && h * sc > 18.0 { g.text(CATALOG[f.kind].0, x + 4.0, y + 13.0, 10.0, Rgba::rgba(20, 20, 30, 220)); }
            if self.sel == Sel::Furn(f.id) { g.rect(x - 2.0, y - 2.0, w * sc + 4.0, h * sc + 4.0, SELECT, false); }
        }
        let wall_px = (0.5 * sc).max(3.0);
        for w in &self.plan.walls {
            let (a, b) = (self.w2s(w.a), self.w2s(w.b));
            let hi = self.sel == Sel::Wall(w.id);
            g.line(a.0, a.1, b.0, b.1, wall_px, if hi { SELECT } else { WALL });
        }
        for o in &self.plan.openings {
            let Some(w) = self.plan.wall(o.wall) else { continue };
            let l = len(w.a, w.b);
            let (ux, uy) = ((w.b.0 - w.a.0) / l, (w.b.1 - w.a.1) / l);
            let c = (w.a.0 + (w.b.0 - w.a.0) * o.t, w.a.1 + (w.b.1 - w.a.1) * o.t);
            self.draw_opening(g, c, (ux, uy), o.width, o.kind, wall_px, self.sel == Sel::Opening(o.id), false);
        }
        if self.dims {
            for w in &self.plan.walls {
                let (m, l) = (((w.a.0 + w.b.0) / 2.0, (w.a.1 + w.b.1) / 2.0), len(w.a, w.b));
                let (ux, uy) = ((w.b.0 - w.a.0) / l, (w.b.1 - w.a.1) / l);
                let s = self.w2s((m.0 - uy * 0.9, m.1 + ux * 0.9));
                let t = fmt_len(l);
                g.text(&t, s.0 - t.len() as f32 * 2.8, s.1 + 4.0, 11.0, Rgba::rgba(255, 196, 61, 230));
            }
        }
    }

    /// A door (gap + leaf + swing arc) or window (gap + glass lines) centred at `c` on a wall running along `u`.
    #[allow(clippy::too_many_arguments)]
    fn draw_opening(&self, g: &mut dyn Gfx, c: P, u: P, width: f32, kind: OpenKind, wall_px: f32, hi: bool, ghost: bool) {
        let n = (-u.1, u.0);
        let (a, b) = ((c.0 - u.0 * width / 2.0, c.1 - u.1 * width / 2.0), (c.0 + u.0 * width / 2.0, c.1 + u.1 * width / 2.0));
        let (sa, sb) = (self.w2s(a), self.w2s(b));
        let col = if hi { SELECT } else if ghost { Rgba::rgba(255, 196, 61, 230) } else { Rgba::rgb(200, 210, 235) };
        g.line(sa.0, sa.1, sb.0, sb.1, wall_px + 2.0, if ghost { Rgba::rgba(24, 27, 38, 200) } else { BG });
        match kind {
            OpenKind::Door => {
                let tip = self.w2s((a.0 + n.0 * width, a.1 + n.1 * width));
                g.line(sa.0, sa.1, tip.0, tip.1, 2.0, col);
                let arc: Vec<(f32, f32)> = (0..=12).map(|i| {
                    let th = (1.0 - i as f32 / 12.0) * std::f32::consts::FRAC_PI_2;
                    self.w2s((a.0 + width * (th.cos() * u.0 + th.sin() * n.0), a.1 + width * (th.cos() * u.1 + th.sin() * n.1)))
                }).collect();
                g.poly(&arc, col.with_alpha(150), false);
            }
            OpenKind::Window => {
                for off in [-0.12, 0.0, 0.12] {
                    let (p, q) = (self.w2s((a.0 + n.0 * off, a.1 + n.1 * off)), self.w2s((b.0 + n.0 * off, b.1 + n.1 * off)));
                    g.line(p.0, p.1, q.0, q.1, if off == 0.0 { 2.0 } else { 1.5 }, if hi { SELECT } else { Rgba::rgb(126, 200, 227) });
                }
            }
        }
    }

    fn draw_overlays(&self, g: &mut dyn Gfx) {
        // selection handles on a wall
        if let Sel::Wall(id) = self.sel {
            if let Some(w) = self.plan.wall(id) {
                for e in [w.a, w.b] { let s = self.w2s(e); g.circle(s.0, s.1, 6.0, ACCENT, true); g.circle(s.0, s.1, 6.0, Rgba::rgb(20, 20, 30), false); }
            }
        }
        if !self.in_canvas(self.mouse) { return; }
        let wp = self.s2w(self.mouse);
        let sp = self.snapped(wp);
        let sps = self.w2s(sp);
        match self.tool {
            Tool::Wall => {
                if let Some(a) = self.chain {
                    let (sa, l) = (self.w2s(a), len(a, sp));
                    g.line(sa.0, sa.1, sps.0, sps.1, (0.5 * self.scale).max(3.0), Rgba::rgba(255, 196, 61, 150));
                    g.text(&fmt_len(l), (sa.0 + sps.0) / 2.0 + 8.0, (sa.1 + sps.1) / 2.0 - 8.0, 12.0, ACCENT);
                }
                g.circle(sps.0, sps.1, 4.0, ACCENT, true);
            }
            Tool::Room => {
                g.circle(sps.0, sps.1, 4.0, ACCENT, true);
                if let Some(a) = self.room_start {
                    let sa = self.w2s(a);
                    g.rect(sa.0.min(sps.0), sa.1.min(sps.1), (sps.0 - sa.0).abs(), (sps.1 - sa.1).abs(), Rgba::rgba(255, 196, 61, 40), true);
                    g.rect(sa.0.min(sps.0), sa.1.min(sps.1), (sps.0 - sa.0).abs(), (sps.1 - sa.1).abs(), ACCENT, false);
                    let (dw, dh) = ((sp.0 - a.0).abs(), (sp.1 - a.1).abs());
                    g.text(&format!("{} × {}  ({:.0} sq ft)", fmt_len(dw), fmt_len(dh), dw * dh), sps.0 + 10.0, sps.1 - 8.0, 12.0, ACCENT);
                }
            }
            Tool::Door | Tool::Window => {
                let kind = if self.tool == Tool::Door { OpenKind::Door } else { OpenKind::Window };
                if let Some((id, t, _)) = self.plan.nearest_wall(wp, 0.8) {
                    if let Some(w) = self.plan.wall(id) {
                        let l = len(w.a, w.b);
                        let width = if kind == OpenKind::Door { 3.0 } else { 4.0 };
                        if l >= width + 0.2 {
                            let half = width / 2.0 / l;
                            let t = t.clamp(half, 1.0 - half);
                            let c = (w.a.0 + (w.b.0 - w.a.0) * t, w.a.1 + (w.b.1 - w.a.1) * t);
                            self.draw_opening(g, c, ((w.b.0 - w.a.0) / l, (w.b.1 - w.a.1) / l), width, kind, (0.5 * self.scale).max(3.0), false, true);
                        }
                    }
                }
            }
            Tool::Furniture => {
                let ghost = model::Furn { id: 0, kind: self.kind, x: sp.0, y: sp.1, rot: self.rot };
                let (w, h) = furn_size(&ghost);
                let (x, y) = self.w2s((sp.0 - w / 2.0, sp.1 - h / 2.0));
                g.rect(x, y, w * self.scale, h * self.scale, Rgba::rgba(255, 196, 61, 70), true);
                g.rect(x, y, w * self.scale, h * self.scale, ACCENT, false);
                g.text(&format!("{} {} × {}", CATALOG[self.kind].0, fmt_len(w), fmt_len(h)), x, y - 6.0, 11.0, ACCENT);
            }
            Tool::Select => {}
        }
    }

    fn draw_ui(&self, g: &mut dyn Gfx) {
        // left panel
        g.rect(0.0, 0.0, PANEL_W, self.h, PANEL, true);
        g.line(PANEL_W, 0.0, PANEL_W, self.h, 1.0, Rgba::rgba(255, 255, 255, 25));
        for (i, (label, act)) in BUTTONS.iter().enumerate() {
            let (x, y, w, h) = Self::button_rect(i);
            let active = matches!(act, Act::Tool(t) if *t == self.tool) || (*act == Act::Snap && self.snap_on) || (*act == Act::Dims && self.dims);
            let hot = Self::button_at(self.mouse) == Some(i);
            let off = (*act == Act::Undo && self.undo.is_empty()) || (*act == Act::Redo && self.redo.is_empty()) || (*act == Act::Delete && self.sel == Sel::None);
            g.rect(x, y, w, h, if active { Rgba::rgb(70, 95, 160) } else if hot { PANEL_HI } else { Rgba::rgb(42, 47, 66) }, true);
            if active { g.rect(x, y, 3.0, h, ACCENT, true); }
            g.text(label, x + 9.0, y + 18.0, 12.0, if off { Rgba::rgba(222, 228, 242, 90) } else { TEXT });
        }
        // furniture palette
        if self.tool == Tool::Furniture {
            g.rect(PANEL_W + 4.0, 6.0, 224.0, 6.0 * 24.0 + 40.0, Rgba::rgba(33, 37, 52, 238), true);
            g.text("Furniture", PANEL_W + 12.0, 22.0, 12.0, DIM);
            for (i, c) in CATALOG.iter().enumerate() {
                let (x, y, w, h) = self.palette_rect(i);
                g.rect(x, y, w, h, if i == self.kind { Rgba::rgb(70, 95, 160) } else { Rgba::rgb(42, 47, 66) }, true);
                g.rect(x + 4.0, y + 5.0, 10.0, 10.0, Rgba::rgb(c.3 .0, c.3 .1, c.3 .2), true);
                g.text(c.0, x + 20.0, y + 15.0, 11.0, TEXT);
            }
        }
        // status bar
        g.rect(PANEL_W, self.h - STATUS_H, self.w - PANEL_W, STATUS_H, PANEL, true);
        let info = match self.sel {
            Sel::Wall(id) => self.plan.wall(id).map(|w| format!("Wall {}", fmt_len(len(w.a, w.b)))).unwrap_or_default(),
            Sel::Furn(id) => self.plan.furn.iter().find(|f| f.id == id).map(|f| { let (w, h) = furn_size(f); format!("{} {} × {}", CATALOG[f.kind].0, fmt_len(w), fmt_len(h)) }).unwrap_or_default(),
            Sel::Room(id) => self.plan.rooms.iter().find(|r| r.id == id).map(|r| format!("{} {} × {} = {:.0} sq ft", r.name, fmt_len(r.w), fmt_len(r.h), r.w * r.h)).unwrap_or_default(),
            Sel::Opening(id) => self.plan.openings.iter().find(|o| o.id == id).map(|o| format!("{} {}", if o.kind == OpenKind::Door { "Door" } else { "Window" }, fmt_len(o.width))).unwrap_or_default(),
            Sel::None => String::new(),
        };
        let left = if info.is_empty() { self.note.clone() } else { info };
        g.text(&left, PANEL_W + 10.0, self.h - 9.0, 12.0, TEXT);
        let total = format!("{:.0} sq ft · {} walls", self.plan.total_room_area(), self.plan.walls.len());
        g.text(&total, self.w - total.len() as f32 * 6.3 - 10.0, self.h - 9.0, 12.0, DIM);
    }
}

impl Default for Planner { fn default() -> Self { Self::new() } }

impl App for Planner {
    fn init(&mut self, w: f32, h: f32) { self.w = w; self.h = h; self.fit(); }
    fn resize(&mut self, w: f32, h: f32) { self.w = w; self.h = h; }

    fn frame(&mut self, g: &mut dyn Gfx, _t_ms: f64) {
        g.clear(BG);
        self.draw_grid(g);
        self.draw_plan(g);
        self.draw_overlays(g);
        self.draw_ui(g);
        if let Some(svg) = self.pending_log.take() { g.log(&svg); }
        g.cursor(if Self::button_at(self.mouse).is_some() { Cursor::Pointer } else if self.tool == Tool::Select { Cursor::Default } else { Cursor::Crosshair });
    }

    fn pointer(&mut self, p: Pointer) {
        let prev = self.mouse;
        self.mouse = (p.x, p.y);
        let here = (p.x, p.y);
        if p.kind == PointerKind::Wheel {
            if self.in_canvas(here) {
                let before = self.s2w(here);
                self.scale = (self.scale * 1.0015f32.powf(-p.delta)).clamp(8.0, 90.0);
                self.ox = here.0 - before.0 * self.scale;
                self.oy = here.1 - before.1 * self.scale;
            }
            return;
        }
        if p.kind == PointerKind::Move && p.buttons & 6 != 0 {      // right / middle drag = pan
            self.ox += here.0 - prev.0; self.oy += here.1 - prev.1;
            return;
        }
        let wp = self.s2w(here);
        let sp = self.snapped(wp);
        match p.kind {
            PointerKind::Down if p.buttons & 2 != 0 => {              // right click: finish a wall chain / cancel
                self.chain = None; self.room_start = None;
            }
            PointerKind::Down if p.buttons & 1 != 0 => {
                if here.0 < PANEL_W {
                    if let Some(i) = Self::button_at(here) { self.act(BUTTONS[i].1); }
                } else if let Some(i) = self.palette_at(here) {
                    self.kind = i;
                } else if self.over_palette(here) || !self.in_canvas(here) {
                    // click on the palette frame or status bar: ignore
                } else {
                    self.canvas_down(wp, sp);
                }
            }
            PointerKind::Move => self.canvas_move(wp, sp),
            PointerKind::Up => self.canvas_up(sp),
            _ => {}
        }
    }

    fn key(&mut self, code: u32, down: bool, mods: Mods) {
        if !down { return; }
        if mods.ctrl() || mods.meta() {
            match code {
                x if x == keys::letter('z') => { if mods.shift() { self.do_redo() } else { self.do_undo() } }
                x if x == keys::letter('y') => self.do_redo(),
                _ => {}
            }
            return;
        }
        match code {
            x if x == keys::letter('v') => self.set_tool(Tool::Select),
            x if x == keys::letter('w') => self.set_tool(Tool::Wall),
            x if x == keys::letter('b') => self.set_tool(Tool::Room),
            x if x == keys::letter('d') => self.set_tool(Tool::Door),
            x if x == keys::letter('n') => self.set_tool(Tool::Window),
            x if x == keys::letter('f') => self.set_tool(Tool::Furniture),
            x if x == keys::letter('r') => self.rotate(),
            x if x == keys::letter('g') => self.act(Act::Snap),
            x if x == keys::letter('m') => self.act(Act::Dims),
            x if x == keys::letter('l') => self.act(Act::Demo),
            x if x == keys::letter('x') => self.act(Act::Export),
            keys::DELETE | keys::BACKSPACE => self.act(Act::Delete),
            keys::ESCAPE => { self.chain = None; self.room_start = None; self.drag = Drag::None; self.sel = Sel::None; }
            keys::LEFT | keys::RIGHT | keys::UP | keys::DOWN => {
                let step = if mods.shift() { 5.0 } else { SNAP };
                let (dx, dy) = match code { keys::LEFT => (-step, 0.0), keys::RIGHT => (step, 0.0), keys::UP => (0.0, -step), _ => (0.0, step) };
                let s = self.sel;
                self.edit(|p| { p.nudge(s, dx, dy); s != Sel::None });
            }
            _ => {}
        }
    }
}

impl Planner {
    fn canvas_down(&mut self, wp: P, sp: P) {
        match self.tool {
            Tool::Select => {
                // wall end handles win over everything else
                if let Sel::Wall(id) = self.sel {
                    if let Some(w) = self.plan.wall(id) {
                        let r = 9.0 / self.scale;
                        let end = if len(wp, w.a) <= r { Some(0) } else if len(wp, w.b) <= r { Some(1) } else { None };
                        if let Some(end) = end { self.drag_start = Some(self.plan.clone()); self.drag = Drag::Handle { wall: id, end }; return; }
                    }
                }
                self.sel = self.plan.hit_test(wp, self.tol());
                self.drag_start = Some(self.plan.clone());
                self.drag = match self.sel {
                    Sel::Furn(id) => { let f = self.plan.furn.iter().find(|f| f.id == id).unwrap(); Drag::Furn { id, off: (f.x - wp.0, f.y - wp.1) } }
                    Sel::Wall(id) => Drag::Wall { id, last: sp },
                    Sel::Opening(id) => Drag::Opening { id },
                    _ => Drag::None,
                };
            }
            Tool::Wall => match self.chain {
                None => self.chain = Some(sp),
                Some(a) => { if self.edit(|p| p.add_wall(a, sp).is_some()) { self.chain = Some(sp); } }
            },
            Tool::Room => self.room_start = Some(sp),
            Tool::Door | Tool::Window => {
                let kind = if self.tool == Tool::Door { OpenKind::Door } else { OpenKind::Window };
                if !self.edit(|p| p.add_opening(kind, wp).is_some()) { self.note = "Click right on a wall that is long enough for it".into(); }
            }
            Tool::Furniture => {
                let (k, r) = (self.kind, self.rot);
                self.edit(|p| { p.add_furn(k, sp.0, sp.1, r); true });
            }
        }
    }

    fn canvas_move(&mut self, wp: P, sp: P) {
        match self.drag.clone() {
            Drag::Furn { id, off } => {
                let t = self.snapped((wp.0 + off.0, wp.1 + off.1));
                if let Some(f) = self.plan.furn.iter_mut().find(|f| f.id == id) { f.x = t.0; f.y = t.1; }
            }
            Drag::Wall { id, last } => {
                let (dx, dy) = (sp.0 - last.0, sp.1 - last.1);
                if dx != 0.0 || dy != 0.0 { self.plan.nudge(Sel::Wall(id), dx, dy); self.drag = Drag::Wall { id, last: sp }; }
            }
            Drag::Opening { id } => self.plan.set_opening_at(id, wp),
            Drag::Handle { wall, end } => { self.plan.set_wall_end(wall, end, sp); }
            Drag::None => {}
        }
    }

    fn canvas_up(&mut self, sp: P) {
        if let Some(start) = self.drag_start.take() {
            if start != self.plan { self.undo.push(start); self.redo.clear(); }
        }
        self.drag = Drag::None;
        if let Some(a) = self.room_start.take() {
            if self.tool == Tool::Room && !self.edit(|p| p.add_room(a, sp).is_some()) { self.note = "Drag a rectangle at least 1 ft each way".into(); }
        }
    }
}

dp::dp_app!(Planner::new());

#[cfg(test)]
mod tests {
    use super::*;
    use dp::recorder::Recorder;

    fn app() -> Planner { let mut a = Planner::new(); a.init(900.0, 640.0); a }
    fn click(a: &mut Planner, x: f32, y: f32) {
        a.pointer(Pointer { kind: PointerKind::Move, x, y, buttons: 0, delta: 0.0 });
        a.pointer(Pointer { kind: PointerKind::Down, x, y, buttons: 1, delta: 0.0 });
        a.pointer(Pointer { kind: PointerKind::Up, x, y, buttons: 0, delta: 0.0 });
    }
    /// screen position of a world point in the current view
    fn at(a: &Planner, x: f32, y: f32) -> (f32, f32) { a.w2s((x, y)) }
    fn press(a: &mut Planner, c: u32) { a.key(c, true, Mods(0)); }

    #[test]
    fn every_toolbar_button_is_clickable_and_in_the_panel() {
        let mut a = app();
        for (i, (_, act)) in BUTTONS.iter().enumerate() {
            let (x, y, w, h) = Planner::button_rect(i);
            assert!(x + w <= PANEL_W && y + h <= 640.0, "button {i} outside the panel");
            assert_eq!(Planner::button_at((x + 2.0, y + 2.0)), Some(i));
            let _ = act;
        }
        let (x, y, _, _) = Planner::button_rect(1);
        click(&mut a, x + 5.0, y + 5.0);
        assert_eq!(a.tool, Tool::Wall);
    }

    #[test]
    fn drawing_a_room_with_the_mouse_adds_four_walls_and_undo_removes_them() {
        let mut a = app(); a.act(Act::New);
        press(&mut a, keys::letter('b'));
        let (x0, y0) = at(&a, 2.0, 2.0); let (x1, y1) = at(&a, 12.0, 9.0);
        a.pointer(Pointer { kind: PointerKind::Move, x: x0, y: y0, buttons: 0, delta: 0.0 });
        a.pointer(Pointer { kind: PointerKind::Down, x: x0, y: y0, buttons: 1, delta: 0.0 });
        a.pointer(Pointer { kind: PointerKind::Move, x: x1, y: y1, buttons: 1, delta: 0.0 });
        a.pointer(Pointer { kind: PointerKind::Up, x: x1, y: y1, buttons: 0, delta: 0.0 });
        assert_eq!((a.plan.walls.len(), a.plan.rooms.len()), (4, 1));
        assert!((a.plan.total_room_area() - 70.0).abs() < 1e-3);
        a.key(keys::letter('z'), true, Mods(2));
        assert_eq!(a.plan.walls.len(), 0, "ctrl+z undoes the whole room");
        a.key(keys::letter('y'), true, Mods(2));
        assert_eq!(a.plan.walls.len(), 4, "ctrl+y brings it back");
    }

    #[test]
    fn wall_tool_chains_segments_and_escape_stops() {
        let mut a = app(); a.act(Act::New);
        press(&mut a, keys::letter('w'));
        let p = [(1.0, 1.0), (8.0, 1.0), (8.0, 6.0)];
        for (x, y) in p { let (sx, sy) = at(&a, x, y); click(&mut a, sx, sy); }
        assert_eq!(a.plan.walls.len(), 2, "three clicks = two chained walls");
        press(&mut a, keys::ESCAPE);
        assert!(a.chain.is_none());
        let (sx, sy) = at(&a, 12.0, 12.0); click(&mut a, sx, sy);
        assert_eq!(a.plan.walls.len(), 2, "first click after Esc only starts a new chain");
    }

    #[test]
    fn doors_need_a_wall_and_land_on_it() {
        let mut a = app(); a.act(Act::New);
        a.plan.add_wall((0.0, 0.0), (10.0, 0.0));
        press(&mut a, keys::letter('d'));
        let (sx, sy) = at(&a, 5.0, 5.0); click(&mut a, sx, sy);
        assert!(a.plan.openings.is_empty() && a.note.contains("wall"));
        let (sx, sy) = at(&a, 5.0, 0.1); click(&mut a, sx, sy);
        assert_eq!(a.plan.openings.len(), 1);
    }

    #[test]
    fn select_drag_moves_furniture_and_delete_removes_it() {
        let mut a = app();
        let f = a.plan.furn.iter().find(|f| CATALOG[f.kind].0 == "Sofa").unwrap().clone();
        let (sx, sy) = at(&a, f.x, f.y);
        a.pointer(Pointer { kind: PointerKind::Move, x: sx, y: sy, buttons: 0, delta: 0.0 });
        a.pointer(Pointer { kind: PointerKind::Down, x: sx, y: sy, buttons: 1, delta: 0.0 });
        assert_eq!(a.sel, Sel::Furn(f.id));
        let (tx, ty) = at(&a, f.x + 2.0, f.y - 1.0);
        a.pointer(Pointer { kind: PointerKind::Move, x: tx, y: ty, buttons: 1, delta: 0.0 });
        a.pointer(Pointer { kind: PointerKind::Up, x: tx, y: ty, buttons: 0, delta: 0.0 });
        let moved = a.plan.furn.iter().find(|g| g.id == f.id).unwrap();
        assert!((moved.x - (f.x + 2.0)).abs() <= SNAP && (moved.y - (f.y - 1.0)).abs() <= SNAP, "moved to {:?}", (moved.x, moved.y));
        let n = a.plan.furn.len();
        press(&mut a, keys::DELETE);
        assert_eq!(a.plan.furn.len(), n - 1);
        a.do_undo(); a.do_undo();
        assert_eq!(a.plan.furn.iter().find(|g| g.id == f.id).unwrap().x, f.x, "two undos: restore + move back");
    }

    #[test]
    fn a_click_without_moving_leaves_no_undo_entry() {
        let mut a = app();
        let before = a.undo.len();
        let (sx, sy) = at(&a, 7.0, 8.5); click(&mut a, sx, sy);   // the rug
        assert_eq!(a.undo.len(), before);
    }

    #[test]
    fn zoom_keeps_the_point_under_the_cursor_fixed() {
        let mut a = app();
        let (x, y) = (400.0, 300.0);
        let (w0, s0) = (a.s2w((x, y)), a.scale);
        a.pointer(Pointer { kind: PointerKind::Wheel, x, y, buttons: 0, delta: -300.0 });
        let w1 = a.s2w((x, y));
        assert!((w0.0 - w1.0).abs() < 1e-3 && (w0.1 - w1.1).abs() < 1e-3);
        assert!(a.scale > s0, "wheel up zooms in");
    }

    #[test]
    fn frame_draws_panel_plan_and_dimensions_and_export_logs_svg() {
        let mut a = app();
        let mut r = Recorder::new();
        a.frame(&mut r, 0.0);
        let t = r.texts();
        assert!(t.iter().any(|s| s.contains("Living")) && t.iter().any(|s| s.contains("Select")));
        assert!(t.iter().any(|s| s.contains("24'")), "outer wall length label");
        press(&mut a, keys::letter('x'));
        let mut r2 = Recorder::new();
        a.frame(&mut r2, 16.0);
        assert!(r2.cmds.iter().any(|c| matches!(c, dp::recorder::Cmd::Log(s) if s.starts_with("<svg"))));
    }

    #[test]
    fn furniture_tool_places_the_selected_item_rotated() {
        let mut a = app(); a.act(Act::New);
        press(&mut a, keys::letter('f'));
        let (x, y, _, _) = a.palette_rect(0);
        click(&mut a, x + 4.0, y + 4.0);               // pick "Bed"
        assert_eq!(a.kind, 0);
        press(&mut a, keys::letter('r'));
        let (sx, sy) = at(&a, 10.0, 10.0); click(&mut a, sx, sy);
        assert_eq!(a.plan.furn.len(), 1);
        assert_eq!(a.plan.furn[0].rot, 1);
    }
}
