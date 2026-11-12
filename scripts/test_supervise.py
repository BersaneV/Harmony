import os
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
