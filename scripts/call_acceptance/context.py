"""Runner context: every host interaction is an injectable function so tests need no live host."""
import hashlib
import os
import platform
import shutil
import sys
from pathlib import Path

from .process import run_bounded

SCRIPTS = Path(__file__).resolve().parent.parent
TESTED_REPO = SCRIPTS.parent
SAFE_ENV_KEYS = ("PATH", "HOME", "LANG", "LC_ALL", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "TG_CTL_CONFIG_DIR",
                 "TMPDIR", "USER", "LOGNAME")


def installed_env(base=None):
    """Environment for the INSTALLED frontdoors: only what they need to find their own state.

    No sidecar override, bot token, provider credential or proxy is ever inherited, so a
    deployed check exercises the real runtime and can neither use nor leak them.
    """
    base = os.environ if base is None else base
    return {key: base[key] for key in SAFE_ENV_KEYS if key in base}


DIGEST_FILES = ("tg", "call-cli", "tg-call", "tg-mtproto", "tg-ctl", "package.json", "requirements-call.txt")
DIGEST_TREES = (("features/telegram_client", "*.py"), ("features/user-account", "*.ts"))


def code_digest(repo):
    """SHA-256 over the call surface's actual file bytes (frontdoors, daemon, sidecar, service).

    Distinct from the git commit: it describes the code that would run, uncommitted edits
    included, so tested and installed trees can be told apart even when HEAD is equal.
    """
    repo = Path(repo)
    names = [name for name in DIGEST_FILES if (repo / name).is_file()]
    for tree, pattern in DIGEST_TREES:
        names += [str(path.relative_to(repo)) for path in sorted((repo / tree).rglob(pattern))
                  if "__pycache__" not in path.parts and path.is_file()]
    return _file_digest(repo, names)


def verification_digest(repo):
    """Hash the runner, manifest, test and fixture bytes, including uncommitted additions."""
    repo = Path(repo)
    paths = [repo / "scripts" / "verify-calls.py"]
    for tree in ("scripts/call_acceptance", "tests"):
        paths.extend(path for path in (repo / tree).rglob("*") if path.suffix in (".py", ".ts"))
    names = [str(path.relative_to(repo)) for path in paths if path.is_file() and "__pycache__" not in path.parts]
    return _file_digest(repo, names)


def _file_digest(repo, names):
    digest = hashlib.sha256()
    for name in sorted(set(names)):
        digest.update(name.encode() + b"\0" + hashlib.sha256((repo / name).read_bytes()).digest())
    return digest.hexdigest() if names else None


class Context:
    def __init__(self, *, tested_repo=TESTED_REPO, env=None, run=run_bounded, which=shutil.which,
                 timeout=120, python=None, config_dir=None):
        self.tested_repo = Path(tested_repo)
        self.env = dict(os.environ if env is None else env)
        self.run = run
        self.which = lambda name: which(name, path=self.env.get("PATH"))
        self.timeout = timeout
        self.python = python or sys.executable
        home = Path(self.env.get("HOME") or Path.home())
        self.home = home
        self.config_dir = Path(config_dir or self.env.get("TG_CTL_CONFIG_DIR") or home / ".config" / "tg-cli")
        if config_dir:
            # Installed tools and probes inherit this env: one default store for every check.
            self.env["TG_CTL_CONFIG_DIR"] = str(self.config_dir)
        self.deployed_repo = None
        self.tested_sha = None
        self.tts_work = None
        self.tts_result = None
        self.calls_attempted = 0
        self.deployed_sha = None
        self.deployed_version = None
        self.deployed_digest = None

    def interpreter(self):
        return {"executable": self.python, "version": platform.python_version(),
                "implementation": platform.python_implementation()}

    def bun_version(self):
        outcome = self.run(["bun", "--version"], 20, env=installed_env(self.env))
        return outcome.stdout.strip()[:40] if outcome.code == 0 and not outcome.timed_out else None

    def git(self, repo, *args):
        outcome = self.run(["git", "-C", str(repo), *args], 20, env=installed_env(self.env))
        if outcome.code != 0 or outcome.timed_out:
            return None
        return outcome.stdout.strip()
