// devportal-app: nes
//! NES emulator, step 1 of 3: cartridge loading + a 6502 that matches the nestest reference log
//! cycle-for-cycle. There is no picture yet (the PPU is step 2) — this build is a debug view: open a ROM,
//! watch the CPU registers and a map of the 2 KB of RAM, and run test ROMs that report through PRG-RAM.
//!
//! Open a .nes file (click, or drop one on the canvas).  Space run/pause · S step · R reset · A nestest auto-mode.
pub mod bus;
pub mod cart;
pub mod cpu;

use bus::NesBus;
use cart::{Cart, Mirroring};
use cpu::Cpu;
use dp::{keys, App, Cursor, Gfx, Mods, Pointer, PointerKind, Rgba};

const CYCLES_PER_FRAME: u64 = 29_781;
/// nestest's last instruction (an RTS) is at $C66E; reaching it means every check ran.
const NESTEST_END: u16 = 0xC66E;
const BG: Rgba = Rgba::rgb(20, 22, 32);
const TEXT: Rgba = Rgba::rgb(222, 228, 242);
const DIM: Rgba = Rgba::rgb(135, 145, 170);
const ACCENT: Rgba = Rgba::rgb(255, 196, 61);
const OK: Rgba = Rgba::rgb(110, 220, 140);
const BAD: Rgba = Rgba::rgb(255, 120, 120);

struct Machine { cpu: Cpu, bus: NesBus, name: String, auto: bool }

pub struct NesApp {
    w: f32, h: f32,
    m: Option<Machine>,
    running: bool,
    error: Option<String>,
    want_picker: bool,
}

impl NesApp {
    pub fn new() -> Self { NesApp { w: 900.0, h: 600.0, m: None, running: false, error: None, want_picker: false } }

    fn load(&mut self, name: &str, data: &[u8]) {
        match Cart::parse(data).and_then(|c| c.supported().map(|_| c)) {
            Ok(cart) => {
                let mut bus = NesBus::new(cart);
                let mut cpu = Cpu::new();
                cpu.reset(&mut bus);
                self.m = Some(Machine { cpu, bus, name: name.to_string(), auto: false });
                self.error = None;
                self.running = true;
            }
            Err(e) => self.error = Some(format!("{name}: {e}")),
        }
    }

    /// Run about one video frame's worth of CPU time.
    fn run_frame(&mut self) {
        let Some(m) = self.m.as_mut() else { return };
        let target = m.cpu.cycles + CYCLES_PER_FRAME;
        while m.cpu.cycles < target && !m.cpu.halted {
            if m.auto && m.cpu.pc == NESTEST_END { self.running = false; return; }
            m.cpu.step(&mut m.bus);
        }
    }

    fn reset(&mut self) {
        if let Some(m) = self.m.as_mut() { m.bus.ram = [0; 0x800]; m.auto = false; m.cpu.reset(&mut m.bus); }
    }

    /// nestest's "automation" entry: jump straight to $C000, which runs every test without the PPU.
    fn nestest_auto(&mut self) {
        if let Some(m) = self.m.as_mut() { m.bus.ram = [0; 0x800]; m.cpu = Cpu::new(); m.cpu.pc = 0xC000; m.cpu.cycles = 7; m.auto = true; self.running = true; }
    }

    /// Text the test ROM left at $6004 (blargg's protocol: signature DE B0 61 at $6001).
    fn test_output(m: &Machine) -> Option<(u8, String)> {
        if (m.bus.peek(0x6001), m.bus.peek(0x6002), m.bus.peek(0x6003)) != (0xDE, 0xB0, 0x61) { return None; }
        let text: String = (0x6004u16..0x7000).map(|a| m.bus.peek(a)).take_while(|&b| b != 0).map(|b| if b == b'\n' || (32..127).contains(&b) { b as char } else { '?' }).collect();
        Some((m.bus.peek(0x6000), text))
    }

