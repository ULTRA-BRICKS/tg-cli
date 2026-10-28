"""Wire protocol v1: JSON lines, size caps, closed request schemas, reply validation.

One request line in, one reply line out (spec §4). Every string that later reaches a path, an
argv or a log line is validated here against a closed rule; unknown fields are rejected, never
ignored. Validators build only from the regexes the spec fixes.
"""

import json
import re
import unicodedata
from collections.abc import Callable, Mapping
from typing import BinaryIO, Final, NoReturn

type JsonObject = dict[str, object]
type Validator = Callable[[object, str], object]

VERSION: Final = 1
MAX_REQUEST_BYTES: Final = 1 << 20
MAX_REPLY_BYTES: Final = 64 << 10
MAX_HISTORY_TEXT_BYTES: Final = 256 << 10
MAX_IDS: Final = 100
MAX_DETAIL_CHARS: Final = 300
MAX_SAFE_INT: Final = 2**53

CODES: Final = frozenset(
    {
        "BAD_REQUEST",
        "TOO_LARGE",
        "VERSION",
        "PEER_MISMATCH",
        "PEER_UNKNOWN",
        "BOT_MISMATCH",
        "MACHINE_MISMATCH",
        "NOT_CLIENT",
        "NO_DAEMON",
        "UNSUPPORTED",
        "INTERNAL",
    }
)

# fullmatch() everywhere: `$` would accept a trailing newline.
_SERVER_RE: Final = re.compile(r"ssh://[A-Za-z0-9][A-Za-z0-9._-]{0,62}")
_MACHINE_RE: Final = re.compile(r"[a-z][a-z0-9-]{0,31}")
_TARGET_RE: Final = re.compile(r"([A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+")
CHAT_RE: Final = re.compile(r"-?[0-9]{1,19}")
_BOT_RE: Final = re.compile(r"[0-9]{1,20}")
_IDEM_RE: Final = re.compile(r"(-?[0-9]{1,19}):([0-9]{1,19})")
_SERVER_PREFIX: Final = "ssh://"


