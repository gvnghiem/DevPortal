//! MOS 6502 as used in the NES (no decimal mode). Instruction-stepped: `step` runs one instruction and
//! returns the cycles it took, including page-crossing and branch penalties. Includes the unofficial
//! opcodes real games and the nestest ROM use (LAX, SAX, DCP, ISB, SLO, SRE, RLA, RRA, extra NOPs, SBC $EB).

pub trait Bus {
    fn read(&mut self, addr: u16) -> u8;
    fn write(&mut self, addr: u16, v: u8);
}

pub const C: u8 = 0x01;
pub const Z: u8 = 0x02;
pub const I: u8 = 0x04;
pub const D: u8 = 0x08;
pub const B: u8 = 0x10;
pub const U: u8 = 0x20;
pub const V: u8 = 0x40;
pub const N: u8 = 0x80;

#[derive(Clone, Debug)]
pub struct Cpu {
    pub a: u8, pub x: u8, pub y: u8, pub sp: u8, pub pc: u16, pub p: u8,
    pub cycles: u64,
    /// Set by the 12 "KIL" opcodes: the real CPU locks up until reset.
    pub halted: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode { Imm, Zp, Zpx, Zpy, Abs, Abx, Aby, Inx, Iny }

/// How an instruction touches memory decides its base cycle count.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Class { Read, Write, Rmw }

fn cycles_for(mode: Mode, class: Class, crossed: bool) -> u32 {
    use {Class::*, Mode::*};
    match (class, mode) {
        (Read, Imm) => 2,
        (Read, Zp) | (Write, Zp) => 3,
        (Read, Zpx) | (Read, Zpy) | (Write, Zpx) | (Write, Zpy) => 4,
        (Read, Abs) | (Write, Abs) => 4,
        (Read, Abx) | (Read, Aby) => 4 + crossed as u32,
        (Write, Abx) | (Write, Aby) => 5,
        (Read, Inx) | (Write, Inx) => 6,
        (Read, Iny) => 5 + crossed as u32,
        (Write, Iny) => 6,
        (Rmw, Zp) => 5,
        (Rmw, Zpx) | (Rmw, Zpy) | (Rmw, Abs) => 6,
        (Rmw, Abx) | (Rmw, Aby) => 7,
        (Rmw, Inx) | (Rmw, Iny) => 8,
        (Write, Imm) | (Rmw, Imm) => 2,
    }
}

impl Default for Cpu { fn default() -> Self { Self::new() } }

impl Cpu {
    pub fn new() -> Self { Cpu { a: 0, x: 0, y: 0, sp: 0xFD, pc: 0, p: I | U, cycles: 0, halted: false } }

    pub fn reset(&mut self, bus: &mut impl Bus) {
        self.sp = 0xFD; self.p = I | U; self.halted = false;
        self.pc = self.read16(bus, 0xFFFC);
        self.cycles = 7;
    }

    fn read16(&self, bus: &mut impl Bus, a: u16) -> u16 { bus.read(a) as u16 | (bus.read(a.wrapping_add(1)) as u16) << 8 }
    fn fetch(&mut self, bus: &mut impl Bus) -> u8 { let v = bus.read(self.pc); self.pc = self.pc.wrapping_add(1); v }
    fn fetch16(&mut self, bus: &mut impl Bus) -> u16 { let lo = self.fetch(bus) as u16; lo | (self.fetch(bus) as u16) << 8 }
    fn push(&mut self, bus: &mut impl Bus, v: u8) { bus.write(0x100 | self.sp as u16, v); self.sp = self.sp.wrapping_sub(1); }
    fn pop(&mut self, bus: &mut impl Bus) -> u8 { self.sp = self.sp.wrapping_add(1); bus.read(0x100 | self.sp as u16) }
    fn push16(&mut self, bus: &mut impl Bus, v: u16) { self.push(bus, (v >> 8) as u8); self.push(bus, v as u8); }
    fn pop16(&mut self, bus: &mut impl Bus) -> u16 { let lo = self.pop(bus) as u16; lo | (self.pop(bus) as u16) << 8 }

