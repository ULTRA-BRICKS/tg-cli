"""Private stores and one-shot event claims; no Telegram or application imports."""

from contextlib import contextmanager
import json
import os
from pathlib import Path
import sqlite3
import stat


class ClientError(Exception):
    """Safe error codes only: never include exception text from transports."""


def private_directory(path):
    path = Path(path)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if (
        not stat.S_ISDIR(info.st_mode)
        or info.st_uid != os.getuid()
        or info.st_mode & 0o077
    ):
        raise ClientError("INSECURE_STORE_DIRECTORY")


def private_file(path):
    info = Path(path).lstat()
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != os.getuid()
        or info.st_mode & 0o077
    ):
        raise ClientError("INSECURE_STORE_FILE")


def check_identity(expected, actual, is_bot=False):
    if (
        type(expected) is not int
        or expected <= 0
        or type(actual) is not int
        or expected != actual
        or is_bot
    ):
        raise ClientError("ACCOUNT_IDENTITY_MISMATCH")


AUTH_KEYS = {"expected_id", "api_id", "api_hash", "session"}
ORIGINS = ("login", "import")


def validate_auth(data):
    if not isinstance(data, dict) or set(data) - {"origin"} != AUTH_KEYS:
        raise ClientError("INVALID_AUTH_STORE")
    check_identity(data["expected_id"], data["expected_id"])
    if type(data["api_id"]) is not int or data["api_id"] <= 0:
        raise ClientError("INVALID_AUTH_STORE")
    if any(
        not isinstance(data[k], str) or not data[k] for k in ("api_hash", "session")
    ):
        raise ClientError("INVALID_AUTH_STORE")
    if "origin" in data and data["origin"] not in ORIGINS:
        raise ClientError("INVALID_AUTH_STORE")
    return data


def auth_origin(data):
    """A store without `origin` predates it; treat it as a copied key (the safe side)."""
    return data.get("origin", "import")


class AuthStore:
    def __init__(self, root):
        self.root = Path(root)

    def path(self, role):
        if role not in ("personal", "caller"):
            raise ClientError("INVALID_ROLE")
        return self.root / (role + ".json")

    def load(self, role):
        path = self.path(role)
        try:
            private_file(path)
            info = self.root.lstat()
            if (
                not stat.S_ISDIR(info.st_mode)
                or info.st_uid != os.getuid()
                or info.st_mode & 0o077
            ):
                raise ClientError("INSECURE_STORE_DIRECTORY")
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd) as f:
                if os.fstat(f.fileno()).st_mode & 0o077:
                    raise ClientError("INSECURE_STORE_FILE")
                return validate_auth(json.load(f))
        except FileNotFoundError:
            raise ClientError("SESSION_MISSING") from None
        except (ValueError, OSError):
            raise ClientError("INVALID_AUTH_STORE") from None

    def save(self, role, data):
        validate_auth(data)
        private_directory(self.root)
        path = self.path(role)
        try:
            fd = os.open(
                path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
            )
        except FileExistsError:
            raise ClientError("SESSION_ALREADY_EXISTS") from None
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(data, f)
                f.flush()
                os.fsync(f.fileno())
            directory = os.open(self.root, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        except BaseException:
            path.unlink(missing_ok=True)
            raise

    def remove(self, role):
        """Local only: the authorization stays listed in Telegram's Settings → Devices."""
        try:
            self.path(role).unlink()
        except FileNotFoundError:
            raise ClientError("SESSION_MISSING") from None


class TriggerStore:
    """At most one attempt; a crash after claiming requires manual reconciliation."""

    def __init__(self, path):
        self.path = Path(path)

    @contextmanager
    def connection(self):
        private_directory(self.path.parent)
        try:
            fd = os.open(
                self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
            )
            os.close(fd)
        except FileExistsError:
            pass
        private_file(self.path)
        conn = sqlite3.connect(self.path, timeout=5)
        try:
            conn.execute("PRAGMA synchronous=FULL")
            conn.execute(
                "CREATE TABLE IF NOT EXISTS trigger (id INTEGER PRIMARY KEY CHECK(id=1), owner INTEGER, peer INTEGER, after_id INTEGER, armed_at REAL, state TEXT, message_id INTEGER)"
            )
            with conn:
                yield conn
        finally:
            conn.close()

    def arm(self, owner, peer, after_id, now):
        check_identity(owner, owner)
        check_identity(peer, peer)
        if owner == peer or type(after_id) is not int or after_id < 0 or now <= 0:
            raise ClientError("INVALID_TRIGGER")
        with self.connection() as conn:
            try:
                conn.execute(
                    "INSERT INTO trigger VALUES(1,?,?,?,?,?,NULL)",
                    (owner, peer, after_id, now, "armed"),
                )
            except sqlite3.IntegrityError:
                raise ClientError("TRIGGER_ALREADY_EXISTS") from None

    def claim(self, account, peer, message_id, date, outgoing=False):
        if outgoing:
            return False
        with self.connection() as conn:
            result = conn.execute(
                "UPDATE trigger SET state='claimed',message_id=? WHERE id=1 AND state='armed' AND owner=? AND peer=? AND after_id<? AND armed_at<?",
                (message_id, account, peer, message_id, date),
            )
            return result.rowcount == 1

    def finish(self, completed):
        with self.connection() as conn:
            conn.execute(
                "UPDATE trigger SET state=? WHERE id=1 AND state='claimed'",
                ("completed" if completed else "uncertain",),
            )

    def status(self):
        if not self.path.exists():
            return "missing"
        with self.connection() as conn:
            row = conn.execute("SELECT state FROM trigger WHERE id=1").fetchone()
            return row[0] if row else "missing"

    def config(self):
        with self.connection() as conn:
            row = conn.execute("SELECT owner,peer FROM trigger WHERE id=1").fetchone()
            if not row:
                raise ClientError("TRIGGER_MISSING")
            return row
