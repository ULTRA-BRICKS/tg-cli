"""`tg-remote satellite serve`: hello and the at-most-once, ledgered deliver (spec §4.2, §8.6)."""

import copy
import io
import json
import shutil
import stat
import threading
import time
from pathlib import Path

import pytest
from remote_fakes import fake_sink, short_dir, sink_calls, write_config

from tgcli.remote import satellite

BOT = "8574086668"
HELLO = {"v": 1, "op": "hello", "machine": "clvm", "bot": BOT, "client": "1.73.1"}
DELIVER = {
    "v": 1,
    "op": "deliver",
    "machine": "clvm",
    "idem": "-1001234567890:555",
    "route": {"paneId": "%3", "cwd": "/home/u/p", "sessionKey": "omp:abc"},
    "text": "go ahead 😀 שלום",
    "replyTo": {"id": 123},
}
MARKER = "-1001234567890-555.json"
UNCERTAIN_REPLAY = {"ok": False, "duplicate": True, "outcome": "uncertain", "uncertain": True}
DELIVERED_REPLAY = {"ok": True, "duplicate": True, "outcome": "delivered"}


class Satellite:
    def __init__(self) -> None:
        self.dir = short_dir()
        write_config(self.dir, "  server: ssh://box\n  machine: clvm\n")
        self.use_sink('print(json.dumps({"ok": True, "sink": "tmux"}))')

    def use_sink(self, body: str) -> None:
        self.sink = fake_sink(self.dir, body)
        self.env = {"TG_CTL_CONFIG_DIR": str(self.dir), "TG_CTL_BIN": str(self.sink)}

    def call(self, request: bytes | dict[str, object], **kwargs) -> dict[str, object]:
        raw = request if isinstance(request, bytes) else json.dumps(request).encode()
        stdout = io.BytesIO()
        rc = satellite.serve(
            config_dir=self.dir,
            env=self.env,
            stdin=io.BytesIO(raw + b"\n"),
            stdout=stdout,
            stderr=io.StringIO(),
            **kwargs,
        )
        assert rc == 0
        lines = stdout.getvalue().split(b"\n")
        assert len(lines) == 2 and lines[1] == b""
        return json.loads(lines[0])

    @property
    def ledger(self) -> Path:
        return self.dir / "remote" / "delivered"

    def state(self) -> str:
        return json.loads((self.ledger / MARKER).read_text())["state"]


@pytest.fixture
def sat():
    made = Satellite()
    yield made
    shutil.rmtree(made.dir, ignore_errors=True)


def test_hello_has_the_same_shape_as_the_server_hello(sat):
    reply = sat.call(HELLO)
    assert reply["ok"] is True and reply["v"] == 1 and reply["peer"] == "clvm"
    assert reply["bot"] == BOT and isinstance(reply["version"], str)
    assert reply["daemon"] == {"up": False} and reply["caps"] == ["deliver"]
    assert sink_calls(sat.dir) == [] and not sat.ledger.exists()


def test_hello_with_another_bot_is_refused(sat):
    assert sat.call({**HELLO, "bot": "1"})["code"] == "BOT_MISMATCH"


@pytest.mark.parametrize("control", ["  enabled: true\n", "  remote_machines: clvm=u@h\n"])
def test_a_machine_that_is_not_a_client_refuses_everything(sat, control):
    write_config(sat.dir, control)
    assert sat.call(HELLO)["code"] == "NOT_CLIENT"
    assert sat.call(DELIVER)["code"] == "NOT_CLIENT"
    assert sink_calls(sat.dir) == [] and not sat.ledger.exists()


def test_invalid_config_is_an_internal_error_not_a_delivery(sat):
    write_config(sat.dir, "  server: ssh://h:22\n  machine: clvm\n")
    assert sat.call(DELIVER)["code"] == "INTERNAL"
    assert sink_calls(sat.dir) == []


@pytest.mark.parametrize("op", [HELLO, DELIVER])
def test_payload_machine_must_be_this_machine(sat, op):
    reply = sat.call({**op, "machine": "ubuntu"})
    assert reply["code"] == "MACHINE_MISMATCH"
    assert sink_calls(sat.dir) == [] and not sat.ledger.exists()


