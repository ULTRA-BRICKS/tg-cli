#!/usr/bin/env python3
"""TG_MTPROTO_SIDECAR fixture for the hermetic call integration suite (#761).

It is the REAL `telegram_client.cli.main`: argument parsing, identity/auth store, role lock,
journal, speech preparation, ffmpeg join, mirror formatter and failure results all run
production code. Only two EXTERNAL boundaries are replaced, each recording what actually
reached it into the effects log (`$TG_FIXTURE_DIR/effects.jsonl`):

* Telegram transport: `runtime.client_class` yields a fake pyrogram Client (connect/get_me/
  get_users/send_message/edit_message_text) over a persisted fake chat store, and
  `Effects.dial` (the pytgcalls call) records the audio it would stream.
* Fish audio: `tts_fish.subprocess` is the child that would talk HTTPS; the fake validates the
  stdin request (voice, model, key, text never in argv) and returns locally generated WAV.

An audit hook enforces "no real network" (blocks and records sockets/DNS) and records which
config files are opened and which processes are spawned. Fake credentials live only in the
temporary config the harness wrote. Control comes from `$TG_FIXTURE_DIR/plan.json`.
"""
import asyncio
import io
import json
import os
import socket
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import wav_tools

CONTROL = Path(os.environ["TG_FIXTURE_DIR"])
CONFIG = Path(os.environ.get("TG_CTL_CONFIG_DIR", "/nonexistent")).resolve()
PLAN = json.loads((CONTROL / "plan.json").read_text())
PARSE_DISABLED = "ParseMode.DISABLED"
SPEECH_TONES = wav_tools.SPEECH_TONES
_busy = False


def emit(kind, **data):
    global _busy
    _busy = True
    try:
        line = json.dumps(dict(kind=kind, pid=os.getpid(), **data), ensure_ascii=False, default=str) + "\n"
        fd = os.open(CONTROL / "effects.jsonl", os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            os.write(fd, line.encode())
        finally:
            os.close(fd)
    finally:
        _busy = False


def audit(event, args):
    if _busy:
        return
    if event in ("socket.getaddrinfo", "socket.gethostbyname", "socket.gethostbyaddr"):
        emit("network_attempt", event=event, target=repr(args[:2]))
        raise OSError("fixture: network is forbidden")
    if event == "socket.connect":
        sock, address = args
        if sock.family != socket.AF_UNIX:
            emit("network_attempt", event=event, target=repr(address))
            raise OSError("fixture: network is forbidden")
    elif event == "open":
        audit_open(args)
    elif event == "subprocess.Popen":
        emit("subprocess", argv=[os.fsdecode(a) for a in args[1]])


def audit_open(args):
    path = args[0]
    if isinstance(path, (str, bytes, os.PathLike)):
        try:
            resolved = Path(os.fsdecode(path)).absolute()
        except (TypeError, ValueError):
            return
        if not Path(os.fsdecode(path)).is_absolute():
            # Descriptor-relative opens (tts_config.open_no_symlinks) show only the name.
            if resolved.suffix == ".json" or resolved.name == ".env":
                emit("config_open", path=resolved.name, relative=True, write=False)
        elif resolved.is_relative_to(CONFIG):
            flags = args[2] if isinstance(args[2], int) else 0
            emit("config_open", path=str(resolved.relative_to(CONFIG)),
                 write=bool(flags & (os.O_WRONLY | os.O_RDWR)))



class PeerIdInvalid(Exception):
    """Pyrogram's name for an unknown peer; account.with_peer_warmup matches the class name."""


class ChatStore:
    """Persisted fake Telegram: messages per chat, authored by the account that sent them."""

    path = CONTROL / "chats.json"

    @classmethod
    def load(cls):
        return json.loads(cls.path.read_text()) if cls.path.exists() else {}

    @classmethod
    def save(cls, data):
        tmp = cls.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False))
        tmp.replace(cls.path)


