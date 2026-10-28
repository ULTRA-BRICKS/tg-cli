"""Wire contract v1 (spec 2026-10-28-remote-ctl-server §4): closed schemas, caps, regexes."""

import copy
import io
import json

import pytest

from tgcli.remote import protocol
from tgcli.remote.protocol import ProtocolError, parse_request, read_line_bounded

ROUTE = {
    "paneId": "%3",
    "cwd": "/home/ultra/proj",
    "agentPid": 1,
    "serverPid": 2,
    "panePid": 3,
    "sessionKey": "omp:abc",
    "parentPaneId": "%1",
}
RECORD = {
    "v": 1,
    "op": "record",
    "machine": "clvm",
    "chat": "-1001234567890",
    "ids": [{"id": 123, "threadId": None}, {"id": 124, "threadId": 7}],
    "route": ROUTE,
    "history": {
        "text": "hello",
        "targetAgent": "clvm/tg-cli",
        "groupToken": "g1",
        "truncated": False,
    },
    "name": {"primary": "tg-cli", "secondary": "refactor"},
    "ts": 1730100000000,
}
HELLO = {"v": 1, "op": "hello", "machine": "clvm", "bot": "8574086668", "client": "1.73.1"}
STATUS = {"v": 1, "op": "status", "machine": "clvm"}
DELIVER = {
    "v": 1,
    "op": "deliver",
    "machine": "clvm",
    "idem": "-1001234567890:555",
    "route": ROUTE,
    "text": "go ahead",
    "replyTo": {"id": 123},
}
SERVER_OPS = frozenset({"hello", "record", "status"})
SATELLITE_OPS = frozenset({"hello", "deliver"})


def line(obj: object) -> bytes:
    return json.dumps(obj, ensure_ascii=False).encode()


def code_of(raw: bytes, ops: frozenset[str] = SERVER_OPS) -> str:
    with pytest.raises(ProtocolError) as info:
        parse_request(raw, ops)
    return info.value.code


@pytest.mark.parametrize("payload", [HELLO, RECORD, STATUS])
def test_valid_server_requests_parse_unchanged(payload):
    assert parse_request(line(payload), SERVER_OPS) == payload


def test_valid_deliver_parses_on_satellite_only():
    assert parse_request(line(DELIVER), SATELLITE_OPS) == DELIVER
    assert code_of(line(DELIVER), SERVER_OPS) == "UNSUPPORTED"
    assert code_of(line(RECORD), SATELLITE_OPS) == "UNSUPPORTED"


def test_optional_fields_may_be_absent_and_null():
    record = copy.deepcopy(RECORD)
    record["route"] = {"paneId": None, "cwd": "/x"}
    record["ids"] = [{"id": 5}]
    record["name"] = {"primary": "x"}
    record["history"] = {"text": "t"}
    assert parse_request(line(record), SERVER_OPS)["route"] == {"paneId": None, "cwd": "/x"}


def test_unknown_fields_are_rejected_at_every_level():
    for mutate in (
        lambda r: r.update(extra=1),
        lambda r: r["route"].update(extra=1),
        lambda r: r["history"].update(extra=1),
        lambda r: r["name"].update(extra=1),
        lambda r: r["ids"][0].update(extra=1),
    ):
        record = copy.deepcopy(RECORD)
        mutate(record)
        assert code_of(line(record)) == "BAD_REQUEST"
    assert code_of(line({**STATUS, "peer": "ubuntu"})) == "BAD_REQUEST"


def test_version_mismatch_is_distinct_from_malformed():
    assert code_of(line({**STATUS, "v": 2})) == "VERSION"
    assert code_of(line({"op": "status", "machine": "clvm"})) == "BAD_REQUEST"
    assert code_of(line({**STATUS, "v": True})) == "BAD_REQUEST"
    assert code_of(line({**STATUS, "v": "1"})) == "BAD_REQUEST"


def test_unknown_op_is_unsupported():
    assert code_of(line({**STATUS, "op": "shutdown"})) == "UNSUPPORTED"
    assert code_of(line({**STATUS, "op": ["status"]})) == "BAD_REQUEST"


