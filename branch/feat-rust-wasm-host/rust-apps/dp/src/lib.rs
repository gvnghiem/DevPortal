//! `dp` — the whole contract between a Rust app and the DevPortal page, in one file.
//!
//! The page owns a <canvas>. Your app implements [`App`]; each animation frame the page calls
//! `App::frame` and you draw with the [`Gfx`] calls (clear, rect, line, circle, polygon, text).
//! Input (pointer, wheel, keys) arrives as plain method calls. There is no wasm-bindgen: the
//! functions below compile to plain WebAssembly imports/exports (see `host`).
//!
//! Colours are `0xRRGGBBAA` (see [`Rgba`]). Coordinates are CSS pixels, origin top-left.
//! Use [`dp_app!`] once in your crate to export the entry points the page looks for.

pub mod keys;
pub mod recorder;
#[cfg(target_arch = "wasm32")]
pub mod host;

/// Bump when an import/export signature changes; the page refuses an app built for another version.
pub const ABI_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rgba(pub u32);
impl Rgba {
    pub const fn rgba(r: u8, g: u8, b: u8, a: u8) -> Self {
        Rgba(((r as u32) << 24) | ((g as u32) << 16) | ((b as u32) << 8) | a as u32)
    }
    pub const fn rgb(r: u8, g: u8, b: u8) -> Self { Self::rgba(r, g, b, 255) }
    pub const fn with_alpha(self, a: u8) -> Self { Rgba((self.0 & 0xffff_ff00) | a as u32) }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Cursor { Default = 0, Pointer = 1, Crosshair = 2, Move = 3, Grab = 4, ResizeNs = 5, ResizeEw = 6, Text = 7 }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PointerKind { Move, Down, Up, Wheel }
impl PointerKind {
    pub fn from_u32(v: u32) -> Self {
        match v { 1 => Self::Down, 2 => Self::Up, 3 => Self::Wheel, _ => Self::Move }
    }
}

/// One pointer event. `buttons` is a bit set (1 = left, 2 = right, 4 = middle); `delta` is the wheel delta.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pointer { pub kind: PointerKind, pub x: f32, pub y: f32, pub buttons: u32, pub delta: f32 }

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Mods(pub u32);
impl Mods {
    pub fn shift(self) -> bool { self.0 & 1 != 0 }
    pub fn ctrl(self) -> bool { self.0 & 2 != 0 }
    pub fn alt(self) -> bool { self.0 & 4 != 0 }
    pub fn meta(self) -> bool { self.0 & 8 != 0 }
}

/// Everything an app can draw with. Implemented by the browser host and by [`recorder::Recorder`] (for tests).
pub trait Gfx {
    fn clear(&mut self, c: Rgba);
    fn rect(&mut self, x: f32, y: f32, w: f32, h: f32, c: Rgba, fill: bool);
    fn line(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, width: f32, c: Rgba);
    fn circle(&mut self, cx: f32, cy: f32, r: f32, c: Rgba, fill: bool);
    fn poly(&mut self, pts: &[(f32, f32)], c: Rgba, fill: bool);
    fn text(&mut self, s: &str, x: f32, y: f32, size: f32, c: Rgba);
    fn cursor(&mut self, k: Cursor);
    /// Print a line in the DevPortal Console tab.
    fn log(&mut self, s: &str);
}

pub trait App: Send {
    fn init(&mut self, _w: f32, _h: f32) {}
    fn resize(&mut self, _w: f32, _h: f32) {}
    fn frame(&mut self, g: &mut dyn Gfx, t_ms: f64);
    fn pointer(&mut self, _p: Pointer) {}
    fn key(&mut self, _code: u32, _down: bool, _mods: Mods) {}
}

/// Export the entry points the page calls: `dp_init`, `dp_resize`, `dp_frame`, `dp_pointer`, `dp_key`.
/// `dp_app!(MyApp::new())` — the expression is evaluated once, on `dp_init`. Does nothing off-wasm (tests).
#[macro_export]
macro_rules! dp_app {
    ($ctor:expr) => {
        #[cfg(target_arch = "wasm32")]
        static DP_APP: ::std::sync::Mutex<Option<Box<dyn $crate::App>>> = ::std::sync::Mutex::new(None);

        #[cfg(target_arch = "wasm32")]
        #[no_mangle]
        pub extern "C" fn dp_abi_version() -> u32 { $crate::ABI_VERSION }

        #[cfg(target_arch = "wasm32")]
        #[no_mangle]
        pub extern "C" fn dp_init(w: f32, h: f32) {
            $crate::host::install_panic_hook();
            let mut app: Box<dyn $crate::App> = Box::new($ctor);
            app.init(w, h);
            *DP_APP.lock().unwrap() = Some(app);
        }

        #[cfg(target_arch = "wasm32")]
        #[no_mangle]
        pub extern "C" fn dp_resize(w: f32, h: f32) {
            if let Some(a) = DP_APP.lock().unwrap().as_mut() { a.resize(w, h); }
        }

        #[cfg(target_arch = "wasm32")]
        #[no_mangle]
        pub extern "C" fn dp_frame(t_ms: f64) {
            if let Some(a) = DP_APP.lock().unwrap().as_mut() { a.frame(&mut $crate::host::HostGfx, t_ms); }
        }

        #[cfg(target_arch = "wasm32")]
        #[no_mangle]
        pub extern "C" fn dp_pointer(kind: u32, x: f32, y: f32, buttons: u32, delta: f32) {
            if let Some(a) = DP_APP.lock().unwrap().as_mut() {
                a.pointer($crate::Pointer { kind: $crate::PointerKind::from_u32(kind), x, y, buttons, delta });
            }
        }

        #[cfg(target_arch = "wasm32")]
        #[no_mangle]
        pub extern "C" fn dp_key(code: u32, down: u32, mods: u32) {
            if let Some(a) = DP_APP.lock().unwrap().as_mut() { a.key(code, down != 0, $crate::Mods(mods)); }
        }
    };
}
