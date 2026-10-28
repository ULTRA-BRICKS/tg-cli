"""`tg-remote hub hello|deliver`: the daemon host reaching a client machine (spec §4.2-4.3)."""

import io
import json
import shutil
import time
from pathlib import Path

import pytest
from remote_fakes import fake_ssh, short_dir, ssh_calls, write_config

from tgcli.remote import hub, ssh

BOT = "8574086668"
HELLO_REPLY = {
    "ok": True,
    "v": 1,
    "peer": "clvm",
    "bot": BOT,
    "version": "1.73.1",
    "daemon": {"up": False},
    "caps": ["deliver"],
}
DELIVER = {
    "idem": "-1001:555",
    "route": {"paneId": "%3", "sessionKey": "omp:abc"},
    "text": "go ahead",
    "replyTo": {"id": 123},
}
FULL = {"v": 1, "op": "deliver", "machine": "clvm", **DELIVER}
UNCERTAIN_REPLAY = {"ok": False, "duplicate": True, "outcome": "uncertain", "uncertain": True}


class Hub:
    """The daemon host: config naming clvm, and a scripted fake ssh for the satellite."""

    def __init__(self, deliver_body: str) -> None:
        self.dir = short_dir()
        write_config(self.dir, "  remote_machines: clvm=ultra@65.21.40.51\n")
        self.requests = self.dir / "requests.log"
        self.stderr = io.StringIO()
        self.set_ssh(deliver_body)

    def set_ssh(self, deliver_body: str, hello_body: str | None = None) -> None:
        hello = hello_body or f"print(json.dumps({HELLO_REPLY!r}))"
        self.ssh = fake_ssh(
            self.dir,
            "line = sys.stdin.buffer.readline()\n"
            f"open({str(self.requests)!r}, 'ab').write(line)\n"
            "req = json.loads(line)\n"
            "if req['op'] == 'hello':\n"
            + "".join(f"    {row}\n" for row in hello.splitlines())
            + "else:\n"
            + "".join(f"    {row}\n" for row in deliver_body.splitlines()),
        )
        self.env = {"TG_CTL_CONFIG_DIR": str(self.dir), "TG_REMOTE_SSH": str(self.ssh)}

    def sent(self) -> list[dict[str, object]]:
        if not self.requests.exists():
            return []
        return [json.loads(row) for row in self.requests.read_bytes().splitlines()]

    def deliver(self, body: dict[str, object] | None = None, machine: str = "clvm", **kwargs):
        return hub.deliver(
            machine,
            DELIVER if body is None else body,
            config_dir=self.dir,
            env=self.env,
            stderr=self.stderr,
            **kwargs,
        )


@pytest.fixture
def make_hub():
    made: list[Hub] = []

    def make(deliver_body: str = 'print(json.dumps({"ok": True, "sink": "tmux"}))') -> Hub:
        made.append(Hub(deliver_body))
        return made[-1]

    yield make
    for item in made:
        shutil.rmtree(item.dir, ignore_errors=True)


def test_hello_probes_the_satellite_with_the_hub_bot_over_the_pinned_ssh_argv(make_hub):
    item = make_hub()
    result = hub.hello("clvm", config_dir=item.dir, env=item.env, stderr=item.stderr)
    assert result.exit_code == 0
    assert result.body == {"ok": True, "machine": "clvm", "reply": HELLO_REPLY}
    (request,) = item.sent()
    assert request["op"] == "hello" and request["machine"] == "clvm" and request["bot"] == BOT
    argv = ssh_calls(item.dir)[0]
    assert argv[-5:] == ["--", "ultra@65.21.40.51", "tg-remote", "satellite", "serve"]
    assert "StrictHostKeyChecking=yes" in argv


@pytest.mark.parametrize(
    ("script", "code", "marker"),
    [
        ("sys.stderr.write('Connection refused'); sys.exit(255)", 69, "unreachable"),
        ("import time; time.sleep(60)", 69, "timeout"),
        ('print(\'{"ok":false,"code":"BOT_MISMATCH","detail":"x"}\')', 76, "BOT_MISMATCH"),
    ],
)
def test_hello_failures_use_the_client_exit_codes(make_hub, script, code, marker):
    item = make_hub()
    item.set_ssh("pass", hello_body=script)
    result = hub.hello("clvm", config_dir=item.dir, env=item.env, stderr=item.stderr, deadline=1.0)
    assert result.exit_code == code and result.body["ok"] is False
    assert marker in json.dumps(result.body)