@pytest.mark.parametrize(
    "machine",
    [
        "",
        "Clvm",
        "1clvm",
        "-clvm",
        "cl_vm",
        "a" * 33,
        "clvm\n",
        "clvm ",
        "ubuntu/../x",
        "клвм",
        "clvm\x00",
    ],
)
def test_machine_regex_is_closed(machine):
    assert code_of(line({**STATUS, "machine": machine})) == "BAD_REQUEST"


def test_machine_regex_accepts_boundaries():
    assert parse_request(line({**STATUS, "machine": "a" * 32}), SERVER_OPS)
    assert parse_request(line({**STATUS, "machine": "a-1"}), SERVER_OPS)


@pytest.mark.parametrize(
    "chat", ["", "abc", "12 3", "1e5", "--5", "1" * 21, "123\n", "١٢٣", "0x10", 5, None]
)
def test_chat_is_a_decimal_string(chat):
    assert code_of(line({**RECORD, "chat": chat})) == "BAD_REQUEST"


@pytest.mark.parametrize("bad_id", ["1", 1.5, True, None, -1, 0, 2**53 + 1, 1e3])
def test_message_ids_are_positive_safe_integers(bad_id):
    assert code_of(line({**RECORD, "ids": [{"id": bad_id, "threadId": None}]})) == "BAD_REQUEST"


def test_ids_list_is_bounded_and_nonempty():
    assert code_of(line({**RECORD, "ids": []})) == "BAD_REQUEST"
    assert code_of(line({**RECORD, "ids": [{"id": i + 1} for i in range(101)]})) == "BAD_REQUEST"
    assert code_of(line({**RECORD, "ids": {"id": 1}})) == "BAD_REQUEST"


@pytest.mark.parametrize("bad_pid", ["1", 1.5, True, -3, 2**40])
def test_route_pids_are_bounded_integers(bad_pid):
    record = copy.deepcopy(RECORD)
    record["route"]["agentPid"] = bad_pid
    assert code_of(line(record)) == "BAD_REQUEST"


@pytest.mark.parametrize("bad_label", ["a\nb", "a\x1b[31m", "a\x7f", "a\u2028b", "a\u0085b"])
def test_names_and_route_strings_reject_control_characters(bad_label):
    record = copy.deepcopy(RECORD)
    record["name"]["primary"] = bad_label
    assert code_of(line(record)) == "BAD_REQUEST"
    record = copy.deepcopy(RECORD)
    record["route"]["cwd"] = bad_label
    assert code_of(line(record)) == "BAD_REQUEST"
    record = copy.deepcopy(RECORD)
    record["history"]["targetAgent"] = bad_label
    assert code_of(line(record)) == "BAD_REQUEST"


def test_nul_is_rejected_in_any_string_even_history_text_and_keys():
    record = copy.deepcopy(RECORD)
    record["history"]["text"] = "a\x00b"
    assert code_of(line(record)) == "BAD_REQUEST"
    assert code_of(b'{"v":1,"op":"status","machine":"clvm","a\\u0000":1}') == "BAD_REQUEST"


def test_lone_surrogate_escape_is_rejected():
    raw = json.dumps(RECORD).replace('"hello"', '"\\ud800"').encode()
    assert code_of(raw) == "BAD_REQUEST"
    # An astral character written as a valid surrogate pair is fine and decodes to one code point.
    ok = json.dumps(RECORD).replace('"hello"', '"\\ud83d\\ude00"').encode()
    assert parse_request(ok, SERVER_OPS)["history"]["text"] == "\U0001f600"


@pytest.mark.parametrize(
    "raw",
    [
        b"",
        b"not json",
        b"[]",
        b'"x"',
        b"null",
        b"123",
        b'{"v":1,"op":"status","machine":"clvm"} trailing',
        b'{"v":1,"op":"status","machine":"clvm","machine":"ubuntu"}',
        b'{"v":NaN,"op":"status","machine":"clvm"}',
        b"\xff\xfe{}",
        b"\xef\xbb\xbf" + line(STATUS),
        b'{"v":1,"op":"status","machine":"\xc3("}',
        b"[" * 100000,
    ],
)
def test_garbled_input_is_a_bad_request_never_a_crash(raw):
    assert code_of(raw) == "BAD_REQUEST"


