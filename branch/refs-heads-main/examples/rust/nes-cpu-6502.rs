// A tiny NES-style CPU: MOS 6502 subset + mini assembler + a 32x32 "screen" at $0200.
// (Same idea as the famous easy6502 playground. No ROMs, no Nintendo code — just the CPU idea.)
use std::collections::HashMap;

const C: u8 = 0x01;
const Z: u8 = 0x02;
const N: u8 = 0x80;

struct Cpu {
    a: u8,
    x: u8,
    y: u8,
    sp: u8,
    pc: u16,
    p: u8,
    mem: Vec<u8>,
    cycles: u64,
    halted: bool,
}

impl Cpu {
    fn new() -> Self {
        Cpu { a: 0, x: 0, y: 0, sp: 0xFF, pc: 0x0600, p: 0x20, mem: vec![0; 65536], cycles: 0, halted: false }
    }
    fn rd(&self, addr: u16) -> u8 { self.mem[addr as usize] }
    fn wr(&mut self, addr: u16, v: u8) { self.mem[addr as usize] = v; }
    fn fetch(&mut self) -> u8 {
        let v = self.rd(self.pc);
        self.pc = self.pc.wrapping_add(1);
        v
    }
    fn fetch16(&mut self) -> u16 {
        let lo = self.fetch() as u16;
        let hi = self.fetch() as u16;
        (hi << 8) | lo
    }
    fn set_zn(&mut self, v: u8) {
        self.p = (self.p & !(Z | N)) | if v == 0 { Z } else { 0 } | (v & N);
    }
    fn push(&mut self, v: u8) { let a = 0x0100 + self.sp as u16; self.wr(a, v); self.sp = self.sp.wrapping_sub(1); }
    fn pull(&mut self) -> u8 { self.sp = self.sp.wrapping_add(1); self.rd(0x0100 + self.sp as u16) }
    fn branch(&mut self, cond: bool) {
        let off = self.fetch() as i8;
        if cond { self.pc = self.pc.wrapping_add(off as i16 as u16); self.cycles += 1; }
    }
    fn compare(&mut self, reg: u8, v: u8) {
        self.p = if reg >= v { self.p | C } else { self.p & !C };
        self.set_zn(reg.wrapping_sub(v));
    }
    fn adc(&mut self, v: u8) {
        let sum = self.a as u16 + v as u16 + (self.p & C) as u16;
        self.p = if sum > 0xFF { self.p | C } else { self.p & !C };
        self.a = sum as u8;
        let a = self.a;
        self.set_zn(a);
    }

