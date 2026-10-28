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
    # These keys have no literal default: the schema omits it and the port uses None.
    schema_only = ("session", "server", "machine", "remote_machines")
    for key in schema_only:
        assert getattr(DEFAULT_CONTROL, key) is None
        assert "default" not in properties.get(key, {})
    assert {k: v["default"] for k, v in properties.items() if k not in schema_only} == defaults


def test_laya_keys_and_defaults_match_schema():
    from tgcli.laya.config import DEFAULTS, SETTINGS

    properties = SCHEMA["laya"]["properties"]
    assert set(properties) == set(SETTINGS)
    defaults = {
        "enabled": DEFAULTS.enabled,
        "autostart": DEFAULTS.autostart,
        "required": DEFAULTS.required,
        "cold_timeout_sec": DEFAULTS.cold_timeout_sec,
        "warm_timeout_ms": DEFAULTS.warm_timeout_ms,
    }
    # task_bin and socket are unset by default: the schema omits a default (PATH search, discovery).
    unset = ("task_bin", "socket")
    assert all("default" not in properties[key] for key in unset)
    assert {k: v["default"] for k, v in properties.items() if k not in unset} == defaults
