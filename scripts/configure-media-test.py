#!/usr/bin/env python3
"""Generate only a loopback Caddy media gateway for integration tests.

Uses the public profile's admission routes, without public TLS/listeners.
Never replaces an existing configuration or reads instance credentials.
"""
import argparse
import json
from pathlib import Path
from configure import configuration, write_private


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--api-port', type=int, default=8080)
    parser.add_argument('--livekit-port', type=int, default=7880)
    parser.add_argument('--port', type=int, default=18082)
    args = parser.parse_args()
    if any(not 1 <= port <= 65535 for port in (args.api_port, args.livekit_port, args.port)):
        parser.error('Ports must be between 1 and 65535')
    config = configuration('integration.invalid')[3]
    media = config['apps']['http']['servers']['media']
    media.pop('listener_wrappers')
    media['listen'] = [f'127.0.0.1:{args.port}']
    routes = json.dumps(media).replace('127.0.0.1:8080', f'127.0.0.1:{args.api_port}').replace('127.0.0.1:7880', f'127.0.0.1:{args.livekit_port}')
    output = {'admin': {'disabled': True}, 'logging': config['logging'],
              'apps': {'http': {'servers': {'media': json.loads(routes)}}}}
    write_private(args.output, json.dumps(output))


if __name__ == '__main__':
    main()
