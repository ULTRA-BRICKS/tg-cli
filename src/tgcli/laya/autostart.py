"""Starting the Laya server through `task classify-server start`, boundedly and exclusively.

A failed start is remembered in `<state>/tg-cli/laya-autostart.json` (0600) so the next sends do
not each pay the cold budget again: no retry inside RETRY_WINDOW_SEC. Concurrent senders queue on
a flock; whoever gets it re-probes before spawning anything. `task` itself keeps its own exclusive
lock underneath, this one only stops us from stacking start attempts.
"""

import contextlib
import fcntl
import json
import os
import signal
import subprocess
import tempfile
import time
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path

from tgcli.common.fsio import atomic_write
from tgcli.laya.discovery import state_home

RETRY_WINDOW_SEC = 300.0
_KEEP_EXACT = {"PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR"}
_KEEP_PREFIX = ("XDG_", "TASK_", "LC_")


def sanitized_env(env: Mapping[str, str]) -> dict[str, str]:
    """The environment `task` runs with: no tokens, no agent or API variables."""
    return {k: v for k, v in env.items() if k in _KEEP_EXACT or k.startswith(_KEEP_PREFIX)}


def _state_dir(env: Mapping[str, str]) -> Path:
    return state_home(env) / "tg-cli"


def state_file(env: Mapping[str, str]) -> Path:
    return _state_dir(env) / "laya-autostart.json"


@dataclass(frozen=True)
class RecordedFailure:
    reason: str
    detail: str
    at: float

    def age(self, now: float) -> int:
        return max(0, int(now - self.at))


def read_recent_failure(env: Mapping[str, str], now: float) -> RecordedFailure | None:
    """The last failed start if still inside the retry window; a damaged file counts as none."""
    try:
        data = json.loads(state_file(env).read_text())
        record = RecordedFailure(str(data["reason"]), str(data["detail"]), float(data["at"]))
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return record if 0 <= now - record.at < RETRY_WINDOW_SEC else None


def record_failure(env: Mapping[str, str], reason: str, detail: str, now: float) -> str | None:
    """Remember a failed start; the error text when the state cannot be written (no bound then)."""
    payload = {"reason": reason, "detail": detail[:500], "at": now}
    try:
        _state_dir(env).mkdir(mode=0o700, parents=True, exist_ok=True)
        atomic_write(state_file(env), json.dumps(payload) + "\n", 0o600)
    except OSError as error:
        return f"{type(error).__name__}: {error}"
    return None


def clear_failure(env: Mapping[str, str]) -> None:
    with contextlib.suppress(FileNotFoundError):
        state_file(env).unlink()


def _acquire(fd: int, deadline: float) -> bool:
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except BlockingIOError:
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.05)


@contextlib.contextmanager
def start_lock(env: Mapping[str, str], deadline: float) -> Iterator[bool]:
    """Exclusive start lock; yields False when `deadline` (monotonic) passes first."""
    directory = _state_dir(env)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(directory / "laya-autostart.lock", os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o600)
    try:
        yield _acquire(fd, deadline)
    finally:
        os.close(fd)


@dataclass(frozen=True)
class StartResult:
    code: int | None  # None: killed at the deadline
    stdout: str
    stderr: str


def run_task_start(task: str, env: Mapping[str, str], timeout_s: float) -> StartResult:
    """`task classify-server start` as an argv list in its own process group, killed at the end.

    Output goes to anonymous files, not pipes: the server `task` leaves running may inherit them,
    and a pipe held open by a daemon would block us long after `task` exited.
    """
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        proc = subprocess.Popen(
            [task, "classify-server", "start"],
            stdin=subprocess.DEVNULL,
            stdout=out,
            stderr=err,
            env=sanitized_env(env),
            start_new_session=True,
        )
        try:
            code: int | None = proc.wait(timeout=max(timeout_s, 0.0))
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
            code = None
        out.seek(0)
        err.seek(0)
        return StartResult(
            code, out.read().decode("utf-8", "replace"), err.read().decode("utf-8", "replace")
        )


def printed_socket_path(stdout: str) -> str:
    """The socket path `task` printed: its last non-empty stdout line."""
    lines = [line.strip() for line in stdout.splitlines() if line.strip()]
    return lines[-1] if lines else ""
