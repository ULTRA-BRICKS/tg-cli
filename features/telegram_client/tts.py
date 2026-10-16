"""Configured `tg call --say` audio in a caller-owned private directory.

Neural identity is pinned in voice.json; absent settings fail closed (#761).
Host speech is explicit opt-in. Its text uses a 0600 file, never visible argv.
"""

import os
import json
import time
from pathlib import Path
import platform
import re
import shutil
import subprocess

from .core import ClientError, private_directory, private_file
from .tts_config import load_config
from .tts_fish import fetch_audio

TEXT_LIMIT = 1000
CYRILLIC = re.compile(r"[\u0400-\u04FF]")


def speech_chunks(text, limit=TEXT_LIMIT):
    """Split speech at whitespace where possible, without empty provider requests.

    Trailing whitespace remains in the journal transcript, but has no spoken audio.
    """
    if not 1 <= limit <= TEXT_LIMIT:
        raise ValueError('invalid speech limit')
    offset = 0
    while offset < len(text):
        end = min(offset + limit, len(text))
        if end < len(text):
            boundaries = [match.end() for match in re.finditer(r'\s+', text[offset:end])]
            if boundaries and text[offset:offset + boundaries[-1]].strip():
                end = offset + boundaries[-1]
        piece = text[offset:end]
        if piece.strip():
            yield piece
        offset = end


def tts_engine(which=shutil.which, system=platform.system()):
    if system == "Darwin" and which("say"):
        return "say"
    for name in ("espeak-ng", "espeak"):
        if which(name):
            return name
    return None


def tts_argv(engine, text, text_file, out_base):
    russian = bool(CYRILLIC.search(text))
    if engine == "say":
        voice = ["-v", "Milena"] if russian else []
        return ["say", *voice, "-f", str(text_file), "-o", str(out_base) + ".aiff"]
    return [engine, "-v", "ru" if russian else "en", "-f", str(text_file), "-w", str(out_base) + ".wav"]


def synthesize(text, directory, run=subprocess.run, which=shutil.which, system=platform.system(), *, config_dir=None):
    """Return the audio file; the caller owns (and deletes) `directory`."""
    if not text.strip():
        raise ClientError("TEXT_EMPTY")
    if len(text) > TEXT_LIMIT:
        raise ClientError("TEXT_TOO_LONG")
    config = load_config(config_dir)
    directory = Path(directory)
    private_directory(directory)
    if config.provider == 'fish_audio':
        payload, timing = fetch_audio(text, config)
        out = directory / 'say.wav'
        write_private(out, payload)
        try:
            record_metrics(out, directory, config, timing)
        except Exception:
            out.unlink(missing_ok=True)
            raise
        return out
    engine = tts_engine(which, system)
    if engine is None:
        raise ClientError("TTS_UNAVAILABLE")
    text_file = directory / "say.txt"
    write_private(text_file, text.encode('utf-8'))
    argv = tts_argv(engine, text, text_file, directory / "say")
    started = time.monotonic()
    out = Path(argv[-1])
    # Reserve output privately; host engines overwrite this file rather than choose its mode.
    write_private(out, b'')
    try:
        result = run(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        out.unlink(missing_ok=True)
        raise ClientError("TTS_FAILED") from None
    if result.returncode != 0 or not out.is_file() or not out.stat().st_size:
        out.unlink(missing_ok=True)
        raise ClientError("TTS_FAILED")
    private_file(out)
    record_metrics(out, directory, config,
                   {'time_to_first_audio_byte_ms': None,
                    'total_synth_ms': (time.monotonic() - started) * 1000}, engine=engine)
    return out


def write_private(path, payload):
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as output:
            output.write(payload)
    except OSError:
        raise ClientError('TTS_OUTPUT_FAILED') from None


def record_metrics(out, directory, config, timing, *, engine=None):
    from .tts_metrics import evaluate_audio

    try:
        metrics = evaluate_audio(out, synth_ms=timing['total_synth_ms'])
        report = {'version': 1, 'provider': config.provider, 'model': config.model,
                  'voice_id': config.voice_id, 'latency': config.latency,
                  'engine': engine, **timing, 'audio': metrics}
        write_private(directory / 'tts.json', json.dumps(report, ensure_ascii=False,
                                                       allow_nan=False).encode('utf-8'))
    except ClientError:
        raise
    except (OSError, ValueError):
        raise ClientError('TTS_AUDIO_INVALID') from None
