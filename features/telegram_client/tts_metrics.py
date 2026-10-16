"""Offline technical evaluation used by TTS and ``python -m telegram_client.tts_metrics``.

Decode only local files, with bounded duration/size and no network protocols. Levels use
full-scale PCM and never cancel stereo channels. Silence means window RMS below -40 dBFS
in 10 ms windows; internal gaps must last 100 ms. A wholly silent clip is counted once
as leading silence. Technical metrics cannot establish perceived voice naturalness.
Normalized transcripts and the combined WER/CER edit matrix are bounded independently;
Unicode expansion and differing long strings must not cause unbounded quadratic work.
"""

import argparse
from array import array
import io
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unicodedata
import wave

MAX_DURATION_SECONDS = 120
MAX_AUDIO_BYTES = 64 * 1024 * 1024
MAX_TRANSCRIPT_CHARACTERS = 10000
MAX_EDIT_CELLS = 2000000
SILENCE_THRESHOLD_DBFS = -40
WINDOW_MS = 10
INTERNAL_GAP_MS = 100
_UNSIGNED_PCM_TO_SIGNED = bytes(value ^ 128 for value in range(256))
OFFLINE_CORPUS = (
    'Привет! Меня зовут Брачо. Это короткая проверка русского голоса.',
    '3d-house. Отчёт по Print Ops. Проверка нового голоса и журнала звонков.',
    '16 октября 2026 года, 12:45. Заказ номер 307, сумма 1250 рублей.',
    'API, PDF и CPU. Да. Хорошо. До встречи!',
)


def _read_pcm(path):
    """Read bounded PCM WAV, decoding other local formats with optional ffmpeg."""
    path = Path(path)
    if not path.is_file() or not 0 < path.stat().st_size <= MAX_AUDIO_BYTES:
        raise ValueError('Audio must be a nonempty local file no larger than 64 MiB')
    with path.open('rb') as source:
        header = source.read(12)
    if header[:4] == b'RIFF' and header[8:12] == b'WAVE':
        source = str(path)
    else:
        # JSON/HTML errors must not be interpreted as media by a permissive decoder.
        if header.lstrip().startswith((b'{', b'[', b'<')):
            raise ValueError('Invalid audio data')
        ffmpeg = shutil.which('ffmpeg')
        if not ffmpeg:
            raise ValueError('Audio must be PCM WAV, or install ffmpeg to decode local audio')
        with tempfile.TemporaryDirectory(prefix='tg-audio-metrics-') as temporary:
            decoded = Path(temporary) / 'decoded.wav'
            try:
                result = subprocess.run(
                    [ffmpeg, '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe',
                     '-i', str(path.resolve()), '-t', str(MAX_DURATION_SECONDS + 1),
                     '-fs', str(MAX_AUDIO_BYTES), '-f', 'wav', '-c:a', 'pcm_s32le', str(decoded)],
                    capture_output=True, timeout=20, check=False,
                )
            except (OSError, subprocess.TimeoutExpired):
                raise ValueError('Audio decode failed or exceeded its 20 second deadline') from None
            if result.returncode or not decoded.is_file():
                raise ValueError('Invalid audio data')
            # ffmpeg may finish the packet crossing -fs. Reject capped output instead of
            # measuring a truncated clip, and never load an oversized decode into memory.
            if decoded.stat().st_size >= MAX_AUDIO_BYTES:
                raise ValueError('Decoded audio exceeds the 64 MiB evaluation limit')
            source = io.BytesIO(decoded.read_bytes())
    try:
        with wave.open(source, 'rb') as audio:
            channels, width, rate = audio.getnchannels(), audio.getsampwidth(), audio.getframerate()
            if audio.getcomptype() != 'NONE' or width not in (1, 2, 3, 4) or not 1 <= channels <= 8 or not 1 <= rate <= 192000:
                raise ValueError('Unsupported PCM audio format')
            # Bound PCM reads independently of container metadata.
            raw = audio.readframes(rate * MAX_DURATION_SECONDS + 1)
            if not raw or len(raw) % (channels * width):
                raise ValueError('Empty or truncated PCM audio')
            frames = len(raw) // (channels * width)
            if frames > rate * MAX_DURATION_SECONDS:
                raise ValueError('Audio exceeds the 120 second evaluation limit')
            if frames != audio.getnframes():
                raise ValueError('Truncated PCM audio')
    except (wave.Error, EOFError, OSError):
        raise ValueError('Invalid PCM WAV audio') from None
    return raw, channels, width, rate, frames


