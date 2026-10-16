"""Offline call CLI contracts: bounded private JSON and canonical preflight reasons."""
import asyncio
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'features'))
from telegram_client import cli
from telegram_client.core import AuthStore, ClientError


class CliHardeningTests(unittest.TestCase):
    def run_payload(self, root, payload):
        args = cli.parser('caller').parse_args(['call', '--peer=@alice', '--audio=/not-present.wav', '--context-stdin', '--dry-run'])
        out = io.StringIO()
        with patch('sys.stdin', io.StringIO(payload)), redirect_stdout(out):
            code = asyncio.run(cli.call(AuthStore(root / 'mtproto'), 'caller', args))
        return code, json.loads(out.getvalue())

    def test_json_escaping_preserves_maximum_transcripts(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for transcript in ['\n' * 99_999 + 'x', '\\' * 100_000, '\U0001f600' * 100_000]:
                with self.subTest(character=repr(transcript[:1])):
                    code, result = self.run_payload(root, json.dumps({'transcript': transcript}))
                    self.assertEqual(code, 3)
                    self.assertEqual(result['audio_transcript'], transcript)
                    self.assertFalse((root / 'mtproto').exists())

    def test_all_legal_field_escaping_fits_raw_cap(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            payload = {'transcript': '\U0001f600' * 100_000, 'say': '\U0001f600' * 1000}
            for name in ('agent', 'task', 'project', 'session'):
                payload[name] = '\U0001f600' * 512
                payload[name + '_title'] = '\U0001f600' * 512
                payload[name + '_url'] = 'https://' + '\U0001f600' * 504
            raw = json.dumps(payload)
            self.assertLess(len(raw.encode('utf-8')), 2 * 1024 * 1024)
            code, result = self.run_payload(root, raw)
            self.assertEqual(code, 3)
            self.assertEqual(result['audio_transcript'], payload['transcript'])
            self.assertEqual(result['references']['project']['url'], payload['project_url'])
            self.assertFalse((root / 'mtproto').exists())

    def test_json_cap_refuses_even_valid_oversize_whitespace_before_any_effect(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            payload = json.dumps({'transcript': 'x'}) + ' ' * (2 * 1024 * 1024)
            with patch.object(cli, 'call_plan', side_effect=AssertionError('preflight effect')), patch('telegram_client.call_service.run_call', side_effect=AssertionError('call effect')):
                with self.assertRaisesRegex(ClientError, '^CALL_PAYLOAD_INVALID$'):
                    self.run_payload(root, payload)
            self.assertFalse((root / 'mtproto').exists())

    def test_field_limits_still_apply_inside_bounded_json(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for fields, error in [({'transcript': 'x' * 100_001}, 'TEXT_TOO_LONG'), ({'agent': 'x' * 513}, 'CALL_REFERENCE_INVALID')]:
                with self.subTest(fields=next(iter(fields))), self.assertRaisesRegex(ClientError, '^' + error + '$'):
                    self.run_payload(root, json.dumps(fields))
            self.assertFalse((root / 'mtproto').exists())

    def test_main_preserves_cancelled_call_diagnostics_and_exit_130(self):
        from telegram_client.call_journal import Journal
        from telegram_call_test_support import FakeEffects
        for cancellation in (KeyboardInterrupt, asyncio.CancelledError):
            with self.subTest(cancellation=cancellation.__name__), tempfile.TemporaryDirectory() as folder:
                store = AuthStore(Path(folder) / 'mtproto')
                store.save('caller', dict(expected_id=8, api_id=11, api_hash='fake-secret', session='fake-secret', origin='login'))
                journal = Journal(store.root)
                update = journal.update
                failures = []
                def fail_terminal(call_id, state, **fields):
                    if state == 'cancelled':
                        failures.append(state)
                        raise OSError('private database details')
                    return update(call_id, state, **fields)
                journal.update = fail_terminal
                effects = FakeEffects(failure=cancellation('private cancellation details'))
                out = io.StringIO()
                with patch('telegram_client.call_service.Effects', return_value=effects), patch('telegram_client.call_service.Journal', return_value=journal), redirect_stdout(out):
                    code = cli.main('caller', [f'--store={store.root}', 'call', '--peer=@alice', '--say=Hi'])
                result = json.loads(out.getvalue())
                self.assertEqual(code, 130)
                self.assertEqual(result['error'], 'INTERRUPTED')
                self.assertFalse(result['ok'])
                self.assertEqual(result['state'], 'cancelled')
                self.assertEqual(result['saved_state'], 'attempting')
                self.assertTrue(result['persistence_failed'])
                self.assertEqual(result['audit_warning'], 'CALL_JOURNAL_WRITE_FAILED')
                self.assertEqual(result['mirror_result'], 'updated')
                self.assertEqual(journal.history(result['call_id'])[0]['status'], 'attempting')
                self.assertEqual(effects.events.count('dial'), 1)
                self.assertEqual(failures, ['cancelled'])
                self.assertNotIn('private', out.getvalue())

    def test_real_sigint_preserves_diagnostics_across_asyncio_runner_conversion(self):
        import os
        import signal
        from telegram_client.call_journal import Journal
        from telegram_call_test_support import FakeEffects
        class InterruptEffects(FakeEffects):
            async def dial(self, *args, **kwargs):
                self.events.append('dial')
                asyncio.get_running_loop().call_soon(os.kill, os.getpid(), signal.SIGINT)
                await asyncio.sleep(5)
        original_handler = signal.getsignal(signal.SIGINT)
        for fail_audit in (False, True):
            with self.subTest(fail_audit=fail_audit), tempfile.TemporaryDirectory() as folder:
                store = AuthStore(Path(folder) / 'mtproto')
                store.save('caller', dict(expected_id=8, api_id=11, api_hash='fixture', session='fixture', origin='login'))
                journal = Journal(store.root)
                update = journal.update
                def persist(call_id, state, **fields):
                    if fail_audit and state == 'cancelled':
                        raise OSError('private database details')
                    return update(call_id, state, **fields)
                journal.update = persist
                effects = InterruptEffects()
                out = io.StringIO()
                with patch('telegram_client.call_service.Effects', return_value=effects), patch('telegram_client.call_service.Journal', return_value=journal), redirect_stdout(out):
                    code = cli.main('caller', [f'--store={store.root}', 'call', '--peer=@alice', '--say=Hi'])
                result = json.loads(out.getvalue())
                self.assertEqual(code, 130)
                self.assertEqual(result['error'], 'INTERRUPTED')
                self.assertEqual(result['state'], 'cancelled')
                self.assertEqual(result['persistence_failed'], fail_audit)
                self.assertEqual(result['saved_state'], 'attempting' if fail_audit else 'cancelled')
                self.assertEqual(journal.history(result['call_id'])[0]['status'], result['saved_state'])
                self.assertEqual(effects.events.count('dial'), 1)
                self.assertEqual(signal.getsignal(signal.SIGINT), original_handler)
                self.assertNotIn('private', out.getvalue())

    def test_missing_reasons_are_canonical_exact_and_leave_no_state(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            args = cli.parser('caller').parse_args(['call', '--peer=me', '--say=Hi', '--dry-run'])
            result = cli.call_plan(AuthStore(root / 'mtproto'), 'caller', args, which=lambda name: None, find_spec=lambda name: None)
            self.assertEqual(result['missing_reasons'], [
                {'component': 'session', 'code': 'SESSION_MISSING'},
                {'component': 'personal_session', 'code': 'SESSION_MISSING'},
                {'component': 'tts', 'code': 'TTS_CONFIG_MISSING'},
                {'component': 'ffmpeg', 'code': 'ffmpeg'},
                {'component': 'call_libraries', 'code': 'call_libraries'},
            ])
            self.assertEqual(result['missing'], ['session', 'personal_session', 'tts', 'ffmpeg', 'call_libraries'])
            self.assertFalse(result['ready'])
            self.assertEqual(list(root.iterdir()), [])
            out = io.StringIO()
            with redirect_stdout(out):
                code = cli.main('caller', [f'--store={root / "mtproto"}', 'call-history'])
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(out.getvalue())['calls'], [])
            self.assertFalse((root / 'mtproto' / 'calls' / 'journal.sqlite3').exists())
            self.assertEqual(list(root.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