def test_deliver_probes_with_hello_first_then_sends_the_request_once(make_hub):
    item = make_hub()
    result = item.deliver()
    assert (result.exit_code, result.body) == (0, {"ok": True, "sink": "tmux"})
    first, second = item.sent()
    assert first["op"] == "hello"
    assert second == FULL
    assert len(ssh_calls(item.dir)) == 2


def test_deliver_accepts_the_full_request_shape_too(make_hub):
    item = make_hub()
    assert item.deliver(FULL).body == {"ok": True, "sink": "tmux"}


@pytest.mark.parametrize(
    "body",
    [
        {**FULL, "machine": "ubuntu"},
        {**FULL, "op": "record"},
        {**FULL, "v": 2},
        {**DELIVER, "idem": "nope"},
        {**DELIVER, "extra": 1},
        {**DELIVER, "text": "a\x00b"},
    ],
)
def test_input_that_does_not_fit_the_contract_sends_nothing(make_hub, body):
    item = make_hub()
    result = item.deliver(body)
    assert result.exit_code == 65 and result.body["ok"] is False
    assert result.body["uncertain"] is False
    assert ssh_calls(item.dir) == []


def test_an_unknown_machine_is_refused_without_ssh(make_hub):
    item = make_hub()
    result = item.deliver(machine="lab")
    assert result.exit_code == 64 and result.body["uncertain"] is False
    assert ssh_calls(item.dir) == []


@pytest.mark.parametrize("control", ["  enabled: true\n", "  server: ssh://box\n  machine: clvm\n"])
def test_a_machine_that_is_not_the_daemon_host_refuses(make_hub, control):
    item = make_hub()
    write_config(item.dir, control)
    result = item.deliver()
    assert result.exit_code == 78 and result.body["uncertain"] is False
    assert ssh_calls(item.dir) == []


def test_invalid_config_refuses_with_the_diagnostics(make_hub):
    item = make_hub()
    write_config(item.dir, "  remote_machines: clvm=-oProxyCommand=x\n")
    result = item.deliver()
    assert result.exit_code == 78 and "control.remote_machines" in json.dumps(result.body)
    assert ssh_calls(item.dir) == []


@pytest.mark.parametrize(
    ("script", "marker"),
    [
        ("sys.stderr.write('Connection refused'); sys.exit(255)", "unreachable"),
        ("import time; time.sleep(60)", "timeout"),
        ('print(\'{"ok":false,"code":"BOT_MISMATCH","detail":"other bot"}\')', "BOT_MISMATCH"),
        ("print('banner')", "bad-reply"),
    ],
)
def test_a_failed_probe_means_nothing_was_sent_and_nothing_is_uncertain(make_hub, script, marker):
    item = make_hub()
    item.set_ssh('print(json.dumps({"ok": True, "sink": "tmux"}))', hello_body=script)
    result = item.deliver(probe_deadline=1.0)
    assert result.exit_code == 69
    assert result.body["ok"] is False and result.body["uncertain"] is False
    assert marker in json.dumps(result.body)
    assert [r["op"] for r in item.sent()] == ["hello"], "the reply text never left the daemon host"
    assert len(ssh_calls(item.dir)) == 1


@pytest.mark.parametrize(
    ("script", "marker"),
    [
        (
            "sys.stderr.write('client_loop: send disconnect: Broken pipe'); sys.exit(255)",
            "unreachable",
        ),
        ("import time; time.sleep(60)", "timeout"),
        ("print('garbage')", "bad-reply"),
        ("pass", "bad-reply"),
        ("sys.stdout.write('{\"ok\":tr')", "bad-reply"),
        ("sys.stdout.write('x' * 200000)", "oversized"),
        ("sys.stderr.write('tg-remote: command not found'); sys.exit(127)", "remote-failed"),
        ("print('{\"ok\":true}')", "bad-reply"),
        ('print(\'{"ok":true,"duplicate":true,"outcome":"uncertain"}\')', "bad-reply"),
    ],
)
def test_ssh_failure_after_the_request_was_written_is_uncertain_and_never_resent(
    make_hub, script, marker
):
    item = make_hub()
    item.set_ssh(script)
    result = item.deliver(deliver_deadline=1.0)
    assert result.exit_code == 75
    assert result.body["ok"] is False and result.body["uncertain"] is True
    assert marker in json.dumps(result.body)
    assert [r["op"] for r in item.sent()] == ["hello", "deliver"]
    assert len(ssh_calls(item.dir)) == 2, "exactly one probe and one deliver, no retry"


