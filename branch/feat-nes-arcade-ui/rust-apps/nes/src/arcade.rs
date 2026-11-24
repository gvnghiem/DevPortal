//! Arcade-cabinet look for the NES app: neon palette, a 5x7 pixel font (the page only offers a system font), glow,
//! chamfered panels, a synthwave backdrop, scanlines and an on-screen controller. Pure drawing: no emulator state in here.

use crate::bus::pad;
use dp::{Gfx, Rgba};

pub const BG: Rgba = Rgba::rgb(7, 6, 15);
pub const CYAN: Rgba = Rgba::rgb(0, 240, 255);
pub const MAGENTA: Rgba = Rgba::rgb(255, 46, 196);
pub const AMBER: Rgba = Rgba::rgb(255, 196, 61);
pub const GREEN: Rgba = Rgba::rgb(57, 255, 136);
pub const VIOLET: Rgba = Rgba::rgb(130, 70, 255);
pub const PANEL: Rgba = Rgba::rgb(16, 14, 32);
pub const PANEL_HI: Rgba = Rgba::rgb(34, 29, 62);
pub const DIM: Rgba = Rgba::rgb(135, 145, 170);

fn rgb(c: Rgba) -> (f32, f32, f32) { ((c.0 >> 24) as f32, ((c.0 >> 16) & 255) as f32, ((c.0 >> 8) & 255) as f32) }

pub fn lerp(a: Rgba, b: Rgba, t: f32) -> Rgba {
    let (t, (ar, ag, ab), (br, bg, bb)) = (t.clamp(0.0, 1.0), rgb(a), rgb(b));
    Rgba::rgb((ar + (br - ar) * t) as u8, (ag + (bg - ag) * t) as u8, (ab + (bb - ab) * t) as u8)
}

