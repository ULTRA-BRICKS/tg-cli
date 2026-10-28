"""Ask Laya one question set: warm socket first, autostart when nothing answers.

Every failure is a typed `Unavailable(reason, detail, attempt, remedy)`: what happened, what was
tried, what to do next. Nothing here decides whether the caller may continue without the model;
that is the `required` policy, applied by the TypeScript gate on the reply.
"""

import json
import os
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass

from tgcli.laya import autostart
from tgcli.laya.client import MAX_MESSAGE_BYTES, Failure, exchange
from tgcli.laya.config import LayaSettings
from tgcli.laya.discovery import check_socket_path, discover_sockets, resolve_task, state_home

Log = Callable[[str], None]
MANUAL_START = "run: task classify-server start"


@dataclass(frozen=True)
class Ok:
    line: str


@dataclass(frozen=True)
class Unavailable:
    reason: str
    detail: str
    attempt: str
    remedy: str


def _fmt(seconds: float) -> str:
    return f"{seconds:g}"


def _from_failure(failure: Failure, path: str, warm_ms: float) -> Unavailable:
    if failure.kind == "timeout":
        return Unavailable(
            "timeout",
            failure.detail,
            f"asked {path}: no reply within {_fmt(warm_ms)} ms",
            "the server is alive but slow (the first call after a load can take seconds): "
            f"retry, raise laya.warm_timeout_ms, or restart it with `{MANUAL_START}`",
        )
    return Unavailable(
        failure.kind,
        failure.detail,
        f"asked {path}: {failure.detail}",
        f"{MANUAL_START}; if it keeps failing read the server log in "
        "~/.local/state/task-cli/classify/",
    )


def _ask_path(path: str, payload: bytes, settings: LayaSettings) -> Ok | Unavailable | None:
    """None: nothing listens there (stale or missing)."""
    result = exchange(path, payload, settings.warm_timeout_ms / 1000)
    if isinstance(result, str):
        return Ok(result)
    if result.kind == "no-listener":
        return None
    return _from_failure(result, path, settings.warm_timeout_ms)


def _ask_discovered(
    env: Mapping[str, str], payload: bytes, settings: LayaSettings
) -> Ok | Unavailable | None:
    found = discover_sockets(env)
    if found.untrusted:
        return Unavailable(
            "untrusted-socket",
            found.untrusted,
            "refused to connect: the classify directory is not private",
            "chmod 700 the directory (it must be owned by you and closed to others), "
            f"then {MANUAL_START}",
        )
    for path in found.sockets:
        outcome = _ask_path(path, payload, settings)
        if outcome is not None:
            return outcome
    return None


PINNED_REMEDY = (
    "the pinned socket {path} is served by an external supervisor; fix or restart that service "
    "(tg does not start a model for a pinned socket); to let tg manage Laya instead, unset "
    "TG_LAYA_SOCKET and laya.socket"
)


def _ask_pinned(path: str, payload: bytes, settings: LayaSettings) -> Ok | Unavailable:
    problem = check_socket_path(path)
    if problem:
        return Unavailable(
            "untrusted-socket",
            problem,
            f"refused to connect to the pinned socket {path}",
            "point TG_LAYA_SOCKET / laya.socket at a socket in a private directory you own: "
            + PINNED_REMEDY.format(path=path),
        )
    outcome = _ask_path(path, payload, settings)
    if isinstance(outcome, Unavailable):
        # `task classify-server start` would start a different server: never advise it here.
        return Unavailable(
            outcome.reason, outcome.detail, outcome.attempt, PINNED_REMEDY.format(path=path)
        )
    if outcome is not None:
        return outcome
    return Unavailable(
        "no-socket",
        f"nothing listens on {path}",
        f"connected to the pinned socket {path}: no listener "
        "(autostart never replaces a pinned socket)",
        PINNED_REMEDY.format(path=path),
    )


def _skipped(recent: autostart.RecordedFailure, now: float, env: Mapping[str, str]) -> Unavailable:
    age = recent.age(now)
    return Unavailable(
        "autostart-skipped",
        f"last failure {age} s ago: {recent.reason}: {recent.detail}",
        f"skipped autostart: last failure {age} s ago "
        f"(no retry within {int(autostart.RETRY_WINDOW_SEC)} s)",
        f"{MANUAL_START} and read its error (a running server is used at once); "
        f"state: {autostart.state_file(env)}",
    )


def _failed_start(
    env: Mapping[str, str], reason: str, detail: str, attempt: str, remedy: str
) -> Unavailable:
    unrecorded = autostart.record_failure(env, reason, detail, time.time())
    window = int(autostart.RETRY_WINDOW_SEC)
    note = (
        f"tg could not record this failure ({unrecorded}), so every send retries autostart"
        if unrecorded
        else f"tg will not retry autostart for {window} s"
    )
    return Unavailable(reason, detail, attempt, f"{remedy}. {note}")


