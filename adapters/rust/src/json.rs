//! A small JSON value with a parser and a compact writer (std only).
//!
//! Objects keep insertion order, so snapshots serialize deterministically. Build values with
//! `From` conversions and the [`obj!`](crate::obj) / [`arr!`](crate::arr) macros:
//!
//! ```
//! use witness::{obj, arr, Value};
//! let v = obj! { "score" => 3, "pos" => [40.0, 90.0], "tags" => arr!["a", 1, true] };
//! assert_eq!(v["pos"][0].as_f64(), Some(40.0));
//! assert_eq!(v.to_string(), r#"{"score":3,"pos":[40,90],"tags":["a",1,true]}"#);
//! ```

use std::fmt::{self, Write as _};
use std::ops::Index;

/// A JSON value. `Object` is an ordered list of members.
#[derive(Clone, Debug, PartialEq, Default)]
pub enum Value {
    #[default]
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Value>),
    Object(Vec<(String, Value)>),
}

static NULL: Value = Value::Null;

impl Value {
    /// Member of an object (first match), or `None`.
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Object(m) => m.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    /// Element of an array, or `None`.
    pub fn at(&self, i: usize) -> Option<&Value> {
        match self {
            Value::Array(a) => a.get(i),
            _ => None,
        }
    }
    /// A number, or a string holding one (`"12.5"`), as f64.
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::Number(n) => Some(*n),
            Value::String(s) => s.trim().parse().ok(),
            _ => None,
        }
    }
    /// [`as_f64`](Self::as_f64) truncated to an integer.
    pub fn as_i64(&self) -> Option<i64> {
        self.as_f64().filter(|n| n.is_finite()).map(|n| n as i64)
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(s) => Some(s),
            _ => None,
        }
    }
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(b) => Some(*b),
            _ => None,
        }
    }
    pub fn as_array(&self) -> &[Value] {
        match self {
            Value::Array(a) => a,
            _ => &[],
        }
    }
    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }
    /// Insert or replace an object member (no-op on non-objects).
    pub fn set(&mut self, key: &str, value: impl Into<Value>) {
        if let Value::Object(m) = self {
            let value = value.into();
            match m.iter_mut().find(|(k, _)| k == key) {
                Some(slot) => slot.1 = value,
                None => m.push((key.to_string(), value)),
            }
        }
    }
    /// Append to an array (no-op on non-arrays).
    pub fn push(&mut self, value: impl Into<Value>) {
        if let Value::Array(a) = self {
            a.push(value.into());
        }
    }

    /// Parse one JSON document.
    pub fn parse(text: &str) -> Result<Value, String> {
        let mut p = Parser {
            s: text.as_bytes(),
            i: 0,
        };
        let v = p.value(0)?;
        p.ws();
        if p.i != p.s.len() {
            return Err(format!("unexpected trailing data at byte {}", p.i));
        }
        Ok(v)
    }

    /// Compact single-line JSON (what the protocol needs). Same as `to_string()`.
    pub fn write_to(&self, out: &mut String) {
        match self {
            Value::Null => out.push_str("null"),
            Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Value::Number(n) => write_number(out, *n),
            Value::String(s) => write_string(out, s),
            Value::Array(a) => {
                out.push('[');
                for (i, v) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    v.write_to(out);
                }
                out.push(']');
            }
            Value::Object(m) => {
                out.push('{');
                for (i, (k, v)) in m.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_string(out, k);
                    out.push(':');
                    v.write_to(out);
                }
                out.push('}');
            }
        }
    }
}

impl fmt::Display for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut s = String::new();
        self.write_to(&mut s);
        f.write_str(&s)
    }
}

/// NaN / infinities are not JSON: the protocol asks for strings instead.
pub(crate) fn write_number(out: &mut String, n: f64) {
    if n.is_nan() {
        out.push_str("\"NaN\"");
    } else if n.is_infinite() {
        out.push_str(if n > 0.0 {
            "\"Infinity\""
        } else {
            "\"-Infinity\""
        });
    } else if n == n.trunc() && n.abs() < 1e15 {
        let _ = write!(out, "{}", n as i64); // 40.0 -> 40, -0.0 -> 0
    } else {
        let _ = write!(out, "{}", n); // shortest round-trip representation
    }
}

pub(crate) fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

impl Index<&str> for Value {
    type Output = Value;
    /// `v["key"]`, or `Null` when missing (never panics).
    fn index(&self, key: &str) -> &Value {
        self.get(key).unwrap_or(&NULL)
    }
}

impl Index<usize> for Value {
    type Output = Value;
    /// `v[0]`, or `Null` when out of range (never panics).
    fn index(&self, i: usize) -> &Value {
        self.at(i).unwrap_or(&NULL)
    }
}

