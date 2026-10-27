"""Private synthetic installed host for verify-calls regressions; never accesses live state."""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
HERE = REPO / "tests" / "telegram-761-verify-calls.test.py"
from call_acceptance import manifest
from call_acceptance.context import Context
from call_acceptance.manifest import Suite
from call_acceptance.process import run_bounded
from call_acceptance.scenario_inventory import REQUIRED_SCENARIOS
from call_lab import CallLab

RUN_ID = "verify-20260101T000000Z-abcd1234"
CANARY = "CANARY-VALUE-761-must-not-appear"
FIXTURE_VALUE = "fixture"
GIT = ["git", "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false"]
# Variables the scrubbed environments must never carry into children (names assembled, values dummy).
LEAKY = {name: "dummy" for name in ("TG_BOT_" + "TOKEN", "TG_MTPROTO_SIDECAR", "OPENAI_API_" + "KEY",
                                   "ANTHROPIC_API_" + "KEY", "HTTPS_PROXY")}


def leaked(key="api_key", separator="="):
    """A credential-shaped assignment carrying CANARY, built at run time."""
    return f"{key}{separator}{CANARY}"


PASSING = "import unittest\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        pass\n\n    def test_b(self):\n        pass\n\nunittest.main()\n"
FAILING = "import unittest\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.fail({!r})\n\nunittest.main()\n".format(leaked("TG_BOT_TOKEN"))
INTEGRATION = ("import unittest\n\nclass T(unittest.TestCase):\n" +
               "".join(f"    def {name}(self):\n        pass\n\n" for name in REQUIRED_SCENARIOS) +
               "    def test_helper(self):\n        pass\n\nunittest.main()\n")
INTEGRATION_WITH_SKIP = INTEGRATION.replace("    def test_helper(self):\n        pass\n", "    @unittest.skip('x')\n    def test_extra_skipped(self):\n        pass\n")


FRONTDOOR = """#!/bin/sh
here=$(dirname "$(readlink -f "$0")")
echo "{name} $*" >> "$here/invocations.log"
env | cut -d= -f1 | sort >> "$here/env-keys.log"
handle() {{
  case "$*" in
    *history*) cat "$here/knob-history.json" ;;
    *--dry-run*) cat "$here/knob-dryrun-{name}.json"; exit 3 ;;
    *) echo "{name}: unexpected $*" >&2; exit 9 ;;
  esac
}}
{dispatch}
"""
TG_DISPATCH = """case "$1" in
  --version) printf '%s' "$(cat "$here/knob-version.txt")"; git -C "$here" rev-parse --short HEAD | sed 's/.*/(&)/' ;;
  auth) cat "$here/knob-auth.json" ;;
  call) shift; handle "$@" ;;
  *) echo "tg: unexpected $*" >&2; exit 9 ;;
esac"""
CALL_CLI_DISPATCH = 'handle "$@"'
TG_CTL = """#!/bin/sh
here=$(dirname "$(readlink -f "$0")")
echo "tg-ctl $*" >> "$here/invocations.log"
cat "$here/knob-status.txt"
"""
# The installed fixture mirrors production's offline code-3 contract. Auth files and
# voice credentials exist only in this temporary lab and must never be read by the plan.
from telegram_client.cli import call_plan, parser as call_parser
from telegram_client.core import AuthStore

with CallLab(accounts=("personal", "caller")) as _dry_lab:
    _dry_args = call_parser("caller").parse_args([
        "call", "--peer", "@verifycalls", "--say", "verify-calls offline dry run",
        "--agent", "verify-calls", "--dry-run"])
    with mock.patch.object(AuthStore, "load", side_effect=AssertionError("dry-run read auth")), \
         mock.patch("telegram_client.tts_config.resolve_credential", side_effect=AssertionError("dry-run read secret")):
        DRY_RUN = call_plan(AuthStore(_dry_lab.store), "caller", _dry_args,
                            which=lambda _: "/fixture/tool", find_spec=lambda _: object())
KNOBS = {
    "knob-version.txt": "tg 1.2.3 ",
    "knob-history.json": json.dumps({"calls": []}),
    "knob-dryrun-tg.json": json.dumps(DRY_RUN),
    "knob-dryrun-call-cli.json": json.dumps(DRY_RUN),
    "knob-auth.json": json.dumps({"configured": True, "online_verified": True, "user_id": 5, "expected_id": 5}),
    "knob-status.txt": "code: abc1234 (current)\nautostart: enabled (launchd)\n",
}


