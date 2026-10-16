"""Importable offline call fixtures; no test discovery, runner, or sys.path mutation."""
from contextlib import asynccontextmanager
from types import SimpleNamespace
import json


def args_for(**values):
    defaults = dict(peer="@alice", say="Принтер сломан", audio=None, timeout=1,
                    dry_run=False, source_session_idle_confirmed=False)
    defaults.update(values)
    return SimpleNamespace(**defaults)


class FakeEffects:
    def __init__(self, failure=None, mirror_failure=None):
        self.events = []
        self.failure = failure
        self.mirror_failure = mirror_failure
        self.sent = []
        self.edits = []

    def parse_mode(self):
        return "disabled"

    @asynccontextmanager
    async def connection(self, store, role, idle):
        self.events.append("connect")
        yield self

    async def resolve(self, app, store, role, peer):
        self.events.append("resolve")
        return 77

    async def send_message(self, recipient, text, **options):
        self.events.append("mirror")
        if self.mirror_failure and len(self.sent) == 1:
            raise self.mirror_failure
        self.sent.append((recipient, text, options))
        return SimpleNamespace(id=len(self.sent), chat=SimpleNamespace(id=recipient))

    async def edit_message_text(self, recipient, message_id, text, **options):
        self.edits.append((recipient, message_id, text))
        return SimpleNamespace(id=message_id, chat=SimpleNamespace(id=recipient))

    def synthesize(self, text, directory, config_dir):
        self.events.append("tts")
        directory.mkdir(mode=0o700)
        out = directory / "speech.wav"
        out.write_bytes(b"fake audio")
        (directory / "tts.json").write_text(json.dumps({"engine": "fake", "voice": "fixture", "duration_ms": 23, "secret": "must-not-persist"}))
        return out

    def join_audio(self, intro, audio, directory):
        self.events.append("prepend")
        return intro

    async def dial(self, store, role, recipient, audio, timeout, idle):
        self.events.append("dial")
        if self.failure:
            raise self.failure
