"""The `tg-remote` launcher and the whole chain over a fake ssh, both directions."""

import io
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest
from remote_fakes import (
    LAUNCHER,
    FakeDaemon,
    fake_sink,
    fake_ssh,
    forced_command_ssh,
    reply_line,
    short_dir,
    sink_calls,
    ssh_calls,
    write_config,
)

from tgcli.remote import client, hub
from tgcli.remote.cli import main

BOT = "8574086668"
RECORD_BODY = {
    "chat": "-1001",
    "ids": [{"id": 123, "threadId": None}],
    "route": {"paneId": "%3", "cwd": "/home/u/p", "agentPid": 1},
    "history": {"text": "hi 😀 שלום \u202eRTL\u202c e\u0301", "targetAgent": "clvm/tg-cli"},
    "name": {"primary": "tg-cli"},
    "ts": 1730100000000,
}


def run_launcher(
    args: list[str], stdin: bytes = b"", env: dict[str, str] | None = None, cwd: str = "/"
) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        [sys.executable, "-I", str(LAUNCHER), *args],
        input=stdin,
        capture_output=True,
        env=env if env is not None else {},
        cwd=cwd,
        timeout=60,
        check=False,
    )


@pytest.fixture
def dirs():
    made: list[Path] = []

    def make() -> Path:
        made.append(short_dir())
        return made[-1]

    yield make
    for directory in made:
        shutil.rmtree(directory, ignore_errors=True)


# --- launcher ----------------------------------------------------------------------------------


def test_launcher_is_executable_and_help_works_without_a_venv_or_env(dirs):
    assert os.access(LAUNCHER, os.X_OK)
    result = run_launcher(["--help"], cwd=str(dirs()))
    assert result.returncode == 0 and b"usage: tg-remote" in result.stdout


def test_launcher_runs_directly_through_its_isolating_shebang(dirs):
    result = subprocess.run(
        [str(LAUNCHER), "--help"],
        capture_output=True,
        env={"PATH": os.environ["PATH"]},
        cwd=str(dirs()),
    )
    assert result.returncode == 0 and b"usage: tg-remote" in result.stdout


@pytest.mark.parametrize("argv", [[], ["nope"], ["config"], ["config", "check", "--x"], ["client"]])
def test_usage_errors_exit_64_with_the_usage_on_stderr(argv, dirs):
    result = run_launcher(argv, cwd=str(dirs()))
    assert result.returncode == 64 and b"usage: tg-remote" in result.stderr
    assert result.stdout == b""


def test_planted_cwd_and_pythonpath_modules_never_execute(dirs):
    planted = dirs()
    marker = planted / "EXECUTED"
    body = f"open({str(marker)!r}, 'w').write('x')\n"
    for root in (planted, planted / "pp"):
        (root / "tgcli").mkdir(parents=True, exist_ok=True)
        (root / "tgcli" / "__init__.py").write_text(body)
        (root / "json.py").write_text(body)
        (root / "sitecustomize.py").write_text(body)
    config = dirs()
    env = {"PYTHONPATH": str(planted / "pp"), "TG_CTL_CONFIG_DIR": str(config), "HOME": str(config)}
    result = run_launcher(["config", "check", "--json"], env=env, cwd=str(planted))
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {"ok": True, "mode": "local"}
    assert not marker.exists()
    direct = subprocess.run(
        [str(LAUNCHER), "config", "check", "--json"], capture_output=True, env=env, cwd=str(planted)
    )
    assert direct.returncode == 0 and not marker.exists()


@pytest.mark.parametrize(
    ("control", "rc", "needle"),
    [
        ("  enabled: true\n", 0, b'"mode": "local"'),
        ("  server: ssh://box\n  machine: clvm\n", 0, b'"alias": "box"'),
        ("  remote_machines: clvm=u@h\n", 0, b'"remote_machines"'),
        ("  server: ssh://-oProxyCommand=x\n  machine: clvm\n", 78, b"server-format"),
        ("  server: ssh://h\n", 78, b"machine-required"),
        ("  server: ssh://h\n  machine: a\n  remote_machines: b=c\n", 78, b"role-conflict"),
    ],
)
def test_config_check_json_exit_codes_and_diagnostics(dirs, control, rc, needle):
    config = dirs()
    write_config(config, control)
    result = run_launcher(["config", "check", "--json"], env={"TG_CTL_CONFIG_DIR": str(config)})
    assert result.returncode == rc and needle in result.stdout
    assert result.stderr == b""