def normalize_transcript(text):
    """NFKC/casefold, ё→е, punctuation/symbols→spaces; retain letters and numbers."""
    text = unicodedata.normalize('NFKC', text).casefold().replace('ё', 'е')
    return ' '.join(''.join(c if c.isalnum() else ' ' for c in text).split())


def _edit_distance(reference, hypothesis):
    row = list(range(len(hypothesis) + 1))
    for i, expected in enumerate(reference, 1):
        next_row = [i]
        for j, actual in enumerate(hypothesis, 1):
            next_row.append(min(next_row[-1] + 1, row[j] + 1, row[j - 1] + (expected != actual)))
        row = next_row
    return row[-1]


def _trim_matching_edges(reference, hypothesis):
    """Common edges do not change Levenshtein distance; omit their matrix cells."""
    start, end_reference, end_hypothesis = 0, len(reference), len(hypothesis)
    while start < min(end_reference, end_hypothesis) and reference[start] == hypothesis[start]:
        start += 1
    while end_reference > start and end_hypothesis > start and reference[end_reference - 1] == hypothesis[end_hypothesis - 1]:
        end_reference -= 1
        end_hypothesis -= 1
    return reference[start:end_reference], hypothesis[start:end_hypothesis]


def _transcript_metrics(reference, hypothesis):
    result = {'asr_status': 'not_measured', 'wer': None, 'cer': None,
              'word_errors': None, 'character_errors': None,
              'reference_words': None, 'reference_characters': None}
    if reference is None or hypothesis is None:
        return result
    if len(reference) > MAX_TRANSCRIPT_CHARACTERS or len(hypothesis) > MAX_TRANSCRIPT_CHARACTERS:
        raise ValueError('Transcripts exceed the 10000 character evaluation limit')
    expected, actual = normalize_transcript(reference), normalize_transcript(hypothesis)
    if len(expected) > MAX_TRANSCRIPT_CHARACTERS or len(actual) > MAX_TRANSCRIPT_CHARACTERS:
        raise ValueError('Transcripts exceed the normalized 10000 character evaluation limit')
    words, chars = expected.split(), expected.replace(' ', '')
    word_pair = _trim_matching_edges(words, actual.split())
    char_pair = _trim_matching_edges(chars, actual.replace(' ', ''))
    if sum(len(left) * len(right) for left, right in (word_pair, char_pair)) > MAX_EDIT_CELLS:
        raise ValueError('Transcript edit-distance work limit exceeded (2000000 cells total for WER and CER)')
    word_errors = _edit_distance(*word_pair)
    char_errors = _edit_distance(*char_pair)
    result.update(asr_status='measured', word_errors=word_errors, character_errors=char_errors,
                  reference_words=len(words), reference_characters=len(chars),
                  wer=word_errors / len(words) if words else (0.0 if not word_errors else None),
                  cer=char_errors / len(chars) if chars else (0.0 if not char_errors else None))
    return result


