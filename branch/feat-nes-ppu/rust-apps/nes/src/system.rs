//! CPU + PPU wired together. The PPU runs 3 dots per CPU cycle, caught up after every instruction.
use crate::bus::NesBus;
use crate::cart::Cart;
use crate::cpu::{Bus, Cpu};

pub struct Nes { pub cpu: Cpu, pub bus: NesBus }

impl Nes {
    pub fn new(cart: Cart) -> Self {
        let mut n = Nes { cpu: Cpu::new(), bus: NesBus::new(cart) };
        n.cpu.reset(&mut n.bus);
        n
    }

    pub fn reset(&mut self) {
        self.bus.ram = [0; 0x800];
        self.cpu.reset(&mut self.bus);
    }

    /// One instruction (or NMI entry) plus the PPU time that passes meanwhile; returns CPU cycles used.
    pub fn step(&mut self) -> u32 {
        self.bus.odd_cycle = self.cpu.cycles & 1 == 1;
        let mut cycles = if self.bus.ppu.take_nmi() { self.cpu.nmi(&mut self.bus) } else { self.cpu.step(&mut self.bus) };
        let stall = self.bus.take_dma_stall();
        self.cpu.cycles += stall as u64;
        cycles += stall;
        for _ in 0..cycles * 3 { self.bus.ppu.tick(&mut self.bus.cart); }
        cycles
    }

    /// Run until the PPU finishes a frame. Stops early (returning true) when the CPU reaches `stop_pc`.
    pub fn run_frame(&mut self, stop_pc: Option<u16>) -> bool {
        self.bus.ppu.frame_ready = false;
        while !self.bus.ppu.frame_ready {
            if Some(self.cpu.pc) == stop_pc { return true; }
            self.step();
        }
        false
    }

    pub fn peek(&self, a: u16) -> u8 { self.bus.peek(a) }
    pub fn read(&mut self, a: u16) -> u8 { self.bus.read(a) }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 16 KB NROM whose reset code is `code` at $8000 and whose NMI handler is `nmi` at $9000.
    fn nes(code: &[u8], nmi: &[u8]) -> Nes {
        let mut v = vec![b'N', b'E', b'S', 0x1a, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        let mut prg = vec![0xEA; 16384];
        prg[..code.len()].copy_from_slice(code);
        prg[0x1000..0x1000 + nmi.len()].copy_from_slice(nmi);
        prg[0x3FFA] = 0x00; prg[0x3FFB] = 0x90;           // NMI -> $9000
        prg[0x3FFC] = 0x00; prg[0x3FFD] = 0x80;           // reset -> $8000
        v.extend(prg); v.extend(vec![0; 8192]);
        Nes::new(Cart::parse(&v).unwrap())
    }

    #[test]
    fn a_frame_takes_about_29780_cpu_cycles() {
        let mut n = nes(&[0x4C, 0x00, 0x80], &[]);
        n.run_frame(None); let c0 = n.cpu.cycles;
        n.run_frame(None);
        let d = n.cpu.cycles - c0;
        assert!((29_700..=29_800).contains(&d), "{d}");
    }

    #[test]
    fn nmi_runs_the_handler_once_per_frame() {
        // reset: enable NMI, spin.  nmi: INC $10; RTI
        let mut n = nes(&[0xA9, 0x80, 0x8D, 0x00, 0x20, 0x4C, 0x05, 0x80], &[0xE6, 0x10, 0x40]);
        for _ in 0..5 { n.run_frame(None); }
        assert!((4..=5).contains(&n.peek(0x10)), "handler ran {} times in 5 frames", n.peek(0x10));
    }

    #[test]
    fn polling_vblank_through_2002_sees_each_frame() {
        // loop: BIT $2002; BPL loop; INC $11; JMP loop   (classic wait-for-vblank)
        let mut n = nes(&[0x2C, 0x02, 0x20, 0x10, 0xFB, 0xE6, 0x11, 0x4C, 0x00, 0x80], &[]);
        for _ in 0..10 { n.run_frame(None); }
        assert!((9..=10).contains(&n.peek(0x11)), "{}", n.peek(0x11));
    }

    #[test]
    fn oam_dma_adds_513_cycles() {
        let mut n = nes(&[0xA9, 0x02, 0x8D, 0x14, 0x40, 0xEA], &[]);
        n.step();
        let before = n.cpu.cycles;
        n.step();                                            // STA $4014
        assert!(n.cpu.cycles - before >= 513 + 4);
    }

    #[test]
    fn run_frame_stops_at_the_requested_pc() {
        let mut n = nes(&[0xEA, 0xEA, 0xEA, 0x4C, 0x03, 0x80], &[]);
        assert!(n.run_frame(Some(0x8003)));
        assert_eq!(n.cpu.pc, 0x8003);
    }
}