def _start_server(
    task: str, env: Mapping[str, str], settings: LayaSettings, deadline: float
) -> str | Unavailable:
    """Run `task classify-server start`; the validated socket path, or why it failed."""
    cold = _fmt(settings.cold_timeout_sec)
    ran = f"ran `{task} classify-server start` (cold budget {cold} s)"
    try:
        result = autostart.run_task_start(task, env, deadline - time.monotonic())
    except OSError as error:  # not executable, bad interpreter line, no such file...
        return _failed_start(
            env,
            "autostart-failed",
            f"{type(error).__name__}: {error}",
            f"tried to run `{task} classify-server start`: it could not be executed",
            "check that the task executable runs by hand",
        )
    if result.code is None:
        return _failed_start(
            env,
            "cold-timeout",
            f"no socket within {cold} s",
            f"{ran}: killed after {cold} s without a socket",
            f"{MANUAL_START} and wait for it (a first start may load or download the model, "
            "which is task's own documented behaviour), or raise laya.cold_timeout_sec",
        )
    if result.code != 0:
        message = " ".join(result.stderr.split())[:300] or "no error text"
        return _failed_start(
            env,
            "autostart-failed",
            message,
            f"{ran}: exit {result.code}",
            f"{MANUAL_START} and read its error",
        )
    path = autostart.printed_socket_path(result.stdout)
    problem = check_socket_path(path) if path else "task printed no socket path"
    if problem:
        return _failed_start(
            env,
            "untrusted-socket",
            f"task printed {path or '(nothing)'}: {problem}",
            f"{ran}: the printed socket was refused",
            "check the task-cli install; its classify socket must be in a private directory "
            "you own",
        )
    return path


def _autostart(
    env: Mapping[str, str], payload: bytes, settings: LayaSettings, log: Log
) -> Ok | Unavailable:
    deadline = time.monotonic() + settings.cold_timeout_sec
    recent = autostart.read_recent_failure(env, time.time())
    if recent:
        return _skipped(recent, time.time(), env)
    task = resolve_task(settings.task_bin, env.get("PATH", ""))
    if task.path is None:
        return Unavailable(
            "no-task",
            task.problem or "task not found",
            "looked for the `task` executable to run `classify-server start`",
            "install task-cli, put `task` on PATH, or set laya.task_bin to its absolute path",
        )
    log(
        f"tg: Laya is not running; starting it with `task classify-server start` "
        f"(up to {_fmt(settings.cold_timeout_sec)} s, once)..."
    )
    try:
        started = _locked_start(task.path, env, payload, settings, deadline)
    except OSError as error:
        return Unavailable(
            "autostart-failed",
            f"cannot use the start lock: {type(error).__name__}: {error}",
            "tried to take the autostart lock in the tg state directory",
            "fix the permissions of ~/.local/state/tg-cli (or XDG_STATE_HOME) and run tg again",
        )
    if not isinstance(started, str):
        return started
    outcome = _ask_path(started, payload, settings)
    if outcome is not None:
        return outcome
    return _failed_start(
        env,
        "autostart-failed",
        f"task reported {started} but nothing listens there",
        f"ran `{task.path} classify-server start`: it printed {started}, "
        "which refused the connection",
        f"{MANUAL_START} and read its error",
    )


def _locked_start(
    task: str, env: Mapping[str, str], payload: bytes, settings: LayaSettings, deadline: float
) -> str | Ok | Unavailable:
    """Under the start lock: a server another sender just started, else start one."""
    with autostart.start_lock(env, deadline) as locked:
        if not locked:
            return Unavailable(
                "cold-timeout",
                "another tg is still starting Laya",
                f"waited {_fmt(settings.cold_timeout_sec)} s for the start lock",
                f"{MANUAL_START}, or raise laya.cold_timeout_sec",
            )
        # Another sender may have finished the start while we queued for the lock.
        again = _ask_discovered(env, payload, settings)
        if again is not None:
            return again
        recent = autostart.read_recent_failure(env, time.time())
        if recent:
            return _skipped(recent, time.time(), env)
        started = _start_server(task, env, settings, deadline)
        if isinstance(started, str):
            autostart.clear_failure(env)
        return started


def ask_laya(
    message: str,
    questions: Mapping[str, object],
    settings: LayaSettings,
    env: Mapping[str, str],
    log: Log,
) -> Ok | Unavailable:
    """One predict request: warm socket, else (when allowed) autostart and ask the fresh server."""
    if not settings.enabled:
        return Unavailable(
            "disabled",
            "Laya is switched off (laya.enabled: false or TG_LAYA=0)",
            "none: no connection was made",
            "enable it: unset TG_LAYA and set laya.enabled: true",
        )
    request = {"op": "predict", "message": message, "questions": questions}
    payload = json.dumps(request, ensure_ascii=False).encode("utf-8")
    if len(payload) + 1 > MAX_MESSAGE_BYTES:
        return Unavailable(
            "payload-too-large",
            f"the request is {len(payload) + 1} bytes; the limit is {MAX_MESSAGE_BYTES}",
            "none: nothing was sent",
            "send a shorter report; long evidence is never cut to its head",
        )
    if settings.socket:
        return _ask_pinned(settings.socket, payload, settings)
    outcome = _ask_discovered(env, payload, settings)
    if outcome is not None:
        return outcome
    if not settings.autostart:
        directory = state_home(env) / "task-cli" / "classify"
        return Unavailable(
            "no-socket",
            f"no live laya-*.sock under {directory}",
            f"looked under {directory}; autostart is off (laya.autostart: false)",
            f"{MANUAL_START}, or enable laya.autostart",
        )
    return _autostart(env, payload, settings, log)


def default_log(message: str) -> None:
    os.write(2, (message + "\n").encode("utf-8", "replace"))