def test_record_and_status_are_not_satellite_ops(sat):
    assert sat.call({"v": 1, "op": "status", "machine": "clvm"})["code"] == "UNSUPPORTED"
    assert sat.call({**DELIVER, "op": "record"})["code"] == "UNSUPPORTED"


@pytest.mark.parametrize(
    "mutate",
    [
        lambda r: r.update(extra=1),
        lambda r: r["route"].update(extra=1),
        lambda r: r.update(idem="abc"),
        lambda r: r.update(idem="1:2:3"),
        lambda r: r.update(idem="../../etc:1"),
        lambda r: r.update(text="a\x00b"),
        lambda r: r.update(text=5),
        lambda r: r["replyTo"].update(id="1"),
        lambda r: r.pop("text"),
    ],
)
def test_invalid_deliver_is_rejected_before_any_claim(sat, mutate):
    request = copy.deepcopy(DELIVER)
    mutate(request)
    assert sat.call(request)["code"] == "BAD_REQUEST"
    assert sink_calls(sat.dir) == [] and not sat.ledger.exists()


def test_lone_surrogate_text_is_rejected_before_any_claim(sat):
    raw = json.dumps(DELIVER).replace('"go ahead', '"\\ud800 go ahead').encode()
    assert sat.call(raw)["code"] == "BAD_REQUEST"
    assert sink_calls(sat.dir) == [] and not sat.ledger.exists()


def test_deliver_runs_the_one_shot_sink_with_the_request_and_records_delivered(sat):
    assert sat.call(DELIVER) == {"ok": True, "sink": "tmux"}
    (call,) = sink_calls(sat.dir)
    assert call["argv"] == ["satellite-deliver"]
    # `tg-ctl satellite-deliver` reads the closed schema {idem, route, text, replyTo}: no wire envelope.
    assert call["req"] == {k: v for k, v in DELIVER.items() if k not in ("v", "op", "machine")}, (
        "text byte-exact"
    )
    assert sat.state() == "delivered"
    assert stat.S_IMODE(sat.ledger.stat().st_mode) == 0o700
    assert stat.S_IMODE((sat.ledger / MARKER).stat().st_mode) == 0o600
    assert [p.name for p in sat.ledger.iterdir()] == [MARKER], "no tmp files left behind"


def test_lost_ack_replay_reports_the_original_delivered_outcome_without_typing(sat):
    sat.call(DELIVER)  # the reply never reached the hub
    assert sat.call(DELIVER) == DELIVERED_REPLAY
    assert sat.call(DELIVER) == DELIVERED_REPLAY
    assert len(sink_calls(sat.dir)) == 1


def test_sink_that_proved_nothing_typed_is_a_definite_failure(sat):
    sat.use_sink('print(json.dumps({"ok": False, "error": "gone", "uncertain": False}))')
    assert sat.call(DELIVER) == {"ok": False, "error": "gone", "uncertain": False}
    assert sat.state() == "failed"
    replay = sat.call(DELIVER)
    assert (
        replay["ok"] is False and replay["duplicate"] is True and replay["outcome"] != "delivered"
    )
    assert len(sink_calls(sat.dir)) == 1


def test_sink_that_may_have_typed_is_uncertain_and_replays_uncertain(sat):
    sat.use_sink('print(json.dumps({"ok": False, "error": "unsubmitted", "uncertain": True}))')
    assert sat.call(DELIVER) == {"ok": False, "error": "unsubmitted", "uncertain": True}
    assert sat.state() == "uncertain"
    assert sat.call(DELIVER) == UNCERTAIN_REPLAY
    assert len(sink_calls(sat.dir)) == 1


@pytest.mark.parametrize(
    "body",
    [
        "sys.exit(1)",
        "sys.stderr.write('boom'); sys.exit(2)",
        "print('not json')",
        "pass",
        'print(\'{"ok":true}{"ok":true}\')',
        "print('{\"ok\":false}')",
        'print(\'{"ok":false,"error":"x"}\')',
        'print(\'{"ok":"yes","sink":"tmux"}\')',
        "sys.stdout.write('x' * 200000)",
    ],
)
def test_any_unprovable_sink_outcome_is_uncertain(sat, body):
    sat.use_sink(body)
    reply = sat.call(DELIVER)
    assert reply["ok"] is False and reply["uncertain"] is True
    assert sat.state() == "uncertain"
    assert sat.call(DELIVER) == UNCERTAIN_REPLAY
    assert len(sink_calls(sat.dir)) == 1


