//! The 2A03's audio unit: two pulse channels, triangle, noise and DMC, the frame counter (length counters,
//! envelopes, sweeps, frame IRQ), the console's non-linear mixer and its output filters.
//! `tick` runs one CPU cycle; samples are produced at the host's sample rate by averaging the cycles in between.
//! Not modelled: the few-cycle write delays of $4017/$4003 and the DMC's effect on CPU read timing beyond a flat stall.

const LENGTHS: [u8; 32] = [10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14, 12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30];
const DUTY: [[u8; 8]; 4] = [[0, 1, 0, 0, 0, 0, 0, 0], [0, 1, 1, 0, 0, 0, 0, 0], [0, 1, 1, 1, 1, 0, 0, 0], [1, 0, 0, 1, 1, 1, 1, 1]];
const NOISE_PERIODS: [u16; 16] = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];
const DMC_RATES: [u16; 16] = [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54];
pub const CPU_HZ: f64 = 1_789_773.0;

#[derive(Clone, Default)]
struct Envelope { start: bool, looping: bool, constant: bool, period: u8, divider: u8, decay: u8 }

impl Envelope {
    fn clock(&mut self) {
        if self.start { self.start = false; self.decay = 15; self.divider = self.period; }
        else if self.divider == 0 {
            self.divider = self.period;
            if self.decay > 0 { self.decay -= 1 } else if self.looping { self.decay = 15 }
        } else { self.divider -= 1 }
    }
    fn volume(&self) -> u8 { if self.constant { self.period } else { self.decay } }
}

#[derive(Clone, Default)]
struct Sweep { enabled: bool, period: u8, negate: bool, shift: u8, reload: bool, divider: u8 }

#[derive(Clone, Default)]
struct Pulse {
    enabled: bool, duty: u8, step: u8, timer: u16, period: u16, len: u8,
    env: Envelope, sweep: Sweep,
    /// Pulse 1 subtracts one extra when the sweep negates (one's complement); pulse 2 doesn't.
    ones_complement: bool,
}

impl Pulse {
    fn target(&self) -> i32 {
        let change = (self.period >> self.sweep.shift) as i32;
        if self.sweep.negate { self.period as i32 - change - self.ones_complement as i32 } else { self.period as i32 + change }
    }
    fn muted(&self) -> bool { self.period < 8 || self.target() > 0x7FF }
    fn tick(&mut self) { if self.timer == 0 { self.timer = self.period; self.step = (self.step + 1) & 7; } else { self.timer -= 1; } }
    fn clock_length(&mut self) { if !self.env.looping && self.len > 0 { self.len -= 1; } }
    fn clock_sweep(&mut self) {
        if self.sweep.divider == 0 && self.sweep.enabled && self.sweep.shift > 0 && !self.muted() { self.period = self.target() as u16; }
        if self.sweep.divider == 0 || self.sweep.reload { self.sweep.divider = self.sweep.period; self.sweep.reload = false; } else { self.sweep.divider -= 1; }
    }
    fn output(&self) -> u8 {
        if !self.enabled || self.len == 0 || self.muted() || DUTY[self.duty as usize][self.step as usize] == 0 { 0 } else { self.env.volume() }
    }
    fn write(&mut self, reg: u16, v: u8) {
        match reg & 3 {
            0 => { self.duty = v >> 6; self.env.looping = v & 0x20 != 0; self.env.constant = v & 0x10 != 0; self.env.period = v & 15; }
            1 => { self.sweep = Sweep { enabled: v & 0x80 != 0, period: (v >> 4) & 7, negate: v & 8 != 0, shift: v & 7, reload: true, divider: self.sweep.divider }; }
            2 => self.period = (self.period & 0x700) | v as u16,
            _ => {
                self.period = (self.period & 0xFF) | (v as u16 & 7) << 8;
                if self.enabled { self.len = LENGTHS[(v >> 3) as usize]; }
                self.step = 0; self.env.start = true;
            }
        }
    }
}

