//! The NES picture processor (2C02), stepped one dot at a time: background with loopy scrolling,
//! sprites (8×8 and 8×16, flips, priority), sprite-0 hit, sprite overflow, vblank + NMI edge, odd-frame skip.
//! Not modelled: colour emphasis, mid-scanline sprite evaluation quirks, open-bus decay.
use crate::cart::{Cart, Mirroring};

pub const WIDTH: usize = 256;
pub const HEIGHT: usize = 240;

/// The common 2C02 colour table (RGB).
pub const PALETTE: [u32; 64] = [
    0x666666, 0x002A88, 0x1412A7, 0x3B00A4, 0x5C007E, 0x6E0040, 0x6C0600, 0x561D00, 0x333500, 0x0B4800, 0x005200, 0x004F08, 0x00404D, 0x000000, 0x000000, 0x000000,
    0xADADAD, 0x155FD9, 0x4240FF, 0x7527FE, 0xA01ACC, 0xB71E7B, 0xB53120, 0x994E00, 0x6B6D00, 0x388700, 0x0C9300, 0x008F32, 0x007C8D, 0x000000, 0x000000, 0x000000,
    0xFFFEFF, 0x64B0FF, 0x9290FF, 0xC676FF, 0xF36AFF, 0xFE6ECC, 0xFE8170, 0xEA9E22, 0xBCBE00, 0x88D800, 0x5CE430, 0x45E082, 0x48CDDE, 0x4F4F4F, 0x000000, 0x000000,
    0xFFFEFF, 0xC0DFFF, 0xD3D2FF, 0xE8C8FF, 0xFBC2FF, 0xFEC4EA, 0xFECCC5, 0xF7D8A5, 0xE4E594, 0xCFEF96, 0xBDF4AB, 0xB3F3CC, 0xB5EBF2, 0xB8B8B8, 0x000000, 0x000000,
];

#[derive(Clone, Copy, Default)]
struct Sprite { x: u8, lo: u8, hi: u8, attr: u8 }

pub struct Ppu {
    pub ctrl: u8, pub mask: u8, pub status: u8,
    oam_addr: u8,
    pub v: u16, pub t: u16, fine_x: u8, w: bool,
    read_buf: u8, latch: u8,
    pub vram: [u8; 4096], pub pal: [u8; 32], pub oam: [u8; 256],
    pub scanline: i32, pub dot: i32, pub frame: u64,
    // background pipeline
    nt: u8, at: u8, pat_lo: u8, pat_hi: u8,
    sh_lo: u16, sh_hi: u16, sh_at_lo: u16, sh_at_hi: u16,
    // sprites for the scanline being drawn
    spr: [Sprite; 8], spr_n: usize, spr0_on: bool,
    nmi_line: bool, nmi_edge: bool,
    /// Instructions to wait before a pending NMI is taken (1 when it came from enabling NMI inside vblank).
    nmi_delay: u8,
    /// RGBA, 256×240.
    pub fb: Vec<u8>,
    pub frame_ready: bool,
}

impl Default for Ppu { fn default() -> Self { Self::new() } }

impl Ppu {
    pub fn new() -> Self {
        Ppu {
            ctrl: 0, mask: 0, status: 0, oam_addr: 0, v: 0, t: 0, fine_x: 0, w: false, read_buf: 0, latch: 0,
            vram: [0; 4096], pal: [0x0F; 32], oam: [0xFF; 256],
            scanline: 261, dot: 0, frame: 0,
            nt: 0, at: 0, pat_lo: 0, pat_hi: 0, sh_lo: 0, sh_hi: 0, sh_at_lo: 0, sh_at_hi: 0,
            spr: [Sprite::default(); 8], spr_n: 0, spr0_on: false,
            nmi_line: false, nmi_edge: false, nmi_delay: 0,
            fb: vec![0; WIDTH * HEIGHT * 4], frame_ready: false,
        }
    }

    pub fn rendering(&self) -> bool { self.mask & 0x18 != 0 }

