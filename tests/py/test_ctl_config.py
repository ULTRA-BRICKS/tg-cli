import pytest

from tgcli.tg_ctl.config import (
    DEFAULT_CONTROL,
    parse_control_config,
    resolve_control_config,
)


def test_parse_full_control_config():
    assert parse_control_config(
        "features:\n  auto-attach: true\ncontrol:\n  enabled: true\n"
        '  transport: tmux\n  session: agents\n  inject_wrap: "[TG from {name}] {msg}"\n'
        "  staleness_sec: 600\n  idle_exit_min: 15\n  allowed_senders: 111, 222\n"
    ) == {
        "enabled": True,
        "transport": "tmux",
        "session": "agents",
        "inject_wrap": "[TG from {name}] {msg}",
        "staleness_sec": 600,
        "idle_exit_min": 15,
        "allowed_senders": [111, 222],
    }


@pytest.mark.parametrize(
    "text",
    [
        "",
        "features:\n  auto-attach: true\n",
        "control:\n  staleness_sec: soon\n  idle_exit_min: 1h\n",
        "control:\n  staleness_sec: -5\n",
        "control:\n  idle_exit_min: 4.5\n",
    ],
)
def test_parse_control_ignores_missing_and_invalid(text):
    assert parse_control_config(text) == {}


def test_parse_control_comments_quotes_and_blocks():
    assert parse_control_config(
        "control:\n\n  # gate inbound\n  enabled: yes  # inline comment\n"
        "  bogus: 1\nother:\n  staleness_sec: 60\n"
    ) == {"enabled": True}
    assert parse_control_config(
        "control:\n  session: 'my session'\n  inject_wrap: \"{name}: {msg}\"\n"
    ) == {"session": "my session", "inject_wrap": "{name}: {msg}"}
    assert parse_control_config("control:\n  allowed_senders: 1, x, 2,, -3\n") == {
        "allowed_senders": [1, 2]
    }
    assert parse_control_config("control:\n  allowed_senders: 42\n") == {"allowed_senders": [42]}


@pytest.mark.parametrize("key", ["enabled", "topics", "private_topics", "git_state_banner"])
@pytest.mark.parametrize(
    ("token", "expected"),
    [(v, True) for v in ["true", "yes", "on", "1"]]
    + [(v, False) for v in ["false", "no", "off", "0"]]
    + [("maybe", None)],
)
def test_control_boolean_tokens(key, token, expected):
    assert parse_control_config(f"control:\n  {key}: {token}\n") == (
        {} if expected is None else {key: expected}
    )


def test_resolve_control_defaults_and_partial():
    assert resolve_control_config({}) == DEFAULT_CONTROL
    r = resolve_control_config({"enabled": True, "staleness_sec": 60, "allowed_senders": [42]})
    assert (
        r.enabled,
        r.staleness_sec,
        r.allowed_senders,
        r.idle_exit_min,
        r.inject_wrap,
        r.transport,
        r.topics,
        r.private_topics,
        r.git_state_banner,
        r.session,
    ) == (
        True,
        60,
        [42],
        30,
        "[TG from {name} {id}] {msg}",
        "auto",
        False,
        False,
        True,
        None,
    )
    assert resolve_control_config({"topics": True}).topics is True
    assert resolve_control_config({"private_topics": True}).private_topics is True
    assert resolve_control_config({"git_state_banner": False}).git_state_banner is False
    assert resolve_control_config({"session": "agents"}).session == "agents"
    r.allowed_senders.append(1)
    assert DEFAULT_CONTROL.allowed_senders == []


@pytest.mark.parametrize(
    ("transport", "expected"),
    [("teleport", "auto"), ("tmux", "tmux"), ("channel", "channel")],
)
def test_resolve_control_transport(transport, expected):
    assert resolve_control_config({"transport": transport}).transport == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ({"staleness_sec": 0}, 300),
        ({"staleness_sec": 1.5}, 300),
        ({"staleness_sec": 1}, 1),
        ({"staleness_sec": True}, 300),
    ],
)
def test_resolve_control_positive_integer(raw, expected):
    assert resolve_control_config(raw).staleness_sec == expected
    assert resolve_control_config({"idle_exit_min": -1}).idle_exit_min == 30


