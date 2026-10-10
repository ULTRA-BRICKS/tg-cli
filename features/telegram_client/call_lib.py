"""Shared call owner used by both CLI and calbot adapter; never imports calbot."""

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
import time

from .core import ClientError
from .paths import receipt_path

VERSION = "0.1.0"


def identity():
    try:
        installed = version("tg-call-lib")
    except PackageNotFoundError:
        installed = VERSION
    if installed != VERSION:
        raise ClientError("CALL_LIB_VERSION_MISMATCH")
    return {
        "distribution": "tg-call-lib",
        "version": VERSION,
        "module": str(Path(__file__).resolve()),
    }


@dataclass(frozen=True)
class Consent:
    call: bool = False
    provider_network: bool = False
    source_idle: bool = False


async def start_conversation(
    store, config, consent, backend=None, maximum_seconds=1800
):
    """Validate and prepare before any Telegram connection; one attempt, no redial."""
    if not all(
        value is True
        for value in (consent.call, consent.provider_network, consent.source_idle)
    ):
        raise ClientError("LIVE_START_NOT_AUTHORIZED")
    if type(maximum_seconds) is not int or not 1 <= maximum_seconds <= 1800:
        raise ClientError("INVALID_CALL_DURATION")
    owner = backend or NativeOwner()
    if not owner.readiness(config).get("configured"):
        raise ClientError("PROVIDERS_NOT_CONFIGURED")
    if config.get("voice", {}).get("status") != "confirmed":
        raise ClientError("VOICE_PROFILE_UNCONFIRMED")
    if config.get("agent", {}).get("protocol") != "call-agent-json-v1":
        raise ClientError("AGENT_PROTOCOL_UNCONFIRMED")
    prepared = await owner.prepare(config)
    try:
        async with owner.open(store, config, prepared) as session:
            try:
                await asyncio.wait_for(session.finished.wait(), maximum_seconds)
            except asyncio.TimeoutError:
                raise ClientError("CALL_DURATION_EXCEEDED") from None
            if session.failure:
                raise ClientError(session.failure)
            return {"state": "completed", "library": identity()}
    finally:
        await owner.dispose(prepared)


class NativeOwner:
    def readiness(self, config):
        from .providers import readiness, media_readiness

        result = readiness(config)
        media = media_readiness(receipt_path())
        result["configured"] = (
            result["configured"]
            and media["ffmpeg_available"]
            and media["patched_binary_matches_receipt"]
            and media["native_interrupt_api"] != "unavailable"
        )
        return result

    async def prepare(self, config):
        from .providers import JsonCallAgent, build_providers

        descriptor = await JsonCallAgent(config["agent"]["command"]).describe()
        if (
            descriptor.get("backend") != "production"
            or descriptor.get("ready") is not True
        ):
            raise ClientError("AGENT_NOT_PRODUCTION_READY")
        return build_providers(config)

    @asynccontextmanager
    async def open(self, store, config, prepared):
        from .runtime import connected
        from .conversation import Conversation
        from .duplex import native_transport
        from pytgcalls import PyTgCalls
        from ntgcalls import NTgCalls

        NTgCalls.enable_glib_loop(True)
        peer = config["user_id"]
        # start_conversation already required consent.source_idle before this point.
        async with connected(
            store, "caller", updates=True, source_idle_confirmed=True
        ) as app:
            if app.me.id == peer:
                raise ClientError("CALL_RECIPIENT_IS_CALLER")
            calls = PyTgCalls(app)
            stt, agent, tts, vad, voice = prepared
            transport = native_transport(calls, peer, vad)
            session = Conversation(stt, agent, tts, transport, voice, time.monotonic)
            stt.bind(session)
            transport.session = session
            try:
                await app.initialize()
                await calls.start()
                await asyncio.wait_for(calls.play(peer, None), 30)
                if session.ended:
                    raise ClientError("CALL_ENDED_BEFORE_CAPTURE")
                await transport.attach(session)
                yield session
            finally:
                await session.event("CALL_ENDED")

    async def dispose(self, prepared):
        stt, agent, tts, _, _ = prepared
        await asyncio.gather(
            stt.close(), agent.close(), tts.close(), return_exceptions=True
        )
