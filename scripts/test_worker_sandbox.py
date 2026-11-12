#!/usr/bin/env python3
"""Independent parser sandbox checks using harmless, locally compiled probes.

Does not contact PostgreSQL or S3. Uses the production worker --check-sandbox
entrypoint with dummy config, no user credentials and no user media. Requires
Unix, a C compiler, and a built harmony-media-worker. Linux requires Landlock ABI3.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


def main():
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument("--worker", type=Path, default=ROOT / "target/debug/harmony-media-worker")
    args.add_argument("--output", type=Path)
    options = args.parse_args()
    compiler = shutil.which("cc")
    if os.name != "posix" or not compiler or not options.worker.is_file():
        raise SystemExit("Requires a Unix C compiler and compiled media worker")
    worker = options.worker.resolve()
    private = ROOT / ".local/qa-worker-sandbox"
    private.mkdir(parents=True, exist_ok=True, mode=0o700)
    checks = []
    with tempfile.TemporaryDirectory(dir=private) as folder:
        directory = Path(folder)
        os.chmod(directory, 0o700)
        canary = directory / "outside-parser-secret.txt"
        canary.write_text("harmless independent sandbox canary\n")
        forbidden_write = directory / "forbidden-created.txt"
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        listener.settimeout(0.1)
        port = listener.getsockname()[1]
        common = """
#include <sys/types.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
"""
        programs = {
            "boundaries": common + "int main(void) {\n" +
                "if (getenv(\"S3_SECRET_KEY\") || getenv(\"DATABASE_URL\")) return 10;\n" +
                "if (open(" + json.dumps(str(canary)) + ", O_RDONLY) >= 0) return 11;\n" +
                "if (open(" + json.dumps(str(forbidden_write)) + ", O_WRONLY|O_CREAT,0600) >= 0) return 12;\n" +
                "int fd=open(\"allowed-temp.txt\",O_WRONLY|O_CREAT,0600); if(fd<0)return 13; close(fd);\n" +
                "int s=socket(AF_INET,SOCK_STREAM,0); if(s>=0) { struct sockaddr_in a={0}; a.sin_family=AF_INET; a.sin_addr.s_addr=htonl(0x7f000001); a.sin_port=htons(" + str(port) + "); if(connect(s,(struct sockaddr*)&a,sizeof(a))==0)return 14; close(s); }\nreturn 0;}\n",
            "stdout_limit": common + 'int main(void){for(int i=0;i<70000;i++) putchar(65); return 0;}\n',
            "stderr_limit": common + 'int main(void){for(int i=0;i<70000;i++) fputc(65,stderr); return 0;}\n',
            "wall_timeout": common + 'int main(void){sleep(20);return 0;}\n',
            "memory_limit": common + 'int main(void){size_t n=200*1024*1024; volatile char *p=malloc(n); if(!p)return 2; for(size_t i=0;i<n;i+=4096)p[i]=1; sleep(20);return 0;}\n',
        }
        for name, source in programs.items():
            path = directory / (name + ".c")
            executable = directory / name
            path.write_text(source)
            subprocess.run([compiler, "-O0", str(path), "-o", str(executable)], check=True, capture_output=True)
            temp = directory / (name + "-temp")
            env = {"PATH": os.environ.get("PATH", ""), "DATABASE_URL": "postgres://unused.invalid/unused", "S3_ENDPOINT": "http://unused.invalid", "S3_ACCESS_KEY": "synthetic-access", "S3_SECRET_KEY": "synthetic-canary-secret", "FFMPEG_PATH": str(executable), "FFPROBE_PATH": str(executable), "WORKER_TEMP_DIR": str(temp), "WORKER_TIMEOUT_SECONDS": "1" if name != "memory_limit" else "5", "WORKER_LEASE_SECONDS": "120", "WORKER_MEMORY_BYTES": str(128*1024*1024), "RUST_LOG": "info"}
            start = time.monotonic()
            result = subprocess.run([str(worker), "--check-sandbox"], env=env, capture_output=True, text=True, timeout=8)
            elapsed = time.monotonic() - start
            output = result.stdout + result.stderr
            expected = {"boundaries": None, "stdout_limit": "parser_output_limit", "stderr_limit": "parser_output_limit", "wall_timeout": "parser_timeout", "memory_limit": "parser_memory_limit" if os.uname().sysname == "Darwin" else "invalid_media"}[name]
            passed = result.returncode == 0 if expected is None else result.returncode != 0 and expected in output
            passed = passed and not forbidden_write.exists() and canary.read_text() == "harmless independent sandbox canary\n"
            if name == "wall_timeout":
                passed = passed and elapsed < 5
            checks.append({"name": name, "passed": passed, "exit_code": result.returncode, "expected_error": expected, "elapsed_seconds": round(elapsed, 3)})
            print(("PASS " if passed else "FAIL ") + name)
        try:
            connection, _ = listener.accept()
            connection.close()
            network_blocked = False
        except socket.timeout:
            network_blocked = True
        finally:
            listener.close()
        checks.append({"name": "no_connection_reached_canary_listener", "passed": network_blocked})
    report = {"scope": "production worker sandbox entrypoint, harmless locally compiled parser substitutes; no FFmpeg exploit or production media", "platform": os.uname().sysname, "worker_sha256": hashlib.sha256(worker.read_bytes()).hexdigest(), "passed": all(c["passed"] for c in checks), "checks": checks}
    if options.output:
        options.output.parent.mkdir(parents=True, exist_ok=True)
        options.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"passed": report["passed"], "checks": len(checks)}))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
