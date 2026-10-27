import json
from pathlib import Path

import pytest

from tgcli.tg_ctl.config import resolve_control_config
from tgcli.tg_ctl.lock import (
    bot_id_from_token,
    ctl_paths,
    flock_pids_for_inode,
    owns_pid_file,
    plan_legacy_last_user_target_migration,
    read_pid_file,
    should_auto_start,
)


def test_ctl_paths_matches_ts_fixture():
    fixture = json.loads((Path(__file__).parent / "fixtures/ctl_paths.json").read_bytes())
    assert ctl_paths(Path("/home/u/.config/tg-cli"), "8574086668") == fixture
    assert ctl_paths(Path("/tmp/cfg/"), "99")["lock"] == "/tmp/cfg/tg-ctl.99.lock"


@pytest.mark.parametrize(
    ("token", "expected"),
    [
        ("123456:ABC-DEF1234", "123456"),
        ("", ""),
        ("no-colon-here", ""),
        (":ABC", ""),
        ("12ab34:XYZ", ""),
        ("١٢:abc", ""),
    ],
)
def test_bot_id_from_token(token, expected):
    assert bot_id_from_token(token) == expected


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("12345\n", 12345),
        ("  777  ", 777),
        (None, None),
        ("", None),
        ("   \n", None),
        ("abc", None),
        ("12.5", None),
        ("0", None),
        ("-5", None),
    ],
)
def test_read_pid_file(text, expected):
    assert read_pid_file(text) == expected


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("4242\n", True),
        ("  4242  ", True),
        ("9999\n", False),
        (None, False),
        ("", False),
        ("  \n", False),
        ("not-a-pid", False),
    ],
)
def test_owns_pid_file(text, expected):
    assert owns_pid_file(text, 4242) is expected


@pytest.mark.parametrize(
    ("env", "enabled", "expected"),
    [
        ({"TMUX": "sock"}, True, True),
        ({}, True, False),
        ({"TMUX": ""}, True, False),
        ({"TMUX": "sock"}, False, False),
        ({"TMUX": "sock", "CI": "true", "SSH_TTY": "", "TERM": "dumb"}, True, True),
    ],
)
def test_should_auto_start(env, enabled, expected):
    assert should_auto_start(env, resolve_control_config({"enabled": enabled})) is expected


@pytest.mark.parametrize(
    ("present", "expected"),
    [
        (
            {"/cfg/tg-ctl.123.last-alex-target.json"},
            {
                "kind": "migrate",
                "from": "/cfg/tg-ctl.123.last-alex-target.json",
                "to": "/cfg/tg-ctl.123.last-user-target.json",
            },
        ),
        (
            {
                "/cfg/tg-ctl.123.last-alex-target.json",
                "/cfg/tg-ctl.123.last-user-target.json",
            },
            {"kind": "remove-stale", "path": "/cfg/tg-ctl.123.last-alex-target.json"},
        ),
        (set(), None),
        ({"/cfg/tg-ctl.123.last-user-target.json"}, None),
    ],
)
def test_legacy_last_user_target_migration(present, expected):
    assert (
        plan_legacy_last_user_target_migration(Path("/cfg"), "123", lambda p: p in present)
        == expected
    )


PROC_LOCKS = "\n".join(
    [
        "1: POSIX  ADVISORY  READ 3305049 00:31:1968647 128 128",
        "2: FLOCK  ADVISORY  WRITE 4242 103:02:8705582 0 EOF",
        "2: -> FLOCK  ADVISORY  WRITE 5151 103:02:8705582 0 EOF",
        "3: OFDLCK ADVISORY  WRITE -1 103:02:8705582 0 EOF",
        "4: FLOCK  ADVISORY  WRITE 7777 00:1d:870558 0 EOF",
        "5: FLOCK  ADVISORY  WRITE 4242 08:01:8705582 0 EOF",
        "6: FLOCK  ADVISORY  WRITE 0 103:02:4410 0 EOF",
        "",
    ]
)


@pytest.mark.parametrize(
    ("text", "inode", "expected"),
    [
        (PROC_LOCKS, "8705582", [4242]),
        (PROC_LOCKS, "1968647", []),
        (PROC_LOCKS, "870558", [7777]),
        (PROC_LOCKS, "123", []),
        ("", "8705582", []),
        (PROC_LOCKS, "4410", [0]),
    ],
)
def test_flock_pids_for_inode(text, inode, expected):
    assert flock_pids_for_inode(text, inode) == expected


@pytest.mark.parametrize(
    ("text", "expected"), [("\ufeff4242\ufeff", 4242), ("\x854242", None), ("\x1c4242\x1f", None)]
)
def test_pid_ecmascript_whitespace(text, expected):
    assert read_pid_file(text) == expected


def test_flock_ecmascript_whitespace_separator():
    assert flock_pids_for_inode(
        "\ufeff2:\ufeffFLOCK\ufeffADVISORY\ufeffWRITE\ufeff4242\ufeff103:02:42 0 EOF", "42"
    ) == [4242]
    assert flock_pids_for_inode("2:\x85FLOCK  ADVISORY WRITE 4242 103:02:42 0 EOF", "42") == []
