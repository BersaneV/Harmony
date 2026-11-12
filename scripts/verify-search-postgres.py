#!/usr/bin/env python3
"""Recheck the committed search oracle against PostgreSQL, without changing it.

Only synthetic inputs from the fixture are submitted; application rows are not
queried. DATABASE_URL is read from the environment and never passed in argv.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
from urllib.parse import parse_qs, unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]


def literal(value):
    return "convert_from(decode('" + value.encode().hex() + "','hex'),'UTF8')"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--psql", default=os.environ.get("PSQL_PATH", "psql"))
    args = parser.parse_args()
    fixture = json.loads((ROOT / "crates/search/tests/fixtures/postgres-simple.json").read_text())
    source = urlsplit(os.environ["DATABASE_URL"])
    if source.scheme not in ("postgres", "postgresql") or not source.hostname:
        parser.error("DATABASE_URL must identify PostgreSQL for the independent oracle")
    env = dict(os.environ, PGHOST=source.hostname, PGPORT=str(source.port or 5432),
               PGDATABASE=unquote(source.path[1:]), PGUSER=unquote(source.username or ""),
               PGPASSWORD=unquote(source.password or ""), PGCONNECT_TIMEOUT="10")
    for key, variable in (("sslmode", "PGSSLMODE"), ("sslrootcert", "PGSSLROOTCERT"),
                          ("sslcert", "PGSSLCERT"), ("sslkey", "PGSSLKEY")):
        option = parse_qs(source.query).get(key)
        if option:
            env[variable] = option[-1]
    corpus = ",".join(f"({i},{literal(case['input'])})" for i, case in enumerate(fixture["cases"]))
    queries = ",".join(f"({i},{literal(case['query'])})" for i, case in enumerate(fixture["queries"]))
    sql = f"""BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
WITH corpus(id,input) AS (VALUES {corpus}), queries(id,input) AS (VALUES {queries})
SELECT json_build_object(
 'cases',(SELECT json_agg(tsvector_to_array(to_tsvector('simple',input)) ORDER BY id) FROM corpus),
 'queries',(SELECT json_agg(json_build_object('id',q.id,'matches',
   ARRAY(SELECT c.id FROM corpus c WHERE to_tsvector('simple',c.input) @@ plainto_tsquery('simple',q.input) ORDER BY c.id)) ORDER BY q.id) FROM queries q));
COMMIT;
"""
    result = subprocess.run([args.psql, "-X", "-qAt", "-v", "ON_ERROR_STOP=1"],
                            input=sql, env=env, capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise SystemExit("PostgreSQL oracle query failed (credentials and server details withheld)")
    actual = json.loads(result.stdout)
    if len(actual["cases"]) != len(fixture["cases"]) or len(actual["queries"]) != len(fixture["queries"]):
        raise SystemExit("PostgreSQL oracle returned a different corpus size")
    lexeme_failures = [i for i, (value, case) in enumerate(zip(actual["cases"], fixture["cases"]))
                      if value != case["lexemes"]]
    query_failures = [i for i, (value, case) in enumerate(zip(actual["queries"], fixture["queries"]))
                     if value["id"] != i or value["matches"] != case["matches"]]
    print(json.dumps({"status": "FAIL" if lexeme_failures or query_failures else "PASS",
                      "cases": len(fixture["cases"]), "queries": len(fixture["queries"]),
                      "lexeme_mismatches": lexeme_failures, "query_mismatches": query_failures,
                      "source_read_only": True, "fixture_modified": False}))
    raise SystemExit(bool(lexeme_failures or query_failures))


if __name__ == "__main__":
    main()
