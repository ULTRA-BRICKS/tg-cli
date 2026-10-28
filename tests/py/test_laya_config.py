"""The `laya:` config block: strict parsing, env precedence, cross-field rules."""

import pytest

from tgcli.laya.config import (
    DEFAULTS,
    LayaConfigError,
    check_config_text,
    resolve_settings,
)


def messages(text: str) -> list[str]:
    return [d.message for d in check_config_text(text)]


def test_defaults_without_a_block_or_a_file():
    s = resolve_settings("", {})
    assert (s.enabled, s.autostart, s.required) == (True, True, False)
    assert s.cold_timeout_sec == DEFAULTS.cold_timeout_sec == 75
    assert s.warm_timeout_ms == DEFAULTS.warm_timeout_ms == 3000
    assert s.task_bin is None
    assert s.socket is None


def test_block_values_are_read_and_other_sections_are_ignored():
    text = (
        "control:\n  enabled: false\n"
        "laya:\n  autostart: false  # trailing comment\n  required: true\n"
        "  cold_timeout_sec: 90\n  warm_timeout_ms: 2500\n  task_bin: '/opt/bin/task'\n"
        "voice:\n  enabled: true\n"
    )
    s = resolve_settings(text, {})
    assert s.enabled is True
    assert (s.autostart, s.required) == (False, True)
    assert (s.cold_timeout_sec, s.warm_timeout_ms) == (90, 2500)
    assert s.task_bin == "/opt/bin/task"


def test_env_wins_over_config():
    text = "laya:\n  autostart: false\n  required: false\n  warm_timeout_ms: 2500\n"
    env = {
        "TG_LAYA_AUTOSTART": "1",
        "TG_LAYA_REQUIRED": "true",
        "TG_LAYA_TIMEOUT_MS": "400",
        "TG_LAYA_COLD_TIMEOUT_SEC": "12",
        "TG_LAYA_SOCKET": "/run/x/laya.sock",
    }
    s = resolve_settings(text, env)
    assert (s.autostart, s.required) == (True, True)
    assert (s.warm_timeout_ms, s.cold_timeout_sec) == (400, 12)
    assert s.socket == "/run/x/laya.sock"


@pytest.mark.parametrize("token", ["0", "false", "No", "OFF"])
def test_tg_laya_disables(token: str):
    assert resolve_settings("", {"TG_LAYA": token}).enabled is False


def test_tg_laya_on_overrides_config_disabled():
    assert resolve_settings("laya:\n  enabled: false\n", {"TG_LAYA": "1"}).enabled is True


@pytest.mark.parametrize(
    ("text", "needle"),
    [
        ("laya:\n  enable: true\n", "laya.enable is not a known setting"),
        ("laya:\n  enabled: maybe\n", "laya.enabled must be true or false"),
        ("laya:\n  enabled: 'true'\n", "laya.enabled must be true or false"),
        ("laya:\n  autostart: 2\n", "laya.autostart must be true or false"),
        ("laya:\n  cold_timeout_sec: 0\n", "laya.cold_timeout_sec must be a positive integer"),
        ("laya:\n  cold_timeout_sec: -3\n", "laya.cold_timeout_sec must be a positive integer"),
        ("laya:\n  cold_timeout_sec: 1.5\n", "laya.cold_timeout_sec must be a positive integer"),
        ("laya:\n  warm_timeout_ms: nan\n", "laya.warm_timeout_ms must be a positive integer"),
        ("laya:\n  warm_timeout_ms: 0\n", "laya.warm_timeout_ms must be a positive integer"),
        ("laya:\n  task_bin: task\n", "laya.task_bin must be an absolute path"),
        ("laya:\n  task_bin: ./bin/task\n", "laya.task_bin must be an absolute path"),
        ("laya:\n  enabled:\n", "laya.enabled has an empty value"),
        ("laya:\n  socket: laya.sock\n", "laya.socket must be an absolute path"),
        ("laya:\n  socket: ''\n", "laya.socket must be an absolute path"),
        ("laya:\n  socket: ./laya.sock\n", "laya.socket must be an absolute path"),
        ("laya:\n  socket: /run/../etc/x.sock\n", "laya.socket must not contain .."),
        ("laya:\n  enabled: true\n  enabled: false\n", "laya.enabled is duplicated"),
        ("laya: true\n", "laya must be a block"),
        (
            "laya:\n  required: true\n  enabled: false\n",
            "laya.required: true conflicts with laya.enabled: false",
        ),
    ],
)
def test_config_diagnostics(text: str, needle: str):
    assert any(needle in m for m in messages(text)), messages(text)
    with pytest.raises(LayaConfigError) as raised:
        resolve_settings(text, {})
    assert any(needle in m for m in raised.value.diagnostics)