    /// True once per NMI edge (vblank start with NMI enabled, or NMI enabled during vblank).
    pub fn take_nmi(&mut self) -> bool {
        if !self.nmi_edge { return false; }
        if self.nmi_delay > 0 { self.nmi_delay -= 1; return false; }
        self.nmi_edge = false;
        true
    }

    fn update_nmi(&mut self) {
        let line = self.status & 0x80 != 0 && self.ctrl & 0x80 != 0;
        if line && !self.nmi_line { self.nmi_edge = true; }
        self.nmi_line = line;
    }

    // ---------- PPU address space ----------
    fn nt_index(a: u16, m: Mirroring) -> usize {
        let nt = (a >> 10) as usize & 3;
        let page = match m { Mirroring::Horizontal => nt >> 1, Mirroring::Vertical => nt & 1, Mirroring::SingleLo => 0, Mirroring::SingleHi => 1, Mirroring::FourScreen => nt };
        page * 0x400 + (a as usize & 0x3FF)
    }
    fn pal_index(a: u16) -> usize { let i = a as usize & 0x1F; if i >= 16 && i & 3 == 0 { i - 16 } else { i } }

    pub fn read(&self, a: u16, cart: &Cart) -> u8 {
        let a = a & 0x3FFF;
        match a {
            0x0000..=0x1FFF => cart.chr_read(a),
            0x2000..=0x3EFF => self.vram[Self::nt_index(a, cart.mirroring)],
            _ => self.pal[Self::pal_index(a)],
        }
    }
    fn write(&mut self, a: u16, v: u8, cart: &mut Cart) {
        let a = a & 0x3FFF;
        match a {
            0x0000..=0x1FFF => cart.chr_write(a, v),
            0x2000..=0x3EFF => { let i = Self::nt_index(a, cart.mirroring); self.vram[i] = v; }
            _ => self.pal[Self::pal_index(a)] = v & 0x3F,
        }
    }

    // ---------- CPU-visible registers ($2000-$2007, mirrored) ----------
    pub fn read_reg(&mut self, reg: u16, cart: &Cart) -> u8 {
        let out = match reg & 7 {
            2 => {
                let s = (self.status & 0xE0) | (self.latch & 0x1F);
                self.status &= !0x80; self.w = false; self.update_nmi();
                s
            }
            4 => self.oam[self.oam_addr as usize],
            7 => {
                let a = self.v & 0x3FFF;
                let r = if a >= 0x3F00 {
                    self.read_buf = self.vram[Self::nt_index(a - 0x1000, cart.mirroring)];      // the nametable "under" the palette
                    self.read(a, cart) & 0x3F | (self.latch & 0xC0)
                } else { let r = self.read_buf; self.read_buf = self.read(a, cart); r };
                self.v = self.v.wrapping_add(if self.ctrl & 4 != 0 { 32 } else { 1 });
                r
            }
            _ => self.latch,
        };
        self.latch = out;
        out
    }

    pub fn write_reg(&mut self, reg: u16, v: u8, cart: &mut Cart) {
        self.latch = v;
        match reg & 7 {
            0 => {
                self.ctrl = v; self.t = (self.t & 0xF3FF) | (v as u16 & 3) << 10;
                let was = self.nmi_edge;
                self.update_nmi();
                if self.nmi_edge && !was { self.nmi_delay = 1; }          // enabling NMI inside vblank: taken after the NEXT instruction
            }
            1 => self.mask = v,
            3 => self.oam_addr = v,
            4 => { self.oam[self.oam_addr as usize] = v; self.oam_addr = self.oam_addr.wrapping_add(1); }
            5 => {
                if !self.w { self.fine_x = v & 7; self.t = (self.t & 0xFFE0) | (v as u16 >> 3); }
                else { self.t = (self.t & 0x8C1F) | (v as u16 & 7) << 12 | (v as u16 >> 3) << 5; }
                self.w = !self.w;
            }
            6 => {
                if !self.w { self.t = (self.t & 0x00FF) | (v as u16 & 0x3F) << 8; }
                else { self.t = (self.t & 0xFF00) | v as u16; self.v = self.t; }
                self.w = !self.w;
            }
            7 => {
                self.write(self.v, v, cart);
                self.v = self.v.wrapping_add(if self.ctrl & 4 != 0 { 32 } else { 1 });
            }
            _ => {}
        }
    }