class ProtocolError(Exception):
    """A request that must be answered with `{"ok":false,"code":…}`."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


class BadReply(ValueError):
    """A peer answered, but not with a reply this contract allows."""


def is_server(value: object) -> bool:
    return isinstance(value, str) and _SERVER_RE.fullmatch(value) is not None


def server_alias(server: str) -> str:
    """The `ssh_config` alias or host name of a validated `control.server`."""
    return server.removeprefix(_SERVER_PREFIX)


def is_machine(value: object) -> bool:
    return isinstance(value, str) and _MACHINE_RE.fullmatch(value) is not None


def is_target(value: object) -> bool:
    return (
        isinstance(value, str)
        and not value.startswith("-")
        and _TARGET_RE.fullmatch(value) is not None
    )


def split_idem(idem: str) -> tuple[str, str]:
    """`<chat>:<message id>` of an already validated idempotency key."""
    match = _IDEM_RE.fullmatch(idem)
    if match is None:
        raise ProtocolError("BAD_REQUEST", "idem: not <chat>:<message id>")
    return match.group(1), match.group(2)


def _fail(where: str, why: str) -> NoReturn:
    raise ProtocolError("BAD_REQUEST", f"{where}: {why}")


# --- Bounded line I/O and strict JSON ---------------------------------------------------------


def read_line_bounded(stream: BinaryIO, cap: int) -> bytes:
    """One line without its terminator; reads at most cap + 2 bytes, whatever the peer sends."""
    data = stream.readline(cap + 2)
    if not data:
        raise ProtocolError("BAD_REQUEST", "empty request")
    body = data
    if data.endswith(b"\n"):
        body = data[:-1].removesuffix(b"\r")
    if len(body) > cap:
        raise ProtocolError("TOO_LARGE", f"line exceeds {cap} bytes")
    return body


def _no_constants(name: str) -> NoReturn:
    raise ValueError(f"constant {name} is not JSON")


def _no_duplicates(pairs: list[tuple[str, object]]) -> JsonObject:
    out: JsonObject = {}
    for key, value in pairs:
        if key in out:
            raise ValueError("duplicate key")
        out[key] = value
    return out


def _strings_are_clean(root: object) -> bool:
    """No NUL and no lone surrogate (which could not be written back as UTF-8) in any string."""
    stack = [root]
    while stack:
        item = stack.pop()
        if isinstance(item, str):
            if "\x00" in item:
                return False
            try:
                item.encode("utf-8")
            except UnicodeEncodeError:
                return False
        elif isinstance(item, dict):
            stack.extend(item.keys())
            stack.extend(item.values())
        elif isinstance(item, list):
            stack.extend(item)
    return True


def load_json(raw: bytes) -> object:
    """Strict JSON: UTF-8, one value, no NaN/duplicate keys, no NUL/lone surrogates."""
    try:
        doc = json.loads(
            raw.decode("utf-8"), parse_constant=_no_constants, object_pairs_hook=_no_duplicates
        )
    except (ValueError, RecursionError) as error:
        raise ValueError(f"not valid JSON ({type(error).__name__})") from error
    if not _strings_are_clean(doc):
        raise ValueError("string contains NUL or a lone surrogate")
    return doc


def encode_line(obj: Mapping[str, object], cap: int) -> bytes:
    """Compact UTF-8 JSON (`ensure_ascii=False`) plus newline; refuses anything over `cap` bytes."""
    try:
        body = json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
    except (UnicodeEncodeError, ValueError, TypeError) as error:
        raise ProtocolError("INTERNAL", "value is not encodable as JSON") from error
    if len(body) > cap:
        raise ProtocolError("TOO_LARGE", f"message exceeds {cap} bytes")
    return body + b"\n"


def _is_control(char: str) -> bool:
    return unicodedata.category(char) in {"Cc", "Zl", "Zp"}


def printable(text: str) -> str:
    return "".join(" " if _is_control(c) else c for c in text)


def error_reply(code: str, detail: str) -> JsonObject:
    if code not in CODES:
        raise ValueError(f"unknown error code {code!r}")
    clean = printable(detail).encode("utf-8", "replace").decode()[:MAX_DETAIL_CHARS]
    return {"ok": False, "code": code, "detail": clean}


# --- Field validators --------------------------------------------------------------------------


def _exact(expected: object) -> Validator:
    def check(value: object, where: str) -> object:
        if type(value) is not type(expected) or value != expected:
            _fail(where, f"must be {expected!r}")
        return value

    return check


def _integer(low: int, high: int) -> Validator:
    def check(value: object, where: str) -> object:
        if type(value) is not int or not low <= value <= high:
            _fail(where, f"must be an integer in {low}..{high}")
        return value

    return check


def _boolean(value: object, where: str) -> object:
    if type(value) is not bool:
        _fail(where, "must be a boolean")
    return value


def _pattern(rule: re.Pattern[str], what: str) -> Validator:
    def check(value: object, where: str) -> object:
        if not isinstance(value, str) or rule.fullmatch(value) is None:
            _fail(where, f"must be {what}")
        return value

    return check


def _label(limit: int) -> Validator:
    """A short single-line string: names, paths and keys never carry control characters."""

    def check(value: object, where: str) -> object:
        if not isinstance(value, str) or not 0 < len(value) <= limit:
            _fail(where, f"must be a string of 1..{limit} characters")
        if any(_is_control(char) for char in value):
            _fail(where, "must not contain control characters")
        return value

    return check


def _text(limit_bytes: int) -> Validator:
    """Free text (newlines and any Unicode allowed), capped in UTF-8 bytes."""

    def check(value: object, where: str) -> object:
        if not isinstance(value, str):
            _fail(where, "must be a string")
        # Characters never outnumber bytes, so the cheap length test spares encoding huge strings.
        if len(value) > limit_bytes or len(value.encode()) > limit_bytes:
            raise ProtocolError("TOO_LARGE", f"{where}: exceeds {limit_bytes} bytes")
        return value

    return check


def _nullable(inner: Validator) -> Validator:
    def check(value: object, where: str) -> object:
        return None if value is None else inner(value, where)

    return check


def _closed(
    value: object, where: str, required: Mapping[str, Validator], optional: Mapping[str, Validator]
) -> JsonObject:
    if not isinstance(value, dict):
        _fail(where, "must be an object")
    out: JsonObject = {}
    for key in value:
        if key not in required and key not in optional:
            _fail(where, f"unknown field {key[:40]!r}")
    for key, rule in {**required, **optional}.items():
        if key in value:
            out[key] = rule(value[key], f"{where}.{key}")
        elif key in required:
            _fail(where, f"missing field {key!r}")
    return out


def _object(
    required: Mapping[str, Validator], optional: Mapping[str, Validator] | None = None
) -> Validator:
    return lambda value, where: _closed(value, where, required, optional or {})


def _list_of(item: Validator, low: int, high: int) -> Validator:
    def check(value: object, where: str) -> object:
        if not isinstance(value, list) or not low <= len(value) <= high:
            _fail(where, f"must be a list of {low}..{high} items")
        return [item(entry, f"{where}[{index}]") for index, entry in enumerate(value)]

    return check


_MESSAGE_ID = _integer(1, MAX_SAFE_INT)
_PID = _nullable(_integer(0, 2**31))
_ROUTE = _object(
    {},
    {
        "paneId": _nullable(_label(64)),
        "cwd": _nullable(_label(4096)),
        "agentPid": _PID,
        "serverPid": _PID,
        "panePid": _PID,
        "sessionKey": _nullable(_label(512)),
        "parentPaneId": _nullable(_label(64)),
    },
)
_MACHINE = _pattern(_MACHINE_RE, "a lowercase machine name")
_HEAD: dict[str, Validator] = {"v": _exact(VERSION), "machine": _MACHINE}

_SCHEMAS: dict[str, tuple[dict[str, Validator], dict[str, Validator]]] = {
    "hello": (
        {"bot": _pattern(_BOT_RE, "a numeric bot id"), "client": _label(64)},
        {},
    ),
    "status": ({}, {}),
    "record": (
        {
            "chat": _pattern(CHAT_RE, "a decimal chat id string"),
            "ids": _list_of(
                _object({"id": _MESSAGE_ID}, {"threadId": _nullable(_integer(0, MAX_SAFE_INT))}),
                1,
                MAX_IDS,
            ),
            "route": _ROUTE,
            "history": _object(
                {"text": _text(MAX_HISTORY_TEXT_BYTES)},
                {"targetAgent": _label(256), "groupToken": _label(256), "truncated": _boolean},
            ),
            "name": _object({"primary": _label(256)}, {"secondary": _nullable(_label(256))}),
            "ts": _integer(0, MAX_SAFE_INT),
        },
        {},
    ),
    "deliver": (
        {
            "idem": _pattern(_IDEM_RE, "<chat>:<message id>"),
            "route": _ROUTE,
            "text": _text(MAX_HISTORY_TEXT_BYTES),
            "replyTo": _object({"id": _MESSAGE_ID}),
        },
        {},
    ),
}


def parse_request(raw: bytes, ops: frozenset[str]) -> JsonObject:
    """Validate a request line against its op's closed schema; `ops` is what the endpoint serves."""
    try:
        doc = load_json(raw)
    except ValueError as error:
        raise ProtocolError("BAD_REQUEST", str(error)) from error
    if not isinstance(doc, dict):
        _fail("request", "must be a JSON object")
    op = doc.get("op")
    version = doc.get("v")
    if not isinstance(op, str) or type(version) is not int:
        _fail("request", "needs a string op and an integer v")
    if version != VERSION:
        raise ProtocolError("VERSION", f"protocol version {VERSION} only")
    if op not in _SCHEMAS or op not in ops:
        raise ProtocolError("UNSUPPORTED", f"op {op[:40]!r} is not served here")
    required, optional = _SCHEMAS[op]
    return _closed(doc, "request", {**_HEAD, "op": _exact(op), **required}, optional)


