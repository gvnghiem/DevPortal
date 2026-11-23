//! The floor-plan data model and every rule about it (snapping, hit testing, areas, export).
//! Pure Rust with no drawing: that is what makes it testable with plain `cargo test`.
//! Units are feet; y grows downwards (screen convention).

pub type P = (f32, f32);

#[derive(Clone, Debug, PartialEq)]
pub struct Wall { pub id: u32, pub a: P, pub b: P }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenKind { Door, Window }

/// A door/window sits on a wall: `t` is the centre as a fraction (0..1) of the wall length.
#[derive(Clone, Debug, PartialEq)]
pub struct Opening { pub id: u32, pub wall: u32, pub t: f32, pub width: f32, pub kind: OpenKind }

/// Furniture rectangle centred on (x, y); `rot` is quarter turns.
#[derive(Clone, Debug, PartialEq)]
pub struct Furn { pub id: u32, pub kind: usize, pub x: f32, pub y: f32, pub rot: u8 }

#[derive(Clone, Debug, PartialEq)]
pub struct Room { pub id: u32, pub name: String, pub x: f32, pub y: f32, pub w: f32, pub h: f32 }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sel { None, Wall(u32), Opening(u32), Furn(u32), Room(u32) }

/// name, width (ft), depth (ft), colour
pub type Item = (&'static str, f32, f32, (u8, u8, u8));
pub const CATALOG: [Item; 12] = [
    ("Bed", 5.0, 6.7, (110, 130, 200)),
    ("Sofa", 7.0, 3.0, (150, 110, 170)),
    ("Dining table", 5.0, 3.0, (190, 150, 100)),
    ("Chair", 1.6, 1.6, (170, 130, 90)),
    ("Desk", 5.0, 2.5, (160, 140, 110)),
    ("Wardrobe", 4.0, 2.0, (130, 110, 90)),
    ("Toilet", 1.5, 2.3, (200, 205, 215)),
    ("Sink", 2.0, 1.7, (200, 205, 215)),
    ("Bathtub", 5.0, 2.5, (190, 215, 225)),
    ("Stove", 2.5, 2.2, (120, 120, 130)),
    ("Fridge", 3.0, 2.5, (170, 180, 190)),
    ("Rug", 6.0, 4.0, (200, 120, 110)),
];

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Plan { pub walls: Vec<Wall>, pub openings: Vec<Opening>, pub furn: Vec<Furn>, pub rooms: Vec<Room>, next_id: u32 }

pub fn snap(v: f32, step: f32) -> f32 { if step <= 0.0 { v } else { (v / step).round() * step } }
pub fn snap_p(p: P, step: f32) -> P { (snap(p.0, step), snap(p.1, step)) }
pub fn len(a: P, b: P) -> f32 { ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt() }

/// distance from `p` to segment a-b, and the projection parameter t in 0..1
pub fn dist_to_segment(p: P, a: P, b: P) -> (f32, f32) {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let l2 = dx * dx + dy * dy;
    if l2 < 1e-9 { return (len(p, a), 0.0); }
    let t = (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / l2).clamp(0.0, 1.0);
    (len(p, (a.0 + t * dx, a.1 + t * dy)), t)
}

/// feet -> 12' 6"   (nearest inch)
pub fn fmt_len(ft: f32) -> String {
    let total = (ft.abs() * 12.0).round() as i32;
    let (f, i) = (total / 12, total % 12);
    if i == 0 { format!("{f}'") } else if f == 0 { format!("{i}\"") } else { format!("{f}' {i}\"") }
}

pub fn furn_size(f: &Furn) -> (f32, f32) {
    let (_, w, h, _) = CATALOG[f.kind.min(CATALOG.len() - 1)];
    if f.rot & 1 == 0 { (w, h) } else { (h, w) }
}

pub fn furn_corners(f: &Furn) -> [P; 4] {
    let (w, h) = furn_size(f);
    [(f.x - w / 2.0, f.y - h / 2.0), (f.x + w / 2.0, f.y - h / 2.0), (f.x + w / 2.0, f.y + h / 2.0), (f.x - w / 2.0, f.y + h / 2.0)]
}

impl Plan {
    pub fn new() -> Self { Plan::default() }
    fn id(&mut self) -> u32 { self.next_id += 1; self.next_id }

    pub fn wall(&self, id: u32) -> Option<&Wall> { self.walls.iter().find(|w| w.id == id) }

    /// Add a wall; an identical wall (same endpoints, either direction) is reused; too short is rejected.
    pub fn add_wall(&mut self, a: P, b: P) -> Option<u32> {
        if len(a, b) < 0.25 { return None; }
        if let Some(w) = self.walls.iter().find(|w| (w.a == a && w.b == b) || (w.a == b && w.b == a)) { return Some(w.id); }
        let id = self.id();
        self.walls.push(Wall { id, a, b });
        Some(id)
    }

    /// An axis-aligned room: four walls plus a labelled area. Returns None when smaller than 1 ft.
    pub fn add_room(&mut self, p0: P, p1: P) -> Option<u32> {
        let (x0, x1) = (p0.0.min(p1.0), p0.0.max(p1.0));
        let (y0, y1) = (p0.1.min(p1.1), p0.1.max(p1.1));
        if x1 - x0 < 1.0 || y1 - y0 < 1.0 { return None; }
        for (a, b) in [((x0, y0), (x1, y0)), ((x1, y0), (x1, y1)), ((x1, y1), (x0, y1)), ((x0, y1), (x0, y0))] { self.add_wall(a, b); }
        let id = self.id();
        let name = format!("Room {}", self.rooms.len() + 1);
        self.rooms.push(Room { id, name, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
        Some(id)
    }

    pub fn nearest_wall(&self, p: P, max_d: f32) -> Option<(u32, f32, f32)> {
        self.walls.iter()
            .map(|w| { let (d, t) = dist_to_segment(p, w.a, w.b); (w.id, t, d) })
            .filter(|&(_, _, d)| d <= max_d)
            .min_by(|a, b| a.2.partial_cmp(&b.2).unwrap())
    }

    /// Put a door/window on the wall nearest to `p` (within 0.8 ft). The opening is kept fully inside the wall.
    pub fn add_opening(&mut self, kind: OpenKind, p: P) -> Option<u32> {
        let (wall, t, _) = self.nearest_wall(p, 0.8)?;
        let l = { let w = self.wall(wall)?; len(w.a, w.b) };
        let width = if kind == OpenKind::Door { 3.0 } else { 4.0 };
        if l < width + 0.2 { return None; }
        let half = width / 2.0 / l;
        let id = self.id();
        self.openings.push(Opening { id, wall, t: t.clamp(half, 1.0 - half), width, kind });
        Some(id)
    }

    pub fn add_furn(&mut self, kind: usize, x: f32, y: f32, rot: u8) -> u32 {
        let id = self.id();
        self.furn.push(Furn { id, kind: kind.min(CATALOG.len() - 1), x, y, rot: rot % 4 });
        id
    }

    pub fn remove(&mut self, s: Sel) -> bool {
        let before = (self.walls.len(), self.openings.len(), self.furn.len(), self.rooms.len());
        match s {
            Sel::Wall(id) => { self.walls.retain(|w| w.id != id); self.openings.retain(|o| o.wall != id); }
            Sel::Opening(id) => self.openings.retain(|o| o.id != id),
            Sel::Furn(id) => self.furn.retain(|f| f.id != id),
            Sel::Room(id) => self.rooms.retain(|r| r.id != id),
            Sel::None => {}
        }
        before != (self.walls.len(), self.openings.len(), self.furn.len(), self.rooms.len())
    }

    /// Topmost thing under `p` (furniture, then openings, walls, rooms). `tol` is in feet.
    pub fn hit_test(&self, p: P, tol: f32) -> Sel {
        for f in self.furn.iter().rev() {
            let (w, h) = furn_size(f);
            if (p.0 - f.x).abs() <= w / 2.0 && (p.1 - f.y).abs() <= h / 2.0 { return Sel::Furn(f.id); }
        }
        for o in self.openings.iter().rev() {
            if let Some(w) = self.wall(o.wall) {
                let c = (w.a.0 + (w.b.0 - w.a.0) * o.t, w.a.1 + (w.b.1 - w.a.1) * o.t);
                if len(p, c) <= o.width / 2.0 + tol * 0.5 { return Sel::Opening(o.id); }
            }
        }
        let mut best: Option<(u32, f32)> = None;
        for w in &self.walls {
            let (d, _) = dist_to_segment(p, w.a, w.b);
            if d <= tol && !best.is_some_and(|b| b.1 <= d) { best = Some((w.id, d)); }
        }
        if let Some((id, _)) = best { return Sel::Wall(id); }
        for r in self.rooms.iter().rev() {
            if p.0 >= r.x && p.0 <= r.x + r.w && p.1 >= r.y && p.1 <= r.y + r.h { return Sel::Room(r.id); }
        }
        Sel::None
    }

    /// Move the selection by (dx, dy). Openings slide along their wall instead; rooms are labels and stay put.
    pub fn nudge(&mut self, s: Sel, dx: f32, dy: f32) {
        match s {
            Sel::Furn(id) => if let Some(f) = self.furn.iter_mut().find(|f| f.id == id) { f.x += dx; f.y += dy; },
            Sel::Wall(id) => if let Some(w) = self.walls.iter_mut().find(|w| w.id == id) {
                w.a = (w.a.0 + dx, w.a.1 + dy); w.b = (w.b.0 + dx, w.b.1 + dy);
            },
            Sel::Opening(id) => {
                let Some(o) = self.openings.iter().find(|o| o.id == id).cloned() else { return };
                let Some(w) = self.wall(o.wall).cloned() else { return };
                let l = len(w.a, w.b);
                let (ux, uy) = ((w.b.0 - w.a.0) / l, (w.b.1 - w.a.1) / l);
                let half = o.width / 2.0 / l;
                let nt = (o.t + (dx * ux + dy * uy) / l).clamp(half, 1.0 - half);
                if let Some(o) = self.openings.iter_mut().find(|o| o.id == id) { o.t = nt; }
            }
            _ => {}
        }
    }

    pub fn rotate_furn(&mut self, id: u32) {
        if let Some(f) = self.furn.iter_mut().find(|f| f.id == id) { f.rot = (f.rot + 1) % 4; }
    }

    pub fn total_room_area(&self) -> f32 { self.rooms.iter().map(|r| r.w * r.h).sum() }

    /// A labelled floor area without walls (used when walls already exist, e.g. the demo apartment).
    pub fn add_area(&mut self, name: &str, x: f32, y: f32, w: f32, h: f32) -> u32 {
        let id = self.id();
        self.rooms.push(Room { id, name: name.to_string(), x, y, w, h });
        id
    }

    /// Slide an opening so it is centred as close to `p` as its wall allows.
    pub fn set_opening_at(&mut self, id: u32, p: P) {
        let Some(o) = self.openings.iter().find(|o| o.id == id).cloned() else { return };
        let Some(w) = self.wall(o.wall).cloned() else { return };
        let l = len(w.a, w.b);
        let half = o.width / 2.0 / l;
        let (_, t) = dist_to_segment(p, w.a, w.b);
        if let Some(o) = self.openings.iter_mut().find(|o| o.id == id) { o.t = t.clamp(half, 1.0 - half); }
    }

    /// Move one end of a wall (0 = a, 1 = b); refused if the wall would become shorter than 0.25 ft.
    pub fn set_wall_end(&mut self, id: u32, end: u8, p: P) -> bool {
        let Some(w) = self.walls.iter_mut().find(|w| w.id == id) else { return false };
        let other = if end == 0 { w.b } else { w.a };
        if len(p, other) < 0.25 { return false; }
        if end == 0 { w.a = p } else { w.b = p }
        true
    }

    /// The demo apartment: 24 x 16 ft, three rooms, doors, windows and furniture.
    pub fn sample() -> Plan {
        let mut p = Plan::new();
        p.add_room((0.0, 0.0), (24.0, 16.0));
        p.rooms.clear();
        p.add_wall((14.0, 0.0), (14.0, 16.0));
        p.add_wall((14.0, 9.0), (24.0, 9.0));
        p.add_area("Living", 0.0, 0.0, 14.0, 16.0);
        p.add_area("Bedroom", 14.0, 0.0, 10.0, 9.0);
        p.add_area("Bath", 14.0, 9.0, 10.0, 7.0);
        for (k, pt) in [(OpenKind::Door, (7.0, 16.0)), (OpenKind::Door, (14.0, 4.5)), (OpenKind::Door, (14.0, 12.5)),
                        (OpenKind::Window, (7.0, 0.0)), (OpenKind::Window, (19.0, 0.0)), (OpenKind::Window, (24.0, 12.5))] {
            p.add_opening(k, pt);
        }
        for (kind, x, y, rot) in [(11, 7.0, 8.5, 0), (1, 7.0, 13.9, 0), (2, 8.0, 4.0, 0), (3, 5.6, 4.0, 0), (3, 10.4, 4.0, 0),
                                  (9, 1.4, 1.2, 0), (10, 4.4, 1.3, 0),
                                  (0, 19.0, 4.8, 0), (5, 21.9, 1.1, 0), (4, 15.5, 7.4, 1),
                                  (6, 22.9, 10.4, 0), (7, 17.0, 10.0, 0), (8, 21.4, 14.7, 0)] {
            p.add_furn(kind, x, y, rot);
        }
        p
    }

    /// Standalone SVG of the plan (1 ft = 20 px), ready to paste into a file.
    pub fn export_svg(&self) -> String {
        let mut pts: Vec<P> = self.walls.iter().flat_map(|w| [w.a, w.b]).collect();
        for f in &self.furn { pts.extend(furn_corners(f)); }
        if pts.is_empty() { return "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"0\" height=\"0\"/>".into(); }
        let x0 = pts.iter().map(|p| p.0).fold(f32::MAX, f32::min) - 1.0;
        let y0 = pts.iter().map(|p| p.1).fold(f32::MAX, f32::min) - 1.0;
        let x1 = pts.iter().map(|p| p.0).fold(f32::MIN, f32::max) + 1.0;
        let y1 = pts.iter().map(|p| p.1).fold(f32::MIN, f32::max) + 1.0;
        let s = 20.0;
        let tx = |v: f32| (v - x0) * s;
        let ty = |v: f32| (v - y0) * s;
        let mut o = format!("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{:.0}\" height=\"{:.0}\" font-family=\"sans-serif\" font-size=\"11\">\n", (x1 - x0) * s, (y1 - y0) * s);
        o.push_str("<rect width=\"100%\" height=\"100%\" fill=\"#fff\"/>\n");
        for r in &self.rooms {
            o.push_str(&format!("<rect x=\"{:.1}\" y=\"{:.1}\" width=\"{:.1}\" height=\"{:.1}\" fill=\"#eef3fb\"/>\n", tx(r.x), ty(r.y), r.w * s, r.h * s));
            o.push_str(&format!("<text x=\"{:.1}\" y=\"{:.1}\" text-anchor=\"middle\" fill=\"#456\">{} · {:.0} sq ft</text>\n", tx(r.x + r.w / 2.0), ty(r.y + r.h / 2.0), r.name, r.w * r.h));
        }
        for f in &self.furn {
            let (w, h) = furn_size(f);
            let c = CATALOG[f.kind].3;
            o.push_str(&format!("<rect x=\"{:.1}\" y=\"{:.1}\" width=\"{:.1}\" height=\"{:.1}\" fill=\"rgb({},{},{})\" stroke=\"#333\" stroke-width=\"0.5\"><title>{}</title></rect>\n", tx(f.x - w / 2.0), ty(f.y - h / 2.0), w * s, h * s, c.0, c.1, c.2, CATALOG[f.kind].0));
        }
        for w in &self.walls {
            o.push_str(&format!("<line x1=\"{:.1}\" y1=\"{:.1}\" x2=\"{:.1}\" y2=\"{:.1}\" stroke=\"#222\" stroke-width=\"6\" stroke-linecap=\"square\"/>\n", tx(w.a.0), ty(w.a.1), tx(w.b.0), ty(w.b.1)));
        }
        for op in &self.openings {
            if let Some(w) = self.wall(op.wall) {
                let l = len(w.a, w.b);
                let (ux, uy) = ((w.b.0 - w.a.0) / l, (w.b.1 - w.a.1) / l);
                let c = (w.a.0 + (w.b.0 - w.a.0) * op.t, w.a.1 + (w.b.1 - w.a.1) * op.t);
                let h = op.width / 2.0;
                let (ax, ay, bx, by) = (c.0 - ux * h, c.1 - uy * h, c.0 + ux * h, c.1 + uy * h);
                let col = if op.kind == OpenKind::Door { "#fff" } else { "#7ec8e3" };
                o.push_str(&format!("<line x1=\"{:.1}\" y1=\"{:.1}\" x2=\"{:.1}\" y2=\"{:.1}\" stroke=\"{}\" stroke-width=\"6\"/>\n", tx(ax), ty(ay), tx(bx), ty(by), col));
            }
        }
        o.push_str("</svg>");
        o
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_lengths_in_feet_and_inches() {
        assert_eq!(fmt_len(12.0), "12'");
        assert_eq!(fmt_len(12.5), "12' 6\"");
        assert_eq!(fmt_len(0.5), "6\"");
        assert_eq!(fmt_len(9.99), "10'");
    }

    #[test]
    fn snapping_rounds_to_the_grid() {
        assert_eq!(snap(1.24, 0.5), 1.0);
        assert_eq!(snap(1.26, 0.5), 1.5);
        assert_eq!(snap(3.3, 0.0), 3.3);
    }

    #[test]
    fn segment_distance_and_projection() {
        let (d, t) = dist_to_segment((5.0, 3.0), (0.0, 0.0), (10.0, 0.0));
        assert!((d - 3.0).abs() < 1e-5 && (t - 0.5).abs() < 1e-5);
        let (d, t) = dist_to_segment((-4.0, 3.0), (0.0, 0.0), (10.0, 0.0));
        assert!((d - 5.0).abs() < 1e-5 && t == 0.0, "clamped to the end point");
    }

    #[test]
    fn rooms_make_four_walls_and_share_edges() {
        let mut p = Plan::new();
        assert!(p.add_room((0.0, 0.0), (10.0, 8.0)).is_some());
        assert_eq!((p.walls.len(), p.rooms.len()), (4, 1));
        assert!(p.add_room((10.0, 0.0), (20.0, 8.0)).is_some());
        assert_eq!(p.walls.len(), 7, "the shared wall must be reused, not doubled");
        assert!(p.add_room((0.0, 0.0), (0.5, 8.0)).is_none(), "too thin");
        assert!((p.total_room_area() - 160.0).abs() < 1e-3);
    }

    #[test]
    fn tiny_walls_are_rejected_and_duplicates_reused() {
        let mut p = Plan::new();
        assert!(p.add_wall((0.0, 0.0), (0.1, 0.0)).is_none());
        let a = p.add_wall((0.0, 0.0), (5.0, 0.0)).unwrap();
        assert_eq!(p.add_wall((5.0, 0.0), (0.0, 0.0)), Some(a));
        assert_eq!(p.walls.len(), 1);
    }

    #[test]
    fn openings_snap_to_a_wall_and_stay_inside_it() {
        let mut p = Plan::new();
        p.add_wall((0.0, 0.0), (10.0, 0.0));
        assert!(p.add_opening(OpenKind::Door, (5.0, 3.0)).is_none(), "too far from any wall");
        let id = p.add_opening(OpenKind::Door, (0.2, 0.3)).unwrap();
        let o = p.openings.iter().find(|o| o.id == id).unwrap();
        assert!((o.t - 0.15).abs() < 1e-5, "3 ft door centred 1.5 ft from the end of a 10 ft wall, got {}", o.t);
        p.add_wall((20.0, 0.0), (22.0, 0.0));
        assert!(p.add_opening(OpenKind::Window, (21.0, 0.0)).is_none(), "wall shorter than the window");
    }

    #[test]
    fn deleting_a_wall_deletes_its_openings() {
        let mut p = Plan::new();
        let w = p.add_wall((0.0, 0.0), (10.0, 0.0)).unwrap();
        p.add_opening(OpenKind::Window, (5.0, 0.0)).unwrap();
        assert!(p.remove(Sel::Wall(w)));
        assert!(p.walls.is_empty() && p.openings.is_empty());
        assert!(!p.remove(Sel::Wall(w)), "second delete is a no-op");
    }

    #[test]
    fn hit_testing_prefers_furniture_then_openings_then_walls_then_rooms() {
        let mut p = Plan::new();
        p.add_room((0.0, 0.0), (12.0, 10.0));
        let door = p.add_opening(OpenKind::Door, (6.0, 0.0)).unwrap();
        let f = p.add_furn(1, 6.0, 5.0, 0);
        assert_eq!(p.hit_test((6.0, 5.0), 0.3), Sel::Furn(f));
        assert_eq!(p.hit_test((6.0, 0.0), 0.3), Sel::Opening(door));
        assert!(matches!(p.hit_test((1.0, 0.1), 0.3), Sel::Wall(_)));
        assert!(matches!(p.hit_test((2.0, 2.0), 0.3), Sel::Room(_)));
        assert_eq!(p.hit_test((50.0, 50.0), 0.3), Sel::None);
    }

    #[test]
    fn rotating_furniture_swaps_its_footprint() {
        let mut p = Plan::new();
        let f = p.add_furn(0, 0.0, 0.0, 0);
        assert_eq!(furn_size(&p.furn[0]), (5.0, 6.7));
        p.rotate_furn(f);
        assert_eq!(furn_size(&p.furn[0]), (6.7, 5.0));
        for _ in 0..3 { p.rotate_furn(f); }
        assert_eq!(p.furn[0].rot, 0);
    }

    #[test]
    fn nudging_moves_furniture_and_slides_openings_along_the_wall() {
        let mut p = Plan::new();
        p.add_wall((0.0, 0.0), (10.0, 0.0));
        let o = p.add_opening(OpenKind::Door, (5.0, 0.0)).unwrap();
        p.nudge(Sel::Opening(o), 2.0, 5.0);       // the y part is ignored: it can only slide along the wall
        assert!((p.openings[0].t - 0.7).abs() < 1e-5);
        p.nudge(Sel::Opening(o), 100.0, 0.0);
        assert!((p.openings[0].t - 0.85).abs() < 1e-5, "clamped so the door stays on the wall");
        let f = p.add_furn(3, 1.0, 1.0, 0);
        p.nudge(Sel::Furn(f), 0.5, -0.5);
        assert_eq!((p.furn[0].x, p.furn[0].y), (1.5, 0.5));
    }

    #[test]
    fn svg_export_contains_every_element() {
        let mut p = Plan::new();
        p.add_room((0.0, 0.0), (10.0, 8.0));
        p.add_opening(OpenKind::Window, (5.0, 0.0)).unwrap();
        p.add_furn(0, 5.0, 4.0, 0);
        let svg = p.export_svg();
        assert!(svg.starts_with("<svg") && svg.ends_with("</svg>"));
        assert_eq!(svg.matches("stroke-linecap").count(), 4, "four walls");
        assert!(svg.contains("80 sq ft") && svg.contains("<title>Bed</title>") && svg.contains("#7ec8e3"));
        assert!(Plan::new().export_svg().contains("width=\"0\""));
    }

    #[test]
    fn sample_apartment_is_well_formed() {
        let p = Plan::sample();
        assert_eq!((p.walls.len(), p.rooms.len(), p.openings.len(), p.furn.len()), (6, 3, 6, 13));
        assert!((p.total_room_area() - 14.0 * 16.0 - 90.0 - 70.0).abs() < 1e-3);
        for f in &p.furn {                      // every piece sits inside the 24 x 16 ft outline
            for c in furn_corners(f) { assert!(c.0 >= 0.0 && c.0 <= 24.0 && c.1 >= 0.0 && c.1 <= 16.0, "{:?} sticks out at {:?}", f, c); }
        }
    }

    #[test]
    fn wall_ends_and_openings_can_be_dragged() {
        let mut p = Plan::new();
        let w = p.add_wall((0.0, 0.0), (10.0, 0.0)).unwrap();
        assert!(p.set_wall_end(w, 1, (10.0, 5.0)));
        assert!(!p.set_wall_end(w, 1, (0.1, 0.0)), "would collapse the wall");
        assert_eq!(p.walls[0].b, (10.0, 5.0));
        let o = p.add_opening(OpenKind::Door, (0.0, 0.0)).unwrap();
        p.set_opening_at(o, (10.0, 5.0));
        let max_t = 1.0 - 1.5 / len((0.0, 0.0), (10.0, 5.0));
        assert!((p.openings[0].t - max_t).abs() < 1e-4);
    }
}
