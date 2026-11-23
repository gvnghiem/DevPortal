// Conway's Game of Life on a small wrapping grid, printed generation by generation.
const W: usize = 24;
const H: usize = 12;

#[derive(Clone)]
struct Life {
    cells: Vec<bool>,
}

impl Life {
    fn new() -> Self {
        Life { cells: vec![false; W * H] }
    }
    fn set(&mut self, x: usize, y: usize) {
        self.cells[y * W + x] = true;
    }
    fn neighbours(&self, x: usize, y: usize) -> usize {
        let mut n = 0;
        for dy in [H - 1, 0, 1] {
            for dx in [W - 1, 0, 1] {
                if dx == 0 && dy == 0 { continue; }
                if self.cells[((y + dy) % H) * W + (x + dx) % W] { n += 1; }
            }
        }
        n
    }
    fn step(&self) -> Life {
        let mut next = Life::new();
        for y in 0..H {
            for x in 0..W {
                let alive = self.cells[y * W + x];
                let n = self.neighbours(x, y);
                next.cells[y * W + x] = matches!((alive, n), (true, 2) | (true, 3) | (false, 3));
            }
        }
        next
    }
    fn show(&self, gen: u32) {
        println!("generation {} (alive: {})", gen, self.cells.iter().filter(|&&c| c).count());
        for y in 0..H {
            let row: String = (0..W).map(|x| if self.cells[y * W + x] { '#' } else { '.' }).collect();
            println!("{}", row);
        }
        println!();
    }
}

fn main() {
    let mut life = Life::new();
    // a glider
    for &(x, y) in &[(1, 0), (2, 1), (0, 2), (1, 2), (2, 2)] { life.set(x, y); }
    // a blinker
    for &(x, y) in &[(15, 6), (16, 6), (17, 6)] { life.set(x, y); }
    for gen in 0..5 {
        life.show(gen);
        life = life.step();
    }
}
