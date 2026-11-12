#!/usr/bin/env python3
"""Collect published license declarations and shipped notices, without relicensing them.

Run npm ci first. Cargo metadata resolves the two committed lockfiles. All target
platforms and build dependencies are included conservatively in the inventory.
"""
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def notice_files(directory):
    found = []
    for path in directory.iterdir():
        if path.is_file() and path.name.lower().startswith(("license", "licence", "copying", "notice", "copyright")):
            found.append(path)
        elif path.is_dir() and path.name.lower() in ("licenses", "licences"):
            found.extend(p for p in path.rglob("*") if p.is_file())
    return sorted(found)


def main():
    packages = {}
    for manifest in (ROOT / "Cargo.toml", ROOT / "apps/desktop/src-tauri/Cargo.toml"):
        data = json.loads(subprocess.check_output([
            "cargo", "metadata", "--locked", "--format-version", "1", "--manifest-path", str(manifest)
        ]))
        for package in data["packages"]:
            if package.get("source") is None and package["name"] != "tauri-plugin-updater":
                continue
            key = "cargo:" + package["name"] + "@" + package["version"]
            packages[key] = {
                "license": package.get("license"),
                "source": ("https://github.com/BersaneV/Harmony/tree/main/vendor/tauri-plugin-updater" if package.get("source") is None else "https://crates.io/crates/" + package["name"] + "/" + package["version"]),
                "directory": Path(package["manifest_path"]).parent,
            }
    lock = json.loads((ROOT / "package-lock.json").read_text())
    for name, entry in lock["packages"].items():
        if not name.startswith("node_modules/") or entry.get("dev") or entry.get("link"):
            continue
        directory = ROOT / name
        if not directory.is_dir():
            continue  # Optional packages unavailable on the inventory host.
        package = json.loads((directory / "package.json").read_text())
        key = "npm:" + package["name"] + "@" + package["version"]
        packages[key] = {
            "license": package.get("license"),
            "source": "https://www.npmjs.com/package/" + package["name"] + "/v/" + package["version"],
            "directory": directory,
        }
    # The text parser is upstream C vendored inside our own workspace crate;
    # Cargo metadata alone cannot discover its separate license/attribution.
    parser_dir = ROOT / "crates/search/vendor"
    parser_files = []
    for name, expected, source in (
        ("wparser_def.c", "ee458e41da57621472c0d8e268b6010fb696d64ac45f7707d98ee9479bb84f47",
         "https://github.com/postgres/postgres/blob/REL_18_6/src/backend/tsearch/wparser_def.c"),
        ("COPYRIGHT", "3d6af92ff8a4c2cdf69afb1cf44edea727922f5cd0cf8b5f72b11cdecac8fdfd",
         "https://github.com/postgres/postgres/blob/REL_18_6/COPYRIGHT"),
    ):
        digest = hashlib.sha256((parser_dir / name).read_bytes()).hexdigest()
        if digest != expected:
            raise RuntimeError(f"Vendored PostgreSQL {name} differs from the verified upstream source")
        parser_files.append({"name": name, "sha256": digest, "source": source})
    packages["vendor:postgresql-text-parser@18.6"] = {
        "license": "PostgreSQL",
        "source": "https://github.com/postgres/postgres/tree/REL_18_6",
        "directory": parser_dir,
        "source_files": parser_files,
        "usage": "Server search tokenizer; Harmony standalone adapter documented in crates/search/vendor/README.md",
    }
    inventory, texts = [], {}
    for key, entry in sorted(packages.items()):
        notices = []
        for path in notice_files(entry.pop("directory")):
            # Normalize only trailing whitespace in the generated display copy.
            content = "\n".join(line.rstrip() for line in path.read_text(errors="replace").splitlines()).rstrip() + "\n"
            digest = hashlib.sha256(content.encode()).hexdigest()
            texts[digest] = content
            notices.append({"name": path.name, "sha256": digest})
        inventory.append({"package": key, **entry, "notices": notices})
    header = (
        "Harmony — third-party notices\n\n"
        "Generated from pinned package metadata and bundled license/notice files.\n"
        "Includes all Cargo target/build dependencies, installed npm production dependencies and vendored third-party sources.\n"
        "Individual packages retain their original licenses; Harmony's Apache-2.0 applies only to its own code.\n"
        "Source links below provide each unmodified package. Windows/WebView2 and infrastructure images are separate products.\n"
        "A missing notice file is not a claim that attribution is unnecessary; inspect the linked package before distribution.\n\n"
    )
    body = [header]
    for entry in inventory:
        body.append(f"{entry['package']}\nLicense: {entry['license']}\nSource: {entry['source']}\n")
        body.extend(f"Source file: {item['name']} — SHA256 {item['sha256']} — {item['source']}\n" for item in entry.get("source_files", []))
        if entry.get("usage"):
            body.append(f"Usage: {entry['usage']}\n")
        body.extend(f"Notice: {n['name']} — {n['sha256']}\n" for n in entry["notices"])
        body.append("\n")
    for digest, content in sorted(texts.items()):
        body.append(f"\n===== Notice SHA256 {digest} =====\n{content}\n")
    destination = ROOT / "apps/desktop/src-tauri/resources"
    destination.mkdir(exist_ok=True)
    (destination / "THIRD-PARTY-NOTICES.txt").write_text("".join(body).rstrip() + "\n")
    (ROOT / "docs/dependency-licenses.json").write_text(json.dumps(inventory, indent=2) + "\n")
    print(json.dumps({"packages": len(inventory), "unique_notice_texts": len(texts),
                      "no_bundled_notice": sum(not p["notices"] for p in inventory),
                      "missing_license_declaration": [p["package"] for p in inventory if not p["license"]]}))


if __name__ == "__main__":
    main()