/// Rows of a 5x7 glyph, top first, bit 4 = leftmost column. Unknown characters are blank; lowercase is upper-cased.
pub fn glyph(c: char) -> [u8; 7] {
    match c.to_ascii_uppercase() {
        'A' => [0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11], 'B' => [0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E],
        'C' => [0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E], 'D' => [0x1E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1E],
        'E' => [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F], 'F' => [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10],
        'G' => [0x0E, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0F], 'H' => [0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
        'I' => [0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E], 'J' => [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0C],
        'K' => [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11], 'L' => [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F],
        'M' => [0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11], 'N' => [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
        'O' => [0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E], 'P' => [0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10],
        'Q' => [0x0E, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0D], 'R' => [0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11],
        'S' => [0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E], 'T' => [0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
        'U' => [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E], 'V' => [0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04],
        'W' => [0x11, 0x11, 0x11, 0x15, 0x15, 0x1B, 0x11], 'X' => [0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11],
        'Y' => [0x11, 0x11, 0x0A, 0x04, 0x04, 0x04, 0x04], 'Z' => [0x1F, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1F],
        '0' => [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E], '1' => [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
        '2' => [0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F], '3' => [0x1E, 0x01, 0x01, 0x0E, 0x01, 0x01, 0x1E],
        '4' => [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02], '5' => [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E],
        '6' => [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E], '7' => [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
        '8' => [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E], '9' => [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C],
        '-' => [0, 0, 0, 0x1F, 0, 0, 0], '.' => [0, 0, 0, 0, 0, 0x0C, 0x0C], ':' => [0, 0x0C, 0x0C, 0, 0x0C, 0x0C, 0],
        '!' => [0x04, 0x04, 0x04, 0x04, 0x04, 0, 0x04], '?' => [0x0E, 0x11, 0x01, 0x02, 0x04, 0, 0x04],
        '/' => [0x01, 0x01, 0x02, 0x04, 0x08, 0x10, 0x10], '>' => [0x10, 0x08, 0x04, 0x02, 0x04, 0x08, 0x10],
        '<' => [0x01, 0x02, 0x04, 0x08, 0x04, 0x02, 0x01], '+' => [0, 0x04, 0x04, 0x1F, 0x04, 0x04, 0],
        '_' => [0, 0, 0, 0, 0, 0, 0x1F], '(' => [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
        ')' => [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08], '*' => [0, 0x15, 0x0E, 0x1F, 0x0E, 0x15, 0],
        _ => [0; 7],
    }
}

/// Width in pixels of `s` drawn by [`pixel_text`] with the given cell size.
pub fn text_width(s: &str, cell: f32) -> f32 { let n = s.chars().count() as f32; if n == 0.0 { 0.0 } else { n * 6.0 * cell - cell } }

/// Draw `s` in chunky pixels, optionally with a soft neon halo around every lit cell.
pub fn pixel_text(g: &mut dyn Gfx, s: &str, x: f32, y: f32, cell: f32, c: Rgba, glow: bool) {
    for pass in 0..2 {
        if pass == 0 && !glow { continue; }
        let mut cx = x;
        for ch in s.chars() {
            for (r, bits) in glyph(ch).iter().enumerate() {
                for col in 0..5 {
                    if bits >> (4 - col) & 1 == 0 { continue; }
                    let (px, py) = (cx + col as f32 * cell, y + r as f32 * cell);
                    if pass == 0 { g.rect(px - cell * 0.6, py - cell * 0.6, cell * 2.2, cell * 2.2, c.with_alpha(26), true); }
                    else { g.rect(px, py, cell * 0.92, cell * 0.92, c, true); }
                }
            }
            cx += 6.0 * cell;
        }
    }
}

pub fn pixel_text_centered(g: &mut dyn Gfx, s: &str, cx: f32, y: f32, cell: f32, c: Rgba, glow: bool) {
    pixel_text(g, s, (cx - text_width(s, cell) / 2.0).round(), y, cell, c, glow);
}

/// Rectangle with its four corners cut off: the "futuristic panel" shape.
pub fn chamfer(g: &mut dyn Gfx, (x, y, w, h): (f32, f32, f32, f32), cut: f32, c: Rgba, fill: bool) {
    let k = cut.min(w / 2.0).min(h / 2.0);
    g.poly(&[(x + k, y), (x + w - k, y), (x + w, y + k), (x + w, y + h - k), (x + w - k, y + h), (x + k, y + h), (x, y + h - k), (x, y + k)], c, fill);
}

/// Soft halo around a rectangle, drawn as stacked translucent frames.
pub fn halo(g: &mut dyn Gfx, x: f32, y: f32, w: f32, h: f32, c: Rgba) {
    for i in (1..=6).rev() {
        let d = i as f32 * 4.0;
        chamfer(g, (x - d, y - d, w + 2.0 * d, h + 2.0 * d), 10.0 + d, c.with_alpha(9), true);
    }
}

fn hash(i: u32) -> u32 { let mut x = i.wrapping_mul(0x9E37_79B1); x ^= x >> 15; x = x.wrapping_mul(0x85EB_CA6B); x ^ (x >> 13) }

/// Night sky, twinkling stars and a perspective grid rolling toward the viewer.
pub fn backdrop(g: &mut dyn Gfx, w: f32, h: f32, t: f64) {
    g.clear(BG);
    let horizon = (h * 0.62).round();
    for i in 0..4 {                                                           // sky glow banding toward the horizon
        let f = i as f32 / 4.0;
        g.rect(0.0, horizon * f, w, horizon * (1.0 - f), VIOLET.with_alpha((10.0 + 14.0 * f) as u8), true);
    }
    for i in 0..60u32 {
        let (x, y) = ((hash(i) % 10_000) as f32 / 10_000.0 * w, (hash(i + 777) % 10_000) as f32 / 10_000.0 * horizon);
        let tw = ((t / 650.0) as f32 + i as f32).sin() * 0.5 + 0.5;
        g.rect(x.floor(), y.floor(), 2.0, 2.0, Rgba::rgb(190, 200, 255).with_alpha((50.0 + 150.0 * tw) as u8), true);
    }
    g.line(0.0, horizon, w, horizon, 2.0, MAGENTA.with_alpha(150));
    g.line(0.0, horizon, w, horizon, 8.0, MAGENTA.with_alpha(30));
    let scroll = ((t / 2200.0) % 1.0) as f32;
    for i in 0..12 {
        let f = (i as f32 + scroll) / 12.0;
        g.line(0.0, horizon + (h - horizon) * f * f, w, horizon + (h - horizon) * f * f, 1.0 + f * 1.5, VIOLET.with_alpha((25.0 + 110.0 * f) as u8));
    }
    for k in -14..=14 {
        g.line(w / 2.0, horizon, w / 2.0 + k as f32 * w * 0.13, h, 1.0, VIOLET.with_alpha(70));
    }
}

/// Dark lines between the scaled pixel rows, like the gaps between a CRT's scanlines.
pub fn scanlines(g: &mut dyn Gfx, x: f32, y: f32, w: f32, scale: f32, rows: u32, alpha: u8) {
    if scale < 2.0 { return; }
    let thick = (scale * 0.38).max(1.0);
    for r in 0..rows { g.rect(x, y + r as f32 * scale + scale - thick, w, thick, Rgba::rgba(0, 0, 0, alpha), true); }
}

/// The on-screen controller: lights up whatever is held on player 1's pad.
pub fn controller(g: &mut dyn Gfx, (x, y, w, h): (f32, f32, f32, f32), held: u8, p2: bool, accent: Rgba) {
    chamfer(g, (x, y, w, h), 14.0, PANEL, true);
    chamfer(g, (x, y, w, h), 14.0, accent.with_alpha(160), false);
    let on = |b: u8| held & b != 0;
    let lit = |b: u8, c: Rgba| if on(b) { c } else { PANEL_HI };
    // d-pad
    let (cx, cy, a) = (x + w * 0.2, y + h * 0.5, (h * 0.2).min(w * 0.06));
    for (dx, dy, b) in [(0.0, -1.0, pad::UP), (0.0, 1.0, pad::DOWN), (-1.0, 0.0, pad::LEFT), (1.0, 0.0, pad::RIGHT)] {
        let c = lit(b, CYAN);
        if on(b) { g.rect(cx + dx * a - a * 0.9, cy + dy * a - a * 0.9, a * 1.8, a * 1.8, CYAN.with_alpha(50), true); }
        g.rect(cx + dx * a - a * 0.5, cy + dy * a - a * 0.5, a, a, c, true);
    }
    g.rect(cx - a * 0.5, cy - a * 0.5, a, a, PANEL_HI, true);
    // select / start pills
    let (pw, ph) = ((w * 0.12).clamp(28.0, 60.0), (h * 0.12).clamp(8.0, 14.0));
    for (i, (b, label)) in [(pad::SELECT, "SELECT"), (pad::START, "START")].into_iter().enumerate() {
        let px = x + w * 0.42 + i as f32 * (pw + 14.0);
        chamfer(g, (px, cy - ph / 2.0, pw, ph), 4.0, lit(b, AMBER), true);
        g.text(label, px + pw / 2.0 - label.len() as f32 * 2.6, cy + ph + 8.0, 9.0, if on(b) { AMBER } else { DIM });
    }
    // B / A
    let r = (h * 0.2).min(w * 0.05);
    for (i, (b, label)) in [(pad::B, "B"), (pad::A, "A")].into_iter().enumerate() {
        let (bx, by) = (x + w * 0.78 + i as f32 * (r * 2.7), cy + (1 - i) as f32 * r * 0.55 - r * 0.3);
        if on(b) { g.circle(bx, by, r * 1.5, MAGENTA.with_alpha(55), true); }
        g.circle(bx, by, r, lit(b, MAGENTA), true);
        g.circle(bx, by, r, MAGENTA.with_alpha(180), false);
        g.text(label, bx - 3.5, by + 4.0, 11.0, if on(b) { BG } else { DIM });
    }
    // player lamp
    let lamp = if p2 { GREEN } else { PANEL_HI };
    g.circle(x + w - 14.0, y + 14.0, 4.0, lamp, true);
    g.text("P2", x + w - 40.0, y + 18.0, 9.0, if p2 { GREEN } else { DIM });
}
