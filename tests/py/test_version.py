import json
import tomllib
from pathlib import Path

from tgcli.version import repo_root, resolve_version


def test_resolve_version_reads_package_json(tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text(json.dumps({"version": "9.8.7"}))
    assert resolve_version(tmp_path) == "9.8.7"


def test_resolve_version_unknown(tmp_path: Path) -> None:
    assert resolve_version(tmp_path) == "unknown"
    (tmp_path / "package.json").write_text(json.dumps({"version": 3}))
    assert resolve_version(tmp_path) == "unknown"
    (tmp_path / "package.json").write_text(json.dumps({"name": "x"}))
    assert resolve_version(tmp_path) == "unknown"


def test_versions_agree() -> None:
    root = repo_root()
    pyproject = tomllib.loads((root / "pyproject.toml").read_text())
    assert pyproject["project"]["version"] == resolve_version(root)
