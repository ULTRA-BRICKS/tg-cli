"""The shared, flat KEY=VALUE credential file and control directory."""

from collections.abc import Mapping
from pathlib import Path

from tgcli.common.fsio import read_text_lossy
from tgcli.common.js_string import js_trim


def parse_env_content(text: str) -> dict[str, str]:
    """Keep values literal; only the first equals sign separates a key."""
    env: dict[str, str] = {}
    for line in text.split("\n"):
        trimmed = js_trim(line)
        if not trimmed or trimmed.startswith("#") or "=" not in trimmed:
            continue
        key, value = trimmed.split("=", 1)
        key = js_trim(key)
        if key and key != "__proto__":
            env[key] = js_trim(value)
    return env


def load_env(config_dir: Path) -> dict[str, str]:
    """Read the directory's `.env`; absent or unreadable credentials are empty."""
    try:
        return parse_env_content(read_text_lossy(config_dir / ".env"))
    except OSError:
        return {}


def config_dir(env: Mapping[str, str], home: Path) -> Path:
    return (
        Path(env["TG_CTL_CONFIG_DIR"])
        if env.get("TG_CTL_CONFIG_DIR")
        else home / ".config" / "tg-cli"
    )
