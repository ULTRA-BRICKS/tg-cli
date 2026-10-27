"""Pure daemon state paths, pid parsing, and lazy-start policy."""

import posixpath
import re
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import TypedDict

from tgcli.common.js_number import js_integer, js_number
from tgcli.common.js_string import JS_WHITESPACE_PATTERN, js_trim
from tgcli.tg_ctl.config import ControlConfig


class CtlPaths(TypedDict):
    lock: str
    pid: str
    offset: str
    registration: str
    socket: str
    log: str
    routes: str
    history: str
    topics: str
    topicHolds: str
    questions: str
    grants: str
    schedules: str
    overloadRetries: str
    usageWarnings: str
    usageLatest: str
    deferred: str
    lastUserTarget: str
    usageSchedule: str
    dailyPending: str
    pendingBatch: str
    deliveryLedger: str
    awarenessNudge: str
    questionInbox: str
    runInfo: str
    sessions: str
    authPending: str
    alertSubscriptions: str
    alertThrottle: str
    outbox: str
    chatgptRefs: str


def ctl_paths(config_dir: Path, bot_id: str) -> CtlPaths:
    base = f"tg-ctl.{bot_id}"

    def path(suffix: str) -> str:
        return posixpath.normpath(posixpath.join(str(config_dir), f"{base}.{suffix}"))

    return {
        "lock": path("lock"),
        "pid": path("pid"),
        "offset": path("offset"),
        "registration": path("registration.json"),
        "socket": path("sock"),
        "log": path("log"),
        "routes": path("routes.json"),
        "history": path("history.jsonl"),
        "topics": path("topics.json"),
        "topicHolds": path("topic-holds.json"),
        "questions": path("questions.json"),
        "grants": path("grants.json"),
        "schedules": path("schedules.json"),
        "overloadRetries": path("overload-retries.json"),
        "usageWarnings": path("usage-warnings.json"),
        "usageLatest": path("usage-latest.json"),
        "deferred": path("deferred.json"),
        "lastUserTarget": path("last-user-target.json"),
        "usageSchedule": path("usage-schedule.json"),
        "dailyPending": path("daily-pending.txt"),
        "pendingBatch": path("pending-batch.json"),
        "deliveryLedger": path("delivery.jsonl"),
        "awarenessNudge": path("awareness-nudge.json"),
        "questionInbox": path("question-inbox.json"),
        "runInfo": path("run.json"),
        "sessions": path("sessions.json"),
        "authPending": path("auth-pending.json"),
        "alertSubscriptions": path("alert-subscriptions.json"),
        "alertThrottle": path("alert-throttle.json"),
        "outbox": path("outbox"),
        "chatgptRefs": path("chatgpt-refs.json"),
    }


def bot_id_from_token(token: str) -> str:
    bot_id, colon, _ = token.partition(":")
    return bot_id if colon and re.fullmatch(r"[0-9]+", bot_id) else ""


def read_pid_file(content: str | None) -> float | None:
    if content is None or not re.fullmatch(r"[0-9]+", js_trim(content)):
        return None
    pid = js_number(js_trim(content))
    return pid if pid > 0 else None


def owns_pid_file(content: str | None, own_pid: int) -> bool:
    return read_pid_file(content) == own_pid


def should_auto_start(env: Mapping[str, str], cfg: ControlConfig) -> bool:
    return bool(env.get("TMUX")) and cfg.enabled


def plan_legacy_last_user_target_migration(
    config_dir: Path, bot_id: str, exists: Callable[[str], bool]
) -> dict[str, str] | None:
    base = f"tg-ctl.{bot_id}"
    target = str(config_dir / f"{base}.last-user-target.json")
    source = str(config_dir / f"{base}.last-alex-target.json")
    if exists(target):
        return {"kind": "remove-stale", "path": source} if exists(source) else None
    return {"kind": "migrate", "from": source, "to": target} if exists(source) else None


def flock_pids_for_inode(proc_locks: str, ino: str) -> list[int]:
    pids: dict[int, None] = {}
    for line in proc_locks.split("\n"):
        fields = re.split(JS_WHITESPACE_PATTERN + "+", js_trim(line))
        if len(fields) < 6 or fields[1] != "FLOCK":
            continue
        inode = fields[5].split(":")
        if len(inode) < 3 or inode[2] != ino:
            continue
        pid = js_integer(js_number(fields[4]))
        if pid is not None and pid >= 0:
            pids[int(pid)] = None
    return list(pids)
