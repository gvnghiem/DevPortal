// devportal-app: nes
//! NES emulator, step 2 of 3: you can play. Cartridge loader, 6502 CPU, dot-stepped PPU (background, sprites,
//! scrolling, sprite-0 hit, NMI), controller 1 on the keyboard, mappers 0 / 2 / 3 / 7. No sound yet (step 3,
//! together with MMC1 and MMC3). Open a .nes file you own (click, or drop one on the canvas).
//!
//! Keys: arrows · X = A · Z = B · Enter = Start · Shift or Tab = Select.
//! Emulator: Space pause · R reset · O open another ROM · D debug view (CPU registers, RAM map) · S step one
//! instruction · T run nestest in its no-picture "automation" mode.
pub mod bus;
pub mod cart;
pub mod cpu;
pub mod ppu;
pub mod system;

use bus::pad;
use cart::{Cart, Mirroring};
use cpu::Cpu;
use dp::{keys, App, Cursor, Gfx, Mods, Pointer, PointerKind, Rgba};
use system::Nes;

/// NTSC: 60.0988 frames per second.
const FRAME_MS: f64 = 1000.0 / 60.0988;
/// nestest's last instruction (an RTS) is at $C66E; reaching it means every check ran.
const NESTEST_END: u16 = 0xC66E;
const BG: Rgba = Rgba::rgb(14, 15, 22);
const TEXT: Rgba = Rgba::rgb(222, 228, 242);
const DIM: Rgba = Rgba::rgb(135, 145, 170);
const ACCENT: Rgba = Rgba::rgb(255, 196, 61);
const OK: Rgba = Rgba::rgb(110, 220, 140);
const BAD: Rgba = Rgba::rgb(255, 120, 120);

pub struct NesApp {
    w: f32, h: f32,
    nes: Option<Nes>,
    name: String,
    running: bool,
    error: Option<String>,
    want_picker: bool,
    debug: bool,
    auto: bool,
    pad: u8,
    last_t: Option<f64>,
    acc: f64,
}

impl NesApp {
    pub fn new() -> Self {
        NesApp { w: 900.0, h: 600.0, nes: None, name: String::new(), running: false, error: None, want_picker: false, debug: false, auto: false, pad: 0, last_t: None, acc: 0.0 }
    }

    fn load(&mut self, name: &str, data: &[u8]) {
        match Cart::parse(data).and_then(|c| c.supported().map(|_| c)) {
            Ok(cart) => {
                self.nes = Some(Nes::new(cart));
                self.name = name.to_string();
                self.error = None; self.running = true; self.auto = false;
                self.acc = FRAME_MS; self.last_t = None;                 // draw the first frame right away
            }
            Err(e) => self.error = Some(format!("{name}: {e}")),
        }
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
        nes.bus.pad = self.pad;
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

    fn draw_prompt(&self, g: &mut dyn Gfx) {
        let (cx, cy) = (self.w / 2.0, self.h / 2.0);
        g.text("NES emulator", cx - 70.0, cy - 90.0, 24.0, TEXT);
        g.rect(cx - 230.0, cy - 60.0, 460.0, 120.0, Rgba::rgba(255, 255, 255, 14), true);
        g.rect(cx - 230.0, cy - 60.0, 460.0, 120.0, ACCENT, false);
        g.text("Click to open a .nes ROM — or drop one here", cx - 190.0, cy - 8.0, 16.0, TEXT);
        g.text(&format!("Supported mappers: {}. Use a ROM you own.", Cart::SUPPORTED_MAPPERS), cx - 214.0, cy + 18.0, 12.0, DIM);
        g.text("Arrows · X = A · Z = B · Enter = Start · Shift = Select", cx - 190.0, cy + 90.0, 13.0, DIM);
        if let Some(e) = &self.error { g.text(e, 24.0, self.h - 24.0, 13.0, BAD); }
    }

    fn draw_game(&self, g: &mut dyn Gfx, n: &Nes) {
        let avail_h = self.h - 34.0;
        let fit = (self.w / ppu::WIDTH as f32).min(avail_h / ppu::HEIGHT as f32);
        let scale = if fit >= 1.0 { fit.floor() } else { fit.max(0.1) };           // whole-number scaling keeps pixels crisp
        let (dw, dh) = (ppu::WIDTH as f32 * scale, ppu::HEIGHT as f32 * scale);
        g.blit(&n.bus.ppu.fb, ppu::WIDTH as u32, ppu::HEIGHT as u32, (((self.w - dw) / 2.0).floor(), ((avail_h - dh) / 2.0).floor().max(0.0), dw, dh));
        let status = if !self.running { "paused" } else { "" };
        g.text(&format!("{}  {}", self.name, status), 12.0, self.h - 12.0, 12.0, DIM);
        let hint = "arrows · X A · Z B · Enter Start · Shift Select · Space pause · R reset · O open · D debug";
        g.text(hint, self.w - hint.len() as f32 * 5.9 - 12.0, self.h - 12.0, 11.0, DIM);
        if n.cpu.halted { g.text("CPU locked up (KIL opcode) — press R to reset", 12.0, 22.0, 14.0, BAD); }
        if let Some(e) = &self.error { g.text(e, 12.0, 40.0, 13.0, BAD); }
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
        self.advance(t);
        g.clear(BG);
        match self.nes.as_ref() {
            None => self.draw_prompt(g),
            Some(n) if self.debug => self.draw_debug(g, n),
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
            if let Some(n) = self.nes.as_mut() { n.bus.pad = self.pad; }
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
            _ => {}
        }
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
        assert_eq!((w, h), (768.0, 720.0), "3x: the largest whole scale that fits 1000x766");
        assert_eq!((x, y), (116.0, 23.0));
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
