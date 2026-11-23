//! iNES (.nes) cartridge files. Only the parts the emulator needs: PRG/CHR data, mapper number, mirroring.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mirroring { Horizontal, Vertical, FourScreen }

#[derive(Clone, Debug)]
pub struct Cart {
    pub prg: Vec<u8>,
    pub chr: Vec<u8>,
    pub chr_is_ram: bool,
    pub mapper: u8,
    pub mirroring: Mirroring,
    pub battery: bool,
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
        Ok(Cart { prg, chr, chr_is_ram, mapper, mirroring, battery: f6 & 2 != 0 })
    }

    pub fn supported(&self) -> Result<(), String> {
        if self.mapper == 0 { Ok(()) } else { Err(format!("mapper {} is not supported yet (only mapper 0 / NROM so far)", self.mapper)) }
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
    fn unsupported_mappers_are_reported() {
        let c = Cart::parse(&image(1, 1, 0x10, 0)).unwrap();
        assert!(c.supported().unwrap_err().contains("mapper 1"));
        assert!(Cart::parse(&image(1, 1, 0, 0)).unwrap().supported().is_ok());
    }
}
