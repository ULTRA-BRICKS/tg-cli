"""Hermetic lab for the #761 call integration suite and the acceptance runner.

Builds a throwaway HOME/config (fake credentials ONLY here), runs the REAL `tg call` / `call-cli`
Bun frontdoors against `call_fixture_sidecar.py` and exposes what the fake external boundaries
recorded. Importable: no test discovery, no runner, no sys.path mutation, no network.
"""
import importlib.util
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from contextlib import closing
from pathlib import Path

# TG_CALL_REPO points the lab at another checkout (mutation controls, a deployed tree).
REPO = Path(os.environ.get("TG_CALL_REPO") or Path(__file__).resolve().parents[2])
SUPPORT = Path(__file__).resolve().parent
FIXTURE = SUPPORT / "call_fixture_sidecar.py"
ACCOUNTS = {"personal": 1001, "caller": 2002}
USERS = {"alice": 3003, "bobby": 4004, "owner": 1001}
FISH_KEY = "FAKE-FISH-KEY-761-not-a-credential"
VOICE_ID = "ab" * 16
MODEL = "fixture-model-761"
SESSION_ID = "fish-entry"

SHIMS = {
    "ps": ("#!/bin/sh\ncase \"$*\" in\n"
           "  \"-axo pid=,ppid=,command=\") printf '%s\\n' '    1     0 /sbin/init' ;;\n"
           "  \"-axo pid=,tty=\") printf '%s\\n' '    1 ??' ;;\n"
           "  *) for real in /bin/ps /usr/bin/ps; do [ -x \"$real\" ] && exec \"$real\" \"$@\"; done; exit 127 ;;\n"
           "esac\n"),
    "launchctl": "#!/bin/sh\n[ \"$1\" = list ] && printf 'PID\\tStatus\\tLabel\\n'\nexit 0\n",
    "pgrep": "#!/bin/sh\nexit 1\n",
    "tmux": "#!/bin/sh\necho 'no server running' >&2\nexit 1\n",
}
HOST_ENGINES = ("say", "espeak-ng", "espeak")
_PROCESS = Path(__file__).resolve().parents[2] / "scripts" / "call_acceptance" / "process.py"


def _bounded_runner():
    """The runner's `run_bounded` (own session, whole-group cleanup), loaded by path: no sys.path edits."""
    if "call_acceptance" not in sys.modules:
        package = importlib.util.spec_from_file_location("call_acceptance", _PROCESS.parent / "__init__.py",
                                                       submodule_search_locations=[str(_PROCESS.parent)])
        module = importlib.util.module_from_spec(package)
        sys.modules["call_acceptance"] = module
        package.loader.exec_module(module)
    spec = importlib.util.spec_from_file_location("call_acceptance.process", _PROCESS)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.run_bounded


def run_bounded_checked(argv, timeout, *, env, cwd, input=None):
    """Noninteractive lab invocation: stdin is closed (DEVNULL) unless `input` is given, the whole
    process group is ended on timeout, and a timeout is a loud failure rather than a hang."""
    outcome = _bounded_runner()(argv, timeout, env=env, cwd=cwd, input=input)
    if outcome.timed_out:
        raise AssertionError(f"lab command exceeded {timeout}s and its process group was ended: {argv[1:]}")
    if outcome.error:
        raise AssertionError(f"lab command could not start: {outcome.error}")
    return subprocess.CompletedProcess(argv, outcome.code, outcome.stdout, outcome.stderr)


class Run:
    def __init__(self, argv, completed):
        self.argv = argv
        self.code = completed.returncode
        self.stdout = completed.stdout
        self.stderr = completed.stderr

    @property
    def result(self):
        """The sidecar's JSON result: `--json` prints it raw (last non-empty line)."""
        lines = [line for line in self.stdout.splitlines() if line.strip()]
        return json.loads(lines[-1]) if lines else None