    fn set(&mut self, flag: u8, on: bool) { if on { self.p |= flag } else { self.p &= !flag } }
    fn nz(&mut self, v: u8) -> u8 { self.set(Z, v == 0); self.set(N, v & 0x80 != 0); v }

    /// Resolve an operand address; also reports whether indexing crossed a page.
    fn addr(&mut self, bus: &mut impl Bus, m: Mode) -> (u16, bool) {
        match m {
            Mode::Imm => { let a = self.pc; self.pc = self.pc.wrapping_add(1); (a, false) }
            Mode::Zp => (self.fetch(bus) as u16, false),
            Mode::Zpx => (self.fetch(bus).wrapping_add(self.x) as u16, false),
            Mode::Zpy => (self.fetch(bus).wrapping_add(self.y) as u16, false),
            Mode::Abs => (self.fetch16(bus), false),
            Mode::Abx | Mode::Aby => {
                let base = self.fetch16(bus);
                let a = base.wrapping_add(if m == Mode::Abx { self.x } else { self.y } as u16);
                (a, base & 0xFF00 != a & 0xFF00)
            }
            Mode::Inx => {
                let z = self.fetch(bus).wrapping_add(self.x);
                (bus.read(z as u16) as u16 | (bus.read(z.wrapping_add(1) as u16) as u16) << 8, false)
            }
            Mode::Iny => {
                let z = self.fetch(bus);
                let base = bus.read(z as u16) as u16 | (bus.read(z.wrapping_add(1) as u16) as u16) << 8;
                let a = base.wrapping_add(self.y as u16);
                (a, base & 0xFF00 != a & 0xFF00)
            }
        }
    }

    fn adc(&mut self, m: u8) {
        let sum = self.a as u16 + m as u16 + (self.p & C) as u16;
        let r = sum as u8;
        self.set(C, sum > 0xFF);
        self.set(V, (self.a ^ r) & (m ^ r) & 0x80 != 0);
        self.a = self.nz(r);
    }
    fn cmp(&mut self, reg: u8, m: u8) { self.set(C, reg >= m); self.nz(reg.wrapping_sub(m)); }
    fn asl(&mut self, v: u8) -> u8 { self.set(C, v & 0x80 != 0); self.nz(v << 1) }
    fn lsr(&mut self, v: u8) -> u8 { self.set(C, v & 1 != 0); self.nz(v >> 1) }
    fn rol(&mut self, v: u8) -> u8 { let c = self.p & C; self.set(C, v & 0x80 != 0); self.nz(v << 1 | c) }
    fn ror(&mut self, v: u8) -> u8 { let c = self.p & C; self.set(C, v & 1 != 0); self.nz(v >> 1 | c << 7) }

    /// The eight "group 1" operations (opcode bits aaa for cc = 01), shared by the unofficial combined ops.
    fn group1(&mut self, aaa: u8, m: u8) {
        match aaa {
            0 => { self.a |= m; self.nz(self.a); }
            1 => { self.a &= m; self.nz(self.a); }
            2 => { self.a ^= m; self.nz(self.a); }
            3 => self.adc(m),
            5 => { self.a = self.nz(m); }
            6 => self.cmp(self.a, m),
            7 => self.adc(!m),
            _ => {}
        }
    }

    fn interrupt(&mut self, bus: &mut impl Bus, vector: u16, brk: bool) {
        self.push16(bus, self.pc);
        self.push(bus, (self.p | U) & !B | if brk { B } else { 0 });
        self.set(I, true);
        self.pc = self.read16(bus, vector);
    }

    /// Non-maskable interrupt (the PPU's vblank signal). Takes 7 cycles.
    pub fn nmi(&mut self, bus: &mut impl Bus) -> u32 { self.interrupt(bus, 0xFFFA, false); self.cycles += 7; 7 }

    /// Maskable interrupt: ignored while the I flag is set.
    pub fn irq(&mut self, bus: &mut impl Bus) -> u32 {
        if self.p & I != 0 { return 0; }
        self.interrupt(bus, 0xFFFE, false); self.cycles += 7; 7
    }

