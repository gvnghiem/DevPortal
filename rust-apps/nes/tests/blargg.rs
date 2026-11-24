//! Public test ROMs (github.com/christopherpow/nes-test-roms) run headless. They report through PRG-RAM:
//! $6001-$6003 = DE B0 61 once the protocol is active, $6000 = 0x80 while running and the result code afterwards,
//! text from $6004. Skipped unless NES_TEST_ROMS points at a checkout (CI clones it).
use nes::cart::Cart;
use nes::system::Nes;
use std::path::PathBuf;

fn dir() -> Option<PathBuf> { std::env::var_os("NES_TEST_ROMS").filter(|d| !d.is_empty()).map(PathBuf::from) }

/// Run a ROM for up to `max_frames`; Some((status, text)) when it finished and reported.
fn run(rel: &str, max_frames: u32) -> Option<(u8, String)> {
    let path = dir()?.join(rel);
    let mut nes = Nes::new(Cart::parse(&std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap());
    let mut reset_at = None;
    for f in 0..max_frames {
        nes.run_frame(None);
        let sig = (nes.peek(0x6001), nes.peek(0x6002), nes.peek(0x6003)) == (0xDE, 0xB0, 0x61);
        match (sig, nes.peek(0x6000)) {
            (true, 0x81) if reset_at.is_none() => reset_at = Some(f + 6),          // "press reset in ~100 ms"
            (true, s) if s < 0x80 => {
                let text: String = (0x6004u16..0x7000).map(|a| nes.peek(a)).take_while(|&b| b != 0).map(|b| b as char).collect();
                return Some((s, text));
            }
            _ => {}
        }
        if reset_at == Some(f) { nes.reset(); reset_at = None; }
    }
    Some((0xFF, "did not finish".into()))
}

macro_rules! rom_tests {
    ($($name:ident: $path:expr, $frames:expr;)*) => { $(
        #[test]
        fn $name() {
            let Some((status, text)) = run($path, $frames) else { eprintln!("NES_TEST_ROMS not set: skipping {}", $path); return };
            assert_eq!(status, 0, "{}: {}", $path, text.trim());
        }
    )* };
}

// Known gaps (not asserted): ppu_vbl_nmi 02, 05-08, 10 and vbl_nmi_timing need the CPU and PPU interleaved per cycle
// (this core catches the PPU up after each instruction); oam_stress, ppu_open_bus, ppu_read_buffer test hardware
// quirks no game relies on. apu_test 4-jitter, 5-len_timing, 6-irq_flag_timing (and the apu_reset power-on ones) need
// cycle-exact frame-counter timing and register power-up state.
rom_tests! {
    ppu_vbl_basics: "ppu_vbl_nmi/rom_singles/01-vbl_basics.nes", 900;
    ppu_vbl_clear_time: "ppu_vbl_nmi/rom_singles/03-vbl_clear_time.nes", 900;
    ppu_nmi_control: "ppu_vbl_nmi/rom_singles/04-nmi_control.nes", 900;
    ppu_even_odd_frames: "ppu_vbl_nmi/rom_singles/09-even_odd_frames.nes", 900;
    oam_read: "oam_read/oam_read.nes", 900;
    apu_len_ctr: "apu_test/rom_singles/1-len_ctr.nes", 900;
    apu_len_table: "apu_test/rom_singles/2-len_table.nes", 900;
    apu_irq_flag: "apu_test/rom_singles/3-irq_flag.nes", 900;
    apu_dmc_basics: "apu_test/rom_singles/7-dmc_basics.nes", 900;
    apu_dmc_rates: "apu_test/rom_singles/8-dmc_rates.nes", 900;
}
