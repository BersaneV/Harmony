#!/usr/bin/env python3
"""Allow delivery retry only after all product gates passed for identical sources."""
import json
import os
from pathlib import PurePosixPath
import re
import subprocess


def gh(path):
    return json.loads(subprocess.check_output(['gh', 'api', path], text=True))


def main():
    if os.environ.get('GITHUB_REPOSITORY') != 'BersaneV/Harmony' or os.environ.get('GITHUB_REF') != 'refs/heads/main':
        raise SystemExit('Trusted personal main required')
    run_id = os.environ.get('VERIFIED_RUN', '')
    if not re.fullmatch(r'\d{5,16}', run_id):
        raise SystemExit('Expected a numeric verified run')
    run = gh('repos/BersaneV/Harmony/actions/runs/' + run_id)
    assert run['status'] == 'completed' and run['conclusion'] == 'failure'
    assert run['path'] == '.github/workflows/verify.yml' and run['head_branch'] == 'main'
    jobs = gh('repos/BersaneV/Harmony/actions/runs/' + run_id + '/jobs?per_page=100')['jobs']
    server = next(job for job in jobs if job['name'] == 'server')
    desktop = next(job for job in jobs if job['name'] == 'desktop')
    assert server['conclusion'] == 'success'
    expected = [
        'Run npm ci', 'Run npm run typecheck', 'Run npm test',
        'Run node node_modules/vitest/vitest.mjs run tools/theme-review.test.ts',
        'Test native update policy', 'Build signed distribution on trusted main',
        'Verify updater signatures using the official plugin',
        'Install and remove on disposable Windows runner', 'Hash the Windows artifacts',
    ]
    steps = {step['name']: step['conclusion'] for step in desktop['steps']}
    assert all(steps.get(step) == 'success' for step in expected), 'Every product/package gate must already have passed'
    assert [step for step, result in steps.items() if result == 'failure'] == ['Save signed installer as a draft versioned release']
    source = run['head_sha']
    assert re.fullmatch(r'[a-f0-9]{40}', source)
    subprocess.run(['git', 'fetch', '--no-tags', '--depth=1', 'origin', source], check=True)
    paths = subprocess.check_output(['git', 'diff', '--name-only', source, os.environ['GITHUB_SHA']], text=True).splitlines()
    exact = {'scripts/verify_packaging_source.py', '.github/workflows/repackage-windows.yml'}
    for path in paths:
        p = PurePosixPath(path)
        assert path in exact or p.parts[:1] == ('docs',) or p.parts[:2] == ('scripts', 'exe-wan') or path in {'.github/workflows/exe-wan.yml', '.github/workflows/exe-wan-probe.yml'}, 'Product source changed: ' + path
    print(json.dumps({'verified_run': run_id, 'verified_source': source, 'packaging_source': os.environ['GITHUB_SHA'], 'product_sources_identical': True, 'delivery_only_paths': paths}))


if __name__ == '__main__':
    main()
