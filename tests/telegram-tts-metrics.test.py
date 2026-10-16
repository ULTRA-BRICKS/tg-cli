"""Offline regression tests for the TTS evaluator; fixtures are generated PCM."""
import json
import math
import time
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'features'))
from telegram_client import tts_metrics


class MetricsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'audio.wav'

    def audio(self, samples, rate=1000, channels=1, width=2):
        with wave.open(str(self.path), 'wb') as out:
            out.setparams((channels, width, rate, 0, 'NONE', 'not compressed'))
            if width == 1:
                out.writeframes(bytes(samples))
            else:
                out.writeframes(b''.join(int(x).to_bytes(width, 'little', signed=True) for x in samples))
        return self.path

    def test_duration_rms_clipping_and_rtf(self):
        result = tts_metrics.evaluate_audio(self.audio([32767, -32768] * 500), synth_ms=500)
        self.assertEqual(result['audio_duration_ms'], 1000)
        self.assertEqual(result['real_time_factor'], .5)
        self.assertAlmostEqual(result['peak'], 1)
        self.assertGreater(result['rms'], .999)
        self.assertEqual(result['clipping_ratio'], 1)
        self.assertIsNone(result['naturalness_score'])
        self.assertIsNone(result['wer'])
        self.assertEqual(result['asr_status'], 'not_measured')

    def test_silence_runs_and_thresholds(self):
        result = tts_metrics.evaluate_audio(self.audio([0]*100 + [10000]*100 + [0]*200 + [10000]*100 + [0]*100))
        self.assertEqual(result['leading_silence_ms'], 100)
        self.assertEqual(result['trailing_silence_ms'], 100)
        self.assertEqual(result['internal_silence_ms'], 200)
        self.assertEqual(result['internal_silence_count'], 1)
        self.assertEqual(result['silence_threshold_dbfs'], -40)

    def test_all_silence_is_not_double_counted(self):
        result = tts_metrics.evaluate_audio(self.audio([0]*100))
        self.assertEqual(result['leading_silence_ms'], 100)
        self.assertEqual(result['trailing_silence_ms'], 0)
        self.assertEqual(result['internal_silence_ms'], 0)
        self.assertIsNone(result['rms_dbfs'])
        self.assertIsNone(result['real_time_factor'])

    def test_stereo_opposite_phase_does_not_cancel(self):
        result = tts_metrics.evaluate_audio(self.audio([12000, -12000]*100, channels=2))
        self.assertEqual(result['audio_duration_ms'], 100)
        self.assertEqual(result['leading_silence_ms'], 0)
        self.assertGreater(result['rms'], .3)

    def test_unsigned_eight_bit_silence(self):
        result = tts_metrics.evaluate_audio(self.audio([128]*100, width=1))
        self.assertEqual(result['rms'], 0)

    def test_24_and_32_bit_pcm(self):
        for width in (3, 4):
            result = tts_metrics.evaluate_audio(self.audio([2**(width*8-2)]*100, width=width))
            self.assertEqual(result['rms'], .5)

    def test_threshold_precision_across_pcm_widths_and_rates(self):
        for width in (1, 2, 3, 4):
            scale = 2 ** (width * 8 - 1)
            threshold = math.ceil(.999 * scale)
            values = [threshold - 1, min(threshold, scale - 1), -threshold + 1, -threshold]
            expected_values = values[:]
            if width == 1:
                values = [x + 128 for x in values]
            for rate in (11025, 44100, 48000):
                result = tts_metrics.evaluate_audio(self.audio(values * 300, width=width, rate=rate))
                self.assertEqual(result['clipping_ratio'], .25 if width == 1 else .5)
                self.assertEqual(result['peak'], threshold / scale)
                expected = math.sqrt(sum((x / scale) ** 2 for x in expected_values) / 4)
                self.assertAlmostEqual(result['rms'], expected, places=14)
                self.assertEqual(result['sample_rate_hz'], rate)

    def test_silence_boundary_and_partial_window(self):
        for width in (2, 3, 4):
            scale = 2 ** (width * 8 - 1)
            below, above = math.floor(.01 * scale), math.ceil(.01 * scale)
            result = tts_metrics.evaluate_audio(self.audio([below] * 10 + [above] * 10 + [below] * 3, width=width))
            self.assertEqual(result['leading_silence_ms'], 10)
            self.assertEqual(result['trailing_silence_ms'], 3)

    def test_30_second_metrics_bulk_performance_and_reference(self):
        # Relative CPU timing excludes scheduler delays and adapts to CI CPU speed.
        pattern = b''.join(x.to_bytes(2, 'little', signed=True) for x in (0, 12345, -12345, 32767, -32768))
        raw = (pattern * ((30 * 44100 + 4) // 5))[:30 * 44100 * 2]
        with wave.open(str(self.path), 'wb') as out:
            out.setparams((1, 2, 44100, 0, 'NONE', 'not compressed'))
            out.writeframes(raw)
        started = time.process_time()
        peak, square_sum, clipped = 0.0, 0.0, 0
        for index in range(len(raw) // 2):
            sample = int.from_bytes(raw[index * 2:index * 2 + 2], 'little', signed=True) / 32768
            magnitude = abs(sample)
            peak = max(peak, magnitude)
            square_sum += sample * sample
            clipped += magnitude >= .999
        legacy_seconds = time.process_time() - started
        started = time.process_time()
        result = tts_metrics.evaluate_audio(self.path)
        bulk_seconds = time.process_time() - started
        self.assertEqual(result['peak'], peak)
        self.assertAlmostEqual(result['rms'], math.sqrt(square_sum / (30 * 44100)), places=11)
        self.assertEqual(result['clipping_ratio'], clipped / (30 * 44100))
        self.assertEqual(result['audio_duration_ms'], 30000)
        self.assertLess(bulk_seconds, legacy_seconds * .65,
                        f'bulk={bulk_seconds:.6f}s legacy={legacy_seconds:.6f}s')

    def test_transcript_edit_distance_and_normalization(self):
        result = tts_metrics.evaluate_audio(self.audio([1000]*100), reference='Ёж, ДОМ!', hypothesis='еж том')
        self.assertEqual(result['asr_status'], 'measured')
        self.assertEqual(result['wer'], .5)
        self.assertEqual(result['cer'], .2)
        self.assertEqual(result['word_errors'], 1)

    def test_missing_and_empty_hypothesis_are_distinct(self):
        path = self.audio([1000]*100)
        self.assertIsNone(tts_metrics.evaluate_audio(path, reference='тест')['wer'])
        self.assertEqual(tts_metrics.evaluate_audio(path, reference='тест', hypothesis='')['wer'], 1)
        self.assertEqual(tts_metrics.evaluate_audio(path, reference='', hypothesis='')['wer'], 0)
        self.assertIsNone(tts_metrics.evaluate_audio(path, reference='', hypothesis='лишнее')['wer'])

    def test_normalized_expansion_is_rejected_before_edit_distance(self):
        for reference, hypothesis in (('\ufdfa' * 10000, 'x'), ('x', 'ß' * 6000)):
            with self.subTest(reference_length=len(reference), hypothesis_length=len(hypothesis)):
                with patch.object(tts_metrics, '_edit_distance', side_effect=AssertionError('quadratic DP reached')):
                    with self.assertRaisesRegex(ValueError, 'normalized.*10000'):
                        tts_metrics._transcript_metrics(reference, hypothesis)

    def test_different_long_inputs_are_rejected_before_edit_distance(self):
        with patch.object(tts_metrics, '_edit_distance', side_effect=AssertionError('quadratic DP reached')):
            with self.assertRaisesRegex(ValueError, 'work limit.*2000000'):
                tts_metrics._transcript_metrics('a' * 1500, 'b' * 1500)

    def test_equal_and_near_equal_long_inputs_keep_exact_rates(self):
        reference = 'a' * 4999 + 'x' + 'b' * 5000
        for hypothesis, errors in ((reference, 0), (reference[:4999] + 'y' + reference[5000:], 1),
                                   (reference[:4999] + reference[5000:], 1)):
            with self.subTest(errors=errors, hypothesis_length=len(hypothesis)):
                result = tts_metrics._transcript_metrics(reference, hypothesis)
                self.assertEqual(result['character_errors'], errors)
                self.assertEqual(result['cer'], errors / 10000)
                self.assertEqual(result['word_errors'], 0 if hypothesis == reference else 1)

    def test_missing_asr_does_not_measure_or_reject_expanded_reference(self):
        result = tts_metrics._transcript_metrics('\ufdfa' * 10000, None)
        self.assertEqual(result['asr_status'], 'not_measured')
        self.assertIsNone(result['wer'])
        self.assertIsNone(result['cer'])

    def test_word_and_character_work_share_one_inclusive_budget(self):
        with patch.object(tts_metrics, 'MAX_EDIT_CELLS', 8):
            result = tts_metrics._transcript_metrics('a b', 'c d')
        self.assertEqual(result['word_errors'], 2)
        self.assertEqual(result['character_errors'], 2)
        self.assertEqual(result['wer'], 1)
        self.assertEqual(result['cer'], 1)
        with patch.object(tts_metrics, 'MAX_EDIT_CELLS', 7):
            with self.assertRaisesRegex(ValueError, 'work limit'):
                tts_metrics._transcript_metrics('a b', 'c d')

    def test_common_edges_preserve_insertions_deletions_and_empty_metrics(self):
        for reference, hypothesis, distance in (('kitten', 'sitting', 3), ('aabaa', 'aaaa', 1),
                                                 ('aaaa', 'aabaa', 1), ('x', '', 1), ('', 'x', 1)):
            with self.subTest(reference=reference, hypothesis=hypothesis):
                result = tts_metrics._transcript_metrics(reference, hypothesis)
                self.assertEqual(result['character_errors'], distance)
                self.assertEqual(result['cer'], distance / len(reference) if reference else None)

    def test_source_limit_still_applies_before_normalization(self):
        with self.assertRaisesRegex(ValueError, '10000 character'):
            tts_metrics._transcript_metrics('!' * 10001, '')

    def test_rejects_empty_malformed_and_overlong_audio(self):
        self.path.write_bytes(b'not audio')
        with self.assertRaises(ValueError):
            tts_metrics.evaluate_audio(self.path)
        with self.assertRaises(ValueError):
            tts_metrics.evaluate_audio(self.audio([]))
        with self.assertRaises(ValueError):
            tts_metrics.evaluate_audio(self.audio([0]*121000))

    def test_rejects_json_disguised_as_audio(self):
        self.path.write_bytes(b'{"error":"not audio"}')
        with self.assertRaisesRegex(ValueError, 'Invalid audio'):
            tts_metrics.evaluate_audio(self.path)

    @unittest.skipUnless(shutil.which('ffmpeg'), 'optional ffmpeg decoder unavailable')
    def test_decodes_real_local_mp3(self):
        self.audio([5000, -5000]*500)
        mp3 = self.path.with_suffix('.mp3')
        result = subprocess.run([shutil.which('ffmpeg'), '-nostdin', '-v', 'error', '-i', str(self.path), str(mp3)], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        metrics = tts_metrics.evaluate_audio(mp3)
        self.assertGreaterEqual(metrics['audio_duration_ms'], 900)
        self.assertLessEqual(metrics['audio_duration_ms'], 1200)
        self.assertGreater(metrics['rms'], 0)

    @unittest.skipUnless(shutil.which('ffmpeg'), 'optional ffmpeg decoder unavailable')
    def test_lossless_compressed_stereo_opposite_phase_does_not_cancel(self):
        self.audio([12000, -12000]*1000, channels=2)
        flac = self.path.with_suffix('.flac')
        result = subprocess.run([shutil.which('ffmpeg'), '-nostdin', '-v', 'error', '-i', str(self.path), str(flac)], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        metrics = tts_metrics.evaluate_audio(flac)
        self.assertEqual(metrics['channels'], 2)
        self.assertEqual(metrics['sample_rate_hz'], 1000)
        self.assertAlmostEqual(metrics['rms'], 12000 / 32768)
        self.assertEqual(metrics['leading_silence_ms'], 0)

    @unittest.skipUnless(shutil.which('ffmpeg'), 'optional ffmpeg decoder unavailable')
    def test_lossless_compressed_24_bit_levels_preserve_clipping_threshold(self):
        self.audio([8380220]*1000, width=3)
        expected = tts_metrics.evaluate_audio(self.path)
        self.assertEqual(expected['clipping_ratio'], 1)
        flac = self.path.with_suffix('.flac')
        result = subprocess.run([shutil.which('ffmpeg'), '-nostdin', '-v', 'error', '-i', str(self.path), str(flac)], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        actual = tts_metrics.evaluate_audio(flac)
        self.assertEqual(actual['peak'], expected['peak'])
        self.assertEqual(actual['rms'], expected['rms'])
        self.assertEqual(actual['clipping_ratio'], expected['clipping_ratio'])

    @unittest.skipUnless(shutil.which('ffmpeg'), 'optional ffmpeg decoder unavailable')
    def test_decoded_audio_size_is_bounded(self):
        self.audio([12000, -12000]*20000, channels=2)
        flac = self.path.with_suffix('.flac')
        result = subprocess.run([shutil.which('ffmpeg'), '-nostdin', '-v', 'error', '-i', str(self.path), str(flac)], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLess(flac.stat().st_size, 16384)
        with patch.object(tts_metrics, 'MAX_AUDIO_BYTES', 16384):
            with self.assertRaisesRegex(ValueError, 'Decoded audio exceeds'):
                tts_metrics.evaluate_audio(flac)

    def test_rejects_truncated_wav(self):
        self.audio([1000]*100)
        self.path.write_bytes(self.path.read_bytes()[:-2])
        with self.assertRaisesRegex(ValueError, 'Truncated'):
            tts_metrics.evaluate_audio(self.path)

    def test_rejects_invalid_synthesis_time(self):
        path = self.audio([1000]*100)
        for value in (-1, float('inf'), float('nan')):
            with self.assertRaises(ValueError):
                tts_metrics.evaluate_audio(path, synth_ms=value)

    def test_json_cli(self):
        path = self.audio([1000]*100)
        result = subprocess.run([sys.executable, '-m', 'telegram_client.tts_metrics', str(path), '--reference', 'Тест', '--hypothesis', 'тест'], env={**__import__('os').environ, 'PYTHONPATH': str(Path(__file__).resolve().parents[1] / 'features')}, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['wer'], 0)
        self.assertEqual(result.stderr, '')

    def test_corpus_covers_requested_cases(self):
        corpus = ' '.join(tts_metrics.OFFLINE_CORPUS)
        for text in ('Привет', '3d-house', 'Print Ops', '2026', 'API'):
            self.assertIn(text, corpus)


if __name__ == '__main__':
    unittest.main()
