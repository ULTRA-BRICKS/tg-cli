"""The client-side journal: a record the server did not confirm is kept, never dropped."""

import json
import os
import stat
import threading
from pathlib import Path

import pytest

from tgcli.remote.journal import CAP, MAX_AGE_MS, Journal


class Clock:
    def __init__(self, now_ms: int = 1_730_100_000_000) -> None:
        self.now_ms = now_ms

    def __call__(self) -> int:
        return self.now_ms


def record(chat: str = "-1001", first: int = 10) -> dict[str, object]:
    return {
        "v": 1,
        "op": "record",
        "machine": "clvm",
        "chat": chat,
        "ids": [{"id": first, "threadId": None}],
        "route": {"paneId": "%3"},
        "history": {"text": "hello"},
        "name": {"primary": "x"},
        "ts": 1,
    }


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def journal(tmp_path: Path, clock: Clock) -> Journal:
    return Journal(tmp_path / "remote", clock)


def test_add_writes_a_private_file_named_after_chat_and_first_id(journal, tmp_path):
    result = journal.add(record())
    assert result.created is True
    assert result.path == tmp_path / "remote" / "journal" / "-1001_10.json"
    assert stat.S_IMODE(result.path.stat().st_mode) == 0o600
    for directory in (tmp_path / "remote", tmp_path / "remote" / "journal"):
        assert stat.S_IMODE(directory.stat().st_mode) == 0o700
    assert json.loads(result.path.read_text()) == {
        "journaledAt": 1_730_100_000_000,
        "record": record(),
    }
    assert [p.name for p in result.path.parent.iterdir()] == ["-1001_10.json"]


def test_existing_loose_permissions_are_tightened(tmp_path, clock):
    base = tmp_path / "remote"
    (base / "journal").mkdir(parents=True, mode=0o755)
    os.chmod(base, 0o755)
    os.chmod(base / "journal", 0o755)
    Journal(base, clock).add(record())
    assert stat.S_IMODE(base.stat().st_mode) == 0o700
    assert stat.S_IMODE((base / "journal").stat().st_mode) == 0o700


def test_readd_is_idempotent_and_keeps_the_first_timestamp(journal, clock):
    first = journal.add(record())
    clock.now_ms += 5000
    again = journal.add(record())
    assert again.created is False and again.path == first.path
    assert json.loads(first.path.read_text())["journaledAt"] == 1_730_100_000_000
    assert journal.depth() == 1


def test_entries_are_listed_oldest_first(journal, clock):
    for index, first in enumerate((30, 10, 20)):
        clock.now_ms = 1_730_100_000_000 + index
        journal.add(record(first=first))
    assert [e.record["ids"][0]["id"] for e in journal.entries()] == [30, 10, 20]


def test_remove_forgets_an_entry(journal):
    journal.add(record(first=1))
    journal.add(record(first=2))
    entry = journal.entries()[0]
    journal.remove(entry)
    assert [e.record["ids"][0]["id"] for e in journal.entries()] == [2]
    journal.remove(entry)  # already gone: not an error


def test_entries_older_than_24h_are_archived_with_a_warning(journal, clock, tmp_path):
    journal.add(record(first=1))
    clock.now_ms += MAX_AGE_MS + 1
    journal.add(record(first=2))
    entries = journal.entries()
    assert [e.record["ids"][0]["id"] for e in entries] == [2]
    archived = tmp_path / "remote" / "journal" / "archive" / "-1001_1.json"
    assert archived.is_file() and stat.S_IMODE(archived.stat().st_mode) == 0o600
    warnings = journal.take_warnings()
    assert len(warnings) == 1 and "-1001_1.json" in warnings[0] and "24 h" in warnings[0]
    assert journal.take_warnings() == []


def test_exactly_24h_old_is_still_kept(journal, clock):
    journal.add(record())
    clock.now_ms += MAX_AGE_MS
    assert journal.depth() == 1


def test_cap_overflow_archives_the_oldest_never_drops(journal, clock, tmp_path):
    for index in range(CAP + 3):
        clock.now_ms = 1_730_100_000_000 + index
        journal.add(record(first=index + 1))
    assert journal.depth() == CAP
    archive = tmp_path / "remote" / "journal" / "archive"
    assert sorted(p.name for p in archive.iterdir()) == [
        "-1001_1.json",
        "-1001_2.json",
        "-1001_3.json",
    ]
    assert len(journal.take_warnings()) >= 1


