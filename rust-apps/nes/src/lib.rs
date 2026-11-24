// devportal-app: nes
//! NES emulator in an arcade-cabinet UI. Cartridge loader, 6502 CPU, dot-stepped PPU, APU sound, keyboard and
//! standard game controllers, mappers 0 / 2 / 3 / 7 (MMC1 and MMC3 to come). Open a .nes file you own (click, or drop one on the canvas).
//!
//! Keys: arrows · X = A · Z = B · Enter = Start · Shift or Tab = Select · M mute · L scanlines.
//! Emulator: Space pause · R reset · O open another ROM · D debug view (CPU registers, RAM map) · S step one
//! instruction · T run nestest in its no-picture "automation" mode.
pub mod apu;
pub mod arcade;
pub mod bus;
pub mod cart;
pub mod cpu;
pub mod ppu;
pub mod system;

use bus::pad;
use cart::{Cart, Mirroring};
use cpu::Cpu;
use dp::{keys, App, Cursor, Gamepad, Gfx, Mods, Pointer, PointerKind, Rgba};
use system::Nes;

/// NTSC: 60.0988 frames per second.
const FRAME_MS: f64 = 1000.0 / 60.0988;
/// nestest's last instruction (an RTS) is at $C66E; reaching it means every check ran.
const NESTEST_END: u16 = 0xC66E;
const BG: Rgba = arcade::BG;
const TEXT: Rgba = Rgba::rgb(222, 228, 242);
const DIM: Rgba = arcade::DIM;
const ACCENT: Rgba = Rgba::rgb(255, 196, 61);
const OK: Rgba = Rgba::rgb(110, 220, 140);
const BAD: Rgba = Rgba::rgb(255, 120, 120);

/// `s`, cut with an ellipsis so it fits `max_w` pixels at roughly `per_char` pixels per character.
fn fit(s: &str, max_w: f32, per_char: f32) -> String {
    let max = (max_w / per_char).floor().max(1.0) as usize;
    if s.chars().count() <= max { s.to_string() } else { s.chars().take(max.saturating_sub(1)).chain(std::iter::once('…')).collect() }
}

/// Screen geometry for the current window size (see `NesApp::layout`).
struct Layout { top: f32, screen: (f32, f32, f32, f32), scale: f32, panel: Option<(f32, f32, f32, f32)> }

pub struct NesApp {
    w: f32, h: f32,
    nes: Option<Nes>,
    name: String,
    running: bool,
    error: Option<String>,
    want_picker: bool,
    debug: bool,
    auto: bool,
    /// Keyboard buttons held (see [`pad`]).
    pad: u8,
    /// Connected game controllers as (browser index, NES buttons), lowest index first: the first is player 1, the second player 2.
    pads: Vec<(u32, u8)>,
    muted: bool,
    scanlines: bool,
    /// Page clock (ms) of the latest frame: drives the animation.
    clock: f64,
    /// Sample rate the APU is currently producing (0 = not yet told).
    audio_rate: u32,
    last_t: Option<f64>,
    acc: f64,
}

/// Translate a controller in the browser's "standard" layout (Xbox, PlayStation, Luna, Switch Pro, ...) to NES buttons.
/// The NES A/B sit where a Nintendo pad's do — A on the right, B below it — so the right/bottom face buttons map to A and B
/// whichever logo they carry, and the left/top face buttons duplicate them (handy for two-thumb "run and jump" play).
pub fn map_gamepad(g: &Gamepad) -> u8 {
    const DEADZONE: f32 = 0.5;
    let mut m = 0;
    let mut set = |on: bool, bit: u8| if on { m |= bit };
    set(g.pressed(1) || g.pressed(3), pad::A);
    set(g.pressed(0) || g.pressed(2), pad::B);
    set(g.pressed(8), pad::SELECT);
    set(g.pressed(9), pad::START);
    set(g.pressed(12) || g.axes[1] < -DEADZONE, pad::UP);
    set(g.pressed(13) || g.axes[1] > DEADZONE, pad::DOWN);
    set(g.pressed(14) || g.axes[0] < -DEADZONE, pad::LEFT);
    set(g.pressed(15) || g.axes[0] > DEADZONE, pad::RIGHT);
    m
}

impl NesApp {
    pub fn new() -> Self {
        NesApp { w: 900.0, h: 600.0, nes: None, name: String::new(), running: false, error: None, want_picker: false, debug: false, auto: false, pad: 0, pads: Vec::new(), muted: false, scanlines: true, clock: 0.0, audio_rate: 0, last_t: None, acc: 0.0 }
    }

    fn load(&mut self, name: &str, data: &[u8]) {
        match Cart::parse(data).and_then(|c| c.supported().map(|_| c)) {
            Ok(cart) => {
                self.nes = Some(Nes::new(cart));
                self.name = name.to_string();
                self.error = None; self.running = true; self.auto = false;
                self.acc = FRAME_MS; self.last_t = None;                 // draw the first frame right away
                self.audio_rate = 0;                                      // re-tell the new APU the page's sample rate
            }
            Err(e) => self.error = Some(format!("{name}: {e}")),
        }
    }

    fn sync_pads(&mut self) {
        let (p1, p2) = (self.pad | self.pads.first().map_or(0, |p| p.1), self.pads.get(1).map_or(0, |p| p.1));
        if let Some(n) = self.nes.as_mut() { n.bus.pad = p1; n.bus.pad2 = p2; }
    }

    /// nestest's "automation" entry: jump straight to $C000, which runs every CPU test.
    fn nestest_auto(&mut self) {
        if let Some(n) = self.nes.as_mut() {
            n.reset(); n.cpu = Cpu::new(); n.cpu.pc = 0xC000; n.cpu.cycles = 7;
            self.auto = true; self.running = true;
        }
    }