// ------------------------------------------------------------------ conversions

macro_rules! from_num {
    ($($t:ty),*) => { $(impl From<$t> for Value { fn from(n: $t) -> Value { Value::Number(n as f64) } })* };
}
from_num!(i8, i16, i32, i64, isize, u8, u16, u32, u64, usize, f32, f64);

impl From<bool> for Value {
    fn from(b: bool) -> Value {
        Value::Bool(b)
    }
}
impl From<&str> for Value {
    fn from(s: &str) -> Value {
        Value::String(s.to_string())
    }
}
impl From<String> for Value {
    fn from(s: String) -> Value {
        Value::String(s)
    }
}
impl From<&String> for Value {
    fn from(s: &String) -> Value {
        Value::String(s.clone())
    }
}
impl<T: Into<Value>> From<Vec<T>> for Value {
    fn from(v: Vec<T>) -> Value {
        Value::Array(v.into_iter().map(Into::into).collect())
    }
}
impl<T: Into<Value>, const N: usize> From<[T; N]> for Value {
    fn from(v: [T; N]) -> Value {
        Value::Array(v.into_iter().map(Into::into).collect())
    }
}
impl<T: Into<Value>> From<Option<T>> for Value {
    fn from(v: Option<T>) -> Value {
        v.map_or(Value::Null, Into::into)
    }
}
impl From<()> for Value {
    fn from(_: ()) -> Value {
        Value::Null
    }
}
impl<A: Into<Value>, B: Into<Value>> From<(A, B)> for Value {
    /// `(x, y)` -> `[x, y]`, handy for positions.
    fn from((a, b): (A, B)) -> Value {
        Value::Array(vec![a.into(), b.into()])
    }
}
impl<A: Into<Value>, B: Into<Value>, C: Into<Value>> From<(A, B, C)> for Value {
    fn from((a, b, c): (A, B, C)) -> Value {
        Value::Array(vec![a.into(), b.into(), c.into()])
    }
}
impl<T: Into<Value>> FromIterator<T> for Value {
    fn from_iter<I: IntoIterator<Item = T>>(iter: I) -> Value {
        Value::Array(iter.into_iter().map(Into::into).collect())
    }
}

/// Build an ordered JSON object: `obj! { "id" => 1, "pos" => [x, y] }`.
#[macro_export]
macro_rules! obj {
    () => { $crate::Value::Object(Vec::new()) };
    ($($k:expr => $v:expr),+ $(,)?) => {
        $crate::Value::Object(vec![$((::std::string::String::from($k), $crate::Value::from($v))),+])
    };
}

/// Build a JSON array of mixed values: `arr!["a", 1, true]`.
#[macro_export]
macro_rules! arr {
    () => { $crate::Value::Array(Vec::new()) };
    ($($v:expr),+ $(,)?) => { $crate::Value::Array(vec![$($crate::Value::from($v)),+]) };
}

// ------------------------------------------------------------------ parser

