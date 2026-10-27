import os
import stat
import subprocess
import sys
import types
from collections.abc import Callable, Mapping
from pathlib import Path

import pytest

from tgcli import entry
from tgcli.entry import (
    DAEMON_TOKENS,
    DECLINE,
    DEFAULT,
    HANDLERS,
    SUBCOMMANDS,
    Decline,
    dispatch,
)
from tgcli.version import repo_root

BUN = "/fake/bun"


class Exec(Exception):
    def __init__(self, file: str, args: list[str], env: Mapping[str, str]) -> None:
        self.file = file
        self.argv = args
        self.env = env


@pytest.fixture
def execs(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_execvpe(file: str, args: list[str], env: Mapping[str, str]) -> None:
        raise Exec(file, args, env)

    monkeypatch.setattr(os, "execvpe", fake_execvpe)


@pytest.fixture
def handlers(monkeypatch: pytest.MonkeyPatch) -> Callable[[str, str, object], list[list[str]]]:
    """Register a fake handler module; returns the log of argv lists it received."""

    def register(entrypoint: str, token: str, result: object) -> list[list[str]]:
        calls: list[list[str]] = []
        mod = types.ModuleType(f"fake_{entrypoint}_{token}".replace("-", "_").replace("*", "d"))

        def handler(argv: list[str]) -> object:
            calls.append(argv)
            return result

        mod.handle = handler  # type: ignore[attr-defined]
        monkeypatch.setitem(sys.modules, mod.__name__, mod)
        monkeypatch.setitem(HANDLERS[entrypoint], token, f"{mod.__name__}:handle")
        return calls

    return register


def env(**extra: str) -> Mapping[str, str]:
    return {"TG_BUN": BUN, "HOME": "/nonexistent-home", **extra}


def test_dispatch_falls_through(execs: None) -> None:
    with pytest.raises(Exec) as caught:
        dispatch("tg", ["hello"], env())
    assert caught.value.file == BUN
    assert caught.value.argv == [BUN, str(repo_root() / "tg"), "hello"]


def test_dispatch_no_fallback_exit_70(execs: None, capsys: pytest.CaptureFixture[str]) -> None:
    assert dispatch("tg", ["hello"], env(TG_NO_TS_FALLBACK="1")) == 70
    assert capsys.readouterr().err == "tg: not ported yet: <send>\n"
    assert dispatch("tg-ctl", ["status"], env(TG_NO_TS_FALLBACK="1")) == 70
    assert capsys.readouterr().err == "tg-ctl: not ported yet: status\n"


def test_dispatch_routes_ported_handler(
    handlers: Callable[[str, str, object], list[list[str]]], execs: None
) -> None:
    auth = handlers("tg", "auth", 0)
    default = handlers("tg", DEFAULT, 5)
    assert dispatch("tg", ["auth", "login"], env()) == 0
    assert auth == [["login"]]
    assert dispatch("tg", ["hello", "world"], env()) == 5
    assert default == [["hello", "world"]]
    assert auth == [["login"]]


def test_dispatch_decline_runs_default_with_full_argv(
    handlers: Callable[[str, str, object], list[list[str]]], execs: None
) -> None:
    help_calls = handlers("tg", "help", DECLINE)
    default = handlers("tg", DEFAULT, 0)
    assert dispatch("tg", ["help", "me", "with", "this"], env()) == 0
    assert help_calls == [["me", "with", "this"]]
    assert default == [["help", "me", "with", "this"]]


def test_dispatch_decline_with_rewritten_argv(
    handlers: Callable[[str, str, object], list[list[str]]], execs: None
) -> None:
    handlers("tg", "user", Decline(["replies", "user", "x"]))
    default = handlers("tg", DEFAULT, 0)
    assert dispatch("tg", ["user", "x"], env()) == 0
    assert default == [["replies", "user", "x"]]


def test_dispatch_decline_without_default_falls_through(
    handlers: Callable[[str, str, object], list[list[str]]], execs: None
) -> None:
    handlers("tg", "help", Decline(["rewritten"]))
    with pytest.raises(Exec) as caught:
        dispatch("tg", ["help", "a", "b"], env())
    assert caught.value.argv == [BUN, str(repo_root() / "tg"), "help", "a", "b"]


def test_subcommand_tables() -> None:
    assert SUBCOMMANDS["tg"] == frozenset(
        {
            "install-skill",
            "auth",
            "call",
            "chatgpt",
            "user",
            "hooks",
            "voice",
            "help",
            "obligations",
            "report",
            "replies",
        }
    )
    assert SUBCOMMANDS["call-cli"] == frozenset()
    assert SUBCOMMANDS["tg-ctl"] >= DAEMON_TOKENS
    assert {"status", "alert", "omp-live", "usage-schedule", "ask", "withdraw"} <= SUBCOMMANDS[
        "tg-ctl"
    ]


@pytest.mark.parametrize("token", sorted(DAEMON_TOKENS))
def test_daemon_tokens_follow_daemon_selection(
    token: str,
    handlers: Callable[[str, str, object], list[list[str]]],
    execs: None,
) -> None:
    calls = handlers("tg-ctl", token, 0)
    with pytest.raises(Exec) as caught:
        dispatch("tg-ctl", [token], env(TG_NO_TS_FALLBACK="1"))
    assert caught.value.argv == [BUN, str(repo_root() / "tg-ctl"), token]
    assert calls == []


def test_daemon_impl(
    handlers: Callable[[str, str, object], list[list[str]]], execs: None, tmp_path: Path
) -> None:
    run = handlers("tg-ctl", "run", 0)
    py = env(TG_IMPL_TG_CTL_DAEMON="py", TG_NO_TS_FALLBACK="1")
    assert dispatch("tg-ctl", ["run"], py) == 0
    assert run == [[]]
    # selection beats TG_IMPL; TG_IMPL applies when the specific variable is absent
    with pytest.raises(Exec):
        dispatch("tg-ctl", ["run"], env(TG_IMPL_TG_CTL_DAEMON="ts", TG_IMPL="py"))
    assert dispatch("tg-ctl", ["run"], env(TG_IMPL="py")) == 0
    # state file is read last
    state = tmp_path / ".local/state/tg-cli/impl"
    state.mkdir(parents=True)
    (state / "tg-ctl-daemon").write_text("py\n")
    assert dispatch("tg-ctl", ["run"], env(HOME=str(tmp_path))) == 0
    # py selected but no handler for the token: still the TS, even under TG_NO_TS_FALLBACK
    with pytest.raises(Exec):
        dispatch("tg-ctl", ["restart"], py)
    # a non-daemon token ignores the daemon selection and follows the normal rule
    assert dispatch("tg-ctl", ["status"], py) == 70


def test_fall_through_flushes_stdout(tmp_path: Path) -> None:
    fake_bun = tmp_path / "bun"
    fake_bun.write_text('#!/bin/sh\necho "bun $*"\n')
    fake_bun.chmod(fake_bun.stat().st_mode | stat.S_IXUSR)
    code = (
        "import sys\n"
        "from tgcli.entry import dispatch\n"
        "import os\n"
        "print('before exec', end='')\n"
        "sys.exit(dispatch('tg', ['hi'], os.environ))\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        env={**os.environ, "TG_BUN": str(fake_bun)},
        check=True,
    )
    assert result.stdout == f"before execbun {repo_root() / 'tg'} hi\n"


def test_bun_resolution(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr("shutil.which", lambda _name: None)
    assert entry.resolve_bun({"HOME": str(tmp_path)}) == str(tmp_path / ".bun/bin/bun")
    monkeypatch.setattr("shutil.which", lambda _name: "/usr/bin/bun")
    assert entry.resolve_bun({}) == "/usr/bin/bun"
    assert entry.resolve_bun({"TG_BUN": "/x/bun"}) == "/x/bun"


def test_self_check() -> None:
    for name in ("tg", "tg-ctl", "call-cli"):
        result = subprocess.run(
            [sys.executable, "-m", "tgcli.entry", "--self-check", name],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, result.stderr


def test_self_check_fails_on_broken_handler(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(HANDLERS["tg"], "auth", "tgcli_does_not_exist:handle")
    assert entry.main(["--self-check", "tg"]) == 1


def test_handlers_imported_lazily(
    monkeypatch: pytest.MonkeyPatch,
    handlers: Callable[[str, str, object], list[list[str]]],
    execs: None,
) -> None:
    monkeypatch.setitem(HANDLERS["tg"], "auth", "tgcli_does_not_exist:handle")
    ok = handlers("tg", "call", 0)
    assert dispatch("tg", ["call", "x"], env()) == 0
    assert ok == [["x"]]
    with pytest.raises(ModuleNotFoundError):
        dispatch("tg", ["auth", "login"], env())


def test_daemon_exec_drops_no_fallback_flag(execs: None) -> None:
    with pytest.raises(Exec) as caught:
        dispatch("tg-ctl", ["run"], env(TG_NO_TS_FALLBACK="1", KEEP="me"))
    assert "TG_NO_TS_FALLBACK" not in caught.value.env
    assert caught.value.env["KEEP"] == "me"
    with pytest.raises(Exec) as caught:
        dispatch("tg", ["hi"], env(KEEP="me"))
    assert caught.value.env["KEEP"] == "me"


def test_daemon_impl_invalid_state_file_defaults_to_ts(tmp_path: Path) -> None:
    state = tmp_path / ".local/state/tg-cli/impl"
    state.mkdir(parents=True)
    (state / "tg-ctl-daemon").write_bytes(b"\xff\xfe")
    assert entry.daemon_impl({"HOME": str(tmp_path)}) == "ts"


@pytest.mark.parametrize(
    ("error", "message"),
    [
        (FileNotFoundError(2, "No such file or directory"), "No such file or directory"),
        (PermissionError(13, "Permission denied"), "Permission denied"),
    ],
)
def test_bun_exec_failure_is_a_clean_ordinary_error(
    error: OSError,
    message: str,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    def refuse(file: str, args: list[str], env: Mapping[str, str]) -> None:
        raise error

    monkeypatch.setattr(os, "execvpe", refuse)
    assert dispatch("tg", ["hi"], env()) == 1
    assert capsys.readouterr().err == f"tg: cannot run bun ({BUN}): {message}\n"


@pytest.mark.parametrize(("name", "token"), [("tg", "chatgpt"), ("tg-ctl", "capabilities")])
def test_current_main_subcommands_never_reach_send(
    name: str,
    token: str,
    handlers: Callable[[str, str, object], list[list[str]]],
    execs: None,
    capsys: pytest.CaptureFixture[str],
) -> None:
    calls = handlers(name, DEFAULT, 0)
    assert dispatch(name, [token, "--json"], env(TG_NO_TS_FALLBACK="1")) == 70
    assert calls == []
    assert capsys.readouterr().err == f"{name}: not ported yet: {token}\n"


@pytest.mark.parametrize("name", ["tg", "tg_ctl", "call_cli"])
def test_console_argv_invalid_utf8_is_replaced(
    name: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[list[str]] = []

    def capture(entrypoint: str, argv: list[str], environ: Mapping[str, str]) -> int:
        calls.append(argv)
        return 0

    monkeypatch.setattr(sys, "argv", [name, os.fsdecode(b"a\xffb")])
    monkeypatch.setattr(entry, "dispatch", capture)
    with pytest.raises(SystemExit) as caught:
        getattr(entry, name)()
    assert caught.value.code == 0
    assert calls == [["a\ufffdb"]]


def test_daemon_impl_reads_first_line_only(tmp_path: Path) -> None:
    state = tmp_path / ".local/state/tg-cli/impl"
    state.mkdir(parents=True)
    (state / "tg-ctl-daemon").write_bytes(b" py \nignored\n")
    assert entry.daemon_impl({"HOME": str(tmp_path)}) == "py"
