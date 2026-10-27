"""Pure feature config parsing and command-line overrides."""

import re
from dataclasses import dataclass

from tgcli.common.js_string import JS_WHITESPACE_PATTERN, js_trim, js_trim_start

DEFAULT_FEATURES: dict[str, bool] = dict.fromkeys(
    [
        "autolink-tasks",
        "autolink-prs",
        "autolink-msgrefs",
        "autolink-msgref-preview",
        "md-as-pdf",
        "code-as-pdf",
        "attach-denylist",
        "flood-cap",
        "cjk-guard",
        "screenshot-guard",
        "file-mention-guard",
        "hooks",
    ],
    True,
)
_TRUE_TOKENS = {"true", "yes", "on", "1"}
_FALSE_TOKENS = {"false", "no", "off", "0"}


@dataclass(frozen=True)
class FeatureOverrides:
    enable: list[str]
    disable: list[str]


@dataclass(frozen=True)
class ApplyFlagsResult:
    enable: list[str]
    disable: list[str]
    rest: list[str]
    error: str | None = None


def parse_feature_config(text: str) -> dict[str, bool]:
    out: dict[str, bool] = {}
    in_features = False
    for raw_line in text.split("\n"):
        line = re.sub(JS_WHITESPACE_PATTERN + r"+#[^\r\n\u2028\u2029]*\Z", "", raw_line)
        if not js_trim(line) or js_trim(line).startswith("#"):
            continue
        if len(line) == len(js_trim_start(line)):
            in_features = re.sub(r":[^\r\n\u2028\u2029]*\Z", "", js_trim(line)) == "features"
            continue
        if not in_features or ":" not in line:
            continue
        name, value = js_trim(line).split(":", 1)
        name = re.sub(r"""^["']|["']$""", "", js_trim(name))
        value = js_trim(value).lower()
        if name and name != "__proto__" and value in _TRUE_TOKENS | _FALSE_TOKENS:
            out[name] = value in _TRUE_TOKENS
    return out


def resolve_features(config: dict[str, bool], overrides: FeatureOverrides) -> dict[str, bool]:
    merged = {**DEFAULT_FEATURES, **config}
    for name in overrides.enable:
        if name != "__proto__" or name in merged:
            merged[name] = True
    for name in overrides.disable:
        if name != "__proto__" or name in merged:
            merged[name] = False
    return merged


def apply_feature_flags(args: list[str]) -> ApplyFlagsResult:
    enable: list[str] = []
    disable: list[str] = []
    rest: list[str] = []
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in {"--feature", "--no-feature"}:
            value = args[i + 1] if i + 1 < len(args) else ""
            if not value or value.startswith("-"):
                return ApplyFlagsResult(enable, disable, rest, f"{arg} requires a feature name")
            (enable if arg == "--feature" else disable).append(value)
            i += 2
        else:
            rest.append(arg)
            i += 1
    return ApplyFlagsResult(enable, disable, rest)
