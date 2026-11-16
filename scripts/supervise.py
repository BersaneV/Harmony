#!/usr/bin/env python3
"""Run the API and isolated worker as one supervised deployment unit."""
import os
import signal
import subprocess
import sys
import time
import urllib.request


def run(api, worker, health, startup_timeout=60, shutdown_timeout=10, media=None):
    children = []
    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    previous = {sig: signal.signal(sig, stop) for sig in (signal.SIGTERM, signal.SIGINT)}
    try:
        # Parser isolation must work before the application accepts any traffic.
        preflight = subprocess.Popen([worker, "--check-sandbox"], start_new_session=True)
        children.append(preflight)
        deadline = time.monotonic() + 45
        while preflight.poll() is None and not stopping:
            if time.monotonic() >= deadline:
                raise RuntimeError("Parser sandbox check timed out")
            time.sleep(0.1)
        if stopping:
            return 0
        if preflight.returncode != 0:
            raise RuntimeError("Parser sandbox check failed")
        children.remove(preflight)
        if media is not None:
            command, media_health = media
            process = subprocess.Popen(command, start_new_session=True)
            children.append(process)
            deadline = time.monotonic() + startup_timeout
            while not stopping:
                if process.poll() is not None:
                    raise RuntimeError("Screen SFU exited before readiness")
                try:
                    with urllib.request.urlopen(media_health, timeout=1) as response:
                        if response.status == 200:
                            break
                except (OSError, TimeoutError):
                    pass
                if time.monotonic() >= deadline:
                    raise RuntimeError("Screen SFU readiness timed out")
                time.sleep(0.1)
            if stopping:
                return 0
        api_process = subprocess.Popen([api], start_new_session=True)
        children.append(api_process)
        deadline = time.monotonic() + startup_timeout
        while not stopping:
            if any(process.poll() is not None for process in children):
                raise RuntimeError("A required process exited before API readiness")
            try:
                with urllib.request.urlopen(health, timeout=1) as response:
                    if response.status == 200:
                        break
            except (OSError, TimeoutError):
                pass
            if time.monotonic() >= deadline:
                raise RuntimeError("API readiness timed out")
            time.sleep(0.1)
        if stopping:
            return 0
        children.append(subprocess.Popen([worker], start_new_session=True))
        while not stopping:
            for child in children:
                if child.poll() is not None:
                    raise RuntimeError("A required Harmony process exited; stopping the instance")
            time.sleep(0.2)
        return 0
    finally:
        for child in children:
            try:
                os.killpg(child.pid, signal.SIGINT)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + shutdown_timeout
        for child in children:
            try:
                child.wait(timeout=max(0.01, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                pass
        # Include a parser grandchild that ignored INT in the shutdown boundary.
        for child in children:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
        for sig, handler in previous.items():
            signal.signal(sig, handler)


if __name__ == "__main__":
    os.umask(0o077)
    try:
        media = None
        if os.environ.get("HARMONY_SCREEN_SFU_ENABLED") == "true" and os.environ.get("HARMONY_LIVEKIT_BIN"):
            binary, configuration = os.environ["HARMONY_LIVEKIT_BIN"], os.environ.get("HARMONY_LIVEKIT_CONFIG", "")
            if not os.path.isabs(binary) or not os.path.isabs(configuration):
                raise RuntimeError("Supervised screen SFU requires fixed absolute paths")
            media = ([binary, "--config", configuration], "http://127.0.0.1:7880/")
        sys.exit(run(os.environ.get("HARMONY_SERVER_BIN", "/usr/local/bin/harmony-server"),
                     os.environ.get("HARMONY_WORKER_BIN", "/usr/local/bin/harmony-media-worker"),
                     os.environ.get("HARMONY_HEALTH_URL", "http://127.0.0.1:8080/health"), media=media))
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"Harmony stopped: {error}", file=sys.stderr)
        sys.exit(1)
