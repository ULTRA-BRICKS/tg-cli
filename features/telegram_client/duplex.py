"""Independent adaptation of HyperCalendarBot's native duplex bridge (see NOTICE)."""

import asyncio
import struct
import tempfile
import wave
from pathlib import Path

from .core import ClientError


class NativeDuplex:
    """PyTgCalls port. Construction/binding never starts a client or places a call.

    The owner supplies an already authorized client and an already connected call.
    Playback uses the source bridge's file/PLAY_DONE contract, with PCM chunks
    serialized as private WAVs; STOP uses skip_stream, not buffered pause.
    """

    def __init__(self, calls, peer, media_factory, record_factory, vad, timeout=10):
        self.calls, self.peer = calls, peer
        self.media_factory, self.record_factory = media_factory, record_factory
        self.vad, self.timeout = vad, timeout
        self.stop_source = lambda: self.calls.skip_stream(self.peer)
        self.leave_source = lambda: self.calls.leave_call(self.peer)
        self.session = None
        self.lock = asyncio.Lock()
        self.done = asyncio.Event()
        self.generation = 0
        self.closed = False
        self.buffer = bytearray()
        self.sequence = 0
        self.speaking = False
        self.directory = tempfile.TemporaryDirectory(prefix="tg-call-audio-")
        self.counter = 0

    async def attach(self, session):
        self.session = session
        await session.event("CALL_CONNECTED")
        await self.calls.record(self.peer, self.record_factory())

    async def receive(self, pcm):
        if self.closed or not self.session or not self.session.connected:
            return
        self.buffer.extend(pcm)
        while len(self.buffer) >= 3072:
            frame = bytes(self.buffer[:3072])
            del self.buffer[:3072]
            detected = self.vad(frame)
            if detected and not self.speaking:
                self.speaking = True
                self.sequence = 0
                await self.session.event("VAD_START")
            if self.speaking:
                await self.session.audio(
                    struct.pack(">H", self.sequence) + frame, self.session.epoch
                )
                self.sequence = (self.sequence + 1) % 65536
            if not detected and self.speaking:
                self.speaking = False
                await self.session.event("VAD_END")

    async def send_audio(self, pcm, generation):
        if not pcm or len(pcm) % 2:
            raise ClientError("INVALID_OUTPUT_PCM")
        path = None
        try:
            async with self.lock:
                if self.closed or generation != self.generation:
                    return
                self.counter += 1
                path = Path(self.directory.name) / f"{self.counter}.wav"
                with wave.open(str(path), "wb") as output:
                    output.setparams((1, 2, 48000, 0, "NONE", "not compressed"))
                    output.writeframes(pcm)
                path.chmod(0o600)
                self.done.clear()
                await self.calls.play(self.peer, self.media_factory(str(path)))
            await asyncio.wait_for(self.done.wait(), self.timeout)
        finally:
            if path:
                path.unlink(missing_ok=True)

    async def stop_audio(self):
        async with self.lock:
            self.generation += 1
            self.done.set()
            if not self.closed:
                await asyncio.wait_for(self.stop_source(), self.timeout)

    async def drain_audio(self):
        return  # send_audio waits for the native PLAY_DONE event.

    async def disconnected(self):
        self.buffer.clear()
        self.speaking = False
        await self.session.event("TRANSPORT_DISCONNECTED")

    async def reconnected(self):
        await self.session.event("TRANSPORT_RECONNECTED")
        await self.calls.record(self.peer, self.record_factory())

    async def hangup(self):
        if self.closed:
            return
        self.closed = True
        self.done.set()
        try:
            await asyncio.wait_for(self.leave_source(), self.timeout)
        finally:
            self.buffer.clear()
            self.directory.cleanup()


def native_transport(calls, peer, vad):
    """Bind actual installed PyTgCalls updates. No network/call initiation here."""
    from pytgcalls.types import (
        MediaStream,
        RecordStream,
        StreamFrames,
        StreamEnded,
        Direction,
        Device,
        ChatUpdate,
    )
    from pytgcalls.types.raw.audio_stream import AudioParameters

    transport = NativeDuplex(
        calls,
        peer,
        lambda path: MediaStream(path, video_flags=MediaStream.Flags.IGNORE),
        lambda: RecordStream(audio=True, audio_parameters=AudioParameters(48000, 1)),
        vad,
    )

    if not callable(getattr(calls, "skip_stream", None)):
        from ntgcalls import MediaDescription, StreamMode

        binding = getattr(calls, "_binding", None)
        if not callable(getattr(binding, "set_stream_sources", None)):
            transport.directory.cleanup()
            raise ClientError("NATIVE_INTERRUPT_UNSUPPORTED")

        async def clear_capture():
            # PyTgCalls 2.x uses this same native setter when replacing a stream.
            # Calling it directly cannot accidentally dial again after disconnect.
            await binding.set_stream_sources(
                peer, StreamMode.CAPTURE, MediaDescription()
            )

        transport.stop_source = clear_capture

    from ntgcalls import ConnectionNotFound
    from pytgcalls.exceptions import NotInCallError

    raw_stop = transport.stop_source

    async def stop_existing():
        try:
            await raw_stop()
        except (ConnectionNotFound, NotInCallError):
            pass  # The peer already ended the call; no source remains to stop.

    async def leave_existing():
        try:
            await calls.leave_call(peer)
        except (ConnectionNotFound, NotInCallError):
            pass

    transport.stop_source = stop_existing
    transport.leave_source = leave_existing

    @calls.on_update()
    async def update(_, event):
        if getattr(event, "chat_id", None) != peer or transport.closed:
            return
        try:
            if (
                isinstance(event, StreamFrames)
                and event.direction == Direction.INCOMING
            ):
                for frame in event.frames:
                    await transport.receive(frame.frame)
            elif (
                isinstance(event, StreamEnded)
                and event.stream_type == StreamEnded.Type.AUDIO
                and event.device == Device.MICROPHONE
            ):
                transport.done.set()
            elif (
                isinstance(event, ChatUpdate)
                and event.status & ChatUpdate.Status.LEFT_CALL
            ):
                if transport.session:
                    await transport.session.event("CALL_ENDED")
        except Exception:
            if transport.session:
                transport.session.failure = "CALL_INPUT_FAILED"
                await transport.session.event("CALL_ENDED")

    return transport


class CallAgentAdapter:
    """Keep the generic calbot CallAgent.run({userId, transcript}) boundary."""

    def __init__(self, agent, user_id):
        self.agent, self.user_id = agent, user_id
        self.end_call = False

    async def reply(self, context):
        result = await self.agent.run(
            {"userId": self.user_id, "transcript": context[-1][1]}
        )
        self.end_call = result.get("endCall") is True
        if result.get("responseText"):
            yield result["responseText"]

    async def close(self):
        await self.agent.close()
