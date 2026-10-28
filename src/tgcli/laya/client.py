"""One request/reply exchange with a classify server over a unix socket."""

import socket
import time
from dataclasses import dataclass
from typing import Literal

MAX_MESSAGE_BYTES = 16 * 1024  # request and reply cap: laya reads a few hundred tokens anyway

FailureKind = Literal["no-listener", "timeout", "connection-error", "invalid-response"]


@dataclass(frozen=True)
class Failure:
    kind: FailureKind
    detail: str


def _connect(sock: socket.socket, path: str) -> Failure | None:
    try:
        sock.connect(path)
    except FileNotFoundError:
        return Failure("no-listener", "no socket file")
    except ConnectionRefusedError:
        return Failure("no-listener", "connection refused (stale socket: nothing listens)")
    except TimeoutError:
        return Failure("timeout", "the server did not accept the connection in time")
    except OSError as error:
        return Failure("connection-error", error.strerror or str(error))
    return None


def _read_line(sock: socket.socket, deadline: float) -> str | Failure:
    buf = b""
    while b"\n" not in buf:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return Failure("timeout", "no reply before the deadline")
        sock.settimeout(remaining)
        try:
            chunk = sock.recv(4096)
        except TimeoutError:
            return Failure("timeout", "no reply before the deadline")
        except OSError as error:
            return Failure("connection-error", error.strerror or str(error))
        if not chunk:
            return Failure("connection-error", "the server closed the connection without a reply")
        buf += chunk
        if len(buf) > MAX_MESSAGE_BYTES and b"\n" not in buf:
            return Failure("invalid-response", f"reply longer than {MAX_MESSAGE_BYTES} bytes")
    return buf.split(b"\n", 1)[0].decode("utf-8", "replace")


def exchange(path: str, request: bytes, timeout_s: float) -> str | Failure:
    """Send `request` (one JSON line) and return the reply line, within `timeout_s` in total."""
    deadline = time.monotonic() + timeout_s
    with socket.socket(socket.AF_UNIX) as sock:
        sock.settimeout(timeout_s)
        failure = _connect(sock, path)
        if failure is not None:
            return failure
        try:
            sock.sendall(request + b"\n")
        except TimeoutError:
            return Failure("timeout", "could not send the request before the deadline")
        except OSError as error:
            return Failure("connection-error", error.strerror or str(error))
        return _read_line(sock, deadline)
