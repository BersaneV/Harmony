import os
import json
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]

class Supervision(unittest.TestCase):
    def test_failed_screen_sfu_prevents_api_launch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            api, worker, media = (root / name for name in ('api', 'worker', 'media'))
            marker = root / 'started'
            api.write_text('#!' + sys.executable + '\nfrom pathlib import Path\nPath(' + repr(str(marker)) + ').touch()\n')
            worker.write_text('#!' + sys.executable + '\nraise SystemExit(0)\n')
            media.write_text('#!' + sys.executable + '\nraise SystemExit(3)\n')
            for path in (api, worker, media): path.chmod(0o700)
            runner = "import json,sys;sys.path.insert(0,sys.argv[1]);import supervise;a=json.loads(sys.argv[2]);supervise.run(*a[:3],startup_timeout=2,shutdown_timeout=1,media=a[3])"
            result = subprocess.run([sys.executable, '-c', runner, str(ROOT / 'scripts'), json.dumps([str(api), str(worker), 'http://127.0.0.1:1/health', [[str(media)], 'http://127.0.0.1:1/']])], capture_output=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(marker.exists(), 'API must not start when the configured SFU failed')

    def test_screen_sfu_death_shuts_down_api_and_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0)); media_port = sock.getsockname()[1]
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0)); api_port = sock.getsockname()[1]
            processes = {}
            for name, port in [('api', api_port), ('media', media_port)]:
                path, marker = root / name, root / (name + '-stopped')
                path.write_text('#!' + sys.executable + '\n' +
                    'import http.server,signal,pathlib,sys,threading,os,time\n' +
                    'def end(*args):\n pathlib.Path(' + repr(str(marker)) + ').touch();sys.exit(0)\n' +
                    'signal.signal(signal.SIGINT,end)\n' +
                    ('threading.Timer(1.5,lambda:os._exit(3)).start()\n' if name == 'media' else '') +
                    'class H(http.server.BaseHTTPRequestHandler):\n def do_GET(self): self.send_response(200);self.end_headers()\n def log_message(self,*args): pass\n' +
                    "http.server.HTTPServer(('127.0.0.1'," + str(port) + '),H).serve_forever()\n')
                path.chmod(0o700); processes[name] = path
            worker = root / 'worker'; worker_marker = root / 'worker-stopped'
            worker.write_text('#!' + sys.executable + '\nimport sys,signal,pathlib,time\nif "--check-sandbox" in sys.argv: sys.exit(0)\ndef end(*args):\n pathlib.Path(' + repr(str(worker_marker)) + ').touch();sys.exit(0)\nsignal.signal(signal.SIGINT,end)\nwhile True: time.sleep(.1)\n')
            worker.chmod(0o700)
            runner = "import json,sys;sys.path.insert(0,sys.argv[1]);import supervise;a=json.loads(sys.argv[2]);supervise.run(*a[:3],startup_timeout=3,shutdown_timeout=2,media=a[3])"
            result = subprocess.run([sys.executable, '-c', runner, str(ROOT / 'scripts'), json.dumps([str(processes['api']), str(worker), f'http://127.0.0.1:{api_port}/health', [[str(processes['media'])], f'http://127.0.0.1:{media_port}/']])], capture_output=True, timeout=12)
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue((root / 'api-stopped').exists())
            self.assertTrue(worker_marker.exists())
            for port in (api_port, media_port):
                with socket.socket() as sock: self.assertNotEqual(sock.connect_ex(('127.0.0.1', port)), 0)

    def test_worker_failure_terminates_api_process_group(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0)); port = sock.getsockname()[1]
            api = root / "api"
            worker = root / "worker"
            marker = root / "api-stopped"
            api.write_text("#!" + sys.executable + "\n" +
                "import http.server,signal,pathlib,sys\n" +
                "def end(*args):\n    pathlib.Path(" + repr(str(marker)) + ").write_text('stopped');sys.exit(0)\n" +
                "signal.signal(signal.SIGINT,end)\n" +
                "class H(http.server.BaseHTTPRequestHandler):\n    def do_GET(self): self.send_response(200);self.end_headers()\n    def log_message(self,*args): pass\n" +
                "http.server.HTTPServer(('127.0.0.1'," + str(port) + "),H).serve_forever()\n")
            worker.write_text("#!" + sys.executable + "\nimport sys,time\nif '--check-sandbox' in sys.argv: sys.exit(0)\ntime.sleep(.2)\nsys.exit(3)\n")
            api.chmod(0o700);worker.chmod(0o700)
            result = subprocess.run([sys.executable, str(ROOT / "scripts/supervise.py")], env=dict(os.environ,
                HARMONY_SERVER_BIN=str(api), HARMONY_WORKER_BIN=str(worker), HARMONY_HEALTH_URL=f"http://127.0.0.1:{port}/health"), capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 1)
            self.assertTrue(marker.exists(), "API must be shut down if the worker dies")
            with socket.socket() as sock:
                self.assertNotEqual(sock.connect_ex(('127.0.0.1', port)), 0)
    def test_failed_sandbox_prevents_api_launch(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);api=root/'api';worker=root/'worker';marker=root/'started'
            api.write_text('#!' + sys.executable + '\nfrom pathlib import Path\nPath(' + repr(str(marker)) + ').touch()\n')
            worker.write_text('#!' + sys.executable + '\nraise SystemExit(1)\n')
            api.chmod(0o700);worker.chmod(0o700)
            result=subprocess.run([sys.executable,str(ROOT/'scripts/supervise.py')],env=dict(os.environ,HARMONY_SERVER_BIN=str(api),HARMONY_WORKER_BIN=str(worker)),capture_output=True,timeout=10)
            self.assertEqual(result.returncode,1);self.assertFalse(marker.exists())

if __name__ == '__main__': unittest.main()