def test_history_text_cap_is_256_kib_of_utf8_bytes():
    record = copy.deepcopy(RECORD)
    record["history"]["text"] = "я" * (protocol.MAX_HISTORY_TEXT_BYTES // 2)
    assert parse_request(line(record), SERVER_OPS)
    record["history"]["text"] += "я"
    assert code_of(line(record)) == "TOO_LARGE"


def test_unicode_round_trips_byte_exact():
    text = "😀 👨‍👩‍👧 שלום עולם \u202eRTL\u202c e\u0301 \u200b\ufeff\n\ttab"
    record = copy.deepcopy(RECORD)
    record["history"]["text"] = text
    encoded = protocol.encode_line(record, protocol.MAX_REQUEST_BYTES)
    assert "😀".encode() in encoded and b"\\u" not in encoded
    assert parse_request(encoded.rstrip(b"\n"), SERVER_OPS)["history"]["text"] == text


@pytest.mark.parametrize(
    ("value", "ok"),
    [
        ("ssh://tg-ctl-ubuntu", True),
        ("ssh://a", True),
        ("ssh://h.example-1_x", True),
        ("ssh://" + "a" * 63, True),
        ("ssh://" + "a" * 64, False),
        ("ssh://-oProxyCommand=x", False),
        ("ssh://u@h", False),
        ("ssh://h:22", False),
        ("ssh://h/x", False),
        ("ssh://h?x", False),
        ("SSH://h", False),
        ("ssh://", False),
        ("", False),
        ("tg-ctl-ubuntu", False),
        ("ssh://h\n", False),
        ("ssh://h h", False),
        ("ssh://_h", False),
        ("ssh://.h", False),
        ("ssh://hé", False),
        ("ssh://h;id", False),
    ],
)
def test_server_regex(value, ok):
    assert protocol.is_server(value) is ok


@pytest.mark.parametrize(
    ("value", "ok"),
    [
        ("ultra@65.21.40.51", True),
        ("host", True),
        ("a.b-c_d@h.example", True),
        ("-oProxyCommand=x", False),
        ("-u@h", False),
        ("u@", False),
        ("@h", False),
        ("u@h@h2", False),
        ("u@h:22", False),
        ("u h", False),
        ("u@h\n", False),
        ("u@h;id", False),
        ("[::1]", False),
        ("", False),
        ("-", False),
        ("a" * 200, True),
    ],
)
def test_target_regex(value, ok):
    assert protocol.is_target(value) is ok


def test_read_line_bounded_returns_one_line_without_terminator():
    assert read_line_bounded(io.BytesIO(b"abc\nrest"), 10) == b"abc"
    assert read_line_bounded(io.BytesIO(b"abc"), 10) == b"abc"
    assert read_line_bounded(io.BytesIO(b"abc\r\n"), 10) == b"abc"


def test_read_line_bounded_cap_is_exact():
    assert read_line_bounded(io.BytesIO(b"x" * 10 + b"\n"), 10) == b"x" * 10
    with pytest.raises(ProtocolError) as info:
        read_line_bounded(io.BytesIO(b"x" * 11 + b"\n"), 10)
    assert info.value.code == "TOO_LARGE"
    with pytest.raises(ProtocolError) as info:
        read_line_bounded(io.BytesIO(b"x" * 500), 10)
    assert info.value.code == "TOO_LARGE"


def test_read_line_bounded_never_reads_more_than_cap_plus_slack():
    class Counting(io.BytesIO):
        asked = 0

        def readline(self, size: int | None = -1, /) -> bytes:
            Counting.asked = size or 0
            return super().readline(size)

    with pytest.raises(ProtocolError):
        read_line_bounded(Counting(b"x" * 100000), 100)
    assert Counting.asked <= 102


def test_read_line_bounded_empty_input_is_bad_request():
    with pytest.raises(ProtocolError) as info:
        read_line_bounded(io.BytesIO(b""), 10)
    assert info.value.code == "BAD_REQUEST"


def test_encode_line_is_compact_utf8_with_newline_and_capped():
    assert protocol.encode_line({"ok": True, "t": "é"}, 100) == '{"ok":true,"t":"é"}\n'.encode()
    with pytest.raises(ProtocolError) as info:
        protocol.encode_line({"ok": True, "t": "x" * 200}, 100)
    assert info.value.code == "TOO_LARGE"


def test_error_reply_shape_and_detail_truncation():
    reply = protocol.error_reply("BAD_REQUEST", "x" * 5000)
    assert reply["ok"] is False and reply["code"] == "BAD_REQUEST"
    assert isinstance(reply["detail"], str) and len(reply["detail"]) <= 300
    with pytest.raises(ValueError):
        protocol.error_reply("MADE_UP", "x")


def test_parse_reply_accepts_spec_replies():
    hello = {
        "ok": True,
        "v": 1,
        "peer": "clvm",
        "bot": "8574086668",
        "version": "1.73.1",
        "daemon": {"up": True},
        "caps": ["record", "status"],
    }
    assert protocol.parse_reply(line(hello), "hello") == hello
    record = {"ok": True, "applied": False, "routes": 1, "history": 2}
    assert protocol.parse_reply(line(record), "record") == record
    status = {
        "ok": True,
        "peer": "clvm",
        "daemon": {"up": True, "pid": 5, "code": "abc"},
        "remote": {"records": 3, "lastRecordAt": None, "lastDeliver": None},
    }
    assert protocol.parse_reply(line(status), "status") == status
    err = {"ok": False, "code": "NO_DAEMON", "detail": "down"}
    assert protocol.parse_reply(line(err), "record") == err


@pytest.mark.parametrize(
    ("op", "reply"),
    [
        ("hello", {"ok": True}),
        (
            "hello",
            {
                "ok": True,
                "v": 1,
                "peer": "clvm",
                "bot": "1",
                "version": "x",
                "daemon": {"up": "yes"},
                "caps": [],
            },
        ),
        ("record", {"ok": True, "applied": "yes", "routes": 1, "history": 1}),
        ("record", {"ok": True}),
        ("record", {"ok": "true"}),
        ("record", {"ok": False, "code": "WHO_KNOWS", "detail": "x"}),
        ("record", {"ok": False, "code": "NO_DAEMON"}),
        ("status", {"ok": True, "peer": "clvm"}),
        ("record", []),
    ],
)
def test_parse_reply_rejects_malformed(op, reply):
    with pytest.raises(protocol.BadReply):
        protocol.parse_reply(line(reply), op)


def test_parse_reply_rejects_non_json_and_nul():
    for raw in (
        b"",
        b"Permission denied",
        b'{"ok":true,"applied":true,"routes":1,"history":1',
        b'{"ok":false,"code":"NO_DAEMON","detail":"a\\u0000"}',
    ):
        with pytest.raises(protocol.BadReply):
            protocol.parse_reply(raw, "record")


@pytest.mark.parametrize(
    "reply",
    [
        {"ok": True, "sink": "tmux"},
        {"ok": True, "duplicate": True, "outcome": "delivered"},
        {"ok": False, "error": "gone", "uncertain": False},
        {"ok": False, "error": "unsubmitted", "uncertain": True},
        {"ok": False, "duplicate": True, "outcome": "uncertain", "uncertain": True},
        {"ok": False, "code": "NOT_CLIENT", "detail": "x"},
    ],
)
def test_parse_reply_accepts_every_deliver_shape(reply):
    assert protocol.parse_reply(line(reply), "deliver") == reply


@pytest.mark.parametrize(
    "reply",
    [
        {"ok": True},
        {"ok": True, "duplicate": True, "outcome": "uncertain"},
        {"ok": True, "duplicate": True},
        {"ok": False, "error": "gone"},
        {"ok": False, "error": 5, "uncertain": False},
        {"ok": False, "duplicate": True, "outcome": "uncertain"},
        {"ok": False},
    ],
)
def test_parse_reply_rejects_deliver_shapes_that_could_hide_an_undelivered_message(reply):
    with pytest.raises(protocol.BadReply):
        protocol.parse_reply(line(reply), "deliver")


@pytest.mark.parametrize("code", [[], {}, 5, None, ["NO_DAEMON"], {"a": 1}, True])
def test_a_failure_code_of_any_non_string_type_is_a_bad_reply_not_a_crash(code):
    for op in ("record", "hello", "status", "deliver"):
        with pytest.raises(protocol.BadReply):
            protocol.parse_reply(line({"ok": False, "code": code, "detail": "x"}), op)
