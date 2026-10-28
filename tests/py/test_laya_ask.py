"""The whole caller: warm ask, stale socket, autostart, bounded retry, trust and timeouts.

Real unix sockets, a real second process for the "started" server and a fake `task` shell script
(laya_fakes.FAKE_TASK). No model is loaded and nothing leaves the machine.
"""

import contextlib
import json
import os
import signal
import sys
import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import laya_fakes
import pytest
from laya_fakes import FakeLaya, install_fake_task, stale_socket

from tgcli.laya import autostart
from tgcli.laya.ask import Ok, Unavailable, ask_laya
from tgcli.laya.config import resolve_settings

QUESTIONS = {"asks_reader": {"type": "noul", "instructions": "?"}}


@dataclass
class Rig:
    root: Path
    env: dict[str, str]
    classify: Path
    log: Path
    state_file: Path

    def ask(self, config: str = "", **env: str) -> Ok | Unavailable:
        merged = {**self.env, **env}
        return ask_laya(
            "hello there", QUESTIONS, resolve_settings(config, merged), merged, lambda _: None
        )

    def task_runs(self) -> int:
        return len(self.log.read_text().splitlines()) if self.log.exists() else 0


@pytest.fixture
def rig(tmp_path: Path) -> Iterator[Rig]:
    state = tmp_path / "state"
    classify = state / "task-cli" / "classify"
    classify.mkdir(parents=True, mode=0o700)
    bindir = tmp_path / "bin"
    install_fake_task(bindir)
    log = tmp_path / "task.log"
    env = {
        "HOME": str(tmp_path / "home"),
        "XDG_STATE_HOME": str(state),
        "PATH": f"{bindir}:/usr/bin:/bin",
        "TASK_FAKE_LOG": str(log),
        "TASK_FAKE_SOCKET": str(classify / "laya-fake.sock"),
        "TASK_FAKE_PYTHON": sys.executable,
        "TASK_FAKE_SCRIPT": laya_fakes.__file__,
        "TG_LAYA_TIMEOUT_MS": "2000",
        "TG_LAYA_COLD_TIMEOUT_SEC": "10",
    }
    yield Rig(tmp_path, env, classify, log, state / "tg-cli" / "laya-autostart.json")
    for pid_file in tmp_path.rglob("*.pid"):
        with contextlib.suppress(OSError, ValueError):
            os.kill(int(pid_file.read_text()), signal.SIGTERM)


def assert_unavailable(result: Ok | Unavailable, reason: str) -> Unavailable:
    assert isinstance(result, Unavailable), result
    assert result.reason == reason, result
    assert result.attempt and result.remedy
    return result


def test_warm_server_answers_without_touching_task(rig: Rig):
    server = FakeLaya(str(rig.classify / "laya-0.23.0.sock")).start()
    result = rig.ask()
    assert isinstance(result, Ok)
    assert json.loads(result.line)["result"]["answers"]["asks_reader"]["noul"] == 0.93
    assert server.requests[0]["message"] == "hello there"
    assert rig.task_runs() == 0
    server.stop()


def test_stale_socket_triggers_one_autostart_and_the_ask_succeeds(rig: Rig):
    stale_socket(str(rig.classify / "laya-fake.sock"))
    result = rig.ask()
    assert isinstance(result, Ok)
    assert rig.task_runs() == 1
    assert not rig.state_file.exists()


def test_no_socket_with_autostart_starts_laya_and_asks(rig: Rig):
    assert isinstance(rig.ask(), Ok)
    assert "classify-server start" in rig.log.read_text()


def test_no_socket_without_autostart_is_a_typed_reason_and_runs_nothing(rig: Rig):
    result = assert_unavailable(rig.ask("laya:\n  autostart: false\n"), "no-socket")
    assert "autostart" in result.attempt
    assert "task classify-server start" in result.remedy
    assert rig.task_runs() == 0


def test_failed_start_is_remembered_then_skipped_then_retried_after_the_window(rig: Rig):
    first = assert_unavailable(rig.ask(TASK_FAKE_MODE="fail"), "autostart-failed")
    assert "model weights missing" in first.detail
    assert "exit 1" in first.attempt
    assert rig.task_runs() == 1
    assert oct(rig.state_file.stat().st_mode & 0o777) == "0o600"
    started = time.monotonic()
    second = assert_unavailable(rig.ask(TASK_FAKE_MODE="fail"), "autostart-skipped")
    assert time.monotonic() - started < 1.0
    assert "skipped" in second.attempt and "ago" in second.attempt
    assert rig.task_runs() == 1  # not retried inside the window
    record = json.loads(rig.state_file.read_text())
    record["at"] -= 301
    rig.state_file.write_text(json.dumps(record))
    assert_unavailable(rig.ask(TASK_FAKE_MODE="fail"), "autostart-failed")
    assert rig.task_runs() == 2


