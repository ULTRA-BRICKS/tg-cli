"""The subprocess contract the TypeScript glue relies on (`python3 -I <repo>/tg-laya ...`)."""

import json
import subprocess
import sys
from pathlib import Path

import pytest
from laya_fakes import FakeLaya, install_fake_task

LAUNCHER = str(Path(__file__).resolve().parents[2] / "tg-laya")


def run(
    args: list[str], stdin: str, env: dict[str, str], cwd: Path | None = None
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-I", LAUNCHER, *args],
        input=stdin,
        capture_output=True,
        text=True,
        timeout=60,
        cwd=cwd,
        env={"PATH": "/usr/bin:/bin", **env},
    )


def lines(proc: subprocess.CompletedProcess[str]) -> list[dict[str, object]]:
    return [json.loads(line) for line in proc.stdout.splitlines()]


@pytest.fixture
def home(tmp_path: Path) -> Path:
    (tmp_path / "state" / "task-cli" / "classify").mkdir(parents=True, mode=0o700)
    (tmp_path / "cfg").mkdir()
    return tmp_path


def env_for(home: Path, **extra: str) -> dict[str, str]:
    return {"HOME": str(home), "XDG_STATE_HOME": str(home / "state"), **extra}


REQUEST = json.dumps({"message": "hi", "questions": {"asks_reader": {"type": "noul"}}})


def test_ok_reply_has_budget_first_and_policy(home: Path):
    server = FakeLaya(str(home / "state/task-cli/classify/laya-1.sock")).start()
    (home / "cfg" / "config.yaml").write_text("laya:\n  warm_timeout_ms: 2500\n  required: true\n")
    proc = run(["ask", "--config-dir", str(home / "cfg")], REQUEST, env_for(home))
    first, last = lines(proc)
    assert first == {"status": "budget", "total_ms": 2500 + 75_000}
    assert last["status"] == "ok" and last["policy"] == "required"
    assert json.loads(str(last["line"]))["ok"] is True
    server.stop()


def test_pinned_socket_budget_has_no_cold_part(home: Path):
    proc = run(
        ["ask", "--config-dir", str(home / "cfg")],
        REQUEST,
        env_for(home, TG_LAYA_SOCKET=str(home / "nope.sock")),
    )
    first, last = lines(proc)
    assert first["total_ms"] == 3000
    assert last["reason"] == "no-socket"


def test_invalid_config_is_a_typed_reason_not_a_crash(home: Path):
    (home / "cfg" / "config.yaml").write_text("laya:\n  warm_timeout_ms: soon\n  bogus: 1\n")
    proc = run(["ask", "--config-dir", str(home / "cfg")], REQUEST, env_for(home))
    assert proc.returncode == 0
    last = lines(proc)[-1]
    assert last["status"] == "unavailable" and last["reason"] == "invalid-config"
    assert "laya.warm_timeout_ms" in str(last["detail"]) and "laya.bogus" in str(last["detail"])


def test_disabled_is_reported_with_a_remedy(home: Path):
    proc = run(["ask", "--config-dir", str(home / "cfg")], REQUEST, env_for(home, TG_LAYA="0"))
    last = lines(proc)[-1]
    assert last["reason"] == "disabled" and last["remedy"] and last["attempt"]


def test_cold_start_progress_goes_to_stderr_and_stdout_stays_json(home: Path):
    install_fake_task(home / "bin")
    proc = run(
        ["ask", "--config-dir", str(home / "cfg")],
        REQUEST,
        env_for(
            home,
            PATH=f"{home / 'bin'}:/usr/bin:/bin",
            TASK_FAKE_LOG=str(home / "task.log"),
            TASK_FAKE_MODE="fail",
        ),
    )
    assert "starting it with `task classify-server start`" in proc.stderr
    assert [line["status"] for line in lines(proc)] == ["budget", "unavailable"]
    assert lines(proc)[-1]["reason"] == "autostart-failed"


def test_check_config_lists_diagnostics_with_lines(home: Path):
    path = home / "cfg" / "config.yaml"
    path.write_text("control:\n  enabled: true\nlaya:\n  autostart: perhaps\n")
    proc = run(["check-config", "--file", str(path)], "", env_for(home))
    assert json.loads(proc.stdout)["diagnostics"] == [
        {
            "line": 4,
            "severity": "error",
            "message": "laya.autostart must be true or false (got 'perhaps')",
        }
    ]
    assert json.loads(
        run(["check-config", "--file", str(home / "none.yaml")], "", env_for(home)).stdout
    ) == {"diagnostics": []}


def test_usage_error_exits_2(home: Path):
    proc = run(["frobnicate"], "", env_for(home))
    assert proc.returncode == 2 and "usage" in proc.stderr


def plant(directory: Path, marker: Path) -> None:
    """A `tgcli` package and a stdlib-shadowing `json.py` that leave `marker` when imported."""
    (directory / "tgcli").mkdir(parents=True)
    code = f"open({str(marker)!r}, 'w').write('planted code ran')\n"
    (directory / "tgcli" / "__init__.py").write_text(code)
    (directory / "json.py").write_text(code)


def test_launcher_ignores_a_planted_package_in_the_cwd_and_on_pythonpath(home: Path):
    cwd, on_path = home / "hostile-cwd", home / "hostile-pythonpath"
    cwd.mkdir()
    plant(cwd, home / "cwd-ran")
    plant(on_path, home / "pythonpath-ran")
    (home / "cfg" / "config.yaml").write_text("laya:\n  autostart: perhaps\n")
    proc = run(
        ["check-config", "--file", str(home / "cfg" / "config.yaml")],
        "",
        env_for(home, PYTHONPATH=str(on_path), PYTHONSAFEPATH=""),
        cwd=cwd,
    )
    assert proc.stderr == ""
    # The real package from <repo>/src answered: its diagnostic names the bad value.
    assert "laya.autostart must be true or false" in proc.stdout
    assert not (home / "cwd-ran").exists()
    assert not (home / "pythonpath-ran").exists()


def test_without_isolation_the_same_plant_would_run(home: Path):
    # Mutation check of the test above: plain `python3 <launcher>` (no -I) imports the planted
    # json.py from the script directory's neighbours via PYTHONPATH, so the plant is a real attack.
    on_path = home / "hostile-pythonpath"
    plant(on_path, home / "pythonpath-ran")
    subprocess.run(
        [sys.executable, LAUNCHER, "check-config", "--file", str(home / "none.yaml")],
        capture_output=True,
        timeout=60,
        env={"PATH": "/usr/bin:/bin", "PYTHONPATH": str(on_path)},
    )
    assert (home / "pythonpath-ran").exists()