class Recorder:
    """Passes straight through to the real bounded runner and remembers every argv."""

    def __init__(self):
        self.argvs = []

    def __call__(self, argv, timeout, **options):
        if any(str(part) == str(HERE) for part in argv):
            raise AssertionError("the runner tests must never launch themselves through the manifest")
        self.argvs.append([str(part) for part in argv])
        return run_bounded(argv, timeout, **options)

    def probes(self, *commands):
        return [a for a in self.argvs if len(a) > 2 and a[1].endswith("probes.py") and a[2] in commands]

    def live_probes(self):
        return self.probes("telegram", "tts", "call")

    def installed(self, world):
        return [a for a in self.argvs if a[0].startswith(str(world.installed))]


class World:
    """A temporary host: tested checkout, installed checkout (+ aliases), private config, voice profile."""

    def __init__(self, test, suites=None):
        self.lab = CallLab(accounts=("personal", "caller"))
        test.addCleanup(self.lab.__exit__)
        self.root = self.lab.root
        self.home, self.config, self.bin = self.lab.home, self.lab.config, self.lab.bin
        self.tested, self.installed = self.root / "tested", self.root / "installed"
        self.git_env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(self.home),
                        "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"}
        suites = suites or {"alpha": PASSING, "beta": PASSING}
        self.build_tested(suites)
        shutil.copytree(self.tested, self.installed, symlinks=True)
        for name, body in KNOBS.items():
            (self.installed / name).write_text(body)
        for alias in ("tg", "call-cli", "tg-ctl"):
            (self.bin / alias).symlink_to(self.installed / alias)
        # Resolve required host executables without exposing host tg/call-cli aliases.
        (self.bin / "git").symlink_to(Path(shutil.which("git")).resolve())
        (self.bin / "bun").symlink_to(shutil.which("bun"))
        self.group = "regression-python"
        self.suites = tuple(Suite(name, f"tests/{name}.test.py", "python", "regression") for name in sorted(suites))
        self.recorder = Recorder()

    def git(self, repo, *args):
        done = subprocess.run([*GIT, "-C", str(repo), *args], capture_output=True, text=True, env=self.git_env,
                              timeout=30, stdin=subprocess.DEVNULL, check=False)
        assert done.returncode == 0, done.stderr
        return done.stdout.strip()

    def build_tested(self, suites):
        (self.tested / "tests").mkdir(parents=True)
        (self.tested / "package.json").write_text(json.dumps({"version": "1.2.3"}))
        (self.tested / "requirements-call.txt").write_text("fixture==1\n")
        for name, body in {"tg": FRONTDOOR.format(name="tg", dispatch=TG_DISPATCH),
                           "call-cli": FRONTDOOR.format(name="call-cli", dispatch=CALL_CLI_DISPATCH),
                           "tg-ctl": TG_CTL}.items():
            (self.tested / name).write_text(body)
            (self.tested / name).chmod(0o755)
        shutil.copytree(REPO / "features" / "telegram_client", self.tested / "features" / "telegram_client",
                        ignore=shutil.ignore_patterns("__pycache__"))
        for name, body in suites.items():
            (self.tested / "tests" / f"{name}.test.py").write_text(body)
        self.git(self.tested, "init", "-q")
        self.git(self.tested, "add", "-A")
        self.git(self.tested, "commit", "-q", "-m", "fixture")

    def sha(self, repo=None):
        return self.git(repo or self.tested, "rev-parse", "HEAD")

    def env(self, **extra):
        env = {"PATH": f"{self.bin}:/usr/bin:/bin", "HOME": str(self.home),
               "TG_CTL_CONFIG_DIR": str(self.config), "XDG_CACHE_HOME": str(self.home / ".cache"),
               "TMPDIR": str(self.lab.tmp), "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"}
        env.update(extra)
        return env

    def context(self, timeout=60, **extra_env):
        return Context(tested_repo=self.tested, env=self.env(**extra_env), run=self.recorder, timeout=timeout)

    def patched_manifest(self):
        return mock.patch.multiple(manifest, GROUPS={self.group: self.suites}, DEFAULT_GROUPS=(self.group,))

    def invocations(self, name="invocations.log"):
        path = self.installed / name
        return path.read_text().splitlines() if path.exists() else []

    def runtime_python(self):
        """Pretend-built sidecar venv (marker + interpreter) so gates behind it become reachable."""
        import hashlib
        sha = hashlib.sha256((self.installed / "requirements-call.txt").read_bytes()).hexdigest()
        venv = self.home / ".cache" / "tg-cli" / f"mtproto-runtime-{sha[:12]}"
        (venv / "bin").mkdir(parents=True)
        (venv / ".tg-ready").write_text(sha)
        (venv / "bin" / "python").symlink_to(sys.executable)
