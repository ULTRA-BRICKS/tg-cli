"""The `laya:` block of config.yaml plus the TG_LAYA* environment, strictly validated.

Unlike the older readers this one never heals a bad value into a default: the caller turns a
`LayaConfigError` into exit 78. One-level scalars only, read line by line like the other
config blocks (the stdlib has no YAML parser).
"""

import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

Severity = Literal["error", "warning"]
Value = bool | int | str


@dataclass(frozen=True)
class Diagnostic:
    line: int  # 1-based line of config.yaml; 0 for an environment variable
    severity: Severity
    message: str


@dataclass(frozen=True)
class LayaDefaults:
    enabled: bool = True
    autostart: bool = True
    required: bool = False
    # 60 s is how long `task classify-server start` waits itself; the margin lets task's own
    # diagnostic arrive before we kill it. Measured cold start: 6.354 s (clvm, CPU).
    cold_timeout_sec: int = 75
    # Ceiling of the ask path. Measured first warm call on clvm (CPU): 1.395 s; Ubuntu: 31-64 ms.
    warm_timeout_ms: int = 3000


DEFAULTS = LayaDefaults()

# key -> value kind
SETTINGS: dict[str, str] = {
    "enabled": "bool",
    "autostart": "bool",
    "required": "bool",
    "cold_timeout_sec": "int",
    "warm_timeout_ms": "int",
    "task_bin": "path",
    "socket": "socket",
}

# The documented runtime boolean tokens (docs/configuration.md), case-insensitive; the TypeScript
# fallback in features/cli/laya-socket.ts mirrors this set, pinned by tests on both sides.
_TRUE = {"true", "1", "yes", "on"}
_FALSE = {"false", "0", "no", "off"}
_COMMENT = re.compile(r"\s+#.*$")


class LayaConfigError(Exception):
    """Config or environment the caller cannot honour; `diagnostics` are user-facing lines."""

    def __init__(self, diagnostics: list[str]) -> None:
        super().__init__("; ".join(diagnostics))
        self.diagnostics = diagnostics


@dataclass(frozen=True)
class LayaSettings:
    enabled: bool
    autostart: bool
    required: bool
    cold_timeout_sec: float
    warm_timeout_ms: float
    task_bin: str | None
    socket: str | None


def _socket_value(path: str, raw: str, inner: str) -> tuple[Value | None, str | None]:
    if "\x00" in inner:
        return None, f"{path} must not contain NUL (got {raw!r})"
    if ".." in inner.split("/"):
        return None, f"{path} must not contain .. (got {raw!r})"
    return inner, None


def _parse_value(key: str, kind: str, raw: str) -> tuple[Value | None, str | None]:
    path = f"laya.{key}"
    if kind == "bool":
        token = raw.lower()  # a quoted value keeps its quotes and so never matches
        if token in _TRUE or token in _FALSE:
            return token in _TRUE, None
        return None, f"{path} must be true or false (got {raw!r})"
    if kind == "int":
        if re.fullmatch(r"[0-9]+", raw) and int(raw) >= 1:
            return int(raw), None
        return None, f"{path} must be a positive integer (got {raw!r})"
    inner = raw[1:-1] if len(raw) >= 2 and raw[0] in "'\"" and raw[-1] == raw[0] else raw
    if not inner.startswith("/"):
        return None, f"{path} must be an absolute path (got {raw!r})"
    return (inner, None) if kind != "socket" else _socket_value(path, raw, inner)


@dataclass
class _Block:
    values: dict[str, Value]
    lines: dict[str, int]
    diagnostics: list[Diagnostic]


def _header(line: str, number: int, block: _Block) -> bool:
    """Handle a top-level line; True when it opens the `laya` block."""
    key, _, rest = line.strip().partition(":")
    if key != "laya":
        return False
    if rest.strip():
        block.diagnostics.append(
            Diagnostic(number, "error", "laya must be a block of indented key: value lines")
        )
        return False
    return True


def _entry(line: str, number: int, block: _Block) -> None:
    key, colon, raw = line.strip().partition(":")
    key, raw = key.strip(), raw.strip()
    path = f"laya.{key}"
    kind = SETTINGS.get(key)
    if not colon or kind is None:
        block.diagnostics.append(Diagnostic(number, "error", f"{path} is not a known setting"))
    elif key in block.lines:
        block.diagnostics.append(
            Diagnostic(number, "error", f"{path} is duplicated (first on line {block.lines[key]})")
        )
    elif not raw:
        block.diagnostics.append(Diagnostic(number, "error", f"{path} has an empty value"))
    else:
        block.lines[key] = number
        value, problem = _parse_value(key, kind, raw)
        if problem:
            block.diagnostics.append(Diagnostic(number, "error", problem))
        elif value is not None:
            block.values[key] = value


