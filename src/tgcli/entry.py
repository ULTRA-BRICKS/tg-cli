"""Facade of the strangler port: one entry per TS entrypoint, ported handlers or fall-through.

Spec §2.2. Sections: handler protocol, the subcommand and daemon tables, fall-through to the
TypeScript, implementation selection, dispatch, console scripts and `--self-check`.
"""

import importlib
import os
import shutil
import sys
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import NoReturn

from tgcli.version import repo_root

# --- Handler protocol -------------------------------------------------------------------------


@dataclass(frozen=True)
class Decline:
    """This argv is a message to send, not my subcommand. `argv` rewrites what the default
    handler receives (the TS argv rewrites); None means the full original argv."""

    argv: list[str] | None = None


DECLINE = Decline()

Handler = Callable[[list[str]], int | Decline]

# --- Tables -----------------------------------------------------------------------------------

DEFAULT = "*"  # "not a subcommand": the send path of `tg`, the whole of `call-cli`

# tg-ctl tokens that run in Python only when the `tg-ctl-daemon` selection is `py` and a handler
# exists. `usage-schedule-check` is the entry of the launchd job `usage-schedule enable`
# installs, so it must follow the daemon selection, not the client one.
DAEMON_TOKENS = frozenset({"run", "start", "restart", "auto-continue-once", "usage-schedule-check"})

# First-token subcommands of each TS entrypoint.
SUBCOMMANDS: dict[str, frozenset[str]] = {
    "tg": frozenset(
        {
            "install-skill",
            "auth",
            "call",
            "user",
            "hooks",
            "voice",
            "help",
            "obligations",
            "report",
            "replies",
        }
    ),
    "tg-ctl": frozenset(
        {
            "start",
            "run",
            "status",
            "audit-delivery",
            "inbox",
            "stop",
            "restart",
            "enable",
            "disable",
            "usage-schedule",
            "ask",
            "withdraw",
            "omp-live",
            "alert",
            "install-hooks",
            "voice-setup",
            "harness-event",
            "codex-usage-hook",
            "usage-schedule-check",
            "auto-continue-once",
        }
    ),
    "call-cli": frozenset(),
}

# token (or DEFAULT) -> lazy "module:function"; imported only when dispatched.
HANDLERS: dict[str, dict[str, str]] = {"tg": {}, "tg-ctl": {}, "call-cli": {}}

# --- Fall-through to the TypeScript -----------------------------------------------------------

NOT_PORTED_EXIT = 70
EXEC_NOT_FOUND_EXIT = 127  # shell convention: command not found
EXEC_FAILED_EXIT = 126  # found but not executable


def _home(env: Mapping[str, str]) -> Path:
    return Path(env["HOME"]) if env.get("HOME") else Path.home()


def resolve_bun(env: Mapping[str, str]) -> str:
    return env.get("TG_BUN") or shutil.which("bun") or str(_home(env) / ".bun" / "bin" / "bun")


def fall_through(entrypoint: str, argv: list[str], env: Mapping[str, str]) -> int:
    """Exec the TS entrypoint of this checkout; with TG_NO_TS_FALLBACK=1 exit 70 instead."""
    if env.get("TG_NO_TS_FALLBACK") == "1":
        token = argv[0] if argv and argv[0] in SUBCOMMANDS[entrypoint] else "<send>"
        print(f"{entrypoint}: not ported yet: {token}", file=sys.stderr)
        return NOT_PORTED_EXIT
    bun = resolve_bun(env)
    sys.stdout.flush()
    sys.stderr.flush()
    try:
        os.execvpe(bun, [bun, str(repo_root() / entrypoint), *argv], dict(env))
    except OSError as error:
        print(f"{entrypoint}: cannot run bun ({bun}): {error.strerror or error}", file=sys.stderr)
        return EXEC_NOT_FOUND_EXIT if isinstance(error, FileNotFoundError) else EXEC_FAILED_EXIT
    return NOT_PORTED_EXIT  # only reached when execvpe is replaced (tests)


# --- Implementation selection -----------------------------------------------------------------


def daemon_impl(env: Mapping[str, str]) -> str:
    """`TG_IMPL_TG_CTL_DAEMON`, then `TG_IMPL`, then state file `impl/tg-ctl-daemon`, else ts."""
    for name in ("TG_IMPL_TG_CTL_DAEMON", "TG_IMPL"):
        if env.get(name):
            return env[name]
    try:
        return (_home(env) / ".local/state/tg-cli/impl/tg-ctl-daemon").read_text().strip() or "ts"
    except (OSError, ValueError):  # unreadable or invalid UTF-8: the default selection
        return "ts"


# --- Dispatch ---------------------------------------------------------------------------------


def _load(reference: str) -> Handler:
    module_name, _, function = reference.partition(":")
    handler: Handler = getattr(importlib.import_module(module_name), function)
    return handler


def _daemon_goes_to_ts(entrypoint: str, token: str, env: Mapping[str, str]) -> bool:
    if entrypoint != "tg-ctl" or token not in DAEMON_TOKENS:
        return False
    return daemon_impl(env) != "py" or token not in HANDLERS[entrypoint]


def dispatch(entrypoint: str, argv: list[str], env: Mapping[str, str]) -> int:
    handlers = HANDLERS[entrypoint]
    is_subcommand = bool(argv) and argv[0] in SUBCOMMANDS[entrypoint]
    token = argv[0] if is_subcommand else DEFAULT

    if _daemon_goes_to_ts(entrypoint, token, env):
        # The daemon is switched by its own selection, never by the parity harness flag: the
        # filtered env is what the exec'd TS daemon (and its children) inherit.
        return fall_through(
            entrypoint, argv, {k: v for k, v in env.items() if k != "TG_NO_TS_FALLBACK"}
        )
    if token not in handlers:
        return fall_through(entrypoint, argv, env)

    result = _load(handlers[token])(argv[1:] if is_subcommand else argv)
    if not isinstance(result, Decline):
        return result
    if DEFAULT not in handlers or token == DEFAULT:
        return fall_through(entrypoint, argv, env)
    fallback = _load(handlers[DEFAULT])(argv if result.argv is None else result.argv)
    return fall_through(entrypoint, argv, env) if isinstance(fallback, Decline) else fallback


# --- Console scripts and --self-check ---------------------------------------------------------


def tg() -> NoReturn:
    sys.exit(dispatch("tg", sys.argv[1:], os.environ))


def tg_ctl() -> NoReturn:
    sys.exit(dispatch("tg-ctl", sys.argv[1:], os.environ))


def call_cli() -> NoReturn:
    sys.exit(dispatch("call-cli", sys.argv[1:], os.environ))


def self_check(entrypoint: str) -> int:
    """Import every registered handler of `entrypoint`; used by `tg-impl` before a flip."""
    for token, reference in HANDLERS[entrypoint].items():
        try:
            _load(reference)
        except Exception as error:
            print(
                f"{entrypoint}: handler {token!r} ({reference}) unusable: {error!r}",
                file=sys.stderr,
            )
            return 1
    return 0


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[0] == "--self-check" and argv[1] in HANDLERS:
        return self_check(argv[1])
    print("usage: python -m tgcli.entry --self-check <tg|tg-ctl|call-cli>", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