const MAX_DEPTH: usize = 128;

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn ws(&mut self) {
        while self.i < self.s.len() && matches!(self.s[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }
    fn err<T>(&self, what: &str) -> Result<T, String> {
        Err(format!("{what} at byte {}", self.i))
    }
    fn value(&mut self, depth: usize) -> Result<Value, String> {
        if depth > MAX_DEPTH {
            return self.err("nesting too deep");
        }
        self.ws();
        match self.s.get(self.i) {
            None => self.err("unexpected end"),
            Some(b'{') => {
                self.i += 1;
                let mut m = Vec::new();
                self.ws();
                if self.s.get(self.i) == Some(&b'}') {
                    self.i += 1;
                    return Ok(Value::Object(m));
                }
                loop {
                    self.ws();
                    if self.s.get(self.i) != Some(&b'"') {
                        return self.err("expected a member name");
                    }
                    let k = self.string()?;
                    self.ws();
                    if self.s.get(self.i) != Some(&b':') {
                        return self.err("expected ':'");
                    }
                    self.i += 1;
                    let v = self.value(depth + 1)?;
                    m.push((k, v));
                    self.ws();
                    match self.s.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b'}') => {
                            self.i += 1;
                            return Ok(Value::Object(m));
                        }
                        _ => return self.err("expected ',' or '}'"),
                    }
                }
            }
            Some(b'[') => {
                self.i += 1;
                let mut a = Vec::new();
                self.ws();
                if self.s.get(self.i) == Some(&b']') {
                    self.i += 1;
                    return Ok(Value::Array(a));
                }
                loop {
                    a.push(self.value(depth + 1)?);
                    self.ws();
                    match self.s.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b']') => {
                            self.i += 1;
                            return Ok(Value::Array(a));
                        }
                        _ => return self.err("expected ',' or ']'"),
                    }
                }
            }
            Some(b'"') => Ok(Value::String(self.string()?)),
            Some(b't') => self.literal("true", Value::Bool(true)),
            Some(b'f') => self.literal("false", Value::Bool(false)),
            Some(b'n') => self.literal("null", Value::Null),
            Some(_) => {
                let start = self.i;
                while self.i < self.s.len()
                    && matches!(
                        self.s[self.i],
                        b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E'
                    )
                {
                    self.i += 1;
                }
                let text = std::str::from_utf8(&self.s[start..self.i]).unwrap_or("");
                match text.parse::<f64>() {
                    Ok(n) if !text.is_empty() && !text.starts_with('+') => Ok(Value::Number(n)),
                    _ => {
                        self.i = start;
                        self.err("invalid value")
                    }
                }
            }
        }
    }
    fn literal(&mut self, word: &str, v: Value) -> Result<Value, String> {
        if self.s[self.i..].starts_with(word.as_bytes()) {
            self.i += word.len();
            Ok(v)
        } else {
            self.err("invalid literal")
        }
    }
    fn hex4(&mut self) -> Result<u32, String> {
        let h = self
            .s
            .get(self.i..self.i + 4)
            .and_then(|h| std::str::from_utf8(h).ok());
        match h.and_then(|h| u32::from_str_radix(h, 16).ok()) {
            Some(v) => {
                self.i += 4;
                Ok(v)
            }
            None => self.err("bad \\u escape"),
        }
    }
    fn string(&mut self) -> Result<String, String> {
        self.i += 1; // opening quote
        let mut out = String::new();
        loop {
            let start = self.i;
            while self.i < self.s.len()
                && self.s[self.i] != b'"'
                && self.s[self.i] != b'\\'
                && self.s[self.i] >= 0x20
            {
                self.i += 1;
            }
            match std::str::from_utf8(&self.s[start..self.i]) {
                Ok(run) => out.push_str(run),
                Err(_) => return self.err("invalid UTF-8"),
            }
            match self.s.get(self.i) {
                Some(b'"') => {
                    self.i += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.i += 1;
                    let c = self.s.get(self.i).copied();
                    self.i += 1;
                    match c {
                        Some(b'"') => out.push('"'),
                        Some(b'\\') => out.push('\\'),
                        Some(b'/') => out.push('/'),
                        Some(b'b') => out.push('\u{8}'),
                        Some(b'f') => out.push('\u{c}'),
                        Some(b'n') => out.push('\n'),
                        Some(b'r') => out.push('\r'),
                        Some(b't') => out.push('\t'),
                        Some(b'u') => {
                            let hi = self.hex4()?;
                            let cp = if (0xD800..0xDC00).contains(&hi)
                                && self.s[self.i..].starts_with(b"\\u")
                            {
                                let save = self.i;
                                self.i += 2;
                                let lo = self.hex4()?;
                                if (0xDC00..0xE000).contains(&lo) {
                                    0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)
                                } else {
                                    self.i = save;
                                    0xFFFD
                                }
                            } else {
                                hi
                            };
                            out.push(char::from_u32(cp).unwrap_or('\u{FFFD}'));
                        }
                        _ => return self.err("bad escape"),
                    }
                }
                _ => return self.err("unterminated string"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let src = r#"{"a":[1,2.5,-3e2,true,false,null],"s":"hé 😀\n\"q\"","o":{}}"#;
        let v = Value::parse(src).unwrap();
        assert_eq!(v["a"][2].as_f64(), Some(-300.0));
        assert_eq!(v["s"].as_str(), Some("hé 😀\n\"q\""));
        assert_eq!(Value::parse(&v.to_string()).unwrap(), v);
    }

    #[test]
    fn numbers_and_specials() {
        assert_eq!(Value::from(40.0).to_string(), "40");
        assert_eq!(Value::from(0.1).to_string(), "0.1");
        assert_eq!(Value::from(1.0 / 3.0).to_string(), "0.3333333333333333");
        assert_eq!(Value::from(f64::NAN).to_string(), "\"NaN\"");
        assert_eq!(Value::from(f64::NEG_INFINITY).to_string(), "\"-Infinity\"");
        assert_eq!(Value::String("12.5".into()).as_f64(), Some(12.5));
    }

    #[test]
    fn rejects_garbage() {
        for bad in [
            "",
            "{",
            "[1,]",
            "{\"a\" 1}",
            "tru",
            "\"abc",
            "1 2",
            "+1",
            "-",
        ] {
            assert!(Value::parse(bad).is_err(), "{bad:?} should fail");
        }
    }

    #[test]
    fn missing_index_is_null() {
        let v = obj! { "a" => 1 };
        assert!(v["nope"][3]["x"].is_null());
    }
}
