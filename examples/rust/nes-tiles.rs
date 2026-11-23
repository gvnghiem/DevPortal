// NES-style graphics: the PPU stores each 8x8 tile as two bit-planes (16 bytes).
// Combine plane 0 and plane 1 to get a 2-bit colour index per pixel — then map it to a palette.
// The tile data below is original pixel art (a tiny heart + a smiling "slime").
const HEART: [u8; 16] = [
    // plane 0 (low bit)
    0b01100110, 0b11111111, 0b11111111, 0b11111111, 0b01111110, 0b00111100, 0b00011000, 0b00000000,
    // plane 1 (high bit)
    0b00000000, 0b01100110, 0b01011110, 0b01111110, 0b00111100, 0b00011000, 0b00000000, 0b00000000,
];
const SLIME: [u8; 16] = [
    0b00000000, 0b00111100, 0b01111110, 0b11111111, 0b11111111, 0b11111111, 0b11111111, 0b01111110,
    0b00000000, 0b00000000, 0b00100100, 0b00100100, 0b00000000, 0b01000010, 0b00111100, 0b00000000,
];
const GRASS: [u8; 16] = [
    0b00000000, 0b01000100, 0b01010100, 0b11010101, 0b11111111, 0b11111111, 0b11111111, 0b11111111,
    0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b11111111, 0b11111111, 0b11111111, 0b11111111,
];

// Colour index (0..3) -> a character from the "palette"
const PALETTE: [&str; 4] = ["  ", "░░", "▒▒", "██"];

fn decode(tile: &[u8; 16]) -> [[u8; 8]; 8] {
    let mut px = [[0u8; 8]; 8];
    for row in 0..8 {
        for col in 0..8 {
            let bit = 7 - col;
            let lo = (tile[row] >> bit) & 1;
            let hi = (tile[row + 8] >> bit) & 1;
            px[row][col] = (hi << 1) | lo;
        }
    }
    px
}

fn main() {
    let tiles = [("heart", HEART), ("slime", SLIME), ("grass", GRASS)];
    for (name, t) in tiles.iter() {
        println!("tile '{}':", name);
        for row in decode(t).iter() {
            println!("  {}", row.iter().map(|&c| PALETTE[c as usize]).collect::<String>());
        }
    }

    // A 12x6 "nametable": each cell is a tile index, like the NES background layer.
    let map: [[usize; 12]; 6] = [
        [3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3],
        [3, 0, 3, 3, 3, 3, 3, 3, 3, 3, 0, 3],
        [3, 3, 3, 3, 3, 1, 3, 3, 3, 3, 3, 3],
        [3, 3, 3, 3, 3, 3, 3, 3, 1, 3, 3, 3],
        [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
        [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
    ];
    let set = [decode(&HEART), decode(&SLIME), decode(&GRASS)];
    println!("\nbackground ({} x {} tiles = {} x {} pixels):", 12, 6, 12 * 8, 6 * 8);
    for ty in 0..6 {
        for py in 0..8 {
            let mut line = String::new();
            for tx in 0..12 {
                let idx = map[ty][tx];
                if idx == 3 {
                    line.push_str(&"  ".repeat(8));
                } else {
                    for px in 0..8 {
                        line.push_str(PALETTE[set[idx][py][px] as usize]);
                    }
                }
            }
            println!("{}", line.trim_end());
        }
    }
}
