//! The CPU's address space: RAM, PPU registers, OAM DMA, controller 1, PRG-RAM and the cartridge.
//! The APU lives here too ($4000-$4017 other than the pads and $4014).
use crate::apu::Apu;
use crate::cart::Cart;
use crate::cpu::Bus;
use crate::ppu::Ppu;

/// Controller bit order (the order the console shifts them out).
pub mod pad {
    pub const A: u8 = 1;
    pub const B: u8 = 2;
    pub const SELECT: u8 = 4;
    pub const START: u8 = 8;
    pub const UP: u8 = 16;
    pub const DOWN: u8 = 32;
    pub const LEFT: u8 = 64;
    pub const RIGHT: u8 = 128;
}

pub struct NesBus {
    pub ram: [u8; 0x800],
    pub prg_ram: [u8; 0x2000],
    pub cart: Cart,
    pub ppu: Ppu,
    pub apu: Apu,
    /// Buttons currently held on controllers 1 and 2 (see [`pad`]).
    pub pad: u8,
    pub pad2: u8,
    shift: u8,
    shift2: u8,
    strobe: bool,
    dma_stall: u32,
    /// Set by the system before each instruction: OAM DMA takes one extra cycle on odd CPU cycles.
    pub odd_cycle: bool,
}

impl NesBus {
    pub fn new(cart: Cart) -> Self {
        NesBus { ram: [0; 0x800], prg_ram: [0; 0x2000], cart, ppu: Ppu::new(), apu: Apu::default(), pad: 0, pad2: 0, shift: 0, shift2: 0, strobe: false, dma_stall: 0, odd_cycle: false }
    }

    /// Read without any side effects (for debug views and tests). PPU/IO registers read as 0.
    pub fn peek(&self, a: u16) -> u8 {
        match a {
            0x0000..=0x1FFF => self.ram[a as usize & 0x7FF],
            0x6000..=0x7FFF => self.prg_ram[a as usize - 0x6000],
            0x8000..=0xFFFF => self.cart.cpu_read(a),
            _ => 0,
        }
    }

    /// Cycles the CPU must sit out after an OAM DMA (taken once).
    pub fn take_dma_stall(&mut self) -> u32 { std::mem::take(&mut self.dma_stall) }

    /// Opposite directions can't both be pressed on a real pad; some games glitch if they are.
    fn clean(mut p: u8) -> u8 {
        if p & (pad::LEFT | pad::RIGHT) == pad::LEFT | pad::RIGHT { p &= !(pad::LEFT | pad::RIGHT); }
        if p & (pad::UP | pad::DOWN) == pad::UP | pad::DOWN { p &= !(pad::UP | pad::DOWN); }
        p
    }

    /// Shift one bit out of a controller (or return the A button continuously while strobing).
    fn serial(strobe: bool, held: u8, shift: &mut u8) -> u8 {
        let bit = if strobe { Self::clean(held) & 1 } else { let b = *shift & 1; *shift = *shift >> 1 | 0x80; b };
        bit | 0x40
    }
}

impl Bus for NesBus {
    fn read(&mut self, a: u16) -> u8 {
        match a {
            0x2000..=0x3FFF => self.ppu.read_reg(a, &self.cart),
            0x4015 => self.apu.read_status(),
            0x4016 => Self::serial(self.strobe, self.pad, &mut self.shift),
            0x4017 => Self::serial(self.strobe, self.pad2, &mut self.shift2),
            _ => self.peek(a),
        }
    }

