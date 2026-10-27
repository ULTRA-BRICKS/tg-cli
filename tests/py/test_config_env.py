from pathlib import Path

import pytest

from tgcli.config.env import config_dir, load_env, parse_env_content


def test_parse_env_content_flat_values():
    assert parse_env_content(
        '# c\n\n A = one=two \r\nBAD\n =empty-key\nA=last\nQ="quoted"\nEMPTY=\n'
    ) == {"A": "last", "Q": '"quoted"', "EMPTY": ""}


def test_load_env_roundtrip_and_missing(tmp_path: Path):
    (tmp_path / ".env").write_bytes(b"# c\nOTHER=v\nTG_BOT_TOKEN=7:sec-ret_x\nTG_CHAT_ID=-1001\n")
    assert load_env(tmp_path) == {
        "OTHER": "v",
        "TG_BOT_TOKEN": "7:sec-ret_x",
        "TG_CHAT_ID": "-1001",
    }
    assert load_env(tmp_path / "missing") == {}


def test_load_env_lossy_without_newline_translation(tmp_path: Path):
    (tmp_path / ".env").write_bytes(b"A=one\rtwo\r\nB=bad\xff\n")
    assert load_env(tmp_path) == {"A": "one\rtwo", "B": "bad\ufffd"}


@pytest.mark.parametrize(
    ("env", "expected"),
    [
        ({}, "/home/u/.config/tg-cli"),
        ({"TG_CTL_CONFIG_DIR": "/custom"}, "/custom"),
        ({"TG_CTL_CONFIG_DIR": ""}, "/home/u/.config/tg-cli"),
    ],
)
def test_config_dir(env, expected):
    assert config_dir(env, Path("/home/u")) == Path(expected)


@pytest.mark.parametrize(
    ("text", "trimmed", "trimmed_start"),
    [
        ("\ufeff \ttext\xa0\u3000", "text", "text\xa0\u3000"),
        ("\u2028x\u2029", "x", "x\u2029"),
        ("\x85text\x85", "\x85text\x85", "\x85text\x85"),
        ("\x1ctext\x1f", "\x1ctext\x1f", "\x1ctext\x1f"),
        ("\u180etext\u180e", "\u180etext\u180e", "\u180etext\u180e"),
    ],
)
def test_ecmascript_trim_whitespace(text, trimmed, trimmed_start):
    from tgcli.common.js_string import js_trim, js_trim_start

    assert js_trim(text) == trimmed
    assert js_trim_start(text) == trimmed_start


def test_env_bom_and_python_only_whitespace():
    assert parse_env_content("\ufeffTOKEN= abc\ufeff\n\x85KEEP=1\x85\n\x1cKEY=2\x1f") == {
        "TOKEN": "abc",
        "\x85KEEP": "1\x85",
        "\x1cKEY": "2\x1f",
    }


def test_env_ignores_primitive_proto_assignment_like_ts():
    assert parse_env_content("__proto__=v\nA=x") == {"A": "x"}
