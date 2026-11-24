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
/// v2 (additive): `blit` + `open_file` imports, `dp_alloc` + `dp_file` exports.
/// v3 (additive): `audio_rate` + `audio_push` imports, `dp_gamepad` export. The page accepts v1, v2 and v3 apps.
pub const ABI_VERSION: u32 = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rgba(pub u32);
impl Rgba {
    #[allow(clippy::self_named_constructors)]
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
    /// Draw `sw`×`sh` RGBA pixels (`pixels.len() == sw*sh*4`), scaled without smoothing into `dest` = (x, y, w, h).
    fn blit(&mut self, pixels: &[u8], sw: u32, sh: u32, dest: (f32, f32, f32, f32));
    /// Ask the page to show a file picker. Only works from inside a click/key handler (browser rule);
    /// the chosen file (or one dropped on the canvas) arrives in [`App::file`].
    fn open_file(&mut self);
    /// Sample rate (Hz) of the page's audio output — fixed once the page starts. 0 if audio is unavailable.
    fn audio_rate(&mut self) -> u32;
    /// Queue mono samples (-1.0..1.0) for playback. Call every frame with that frame's worth of audio;
    /// the page keeps a short buffer and drops audio rather than letting the delay grow.
    fn audio_push(&mut self, samples: &[f32]);
}

/// A connected game controller, as the browser's Gamepad API reports it (the "standard" layout used by
/// Xbox, PlayStation and most other pads): bit *n* of `buttons` is standard button *n*
/// (0 = bottom face, 1 = right, 2 = left, 3 = top, 4/5 = bumpers, 6/7 = triggers, 8 = back/select,
/// 9 = start, 10/11 = stick clicks, 12-15 = d-pad up/down/left/right, 16 = home). Axes: left stick x/y, right stick x/y, -1..1.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Gamepad { pub buttons: u32, pub axes: [f32; 4] }

impl Gamepad {
    pub fn pressed(&self, button: u32) -> bool { button < 32 && self.buttons & (1 << button) != 0 }
}

pub trait App: Send {
    fn init(&mut self, _w: f32, _h: f32) {}
    fn resize(&mut self, _w: f32, _h: f32) {}
    fn frame(&mut self, g: &mut dyn Gfx, t_ms: f64);
    fn pointer(&mut self, _p: Pointer) {}
    fn key(&mut self, _code: u32, _down: bool, _mods: Mods) {}
    /// A file the user picked or dropped.
    fn file(&mut self, _name: &str, _data: Vec<u8>) {}
    /// Controller `index` (the browser's slot number) is connected and in this state, or `None` when it was unplugged.
    /// Sent every frame while connected, before `frame`.
    fn gamepad(&mut self, _index: u32, _state: Option<Gamepad>) {}
}

/// Export the entry points the page calls: `dp_init`, `dp_resize`, `dp_frame`, `dp_pointer`, `dp_key`, `dp_alloc`, `dp_file`, `dp_gamepad`.
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

        /// The page asks for `len` bytes to copy a file into; ownership comes back through `dp_file`.
        #[cfg(target_arch = "wasm32")]
        #[no_mangle]
        pub extern "C" fn dp_alloc(len: u32) -> *mut u8 {
            let mut v = ::std::vec![0u8; len as usize];
            let p = v.as_mut_ptr();
            ::std::mem::forget(v);
            p
        }

        #[cfg(target_arch = "wasm32")]
        #[no_mangle]
        pub extern "C" fn dp_file(ptr: *mut u8, len: u32, name_ptr: *mut u8, name_len: u32) {
            // SAFETY: both pointers came from `dp_alloc` with exactly these lengths and the page uses each once.
            let (data, name) = unsafe { (Vec::from_raw_parts(ptr, len as usize, len as usize), Vec::from_raw_parts(name_ptr, name_len as usize, name_len as usize)) };
            if let Some(a) = DP_APP.lock().unwrap().as_mut() { a.file(&String::from_utf8_lossy(&name), data); }
        }

        #[cfg(target_arch = "wasm32")]
        #[no_mangle]
        pub extern "C" fn dp_gamepad(index: u32, connected: u32, buttons: u32, lx: f32, ly: f32, rx: f32, ry: f32) {
            let state = if connected != 0 { Some($crate::Gamepad { buttons, axes: [lx, ly, rx, ry] }) } else { None };
            if let Some(a) = DP_APP.lock().unwrap().as_mut() { a.gamepad(index, state); }
        }
    };
}
