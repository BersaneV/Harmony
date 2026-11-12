#!/usr/bin/env python3
"""Real official-updater verification, synthetic keys/artifacts, never installation.

Run from any directory after `cargo build --locked --manifest-path .../Cargo.toml`.
NODE_BIN may select Node; UPDATER_CHECK_BIN may select the compiled probe.
Optional --artifact/--signature/--public-key/--version verifies a released artifact
through exactly the same plugin and local HTTP transport, without executing it.
"""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import http.server
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("artifact", "signature", "public-key", "version"):
        parser.add_argument("--" + name)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    real = [args.artifact, args.signature, args.public_key, args.version]
    if any(real) and not all(real):
        parser.error("all artifact verification arguments are required together")
    binary = Path(os.environ.get("UPDATER_CHECK_BIN", str(Path(__file__).parent / "target/debug" / ("harmony-updater-check.exe" if os.name == "nt" else "harmony-updater-check"))))
    node = os.environ.get("NODE_BIN") or shutil.which("node")
    if not binary.is_file() or not node:
        raise SystemExit("Build the probe first and provide Node on PATH or NODE_BIN")
    cli = ROOT / "node_modules/@tauri-apps/cli/tauri.js"
    if not cli.is_file():
        raise SystemExit("Run npm ci at the repository root first")
    private_root = ROOT / ".local/qa-updater"
    private_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    results = []
    with tempfile.TemporaryDirectory(prefix="verification-", dir=private_root) as tmp:
        directory = Path(tmp)
        os.chmod(directory, 0o700)
        env = os.environ.copy()
        env.pop("TAURI_SIGNING_PRIVATE_KEY", None)
        env.pop("TAURI_SIGNING_PRIVATE_KEY_PATH", None)
        env["TAURI_SIGNING_PRIVATE_KEY_PASSWORD"] = secrets.token_urlsafe(32)

        def command(*parameters):
            completed = subprocess.run([node, str(cli), *parameters], env=env, capture_output=True, text=True, timeout=60)
            if completed.returncode:
                # The signer may print secret key material; intentionally suppress output.
                raise RuntimeError("ephemeral signer command failed (output suppressed)")

        for name in ("a", "b"):
            command("signer", "generate", "--ci", "--password=" + env["TAURI_SIGNING_PRIVATE_KEY_PASSWORD"], "-w", str(directory / name))
        payload = directory / "synthetic.bin"
        data = b"Harmony verification fixture. Harmless bytes; never executed.\n"
        payload.write_bytes(data)

        def sign(version):
            parameters = ["signer", "sign", "-f", str(directory / "a")]
            if version:
                parameters += ["--app-version", version]
            command(*parameters, str(payload))
            return Path(str(payload) + ".sig").read_text().strip()

        signature = sign("0.2.0")
        legacy = sign(None)
        active = {}

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/manifest":
                    body = json.dumps(active["manifest"]).encode()
                    content_type = "application/json"
                elif self.path == "/artifact":
                    body = active["payload"]
                    content_type = "application/octet-stream"
                else:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                if self.path != "/artifact" or active.get("content_length", True):
                    self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # Probe intentionally cancels oversized downloads.

            def log_message(self, *_):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = "http://127.0.0.1:" + str(server.server_port)

        def case(name, expected, *, body=data, sig=signature, version="0.2.0", key=None, current="0.1.0", error_contains=None, cap=None, content_length=True, cancel_after_chunk=False):
            active.update(payload=body, manifest={"version": version, "url": url + "/artifact", "signature": sig}, content_length=content_length)
            arguments = [str(binary), url + "/manifest", str(key or directory / "a.pub"), current]
            if cap is not None:
                arguments.append(str(cap))
            if cancel_after_chunk:
                if cap is None:
                    arguments.append(str(128 * 1024 * 1024))
                arguments.append("cancel-after-chunk")
            completed = subprocess.run(arguments, capture_output=True, text=True, timeout=20)
            if completed.returncode:
                raise RuntimeError("official plugin probe exited unsuccessfully: " + completed.stderr[-1000:])
            observed = json.loads(completed.stdout.strip().splitlines()[-1])
            passed = observed["status"] == expected
            if expected == "verified":
                passed = passed and observed["bytes"] == len(body)
            if expected == "capped":
                passed = passed and observed["downloaded"] < len(body) and observed["downloaded"] <= cap
            if expected == "cancelled":
                passed = passed and 0 < observed["downloaded"] < len(body)
            if error_contains:
                passed = passed and error_contains in observed.get("error", "")
            record = {"name": name, "passed": passed, "expected": expected, "observed": observed}
            results.append(record)
            print(("PASS " if passed else "FAIL ") + name)

        try:
            case("matching key, bytes and signed version accepted", "verified")
            case("payload byte changed", "rejected", body=data.replace(b"Harmony", b"Harm0ny"))
            case("payload truncated", "rejected", body=data[:-1])
            case("wrong public key", "rejected", key=directory / "b.pub")
            case("signature is not base64", "rejected", sig="not-valid-base64!")
            decoded = base64.b64decode(signature).decode()
            lines = decoded.splitlines()
            signature_bytes = bytearray(base64.b64decode(lines[1]))
            signature_bytes[-1] ^= 1
            changed = list(lines)
            changed[1] = base64.b64encode(signature_bytes).decode()
            case("cryptographic signature bit flipped", "rejected", sig=base64.b64encode(("\n".join(changed) + "\n").encode()).decode())
            changed = list(lines)
            changed[2] += " forged"
            case("trusted comment altered", "rejected", sig=base64.b64encode(("\n".join(changed) + "\n").encode()).decode())
            case("signed 0.2.0 relabeled as 0.3.0", "rejected", version="0.3.0", error_contains="Version")
            case("legacy signature without signed version", "rejected", sig=legacy, error_contains="Version")
            case("downgrade not offered", "no_update", current="0.3.0")
            case("same version not offered", "no_update", current="0.2.0")
            case("size cap cancels announced oversized body", "capped", body=b"x" * (2 * 1024 * 1024), cap=65536)
            case("size cap cancels unannounced oversized body", "capped", body=b"x" * (2 * 1024 * 1024), cap=65536, content_length=False)
            case("exact size limit preserves valid signature", "verified", cap=len(data))
            case("one byte above limit rejected without length", "capped", cap=len(data)-1, content_length=False)
            case("user cancellation interrupts ready stream", "cancelled", body=b"x" * (2 * 1024 * 1024), cancel_after_chunk=True)
            if all(real):
                case("real release artifact signature and version", "verified", body=Path(args.artifact).read_bytes(), sig=Path(args.signature).read_text().strip(), key=Path(args.public_key), version=args.version, current="0.0.0")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
    report = {"scope": "tauri-plugin-updater 2.13.3 with documented local download limit; official MockRuntime check/download only; no installation", "timestamp": datetime.now(timezone.utc).isoformat(), "probe_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "patch_sha256": hashlib.sha256((ROOT / "vendor/tauri-plugin-updater/HARMONY.patch").read_bytes()).hexdigest(), "passed": all(row["passed"] for row in results), "checks": results}
    if all(real):
        report["release"] = {"artifact_sha256": hashlib.sha256(Path(args.artifact).read_bytes()).hexdigest(), "signature_sha256": hashlib.sha256(Path(args.signature).read_bytes()).hexdigest(), "public_key_sha256": hashlib.sha256(Path(args.public_key).read_bytes()).hexdigest(), "version": args.version}
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"passed": report["passed"], "checks": len(results)}))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
