"""Which socket and which `task` binary tg is willing to trust."""

import os
import socket
from pathlib import Path

from tgcli.laya.discovery import (
    check_socket_path,
    discover_sockets,
    private_dir,
    resolve_task,
)


def make_dir(path: Path, mode: int = 0o700) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    path.chmod(mode)
    return path


def bind_socket(path: Path) -> socket.socket:
    s = socket.socket(socket.AF_UNIX)
    s.bind(str(path))
    return s


def executable(path: Path) -> Path:
    path.write_text("#!/bin/sh\nexit 0\n")
    path.chmod(0o755)
    return path


def test_private_dir_rules(tmp_path: Path):
    assert private_dir(make_dir(tmp_path / "ok"))
    assert not private_dir(make_dir(tmp_path / "group", 0o750))
    assert not private_dir(make_dir(tmp_path / "other", 0o705))
    assert not private_dir(tmp_path / "missing")
    (tmp_path / "link").symlink_to(tmp_path / "ok")
    assert not private_dir(tmp_path / "link")  # a symlink could point anywhere


def test_discovery_returns_newest_sockets_first_and_ignores_other_files(tmp_path: Path):
    classify = make_dir(tmp_path / "task-cli" / "classify")
    old = bind_socket(classify / "laya-0.22.0.sock")
    new = bind_socket(classify / "laya-0.23.0.sock")
    os.utime(classify / "laya-0.22.0.sock", (1, 1))
    (classify / "laya-0.23.0.sock.lock").write_text("")
    (classify / "other.sock").write_text("")
    found = discover_sockets({"XDG_STATE_HOME": str(tmp_path)})
    assert found.sockets == [str(classify / "laya-0.23.0.sock"), str(classify / "laya-0.22.0.sock")]
    assert found.untrusted is None
    old.close()
    new.close()


def test_discovery_falls_back_to_home_local_state(tmp_path: Path):
    classify = make_dir(tmp_path / ".local" / "state" / "task-cli" / "classify")
    s = bind_socket(classify / "laya-1.sock")
    assert discover_sockets({"HOME": str(tmp_path)}).sockets == [str(classify / "laya-1.sock")]
    s.close()


def test_discovery_without_a_classify_dir_is_just_empty(tmp_path: Path):
    found = discover_sockets({"XDG_STATE_HOME": str(tmp_path)})
    assert (found.sockets, found.untrusted) == ([], None)


def test_discovery_refuses_a_directory_others_can_enter(tmp_path: Path):
    classify = make_dir(tmp_path / "task-cli" / "classify", 0o755)
    s = bind_socket(classify / "laya-1.sock")
    found = discover_sockets({"XDG_STATE_HOME": str(tmp_path)})
    assert found.sockets == []
    assert found.untrusted is not None and "classify" in found.untrusted
    s.close()


def test_check_socket_path(tmp_path: Path):
    private = make_dir(tmp_path / "p")
    open_dir = make_dir(tmp_path / "o", 0o755)
    s1 = bind_socket(private / "a.sock")
    s2 = bind_socket(open_dir / "a.sock")
    assert check_socket_path(str(private / "a.sock")) is None
    assert check_socket_path(str(private / "absent.sock")) is None  # absent is not untrusted
    assert "not private" in (check_socket_path(str(open_dir / "a.sock")) or "")
    (private / "plain").write_text("")
    assert "not a socket" in (check_socket_path(str(private / "plain")) or "")
    assert "absolute" in (check_socket_path("rel/laya.sock") or "")
    s1.close()
    s2.close()


def test_task_bin_must_be_absolute_and_executable(tmp_path: Path):
    good = executable(tmp_path / "task")
    assert resolve_task(str(good), "").path == str(good)
    plain = tmp_path / "plain"
    plain.write_text("")
    bad = resolve_task(str(plain), str(tmp_path))
    assert bad.path is None and "not executable" in (bad.problem or "")
    missing = resolve_task(str(tmp_path / "nope"), str(tmp_path))
    assert missing.path is None and "does not exist" in (missing.problem or "")


def test_task_found_on_a_trusted_path_entry(tmp_path: Path):
    trusted = make_dir(tmp_path / "bin", 0o755)
    executable(trusted / "task")
    resolved = resolve_task(None, f"/nonexistent:{trusted}")
    assert resolved.path == str(trusted / "task")


def test_untrusted_path_entries_are_skipped_and_named(tmp_path: Path, monkeypatch):
    world = make_dir(tmp_path / "world", 0o777)
    executable(world / "task")
    rel = make_dir(tmp_path / "rel", 0o755)
    executable(rel / "task")
    monkeypatch.chdir(tmp_path)
    resolved = resolve_task(None, f"{world}:rel:.:")
    assert resolved.path is None
    assert "no `task` on a trusted PATH" in (resolved.problem or "")
    assert any("world-writable" in s and str(world) in s for s in resolved.skipped)
    assert any("not absolute" in s for s in resolved.skipped)


def test_empty_path_has_no_task(tmp_path: Path):
    resolved = resolve_task(None, "")
    assert resolved.path is None and resolved.problem