    /// Run as many emulated frames as real time has passed (at most 3, so a hidden tab can't snowball).
    fn advance(&mut self, t: f64) {
        if !self.running || self.nes.is_none() { self.last_t = None; return; }
        if let Some(last) = self.last_t { self.acc += (t - last).clamp(0.0, 100.0); }
        self.last_t = Some(t);
        let stop = if self.auto { Some(NESTEST_END) } else { None };
        let nes = self.nes.as_mut().expect("checked above");
        nes.bus.pad = self.pad | self.pads.first().map_or(0, |p| p.1);
        nes.bus.pad2 = self.pads.get(1).map_or(0, |p| p.1);
        let mut ran = 0;
        while self.acc >= FRAME_MS && ran < 3 {
            if nes.run_frame(stop) { self.running = false; self.acc = 0.0; return; }
            self.acc -= FRAME_MS; ran += 1;
        }
        if ran == 3 { self.acc = 0.0; }
    }

    /// Text a blargg-style test ROM left at $6004 (signature DE B0 61 at $6001).
    fn test_output(n: &Nes) -> Option<(u8, String)> {
        if (n.peek(0x6001), n.peek(0x6002), n.peek(0x6003)) != (0xDE, 0xB0, 0x61) { return None; }
        let text: String = (0x6004u16..0x7000).map(|a| n.peek(a)).take_while(|&b| b != 0).map(|b| if b == b'\n' || (32..127).contains(&b) { b as char } else { '?' }).collect();
        Some((n.peek(0x6000), text))
    }

    /// Where everything goes for a window of this size; small windows drop the marquee and the controller panel first.
    fn layout(&self) -> Layout {
        let (w, h) = (self.w, self.h);
        let top = if h >= 480.0 { 64.0 } else if h >= 380.0 { 36.0 } else { 0.0 };
        let panel_h = if h >= 600.0 { 100.0 } else { 0.0 };
        let (footer, pad) = (36.0, 16.0);
        let avail_w = (w - 2.0 * pad - 16.0).max(64.0);
        let avail_h = (h - top - panel_h - footer - 2.0 * pad - 8.0).max(48.0);
        let fit = (avail_w / ppu::WIDTH as f32).min(avail_h / ppu::HEIGHT as f32);
        let scale = if fit >= 1.0 { fit.floor() } else { fit.max(0.1) };           // whole-number scaling keeps pixels crisp
        let (sw, sh) = (ppu::WIDTH as f32 * scale, ppu::HEIGHT as f32 * scale);
        let region_h = h - top - panel_h - footer;
        let sx = ((w - sw) / 2.0).floor();
        let sy = (top + (region_h - sh) / 2.0).floor().max(top);
        let pw = (w - 24.0).clamp(0.0, 640.0);
        let panel = if panel_h > 0.0 { Some((((w - pw) / 2.0).floor(), h - footer - panel_h + 6.0, pw, panel_h - 12.0)) } else { None };
        Layout { top, screen: (sx, sy, sw, sh), scale, panel }
    }

    fn neon(&self) -> Rgba { arcade::lerp(arcade::CYAN, arcade::MAGENTA, ((self.clock / 3200.0).sin() as f32) * 0.5 + 0.5) }
    fn p1(&self) -> u8 { self.pad | self.pads.first().map_or(0, |p| p.1) }

    /// "NES ARCADE" marquee, with 1UP / 2UP lamps.
    fn marquee(&self, g: &mut dyn Gfx, top: f32) {
        if top <= 0.0 { return; }
        let cell = if top >= 64.0 { 4.0 } else { 2.5 };
        let y = ((top - 7.0 * cell) / 2.0).floor();
        arcade::pixel_text_centered(g, "NES ARCADE", self.w / 2.0, y, cell, self.neon(), true);
        let lamp = |on: bool, c: Rgba| if on { c } else { c.with_alpha(70) };
        let blink = (self.clock / 500.0) as i64 % 2 == 0;
        let small = if top >= 64.0 { 2.0 } else { 1.5 };
        arcade::pixel_text(g, "1UP", 16.0, y + 7.0 * (cell - small) / 2.0, small, lamp(self.nes.is_none() && blink || self.nes.is_some(), arcade::AMBER), self.nes.is_some());
        let two = "2UP"; arcade::pixel_text(g, two, self.w - 16.0 - arcade::text_width(two, small), y + 7.0 * (cell - small) / 2.0, small, lamp(self.pads.len() >= 2, arcade::GREEN), self.pads.len() >= 2);
        g.line(self.w * 0.2, top - 2.0, self.w * 0.8, top - 2.0, 1.0, self.neon().with_alpha(120));
    }

    /// The cabinet: glowing bezel, the screen rectangle (drawn black here; the caller fills it), and a glass glint.
    fn cabinet(&self, g: &mut dyn Gfx, lay: &Layout) {
        let (x, y, w, h) = lay.screen;
        let neon = self.neon();
        arcade::halo(g, x - 14.0, y - 14.0, w + 28.0, h + 28.0, neon);
        arcade::chamfer(g, (x - 14.0, y - 14.0, w + 28.0, h + 28.0), 12.0, arcade::PANEL, true);
        arcade::chamfer(g, (x - 14.0, y - 14.0, w + 28.0, h + 28.0), 12.0, neon, false);
        arcade::chamfer(g, (x - 6.0, y - 6.0, w + 12.0, h + 12.0), 6.0, arcade::PANEL_HI, false);
        g.rect(x, y, w, h, Rgba::rgb(0, 0, 0), true);
    }

