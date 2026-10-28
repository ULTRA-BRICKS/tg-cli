"""File writes with the modes and atomicity the TS implementation had."""

import contextlib
import os
import secrets
import sys
from collections.abc import Sequence
from pathlib import Path


def fsync_dir(directory: Path) -> None:
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


def _write_tmp(path: Path, data: str | bytes, mode: int) -> Path:
    """Write `data` to a fresh, fsynced temp file beside `path`; the caller publishes it.

    The temp name is unique per call and created exclusively without following symlinks, so
    concurrent writers of one path never share a temp file. A failed write removes it.
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
    except BaseException:
        with contextlib.suppress(OSError):
            tmp.unlink()
        raise
    return tmp


def atomic_write(path: Path, data: str | bytes, mode: int = 0o600) -> None:
    """tmp file in the same directory, fsync, rename, fsync the directory."""
    tmp = _write_tmp(path, data, mode)
    try:
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            tmp.unlink()
        raise
    fsync_dir(path.parent)


def atomic_create(path: Path, data: str | bytes, mode: int = 0o600) -> bool:
    """Publish `data` at `path` complete and fsynced, never replacing an existing file.

    Like `atomic_write`, but the final step is a hard link, which fails when `path` exists: the
    file is either absent or whole, and exactly one concurrent creator wins. True = created.
    """
    tmp = _write_tmp(path, data, mode)
    try:
        os.link(tmp, path)
    except FileExistsError:
        return False
    finally:
        with contextlib.suppress(OSError):
            tmp.unlink()
    fsync_dir(path.parent)
    return True


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