def test_socket_comes_from_env_then_config_then_discovery():
    text = "laya:\n  socket: '/state/laya-ubuntu.sock'\n"
    assert resolve_settings("", {}).socket is None
    assert resolve_settings(text, {}).socket == "/state/laya-ubuntu.sock"
    assert resolve_settings(text, {"TG_LAYA_SOCKET": "/env/x.sock"}).socket == "/env/x.sock"
    assert resolve_settings(text, {"TG_LAYA_SOCKET": "  "}).socket == "/state/laya-ubuntu.sock"


def test_a_nul_in_the_yaml_socket_is_refused():
    text = "laya:\n  socket: /run/x\x00y.sock\n"
    assert any("NUL" in m for m in messages(text))
    with pytest.raises(LayaConfigError):
        resolve_settings(text, {})


def test_diagnostics_carry_line_numbers():
    (d,) = check_config_text("control:\n  enabled: true\nlaya:\n  warm_timeout_ms: -1\n")
    assert (d.line, d.severity) == (4, "error")


def test_valid_block_has_no_diagnostics():
    assert messages("laya:\n  enabled: true\n  warm_timeout_ms: 2000\n") == []
    assert messages("") == []


@pytest.mark.parametrize(
    ("env", "needle"),
    [
        ({"TG_LAYA": "banana"}, "TG_LAYA must be"),
        ({"TG_LAYA_AUTOSTART": "x"}, "TG_LAYA_AUTOSTART must be"),
        ({"TG_LAYA_REQUIRED": "2"}, "TG_LAYA_REQUIRED must be"),
        ({"TG_LAYA_TIMEOUT_MS": "0"}, "TG_LAYA_TIMEOUT_MS must be a positive number"),
        ({"TG_LAYA_TIMEOUT_MS": "abc"}, "TG_LAYA_TIMEOUT_MS must be a positive number"),
        ({"TG_LAYA_TIMEOUT_MS": "nan"}, "TG_LAYA_TIMEOUT_MS must be a positive number"),
        ({"TG_LAYA_COLD_TIMEOUT_SEC": "-1"}, "TG_LAYA_COLD_TIMEOUT_SEC must be a positive number"),
    ],
)
def test_bad_env_is_a_diagnostic_not_a_default(env: dict[str, str], needle: str):
    with pytest.raises(LayaConfigError) as raised:
        resolve_settings("", env)
    assert any(needle in m for m in raised.value.diagnostics), raised.value.diagnostics


def test_required_with_tg_laya_zero_conflicts():
    with pytest.raises(LayaConfigError) as raised:
        resolve_settings("laya:\n  required: true\n", {"TG_LAYA": "0"})
    assert any("TG_LAYA=0" in m and "required" in m for m in raised.value.diagnostics)
    with pytest.raises(LayaConfigError):
        resolve_settings("", {"TG_LAYA": "0", "TG_LAYA_REQUIRED": "1"})


def test_env_enabled_rescues_a_config_disabled_required_pair_only_at_runtime():
    text = "laya:\n  required: true\n  enabled: false\n"
    assert resolve_settings(text, {"TG_LAYA": "1"}).required is True
    # The file on its own is still contradictory: `tg config validate` reports it.
    assert any("conflicts" in m for m in messages(text))


BOOLEAN_TOKENS = [
    ("true", True), ("True", True), ("TRUE", True), ("yes", True), ("Yes", True), ("on", True),
    ("ON", True), ("1", True), ("false", False), ("False", False), ("FALSE", False), ("no", False),
    ("No", False), ("off", False), ("OFF", False), ("0", False),
]  # fmt: skip


@pytest.mark.parametrize(("token", "expected"), BOOLEAN_TOKENS)
def test_documented_boolean_tokens_in_config_and_environment(token: str, expected: bool):
    # docs/configuration.md: the runtime also accepts yes/no, on/off, 1/0, case-insensitively.
    assert resolve_settings(f"laya:\n  autostart: {token}\n", {}).autostart is expected
    assert resolve_settings("", {"TG_LAYA_AUTOSTART": token}).autostart is expected
    assert messages(f"laya:\n  autostart: {token}\n") == []