    /// $4014: copy a 256-byte page into OAM, starting at the current OAM address.
    pub fn dma(&mut self, page: &[u8; 256]) {
        for (i, &b) in page.iter().enumerate() { self.oam[(self.oam_addr as usize + i) & 0xFF] = b; }
    }

    // ---------- rendering ----------
    fn inc_x(&mut self) { if self.v & 0x1F == 31 { self.v = (self.v & !0x1F) ^ 0x400; } else { self.v += 1; } }
    fn inc_y(&mut self) {
        if self.v & 0x7000 != 0x7000 { self.v += 0x1000; return; }
        self.v &= !0x7000;
        let mut y = (self.v & 0x3E0) >> 5;
        if y == 29 { y = 0; self.v ^= 0x800; } else if y == 31 { y = 0; } else { y += 1; }
        self.v = (self.v & !0x3E0) | y << 5;
    }

    fn load_shifters(&mut self) {
        self.sh_lo = (self.sh_lo & 0xFF00) | self.pat_lo as u16;
        self.sh_hi = (self.sh_hi & 0xFF00) | self.pat_hi as u16;
        self.sh_at_lo = (self.sh_at_lo & 0xFF00) | if self.at & 1 != 0 { 0xFF } else { 0 };
        self.sh_at_hi = (self.sh_at_hi & 0xFF00) | if self.at & 2 != 0 { 0xFF } else { 0 };
    }

    fn evaluate_sprites(&mut self, target: i32, cart: &Cart) {
        self.spr_n = 0; self.spr0_on = false;
        if !(0..HEIGHT as i32).contains(&target) { return; }
        let h = if self.ctrl & 0x20 != 0 { 16 } else { 8 };
        for i in 0..64 {
            let (y, tile, attr, x) = (self.oam[i * 4] as i32, self.oam[i * 4 + 1], self.oam[i * 4 + 2], self.oam[i * 4 + 3]);
            let mut row = target - 1 - y;
            if !(0..h).contains(&row) { continue; }
            if self.spr_n == 8 { self.status |= 0x20; break; }
            if attr & 0x80 != 0 { row = h - 1 - row; }
            let addr = if h == 8 { (self.ctrl as u16 & 8) << 9 | (tile as u16) << 4 | row as u16 }
                else { (tile as u16 & 1) << 12 | ((tile as u16 & 0xFE) + (row as u16 >> 3)) << 4 | (row as u16 & 7) };
            let (mut lo, mut hi) = (cart.chr_read(addr), cart.chr_read(addr + 8));
            if attr & 0x40 != 0 { lo = lo.reverse_bits(); hi = hi.reverse_bits(); }
            self.spr[self.spr_n] = Sprite { x, lo, hi, attr };
            if i == 0 { self.spr0_on = true; }
            self.spr_n += 1;
        }
    }

    fn pixel(&mut self, x: usize, y: usize) {
        let (mut bg, mut bg_pal) = (0u8, 0u8);
        if self.mask & 8 != 0 && (self.mask & 2 != 0 || x >= 8) {
            let m = 0x8000u16 >> self.fine_x;
            bg = ((self.sh_hi & m != 0) as u8) << 1 | (self.sh_lo & m != 0) as u8;
            bg_pal = ((self.sh_at_hi & m != 0) as u8) << 1 | (self.sh_at_lo & m != 0) as u8;
        }
        let (mut fg, mut fg_pal, mut fg_front, mut spr0_pixel) = (0u8, 0u8, false, false);
        if self.mask & 0x10 != 0 && (self.mask & 4 != 0 || x >= 8) {
            for i in 0..self.spr_n {
                let s = self.spr[i];
                let sx = x as i32 - s.x as i32;
                if !(0..8).contains(&sx) { continue; }
                let p = ((s.hi >> (7 - sx)) & 1) << 1 | ((s.lo >> (7 - sx)) & 1);
                if p == 0 { continue; }
                if fg == 0 { fg = p; fg_pal = (s.attr & 3) + 4; fg_front = s.attr & 0x20 == 0; spr0_pixel = i == 0 && self.spr0_on; }
            }
        }
        if spr0_pixel && bg != 0 && x < 255 && self.mask & 0x18 == 0x18 { self.status |= 0x40; }
        let (p, pal) = match (bg, fg) { (0, 0) => (0, 0), (0, _) => (fg, fg_pal), (_, 0) => (bg, bg_pal), _ => if fg_front { (fg, fg_pal) } else { (bg, bg_pal) } };
        self.put(x, y, self.pal[Self::pal_index(0x3F00 + (pal as u16) * 4 + p as u16)]);
    }

