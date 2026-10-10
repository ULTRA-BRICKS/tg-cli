"""No credentials/network: auth separation, account gates, durable event dedup."""

import concurrent.futures
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "features"))
from telegram_client.core import AuthStore, ClientError, TriggerStore, check_identity


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_stores_are_separate(self):
        store = AuthStore(self.root / "auth")
        self.assertNotEqual(store.path("personal"), store.path("caller"))

    def test_missing_session_fails_closed_without_creating(self):
        store = AuthStore(self.root / "auth")
        with self.assertRaisesRegex(ClientError, "^SESSION_MISSING$"):
            store.load("personal")
        self.assertFalse(store.root.exists())

    def test_identity_mismatch_and_bots_refused(self):
        for expected, actual, bot in [(1, 2, False), (0, 0, False), (1, 1, True)]:
            with self.assertRaises(ClientError):
                check_identity(expected, actual, bot)

    def test_private_store_and_no_overwrite(self):
        store = AuthStore(self.root / "auth")
        data = dict(expected_id=7, api_id=1, api_hash="fixture", session="fixture")
        store.save("caller", data)
        self.assertEqual(store.load("caller"), data)
        self.assertEqual(store.path("caller").stat().st_mode & 0o777, 0o600)
        with self.assertRaises(ClientError):
            store.save("caller", data)

    def test_insecure_and_symlink_stores_refused(self):
        store = AuthStore(self.root / "auth")
        data = dict(expected_id=7, api_id=1, api_hash="fixture", session="fixture")
        store.save("personal", data)
        store.path("personal").chmod(0o644)
        with self.assertRaises(ClientError):
            store.load("personal")
        store.path("personal").unlink()
        store.path("personal").symlink_to(self.root / "elsewhere")
        with self.assertRaises(ClientError):
            store.load("personal")

    def trigger(self):
        s = TriggerStore(self.root / "trigger.sqlite")
        s.arm(owner=1, peer=2, after_id=100, now=1000)
        return s

    def test_only_new_incoming_from_exact_peer_and_account(self):
        for args in [
            (1, 2, 100, 1001, False),
            (1, 2, 101, 999, False),
            (1, 3, 101, 1001, False),
            (3, 2, 101, 1001, False),
            (1, 2, 101, 1001, True),
        ]:
            s = self.trigger()
            self.assertFalse(s.claim(*args))
            self.assertTrue(s.claim(1, 2, 101, 1001))
            (self.root / "trigger.sqlite").unlink()

    def test_restart_and_parallel_duplicates_do_not_ring_twice(self):
        self.trigger()

        def claim(_):
            return TriggerStore(self.root / "trigger.sqlite").claim(1, 2, 101, 1001)

        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            self.assertEqual(sum(pool.map(claim, range(8))), 1)
        restarted = TriggerStore(self.root / "trigger.sqlite")
        self.assertFalse(restarted.claim(1, 2, 102, 1002))
        restarted.finish(True)
        self.assertEqual(restarted.status(), "completed")
        self.assertFalse(restarted.claim(1, 2, 103, 1003))

    def test_ambiguous_call_stops_retries(self):
        s = self.trigger()
        self.assertTrue(s.claim(1, 2, 101, 1001))
        s.finish(False)
        self.assertEqual(s.status(), "uncertain")
        self.assertFalse(s.claim(1, 2, 102, 1002))

    def test_cannot_rearm_existing_trigger(self):
        s = self.trigger()
        with self.assertRaises(ClientError):
            s.arm(1, 2, 100, 1000)