def evaluate_audio(path, *, reference=None, hypothesis=None, synth_ms=None):
    """Return JSON-safe measurements; ASR text must come from an independent recognizer.

    No ASR is run here. WER/CER use normalized Levenshtein distance; CER omits spaces.
    An empty reference with insertions has an undefined (null) rate. dBFS is null at
    digital silence. RTF is total synthesis time divided by decoded audio duration.
    Source and normalized transcripts are limited to 10000 characters each. After
    exact common-edge trimming, WER and CER together may visit at most 2000000 cells.
    """
    if synth_ms is not None and (not math.isfinite(synth_ms) or synth_ms < 0):
        raise ValueError('Synthesis time must be finite and nonnegative')
    raw, channels, width, rate, frames = _read_pcm(path)
    peak, square_sum, clipped = 0, 0, 0
    window_frames = max(1, round(rate * WINDOW_MS / 1000))
    silent_windows = []
    count = frames * channels
    window_bytes = window_frames * channels * width
    # Native integer dot products retain PCM24 precision and avoid per-sample
    # byte slices/floats. Decode one window at a time to bound temporary storage.
    for offset in range(0, len(raw), window_bytes):
        block = raw[offset:offset + window_bytes]
        if width == 1:
            samples = array('b', block.translate(_UNSIGNED_PCM_TO_SIGNED))
        elif width == 3:
            # Left-align PCM24 in signed PCM32 without dropping its low bits.
            padded = bytearray(len(block) // 3 * 4)
            padded[1::4], padded[2::4], padded[3::4] = block[::3], block[1::3], block[2::3]
            samples = array('i', padded)
        else:
            samples = array('h' if width == 2 else 'i', block)
        if width != 1 and sys.byteorder != 'little':
            samples.byteswap()
        block_scale = 2 ** (31 if width == 3 else width * 8 - 1)
        magnitude = max(abs(min(samples)), abs(max(samples)))
        peak = max(peak, magnitude / block_scale)
        block_squares = math.sumprod(samples, samples)
        normalized_squares = block_squares / block_scale ** 2
        square_sum += normalized_squares
        clipping_sample = math.ceil(.999 * block_scale)
        clipped += sum(sample >= clipping_sample or sample <= -clipping_sample for sample in samples)
        silent_windows.append((math.sqrt(normalized_squares / len(samples)) < 10 ** (SILENCE_THRESHOLD_DBFS / 20),
                               len(samples) / channels / rate * 1000))
    runs = []
    for silent, duration in silent_windows:
        if runs and runs[-1][0] == silent:
            runs[-1] = (silent, runs[-1][1] + duration)
        else:
            runs.append((silent, duration))
    leading = runs[0][1] if runs[0][0] else 0.0
    trailing = runs[-1][1] if len(runs) > 1 and runs[-1][0] else 0.0
    internal = [duration for silent, duration in runs[1:-1] if silent and duration >= INTERNAL_GAP_MS - 1e-6]
    duration_ms = frames / rate * 1000
    rms = math.sqrt(square_sum / count)
    result = {
        'audio_duration_ms': duration_ms, 'sample_rate_hz': rate, 'channels': channels,
        'synth_ms': synth_ms, 'real_time_factor': synth_ms / duration_ms if synth_ms is not None else None,
        'peak': peak, 'rms': rms, 'peak_dbfs': 20 * math.log10(peak) if peak else None,
        'rms_dbfs': 20 * math.log10(rms) if rms else None, 'clipping_ratio': clipped / count,
        'clipping_threshold': .999, 'silence_threshold_dbfs': SILENCE_THRESHOLD_DBFS,
        'silence_window_ms': WINDOW_MS, 'internal_silence_min_ms': INTERNAL_GAP_MS,
        'leading_silence_ms': leading, 'trailing_silence_ms': trailing,
        'internal_silence_ms': sum(internal), 'internal_silence_count': len(internal),
        'naturalness_score': None,
    }
    result.update(_transcript_metrics(reference, hypothesis))
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('audio', type=Path, help='Local PCM WAV or ffmpeg-decodable audio (maximum 120 seconds)')
    parser.add_argument('--reference', help='Expected text, normalized with NFKC/casefold, ё→е and punctuation removal')
    parser.add_argument('--hypothesis', help='Independent ASR transcript; omit to leave WER/CER unmeasured')
    parser.add_argument('--synth-ms', type=float, help='Measured total synthesis milliseconds, for real-time factor')
    args = parser.parse_args(argv)
    try:
        report = evaluate_audio(args.audio, reference=args.reference, hypothesis=args.hypothesis, synth_ms=args.synth_ms)
    except (ValueError, OSError):
        parser.exit(2, 'Audio evaluation failed: provide valid local audio within the documented limits.\n')
    print(json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2))


if __name__ == '__main__':
    main()
