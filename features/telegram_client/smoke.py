"""Offline integration smoke through the real transport adapter with fake native I/O."""

import asyncio
import json
import time
import wave
from pathlib import Path

from .conversation import Conversation, VoiceProfile
from .duplex import NativeDuplex, CallAgentAdapter


async def smoke():
    class Calls:
        def __init__(self):
            self.output = []
            self.records = self.stops = self.left = 0
            self.playing = asyncio.Event()

        async def record(self, peer, config):
            self.records += 1

        async def play(self, peer, path):
            with wave.open(path, "rb") as source:
                self.output.append(source.readframes(source.getnframes()))
            self.playing.set()

        async def skip_stream(self, peer):
            self.stops += 1

        async def leave_call(self, peer):
            self.left += 1

    class Stt:
        def __init__(self):
            self.frames = []
            self.turn = None

        async def connect(self):
            pass

        async def send_audio(self, pcm):
            self.frames.append(pcm)

        async def end_utterance(self):
            await session.final("fake audio transcript", session.epoch)

        async def close(self):
            pass

    class Agent:
        async def run(self, turn):
            assert turn == {"userId": 123, "transcript": "fake audio transcript"}
            return {"responseText": "mock response"}

        async def close(self):
            pass

    class Tts:
        async def synthesize(self, text, voice):
            assert text == "mock response" and voice.name == "bracho"
            yield b"\x02\x00" * 1536

        async def close(self):
            pass

    calls, stt = Calls(), Stt()
    transport = NativeDuplex(
        calls, 123, lambda p: p, lambda: "48k-mono", lambda pcm: pcm[0] != 0, timeout=1
    )
    session = Conversation(
        stt,
        CallAgentAdapter(Agent(), 123),
        Tts(),
        transport,
        VoiceProfile("bracho", "Брачо", "mock", "synthetic-only"),
        time.monotonic,
    )
    directory = transport.directory.name
    start = time.monotonic()
    try:
        await transport.attach(session)
        speech, silence = b"\x01\x00" * 1536, b"\x00\x00" * 1536
        # Exercise arbitrary native frame boundaries, not direct VAD injection.
        await transport.receive(speech[:100])
        await transport.receive(speech[100:] + silence)
        await asyncio.wait_for(calls.playing.wait(), 1)
        first_audio_ms = (time.monotonic() - start) * 1000
        assert calls.output == [b"\x02\x00" * 1536]
        assert stt.frames == [speech, silence]
        interrupt_start = time.monotonic()
        await transport.receive(speech)
        await session.drain()
        interrupt_ms = (time.monotonic() - interrupt_start) * 1000
        assert calls.stops >= 2
        assert not any(role == "assistant" for role, _ in session.context)
        old_epoch = session.epoch
        await transport.disconnected()
        await transport.reconnected()
        assert session.epoch > old_epoch and calls.records == 2
        calls.playing.clear()
        await transport.receive(speech + silence)
        await asyncio.wait_for(calls.playing.wait(), 1)
        transport.done.set()
        await session.drain()
        assert session.context[-1] == ("assistant", "mock response")
    finally:
        await session.event("CALL_ENDED")
        await session.event("CALL_ENDED")
    assert calls.left == 1 and not Path(directory).exists()
    return {
        "ok": True,
        "network": False,
        "call_placed": False,
        "audio_input_frames": len(stt.frames),
        "audio_output_chunks": len(calls.output),
        "first_mock_audio_ms": round(first_audio_ms, 3),
        "interrupt_cleanup_ms": round(interrupt_ms, 3),
        "reconnect": True,
        "hangup_cleanup": True,
        "production_voice": "unresolved",
        "latency_scope": "local fake native I/O; real monotonic clock",
    }


if __name__ == "__main__":
    print(json.dumps(asyncio.run(smoke())))