class AdapterTests(unittest.TestCase):
    def test_wal_snapshot_is_consistent_without_writing_original(self):
        from telegram_client.runtime import sqlite_snapshot

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.session"
            original = sqlite3.connect(source)
            original.execute("PRAGMA journal_mode=WAL")
            original.execute("CREATE TABLE sample(value TEXT)")
            original.commit()
            original.execute("INSERT INTO sample VALUES('committed-in-wal')")
            original.commit()
            before = source.read_bytes()
            snapshot = Path(directory) / "copy.session"
            sqlite_snapshot(source, snapshot)
            with sqlite3.connect(snapshot) as copied:
                self.assertEqual(
                    copied.execute("SELECT value FROM sample").fetchone()[0],
                    "committed-in-wal",
                )
            self.assertEqual(source.read_bytes(), before)
            self.assertEqual(snapshot.stat().st_mode & 0o777, 0o600)
            original.close()

    def test_missing_source_does_not_create_a_new_session(self):
        from telegram_client.runtime import sqlite_snapshot

        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ClientError, "SOURCE_SESSION_MISSING"):
                sqlite_snapshot(Path(directory) / "missing", Path(directory) / "copy")
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_offline_status_never_exposes_auth(self):
        import subprocess

        with tempfile.TemporaryDirectory() as directory:
            store = AuthStore(Path(directory) / "auth")
            store.save(
                "caller",
                dict(
                    expected_id=7,
                    api_id=1,
                    api_hash="NEVER_PRINT_HASH",
                    session="NEVER_PRINT_SESSION",
                ),
            )
            result = subprocess.run(
                [
                    sys.executable,
                    str(Path(__file__).resolve().parents[1] / "tg-call"),
                    "--store",
                    str(store.root),
                    "status",
                ],
                capture_output=True,
                text=True,
                timeout=5,
            )
            self.assertEqual(result.returncode, 0)
            self.assertNotIn("NEVER_PRINT", result.stdout + result.stderr)
            self.assertIn('"online_verified": false', result.stdout)

    def test_session_unauthorized_does_not_start_login(self):
        import asyncio
        from unittest.mock import patch
        from telegram_client.runtime import connected

        class FakeClient:
            is_connected = True
            is_initialized = False

            def __init__(self, *a, **kw):
                pass

            async def connect(self):
                return False

            async def disconnect(self):
                self.is_connected = False

            async def start(self):
                raise AssertionError("login must never start")

            async def get_me(self):
                raise AssertionError("unauthorized get_me")

        with tempfile.TemporaryDirectory() as directory:
            store = AuthStore(Path(directory) / "auth")
            store.save(
                "personal",
                dict(expected_id=7, api_id=1, api_hash="fixture", session="fixture", origin="login"),
            )

            async def run():
                with patch(
                    "telegram_client.runtime.client_class", return_value=FakeClient
                ):
                    with self.assertRaisesRegex(ClientError, "SESSION_UNAUTHORIZED"):
                        async with connected(store, "personal"):
                            self.fail("must refuse")

            asyncio.run(run())

    def test_online_identity_mismatch_disconnects_before_read(self):
        import asyncio
        from types import SimpleNamespace
        from unittest.mock import patch
        from telegram_client.runtime import connected

        class FakeClient:
            is_connected = True
            is_initialized = False
            closed = False

            def __init__(self, *a, **kw):
                pass

            async def connect(self):
                return True

            async def disconnect(self):
                FakeClient.closed = True

            async def get_me(self):
                return SimpleNamespace(id=99, is_bot=False)

        with tempfile.TemporaryDirectory() as directory:
            store = AuthStore(Path(directory) / "auth")
            store.save(
                "personal",
                dict(expected_id=7, api_id=1, api_hash="fixture", session="fixture", origin="login"),
            )

            async def run():
                with patch(
                    "telegram_client.runtime.client_class", return_value=FakeClient
                ):
                    with self.assertRaisesRegex(
                        ClientError, "ACCOUNT_IDENTITY_MISMATCH"
                    ):
                        async with connected(store, "personal"):
                            self.fail("must refuse")

            asyncio.run(run())
            self.assertTrue(FakeClient.closed)


if __name__ == "__main__":
    unittest.main()
