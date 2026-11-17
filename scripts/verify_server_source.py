#!/usr/bin/env python3
"""Reuse a successful server gate only when server product sources are identical.
The desktop job, signatures and real installation gates must run again.
"""
import json
import os
from pathlib import PurePosixPath
import re
import subprocess

# This Rust desktop module is outside the server workspace and web bundle.
# Every desktop build, signature and installation check is repeated below.
NATIVE_ONLY = {'apps/desktop/src-tauri/src/call_keys.rs'}
QA_ONLY = {'scripts/test_windows_audio.mjs', 'scripts/verify_server_source.py',
           'scripts/test_verify_server_source.py', '.github/workflows/desktop-proof.yml'}

def unchanged_product(paths):
    return all(path in QA_ONLY or path in NATIVE_ONLY or PurePosixPath(path).parts[:1] == ('docs',) for path in paths)

def gh(path):
    return json.loads(subprocess.check_output(['gh', 'api', 'repos/BersaneV/Harmony/' + path], text=True))

def require(condition, message):
    if not condition:
        raise SystemExit(message)

def main():
    require(os.environ.get('GITHUB_REPOSITORY') == 'BersaneV/Harmony' and os.environ.get('GITHUB_REF') == 'refs/heads/main', 'Personal main required')
    run_id = os.environ.get('VERIFIED_SERVER_RUN', '')
    require(re.fullmatch(r'\d{5,16}', run_id), 'Numeric run required')
    run = gh('actions/runs/' + run_id)
    require(run['status'] == 'completed' and run['path'] == '.github/workflows/verify.yml' and run['head_branch'] == 'main', 'Completed trusted verification required')
    jobs = gh('actions/runs/' + run_id + '/jobs?per_page=100')['jobs']
    server = next((j for j in jobs if j['name'] == 'server'), None)
    require(server and server['conclusion'] == 'success', 'Server gate must be successful')
    require(not any(s['conclusion'] == 'failure' for s in server['steps']), 'No failed server steps permitted')
    source = run['head_sha']
    require(re.fullmatch(r'[a-f0-9]{40}', source), 'Exact verified source required')
    subprocess.run(['git', 'fetch', '--no-tags', '--depth=1', 'origin', source], check=True)
    paths = subprocess.check_output(['git', 'diff', '--name-only', source, os.environ['GITHUB_SHA']], text=True).splitlines()
    require(unchanged_product(paths), 'Product changed: a fresh complete Verify run is required')
    print(json.dumps({'server_run': int(run_id), 'server_job': server['id'], 'verified_source': source,
                      'desktop_source': os.environ['GITHUB_SHA'], 'server_product_sources_identical': True, 'desktop_product_sources_identical': not any(p in NATIVE_ONLY for p in paths),
                      'qa_docs_or_native_desktop_changes': paths, 'desktop_and_installation_gates': 'MUST_RUN_AGAIN'}))

if __name__ == '__main__':
    main()