    fn glass(&self, g: &mut dyn Gfx, lay: &Layout) {
        let (x, y, w, h) = lay.screen;
        arcade::scanlines(g, x, y, w, lay.scale, ppu::HEIGHT as u32, if self.scanlines { 70 } else { 0 });
        g.poly(&[(x, y), (x + w * 0.42, y), (x, y + h * 0.32)], Rgba::rgba(255, 255, 255, 9), true);   // glint in the top-left corner
    }

    fn footer(&self, g: &mut dyn Gfx, left: &str) {
        let left = fit(left, self.w - 24.0, 7.0);
        g.text(&left, 12.0, self.h - 12.0, 12.0, arcade::DIM);
        let full = "arrows · X A · Z B · Enter Start · Shift Select · Space pause · R reset · M mute · L scanlines · O open · D debug";
        let short = "X A · Z B · Enter Start · M mute · L scanlines";
        let width = |t: &str| t.chars().count() as f32 * 6.3;
        let hint = if width(full) <= self.w - 24.0 { full } else { short };
        let fits = left.chars().count() as f32 * 7.0 + width(hint) + 40.0 < self.w;       // otherwise the hint gets its own line
        g.text(&fit(hint, self.w - 24.0, 6.3), (self.w - width(hint) - 12.0).max(12.0), if fits { self.h - 12.0 } else { self.h - 27.0 }, 11.0, arcade::DIM);
    }

    fn draw_prompt(&self, g: &mut dyn Gfx) {
        let lay = self.layout();
        arcade::backdrop(g, self.w, self.h, self.clock);
        self.marquee(g, lay.top);
        self.cabinet(g, &lay);
        let (x, y, w, h) = lay.screen;
        let cx = x + w / 2.0;
        let cell = (w * 0.9 / 60.0).floor().clamp(1.0, 6.0);                     // "INSERT ROM" is 10 glyphs = 60 cells wide
        let blink = (self.clock / 600.0) as i64 % 2 == 0;
        arcade::pixel_text_centered(g, "INSERT ROM", cx, y + h * 0.34, cell, if blink { arcade::AMBER } else { arcade::AMBER.with_alpha(90) }, true);
        let sub = "CLICK OR DROP A .NES FILE";
        let c2 = (w * 0.88 / (sub.len() as f32 * 6.0)).floor().clamp(1.0, 3.0);
        arcade::pixel_text_centered(g, sub, cx, y + h * 0.34 + 7.0 * cell + 18.0 * c2, c2, arcade::CYAN, true);
        let beam = (((self.clock / 2400.0) % 1.0) as f32) * h;                      // a slow light band sweeping down the glass
        g.rect(x, y + beam, w, (h * 0.08).max(2.0), Rgba::rgba(255, 255, 255, 8), true);
        self.glass(g, &lay);
        if let Some((px, py, pw, ph)) = lay.panel { arcade::controller(g, (px, py, pw, ph), self.p1(), self.pads.len() >= 2, self.neon()); }
        let pad_line = if self.pads.is_empty() { "Xbox, PlayStation, Luna and other standard controllers work too: connect one and press a button.".to_string() } else { format!("{} controller(s) connected.", self.pads.len()) };
        g.text(&fit(&format!("Supported mappers: {}. Use a ROM you own.", Cart::SUPPORTED_MAPPERS), self.w - 24.0, 6.0), 12.0, self.h - 27.0, 11.0, arcade::DIM);
        g.text(&fit(&pad_line, self.w - 24.0, 6.0), 12.0, self.h - 12.0, 11.0, arcade::DIM);
        g.text("Click to open a .nes ROM — or drop one here", cx - 130.0, y + h + 36.0, 14.0, TEXT);
        if let Some(e) = &self.error { g.text(&fit(e, self.w - 24.0, 7.5), 12.0, self.h - 44.0, 13.0, BAD); }
    }

    fn draw_game(&self, g: &mut dyn Gfx, n: &Nes) {
        let lay = self.layout();
        arcade::backdrop(g, self.w, self.h, self.clock);
        self.marquee(g, lay.top);
        self.cabinet(g, &lay);
        let (x, y, w, h) = lay.screen;
        g.blit(&n.bus.ppu.fb, ppu::WIDTH as u32, ppu::HEIGHT as u32, (x, y, w, h));
        self.glass(g, &lay);
        if !self.running {
            g.rect(x, y, w, h, Rgba::rgba(0, 0, 0, 120), true);
            let cell = (w / 72.0).floor().clamp(2.0, 8.0);
            if (self.clock / 500.0) as i64 % 2 == 0 { arcade::pixel_text_centered(g, "PAUSED", x + w / 2.0, y + h / 2.0 - 3.5 * cell, cell, arcade::AMBER, true); }
        }
        if let Some((px, py, pw, ph)) = lay.panel { arcade::controller(g, (px, py, pw, ph), self.p1(), self.pads.len() >= 2, self.neon()); }
        let status = if !self.running { "paused" } else { "" };
        let pads = match self.pads.len() { 0 => String::new(), 1 => "  🎮 controller".into(), k => format!("  🎮 {k} controllers") };
        let mute = if self.muted { "  🔇 muted" } else if self.audio_rate == 0 { "  🔇 click the game or press a key for sound" } else { "" };
        let crt = if self.scanlines { "" } else { "  · scanlines off" };
        self.footer(g, &format!("{}  {}{}{}{}", self.name, status, pads, mute, crt));
        if n.cpu.halted { g.text("CPU locked up (KIL opcode) — press R to reset", 12.0, lay.top + 22.0, 14.0, BAD); }
        if let Some(e) = &self.error { g.text(e, 12.0, lay.top + 40.0, 13.0, BAD); }
    }

