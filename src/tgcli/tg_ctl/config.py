"""Pure control-block parsing and resolution, without a YAML dependency."""

import re
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from typing import Literal, TypedDict, cast

from tgcli.common.js_number import js_integer, js_number
from tgcli.common.js_string import JS_WHITESPACE_PATTERN, js_trim, js_trim_start


class ControlConfigRaw(TypedDict, total=False):
    enabled: bool
    transport: str
    session: str
    inject_wrap: str
    staleness_sec: float
    idle_exit_min: float
    allowed_senders: list[float]
    topics: bool
    private_topics: bool
    git_state_banner: bool
    server: str
    machine: str
    remote_machines: str


@dataclass(frozen=True)
class ControlConfig:
    enabled: bool = True
    transport: Literal["auto", "tmux", "channel"] = "auto"
    session: str | None = None
    inject_wrap: str = "[TG from {name} {id}] {msg}"
    staleness_sec: int = 300
    idle_exit_min: int = 30
    allowed_senders: list[float] = field(default_factory=list)
    topics: bool = False
    private_topics: bool = False
    git_state_banner: bool = True
    # Raw, unvalidated scalars: `tgcli.remote.config.check` is the one place that judges them.
    server: str | None = None
    machine: str | None = None
    remote_machines: str | None = None


DEFAULT_CONTROL = ControlConfig()
_TRUE_TOKENS = {"true", "yes", "on", "1"}
_FALSE_TOKENS = {"false", "no", "off", "0"}
_INT_RE = re.compile(r"^[0-9]+$")


def _unquote(s: str) -> str:
    return re.sub(r"""^["']|["']$""", "", s)


_BOOLEAN_KEYS = frozenset({"enabled", "topics", "private_topics", "git_state_banner"})
_STRING_KEYS = frozenset(
    {"transport", "session", "inject_wrap", "server", "machine", "remote_machines"}
)
_INTEGER_KEYS = frozenset({"staleness_sec", "idle_exit_min"})


def _control_pairs(text: str) -> Iterator[tuple[str, str]]:
    """Yield the non-empty `key: value` scalars of the top-level `control:` block."""
    in_control = False
    for raw_line in text.split("\n"):
        line = re.sub(JS_WHITESPACE_PATTERN + r"+#[^\r\n\u2028\u2029]*\Z", "", raw_line)
        if not js_trim(line) or js_trim(line).startswith("#"):
            continue
        if len(line) == len(js_trim_start(line)):
            in_control = re.sub(r":[^\r\n\u2028\u2029]*\Z", "", js_trim(line)) == "control"
            continue
        if not in_control or ":" not in line:
            continue
        key, value = js_trim(line).split(":", 1)
        key, value = _unquote(js_trim(key)), js_trim(value)
        if value:
            yield key, value


def _apply_control_pair(out: dict[str, object], key: str, value: str) -> None:
    if key in _BOOLEAN_KEYS:
        token = value.lower()
        if token in _TRUE_TOKENS or token in _FALSE_TOKENS:
            out[key] = token in _TRUE_TOKENS
    elif key in _STRING_KEYS:
        out[key] = _unquote(value)
    elif key in _INTEGER_KEYS:
        if _INT_RE.fullmatch(value):
            out[key] = js_number(value)
    elif key == "allowed_senders":
        out[key] = [
            js_number(js_trim(s))
            for s in _unquote(value).split(",")
            if _INT_RE.fullmatch(js_trim(s))
        ]


def parse_control_config(text: str) -> ControlConfigRaw:
    out: dict[str, object] = {}
    for key, value in _control_pairs(text):
        _apply_control_pair(out, key, value)
    return cast(ControlConfigRaw, out)


def resolve_control_config(
    raw: Mapping[str, object], env: Mapping[str, str] | None = None
) -> ControlConfig:
    """Heal programmatic values just as the TS nullish/default and integer checks do."""

    def positive_int(value: object, default: int) -> int:
        integer = js_integer(value)
        return int(integer) if integer is not None and integer > 0 else default

    def nullish[T](key: str, default: T) -> T:
        value = raw.get(key)
        return default if value is None else cast(T, value)

    transport = raw.get("transport")
    return ControlConfig(
        enabled=nullish("enabled", DEFAULT_CONTROL.enabled),
        transport=cast(Literal["auto", "tmux", "channel"], transport)
        if isinstance(transport, str) and transport in {"auto", "tmux", "channel"}
        else "auto",
        # Unlike the nullish-default fields, an explicitly null session is retained.
        session=cast(str | None, raw.get("session")),
        inject_wrap=nullish("inject_wrap", DEFAULT_CONTROL.inject_wrap),
        staleness_sec=positive_int(raw.get("staleness_sec"), DEFAULT_CONTROL.staleness_sec),
        idle_exit_min=positive_int(raw.get("idle_exit_min"), DEFAULT_CONTROL.idle_exit_min),
        allowed_senders=list(nullish("allowed_senders", DEFAULT_CONTROL.allowed_senders)),
        topics=nullish("topics", DEFAULT_CONTROL.topics),
        private_topics=nullish("private_topics", DEFAULT_CONTROL.private_topics),
        git_state_banner=nullish("git_state_banner", DEFAULT_CONTROL.git_state_banner),
        server=cast(str | None, raw.get("server")),
        machine=cast(str | None, raw.get("machine")),
        remote_machines=cast(str | None, raw.get("remote_machines")),
    )