    fn step(&mut self) -> String {
        let at = self.pc;
        let op = self.fetch();
        let name: &str;
        match op {
            0x00 => { name = "BRK"; self.halted = true; }
            0xEA => { name = "NOP"; }
            0xA9 => { name = "LDA #"; let v = self.fetch(); self.a = v; self.set_zn(v); }
            0xA5 => { name = "LDA zp"; let z = self.fetch() as u16; let v = self.rd(z); self.a = v; self.set_zn(v); }
            0xAD => { name = "LDA abs"; let ad = self.fetch16(); let v = self.rd(ad); self.a = v; self.set_zn(v); }
            0xBD => { name = "LDA abs,X"; let ad = self.fetch16().wrapping_add(self.x as u16); let v = self.rd(ad); self.a = v; self.set_zn(v); }
            0xA2 => { name = "LDX #"; let v = self.fetch(); self.x = v; self.set_zn(v); }
            0xA0 => { name = "LDY #"; let v = self.fetch(); self.y = v; self.set_zn(v); }
            0x85 => { name = "STA zp"; let z = self.fetch() as u16; let a = self.a; self.wr(z, a); }
            0x86 => { name = "STX zp"; let z = self.fetch() as u16; let x = self.x; self.wr(z, x); }
            0x8D => { name = "STA abs"; let ad = self.fetch16(); let a = self.a; self.wr(ad, a); }
            0x9D => { name = "STA abs,X"; let ad = self.fetch16().wrapping_add(self.x as u16); let a = self.a; self.wr(ad, a); }
            0x99 => { name = "STA abs,Y"; let ad = self.fetch16().wrapping_add(self.y as u16); let a = self.a; self.wr(ad, a); }
            0xAA => { name = "TAX"; self.x = self.a; let v = self.x; self.set_zn(v); }
            0x8A => { name = "TXA"; self.a = self.x; let v = self.a; self.set_zn(v); }
            0xA8 => { name = "TAY"; self.y = self.a; let v = self.y; self.set_zn(v); }
            0x98 => { name = "TYA"; self.a = self.y; let v = self.a; self.set_zn(v); }
            0xE8 => { name = "INX"; self.x = self.x.wrapping_add(1); let v = self.x; self.set_zn(v); }
            0xC8 => { name = "INY"; self.y = self.y.wrapping_add(1); let v = self.y; self.set_zn(v); }
            0xCA => { name = "DEX"; self.x = self.x.wrapping_sub(1); let v = self.x; self.set_zn(v); }
            0x88 => { name = "DEY"; self.y = self.y.wrapping_sub(1); let v = self.y; self.set_zn(v); }
            0x69 => { name = "ADC #"; let v = self.fetch(); self.adc(v); }
            0x65 => { name = "ADC zp"; let z = self.fetch() as u16; let v = self.rd(z); self.adc(v); }
            0x29 => { name = "AND #"; let v = self.fetch(); self.a &= v; let r = self.a; self.set_zn(r); }
            0x09 => { name = "ORA #"; let v = self.fetch(); self.a |= v; let r = self.a; self.set_zn(r); }
            0x49 => { name = "EOR #"; let v = self.fetch(); self.a ^= v; let r = self.a; self.set_zn(r); }
            0x0A => { name = "ASL A"; let c = self.a >> 7; self.a <<= 1; self.p = (self.p & !C) | c; let r = self.a; self.set_zn(r); }
            0x4A => { name = "LSR A"; let c = self.a & 1; self.a >>= 1; self.p = (self.p & !C) | c; let r = self.a; self.set_zn(r); }
            0x18 => { name = "CLC"; self.p &= !C; }
            0x38 => { name = "SEC"; self.p |= C; }
            0xC9 => { name = "CMP #"; let v = self.fetch(); let a = self.a; self.compare(a, v); }
            0xE0 => { name = "CPX #"; let v = self.fetch(); let x = self.x; self.compare(x, v); }
            0xC0 => { name = "CPY #"; let v = self.fetch(); let y = self.y; self.compare(y, v); }
            0xD0 => { name = "BNE"; let c = self.p & Z == 0; self.branch(c); }
            0xF0 => { name = "BEQ"; let c = self.p & Z != 0; self.branch(c); }
            0x90 => { name = "BCC"; let c = self.p & C == 0; self.branch(c); }
            0xB0 => { name = "BCS"; let c = self.p & C != 0; self.branch(c); }
            0x4C => { name = "JMP"; self.pc = self.fetch16(); }
            0x20 => { name = "JSR"; let ad = self.fetch16(); let ret = self.pc.wrapping_sub(1); self.push((ret >> 8) as u8); self.push(ret as u8); self.pc = ad; }
            0x60 => { name = "RTS"; let lo = self.pull() as u16; let hi = self.pull() as u16; self.pc = ((hi << 8) | lo).wrapping_add(1); }
            0x48 => { name = "PHA"; let a = self.a; self.push(a); }
            0x68 => { name = "PLA"; let v = self.pull(); self.a = v; self.set_zn(v); }
            _ => { name = "???"; self.halted = true; }
        }
        self.cycles += 2;
        format!("{:04X}  {:02X}  {:<10} A={:02X} X={:02X} Y={:02X} P={:08b}", at, op, name, self.a, self.x, self.y, self.p)
    }
}

// ---- mini assembler -------------------------------------------------------
fn num(s: &str) -> u16 {
    let s = s.trim_start_matches('#');
    if let Some(h) = s.strip_prefix('$') { u16::from_str_radix(h, 16).unwrap() } else { s.parse().unwrap() }
}

