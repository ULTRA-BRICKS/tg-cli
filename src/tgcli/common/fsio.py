"""File writes with the modes and atomicity the TS implementation had."""

import contextlib
import os
import secrets
import sys
from collections.abc import Sequence
from pathlib import Path


def _fsync_dir(directory: Path) -> None:
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _write_all(fd: int, payload: bytes) -> None:
    view = memoryview(payload)
    while view:
        written = os.write(fd, view)
        if written == 0:
            raise OSError("write made no progress")
        view = view[written:]


def atomic_write(path: Path, data: str | bytes, mode: int = 0o600) -> None:
    """tmp file in the same directory, fsync, rename, fsync the directory.

    The temp name is unique per call and created exclusively without following symlinks, so
    concurrent writers of one path never share a temp file.
    """
    payload = data.encode("utf-8") if isinstance(data, str) else data
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(8)}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        try:
            os.fchmod(fd, mode)
            _write_all(fd, payload)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            tmp.unlink()
        raise
    _fsync_dir(path.parent)


def append_lines(path: Path, lines: Sequence[str], *, fsync: bool, mode: int = 0o600) -> None:
    """Append each line plus a newline in ONE `O_APPEND` write. A short write is reported
    (OSError), not prevented: a torn fragment may remain, and a retry would no longer be one
    write."""
    payload = "".join(f"{line}\n" for line in lines).encode("utf-8")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, mode)
    try:
        written = os.write(fd, payload)
        if written != len(payload):
            raise OSError(f"short append to {path}: {written} of {len(payload)} bytes")
        if fsync:
            os.fsync(fd)
    finally:
        os.close(fd)


def read_text_lossy(path: Path) -> str:
    """Never `read_text`: universal newlines would turn CR bytes into LF."""
    return path.read_bytes().decode("utf-8", "replace")


def read_stdin_lossy() -> str:
    """Read stdin bytes without newline translation and replace invalid UTF-8, as Bun does."""
    return sys.stdin.buffer.read().decode("utf-8", "replace")
