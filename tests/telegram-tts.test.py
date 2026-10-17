"""Offline regression tests for configured speech; transport fakes never call Fish."""
import io
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'features'))
from telegram_client.core import ClientError
from telegram_client.tts import synthesize


def wav_bytes():
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(struct.pack('<800h', *([1000] * 800)))
    return buffer.getvalue()


def config(root, **changes):
    value = {'version': 1, 'provider': 'fish_audio', 'model': 'pinned-model',
             'voice_id': 'a' * 32, 'latency': 'balanced', 'format': 'wav',
             'credential_source': {'type': 'env', 'name': 'TEST_FISH_KEY'}}
    value.update(changes)
    (root / 'voice.json').write_text(json.dumps(value))
    (root / 'voice.json').chmod(0o600)
    return value


class SpeechTests(unittest.TestCase):
    def test_missing_config_never_runs_host_voice(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with patch.dict(os.environ, {'TG_CTL_CONFIG_DIR': str(root)}):
                with self.assertRaisesRegex(ClientError, 'TTS_CONFIG_MISSING'):
                    synthesize('Привет', root / 'out', run=lambda *a, **k: self.fail('host fallback'), which=lambda n: n)

    def test_empty_and_oversized_text_fail_before_configuration(self):
        with tempfile.TemporaryDirectory() as folder:
            for text, code in [(' ', 'TEXT_EMPTY'), ('x' * 1001, 'TEXT_TOO_LONG')]:
                with self.subTest(code=code), self.assertRaisesRegex(ClientError, code):
                    synthesize(text, folder, config_dir=folder)


class FishTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        config(self.root)
        self.env = patch.dict(os.environ, {'TEST_FISH_KEY': 'private-test-secret'})
        self.env.start()
        self.addCleanup(self.env.stop)

    def synth(self, connection):
        from telegram_client.tts_fish import fetch_audio_in_process
        with patch('telegram_client.tts.fetch_audio', side_effect=fetch_audio_in_process), patch('telegram_client.tts_fish.http.client.HTTPSConnection', return_value=connection):
            return synthesize('Привет!', self.root / 'audio', config_dir=self.root)

    def test_pinned_request_private_audio_and_metrics(self):
        connection = FakeConnection(wav_bytes())
        out = self.synth(connection)
        self.assertEqual(out.read_bytes(), wav_bytes())
        self.assertEqual(out.stat().st_mode & 0o777, 0o600)
        self.assertEqual(out.parent.stat().st_mode & 0o777, 0o700)
        report_path = out.parent / 'tts.json'
        report = json.loads(report_path.read_text())
        self.assertEqual(report_path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(report['provider'], 'fish_audio')
        self.assertEqual(report['voice_id'], 'a' * 32)
        self.assertGreaterEqual(report['total_synth_ms'], report['time_to_first_audio_byte_ms'])
        self.assertNotIn('private-test-secret', report_path.read_text())
        method, target, body, headers = connection.request_data
        self.assertEqual((method, target), ('POST', '/v1/tts'))
        self.assertEqual(json.loads(body), {'text': 'Привет!', 'reference_id': 'a' * 32,
                                         'format': 'wav', 'latency': 'balanced'})
        self.assertEqual(headers['model'], 'pinned-model')
        self.assertEqual(headers['Authorization'], 'Bearer private-test-secret')
        self.assertTrue(connection.closed)

    def test_status_redirect_empty_and_invalid_audio_fail_without_fallback(self):
        for status, data in [(302, wav_bytes()), (401, b'private-test-secret'),
                             (500, b'error'), (200, b''), (200, b'{"error":"private-test-secret"}'),
                             (200, b'RIFF')]:
            with self.subTest(status=status, data=data), self.assertRaises(ClientError) as error:
                self.synth(FakeConnection(data, status))
            self.assertNotIn('private-test-secret', str(error.exception))
            self.assertFalse((self.root / 'audio' / 'say.wav').exists())

    def test_network_error_is_redacted_and_closed(self):
        connection = FakeConnection(wav_bytes())
        connection.getresponse = lambda: (_ for _ in ()).throw(TimeoutError('private-test-secret'))
        with self.assertRaisesRegex(ClientError, '^TTS_PROVIDER_FAILED$') as error:
            self.synth(connection)
        self.assertIsNone(error.exception.__cause__)
        self.assertTrue(connection.closed)

    def test_missing_key_fails_before_network(self):
        with patch.dict(os.environ, {'TEST_FISH_KEY': ''}), patch('telegram_client.tts_fish.subprocess.run') as transport:
            with self.assertRaisesRegex(ClientError, 'TTS_CREDENTIAL_UNAVAILABLE'):
                synthesize('hello', self.root / 'audio', config_dir=self.root)
            transport.assert_not_called()

    def test_size_content_type_and_declared_length_are_bounded(self):
        from telegram_client.tts_fish import MAX_AUDIO_BYTES
        for headers, body in [({'Content-Length': str(MAX_AUDIO_BYTES + 1)}, wav_bytes()),
                              ({'Content-Length': 'invalid'}, wav_bytes()),
                              ({'Content-Length': '5'}, wav_bytes()),
                              ({'Content-Type': 'application/json'}, wav_bytes())]:
            connection = FakeConnection(body)
            connection.response.getheader = lambda key, headers=headers: headers.get(key, 'audio/wav' if key == 'Content-Type' else None)
            with self.subTest(headers=headers), self.assertRaisesRegex(ClientError, 'TTS_AUDIO_INVALID'):
                self.synth(connection)
        connection = FakeConnection(wav_bytes() + b'x' * MAX_AUDIO_BYTES)
        with self.assertRaisesRegex(ClientError, 'TTS_AUDIO_INVALID'):
            self.synth(connection)

    def test_first_byte_timing_is_distinct_from_completion_and_deadline(self):
        connection = FakeConnection(wav_bytes())
        ticks = iter([0, .1, .2, .3, .4, .5, .6, .7])
        with patch('telegram_client.tts_fish.time.monotonic', side_effect=lambda: next(ticks)):
            out = self.synth(connection)
        report = json.loads((out.parent / 'tts.json').read_text())
        self.assertEqual(report['time_to_first_audio_byte_ms'], 300)
        self.assertEqual(report['total_synth_ms'], 700)
        other = FakeConnection(wav_bytes())
        ticks = iter([0, 61])
        with patch('telegram_client.tts_fish.time.monotonic', side_effect=lambda: next(ticks)):
            with self.assertRaisesRegex(ClientError, 'TTS_PROVIDER_TIMEOUT'):
                self.synth(other)
        self.assertTrue(other.closed)

    def test_truncated_wav_rejected(self):
        with self.assertRaisesRegex(ClientError, 'TTS_AUDIO_INVALID'):
            self.synth(FakeConnection(wav_bytes()[:-2]))


    def test_fish_streaming_sizes_are_normalized_without_changing_pcm(self):
        original = wav_bytes()
        streamed = bytearray(original)
        struct.pack_into('<I', streamed, 4, 0xffffff24)
        struct.pack_into('<I', streamed, 40, 0xffffff00)
        out = self.synth(FakeConnection(bytes(streamed)))
        self.assertEqual(out.read_bytes(), original)
        self.assertEqual(out.read_bytes()[44:], bytes(streamed)[44:])
        with wave.open(str(out), 'rb') as audio:
            self.assertEqual(audio.getnframes(), 800)
        report = json.loads((out.parent / 'tts.json').read_text())
        self.assertEqual(report['voice_id'], 'a' * 32)

    def test_documented_all_ones_streaming_header_is_normalized(self):
        original = wav_bytes()
        streamed = bytearray(original)
        struct.pack_into('<I', streamed, 4, 0xffffffff)
        struct.pack_into('<I', streamed, 40, 0xffffffff)
        self.assertEqual(self.synth(FakeConnection(bytes(streamed))).read_bytes(), original)

    def test_streaming_header_does_not_weaken_audio_validation(self):
        base = bytearray(wav_bytes())
        struct.pack_into('<I', base, 4, 0xffffff24)
        struct.pack_into('<I', base, 40, 0xffffff00)
        wrong_rate = bytearray(base)
        struct.pack_into('<I', wrong_rate, 28, 999)
        wrong_align = bytearray(base)
        struct.pack_into('<H', wrong_align, 32, 3)
        wrong_format = bytearray(base)
        struct.pack_into('<H', wrong_format, 20, 3)
        wrong_riff = bytearray(base)
        struct.pack_into('<I', wrong_riff, 4, 123456)
        unknown_size = bytearray(base)
        struct.pack_into('<I', unknown_size, 40, 0xffffff01)
        overlong = bytes(base[:44]) + bytes(8000 * 2 * 121)
        cases = [base[:44], base[:-1], wrong_rate, wrong_align, wrong_format,
                 wrong_riff, unknown_size, overlong]
        for payload in cases:
            with self.subTest(size=len(payload)), self.assertRaisesRegex(ClientError, 'TTS_AUDIO_INVALID'):
                self.synth(FakeConnection(bytes(payload)))



class WorkerBoundaryTests(unittest.TestCase):
    def test_worker_uses_stdin_for_secrets_and_preserves_timing(self):
        from telegram_client.tts_config import load_config
        from telegram_client.tts_fish import fetch_audio
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            config(root)
            timing = {'time_to_first_audio_byte_ms': 10, 'total_synth_ms': 20}
            result = SimpleNamespace(returncode=0, stdout=json.dumps(timing).encode() + b'\n' + wav_bytes())
            with patch.dict(os.environ, {'TEST_FISH_KEY': 'private-test-secret'}), patch('telegram_client.tts_fish.subprocess.run', return_value=result) as run:
                audio, measured = fetch_audio('sensitive utterance', load_config(root))
            self.assertEqual(audio, wav_bytes())
            self.assertEqual(measured, timing)
            args, kwargs = run.call_args
            self.assertNotIn('private-test-secret', repr(args))
            self.assertNotIn('sensitive utterance', repr(args))
            self.assertEqual(json.loads(kwargs['input'])['key'], 'private-test-secret')
            self.assertEqual(kwargs['timeout'], 60)

    def test_hard_wall_deadline_kills_blocked_worker_without_network(self):
        import subprocess
        import time
        from telegram_client.tts_config import load_config
        from telegram_client.tts_fish import fetch_audio
        original = subprocess.run
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            config(root)
            def blocked_worker(argv, **kwargs):
                return original([sys.executable, '-c', 'import time; time.sleep(5)'], **kwargs)
            started = time.monotonic()
            with patch.dict(os.environ, {'TEST_FISH_KEY': 'private-test-secret'}), patch('telegram_client.tts_fish.TOTAL_TIMEOUT_SECONDS', .05), patch('telegram_client.tts_fish.subprocess.run', side_effect=blocked_worker):
                with self.assertRaisesRegex(ClientError, '^TTS_PROVIDER_TIMEOUT$'):
                    fetch_audio('hello', load_config(root))
            self.assertLess(time.monotonic() - started, 2)

    def test_real_worker_rejects_invalid_protocol_without_network_or_traceback(self):
        import subprocess
        result = subprocess.run([sys.executable, '-m', 'telegram_client.tts_fish'],
                                input=b'{"key":"private-test-secret"}', capture_output=True,
                                timeout=5, env={**os.environ, 'PYTHONPATH': str(Path(__file__).resolve().parents[1] / 'features')})
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, b'')
        self.assertEqual(json.loads(result.stdout), {'error': 'TTS_PROVIDER_FAILED'})

    def test_worker_failure_and_invalid_timing_are_redacted(self):
        from telegram_client.tts_config import load_config
        from telegram_client.tts_fish import fetch_audio
        from types import SimpleNamespace
        cases = [b'private-test-secret', b'{"error":"private-test-secret"}\n',
                 b'{"time_to_first_audio_byte_ms": 50, "total_synth_ms": 10}\n',
                 b'{"time_to_first_audio_byte_ms": NaN, "total_synth_ms": 10}\n']
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            config(root)
            for data in cases:
                with self.subTest(data=data), patch.dict(os.environ, {'TEST_FISH_KEY': 'private-test-secret'}), patch('telegram_client.tts_fish.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout=data)):
                    with self.assertRaisesRegex(ClientError, '^TTS_PROVIDER_FAILED$'):
                        fetch_audio('hello', load_config(root))


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_untrusted_urls_invalid_fields_and_inline_keys_refused(self):
        from telegram_client.tts_config import load_config
        bad = [{'base_url': 'https://evil.example/v1/tts'}, {'base_url': 'http://api.fish.audio/v1/tts'},
               {'base_url': 'https://api.fish.audio/v1/tts?redirect=x'}, {'model': ''},
               {'voice_id': 'unknown'}, {'format': 'mp3'}, {'latency': 'surprise'},
               {'api_key': 'secret'}, {'credential_source': {'type': 'env', 'name': 'KEY\r\n'}},
               {'credential_source': {'type': 'home_assistant', 'path': 'relative', 'entry_id': 'x'}}]
        for changes in bad:
            with self.subTest(fields=list(changes)):
                config(self.root, **changes)
                with self.assertRaises(ClientError):
                    load_config(self.root)

    def test_malformed_insecure_oversized_and_symlink_config(self):
        from telegram_client.tts_config import load_config, MAX_CONFIG_BYTES
        path = self.root / 'voice.json'
        for payload in ['{bad', '[]', '{"version": true}', 'x' * (MAX_CONFIG_BYTES + 1)]:
            path.write_text(payload)
            path.chmod(0o600)
            with self.subTest(size=len(payload)), self.assertRaisesRegex(ClientError, 'TTS_CONFIG_INVALID'):
                load_config(self.root)
        config(self.root)
        path.chmod(0o666)
        with self.assertRaisesRegex(ClientError, 'TTS_CONFIG_INVALID'):
            load_config(self.root)
        path.unlink()
        path.symlink_to(self.root / 'absent')
        with self.assertRaisesRegex(ClientError, 'TTS_CONFIG_INVALID'):
            load_config(self.root)

    def test_home_assistant_selects_exact_entry_without_copying_key(self):
        from telegram_client.tts_config import load_config, resolve_credential
        source = self.root / 'entries'
        source.write_text(json.dumps({'data': {'entries': [
            {'entry_id': 'wrong', 'data': {'api_key': 'wrong-key'}},
            {'entry_id': 'chosen', 'domain': 'fish_audio', 'data': {'api_key': 'correct-key'}}]}}))
        source.chmod(0o600)
        config(self.root, credential_source={'type': 'home_assistant', 'path': str(source), 'entry_id': 'chosen'})
        settings = load_config(self.root)
        self.assertEqual(resolve_credential(settings), 'correct-key')
        self.assertNotIn('correct-key', repr(settings))
        self.assertNotIn('correct-key', (self.root / 'voice.json').read_text())
        self.assertEqual(set(self.root.iterdir()), {source, self.root / 'voice.json'})
        source.write_text('{"data":{"entries":[]}}')
        with self.assertRaisesRegex(ClientError, 'TTS_CREDENTIAL_UNAVAILABLE'):
            resolve_credential(settings)

    def test_missing_duplicate_malformed_and_header_injection_credentials(self):
        from telegram_client.tts_config import load_config, resolve_credential
        config(self.root)
        for key in ['', 'bad\nheader', 'bad key', 'é', 'x' * 4097]:
            with self.subTest(size=len(key)), patch.dict(os.environ, {'TEST_FISH_KEY': key}):
                with self.assertRaisesRegex(ClientError, 'TTS_CREDENTIAL_UNAVAILABLE'):
                    resolve_credential(load_config(self.root))
        source = self.root / 'entries'
        config(self.root, credential_source={'type': 'home_assistant', 'path': str(source), 'entry_id': 'chosen'})
        for payload in ['[]', '{bad', '{"data":{"entries":[{"entry_id":"chosen","data":{"api_key":"a"}},{"entry_id":"chosen","data":{"api_key":"b"}}]}}']:
            source.write_text(payload)
            source.chmod(0o600)
            with self.assertRaisesRegex(ClientError, 'TTS_CREDENTIAL_UNAVAILABLE'):
                resolve_credential(load_config(self.root))


class FakeResponse:
    def __init__(self, data, status):
        self.stream = io.BytesIO(data)
        self.status = status

    def read(self, size):
        return self.stream.read(size)

    def getheader(self, name):
        return 'audio/wav' if name == 'Content-Type' else None


class FakeConnection:
    def __init__(self, data, status=200):
        self.response = FakeResponse(data, status)
        self.sock = self
        self.closed = False

    def settimeout(self, timeout):
        self.timeout = timeout

    def request(self, method, target, body, headers):
        self.request_data = method, target, body, headers

    def getresponse(self):
        return self.response

    def close(self):
        self.closed = True


if __name__ == '__main__':
    unittest.main()
