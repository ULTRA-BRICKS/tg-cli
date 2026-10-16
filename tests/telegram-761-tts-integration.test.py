"""Offline #761 integration: real TTS schema, safe configuration and preflight."""
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'features'))
from telegram_client.core import ClientError
from telegram_client import tts_config
from telegram_client.call_service import tts_metadata


class IntegrationTests(unittest.TestCase):
    def test_current_schema_preserves_voice_and_audio_metrics_without_unknown_text(self):
        with tempfile.TemporaryDirectory() as folder:
            report = {'version': 1, 'provider': 'fish_audio', 'model': 'pinned-model',
                      'voice_id': 'a' * 32, 'latency': 'balanced',
                      'time_to_first_audio_byte_ms': 100, 'total_synth_ms': 500,
                      'audio': {'audio_duration_ms': 1000, 'sample_rate_hz': 8000,
                                'real_time_factor': .5, 'rms_dbfs': -20,
                                'naturalness_score': None, 'secret': 'never'},
                      'api_key': 'never'}
            (Path(folder) / 'tts.json').write_text(json.dumps(report))
            result = tts_metadata(folder)
            self.assertEqual(result['voice_id'], 'a' * 32)
            self.assertEqual(result['audio']['audio_duration_ms'], 1000)
            self.assertNotIn('never', json.dumps(result))

    def test_metadata_rejects_nan_nonobject_oversize_and_symlink(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'tts.json'
            for payload in ['{"total_synth_ms":NaN}', json.dumps({'total_synth_ms': 10 ** 400}), json.dumps({'audio': {'audio_duration_ms': -10}}), '[]', 'x' * 65537]:
                path.write_text(payload)
                with self.subTest(payload=payload[:30]), self.assertRaisesRegex(ClientError, 'TTS_METADATA_INVALID'):
                    tts_metadata(folder)
            path.unlink()
            path.symlink_to(Path(folder) / 'absent')
            with self.assertRaisesRegex(ClientError, 'TTS_METADATA_INVALID'):
                tts_metadata(folder)

    def test_root_owned_explicit_credential_source_is_allowed_but_config_is_not(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'entries'
            path.write_text(json.dumps({'data': {'entries': [{'entry_id': 'chosen', 'domain': 'fish_audio', 'data': {'api_key': 'test-key'}}]}}))
            settings = tts_config.VoiceConfig('fish_audio', credential_source={'type': 'home_assistant', 'path': str(path), 'entry_id': 'chosen'})
            info = SimpleNamespace(st_mode=0o100644, st_uid=0, st_size=path.stat().st_size)
            with patch.object(tts_config.os, 'getuid', return_value=1000), patch.object(tts_config.os, 'fstat', return_value=info):
                self.assertEqual(tts_config.resolve_credential(settings), 'test-key')
                with self.assertRaisesRegex(ClientError, 'TTS_CONFIG_INVALID'):
                    tts_config.read_json(path, 'TTS_CONFIG_INVALID')
            for uid, mode in [(1001, 0o100644), (0, 0o100664), (0, 0o040644)]:
                with patch.object(tts_config.os, 'getuid', return_value=1000), patch.object(tts_config.os, 'fstat', return_value=SimpleNamespace(st_mode=mode, st_uid=uid, st_size=10)):
                    with self.assertRaisesRegex(ClientError, 'TTS_CREDENTIAL_UNAVAILABLE'):
                        tts_config.resolve_credential(settings)

    def test_ha_domain_and_entry_identity_are_both_required(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'entries'
            settings = tts_config.VoiceConfig('fish_audio', credential_source={'type': 'home_assistant', 'path': str(path), 'entry_id': 'chosen'})
            for entries in [[{'entry_id': 'chosen', 'domain': 'other', 'data': {'api_key': 'test-key'}}],
                            [{'entry_id': 'chosen', 'domain': 'fish_audio', 'data': {'api_key': 'test-key'}}, {'entry_id': 'chosen', 'domain': 'other'}]]:
                path.write_text(json.dumps({'data': {'entries': entries}}))
                with self.assertRaisesRegex(ClientError, 'TTS_CREDENTIAL_UNAVAILABLE'):
                    tts_config.resolve_credential(settings)

    def test_symlinked_credential_parent_is_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'actual').mkdir()
            (root / 'actual' / 'entries').write_text('{}')
            (root / 'link').symlink_to(root / 'actual', target_is_directory=True)
            settings = tts_config.VoiceConfig('fish_audio', credential_source={'type': 'home_assistant', 'path': str(root / 'link' / 'entries'), 'entry_id': 'chosen'})
            with self.assertRaisesRegex(ClientError, 'TTS_CREDENTIAL_UNAVAILABLE'):
                tts_config.read_json(root / 'link' / 'entries', 'TTS_CREDENTIAL_UNAVAILABLE', credential_source=True)

    def test_no_getuid_fails_with_safe_code(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'data'
            path.write_text('{}')
            with patch.object(tts_config.os, 'getuid', None):
                with self.assertRaisesRegex(ClientError, 'TTS_CONFIG_INVALID'):
                    tts_config.read_json(path, 'TTS_CONFIG_INVALID')

    def test_preflight_reads_only_canonical_settings_and_reports_pinned_neural_voice(self):
        from telegram_client import cli
        from telegram_client.core import AuthStore
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'voice.json').write_text(json.dumps({'version': 1, 'provider': 'fish_audio', 'model': 'pinned', 'voice_id': 'a' * 32, 'latency': 'balanced', 'format': 'wav', 'credential_source': {'type': 'home_assistant', 'path': '/must/not/be/read', 'entry_id': 'chosen'}}))
            (root / 'voice.json').chmod(0o600)
            args = cli.parser('caller').parse_args(['call', '--peer=@alice', '--say=Hi', '--dry-run'])
            def which(name):
                self.assertNotIn(name, ('espeak', 'espeak-ng', 'say'))
                return '/fake/' + name
            with patch('telegram_client.tts_config.resolve_credential', side_effect=AssertionError('credential access')):
                result = cli.call_plan(AuthStore(root / 'mtproto'), 'caller', args, which=which, find_spec=lambda name: object())
            self.assertEqual(result['tts']['provider'], 'fish_audio')
            self.assertEqual(result['tts']['voice_id'], 'a' * 32)
            self.assertEqual(result['tts']['model'], 'pinned')
            self.assertIsNone(result['tts_engine'])
            self.assertFalse((root / 'mtproto').exists())
            self.assertNotIn('/must/not/be/read', json.dumps(result['tts']))
            (root / 'voice.json').unlink()
            result = cli.call_plan(AuthStore(root / 'mtproto'), 'caller', args, which=which, find_spec=lambda name: object())
            self.assertIn({'component': 'tts', 'code': 'TTS_CONFIG_MISSING'}, result['missing_reasons'])

    def test_call_preflight_never_reads_auth_contents_even_with_existing_sessions(self):
        from telegram_client import cli
        from telegram_client.core import AuthStore
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            store = AuthStore(root / 'mtproto')
            store.root.mkdir(mode=0o700)
            for role in ('caller', 'personal'):
                store.path(role).write_text('not JSON: private auth contents must not be read')
                store.path(role).chmod(0o600)
            (root / 'voice.json').write_text('{"version":1,"provider":"host"}')
            (root / 'voice.json').chmod(0o600)
            args = cli.parser('caller').parse_args(['call', '--peer=me', '--say=Hi', '--dry-run'])
            with patch.object(store, 'load', side_effect=AssertionError('auth credential read')):
                result = cli.call_plan(store, 'caller', args, which=lambda name: '/fixture/' + name, find_spec=lambda name: object())
            self.assertIsNone(result['recipient_id'])
            self.assertFalse(result['session_checks']['auth_contents_checked'])
            self.assertFalse(result['session_checks']['identity_verified'])
            self.assertIn('session_identity_unverified', result['missing'])
            self.assertIn('source_session_origin_unverified', result['missing'])
            self.assertNotIn('not JSON', json.dumps(result))
            store.path('caller').chmod(0o644)
            result = cli.call_plan(store, 'caller', args, which=lambda name: '/fixture/' + name, find_spec=lambda name: object())
            self.assertIn({'component': 'session', 'code': 'INSECURE_STORE_FILE'}, result['missing_reasons'])

    def test_synthesis_schema_persists_every_chunk_and_honest_aggregate(self):
        import asyncio
        from telegram_call_test_support import FakeEffects, args_for
        from telegram_client.core import AuthStore
        from telegram_client.call_journal import Journal
        from telegram_client.call_service import run_call
        from telegram_client.tts import synthesize
        from telegram_client.tts_config import VoiceConfig
        import io
        import wave
        import struct
        output = io.BytesIO()
        with wave.open(output, 'wb') as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(8000)
            wav.writeframes(struct.pack('<800h', *([1000] * 800)))
        class RealSchemaEffects(FakeEffects):
            def synthesize(self, text, directory, config_dir):
                return synthesize(text, directory, config_dir=config_dir)
        with tempfile.TemporaryDirectory() as folder:
            store = AuthStore(Path(folder) / 'mtproto')
            store.save('caller', {'api_id': 1, 'api_hash': 'fixture', 'session': 'fixture', 'expected_id': 8, 'origin': 'login'})
            settings = VoiceConfig('fish_audio', 'pinned', 'a' * 32, 'balanced', {'type': 'env', 'name': 'UNREAD'})
            with patch('telegram_client.tts.load_config', return_value=settings), patch('telegram_client.tts.fetch_audio', return_value=(output.getvalue(), {'time_to_first_audio_byte_ms': 50, 'total_synth_ms': 200})):
                result = asyncio.run(run_call(store, 'caller', args_for(say='x' * 1000), effects=RealSchemaEffects()))
            self.assertNotIn('error', result)
            record = Journal(store.root).history(call_id=result['call_id'])[0]
            metrics = record['tts']
            self.assertGreater(len(metrics['segments']), 1)
            for part in metrics['segments']:
                self.assertEqual(part['voice_id'], 'a' * 32)
                self.assertEqual(part['audio']['audio_duration_ms'], 100)
            aggregate = metrics['aggregate']
            self.assertEqual(aggregate['total_synth_ms'], len(metrics['segments']) * 200)
            self.assertEqual(aggregate['real_time_factor'], 2)
            self.assertIsNone(aggregate['time_to_first_playback_ms'])

    def test_join_audio_is_private_and_never_overwrites_existing_file(self):
        from telegram_client.preparation_worker import join_audio
        def convert(argv, **options):
            output = Path(argv[-1])
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            output.write_bytes(b'fake audio')
            return SimpleNamespace(returncode=0)
        with tempfile.TemporaryDirectory() as folder:
            with patch('telegram_client.preparation_worker.subprocess.run', side_effect=convert):
                out = join_audio('intro.wav', 'body.wav', folder)
                self.assertEqual(out.stat().st_mode & 0o777, 0o600)
                with self.assertRaisesRegex(ClientError, 'TTS_OUTPUT_FAILED'):
                    join_audio('intro.wav', 'body.wav', folder)


if __name__ == '__main__':
    unittest.main()
