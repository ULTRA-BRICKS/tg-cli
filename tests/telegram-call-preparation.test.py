"""Offline cancellation, child ownership and speech boundaries for #761."""
import asyncio
import os
from pathlib import Path
import shutil
import json
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'features'))
from telegram_client import call_service, tts
from telegram_client.call_journal import Journal
from telegram_client.core import AuthStore, ClientError
from telegram_call_test_support import FakeEffects, args_for


class SpeechTests(unittest.IsolatedAsyncioTestCase):
    async def test_blank_tail_never_reaches_synth_and_literal_transcripts_survive(self):
        class StrictEffects(FakeEffects):
            def synthesize(self, text, *args):
                if not text.strip():
                    raise ClientError('TEXT_EMPTY')
                self_text.append(text)
                return super().synthesize(text, *args)
        self_text = []
        with tempfile.TemporaryDirectory() as folder:
            store = AuthStore(Path(folder) / 'mtproto')
            store.save('caller', dict(expected_id=8, api_id=1, api_hash='fake', session='fake', origin='login'))
            source = 'x' + ' ' * 999
            result = await call_service.run_call(store, 'caller', args_for(say=source), StrictEffects(), env={})
            self.assertEqual(result['state'], 'audio_stream_ended')
            row = Journal(store.root).history()[0]
            self.assertEqual(row['source_text'], source)
            self.assertTrue(row['spoken_text'].endswith(source))
            self.assertTrue(all(0 < len(text) <= 1000 and text.strip() for text in self_text))

    async def test_long_metadata_intro_stays_within_tts_limit(self):
        effects = FakeEffects()
        synth = effects.synthesize
        inputs = []
        def bounded(text, *args):
            self.assertTrue(text.strip())
            self.assertLessEqual(len(text), tts.TEXT_LIMIT)
            inputs.append(text)
            return synth(text, *args)
        effects.synthesize = bounded
        with tempfile.TemporaryDirectory() as folder:
            store = AuthStore(Path(folder) / 'mtproto')
            store.save('caller', dict(expected_id=8, api_id=1, api_hash='fake', session='fake', origin='login'))
            args = args_for(say='source', agent='a' * 512, task='t' * 512, project='p' * 512)
            result = await call_service.run_call(store, 'caller', args, effects, env={})
            self.assertEqual(result['state'], 'audio_stream_ended')
            row = Journal(store.root).history()[0]
            self.assertGreater(len(row['intro']), 1000)
            self.assertEqual(''.join(inputs), row['spoken_text'])
            self.assertEqual(row['source_text'], 'source')

    async def test_async_synthesis_cancel_is_journalled_and_never_dials(self):
        effects = FakeEffects()
        entered = asyncio.Event()
        async def synth(*args):
            entered.set()
            await asyncio.sleep(10)
        effects.synthesize = synth
        with tempfile.TemporaryDirectory() as folder:
            store = AuthStore(Path(folder) / 'mtproto')
            store.save('caller', dict(expected_id=8, api_id=1, api_hash='fake', session='fake', origin='login'))
            task = asyncio.create_task(call_service.run_call(store, 'caller', args_for(), effects, env={}))
            await asyncio.wait_for(entered.wait(), .5)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertNotIn('dial', effects.events)
            self.assertEqual(Journal(store.root).history()[0]['status'], 'cancelled')

    async def test_speech_boundaries_use_python_characters(self):
        for text in ['🙂' * 1001, 'a' * 2001, 'a' * 1000, 'abc ' * 700, 'x' + ' ' * 999]:
            with self.subTest(text=text[:10]):
                chunks = list(tts.speech_chunks(text))
                self.assertTrue(all(part.strip() and len(part) <= tts.TEXT_LIMIT for part in chunks))
                self.assertEqual(''.join(chunks).rstrip(), text.rstrip())
        self.assertEqual(list(tts.speech_chunks('hello world', limit=8)), ['hello ', 'world'])
        self.assertEqual(list(tts.speech_chunks('🙂' * 1000)), ['🙂' * 1000])
        intro = 'm' * 1600 + ' Привет'
        self.assertGreater(len(list(tts.speech_chunks(intro))), 1)


