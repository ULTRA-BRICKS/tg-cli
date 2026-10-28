"""Client machine side of the remote ctl (spec §5): record, flush, hello, status, doctor.

The message is already out when `record` runs, so a failed record is never an error for the
sender: it is journaled, warned about on stderr, and the command exits 0. Every function returns a
`Result` (exit code + the one JSON object the CLI prints); warnings go to the `stderr` stream.
"""

import time
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Final, TextIO

from tgcli.config.env import load_env
from tgcli.remote import config as remote_config
from tgcli.remote import protocol, ssh
from tgcli.remote.config import RemoteConfig
from tgcli.remote.journal import Entry, Journal
from tgcli.remote.protocol import JsonObject, ProtocolError
from tgcli.remote.result import (
    EXIT_CONFIG,
    EXIT_DATA,
    EXIT_IO,
    EXIT_REFUSED,
    EXIT_UNREACHABLE,
    Result,
)
from tgcli.tg_ctl.lock import bot_id_from_token
from tgcli.version import VERSION

RECORD_BUDGET: Final = 8.0
FLUSH_BEFORE_SEND: Final = 5
FLUSH_BUDGET: Final = 120.0
# Server answers that mean "this entry can never succeed as sent", so replaying it forever is
# pointless: such an entry is archived (kept, with a warning), not retried.
_REJECTING_CODES: Final = frozenset({"BAD_REQUEST", "TOO_LARGE", "VERSION"})
_BUDGET_CAUSE: Final = "timeout: the time budget ran out"


class _Refusal(Exception):
    def __init__(self, result: Result) -> None:
        super().__init__(str(result.body.get("code")))
        self.result = result


def _require_client(config_dir: Path) -> RemoteConfig:
    settings = remote_config.resolve(config_dir)
    if settings.mode == "client":
        return settings
    if settings.mode == "invalid":
        body: JsonObject = {
            "ok": False,
            "code": "INVALID_CONFIG",
            "detail": "control config is invalid",
            "errors": list(settings.errors),
        }
    else:
        body = {
            "ok": False,
            "code": "NOT_CLIENT",
            "detail": "control.server is not set: this machine is not a ctl client",
        }
    raise _Refusal(Result(EXIT_CONFIG, body))


def _argv(settings: RemoteConfig, env: Mapping[str, str]) -> list[str]:
    assert settings.alias is not None and settings.machine is not None
    return ssh.client_argv(settings.alias, settings.machine, env)


def _cause(outcome: ssh.Outcome) -> str:
    if outcome.reply is not None:
        return f"{outcome.reply['code']}: {outcome.reply['detail']}"
    return f"{outcome.kind}: {outcome.detail}"


# --- record -------------------------------------------------------------------------------------


def _truncate_history(request: JsonObject) -> None:
    """Cap history.text at 256 KiB of UTF-8 on a character boundary and say so (`truncated`)."""
    history = request.get("history")
    text = history.get("text") if isinstance(history, dict) else None
    if not isinstance(history, dict) or not isinstance(text, str):
        return
    try:
        encoded = text.encode("utf-8")
    except UnicodeEncodeError:
        return  # a lone surrogate: validation below rejects the whole record
    if len(encoded) > protocol.MAX_HISTORY_TEXT_BYTES:
        cut = encoded[: protocol.MAX_HISTORY_TEXT_BYTES].decode("utf-8", "ignore")
        request["history"] = {**history, "text": cut, "truncated": True}


def build_request(body: JsonObject, machine: str) -> JsonObject:
    """The validated `record` request for `body`; v/op/machine are ours and must agree if given."""
    request: JsonObject = {"v": protocol.VERSION, "op": "record", "machine": machine}
    for key, value in body.items():
        if key in request and value != request[key]:
            raise ProtocolError("BAD_REQUEST", f"{key}: does not match this client")
        request[key] = value
    _truncate_history(request)
    line = protocol.encode_line(request, protocol.MAX_REQUEST_BYTES)
    return protocol.parse_request(line.rstrip(b"\n"), frozenset({"record"}))


@dataclass(frozen=True)
class _Flushed:
    sent: int
    stopped: str | None


def _verdict(outcome: ssh.Outcome) -> str:
    if outcome.kind == "ok" and outcome.reply is not None:
        if outcome.reply["ok"] is True:
            return "sent"
        if outcome.reply["code"] in _REJECTING_CODES:
            return "rejected"
    return "stop"


def _replay(entry: Entry) -> JsonObject | None:
    try:
        raw = protocol.encode_line(entry.record, protocol.MAX_REQUEST_BYTES)
        return protocol.parse_request(raw.rstrip(b"\n"), frozenset({"record"}))
    except ProtocolError:
        return None


