"""Client side: record (flush, send within a budget, journal on failure), hello, status, doctor."""

import io
import json
import shutil
import threading
import time
from pathlib import Path

import pytest
from remote_fakes import env_for, fake_ssh, short_dir, ssh_calls, write_config

from tgcli.remote import client
from tgcli.remote.journal import Journal
from tgcli.remote.protocol import MAX_HISTORY_TEXT_BYTES

RECORD_OK = {"ok": True, "applied": True, "routes": 1, "history": 1}
HELLO_OK = {
    "ok": True,
    "v": 1,
    "peer": "clvm",
    "bot": "8574086668",
    "version": "1.73.1",
    "daemon": {"up": True},
    "caps": ["record", "status"],
}
STATUS_OK = {
    "ok": True,
    "peer": "clvm",
    "daemon": {"up": True, "pid": 9, "code": "abc"},
    "remote": {"records": 2, "lastRecordAt": 5, "lastDeliver": None},
}


def body_of(first_id: int = 123, text: str = "hello") -> dict[str, object]:
    return {
        "chat": "-1001",
        "ids": [{"id": first_id, "threadId": None}],
        "route": {"paneId": "%3", "cwd": "/home/u/p"},
        "history": {"text": text, "targetAgent": "clvm/tg-cli", "truncated": False},
        "name": {"primary": "tg-cli"},
        "ts": 1730100000000,
    }


class Env:
    """A client machine: config dir, a scripted fake ssh and its request log."""

    def __init__(self, reply_body: str) -> None:
        self.dir = short_dir()
        write_config(self.dir, "  server: ssh://box\n  machine: clvm\n")
        self.requests = self.dir / "requests.log"
        self.stderr = io.StringIO()
        self.set_ssh(reply_body)

    def set_ssh(self, reply_body: str) -> None:
        self.ssh = fake_ssh(
            self.dir,
            "line = sys.stdin.buffer.readline()\n"
            f"open({str(self.requests)!r}, 'ab').write(line)\n" + reply_body,
        )
        self.env = env_for(self.dir, TG_REMOTE_SSH=str(self.ssh))

    def sent(self) -> list[dict[str, object]]:
        if not self.requests.exists():
            return []
        return [json.loads(line) for line in self.requests.read_bytes().splitlines()]

    def journal(self) -> Journal:
        return Journal(self.dir / "remote")

    def record(self, body: dict[str, object] | None = None, **kwargs) -> client.Result:
        return client.record(
            body or body_of(), config_dir=self.dir, env=self.env, stderr=self.stderr, **kwargs
        )


@pytest.fixture
def box():
    made: list[Env] = []

    def make(reply_body: str = "print(json.dumps(RECORD_OK))") -> Env:
        env = Env(f"RECORD_OK = {RECORD_OK!r}\n" + reply_body)
        made.append(env)
        return env

    yield make
    for env in made:
        shutil.rmtree(env.dir, ignore_errors=True)


def test_record_success_sends_the_full_request_over_the_fixed_ssh_argv(box):
    env = box()
    result = env.record()
    assert result.exit_code == 0
    assert result.body["status"] == "recorded"
    assert env.sent() == [{"v": 1, "op": "record", "machine": "clvm", **body_of()}]
    argv = ssh_calls(env.dir)[0]
    assert argv[-6:] == ["--", "box", "tg-remote", "server", "--peer", "clvm"]
    assert "-T" in argv and "BatchMode=yes" in argv
    assert env.journal().depth() == 0 and env.stderr.getvalue() == ""
    assert not (env.dir / "remote" / "journal").exists()


HOSTILE = "$(touch PWNED) `touch PWNED` ; touch PWNED\n'; rm -rf / #\" && touch PWNED | cat\r\n\\"


def test_hostile_message_text_never_reaches_argv_or_a_shell(box):
    env = box()
    victim = Path(env.dir) / "PWNED"
    result = env.record(body_of(text=HOSTILE))
    assert result.body["status"] == "recorded"
    (argv,) = ssh_calls(env.dir)
    assert argv[-6:] == ["--", "box", "tg-remote", "server", "--peer", "clvm"]
    assert not any("touch" in part or "$(" in part or "`" in part for part in argv)
    raw = env.requests.read_bytes()
    assert raw.count(b"\n") == 1, "stdin is exactly one JSON line"
    assert json.loads(raw)["history"]["text"] == HOSTILE
    assert not victim.exists()


