"""Speech settings loaded by `tts.synthesize` from the canonical config directory.

Voice/model identity belongs to runtime configuration, never to this reusable library.
Secrets remain in their original source and errors contain only safe codes (#761).
"""

from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import re
import stat

from .core import ClientError

FISH_URL = 'https://api.fish.audio/v1/tts'
MAX_CONFIG_BYTES = 1024 * 1024


def open_no_symlinks(path):
    """Walk descriptor-relative components so parent symlinks cannot redirect a read."""
    path = Path(path).absolute()
    if '..' in path.parts:
        raise OSError('Unsafe path')
    directory = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        return os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    finally:
        os.close(directory)


def read_json(path, error, *, credential_source=False):
    """Bound local reads and reject symlinks and files writable by other users."""
    try:
        getuid = getattr(os, "getuid", None)
        if not callable(getuid) or not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
            raise ClientError(error)
        owners = {getuid(), 0} if credential_source else {getuid()}
        fd = open_no_symlinks(path)
        with os.fdopen(fd, 'rb') as source:
            info = os.fstat(source.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid not in owners
                    or info.st_mode & 0o022 or info.st_size > MAX_CONFIG_BYTES):
                raise ClientError(error)
            payload = source.read(MAX_CONFIG_BYTES + 1)
            if len(payload) > MAX_CONFIG_BYTES:
                raise ClientError(error)
            return json.loads(payload)
    except (OSError, ValueError, RecursionError):
        raise ClientError(error) from None


def token(value, pattern):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


@dataclass(frozen=True)
class VoiceConfig:
    provider: str
    model: str | None = None
    voice_id: str | None = None
    latency: str | None = None
    credential_source: dict = field(default_factory=dict, repr=False)


def load_config(config_dir=None):
    root = Path(config_dir) if config_dir is not None else Path(
        os.environ.get('TG_CTL_CONFIG_DIR', '~/.config/tg-cli')).expanduser()
    path = root / 'voice.json'
    if not path.exists() and not path.is_symlink():
        raise ClientError('TTS_CONFIG_MISSING')
    value = read_json(path, 'TTS_CONFIG_INVALID')
    if not isinstance(value, dict) or type(value.get('version')) is not int or value['version'] != 1:
        raise ClientError('TTS_CONFIG_INVALID')
    if value.get('provider') == 'host':
        if set(value) != {'version', 'provider'}:
            raise ClientError('TTS_CONFIG_INVALID')
        return VoiceConfig(provider='host')
    expected = {'version', 'provider', 'model', 'voice_id', 'latency', 'format', 'credential_source'}
    if set(value) - {'base_url'} != expected or value.get('provider') != 'fish_audio':
        raise ClientError('TTS_CONFIG_INVALID')
    if value.get('base_url', FISH_URL) != FISH_URL:
        raise ClientError('TTS_ENDPOINT_UNTRUSTED')
    if (not token(value['model'], r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}')
            or not token(value['voice_id'], r'[a-fA-F0-9]{32}')
            or value['latency'] not in ('normal', 'balanced') or value['format'] != 'wav'):
        raise ClientError('TTS_CONFIG_INVALID')
    source = value['credential_source']
    if not isinstance(source, dict):
        raise ClientError('TTS_CONFIG_INVALID')
    if source.get('type') == 'env':
        if set(source) != {'type', 'name'} or not token(source['name'], r'[A-Za-z_][A-Za-z0-9_]{0,127}'):
            raise ClientError('TTS_CONFIG_INVALID')
    elif source.get('type') == 'home_assistant':
        if (set(source) != {'type', 'path', 'entry_id'}
                or not isinstance(source['path'], str) or not Path(source['path']).is_absolute()
                or not token(source['entry_id'], r'[A-Za-z0-9_-]{1,128}')):
            raise ClientError('TTS_CONFIG_INVALID')
    else:
        raise ClientError('TTS_CONFIG_INVALID')
    return VoiceConfig('fish_audio', value['model'], value['voice_id'], value['latency'], source)


def resolve_credential(config):
    source = config.credential_source
    if source['type'] == 'env':
        key = os.environ.get(source['name'])
    else:
        value = read_json(Path(source['path']), 'TTS_CREDENTIAL_UNAVAILABLE', credential_source=True)
        data = value.get('data') if isinstance(value, dict) else None
        entries = data.get('entries') if isinstance(data, dict) else None
        if not isinstance(entries, list):
            raise ClientError('TTS_CREDENTIAL_UNAVAILABLE')
        matches = [e for e in entries if isinstance(e, dict) and e.get('entry_id') == source['entry_id']]
        if (len(matches) != 1 or matches[0].get('domain') != 'fish_audio'
                or not isinstance(matches[0].get('data'), dict)):
            raise ClientError('TTS_CREDENTIAL_UNAVAILABLE')
        key = matches[0]['data'].get('api_key')
    if not isinstance(key, str) or not key or len(key) > 4096 or any(ord(c) < 33 or ord(c) > 126 for c in key):
        raise ClientError('TTS_CREDENTIAL_UNAVAILABLE')
    return key
