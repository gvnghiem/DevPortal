// devportal-app: hello_canvas
//! Hello, canvas — the smallest useful DevPortal Rust app.
//! Move the mouse: a ring follows it. Click: drop a bouncing ball. Space: clear. Everything below is
//! plain Rust; the `dp` crate turns draw calls into the browser <canvas>.
use dp::{keys, App, Cursor, Gfx, Mods, Pointer, PointerKind, Rgba};

const BG: Rgba = Rgba::rgb(14, 17, 27);
const GRID: Rgba = Rgba::rgba(255, 255, 255, 14);
const TEXT: Rgba = Rgba::rgb(220, 226, 240);
const DIM: Rgba = Rgba::rgb(130, 140, 165);

struct Ball { x: f32, y: f32, vx: f32, vy: f32, r: f32, color: Rgba }

pub struct Hello { w: f32, h: f32, balls: Vec<Ball>, mouse: (f32, f32), last_t: f64, seed: u32, frames: u32 }

impl Hello {
    pub fn new() -> Self {
        Hello { w: 640.0, h: 400.0, balls: Vec::new(), mouse: (-100.0, -100.0), last_t: 0.0, seed: 0x2545_f491, frames: 0 }
    }
    /// tiny deterministic random numbers in 0..1 (xorshift), so tests are reproducible
    fn rnd(&mut self) -> f32 {
        let mut x = self.seed;
        x ^= x << 13; x ^= x >> 17; x ^= x << 5;
        self.seed = x;
        (x >> 8) as f32 / (1u32 << 24) as f32
    }
    fn spawn(&mut self, x: f32, y: f32) {
        let (a, b, c, d) = (self.rnd(), self.rnd(), self.rnd(), self.rnd());
        self.balls.push(Ball {
            x, y,
            vx: (a - 0.5) * 360.0,
            vy: -120.0 - b * 200.0,
            r: 10.0 + c * 16.0,
            color: Rgba::rgb(80 + (d * 175.0) as u8, 120 + (a * 120.0) as u8, 255 - (b * 150.0) as u8),
        });
        if self.balls.len() > 200 { self.balls.remove(0); }
    }
    pub fn step(&mut self, dt: f32) {
        let (w, h) = (self.w, self.h);
        for b in &mut self.balls {
            b.vy += 900.0 * dt;                       // gravity, pixels / s²
            b.x += b.vx * dt;
            b.y += b.vy * dt;
            if b.x < b.r { b.x = b.r; b.vx = -b.vx * 0.9; }
            if b.x > w - b.r { b.x = w - b.r; b.vx = -b.vx * 0.9; }
            if b.y > h - b.r { b.y = h - b.r; b.vy = -b.vy * 0.82; if b.vy.abs() < 20.0 { b.vy = 0.0; } }
        }
    }
    pub fn ball_count(&self) -> usize { self.balls.len() }
}

impl Default for Hello { fn default() -> Self { Self::new() } }

impl App for Hello {
    fn init(&mut self, w: f32, h: f32) {
        self.w = w; self.h = h;
        for i in 0..4 { self.spawn(w * (0.2 + 0.2 * i as f32), h * 0.3); }
    }
    fn resize(&mut self, w: f32, h: f32) { self.w = w; self.h = h; }

    fn frame(&mut self, g: &mut dyn Gfx, t_ms: f64) {
        let dt = if self.last_t == 0.0 { 0.016 } else { ((t_ms - self.last_t) / 1000.0).min(0.05) as f32 };
        self.last_t = t_ms;
        self.frames += 1;
        self.step(dt);

        g.clear(BG);
        let mut x = 0.0;
        while x < self.w { g.line(x, 0.0, x, self.h, 1.0, GRID); x += 40.0; }
        let mut y = 0.0;
        while y < self.h { g.line(0.0, y, self.w, y, 1.0, GRID); y += 40.0; }

        for b in &self.balls {
            g.circle(b.x, b.y, b.r, b.color, true);
            g.circle(b.x, b.y, b.r, Rgba::rgba(255, 255, 255, 90), false);
        }
        g.circle(self.mouse.0, self.mouse.1, 18.0, Rgba::rgb(255, 196, 61), false);

        g.text("Hello from Rust → WebAssembly", 16.0, 28.0, 18.0, TEXT);
        g.text(&format!("balls: {}   frame: {}", self.balls.len(), self.frames), 16.0, 50.0, 13.0, DIM);
        g.text("click = drop a ball · space = clear", 16.0, self.h - 14.0, 12.0, DIM);
        g.cursor(Cursor::Crosshair);
    }

    fn pointer(&mut self, p: Pointer) {
        self.mouse = (p.x, p.y);
        if p.kind == PointerKind::Down && p.buttons & 1 != 0 { self.spawn(p.x, p.y); }
    }
    fn key(&mut self, code: u32, down: bool, _mods: Mods) {
        if down && code == keys::SPACE { self.balls.clear(); }
    }
}

dp::dp_app!(Hello::new());

#[cfg(test)]
mod tests {
    use super::*;
    use dp::recorder::{Cmd, Recorder};

    fn app() -> Hello { let mut a = Hello::new(); a.init(640.0, 400.0); a }

    #[test]
    fn starts_with_four_balls_and_draws_them() {
        let mut a = app();
        let mut r = Recorder::new();
        a.frame(&mut r, 16.0);
        assert_eq!(a.ball_count(), 4);
        assert!(matches!(r.cmds[0], Cmd::Clear(_)));
        assert!(r.texts().iter().any(|t| t.contains("balls: 4")));
    }

    #[test]
    fn click_spawns_a_ball_and_space_clears() {
        let mut a = app();
        a.pointer(Pointer { kind: PointerKind::Down, x: 100.0, y: 100.0, buttons: 1, delta: 0.0 });
        assert_eq!(a.ball_count(), 5);
        a.pointer(Pointer { kind: PointerKind::Move, x: 5.0, y: 5.0, buttons: 0, delta: 0.0 });
        assert_eq!(a.ball_count(), 5, "moving must not spawn");
        a.key(keys::SPACE, true, Mods(0));
        assert_eq!(a.ball_count(), 0);
    }

    #[test]
    fn balls_stay_inside_the_canvas() {
        let mut a = app();
        for _ in 0..2000 { a.step(0.016); }
        for b in &a.balls {
            assert!(b.x >= b.r - 0.01 && b.x <= 640.0 - b.r + 0.01, "x out of range: {}", b.x);
            assert!(b.y <= 400.0 - b.r + 0.01, "fell through the floor: {}", b.y);
        }
    }

    #[test]
    fn ball_count_is_capped() {
        let mut a = app();
        for i in 0..500 { a.spawn(i as f32, 10.0); }
        assert_eq!(a.ball_count(), 200);
    }
}