class OwnedProcessTests(unittest.IsolatedAsyncioTestCase):
    async def exercise_child(self, timeout=False, join=False):
        from telegram_client.preparation import prepare_audio
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            config = root / 'voice.json'
            config.write_text('{"version":1,"provider":"host"}')
            config.chmod(0o600)
            pids = root / 'pids'
            engine = root / ('ffmpeg' if join else 'espeak-ng')
            engine.write_text('#!' + sys.executable + '\n' +
                "import os, subprocess, sys, time\n" +
                "from pathlib import Path\n" +
                f"child = subprocess.Popen([sys.executable, '-c', {('import signal,time; from pathlib import Path; signal.signal(signal.SIGTERM, signal.SIG_IGN); Path(' + repr(str(root / 'ready')) + ').touch(); time.sleep(60)')!r}])\n" +
                f"while not Path({str(root / 'ready')!r}).exists(): time.sleep(.001)\n" +
                f"Path({str(pids)!r}).write_text(str(os.getpid()) + ' ' + str(child.pid))\n" +
                "time.sleep(60)\n")
            engine.chmod(0o700)
            unrelated = await asyncio.create_subprocess_exec(sys.executable, '-c', 'import time; time.sleep(60)', start_new_session=True)
            try:
                with patch.dict(os.environ, {'PATH': str(root)}):
                    if timeout:
                        task = asyncio.create_task(prepare_audio('synthesize', timeout=.8,
                            text='private text $(never argv)', directory=str(root / 'out'), config_dir=str(root)))
                    else:
                        store = AuthStore(root / 'mtproto')
                        store.save('caller', dict(expected_id=8, api_id=1, api_hash='fake', session='fake', origin='login'))
                        effects = FakeEffects()
                        args = args_for(say='private text $(never argv)')
                        if join:
                            args.audio = root / 'input.wav'
                            args.audio.write_bytes(b'offline fixture')
                            effects.join_audio = call_service.Effects().join_audio
                        else:
                            effects.synthesize = call_service.Effects().synthesize
                        task = asyncio.create_task(call_service.run_call(store, 'caller', args, effects, env={}))
                    for _ in range(100):
                        if pids.exists():
                            break
                        await asyncio.sleep(.01)
                    self.assertTrue(pids.exists(), 'real host preparation child did not start')
                    owned = [int(pid) for pid in pids.read_text().split()]
                    if not timeout:
                        task.cancel()
                        asyncio.get_running_loop().call_later(.05, task.cancel)
                    with self.assertRaises(TimeoutError if timeout else asyncio.CancelledError):
                        await task
                for pid in owned:
                    with self.subTest(pid=pid), self.assertRaises(ProcessLookupError):
                        os.kill(pid, 0)
                self.assertIsNone(unrelated.returncode)
                if timeout:
                    self.assertFalse((root / 'out' / 'say.wav').read_bytes())
                    self.assertEqual((root / 'out' / 'say.txt').stat().st_mode & 0o777, 0o600)
                else:
                    self.assertNotIn('dial', effects.events)
                    self.assertEqual(Journal(store.root).history()[0]['status'], 'cancelled')
            finally:
                unrelated.terminate()
                await unrelated.wait()

    async def test_cancel_during_spawn_still_obtains_and_reaps_owned_child(self):
        from telegram_client.preparation import prepare_audio
        actual_spawn = asyncio.create_subprocess_exec
        entered = asyncio.Event()
        release = asyncio.Event()
        children = []
        async def slow_spawn(*args, **options):
            child = await actual_spawn(*args, **options)
            children.append(child)
            entered.set()
            await release.wait()
            return child
        with patch('telegram_client.preparation.asyncio.create_subprocess_exec', side_effect=slow_spawn):
            task = asyncio.create_task(prepare_audio('synthesize', text='never consumed', directory='/unused', config_dir='/unused'))
            await asyncio.wait_for(entered.wait(), 1)
            task.cancel()
            await asyncio.sleep(0)
            task.cancel()
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(task, 4)
        self.assertIsNotNone(children[0].returncode)
        with self.assertRaises(ProcessLookupError):
            os.killpg(children[0].pid, 0)

    @unittest.skipUnless(shutil.which('ffmpeg'), 'local ffmpeg required')
    async def test_production_worker_synthesis_and_join_private_schema(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            config = root / 'voice.json'
            config.write_text('{"version":1,"provider":"host"}')
            config.chmod(0o600)
            engine = root / 'espeak-ng'
            engine.write_text('#!' + sys.executable + '\n' +
                "import sys, wave, struct\n" +
                "with wave.open(sys.argv[-1], 'wb') as audio:\n" +
                " audio.setparams((1, 2, 8000, 0, 'NONE', 'not compressed'))\n" +
                " audio.writeframes(struct.pack('<800h', *([1000] * 800)))\n")
            engine.chmod(0o700)
            effects = call_service.Effects()
            with patch.dict(os.environ, {'PATH': str(root) + os.pathsep + os.environ['PATH']}):
                audio = await effects.synthesize('private speech', root / 'tts', root)
                self.assertEqual(audio.stat().st_mode & 0o777, 0o600)
                self.assertEqual(audio.parent.stat().st_mode & 0o777, 0o700)
                metadata = call_service.tts_metadata(audio.parent)
                self.assertEqual(metadata['provider'], 'host')
                self.assertEqual(metadata['audio']['audio_duration_ms'], 100)
                self.assertNotIn('private speech', json.dumps(metadata))
                joined = await effects.join_audio(audio, audio, root)
                self.assertEqual(joined.stat().st_mode & 0o777, 0o600)
                from telegram_client.tts_metrics import evaluate_audio
                self.assertAlmostEqual(evaluate_audio(joined)['audio_duration_ms'], 200, delta=1)
                with self.assertRaisesRegex(ClientError, 'TTS_OUTPUT_FAILED'):
                    await effects.join_audio(audio, audio, root)

    @unittest.skipUnless(sys.platform == 'linux', 'Linux descendant reaping evidence')
    async def test_real_sleeping_ffmpeg_and_nested_child_cancelled_and_reaped(self):
        await self.exercise_child(join=True)

    @unittest.skipUnless(sys.platform == 'linux', 'Linux descendant reaping evidence')
    async def test_real_sleeping_host_and_nested_sigterm_ignoring_child_cancelled_and_reaped(self):
        await self.exercise_child()

    @unittest.skipUnless(sys.platform == 'linux', 'Linux descendant reaping evidence')
    async def test_real_child_timeout_reaps_only_owned_group(self):
        await self.exercise_child(timeout=True)


if __name__ == '__main__':
    unittest.main()
