#[test]
fn postgres_simple_corpus_matches() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/postgres-simple.json")).unwrap();
    let mut failures = Vec::new();
    for case in fixture["cases"].as_array().unwrap() {
        let input = case["input"].as_str().unwrap();
        let expected: Vec<String> = serde_json::from_value(case["lexemes"].clone()).unwrap();
        match harmony_search::lexemes(input) {
            Ok(actual) if actual == expected => (),
            result => failures.push(format!(
                "input={input:?}\nexpected={expected:?}\nactual={result:?}"
            )),
        }
    }
    assert!(
        failures.is_empty(),
        "{} mismatches:\n{}",
        failures.len(),
        failures
            .iter()
            .take(15)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

#[test]
fn parser_rejects_nul_and_oversize_and_is_thread_local() {
    assert!(harmony_search::lexemes("bad\0text").is_err());
    assert!(harmony_search::lexemes(&"a".repeat(65537)).is_err());
    let mut threads = Vec::new();
    for _ in 0..8 {
        threads.push(std::thread::spawn(|| {
            for _ in 0..300 {
                assert_eq!(
                    harmony_search::lexemes("foo-bar 1.23 foo@example.com").unwrap(),
                    vec!["1.23", "bar", "foo", "foo-bar", "foo@example.com"]
                );
            }
        }));
    }
    for thread in threads {
        thread.join().unwrap();
    }
}

#[test]
fn bounded_parser_handles_adversarial_valid_utf8() {
    // Exercise parser backtracking, UTF-8 lookahead and allocation cleanup at
    // the real message limit, then the larger library input boundary. This is
    // a safety test; the independent PostgreSQL fixture supplies semantics.
    for unit in [
        "a-",
        "<",
        "<!--",
        "http://a/",
        "a.b.",
        "é\u{301}",
        "👩\u{200d}💻",
        "&amp;",
        "a@",
        "1e+",
    ] {
        let message: String = unit.chars().cycle().take(4000).collect();
        assert!(
            harmony_search::lexemes(&message).is_ok(),
            "valid message rejected: {unit:?}"
        );
        let large: String = unit.chars().cycle().take(16384).collect();
        let _ = harmony_search::lexemes(&large);
        // Error recovery must leave no poisoned per-thread parser state.
        assert_eq!(harmony_search::lexemes("after").unwrap(), vec!["after"]);
    }
    let alphabet = [
        'a', '-', '_', '/', ':', '@', '.', '<', '>', '&', '1', '\n', 'é', '\u{301}', '中', '👩',
        '\u{200d}',
    ];
    let mut seed = 0x532a_14c9u64;
    for _ in 0..300 {
        let mut input = String::new();
        for _ in 0..4000 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            input.push(alphabet[seed as usize % alphabet.len()]);
        }
        assert!(harmony_search::lexemes(&input).is_ok());
    }
}
