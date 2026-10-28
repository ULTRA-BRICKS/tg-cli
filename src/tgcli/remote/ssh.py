"""SSH transport: argv as a list, one process group per call, a hard deadline, bounded output.

Never a shell string, never a retry (spec §4.3). `TG_REMOTE_SSH` swaps the ssh binary for tests
only; it is read from the environment, never from config.
"""

import contextlib
import os
import selectors
import signal
import subprocess
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import IO, Final, Literal

from tgcli.remote import protocol
from tgcli.remote.protocol import BadReply, JsonObject

RECORD_DEADLINE: Final = 8.0
STATUS_DEADLINE: Final = 6.0
HELLO_DEADLINE: Final = 6.0
DELIVER_DEADLINE: Final = 15.0
STDERR_KEEP: Final = 8192
_CHUNK: Final = 65536
_SSH_FAILURE_CODE: Final = 255

SSH_OPTIONS: Final = (
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "ServerAliveInterval=5",
    "-o",
    "ServerAliveCountMax=2",
)

type Kind = Literal["ok", "unreachable", "timeout", "remote-failed", "bad-reply", "oversized"]


def ssh_binary(env: Mapping[str, str]) -> str:
    return env.get("TG_REMOTE_SSH") or "ssh"


def client_argv(alias: str, machine: str, env: Mapping[str, str]) -> list[str]:
    """Always an explicit constant command: protocol JSON must never reach a login shell.

    The client's key forces the pinned endpoint and ignores this command; an ordinary key would
    run it, and a missing launcher is then the remote shell's 127, not a shell reading the JSON.
    """
    if not protocol.is_server(f"ssh://{alias}"):
        raise ValueError("ssh alias is not a plain host name")
    if not protocol.is_machine(machine):
        raise ValueError("machine is not a plain machine name")
    return [ssh_binary(env), *SSH_OPTIONS, "--", alias, "tg-remote", "server", "--peer", machine]


def hub_argv(target: str, env: Mapping[str, str]) -> list[str]:
    """Daemon host -> client machine: host keys are always checked, `--` ends the options."""
    if not protocol.is_target(target):
        raise ValueError("ssh target is not [user@]host")
    return [
        ssh_binary(env),
        *SSH_OPTIONS,
        "-o",
        "StrictHostKeyChecking=yes",
        "--",
        target,
        "tg-remote",
        "satellite",
        "serve",
    ]


@dataclass(frozen=True)
class RunResult:
    returncode: int | None
    stdout: bytes
    stderr: bytes
    timed_out: bool
    oversized: bool
    written: bool


@dataclass(frozen=True)
class Outcome:
    kind: Kind
    detail: str
    reply: JsonObject | None
    written: bool


class _Pump:
    """Non-blocking stdin feed and capped stdout/stderr collection for one child."""

    def __init__(self, proc: subprocess.Popen[bytes], stdin: bytes, stdout_cap: int) -> None:
        assert proc.stdin is not None and proc.stdout is not None and proc.stderr is not None
        self.proc = proc
        self.streams: dict[str, IO[bytes]] = {
            "stdin": proc.stdin,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
        }
        self.pending = memoryview(stdin)
        self.stdout = bytearray()
        self.stderr = bytearray()
        self.stdout_cap = stdout_cap
        self.written = not stdin
        self.oversized = False
        self.selector = selectors.DefaultSelector()
        for stream in self.streams.values():
            os.set_blocking(stream.fileno(), False)
        self.selector.register(proc.stdout, selectors.EVENT_READ, "stdout")
        self.selector.register(proc.stderr, selectors.EVENT_READ, "stderr")
        if stdin:
            self.selector.register(proc.stdin, selectors.EVENT_WRITE, "stdin")
        else:
            proc.stdin.close()

    def step(self, timeout: float) -> bool:
        """Pump whatever is ready; False once nothing is left to pump or the output cap broke."""
        handled = self._handle(self.selector.select(timeout))
        if not handled and self.proc.poll() is not None:
            # The child may have written and exited between select() and poll(): look once more.
            handled = self._handle(self.selector.select(0))
            if not handled:
                return False
        return not self.oversized and bool(self.selector.get_map())

    def _handle(self, events: list[tuple[selectors.SelectorKey, int]]) -> bool:
        for key, _ in events:
            if key.data == "stdin":
                self._feed()
            else:
                self._drain(key.data)
        return bool(events)

    def _feed(self) -> None:
        try:
            sent = os.write(self.streams["stdin"].fileno(), self.pending[:_CHUNK])
        except BlockingIOError:
            return
        except OSError:
            self._close_stdin()
            return
        self.pending = self.pending[sent:]
        if not self.pending:
            self.written = True
            self._close_stdin()

    def _close_stdin(self) -> None:
        self.selector.unregister(self.streams["stdin"])
        self.streams["stdin"].close()

    def _drain(self, name: str) -> None:
        stream = self.streams[name]
        try:
            chunk = os.read(stream.fileno(), _CHUNK)
        except BlockingIOError:
            return
        except OSError:
            chunk = b""
        if not chunk:
            self.selector.unregister(stream)
        elif name == "stdout":
            self.stdout += chunk
            self.oversized = len(self.stdout) > self.stdout_cap
        else:
            self.stderr += chunk
            del self.stderr[:-STDERR_KEEP]