fn assemble(src: &str, org: u16) -> Vec<u8> {
    let mut labels: HashMap<String, u16> = HashMap::new();
    let mut lines: Vec<(String, String)> = Vec::new();
    for raw in src.lines() {
        let mut l = raw.split(';').next().unwrap().trim().to_string();
        if l.is_empty() { continue; }
        while let Some(i) = l.find(':') {
            lines.push((l[..i].trim().to_string(), String::new()));
            l = l[i + 1..].trim().to_string();
        }
        if !l.is_empty() { lines.push((String::new(), l)); }
    }
    for pass in 0..2 {
        let mut out: Vec<u8> = Vec::new();
        for (label, ins) in &lines {
            let addr = org + out.len() as u16;
            if !label.is_empty() { labels.insert(label.clone(), addr); continue; }
            let mut it = ins.splitn(2, ' ');
            let m = it.next().unwrap().to_uppercase();
            let arg = it.next().unwrap_or("").trim().to_string();
            let imp = |op: u8, out: &mut Vec<u8>| out.push(op);
            let rel = |op: u8, out: &mut Vec<u8>, labels: &HashMap<String, u16>| {
                out.push(op);
                let t = *labels.get(&arg).unwrap_or(&0) as i32;
                out.push((t - (addr as i32 + 2)) as i8 as u8);
            };
            match m.as_str() {
                "BRK" => imp(0x00, &mut out), "NOP" => imp(0xEA, &mut out), "TAX" => imp(0xAA, &mut out),
                "TXA" => imp(0x8A, &mut out), "TAY" => imp(0xA8, &mut out), "TYA" => imp(0x98, &mut out),
                "INX" => imp(0xE8, &mut out), "INY" => imp(0xC8, &mut out), "DEX" => imp(0xCA, &mut out),
                "DEY" => imp(0x88, &mut out), "CLC" => imp(0x18, &mut out), "SEC" => imp(0x38, &mut out),
                "RTS" => imp(0x60, &mut out), "PHA" => imp(0x48, &mut out), "PLA" => imp(0x68, &mut out),
                "ASL" => imp(0x0A, &mut out), "LSR" => imp(0x4A, &mut out),
                "BNE" => rel(0xD0, &mut out, &labels), "BEQ" => rel(0xF0, &mut out, &labels),
                "BCC" => rel(0x90, &mut out, &labels), "BCS" => rel(0xB0, &mut out, &labels),
                "JMP" | "JSR" => {
                    out.push(if m == "JMP" { 0x4C } else { 0x20 });
                    let t = *labels.get(&arg).unwrap_or(&0);
                    out.push(t as u8); out.push((t >> 8) as u8);
                }
                _ => {
                    if arg.starts_with('#') {
                        let op = match m.as_str() { "LDA" => 0xA9, "LDX" => 0xA2, "LDY" => 0xA0, "ADC" => 0x69, "AND" => 0x29,
                            "ORA" => 0x09, "EOR" => 0x49, "CMP" => 0xC9, "CPX" => 0xE0, "CPY" => 0xC0, _ => panic!("bad op {}", m) };
                        out.push(op); out.push(num(&arg) as u8);
                    } else {
                        let (base, idx) = match arg.split_once(',') { Some((b, i)) => (b.trim(), i.trim().to_uppercase()), None => (arg.as_str(), String::new()) };
                        let v = num(base);
                        let zp = v < 256 && idx.is_empty() && matches!(m.as_str(), "LDA" | "STA" | "ADC" | "STX");
                        let op = match (m.as_str(), idx.as_str(), zp) {
                            ("LDA", "", true) => 0xA5, ("LDA", "", false) => 0xAD, ("LDA", "X", _) => 0xBD,
                            ("STA", "", true) => 0x85, ("STA", "", false) => 0x8D, ("STA", "X", _) => 0x9D, ("STA", "Y", _) => 0x99,
                            ("ADC", "", true) => 0x65, ("STX", "", true) => 0x86, _ => panic!("unsupported {} {}", m, arg) };
                        out.push(op);
                        out.push(v as u8);
                        if !zp { out.push((v >> 8) as u8); }
                    }
                }
            }
        }
        if pass == 1 { return out; }
    }
    unreachable!()
}

fn main() {
    let program = "
        ; part 1: sum 1..10 into $10
            LDX #10
            LDA #0
        add: STX $11
            CLC
            ADC $11
            DEX
            BNE add
            STA $10
        ; part 2: paint the 32x32 screen (colour = x & 15), then a bright diagonal
            LDX #0
        fill: TXA
            AND #$0F
            STA $0200,X
            STA $0300,X
            STA $0400,X
            STA $0500,X
            INX
            BNE fill
            LDX #0
            LDY #0
        diag: LDA #15
            STA $0200,Y
            TYA
            CLC
            ADC #33
            TAY
            INX
            CPX #31
            BNE diag
            BRK
    ";
    let code = assemble(program, 0x0600);
    println!("assembled {} bytes at $0600: {:02X?}", code.len(), &code[..12.min(code.len())]);

    let mut cpu = Cpu::new();
    cpu.mem[0x0600..0x0600 + code.len()].copy_from_slice(&code);
    let mut steps = 0;
    while !cpu.halted && steps < 100_000 {
        let line = cpu.step();
        if steps < 8 { println!("{}", line); }
        steps += 1;
    }
    println!("...\nhalted after {} instructions, ~{} cycles", steps, cpu.cycles);
    println!("sum(1..10) at $10 = {}", cpu.mem[0x10]);

    let shades: Vec<char> = " .,:;ox%#@abcdef".chars().collect();
    println!("\nscreen ($0200-$05FF):");
    for row in 0..32 {
        let line: String = (0..32).map(|col| shades[(cpu.mem[0x0200 + row * 32 + col] & 15) as usize]).collect();
        println!("|{}|", line);
    }
}
