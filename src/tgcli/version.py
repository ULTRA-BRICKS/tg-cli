"""Package version, read from package.json at run time (the single source until the TS goes)."""

import json
from pathlib import Path


def repo_root() -> Path:
    """The checkout this package is installed from (an editable install: src/tgcli/ lives in it)."""
    return Path(__file__).resolve().parents[2]


def resolve_version(root: Path) -> str:
    """`version` from `<root>/package.json`; "unknown" when absent or not a string."""
    try:
        data = json.loads((root / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return "unknown"
    version = data.get("version") if isinstance(data, dict) else None
    return version if isinstance(version, str) else "unknown"


VERSION = resolve_version(repo_root())
