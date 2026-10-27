"""Locally generated PCM WAV fixtures and tone analysis; no binary files, no external tools.

Speech-like audio is two tones with a syllable-rate amplitude envelope and short gaps. It is
a stand-in with measurable structure: it proves ordering/length/validity, never naturalness.
"""
import math
import wave
from array import array

SYLLABLE_MS = 180
GAP_MS = 60


def write_tones(path, tones, duration_ms, rate=24000, amplitude=0.3):
    """Write mono 16-bit PCM: `tones` frequencies mixed under a syllable envelope with gaps."""
    frames = int(rate * duration_ms / 1000)
    samples = array("h")
    period = (SYLLABLE_MS + GAP_MS) / 1000
    for index in range(frames):
        t = index / rate
        phase = t % period
        if phase * 1000 >= SYLLABLE_MS:
            samples.append(0)
            continue
        envelope = math.sin(math.pi * phase * 1000 / SYLLABLE_MS) ** 0.5
        value = sum(math.sin(2 * math.pi * f * t) for f in tones) / len(tones)
        samples.append(int(32767 * amplitude * envelope * value))
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(samples.tobytes())
    return path


def wav_bytes(tones, duration_ms, rate=24000):
    import tempfile
    from pathlib import Path
    with tempfile.TemporaryDirectory() as folder:
        path = write_tones(Path(folder) / "x.wav", tones, duration_ms, rate)
        return path.read_bytes()


def read_mono(path):
    with wave.open(str(path), "rb") as source:
        if source.getsampwidth() != 2:
            raise ValueError("expected 16-bit PCM")
        channels, rate = source.getnchannels(), source.getframerate()
        raw = source.readframes(source.getnframes())
    samples = array("h")
    samples.frombytes(raw)
    if channels > 1:
        samples = array("h", samples[::channels])
    return samples, rate


def goertzel(samples, rate, frequency, start_ms, length_ms):
    """Relative power of one frequency inside a window; 0 for an empty window."""
    first = int(rate * start_ms / 1000)
    window = samples[first:first + int(rate * length_ms / 1000)]
    if not window:
        return 0.0
    coefficient = 2 * math.cos(2 * math.pi * frequency / rate)
    s1 = s2 = 0.0
    for value in window:
        s0 = value + coefficient * s1 - s2
        s2, s1 = s1, s0
    return (s1 * s1 + s2 * s2 - coefficient * s1 * s2) / (len(window) ** 2)


def analyze(path):
    """Plain-data facts about a PCM WAV: format, duration, level, longest silence-free span."""
    with wave.open(str(path), "rb") as source:
        frames, rate, channels, width = source.getnframes(), source.getframerate(), source.getnchannels(), source.getsampwidth()
    samples, rate = read_mono(path)
    peak = max((abs(v) for v in samples), default=0) / 32768
    energy = sum(v * v for v in samples) / max(1, len(samples)) / 32768 ** 2
    return {"frames": frames, "rate": rate, "channels": channels, "sample_width": width,
            "duration_ms": frames * 1000 / rate, "peak": peak, "rms": math.sqrt(energy)}


def dominant(samples, rate, candidates, start_ms, length_ms):
    """Which candidate frequency carries the most energy in a window."""
    return max(candidates, key=lambda f: goertzel(samples, rate, f, start_ms, length_ms))


SPEECH_TONES = (330, 550)
RAW_TONES = (1000, 1500)


def tone_profile(path, window_ms=240):
    """Run-length [kind, start_ms, end_ms] of speech-like vs raw-fixture tones; silence is skipped."""
    samples, rate = read_mono(path)
    total = len(samples) * 1000 / rate
    runs, start = [], 0
    while start < total:
        speech = sum(goertzel(samples, rate, f, start, window_ms) for f in SPEECH_TONES)
        raw = sum(goertzel(samples, rate, f, start, window_ms) for f in RAW_TONES)
        if max(speech, raw) >= 1e-4:
            kind = "speech" if speech > raw else "raw"
            if runs and runs[-1][0] == kind:
                runs[-1][2] = min(total, start + window_ms)
            else:
                runs.append([kind, start, min(total, start + window_ms)])
        start += window_ms
    return runs
