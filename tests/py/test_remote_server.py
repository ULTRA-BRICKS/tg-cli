"""The forced-command endpoint `tg-remote server --peer <name>` (spec §4.1, §7, §8.11)."""

import copy
import io
import json
import shutil
from pathlib import Path

import pytest
from remote_fakes import FakeDaemon, reply_line, short_dir, write_config

from tgcli.remote import server
from tgcli.remote.protocol import MAX_REPLY_BYTES

BOT = "8574086668"
HELLO = {"v": 1, "op": "hello", "machine": "clvm", "bot": BOT, "client": "1.73.1"}
STATUS = {"v": 1, "op": "status", "machine": "clvm"}
RECORD = {
    "v": 1,
    "op": "record",
    "machine": "clvm",
    "chat": "-1001",
    "ids": [{"id": 123, "threadId": None}],
    "route": {"paneId": "%3", "cwd": "/home/u/p", "agentPid": 1},
    "history": {"text": "hi 😀 שלום", "targetAgent": "clvm/tg-cli", "truncated": False},
    "name": {"primary": "tg-cli"},
    "ts": 1730100000000,
}
RECORD_OK = {"ok": True, "applied": True, "routes": 1, "history": 1}


@pytest.fixture
def cfg():
    directory = short_dir()
    write_config(directory, "  remote_machines: clvm=ultra@h, lab=lab.example\n")
    yield directory
    shutil.rmtree(directory, ignore_errors=True)


def call(cfg: Path, peer: str, request: bytes | dict[str, object], **kwargs) -> dict[str, object]:
    raw = (
        request if isinstance(request, bytes) else json.dumps(request, ensure_ascii=False).encode()
    )
    stdout = io.BytesIO()
    rc = server.serve(
        peer,
        config_dir=cfg,
        stdin=io.BytesIO(raw + b"\n"),
        stdout=stdout,
        stderr=io.StringIO(),
        **kwargs,
    )
    assert rc == 0, "an answered request always exits 0"
    lines = stdout.getvalue().split(b"\n")
    assert len(lines) == 2 and lines[1] == b"", "exactly one reply line"
    return json.loads(lines[0])


def daemon(cfg: Path, handler=lambda request: reply_line(RECORD_OK)) -> FakeDaemon:
    return FakeDaemon(cfg / f"tg-ctl.{BOT}.sock", handler)


def code(reply: dict[str, object]) -> object:
    assert reply["ok"] is False, reply
    return reply["code"]


def test_hello_reports_the_peer_bot_version_caps_and_daemon_state(cfg):
    down = call(cfg, "clvm", HELLO)
    assert down["ok"] is True and down["peer"] == "clvm" and down["bot"] == BOT
    assert down["daemon"] == {"up": False} and down["caps"] == ["record", "status"]
    assert down["v"] == 1 and isinstance(down["version"], str)
    live = daemon(cfg)
    try:
        assert call(cfg, "clvm", HELLO)["daemon"] == {"up": True}
        assert live.requests == [], "hello only probes the socket; it sends the daemon nothing"
    finally:
        live.close()


def test_hello_with_a_different_bot_is_refused(cfg):
    assert code(call(cfg, "clvm", {**HELLO, "bot": "999"})) == "BOT_MISMATCH"


def test_hello_without_a_server_bot_token_cannot_prove_the_bot(cfg):
    (cfg / ".env").unlink()
    assert code(call(cfg, "clvm", HELLO)) == "INTERNAL"


def test_record_is_relayed_to_the_daemon_with_the_authenticated_peer(cfg):
    live = daemon(cfg)
    try:
        reply = call(cfg, "clvm", RECORD)
        assert reply == RECORD_OK
        assert live.requests == [{"kind": "remote-record", "peer": "clvm", "record": RECORD}]
    finally:
        live.close()


def test_unicode_history_reaches_the_daemon_byte_exact(cfg):
    text = "😀 👨‍👩‍👧 שלום \u202eRTL\u202c e\u0301 \u200b"
    record = copy.deepcopy(RECORD)
    record["history"]["text"] = text
    live = daemon(cfg)
    try:
        call(cfg, "clvm", record)
        assert live.requests[0]["record"]["history"]["text"] == text
    finally:
        live.close()


def test_status_is_relayed_and_stamped_with_the_peer(cfg):
    status = {
        "ok": True,
        "peer": "someone-else",
        "daemon": {"up": True, "pid": 7, "code": "abc"},
        "remote": {"records": 3, "lastRecordAt": 5, "lastDeliver": None},
    }
    live = daemon(cfg, lambda request: reply_line(status))
    try:
        reply = call(cfg, "clvm", STATUS)
        assert live.requests == [{"kind": "remote-status", "peer": "clvm"}]
        assert reply["peer"] == "clvm" and reply["remote"] == status["remote"]
    finally:
        live.close()


@pytest.mark.parametrize("op", [RECORD, STATUS])
def test_no_daemon_is_reported_not_hidden(cfg, op):
    assert code(call(cfg, "clvm", op)) == "NO_DAEMON"


