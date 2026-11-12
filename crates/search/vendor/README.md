# PostgreSQL text-search parser

`wparser_def.c` is the unmodified upstream PostgreSQL REL_18_6 source:
https://github.com/postgres/postgres/blob/REL_18_6/src/backend/tsearch/wparser_def.c

SHA-256: `ee458e41da57621472c0d8e268b6010fb696d64ac45f7707d98ee9479bb84f47`.
`COPYRIGHT` is the upstream PostgreSQL license, SHA-256
`3d6af92ff8a4c2cdf69afb1cf44edea727922f5cd0cf8b5f72b11cdecac8fdfd`.

The build retains the state machine through `TParserGet`, omits SQL-call/headline
integration, and uses the adjacent bounded standalone shim. `build.rs` shows each
adaptation: allocator/UTF-8 character support and the narrow synchronous callback.
No PostgreSQL server, SQL parser, database calls or process-global locale changes
are included. Token kinds use the default `simple` configuration mappings. Words
are lowercased per character, without stemming, accent removal or stopwords.

The C adapter accepts at most 65536 valid UTF-8 bytes; rejects NUL; bounds parser
memory to 8 MiB, recursion stack distance to 256 KiB and parsing steps to 32000000;
frees all allocations on success or failure. Parser failures are returned to Rust.
Input/parser pointers never escape the call. UTF-8 scalar classification uses
Rust Unicode properties and width uses unicode-width; parity is exercised against
the old PostgreSQL 18.7 C.UTF-8 instance on a recorded corpus, not asserted for all
possible database locales or historical Unicode versions.

The encoded lexeme index stores lowercase UTF-8 bytes as hexadecimal tokens so
SQLite cannot reinterpret punctuation, accents, emails, URLs or numerical tokens.

Validation includes 416 independently recorded PostgreSQL lexeme cases and 69
real PostgreSQL query result sets over those documents. The bounded adapter also
runs with AddressSanitizer and UndefinedBehaviorSanitizer on macOS/arm64, including
eight concurrent threads, 300 generated 4000-character messages, malformed HTML,
hyphens/URLs, Unicode combining/ZWJ sequences and the input boundary. This is
regression evidence, not a universal proof of C memory safety or locale parity.
