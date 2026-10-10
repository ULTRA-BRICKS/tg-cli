"""Synthetic duplex contracts only: never authorizes, dials, or invokes paid providers."""

import asyncio
from pathlib import Path
import struct
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "features"))
from telegram_client.conversation import BRACHO, Conversation, VoiceProfile
from telegram_client.core import ClientError


class Clock:
    value = 10.0

    def __call__(self):
        return self.value

    def tick(self, ms):
        self.value += ms / 1000


class Stt:
    def __init__(self):
        self.frames = []
        self.connected = 0
        self.closed = 0
        self.flushed = 0

    async def connect(self):
        self.connected += 1

    async def send_audio(self, pcm):
        self.frames.append(pcm)

    async def end_utterance(self):
        self.flushed += 1

    async def close(self):
        self.closed += 1


class Model:
    def __init__(self, clock):
        self.clock = clock
        self.histories = []

    async def reply(self, context):
        self.histories.append(tuple(context))
        self.clock.tick(20)
        yield "Ответ."

    async def close(self):
        pass


class Tts:
    def __init__(self, clock):
        self.clock = clock
        self.voices = []
        self.closed = 0

    async def synthesize(self, text, voice):
        self.voices.append(voice.name)
        self.clock.tick(30)
        yield b"\x01\x00" * 48

    async def close(self):
        self.closed += 1


class Transport:
    def __init__(self, clock):
        self.clock = clock
        self.sent = []
        self.stops = 0
        self.closed = 0
        self.drains = 0

    async def send_audio(self, pcm, generation):
        self.sent.append((pcm, generation))

    async def stop_audio(self):
        self.clock.tick(5)
        self.stops += 1

    async def drain_audio(self):
        self.drains += 1

    async def hangup(self):
        self.closed += 1


class ConversationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.clock = Clock()
        self.stt = Stt()
        self.model = Model(self.clock)
        self.tts = Tts(self.clock)
        self.transport = Transport(self.clock)
        self.voice = VoiceProfile(
            "bracho", "Брачо", "fixture", "explicit-fixture-voice"
        )
        self.s = Conversation(
            self.stt, self.model, self.tts, self.transport, self.voice, self.clock
        )

    async def asyncTearDown(self):
        await self.s.event("CALL_ENDED")

    async def start(self):
        await self.s.event("CALL_CONNECTED")
        await self.s.event("VAD_START")

    async def test_streaming_audio_and_turn_context(self):
        await self.start()
        self.assertTrue(
            await self.s.audio(struct.pack(">H", 0) + b"\x01\x00" * 48, self.s.epoch)
        )
        self.assertEqual(self.stt.frames, [b"\x01\x00" * 48])
        await self.s.event("VAD_END")
        self.assertEqual(self.stt.flushed, 1)
        await self.s.final("Привет", self.s.epoch)
        await self.s.drain()
        self.assertTrue(self.transport.sent)
        self.assertEqual(self.tts.voices, ["bracho"])
        self.assertEqual(self.s.context, [("user", "Привет"), ("assistant", "Ответ.")])
        await self.s.event("VAD_START")
        await self.s.event("VAD_END")
        await self.s.final("А дальше?", self.s.epoch)
        await self.s.drain()
        self.assertIn(("assistant", "Ответ."), self.model.histories[-1])

    async def test_latency_is_measured_not_assumed(self):
        await self.start()
        await self.s.event("VAD_END")
        self.clock.tick(10)
        await self.s.final("Вопрос", self.s.epoch)
        await self.s.drain()
        self.assertAlmostEqual(self.s.metrics["stt_final_ms"][-1], 10)
        self.assertAlmostEqual(self.s.metrics["first_text_ms"][-1], 30)
        self.assertAlmostEqual(self.s.metrics["first_audio_completed_ms"][-1], 60)
        self.assertAlmostEqual(self.s.metrics["interrupt_to_stop_ms"][0], 5)

    async def test_interrupt_drops_late_tts_even_if_it_ignores_cancel(self):
        entered = asyncio.Event()
        release = asyncio.Event()

        class LateTts:
            async def synthesize(self, text, voice):
                entered.set()
                try:
                    await release.wait()
                except asyncio.CancelledError:
                    await release.wait()
                yield b"late"

            async def close(self):
                release.set()

        self.s.tts = LateTts()
        await self.start()
        await self.s.event("VAD_END")
        await self.s.final("Вопрос", self.s.epoch)
        await asyncio.wait_for(entered.wait(), 1)
        stops = self.transport.stops
        await self.s.event("VAD_START")
        self.assertGreater(self.transport.stops, stops)
        release.set()
        await self.s.drain()
        self.assertEqual(self.transport.sent, [])
        self.assertNotIn(("assistant", "Ответ."), self.s.context)

    async def test_reconnect_preserves_context_but_drops_old_audio(self):
        await self.start()
        old = self.s.epoch
        await self.s.event("TRANSPORT_DISCONNECTED")
        self.assertFalse(await self.s.audio(b"\x00\x00ab", old))
        await self.s.event("TRANSPORT_RECONNECTED")
        await self.s.event("VAD_START")
        self.assertGreater(self.s.epoch, old)
        self.assertFalse(await self.s.audio(b"\x00\x00ab", old))
        self.assertTrue(await self.s.audio(b"\x00\x00ab", self.s.epoch))
        self.assertEqual(self.stt.connected, 2)

    async def test_hangup_is_idempotent_and_rejects_late_events(self):
        await self.start()
        await self.s.event("CALL_ENDED")
        await self.s.event("CALL_ENDED")
        await self.s.final("late", self.s.epoch)
        self.assertTrue(self.s.ended)
        self.assertEqual(self.transport.closed, 1)
        self.assertEqual(self.tts.closed, 1)
        self.assertFalse(await self.s.audio(b"\x00\x00ab", self.s.epoch))

    async def test_sequence_duplicates_and_bad_pcm_are_rejected(self):
        await self.start()
        packet = b"\x00\x00ab"
        self.assertTrue(await self.s.audio(packet, self.s.epoch))
        self.assertFalse(await self.s.audio(packet, self.s.epoch))
        self.assertFalse(await self.s.audio(b"\x00", self.s.epoch))

    async def test_provider_failure_hangs_up_without_unobserved_task(self):
        class BrokenModel:
            async def reply(self, context):
                raise RuntimeError("fixture")
                yield ""

            async def close(self):
                pass

        self.s.model = BrokenModel()
        await self.start()
        await self.s.event("VAD_END")
        await self.s.final("question", self.s.epoch)
        await asyncio.wait_for(self.s.finished.wait(), 1)
        self.assertEqual(self.s.failure, "CONVERSATION_PROVIDER_FAILED")
        self.assertEqual(self.transport.closed, 1)

    async def test_agent_end_call_waits_for_playback_then_hangs_up(self):
        self.model.end_call = True
        await self.start()
        await self.s.event("VAD_END")
        await self.s.final("goodbye", self.s.epoch)
        await asyncio.wait_for(self.s.finished.wait(), 1)
        self.assertEqual(self.transport.drains, 1)
        self.assertEqual(self.transport.closed, 1)

    async def test_bracho_has_no_xenia_fallback(self):
        with self.assertRaisesRegex(ClientError, "VOICE_PROFILE_UNCONFIGURED"):
            Conversation(
                self.stt, self.model, self.tts, self.transport, BRACHO, self.clock
            )


if __name__ == "__main__":
    unittest.main()