    fn put(&mut self, x: usize, y: usize, idx: u8) {
        let c = PALETTE[(if self.mask & 1 != 0 { idx & 0x30 } else { idx } & 0x3F) as usize];
        let o = (y * WIDTH + x) * 4;
        self.fb[o] = (c >> 16) as u8; self.fb[o + 1] = (c >> 8) as u8; self.fb[o + 2] = c as u8; self.fb[o + 3] = 255;
    }

    /// Advance one PPU dot.
    pub fn tick(&mut self, cart: &mut Cart) {
        let (sl, d) = (self.scanline, self.dot);
        let visible = sl < 240;
        let pre = sl == 261;
        let rendering = self.rendering();

        if rendering && (visible || pre) {
            if (2..=257).contains(&d) || (321..=337).contains(&d) {
                self.sh_lo <<= 1; self.sh_hi <<= 1; self.sh_at_lo <<= 1; self.sh_at_hi <<= 1;
                match (d - 1) % 8 {
                    0 => { self.load_shifters(); self.nt = self.read(0x2000 | (self.v & 0x0FFF), cart); }
                    2 => {
                        let a = 0x23C0 | (self.v & 0x0C00) | ((self.v >> 4) & 0x38) | ((self.v >> 2) & 7);
                        let mut at = self.read(a, cart);
                        if self.v & 0x40 != 0 { at >>= 4; }
                        if self.v & 0x02 != 0 { at >>= 2; }
                        self.at = at & 3;
                    }
                    4 => self.pat_lo = self.read((self.ctrl as u16 & 0x10) << 8 | (self.nt as u16) << 4 | (self.v >> 12) & 7, cart),
                    6 => self.pat_hi = self.read((self.ctrl as u16 & 0x10) << 8 | (self.nt as u16) << 4 | (self.v >> 12) & 7 | 8, cart),
                    _ => if d % 8 == 0 { self.inc_x() },
                }
            }
            if d == 256 { self.inc_y(); }
            if d == 257 { self.v = (self.v & !0x041F) | (self.t & 0x041F); self.evaluate_sprites(if pre { 0 } else { sl + 1 }, cart); }
            if pre && (280..=304).contains(&d) { self.v = (self.v & !0x7BE0) | (self.t & 0x7BE0); }
        }
        // the pixel is composed after this dot's shift/fetch work, as on the real pipeline
        if visible && (1..=256).contains(&d) {
            let (x, y) = (d as usize - 1, sl as usize);
            if rendering { self.pixel(x, y) } else { self.put(x, y, self.pal[0]) }
        }
        if sl == 241 && d == 1 { self.status |= 0x80; self.update_nmi(); }
        if pre && d == 1 { self.status &= !0xE0; self.update_nmi(); }

        self.dot += 1;
        if pre && d == 339 && self.frame & 1 == 1 && rendering { self.dot += 1; }          // odd frames skip a dot
        if self.dot > 340 {
            self.dot = 0; self.scanline += 1;
            if self.scanline > 261 { self.scanline = 0; self.frame += 1; self.frame_ready = true; }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cart::Cart;

    /// NROM cart with 8 KB CHR-ROM where tile 1 is solid colour 1 and tile 2 is solid colour 3.
    fn cart(m: Mirroring) -> Cart {
        let mut v = vec![b'N', b'E', b'S', 0x1a, 1, 1, if m == Mirroring::Vertical { 1 } else { 0 }, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        v.extend(vec![0xEA; 16384]);
        let mut chr = vec![0u8; 8192];
        for r in 0..8 { chr[16 + r] = 0xFF; chr[32 + r] = 0xFF; chr[32 + 8 + r] = 0xFF; }
        v.extend(chr);
        Cart::parse(&v).unwrap()
    }
    fn set_addr(p: &mut Ppu, c: &mut Cart, a: u16) { p.write_reg(6, (a >> 8) as u8, c); p.write_reg(6, a as u8, c); }
    fn run_frames(p: &mut Ppu, c: &mut Cart, n: u64) { let end = p.frame + n; while p.frame < end { p.tick(c); } }
    fn px(p: &Ppu, x: usize, y: usize) -> u32 { let o = (y * WIDTH + x) * 4; (p.fb[o] as u32) << 16 | (p.fb[o + 1] as u32) << 8 | p.fb[o + 2] as u32 }

    #[test]
    fn status_read_clears_vblank_and_the_write_toggle() {
        let (mut p, mut c) = (Ppu::new(), cart(Mirroring::Horizontal));
        p.status = 0x80; p.write_reg(6, 0x21, &mut c);
        assert_eq!(p.read_reg(2, &c) & 0x80, 0x80);
        assert_eq!(p.status & 0x80, 0, "reading clears vblank");
        p.write_reg(6, 0x08, &mut c); p.write_reg(6, 0x00, &mut c);
        assert_eq!(p.v, 0x0800, "the toggle was reset, so these two writes form one address");
    }

    #[test]
    fn ppudata_reads_are_buffered_and_the_address_increments_by_1_or_32() {
        let (mut p, mut c) = (Ppu::new(), cart(Mirroring::Horizontal));
        set_addr(&mut p, &mut c, 0x2000);
        p.write_reg(7, 0xAA, &mut c); p.write_reg(7, 0xBB, &mut c);
        set_addr(&mut p, &mut c, 0x2000);
        assert_eq!(p.read_reg(7, &c), 0x00, "first read returns the stale buffer");
        assert_eq!((p.read_reg(7, &c), p.read_reg(7, &c)), (0xAA, 0xBB));
        p.write_reg(0, 0x04, &mut c); set_addr(&mut p, &mut c, 0x2000); p.write_reg(7, 1, &mut c);
        assert_eq!(p.v, 0x2020, "ctrl bit 2 steps by a whole row");
    }

    #[test]
    fn palette_writes_mirror_and_reads_are_not_buffered() {
        let (mut p, mut c) = (Ppu::new(), cart(Mirroring::Horizontal));
        set_addr(&mut p, &mut c, 0x3F10); p.write_reg(7, 0x21, &mut c);
        set_addr(&mut p, &mut c, 0x3F00);
        assert_eq!(p.read_reg(7, &c) & 0x3F, 0x21, "$3F10 mirrors $3F00, and the value comes straight back");
        set_addr(&mut p, &mut c, 0x3F05); p.write_reg(7, 0x15, &mut c);
        set_addr(&mut p, &mut c, 0x3F05); assert_eq!(p.read_reg(7, &c) & 0x3F, 0x15);
        set_addr(&mut p, &mut c, 0x3F25); assert_eq!(p.read_reg(7, &c) & 0x3F, 0x15, "palette repeats every 32 bytes");
    }

    #[test]
    fn nametable_mirroring_follows_the_cartridge() {
        for (m, a, b, same) in [(Mirroring::Horizontal, 0x2000u16, 0x2400u16, true), (Mirroring::Horizontal, 0x2000, 0x2800, false),
                                (Mirroring::Vertical, 0x2000, 0x2800, true), (Mirroring::Vertical, 0x2000, 0x2400, false)] {
            let (mut p, mut c) = (Ppu::new(), cart(m));
            set_addr(&mut p, &mut c, a); p.write_reg(7, 0x5A, &mut c);
            set_addr(&mut p, &mut c, b); p.read_reg(7, &c);
            assert_eq!(p.read_reg(7, &c) == 0x5A, same, "{m:?} {a:04X} vs {b:04X}");
        }
    }

    #[test]
    fn scroll_and_address_writes_fill_t_the_way_the_hardware_does() {
        let (mut p, mut c) = (Ppu::new(), cart(Mirroring::Horizontal));
        p.write_reg(0, 0x03, &mut c);                               // nametable select 3
        p.write_reg(5, 0x7D, &mut c); p.write_reg(5, 0x5E, &mut c);
        assert_eq!(p.t, 0x0C00 | 0x616F, "coarse x 15, fine y 6, coarse y 11, nametable 3");
        assert_eq!(p.fine_x, 5);
        p.write_reg(6, 0x3F, &mut c); p.write_reg(6, 0xFF, &mut c);
        assert_eq!(p.v, 0x3FFF);
    }

    #[test]
    fn vblank_starts_at_241_1_and_nmi_fires_only_when_enabled() {
        let (mut p, mut c) = (Ppu::new(), cart(Mirroring::Horizontal));
        while !(p.scanline == 241 && p.dot == 1) { p.tick(&mut c); }
        assert_eq!(p.status & 0x80, 0); assert!(!p.take_nmi());
        p.tick(&mut c);
        assert_eq!(p.status & 0x80, 0x80); assert!(!p.take_nmi(), "NMI disabled");
        p.write_reg(0, 0x80, &mut c);
        assert!(!p.take_nmi(), "enabling NMI during vblank waits for one more instruction");
        assert!(p.take_nmi(), "then fires");
        assert!(!p.take_nmi(), "only one edge");
        while !(p.scanline == 261 && p.dot == 2) { p.tick(&mut c); }
        assert_eq!(p.status & 0xE0, 0, "pre-render line clears vblank, sprite 0 and overflow");
    }

    #[test]
    fn nmi_edge_fires_at_vblank_start_when_already_enabled() {
        let (mut p, mut c) = (Ppu::new(), cart(Mirroring::Horizontal));
        p.write_reg(0, 0x80, &mut c);
        while !(p.scanline == 241 && p.dot == 2) { p.tick(&mut c); }
        assert!(p.take_nmi());
    }

    #[test]
    fn background_tiles_use_the_nametable_attribute_table_and_palette() {
        let (mut p, mut c) = (Ppu::new(), cart(Mirroring::Horizontal));
        set_addr(&mut p, &mut c, 0x3F00);
        for v in [0x0F, 0x16, 0x2A, 0x30, 0x0F, 0x11, 0x12, 0x13] { p.write_reg(7, v, &mut c); }
        set_addr(&mut p, &mut c, 0x2000); p.write_reg(7, 1, &mut c); p.write_reg(7, 2, &mut c);       // tiles 1 and 2 at (0,0) and (1,0)
        set_addr(&mut p, &mut c, 0x23C0); p.write_reg(7, 0b0000_0001, &mut c);                          // top-left 2×2 block uses palette 1
        set_addr(&mut p, &mut c, 0x0000);
        p.write_reg(1, 0x0A, &mut c);
        run_frames(&mut p, &mut c, 2);
        assert_eq!(px(&p, 0, 0), PALETTE[0x11], "tile 1 = colour 1 of palette 1");
        assert_eq!(px(&p, 8, 0), PALETTE[0x13], "tile 2 = colour 3 of palette 1");
        assert_eq!(px(&p, 16, 0), PALETTE[0x0F], "empty tile shows the backdrop");
        assert_eq!(px(&p, 0, 7), PALETTE[0x11]); assert_eq!(px(&p, 0, 8), PALETTE[0x0F]);
    }

    #[test]
    fn fine_x_scroll_shifts_the_picture_left() {
        let (mut p, mut c) = (Ppu::new(), cart(Mirroring::Horizontal));
        set_addr(&mut p, &mut c, 0x3F00); for v in [0x0F, 0x16] { p.write_reg(7, v, &mut c); }
        set_addr(&mut p, &mut c, 0x2000); p.write_reg(7, 1, &mut c);
        p.write_reg(1, 0x0A, &mut c);
        p.write_reg(5, 3, &mut c); p.write_reg(5, 0, &mut c);                  // scroll x = 3
        run_frames(&mut p, &mut c, 2);
        assert_eq!(px(&p, 4, 0), PALETTE[0x16], "tile now covers x 0-4");
        assert_eq!(px(&p, 5, 0), PALETTE[0x0F]);
    }

    #[test]
    fn left_column_clipping_hides_the_first_8_pixels() {
        let (mut p, mut c) = (Ppu::new(), cart(Mirroring::Horizontal));
        set_addr(&mut p, &mut c, 0x3F00); for v in [0x0F, 0x16] { p.write_reg(7, v, &mut c); }
        set_addr(&mut p, &mut c, 0x2000); p.write_reg(7, 1, &mut c); p.write_reg(7, 1, &mut c);
        p.write_reg(1, 0x08, &mut c);                                          // bg on, left 8 px hidden
        run_frames(&mut p, &mut c, 2);
        assert_eq!((px(&p, 0, 0), px(&p, 7, 0), px(&p, 8, 0)), (PALETTE[0x0F], PALETTE[0x0F], PALETTE[0x16]));
    }

    fn put_sprite(p: &mut Ppu, i: usize, y: u8, tile: u8, attr: u8, x: u8) { p.oam[i * 4..i * 4 + 4].copy_from_slice(&[y, tile, attr, x]); }

    #[test]
    fn sprites_draw_with_their_own_palette_one_line_below_their_y() {
        let (mut p, mut c) = (Ppu::new(), cart(Mirroring::Horizontal));
        set_addr(&mut p, &mut c, 0x3F10); for v in [0x0F, 0x16, 0x2A, 0x30] { p.write_reg(7, v, &mut c); }
        p.oam = [0xFF; 256]; put_sprite(&mut p, 0, 9, 1, 0, 20);
        p.write_reg(1, 0x14, &mut c);
        run_frames(&mut p, &mut c, 2);
        assert_eq!(px(&p, 20, 10), PALETTE[0x16], "OAM Y = 9 means the first row is scanline 10");
        assert_eq!(px(&p, 27, 17), PALETTE[0x16]);
        assert_eq!((px(&p, 19, 10), px(&p, 28, 10), px(&p, 20, 9), px(&p, 20, 18)), (PALETTE[0x0F], PALETTE[0x0F], PALETTE[0x0F], PALETTE[0x0F]));
    }

    #[test]
    fn sprite_flips_priority_and_sixteen_pixel_height() {
        let (mut p, mut c) = (Ppu::new(), cart(Mirroring::Horizontal));
        // make tile 3 a left-half-only tile: columns 0-3 set
        let mut chr_patch = Vec::new(); for r in 0..8 { chr_patch.push((3 * 16 + r, 0xF0u8)); }
        for (i, b) in chr_patch { c.chr[i] = b; }
        set_addr(&mut p, &mut c, 0x3F10); for v in [0x0F, 0x16, 0x2A, 0x30] { p.write_reg(7, v, &mut c); }
        p.oam = [0xFF; 256]; put_sprite(&mut p, 0, 9, 3, 0x40, 20);            // horizontally flipped
        p.write_reg(1, 0x14, &mut c); run_frames(&mut p, &mut c, 2);
        assert_eq!((px(&p, 20, 10), px(&p, 24, 10)), (PALETTE[0x0F], PALETTE[0x16]), "flip moved the solid half to the right");
        // 8×16: tiles 2 (top) and 3 (bottom) of bank 0
        p.oam = [0xFF; 256]; put_sprite(&mut p, 0, 9, 2, 0, 40);
        p.write_reg(0, 0x20, &mut c); run_frames(&mut p, &mut c, 2);
        assert_eq!(px(&p, 40, 10), PALETTE[0x30], "top tile = tile 2 (colour 3)");
        assert_eq!(px(&p, 40, 18), PALETTE[0x16], "bottom tile = tile 3 (colour 1, left half)");
        // behind-background priority
        set_addr(&mut p, &mut c, 0x3F00); for v in [0x0F, 0x01] { p.write_reg(7, v, &mut c); }
        set_addr(&mut p, &mut c, 0x2000 + 5 + 32); p.write_reg(7, 1, &mut c);   // bg tile at (40..47, 8..15)
        p.oam = [0xFF; 256]; put_sprite(&mut p, 0, 11, 1, 0x20, 42);
        p.write_reg(0, 0, &mut c); p.write_reg(1, 0x1E, &mut c); set_addr(&mut p, &mut c, 0); run_frames(&mut p, &mut c, 2);
        assert_eq!(px(&p, 43, 13), PALETTE[0x01], "background wins over a behind-sprite");
    }

    #[test]
    fn sprite_zero_hit_needs_opaque_overlap_and_is_cleared_each_frame() {
        let (mut p, mut c) = (Ppu::new(), cart(Mirroring::Horizontal));
        set_addr(&mut p, &mut c, 0x2000 + 1 + 32); p.write_reg(7, 1, &mut c);          // bg tile at (8..15, 8..15)
        p.oam = [0xFF; 256]; put_sprite(&mut p, 0, 10, 1, 0, 12);
        set_addr(&mut p, &mut c, 0); p.write_reg(1, 0x1E, &mut c);
        run_frames(&mut p, &mut c, 1);
        while !(p.scanline == 12 && p.dot == 200) { p.tick(&mut c); }
        assert_eq!(p.status & 0x40, 0x40, "overlap at scanline 11 sets the flag");
        run_frames(&mut p, &mut c, 1);
        while !(p.scanline == 100 && p.dot == 5) { p.tick(&mut c); }
        assert_eq!(p.status & 0x40, 0x40, "and it stays set until the pre-render line");
        // no overlap -> no hit
        let (mut p, mut c) = (Ppu::new(), cart(Mirroring::Horizontal));
        p.oam = [0xFF; 256]; put_sprite(&mut p, 0, 10, 1, 0, 12); set_addr(&mut p, &mut c, 0); p.write_reg(1, 0x1E, &mut c);
        run_frames(&mut p, &mut c, 2); assert_eq!(p.status & 0x40, 0, "sprite over empty background");
    }

    #[test]
    fn nine_sprites_on_a_line_set_the_overflow_flag() {
        let (mut p, mut c) = (Ppu::new(), cart(Mirroring::Horizontal));
        p.oam = [0xFF; 256];
        for i in 0..9 { put_sprite(&mut p, i, 50, 1, 0, (i * 10) as u8); }
        p.write_reg(1, 0x10, &mut c);
        while !(p.scanline == 60 && p.dot == 0) { p.tick(&mut c); }
        assert_eq!(p.status & 0x20, 0x20);
    }

    #[test]
    fn odd_frames_are_one_dot_shorter_only_while_rendering() {
        let count = |mask: u8| {
            let (mut p, mut c) = (Ppu::new(), cart(Mirroring::Horizontal));
            p.write_reg(1, mask, &mut c);
            run_frames(&mut p, &mut c, 2);                       // get into a known phase
            let (mut n, start) = (0u64, p.frame);
            while p.frame == start { p.tick(&mut c); n += 1; }
            let start = p.frame; let mut m = 0u64;
            while p.frame == start { p.tick(&mut c); m += 1; }
            (n, m)
        };
        let (a, b) = count(0x08); assert_eq!(a + b, 2 * 89342 - 1);
        let (a, b) = count(0); assert_eq!((a, b), (89342, 89342));
    }

    #[test]
    fn dma_copies_a_page_starting_at_the_oam_address() {
        let (mut p, mut c) = (Ppu::new(), cart(Mirroring::Horizontal));
        let page: [u8; 256] = std::array::from_fn(|i| i as u8);
        p.write_reg(3, 4, &mut c); p.dma(&page);
        assert_eq!((p.oam[4], p.oam[255], p.oam[0], p.oam[3]), (0, 251, 252, 255));
    }
}
