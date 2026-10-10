"""Runnable provider bindings; no connection, weight load, or subprocess on import.

Nova wire parameters and Silero preprocessing derive from HyperCalendarBot; NOTICE.
Credentials are passed by the caller only at explicit provider activation.
"""

import asyncio
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import urlencode

from .core import ClientError


def verified_weight(path, digest):
    file = Path(path)
    if not file.is_file() or len(digest) != 64:
        raise ClientError("MODEL_FILE_OR_HASH_MISSING")
    checksum = hashlib.sha256()
    with file.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(block)
    if checksum.hexdigest() != digest:
        raise ClientError("MODEL_HASH_MISMATCH")
    return file


class NovaStreamingSTT:
    """One Nova websocket per utterance: no transcript leaks across interruption.

    Audio is streamed as captured; CloseStream flushes the final transcript.
    connect() arms locally. begin_utterance() is the first network operation.
    """

    def __init__(self, key, socket_factory=None, timeout=10):
        self.key, self.factory, self.timeout = key, socket_factory, timeout
        self.socket = self.http = self.reader = None
        self.session = None
        self.epoch = self.generation = None
        self.parts = []
        self.error = None
        self.finalizer = None

    def bind(self, session):
        self.session = session

    async def connect(self):
        pass

    async def begin_utterance(self, epoch, generation):
        await self.close()
        self.epoch, self.generation = epoch, generation
        self.parts, self.error = [], None
        params = dict(
            model="nova-3",
            language="ru",
            punctuate="true",
            smart_format="true",
            encoding="linear16",
            sample_rate="48000",
            channels="1",
            interim_results="true",
        )
        url = "wss://api.deepgram.com/v1/listen?" + urlencode(params)
        try:
            if self.factory:
                self.socket = await asyncio.wait_for(
                    self.factory(url, self.key), self.timeout
                )
            else:
                if not self.key:
                    raise ClientError("STT_CREDENTIAL_MISSING")
                import aiohttp

                self.http = aiohttp.ClientSession(
                    timeout=aiohttp.ClientTimeout(total=None, sock_connect=self.timeout)
                )
                self.socket = await asyncio.wait_for(
                    self.http.ws_connect(
                        url,
                        headers={"Authorization": "Token " + self.key},
                        max_msg_size=1024 * 1024,
                    ),
                    self.timeout,
                )
            self.reader = asyncio.create_task(self.read())
        except BaseException:
            await self.close()
            raise

    async def read(self):
        try:
            async for message in self.socket:
                data = getattr(message, "data", message)
                if not isinstance(data, str):
                    continue
                try:
                    value = json.loads(data)
                except (ValueError, TypeError):
                    continue
                if value.get("type") == "Error":
                    raise ClientError("STT_PROVIDER_FAILED")
                alternatives = value.get("channel", {}).get("alternatives", [])
                text = alternatives[0].get("transcript", "") if alternatives else ""
                if value.get("is_final") and text:
                    self.parts.append(text)
        except asyncio.CancelledError:
            raise
        except Exception:
            self.error = ClientError("STT_PROVIDER_FAILED")

    async def send_audio(self, pcm):
        if not self.socket:
            raise ClientError("STT_NOT_CONNECTED")
        await asyncio.wait_for(self.socket.send_bytes(pcm), self.timeout)

    async def end_utterance(self):
        if self.socket:
            self.finalizer = asyncio.create_task(self.finish())

    async def finish(self):
        if not self.socket:
            return
        socket, reader = self.socket, self.reader
        epoch, generation = self.epoch, self.generation
        try:
            await socket.send_str(json.dumps({"type": "CloseStream"}))
            await asyncio.wait_for(asyncio.shield(reader), self.timeout)
            if self.error:
                raise self.error
            await self.session.final(" ".join(self.parts), epoch, generation)
        except asyncio.CancelledError:
            raise
        except Exception:
            self.error = ClientError("STT_PROVIDER_FAILED")
            cleanup = asyncio.create_task(self.session.event("CALL_ENDED"))
            cleanup.add_done_callback(
                lambda task: None if task.cancelled() else task.exception()
            )

    async def close(self):
        if self.finalizer and self.finalizer is not asyncio.current_task():
            self.finalizer.cancel()
            await asyncio.gather(self.finalizer, return_exceptions=True)
        self.finalizer = None
        if self.reader and self.reader is not asyncio.current_task():
            self.reader.cancel()
            await asyncio.gather(self.reader, return_exceptions=True)
        if self.socket:
            await self.socket.close()
        if self.http:
            await self.http.close()
        self.socket = self.http = self.reader = None