#[derive(Clone, Default)]
struct Triangle { enabled: bool, control: bool, linear_reload: u8, linear: u8, reload_flag: bool, timer: u16, period: u16, len: u8, step: u8 }

impl Triangle {
    fn tick(&mut self) {
        if self.timer == 0 { self.timer = self.period; if self.len > 0 && self.linear > 0 { self.step = (self.step + 1) & 31; } } else { self.timer -= 1; }
    }
    fn clock_linear(&mut self) {
        if self.reload_flag { self.linear = self.linear_reload } else if self.linear > 0 { self.linear -= 1 }
        if !self.control { self.reload_flag = false; }
    }
    fn clock_length(&mut self) { if !self.control && self.len > 0 { self.len -= 1; } }
    fn output(&self) -> u8 { if self.step < 16 { 15 - self.step } else { self.step - 16 } }
    fn write(&mut self, reg: u16, v: u8) {
        match reg & 3 {
            0 => { self.control = v & 0x80 != 0; self.linear_reload = v & 0x7F; }
            2 => self.period = (self.period & 0x700) | v as u16,
            3 => { self.period = (self.period & 0xFF) | (v as u16 & 7) << 8; if self.enabled { self.len = LENGTHS[(v >> 3) as usize]; } self.reload_flag = true; }
            _ => {}
        }
    }
}

#[derive(Clone)]
struct Noise { enabled: bool, env: Envelope, mode: bool, timer: u16, period: u16, len: u8, lfsr: u16 }

impl Noise {
    fn new() -> Self { Noise { enabled: false, env: Envelope::default(), mode: false, timer: 0, period: NOISE_PERIODS[0], len: 0, lfsr: 1 } }
    fn tick(&mut self) {
        if self.timer == 0 {
            self.timer = self.period - 1;
            let fb = (self.lfsr & 1) ^ ((self.lfsr >> if self.mode { 6 } else { 1 }) & 1);
            self.lfsr = (self.lfsr >> 1) | fb << 14;
        } else { self.timer -= 1; }
    }
    fn clock_length(&mut self) { if !self.env.looping && self.len > 0 { self.len -= 1; } }
    fn output(&self) -> u8 { if !self.enabled || self.len == 0 || self.lfsr & 1 != 0 { 0 } else { self.env.volume() } }
    fn write(&mut self, reg: u16, v: u8) {
        match reg & 3 {
            0 => { self.env.looping = v & 0x20 != 0; self.env.constant = v & 0x10 != 0; self.env.period = v & 15; }
            2 => { self.mode = v & 0x80 != 0; self.period = NOISE_PERIODS[(v & 15) as usize]; }
            3 => { if self.enabled { self.len = LENGTHS[(v >> 3) as usize]; } self.env.start = true; }
            _ => {}
        }
    }
}

#[derive(Clone, Default)]
struct Dmc {
    irq_enable: bool, looping: bool, rate: u16, timer: u16,
    level: u8, addr_reg: u16, len_reg: u16,
    addr: u16, remaining: u16,
    buffer: Option<u8>, shift: u8, bits: u8, silence: bool,
    irq: bool,
}

impl Dmc {
    fn restart(&mut self) { self.addr = self.addr_reg; self.remaining = self.len_reg; }
    /// The address the memory reader wants next (it wants one whenever the sample buffer is empty).
    fn wants_byte(&self) -> Option<u16> { if self.buffer.is_none() && self.remaining > 0 { Some(self.addr) } else { None } }
    fn supply(&mut self, b: u8) {
        self.buffer = Some(b);
        self.addr = if self.addr == 0xFFFF { 0x8000 } else { self.addr + 1 };
        self.remaining -= 1;
        if self.remaining == 0 { if self.looping { self.restart() } else if self.irq_enable { self.irq = true } }
    }
    fn tick(&mut self) {
        if self.timer > 0 { self.timer -= 1; return; }
        self.timer = self.rate.max(2) - 1;
        if !self.silence {
            if self.shift & 1 != 0 { if self.level <= 125 { self.level += 2 } } else if self.level >= 2 { self.level -= 2 }
            self.shift >>= 1;
        }
        if self.bits > 0 { self.bits -= 1; }
        if self.bits == 0 {
            self.bits = 8;
            match self.buffer.take() { Some(b) => { self.shift = b; self.silence = false; } None => self.silence = true }
        }
    }
    fn write(&mut self, reg: u16, v: u8) {
        match reg & 3 {
            0 => { self.irq_enable = v & 0x80 != 0; self.looping = v & 0x40 != 0; self.rate = DMC_RATES[(v & 15) as usize]; if !self.irq_enable { self.irq = false; } }
            1 => self.level = v & 0x7F,
            2 => self.addr_reg = 0xC000 | (v as u16) << 6,
            _ => self.len_reg = (v as u16) << 4 | 1,
        }
    }
}

