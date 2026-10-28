"""`tg-remote config check`: the single judge of control.server / machine / remote_machines."""

from pathlib import Path

import pytest

from tgcli.remote import config as remote_config


def check(tmp_path: Path, control: str | None) -> dict[str, object]:
    if control is not None:
        (tmp_path / "config.yaml").write_text(f"control:\n{control}")
    return remote_config.check(tmp_path)


def test_no_config_file_and_no_keys_are_local(tmp_path):
    assert check(tmp_path, None) == {"ok": True, "mode": "local"}
    assert check(tmp_path, "  enabled: true\n  transport: tmux\n") == {"ok": True, "mode": "local"}


def test_client_mode(tmp_path):
    assert check(tmp_path, "  server: ssh://tg-ctl-ubuntu\n  machine: clvm\n") == {
        "ok": True,
        "mode": "client",
        "server": "ssh://tg-ctl-ubuntu",
        "alias": "tg-ctl-ubuntu",
        "machine": "clvm",
    }


def test_quoted_values_are_unquoted_like_the_ts_twin(tmp_path):
    result = check(tmp_path, "  server: 'ssh://h'\n  machine: \"clvm\"\n")
    assert result["ok"] is True and result["alias"] == "h" and result["machine"] == "clvm"


def test_hub_mode_lists_name_and_target(tmp_path):
    assert check(tmp_path, '  remote_machines: "clvm=ultra@65.21.40.51, lab=lab.example"\n') == {
        "ok": True,
        "mode": "hub",
        "remote_machines": [
            {"name": "clvm", "target": "ultra@65.21.40.51"},
            {"name": "lab", "target": "lab.example"},
        ],
    }


def test_empty_remote_machines_means_feature_off(tmp_path):
    assert check(tmp_path, '  remote_machines: ""\n') == {"ok": True, "mode": "local"}
    assert check(tmp_path, "  remote_machines:\n") == {"ok": True, "mode": "local"}


def test_eight_machines_are_allowed_nine_are_not(tmp_path):
    eight = ",".join(f"m{i}=h{i}" for i in range(8))
    assert check(tmp_path, f"  remote_machines: {eight}\n")["ok"] is True
    result = check(tmp_path, f"  remote_machines: {eight},m8=h8\n")
    assert result["ok"] is False
    assert any("remote-machines-too-many" in e for e in result["errors"])


REMOTE = "control.remote_machines"


@pytest.mark.parametrize(
    ("control", "rule", "key"),
    [
        ("  server: ssh://-oProxyCommand=x\n  machine: clvm\n", "server-format", "control.server"),
        ("  server: ssh://u@h\n  machine: clvm\n", "server-format", "control.server"),
        ("  server: ssh://h:22\n  machine: clvm\n", "server-format", "control.server"),
        ("  server: ssh://h/x\n  machine: clvm\n", "server-format", "control.server"),
        ("  server: SSH://h\n  machine: clvm\n", "server-format", "control.server"),
        ("  server: h\n  machine: clvm\n", "server-format", "control.server"),
        ('  server: ""\n  machine: clvm\n', "server-empty", "control.server"),
        ("  server: ssh://h\n", "machine-required", "control.machine"),
        ("  server: ssh://h\n  machine: Clvm\n", "machine-format", "control.machine"),
        ("  server: ssh://h\n  machine: 1clvm\n", "machine-format", "control.machine"),
        ("  server: ssh://h\n  machine: " + "a" * 33 + "\n", "machine-format", "control.machine"),
        ('  server: ssh://h\n  machine: ""\n', "machine-empty", "control.machine"),
        ("  machine: clvm\n", "server-required", "control.server"),
        ("  server: ssh://h\n  machine: clvm\n  remote_machines: a=b\n", "role-conflict", REMOTE),
        ("  machine: clvm\n  remote_machines: a=b\n", "role-conflict", REMOTE),
        ("  remote_machines: a=b,a=c\n", "remote-machines-duplicate", REMOTE),
        ("  remote_machines: a=b,,c=d\n", "remote-machines-empty-item", REMOTE),
        ("  remote_machines: a=b,\n", "remote-machines-empty-item", REMOTE),
        ("  remote_machines: a=b, \n", "remote-machines-empty-item", REMOTE),
        ("  remote_machines: a\n", "remote-machines-entry", REMOTE),
        ("  remote_machines: =host\n", "remote-machines-entry", REMOTE),
        ("  remote_machines: a=\n", "remote-machines-entry", REMOTE),
        ("  remote_machines: A=host\n", "remote-machines-entry", REMOTE),
        ("  remote_machines: a=-oProxyCommand=x\n", "remote-machines-entry", REMOTE),
        ("  remote_machines: a=-h\n", "remote-machines-entry", REMOTE),
        ("  remote_machines: a=u@h:22\n", "remote-machines-entry", REMOTE),
        ("  remote_machines: a=h;id\n", "remote-machines-entry", REMOTE),
        ("  remote_machines: a=h h\n", "remote-machines-entry", REMOTE),
        ("  remote_machines: a=u@h@x\n", "remote-machines-entry", REMOTE),
    ],
)
def test_bad_config_names_the_key_and_the_rule(tmp_path, control, rule, key):
    result = check(tmp_path, control)
    assert result["ok"] is False
    assert "mode" not in result
    errors = result["errors"]
    assert isinstance(errors, list) and errors
    assert any(e.startswith(key) and rule in e for e in errors), errors


def test_every_problem_is_reported_not_only_the_first(tmp_path):
    result = check(tmp_path, "  server: ssh://h:22\n  remote_machines: a=b,a=c\n")
    assert result["ok"] is False
    keys = {e.split(" ")[0].rstrip(":") for e in result["errors"]}
    assert {"control.server", "control.machine", REMOTE} <= keys


def test_other_blocks_and_unrelated_keys_do_not_leak_in(tmp_path):
    (tmp_path / "config.yaml").write_text(
        "other:\n  server: ssh://-bad\ncontrol:\n  enabled: true\n"
    )
    assert remote_config.check(tmp_path) == {"ok": True, "mode": "local"}


def test_resolution_exposes_typed_values_for_the_other_modules(tmp_path):
    def write(control: str) -> None:
        (tmp_path / "config.yaml").write_text(f"control:\n{control}")

    write("  server: ssh://box\n  machine: clvm\n")
    client = remote_config.resolve(tmp_path)
    assert (client.mode, client.alias, client.machine, client.errors) == (
        "client",
        "box",
        "clvm",
        (),
    )
    write("  remote_machines: clvm=ultra@h\n")
    hub = remote_config.resolve(tmp_path)
    assert hub.mode == "hub" and hub.machines == {"clvm": "ultra@h"}
    write("  server: nope\n")
    assert remote_config.resolve(tmp_path).mode == "invalid"


def test_config_dir_comes_from_the_environment(tmp_path):
    assert remote_config.config_dir({"TG_CTL_CONFIG_DIR": str(tmp_path)}) == tmp_path
    assert remote_config.config_dir({}) == Path.home() / ".config" / "tg-cli"
