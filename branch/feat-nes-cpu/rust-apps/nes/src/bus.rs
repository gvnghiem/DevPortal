//! The CPU's address space. PR 1 scope: RAM, cartridge PRG (NROM), 8 KB PRG-RAM; PPU/APU/IO are stubs.
use crate::cart::Cart;
use crate::cpu::Bus;

pub struct NesBus {
    pub ram: [u8; 0x800],
    pub prg_ram: [u8; 0x2000],
    pub cart: Cart,
}

impl NesBus {
    pub fn new(cart: Cart) -> Self { NesBus { ram: [0; 0x800], prg_ram: [0; 0x2000], cart } }

    /// Read without any side effects (for debug views and tests).
    pub fn peek(&self, a: u16) -> u8 {
        match a {
            0x0000..=0x1FFF => self.ram[a as usize & 0x7FF],
            0x6000..=0x7FFF => self.prg_ram[a as usize - 0x6000],
            0x8000..=0xFFFF => { let i = a as usize - 0x8000; self.cart.prg[i % self.cart.prg.len()] }
            _ => 0,
        }
    }
}

impl Bus for NesBus {
    fn read(&mut self, a: u16) -> u8 { self.peek(a) }
    fn write(&mut self, a: u16, v: u8) {
        match a {
            0x0000..=0x1FFF => self.ram[a as usize & 0x7FF] = v,
            0x6000..=0x7FFF => self.prg_ram[a as usize - 0x6000] = v,
            _ => {}                                                // PPU / APU / mapper registers arrive in later PRs
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cart::{Cart, Mirroring};

    fn bus(prg_banks: usize) -> NesBus {
        NesBus::new(Cart { prg: (0..prg_banks * 16384).map(|i| (i / 16384) as u8 + 1).collect(), chr: vec![0; 8192], chr_is_ram: true, mapper: 0, mirroring: Mirroring::Horizontal, battery: false })
    }

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
}