# --- Replies -----------------------------------------------------------------------------------


def _plain_object(value: object, where: str) -> object:
    """The daemon owns the inner shape of the status `remote` block; we only need an object."""
    if not isinstance(value, dict):
        _fail(where, "must be an object")
    return value


def _daemon_block(value: object, where: str) -> object:
    """Replies may carry more daemon facts than we know; `up` is the one we rely on."""
    block = _plain_object(value, where)
    if not isinstance(block, dict) or type(block.get("up")) is not bool:
        _fail(where, "must be an object with a boolean up")
    return block


_OK_REPLIES: dict[str, dict[str, Validator]] = {
    "hello": {
        "v": _exact(VERSION),
        "peer": _MACHINE,
        "bot": _pattern(_BOT_RE, "a numeric bot id"),
        "version": _label(64),
        "daemon": _daemon_block,
        "caps": _list_of(_label(32), 0, 16),
    },
    "record": {
        "applied": _boolean,
        "routes": _integer(0, MAX_SAFE_INT),
        "history": _integer(0, MAX_SAFE_INT),
    },
    "status": {"peer": _MACHINE, "daemon": _daemon_block, "remote": _plain_object},
    # What the daemon answers the server's relay with; the server stamps `peer` itself.
    "daemon-status": {"daemon": _daemon_block, "remote": _plain_object},
    "deliver": {},
}