    fn draw_debug(&self, g: &mut dyn Gfx, n: &Nes) {
        g.text("NES — debug view", 24.0, 40.0, 22.0, TEXT);
        let c = &n.bus.cart;
        let mir = match c.mirroring { Mirroring::Horizontal => "horizontal", Mirroring::Vertical => "vertical", Mirroring::FourScreen => "four-screen", Mirroring::SingleLo => "single-screen (low)", Mirroring::SingleHi => "single-screen (high)" };
        g.text(&self.name, 24.0, 76.0, 16.0, ACCENT);
        g.text(&format!("PRG {} KB · CHR {} KB{} · mapper {} · {} mirroring", c.prg.len() / 1024, c.chr.len() / 1024, if c.chr_is_ram { " (RAM)" } else { "" }, c.mapper, mir), 24.0, 96.0, 13.0, DIM);
        let cpu = &n.cpu;
        let flags: String = "NV-BDIZC".chars().enumerate().map(|(i, ch)| if cpu.p & (0x80 >> i) != 0 { ch } else { '.' }).collect();
        let p = &n.bus.ppu;
        let regs = [
            format!("PC  {:04X}", cpu.pc), format!("A   {:02X}", cpu.a), format!("X   {:02X}", cpu.x), format!("Y   {:02X}", cpu.y),
            format!("SP  {:02X}", cpu.sp), format!("P   {:02X}  {}", cpu.p, flags), format!("CYC {}", cpu.cycles),
            format!("PPU ctrl {:02X} mask {:02X} status {:02X}", p.ctrl, p.mask, p.status), format!("    scanline {} dot {} frame {}", p.scanline, p.dot, p.frame),
        ];
        for (i, l) in regs.iter().enumerate() { g.text(l, 24.0, 138.0 + i as f32 * 20.0, 15.0, TEXT); }
        let mut px = Vec::with_capacity(64 * 32 * 4);
        for &b in n.bus.ram.iter() { px.extend_from_slice(&[b, b, b, 255]); }
        let mw = (self.w - 380.0 - 24.0).clamp(128.0, 512.0);
        g.text("RAM ($0000–$07FF), one pixel per byte", 380.0, 128.0, 12.0, DIM);
        g.blit(&px, 64, 32, (380.0, 138.0, mw, mw / 2.0));
        let mut y = 350.0;
        if let Some((status, text)) = Self::test_output(n) {
            let col = match status { 0x80 => DIM, 0 => OK, _ => BAD };
            g.text(&format!("test ROM status ${status:02X}{}", match status { 0x80 => " (running)", 0 => " — passed", _ => " — failed" }), 24.0, y, 14.0, col);
            for l in text.lines().take(12) { y += 17.0; g.text(l, 24.0, y, 12.0, TEXT); }
        } else if self.auto && cpu.pc == NESTEST_END {
            let (r2, r3) = (n.peek(2), n.peek(3));
            g.text(&format!("nestest result  $02={r2:02X}  $03={r3:02X}  {}", if r2 == 0 && r3 == 0 { "— PASS" } else { "— FAIL" }), 24.0, y, 14.0, if r2 == 0 && r3 == 0 { OK } else { BAD });
        }
        g.text("D back to the game · Space run/pause · S step · R reset · T nestest · O open", 24.0, self.h - 24.0, 12.0, DIM);
    }
}

impl Default for NesApp { fn default() -> Self { Self::new() } }

impl App for NesApp {
    fn init(&mut self, w: f32, h: f32) { self.w = w; self.h = h; }
    fn resize(&mut self, w: f32, h: f32) { self.w = w; self.h = h; }

    fn frame(&mut self, g: &mut dyn Gfx, t: f64) {
        let rate = g.audio_rate();
        if rate > 0 && rate != self.audio_rate {
            self.audio_rate = rate;
            if let Some(n) = self.nes.as_mut() { n.bus.apu.set_sample_rate(rate); }
        }
        self.clock = t;
        self.advance(t);
        if let Some(n) = self.nes.as_mut() {
            let samples = n.bus.apu.take_samples();                       // always drained, so muting or pausing can't pile them up
            if !self.muted && self.running && rate > 0 { g.audio_push(&samples); }
        }
        match self.nes.as_ref() {
            None => self.draw_prompt(g),
            Some(n) if self.debug => { g.clear(BG); self.draw_debug(g, n) }
            Some(n) => self.draw_game(g, n),
        }
        if std::mem::take(&mut self.want_picker) { g.open_file(); }
        g.cursor(if self.nes.is_none() { Cursor::Pointer } else { Cursor::Default });
    }

    fn pointer(&mut self, p: Pointer) {
        // the picker must open inside the click handler: request it here, the next frame call hands it to the page
        if p.kind == PointerKind::Down && p.buttons & 1 != 0 && self.nes.is_none() { self.want_picker = true; }
    }

    fn key(&mut self, code: u32, down: bool, mods: Mods) {
        let bit = match code {
            x if x == keys::letter('x') => pad::A,
            x if x == keys::letter('z') => pad::B,
            keys::ENTER => pad::START,
            16 | keys::TAB => pad::SELECT,
            keys::UP => pad::UP, keys::DOWN => pad::DOWN, keys::LEFT => pad::LEFT, keys::RIGHT => pad::RIGHT,
            _ => 0,
        };
        if bit != 0 {
            if down { self.pad |= bit } else { self.pad &= !bit }
            self.sync_pads();
            return;
        }
        if !down || mods.ctrl() || mods.meta() { return; }
        match code {
            keys::SPACE => self.running = !self.running,
            x if x == keys::letter('d') => self.debug = !self.debug,
            x if x == keys::letter('s') => {
                self.running = false;
                if let Some(n) = self.nes.as_mut() { n.step(); }
            }
            x if x == keys::letter('r') => { if let Some(n) = self.nes.as_mut() { n.reset(); } self.auto = false; }
            x if x == keys::letter('t') => self.nestest_auto(),
            x if x == keys::letter('o') => self.want_picker = true,
            x if x == keys::letter('m') => self.muted = !self.muted,
            x if x == keys::letter('l') => self.scanlines = !self.scanlines,
            _ => {}
        }
    }

