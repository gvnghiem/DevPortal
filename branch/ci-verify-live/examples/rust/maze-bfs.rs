// Shortest path through an ASCII maze with breadth-first search, then draw the route.
use std::collections::VecDeque;

fn main() {
    let maze = [
        "S.#.........#..",
        ".##.#######.#.#",
        "....#.....#.#..",
        ".####.###.#.##.",
        ".#....#...#....",
        ".#.####.#####.#",
        ".#.#....#.....#",
        ".#.#.####.###..",
        "...#......#...E",
    ];
    let grid: Vec<Vec<char>> = maze.iter().map(|r| r.chars().collect()).collect();
    let (h, w) = (grid.len(), grid[0].len());
    let find = |t: char| -> (usize, usize) {
        for y in 0..h { for x in 0..w { if grid[y][x] == t { return (y, x); } } }
        panic!("missing {}", t)
    };
    let (start, goal) = (find('S'), find('E'));

    let mut prev: Vec<Vec<Option<(usize, usize)>>> = vec![vec![None; w]; h];
    let mut seen = vec![vec![false; w]; h];
    let mut q = VecDeque::new();
    q.push_back(start);
    seen[start.0][start.1] = true;
    let mut visited = 0;
    while let Some((y, x)) = q.pop_front() {
        visited += 1;
        if (y, x) == goal { break; }
        let dirs: [(i32, i32); 4] = [(0, 1), (1, 0), (0, -1), (-1, 0)];
        for (dy, dx) in dirs.iter() {
            let (ny, nx) = (y as i32 + dy, x as i32 + dx);
            if ny < 0 || nx < 0 || ny >= h as i32 || nx >= w as i32 { continue; }
            let (ny, nx) = (ny as usize, nx as usize);
            if grid[ny][nx] == '#' || seen[ny][nx] { continue; }
            seen[ny][nx] = true;
            prev[ny][nx] = Some((y, x));
            q.push_back((ny, nx));
        }
    }

    let mut out = grid.clone();
    let mut cur = goal;
    let mut len = 0;
    while let Some(p) = prev[cur.0][cur.1] {
        if p != start { out[p.0][p.1] = '*'; }
        cur = p;
        len += 1;
    }
    if len == 0 { println!("no path!"); return; }
    for row in &out { println!("{}", row.iter().collect::<String>()); }
    println!("\nshortest path: {} steps (explored {} cells)", len, visited);
}