def test_config_check_text_mode_prints_diagnostics_to_stderr(dirs):
    config = dirs()
    write_config(config, "  server: ssh://h:22\n  machine: clvm\n")
    result = run_launcher(["config", "check"], env={"TG_CTL_CONFIG_DIR": str(config)})
    assert result.returncode == 78 and result.stdout == b""
    assert b"control.server" in result.stderr and b"server-format" in result.stderr
    write_config(config, "  server: ssh://box\n  machine: clvm\n")
    ok = run_launcher(["config", "check"], env={"TG_CTL_CONFIG_DIR": str(config)})
    assert ok.returncode == 0 and ok.stdout == b"ok: client of ssh://box as clvm\n"


def test_main_is_callable_in_process_with_injected_streams(dirs):
    config = dirs()
    out = io.BytesIO()
    rc = main(
        ["config", "check", "--json"],
        {"TG_CTL_CONFIG_DIR": str(config)},
        io.BytesIO(),
        out,
        io.StringIO(),
    )
    assert rc == 0 and json.loads(out.getvalue()) == {"ok": True, "mode": "local"}


# --- server endpoint as the forced command ------------------------------------------------------


def hub_dir(dirs, token: str | None = f"{BOT}:SECRET") -> Path:
    directory = dirs()
    write_config(directory, "  remote_machines: clvm=ultra@h\n", token)
    return directory


def test_server_is_independent_of_cwd_path_and_ssh_original_command(dirs):
    server_dir = hub_dir(dirs)
    victim = server_dir / "PWNED"
    env = {"TG_CTL_CONFIG_DIR": str(server_dir), "SSH_ORIGINAL_COMMAND": f"touch {victim}"}
    request = {"v": 1, "op": "hello", "machine": "clvm", "bot": BOT, "client": "1"}
    result = run_launcher(
        ["server", "--peer", "clvm"], json.dumps(request).encode() + b"\n", env, "/"
    )
    reply = json.loads(result.stdout)
    assert result.returncode == 0 and reply["ok"] is True and reply["daemon"] == {"up": False}
    assert not victim.exists()


@pytest.mark.parametrize(
    "argv", [["server"], ["server", "clvm"], ["server", "--peer"], ["server", "--peer", "a", "b"]]
)
def test_server_usage_errors_exit_64(argv, dirs):
    assert run_launcher(argv, cwd=str(dirs())).returncode == 64


def test_forced_command_endpoint_rejects_garbage_with_a_json_reply_and_exit_zero(dirs):
    server_dir = hub_dir(dirs)
    result = run_launcher(
        ["server", "--peer", "clvm"], b"{garbage\n", {"TG_CTL_CONFIG_DIR": str(server_dir)}
    )
    assert result.returncode == 0 and json.loads(result.stdout)["code"] == "BAD_REQUEST"


# --- client -> fake ssh -> server -> fake daemon -------------------------------------------


class Chain:
    """A client machine, the daemon host, a fake ssh between them and a fake daemon socket."""

    def __init__(self, dirs) -> None:
        self.client_dir = dirs()
        self.server_dir = hub_dir(dirs)
        write_config(self.client_dir, "  server: ssh://box\n  machine: clvm\n")
        self.ssh_dir = dirs()
        ssh = forced_command_ssh(
            self.ssh_dir, ["server", "--peer", "clvm"], {"TG_CTL_CONFIG_DIR": str(self.server_dir)}
        )
        self.env = {"TG_CTL_CONFIG_DIR": str(self.client_dir), "TG_REMOTE_SSH": str(ssh)}
        self.daemon: FakeDaemon | None = None
        self.applied: list[dict[str, object]] = []

    def daemon_up(self, applied: bool = True) -> None:
        def handle(request: dict[str, object]) -> bytes:
            if request["kind"] == "remote-status":
                return reply_line(
                    {
                        "ok": True,
                        "daemon": {"up": True, "pid": 7, "code": "abc"},
                        "remote": {
                            "records": len(self.applied),
                            "lastRecordAt": None,
                            "lastDeliver": None,
                        },
                    }
                )
            self.applied.append(request)
            return reply_line({"ok": True, "applied": applied, "routes": 1, "history": 1})

        self.daemon = FakeDaemon(self.server_dir / f"tg-ctl.{BOT}.sock", handle)

    def daemon_down(self) -> None:
        if self.daemon:
            self.daemon.close()
            self.daemon = None

    def record(self, body=None, **kwargs):
        return client.record(
            body or RECORD_BODY,
            config_dir=self.client_dir,
            env=self.env,
            stderr=io.StringIO(),
            **kwargs,
        )