class CallLab:
    def __init__(self, *, voice=True, credential=True, accounts=("personal", "caller")):
        self._temporary = tempfile.TemporaryDirectory(prefix="tg-call-lab-")
        self.root = Path(os.path.realpath(self._temporary.name))
        self.home = self.root / "home"
        self.config = self.root / "config"
        self.store = self.config / "mtproto"
        self.control = self.root / "control"
        self.bin = self.root / "bin"
        self.tmp = self.root / "tmp"
        for directory in (self.home, self.control, self.bin, self.tmp):
            directory.mkdir(mode=0o700)
        self.config.mkdir(mode=0o700)
        self.store.mkdir(mode=0o700)
        self.plan = {"users": dict(USERS), "bots": [], "fish_key": FISH_KEY, "provider": "ok", "dial": "ok"}
        self._write_shims()
        for role in accounts:
            self.write_session(role)
        if voice:
            self.write_voice(credential=credential)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self._temporary.cleanup()

    # --- fixtures -------------------------------------------------------------------------
    def _write_shims(self):
        for name, body in SHIMS.items():
            self._executable(self.bin / name, body)
        for name in HOST_ENGINES:
            self._executable(self.bin / name, f"#!/bin/sh\necho {name} \"$@\" >> '{self.control}/host-engine.log'\nexit 1\n")

    @staticmethod
    def _executable(path, body):
        path.write_text(body)
        path.chmod(0o755)

    def write_session(self, role, expected_id=None, origin="login"):
        account = ACCOUNTS[role] if expected_id is None else expected_id
        path = self.store / (role + ".json")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as out:
            json.dump({"expected_id": account, "api_id": 12345, "api_hash": "fake-api-hash-761",
                       "session": f"FAKE-SESSION-{ACCOUNTS[role]}", "origin": origin}, out)

    def write_voice(self, credential=True, domain="fish_audio"):
        entries = self.config / "ha-entries.json"
        if credential:
            self._private(entries, json.dumps({"data": {"entries": [
                {"entry_id": SESSION_ID, "domain": domain, "data": {"api_key": FISH_KEY}}]}}))
        self._private(self.config / "voice.json", json.dumps({
            "version": 1, "provider": "fish_audio", "model": MODEL, "voice_id": VOICE_ID,
            "latency": "balanced", "format": "wav",
            "credential_source": {"type": "home_assistant", "path": str(entries), "entry_id": SESSION_ID}}))

    @staticmethod
    def _private(path, text):
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as out:
            out.write(text)

    def raw_audio(self, name="raw.wav", duration_ms=1200):
        """A generated two-tone WAV the caller supplies with --audio (never checked in)."""
        import sys
        sys.path.insert(0, str(SUPPORT))
        try:
            import wav_tools
        finally:
            sys.path.remove(str(SUPPORT))
        return wav_tools.write_tones(self.root / name, (1000, 1500), duration_ms)

    # --- running ----------------------------------------------------------------------------
    def environment(self, extra=None):
        env = {
            "PATH": f"{self.bin}:{os.environ.get('PATH', '/usr/bin:/bin')}",
            "HOME": str(self.home), "XDG_CACHE_HOME": str(self.home / ".cache"),
            "TMPDIR": str(self.tmp), "TMUX_TMPDIR": str(self.root / "tmux"),
            "LC_ALL": "C.UTF-8", "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1",
            "TG_CTL_CONFIG_DIR": str(self.config), "TG_MTPROTO_SIDECAR": str(FIXTURE),
            "TG_FIXTURE_DIR": str(self.control), "TG_BOT_TOKEN": "1:bot-token-must-not-leak",
            "PYTHONPATH": str(REPO / "features"), "TG_LAYA": "0", "TG_SEND_RETRY_BUDGET_MS": "0",
        }
        env.update(extra or {})
        return env

    def run(self, frontdoor, args, *, plan=None, stdin=None, env=None, timeout=90):
        """Run `tg call <args>` or `call-cli <args>`; every plan change is written first."""
        (self.control / "plan.json").write_text(json.dumps({**self.plan, **(plan or {})}))
        script = {"tg": [str(REPO / "tg"), "call"], "call-cli": [str(REPO / "call-cli")]}[frontdoor]
        bun = shutil.which("bun")
        argv = [bun, *script, *args]
        completed = run_bounded_checked(argv, timeout, env=self.environment(env), cwd=str(self.root), input=stdin)
        return Run(argv, completed)

    def sidecar(self, args, *, plan=None, stdin=None, timeout=60):
        """Invoke the fixture sidecar directly with its own argv (what a frontdoor spawns)."""
        (self.control / "plan.json").write_text(json.dumps({**self.plan, **(plan or {})}))
        argv = [str(FIXTURE), *args]
        completed = run_bounded_checked(argv, timeout, env=self.environment(), cwd=str(self.root), input=stdin)
        return Run(argv, completed)

    # --- observations -----------------------------------------------------------------------
    def effects(self, *kinds):
        path = self.control / "effects.jsonl"
        rows = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
        return [row for row in rows if not kinds or row["kind"] in kinds]

    def mark(self):
        """Index to pass to `since` so a scenario only looks at its own effects."""
        return len(self.effects())

    def since(self, mark, *kinds):
        return [row for row in self.effects()[mark:] if not kinds or row["kind"] in kinds]

    def chats(self):
        path = self.control / "chats.json"
        return json.loads(path.read_text()) if path.exists() else {}

    def host_engine_calls(self):
        path = self.control / "host-engine.log"
        return path.read_text().splitlines() if path.exists() else []

    def history(self, frontdoor="tg", *flags):
        run = self.run(frontdoor, ["history", "list", "--json", *flags])
        if run.code != 0:
            raise AssertionError(f"history failed: {run.stdout!r} {run.stderr!r}")
        return run.result["calls"]

    def journal_path(self):
        return self.store / "calls" / "journal.sqlite3"

    def journal_rows(self):
        with closing(sqlite3.connect(self.journal_path().as_uri() + "?mode=ro", uri=True)) as db:
            rows = [json.loads(row[0]) for row in db.execute("SELECT data FROM calls ORDER BY created")]
            for row in rows:
                row["transitions"] = [{"at": at, "status": status} for at, status in db.execute(
                    "SELECT at, status FROM events WHERE call_id=? ORDER BY rowid", (row["call_id"],))]
            return rows

    def tree(self, root=None):
        """(relative path -> (mode, size, mtime_ns)) for a no-write comparison."""
        root = root or self.config
        return {str(p.relative_to(root)): (p.lstat().st_mode, p.lstat().st_size, p.lstat().st_mtime_ns)
                for p in sorted(root.rglob("*"))}

    def leftover_audio_dirs(self):
        return sorted(p.name for p in self.tmp.glob("tg-call-*"))
