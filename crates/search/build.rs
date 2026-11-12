use std::{env, fs, path::PathBuf};
fn main() {
    println!("cargo:rerun-if-changed=vendor/wparser_def.c");
    println!("cargo:rerun-if-changed=vendor/shim.h");
    println!("cargo:rerun-if-changed=vendor/wrapper.c");
    let original = fs::read_to_string("vendor/wparser_def.c").unwrap();
    // Keep the upstream state machine, omit PostgreSQL SQL-call/headline glue.
    let mut source = original[..original.find("\nDatum\nprsd_lextype").unwrap()].to_owned();
    let start = source.find("#include \"postgres.h\"").unwrap();
    let end = source.find("/* Define me to enable tracing").unwrap();
    source.replace_range(start..end, "#include \"shim.h\"\n\n");
    // UTF-8 is already validated by Rust. Use Unicode scalar values on all OSes;
    // never mutate process locale and never rely on Windows' 16-bit wchar_t.
    let start = source.find("\t/*\n\t * Use wide char code").unwrap();
    let end = source[start..]
        .find("\n\tprs->state = newTParserPosition")
        .unwrap()
        + start;
    source.replace_range(start..end,"\tprs->usewide = true;\n\tprs->pgwstr = (pg_wchar *) palloc(sizeof(pg_wchar) * (prs->lenstr + 1));\n\tpg_mb2wchar_with_len(prs->str,prs->pgwstr,prs->lenstr);\n");
    let start = source.find("#define p_iswhat").unwrap();
    let end = source[start..].find("\n/*\n * In C locale").unwrap() + start;
    source.replace_range(
        start..end,
        r#"
#define p_iswhat(type,nonascii) \
static int p_is##type(TParser *prs) { \
    return harmony_char_class(prs->pgwstr[prs->state->poschar], #type); \
} \
static int p_isnot##type(TParser *prs) { return !p_is##type(prs); }
"#,
    );
    source = source.replace(
        "while (prs->state->posbyte <= prs->lenstr)\n\t{",
        "while (prs->state->posbyte <= prs->lenstr)\n\t{\n\t\tCHECK_FOR_INTERRUPTS();",
    );
    source.push_str(&fs::read_to_string("vendor/wrapper.c").unwrap());
    let path = PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("parser.c");
    fs::write(&path, source).unwrap();
    cc::Build::new()
        .file(path)
        .include("vendor")
        .flag_if_supported("-std=c11")
        .warnings(false)
        .compile("harmony_pg_text_parser");
}