@pytest.fixture
def chain(dirs):
    made = Chain(dirs)
    yield made
    made.daemon_down()


def test_record_reaches_the_daemon_byte_exact_and_is_reported_recorded(chain):
    chain.daemon_up()
    result = chain.record()
    assert result.exit_code == 0 and result.body["status"] == "recorded"
    (message,) = chain.applied
    assert message["kind"] == "remote-record" and message["peer"] == "clvm"
    record = message["record"]
    assert record["history"]["text"] == RECORD_BODY["history"]["text"]
    assert record["machine"] == "clvm" and record["chat"] == "-1001"
    assert not (chain.client_dir / "remote" / "journal").exists()


def test_a_duplicate_application_is_reported_duplicate(chain):
    chain.daemon_up(applied=False)
    assert chain.record().body["status"] == "duplicate"


def test_daemon_down_journals_then_flush_replays_the_same_record(chain):
    result = chain.record()
    assert result.exit_code == 0 and result.body["status"] == "journaled"
    assert "NO_DAEMON" in str(result.body["detail"])
    assert client.Journal(chain.client_dir / "remote").depth() == 1
    chain.daemon_up()
    flushed = client.flush(config_dir=chain.client_dir, env=chain.env, stderr=io.StringIO())
    assert flushed.exit_code == 0 and (flushed.body["sent"], flushed.body["remaining"]) == (1, 0)
    assert chain.applied[0]["record"]["history"]["text"] == RECORD_BODY["history"]["text"]


def test_a_second_record_flushes_the_first_in_one_go(chain):
    first = chain.record()
    assert first.body["status"] == "journaled"
    chain.daemon_up()
    second = chain.record({**RECORD_BODY, "ids": [{"id": 124, "threadId": None}]})
    assert second.body["status"] == "recorded" and second.body["flushed"] == 1
    assert [m["record"]["ids"][0]["id"] for m in chain.applied] == [123, 124]


def test_hello_and_status_round_trip_through_the_server(chain):
    chain.daemon_up()
    hello = client.hello(config_dir=chain.client_dir, env=chain.env, stderr=io.StringIO())
    assert hello.exit_code == 0 and hello.body["reply"]["daemon"] == {"up": True}
    assert hello.body["reply"]["peer"] == "clvm" and hello.body["reply"]["bot"] == BOT
    status = client.status(config_dir=chain.client_dir, env=chain.env, stderr=io.StringIO())
    assert status.exit_code == 0 and status.body["reply"]["peer"] == "clvm"


def test_hello_with_the_wrong_bot_is_refused_by_the_real_server(chain):
    (chain.client_dir / ".env").write_text("TG_BOT_TOKEN=999:other\n")
    hello = client.hello(config_dir=chain.client_dir, env=chain.env, stderr=io.StringIO())
    assert hello.exit_code == 76 and hello.body["code"] == "BOT_MISMATCH"


def test_doctor_end_to_end_with_the_daemon_down_reports_it(chain):
    result = client.doctor(config_dir=chain.client_dir, env=chain.env)
    checks = {c["name"]: c for c in result.body["checks"]}
    assert result.exit_code == 0 and "daemon DOWN" in checks["transport"]["detail"]


def test_cli_client_record_prints_one_json_line_and_exits_zero_even_when_journaled(chain):
    env = {**chain.env, "HOME": str(chain.client_dir)}
    result = run_launcher(
        ["client", "record"], json.dumps(RECORD_BODY, ensure_ascii=False).encode(), env, cwd="/"
    )
    assert result.returncode == 0
    body = json.loads(result.stdout)
    assert body["status"] == "journaled" and result.stdout.count(b"\n") == 1
    assert b"ssh://box" in result.stderr and b"flush" in result.stderr
    chain.daemon_up()
    flush = run_launcher(["client", "flush"], env=env)
    assert flush.returncode == 0 and json.loads(flush.stdout)["remaining"] == 0


