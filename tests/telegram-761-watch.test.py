"""Offline watcher integration: durable watermark claims feed the audited call service."""
import asyncio
from contextlib import asynccontextmanager, redirect_stdout
from datetime import datetime, timezone
import io
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "features"))
from telegram_client import cli, call_lib
from telegram_client.core import AuthStore, ClientError, TriggerStore


class WatchTests(unittest.IsolatedAsyncioTestCase):
    async def test_claim_once_routes_identified_audio_to_shared_service(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = AuthStore(root / "mtproto")
            for role, account in (("personal", 42), ("caller", 8)):
                store.save(role, dict(expected_id=account, api_id=11, api_hash="fixture", session="fixture", origin="login"))
            audio = root / "speech.wav"
            audio.write_bytes(b"fixture")
            trigger = TriggerStore(root / "trigger.sqlite")
            trigger.arm(42, 77, 10, 100)
            args = cli.parser("personal").parse_args([
                "watch-call", "--trigger", str(trigger.path), "--audio", str(audio),
                "--agent", "3d-house", "--kind", "problem", "--task-title", "Print Ops",
                "--transcript", "provided only", "--session", "session-a",
            ])
            calls = []
            messages = [
                SimpleNamespace(id=11, chat=SimpleNamespace(id=77), from_user=SimpleNamespace(id=77),
                    date=datetime.fromtimestamp(99, timezone.utc), outgoing=False),
                SimpleNamespace(id=10, chat=SimpleNamespace(id=77), from_user=SimpleNamespace(id=77),
                    date=datetime.fromtimestamp(101, timezone.utc), outgoing=False),
                SimpleNamespace(id=11, chat=SimpleNamespace(id=77), from_user=SimpleNamespace(id=77),
                    date=datetime.fromtimestamp(101, timezone.utc), outgoing=True),
                SimpleNamespace(id=11, chat=SimpleNamespace(id=77), from_user=SimpleNamespace(id=77),
                    date=datetime.fromtimestamp(101, timezone.utc), outgoing=False),
            ]
            class Effects:
                @asynccontextmanager
                async def connection(self, store, role, idle, updates=False):
                    self.role = role
                    yield self
                @property
                def me(self):
                    return SimpleNamespace(id=42 if self.role == "personal" else 8, is_bot=False)
                def subscribe(self, app, peer, callback):
                    self.callback = callback
                async def initialize(self):
                    for message in messages + [messages[-1]]:
                        await self.callback(None, message)
                async def run_call(self, store, role, call_args):
                    calls.append((role, call_args))
                    return dict(call_id="fixture", state="audio_stream_ended")
            with redirect_stdout(io.StringIO()):
                await cli.watch(store, args, effects=Effects())
            self.assertEqual(trigger.status(), "completed")
            self.assertEqual(len(calls), 1)
            role, request = calls[0]
            self.assertEqual((role, request.peer, request.agent, request.task_title), ("caller", "42", "3d-house", "Print Ops"))
            self.assertEqual((request.transcript, request.session, request.kind), ("provided only", "session-a", "problem"))
            self.assertTrue(request.idempotency_key)
            self.assertIsNone(request.say)
            self.assertFalse(request.dry_run)

    async def test_real_service_journals_and_mirrors_watch_audio_and_failure_never_replays(self):
        from telegram_client.call_journal import Journal
        from telegram_client.call_service import run_call
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = AuthStore(root / "mtproto")
            for role, account in (("personal", 42), ("caller", 8)):
                store.save(role, dict(expected_id=account, api_id=11, api_hash="fixture", session="fixture", origin="login"))
            audio = root / "speech.wav"
            audio.write_bytes(b"fixture")
            trigger = TriggerStore(root / "trigger.sqlite")
            trigger.arm(42, 77, 10, 100)
            args = cli.parser("personal").parse_args([
                "watch-call", "--trigger", str(trigger.path), "--audio", str(audio),
                "--agent", "3d-house", "--transcript", "unverified fixture",
            ])
            message = SimpleNamespace(id=11, chat=SimpleNamespace(id=77), from_user=SimpleNamespace(id=77),
                date=datetime.fromtimestamp(101, timezone.utc), outgoing=False)
            class Effects(cli.WatchEffects):
                def __init__(self):
                    self.dials = 0
                    self.sent = []
                    self.edits = []
                @asynccontextmanager
                async def connection(self, store, role, idle, updates=False):
                    yield SimpleNamespace(me=SimpleNamespace(id=42 if role == "personal" else 8, is_bot=False), initialize=self.initialize)
                def subscribe(self, app, peer, callback):
                    self.callback = callback
                async def initialize(self):
                    await self.callback(None, message)
                    await self.callback(None, message)
                async def run_call(self, store, role, args):
                    return await run_call(store, role, args, effects=self, env={})
                def parse_mode(self):
                    return "disabled"
                async def resolve(self, app, store, role, peer):
                    return 42
                async def send_message(self, recipient, text, **options):
                    self.sent.append((recipient, text, options))
                    return SimpleNamespace(id=len(self.sent), chat=SimpleNamespace(id=recipient))
                async def edit_message_text(self, recipient, message_id, text, **options):
                    self.edits.append((recipient, message_id, text))
                    return SimpleNamespace(id=message_id, chat=SimpleNamespace(id=recipient))
                def synthesize(self, text, directory, config_dir):
                    directory.mkdir(mode=0o700)
                    output = directory / "speech.wav"
                    output.write_bytes(b"fixture")
                    return output
                def join_audio(self, intro, raw, directory):
                    return intro
                async def dial(self, *args):
                    self.dials += 1
                    raise ClientError("CALL_INCOMPLETE")
            effects = Effects()
            # The mirror connection must provide its send/edit capabilities like Pyrogram.
            original_connection = effects.connection
            @asynccontextmanager
            async def connection(store, role, idle, updates=False):
                async with original_connection(store, role, idle, updates) as app:
                    app.send_message = effects.send_message
                    app.edit_message_text = effects.edit_message_text
                    yield app
            effects.connection = connection
            with redirect_stdout(io.StringIO()):
                await cli.watch(store, args, effects=effects)
            self.assertEqual(trigger.status(), "uncertain")
            self.assertEqual(effects.dials, 1)
            rows = Journal(store.root).history()
            self.assertEqual(len(rows), 1)
            row = rows[0]
            self.assertEqual((row["recipient_id"], row["status"], row["failure"]), (42, "failed", "CALL_INCOMPLETE"))
            self.assertEqual(row["transcript_kind"], "sender_provided_unverified")
            self.assertTrue(all(item[0] == 42 for item in effects.sent + effects.edits))
            self.assertTrue(effects.sent)
            self.assertEqual(effects.edits[0][1], 1)
            with self.assertRaisesRegex(ClientError, "TRIGGER_NOT_ARMED"):
                await cli.watch(store, args, effects=effects)
            self.assertEqual(effects.dials, 1)

    async def test_import_source_idle_blocks_before_online(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = AuthStore(root / "mtproto")
            for role, account in (("personal", 42), ("caller", 8)):
                store.save(role, dict(expected_id=account, api_id=11, api_hash="fixture", session="fixture", origin="import"))
            audio = root / "speech.wav"
            audio.write_bytes(b"fixture")
            trigger = TriggerStore(root / "trigger.sqlite")
            trigger.arm(42, 77, 10, 100)
            args = cli.parser("personal").parse_args(["watch-call", "--trigger", str(trigger.path), "--audio", str(audio)])
            with patch.object(cli.WatchEffects, "connection", side_effect=AssertionError("online")):
                with self.assertRaisesRegex(ClientError, "SOURCE_SESSION_OWNERSHIP_NOT_CONFIRMED"):
                    await cli.watch(store, args)
            self.assertEqual(trigger.status(), "armed")

    async def test_native_readiness_refuses_before_provider_preparation(self):
        config = {"voice": {"status": "confirmed"}, "agent": {"protocol": "call-agent-json-v1", "command": ["must-not-run"]}}
        with patch.object(call_lib.NativeOwner, "readiness", return_value={"configured": True}), patch("telegram_client.providers.build_providers", side_effect=AssertionError("provider side effect")), patch("telegram_client.providers.JsonCallAgent.describe", side_effect=AssertionError("agent side effect")):
            with self.assertRaisesRegex(ClientError, "CONVERSATION_REQUIRES_IDENTIFIED_SERVICE"):
                await call_lib.start_conversation(None, config, call_lib.Consent(True, True, True))


if __name__ == "__main__":
    unittest.main()