def _check_reply_fields(doc: JsonObject, rules: Mapping[str, Validator]) -> None:
    for key, rule in rules.items():
        if key not in doc:
            raise BadReply(f"reply lacks {key!r}")
        try:
            rule(doc[key], key)
        except ProtocolError as error:
            raise BadReply(error.detail) from error


def _check_deliver_failure(doc: JsonObject) -> None:
    """Sink failure (`error` + `uncertain`) or a ledger replay (`duplicate` + `outcome`)."""
    if "error" in doc:
        if not isinstance(doc["error"], str) or type(doc.get("uncertain")) is not bool:
            raise BadReply("deliver failure needs a string error and a boolean uncertain")
    elif doc.get("duplicate") is True:
        if not isinstance(doc.get("outcome"), str) or type(doc.get("uncertain")) is not bool:
            raise BadReply("a duplicate failure needs a string outcome and a boolean uncertain")
    else:
        _check_refusal(doc)


def _check_refusal(doc: JsonObject) -> None:
    code = doc.get("code")
    if not isinstance(code, str) or code not in CODES or not isinstance(doc.get("detail"), str):
        raise BadReply("failure reply needs a known code and a string detail")


def _check_deliver_ok(doc: JsonObject) -> None:
    """A typed delivery names its sink; a replay is ok only when the original was delivered."""
    if doc.get("duplicate") is True:
        if doc.get("outcome") != "delivered":
            raise BadReply("ok duplicate must report the original outcome delivered")
    elif not isinstance(doc.get("sink"), str):
        raise BadReply("ok deliver reply lacks its sink")


def _check_failure(doc: JsonObject, op: str) -> None:
    if op == "deliver":
        _check_deliver_failure(doc)
    else:
        _check_refusal(doc)


def parse_reply(raw: bytes, op: str) -> JsonObject:
    """Validate a peer's reply to `op`; anything off-contract is a `BadReply`."""
    try:
        doc = load_json(raw)
    except ValueError as error:
        raise BadReply(str(error)) from error
    if not isinstance(doc, dict) or type(doc.get("ok")) is not bool:
        raise BadReply("reply is not an object with a boolean ok")
    if doc["ok"]:
        _check_reply_fields(doc, _OK_REPLIES[op])
        if op == "deliver":
            _check_deliver_ok(doc)
    else:
        _check_failure(doc, op)
    return doc