@pytest.mark.parametrize("stdin", [b"", b"not json", b"[]", b'"x"'])
def test_cli_client_record_with_bad_stdin_exits_65_and_journals_nothing(chain, stdin):
    result = run_launcher(["client", "record"], stdin, chain.env)
    assert result.returncode == 65 and json.loads(result.stdout)["status"] == "invalid"
    assert ssh_calls(chain.ssh_dir) == []


def test_cli_doctor_text_and_json(chain):
    text = run_launcher(["doctor", "--no-network"], env=chain.env)
    assert text.returncode == 0 and b"config: client of ssh://box as clvm" in text.stdout
    assert b"skipped" in text.stdout
    document = run_launcher(["doctor", "--json", "--no-network"], env=chain.env)
    assert json.loads(document.stdout)["ok"] is True


def test_cli_exit_69_when_the_server_is_unreachable(chain):
    dead = fake_ssh(chain.ssh_dir, "sys.stderr.write('Connection refused'); sys.exit(255)")
    env = {**chain.env, "TG_REMOTE_SSH": str(dead)}
    result = run_launcher(["client", "hello"], env=env)
    assert result.returncode == 69 and json.loads(result.stdout)["kind"] == "unreachable"
    assert run_launcher(["doctor", "--json"], env=env).returncode == 69


# --- hub -> fake ssh -> satellite -> fake sink ---------------------------------------------


class Satellite:
    def __init__(self, dirs, sink_body: str) -> None:
        self.hub_dir = hub_dir(dirs)
        self.client_dir = dirs()
        write_config(self.client_dir, "  server: ssh://box\n  machine: clvm\n")
        self.work = dirs()
        self.sink = fake_sink(self.work, sink_body)
        self.ssh = forced_command_ssh(
            self.work,
            ["satellite", "serve"],
            {"TG_CTL_CONFIG_DIR": str(self.client_dir), "TG_CTL_BIN": str(self.sink)},
        )
        self.env = {"TG_CTL_CONFIG_DIR": str(self.hub_dir), "TG_REMOTE_SSH": str(self.ssh)}

    def deliver(self, **kwargs):
        body = {
            "idem": "-1001:555",
            "route": {"paneId": "%3", "sessionKey": "omp:abc"},
            "text": "go ahead 😀",
            "replyTo": {"id": 123},
        }
        return hub.deliver(
            "clvm", body, config_dir=self.hub_dir, env=self.env, stderr=io.StringIO(), **kwargs
        )


@pytest.fixture
def satellite_chain(dirs):
    return lambda sink_body='print(json.dumps({"ok": True, "sink": "tmux"}))': Satellite(
        dirs, sink_body
    )


def test_hub_hello_reaches_the_real_satellite(satellite_chain):
    chain = satellite_chain()
    result = hub.hello("clvm", config_dir=chain.hub_dir, env=chain.env, stderr=io.StringIO())
    assert result.exit_code == 0 and result.body["reply"]["caps"] == ["deliver"]


def test_delivery_types_once_and_a_replay_reports_the_original_outcome(satellite_chain):
    chain = satellite_chain()
    first = chain.deliver()
    assert (first.exit_code, first.body) == (0, {"ok": True, "sink": "tmux"})
    again = chain.deliver()
    assert (again.exit_code, again.body) == (
        0,
        {"ok": True, "duplicate": True, "outcome": "delivered"},
    )
    assert len(sink_calls(chain.work)) == 1
    assert sink_calls(chain.work)[0]["req"]["text"] == "go ahead 😀"


def test_lost_ack_then_replay_is_delivered_and_never_typed_twice(satellite_chain):
    chain = satellite_chain()
    # The satellite finishes and the ledger says delivered, but the reply never gets back.
    flag = chain.work / "dropped"
    dropper = fake_ssh(
        chain.work,
        "import subprocess\n"
        "line = sys.stdin.buffer.readline()\n"
        f"inner = [{str(chain.ssh)!r}, *sys.argv[1:]]\n"
        "out = subprocess.run(inner, input=line, capture_output=True)\n"
        f"if json.loads(line)['op'] == 'deliver' and not os.path.exists({str(flag)!r}):\n"
        f"    open({str(flag)!r}, 'w').close()\n"
        "    sys.exit(255)\n"
        "sys.stdout.buffer.write(out.stdout)\n",
        name="dropper-ssh",
    )
    chain.env["TG_REMOTE_SSH"] = str(dropper)
    first = chain.deliver()
    assert first.exit_code == 75 and first.body["uncertain"] is True
    assert len(sink_calls(chain.work)) == 1
    replay = chain.deliver()
    assert (replay.exit_code, replay.body) == (
        0,
        {"ok": True, "duplicate": True, "outcome": "delivered"},
    )
    assert len(sink_calls(chain.work)) == 1, "the replay never typed again"


