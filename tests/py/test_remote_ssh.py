"""SSH argv construction, bounded process-group runs, and result classification (spec §4.3)."""

import os
import signal
import time
from pathlib import Path

import pytest
from remote_fakes import fake_ssh, short_dir, ssh_calls

from tgcli.remote import ssh

OPTIONS = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "ServerAliveInterval=5",
    "-o",
    "ServerAliveCountMax=2",
]


def test_client_argv_is_options_then_double_dash_alias_and_the_fixed_server_command():
    assert ssh.client_argv("tg-ctl-ubuntu", "clvm", {}) == [
        "ssh",
        *OPTIONS,
        "--",
        "tg-ctl-ubuntu",
        "tg-remote",
        "server",
        "--peer",
        "clvm",
    ]


def test_hub_argv_pins_host_key_checking_and_runs_the_satellite():
    assert ssh.hub_argv("ultra@65.21.40.51", {}) == [
        "ssh",
        *OPTIONS,
        "-o",
        "StrictHostKeyChecking=yes",
        "--",
        "ultra@65.21.40.51",
        "tg-remote",
        "satellite",
        "serve",
    ]


def test_ssh_binary_override_is_the_test_seam_only():
    assert ssh.client_argv("h", "m", {"TG_REMOTE_SSH": "/tmp/fake"})[0] == "/tmp/fake"
    assert ssh.client_argv("h", "m", {"TG_REMOTE_SSH": ""})[0] == "ssh"


@pytest.mark.parametrize(
    "alias", ["-oProxyCommand=x", "u@h", "h:22", "h/x", "", "h h", "h\n", "h;id", "$(id)"]
)
def test_client_argv_refuses_anything_but_a_plain_alias(alias):
    with pytest.raises(ValueError):
        ssh.client_argv(alias, "clvm", {})


@pytest.mark.parametrize(
    "machine", ["", "Clvm", "-x", "a b", "a;id", "$(id)", "a\n", "a/../b", "a" * 33, "1a"]
)
def test_client_argv_refuses_a_machine_that_is_not_a_plain_name(machine):
    with pytest.raises(ValueError):
        ssh.client_argv("h", machine, {})


@pytest.mark.parametrize(
    "target", ["-oProxyCommand=x", "-h", "u@", "@h", "h h", "h;id", "h\n", "u@h:22", "", "`id`"]
)
def test_hub_argv_refuses_anything_but_a_plain_target(target):
    with pytest.raises(ValueError):
        ssh.hub_argv(target, {})


def test_strict_host_key_checking_is_never_relaxed():
    for argv in (ssh.client_argv("h", "m", {}), ssh.hub_argv("h", {})):
        assert not any("StrictHostKeyChecking=no" in a or "accept-new" in a for a in argv)


def script(body: str) -> list[str]:
    directory = short_dir()
    return [str(fake_ssh(directory, body)), "--", "host"]


def test_run_passes_stdin_through_and_reports_exit_code_and_both_streams():
    argv = script(
        "sys.stdout.write(sys.stdin.read().upper()); sys.stderr.write('warn'); sys.exit(3)"
    )
    result = ssh.run(argv, b"hello", 5, {})
    assert (result.returncode, result.stdout, result.stderr) == (3, b"HELLO", b"warn")
    assert not result.timed_out and not result.oversized and result.written


def test_run_handles_a_megabyte_of_stdin_without_deadlock():
    argv = script("data = sys.stdin.buffer.read(); sys.stdout.write(str(len(data)))")
    result = ssh.run(argv, b"x" * (1 << 20), 10, {})
    assert result.stdout == str(1 << 20).encode()


def test_run_caps_stdout_and_kills_the_producer():
    argv = script("sys.stdout.write('x' * 10_000_000); sys.stdout.flush()")
    start = time.monotonic()
    result = ssh.run(argv, b"", 10, {}, stdout_cap=1000)
    assert result.oversized and len(result.stdout) <= 1000 + 65536
    assert time.monotonic() - start < 5


def test_run_hard_deadline_kills_the_whole_process_group(tmp_path):
    marker = tmp_path / "grandchild.pid"
    argv = script(
        "import subprocess, time\n"
        f"child = subprocess.Popen(['sleep', '60'])\n"
        f"open({str(marker)!r}, 'w').write(str(child.pid))\n"
        "time.sleep(60)"
    )
    start = time.monotonic()
    result = ssh.run(argv, b"", 1, {})
    assert result.timed_out and result.returncode is None
    assert 0.9 < time.monotonic() - start < 4
    pid = int(marker.read_text())
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.05)
    else:
        os.kill(pid, signal.SIGKILL)
        pytest.fail("the grandchild of ssh survived the deadline")


