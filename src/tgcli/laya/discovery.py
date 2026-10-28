"""Trust decisions: which socket receives message text and which `task` binary tg may run.

Message bodies go over the socket and `task` is executed, so both come only from places no other
account can write to: a directory this user owns and nobody else can enter (task-cli's own
`_private_dir` rule), PATH entries that are absolute, not world-writable and owned by us or root.
"""

import os
import stat
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path


def _uid() -> int:
    return os.geteuid()


def private_dir(path: str | Path) -> bool:
    """A real directory (no symlink) owned by this user that group/other cannot enter."""
    try:
        st = os.lstat(path)
    except OSError:
        return False
    return stat.S_ISDIR(st.st_mode) and st.st_uid == _uid() and (st.st_mode & 0o077) == 0


def state_home(env: Mapping[str, str]) -> Path:
    xdg = env.get("XDG_STATE_HOME", "")
    return Path(xdg) if xdg else Path(env.get("HOME", "")) / ".local" / "state"


def check_socket_path(path: str) -> str | None:
    """Why this socket path must not be trusted; None when usable (or not created yet)."""
    if not os.path.isabs(path):
        return f"socket path {path!r} is not absolute"
    directory = os.path.dirname(path)
    if not private_dir(directory):
        return f"{directory} is not private (it must be a directory only this user can enter)"
    try:
        st = os.lstat(path)
    except OSError:
        return None
    if not stat.S_ISSOCK(st.st_mode):
        return f"{path} is not a socket"
    if st.st_uid != _uid():
        return f"{path} is not owned by this user"
    return None


@dataclass(frozen=True)
class Discovery:
    sockets: list[str] = field(default_factory=list)  # newest first
    untrusted: str | None = None


def discover_sockets(env: Mapping[str, str]) -> Discovery:
    """The `laya-*.sock` files task-cli left under its private classify directory."""
    directory = state_home(env) / "task-cli" / "classify"
    if not os.path.lexists(directory):
        return Discovery()
    if not private_dir(directory):
        return Discovery(untrusted=f"{directory} is not private (mode/owner); refusing to use it")
    found: list[tuple[float, str]] = []
    try:
        names = os.listdir(directory)
    except OSError:
        return Discovery()
    for name in names:
        if not (name.startswith("laya-") and name.endswith(".sock")):
            continue
        path = str(directory / name)
        try:  # an idle-exiting server unlinks its socket at any moment
            if check_socket_path(path) is None:
                st = os.lstat(path)
                if stat.S_ISSOCK(st.st_mode):
                    found.append((st.st_mtime, path))
        except OSError:
            continue
    return Discovery(sockets=[p for _, p in sorted(found, reverse=True)])


@dataclass(frozen=True)
class TaskResolution:
    path: str | None
    problem: str | None = None
    skipped: list[str] = field(default_factory=list)


def _is_executable_file(path: str) -> bool:
    return os.path.isfile(path) and os.access(path, os.X_OK)


def resolve_task(task_bin: str | None, path_env: str) -> TaskResolution:
    """`laya.task_bin`, else `task` on a trusted PATH entry. Never a relative entry."""
    if task_bin is not None:
        if not os.path.exists(task_bin):
            return TaskResolution(None, f"laya.task_bin {task_bin} does not exist")
        if not _is_executable_file(task_bin):
            return TaskResolution(None, f"laya.task_bin {task_bin} is not executable")
        return TaskResolution(task_bin)
    skipped: list[str] = []
    for entry in path_env.split(":"):
        distrust = _distrust_path_entry(entry)
        if distrust:
            skipped.append(distrust)
            continue
        candidate = os.path.join(entry, "task")
        if _is_executable_file(candidate):
            return TaskResolution(candidate, skipped=skipped)
    detail = "; ignored PATH entries: " + ", ".join(skipped) if skipped else ""
    return TaskResolution(None, f"no `task` on a trusted PATH{detail}", skipped)


def _distrust_path_entry(entry: str) -> str | None:
    """Why a PATH entry may not be searched; None when it may (or is simply absent)."""
    if not os.path.isabs(entry):
        return f"{entry or '(empty)'} (not absolute)"
    try:
        st = os.stat(entry)
    except OSError:
        return None
    if not stat.S_ISDIR(st.st_mode):
        return None
    if st.st_mode & 0o002:
        return f"{entry} (world-writable)"
    if st.st_uid == 0 and st.st_mode & 0o020:
        return f"{entry} (root-owned but group-writable)"
    if st.st_uid not in (_uid(), 0):
        return f"{entry} (owned by another account)"
    return None