def test_record_duplicate_is_reported_not_journaled(box):
    env = box('RECORD_OK["applied"] = False\nprint(json.dumps(RECORD_OK))')
    result = env.record()
    assert (result.exit_code, result.body["status"]) == (0, "duplicate")
    assert env.journal().depth() == 0


def test_record_accepts_matching_v_op_machine_in_the_input(box):
    env = box()
    result = env.record({"v": 1, "op": "record", "machine": "clvm", **body_of()})
    assert result.body["status"] == "recorded"


@pytest.mark.parametrize(
    "extra", [{"machine": "ubuntu"}, {"op": "hello"}, {"v": 2}, {"bogus": 1}, {"chat": "x"}]
)
def test_record_input_that_does_not_fit_the_contract_is_invalid_and_never_sent(box, extra):
    env = box()
    result = env.record({**body_of(), **extra})
    assert (result.exit_code, result.body["status"]) == (65, "invalid")
    assert env.sent() == [] and env.journal().depth() == 0


@pytest.mark.parametrize(
    "garbage",
    [
        '{"ok":false,"code":[],"detail":"down"}',
        '{"ok":false,"code":{"a":1},"detail":"down"}',
        '{"ok":false,"code":5,"detail":"down"}',
        '{"ok":true,"applied":"yes","routes":1,"history":1}',
    ],
)
def test_a_malformed_server_reply_still_journals_the_record(box, garbage):
    env = box(f"print({garbage!r})")
    result = env.record()
    assert result.exit_code == 0 and result.body["status"] == "journaled"
    assert "bad-reply" in env.stderr.getvalue()
    assert env.journal().depth() == 1


@pytest.mark.parametrize(
    ("script", "cause"),
    [
        ("sys.stderr.write('Connection refused'); sys.exit(255)", "unreachable"),
        (
            "sys.stderr.write('Host key verification failed.'); sys.exit(255)",
            "Host key verification",
        ),
        ("sys.stderr.write('Permission denied (publickey).'); sys.exit(255)", "Permission denied"),
        ("sys.stderr.write('tg-remote: command not found'); sys.exit(127)", "remote-failed"),
        ("print('Welcome')", "bad-reply"),
        ("sys.stdout.write('x' * 200000)", "oversized"),
        (
            'print(\'{"ok":false,"code":"NO_DAEMON","detail":"hook socket unreachable"}\')',
            "NO_DAEMON",
        ),
        ('print(\'{"ok":false,"code":"BOT_MISMATCH","detail":"x"}\')', "BOT_MISMATCH"),
        ('print(\'{"ok":false,"code":"PEER_UNKNOWN","detail":"x"}\')', "PEER_UNKNOWN"),
    ],
)
def test_every_failure_is_journaled_warned_and_exits_zero(box, script, cause):
    env = box(script)
    result = env.record()
    assert result.exit_code == 0, "the message is out; a failed record must not fail the send"
    assert result.body["status"] == "journaled"
    journal_path = env.dir / "remote" / "journal" / "-1001_123.json"
    assert result.body["journal"] == str(journal_path) and journal_path.is_file()
    warning = env.stderr.getvalue()
    assert "ssh://box" in warning and cause in warning and str(journal_path) in warning
    assert "flush" in warning
    assert env.journal().entries()[0].record == {
        "v": 1,
        "op": "record",
        "machine": "clvm",
        **body_of(),
    }


def test_a_hung_ssh_is_killed_at_the_total_budget_and_journaled(box):
    env = box("import time; time.sleep(60)")
    start = time.monotonic()
    result = env.record(budget=1.0)
    assert time.monotonic() - start < 3
    assert result.body["status"] == "journaled" and "timeout" in env.stderr.getvalue()
    assert env.journal().depth() == 1


def test_record_flushes_at_most_five_older_entries_before_the_new_one(box):
    env = box()
    journal = env.journal()
    for index in range(7):
        journal.add({"v": 1, "op": "record", "machine": "clvm", **body_of(first_id=100 + index)})
    result = env.record(body_of(first_id=999))
    assert result.body["status"] == "recorded" and result.body["flushed"] == 5
    order = [r["ids"][0]["id"] for r in env.sent()]
    assert order == [100, 101, 102, 103, 104, 999]
    assert [e.record["ids"][0]["id"] for e in env.journal().entries()] == [105, 106]


def test_a_failing_flush_does_not_try_the_new_record_again(box):
    env = box("sys.exit(255)")
    journal = env.journal()
    journal.add({"v": 1, "op": "record", "machine": "clvm", **body_of(first_id=1)})
    result = env.record(body_of(first_id=2))
    assert result.body["status"] == "journaled"
    assert len(ssh_calls(env.dir)) == 1, "one ssh attempt, then straight to the journal"
    assert env.journal().depth() == 2


