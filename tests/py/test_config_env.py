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
