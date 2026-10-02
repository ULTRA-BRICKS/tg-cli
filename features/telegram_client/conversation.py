"""Synthetic-testable call orchestration; provider and transport ports are injected."""

import asyncio
from dataclasses import dataclass
from typing import Optional

from .core import ClientError


@dataclass(frozen=True)
class VoiceProfile:
    name: str
    display_name: str
    provider: Optional[str] = None
    voice_id: Optional[str] = None

    def require_configured(self):
        if not self.provider or not self.voice_id:
            raise ClientError("VOICE_PROFILE_UNCONFIGURED")


BRACHO = VoiceProfile("bracho", "Брачо")


class Conversation:
    def __init__(self, stt, model, tts, transport, voice, clock):
        voice.require_configured()
        self.stt, self.model, self.tts, self.transport = stt, model, tts, transport
        self.voice, self.clock = voice, clock
        self.epoch = 0
        self.generation = 0
        self.context = []
        self.metrics = {}
        self.ended = False
        self.connected = False
        self.speaking = False
        self.endpoint = None
        self.sequence = None
        self.tasks = set()
        self.failure = None
        self.finished = asyncio.Event()

    def measure(self, name, start):
        self.metrics.setdefault(name, []).append((self.clock() - start) * 1000)

    async def interrupt(self, exclude=None):
        self.generation += 1
        for task in self.tasks:
            if (
                not task.done()
                and task is not asyncio.current_task()
                and task is not exclude
            ):
                task.cancel()
        start = self.clock()
        await self.transport.stop_audio()
        self.measure("interrupt_to_stop_ms", start)

    async def event(self, name):
        if self.ended:
            return
        if name == "CALL_ENDED":
            self.ended = True
            self.connected = False
            stop_result = await asyncio.gather(
                self.interrupt(exclude=asyncio.current_task()), return_exceptions=True
            )
            # Attempt every cleanup even if another port fails.
            results = await asyncio.gather(
                asyncio.wait_for(self.stt.close(), 2),
                asyncio.wait_for(self.model.close(), 2),
                asyncio.wait_for(self.tts.close(), 2),
                asyncio.wait_for(self.transport.hangup(), 2),
                return_exceptions=True,
            )
            other_tasks = self.tasks - {asyncio.current_task()}
            if other_tasks:
                _, pending = await asyncio.wait(other_tasks, timeout=1)
                for task in pending:
                    task.cancel()
            self.finished.set()
            if any(isinstance(result, Exception) for result in results + stop_result):
                raise ClientError("CONVERSATION_CLEANUP_FAILED")
        elif name in ("CALL_CONNECTED", "TRANSPORT_RECONNECTED"):
            if not self.connected:
                await self.stt.connect()
                self.connected = True
                self.sequence = None
        elif name == "TRANSPORT_DISCONNECTED":
            self.connected = False
            self.speaking = False
            self.endpoint = None
            self.epoch += 1
            await self.interrupt()
            await self.stt.close()
        elif name == "VAD_START" and self.connected:
            await self.interrupt()
            self.speaking = True
            self.endpoint = None
            self.sequence = None
            if hasattr(self.stt, "begin_utterance"):
                await self.stt.begin_utterance(self.epoch, self.generation)
        elif name == "VAD_END" and self.connected and self.speaking:
            self.speaking = False
            self.endpoint = self.clock()
            await self.stt.end_utterance()

    async def audio(self, packet, epoch):
        if (
            self.ended
            or not self.connected
            or not self.speaking
            or epoch != self.epoch
            or len(packet) < 4
            or len(packet) % 2
        ):
            return False
        sequence = int.from_bytes(packet[:2], "big")
        if self.sequence is not None:
            delta = (sequence - self.sequence) % 65536
            if not 0 < delta < 32768:
                return False
        self.sequence = sequence
        await self.stt.send_audio(packet[2:])
        return True

    async def final(self, text, epoch, generation=None):
        if (
            self.ended
            or not self.connected
            or self.speaking
            or epoch != self.epoch
            or (generation is not None and generation != self.generation)
            or self.endpoint is None
            or not text.strip()
        ):
            return
        endpoint = self.endpoint
        self.endpoint = None
        self.measure("stt_final_ms", endpoint)
        self.context.append(("user", text))
        task = asyncio.create_task(self.respond(self.generation, endpoint))
        self.tasks.add(task)
        task.add_done_callback(self.response_finished)

    def response_finished(self, task):
        self.tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            self.failure = "CONVERSATION_PROVIDER_FAILED"
            if not self.ended:
                cleanup = asyncio.create_task(self.event("CALL_ENDED"))
                cleanup.add_done_callback(
                    lambda task: None if task.cancelled() else task.exception()
                )

    async def respond(self, generation, endpoint):
        def current():
            return not self.ended and self.connected and generation == self.generation

        answer = []
        first_text = first_audio = True
        async for text in self.model.reply(tuple(self.context)):
            if not current():
                return
            if first_text:
                self.measure("first_text_ms", endpoint)
                first_text = False
            answer.append(text)
            async for pcm in self.tts.synthesize(text, self.voice):
                if not current():
                    return
                await self.transport.send_audio(pcm, generation)
                if not current():
                    return
                if first_audio:
                    self.measure("first_audio_completed_ms", endpoint)
                    first_audio = False
        if current():
            await self.transport.drain_audio()
            if current():
                self.context.append(("assistant", "".join(answer)))
                if getattr(self.model, "end_call", False):
                    await self.event("CALL_ENDED")

    async def drain(self):
        tasks = tuple(self.tasks)
        results = await asyncio.gather(*tasks, return_exceptions=True)
        self.tasks.difference_update(tasks)
        if self.failure or any(isinstance(result, Exception) for result in results):
            raise ClientError("CONVERSATION_PROVIDER_FAILED")
