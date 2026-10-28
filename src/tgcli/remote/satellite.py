"""`tg-remote satellite serve`: the daemon host's way into this client machine (spec §4.2).

`deliver` is at-most-once. Before anything is typed, a ledger file
`<remote dir>/delivered/<chat>-<msg>.json` is claimed (`claimed`, fsynced, exclusive). After the
one-shot sink (`tg-ctl satellite-deliver`) returns, the ledger is rewritten atomically to
`delivered`, `uncertain`, or `failed` (the sink proved nothing was typed). A replay never types
again and reports the ORIGINAL outcome; `ok:true` + `duplicate` therefore cannot hide an
undelivered message.
"""

import json
import os
import time
from collections.abc import Mapping
from pathlib import Path
from typing import BinaryIO, Final, TextIO

from tgcli.common.fsio import atomic_create, atomic_write
from tgcli.config.env import load_env
from tgcli.remote import config as remote_config
from tgcli.remote import protocol, ssh
from tgcli.remote.protocol import JsonObject, ProtocolError
from tgcli.tg_ctl.lock import bot_id_from_token
from tgcli.version import VERSION, repo_root

SATELLITE_OPS: Final = frozenset({"hello", "deliver"})
SINK_DEADLINE: Final = 12.0
_STATES: Final = frozenset({"claimed", "delivered", "uncertain", "failed"})
_NOT_STARTED: Final = frozenset({126, 127})
# `tg-ctl satellite-deliver` reads a closed schema; the wire envelope (v/op/machine) is already checked here.
_SINK_FIELDS: Final = ("idem", "route", "text", "replyTo")
_NO_SINK: Final[JsonObject] = {"ok": False, "error": "no-sink", "uncertain": False}
_UNCERTAIN_REPLAY: Final[JsonObject] = {
    "ok": False,
    "duplicate": True,
    "outcome": "uncertain",
    "uncertain": True,
}
# sshd gives a non-login session a minimal PATH, but `tg-ctl` runs under bun.
_EXTRA_PATHS: Final = (".bun/bin", ".local/bin")


def child_env(env: Mapping[str, str]) -> dict[str, str]:
    """The sink's environment: ours, with the usual per-user bin directories reachable."""
    out = dict(env)
    parts = [p for p in out.get("PATH", "").split(":") if p]
    for relative in _EXTRA_PATHS:
        candidate = Path.home() / relative
        if str(candidate) not in parts and candidate.is_dir():
            parts.append(str(candidate))
    out["PATH"] = ":".join(parts)
    return out


class Ledger:
    """One marker per (chat, message): claimed -> delivered | uncertain | failed."""

    def __init__(self, directory: Path, name: str) -> None:
        self._directory = directory
        self._path = directory / f"{name}.json"

    def claim(self) -> bool:
        """True when this call created the marker; False when one already exists."""
        self._directory.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self._directory.mkdir(mode=0o700, exist_ok=True)
        os.chmod(self._directory.parent, 0o700)
        os.chmod(self._directory, 0o700)
        return atomic_create(self._path, self._document("claimed"))

    @staticmethod
    def _document(state: str) -> str:
        return json.dumps({"state": state, "at": int(time.time() * 1000)})

    def state(self) -> str:
        """The stored state; anything unreadable counts as `uncertain`, never as delivered."""
        try:
            doc = json.loads(self._path.read_bytes().decode("utf-8"))
        except (OSError, ValueError):
            return "uncertain"
        state = doc.get("state") if isinstance(doc, dict) else None
        return state if isinstance(state, str) and state in _STATES else "uncertain"

    def finish(self, state: str) -> None:
        atomic_write(self._path, self._document(state))


def _replay(state: str) -> JsonObject:
    if state == "delivered":
        return {"ok": True, "duplicate": True, "outcome": "delivered"}
    if state == "failed":
        return {"ok": False, "duplicate": True, "outcome": "failed", "uncertain": False}
    return dict(_UNCERTAIN_REPLAY)


def _uncertain(why: str) -> JsonObject:
    return {"ok": False, "error": why, "uncertain": True}


def _interpret(stdout: bytes) -> tuple[JsonObject, str]:
    """Map the sink's one reply line to (reply for the hub, ledger state); doubt is uncertain."""
    line = stdout.removesuffix(b"\n")
    try:
        doc = protocol.load_json(line) if line and b"\n" not in line else None
    except ValueError:
        doc = None
    if isinstance(doc, dict) and doc.get("ok") is True and isinstance(doc.get("sink"), str):
        return {"ok": True, "sink": protocol.printable(str(doc["sink"]))[:32]}, "delivered"
    if (
        isinstance(doc, dict)
        and doc.get("ok") is False
        and isinstance(doc.get("error"), str)
        and isinstance(doc.get("uncertain"), bool)
    ):
        error = protocol.printable(str(doc["error"]))[:64]
        if doc["uncertain"]:
            return _uncertain(error), "uncertain"
        return {"ok": False, "error": error, "uncertain": False}, "failed"
    return _uncertain("bad-sink-reply"), "uncertain"


