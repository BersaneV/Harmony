//! PostgreSQL `simple` text-search lexemes, without a PostgreSQL server.
//! The upstream parser state machine is retained; locale-free UTF-8 character
//! adapters are tested against the former database's C.UTF-8 behavior.
use std::{
    collections::BTreeSet,
    ffi::{CStr, c_char, c_int, c_void},
};
use unicode_width::UnicodeWidthChar;

unsafe extern "C" {
    fn harmony_pg_tokens(
        input: *const c_char,
        length: usize,
        context: *mut c_void,
        emit: unsafe extern "C" fn(*mut c_void, c_int, *const c_char, usize),
    ) -> c_int;
}

#[unsafe(no_mangle)]
extern "C" fn harmony_char_class(value: u32, name: *const c_char) -> c_int {
    let Some(c) = char::from_u32(value) else {
        return 0;
    };
    // SAFETY: the C parser passes only static NUL-terminated class names.
    let name = unsafe { CStr::from_ptr(name) }.to_bytes();
    let result = match name {
        b"alpha" => c.is_alphabetic(),
        b"alnum" => c.is_alphanumeric(),
        b"digit" => c.is_ascii_digit(),
        b"xdigit" => c.is_ascii_hexdigit(),
        b"space" => c.is_whitespace(),
        b"lower" => c.is_lowercase(),
        b"upper" => c.is_uppercase(),
        b"print" => !c.is_control(),
        b"punct" => !c.is_alphanumeric() && !c.is_whitespace() && !c.is_control(),
        _ => false,
    };
    i32::from(result)
}
#[unsafe(no_mangle)]
extern "C" fn harmony_char_width(value: u32) -> c_int {
    char::from_u32(value)
        .and_then(UnicodeWidthChar::width)
        .map(|w| w as c_int)
        .unwrap_or(-1)
}
unsafe extern "C" fn collect(
    context: *mut c_void,
    kind: c_int,
    text: *const c_char,
    length: usize,
) {
    if matches!(kind, 12 | 13 | 14 | 23) {
        return;
    }
    // SAFETY: C emits slices within the live, valid UTF-8 input and context is
    // our exclusively borrowed vector, used synchronously during this call.
    let bytes = unsafe { std::slice::from_raw_parts(text.cast::<u8>(), length) };
    if let Ok(word) = std::str::from_utf8(bytes) {
        let words = unsafe { &mut *context.cast::<Vec<String>>() };
        // PostgreSQL's simple dictionary uses per-character lowercase, without
        // stemming, accent stripping, stopwords or context-sensitive casefolding.
        words.push(
            word.chars()
                .map(|c| c.to_lowercase().next().unwrap_or(c))
                .collect(),
        );
    }
}
pub fn lexemes(input: &str) -> Result<Vec<String>, &'static str> {
    if input.len() > 65536 || input.contains('\0') {
        return Err("Texto de busca inválido");
    }
    // PG look-ahead may inspect the terminator. Input is valid UTF-8 plus NUL.
    let mut terminated = Vec::with_capacity(input.len() + 1);
    terminated.extend_from_slice(input.as_bytes());
    terminated.push(0);
    let mut result = Vec::<String>::new();
    // SAFETY: bounded valid input, synchronous callback, no pointers escape; C
    // owns and frees its bounded allocations before returning, including errors.
    let status = unsafe {
        harmony_pg_tokens(
            terminated.as_ptr().cast(),
            input.len(),
            (&mut result as *mut Vec<String>).cast(),
            collect,
        )
    };
    if status != 0 {
        return Err("Não foi possível analisar o texto de busca");
    }
    Ok(result
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect())
}

/// Hex lexemes prevent SQLite's tokenizer from splitting punctuation or accents.
pub fn encoded(input: &str) -> Result<String, &'static str> {
    Ok(lexemes(input)?
        .iter()
        .map(|word| {
            word.as_bytes()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join(" "))
}
pub fn query(input: &str) -> Result<String, &'static str> {
    let text = encoded(input)?;
    Ok(if text.is_empty() {
        "\"\"".into()
    } else {
        text.split(' ').collect::<Vec<_>>().join(" AND ")
    })
}
