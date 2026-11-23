// Tic-tac-toe with an unbeatable minimax AI. X (AI) plays against O (a scripted "human").
#[derive(Clone, Copy, PartialEq)]
enum Cell { Empty, X, O }

type Board = [Cell; 9];

const LINES: [[usize; 3]; 8] = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

fn winner(b: &Board) -> Option<Cell> {
    for l in LINES.iter() {
        if b[l[0]] != Cell::Empty && b[l[0]] == b[l[1]] && b[l[1]] == b[l[2]] {
            return Some(b[l[0]]);
        }
    }
    None
}

fn full(b: &Board) -> bool { b.iter().all(|&c| c != Cell::Empty) }

fn minimax(b: &mut Board, x_turn: bool, nodes: &mut u32) -> i32 {
    *nodes += 1;
    match winner(b) {
        Some(Cell::X) => return 1,
        Some(Cell::O) => return -1,
        _ => {}
    }
    if full(b) { return 0; }
    let mut best = if x_turn { -2 } else { 2 };
    for i in 0..9 {
        if b[i] == Cell::Empty {
            b[i] = if x_turn { Cell::X } else { Cell::O };
            let score = minimax(b, !x_turn, nodes);
            b[i] = Cell::Empty;
            best = if x_turn { best.max(score) } else { best.min(score) };
        }
    }
    best
}

fn best_move(b: &mut Board, nodes: &mut u32) -> usize {
    let mut best = (-2, 0);
    for i in 0..9 {
        if b[i] == Cell::Empty {
            b[i] = Cell::X;
            let s = minimax(b, false, nodes);
            b[i] = Cell::Empty;
            if s > best.0 { best = (s, i); }
        }
    }
    best.1
}

fn show(b: &Board) {
    for r in 0..3 {
        let row: Vec<&str> = (0..3).map(|c| match b[r * 3 + c] { Cell::X => "X", Cell::O => "O", Cell::Empty => "." }).collect();
        println!("  {}", row.join(" "));
    }
    println!();
}

fn main() {
    let mut b: Board = [Cell::Empty; 9];
    let human_moves = [0usize, 5, 7, 2, 3];
    let mut h = 0;
    println!("AI = X, scripted opponent = O\n");
    loop {
        let mut nodes = 0;
        let m = best_move(&mut b, &mut nodes);
        b[m] = Cell::X;
        println!("X plays {} (searched {} positions)", m, nodes);
        show(&b);
        if winner(&b).is_some() || full(&b) { break; }
        while h < human_moves.len() && b[human_moves[h]] != Cell::Empty { h += 1; }
        let o = if h < human_moves.len() { human_moves[h] } else { (0..9).find(|&i| b[i] == Cell::Empty).unwrap() };
        b[o] = Cell::O;
        println!("O plays {}", o);
        show(&b);
        if winner(&b).is_some() || full(&b) { break; }
    }
    match winner(&b) {
        Some(Cell::X) => println!("X wins!"),
        Some(Cell::O) => println!("O wins!"),
        _ => println!("It's a draw."),
    }
}
