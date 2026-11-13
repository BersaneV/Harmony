#!/usr/bin/env python3
"""Generate one private deployment. Never overwrite existing keys or contact a host."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets

ROOT = Path(__file__).resolve().parents[1]


def configuration(domain=None, data_directory=None, media_transport="p2p"):
    if media_transport not in ("p2p", "livekit"):
        raise ValueError("Transporte de mídia inválido; use p2p ou livekit.")
    if domain and (not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?", domain)
                   or "." not in domain or ".." in domain):
        raise ValueError("Domínio DNS inválido; use somente o nome, sem protocolo ou porta.")
    secret = lambda: secrets.token_hex(32)
    data = Path(data_directory or "./data").resolve()
    env = {
        "DATABASE_URL": f"sqlite:{data / 'harmony.db'}",
        "HARMONY_STORAGE_BACKEND": "local",
        "HARMONY_STORAGE_DIR": str(data / "files"),
        "HARMONY_PUBLIC_API_URL": f"https://app.{domain}" if domain else "http://127.0.0.1:8080",
        "HARMONY_WEB_DIR": str(ROOT / "apps/desktop/dist"),
        "HARMONY_MEDIA_TRANSPORT": media_transport,
        "HARMONY_CALL_STUN_URLS": "stun:stun.l.google.com:19302",
        "HARMONY_P2P_DIAGNOSTICS": "true",
        "HARMONY_P2P_STUN_URLS": "",
        "HARMONY_BIND": "127.0.0.1:8080",
        "HARMONY_TRUST_PROXY": "true" if domain else "false",
        "HARMONY_PUBLIC_ORIGIN": ",".join(([f"https://app.{domain}"] if domain else ["http://127.0.0.1:8080", "http://localhost:8080", "http://127.0.0.1:1420", "http://localhost:1420"]) + ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]),
        "HARMONY_JWT_SECRET": secret(),
        "HARMONY_BOOTSTRAP_USERNAME": "admin",
        "HARMONY_BOOTSTRAP_PASSWORD": secrets.token_urlsafe(24),
        "HARMONY_INSTANCE_NAME": "Harmony",
        "HARMONY_MAX_UPLOAD_BYTES": "26214400",
        "HARMONY_STORAGE_QUOTA_BYTES": "1073741824",
        "HARMONY_MAX_VIDEO_BITRATE": "32000000",
        "HARMONY_MAX_ROOM_PARTICIPANTS": "12",
        "LIVEKIT_URL": f"wss://media.{domain}" if domain else "ws://127.0.0.1:7880",
        "LIVEKIT_API_URL": "http://127.0.0.1:7880",
        "LIVEKIT_API_KEY": "harmony_" + secrets.token_hex(8),
        "LIVEKIT_API_SECRET": secret(),
    }
    storage = {"backend": "local", "directory": str(data / "files")}
    livekit = {"port": 7880, "bind_addresses": ["127.0.0.1"], "logging": {"level": "info"},
               "rtc": {"tcp_port": 7881, "udp_port": 7882, "use_external_ip": bool(domain)},
               "keys": {env["LIVEKIT_API_KEY"]: env["LIVEKIT_API_SECRET"]},
               "room": {"auto_create": True, "empty_timeout": 300, "max_participants": 12},
               "turn": {"enabled": bool(domain)}}
    if domain:
        livekit["turn"].update({"domain": f"turn.{domain}", "tls_port": 5349, "udp_port": 3478,
                                "bind_addresses": ["0.0.0.0"],
                                "external_tls": True, "proxy_protocol": True,
                                "proxy_protocol_trusted_cidrs": ["127.0.0.0/8", "::1/128"]})
    proxy = lambda port: {"handler": "reverse_proxy", "upstreams": [{"dial": f"127.0.0.1:{port}"}]}
    web_routes = [
        {"match": [{"path": ["/api/internal/*"]}], "handle": [{"handler": "static_response", "status_code": 404}]},
        {"match": [{"path": ["/api/files/*"]}], "handle": [
            {"handler": "request_body", "max_size": int(env["HARMONY_MAX_UPLOAD_BYTES"])}, proxy(8080)]},
        {"handle": [proxy(8080)]},
    ]
    caddy = {"admin": {"listen": "localhost:2019"}, "logging": {"logs": {"default": {"level": "INFO"}}},
             "storage": {"module": "file_system", "root": "/data"},
             "apps": {"http": {"servers": {"web": {"listen": ["127.0.0.1:18081"], "routes": web_routes}}}}}
    caddy["logging"]["logs"]["default"]["encoder"] = {
        "format": "filter", "wrap": {"format": "json"},
        "fields": {field: {"filter": "delete"} for field in (
            "request>uri", "request>headers>Authorization", "request>headers>Cookie",
            "request>headers>X-Livekit-Query-Token", "request>headers>X-Forwarded-Uri")},
    }
    if domain and media_transport == "livekit":
        admission = {"handler": "reverse_proxy", "upstreams": [{"dial": "127.0.0.1:8080"}],
                     "rewrite": {"method": "GET", "uri": "/api/internal/media-admit"},
                     "headers": {"request": {"set": {"X-Livekit-Query-Token": ["{http.request.uri.query.access_token}"]}}},
                     "handle_response": [{"match": {"status_code": [2]}, "routes": [{"handle": [{"handler": "vars"}]}]}]}
        caddy["apps"]["http"]["servers"]["media"] = {
            "listen": ["127.0.0.1:18082"],
            "routes": [
                {"match": [{"path": ["/rtc", "/rtc/*"]}],
                 "handle": [{"handler": "subroute", "routes": [{"handle": [admission]}, {"handle": [proxy(7880)]}]}],
                 "terminal": True},
                {"handle": [{"handler": "static_response", "status_code": 404}]},
            ],
        }
    if domain:
        for server in caddy["apps"]["http"]["servers"]:
            caddy["apps"]["http"]["servers"][server]["listener_wrappers"] = [
                {"wrapper": "proxy_protocol", "allow": ["127.0.0.1/32", "::1/128"], "fallback_policy": "reject"}
            ]
        endpoints = [("app", 18081)]
        if media_transport == "livekit":
            endpoints += [("media", 18082), ("turn", 5349)]
        names = [f"{prefix}.{domain}" for prefix, _ in endpoints]
        caddy["apps"]["tls"] = {"certificates": {"automate": names}}
        routes = []
        for prefix, port in endpoints:
            tls = {"handler": "tls"}
            if prefix != "turn":
                tls["connection_policies"] = [{"alpn": ["http/1.1"]}]
            transport = {"handler": "proxy", "upstreams": [{"dial": [f"127.0.0.1:{port}"]}]}
            transport["proxy_protocol"] = "v2"
            routes.append({"match": [{"tls": {"sni": [f"{prefix}.{domain}"]}}], "handle": [tls, transport]})
        caddy["apps"]["layer4"] = {"servers": {"main": {"listen": [":443"], "routes": routes}}}
    return env, storage, livekit, caddy


def write_private(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as file:
        file.write(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--domain", help="Domínio base; P2P requer app, LiveKit também media/turn apontando ao host")
    parser.add_argument("--media-transport", choices=("p2p", "livekit"), default="p2p")
    parser.add_argument("--directory", type=Path, default=ROOT)
    args = parser.parse_args()
    base = args.directory.resolve()
    targets = [base / ".env"] + [base / ".local/deploy" / f for f in ("livekit.yaml", "caddy.json")]
    if any(p.exists() for p in targets):
        parser.error("Configuração já existe; nenhuma chave foi substituída. Use outro --directory para ensaio.")
    env, _, livekit, caddy = configuration(args.domain, base / "data", args.media_transport)
    write_private(targets[0], "".join(f"{k}={v}\n" for k, v in env.items()))
    for path, content in zip(targets[1:], (livekit, caddy)):
        write_private(path, json.dumps(content, indent=2) + "\n")  # JSON is valid YAML 1.2.
    print(f"Configuração privada criada em {base}. Senha inicial: HARMONY_BOOTSTRAP_PASSWORD no arquivo .env.")
    print("Nenhuma conta externa, recurso pago, DNS ou servidor foi criado.")


if __name__ == "__main__":
    main()
