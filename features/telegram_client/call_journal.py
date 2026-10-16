"""Private SQLite intent and transition journal for the call service.

SQLite serializes claims across processes; a token is never automatically replayed.
Readers do not create state. No auth/session objects are accepted here.
History holds one read snapshot so concurrent completion cannot mix row/event states.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
import uuid
from .core import ClientError, private_directory, private_file


def utc():
    return datetime.now(timezone.utc).isoformat()


class Journal:
    def __init__(self, store):
        self.directory = Path(store) / "calls"
        self.path = self.directory / "journal.sqlite3"

    @contextmanager
    def connect(self, write=False):
        if write:
            private_directory(self.directory.parent)
            private_directory(self.directory)
            fd = os.open(self.path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            os.close(fd)
        private_file(self.path)
        uri = self.path.absolute().as_uri() + ("?mode=rw" if write else "?mode=ro")
        db = None
        try:
            db = sqlite3.connect(uri, uri=True, timeout=5)
            db.execute("PRAGMA synchronous=FULL")
            if write:
                db.execute("CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, token TEXT UNIQUE, created TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL)")
                db.execute("CREATE TABLE IF NOT EXISTS events (call_id TEXT, at TEXT, status TEXT)")
                db.execute("CREATE INDEX IF NOT EXISTS events_call_id ON events(call_id)")
            with db:
                yield db
        except sqlite3.IntegrityError:
            raise ClientError("CALL_TOKEN_ALREADY_USED") from None
        except (sqlite3.Error, ValueError, TypeError):
            raise ClientError("CALL_JOURNAL_UNAVAILABLE") from None
        finally:
            if db is not None:
                db.close()

    def begin(self, plan, token=None):
        call_id, at = str(uuid.uuid4()), utc()
        data = dict(plan, call_id=call_id, created_at=at, updated_at=at, status="intent", mirror_ids=[])
        try:
            with self.connect(True) as db:
                db.execute("INSERT INTO calls VALUES (?, ?, ?, ?, ?)", (call_id, token, at, "intent", json.dumps(data, ensure_ascii=False)))
                db.execute("INSERT INTO events VALUES (?, ?, ?)", (call_id, at, "intent"))
        except sqlite3.IntegrityError:
            raise ClientError("CALL_TOKEN_ALREADY_USED") from None
        return data

    def update(self, call_id, status, **fields):
        self.validate_id(call_id)
        with self.connect(True) as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT data FROM calls WHERE id=?", (call_id,)).fetchone()
            if row is None:
                raise ClientError("CALL_ID_NOT_FOUND")
            data = json.loads(row[0])
            data.update(fields, status=status, updated_at=utc())
            db.execute("UPDATE calls SET status=?, data=? WHERE id=?", (status, json.dumps(data, ensure_ascii=False), call_id))
            db.execute("INSERT INTO events VALUES (?, ?, ?)", (call_id, data["updated_at"], status))
        return data

    @staticmethod
    def validate_id(call_id):
        try:
            if str(uuid.UUID(call_id)) != call_id:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise ClientError("CALL_ID_INVALID") from None

    def history(self, call_id=None, status=None, agent=None, session=None, recipient=None, limit=50, task=None, project=None):
        if call_id is not None:
            self.validate_id(call_id)
        if not 1 <= limit <= 100:
            raise ClientError("LIMIT_MUST_BE_1_TO_100")
        if not self.path.exists():
            return []
        clauses, values = [], []
        for column, value in (("id", call_id), ("status", status)):
            if value is not None:
                clauses.append(column + "=?")
                values.append(value)
        for name, value in (("agent", agent), ("session", session), ("task", task), ("project", project)):
            if value is not None:
                clauses.append("json_extract(data, ?) = ?")
                values.extend([f"$.references.{name}.id", value])
        if recipient is not None:
            clauses.append("json_extract(data, '$.recipient_id') = ?")
            values.append(recipient)
        query = "SELECT data FROM calls" + (" WHERE " + " AND ".join(clauses) if clauses else "") + " ORDER BY created DESC LIMIT ?"
        with self.connect() as db:
            db.execute("BEGIN")
            rows = [json.loads(row[0]) for row in db.execute(query, [*values, limit])]
            for row in rows:
                row["transitions"] = [{"at": at, "status": state} for at, state in db.execute("SELECT at,status FROM events WHERE call_id=? ORDER BY rowid", (row["call_id"],))]
        return rows