def test_flush_quarantines_an_entry_the_server_calls_malformed_and_continues(box):
    env = box(
        "req = json.loads(line)\n"
        "if req['ids'][0]['id'] == 1:\n"
        '    print(\'{"ok":false,"code":"BAD_REQUEST","detail":"bad"}\')\n'
        "else:\n"
        "    print(json.dumps(RECORD_OK))"
    )
    journal = env.journal()
    for first in (1, 2):
        journal.add({"v": 1, "op": "record", "machine": "clvm", **body_of(first_id=first)})
    result = env.record(body_of(first_id=3))
    assert result.body["status"] == "recorded"
    assert [r["ids"][0]["id"] for r in env.sent()] == [1, 2, 3]
    assert (env.dir / "remote" / "journal" / "archive" / "-1001_1.json").is_file()
    assert env.journal().depth() == 0
    assert "BAD_REQUEST" in env.stderr.getvalue()


def test_flush_command_replays_everything_and_reports_the_rest(box):
    env = box()
    journal = env.journal()
    for first in (1, 2, 3):
        journal.add({"v": 1, "op": "record", "machine": "clvm", **body_of(first_id=first)})
    result = client.flush(config_dir=env.dir, env=env.env, stderr=env.stderr)
    assert result.exit_code == 0
    assert (result.body["sent"], result.body["remaining"]) == (3, 0)
    assert env.journal().depth() == 0


def test_flush_stops_at_the_first_transport_failure_with_exit_69(box):
    env = box("sys.exit(255)")
    for first in (1, 2):
        env.journal().add({"v": 1, "op": "record", "machine": "clvm", **body_of(first_id=first)})
    result = client.flush(config_dir=env.dir, env=env.env, stderr=env.stderr)
    assert result.exit_code == 69
    assert (result.body["sent"], result.body["remaining"]) == (0, 2)
    assert len(ssh_calls(env.dir)) == 1


def test_flush_of_an_empty_journal_makes_no_ssh_call(box):
    env = box()
    result = client.flush(config_dir=env.dir, env=env.env, stderr=env.stderr)
    assert (result.exit_code, result.body["sent"], result.body["remaining"]) == (0, 0, 0)
    assert ssh_calls(env.dir) == []