    fn draw(&self, g: &mut dyn Gfx) {
        g.clear(BG);
        g.text("NES emulator", 24.0, 40.0, 24.0, TEXT);
        g.text("step 1 of 3: cartridge + 6502 CPU (no picture yet)", 24.0, 62.0, 13.0, DIM);
        let Some(m) = self.m.as_ref() else {
            let (cx, cy) = (self.w / 2.0, self.h / 2.0);
            g.rect(cx - 230.0, cy - 60.0, 460.0, 120.0, Rgba::rgba(255, 255, 255, 14), true);
            g.rect(cx - 230.0, cy - 60.0, 460.0, 120.0, ACCENT, false);
            g.text("Click to open a .nes ROM — or drop one here", cx - 190.0, cy - 8.0, 16.0, TEXT);
            g.text("Mapper 0 (NROM) cartridges only for now. Use a ROM you own.", cx - 190.0, cy + 18.0, 12.0, DIM);
            if let Some(e) = &self.error { g.text(e, 24.0, self.h - 24.0, 13.0, BAD); }
            return;
        };
        let c = &m.bus.cart;
        let mir = match c.mirroring { Mirroring::Horizontal => "horizontal", Mirroring::Vertical => "vertical", Mirroring::FourScreen => "four-screen" };
        let lines = [
            m.name.clone(),
            format!("PRG {} KB · CHR {} KB{} · mapper {} · {} mirroring", c.prg.len() / 1024, c.chr.len() / 1024, if c.chr_is_ram { " (RAM)" } else { "" }, c.mapper, mir),
        ];
        for (i, l) in lines.iter().enumerate() { g.text(l, 24.0, 98.0 + i as f32 * 20.0, if i == 0 { 16.0 } else { 13.0 }, if i == 0 { ACCENT } else { DIM }); }

        let cpu = &m.cpu;
        let flags: String = "NV-BDIZC".chars().enumerate().map(|(i, ch)| if cpu.p & (0x80 >> i) != 0 { ch } else { '.' }).collect();
        let regs = [
            format!("PC  {:04X}", cpu.pc), format!("A   {:02X}", cpu.a), format!("X   {:02X}", cpu.x), format!("Y   {:02X}", cpu.y),
            format!("SP  {:02X}", cpu.sp), format!("P   {:02X}  {}", cpu.p, flags), format!("CYC {}", cpu.cycles),
        ];
        for (i, l) in regs.iter().enumerate() { g.text(l, 24.0, 160.0 + i as f32 * 20.0, 15.0, TEXT); }
        g.text(if cpu.halted { "CPU locked up (KIL opcode) — press R to reset" } else if self.running { "running" } else { "paused" }, 24.0, 318.0, 13.0, if cpu.halted { BAD } else { DIM });

        // RAM map: 2 KB as 64×32 greyscale pixels
        let mut px = Vec::with_capacity(64 * 32 * 4);
        for &b in m.bus.ram.iter() { px.extend_from_slice(&[b, b, b, 255]); }
        g.text("RAM ($0000–$07FF), one pixel per byte", 300.0, 150.0, 12.0, DIM);
        g.blit(&px, 64, 32, (300.0, 160.0, 512.0, 256.0));

        // test-ROM output
        let mut y = 350.0;
        if let Some((status, text)) = Self::test_output(m) {
            let col = match status { 0x80 => DIM, 0 => OK, _ => BAD };
            g.text(&format!("test ROM status ${status:02X}{}", match status { 0x80 => " (running)", 0 => " — passed", _ => " — failed" }), 24.0, y, 14.0, col);
            for l in text.lines().take(12) { y += 17.0; g.text(l, 24.0, y, 12.0, TEXT); }
        } else if m.auto && cpu.pc == NESTEST_END {
            let (r2, r3) = (m.bus.peek(2), m.bus.peek(3));
            g.text(&format!("nestest result  $02={r2:02X}  $03={r3:02X}  {}", if r2 == 0 && r3 == 0 { "— PASS" } else { "— FAIL" }), 24.0, y, 14.0, if r2 == 0 && r3 == 0 { OK } else { BAD });
        }
        g.text("Space run/pause · S step · R reset · A nestest auto-mode · O open another ROM", 24.0, self.h - 24.0, 12.0, DIM);
        if let Some(e) = &self.error { g.text(e, 24.0, self.h - 44.0, 13.0, BAD); }
    }
}

impl Default for NesApp { fn default() -> Self { Self::new() } }

impl App for NesApp {
    fn init(&mut self, w: f32, h: f32) { self.w = w; self.h = h; }
    fn resize(&mut self, w: f32, h: f32) { self.w = w; self.h = h; }

    fn frame(&mut self, g: &mut dyn Gfx, _t: f64) {
        if self.running { self.run_frame(); }
        self.draw(g);
        if std::mem::take(&mut self.want_picker) { g.open_file(); }
        g.cursor(if self.m.is_none() { Cursor::Pointer } else { Cursor::Default });
    }

    fn pointer(&mut self, p: Pointer) {
        // the picker must open inside the click handler, so ask for it right here via the next frame call
        if p.kind == PointerKind::Down && p.buttons & 1 != 0 && self.m.is_none() { self.want_picker = true; }
    }