def test_a_hung_sink_is_killed_at_the_deadline_and_is_uncertain(sat):
    sat.use_sink("time.sleep(60)")
    start = time.monotonic()
    reply = sat.call(DELIVER, sink_deadline=0.6)
    assert time.monotonic() - start < 4
    assert reply["ok"] is False and reply["uncertain"] is True and "timeout" in str(reply["error"])
    assert sat.state() == "uncertain"


@pytest.mark.parametrize("code", [126, 127])
def test_a_sink_that_could_not_start_proves_nothing_was_typed(sat, code):
    sat.use_sink(f"sys.exit({code})")
    reply = sat.call(DELIVER)
    assert reply == {"ok": False, "error": "no-sink", "uncertain": False}
    assert sat.state() == "failed"


def test_a_missing_sink_binary_proves_nothing_was_typed(sat):
    sat.env["TG_CTL_BIN"] = str(sat.dir / "does-not-exist")
    assert sat.call(DELIVER) == {"ok": False, "error": "no-sink", "uncertain": False}
    assert sat.state() == "failed"


def test_a_crash_between_claim_and_result_replays_as_uncertain_never_types(sat):
    # What a SIGKILL after the claim leaves on disk: the marker in state `claimed`.
    sat.ledger.mkdir(parents=True, mode=0o700)
    (sat.ledger / MARKER).write_text(json.dumps({"state": "claimed", "at": 1}))
    assert sat.call(DELIVER) == UNCERTAIN_REPLAY
    assert sink_calls(sat.dir) == []


@pytest.mark.parametrize("content", ["", "{not json", '{"state":"banana"}', "[]", '{"state":5}'])
def test_an_unreadable_marker_is_uncertain_never_a_second_typing(sat, content):
    sat.ledger.mkdir(parents=True, mode=0o700)
    (sat.ledger / MARKER).write_text(content)
    assert sat.call(DELIVER) == UNCERTAIN_REPLAY
    assert sink_calls(sat.dir) == []


def test_concurrent_deliveries_of_one_message_type_exactly_once(sat):
    sat.use_sink('time.sleep(0.4)\nprint(json.dumps({"ok": True, "sink": "tmux"}))')
    replies: list[dict[str, object]] = []

    def work() -> None:
        replies.append(sat.call(DELIVER))

    threads = [threading.Thread(target=work) for _ in range(5)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len(sink_calls(sat.dir)) == 1
    assert sum(1 for r in replies if r == {"ok": True, "sink": "tmux"}) == 1
    losers = [r for r in replies if r != {"ok": True, "sink": "tmux"}]
    assert all(r in (UNCERTAIN_REPLAY, DELIVERED_REPLAY) for r in losers)


def test_different_messages_have_separate_ledger_entries(sat):
    sat.call(DELIVER)
    sat.call({**DELIVER, "idem": "-1001234567890:556"})
    assert sorted(p.name for p in sat.ledger.iterdir()) == [
        "-1001234567890-555.json",
        "-1001234567890-556.json",
    ]
    assert len(sink_calls(sat.dir)) == 2


def test_the_hostile_text_goes_to_the_sink_stdin_only(sat):
    text = "$(touch PWNED) `touch PWNED` ; touch PWNED\n' \" && touch PWNED\r\n\\"
    reply = sat.call({**DELIVER, "text": text})
    assert reply["ok"] is True
    (call,) = sink_calls(sat.dir)
    assert call["argv"] == ["satellite-deliver"] and call["req"]["text"] == text
    assert not (sat.dir / "PWNED").exists()
    assert not Path("PWNED").exists()


def test_bun_is_found_even_when_the_ssh_session_path_is_bare(sat, monkeypatch):
    # sshd gives a non-login session a minimal PATH; ~/.bun/bin must still be reachable.
    home = sat.dir / "home"
    (home / ".bun" / "bin").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    seen = satellite.child_env({"PATH": "/usr/bin:/bin", "TG_CTL_BIN": "x"})
    assert str(home / ".bun" / "bin") in seen["PATH"].split(":")
    assert seen["PATH"].startswith("/usr/bin:/bin")
