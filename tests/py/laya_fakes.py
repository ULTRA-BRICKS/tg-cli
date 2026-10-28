"""A real unix-socket Laya server (task-cli's classify protocol) and a fake `task` executable.

No model is ever loaded. The server speaks the wire the real one does: one JSON request line in,
one JSON reply line out. Run as a script (`laya_fakes.py serve SOCK [MODE]`) it is what the fake
`task classify-server start` spawns, so autostart tests exercise a real second process.
"""

import json
import os
import signal
import socket
import stat
import sys
import threading
import time
from pathlib import Path

OK_SCORE = 0.93


def answer_line(questions: dict[str, object]) -> str:
    answers = {name: {"type": "noul", "noul": OK_SCORE} for name in questions}
    return json.dumps({"ok": True, "result": {"answers": answers}})


class FakeLaya:
    """Accepts connections; behaviour per `mode`: ok | silent | garbage | huge | close."""

    def __init__(self, path: str, mode: str = "ok", delay: float = 0.0) -> None:
        self.path = path
        self.mode = mode
        self.delay = delay
        self.requests: list[dict[str, object]] = []
        self._server = socket.socket(socket.AF_UNIX)
        self._server.bind(path)
        self._server.listen(8)
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._accept, daemon=True)

    def start(self) -> "FakeLaya":
        self._thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()
        self._server.close()

    def _accept(self) -> None:
        while not self._stop.is_set():
            try:
                conn, _ = self._server.accept()
            except OSError:
                return
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    def _serve(self, conn: socket.socket) -> None:
        with conn:
            buf = b""
            while b"\n" not in buf:
                chunk = conn.recv(65536)
                if not chunk:
                    return
                buf += chunk
            request = json.loads(buf.split(b"\n", 1)[0])
            self.requests.append(request)
            time.sleep(self.delay)
            self._reply(conn, request)

    def _reply(self, conn: socket.socket, request: dict[str, object]) -> None:
        if self.mode == "ok":
            conn.sendall((answer_line(request.get("questions") or {}) + "\n").encode())  # type: ignore[arg-type]
        elif self.mode == "garbage":
            conn.sendall(b"not json\n")
        elif self.mode == "huge":
            conn.sendall(b"x" * 40_000)
        elif self.mode == "silent":
            self._stop.wait(30)


def stale_socket(path: str) -> None:
    """A socket file nothing listens on: what a crashed server leaves behind."""
    s = socket.socket(socket.AF_UNIX)
    s.bind(path)
    s.close()
    assert stat.S_ISSOCK(os.lstat(path).st_mode)


FAKE_TASK = """#!/bin/sh
# Fake `task`: TASK_FAKE_MODE ok|fail|hang|badpath|ghost, TASK_FAKE_LOG, TASK_FAKE_SOCKET,
# TASK_FAKE_PYTHON, TASK_FAKE_SCRIPT, TASK_FAKE_DELAY (all TASK_* survive the sanitized env).
echo "$$ $*" >> "$TASK_FAKE_LOG"
[ "$1 $2" = "classify-server start" ] || exit 2
case "$TASK_FAKE_MODE" in
  fail) echo "classify-server: model weights missing" >&2; exit 1 ;;
  hang) sleep 300; exit 0 ;;
  badpath) echo "/etc/passwd"; exit 0 ;;
  ghost) echo "$TASK_FAKE_SOCKET"; exit 0 ;;
esac
sleep "${TASK_FAKE_DELAY:-0}"
mkdir -p "$(dirname "$TASK_FAKE_SOCKET")"
chmod 700 "$(dirname "$TASK_FAKE_SOCKET")"
probe="import socket,sys;s=socket.socket(socket.AF_UNIX);s.connect(sys.argv[1])"
live() { "$TASK_FAKE_PYTHON" -c "$probe" "$TASK_FAKE_SOCKET" 2>/dev/null; }
if [ ! -S "$TASK_FAKE_SOCKET" ] || ! live; then
  rm -f "$TASK_FAKE_SOCKET"
  "$TASK_FAKE_PYTHON" "$TASK_FAKE_SCRIPT" serve "$TASK_FAKE_SOCKET" </dev/null >/dev/null 2>&1 &
  for _ in $(seq 1 100); do [ -S "$TASK_FAKE_SOCKET" ] && break; sleep 0.05; done
fi
echo "$TASK_FAKE_SOCKET"
"""


def install_fake_task(directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    directory.chmod(0o755)
    path = directory / "task"
    path.write_text(FAKE_TASK)
    path.chmod(0o755)
    return path


def serve_forever(path: str, mode: str) -> None:
    server = FakeLaya(path, mode).start()
    Path(path + ".pid").write_text(str(os.getpid()))
    signal.signal(signal.SIGTERM, lambda *_: (server.stop(), sys.exit(0)))
    while True:
        time.sleep(1)


if __name__ == "__main__":
    if sys.argv[1] == "serve":
        serve_forever(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "ok")