struct HighPass { a: f32, px: f32, py: f32 }
impl HighPass {
    fn new(hz: f32, rate: f32) -> Self { let rc = 1.0 / (2.0 * std::f32::consts::PI * hz); HighPass { a: rc / (rc + 1.0 / rate), px: 0.0, py: 0.0 } }
    fn run(&mut self, x: f32) -> f32 { let y = self.a * (self.py + x - self.px); self.px = x; self.py = y; y }
}
struct LowPass { k: f32, y: f32 }
impl LowPass {
    fn new(hz: f32, rate: f32) -> Self { let rc = 1.0 / (2.0 * std::f32::consts::PI * hz); LowPass { k: (1.0 / rate) / (rc + 1.0 / rate), y: 0.0 } }
    fn run(&mut self, x: f32) -> f32 { self.y += self.k * (x - self.y); self.y }
}

pub struct Apu {
    p1: Pulse, p2: Pulse, tri: Triangle, noise: Noise, dmc: Dmc,
    fc: u32, five_step: bool, irq_inhibit: bool, frame_irq: bool,
    cycle: u64,
    pulse_table: [f32; 31], tnd_table: [f32; 203],
    cycles_per_sample: f64, phase: f64, acc: f32, n: f32,
    hp1: HighPass, hp2: HighPass, lp: LowPass,
    samples: Vec<f32>,
}

impl Default for Apu { fn default() -> Self { Self::new(48_000) } }

impl Apu {
    pub fn new(rate: u32) -> Self {
        let mut pulse_table = [0.0; 31];
        for (i, v) in pulse_table.iter_mut().enumerate().skip(1) { *v = 95.52 / (8128.0 / i as f32 + 100.0); }
        let mut tnd_table = [0.0; 203];
        for (i, v) in tnd_table.iter_mut().enumerate().skip(1) { *v = 163.67 / (24329.0 / i as f32 + 100.0); }
        let r = rate.max(8000) as f32;
        Apu {
            p1: Pulse { ones_complement: true, ..Pulse::default() }, p2: Pulse::default(), tri: Triangle::default(), noise: Noise::new(), dmc: Dmc { silence: true, bits: 8, rate: DMC_RATES[0], ..Dmc::default() },
            fc: 0, five_step: false, irq_inhibit: false, frame_irq: false, cycle: 0,
            pulse_table, tnd_table,
            cycles_per_sample: CPU_HZ / r as f64, phase: 0.0, acc: 0.0, n: 0.0,
            hp1: HighPass::new(90.0, r), hp2: HighPass::new(440.0, r), lp: LowPass::new(14_000.0, r),
            samples: Vec::new(),
        }
    }

    pub fn set_sample_rate(&mut self, rate: u32) {
        let r = rate.clamp(8000, 192_000) as f32;
        self.cycles_per_sample = CPU_HZ / r as f64;
        self.hp1 = HighPass::new(90.0, r); self.hp2 = HighPass::new(440.0, r); self.lp = LowPass::new(14_000.0, r);
    }

    /// Audio made since the last call (mono, -1..1).
    pub fn take_samples(&mut self) -> Vec<f32> { std::mem::take(&mut self.samples) }

