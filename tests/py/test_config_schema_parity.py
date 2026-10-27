"""The TypeScript-generated editor schema must describe the Python port's defaults too."""

import json
from pathlib import Path

from tgcli.auto_attach.feature_flags import DEFAULT_FEATURES
from tgcli.tg_ctl.config import DEFAULT_CONTROL

SCHEMA = json.loads((Path(__file__).parents[2] / "config.schema.json").read_text())["properties"]


def test_feature_names_and_defaults_match_schema():
    assert {
        k: v["default"] for k, v in SCHEMA["features"]["properties"].items()
    } == DEFAULT_FEATURES


def test_control_keys_and_defaults_match_schema():
    defaults = {
        "enabled": DEFAULT_CONTROL.enabled,
        "transport": DEFAULT_CONTROL.transport,
        "inject_wrap": DEFAULT_CONTROL.inject_wrap,
        "staleness_sec": DEFAULT_CONTROL.staleness_sec,
        "idle_exit_min": DEFAULT_CONTROL.idle_exit_min,
        "allowed_senders": ", ".join(str(n) for n in DEFAULT_CONTROL.allowed_senders),
        "topics": DEFAULT_CONTROL.topics,
        "private_topics": DEFAULT_CONTROL.private_topics,
        "git_state_banner": DEFAULT_CONTROL.git_state_banner,
    }
    properties = SCHEMA["control"]["properties"]
    # session has no literal default: the schema omits it and the port uses None.
    assert DEFAULT_CONTROL.session is None
    assert "default" not in properties["session"]
    assert {k: v["default"] for k, v in properties.items() if k != "session"} == defaults
