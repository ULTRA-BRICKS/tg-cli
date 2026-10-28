"""Client journal of records the server has not confirmed (spec §5).

`<remote dir>/journal/<chat>_<firstId>.json`, 0600 in a 0700 directory, written tmp+fsync+link so a
crash leaves either the whole entry or none. Entries older than 24 h and entries beyond the cap
move to `archive/` with a warning: nothing is ever dropped silently.
"""

import json
import os
import re
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from tgcli.common.fsio import atomic_create, fsync_dir
from tgcli.remote.protocol import CHAT_RE, MAX_SAFE_INT, JsonObject

CAP = 500
MAX_AGE_MS = 24 * 60 * 60 * 1000
_FILE_RE = re.compile(r"-?[0-9]{1,19}_[0-9]{1,19}\.json")


@dataclass(frozen=True)
class Entry:
    path: Path
    journaled_at: int
    record: JsonObject


@dataclass(frozen=True)
class AddResult:
    path: Path
    created: bool


def _now_ms() -> int:
    return int(time.time() * 1000)


def _private_dir(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path, 0o700)


def _file_name(record: JsonObject) -> str:
    """`<chat>_<first id>.json`; refuses anything that could not be a plain file name."""
    chat, ids = record.get("chat"), record.get("ids")
    first = ids[0].get("id") if isinstance(ids, list) and ids and isinstance(ids[0], dict) else None
    in_range = type(first) is int and 1 <= first <= MAX_SAFE_INT
    if not isinstance(chat, str) or CHAT_RE.fullmatch(chat) is None or not in_range:
        raise ValueError("record has no chat/first id that can name a journal file")
    return f"{chat}_{first}.json"


class Journal:
    def __init__(self, base: Path, clock: Callable[[], int] = _now_ms) -> None:
        self._root = base / "journal"
        self._archive = self._root / "archive"
        self._base = base
        self._clock = clock
        self._warnings: list[str] = []

    @property
    def root(self) -> Path:
        return self._root

    def take_warnings(self) -> list[str]:
        warnings, self._warnings = self._warnings, []
        return warnings

    def add(self, record: JsonObject) -> AddResult:
        """Persist `record`; a second add of the same (chat, first id) keeps the first entry."""
        name = _file_name(record)
        _private_dir(self._base)
        _private_dir(self._root)
        target = self._root / name
        body = json.dumps({"journaledAt": self._clock(), "record": record}, ensure_ascii=False)
        created = atomic_create(target, body)
        self._enforce_cap()
        return AddResult(target, created)

    def entries(self) -> list[Entry]:
        """Live entries, oldest first; stale and unreadable ones are archived on the way."""
        if not self._root.is_dir():
            return []
        found: list[Entry] = []
        for path in self._root.iterdir():
            if _FILE_RE.fullmatch(path.name) is None:
                continue
            entry = self._read(path)
            if entry is not None:
                found.append(entry)
        found.sort(key=lambda e: (e.journaled_at, e.path.name))
        return found

    def depth(self) -> int:
        return len(self.entries())

    def remove(self, entry: Entry) -> None:
        entry.path.unlink(missing_ok=True)

    def archive(self, entry: Entry, reason: str) -> None:
        self._move_to_archive(entry.path, reason)

    def _read(self, path: Path) -> Entry | None:
        try:
            doc = json.loads(path.read_bytes().decode("utf-8"))
            stamp = doc["journaledAt"]
            record = doc["record"]
            if type(stamp) is not int or not isinstance(record, dict):
                raise ValueError("wrong shape")
        except FileNotFoundError:
            return None
        except (ValueError, KeyError, TypeError, OSError):
            self._move_to_archive(path, "unreadable")
            return None
        if self._clock() - stamp > MAX_AGE_MS:
            self._move_to_archive(path, "older than 24 h")
            return None
        return Entry(path, stamp, record)

    def _enforce_cap(self) -> None:
        # Listing names is cheap; only an over-full journal is worth parsing to find the oldest.
        if sum(1 for path in self._root.iterdir() if _FILE_RE.fullmatch(path.name)) <= CAP:
            return
        live = self.entries()
        for entry in live[: max(0, len(live) - CAP)]:
            self._move_to_archive(entry.path, f"journal holds more than {CAP} entries")

    def _move_to_archive(self, path: Path, reason: str) -> None:
        """Link into the archive under a name nobody else holds, then drop the original.

        A link never replaces: two archivings of the same key keep both records.
        """
        _private_dir(self._archive)
        target = self._archive / path.name
        while True:
            try:
                os.link(path, target)
                break
            except FileNotFoundError:
                return
            except FileExistsError:
                unique = f"{path.stem}.{self._clock()}.{secrets.token_hex(4)}{path.suffix}"
                target = self._archive / unique
        # The archived copy must be on disk before the original goes, or a crash could lose both.
        fsync_dir(self._archive)
        path.unlink(missing_ok=True)
        fsync_dir(self._root)
        self._warnings.append(
            f"journal entry {path.name} moved to the archive ({reason}): {target}"
        )
