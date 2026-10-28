"""Hermetic fakes for the remote ctl tests: a fake `ssh`, a fake daemon socket, a short tmp dir.

The fake ssh emulates what the real one does with a forced command key: it ignores the remote
command, runs the real `tg-remote` entry locally and passes stdin/stdout through. Nothing here
opens a network connection or touches the real ~/.config/tg-cli.
"""

import json
import os
import socket
import stat
import sys
import tempfile
import textwrap
import threading
from collections.abc import Callable
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
LAUNCHER = REPO / "tg-remote"


def short_dir() -> Path:
    """AF_UNIX paths are limited to ~107 bytes; pytest's tmp_path can exceed that."""
    return Path(tempfile.mkdtemp(prefix="tgr-"))


def fake_ssh(directory: Path, body: str, name: str = "fake-ssh") -> Path:
    """An executable standing in for `ssh`; `body` sees argv, opts, host, remote and stdin helpers.

    Every call appends its full argv as one JSON line to `<directory>/ssh.log`.
    """
    script = directory / name
    script.write_text(
        f"#!{sys.executable}\n"
        "import json, os, sys\n"
        "argv = sys.argv[1:]\n"
        "split = argv.index('--')\n"
        "opts, host, remote = argv[:split], argv[split + 1], argv[split + 2:]\n"
        f"with open({str(directory / 'ssh.log')!r}, 'a') as log:\n"
        "    log.write(json.dumps(argv) + '\\n')\n" + textwrap.dedent(body)
    )
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    return script


def ssh_calls(directory: Path) -> list[list[str]]:
    log = directory / "ssh.log"
    return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []


FORCED_COMMAND = """
env = {{'PATH': '/usr/bin:/bin', 'HOME': os.environ.get('HOME', '/')}}
env.update({remote_env!r})
env['SSH_ORIGINAL_COMMAND'] = ' '.join(remote)
os.chdir('/')
os.execve(sys.executable, [sys.executable, '-I', {launcher!r}, *{command!r}], env)
"""


def forced_command_ssh(
    directory: Path,
    command: list[str],
    remote_env: dict[str, str] | None = None,
    name: str = "fake-ssh",
) -> Path:
    """A fake ssh that runs `tg-remote <command…>` as the REMOTE host would.

    Like a forced-command key it ignores the requested command and gives the process a bare
    environment (`remote_env` is that host's, e.g. its own TG_CTL_CONFIG_DIR) and cwd `/`.
    """
    return fake_ssh(
        directory,
        FORCED_COMMAND.format(launcher=str(LAUNCHER), command=command, remote_env=remote_env or {}),
        name,
    )


def fake_sink(directory: Path, body: str) -> Path:
    """An executable standing in for `tg-ctl`; `body` sees `req` (the stdin JSON) and `argv`.

    Each call appends `{argv, req}` as one JSON line to `<directory>/sink.log`, before `body` runs.
    """
    script = directory / "fake-sink"
    script.write_text(
        f"#!{sys.executable}\n"
        "import json, os, sys, time\n"
        "argv = sys.argv[1:]\n"
        "raw = sys.stdin.buffer.read()\n"
        "req = json.loads(raw)\n"
        f"with open({str(directory / 'sink.log')!r}, 'a') as log:\n"
        "    log.write(json.dumps({'argv': argv, 'req': req}, ensure_ascii=False) + '\\n')\n"
        + textwrap.dedent(body)
    )
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    return script


def sink_calls(directory: Path) -> list[dict[str, object]]:
    log = directory / "sink.log"
    if not log.exists():
        return []
    return [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]


class FakeDaemon:
    """A unix-socket hook server: one JSON line in, one reply line out, then close."""

    def __init__(self, path: Path, handler: Callable[[dict[str, object]], bytes | None]) -> None:
        self.path = path
        self.requests: list[dict[str, object]] = []
        self._handler = handler
        self._server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._server.bind(str(path))
        self._server.listen(8)
        self._stop = False
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self) -> None:
        while not self._stop:
            try:
                conn, _ = self._server.accept()
            except OSError:
                return
            threading.Thread(target=self._one, args=(conn,), daemon=True).start()

    def _one(self, conn: socket.socket) -> None:
        with conn:
            data = b""
            while not data.endswith(b"\n"):
                chunk = conn.recv(65536)
                if not chunk:
                    break
                data += chunk
            if not data:
                return  # a connect-and-close probe
            request = json.loads(data)
            self.requests.append(request)
            reply = self._handler(request)
            if reply is not None:
                conn.sendall(reply)

    def close(self) -> None:
        self._stop = True
        self._server.close()
        self.path.unlink(missing_ok=True)


def reply_line(obj: dict[str, object]) -> bytes:
    return json.dumps(obj, ensure_ascii=False).encode() + b"\n"


def write_config(config_dir: Path, control: str, token: str | None = "8574086668:SECRET") -> None:
    (config_dir / "config.yaml").write_text(f"control:\n{control}")
    if token is not None:
        (config_dir / ".env").write_text(f"TG_BOT_TOKEN={token}\nTG_CHAT_ID=1\n")


def env_for(config_dir: Path, **extra: str) -> dict[str, str]:
    env = {"PATH": os.environ.get("PATH", ""), "TG_CTL_CONFIG_DIR": str(config_dir)}
    env.update(extra)
    return env