    fn key(&mut self, code: u32, down: bool, mods: Mods) {
        if !down || mods.ctrl() || mods.meta() { return; }
        match code {
            keys::SPACE => self.running = !self.running,
            x if x == keys::letter('s') => {
                self.running = false;
                if let Some(m) = self.m.as_mut() { m.cpu.step(&mut m.bus); }
            }
            x if x == keys::letter('r') => self.reset(),
            x if x == keys::letter('a') => self.nestest_auto(),
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

    /// A 16 KB NROM image whose reset vector points at `code` (placed at $8000).
    fn rom(code: &[u8]) -> Vec<u8> {
        let mut v = vec![b'N', b'E', b'S', 0x1a, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        let mut prg = vec![0xEA; 16384];                                  // NOP sled
        prg[..code.len()].copy_from_slice(code);
        prg[0x3FFC] = 0x00; prg[0x3FFD] = 0x80;                           // reset -> $8000
        v.extend(prg); v.extend(vec![0; 8192]); v
    }
    fn frame(a: &mut NesApp) -> Recorder { let mut r = Recorder::new(); a.frame(&mut r, 0.0); r }

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
        assert!(frame(&mut a).texts().iter().any(|t| t.contains("mapper 1")));
        assert!(a.m.is_none());
    }

    #[test]
    fn a_loaded_rom_runs_one_frame_of_cpu_time_and_draws_the_ram_map() {
        let mut a = NesApp::new();
        a.file("t.nes", rom(&[0xA9, 0x7F, 0x85, 0x10, 0x4C, 0x04, 0x80]));   // LDA #$7F; STA $10; JMP self
        let r = frame(&mut a);
        let m = a.m.as_ref().unwrap();
        assert_eq!(m.bus.ram[0x10], 0x7F);
        assert!(m.cpu.cycles >= CYCLES_PER_FRAME);
        let blit = r.cmds.iter().find_map(|c| if let Cmd::Blit { sw, sh, pixels, .. } = c { Some((*sw, *sh, pixels.clone())) } else { None }).expect("RAM map");
        assert_eq!((blit.0, blit.1, blit.2.len()), (64, 32, 64 * 32 * 4));
        assert_eq!(&blit.2[0x10 * 4..0x10 * 4 + 4], &[0x7F, 0x7F, 0x7F, 255]);
        assert!(r.texts().iter().any(|t| t.starts_with("PC  8004")));
    }

    #[test]
    fn keys_pause_step_and_reset() {
        let mut a = NesApp::new();
        a.file("t.nes", rom(&[0xE8, 0x4C, 0x00, 0x80]));                   // INX; JMP $8000
        a.key(keys::SPACE, true, Mods(0)); assert!(!a.running);
        let before = a.m.as_ref().unwrap().cpu.cycles;
        a.key(keys::letter('s'), true, Mods(0));
        assert_eq!(a.m.as_ref().unwrap().cpu.x, 1);
        assert!(a.m.as_ref().unwrap().cpu.cycles > before);
        a.key(keys::letter('r'), true, Mods(0));
        assert_eq!((a.m.as_ref().unwrap().cpu.pc, a.m.as_ref().unwrap().cpu.cycles), (0x8000, 7));
    }

    #[test]
    fn a_locked_up_cpu_is_reported_not_spun_on() {
        let mut a = NesApp::new();
        a.file("t.nes", rom(&[0x02]));
        let r = frame(&mut a);
        assert!(r.texts().iter().any(|t| t.contains("locked up")));
    }

    #[test]
    fn blargg_style_test_output_is_shown() {
        let mut a = NesApp::new();
        // LDA #$DE STA $6001 ... then text "ok" at $6004, status $00 at $6000
        let code = [0xA9, 0xDE, 0x8D, 0x01, 0x60, 0xA9, 0xB0, 0x8D, 0x02, 0x60, 0xA9, 0x61, 0x8D, 0x03, 0x60,
                    0xA9, b'o', 0x8D, 0x04, 0x60, 0xA9, b'k', 0x8D, 0x05, 0x60, 0xA9, 0x00, 0x8D, 0x06, 0x60, 0x8D, 0x00, 0x60, 0x4C, 0x20, 0x80];
        a.file("t.nes", rom(&code));
        let r = frame(&mut a);
        let t = r.texts();
        assert!(t.iter().any(|s| s.contains("passed")) && t.contains(&"ok"), "{t:?}");
    }

    #[test]
    fn nestest_auto_mode_reports_pass_when_the_rom_is_available() {
        let Some(dir) = std::env::var_os("NES_TEST_ROMS").filter(|d| !d.is_empty()) else { return };
        let mut a = NesApp::new();
        a.file("nestest.nes", std::fs::read(std::path::Path::new(&dir).join("other/nestest.nes")).unwrap());
        a.key(keys::letter('a'), true, Mods(0));
        for _ in 0..10 { frame(&mut a); if !a.running { break; } }
        let r = frame(&mut a);
        assert!(r.texts().iter().any(|t| t.contains("nestest result") && t.contains("PASS")), "{:?}", r.texts());
    }
}