    pub fn irq(&self) -> bool { self.frame_irq || self.dmc.irq }

    pub fn write(&mut self, addr: u16, v: u8) {
        match addr {
            0x4000..=0x4003 => self.p1.write(addr, v),
            0x4004..=0x4007 => self.p2.write(addr, v),
            0x4008..=0x400B => self.tri.write(addr, v),
            0x400C..=0x400F => self.noise.write(addr, v),
            0x4010..=0x4013 => self.dmc.write(addr, v),
            0x4015 => {
                self.p1.enabled = v & 1 != 0; if !self.p1.enabled { self.p1.len = 0; }
                self.p2.enabled = v & 2 != 0; if !self.p2.enabled { self.p2.len = 0; }
                self.tri.enabled = v & 4 != 0; if !self.tri.enabled { self.tri.len = 0; }
                self.noise.enabled = v & 8 != 0; if !self.noise.enabled { self.noise.len = 0; }
                self.dmc.irq = false;
                if v & 0x10 == 0 { self.dmc.remaining = 0; } else if self.dmc.remaining == 0 { self.dmc.restart(); }
            }
            0x4017 => {
                self.five_step = v & 0x80 != 0; self.irq_inhibit = v & 0x40 != 0;
                if self.irq_inhibit { self.frame_irq = false; }
                self.fc = 0;
                if self.five_step { self.clock_quarter(); self.clock_half(); }
            }
            _ => {}
        }
    }

    /// $4015 read: which channels are still running, and the IRQ flags. Clears the frame IRQ.
    pub fn read_status(&mut self) -> u8 {
        let s = (self.p1.len > 0) as u8 | ((self.p2.len > 0) as u8) << 1 | ((self.tri.len > 0) as u8) << 2 | ((self.noise.len > 0) as u8) << 3
            | ((self.dmc.remaining > 0) as u8) << 4 | (self.frame_irq as u8) << 6 | (self.dmc.irq as u8) << 7;
        self.frame_irq = false;
        s
    }

    fn clock_quarter(&mut self) { self.p1.env.clock(); self.p2.env.clock(); self.noise.env.clock(); self.tri.clock_linear(); }
    fn clock_half(&mut self) {
        self.p1.clock_length(); self.p2.clock_length(); self.tri.clock_length(); self.noise.clock_length();
        self.p1.clock_sweep(); self.p2.clock_sweep();
    }

    fn frame_counter(&mut self) {
        self.fc += 1;
        match (self.five_step, self.fc) {
            (_, 7457) | (_, 22371) => self.clock_quarter(),
            (_, 14913) => { self.clock_quarter(); self.clock_half(); }
            (false, 29828) => { if !self.irq_inhibit { self.frame_irq = true; } }
            (false, 29829) => { self.clock_quarter(); self.clock_half(); if !self.irq_inhibit { self.frame_irq = true; } }
            (false, 29830) => { if !self.irq_inhibit { self.frame_irq = true; } self.fc = 0; }
            (true, 37281) => { self.clock_quarter(); self.clock_half(); }
            (true, 37282) => self.fc = 0,
            _ => {}
        }
    }

    /// Current mixed level, 0..~1.
    pub fn mix(&self) -> f32 {
        let (p, t) = (self.p1.output() + self.p2.output(), 3 * self.tri.output() as usize + 2 * self.noise.output() as usize + self.dmc.level as usize);
        self.pulse_table[p as usize] + self.tnd_table[t]
    }

    /// One CPU cycle. Returns the address the DMC wants read, if any — answer it with [`Apu::supply_dmc`].
    pub fn tick(&mut self) -> Option<u16> {
        self.cycle += 1;
        self.frame_counter();
        if self.cycle & 1 == 0 { self.p1.tick(); self.p2.tick(); }
        self.tri.tick(); self.noise.tick(); self.dmc.tick();
        self.acc += self.mix(); self.n += 1.0;
        self.phase += 1.0;
        if self.phase >= self.cycles_per_sample {
            self.phase -= self.cycles_per_sample;
            let x = self.acc / self.n; self.acc = 0.0; self.n = 0.0;
            let y = self.lp.run(self.hp2.run(self.hp1.run(x)));
            if self.samples.len() >= 96_000 { self.samples.drain(..48_000); }        // nobody is listening: don't grow forever
            self.samples.push(y.clamp(-1.0, 1.0));
        }
        self.dmc.wants_byte()
    }

