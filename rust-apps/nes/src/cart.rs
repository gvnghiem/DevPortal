//! iNES (.nes) cartridge files. Only the parts the emulator needs: PRG/CHR data, mapper number, mirroring.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mirroring { Horizontal, Vertical, FourScreen, SingleLo, SingleHi }

#[derive(Clone, Debug)]
pub struct Cart {
    pub prg: Vec<u8>,
    pub chr: Vec<u8>,
    pub chr_is_ram: bool,
    pub mapper: u8,
    pub mirroring: Mirroring,
    pub battery: bool,
    /// Currently selected bank: PRG for mappers 2 and 7, CHR for mapper 3.
    bank: usize,
}

impl Cart {
    /// Parse an iNES file. Errors are plain sentences meant for the user.
    pub fn parse(data: &[u8]) -> Result<Cart, String> {
        if data.len() < 16 || &data[0..4] != b"NES\x1a" { return Err("not an iNES file (.nes) — the header is missing".into()); }
        let (prg_banks, chr_banks, f6, f7) = (data[4] as usize, data[5] as usize, data[6], data[7]);
        if f7 & 0x0c == 0x08 { return Err("NES 2.0 files are not supported yet".into()); }
        if prg_banks == 0 { return Err("the file has no program ROM".into()); }
        let mapper = (f6 >> 4) | (f7 & 0xf0);
        let trainer = if f6 & 4 != 0 { 512 } else { 0 };
        let (prg_len, chr_len) = (prg_banks * 16 * 1024, chr_banks * 8 * 1024);
        let start = 16 + trainer;
        if data.len() < start + prg_len + chr_len { return Err(format!("the file is truncated: header promises {} bytes, found {}", start + prg_len + chr_len, data.len())); }
        let prg = data[start..start + prg_len].to_vec();
        let (chr, chr_is_ram) = if chr_banks == 0 { (vec![0; 8 * 1024], true) } else { (data[start + prg_len..start + prg_len + chr_len].to_vec(), false) };
        let mirroring = if f6 & 8 != 0 { Mirroring::FourScreen } else if f6 & 1 != 0 { Mirroring::Vertical } else { Mirroring::Horizontal };
        Ok(Cart { prg, chr, chr_is_ram, mapper, mirroring, battery: f6 & 2 != 0, bank: 0 })
    }

    pub const SUPPORTED_MAPPERS: &'static str = "0 (NROM), 2 (UxROM), 3 (CNROM), 7 (AxROM)";

    pub fn supported(&self) -> Result<(), String> {
        if matches!(self.mapper, 0 | 2 | 3 | 7) { Ok(()) }
        else { Err(format!("mapper {} is not supported yet (supported: {})", self.mapper, Self::SUPPORTED_MAPPERS)) }
    }

    /// CPU read from $8000-$FFFF.
    pub fn cpu_read(&self, a: u16) -> u8 {
        let off = a as usize & 0x7FFF;
        let i = match self.mapper {
            2 => {
                let banks = self.prg.len() / 0x4000;
                if off < 0x4000 { (self.bank % banks) * 0x4000 + off } else { (banks - 1) * 0x4000 + (off - 0x4000) }
            }
            7 => (self.bank % (self.prg.len() / 0x8000).max(1)) * 0x8000 + off,
            _ => off,                                                   // 0 and 3: 16 KB images mirror into both halves
        };
        self.prg[i % self.prg.len()]
    }

    /// CPU write to $8000-$FFFF: mapper registers (bus conflicts are not modelled).
    pub fn cpu_write(&mut self, _a: u16, v: u8) {
        match self.mapper {
            2 => self.bank = (v & 0x0F) as usize,
            3 => self.bank = (v & 0x03) as usize,
            7 => { self.bank = (v & 0x07) as usize; self.mirroring = if v & 0x10 != 0 { Mirroring::SingleHi } else { Mirroring::SingleLo }; }
            _ => {}
        }
    }

    /// PPU pattern-table read ($0000-$1FFF).
    pub fn chr_read(&self, a: u16) -> u8 {
        let base = if self.mapper == 3 { (self.bank % (self.chr.len() / 0x2000).max(1)) * 0x2000 } else { 0 };
        self.chr[(base + (a as usize & 0x1FFF)) % self.chr.len()]
    }