class FakeClient:
    sends = 0

    def __init__(self, role, api_id=None, api_hash=None, session_string=None, in_memory=None, no_updates=None):
        if not str(session_string).startswith("FAKE-SESSION-") or not str(api_hash).startswith("fake-api-hash"):
            raise AssertionError("fixture: production passed unexpected credentials")
        self.role = role
        self.account = int(session_string.rsplit("-", 1)[1])
        self.is_initialized = False
        self.is_connected = False
        self.me = None

    async def connect(self):
        emit("telegram.connect", role=self.role, account=self.account)
        self.is_connected = True
        return True

    async def get_me(self):
        identity = PLAN.get("identity", {}).get(self.role, self.account)
        emit("telegram.get_me", role=self.role, returns=identity)
        return SimpleNamespace(id=identity, is_bot=False, username=f"fixture{identity}")

    async def get_dialogs(self, limit=None):
        emit("telegram.get_dialogs")
        return
        yield

    async def get_users(self, target):
        users = {**{str(v): v for v in PLAN["users"].values()}, **PLAN["users"]}
        emit("telegram.get_users", target=target, as_account=self.account)
        key = str(target)
        if key not in users:
            raise PeerIdInvalid()
        ident = users[key]
        return SimpleNamespace(id=ident, is_bot=ident in PLAN.get("bots", []))

    async def send_message(self, chat_id, text, parse_mode=None, reply_to_message_id=None,
                           disable_web_page_preview=None):
        FakeClient.sends += 1
        count = FakeClient.sends
        record = {"chat_id": chat_id, "text": text, "parse_mode": str(parse_mode),
                      "reply_to": reply_to_message_id, "sender": self.account, "nth": count,
                      "preview_disabled": disable_web_page_preview}
        if PLAN.get("fail_send_at") == count:
            emit("telegram.send_message", **record, outcome="transport_error")
            raise RuntimeError("FLOOD_WAIT secret-transport-detail")
        chats = ChatStore.load()
        chat = chats.setdefault(str(chat_id), {"messages": {}, "next": 100})
        message_id = chat["next"]
        chat["next"] += 1
        chat["messages"][str(message_id)] = {"text": text, "reply_to": reply_to_message_id,
                                                 "sender": self.account, "edits": []}
        ChatStore.save(chats)
        returned_chat = PLAN.get("wrong_chat") if PLAN.get("wrong_chat_at") == count else chat_id
        emit("telegram.send_message", **record, message_id=message_id, outcome="sent")
        return SimpleNamespace(id=message_id, chat=SimpleNamespace(id=returned_chat))

    async def edit_message_text(self, chat_id, message_id, text, parse_mode=None,
                                disable_web_page_preview=None):
        record = {"chat_id": chat_id, "message_id": message_id, "text": text, "parse_mode": str(parse_mode),
                      "sender": self.account}
        if PLAN.get("edit_fail"):
            emit("telegram.edit_message_text", **record, outcome="transport_error")
            raise RuntimeError("EDIT secret-transport-detail")
        chats = ChatStore.load()
        message = chats.get(str(chat_id), {}).get("messages", {}).get(str(message_id))
        if message is None or message["sender"] != self.account:
            emit("telegram.edit_message_text", **record, outcome="no_such_own_message")
            raise PeerIdInvalid()
        message["edits"].append(message["text"])
        message["text"] = text
        ChatStore.save(chats)
        emit("telegram.edit_message_text", **record, outcome="edited")
        return SimpleNamespace(id=message_id, chat=SimpleNamespace(id=chat_id))

    async def terminate(self):
        self.is_initialized = False

    async def disconnect(self):
        emit("telegram.disconnect", role=self.role)
        self.is_connected = False


def tree_modes(root):
    result = {}
    for path in [root, *root.rglob("*")]:
        info = path.lstat()
        result[str(path.relative_to(root.parent))] = {"dir": path.is_dir(), "mode": info.st_mode & 0o777}
    return result


