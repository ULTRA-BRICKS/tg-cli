"""`python3 -I <repo>/tg-laya ask|check-config`: the wire the TypeScript `tg` calls.

ask:          stdin one JSON object {message, questions}; stdout JSON lines, the first
              {"status":"budget","total_ms":N} (the longest this call can take, so the caller can
              arm a kill timer without parsing config), the last
              {"status":"ok","line":...,"policy":...} or
              {"status":"unavailable","reason","detail","attempt","remedy","policy"}.
              Progress notes go to stderr, so a cold start is never a silent pause.
check-config: `--file config.yaml` -> one JSON list of {line, severity, message} for `laya:`.
"""

import json
import os
import sys
from collections.abc import Mapping

from tgcli.laya.ask import Ok, Unavailable, ask_laya, default_log
from tgcli.laya.config import LayaConfigError, LayaSettings, check_config_text, resolve_settings


def _emit(obj: Mapping[str, object]) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _read_config(directory: str) -> str:
    try:
        with open(os.path.join(directory, "config.yaml"), encoding="utf-8", errors="replace") as f:
            return f.read()
    except FileNotFoundError:
        return ""


def _total_ms(settings: LayaSettings) -> float:
    cold = settings.cold_timeout_sec * 1000 if settings.autostart and not settings.socket else 0
    return settings.warm_timeout_ms + cold


def _invalid_config(error: LayaConfigError) -> dict[str, object]:
    return {
        "status": "unavailable",
        "reason": "invalid-config",
        "detail": "; ".join(error.diagnostics),
        "attempt": "validated the laya: block of config.yaml and the TG_LAYA* environment",
        "remedy": "fix the setting named above (`tg config validate` shows the line numbers)",
        "policy": "fallback",
    }


def _failure(reason: str, detail: str, attempt: str, remedy: str, policy: str) -> dict[str, object]:
    return {
        "status": "unavailable",
        "reason": reason,
        "detail": detail,
        "attempt": attempt,
        "remedy": remedy,
        "policy": policy,
    }


def _result_json(result: Ok | Unavailable, policy: str) -> dict[str, object]:
    if isinstance(result, Ok):
        return {"status": "ok", "line": result.line, "policy": policy}
    return _failure(result.reason, result.detail, result.attempt, result.remedy, policy)


def _run_ask(config_dir: str) -> int:
    try:
        request = json.loads(sys.stdin.read())
        message, questions = request["message"], request["questions"]
        settings = resolve_settings(_read_config(config_dir), os.environ)
    except LayaConfigError as error:
        _emit({"status": "budget", "total_ms": 0})
        _emit(_invalid_config(error))
        return 0
    except (ValueError, KeyError, TypeError, OSError) as error:
        # A malformed request or an unreadable config.yaml: typed, never a traceback.
        _emit({"status": "budget", "total_ms": 0})
        _emit(
            _failure(
                "helper-failed",
                f"{type(error).__name__}: {error}",
                "read the request on stdin and config.yaml",
                "check that config.yaml is readable and run tg again",
                "fallback",
            )
        )
        return 0
    _emit({"status": "budget", "total_ms": _total_ms(settings)})
    policy = "required" if settings.required else "fallback"
    try:
        result = ask_laya(message, questions, settings, os.environ, default_log)
    except OSError as error:
        # State dir or lock the caller needs is unusable (read-only home, full disk, ...).
        result = Unavailable(
            "helper-failed",
            f"{type(error).__name__}: {error}",
            "asked Laya, then used the autostart state/lock files",
            "fix the permissions of ~/.local/state/tg-cli (or XDG_STATE_HOME) and run tg again",
        )
    _emit(_result_json(result, policy))
    return 0


def _run_check(path: str) -> int:
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read()
    except FileNotFoundError:
        text = ""
    diagnostics = [
        {"line": d.line, "severity": d.severity, "message": d.message}
        for d in check_config_text(text)
    ]
    _emit({"diagnostics": diagnostics})
    return 0


def _option(args: list[str], name: str) -> str | None:
    if name in args and args.index(name) + 1 < len(args):
        return args[args.index(name) + 1]
    return None


def main(args: list[str]) -> int:
    if args[:1] == ["ask"] and (directory := _option(args, "--config-dir")):
        return _run_ask(directory)
    if args[:1] == ["check-config"] and (path := _option(args, "--file")):
        return _run_check(path)
    sys.stderr.write(
        "usage: python3 -I <repo>/tg-laya ask --config-dir DIR | check-config --file PATH\n"
    )
    return 2