async def process_json(command, payload, timeout=30, raw=False):
    """Bounded JSON stdin, stdout-only result; kill/reap child on cancel or timeout."""
    process = await asyncio.create_subprocess_exec(
        *command,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )

    async def exchange():
        process.stdin.write(json.dumps(payload).encode())
        await process.stdin.drain()
        process.stdin.close()
        maximum = 16 * 1024 * 1024
        chunks, size = [], 0
        while True:
            chunk = await process.stdout.read(min(65536, maximum + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > maximum:
                raise ClientError("PROVIDER_RESPONSE_TOO_LARGE")
        await process.wait()
        if process.returncode:
            raise ClientError("PROVIDER_PROCESS_FAILED")
        stdout = b"".join(chunks)
        return stdout if raw else json.loads(stdout)

    try:
        return await asyncio.wait_for(exchange(), timeout)
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


class JsonCallAgent:
    """Existing generic CallAgent contract over a configured executable's JSON stdin.

    No shell. The configured agent owns persistent user context and tool policies.
    This adapter does not import the calendar agent or its application database.
    """

    def __init__(self, command):
        self.command = command

    async def describe(self):
        result = await process_json(
            self.command,
            {"action": "describe", "protocol": "call-agent-json-v1"},
            timeout=5,
        )
        if (
            not isinstance(result, dict)
            or result.get("protocol") != "call-agent-json-v1"
        ):
            raise ClientError("AGENT_PROTOCOL_UNSUPPORTED")
        return result

    async def run(self, turn):
        result = await process_json(self.command, turn)
        if not isinstance(result, dict) or not isinstance(
            result.get("responseText", ""), str
        ):
            raise ClientError("INVALID_AGENT_RESPONSE")
        return result

    async def close(self):
        pass


class SileroTTS:
    """Local pinned model worker; explicit voice ID only, cancellable subprocess."""

    def __init__(self, python, model_path, sha256, worker=None):
        self.python, self.path, self.sha256 = python, str(model_path), sha256
        self.worker = worker or Path(__file__).with_name("silero_worker.py")

    async def synthesize(self, text, voice):
        voice.require_configured()
        if voice.provider != "silero":
            raise ClientError("VOICE_PROVIDER_MISMATCH")
        verified_weight(self.path, self.sha256)
        pcm = await process_json(
            [self.python, str(self.worker)],
            {
                "text": text,
                "speaker": voice.voice_id,
                "model": self.path,
                "sha256": self.sha256,
            },
            raw=True,
        )
        if not pcm or len(pcm) % 2:
            raise ClientError("INVALID_TTS_PCM")
        # Bounded playback units allow transport interruption between chunks.
        for offset in range(0, len(pcm), 48000):
            yield pcm[offset : offset + 48000]

    async def close(self):
        pass


class SileroVAD:
    """Source 48k->16k decimation, explicit verified TorchScript weight, CPU only."""

    def __init__(self, model_path, sha256):
        import torch

        self.torch = torch
        self.model = torch.jit.load(
            str(verified_weight(model_path, sha256)), map_location="cpu"
        )
        self.model.eval()

    def __call__(self, pcm):
        import array
        import sys

        samples = array.array("h", pcm)
        if sys.byteorder != "little":
            samples.byteswap()
        tensor = self.torch.tensor(samples[::3], dtype=self.torch.float32) / 32768.0
        with self.torch.no_grad():
            return self.model(tensor, 16000).item() > 0.5

    def reset(self):
        self.model.reset_states()


def readiness(config):
    """Offline metadata only: never reads credential values or loads model code."""
    import importlib.util
    import shutil

    result = {"network_called": False, "voice_ready": False, "live_verified": False}
    voice = config.get("voice", {})
    result["voice_ready"] = (
        voice.get("name") == "bracho"
        and voice.get("provider") == "silero"
        and isinstance(voice.get("voice_id"), str)
        and bool(voice["voice_id"].strip())
    )
    result["stt_provider_supported"] = (
        config.get("stt", {}).get("provider") == "deepgram-nova-3"
    )
    result["recipient_configured"] = (
        type(config.get("user_id")) is int and config["user_id"] > 0
    )
    result["stt_credential_present"] = bool(
        config.get("stt", {}).get("credential_env") in os.environ
    )
    command = config.get("agent", {}).get("command", [])
    result["agent_executable"] = bool(command and shutil.which(command[0]))
    result["tts_python_executable"] = bool(
        shutil.which(config.get("tts", {}).get("python", ""))
    )
    result["tts_python_dependencies"] = False
    if result["tts_python_executable"]:
        import subprocess

        try:
            probe = subprocess.run(
                [
                    config["tts"]["python"],
                    "-I",
                    "-c",
                    "import importlib.util; print(int(all(importlib.util.find_spec(n) is not None for n in ('torch','numpy'))))",
                ],
                capture_output=True,
                timeout=5,
                check=False,
            )
            result["tts_python_dependencies"] = (
                probe.returncode == 0 and probe.stdout.strip() == b"1"
            )
        except (OSError, subprocess.TimeoutExpired):
            pass
    for name in ("tts", "vad"):
        entry = config.get(name, {})
        try:
            verified_weight(entry.get("model", ""), entry.get("sha256", ""))
            result[name + "_weight_verified"] = True
        except (ClientError, OSError, TypeError):
            result[name + "_weight_verified"] = False
    result["dependencies"] = {
        name: importlib.util.find_spec(name) is not None
        for name in ("aiohttp", "torch", "pytgcalls")
    }
    result["configured"] = all(
        result.get(key, False)
        for key in (
            "voice_ready",
            "stt_provider_supported",
            "recipient_configured",
            "stt_credential_present",
            "agent_executable",
            "tts_python_executable",
            "tts_python_dependencies",
            "tts_weight_verified",
            "vad_weight_verified",
        )
    ) and all(result["dependencies"].values())
    return result


def build_providers(config):
    """Explicit activation only. Caller must authorize provider use before calling."""
    from .conversation import VoiceProfile
    from .duplex import CallAgentAdapter

    if not readiness(config)["configured"]:
        raise ClientError("PROVIDERS_NOT_CONFIGURED")
    stt = NovaStreamingSTT(os.environ[config["stt"]["credential_env"]])
    agent = CallAgentAdapter(
        JsonCallAgent(config["agent"]["command"]), config["user_id"]
    )
    tts = SileroTTS(
        config["tts"]["python"], config["tts"]["model"], config["tts"]["sha256"]
    )
    vad = SileroVAD(config["vad"]["model"], config["vad"]["sha256"])
    voice = VoiceProfile("bracho", "Брачо", "silero", config["voice"]["voice_id"])
    return stt, agent, tts, vad, voice


async def attach_configured_session(calls, peer, config):
    """Attach to a caller-owned, already connected call; never dial or log in."""
    import time
    from .conversation import Conversation
    from .duplex import native_transport

    if config.get("user_id") != peer:
        raise ClientError("PROVIDER_PEER_MISMATCH")
    stt, agent, tts, vad, voice = build_providers(config)
    transport = native_transport(calls, peer, vad)
    session = Conversation(stt, agent, tts, transport, voice, time.monotonic)
    stt.bind(session)
    try:
        await transport.attach(session)
    except BaseException:
        await session.event("CALL_ENDED")
        raise
    return session, transport


def media_readiness(receipt_path):
    """Verify installed native binary against the existing private patch receipt."""
    import importlib.util
    import shutil

    result = {
        "ffmpeg_available": bool(shutil.which("ffmpeg")),
        "patched_binary_matches_receipt": False,
        "live_audio_verified": False,
    }
    result["native_interrupt_api"] = "unavailable"
    try:
        from pytgcalls import PyTgCalls
        from ntgcalls import NTgCalls

        if callable(getattr(PyTgCalls, "skip_stream", None)):
            result["native_interrupt_api"] = "skip_stream"
        elif callable(getattr(NTgCalls, "set_stream_sources", None)):
            result["native_interrupt_api"] = "clear_capture_sources"
    except ImportError:
        pass
    try:
        receipt = json.loads(Path(receipt_path).read_text())
        spec = importlib.util.find_spec("ntgcalls")
        if spec and spec.origin:
            verified_weight(spec.origin, receipt.get("sha256", ""))
            result["patched_binary_matches_receipt"] = True
    except (OSError, ValueError, TypeError, ClientError):
        pass
    return result
