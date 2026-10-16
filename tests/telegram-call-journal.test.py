"""Offline journal migration/query-plan checks for the identified call history.

Only temporary private stores are opened; read paths must leave unknown schemas alone.
"""
import json
from contextlib import closing
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "features"))
from telegram_client.call_journal import Journal
from telegram_client.core import ClientError


class JournalIndexTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.journal = Journal(Path(self.temp.name) / "mtproto")

    def create_old_database(self):
        self.journal.directory.mkdir(mode=0o700, parents=True)
        self.journal.directory.parent.chmod(0o700)
        with closing(sqlite3.connect(self.journal.path)) as db, db:
            db.execute("CREATE TABLE calls (id TEXT PRIMARY KEY, token TEXT UNIQUE, created TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL)")
            db.execute("CREATE TABLE events (call_id TEXT, at TEXT, status TEXT)")
        self.journal.path.chmod(0o600)

    def assert_indexed(self):
        with self.journal.connect() as db:
            plan = db.execute("EXPLAIN QUERY PLAN SELECT at,status FROM events WHERE call_id=? ORDER BY rowid", (str(uuid.uuid4()),)).fetchall()
            self.assertTrue(any("SEARCH events USING INDEX" in row[3] and "call_id=?" in row[3] for row in plan), plan)
            self.assertFalse(any("TEMP B-TREE" in row[3] for row in plan), plan)

    def test_new_write_setup_indexes_the_actual_history_query(self):
        self.journal.begin({"references": {}})
        self.assert_indexed()
        self.assertEqual(self.journal.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.journal.directory.stat().st_mode & 0o777, 0o700)

    def test_existing_store_migrates_on_normal_write_without_losing_events(self):
        self.create_old_database()
        call_id = str(uuid.uuid4())
        data = dict(call_id=call_id, status="intent", references={})
        with closing(sqlite3.connect(self.journal.path)) as db, db:
            db.execute("INSERT INTO calls VALUES (?,?,?,?,?)", (call_id, "claimed-token", "before", "intent", json.dumps(data)))
            db.executemany("INSERT INTO events VALUES (?,?,?)", [(call_id, "same-time", "intent"), (call_id, "same-time", "preparing")])
        self.journal.update(call_id, "cancelled")
        self.assert_indexed()
        self.assertEqual([event["status"] for event in self.journal.history(call_id)[0]["transitions"]], ["intent", "preparing", "cancelled"])
        with self.assertRaisesRegex(ClientError, "CALL_TOKEN_ALREADY_USED"):
            self.journal.begin({}, "claimed-token")
        self.assert_indexed()

    def test_read_only_old_store_never_adds_schema_or_changes_bytes(self):
        self.create_old_database()
        before = self.journal.path.read_bytes()
        stat = self.journal.path.stat()
        files = sorted(path.name for path in self.journal.directory.iterdir())
        self.assertEqual(self.journal.history(), [])
        self.assertEqual(self.journal.path.read_bytes(), before)
        self.assertEqual(self.journal.path.stat().st_mtime_ns, stat.st_mtime_ns)
        self.assertEqual(sorted(path.name for path in self.journal.directory.iterdir()), files)

    def test_unknown_schema_read_fails_safely_without_mutation(self):
        self.create_old_database()
        with closing(sqlite3.connect(self.journal.path)) as db, db:
            db.execute("DROP TABLE calls")
            db.execute("CREATE TABLE unrelated (secret TEXT)")
        before = self.journal.path.read_bytes()
        with self.assertRaisesRegex(ClientError, "^CALL_JOURNAL_UNAVAILABLE$"):
            self.journal.history()
        self.assertEqual(self.journal.path.read_bytes(), before)

    def test_missing_read_never_creates_database_or_directories(self):
        self.assertEqual(self.journal.history(), [])
        self.assertFalse(self.journal.directory.parent.exists())

    def test_history_rows_and_events_share_snapshot_during_real_wal_commit(self):
        record = self.journal.begin({"references": {}})
        call_id = record["call_id"]
        self.journal.update(call_id, "attempting")
        with closing(sqlite3.connect(self.journal.path)) as writer:
            self.assertEqual(writer.execute("PRAGMA journal_mode=WAL").fetchone()[0], "wal")
            connect = sqlite3.connect
            commits = []

            class InterleavedReader(sqlite3.Connection):
                def execute(reader, query, parameters=()):
                    if query.startswith("SELECT at,status FROM events") and not commits:
                        data = json.loads(writer.execute("SELECT data FROM calls WHERE id=?", (call_id,)).fetchone()[0])
                        data["status"] = "audio_stream_ended"
                        with writer:
                            writer.execute("UPDATE calls SET status=?,data=? WHERE id=?", (data["status"], json.dumps(data), call_id))
                            writer.execute("INSERT INTO events VALUES (?,?,?)", (call_id, "completed", data["status"]))
                        commits.append(True)
                    return super().execute(query, parameters)

            with patch("telegram_client.call_journal.sqlite3.connect", side_effect=lambda *args, **kwargs: connect(*args, **kwargs, factory=InterleavedReader)):
                snapshot = self.journal.history(call_id)[0]
            self.assertEqual(commits, [True])
            self.assertEqual(snapshot["status"], "attempting")
            self.assertEqual(snapshot["transitions"][-1]["status"], "attempting")
            completed = self.journal.history(call_id)[0]
            self.assertEqual(completed["status"], "audio_stream_ended")
            self.assertEqual(completed["transitions"][-1]["status"], "audio_stream_ended")

    def test_unsafe_existing_file_is_refused_without_mode_repair(self):
        self.create_old_database()
        self.journal.path.chmod(0o644)
        with self.assertRaisesRegex(ClientError, "INSECURE_STORE_FILE"):
            self.journal.begin({})
        self.assertEqual(self.journal.path.stat().st_mode & 0o777, 0o644)


if __name__ == "__main__":
    unittest.main()
