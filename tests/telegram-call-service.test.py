"""Identified outbound calls: offline fakes, temporary stores, no Telegram dependencies."""
import asyncio
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "features"))
from telegram_client import cli
from telegram_client.core import AuthStore


class PreparationTests(unittest.TestCase):
    def test_existing_dry_run_includes_identified_spoken_text_without_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "mtproto"
            args = cli.parser("caller").parse_args([
                "call", "--peer=me", "--say=сломался принтер", "--dry-run"
            ])
            out = io.StringIO()
            with redirect_stdout(out):
                asyncio.run(cli.call(AuthStore(root), "caller", args))
            plan = json.loads(out.getvalue())
            self.assertIn("Привет!", plan.get("spoken_text", ""))
            self.assertIn("неизвест", plan.get("spoken_text", ""))
            self.assertFalse(root.exists())




from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from telegram_client.call_identity import prepare
from telegram_client.call_journal import Journal
from telegram_client.call_service import run_call
from telegram_client.core import ClientError


from telegram_call_test_support import FakeEffects, args_for


class IdentityTests(unittest.TestCase):
    def test_explicit_context_overrides_environment_and_ids_stay_distinct(self):
        plan = prepare(args_for(agent="3d-house", task="OPS-42", task_title="Print Ops", task_url="https://example.test/OPS-42", project="house", session="explicit", kind="problem"), {"RIG_AGENT_ID": "other", "TG_SESSION": "inherited"})
        self.assertIn("Привет! 3d-house. Проблема с Print Ops.", plan["spoken_text"])
        self.assertEqual(plan["references"]["task"], {"id": "OPS-42", "title": "Print Ops", "url": "https://example.test/OPS-42"})
        self.assertEqual(plan["references"]["session"]["id"], "explicit")
        self.assertIn("Print Ops", plan["spoken_text"])

    def test_each_kind_unknown_context_and_env_session(self):
        for kind, word in (("report", "Отчёт"), ("question", "Вопрос"), ("problem", "Проблема")):
            plan = prepare(args_for(kind=kind), {"TG_SESSION": "s-1", "RIG_AGENT_ID": "worker"})
            self.assertIn(word, plan["spoken_text"])
            self.assertIn("неизвестной задач", plan["spoken_text"])
            self.assertEqual(plan["references"]["session"]["id"], "s-1")
            self.assertIsNone(plan["references"]["task"]["id"])

    def test_raw_audio_never_claims_transcription(self):
        unknown = prepare(args_for(audio=Path("/tmp/input.wav"), say=None), {})
        self.assertEqual(unknown["transcript_kind"], "unknown")
        self.assertIn("содержание неизвестно", unknown["spoken_text"])
        known = prepare(args_for(audio=Path("/tmp/input.wav"), say=None, transcript="caller claim"), {})
        self.assertEqual(known["transcript_kind"], "sender_provided_unverified")
        self.assertNotIn("caller claim", known["spoken_text"])

    def test_hostile_metadata_and_invalid_urls_are_refused_without_path_use(self):
        for values in ({"agent": "bad\nagent"}, {"task_url": "file:///etc/passwd"}, {"kind": "secret"}):
            with self.assertRaises(ClientError):
                prepare(args_for(**values), {})
        plan = prepare(args_for(agent="../../escape", say="$(touch /tmp/never) <b>literal</b>"), {})
        self.assertEqual(plan["references"]["agent"]["id"], "../../escape")
        self.assertIn("$(touch", plan["spoken_text"])


class ServiceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = AuthStore(Path(self.temp.name) / "mtproto")
        self.store.save("caller", dict(expected_id=8, api_id=11, api_hash="credential-secret", session="auth-secret", origin="login"))
        self.journal = Journal(self.store.root)

    def tearDown(self):
        self.temp.cleanup()

    async def run_service(self, args=None, effects=None):
        return await run_call(self.store, "caller", args or args_for(), effects or FakeEffects(), env={})

    async def test_durable_intent_exists_before_connection_then_mirror_precedes_tts_and_dial(self):
        effects = FakeEffects()
        original = effects.connection
        @asynccontextmanager
        async def inspect(*args):
            self.assertTrue(self.journal.history())
            async with original(*args) as app:
                yield app
        effects.connection = inspect
        result = await self.run_service(effects=effects)
        self.assertEqual(result["state"], "audio_stream_ended")
        self.assertLess(effects.events.index("mirror"), effects.events.index("tts"))
        self.assertLess(effects.events.index("tts"), effects.events.index("dial"))
        row = self.journal.history()[0]
        self.assertEqual(row["recipient_id"], 77)
        self.assertEqual(row["tts"]["segments"][0]["voice"], "fixture")
        self.assertNotIn("secret", row["tts"]["segments"][0])
        self.assertNotIn("auth-secret", json.dumps(row))
        self.assertEqual(self.journal.directory.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.journal.path.stat().st_mode & 0o777, 0o600)
        self.assertIn("attempting", [event["status"] for event in row["transitions"]])

    async def test_all_tts_segments_have_metrics_and_all_spoken_input_is_accounted_for(self):
        effects = FakeEffects()
        args = args_for(say="я" * 1000)
        await self.run_service(args, effects)
        row = self.journal.history()[0]
        segments = row["tts"]["segments"]
        self.assertGreater(len(segments), 1)
        self.assertEqual(sum(segment["input_characters"] for segment in segments), len(row["spoken_text"]))
        self.assertTrue(all(segment["voice"] == "fixture" for segment in segments))

    async def test_later_tts_failure_preserves_metrics_for_completed_segments(self):
        effects = FakeEffects()
        synthesize = effects.synthesize
        count = 0
        def fail_second(*args):
            nonlocal count
            count += 1
            if count == 2:
                raise ClientError("TTS_FAILED")
            return synthesize(*args)
        effects.synthesize = fail_second
        result = await self.run_service(args_for(say="я" * 1000), effects)
        self.assertFalse(result["ok"])
        self.assertNotIn("dial", effects.events)
        row = self.journal.history()[0]
        self.assertEqual(row["status"], "failed")
        self.assertEqual(row["tts"]["segments"][0]["voice"], "fixture")

    async def test_exact_recipient_chunked_mirror_plain_text_and_anchor_result(self):
        effects = FakeEffects()
        transcript = "<b>" + "🙂" * 5000 + "</b>"
        audio = Path(self.temp.name) / "input.wav"
        audio.write_bytes(b"fake")
        result = await self.run_service(args_for(say=None, audio=audio, transcript=transcript, reply_to=123), effects)
        self.assertTrue(len(effects.sent) > 3)
        self.assertTrue(all(peer == 77 and options["parse_mode"] == "disabled" for peer, _, options in effects.sent))
        self.assertEqual(effects.sent[0][2]["reply_to_message_id"], 123)
        self.assertTrue(all(row[2]["reply_to_message_id"] == 1 for row in effects.sent[1:]))
        self.assertTrue(all(len(text.encode("utf-16-le")) // 2 <= 3500 for _, text, _ in effects.sent[1:]))
        self.assertIn(transcript, "".join(text for _, text, _ in effects.sent[1:]))
        self.assertEqual(effects.edits[0][0:2], (77, 1))
        self.assertIn("Статус: Аудиопоток завершён", effects.edits[0][2])
        self.assertIn("prepend", effects.events)
        self.assertEqual(result["recipient_id"], 77)

    async def test_partial_mirror_failure_never_rings_or_runs_tts_and_is_audited(self):
        effects = FakeEffects(mirror_failure=RuntimeError("secret transport"))
        result = await self.run_service(effects=effects)
        self.assertFalse(result["ok"])
        self.assertIn("no call placed", result["warning"])
        self.assertNotIn("dial", effects.events)
        self.assertNotIn("tts", effects.events)
        row = self.journal.history()[0]
        self.assertEqual(row["failure_stage"], "mirror")
        self.assertEqual(row["mirror_ids"], [1])
        self.assertNotIn("secret transport", json.dumps(row))

    async def test_no_answer_timeout_exception_and_cancel_are_terminal_and_not_retried(self):
        for failure, status in ((ClientError("CALL_INCOMPLETE"), "failed"), (TimeoutError(), "timeout"), (RuntimeError("SECRET"), "failed"), (asyncio.CancelledError(), "cancelled")):
            effects = FakeEffects(failure=failure)
            if status == "cancelled":
                with self.assertRaises(asyncio.CancelledError):
                    await self.run_service(effects=effects)
            else:
                await self.run_service(effects=effects)
            row = self.journal.history()[0]
            self.assertEqual(row["status"], status)
            self.assertFalse(row["automatic_retry"])
            self.assertEqual(effects.events.count("dial"), 1)
            self.assertNotIn("SECRET", json.dumps(row))

    async def test_mirror_update_failure_is_an_explicit_warning_and_keeps_actual_outcome(self):
        effects = FakeEffects()
        async def fail(*args, **kw):
            raise RuntimeError("secret")
        effects.edit_message_text = fail
        result = await self.run_service(effects=effects)
        self.assertEqual(result["state"], "audio_stream_ended")
        self.assertEqual(result["warning"], "RuntimeError")
        self.assertEqual(self.journal.history()[0]["mirror_result"], "update_failed")

    async def test_journal_failures_preserve_observed_outcomes_without_retry(self):
        cases = [
            ("mirror", None, None, "audio_stream_ended", "audio_stream_ended", "updated"),
            ("terminal", None, None, "audio_stream_ended", "attempting", "updated"),
            ("mirror", None, RuntimeError("private mirror"), "audio_stream_ended", "audio_stream_ended", "update_failed"),
            ("terminal", ClientError("CALL_INCOMPLETE"), None, "failed", "attempting", "updated"),
            ("terminal", asyncio.CancelledError(), None, "cancelled", "attempting", "updated"),
            ("mirror", None, asyncio.CancelledError(), "audio_stream_ended", "audio_stream_ended", "update_cancelled"),
            ("terminal", asyncio.CancelledError(), asyncio.CancelledError(), "cancelled", "attempting", "update_cancelled"),
            ("terminal", TimeoutError(), RuntimeError("private mirror"), "timeout", "attempting", "update_failed"),
        ]
        for trigger, dial_error, edit_error, observed, saved, mirror_result in cases:
            with self.subTest(trigger=trigger, observed=observed, mirror_result=mirror_result):
                journal = Journal(self.store.root)
                update = journal.update
                failures = []
                def fail_update(call_id, state, **fields):
                    fail = trigger == "terminal" and state in ("audio_stream_ended", "failed", "cancelled", "timeout") or trigger == "mirror" and "mirror_result" in fields
                    if failures or fail:
                        failures.append(state)
                        raise OSError("private database failure")
                    return update(call_id, state, **fields)
                journal.update = fail_update
                effects = FakeEffects(failure=dial_error)
                if edit_error:
                    async def fail_edit(*args, **kwargs):
                        raise edit_error
                    effects.edit_message_text = fail_edit
                if any(isinstance(error, asyncio.CancelledError) for error in (dial_error, edit_error)):
                    with self.assertRaises(asyncio.CancelledError) as caught:
                        await run_call(self.store, "caller", args_for(), effects, journal=journal, env={})
                    result = caught.exception.call_result
                    self.assertIs(caught.exception, dial_error if isinstance(dial_error, asyncio.CancelledError) else edit_error)
                else:
                    result = await run_call(self.store, "caller", args_for(), effects, journal=journal, env={})
                self.assertEqual(result["state"], observed)
                if mirror_result == "updated":
                    self.assertEqual(len(effects.edits), 1)
                    from telegram_client.call_mirror import STATUS_LABELS
                    self.assertIn("Статус: " + STATUS_LABELS[observed], effects.edits[0][2])
                self.assertEqual(result["saved_state"], saved)
                self.assertTrue(result["persistence_failed"])
                self.assertEqual(result["audit_warning"], "CALL_JOURNAL_WRITE_FAILED")
                self.assertEqual(result["mirror_result"], mirror_result)
                self.assertEqual(journal.history(call_id=result["call_id"])[0]["status"], saved)
                self.assertEqual(effects.events.count("dial"), 1)
                self.assertEqual(len(failures), 1)
                self.assertNotIn("private", json.dumps(result))
                if isinstance(dial_error, ClientError):
                    self.assertFalse(result["ok"])
                    self.assertEqual(result["reason"], "CALL_INCOMPLETE")
                if isinstance(edit_error, RuntimeError):
                    self.assertEqual(result["mirror_warning"], "RuntimeError")
                elif mirror_result == "updated":
                    self.assertIsNone(result.get("mirror_warning"))

    async def test_mirror_cancellation_keeps_original_failed_call_diagnostics(self):
        journal = Journal(self.store.root)
        update = journal.update
        def fail_terminal_write(call_id, state, **fields):
            if state == "failed":
                raise OSError("private database failure")
            return update(call_id, state, **fields)
        journal.update = fail_terminal_write
        effects = FakeEffects(failure=ClientError("CALL_INCOMPLETE"))
        async def cancel_edit(*args, **kwargs):
            raise asyncio.CancelledError()
        effects.edit_message_text = cancel_edit
        with self.assertRaises(asyncio.CancelledError) as caught:
            await run_call(self.store, "caller", args_for(), effects, journal=journal, env={})
        result = caught.exception.call_result
        self.assertFalse(result["ok"])
        self.assertEqual(result["state"], "failed")
        self.assertEqual(result["reason"], "CALL_INCOMPLETE")
        self.assertEqual(result["stage"], "dial")
        self.assertTrue(result["persistence_failed"])
        self.assertEqual(result["mirror_result"], "update_cancelled")
        self.assertEqual(effects.events.count("dial"), 1)
        self.assertNotIn("private", json.dumps(result))

    async def test_pre_dial_journal_failure_never_dials_or_retries_persistence(self):
        for failed_state in ("resolved", "mirroring", "mirrored", "synthesizing", "prepared", "attempting"):
            with self.subTest(failed_state=failed_state):
                journal = Journal(self.store.root)
                update = journal.update
                failures = []
                def fail_update(call_id, state, **fields):
                    if failures or state == failed_state:
                        failures.append(state)
                        raise OSError("private database failure")
                    return update(call_id, state, **fields)
                journal.update = fail_update
                effects = FakeEffects()
                result = await run_call(self.store, "caller", args_for(), effects, journal=journal, env={})
                self.assertFalse(result["ok"])
                self.assertTrue(result["persistence_failed"])
                self.assertEqual(result["state"], "failed")
                self.assertTrue(result["call_id"])
                self.assertNotIn("dial", effects.events)
                self.assertEqual(len(failures), 1)
                self.assertNotIn("private", json.dumps(result))

    async def test_dry_run_has_zero_effects_and_zero_journal_writes(self):
        effects = FakeEffects()
        result = await self.run_service(args_for(dry_run=True), effects)
        self.assertTrue(result["dry_run"])
        self.assertIn("Привет!", result["spoken_text"])
        self.assertEqual(effects.events, [])
        self.assertFalse(self.journal.directory.exists())

    async def test_intent_persistence_failure_unverified_topic_and_identity_fail_closed(self):
        effects = FakeEffects()
        with patch.object(Journal, "begin", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                await self.run_service(effects=effects)
        self.assertEqual(effects.events, [])
        with self.assertRaisesRegex(ClientError, "CALL_TOPIC_MAPPING_UNVERIFIED"):
            await self.run_service(args_for(topic=4), effects)
        async def invalid(*args):
            return 8
        effects.resolve = invalid
        await self.run_service(effects=effects)
        self.assertNotIn("dial", effects.events)
        self.assertNotIn("mirror", effects.events)

    async def test_import_safety_is_checked_before_any_network(self):
        self.store.remove("caller")
        self.store.save("caller", dict(expected_id=8, api_id=11, api_hash="h", session="s", origin="import"))
        effects = FakeEffects()
        with self.assertRaisesRegex(ClientError, "SOURCE_SESSION_OWNERSHIP_NOT_CONFIRMED"):
            await self.run_service(effects=effects)
        self.assertEqual(effects.events, [])

    async def test_repeated_token_cannot_dial_even_after_failed_attempt(self):
        effects = FakeEffects(failure=ClientError("CALL_INCOMPLETE"))
        args = args_for(idempotency_key="operation-1")
        await self.run_service(args, effects)
        with self.assertRaisesRegex(ClientError, "CALL_TOKEN_ALREADY_USED"):
            await self.run_service(args, effects)
        self.assertEqual(effects.events.count("dial"), 1)


class BoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_native_conversation_and_unarmed_watcher_refuse_before_transport_imports(self):
        from telegram_client.call_lib import NativeOwner
        with self.assertRaisesRegex(ClientError, "CONVERSATION_REQUIRES_IDENTIFIED_SERVICE"):
            async with NativeOwner().open(None, {}, None):
                self.fail("must not open")
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ClientError, "TRIGGER_NOT_ARMED"):
                await cli.watch(None, SimpleNamespace(trigger=Path(directory) / "missing.sqlite"))

    async def test_cancellation_during_outcome_edit_is_not_swallowed(self):
        with tempfile.TemporaryDirectory() as directory:
            store = AuthStore(Path(directory) / "mtproto")
            store.save("caller", dict(expected_id=8, api_id=11, api_hash="h", session="s", origin="login"))
            effects = FakeEffects()
            async def cancel(*args, **kw):
                raise asyncio.CancelledError()
            effects.edit_message_text = cancel
            with self.assertRaises(asyncio.CancelledError):
                await run_call(store, "caller", args_for(), effects, env={})
            row = Journal(store.root).history()[0]
            self.assertEqual(row["status"], "audio_stream_ended")
            self.assertEqual(row["mirror_result"], "update_cancelled")


class ExpertTests(unittest.TestCase):
    def test_expert_stdin_call_and_offline_history_use_the_same_plan_and_store(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "mtproto"
            out = io.StringIO()
            with patch("sys.stdin", io.StringIO("private speech")), redirect_stdout(out):
                code = cli.main("caller", [f"--store={root}", "call", "--peer=me", "--say-stdin", "--agent=expert", "--dry-run"])
            self.assertEqual(code, 3)
            self.assertIn("private speech", json.loads(out.getvalue())["spoken_text"])
            self.assertFalse(root.exists())
            journal = Journal(root)
            created = journal.begin(prepare(args_for(agent="expert"), {}))
            out = io.StringIO()
            with redirect_stdout(out):
                code = cli.main("caller", [f"--store={root}", "call-history", "show", created["call_id"], "--json"])
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(out.getvalue())["calls"][0]["call_id"], created["call_id"])


class JournalTests(unittest.TestCase):
    def test_parallel_claims_and_readers_preserve_every_transition_and_unique_token(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = Journal(Path(directory) / "mtproto")
            plan = prepare(args_for(agent="worker", session="s-1"), {})
            def create(index):
                row = journal.begin(plan, str(index))
                journal.update(row["call_id"], "failed", recipient_id=77)
                journal.history()
                return row["call_id"]
            with ThreadPoolExecutor(max_workers=8) as pool:
                ids = list(pool.map(create, range(25)))
            rows = journal.history(status="failed", agent="worker", session="s-1", recipient=77)
            self.assertEqual(len(rows), 25)
            self.assertEqual(len(set(ids)), 25)
            self.assertTrue(all(len(row["transitions"]) == 2 for row in rows))
            with self.assertRaisesRegex(ClientError, "CALL_TOKEN_ALREADY_USED"):
                journal.begin(plan, "0")

    def test_history_missing_is_read_only_and_symlink_database_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = Journal(Path(directory) / "mtproto")
            self.assertEqual(journal.history(), [])
            self.assertFalse(journal.directory.exists())
            journal.directory.mkdir(parents=True, mode=0o700)
            journal.directory.parent.chmod(0o700)
            target = Path(directory) / "target"
            target.write_text("untouched")
            journal.path.symlink_to(target)
            with self.assertRaises((ClientError, OSError)):
                journal.begin(prepare(args_for(), {}))
            self.assertEqual(target.read_text(), "untouched")


if __name__ == "__main__":
    unittest.main()
