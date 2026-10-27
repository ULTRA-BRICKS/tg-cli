"""Exercise the real installed shims against isolated runtime executables."""

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class Sandbox(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.repo = self.home / "checkout with spaces"
        self.repo.mkdir()
        for directory in ("bin", "scripts", ".venv/bin", "tests/parity", "fakebin"):
            (self.repo / directory).mkdir(parents=True)
        for name in ("tg", "tg-ctl", "call-cli"):
            source = ROOT / "bin" / name
            if source.exists():
                shutil.copy2(source, self.repo / "bin" / name)
        source = ROOT / "scripts/tg-impl"
        if source.exists():
            shutil.copy2(source, self.repo / "scripts/tg-impl")
        self.env = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith("TG_IMPL")
            and key
            not in ("XDG_CONFIG_HOME", "XDG_STATE_HOME", "TG_BUN", "TG_CTL_CONFIG_DIR")
        }
        self.env.update(
            HOME=str(self.home),
            PATH=str(self.repo / "fakebin") + ":/usr/bin:/bin",
            TEST_REPO=str(self.repo),
            TEST_LOG=str(self.home / "log"),
        )
        self.executable(
            "fakebin/bun",
            "#!/usr/bin/env python3\nimport json,sys\nprint(json.dumps(sys.argv[1:]))\n",
        )
        self.executable(".venv/bin/python", "#!/bin/sh\nexit 0\n")
        for name in ("tg", "tg-ctl", "call-cli"):
            self.executable(
                ".venv/bin/" + name,
                '#!/usr/bin/env python3\nimport json,sys\nprint(json.dumps(["py"]+sys.argv[1:]))\n',
            )

    def executable(self, path, contents):
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(contents)
        target.chmod(0o755)
        return target

    def state(self, name, value):
        path = self.home / ".local/state/tg-cli/impl" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value + "\n")
        return path

    def run_command(self, path, *args):
        # Missing artifacts report an assertion failure in the initial red run.
        self.assertTrue(path.is_file(), "implementation artifact missing: " + str(path))
        return subprocess.run(
            [str(path), *args],
            env=self.env,
            capture_output=True,
            check=False,
            text=True,
            timeout=40,
        )

    def shim(self, *args, name="tg"):
        return self.run_command(self.repo / "bin" / name, *args)


class SwitchTests(Sandbox):
    def test_shim_default_is_ts(self):
        result = self.shim("hello", "я😀", "")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout), [str(self.repo / "tg"), "hello", "я😀", ""]
        )

    def test_shim_state_file_py(self):
        self.state("tg", "  py  \nts")
        self.assertEqual(json.loads(self.shim("--version").stdout), ["py", "--version"])

    def test_shim_ignores_xdg_state_home(self):
        self.env["XDG_STATE_HOME"] = str(self.home / "other")
        other = self.home / "other/tg-cli/impl"
        other.mkdir(parents=True)
        (other / "tg").write_text("py")
        self.test_shim_default_is_ts()

    def test_shim_env_beats_state(self):
        self.state("tg", "py")
        self.env["TG_IMPL"] = "ts"
        self.test_shim_default_is_ts()

    def test_shim_per_entry_env_beats_global(self):
        self.env.update(TG_IMPL="ts", TG_IMPL_CALL_CLI="py")
        self.assertEqual(
            json.loads(self.shim("peer", name="call-cli").stdout), ["py", "peer"]
        )

    def test_shim_unknown_selection_exit_64(self):
        self.env["TG_IMPL_TG"] = "wat"
        result = self.shim()
        self.assertEqual(result.returncode, 64)
        self.assertIn(
            "tg: unknown implementation 'wat' (from env:TG_IMPL_TG); expected py or ts",
            result.stderr,
        )

    def test_shim_missing_venv(self):
        self.env["TG_IMPL"] = "py"
        (self.repo / ".venv/bin/tg").unlink()
        result = self.shim()
        self.assertEqual(result.returncode, 71)
        self.assertIn("roll back with: tg-impl use ts tg", result.stderr)
        self.assertIn(str(self.repo / "scripts/tg-impl"), result.stderr)

    def test_shim_dangling_interpreter(self):
        self.env["TG_IMPL"] = "py"
        path = self.repo / ".venv/bin/python"
        path.unlink()
        path.symlink_to(self.home / "removed-python")
        self.assertEqual(self.shim().returncode, 71)

    def test_shim_through_symlink(self):
        link = self.home / ".local/bin/tg"
        link.parent.mkdir(parents=True)
        link.symlink_to(self.repo / "bin/tg")
        result = self.run_command(link, "hello")
        self.assertEqual(json.loads(result.stdout), [str(self.repo / "tg"), "hello"])

    def test_shim_bun_fallback_path(self):
        (self.repo / "fakebin/bun").unlink()
        target = self.home / ".bun/bin/bun"
        target.parent.mkdir(parents=True)
        target.write_text('#!/bin/sh\nprintf "fallback\\n"\n')
        target.chmod(0o755)
        self.assertEqual(self.shim().stdout, "fallback\n")


if __name__ == "__main__":
    unittest.main()