    pub fn supply_dmc(&mut self, b: u8) { self.dmc.supply(b); }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(a: &mut Apu, cycles: u32) { for _ in 0..cycles { a.tick(); } }
    fn status(a: &mut Apu) -> u8 { a.read_status() }

    #[test]
    fn length_counters_load_from_the_table_and_need_the_channel_enabled() {
        let mut a = Apu::default();
        a.write(0x4003, 0x08);                                    // index 1 = 254, but the channel is disabled
        assert_eq!(status(&mut a) & 1, 0);
        a.write(0x4015, 0x01); a.write(0x4003, 0x08);
        assert_eq!(status(&mut a) & 1, 1);
        a.write(0x4015, 0x00);
        assert_eq!(status(&mut a) & 1, 0, "disabling clears the length");
    }

    #[test]
    fn length_counts_down_on_half_frames_and_halt_freezes_it() {
        let mut a = Apu::default();
        a.write(0x4015, 0x01); a.write(0x4000, 0x00); a.write(0x4003, 0x18);      // length index 3 = 2 (not halted)
        run(&mut a, 14913 + 5); assert_eq!(status(&mut a) & 1, 1, "one half-frame so far: 2 -> 1");
        run(&mut a, 29830 - 14913); assert_eq!(status(&mut a) & 1, 0, "second half-frame: gone");
        let mut b = Apu::default();
        b.write(0x4015, 0x01); b.write(0x4000, 0x20); b.write(0x4003, 0x18);      // halt bit set
        run(&mut b, 60_000); assert_eq!(status(&mut b) & 1, 1);
    }

    #[test]
    fn four_step_mode_raises_the_frame_irq_unless_inhibited() {
        let mut a = Apu::default();
        run(&mut a, 29_000); assert!(!a.irq());
        run(&mut a, 1_000); assert!(a.irq());
        assert_eq!(status(&mut a) & 0x40, 0x40);
        assert!(!a.irq(), "reading $4015 clears it");
        let mut b = Apu::default(); b.write(0x4017, 0x40); run(&mut b, 40_000); assert!(!b.irq());
        let mut c = Apu::default(); c.write(0x4017, 0x80); run(&mut c, 80_000); assert!(!c.irq(), "five-step mode never raises it");
        let mut d = Apu::default(); run(&mut d, 30_000); assert!(d.irq()); d.write(0x4017, 0x40); assert!(!d.irq(), "inhibit also clears");
    }

    #[test]
    fn five_step_write_clocks_the_units_immediately() {
        let mut a = Apu::default();
        a.write(0x4015, 0x01); a.write(0x4000, 0x00); a.write(0x4003, 0x18);        // length 2
        a.write(0x4017, 0x80); assert_eq!(status(&mut a) & 1, 1, "2 -> 1");
        a.write(0x4017, 0x80); assert_eq!(status(&mut a) & 1, 0);
    }

    #[test]
    fn a_pulse_wave_follows_its_duty_pattern_and_timer() {
        let mut a = Apu::default();
        a.write(0x4015, 0x01); a.write(0x4000, 0b1011_1111);                         // duty 2 (50%), halt, constant volume 15
        a.write(0x4002, 0x10); a.write(0x4003, 0x08);                                // period 16: 2*17 = 34 CPU cycles per step
        let mut seen = vec![];
        for _ in 0..8 * 34 + 2 { a.tick(); if seen.last() != Some(&a.p1.output()) { seen.push(a.p1.output()); } }
        assert!(seen.contains(&15) && seen.contains(&0), "{seen:?}");
        assert!(seen.len() >= 3, "it toggles: {seen:?}");
    }