def _flush(
    journal: Journal, argv: list[str], env: Mapping[str, str], end_at: float, limit: int | None
) -> _Flushed:
    """Replay journal entries oldest first; the first transport/server failure stops the run."""
    sent = 0
    for entry in journal.entries()[:limit]:
        remaining = end_at - time.monotonic()
        if remaining <= 0:
            return _Flushed(sent, "timeout: the time budget ran out")
        request = _replay(entry)
        if request is None:
            journal.archive(entry, "no longer a valid record")
            continue
        outcome = ssh.exchange(argv, request, "record", min(remaining, ssh.RECORD_DEADLINE), env)
        verdict = _verdict(outcome)
        if verdict == "stop":
            return _Flushed(sent, _cause(outcome))
        if verdict == "rejected":
            journal.archive(entry, f"rejected by the server ({_cause(outcome)})")
        else:
            journal.remove(entry)
            sent += 1
    return _Flushed(sent, None)


def _emit(journal: Journal, stderr: TextIO) -> None:
    for warning in journal.take_warnings():
        stderr.write(f"tg-remote: {warning}\n")


def _keep(
    journal: Journal, request: JsonObject, settings: RemoteConfig, cause: str, stderr: TextIO
) -> Result:
    try:
        added = journal.add(request)
    except OSError as error:
        stderr.write(
            f"tg-remote: ctl server {settings.server} did not take the record ({cause}) and the "
            f"journal could not be written ({error.strerror}); the route is NOT recorded\n"
        )
        return Result(EXIT_IO, {"status": "failed", "detail": f"journal write failed: {error}"})
    stderr.write(
        f"tg-remote: ctl server {settings.server} did not take the record ({cause}); kept in "
        f"{added.path}; `tg-remote client flush` replays it\n"
    )
    return Result(
        0,
        {
            "status": "journaled",
            "detail": cause,
            "journal": str(added.path),
            "server": settings.server,
        },
    )


def _send(
    argv: list[str], request: JsonObject, env: Mapping[str, str], end_at: float
) -> tuple[str | None, str]:
    """(`recorded`|`duplicate`, "") when the server took the record, else (None, cause)."""
    remaining = end_at - time.monotonic()
    if remaining <= 0:
        return None, _BUDGET_CAUSE
    outcome = ssh.exchange(argv, request, "record", remaining, env)
    if outcome.kind == "ok" and outcome.reply is not None and outcome.reply["ok"] is True:
        return ("recorded" if outcome.reply["applied"] is True else "duplicate"), ""
    return None, _cause(outcome)


def record(
    body: JsonObject,
    *,
    config_dir: Path,
    env: Mapping[str, str],
    stderr: TextIO,
    budget: float = RECORD_BUDGET,
) -> Result:
    """Flush up to 5 older entries, then send `body` within `budget` seconds; journal on failure."""
    end_at = time.monotonic() + budget
    try:
        settings = _require_client(config_dir)
    except _Refusal as refusal:
        return refusal.result
    assert settings.machine is not None
    try:
        request = build_request(body, settings.machine)
    except ProtocolError as error:
        stderr.write(f"tg-remote: record not sent, invalid input: {error.detail}\n")
        return Result(EXIT_DATA, {"status": "invalid", "detail": error.detail})
    journal = Journal(config_dir / "remote")
    argv = _argv(settings, env)
    flushed = _Flushed(0, None)
    if journal.depth():
        flushed = _flush(journal, argv, env, end_at, FLUSH_BEFORE_SEND)
    if flushed.stopped:
        taken, cause = None, flushed.stopped
    else:
        taken, cause = _send(argv, request, env, end_at)
    _emit(journal, stderr)
    if taken is not None:
        return Result(
            0,
            {"status": taken, "detail": "", "server": settings.server, "flushed": flushed.sent},
        )
    result = _keep(journal, request, settings, cause, stderr)
    _emit(journal, stderr)
    return Result(result.exit_code, {**result.body, "flushed": flushed.sent})


def flush(*, config_dir: Path, env: Mapping[str, str], stderr: TextIO) -> Result:
    """Replay the whole journal (oldest first); exit 69 when the server could not take it all."""
    try:
        settings = _require_client(config_dir)
    except _Refusal as refusal:
        return refusal.result
    journal = Journal(config_dir / "remote")
    result = _flush(journal, _argv(settings, env), env, time.monotonic() + FLUSH_BUDGET, limit=None)
    _emit(journal, stderr)
    remaining = journal.depth()
    body: JsonObject = {
        "status": "flushed" if result.stopped is None else "partial",
        "sent": result.sent,
        "remaining": remaining,
        "server": settings.server,
    }
    if result.stopped is not None:
        body["detail"] = result.stopped
        stderr.write(f"tg-remote: flush stopped: {result.stopped}\n")
    return Result(0 if result.stopped is None else EXIT_UNREACHABLE, body)


