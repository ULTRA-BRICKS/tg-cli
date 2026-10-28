"""`control.server` / `control.machine` / `control.remote_machines`: the one validator (spec §3).

TypeScript reads the raw strings and asks `tg-remote config check --json`; it never judges them
itself. Raw parsing is the `tgcli.tg_ctl.config` twin; this module only applies the rules.
"""

from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from tgcli.common.fsio import read_text_lossy
from tgcli.common.js_string import js_trim
from tgcli.config import env as config_env
from tgcli.remote import protocol
from tgcli.tg_ctl.config import parse_control_config

MAX_REMOTE_MACHINES = 8
type Mode = Literal["local", "client", "hub", "invalid"]


@dataclass(frozen=True)
class RemoteConfig:
    mode: Mode
    server: str | None = None
    alias: str | None = None
    machine: str | None = None
    machines: Mapping[str, str] = field(default_factory=dict)
    errors: tuple[str, ...] = ()


def config_dir(env: Mapping[str, str]) -> Path:
    return config_env.config_dir(env, Path.home())


def _diag(key: str, rule: str, message: str) -> str:
    return f"control.{key}: {message} [rule: {rule}]"


def _server_errors(server: str) -> list[str]:
    if server == "":
        return [_diag("server", "server-empty", "must not be empty; remove the key to run local")]
    if not protocol.is_server(server):
        return [
            _diag(
                "server",
                "server-format",
                "must be ssh://<ssh_config alias or host> (letters, digits, . _ -; no user, "
                "port, path or leading -)",
            )
        ]
    return []


def _machine_errors(machine: str) -> list[str]:
    if machine == "":
        return [_diag("machine", "machine-empty", "must not be empty")]
    if not protocol.is_machine(machine):
        return [
            _diag(
                "machine",
                "machine-format",
                "must start with a lowercase letter, then lowercase letters, digits or -, "
                "at most 32 characters",
            )
        ]
    return []


def _parse_machines(value: str) -> tuple[dict[str, str], list[str]]:
    machines: dict[str, str] = {}
    errors: list[str] = []
    items = [js_trim(item) for item in value.split(",")]
    if len(items) > MAX_REMOTE_MACHINES:
        errors.append(
            _diag("remote_machines", "remote-machines-too-many", f"at most {MAX_REMOTE_MACHINES}")
        )
    for item in items:
        if not item:
            errors.append(_diag("remote_machines", "remote-machines-empty-item", "empty item"))
            continue
        name, equals, target = (js_trim(part) for part in item.partition("="))
        if not equals or not protocol.is_machine(name) or not protocol.is_target(target):
            errors.append(
                _diag(
                    "remote_machines",
                    "remote-machines-entry",
                    f"item {item[:40]!r} must be <name>=[user@]host with a lowercase name and "
                    "a target of letters, digits, . _ - not starting with -",
                )
            )
        elif name in machines:
            errors.append(
                _diag("remote_machines", "remote-machines-duplicate", f"name {name!r} twice")
            )
        else:
            machines[name] = target
    return machines, errors


def resolve_values(server: str | None, machine: str | None, remote: str | None) -> RemoteConfig:
    errors: list[str] = []
    if server is not None:
        errors += _server_errors(server)
    if machine is not None:
        errors += _machine_errors(machine)
    if server is not None and machine is None:
        errors.append(_diag("machine", "machine-required", "required when control.server is set"))
    if machine is not None and server is None:
        errors.append(_diag("server", "server-required", "required when control.machine is set"))
    machines: dict[str, str] = {}
    if remote is not None and remote != "":
        machines, machine_errors = _parse_machines(remote)
        errors += machine_errors
        if server is not None or machine is not None:
            errors.append(
                _diag(
                    "remote_machines",
                    "role-conflict",
                    "a machine is a ctl client (server/machine) or the daemon host "
                    "(remote_machines), not both",
                )
            )
    if errors:
        return RemoteConfig(mode="invalid", errors=tuple(errors))
    if server is not None and machine is not None:
        return RemoteConfig(
            mode="client", server=server, alias=protocol.server_alias(server), machine=machine
        )
    if machines:
        return RemoteConfig(mode="hub", machines=machines)
    return RemoteConfig(mode="local")


def resolve(directory: Path) -> RemoteConfig:
    try:
        text = read_text_lossy(directory / "config.yaml")
    except OSError:
        text = ""
    raw = parse_control_config(text)
    return resolve_values(raw.get("server"), raw.get("machine"), raw.get("remote_machines"))


def check(directory: Path) -> dict[str, object]:
    """The `config check --json` document (exit 78 for `ok: false`)."""
    result = resolve(directory)
    if result.mode == "invalid":
        return {"ok": False, "errors": list(result.errors)}
    if result.mode == "client":
        return {
            "ok": True,
            "mode": "client",
            "server": result.server,
            "alias": result.alias,
            "machine": result.machine,
        }
    if result.mode == "hub":
        return {
            "ok": True,
            "mode": "hub",
            "remote_machines": [
                {"name": name, "target": target} for name, target in result.machines.items()
            ],
        }
    return {"ok": True, "mode": "local"}
