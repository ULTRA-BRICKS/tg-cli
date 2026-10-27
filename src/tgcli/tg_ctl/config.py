"""Pure control-block parsing and resolution, without a YAML dependency."""

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Literal, TypedDict, cast


class ControlConfigRaw(TypedDict, total=False):
    enabled: bool
    transport: str
    session: str
    inject_wrap: str
    staleness_sec: int
    idle_exit_min: int
    allowed_senders: list[int]
    topics: bool
    private_topics: bool
    git_state_banner: bool


@dataclass(frozen=True)
class ControlConfig:
    enabled: bool = True
    transport: Literal["auto", "tmux", "channel"] = "auto"
    session: str | None = None
    inject_wrap: str = "[TG from {name} {id}] {msg}"
    staleness_sec: int = 300
    idle_exit_min: int = 30
    allowed_senders: list[int] = field(default_factory=list)
    topics: bool = False
    private_topics: bool = False
    git_state_banner: bool = True


DEFAULT_CONTROL = ControlConfig()
_TRUE_TOKENS = {"true", "yes", "on", "1"}
_FALSE_TOKENS = {"false", "no", "off", "0"}
_INT_RE = re.compile(r"^[0-9]+$")


def _unquote(s: str) -> str:
    return re.sub(r"""^["']|["']$""", "", s)


def parse_control_config(text: str) -> ControlConfigRaw:
    out: ControlConfigRaw = {}
    in_control = False
    for raw_line in text.split("\n"):
        line = re.sub(r"\s+#.*$", "", raw_line)
        if not line.strip() or line.strip().startswith("#"):
            continue
        if len(line) == len(line.lstrip()):
            in_control = re.sub(r":.*$", "", line.strip()) == "control"
            continue
        if not in_control or ":" not in line:
            continue
        key, value = line.strip().split(":", 1)
        key, value = _unquote(key.strip()), value.strip()
        if not value:
            continue
        if key in {"enabled", "topics", "private_topics", "git_state_banner"}:
            token = value.lower()
            if token in _TRUE_TOKENS or token in _FALSE_TOKENS:
                boolean = token in _TRUE_TOKENS
                if key == "enabled":
                    out["enabled"] = boolean
                elif key == "topics":
                    out["topics"] = boolean
                elif key == "private_topics":
                    out["private_topics"] = boolean
                else:
                    out["git_state_banner"] = boolean
        elif key == "transport":
            out["transport"] = _unquote(value)
        elif key == "session":
            out["session"] = _unquote(value)
        elif key == "inject_wrap":
            out["inject_wrap"] = _unquote(value)
        elif key == "staleness_sec" and _INT_RE.fullmatch(value):
            out["staleness_sec"] = int(value)
        elif key == "idle_exit_min" and _INT_RE.fullmatch(value):
            out["idle_exit_min"] = int(value)
        elif key == "allowed_senders":
            out["allowed_senders"] = [
                int(s.strip()) for s in _unquote(value).split(",") if _INT_RE.fullmatch(s.strip())
            ]
    return out


def resolve_control_config(
    raw: ControlConfigRaw, env: Mapping[str, str] | None = None
) -> ControlConfig:
    """Heal invalid durations/transports; there are no environment overrides in TS."""

    def positive_int(value: object, default: int) -> int:
        return (
            int(value)
            if type(value) in (int, float)
            and isinstance(value, (int, float))
            and value > 0
            and value % 1 == 0
            else default
        )

    transport = raw.get("transport", "auto")
    return ControlConfig(
        enabled=raw.get("enabled", DEFAULT_CONTROL.enabled),
        transport=cast(Literal["auto", "tmux", "channel"], transport)
        if transport in {"auto", "tmux", "channel"}
        else "auto",
        session=raw.get("session"),
        inject_wrap=raw.get("inject_wrap", DEFAULT_CONTROL.inject_wrap),
        staleness_sec=positive_int(raw.get("staleness_sec"), DEFAULT_CONTROL.staleness_sec),
        idle_exit_min=positive_int(raw.get("idle_exit_min"), DEFAULT_CONTROL.idle_exit_min),
        allowed_senders=list(raw.get("allowed_senders", DEFAULT_CONTROL.allowed_senders)),
        topics=raw.get("topics", DEFAULT_CONTROL.topics),
        private_topics=raw.get("private_topics", DEFAULT_CONTROL.private_topics),
        git_state_banner=raw.get("git_state_banner", DEFAULT_CONTROL.git_state_banner),
    )