# --- hello / status / doctor ----------------------------------------------------------------


def _own_bot(config_dir: Path) -> str:
    return bot_id_from_token(load_env(config_dir).get("TG_BOT_TOKEN", ""))


def _roundtrip(
    settings: RemoteConfig,
    env: Mapping[str, str],
    request: JsonObject,
    op: str,
    deadline: float,
) -> tuple[int, JsonObject]:
    outcome = ssh.exchange(_argv(settings, env), request, op, deadline, env)
    base: JsonObject = {"server": settings.server, "machine": settings.machine}
    if outcome.kind != "ok" or outcome.reply is None:
        return EXIT_UNREACHABLE, {
            "ok": False,
            **base,
            "kind": outcome.kind,
            "detail": outcome.detail,
        }
    if outcome.reply["ok"] is not True:
        return EXIT_REFUSED, {
            "ok": False,
            **base,
            "code": outcome.reply["code"],
            "detail": outcome.reply["detail"],
        }
    return 0, {"ok": True, **base, "reply": outcome.reply}


def _hello_request(settings: RemoteConfig, bot: str) -> JsonObject:
    return {
        "v": protocol.VERSION,
        "op": "hello",
        "machine": settings.machine,
        "bot": bot,
        "client": VERSION[:64] or "unknown",
    }


def hello(
    *,
    config_dir: Path,
    env: Mapping[str, str],
    stderr: TextIO,
    deadline: float = ssh.HELLO_DEADLINE,
) -> Result:
    try:
        settings = _require_client(config_dir)
    except _Refusal as refusal:
        return refusal.result
    bot = _own_bot(config_dir)
    if not bot:
        return Result(
            EXIT_CONFIG,
            {
                "ok": False,
                "code": "NO_BOT",
                "detail": "this machine has no TG_BOT_TOKEN to say hello with",
            },
        )
    code, body = _roundtrip(settings, env, _hello_request(settings, bot), "hello", deadline)
    if code:
        stderr.write(f"tg-remote: hello to {settings.server} failed: {body.get('detail')}\n")
    return Result(code, body)


def status(*, config_dir: Path, env: Mapping[str, str], stderr: TextIO) -> Result:
    try:
        settings = _require_client(config_dir)
    except _Refusal as refusal:
        return refusal.result
    request: JsonObject = {"v": protocol.VERSION, "op": "status", "machine": settings.machine}
    code, body = _roundtrip(settings, env, request, "status", ssh.STATUS_DEADLINE)
    body["journal"] = Journal(config_dir / "remote").depth()
    if code:
        stderr.write(f"tg-remote: status from {settings.server} failed: {body.get('detail')}\n")
    return Result(code, body)


def _check(name: str, status_: str, detail: str) -> JsonObject:
    return {"name": name, "status": status_, "ok": status_ != "fail", "detail": detail}


def _transport_check(
    settings: RemoteConfig, config_dir: Path, env: Mapping[str, str]
) -> tuple[int, JsonObject]:
    bot = _own_bot(config_dir)
    if not bot:
        return EXIT_CONFIG, _check("transport", "fail", "no TG_BOT_TOKEN to say hello with")
    code, body = _roundtrip(
        settings, env, _hello_request(settings, bot), "hello", ssh.HELLO_DEADLINE
    )
    if code:
        why = body.get("detail")
        return code, _check("transport", "fail", f"{body.get('kind') or body.get('code')}: {why}")
    reply = body["reply"]
    assert isinstance(reply, dict)
    daemon = reply["daemon"]
    assert isinstance(daemon, dict)
    state = "daemon up" if daemon["up"] else "daemon DOWN"
    return 0, _check("transport", "ok", f"{settings.server} answered as {reply['peer']}; {state}")


def doctor(*, config_dir: Path, env: Mapping[str, str], network: bool = True) -> Result:
    """Config check, a hello round trip (unless `network` is off) and the journal depth."""
    try:
        settings = _require_client(config_dir)
    except _Refusal as refusal:
        body = refusal.result.body
        failure = _check("config", "fail", str(body["detail"]))
        return Result(refusal.result.exit_code, {**body, "checks": [failure]})
    checks = [_check("config", "ok", f"client of {settings.server} as {settings.machine}")]
    code = 0
    if network:
        code, transport = _transport_check(settings, config_dir, env)
    else:
        transport = _check("transport", "skipped", "--no-network")
    checks.append(transport)
    depth = Journal(config_dir / "remote").depth()
    checks.append(_check("journal", "ok", f"{depth} entries pending"))
    return Result(code, {"ok": code == 0, "checks": checks})