    #[test]
    fn periods_below_8_and_overflowing_sweeps_mute_a_pulse() {
        let mut a = Apu::default();
        a.write(0x4015, 0x01); a.write(0x4000, 0b1011_1111); a.write(0x4003, 0x08);
        a.write(0x4002, 0x07);
        for _ in 0..200 { a.tick(); assert_eq!(a.p1.output(), 0, "period 7 is silent"); }
        a.write(0x4002, 0xFF); a.write(0x4003, 0x0F | 0x08);                        // period 0x7FF
        a.write(0x4001, 0b0000_0001);                                                // sweep disabled but target = 0x7FF + 0x3FF > 0x7FF
        for _ in 0..4000 { a.tick(); assert_eq!(a.p1.output(), 0, "sweep overflow mutes even when the sweep is off"); }
    }

    #[test]
    fn sweep_changes_the_period_and_pulse1_negates_one_lower_than_pulse2() {
        let mut p1 = Pulse { ones_complement: true, period: 0x100, ..Pulse::default() };
        let mut p2 = Pulse { ones_complement: false, period: 0x100, ..Pulse::default() };
        for p in [&mut p1, &mut p2] { p.sweep = Sweep { enabled: true, period: 0, negate: true, shift: 1, reload: false, divider: 0 }; }
        p1.clock_sweep(); p2.clock_sweep();
        assert_eq!((p1.period, p2.period), (0x100 - 0x80 - 1, 0x100 - 0x80));
        let mut up = Pulse { period: 0x100, ..Pulse::default() };
        up.sweep = Sweep { enabled: true, period: 0, negate: false, shift: 2, reload: false, divider: 0 };
        up.clock_sweep(); assert_eq!(up.period, 0x140);
    }

    #[test]
    fn the_envelope_decays_once_per_period_and_loops_when_asked() {
        let mut e = Envelope { period: 1, ..Envelope::default() };
        e.start = true; e.clock(); assert_eq!(e.volume(), 15);
        e.clock(); assert_eq!(e.volume(), 15, "divider counting");
        e.clock(); assert_eq!(e.volume(), 14);
        let mut l = Envelope { period: 0, looping: true, decay: 1, ..Envelope::default() };
        l.clock(); assert_eq!(l.volume(), 0); l.clock(); assert_eq!(l.volume(), 15, "loop wraps to 15");
        let c = Envelope { period: 9, constant: true, ..Envelope::default() }; assert_eq!(c.volume(), 9);
    }

    #[test]
    fn the_triangle_walks_15_down_to_0_and_back_only_with_length_and_linear_counter() {
        let mut a = Apu::default();
        a.write(0x4015, 0x04); a.write(0x4008, 0xFF); a.write(0x400A, 0x00); a.write(0x400B, 0x08);   // control (no length decay), linear 127
        a.write(0x4017, 0x80);                                                                          // quarter-frame clock loads the linear counter
        let mut outs = vec![a.tri.output()]; for _ in 0..40 { a.tick(); if outs.last() != Some(&a.tri.output()) { outs.push(a.tri.output()); } }
        assert_eq!(&outs[..4], &[15, 14, 13, 12], "{outs:?}");
        let mut b = Apu::default(); b.write(0x4008, 0xFF); b.write(0x400B, 0x08);
        run(&mut b, 200); assert_eq!(b.tri.output(), 15, "disabled channel keeps its position");
    }

    #[test]
    fn noise_lfsr_shifts_with_the_right_feedback_taps() {
        let mut n = Noise::new(); n.period = 1;
        n.tick();
        assert_eq!(n.lfsr, 0x4000, "first clock: 1 xor 0 = 1 into bit 14");
        let mut m = Noise::new(); m.mode = true; m.period = 1; m.lfsr = 0b100_0000;
        m.tick(); assert_eq!(m.lfsr, 0b100_0000 >> 1 | 1 << 14, "short mode taps bit 6: 0 xor 1 = 1 into bit 14");
        let mut full = Noise::new(); full.period = 1; for _ in 0..40_000 { full.tick(); assert_ne!(full.lfsr, 0, "the register never locks at zero"); }
    }