def test_a_satellite_killed_between_claim_and_sink_result_replays_uncertain(satellite_chain):
    chain = satellite_chain("time.sleep(4)")
    first = chain.deliver(deliver_deadline=1.0)  # the hub kills ssh and the satellite with it
    assert first.exit_code == 75 and first.body["uncertain"] is True
    ledger = chain.client_dir / "remote" / "delivered" / "-1001-555.json"
    assert json.loads(ledger.read_text())["state"] == "claimed"
    chain.sink = fake_sink(chain.work, 'print(json.dumps({"ok": True, "sink": "tmux"}))')
    replay = chain.deliver()
    assert replay.exit_code == 75
    assert replay.body == {
        "ok": False,
        "duplicate": True,
        "outcome": "uncertain",
        "uncertain": True,
    }
    assert len(sink_calls(chain.work)) == 1, "the sink was never run a second time"


def test_a_satellite_that_is_hung_up_mid_delivery_kills_its_sink_and_stays_claimed(dirs):
    client_dir, work = dirs(), dirs()
    write_config(client_dir, "  server: ssh://box\n  machine: clvm\n")
    pid_file = work / "sink.pid"
    sink = fake_sink(work, f"open({str(pid_file)!r}, 'w').write(str(os.getpid()))\ntime.sleep(60)")
    env = {"TG_CTL_CONFIG_DIR": str(client_dir), "TG_CTL_BIN": str(sink)}
    request = {
        "v": 1,
        "op": "deliver",
        "machine": "clvm",
        "idem": "-1001:700",
        "route": {"paneId": "%3"},
        "text": "x",
        "replyTo": {"id": 1},
    }
    proc = subprocess.Popen(
        [sys.executable, "-I", str(LAUNCHER), "satellite", "serve"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        env=env,
    )
    assert proc.stdin is not None
    proc.stdin.write(json.dumps(request).encode() + b"\n")
    proc.stdin.flush()
    deadline = time.monotonic() + 10
    while not pid_file.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    time.sleep(0.2)
    sink_pid = int(pid_file.read_text())
    proc.send_signal(signal.SIGHUP)
    assert proc.wait(timeout=10) == 128 + signal.SIGHUP
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        try:
            os.kill(sink_pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.05)
    else:
        os.kill(sink_pid, signal.SIGKILL)
        pytest.fail("the sink survived the hang-up")
    ledger = client_dir / "remote" / "delivered" / "-1001-700.json"
    assert json.loads(ledger.read_text())["state"] == "claimed"
    proc.stdin.close()
    if proc.stdout:
        proc.stdout.close()


def test_cli_hub_deliver_reads_stdin_and_uses_exit_codes(satellite_chain):
    chain = satellite_chain()
    body = {
        "idem": "-1001:600",
        "route": {"paneId": "%3"},
        "text": "hello",
        "replyTo": {"id": 1},
    }
    env = {**chain.env, "HOME": str(chain.hub_dir)}
    ok = run_launcher(["hub", "deliver", "clvm"], json.dumps(body).encode(), env)
    assert ok.returncode == 0 and json.loads(ok.stdout) == {"ok": True, "sink": "tmux"}
    replay = run_launcher(["hub", "deliver", "clvm"], json.dumps(body).encode(), env)
    assert replay.returncode == 0 and json.loads(replay.stdout)["outcome"] == "delivered"
    bad = run_launcher(["hub", "deliver", "clvm"], b"nope", env)
    assert bad.returncode == 65 and json.loads(bad.stdout)["uncertain"] is False
    hello = run_launcher(["hub", "hello", "clvm"], env=env)
    assert hello.returncode == 0 and json.loads(hello.stdout)["ok"] is True
    assert run_launcher(["hub", "hello", "lab"], env=env).returncode == 64