    pub fn chr_write(&mut self, a: u16, v: u8) {
        if self.chr_is_ram { let n = self.chr.len(); self.chr[(a as usize & 0x1FFF) % n] = v; }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn image(prg_banks: u8, chr_banks: u8, f6: u8, f7: u8) -> Vec<u8> {
        let mut v = vec![b'N', b'E', b'S', 0x1a, prg_banks, chr_banks, f6, f7, 0, 0, 0, 0, 0, 0, 0, 0];
        if f6 & 4 != 0 { v.extend(std::iter::repeat_n(0xEE, 512)); }
        v.extend((0..prg_banks as usize * 16384).map(|i| (i % 251) as u8));
        v.extend((0..chr_banks as usize * 8192).map(|i| (i % 241) as u8));
        v
    }

    #[test]
    fn parses_header_fields() {
        let c = Cart::parse(&image(2, 1, 0x01, 0x00)).unwrap();
        assert_eq!((c.prg.len(), c.chr.len(), c.mapper, c.mirroring, c.chr_is_ram), (32768, 8192, 0, Mirroring::Vertical, false));
        let c = Cart::parse(&image(1, 0, 0x12, 0x40)).unwrap();
        assert_eq!((c.mapper, c.chr_is_ram, c.chr.len(), c.battery), (0x41, true, 8192, true));
    }

    #[test]
    fn skips_a_trainer() {
        let c = Cart::parse(&image(1, 1, 0x04, 0)).unwrap();
        assert_eq!(c.prg[0], 0, "first PRG byte is after the 512-byte trainer");
        assert_eq!(c.prg[1], 1);
    }

    #[test]
    fn rejects_bad_files_with_clear_messages() {
        assert!(Cart::parse(b"hello").unwrap_err().contains("iNES"));
        let mut bad = image(1, 1, 0, 0); bad[0] = b'X';
        assert!(Cart::parse(&bad).is_err());
        let mut short = image(2, 1, 0, 0); short.truncate(1000);
        assert!(Cart::parse(&short).unwrap_err().contains("truncated"));
        assert!(Cart::parse(&image(0, 1, 0, 0)).unwrap_err().contains("no program"));
        assert!(Cart::parse(&image(1, 1, 0, 0x08)).unwrap_err().contains("2.0"));
    }

    #[test]
    fn unsupported_mappers_are_reported_and_supported_ones_pass() {
        let c = Cart::parse(&image(1, 1, 0x10, 0)).unwrap();
        let e = c.supported().unwrap_err();
        assert!(e.contains("mapper 1") && e.contains("UxROM"), "{e}");
        for m in [0u8, 2, 3, 7] { assert!(Cart::parse(&image(2, 1, m << 4, 0)).unwrap().supported().is_ok(), "mapper {m}"); }
    }

    /// 8 banks of 16 KB where every byte of bank n is n.
    fn banked(mapper: u8, banks: u8) -> Cart {
        let mut c = Cart::parse(&image(banks, 1, mapper << 4, 0)).unwrap();
        for (i, b) in c.prg.iter_mut().enumerate() { *b = (i / 0x4000) as u8; }
        c
    }

    #[test]
    fn uxrom_switches_the_low_half_and_fixes_the_last_bank_high() {
        let mut c = banked(2, 8);
        assert_eq!((c.cpu_read(0x8000), c.cpu_read(0xC000), c.cpu_read(0xFFFF)), (0, 7, 7));
        c.cpu_write(0x8000, 3);
        assert_eq!((c.cpu_read(0x8000), c.cpu_read(0xBFFF), c.cpu_read(0xC000)), (3, 3, 7));
        c.cpu_write(0x8000, 0x0F);                                       // out-of-range bank wraps instead of panicking
        assert_eq!(c.cpu_read(0x8000), 7);
    }

    #[test]
    fn cnrom_switches_chr_banks() {
        let mut c = Cart::parse(&image(2, 4, 0x30, 0)).unwrap();
        for (i, b) in c.chr.iter_mut().enumerate() { *b = (i / 0x2000) as u8; }
        assert_eq!(c.chr_read(0x0000), 0);
        c.cpu_write(0x8000, 2); assert_eq!((c.chr_read(0), c.chr_read(0x1FFF)), (2, 2));
        c.cpu_write(0x8000, 7); assert_eq!(c.chr_read(0), 3, "bank number wraps to the 4 banks present");
    }

    #[test]
    fn axrom_switches_32k_and_selects_the_single_screen() {
        let mut c = Cart::parse(&image(8, 0, 0x70, 0)).unwrap();
        for (i, b) in c.prg.iter_mut().enumerate() { *b = (i / 0x8000) as u8; }
        assert_eq!((c.cpu_read(0x8000), c.cpu_read(0xFFFF)), (0, 0));
        c.cpu_write(0x8000, 0x12);
        assert_eq!((c.cpu_read(0x8000), c.cpu_read(0xFFFF), c.mirroring), (2, 2, Mirroring::SingleHi));
        c.cpu_write(0x8000, 0x01); assert_eq!(c.mirroring, Mirroring::SingleLo);
    }

    #[test]
    fn chr_ram_is_writable_and_chr_rom_is_not() {
        let mut ram = Cart::parse(&image(1, 0, 0, 0)).unwrap();
        ram.chr_write(0x0123, 9); assert_eq!(ram.chr_read(0x0123), 9);
        let mut rom = Cart::parse(&image(1, 1, 0, 0)).unwrap();
        let before = rom.chr_read(0x0123); rom.chr_write(0x0123, before.wrapping_add(1)); assert_eq!(rom.chr_read(0x0123), before);
    }
}
