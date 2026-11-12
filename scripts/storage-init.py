#!/usr/bin/env python3
"""Create the private S3 bucket and explicit browser CORS using SigV4."""
import datetime
import hashlib
import hmac
import os
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET


def load_env(path=Path(".env")):
    result = {}
    if path.exists():
        for line in path.read_text().splitlines():
            if line.strip() and not line.startswith("#"):
                key, value = line.split("=", 1)
                result[key] = value
    result.update(os.environ)
    return result


def request(env, method, key="", query="", body=b"", headers=None):
    endpoint = urllib.parse.urlsplit(env["S3_ENDPOINT"])
    if endpoint.scheme not in ("http", "https") or endpoint.username or endpoint.password:
        raise ValueError("Invalid S3 endpoint")
    path = "/" + urllib.parse.quote(env["S3_BUCKET"], safe="") + ("/" + urllib.parse.quote(key, safe="/") if key else "")
    now = datetime.datetime.now(datetime.timezone.utc)
    date, stamp = now.strftime("%Y%m%d"), now.strftime("%Y%m%dT%H%M%SZ")
    digest = hashlib.sha256(body).hexdigest()
    signed_headers = {"host": endpoint.netloc, "x-amz-content-sha256": digest, "x-amz-date": stamp}
    canonical = "\n".join([method, path, query, "".join(f"{k}:{v}\n" for k, v in sorted(signed_headers.items())),
                           ";".join(sorted(signed_headers)), digest])
    region = env.get("S3_REGION", "us-east-1")
    scope = f"{date}/{region}/s3/aws4_request"
    string_to_sign = f"AWS4-HMAC-SHA256\n{stamp}\n{scope}\n{hashlib.sha256(canonical.encode()).hexdigest()}"
    sign = lambda key, value: hmac.new(key, value.encode(), hashlib.sha256).digest()
    signing_key = sign(sign(sign(sign(("AWS4" + env["S3_SECRET_KEY"]).encode(), date), region), "s3"), "aws4_request")
    signature = hmac.new(signing_key, string_to_sign.encode(), hashlib.sha256).hexdigest()
    signed_headers["Authorization"] = f"AWS4-HMAC-SHA256 Credential={env['S3_ACCESS_KEY']}/{scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature={signature}"
    signed_headers.update(headers or {})
    url = urllib.parse.urlunsplit((endpoint.scheme, endpoint.netloc, path, query, ""))
    return urllib.request.urlopen(urllib.request.Request(url, data=body if method in ("PUT", "POST") else None, method=method, headers=signed_headers), timeout=30)


def initialize(env):
    try:
        request(env, "PUT").close()
    except urllib.error.HTTPError as exc:
        error = exc.read()
        if exc.code != 409 or b"BucketAlreadyOwnedByYou" not in error:
            raise RuntimeError(f"Bucket initialization failed: HTTP {exc.code}") from None
    root = ET.Element("CORSConfiguration")
    origins = set(env.get("HARMONY_PUBLIC_ORIGIN", "http://127.0.0.1:1420").split(","))
    origins.update(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"])
    rule = ET.SubElement(root, "CORSRule")
    for origin in sorted(origins):
        ET.SubElement(rule, "AllowedOrigin").text = origin.strip()
    for method in ("GET", "PUT", "HEAD"):
        ET.SubElement(rule, "AllowedMethod").text = method
    ET.SubElement(rule, "AllowedHeader").text = "*"
    ET.SubElement(rule, "ExposeHeader").text = "ETag"
    ET.SubElement(rule, "MaxAgeSeconds").text = "600"
    request(env, "PUT", query="cors=", body=ET.tostring(root), headers={"Content-Type": "application/xml"}).close()
    print("Bucket privado e CORS configurados. Nenhuma política pública foi criada.")


if __name__ == "__main__":
    try:
        initialize(load_env())
    except (KeyError, ValueError, RuntimeError, urllib.error.URLError) as error:
        print(f"Não foi possível preparar o storage ({type(error).__name__}). Confira .env e serviço local.", file=sys.stderr)
        sys.exit(1)