    #[test]
    fn dmc_direct_load_plays_through_the_mixer_and_samples_arrive_via_the_reader() {
        let mut a = Apu::default();
        a.write(0x4011, 0x40); assert_eq!(a.dmc.level, 0x40);
        assert!(a.mix() > 0.2, "a DC level shows up in the mix");
        a.write(0x4010, 0x0F); a.write(0x4012, 0x00); a.write(0x4013, 0x00);       // fastest rate, address $C000, length 1
        a.write(0x4015, 0x10);
        let mut req = None; for _ in 0..4 { if let Some(r) = a.tick() { req = Some(r); break; } }
        assert_eq!(req, Some(0xC000));
        a.supply_dmc(0xFF);
        assert_eq!(status(&mut a) & 0x10, 0, "length 1: the only byte has been fetched");
        run(&mut a, 54 * 8 + 10);
        assert!(a.dmc.level > 0x40, "all-ones sample ramps the level up");
    }

    #[test]
    fn dmc_irq_fires_at_the_end_of_a_non_looping_sample_and_acknowledges_through_4015() {
        let mut a = Apu::default();
        a.write(0x4010, 0x8F); a.write(0x4013, 0x00); a.write(0x4015, 0x10);
        assert!(a.tick().is_some()); a.supply_dmc(0);
        assert!(a.irq()); assert_eq!(status(&mut a) & 0x80, 0x80);
        a.write(0x4015, 0x10); assert!(!a.irq(), "writing $4015 clears it");
        let mut l = Apu::default(); l.write(0x4010, 0x4F); l.write(0x4013, 0x00); l.write(0x4015, 0x10);
        l.tick(); l.supply_dmc(0); assert_eq!(l.dmc.remaining, 1, "looping restarts the sample"); assert!(!l.irq());
    }

    #[test]
    fn the_mixer_matches_the_published_non_linear_formula() {
        let mut a = Apu::default();
        a.p1.enabled = true; a.p1.len = 10; a.p1.period = 100; a.p1.env = Envelope { constant: true, period: 15, ..Envelope::default() };
        a.p1.duty = 3; a.p1.step = 0;                                                     // duty 3 starts high
        a.tri.step = 16;                                                                  // the triangle DAC always outputs its step; 16 = level 0
        assert!((a.mix() - 95.52 / (8128.0 / 15.0 + 100.0)).abs() < 1e-5, "{}", a.mix());
        let mut b = Apu::default(); b.tri.step = 16; b.dmc.level = 127;
        assert!((b.mix() - 163.67 / (24329.0 / 127.0 + 100.0)).abs() < 1e-5);
        let mut z = Apu::default(); z.tri.step = 16; assert_eq!(z.mix(), 0.0);
    }

    #[test]
    fn sample_count_follows_the_requested_rate_and_dc_is_filtered_out() {
        let mut a = Apu::new(44_100);
        a.write(0x4011, 0x7F);                                       // a constant DC level
        run(&mut a, 1_789_773 / 2);                                  // half a second
        let s = a.take_samples();
        assert!((s.len() as i32 - 22_050).abs() <= 2, "{}", s.len());
        let early = s[10..400].iter().fold(0f32, |m, x| m.max(x.abs()));
        let late = s[s.len() - 400..].iter().fold(0f32, |m, x| m.max(x.abs()));
        assert!(early > 0.05 && late < early / 20.0, "the high-pass removes the offset: {early} -> {late}");
        assert!(a.take_samples().is_empty(), "taken once");
        a.set_sample_rate(48_000); run(&mut a, 1_789_773 / 10); assert!((a.take_samples().len() as i32 - 4_800).abs() <= 2);
    }

    #[test]
    fn unread_audio_does_not_grow_without_bound() {
        let mut a = Apu::new(48_000);
        run(&mut a, 6_000_000);
        assert!(a.samples.len() <= 96_000);
    }
}