def test_corrupt_entry_is_archived_not_fatal(journal, tmp_path):
    journal.add(record(first=1))
    bad = tmp_path / "remote" / "journal" / "-1001_99.json"
    bad.write_text("{not json")
    assert [e.record["ids"][0]["id"] for e in journal.entries()] == [1]
    assert (tmp_path / "remote" / "journal" / "archive" / "-1001_99.json").is_file()
    assert "unreadable" in journal.take_warnings()[0]


def test_unrelated_files_are_ignored(journal, tmp_path):
    journal.add(record())
    directory = tmp_path / "remote" / "journal"
    (directory / "notes.txt").write_text("x")
    (directory / ".tmp-123").write_text("x")
    (directory / "a_b.json").write_text("x")
    assert journal.depth() == 1


def test_archive_name_collision_keeps_both(journal, clock, tmp_path):
    journal.add(record(first=1))
    clock.now_ms += MAX_AGE_MS + 1
    journal.entries()
    journal.add(record(first=1))
    clock.now_ms += MAX_AGE_MS + 1
    journal.entries()
    archive = tmp_path / "remote" / "journal" / "archive"
    assert len(list(archive.iterdir())) == 2


@pytest.mark.parametrize("chat", ["abc", "1/../2", "", "12\n", "-"])
def test_refuses_a_record_whose_chat_cannot_name_a_file(journal, chat):
    with pytest.raises(ValueError):
        journal.add(record(chat=chat))
    assert journal.depth() == 0


def test_concurrent_adds_make_distinct_files(tmp_path):
    base = tmp_path / "remote"
    errors: list[BaseException] = []

    def work(index: int) -> None:
        try:
            Journal(base, Clock()).add(record(first=index + 1))
        except BaseException as error:
            errors.append(error)

    threads = [threading.Thread(target=work, args=(i,)) for i in range(40)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert errors == []
    assert Journal(base, Clock()).depth() == 40
    assert not [p for p in (base / "journal").iterdir() if p.name.startswith(".")]


def test_unicode_survives_the_journal_byte_exact(journal):
    rec = record()
    rec["history"] = {"text": "😀 שלום e\u0301\u202e"}
    journal.add(rec)
    assert journal.entries()[0].record["history"] == rec["history"]


def test_archiving_the_same_key_twice_within_one_millisecond_keeps_both(journal, tmp_path):
    archive = tmp_path / "remote" / "journal" / "archive"
    for text in ("first", "second", "third"):
        rec = record()
        rec["history"] = {"text": text}
        entry_path = journal.add(rec).path
        journal.archive(journal.entries()[0], "test")  # the clock never advances
        assert not entry_path.exists()
    kept = sorted(p.read_text() for p in archive.iterdir())
    assert len(kept) == 3
    assert [text for text in ("first", "second", "third") if any(text in k for k in kept)] == [
        "first",
        "second",
        "third",
    ]


def test_concurrent_archivings_of_one_key_never_overwrite(tmp_path):
    base = tmp_path / "remote"
    fixed = Clock()
    seed = Journal(base, fixed)
    barrier = threading.Barrier(8)

    def work(index: int) -> None:
        rec = record()
        rec["history"] = {"text": f"v{index}"}
        journal = Journal(base, fixed)
        path = journal.root / "-1001_10.json"
        journal.root.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"journaledAt": fixed.now_ms, "record": rec}))
        barrier.wait()
        journal._move_to_archive(path, "race")  # noqa: SLF001 - the collision path itself

    seed.add(record())
    threads = [threading.Thread(target=work, args=(i,)) for i in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    archived = list((base / "journal" / "archive").iterdir())
    assert len(archived) >= 1
    assert all(
        json.loads(p.read_text())["record"]["history"]["text"].startswith("v") for p in archived
    )


@pytest.mark.parametrize("first", [0, -5, 2**53 + 1, 10**20, True, "7", None])
def test_a_first_id_that_the_listing_would_never_see_is_refused(journal, first):
    rec = record()
    rec["ids"] = [{"id": first}]
    with pytest.raises(ValueError):
        journal.add(rec)
    assert journal.depth() == 0


def test_the_archived_copy_is_durable_before_the_original_is_removed(
    journal, monkeypatch, tmp_path
):
    from tgcli.remote import journal as journal_module

    original = journal.add(record()).path
    journal_dir = tmp_path / "remote" / "journal"
    seen: list[tuple[str, bool]] = []
    real = journal_module.fsync_dir

    def spy(directory: Path) -> None:
        seen.append((directory.name, original.exists()))
        real(directory)

    monkeypatch.setattr(journal_module, "fsync_dir", spy)
    journal.archive(journal.entries()[0], "test")
    assert seen == [("archive", True), (journal_dir.name, False)]