def test_a_hung_deliver_is_killed_at_the_deadline(make_hub):
    item = make_hub()
    item.set_ssh("import time; time.sleep(60)")
    start = time.monotonic()
    item.deliver(deliver_deadline=0.8)
    assert time.monotonic() - start < 4


@pytest.mark.parametrize(
    ("reply", "code", "expected"),
    [
        (
            {"ok": True, "duplicate": True, "outcome": "delivered"},
            0,
            {"ok": True, "duplicate": True, "outcome": "delivered"},
        ),
        (UNCERTAIN_REPLAY, 75, UNCERTAIN_REPLAY),
        (
            {"ok": False, "error": "gone", "uncertain": False},
            69,
            {"ok": False, "error": "gone", "uncertain": False},
        ),
        (
            {"ok": False, "error": "unsubmitted", "uncertain": True},
            75,
            {"ok": False, "error": "unsubmitted", "uncertain": True},
        ),
        (
            {"ok": False, "error": "no-sink", "uncertain": False},
            69,
            {"ok": False, "error": "no-sink", "uncertain": False},
        ),
    ],
)
def test_satellite_outcomes_are_relayed_with_their_exact_certainty(make_hub, reply, code, expected):
    item = make_hub(f"print(json.dumps({reply!r}))")
    result = item.deliver()
    assert (result.exit_code, result.body) == (code, expected)
    assert len(ssh_calls(item.dir)) == 2


@pytest.mark.parametrize(
    ("refusal", "uncertain"),
    [
        ("NOT_CLIENT", False),
        ("MACHINE_MISMATCH", False),
        ("BAD_REQUEST", False),
        ("UNSUPPORTED", False),
        ("INTERNAL", True),
    ],
)
def test_satellite_protocol_refusals_are_definite_except_internal(make_hub, refusal, uncertain):
    item = make_hub(f'print(\'{{"ok":false,"code":"{refusal}","detail":"x"}}\')')
    result = item.deliver()
    assert result.body["ok"] is False and result.body["uncertain"] is uncertain
    assert refusal in json.dumps(result.body)
    assert result.exit_code == (75 if uncertain else 69)


def test_hostile_text_is_stdin_only_and_the_argv_is_constant(make_hub):
    text = "$(touch PWNED) `touch PWNED` ; touch PWNED\n' \" && touch PWNED\r\n\\ 😀 שלום"
    item = make_hub()
    result = item.deliver({**DELIVER, "text": text})
    assert result.body["ok"] is True
    for argv in ssh_calls(item.dir):
        assert argv[-4:] == ["ultra@65.21.40.51", "tg-remote", "satellite", "serve"]
        assert not any("touch" in part for part in argv)
    raw = item.requests.read_bytes().splitlines()
    assert len(raw) == 2 and json.loads(raw[1])["text"] == text
    assert not (Path(item.dir) / "PWNED").exists()


def test_the_hub_without_a_bot_token_cannot_probe(make_hub):
    item = make_hub()
    (item.dir / ".env").unlink()
    result = item.deliver()
    assert result.exit_code == 78 and result.body["uncertain"] is False
    assert ssh_calls(item.dir) == []


def test_targets_come_only_from_config_and_ssh_is_never_given_an_option_target(make_hub):
    item = make_hub()
    assert ssh.hub_argv("ultra@65.21.40.51", {})[-4] == "ultra@65.21.40.51"
    write_config(item.dir, "  remote_machines: clvm=-oProxyCommand=touch\n")
    assert item.deliver().exit_code == 78
    assert ssh_calls(item.dir) == []