def test_a_live_server_overrides_a_remembered_failure(rig: Rig):
    assert_unavailable(rig.ask(TASK_FAKE_MODE="fail"), "autostart-failed")
    server = FakeLaya(str(rig.classify / "laya-manual.sock")).start()
    assert isinstance(rig.ask(TASK_FAKE_MODE="fail"), Ok)  # started by hand: no need to wait
    assert rig.task_runs() == 1
    server.stop()


def test_hung_start_is_a_cold_timeout_bounded_by_the_cold_budget(rig: Rig):
    started = time.monotonic()
    result = assert_unavailable(
        rig.ask(TASK_FAKE_MODE="hang", TG_LAYA_COLD_TIMEOUT_SEC="1"), "cold-timeout"
    )
    assert 0.9 <= time.monotonic() - started < 5.0
    assert "1 s" in result.attempt
    assert "laya.cold_timeout_sec" in result.remedy
    assert rig.state_file.exists()


def test_slow_live_server_is_a_warm_timeout_and_never_restarted(rig: Rig):
    server = FakeLaya(str(rig.classify / "laya-slow.sock"), mode="silent").start()
    started = time.monotonic()
    result = assert_unavailable(rig.ask(TG_LAYA_TIMEOUT_MS="300"), "timeout")
    assert time.monotonic() - started < 3.0
    assert "300" in result.attempt
    assert rig.task_runs() == 0
    server.stop()


def test_task_printing_an_untrusted_socket_path_is_refused(rig: Rig):
    result = assert_unavailable(rig.ask(TASK_FAKE_MODE="badpath"), "untrusted-socket")
    assert "/etc" in result.detail
    assert rig.state_file.exists()


def test_start_that_prints_a_path_nobody_listens_on_fails(rig: Rig):
    # `task` claims success and prints a socket path, but nothing ever listens there.
    result = rig.ask(TASK_FAKE_SOCKET=str(rig.classify / "laya-ghost.sock"), TASK_FAKE_MODE="ghost")
    assert_unavailable(result, "autostart-failed")


def test_concurrent_senders_start_exactly_one_server(rig: Rig):
    env = {"TASK_FAKE_DELAY": "1"}
    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(lambda _: rig.ask(**env), range(3)))
    assert all(isinstance(r, Ok) for r in results), results
    assert rig.task_runs() == 1


def test_directory_others_can_enter_is_never_used(rig: Rig):
    server = FakeLaya(str(rig.classify / "laya-open.sock")).start()
    os.chmod(rig.classify, 0o755)
    result = assert_unavailable(rig.ask(), "untrusted-socket")
    assert "not private" in result.detail
    assert server.requests == []
    assert rig.task_runs() == 0
    server.stop()


def test_pinned_socket_is_used_and_never_autostarted(rig: Rig):
    server = FakeLaya(str(rig.root / "pinned.sock")).start()
    os.chmod(rig.root, 0o700)
    assert isinstance(rig.ask(TG_LAYA_SOCKET=server.path), Ok)
    stale_socket(str(rig.root / "stale.sock"))
    assert_unavailable(rig.ask(TG_LAYA_SOCKET=str(rig.root / "stale.sock")), "no-socket")
    assert rig.task_runs() == 0
    server.stop()


def test_yaml_pinned_socket_is_used_and_autostart_never_runs_task(rig: Rig):
    os.chmod(rig.root, 0o700)
    server = FakeLaya(str(rig.root / "pinned.sock")).start()
    config = f"laya:\n  autostart: true\n  socket: {server.path}\n"
    assert isinstance(rig.ask(config), Ok)
    assert len(server.requests) == 1
    stale = str(rig.root / "stale.sock")
    stale_socket(stale)
    for pinned in (f"laya:\n  autostart: true\n  socket: {stale}\n", None):
        result = (
            rig.ask(pinned)
            if pinned
            else rig.ask(f"laya:\n  socket: {server.path}\n", TG_LAYA_SOCKET=stale)
        )
        assert_unavailable(result, "no-socket")
        assert stale in result.remedy and "external" in result.remedy
        assert "does not start a model" in result.remedy
    assert rig.task_runs() == 0
    assert not rig.state_file.exists()
    server.stop()