def _parse_block(text: str) -> _Block:
    block = _Block({}, {}, [])
    in_laya = False
    for number, raw_line in enumerate(text.split("\n"), start=1):
        line = _COMMENT.sub("", raw_line.rstrip("\r"))
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line[0] not in " \t":
            in_laya = _header(line, number, block)
        elif in_laya:
            _entry(line, number, block)
    return block


def _conflict(required_by: str, disabled_by: str) -> str:
    return (
        f"{required_by} conflicts with {disabled_by}: a required model cannot be switched off; "
        "set one of them differently"
    )


def check_config_text(text: str) -> list[Diagnostic]:
    """Everything wrong with the `laya:` block of this file alone (`tg config validate`)."""
    block = _parse_block(text)
    out = list(block.diagnostics)
    if block.values.get("required") is True and block.values.get("enabled") is False:
        out.append(
            Diagnostic(
                block.lines["required"],
                "error",
                _conflict("laya.required: true", "laya.enabled: false"),
            )
        )
    return sorted(out, key=lambda d: d.line)


def _env_bool(env: Mapping[str, str], name: str, problems: list[str]) -> bool | None:
    value = env.get(name, "").strip()
    if not value:
        return None
    token = value.lower()
    if token in _TRUE:
        return True
    if token in _FALSE:
        return False
    problems.append(f"{name} must be true/1/yes/on or false/0/no/off (got {value!r})")
    return None


def _env_number(env: Mapping[str, str], name: str, problems: list[str]) -> float | None:
    value = env.get(name, "").strip()
    if not value:
        return None
    try:
        number = float(value)
    except ValueError:
        number = math.nan
    if math.isfinite(number) and number > 0:
        return number
    problems.append(f"{name} must be a positive number (got {value!r})")
    return None


def _bool_or(env_value: bool | None, block_value: Value | None, default: bool) -> bool:
    if env_value is not None:
        return env_value
    return block_value if isinstance(block_value, bool) else default


def _number_or(env_value: float | None, block_value: Value | None, default: int) -> float:
    if env_value is not None:
        return env_value
    if isinstance(block_value, int) and not isinstance(block_value, bool):
        return block_value
    return default


def _conflict_message(
    env: Mapping[str, str], env_required: bool | None, env_enabled: bool | None
) -> str:
    required_by = (
        f"TG_LAYA_REQUIRED={env['TG_LAYA_REQUIRED'].strip()}"
        if env_required is not None
        else "laya.required: true"
    )
    disabled_by = (
        f"TG_LAYA={env['TG_LAYA'].strip()}" if env_enabled is not None else "laya.enabled: false"
    )
    return _conflict(required_by, disabled_by)


def _socket_from_block(values: Mapping[str, Value]) -> str | None:
    socket = values.get("socket")
    return socket if isinstance(socket, str) else None


def resolve_settings(text: str, env: Mapping[str, str]) -> LayaSettings:
    """Effective settings: environment over config over defaults. Raises LayaConfigError."""
    block = _parse_block(text)
    problems = [d.message for d in block.diagnostics]
    env_enabled = _env_bool(env, "TG_LAYA", problems)
    env_autostart = _env_bool(env, "TG_LAYA_AUTOSTART", problems)
    env_required = _env_bool(env, "TG_LAYA_REQUIRED", problems)
    env_warm = _env_number(env, "TG_LAYA_TIMEOUT_MS", problems)
    env_cold = _env_number(env, "TG_LAYA_COLD_TIMEOUT_SEC", problems)
    values = block.values
    enabled = _bool_or(env_enabled, values.get("enabled"), DEFAULTS.enabled)
    required = _bool_or(env_required, values.get("required"), DEFAULTS.required)
    if required and not enabled:
        problems.append(_conflict_message(env, env_required, env_enabled))
    if problems:
        raise LayaConfigError(problems)
    task_bin = values.get("task_bin")
    return LayaSettings(
        enabled=enabled,
        autostart=_bool_or(env_autostart, values.get("autostart"), DEFAULTS.autostart),
        required=required,
        cold_timeout_sec=_number_or(
            env_cold, values.get("cold_timeout_sec"), DEFAULTS.cold_timeout_sec
        ),
        warm_timeout_ms=_number_or(
            env_warm, values.get("warm_timeout_ms"), DEFAULTS.warm_timeout_ms
        ),
        task_bin=task_bin if isinstance(task_bin, str) else None,
        socket=env.get("TG_LAYA_SOCKET", "").strip() or _socket_from_block(values),
    )
