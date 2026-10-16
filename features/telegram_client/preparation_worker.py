"""Isolated synchronous TTS/join worker reached only by preparation.prepare_audio.

The worker is a process-group leader. On Linux it adopts orphaned descendants so
Fish/ffmpeg descendants are terminated and reaped before the caller removes files.
Only bounded stable result/error data leaves stdout; provider exceptions stay private.
"""
import ctypes
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from .core import ClientError


class Stopped(BaseException):
    pass


def stopped(signum, frame):
    raise Stopped()


def cleanup():
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    os.killpg(os.getpgrp(), signal.SIGTERM)
    deadline = time.monotonic() + .5
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid:
            continue
        if time.monotonic() >= deadline:
            # Linux's subreaper owns these children; never signal unrelated processes.
            children = Path(f'/proc/self/task/{os.getpid()}/children')
            try:
                for child in children.read_text().split():
                    try:
                        os.kill(int(child), signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            except OSError:
                return
        time.sleep(.01)


def join_audio(intro, audio, directory):
    from .tts import write_private
    out = Path(directory) / 'introduced.wav'
    write_private(out, b'')
    try:
        result = subprocess.run([
            'ffmpeg', '-nostdin', '-v', 'error', '-i', str(intro), '-i', str(Path(audio).resolve()),
            '-filter_complex', '[0:a]aresample=48000,aformat=channel_layouts=mono[a];[1:a]aresample=48000,aformat=channel_layouts=mono[b];[a][b]concat=n=2:v=0:a=1[out]',
            '-map', '[out]', '-y', str(out)], stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        raise ClientError('CALL_AUDIO_PREPARATION_FAILED') from None
    if result.returncode or not out.is_file() or not out.stat().st_size:
        raise ClientError('CALL_AUDIO_PREPARATION_FAILED')
    return out


def main():
    if sys.platform == 'linux':
        # Scope adoption to this disposable worker, never the daemon or CLI process.
        if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0):
            raise ClientError('CALL_AUDIO_PREPARATION_FAILED')
    signal.signal(signal.SIGTERM, stopped)
    try:
        payload = json.loads(sys.stdin.buffer.read(65537))
        operation = payload.pop('operation')
        if operation == 'synthesize':
            from .tts import synthesize
            result = synthesize(**payload)
        elif operation == 'join':
            result = join_audio(**payload)
        else:
            raise ClientError('CALL_AUDIO_PREPARATION_FAILED')
        print(str(result))
    except ClientError as error:
        print(str(error))
        return 1
    except BaseException:
        print('CALL_AUDIO_PREPARATION_FAILED')
        return 1
    finally:
        cleanup()
    return 0


if __name__ == '__main__':
    sys.exit(main())