def test_daemon_refusal_is_passed_through_with_its_code(cfg):
    live = daemon(cfg, lambda r: reply_line({"ok": False, "code": "BAD_REQUEST", "detail": "nope"}))
    try:
        reply = call(cfg, "clvm", RECORD)
        assert reply == {"ok": False, "code": "BAD_REQUEST", "detail": "nope"}
    finally:
        live.close()


@pytest.mark.parametrize(
    "garbage",
    [
        b"not json\n",
        b'{"ok":true}\n',
        reply_line({"ok": False, "code": "MADE_UP", "detail": "x"}),
        b"x" * (MAX_REPLY_BYTES + 100) + b"\n",
        None,
    ],
)
def test_daemon_garbage_is_an_internal_error(cfg, garbage):
    live = daemon(cfg, lambda r: garbage)
    try:
        assert code(call(cfg, "clvm", RECORD)) == "INTERNAL"
    finally:
        live.close()


def test_a_hung_daemon_hits_the_timeout(cfg):
    import time

    live = daemon(cfg, lambda r: time.sleep(2) or reply_line(RECORD_OK))
    try:
        start = time.monotonic()
        assert code(call(cfg, "clvm", RECORD, daemon_timeout=0.4)) == "INTERNAL"
        assert time.monotonic() - start < 1.5
    finally:
        live.close()


def test_unknown_peer_is_refused_before_any_work(cfg):
    live = daemon(cfg)
    try:
        assert code(call(cfg, "ubuntu", RECORD)) == "PEER_UNKNOWN"
        assert code(call(cfg, "Clvm", RECORD)) == "PEER_UNKNOWN"
        assert code(call(cfg, "--peer", RECORD)) == "PEER_UNKNOWN"
        assert live.requests == []
    finally:
        live.close()


def test_without_remote_machines_every_peer_is_unknown(cfg):
    write_config(cfg, "  enabled: true\n")
    assert code(call(cfg, "clvm", HELLO)) == "PEER_UNKNOWN"


def test_invalid_config_refuses_everything_with_an_internal_error(cfg):
    write_config(cfg, "  remote_machines: clvm=-oProxyCommand=x\n")
    assert code(call(cfg, "clvm", HELLO)) == "INTERNAL"


@pytest.mark.parametrize("claimed", ["ubuntu", "lab", "clvm2"])
def test_payload_machine_must_equal_the_authenticated_peer(cfg, claimed):
    live = daemon(cfg)
    try:
        assert code(call(cfg, "clvm", {**RECORD, "machine": claimed})) == "PEER_MISMATCH"
        assert live.requests == []
    finally:
        live.close()


def test_ops_outside_the_server_set_are_unsupported(cfg):
    deliver = {
        "v": 1,
        "op": "deliver",
        "machine": "clvm",
        "idem": "1:2",
        "route": {},
        "text": "x",
        "replyTo": {"id": 1},
    }
    assert code(call(cfg, "clvm", deliver)) == "UNSUPPORTED"
    assert code(call(cfg, "clvm", {**STATUS, "op": "shell"})) == "UNSUPPORTED"


def test_unknown_fields_and_bad_versions_are_rejected(cfg):
    assert code(call(cfg, "clvm", {**STATUS, "peer": "ubuntu"})) == "BAD_REQUEST"
    assert code(call(cfg, "clvm", {**STATUS, "v": 2})) == "VERSION"


@pytest.mark.parametrize(
    "raw",
    [b"", b"garbage", b"[]", b'{"v":1,"op":"status","machine":"clvm\\u0000"}', b"\xff\xfe\n"],
)
def test_garbled_input_gets_a_bad_request(cfg, raw):
    assert code(call(cfg, "clvm", raw)) == "BAD_REQUEST"


def test_empty_stdin_gets_a_bad_request(cfg):
    stdout = io.BytesIO()
    rc = server.serve(
        "clvm", config_dir=cfg, stdin=io.BytesIO(b""), stdout=stdout, stderr=io.StringIO()
    )
    assert rc == 0 and json.loads(stdout.getvalue())["code"] == "BAD_REQUEST"


def test_oversized_request_is_refused_after_reading_at_most_cap_plus_slack(cfg):
    stdin = io.BytesIO(b"x" * (2 << 20))
    stdout = io.BytesIO()
    rc = server.serve("clvm", config_dir=cfg, stdin=stdin, stdout=stdout, stderr=io.StringIO())
    assert rc == 0 and json.loads(stdout.getvalue())["code"] == "TOO_LARGE"
    assert stdin.tell() <= (1 << 20) + 2


def test_history_text_over_256_kib_is_too_large(cfg):
    record = copy.deepcopy(RECORD)
    record["history"]["text"] = "x" * ((256 << 10) + 1)
    assert code(call(cfg, "clvm", record)) == "TOO_LARGE"


def test_lone_surrogate_in_a_name_is_rejected(cfg):
    raw = json.dumps(RECORD).replace('"tg-cli"}', '"\\ud800"}').encode()
    assert code(call(cfg, "clvm", raw)) == "BAD_REQUEST"


def test_the_reply_never_echoes_attacker_text_unbounded(cfg):
    reply = call(cfg, "clvm", {**STATUS, "extra" + "x" * 5000: 1})
    assert code(reply) == "BAD_REQUEST" and len(str(reply["detail"])) <= 300