    fn write(&mut self, a: u16, v: u8) {
        match a {
            0x0000..=0x1FFF => self.ram[a as usize & 0x7FF] = v,
            0x2000..=0x3FFF => self.ppu.write_reg(a, v, &mut self.cart),
            0x4014 => {
                let base = (v as u16) << 8;
                let page: [u8; 256] = std::array::from_fn(|i| self.peek(base + i as u16));
                self.ppu.dma(&page);
                self.dma_stall = 513 + self.odd_cycle as u32;
            }
            0x4016 => { self.strobe = v & 1 != 0; if self.strobe { self.shift = Self::clean(self.pad); self.shift2 = Self::clean(self.pad2); } }
            0x4000..=0x4013 | 0x4015 | 0x4017 => self.apu.write(a, v),
            0x6000..=0x7FFF => self.prg_ram[a as usize - 0x6000] = v,
            0x8000..=0xFFFF => self.cart.cpu_write(a, v),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cart::{Cart, Mirroring};

    fn bus(prg_banks: usize) -> NesBus {
        NesBus::new(Cart::parse(&{
            let mut v = vec![b'N', b'E', b'S', 0x1a, prg_banks as u8, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
            for i in 0..prg_banks * 16384 { v.push((i / 16384) as u8 + 1); }
            v.extend(vec![0; 8192]); v
        }).unwrap())
    }
    #[allow(dead_code)] fn _m(_: Mirroring) {}

    #[test]
    fn ram_is_mirrored_every_2k() {
        let mut b = bus(1);
        b.write(0x0005, 0xAB);
        assert_eq!((b.read(0x0805), b.read(0x1005), b.read(0x1805)), (0xAB, 0xAB, 0xAB));
    }

    #[test]
    fn a_16k_rom_is_mirrored_into_both_halves() {
        let mut b = bus(1);
        assert_eq!((b.read(0x8000), b.read(0xC000)), (1, 1));
        let mut b = bus(2);
        assert_eq!((b.read(0x8000), b.read(0xC000)), (1, 2));
    }

    #[test]
    fn prg_ram_reads_back_and_rom_ignores_writes() {
        let mut b = bus(1);
        b.write(0x6000, 0x42); b.write(0x8000, 0x99);
        assert_eq!((b.read(0x6000), b.read(0x8000)), (0x42, 1));
    }

    #[test]
    fn ppu_registers_are_mirrored_through_3fff() {
        let mut b = bus(1);
        b.write(0x2006, 0x3F); b.write(0x2006, 0x01); b.write(0x2007, 0x2A);
        b.write(0x3F06, 0x3F); b.write(0x3F06, 0x01);                       // $3F06 is $2006 again
        assert_eq!(b.read(0x3FFF) & 0x3F, 0x2A);
    }

    #[test]
    fn controller_shifts_out_a_b_select_start_up_down_left_right() {
        let mut b = bus(1);
        b.pad = pad::A | pad::START | pad::RIGHT;
        b.write(0x4016, 1); b.write(0x4016, 0);
        let bits: Vec<u8> = (0..8).map(|_| b.read(0x4016) & 1).collect();
        assert_eq!(bits, [1, 0, 0, 1, 0, 0, 0, 1]);
        assert_eq!(b.read(0x4016) & 1, 1, "after 8 reads a real pad returns 1s");
        assert_eq!(b.read(0x4016) & 0x40, 0x40, "open-bus bit");
    }

    #[test]
    fn while_strobe_is_high_the_a_button_is_returned_continuously() {
        let mut b = bus(1);
        b.pad = pad::A; b.write(0x4016, 1);
        assert_eq!((b.read(0x4016) & 1, b.read(0x4016) & 1), (1, 1));
    }

    #[test]
    fn controller_two_is_read_at_4017_and_shares_the_strobe() {
        let mut b = bus(1);
        b.pad = pad::A; b.pad2 = pad::B | pad::DOWN;
        b.write(0x4016, 1); b.write(0x4016, 0);
        let p1: Vec<u8> = (0..8).map(|_| b.read(0x4016) & 1).collect();
        let p2: Vec<u8> = (0..8).map(|_| b.read(0x4017) & 1).collect();
        assert_eq!(p1, [1, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(p2, [0, 1, 0, 0, 0, 1, 0, 0]);
    }

    #[test]
    fn apu_registers_and_status_are_reachable_from_the_cpu() {
        let mut b = bus(1);
        b.write(0x4015, 0x01); b.write(0x4003, 0x08);
        assert_eq!(b.read(0x4015) & 1, 1, "length counter is running");
        b.write(0x4015, 0x00);
        assert_eq!(b.read(0x4015) & 1, 0);
        b.write(0x4017, 0x40); assert!(!b.apu.irq());
    }

    #[test]
    fn opposite_directions_are_ignored() {
        let mut b = bus(1);
        b.pad = pad::LEFT | pad::RIGHT | pad::UP; b.write(0x4016, 1); b.write(0x4016, 0);
        let bits: Vec<u8> = (0..8).map(|_| b.read(0x4016) & 1).collect();
        assert_eq!(bits, [0, 0, 0, 0, 1, 0, 0, 0]);
    }

    #[test]
    fn oam_dma_copies_a_page_and_stalls_the_cpu() {
        let mut b = bus(1);
        for i in 0..256 { b.write(0x0200 + i, i as u8 ^ 0x5A); }
        b.write(0x4014, 0x02);
        assert_eq!((b.ppu.oam[0], b.ppu.oam[255]), (0x5A, 0xFF ^ 0x5A));
        assert_eq!(b.take_dma_stall(), 513);
        b.odd_cycle = true; b.write(0x4014, 0x02); assert_eq!(b.take_dma_stall(), 514);
        assert_eq!(b.take_dma_stall(), 0, "taken once");
    }
}