    fn gamepad(&mut self, index: u32, state: Option<Gamepad>) {
        self.pads.retain(|p| p.0 != index);
        if let Some(g) = state {
            self.pads.push((index, map_gamepad(&g)));
            self.pads.sort_by_key(|p| p.0);
        }
        self.sync_pads();
    }

    fn file(&mut self, name: &str, data: Vec<u8>) { self.load(name, &data); }
}

dp::dp_app!(NesApp::new());

#[cfg(test)]
mod tests {
    use super::*;
    use dp::recorder::{Cmd, Recorder};
    use ppu::PALETTE;

    /// A 16 KB NROM image whose reset vector points at `code` (placed at $8000).
    fn rom(code: &[u8]) -> Vec<u8> {
        let mut v = vec![b'N', b'E', b'S', 0x1a, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        let mut prg = vec![0xEA; 16384];                                  // NOP sled
        prg[..code.len()].copy_from_slice(code);
        prg[0x3FFC] = 0x00; prg[0x3FFD] = 0x80;                           // reset -> $8000
        v.extend(prg); v.extend(vec![0; 8192]); v
    }
    fn frame_at(a: &mut NesApp, t: f64) -> Recorder { let mut r = Recorder::new(); a.frame(&mut r, t); r }
    fn frame(a: &mut NesApp) -> Recorder { frame_at(a, 0.0) }
    type Blit = (u32, u32, (f32, f32, f32, f32), Vec<u8>);
    fn blit_of(r: &Recorder) -> Option<Blit> {
        r.cmds.iter().find_map(|c| if let Cmd::Blit { sw, sh, x, y, w, h, pixels } = c { Some((*sw, *sh, (*x, *y, *w, *h), pixels.clone())) } else { None })
    }

    #[test]
    fn click_asks_for_the_file_picker_only_while_empty() {
        let mut a = NesApp::new();
        a.pointer(Pointer { kind: PointerKind::Down, x: 5.0, y: 5.0, buttons: 1, delta: 0.0 });
        assert!(frame(&mut a).cmds.contains(&Cmd::OpenFile));
        a.file("t.nes", rom(&[0xEA]));
        a.pointer(Pointer { kind: PointerKind::Down, x: 5.0, y: 5.0, buttons: 1, delta: 0.0 });
        assert!(!frame(&mut a).cmds.contains(&Cmd::OpenFile), "no picker once a ROM is loaded");
    }

    #[test]
    fn bad_files_show_a_readable_error_and_keep_the_app_alive() {
        let mut a = NesApp::new();
        a.file("notes.txt", b"hello".to_vec());
        assert!(frame(&mut a).texts().iter().any(|t| t.contains("notes.txt") && t.contains("iNES")));
        let mut m1 = rom(&[0xEA]); m1[6] = 0x10;                          // mapper 1
        a.file("mmc1.nes", m1);
        assert!(frame(&mut a).texts().iter().any(|t| t.contains("mapper 1") && t.contains("UxROM")));
        assert!(a.nes.is_none());
    }

    #[test]
    fn the_game_view_blits_the_ppu_picture_scaled_by_a_whole_number() {
        let mut a = NesApp::new(); a.init(1000.0, 800.0);
        a.file("t.nes", rom(&[0x4C, 0x00, 0x80]));
        let (sw, sh, (x, y, w, h), px) = blit_of(&frame(&mut a)).expect("picture");
        assert_eq!((sw, sh, px.len()), (256, 240, 256 * 240 * 4));
        assert_eq!((w, h), (512.0, 480.0), "2x: the largest whole scale that fits once the bezel, marquee and controller panel are reserved");
        assert_eq!(x, ((1000.0 - w) / 2.0f32).floor(), "centred horizontally");
        assert!(y >= 64.0 && y + h <= 800.0 - 36.0 - 100.0, "sits between the marquee and the controller panel, got y={y}");
        a.init(200.0, 200.0);
        let (_, _, (_, _, w, h), _) = blit_of(&frame(&mut a)).unwrap();
        assert!(w < 256.0 && (w / h - 256.0 / 240.0).abs() < 1e-3, "small panes shrink but keep the aspect ratio");
    }

    #[test]
    fn a_program_that_enables_rendering_puts_its_palette_on_screen() {
        // set $3F00 = $16 (red), reset the address, turn the background on, spin
        let code = [0xA9, 0x3F, 0x8D, 0x06, 0x20, 0xA9, 0x00, 0x8D, 0x06, 0x20, 0xA9, 0x16, 0x8D, 0x07, 0x20,
                    0xA9, 0x00, 0x8D, 0x06, 0x20, 0x8D, 0x06, 0x20, 0xA9, 0x0A, 0x8D, 0x01, 0x20, 0x4C, 0x1C, 0x80];
        let mut a = NesApp::new(); a.init(1024.0, 780.0);
        a.file("t.nes", rom(&code));
        let mut t = 0.0;
        for _ in 0..4 { frame_at(&mut a, t); t += FRAME_MS; }
        let r = frame_at(&mut a, t);
        let (_, _, _, px) = blit_of(&r).unwrap();
        let c = PALETTE[0x16];
        assert_eq!(&px[0..3], &[(c >> 16) as u8, (c >> 8) as u8, c as u8]);
    }

    #[test]
    fn emulation_speed_follows_the_clock_not_the_refresh_rate() {
        let mut a = NesApp::new();
        a.file("t.nes", rom(&[0x4C, 0x00, 0x80]));
        frame_at(&mut a, 1000.0);                                         // first frame is free
        let f0 = a.nes.as_ref().unwrap().bus.ppu.frame;
        for i in 1..=12 { frame_at(&mut a, 1000.0 + i as f64 * 8.0); }    // a 125 Hz monitor for 96 ms
        let ran = a.nes.as_ref().unwrap().bus.ppu.frame - f0;
        assert!((5..=6).contains(&ran), "96 ms is about 5.8 NES frames, ran {ran}");
        frame_at(&mut a, 90_000.0);                                       // tab was hidden for a minute
        assert!(a.nes.as_ref().unwrap().bus.ppu.frame - f0 - ran <= 3, "catch-up is capped");
    }

    #[test]
    fn keys_map_to_the_pad_and_release_clears_them() {
        let mut a = NesApp::new();
        a.file("t.nes", rom(&[0xEA]));
        for (k, bit) in [(keys::letter('x'), pad::A), (keys::letter('z'), pad::B), (keys::ENTER, pad::START), (16, pad::SELECT), (keys::UP, pad::UP), (keys::RIGHT, pad::RIGHT)] {
            a.key(k, true, Mods(0)); assert_eq!(a.nes.as_ref().unwrap().bus.pad & bit, bit, "key {k}");
            a.key(k, false, Mods(0)); assert_eq!(a.nes.as_ref().unwrap().bus.pad & bit, 0);
        }
        a.key(keys::LEFT, true, Mods(1)); assert_eq!(a.nes.as_ref().unwrap().bus.pad, pad::LEFT, "shift held doesn't stop pad keys");
    }

    fn pad_state(buttons: &[u32], axes: [f32; 4]) -> Gamepad { Gamepad { buttons: buttons.iter().fold(0, |m, b| m | 1 << b), axes } }

    #[test]
    fn the_status_line_and_key_hint_never_share_a_row_when_narrow() {
        let mut a = NesApp::new(); a.file("a-long-rom-name.nes", rom(&[0x4C, 0x00, 0x80]));
        a.gamepad(0, Some(Gamepad::default())); a.resize(480.0, 500.0);
        let r = frame(&mut a);
        let ys: Vec<f32> = r.cmds.iter().filter_map(|c| if let Cmd::Text { s, y, .. } = c { if s.contains("a-long-rom-name") || s.contains("M mute") { Some(*y) } else { None } } else { None }).collect();
        assert_eq!(ys.len(), 2); assert_ne!(ys[0], ys[1], "{ys:?}");
        a.resize(1400.0, 500.0);
        let r = frame(&mut a);
        let ys: Vec<f32> = r.cmds.iter().filter_map(|c| if let Cmd::Text { s, y, .. } = c { if s.contains("a-long-rom-name") || s.contains("M mute") { Some(*y) } else { None } } else { None }).collect();
        assert_eq!(ys[0], ys[1], "wide windows keep one row");
    }

    #[test]
    fn footer_text_is_shortened_to_the_window_width() {
        assert_eq!(fit("hello world", 1000.0, 7.0), "hello world");
        assert_eq!(fit("hello world", 42.0, 7.0), "hello…");
        let mut a = NesApp::new(); a.init(360.0, 300.0); a.file("some-rather-long-game-name-here.nes", rom(&[0x4C, 0x00, 0x80]));
        for t in frame(&mut a).cmds.iter().filter_map(|c| if let Cmd::Text { s, x, size, .. } = c { Some((s, x, size)) } else { None }) {
            if *t.2 <= 12.0 && !t.0.is_empty() { assert!(t.1 + t.0.chars().count() as f32 * 5.5 <= 360.0 + 20.0, "'{}' at x={} runs off a 360px window", t.0, t.1); }
        }
    }

    #[test]
    fn small_windows_drop_the_marquee_and_panel_but_the_screen_always_fits() {
        for (w, h) in [(1500.0f32, 900.0f32), (1000.0, 800.0), (700.0, 520.0), (500.0, 400.0), (320.0, 240.0), (120.0, 90.0)] {
            let mut a = NesApp::new(); a.init(w, h);
            let l = a.layout(); let (x, y, sw, sh) = l.screen;
            assert!(x >= 0.0 && y >= l.top && x + sw <= w + 0.5 && y + sh <= h - 36.0 + 0.5, "{w}x{h}: screen {x},{y} {sw}x{sh}");
            if l.scale >= 1.0 { assert_eq!(l.scale, l.scale.floor(), "{w}x{h}: whole-number scale"); }
            assert_eq!(l.panel.is_some(), h >= 600.0, "{w}x{h}");
        }
    }

    #[test]
    fn the_empty_screen_invites_a_rom_and_the_game_screen_has_the_cabinet_and_pad_lights() {
        let mut a = NesApp::new(); a.init(1000.0, 800.0);
        let empty = frame(&mut a);
        assert!(empty.texts().iter().any(|t| t.contains("Click to open")));
        a.file("t.nes", rom(&[0x4C, 0x00, 0x80]));
        a.key(keys::letter('x'), true, Mods(0));
        let g = frame(&mut a);
        assert!(g.cmds.iter().any(|c| matches!(c, Cmd::Poly { .. })), "chamfered bezel and panel are polygons");
        let a_button_lit = g.cmds.iter().any(|c| matches!(c, Cmd::Circle { fill: true, .. }));
        assert!(a_button_lit, "buttons are drawn");
        assert!(g.texts().contains(&"SELECT") && g.texts().contains(&"START"), "controller labels");
    }

    #[test]
    fn l_toggles_scanlines_and_they_are_drawn_between_the_pixel_rows() {
        let mut a = NesApp::new(); a.init(1000.0, 800.0); a.file("t.nes", rom(&[0x4C, 0x00, 0x80]));
        let count = |r: &Recorder| r.cmds.iter().filter(|c| matches!(c, Cmd::Rect { c: col, w, .. } if col.0 == 0x0000_0046 && *w > 100.0)).count();
        assert_eq!(count(&frame(&mut a)), 240, "one dark line per source row at 2x");
        a.key(keys::letter('l'), true, Mods(0));
        assert_eq!(count(&frame(&mut a)), 0);
        assert!(frame(&mut a).texts().iter().any(|t| t.contains("scanlines off")));
    }

    #[test]
    fn pixel_font_covers_the_title_and_stays_inside_its_5x7_cells() {
        for ch in "NES ARCADE INSERT ROM PAUSED 1UP 2UP CLICK OR DROP A .NES FILE".chars() { if ch != ' ' && ch != '.' { assert!(arcade::glyph(ch).iter().any(|r| *r != 0), "{ch} has a glyph"); } }
        for ch in ('A'..='Z').chain('0'..='9') { assert!(arcade::glyph(ch).iter().all(|r| *r < 32), "{ch} fits 5 columns"); }
        assert_eq!(arcade::text_width("AB", 2.0), 22.0);
        assert_eq!(arcade::glyph('a'), arcade::glyph('A'));
    }

    #[test]
    fn standard_controller_buttons_map_to_the_nes_pad() {
        let none = [0.0; 4];
        for (b, bit) in [(1, pad::A), (3, pad::A), (0, pad::B), (2, pad::B), (8, pad::SELECT), (9, pad::START), (12, pad::UP), (13, pad::DOWN), (14, pad::LEFT), (15, pad::RIGHT)] {
            assert_eq!(map_gamepad(&pad_state(&[b], none)), bit, "button {b}");
        }
        assert_eq!(map_gamepad(&pad_state(&[4, 5, 6, 7, 10, 11, 16], none)), 0, "bumpers, triggers, stick clicks and home do nothing");
        assert_eq!(map_gamepad(&pad_state(&[1, 0, 9], none)), pad::A | pad::B | pad::START, "chords work");
    }

    #[test]
    fn the_left_stick_acts_as_a_d_pad_outside_the_dead_zone() {
        assert_eq!(map_gamepad(&pad_state(&[], [0.3, -0.4, 0.0, 0.0])), 0, "drift inside the dead zone is ignored");
        assert_eq!(map_gamepad(&pad_state(&[], [-0.9, 0.0, 0.0, 0.0])), pad::LEFT);
        assert_eq!(map_gamepad(&pad_state(&[], [0.9, 0.9, 0.0, 0.0])), pad::RIGHT | pad::DOWN);
        assert_eq!(map_gamepad(&pad_state(&[], [0.0, -0.9, 0.0, 0.0])), pad::UP);
        assert_eq!(map_gamepad(&pad_state(&[], [0.0, 0.0, 0.9, 0.9])), 0, "the right stick is not used");
    }

    #[test]
    fn controllers_are_players_in_connection_order_and_merge_with_the_keyboard() {
        let mut a = NesApp::new(); a.file("t.nes", rom(&[0x4C, 0x00, 0x80]));
        let start = pad_state(&[9], [0.0; 4]); let jump = pad_state(&[1], [0.0; 4]);
        a.gamepad(3, Some(jump)); a.gamepad(1, Some(start));            // index 1 is the lower: it becomes player 1
        { let b = &a.nes.as_ref().unwrap().bus; assert_eq!((b.pad, b.pad2), (pad::START, pad::A)); }
        a.key(keys::letter('z'), true, Mods(0));
        assert_eq!(a.nes.as_ref().unwrap().bus.pad, pad::START | pad::B, "keyboard and first controller both drive player 1");
        a.gamepad(1, None);                                              // unplug player 1: the other pad slides up
        { let b = &a.nes.as_ref().unwrap().bus; assert_eq!((b.pad, b.pad2), (pad::A | pad::B, 0)); }
        a.gamepad(3, Some(pad_state(&[], [0.0; 4])));
        assert_eq!(a.nes.as_ref().unwrap().bus.pad, pad::B, "releasing everything clears the pad");
    }

    #[test]
    fn a_pad_connected_before_a_rom_loads_still_works_once_the_game_starts() {
        let mut a = NesApp::new();
        a.gamepad(0, Some(pad_state(&[9], [0.0; 4])));
        a.file("t.nes", rom(&[0x4C, 0x00, 0x80]));
        frame(&mut a);
        assert_eq!(a.nes.as_ref().unwrap().bus.pad, pad::START);
    }

    #[test]
    fn audio_is_pushed_each_frame_at_the_hosts_rate_and_m_mutes_it() {
        // LDA #$01; STA $4015; LDA #$BF; STA $4000; LDA #$40; STA $4002; LDA #$08; STA $4003; JMP *
        let code = [0xA9, 0x01, 0x8D, 0x15, 0x40, 0xA9, 0xBF, 0x8D, 0x00, 0x40, 0xA9, 0x40, 0x8D, 0x02, 0x40, 0xA9, 0x08, 0x8D, 0x03, 0x40, 0x4C, 0x14, 0x80];
        let mut a = NesApp::new(); a.file("t.nes", rom(&code));
        let mut r = Recorder::new(); r.audio_rate = 44_100;
        a.frame(&mut r, 0.0);
        let mut t = 0.0; for _ in 0..20 { t += FRAME_MS; a.frame(&mut r, t); }
        let pushed = r.audio();
        assert!((pushed.len() as i32 - 20 * 44_100 / 60).abs() < 44_100 / 10, "about 20 frames of audio at 44.1 kHz, got {}", pushed.len());
        assert!(pushed.iter().fold(0f32, |m, x| m.max(x.abs())) > 0.05, "the square wave is audible");
        a.key(keys::letter('m'), true, Mods(0));
        let mut m = Recorder::new(); m.audio_rate = 44_100;
        for _ in 0..5 { t += FRAME_MS; a.frame(&mut m, t); }
        assert!(m.audio().is_empty(), "muted: nothing pushed");
        a.key(keys::letter('m'), true, Mods(0));
        for _ in 0..5 { t += FRAME_MS; a.frame(&mut m, t); }
        assert!(!m.audio().is_empty(), "unmuted again");
    }

    #[test]
    fn nothing_is_pushed_while_paused() {
        let mut a = NesApp::new(); a.file("t.nes", rom(&[0x4C, 0x00, 0x80]));
        let mut r = Recorder::new(); a.frame(&mut r, 0.0);
        a.key(keys::SPACE, true, Mods(0));
        let mut p = Recorder::new(); for i in 1..6 { a.frame(&mut p, i as f64 * FRAME_MS); }
        assert!(p.audio().is_empty());
    }

    #[test]
    fn a_game_reads_the_pad_through_4016() {
        // strobe, then read A into $10
        let code = [0xA9, 0x01, 0x8D, 0x16, 0x40, 0xA9, 0x00, 0x8D, 0x16, 0x40, 0xAD, 0x16, 0x40, 0x29, 0x01, 0x85, 0x10, 0x4C, 0x00, 0x80];
        let mut a = NesApp::new();
        a.file("t.nes", rom(&code));
        a.key(keys::letter('x'), true, Mods(0));
        frame_at(&mut a, 0.0); frame_at(&mut a, 20.0);
        assert_eq!(a.nes.as_ref().unwrap().peek(0x10), 1);
        a.key(keys::letter('x'), false, Mods(0));
        frame_at(&mut a, 40.0);
        assert_eq!(a.nes.as_ref().unwrap().peek(0x10), 0);
    }

    #[test]
    fn space_pauses_d_toggles_debug_s_steps_r_resets() {
        let mut a = NesApp::new();
        a.file("t.nes", rom(&[0xE8, 0x4C, 0x00, 0x80]));                   // INX; JMP $8000
        a.key(keys::SPACE, true, Mods(0)); assert!(!a.running);
        let before = a.nes.as_ref().unwrap().cpu.cycles;
        a.key(keys::letter('s'), true, Mods(0));
        assert_eq!(a.nes.as_ref().unwrap().cpu.x, 1);
        assert!(a.nes.as_ref().unwrap().cpu.cycles > before);
        a.key(keys::letter('d'), true, Mods(0));
        let r = frame(&mut a);
        assert!(r.texts().iter().any(|t| t.starts_with("PC  8001")), "{:?}", r.texts());
        let ram = blit_of(&r).unwrap(); assert_eq!((ram.0, ram.1), (64, 32), "debug view blits the RAM map");
        a.key(keys::letter('r'), true, Mods(0));
        assert_eq!((a.nes.as_ref().unwrap().cpu.pc, a.nes.as_ref().unwrap().cpu.cycles), (0x8000, 7));
    }

    #[test]
    fn a_locked_up_cpu_is_reported_not_spun_on() {
        let mut a = NesApp::new();
        a.file("t.nes", rom(&[0x02]));
        let r = frame(&mut a);
        assert!(r.texts().iter().any(|t| t.contains("locked up")));
    }

    #[test]
    fn blargg_style_test_output_is_shown_in_the_debug_view() {
        let mut a = NesApp::new();
        let code = [0xA9, 0xDE, 0x8D, 0x01, 0x60, 0xA9, 0xB0, 0x8D, 0x02, 0x60, 0xA9, 0x61, 0x8D, 0x03, 0x60,
                    0xA9, b'o', 0x8D, 0x04, 0x60, 0xA9, b'k', 0x8D, 0x05, 0x60, 0xA9, 0x00, 0x8D, 0x06, 0x60, 0x8D, 0x00, 0x60, 0x4C, 0x20, 0x80];
        a.file("t.nes", rom(&code));
        a.key(keys::letter('d'), true, Mods(0));
        let r = frame(&mut a);
        let t = r.texts();
        assert!(t.iter().any(|s| s.contains("passed")) && t.contains(&"ok"), "{t:?}");
    }

    #[test]
    fn nestest_auto_mode_reports_pass_when_the_rom_is_available() {
        let Some(dir) = std::env::var_os("NES_TEST_ROMS").filter(|d| !d.is_empty()) else { return };
        let mut a = NesApp::new();
        a.file("nestest.nes", std::fs::read(std::path::Path::new(&dir).join("other/nestest.nes")).unwrap());
        a.key(keys::letter('t'), true, Mods(0));
        a.key(keys::letter('d'), true, Mods(0));
        let mut t = 0.0;
        for _ in 0..30 { frame_at(&mut a, t); t += 17.0; if !a.running { break; } }
        let r = frame_at(&mut a, t);
        assert!(r.texts().iter().any(|t| t.contains("nestest result") && t.contains("PASS")), "{:?}", r.texts());
    }
}