def test_control_parse_resolve_roundtrip():
    r = resolve_control_config(
        parse_control_config(
            "control:\n  enabled: yes\n  transport: zigbee\n"
            "  staleness_sec: 0\n  idle_exit_min: 45\n"
        )
    )
    assert (r.enabled, r.transport, r.staleness_sec, r.idle_exit_min) == (
        True,
        "auto",
        300,
        45,
    )


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("control:\n\ufeffenabled:\ufeffyes\n", {"enabled": True}),
        ("control:\n  enabled: yes\ufeff#comment\n", {"enabled": True}),
        ("control:\n  enabled: yes\x85#comment\n", {}),
        ("control:\n  enabled: yes #comment\r\n", {}),
        ("control:\n  session: abc # c\u2028z\n", {"session": "abc # c\u2028z"}),
        ("control:\u2028metadata\n  enabled: true\n", {}),
        ("control:\n  allowed_senders: \ufeff1\ufeff,2,\x853\n", {"allowed_senders": [1, 2]}),
        ("control:\n\x85enabled: true\n", {}),
    ],
)
def test_control_ecmascript_whitespace_and_comment_boundaries(text, expected):
    assert parse_control_config(text) == expected


def test_control_numbers_round_to_js_double_before_resolving():
    raw = parse_control_config(
        "control:\n  allowed_senders: 9007199254740993\n  staleness_sec: 9007199254740993\n"
    )
    assert raw["allowed_senders"] == [9007199254740992]
    assert raw["staleness_sec"] == 9007199254740992
    assert resolve_control_config(raw).staleness_sec == 9007199254740992


@pytest.mark.parametrize("digits", [309, 5000])
def test_control_very_long_numbers_do_not_crash_and_resolve_nonfinite(digits):
    import math

    raw = parse_control_config(
        "control:\n  staleness_sec: "
        + "9" * digits
        + "\n  idle_exit_min: "
        + "9" * digits
        + "\n  allowed_senders: "
        + "9" * digits
        + "\n"
    )
    assert math.isinf(raw["staleness_sec"])
    assert math.isinf(raw["allowed_senders"][0])
    cfg = resolve_control_config(raw)
    assert (cfg.staleness_sec, cfg.idle_exit_min) == (300, 30)


def test_resolve_control_nullish_healing_and_session_passthrough():
    cfg = resolve_control_config(
        dict.fromkeys(
            [
                "enabled",
                "inject_wrap",
                "allowed_senders",
                "topics",
                "private_topics",
                "git_state_banner",
                "session",
            ]
        )
    )
    assert cfg.enabled is True
    assert cfg.inject_wrap == "[TG from {name} {id}] {msg}"
    assert cfg.allowed_senders == []
    assert (cfg.topics, cfg.private_topics, cfg.git_state_banner) == (False, False, True)
    assert cfg.session is None
    assert resolve_control_config({"session": ""}).session == ""
    assert (
        resolve_control_config({"enabled": False, "inject_wrap": "", "allowed_senders": []}).enabled
        is False
    )
    assert resolve_control_config({"inject_wrap": ""}).inject_wrap == ""


@pytest.mark.parametrize("transport", [[], {}, None, 42, True])
def test_resolve_control_invalid_transport_heals_without_throwing(transport):
    assert resolve_control_config({"transport": transport}).transport == "auto"


def test_resolve_control_programmatic_number_uses_js_double():
    assert (
        resolve_control_config({"staleness_sec": 9007199254740993}).staleness_sec
        == 9007199254740992
    )
    assert resolve_control_config({"staleness_sec": 10**5000}).staleness_sec == 300


def test_parse_remote_keys_are_raw_scalars_like_the_ts_twin():
    assert parse_control_config(
        "control:\n  server: ssh://tg-ctl-ubuntu\n  machine: 'clvm'\n"
        '  remote_machines: "clvm=ultra@65.21.40.51, lab=lab.example"\n'
    ) == {
        "server": "ssh://tg-ctl-ubuntu",
        "machine": "clvm",
        "remote_machines": "clvm=ultra@65.21.40.51, lab=lab.example",
    }


@pytest.mark.parametrize(
    "text",
    [
        "control:\n  server: ssh://-oProxyCommand=x\n",
        "control:\n  machine: Not A Machine\n",
        "control:\n  remote_machines: =,,\n",
    ],
)
def test_parse_remote_keys_do_not_validate(text):
    assert len(parse_control_config(text)) == 1


def test_parse_remote_keys_ignore_empty_values_and_other_blocks():
    assert parse_control_config("control:\n  server:\n  machine:   \nother:\n  server: x\n") == {}


def test_resolve_control_keeps_remote_keys_none_unless_set():
    cfg = resolve_control_config(parse_control_config("control:\n  server: ssh://h\n"))
    assert (cfg.server, cfg.machine, cfg.remote_machines) == ("ssh://h", None, None)
    assert resolve_control_config({}) == DEFAULT_CONTROL
    assert (DEFAULT_CONTROL.server, DEFAULT_CONTROL.machine, DEFAULT_CONTROL.remote_machines) == (
        None,
        None,
        None,
    )
