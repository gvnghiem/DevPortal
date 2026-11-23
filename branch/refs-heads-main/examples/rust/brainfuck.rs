// A Brainfuck interpreter — a classic "write a VM in an afternoon" project.
use std::collections::HashMap;

fn run(program: &str, max_steps: usize) -> Result<String, String> {
    let code: Vec<char> = program.chars().filter(|c| "+-<>[].,".contains(*c)).collect();
    // pre-compute matching brackets
    let mut jump: HashMap<usize, usize> = HashMap::new();
    let mut stack = Vec::new();
    for (i, &c) in code.iter().enumerate() {
        if c == '[' { stack.push(i); }
        if c == ']' {
            let open = stack.pop().ok_or(format!("unmatched ] at {}", i))?;
            jump.insert(open, i);
            jump.insert(i, open);
        }
    }
    if let Some(i) = stack.pop() { return Err(format!("unmatched [ at {}", i)); }

    let mut tape = vec![0u8; 30000];
    let (mut ptr, mut pc, mut steps) = (0usize, 0usize, 0usize);
    let mut out = String::new();
    while pc < code.len() {
        steps += 1;
        if steps > max_steps { return Err("step limit exceeded".to_string()); }
        match code[pc] {
            '+' => tape[ptr] = tape[ptr].wrapping_add(1),
            '-' => tape[ptr] = tape[ptr].wrapping_sub(1),
            '>' => ptr += 1,
            '<' => ptr = ptr.checked_sub(1).ok_or("pointer moved left of the tape")?,
            '.' => out.push(tape[ptr] as char),
            '[' => if tape[ptr] == 0 { pc = jump[&pc]; },
            ']' => if tape[ptr] != 0 { pc = jump[&pc]; },
            _ => {}
        }
        pc += 1;
    }
    println!("({} steps)", steps);
    Ok(out)
}

fn main() {
    let hello = "++++++++[>++++[>++>+++>+++>+<<<<-]>+>+>->>+[<]<-]>>.>---.+++++++..+++.>>.<-.<.+++.------.--------.>>+.";
    match run(hello, 1_000_000) {
        Ok(s) => println!("output: {}", s.trim_end()),
        Err(e) => println!("error: {}", e),
    }
    // countdown: prints 9876543210 using a loop and two cells
    let countdown = "++++++++++>+++++++[>++++++++<-]>+<<[>>.-<<-]";
    match run(countdown, 5_000) {
        Ok(s) => println!("countdown: {}", s),
        Err(e) => println!("error: {}", e),
    }
    println!("{:?}", run("[[]", 10));
}
