#!/usr/bin/env python3
"""Exercise generated TLS/L4/PROXYv2 routes using controlled HTTP backends.

Run with CADDY_BIN=/path/to/caddy python3 scripts/test_media_proxy.py.
The binary must include caddy-l4. Missing binary/modules explicitly skip the
test; HARMONY_REQUIRE_CADDY=1 makes their absence an error for required CI gates.
This verifies proxy routing, not real Harmony authorization or LiveKit media.
"""
import copy
import hashlib
import http.client
import http.server
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import struct
import subprocess
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("configure", ROOT / "scripts/configure.py")
configure = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(configure)


class ControlledBackend(http.server.BaseHTTPRequestHandler):
    def do_PUT(self):
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        authorization = self.headers.get("Authorization")
        token = (authorization.removeprefix("Bearer ") if authorization is not None
                 else self.headers.get("X-Livekit-Query-Token"))
        self.server.events.append({"path": self.path, "xff": self.headers.get("X-Forwarded-For"),
                                   "kind": self.server.kind})
        status = (204 if token == "allowed" else 401) if self.server.kind == "admission" else 200
        self.send_response(status)
        self.end_headers()
        if status != 204:
            self.wfile.write(self.server.kind.encode())

    def log_message(self, *_):
        pass


def start_backend(kind, events):
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), ControlledBackend)
    server.kind, server.events = kind, events
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def free_port(used):
    while True:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        if port not in used:
            used.add(port)
            return port


def proxy_header(port, source="203.0.113.77"):
    return (b"\r\n\r\n\x00\r\nQUIT\n" + bytes([0x21, 0x11]) + struct.pack("!H", 12)
            + socket.inet_aton(source) + socket.inet_aton("127.0.0.1")
            + struct.pack("!HH", 43210, port))


def request(port, host, path, headers=None, *, tls=False, proxy=False, method="GET", body=b"", deadline=None):
    def remaining():
        if deadline is None:
            return 4
        left = deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError("Isolated route readiness deadline elapsed")
        return min(4, left)

    raw = socket.create_connection(("127.0.0.1", port), timeout=remaining())
    try:
        if proxy:
            raw.sendall(proxy_header(port))
        if tls:
            # Only the isolated Caddy instance uses this temporary local CA.
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            raw.settimeout(remaining())
            raw = ctx.wrap_socket(raw, server_hostname=host)
        fields = {"Host": host, "Connection": "close", "Content-Length": str(len(body)), **(headers or {})}
        raw.settimeout(remaining())
        raw.sendall((f"{method} {path} HTTP/1.1\r\n" + "".join(f"{key}: {value}\r\n" for key, value in fields.items()) + "\r\n").encode() + body)
        response = http.client.HTTPResponse(raw)
        raw.settimeout(remaining())
        response.begin()
        raw.settimeout(remaining())
        return response.status, response.read().decode()
    finally:
        raw.close()


class MediaProxyIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.caddy = shutil.which(os.environ.get("CADDY_BIN", "caddy"))
        missing = "Caddy not found; set CADDY_BIN to a binary including caddy-l4"
        if cls.caddy:
            result = subprocess.run([cls.caddy, "list-modules"], text=True, capture_output=True, check=True)
            required = {"layer4", "layer4.handlers.tls", "layer4.handlers.proxy", "caddy.listeners.proxy_protocol"}
            absent = required - set(result.stdout.splitlines())
            missing = "Caddy modules absent: " + ", ".join(sorted(absent)) if absent else None
        if missing:
            if os.environ.get("HARMONY_REQUIRE_CADDY") == "1":
                raise RuntimeError(missing)
            raise unittest.SkipTest(missing)

    def test_generated_media_admission_and_source_preservation(self):
        events, checks = [], []
        admission = start_backend("admission", events)
        upstream = start_backend("upstream", events)
        process = None
        used = {admission.server_port, upstream.server_port}
        ports = {18081: free_port(used), 18082: free_port(used),
                 8080: admission.server_port, 7880: upstream.server_port}
        edge = free_port(used)
        config = copy.deepcopy(configure.configuration("example.test", media_transport="livekit")[3])
        config["apps"]["http"]["servers"]["web"]["routes"][1]["handle"][0]["max_size"] = 128
        config["admin"] = {"disabled": True, "config": {"persist": False}}
        # This fixture never needs a trusted root on the host. TLS uses its
        # temporary CA; chain verification is disabled only for this loopback test.
        config["apps"]["pki"] = {"certificate_authorities": {"local": {"install_trust": False}}}
        config["apps"]["tls"]["automation"] = {"policies": [{"issuers": [{"module": "internal"}]}]}
        for server in config["apps"]["http"]["servers"].values():
            server["automatic_https"] = {"disable": True}
        config["apps"]["layer4"]["servers"]["main"]["listen"] = [f"127.0.0.1:{edge}"]
        encoded = json.dumps(config)
        for old, new in ports.items():
            encoded = encoded.replace(f"127.0.0.1:{old}\"", f"127.0.0.1:{new}\"")
        config = json.loads(encoded)
        private = ROOT / ".local"
        private.mkdir(exist_ok=True)
        try:
            with tempfile.TemporaryDirectory(prefix="media-proxy-test-", dir=private) as directory:
                directory = Path(directory)
                config["storage"]["root"] = str(directory / "data")
                path = directory / "config.json"
                path.write_text(json.dumps(config))
                with (directory / "caddy.log").open("w") as log:
                    process = subprocess.Popen([self.caddy, "run", "--config", str(path)], stdout=log, stderr=log)
                    started = time.monotonic()
                    deadline = started + 30
                    last_status, last_exception = None, None
                    ready = False
                    while time.monotonic() < deadline:
                        if process.poll() is not None:
                            break
                        try:
                            last_status = request(edge, "media.example.test", "/rtc?access_token=allowed", tls=True, deadline=deadline)[0]
                            if last_status == 200:
                                ready = True
                                break
                        except (OSError, http.client.HTTPException, ssl.SSLError) as error:
                            last_exception = type(error).__name__
                        # Also pause on a successful connection with non-200
                        # status; startup must not become a tight request loop.
                        time.sleep(min(0.1, max(0, deadline - time.monotonic())))
                    if not ready:
                        log.flush()
                        print(json.dumps({"kind": "caddy_fixture_readiness", "status": "FAIL",
                                          "elapsed_seconds": time.monotonic() - started, "process_exit": process.poll(),
                                          "last_http_status": last_status, "last_exception": last_exception}), flush=True)
                        # Keep bounded, whitelisted diagnostics before TemporaryDirectory
                        # removes the file. Never emit raw configuration, headers or keys.
                        with (directory / "caddy.log").open("rb") as diagnostic:
                            diagnostic.seek(max(0, diagnostic.seek(0, 2) - 32_768))
                            lines = diagnostic.read().decode(errors="replace").splitlines()[-12:]
                        for line in lines:
                            try:
                                record = json.loads(line)
                            except ValueError:
                                continue
                            safe = {key: str(record[key]).replace(str(directory), "<fixture>")[:400]
                                    for key in ("level", "logger", "msg", "error") if key in record}
                            print(json.dumps({"kind": "caddy_fixture_log", **safe}), flush=True)
                        self.fail("Caddy did not start the isolated route; bounded diagnostics printed above")
                    for label, token, headers, expected in [
                        ("query allows", "allowed", {}, 200),
                        ("query denies", "blocked", {}, 401),
                        ("header deny beats query allow", "allowed", {"Authorization": "Bearer blocked"}, 401),
                        ("header allow beats query deny", "blocked", {"Authorization": "Bearer allowed"}, 200),
                        ("forged query header overwritten", "blocked", {"X-Livekit-Query-Token": "allowed"}, 401),
                        ("missing token denies", "", {}, 401),
                    ]:
                        before = sum(event["kind"] == "upstream" for event in events)
                        status, _ = request(edge, "media.example.test", f"/rtc?access_token={token}", headers, tls=True)
                        self.assertEqual(status, expected, label)
                        after = sum(event["kind"] == "upstream" for event in events)
                        self.assertEqual(after - before, int(expected == 200), label)
                        checks.append(label)
                    for blocked in ("/twirp/livekit.RoomService/ListRooms", "/api/internal/media-admit", "/agent"):
                        self.assertEqual(request(edge, "media.example.test", blocked, tls=True)[0], 404)
                        checks.append("media path blocked " + blocked)
                    self.assertEqual(request(edge, "app.example.test", "/api/internal/media-admit", tls=True)[0], 404)
                    checks.append("app internal endpoint hidden")
                    self.assertEqual(request(edge, "app.example.test", "/api/files/test/original", tls=True, method="PUT", body=b"x" * 128)[0], 200)
                    checks.append("storage accepts body at configured limit")
                    self.assertEqual(request(edge, "app.example.test", "/api/files/test/original", tls=True, method="PUT", body=b"x" * 129)[0], 413)
                    checks.append("storage rejects body exceeding configured limit")
                    for key, host, route in [(18081, "app.example.test", "/api/test"),
                                             (18082, "media.example.test", "/rtc?access_token=allowed")]:
                        events.clear()
                        status, _ = request(ports[key], host, route, {"X-Forwarded-For": "192.0.2.123"}, proxy=True)
                        self.assertIn(status, (200, 401))
                        self.assertTrue(events)
                        self.assertTrue(all(event["xff"] == "203.0.113.77" for event in events), events)
                        checks.append(f"PROXY v2 preserves source and strips forged XFF on {key}")
                        # The allow list uses USE, not REQUIRE: direct loopback is supported.
                        events.clear()
                        status, _ = request(ports[key], host, route, {"X-Forwarded-For": "192.0.2.123"})
                        self.assertIn(status, (200, 401))
                        self.assertTrue(events)
                        self.assertTrue(all(event["xff"] == "127.0.0.1" for event in events), events)
                        checks.append(f"direct loopback uses actual source on {key}")
                    report = {"status": "PASS", "checks": checks,
                              "scope": "real Caddy TLS/L4/PROXYv2, controlled admission/upstream; not real API authorization or LiveKit media",
                              "configure_sha256": hashlib.sha256((ROOT / "scripts/configure.py").read_bytes()).hexdigest(),
                              "caddy_version": subprocess.run([self.caddy, "version"], text=True, capture_output=True, check=True).stdout.strip()}
                    (private / "security-media-proxy-result.json").write_text(json.dumps(report, indent=2) + "\n")
        finally:
            if process is not None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            for server in (admission, upstream):
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
