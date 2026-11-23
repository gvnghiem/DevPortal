//! wasm32 only: the functions the page provides (module "env"). Keep in sync with the host JS in index.html.
use crate::{Cursor, Gfx, Rgba};

#[link(wasm_import_module = "env")]
extern "C" {
    fn dp_clear(rgba: u32);
    fn dp_rect(x: f32, y: f32, w: f32, h: f32, rgba: u32, fill: u32);
    fn dp_line(x1: f32, y1: f32, x2: f32, y2: f32, width: f32, rgba: u32);
    fn dp_circle(cx: f32, cy: f32, r: f32, rgba: u32, fill: u32);
    fn dp_poly(pts: *const f32, n: u32, rgba: u32, fill: u32);
    fn dp_text(ptr: *const u8, len: u32, x: f32, y: f32, size: f32, rgba: u32);
    fn dp_cursor(kind: u32);
    fn dp_log(ptr: *const u8, len: u32);
    fn dp_blit(ptr: *const u8, sw: u32, sh: u32, x: f32, y: f32, w: f32, h: f32);
    fn dp_open_file();
}

pub struct HostGfx;
impl Gfx for HostGfx {
    fn clear(&mut self, c: Rgba) { unsafe { dp_clear(c.0) } }
    fn rect(&mut self, x: f32, y: f32, w: f32, h: f32, c: Rgba, fill: bool) { unsafe { dp_rect(x, y, w, h, c.0, fill as u32) } }
    fn line(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, width: f32, c: Rgba) { unsafe { dp_line(x1, y1, x2, y2, width, c.0) } }
    fn circle(&mut self, cx: f32, cy: f32, r: f32, c: Rgba, fill: bool) { unsafe { dp_circle(cx, cy, r, c.0, fill as u32) } }
    fn poly(&mut self, pts: &[(f32, f32)], c: Rgba, fill: bool) {
        // (f32, f32) tuples are not guaranteed to be laid out as a flat f32 array, so flatten explicitly
        let flat: Vec<f32> = pts.iter().flat_map(|p| [p.0, p.1]).collect();
        unsafe { dp_poly(flat.as_ptr(), pts.len() as u32, c.0, fill as u32) }
    }
    fn text(&mut self, s: &str, x: f32, y: f32, size: f32, c: Rgba) { unsafe { dp_text(s.as_ptr(), s.len() as u32, x, y, size, c.0) } }
    fn cursor(&mut self, k: Cursor) { unsafe { dp_cursor(k as u32) } }
    fn log(&mut self, s: &str) { unsafe { dp_log(s.as_ptr(), s.len() as u32) } }
    fn blit(&mut self, pixels: &[u8], sw: u32, sh: u32, (x, y, w, h): (f32, f32, f32, f32)) {
        if pixels.len() as u64 == sw as u64 * sh as u64 * 4 { unsafe { dp_blit(pixels.as_ptr(), sw, sh, x, y, w, h) } }
    }
    fn open_file(&mut self) { unsafe { dp_open_file() } }
}

/// Panics become a message in the DevPortal Console (then the module traps and the page stops the loop).
pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| HostGfx.log(&format!("panic: {info}"))));
}