    fn branch(&mut self, bus: &mut impl Bus, cond: bool) -> u32 {
        let off = self.fetch(bus) as i8;
        if !cond { return 2; }
        let from = self.pc;
        self.pc = from.wrapping_add(off as u16);
        3 + (from & 0xFF00 != self.pc & 0xFF00) as u32
    }

    /// Run one instruction; returns the cycles used (a locked-up CPU just burns 2 per call).
    pub fn step(&mut self, bus: &mut impl Bus) -> u32 {
        if self.halted { self.cycles += 2; return 2; }
        let op = self.fetch(bus);
        let c = self.exec(bus, op);
        self.cycles += c as u64;
        c
    }

    fn exec(&mut self, bus: &mut impl Bus, op: u8) -> u32 {
        let (aaa, bbb, cc) = (op >> 5, (op >> 2) & 7, op & 3);
        // branches: xxy10000
        if op & 0x1F == 0x10 {
            let flag = [N, V, C, Z][(op >> 6) as usize];
            let want = op & 0x20 != 0;
            return self.branch(bus, (self.p & flag != 0) == want);
        }
        match op {
            0x00 => { self.pc = self.pc.wrapping_add(1); self.interrupt(bus, 0xFFFE, true); return 7; }
            0x20 => { let t = self.fetch16(bus); self.push16(bus, self.pc.wrapping_sub(1)); self.pc = t; return 6; }
            0x40 => { self.p = (self.pop(bus) & !B) | U; self.pc = self.pop16(bus); return 6; }
            0x60 => { self.pc = self.pop16(bus).wrapping_add(1); return 6; }
            0x4C => { self.pc = self.fetch16(bus); return 3; }
            0x6C => {
                let p = self.fetch16(bus);
                let hi = (p & 0xFF00) | (p.wrapping_add(1) & 0x00FF);      // the famous page-wrap bug
                self.pc = bus.read(p) as u16 | (bus.read(hi) as u16) << 8;
                return 5;
            }
            0x08 => { self.push(bus, self.p | B | U); return 3; }
            0x28 => { self.p = (self.pop(bus) & !B) | U; return 4; }
            0x48 => { self.push(bus, self.a); return 3; }
            0x68 => { let v = self.pop(bus); self.a = self.nz(v); return 4; }
            0x88 => { self.y = self.nz(self.y.wrapping_sub(1)); return 2; }
            0xA8 => { self.y = self.nz(self.a); return 2; }
            0xC8 => { self.y = self.nz(self.y.wrapping_add(1)); return 2; }
            0xE8 => { self.x = self.nz(self.x.wrapping_add(1)); return 2; }
            0x18 => { self.set(C, false); return 2; }
            0x38 => { self.set(C, true); return 2; }
            0x58 => { self.set(I, false); return 2; }
            0x78 => { self.set(I, true); return 2; }
            0x98 => { self.a = self.nz(self.y); return 2; }
            0xB8 => { self.set(V, false); return 2; }
            0xD8 => { self.set(D, false); return 2; }
            0xF8 => { self.set(D, true); return 2; }
            0x8A => { self.a = self.nz(self.x); return 2; }
            0x9A => { self.sp = self.x; return 2; }
            0xAA => { self.x = self.nz(self.a); return 2; }
            0xBA => { self.x = self.nz(self.sp); return 2; }
            0xCA => { self.x = self.nz(self.x.wrapping_sub(1)); return 2; }
            0xEA | 0x1A | 0x3A | 0x5A | 0x7A | 0xDA | 0xFA => return 2,
            0x02 | 0x12 | 0x22 | 0x32 | 0x42 | 0x52 | 0x62 | 0x72 | 0x92 | 0xB2 | 0xD2 | 0xF2 => {
                self.halted = true; self.pc = self.pc.wrapping_sub(1); return 2;
            }
            // accumulator shifts
            0x0A | 0x2A | 0x4A | 0x6A => {
                self.a = match op { 0x0A => self.asl(self.a), 0x2A => self.rol(self.a), 0x4A => self.lsr(self.a), _ => self.ror(self.a) };
                return 2;
            }
            _ => {}
        }
        match cc {
            1 => {
                const MODES: [Mode; 8] = [Mode::Inx, Mode::Zp, Mode::Imm, Mode::Abs, Mode::Iny, Mode::Zpx, Mode::Aby, Mode::Abx];
                let mode = MODES[bbb as usize];
                if aaa == 4 {
                    if mode == Mode::Imm { self.pc = self.pc.wrapping_add(1); return 2; }         // 0x89 = NOP #imm
                    let (a, _) = self.addr(bus, mode);
                    bus.write(a, self.a);
                    return cycles_for(mode, Class::Write, false);
                }
                let (a, cross) = self.addr(bus, mode);
                let m = bus.read(a);
                self.group1(aaa, m);
                cycles_for(mode, Class::Read, cross)
            }
            2 => {
                let mode = match bbb {
                    0 => Mode::Imm, 1 => Mode::Zp, 3 => Mode::Abs,
                    5 => if aaa == 4 || aaa == 5 { Mode::Zpy } else { Mode::Zpx },
                    7 => if aaa == 5 { Mode::Aby } else { Mode::Abx },
                    _ => Mode::Imm,
                };
                match aaa {
                    4 if bbb == 0 => { self.pc = self.pc.wrapping_add(1); 2 }                    // 0x82 NOP #imm
                    4 if bbb == 7 => { self.pc = self.pc.wrapping_add(2); 5 }                    // 0x9E unstable SHX: skipped
                    4 => { let (a, _) = self.addr(bus, mode); bus.write(a, self.x); cycles_for(mode, Class::Write, false) }
                    5 => { let (a, cross) = self.addr(bus, mode); let m = bus.read(a); self.x = self.nz(m); cycles_for(mode, Class::Read, cross) }
                    6 | 7 if bbb == 0 => { self.pc = self.pc.wrapping_add(1); 2 }                // 0xC2 / 0xE2 NOP #imm
                    _ => {
                        let (a, _) = self.addr(bus, mode);
                        let m = bus.read(a);
                        let r = match aaa { 0 => self.asl(m), 1 => self.rol(m), 2 => self.lsr(m), 3 => self.ror(m), 6 => self.nz(m.wrapping_sub(1)), _ => self.nz(m.wrapping_add(1)) };
                        bus.write(a, r);
                        cycles_for(mode, Class::Rmw, false)
                    }
                }
            }
            0 => {
                let mode = match bbb { 0 => Mode::Imm, 1 => Mode::Zp, 3 => Mode::Abs, 5 => Mode::Zpx, _ => Mode::Abx };
                let (a, cross) = self.addr(bus, mode);
                match (aaa, bbb) {
                    (1, 1) | (1, 3) => { let m = bus.read(a); self.set(Z, self.a & m == 0); self.set(V, m & 0x40 != 0); self.set(N, m & 0x80 != 0); }
                    (4, 1) | (4, 3) | (4, 5) => { bus.write(a, self.y); return cycles_for(mode, Class::Write, false); }
                    (5, _) => { let m = bus.read(a); self.y = self.nz(m); }
                    (6, 0) | (6, 1) | (6, 3) => { let m = bus.read(a); self.cmp(self.y, m); }
                    (7, 0) | (7, 1) | (7, 3) => { let m = bus.read(a); self.cmp(self.x, m); }
                    _ => { bus.read(a); }                                                         // the many unofficial NOPs
                }
                cycles_for(mode, Class::Read, cross)
            }
            _ => {
                // unofficial cc = 11: combined read-modify-write and load/store pairs
                const MODES: [Mode; 8] = [Mode::Inx, Mode::Zp, Mode::Imm, Mode::Abs, Mode::Iny, Mode::Zpx, Mode::Aby, Mode::Abx];
                let mut mode = MODES[bbb as usize];
                if (aaa == 4 || aaa == 5) && bbb == 5 { mode = Mode::Zpy; }
                if aaa == 5 && bbb == 7 { mode = Mode::Aby; }
                if mode == Mode::Imm {
                    if op == 0xEB { let (a, _) = self.addr(bus, mode); let m = bus.read(a); self.adc(!m); }
                    else { self.pc = self.pc.wrapping_add(1); }                                    // ANC/ALR/ARR/XAA/AXS: not emulated
                    return 2;
                }
                if aaa == 4 {
                    if bbb == 5 || bbb == 0 || bbb == 1 || bbb == 3 {                              // SAX
                        let (a, _) = self.addr(bus, mode); bus.write(a, self.a & self.x);
                        return cycles_for(mode, Class::Write, false);
                    }
                    let _ = self.addr(bus, mode); return 5;                                         // AHX/TAS: unstable, skipped
                }
                if aaa == 5 {                                                                       // LAX (and LAS, treated the same)
                    let (a, cross) = self.addr(bus, mode); let m = bus.read(a);
                    self.a = m; self.x = self.nz(m);
                    return cycles_for(mode, Class::Read, cross);
                }
                let (a, _) = self.addr(bus, mode);
                let m = bus.read(a);
                let r = match aaa {
                    0 => { let r = self.asl(m); self.group1(0, r); r }          // SLO
                    1 => { let r = self.rol(m); self.group1(1, r); r }          // RLA
                    2 => { let r = self.lsr(m); self.group1(2, r); r }          // SRE
                    3 => { let r = self.ror(m); self.group1(3, r); r }          // RRA
                    6 => { let r = m.wrapping_sub(1); self.cmp(self.a, r); r }   // DCP
                    _ => { let r = m.wrapping_add(1); self.adc(!r); r }          // ISB
                };
                bus.write(a, r);
                cycles_for(mode, Class::Rmw, false)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Ram(Vec<u8>);
    impl Bus for Ram {
        fn read(&mut self, a: u16) -> u8 { self.0[a as usize] }
        fn write(&mut self, a: u16, v: u8) { self.0[a as usize] = v; }
    }
    /// A CPU at 0x0200 with `code` loaded there.
    fn rig(code: &[u8]) -> (Cpu, Ram) {
        let mut m = Ram(vec![0; 65536]);
        m.0[0x200..0x200 + code.len()].copy_from_slice(code);
        let mut c = Cpu::new(); c.pc = 0x200;
        (c, m)
    }
    fn run(code: &[u8], n: usize) -> (Cpu, Ram) {
        let (mut c, mut m) = rig(code);
        for _ in 0..n { c.step(&mut m); }
        (c, m)
    }

    #[test]
    fn load_store_and_flags() {
        let (c, m) = run(&[0xA9, 0x80, 0x85, 0x10, 0xA2, 0x00], 3);        // LDA #$80; STA $10; LDX #0
        assert_eq!((c.a, m.0[0x10], c.x), (0x80, 0x80, 0));
        assert!(c.p & Z != 0, "LDX #0 sets zero");
        let (c, _) = run(&[0xA9, 0x80], 1);
        assert!(c.p & N != 0);
    }

    #[test]
    fn adc_sets_carry_and_overflow() {
        let (c, _) = run(&[0xA9, 0x50, 0x69, 0x50], 2);                    // 0x50 + 0x50 = 0xA0: signed overflow
        assert_eq!(c.a, 0xA0); assert!(c.p & V != 0 && c.p & N != 0 && c.p & C == 0);
        let (c, _) = run(&[0xA9, 0xFF, 0x69, 0x01], 2);
        assert_eq!(c.a, 0); assert!(c.p & C != 0 && c.p & Z != 0 && c.p & V == 0);
    }

    #[test]
    fn sbc_borrows_through_carry() {
        let (c, _) = run(&[0x38, 0xA9, 0x10, 0xE9, 0x01], 3);              // SEC; LDA #$10; SBC #1
        assert_eq!(c.a, 0x0F); assert!(c.p & C != 0, "no borrow");
        let (c, _) = run(&[0x18, 0xA9, 0x10, 0xE9, 0x01], 3);              // CLC: borrow one more
        assert_eq!(c.a, 0x0E);
    }

    #[test]
    fn compare_and_branch_with_cycle_penalties() {
        let (mut c, mut m) = rig(&[0xC9, 0x05, 0xD0, 0x02]);               // CMP #5; BNE +2
        c.a = 5; assert_eq!(c.step(&mut m), 2); assert!(c.p & Z != 0);
        assert_eq!(c.step(&mut m), 2, "not taken");
        c.a = 6; c.pc = 0x200; c.step(&mut m);
        assert_eq!(c.step(&mut m), 3, "taken, same page"); assert_eq!(c.pc, 0x206);
        let (mut c, mut m) = rig(&[]); c.pc = 0x02FD; m.0[0x2FD] = 0xD0; m.0[0x2FE] = 0x10;
        assert_eq!(c.step(&mut m), 4, "taken across a page"); assert_eq!(c.pc, 0x030F);
    }

    #[test]
    fn jsr_rts_round_trip_and_stack() {
        let (mut c, mut m) = rig(&[0x20, 0x10, 0x02, 0xEA]);              // JSR $0210
        m.0[0x210] = 0x60;                                                 // RTS
        assert_eq!(c.step(&mut m), 6); assert_eq!((c.pc, c.sp), (0x210, 0xFB));
        assert_eq!(c.step(&mut m), 6); assert_eq!((c.pc, c.sp), (0x203, 0xFD));
    }

    #[test]
    fn jmp_indirect_has_the_page_wrap_bug() {
        let (mut c, mut m) = rig(&[0x6C, 0xFF, 0x03]);                     // JMP ($03FF)
        m.0[0x3FF] = 0x34; m.0[0x300] = 0x12; m.0[0x400] = 0x56;           // high byte comes from $0300, not $0400
        assert_eq!(c.step(&mut m), 5); assert_eq!(c.pc, 0x1234);
    }

    #[test]
    fn indexed_reads_pay_for_page_crossing_but_writes_always_pay() {
        let (mut c, mut m) = rig(&[0xBD, 0xFF, 0x03, 0x9D, 0xFF, 0x03]);   // LDA $03FF,X ; STA $03FF,X
        c.x = 1; assert_eq!(c.step(&mut m), 5);
        c.x = 0; c.pc = 0x200; assert_eq!(c.step(&mut m), 4);
        assert_eq!(c.step(&mut m), 5, "STA abs,X is always 5");
    }

    #[test]
    fn indirect_modes_wrap_in_the_zero_page() {
        let (mut c, mut m) = rig(&[0xA1, 0xFE, 0xB1, 0xFF]);               // LDA ($FE,X) ; LDA ($FF),Y
        m.0[0xFF] = 0x00; m.0[0x00] = 0x03;                                // pointer at $FF wraps to $00
        m.0[0x300] = 0x77; m.0[0x305] = 0x99;
        c.x = 1; c.step(&mut m); assert_eq!(c.a, 0x77);
        c.y = 5; assert_eq!(c.step(&mut m), 5); assert_eq!(c.a, 0x99);
    }

    #[test]
    fn php_plp_handle_the_break_bits() {
        let (mut c, mut m) = rig(&[0x08, 0x28]);
        c.p = N | C | U; c.step(&mut m);
        assert_eq!(m.0[0x1FD], N | C | U | B, "PHP pushes B set");
        c.step(&mut m); assert_eq!(c.p, N | C | U, "PLP drops B, keeps U");
    }

    #[test]
    fn brk_and_rti() {
        let (mut c, mut m) = rig(&[0x00, 0xEA, 0xEA]);
        m.0[0xFFFE] = 0x00; m.0[0xFFFF] = 0x03; m.0[0x300] = 0x40;          // IRQ vector -> RTI
        assert_eq!(c.step(&mut m), 7); assert_eq!(c.pc, 0x300); assert!(c.p & I != 0);
        assert_eq!(m.0[0x1FD], 0x02, "return address is BRK + 2");
        assert_eq!(c.step(&mut m), 6); assert_eq!(c.pc, 0x202);
    }

    #[test]
    fn nmi_pushes_state_without_break_flag_and_irq_respects_i() {
        let (mut c, mut m) = rig(&[]);
        m.0[0xFFFA] = 0x00; m.0[0xFFFB] = 0x04; c.p = U;
        assert_eq!(c.nmi(&mut m), 7); assert_eq!(c.pc, 0x400);
        assert_eq!(m.0[0x1FB] & B, 0); assert!(c.p & I != 0);
        assert_eq!(c.irq(&mut m), 0, "masked by I");
    }

    #[test]
    fn rmw_and_unofficial_ops() {
        let (c, m) = run(&[0xA9, 0x81, 0x85, 0x20, 0x06, 0x20], 3);        // ASL $20 -> 0x02, carry
        assert_eq!(m.0[0x20], 0x02); assert!(c.p & C != 0);
        let (c, m) = run(&[0xA9, 0x0F, 0xA2, 0xF3, 0x87, 0x30], 3);        // SAX $30 = A & X
        assert_eq!(m.0[0x30], 0x03); let _ = c;
        let (mut c, mut m) = rig(&[0xA7, 0x40]); m.0[0x40] = 0x80; c.step(&mut m);   // LAX $40
        assert_eq!((c.a, c.x), (0x80, 0x80));
        let (mut c, mut m) = rig(&[0xC7, 0x40]); m.0[0x40] = 0x01; c.a = 0; assert_eq!(c.step(&mut m), 5);   // DCP
        assert_eq!(m.0[0x40], 0); assert!(c.p & Z != 0);
    }

    #[test]
    fn kil_locks_up_the_cpu() {
        let (mut c, mut m) = rig(&[0x02]);
        c.step(&mut m); assert!(c.halted); let pc = c.pc;
        c.step(&mut m); assert_eq!(c.pc, pc);
    }

    /// Reference: nestest.nes + nestest.log (public CPU test ROM). Not stored in this repo — CI clones
    /// github.com/christopherpow/nes-test-roms and points NES_TEST_ROMS at it; the test skips if that is unset.
    #[test]
    fn matches_the_nestest_reference_log_cycle_for_cycle() {
        let Some(dir) = std::env::var_os("NES_TEST_ROMS").filter(|d| !d.is_empty()) else { eprintln!("NES_TEST_ROMS not set: skipping nestest"); return };
        let dir = std::path::Path::new(&dir).join("other");
        let rom = std::fs::read(dir.join("nestest.nes")).expect("nestest.nes");
        let log = std::fs::read_to_string(dir.join("nestest.log")).expect("nestest.log");
        let cart = crate::cart::Cart::parse(&rom).unwrap();
        let mut bus = crate::bus::NesBus::new(cart);
        let mut cpu = Cpu::new();
        cpu.pc = 0xC000; cpu.cycles = 7;                                   // "automation" entry point
        for (n, line) in log.lines().enumerate() {
            let field = |key: &str| -> u64 {
                let i = line.find(key).unwrap() + key.len();
                let s = &line[i..]; let end = s.find(' ').unwrap_or(s.len());
                if key == "CYC:" { s[..end].parse().unwrap() } else { u64::from_str_radix(&s[..end], 16).unwrap() }
            };
            let want = (u16::from_str_radix(&line[0..4], 16).unwrap(), field("A:") as u8, field("X:") as u8, field("Y:") as u8, field("P:") as u8, field("SP:") as u8, field("CYC:"));
            let got = (cpu.pc, cpu.a, cpu.x, cpu.y, cpu.p, cpu.sp, cpu.cycles);
            assert_eq!(got, want, "line {}: {}", n + 1, line);
            cpu.step(&mut bus);
        }
        assert_eq!((bus.peek(2), bus.peek(3)), (0, 0), "nestest result codes ($02/$03) must be 00");
    }
}