def _kill_group(proc: subprocess.Popen[bytes]) -> None:
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(proc.pid, signal.SIGKILL)


def run(
    argv: list[str],
    stdin: bytes,
    deadline: float,
    env: Mapping[str, str],
    stdout_cap: int = protocol.MAX_REPLY_BYTES + 2,
) -> RunResult:
    """Run `argv` in its own process group; at `deadline` seconds the whole group is killed.

    Raises OSError when the binary cannot be started.
    """
    end = time.monotonic() + deadline
    proc = subprocess.Popen(
        argv,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
        env=dict(env),
    )
    pump = _Pump(proc, stdin, stdout_cap)
    timed_out = False
    try:
        while True:
            remaining = end - time.monotonic()
            if remaining <= 0:
                timed_out = True
                break
            if not pump.step(min(remaining, 0.2)):
                break
        if not timed_out and not pump.oversized:
            try:
                proc.wait(timeout=max(end - time.monotonic(), 0.01))
            except subprocess.TimeoutExpired:
                timed_out = True
    finally:
        # Also reaps what the child left behind (ProxyCommand helpers, a master connection).
        _kill_group(proc)
        pump.selector.close()
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            if stream is not None and not stream.closed:
                stream.close()
        proc.wait()
    return RunResult(
        returncode=None if timed_out or pump.oversized else proc.returncode,
        stdout=bytes(pump.stdout[: stdout_cap + 1]),
        stderr=bytes(pump.stderr),
        timed_out=timed_out,
        oversized=pump.oversized,
        written=pump.written,
    )


def _tail(raw: bytes) -> str:
    """The last words of a stderr dump as one clean line."""
    text = raw.decode("utf-8", "replace")
    return " ".join(protocol.printable(text).split())[-protocol.MAX_DETAIL_CHARS :]


def _classify(result: RunResult, op: str) -> Outcome:
    detail = _tail(result.stderr)
    if result.timed_out:
        return Outcome(
            "timeout", "no reply before the deadline; ssh was killed", None, result.written
        )
    if result.oversized:
        return Outcome("oversized", "reply exceeds the size cap", None, result.written)
    code = result.returncode
    if code == _SSH_FAILURE_CODE:
        return Outcome("unreachable", detail or "ssh exited 255", None, result.written)
    if code != 0:
        return Outcome(
            "remote-failed",
            f"exit {code}: {detail}" if detail else f"exit {code}",
            None,
            result.written,
        )
    line = result.stdout.removesuffix(b"\n")
    if not line or b"\n" in line:
        return Outcome("bad-reply", "expected exactly one reply line", None, result.written)
    try:
        reply = protocol.parse_reply(line, op)
    except BadReply as error:
        return Outcome("bad-reply", str(error)[: protocol.MAX_DETAIL_CHARS], None, result.written)
    return Outcome("ok", "", reply, result.written)


def exchange(
    argv: list[str], request: JsonObject, op: str, deadline: float, env: Mapping[str, str]
) -> Outcome:
    """Send one request line, read one reply line; one attempt, failures classified not retried."""
    line = protocol.encode_line(request, protocol.MAX_REQUEST_BYTES)
    try:
        result = run(argv, line, deadline, env)
    except OSError as error:
        return Outcome(
            "unreachable", f"cannot run {argv[0]}: {error.strerror or error}", None, False
        )
    return _classify(result, op)
