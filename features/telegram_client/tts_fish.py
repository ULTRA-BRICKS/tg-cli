"""Fish HTTPS transport used only by explicitly configured one-shot speech.

No redirects, proxy discovery, retries, credential argv, or response-body diagnostics.
A first-byte read measures arrival independently of the remaining audio download (#761).
"""

import http.client
import io
import json
import math
import os
from pathlib import Path
import subprocess
import struct
import sys
from types import SimpleNamespace
import time
import wave

from .core import ClientError
from .tts_config import resolve_credential

MAX_AUDIO_BYTES = 8 * 1024 * 1024
TOTAL_TIMEOUT_SECONDS = 60
IO_TIMEOUT_SECONDS = 10



def normalize_streaming_wav(payload):
    """Finalize recognized Fish PCM stream headers after the bounded HTTP body ends.

    Only the two known unknown-length header pairs are eligible. Finite WAVs
    remain untouched, so the strict validator still detects actual truncation.
    Audio samples are never resampled or rewritten.
    """
    if len(payload) < 44:
        return payload
    riff_size = struct.unpack_from('<I', payload, 4)[0]
    data_size = struct.unpack_from('<I', payload, 40)[0]
    if (riff_size, data_size) not in ((0xffffff24, 0xffffff00), (0xffffffff, 0xffffffff)):
        return payload
    if (len(payload) > MAX_AUDIO_BYTES or payload[:4] != b'RIFF'
            or payload[8:16] != b'WAVEfmt ' or payload[36:40] != b'data'
            or struct.unpack_from('<I', payload, 16)[0] != 16):
        raise ClientError('TTS_AUDIO_INVALID')
    encoding, channels, rate, byte_rate, block_align, bits = struct.unpack_from('<HHIIHH', payload, 20)
    if (encoding != 1 or channels not in (1, 2) or bits not in (8, 16, 24, 32)
            or not 8000 <= rate <= 192000 or block_align != channels * (bits // 8)
            or byte_rate != rate * block_align):
        raise ClientError('TTS_AUDIO_INVALID')
    actual_size = len(payload) - 44
    if actual_size <= 0 or actual_size % block_align or actual_size / byte_rate > 120:
        raise ClientError('TTS_AUDIO_INVALID')
    result = bytearray(payload)
    struct.pack_into('<I', result, 4, len(result) - 8)
    struct.pack_into('<I', result, 40, actual_size)
    return bytes(result)


def validate_wav(payload):
    try:
        with wave.open(io.BytesIO(payload), 'rb') as audio:
            frames = audio.getnframes()
            width = audio.getsampwidth()
            channels = audio.getnchannels()
            rate = audio.getframerate()
            if (frames <= 0 or width not in (1, 2, 3, 4) or channels not in (1, 2)
                    or rate < 8000 or rate > 192000 or frames / rate > 120):
                raise ClientError('TTS_AUDIO_INVALID')
            if len(audio.readframes(frames)) != frames * width * channels:
                raise ClientError('TTS_AUDIO_INVALID')
    except (EOFError, wave.Error, ValueError, OSError):
        raise ClientError('TTS_AUDIO_INVALID') from None


def fetch_audio_in_process(text, config, key=None):
    if key is None:
        key = resolve_credential(config)
    body = json.dumps({'text': text, 'reference_id': config.voice_id,
                       'format': 'wav', 'latency': config.latency}).encode('utf-8')
    started = time.monotonic()
    connection = http.client.HTTPSConnection('api.fish.audio', timeout=IO_TIMEOUT_SECONDS)

    def remaining():
        left = TOTAL_TIMEOUT_SECONDS - (time.monotonic() - started)
        if left <= 0:
            raise ClientError('TTS_PROVIDER_TIMEOUT')
        if connection.sock is not None:
            connection.sock.settimeout(min(IO_TIMEOUT_SECONDS, left))

    try:
        connection.request('POST', '/v1/tts', body=body,
                           headers={'Authorization': 'Bearer ' + key,
                                    'Content-Type': 'application/json',
                                    'model': config.model})
        remaining()
        response = connection.getresponse()
        if response.status != 200:
            raise ClientError('TTS_PROVIDER_FAILED')
        content_type = (response.getheader('Content-Type') or '').split(';')[0].strip().lower()
        if content_type not in ('audio/wav', 'audio/x-wav', 'audio/wave', 'application/octet-stream'):
            raise ClientError('TTS_AUDIO_INVALID')
        size = response.getheader('Content-Length')
        if size is not None and (not size.isdecimal() or int(size) > MAX_AUDIO_BYTES):
            raise ClientError('TTS_AUDIO_INVALID')
        remaining()
        first = response.read(1)
        first_byte_ms = (time.monotonic() - started) * 1000 if first else None
        payload = bytearray(first)
        while first:
            remaining()
            # read1 returns available bytes; a trickling response cannot reset the deadline.
            read = getattr(response, 'read1', response.read)
            chunk = read(min(65536, MAX_AUDIO_BYTES + 1 - len(payload)))
            if not chunk:
                break
            payload.extend(chunk)
            if len(payload) > MAX_AUDIO_BYTES:
                raise ClientError('TTS_AUDIO_INVALID')
        remaining()
        if size is not None and len(payload) != int(size):
            raise ClientError('TTS_AUDIO_INVALID')
        payload = normalize_streaming_wav(payload)
        validate_wav(payload)
        total_ms = (time.monotonic() - started) * 1000
        return bytes(payload), {'time_to_first_audio_byte_ms': first_byte_ms,
                                'total_synth_ms': total_ms}
    except ClientError:
        raise
    except (OSError, ValueError, http.client.HTTPException):
        raise ClientError('TTS_PROVIDER_FAILED') from None
    finally:
        connection.close()


def fetch_audio(text, config):
    """Enforce a wall deadline even while DNS or HTTP header parsing is blocked.

    Auth and text travel on stdin, never argv; timeout kills and reaps the child.
    The child implementation bounds its only stdout result to 8 MiB plus timing.
    """
    key = resolve_credential(config)
    request = json.dumps({'text': text, 'model': config.model, 'voice_id': config.voice_id,
                          'latency': config.latency, 'key': key}).encode('utf-8')
    env = {**os.environ, 'PYTHONPATH': str(Path(__file__).resolve().parents[1])}
    try:
        result = subprocess.run([sys.executable, '-m', 'telegram_client.tts_fish'],
                                input=request, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                timeout=TOTAL_TIMEOUT_SECONDS, check=False, env=env)
        if result.returncode != 0 or len(result.stdout) > MAX_AUDIO_BYTES + 1024:
            raise ClientError('TTS_PROVIDER_FAILED')
        header, separator, payload = result.stdout.partition(b'\n')
        timing = json.loads(header)
        if not separator or len(header) > 1024 or not isinstance(timing, dict):
            raise ClientError('TTS_PROVIDER_FAILED')
        if timing.get('error'):
            code = timing['error']
            if code not in ('TTS_PROVIDER_TIMEOUT', 'TTS_PROVIDER_FAILED', 'TTS_AUDIO_INVALID'):
                code = 'TTS_PROVIDER_FAILED'
            raise ClientError(code)
        if set(timing) != {'time_to_first_audio_byte_ms', 'total_synth_ms'}:
            raise ClientError('TTS_PROVIDER_FAILED')
        first, total = timing['time_to_first_audio_byte_ms'], timing['total_synth_ms']
        if (type(first) not in (int, float) or type(total) not in (int, float)
                or not math.isfinite(first) or not math.isfinite(total) or not 0 <= first <= total):
            raise ClientError('TTS_PROVIDER_FAILED')
        validate_wav(payload)
        return payload, timing
    except subprocess.TimeoutExpired:
        raise ClientError('TTS_PROVIDER_TIMEOUT') from None
    except (OSError, ValueError):
        raise ClientError('TTS_PROVIDER_FAILED') from None


def main():
    """Private worker protocol: bounded stdin JSON; safe timing header plus WAV bytes."""
    try:
        request = sys.stdin.buffer.read(16385)
        if len(request) > 16384:
            raise ValueError()
        value = json.loads(request)
        if (not isinstance(value, dict) or set(value) != {'text', 'model', 'voice_id', 'latency', 'key'}
                or any(not isinstance(v, str) for v in value.values())
                or not value['text'].strip() or len(value['text']) > 1000):
            raise ValueError()
        settings = SimpleNamespace(model=value['model'], voice_id=value['voice_id'], latency=value['latency'])
        payload, timing = fetch_audio_in_process(value['text'], settings, value['key'])
        sys.stdout.buffer.write(json.dumps(timing, allow_nan=False).encode('ascii') + b'\n' + payload)
    except Exception as error:
        code = str(error) if isinstance(error, ClientError) else 'TTS_PROVIDER_FAILED'
        if code not in ('TTS_PROVIDER_TIMEOUT', 'TTS_PROVIDER_FAILED', 'TTS_AUDIO_INVALID'):
            code = 'TTS_PROVIDER_FAILED'
        sys.stdout.buffer.write(json.dumps({'error': code}).encode('ascii') + b'\n')


if __name__ == '__main__':
    main()