def test_pinned_unreachable_socket_never_spawns_task_even_without_any_listener(rig: Rig):
    os.chmod(rig.root, 0o700)
    missing = str(rig.root / "missing.sock")
    result = assert_unavailable(rig.ask(f"laya:\n  socket: {missing}\n"), "no-socket")
    assert missing in result.remedy and "external" in result.remedy
    assert rig.task_runs() == 0


def test_pinned_socket_in_an_open_directory_is_untrusted(rig: Rig, tmp_path: Path):
    open_dir = tmp_path / "open"
    open_dir.mkdir(mode=0o755)
    open_dir.chmod(0o755)
    assert_unavailable(rig.ask(TG_LAYA_SOCKET=str(open_dir / "x.sock")), "untrusted-socket")


def test_disabled_never_connects_or_spawns(rig: Rig):
    server = FakeLaya(str(rig.classify / "laya-1.sock")).start()
    assert_unavailable(rig.ask(TG_LAYA="0"), "disabled")
    assert server.requests == [] and rig.task_runs() == 0
    server.stop()


def test_oversized_request_is_refused_before_any_effect(rig: Rig):
    settings = resolve_settings("", rig.env)
    result = ask_laya("x" * 20_000, QUESTIONS, settings, rig.env, lambda _: None)
    assert_unavailable(result, "payload-too-large")
    assert rig.task_runs() == 0


def test_task_only_on_an_untrusted_path_entry_is_not_run(rig: Rig, tmp_path: Path):
    world = tmp_path / "world"
    install_fake_task(world)
    world.chmod(0o777)
    result = assert_unavailable(rig.ask(PATH=f"{world}:relative/bin"), "no-task")
    assert "world-writable" in result.detail and str(world) in result.detail
    assert rig.task_runs() == 0


def test_task_bin_pins_the_binary_and_a_bad_one_does_not_fall_through(rig: Rig, tmp_path: Path):
    pinned = tmp_path / "pinned-bin"
    task = install_fake_task(pinned)
    task.chmod(0o644)
    result = assert_unavailable(rig.ask(f"laya:\n  task_bin: {task}\n"), "no-task")
    assert "not executable" in result.detail
    task.chmod(0o755)
    assert isinstance(rig.ask(f"laya:\n  task_bin: {task}\n", PATH="/usr/bin:/bin"), Ok)


def test_the_child_env_is_sanitized(rig: Rig, tmp_path: Path):
    probe = tmp_path / "env-probe"
    task = install_fake_task(probe)
    task.write_text('#!/bin/sh\nenv > "$TASK_FAKE_LOG"\necho /nonexistent/laya.sock\n')
    rig.ask(
        f"laya:\n  task_bin: {task}\n",
        TG_BOT_TOKEN="123:secret",
        ANTHROPIC_API_KEY="k",
        TASK_KEEP="yes",
    )
    seen = rig.log.read_text()
    assert "TG_BOT_TOKEN" not in seen and "ANTHROPIC_API_KEY" not in seen
    assert "TASK_KEEP=yes" in seen and "HOME=" in seen


def test_an_unwritable_state_dir_is_a_typed_failure_not_a_traceback(rig: Rig):
    # `<state>/tg-cli` is a regular file: neither the lock nor the failure record can be created.
    rig.state_file.parent.write_text("in the way")
    result = assert_unavailable(rig.ask(), "autostart-failed")
    assert "cannot use the start lock" in result.detail
    assert rig.task_runs() == 0


def test_a_failure_that_cannot_be_recorded_says_so(rig: Rig, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(autostart, "record_failure", lambda *_: "PermissionError: read-only")
    result = assert_unavailable(rig.ask(TASK_FAKE_MODE="fail"), "autostart-failed")
    assert "could not record this failure (PermissionError: read-only)" in result.remedy


def test_a_task_that_cannot_be_executed_is_autostart_failed(rig: Rig, tmp_path: Path):
    broken = tmp_path / "broken-bin" / "task"
    broken.parent.mkdir()
    broken.write_text("#!/nonexistent/interpreter\n")
    broken.chmod(0o755)
    result = assert_unavailable(rig.ask(f"laya:\n  task_bin: {broken}\n"), "autostart-failed")
    assert "could not be executed" in result.attempt