def _sink_binary(env: Mapping[str, str]) -> str:
    # TG_CTL_BIN exists for tests only; it is never read from config.
    return env.get("TG_CTL_BIN") or str(repo_root() / "tg-ctl")


def run_sink(
    request: JsonObject, env: Mapping[str, str], deadline: float
) -> tuple[JsonObject, str]:
    """Run `tg-ctl satellite-deliver` once (request JSON on stdin) and classify what happened."""
    argv = [_sink_binary(env), "satellite-deliver"]
    sink_request: JsonObject = {key: request[key] for key in _SINK_FIELDS if key in request}
    line = protocol.encode_line(sink_request, protocol.MAX_REQUEST_BYTES)
    try:
        result = ssh.run(argv, line, deadline, child_env(env))
    except OSError:
        return dict(_NO_SINK), "failed"
    if result.timed_out:
        return _uncertain("timeout: the sink was killed at its deadline"), "uncertain"
    if result.oversized:
        return _uncertain("oversized-sink-reply"), "uncertain"
    if result.returncode in _NOT_STARTED:
        return dict(_NO_SINK), "failed"
    if result.returncode != 0:
        return _uncertain(f"sink-exit-{result.returncode}"), "uncertain"
    return _interpret(result.stdout)


def _own_bot(config_dir: Path) -> str:
    bot = bot_id_from_token(load_env(config_dir).get("TG_BOT_TOKEN", ""))
    if not bot:
        raise ProtocolError("INTERNAL", "this machine has no TG_BOT_TOKEN to compare bots with")
    return bot


def _hello(request: JsonObject, machine: str, config_dir: Path) -> JsonObject:
    bot = _own_bot(config_dir)
    if request["bot"] != bot:
        raise ProtocolError("BOT_MISMATCH", "the daemon host talks to a different bot")
    return {
        "ok": True,
        "v": protocol.VERSION,
        "peer": machine,
        "bot": bot,
        "version": VERSION,
        "daemon": {"up": False},
        "caps": ["deliver"],
    }


def _deliver(
    request: JsonObject, env: Mapping[str, str], config_dir: Path, deadline: float
) -> JsonObject:
    chat, message = protocol.split_idem(str(request["idem"]))
    ledger = Ledger(config_dir / "remote" / "delivered", f"{chat}-{message}")
    if not ledger.claim():
        return _replay(ledger.state())
    try:
        reply, state = run_sink(request, env, deadline)
        ledger.finish(state)
    except Exception:
        # Whatever broke after the claim, the marker stays `claimed`: a replay reports uncertain.
        return _uncertain("ledger-or-sink-error")
    return reply


def _answer(
    stdin: BinaryIO, env: Mapping[str, str], config_dir: Path, deadline: float
) -> JsonObject:
    request = protocol.parse_request(
        protocol.read_line_bounded(stdin, protocol.MAX_REQUEST_BYTES), SATELLITE_OPS
    )
    settings = remote_config.resolve(config_dir)
    if settings.mode == "invalid":
        raise ProtocolError("INTERNAL", "control config is invalid; run tg-remote config check")
    if settings.mode != "client" or settings.machine is None:
        raise ProtocolError("NOT_CLIENT", "this machine is not a ctl client")
    if request["machine"] != settings.machine:
        raise ProtocolError("MACHINE_MISMATCH", "payload machine is not this machine")
    if request["op"] == "hello":
        return _hello(request, settings.machine, config_dir)
    return _deliver(request, env, config_dir, deadline)


def serve(
    *,
    config_dir: Path,
    env: Mapping[str, str],
    stdin: BinaryIO,
    stdout: BinaryIO,
    stderr: TextIO,
    sink_deadline: float = SINK_DEADLINE,
) -> int:
    """One request line in, one reply line out; exit 0 once a reply was written."""
    try:
        reply = _answer(stdin, env, config_dir, sink_deadline)
    except ProtocolError as error:
        reply = protocol.error_reply(error.code, error.detail)
    except Exception as error:  # the daemon host must still get a reply line
        stderr.write(f"tg-remote satellite: internal error: {type(error).__name__}\n")
        reply = protocol.error_reply("INTERNAL", "unexpected satellite error")
    try:
        line = protocol.encode_line(reply, protocol.MAX_REPLY_BYTES)
    except ProtocolError as error:
        line = protocol.encode_line(protocol.error_reply(error.code, error.detail), 4096)
    stdout.write(line)
    stdout.flush()
    return 0
