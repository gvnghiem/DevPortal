// A recursive-descent expression calculator: tokenizer -> parser -> evaluator, with error messages.
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
enum Tok { Num(f64), Ident(String), Op(char), LParen, RParen }

fn tokenize(s: &str) -> Result<Vec<Tok>, String> {
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    let mut out = Vec::new();
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() { i += 1; }
        else if c.is_ascii_digit() || c == '.' {
            let st = i;
            while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') { i += 1; }
            let t: String = chars[st..i].iter().collect();
            out.push(Tok::Num(t.parse().map_err(|_| format!("bad number '{}'", t))?));
        } else if c.is_alphabetic() {
            let st = i;
            while i < chars.len() && chars[i].is_alphanumeric() { i += 1; }
            out.push(Tok::Ident(chars[st..i].iter().collect()));
        } else if "+-*/^".contains(c) { out.push(Tok::Op(c)); i += 1; }
        else if c == '(' { out.push(Tok::LParen); i += 1; }
        else if c == ')' { out.push(Tok::RParen); i += 1; }
        else { return Err(format!("unexpected character '{}' at {}", c, i)); }
    }
    Ok(out)
}

struct Parser<'a> { toks: Vec<Tok>, pos: usize, vars: &'a HashMap<String, f64> }

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<&Tok> { self.toks.get(self.pos) }
    fn next(&mut self) -> Option<Tok> { let t = self.toks.get(self.pos).cloned(); self.pos += 1; t }
    // expr := term (('+'|'-') term)*
    fn expr(&mut self) -> Result<f64, String> {
        let mut v = self.term()?;
        while let Some(Tok::Op(c)) = self.peek().cloned() {
            if c != '+' && c != '-' { break; }
            self.next();
            let r = self.term()?;
            v = if c == '+' { v + r } else { v - r };
        }
        Ok(v)
    }
    // term := power (('*'|'/') power)*
    fn term(&mut self) -> Result<f64, String> {
        let mut v = self.power()?;
        while let Some(Tok::Op(c)) = self.peek().cloned() {
            if c != '*' && c != '/' { break; }
            self.next();
            let r = self.power()?;
            if c == '/' && r == 0.0 { return Err("division by zero".to_string()); }
            v = if c == '*' { v * r } else { v / r };
        }
        Ok(v)
    }
    // power := unary ('^' power)?   (right associative)
    fn power(&mut self) -> Result<f64, String> {
        let base = self.unary()?;
        if let Some(Tok::Op('^')) = self.peek() { self.next(); let e = self.power()?; return Ok(base.powf(e)); }
        Ok(base)
    }
    fn unary(&mut self) -> Result<f64, String> {
        if let Some(Tok::Op('-')) = self.peek() { self.next(); return Ok(-self.unary()?); }
        self.atom()
    }
    fn atom(&mut self) -> Result<f64, String> {
        match self.next() {
            Some(Tok::Num(n)) => Ok(n),
            Some(Tok::Ident(name)) => {
                if let Some(Tok::LParen) = self.peek() {
                    self.next();
                    let arg = self.expr()?;
                    match self.next() { Some(Tok::RParen) => {}, _ => return Err("expected ')'".to_string()) }
                    match name.as_str() {
                        "sqrt" => Ok(arg.sqrt()), "sin" => Ok(arg.sin()), "cos" => Ok(arg.cos()), "abs" => Ok(arg.abs()),
                        "ln" => Ok(arg.ln()), _ => Err(format!("unknown function '{}'", name)),
                    }
                } else {
                    self.vars.get(&name).copied().ok_or(format!("unknown variable '{}'", name))
                }
            }
            Some(Tok::LParen) => {
                let v = self.expr()?;
                match self.next() { Some(Tok::RParen) => Ok(v), _ => Err("expected ')'".to_string()) }
            }
            Some(t) => Err(format!("unexpected token {:?}", t)),
            None => Err("unexpected end of input".to_string()),
        }
    }
}

fn eval(s: &str, vars: &HashMap<String, f64>) -> Result<f64, String> {
    let toks = tokenize(s)?;
    let mut p = Parser { toks, pos: 0, vars };
    let v = p.expr()?;
    if p.pos < p.toks.len() { return Err(format!("unexpected token {:?}", p.toks[p.pos])); }
    Ok(v)
}

fn main() {
    let mut vars = HashMap::new();
    vars.insert("pi".to_string(), std::f64::consts::PI);
    vars.insert("r".to_string(), 2.5);
    let tests = ["1 + 2 * 3", "(1 + 2) * 3", "2 ^ 3 ^ 2", "-4 + 10 / 4", "pi * r ^ 2", "sqrt(144) + abs(-3)",
                 "10 / (5 - 5)", "2 +", "3 $ 4", "foo(1)", "x * 2"];
    for t in tests.iter() {
        match eval(t, &vars) {
            Ok(v) => println!("{:<22} = {}", t, v),
            Err(e) => println!("{:<22} ! {}", t, e),
        }
    }
}