def fake_fish(argv, input=None, stdout=None, stderr=None, timeout=None, check=False, env=None):
    """The child process that would speak HTTPS to Fish; validates how production invokes it."""
    request = json.loads(input)
    key = PLAN["fish_key"]
    emit("provider.request", text=request["text"], voice_id=request["voice_id"], model=request["model"],
         latency=request["latency"], key_matches=request["key"] == key,
         key_in_argv=any(key in part for part in argv),
         text_in_argv=any(request["text"] in part for part in argv),
         module=argv[-1], timeout=timeout)
    fake_fish.requests += 1
    mode = PLAN.get("provider", "ok")
    if fake_fish.requests >= PLAN.get("provider_fail_from", 10 ** 9):
        mode = "error:TTS_PROVIDER_FAILED"
    if mode == "timeout":
        raise subprocess.TimeoutExpired(argv, timeout)
    if mode.startswith("error:"):
        header = json.dumps({"error": mode.split(":", 1)[1]}).encode()
        return SimpleNamespace(returncode=0, stdout=header + b"\n")
    length = len(request["text"])
    duration = max(300, length * PLAN.get("ms_per_char", 8))
    payload = wav_tools.wav_bytes(SPEECH_TONES, duration)
    timing = {"time_to_first_audio_byte_ms": 100.0 + length * 0.05, "total_synth_ms": 200.0 + length * 2.0}
    return SimpleNamespace(returncode=0, stdout=json.dumps(timing).encode() + b"\n" + payload)


fake_fish.requests = 0


def install():
    from telegram_client import call_service, runtime, tts_fish
    sys.addaudithook(audit)
    runtime.client_class = lambda: FakeClient
    tts_fish.subprocess = SimpleNamespace(
        run=fake_fish, PIPE=subprocess.PIPE, DEVNULL=subprocess.DEVNULL, TimeoutExpired=subprocess.TimeoutExpired)

    class FixtureEffects(call_service.Effects):
        """Production Effects with only the pyrogram enum and the pytgcalls dial replaced."""

        def parse_mode(self):
            return PARSE_DISABLED

        async def synthesize(self, text, directory, config_dir):
            # Real tts.synthesize, in this process so the Fish child boundary above applies.
            from telegram_client import tts
            emit("tts.synthesize", characters=len(text))
            return tts.synthesize(text, directory, config_dir=config_dir)

        async def dial(self, store, role, recipient, audio, timeout, idle):
            audio = Path(audio)
            root = next(p for p in audio.parents if p.name.startswith("tg-call-"))
            emit("dial", role=role, recipient=recipient, timeout=timeout, source_idle=idle,
                 audio=wav_tools.analyze(audio), profile=wav_tools.tone_profile(audio),
                 tree=tree_modes(root), audio_name=audio.name)
            mode = PLAN.get("dial", "ok")
            if mode == "timeout":
                raise TimeoutError()
            if mode == "declined":
                from telegram_client.core import ClientError
                raise ClientError("CALL_INCOMPLETE")
            if mode == "cancel":
                raise asyncio.CancelledError()

    call_service.Effects = FixtureEffects


def main():
    argv = sys.argv[1:]
    # Only the commands that production reads stdin for may block on it; queries never do.
    takes_stdin = "--say-stdin" in argv or "--context-stdin" in argv or "send" in argv
    raw = sys.stdin.read() if takes_stdin and not sys.stdin.isatty() else None
    emit("sidecar.start", argv=argv, bot_token_in_env="TG_BOT_TOKEN" in os.environ,
         stdin=json.loads(raw) if raw else None, cwd=os.getcwd(),
         config_dir=os.environ.get("TG_CTL_CONFIG_DIR"))
    if raw is not None:
        sys.stdin = io.StringIO(raw)
    install()
    from telegram_client.cli import main as cli_main
    if len(argv) < 2 or argv[0] not in ("personal", "caller"):
        return 2
    code = cli_main(argv[0], argv[1:])
    emit("sidecar.exit", code=code)
    return code


if __name__ == "__main__":
    sys.exit(main())
