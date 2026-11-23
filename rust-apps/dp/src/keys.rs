//! Key codes = JavaScript `KeyboardEvent.keyCode` (letters are the upper-case ASCII code).
pub const BACKSPACE: u32 = 8;
pub const TAB: u32 = 9;
pub const ENTER: u32 = 13;
pub const ESCAPE: u32 = 27;
pub const SPACE: u32 = 32;
pub const LEFT: u32 = 37;
pub const UP: u32 = 38;
pub const RIGHT: u32 = 39;
pub const DOWN: u32 = 40;
pub const DELETE: u32 = 46;
pub const fn letter(c: char) -> u32 { c.to_ascii_uppercase() as u32 }
