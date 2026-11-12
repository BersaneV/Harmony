#!/usr/bin/env python3
"""Restore a consistent local PostgreSQL snapshot into a fresh disposable DB.

Run through scripts/with-env.py with HARMONY_PG_BIN set to native PostgreSQL
tools. The source is read-only. The random destination is created, validated,
then dropped. Private dump/evidence remain in .local/qa-restore (not Git).
This does not test SeaweedFS, restic, Docker, or a coordinated database/S3 backup.
"""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import select
import shutil
import subprocess
import sys
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
REPORT = {"status": "RUNNING", "stage": "configuration", "checks": [],
          "scope": "native PostgreSQL consistent snapshot and isolated restore; not S3/restic/Docker recovery"}


def check(value, label):
    if not value:
        raise AssertionError(label)
    REPORT["checks"].append(label)


def main():
    os.umask(0o077)
    parsed = urlsplit(os.environ["DATABASE_URL"])
    check(parsed.hostname in ("localhost", "127.0.0.1", "::1"), "source PostgreSQL restricted to loopback")
    source = unquote(parsed.path.lstrip("/"))
    check(source not in ("", "postgres", "template0", "template1"), "source is an application database")
    directory = os.environ.get("HARMONY_PG_BIN")
    bins = {}
    for name in ("psql", "pg_dump", "pg_restore", "createdb", "dropdb"):
        path = str(Path(directory) / name) if directory else shutil.which(name)
        check(bool(path) and Path(path).is_file(), f"native {name} available")
        bins[name] = path
    env = dict(os.environ, PGHOST=parsed.hostname, PGPORT=str(parsed.port or 5432),
               PGUSER=unquote(parsed.username or ""), PGPASSWORD=unquote(parsed.password or ""), PGDATABASE=source)
    # Preserve explicit connection options without putting secrets on command lines.
    env["PGCONNECT_TIMEOUT"] = "5"
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    target = "harmony_restore_" + stamp.lower() + "_" + secrets.token_hex(4)
    work = ROOT / ".local/qa-restore" / target
    work.mkdir(parents=True, mode=0o700)
    REPORT["started_at_utc"] = datetime.now(timezone.utc).isoformat()
    REPORT["test_sha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    REPORT["artifact_directory"] = str(work.relative_to(ROOT))
    snapshot_owner = None
    created = False

    with (work / "native-tools.log").open("w") as log:
        def run(name, args, database=source, sql=None):
            return subprocess.run([bins[name], *args], env=dict(env, PGDATABASE=database), input=sql,
                                  text=True, stdout=subprocess.PIPE, stderr=log, check=True, timeout=120)

        def query(sql, database=source, snapshot=None):
            setup = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n"
            if snapshot:
                setup += f"SET TRANSACTION SNAPSHOT '{snapshot}';\n"
            setup += "SET LOCAL timezone='UTC';\n"
            output = run("psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1"], database,
                         setup + sql + ";\nROLLBACK;\n").stdout.strip()
            return json.loads(output)

        try:
            REPORT["stage"] = "export consistent source snapshot"
            snapshot_owner = subprocess.Popen([bins["psql"], "-X", "-qAt", "-v", "ON_ERROR_STOP=1"], env=env,
                                               text=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log)
            snapshot_owner.stdin.write("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();\n")
            snapshot_owner.stdin.flush()
            check(bool(select.select([snapshot_owner.stdout], [], [], 10)[0]), "snapshot export responds")
            snapshot = snapshot_owner.stdout.readline().strip()
            check(bool(snapshot) and all(c in "0123456789ABCDEF-" for c in snapshot), "snapshot identifier valid")
            tables = query("SELECT COALESCE(json_agg(tablename ORDER BY tablename),'[]') FROM pg_tables WHERE schemaname='public'", snapshot=snapshot)
            check("users" in tables and "messages" in tables, "source contains Harmony schema")
            REPORT["postgres_version"] = query("SELECT to_json(current_setting('server_version'))", snapshot=snapshot)
            metadata_sql = """SELECT json_build_object(
              'columns',(SELECT json_agg(x ORDER BY table_name,ordinal_position) FROM
                (SELECT table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default
                 FROM information_schema.columns WHERE table_schema='public') x),
              'constraints',(SELECT json_agg(x ORDER BY table_name,name) FROM
                (SELECT c.relname AS table_name,p.conname AS name,p.contype,p.convalidated,pg_get_constraintdef(p.oid) AS definition
                 FROM pg_constraint p JOIN pg_class c ON c.oid=p.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public') x),
              'indexes',(SELECT json_agg(x ORDER BY tablename,indexname) FROM
                (SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public') x),
              'functions',(SELECT json_agg(x ORDER BY signature) FROM
                (SELECT p.oid::regprocedure::text AS signature,pg_get_functiondef(p.oid) AS definition
                 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f') x),
              'views',(SELECT json_agg(x ORDER BY viewname) FROM
                (SELECT viewname,definition FROM pg_views WHERE schemaname='public') x),
              'triggers',(SELECT json_agg(x ORDER BY definition) FROM
                (SELECT pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
                 JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal) x))"""
            source_metadata = query(metadata_sql, snapshot=snapshot)

            def fingerprints(database, exported=None):
                result = {}
                for table in tables:
                    identifier = '"' + table.replace('"', '""') + '"'
                    sql = "SELECT json_build_object('rows',count(*),'digest',md5(COALESCE(string_agg(digest,E'\\n' ORDER BY digest),''))) FROM (SELECT md5(row_to_json(t)::text) AS digest FROM public." + identifier + " t) rows"
                    result[table] = query(sql, database, exported)
                return result

            before = fingerprints(source, snapshot)
            REPORT["stage"] = "dump source snapshot"
            dump = work / "postgres.dump"
            run("pg_dump", ["--format=custom", "--snapshot=" + snapshot, "--file=" + str(dump)])
            check(dump.stat().st_size > 0, "custom dump written")
            REPORT["dump_sha256"] = hashlib.sha256(dump.read_bytes()).hexdigest()
            REPORT["dump_bytes"] = dump.stat().st_size
            REPORT["stage"] = "create isolated destination and restore"
            check(target != source and target.startswith("harmony_restore_"), "restore destination distinct and generated")
            run("createdb", ["--template=template0", target], "postgres")
            created = True
            run("pg_restore", ["--exit-on-error", "--no-owner", "--dbname=" + target, str(dump)], target)
            REPORT["stage"] = "compare restored schema and rows"
            after_tables = query("SELECT COALESCE(json_agg(tablename ORDER BY tablename),'[]') FROM pg_tables WHERE schemaname='public'", target)
            check(after_tables == tables, "restored table inventory identical")
            check(query(metadata_sql, target) == source_metadata, "columns constraints indexes functions views triggers identical")
            after = fingerprints(target)
            check(after == before, "all table row counts and canonical digests identical to exported snapshot")
            REPORT["tables"] = len(tables)
            REPORT["rows"] = sum(value["rows"] for value in before.values())
            REPORT["table_fingerprints"] = before
            # Sequence reads are not MVCC snapshots. Compare safety against restored
            # rows, rather than claiming equality with a concurrently changing source.
            sequences = query("SELECT COALESCE(json_agg(x),'[]') FROM (SELECT c.relname AS table_name,a.attname AS column_name,pg_get_serial_sequence(format('%I.%I',n.nspname,c.relname),a.attname) AS sequence_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped AND pg_get_serial_sequence(format('%I.%I',n.nspname,c.relname),a.attname) IS NOT NULL) x", target)
            for item in sequences:
                table = '"' + item["table_name"].replace('"', '""') + '"'
                column = '"' + item["column_name"].replace('"', '""') + '"'
                sequence = item["sequence_name"]
                safe = query(f"SELECT to_json(COALESCE((SELECT last_value FROM {sequence}) >= (SELECT max({column}) FROM public.{table}),true))", target)
                check(safe, "restored sequence covers existing rows")
            REPORT["sequences_checked"] = len(sequences)
            REPORT["status"], REPORT["stage"] = "PASS", "complete"
        finally:
            if snapshot_owner is not None:
                try:
                    snapshot_owner.communicate("ROLLBACK;\n\\q\n", timeout=5)
                except (subprocess.TimeoutExpired, BrokenPipeError):
                    snapshot_owner.terminate()
                    snapshot_owner.wait(timeout=5)
            if created:
                run("dropdb", [target], "postgres")
                REPORT["destination_dropped"] = True
            REPORT["source_writes"] = False
            (work / "result.json").write_text(json.dumps(REPORT, indent=2) + "\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        REPORT["status"], REPORT["error_type"] = "FAIL", type(error).__name__
    final = ROOT / ".local/qa-restore/result.json"
    final.parent.mkdir(parents=True, exist_ok=True)
    final.write_text(json.dumps(REPORT, indent=2) + "\n")
    public = {key: value for key, value in REPORT.items() if key != "table_fingerprints"}
    print(json.dumps(public, indent=2))
    sys.exit(0 if REPORT["status"] == "PASS" else 1)
