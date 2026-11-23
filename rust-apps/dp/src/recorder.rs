//! A [`Gfx`] that just remembers what was drawn, so app logic can be unit-tested natively (`cargo test`).
use crate::{Cursor, Gfx, Rgba};

#[derive(Clone, Debug, PartialEq)]
pub enum Cmd {
    Clear(Rgba),
    Rect { x: f32, y: f32, w: f32, h: f32, c: Rgba, fill: bool },
    Line { x1: f32, y1: f32, x2: f32, y2: f32, width: f32, c: Rgba },
    Circle { cx: f32, cy: f32, r: f32, c: Rgba, fill: bool },
    Poly { pts: Vec<(f32, f32)>, c: Rgba, fill: bool },
    Text { s: String, x: f32, y: f32, size: f32, c: Rgba },
    Cursor(Cursor),
    Log(String),
    Blit { sw: u32, sh: u32, x: f32, y: f32, w: f32, h: f32, pixels: Vec<u8> },
    OpenFile,
}

#[derive(Default)]
pub struct Recorder { pub cmds: Vec<Cmd> }
impl Recorder {
    pub fn new() -> Self { Self::default() }
    pub fn texts(&self) -> Vec<&str> {
        self.cmds.iter().filter_map(|c| if let Cmd::Text { s, .. } = c { Some(s.as_str()) } else { None }).collect()
    }
    pub fn count(&self, f: impl Fn(&Cmd) -> bool) -> usize { self.cmds.iter().filter(|c| f(c)).count() }
}
impl Gfx for Recorder {
    fn clear(&mut self, c: Rgba) { self.cmds.push(Cmd::Clear(c)) }
    fn rect(&mut self, x: f32, y: f32, w: f32, h: f32, c: Rgba, fill: bool) { self.cmds.push(Cmd::Rect { x, y, w, h, c, fill }) }
    fn line(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, width: f32, c: Rgba) { self.cmds.push(Cmd::Line { x1, y1, x2, y2, width, c }) }
    fn circle(&mut self, cx: f32, cy: f32, r: f32, c: Rgba, fill: bool) { self.cmds.push(Cmd::Circle { cx, cy, r, c, fill }) }
    fn poly(&mut self, pts: &[(f32, f32)], c: Rgba, fill: bool) { self.cmds.push(Cmd::Poly { pts: pts.to_vec(), c, fill }) }
    fn text(&mut self, s: &str, x: f32, y: f32, size: f32, c: Rgba) { self.cmds.push(Cmd::Text { s: s.to_string(), x, y, size, c }) }
    fn cursor(&mut self, k: Cursor) { self.cmds.push(Cmd::Cursor(k)) }
    fn log(&mut self, s: &str) { self.cmds.push(Cmd::Log(s.to_string())) }
    fn blit(&mut self, pixels: &[u8], sw: u32, sh: u32, (x, y, w, h): (f32, f32, f32, f32)) { self.cmds.push(Cmd::Blit { sw, sh, x, y, w, h, pixels: pixels.to_vec() }) }
    fn open_file(&mut self) { self.cmds.push(Cmd::OpenFile) }
}
