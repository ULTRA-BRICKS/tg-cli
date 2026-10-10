"""`tg call --say`: speak a short text with the host's own TTS into a private temp file.

macOS ships `say`; Linux hosts use `espeak-ng`. The text travels through a 0600 file, never
argv (argv is visible to every local user in `ps`).
"""

import os
from pathlib import Path
import platform
import re
import shutil
import subprocess

from .core import ClientError, private_directory

TEXT_LIMIT = 1000
CYRILLIC = re.compile(r"[\u0400-\u04FF]")


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


def synthesize(text, directory, run=subprocess.run, which=shutil.which, system=platform.system()):
    """Return the audio file; the caller owns (and deletes) `directory`."""
    if not text.strip():
        raise ClientError("TEXT_EMPTY")
    if len(text) > TEXT_LIMIT:
        raise ClientError("TEXT_TOO_LONG")
    engine = tts_engine(which, system)
    if engine is None:
        raise ClientError("TTS_UNAVAILABLE")
    directory = Path(directory)
    private_directory(directory)
    text_file = directory / "say.txt"
    fd = os.open(text_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    argv = tts_argv(engine, text, text_file, directory / "say")
    try:
        result = run(argv, capture_output=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        raise ClientError("TTS_FAILED") from None
    out = Path(argv[-1])
    if result.returncode != 0 or not out.is_file():
        raise ClientError("TTS_FAILED")
    return out
