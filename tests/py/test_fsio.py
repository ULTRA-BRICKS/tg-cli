import os
import secrets
import stat
import threading
from pathlib import Path

import pytest

from tgcli.common.fsio import append_lines, atomic_write, read_text_lossy


def test_read_text_lossy_keeps_crlf(tmp_path: Path) -> None:
    path = tmp_path / "f"
    path.write_bytes(b"a\r\nb\rc")
    assert read_text_lossy(path) == "a\r\nb\rc"


def test_read_text_lossy_replaces_invalid_utf8(tmp_path: Path) -> None:
    path = tmp_path / "f"
    path.write_bytes(b"a\xffb")
    assert read_text_lossy(path) == "a\ufffdb"


def test_atomic_write_mode_and_content(tmp_path: Path) -> None:
    path = tmp_path / "f"
    atomic_write(path, "héllo")
    assert path.read_bytes() == "héllo".encode()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    other = tmp_path / "g"
    atomic_write(other, b"\x00\x01", mode=0o644)
    assert other.read_bytes() == b"\x00\x01"
    assert stat.S_IMODE(other.stat().st_mode) == 0o644
    assert sorted(os.listdir(tmp_path)) == ["f", "g"]


def test_atomic_write_replaces_existing(tmp_path: Path) -> None:
    path = tmp_path / "f"
    path.write_text("old")
    path.chmod(0o644)
    atomic_write(path, "new")
    assert path.read_text() == "new"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_append_lines(tmp_path: Path) -> None:
    path = tmp_path / "log"
    append_lines(path, ["a", "b"], fsync=True)
    append_lines(path, ["c"], fsync=False)
    assert path.read_text() == "a\nb\nc\n"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_append_lines_short_write_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    real_write = os.write
    monkeypatch.setattr(os, "write", lambda fd, data: real_write(fd, bytes(data)[:1]))
    with pytest.raises(OSError, match="short append"):
        append_lines(tmp_path / "log", ["abc"], fsync=False)


def test_atomic_write_concurrent_writers(tmp_path: Path) -> None:
    path = tmp_path / "f"
    payloads = [str(i) * 20_000 for i in range(4)]
    errors: list[BaseException] = []

    def write(payload: str) -> None:
        try:
            for _ in range(5):
                atomic_write(path, payload)
        except BaseException as error:
            errors.append(error)

    threads = [threading.Thread(target=write, args=(p,)) for p in payloads]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert errors == []
    assert path.read_text() in payloads
    assert [p.name for p in tmp_path.iterdir()] == ["f"]


def test_atomic_write_does_not_follow_planted_symlink(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    victim = tmp_path / "victim"
    victim.write_text("keep")
    path = tmp_path / "f"
    monkeypatch.setattr(secrets, "token_hex", lambda _n: "fixed")
    (tmp_path / f".f.{os.getpid()}.fixed.tmp").symlink_to(victim)
    with pytest.raises(FileExistsError):
        atomic_write(path, "pwned")
    assert victim.read_text() == "keep"
    assert not path.exists()


@pytest.mark.parametrize("payload", [b"a\r\nb\rc", b"a\xffb"])
def test_stdin_keeps_crlf(payload: bytes) -> None:
    import subprocess
    import sys

    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "from tgcli.common.fsio import read_stdin_lossy; "
            "import sys; sys.stdout.buffer.write(read_stdin_lossy().encode('utf-8'))",
        ],
        input=payload,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout == payload.decode("utf-8", "replace").encode("utf-8")


def test_atomic_write_zero_write_fails_without_replacing_target(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "f"
    path.write_bytes(b"old")
    attempts = 0
    real_write = os.write

    def zero_once(fd: int, data: bytes) -> int:
        nonlocal attempts
        attempts += 1
        return 0 if attempts == 1 else real_write(fd, data)

    monkeypatch.setattr(os, "write", zero_once)
    with pytest.raises(OSError, match="write"):
        atomic_write(path, "new")
    assert path.read_bytes() == b"old"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["f"]