def test_run_does_not_wait_for_a_grandchild_that_keeps_the_pipes_open():
    argv = script(
        "import subprocess\n"
        "subprocess.Popen(['sleep', '5'], stdout=sys.stdout, stderr=sys.stderr)\n"
        "sys.stdout.write('done')"
    )
    start = time.monotonic()
    result = ssh.run(argv, b"", 10, {})
    assert result.stdout == b"done" and result.returncode == 0
    assert time.monotonic() - start < 4


def test_run_survives_a_child_that_never_reads_stdin():
    argv = script("sys.stdout.write('ok')")
    result = ssh.run(argv, b"x" * (1 << 20), 5, {})
    assert result.stdout == b"ok"
    assert result.written is False


def test_run_reports_a_missing_binary_as_oserror():
    with pytest.raises(OSError):
        ssh.run(["/nonexistent/ssh", "--", "h"], b"", 2, {})


REQUEST = {"v": 1, "op": "status", "machine": "clvm"}
STATUS_OK = (
    '{"ok":true,"peer":"clvm","daemon":{"up":true,"pid":1,"code":"abc"},'
    '"remote":{"records":0,"lastRecordAt":null,"lastDeliver":null}}'
)


def exchange(body: str, deadline: float = 5, directory: Path | None = None) -> ssh.Outcome:
    directory = directory or short_dir()
    argv = [str(fake_ssh(directory, body)), "--", "host"]
    return ssh.exchange(argv, REQUEST, "status", deadline, {})


def test_exchange_ok_returns_the_parsed_reply_and_sent_the_request_line():
    directory = short_dir()
    outcome = exchange(
        "line = sys.stdin.buffer.readline()\n"
        "assert json.loads(line) == {'v': 1, 'op': 'status', 'machine': 'clvm'}, line\n"
        f"print({STATUS_OK!r})",
        directory=directory,
    )
    assert outcome.kind == "ok" and outcome.reply is not None and outcome.reply["peer"] == "clvm"
    assert len(ssh_calls(directory)) == 1


def test_exchange_remote_refusal_is_a_transport_success():
    outcome = exchange('print(\'{"ok":false,"code":"NO_DAEMON","detail":"down"}\')')
    assert outcome.kind == "ok" and outcome.reply == {
        "ok": False,
        "code": "NO_DAEMON",
        "detail": "down",
    }


@pytest.mark.parametrize(
    ("body", "kind"),
    [
        (
            "sys.stderr.write('ssh: connect to host x port 22: Connection refused'); sys.exit(255)",
            "unreachable",
        ),
        ("sys.stderr.write('Permission denied (publickey).'); sys.exit(255)", "unreachable"),
        ("sys.stderr.write('Host key verification failed.'); sys.exit(255)", "unreachable"),
        ("sys.stderr.write('bash: tg-remote: command not found'); sys.exit(127)", "remote-failed"),
        ("sys.exit(1)", "remote-failed"),
        ("print('Welcome to Ubuntu')", "bad-reply"),
        ("pass", "bad-reply"),
        ("print('{\"ok\":true}')", "bad-reply"),
        (f"print({STATUS_OK!r}); print({STATUS_OK!r})", "bad-reply"),
        ("sys.stdout.write('{\"ok\":tr')", "bad-reply"),
        ("sys.stdout.write('x' * 200000)", "oversized"),
        ("import time; time.sleep(30)", "timeout"),
    ],
)
def test_exchange_classifies_every_failure(body, kind):
    start = time.monotonic()
    outcome = exchange(body, deadline=1)
    assert outcome.kind == kind, outcome
    assert outcome.reply is None
    assert time.monotonic() - start < 5


def test_failure_detail_is_one_clean_line_of_the_stderr_tail():
    outcome = exchange(
        "sys.stderr.write('line1\\n\\x1b[31mPermission denied\\x1b[0m\\n' + 'x' * 5000)\n"
        "sys.exit(255)"
    )
    assert outcome.kind == "unreachable"
    assert (
        "\n" not in outcome.detail and "\x1b" not in outcome.detail and len(outcome.detail) <= 300
    )


def test_a_reply_without_a_trailing_newline_is_still_accepted():
    outcome = exchange(f"sys.stdout.write({STATUS_OK!r})")
    assert outcome.kind == "ok"


def test_exchange_never_retries():
    directory = short_dir()
    exchange("sys.exit(255)", directory=directory)
    assert len(ssh_calls(directory)) == 1


def test_missing_ssh_binary_is_unreachable_with_a_reason():
    outcome = ssh.exchange(["/nonexistent/ssh", "--", "h"], REQUEST, "status", 2, {})
    assert outcome.kind == "unreachable" and "ssh" in outcome.detail


def test_written_is_true_once_the_request_reached_the_pipe():
    outcome = exchange("sys.stdin.read(); sys.exit(255)")
    assert outcome.written is True
