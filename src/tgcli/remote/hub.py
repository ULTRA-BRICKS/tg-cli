"""`tg-remote hub hello|deliver <machine>`: the daemon host reaching a client machine (spec §4.2).

The target comes only from `control.remote_machines`. `deliver` probes the satellite with a
`hello` first (a failed probe means nothing was sent), then sends the request exactly once: the
satellite's ledger makes a replay harmless, but this process never re-sends, so a request that
was handed to ssh and then lost is reported `uncertain`, never retried.
"""

from collections.abc import Mapping
from pathlib import Path
from typing import TextIO

from tgcli.config.env import load_env
from tgcli.remote import config as remote_config
from tgcli.remote import protocol, ssh
from tgcli.remote.protocol import JsonObject, ProtocolError
from tgcli.remote.result import (
    EXIT_CONFIG,
    EXIT_DATA,
    EXIT_REFUSED,
    EXIT_UNCERTAIN,
    EXIT_UNREACHABLE,
    EXIT_USAGE,
    Result,
)
from tgcli.tg_ctl.lock import bot_id_from_token
from tgcli.version import VERSION


class _Stop(Exception):
    def __init__(self, result: Result) -> None:
        super().__init__(str(result.body.get("error")))
        self.result = result


def _not_sent(exit_code: int, error: str, detail: str, **extra: object) -> Result:
    body: JsonObject = {"ok": False, "error": error, "uncertain": False, "detail": detail, **extra}
    return Result(exit_code, body)


def _target(machine: str, config_dir: Path) -> str:
    settings = remote_config.resolve(config_dir)
    if settings.mode == "invalid":
        raise _Stop(
            _not_sent(
                EXIT_CONFIG,
                "invalid-config",
                "control config is invalid",
                errors=list(settings.errors),
            )
        )
    if settings.mode != "hub":
        raise _Stop(
            _not_sent(EXIT_CONFIG, "not-hub", "control.remote_machines is not set on this machine")
        )
    if machine not in settings.machines:
        raise _Stop(_not_sent(EXIT_USAGE, "unknown-machine", "machine is not in remote_machines"))
    return settings.machines[machine]


def _hello_request(machine: str, config_dir: Path) -> JsonObject:
    bot = bot_id_from_token(load_env(config_dir).get("TG_BOT_TOKEN", ""))
    if not bot:
        raise _Stop(_not_sent(EXIT_CONFIG, "no-bot", "this machine has no TG_BOT_TOKEN"))
    return {
        "v": protocol.VERSION,
        "op": "hello",
        "machine": machine,
        "bot": bot,
        "client": VERSION[:64] or "unknown",
    }


def hello(
    machine: str,
    *,
    config_dir: Path,
    env: Mapping[str, str],
    stderr: TextIO,
    deadline: float = ssh.HELLO_DEADLINE,
) -> Result:
    try:
        argv = ssh.hub_argv(_target(machine, config_dir), env)
        request = _hello_request(machine, config_dir)
    except _Stop as stop:
        return stop.result
    outcome = ssh.exchange(argv, request, "hello", deadline, env)
    base: JsonObject = {"machine": machine}
    if outcome.kind != "ok" or outcome.reply is None:
        stderr.write(f"tg-remote: hello to {machine} failed: {outcome.kind}: {outcome.detail}\n")
        body: JsonObject = {"ok": False, **base, "kind": outcome.kind, "detail": outcome.detail}
        return Result(EXIT_UNREACHABLE, body)
    if outcome.reply["ok"] is not True:
        refusal: JsonObject = {
            "ok": False,
            **base,
            "code": outcome.reply["code"],
            "detail": outcome.reply["detail"],
        }
        return Result(EXIT_REFUSED, refusal)
    return Result(0, {"ok": True, **base, "reply": outcome.reply})


def build_request(body: JsonObject, machine: str) -> JsonObject:
    """The validated `deliver` request; v/op/machine are the hub's and must agree if given."""
    request: JsonObject = {"v": protocol.VERSION, "op": "deliver", "machine": machine}
    for key, value in body.items():
        if key in request and value != request[key]:
            raise ProtocolError("BAD_REQUEST", f"{key}: does not match this delivery")
        request[key] = value
    line = protocol.encode_line(request, protocol.MAX_REQUEST_BYTES)
    return protocol.parse_request(line.rstrip(b"\n"), frozenset({"deliver"}))


def _from_satellite(reply: JsonObject) -> Result:
    """Keep the satellite's own certainty; only INTERNAL (maybe after the claim) is doubt."""
    if reply["ok"] is True:
        return Result(0, reply)
    if "error" in reply or reply.get("duplicate") is True:
        uncertain = reply["uncertain"] is True
        return Result(EXIT_UNCERTAIN if uncertain else EXIT_UNREACHABLE, reply)
    uncertain = reply["code"] == "INTERNAL"
    body: JsonObject = {
        "ok": False,
        "error": reply["code"],
        "uncertain": uncertain,
        "detail": reply["detail"],
    }
    return Result(EXIT_UNCERTAIN if uncertain else EXIT_UNREACHABLE, body)


def deliver(
    machine: str,
    body: JsonObject,
    *,
    config_dir: Path,
    env: Mapping[str, str],
    stderr: TextIO,
    probe_deadline: float = ssh.HELLO_DEADLINE,
    deliver_deadline: float = ssh.DELIVER_DEADLINE,
) -> Result:
    try:
        request = build_request(body, machine)
    except ProtocolError as error:
        return _not_sent(EXIT_DATA, "invalid-request", error.detail)
    try:
        argv = ssh.hub_argv(_target(machine, config_dir), env)
        probe = _hello_request(machine, config_dir)
    except _Stop as stop:
        return stop.result
    probed = ssh.exchange(argv, probe, "hello", probe_deadline, env)
    if probed.kind != "ok" or probed.reply is None or probed.reply["ok"] is not True:
        cause = (
            f"{probed.kind}: {probed.detail}"
            if probed.reply is None
            else f"{probed.reply['code']}: {probed.reply['detail']}"
        )
        stderr.write(f"tg-remote: {machine} not reachable, reply NOT sent: {cause}\n")
        return _not_sent(EXIT_UNREACHABLE, "probe-failed", cause)
    outcome = ssh.exchange(argv, request, "deliver", deliver_deadline, env)
    if outcome.kind == "ok" and outcome.reply is not None:
        return _from_satellite(outcome.reply)
    # Handed to ssh and then no usable answer: it may have been typed. Never re-send.
    stderr.write(
        f"tg-remote: delivery to {machine} is uncertain: {outcome.kind}: {outcome.detail}\n"
    )
    return Result(
        EXIT_UNCERTAIN if outcome.written else EXIT_UNREACHABLE,
        {
            "ok": False,
            "error": outcome.kind,
            "uncertain": outcome.written,
            "detail": outcome.detail,
        },
    )