def test_history_text_over_the_cap_is_cut_on_a_character_boundary(box):
    env = box()
    text = "😀" * (MAX_HISTORY_TEXT_BYTES // 4 + 10)
    result = env.record(body_of(text=text))
    assert result.body["status"] == "recorded"
    sent = env.sent()[0]["history"]
    assert sent["truncated"] is True
    assert len(sent["text"].encode()) <= MAX_HISTORY_TEXT_BYTES
    assert text.startswith(sent["text"]) and len(sent["text"]) == MAX_HISTORY_TEXT_BYTES // 4


def test_unicode_round_trips_byte_exact_to_ssh_and_journal(box):
    text = "😀 👨‍👩‍👧 שלום \u202eRTL\u202c e\u0301 \u200b line\nbreak"
    ok = box()
    ok.record(body_of(text=text))
    assert ok.sent()[0]["history"]["text"] == text
    down = box("sys.exit(255)")
    down.record(body_of(text=text))
    assert down.journal().entries()[0].record["history"]["text"] == text


def test_concurrent_records_journal_distinct_files(box):
    env = box("sys.exit(255)")
    results: list[client.Result] = []

    def work(first: int) -> None:
        results.append(
            client.record(
                body_of(first_id=first),
                config_dir=env.dir,
                env=env.env,
                stderr=io.StringIO(),
                budget=2.0,
            )
        )

    threads = [threading.Thread(target=work, args=(i + 1,)) for i in range(6)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert {r.body["status"] for r in results} == {"journaled"}
    assert env.journal().depth() == 6


@pytest.mark.parametrize(
    ("control", "code"),
    [
        ("  enabled: true\n", "NOT_CLIENT"),
        ("  remote_machines: clvm=u@h\n", "NOT_CLIENT"),
        ("  server: ssh://-oProxyCommand=x\n  machine: clvm\n", "INVALID_CONFIG"),
    ],
)
def test_client_commands_refuse_a_machine_that_is_not_a_client(box, control, code):
    env = box()
    write_config(env.dir, control)
    for call in (
        lambda: env.record(),
        lambda: client.hello(config_dir=env.dir, env=env.env, stderr=env.stderr),
        lambda: client.status(config_dir=env.dir, env=env.env, stderr=env.stderr),
        lambda: client.flush(config_dir=env.dir, env=env.env, stderr=env.stderr),
    ):
        result = call()
        assert result.exit_code == 78 and result.body["code"] == code
    assert ssh_calls(env.dir) == []


def test_hello_sends_the_client_bot_and_reports_the_server_reply(box):
    env = box(f"print(json.dumps({HELLO_OK!r}))")
    result = client.hello(config_dir=env.dir, env=env.env, stderr=env.stderr)
    assert result.exit_code == 0 and result.body["ok"] is True
    assert result.body["reply"] == HELLO_OK
    request = env.sent()[0]
    assert (
        request["op"] == "hello" and request["bot"] == "8574086668" and request["machine"] == "clvm"
    )
    assert isinstance(request["client"], str)


def test_hello_without_a_client_bot_token_is_a_config_error(box):
    env = box()
    (env.dir / ".env").unlink()
    result = client.hello(config_dir=env.dir, env=env.env, stderr=env.stderr)
    assert result.exit_code == 78 and result.body["code"] == "NO_BOT"


@pytest.mark.parametrize(
    ("script", "exit_code", "marker"),
    [
        ("sys.exit(255)", 69, "unreachable"),
        ("import time; time.sleep(60)", 69, "timeout"),
        ('print(\'{"ok":false,"code":"BOT_MISMATCH","detail":"x"}\')', 76, "BOT_MISMATCH"),
    ],
)
def test_hello_failures_have_distinct_exit_codes(box, script, exit_code, marker):
    env = box(script)
    result = client.hello(config_dir=env.dir, env=env.env, stderr=env.stderr, deadline=1.0)
    assert result.exit_code == exit_code and result.body["ok"] is False
    assert marker in json.dumps(result.body)


def test_status_reports_server_reply_and_journal_depth(box):
    env = box(f"print(json.dumps({STATUS_OK!r}))")
    env.journal().add({"v": 1, "op": "record", "machine": "clvm", **body_of()})
    result = client.status(config_dir=env.dir, env=env.env, stderr=env.stderr)
    assert result.exit_code == 0
    assert result.body["reply"] == STATUS_OK and result.body["journal"] == 1
    assert env.sent()[0] == {"v": 1, "op": "status", "machine": "clvm"}


def test_doctor_offline_checks_config_and_journal_without_ssh(box):
    env = box()
    env.journal().add({"v": 1, "op": "record", "machine": "clvm", **body_of()})
    result = client.doctor(config_dir=env.dir, env=env.env, network=False)
    checks = {c["name"]: c for c in result.body["checks"]}
    assert result.exit_code == 0 and result.body["ok"] is True
    assert checks["config"]["ok"] is True and "ssh://box" in checks["config"]["detail"]
    assert checks["transport"]["status"] == "skipped"
    assert checks["journal"]["detail"] == "1 entries pending"
    assert ssh_calls(env.dir) == []


def test_doctor_online_does_a_hello_round_trip(box):
    env = box(f"print(json.dumps({HELLO_OK!r}))")
    result = client.doctor(config_dir=env.dir, env=env.env, network=True)
    checks = {c["name"]: c for c in result.body["checks"]}
    assert result.exit_code == 0 and checks["transport"]["ok"] is True
    assert "daemon up" in checks["transport"]["detail"]
    assert len(ssh_calls(env.dir)) == 1


def test_doctor_online_failure_is_reported_with_the_cause(box):
    env = box("sys.stderr.write('Host key verification failed.'); sys.exit(255)")
    result = client.doctor(config_dir=env.dir, env=env.env, network=True)
    transport = {c["name"]: c for c in result.body["checks"]}["transport"]
    assert result.exit_code == 69 and result.body["ok"] is False and transport["ok"] is False
    assert "Host key verification failed" in transport["detail"]


def test_doctor_of_an_invalid_config_names_the_key(box):
    env = box()
    write_config(env.dir, "  server: ssh://h:22\n  machine: clvm\n")
    result = client.doctor(config_dir=env.dir, env=env.env, network=False)
    assert result.exit_code == 78 and result.body["ok"] is False
    assert "control.server" in json.dumps(result.body)


def test_the_journal_is_private_and_lives_under_the_config_dir(box):
    env = box("sys.exit(255)")
    env.record()
    path = Path(str(env.dir / "remote" / "journal" / "-1001_123.json"))
    assert oct(path.stat().st_mode & 0o777) == "0o600"
