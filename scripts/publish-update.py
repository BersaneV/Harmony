#!/usr/bin/env python3
"""Publish an already signed, verified version and its fixed HTTPS update channel.

Requires an explicit invocation, personal gh authentication, Node and a built
`tools/updater-check` probe. No private signing key is read by this publisher.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
REPO = "BersaneV/Harmony"


def gh(*args, json_output=False):
    executable = os.environ.get("GH_BIN", "gh")
    value = subprocess.check_output([executable, *args], cwd=ROOT, text=True)
    return json.loads(value) if json_output else value.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"\d+\.\d+\.\d+", args.version):
        parser.error("Use a stable semantic version with three numeric components")
    cfg = json.loads((ROOT / "apps/desktop/src-tauri/tauri.conf.json").read_text())
    if cfg["version"] != args.version or gh("api", "user", "--jq", ".login") != "BersaneV":
        raise SystemExit("Version or authenticated personal account does not match")
    tag = "v" + args.version
    # Draft tags need not exist as Git refs yet; /releases/tags can return404.
    releases = gh("api", "repos/" + REPO + "/releases?per_page=100", json_output=True)
    release = next((item for item in releases if item["tag_name"] == tag), None)
    if release is None:
        raise SystemExit("Versioned release not found; run the signed package workflow first")
    directory = ROOT / ".local/releases" / tag
    directory.mkdir(parents=True, exist_ok=True)
    name = "Harmony_" + args.version + "_x64-setup.exe"
    for asset in (name, name + ".sig", "SHA256SUMS.txt", "windows-release.json", "windows-install.json"):
        gh("release", "download", tag, "--repo", REPO, "--pattern", asset, "--dir", str(directory), "--clobber")
    digest = hashlib.sha256((directory / name).read_bytes()).hexdigest()
    sums = (directory / "SHA256SUMS.txt").read_text(encoding="utf-8-sig")
    if f"{digest}  {name}" not in sums.splitlines():
        raise SystemExit("Artifact hash mismatch")
    asset = next(a for a in release["assets"] if a["name"] == name)
    if asset.get("digest") and asset["digest"] != "sha256:" + digest:
        raise SystemExit("GitHub asset digest mismatch")
    report = json.loads((directory / "windows-release.json").read_text())
    installation = json.loads((directory / "windows-install.json").read_text())
    if not installation.get("passed") or installation.get("artifact_sha256") != digest:
        raise SystemExit("Windows installer verification did not pass for this artifact")
    if not report.get("passed"):
        raise SystemExit("Windows signature verification did not pass")
    public = directory / "updater.pub"
    public.write_text(cfg["plugins"]["updater"]["pubkey"] + "\n")
    subprocess.run(["python3", str(ROOT / "tools/updater-check/test_updater.py"),
        "--artifact", str(directory / name), "--signature", str(directory / (name + ".sig")),
        "--public-key", str(public), "--version", args.version,
        "--output", str(directory / "local-signature-verification.json")], check=True, cwd=ROOT)
    manifest = {
        "version": args.version,
        "notes": "Servidor simplificado com SQLite e arquivos locais, navegação responsiva e diagnóstico P2P. Worker, personalização e atualizações assinadas preservados. Consulte as notas da versão no GitHub.",
        "pub_date": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "platforms": {"windows-x86_64": {
            "signature": (directory / (name + ".sig")).read_text().strip(),
            "url": f"https://github.com/{REPO}/releases/download/{tag}/{name}",
        }},
    }
    latest = directory / "latest.json"
    latest.write_text(json.dumps(manifest, indent=2) + "\n")
    gh("release", "upload", tag, str(latest), "--repo", REPO, "--clobber")
    if release["draft"]:
        gh("release", "edit", tag, "--repo", REPO, "--draft=false", "--prerelease")
    releases = gh("api", "repos/" + REPO + "/releases?per_page=100", json_output=True)
    if any(r["tag_name"] == "update-channel" for r in releases):
        gh("release", "upload", "update-channel", str(latest), "--repo", REPO, "--clobber")
    else:
        notes = directory / "channel-notes.md"
        notes.write_text("Canal de atualização do Harmony Windows x64. O cliente exige assinatura Ed25519, vínculo da versão e impede downgrade. Os instaladores e suas notas ficam nas releases versionadas. Este canal não contém chaves privadas.\n")
        gh("release", "create", "update-channel", str(latest), "--repo", REPO,
           "--target", release["target_commitish"], "--prerelease", "--title", "Harmony — canal de atualizações", "--notes-file", str(notes))
    print(json.dumps({"version": args.version, "sha256": digest,
        "release": f"https://github.com/{REPO}/releases/tag/{tag}",
        "feed": f"https://github.com/{REPO}/releases/download/update-channel/latest.json"}))


if __name__ == "__main__":
    main()
