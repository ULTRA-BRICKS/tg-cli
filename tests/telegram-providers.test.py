"""Offline provider contract tests; no paid API, model download, or Telegram call."""

import asyncio
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "features"))
from telegram_client.providers import (
    NovaStreamingSTT,
    JsonCallAgent,
    SileroTTS,
    process_json,
    readiness,
)
from telegram_client.conversation import VoiceProfile


class ProvidersTests(unittest.IsolatedAsyncioTestCase):
    async def test_nova_real_wire_contract_with_fake_socket(self):
        class Socket:
            def __init__(self):
                self.queue = asyncio.Queue()
                self.audio = []
                self.closed = False

            def __aiter__(self):
                return self

            async def __anext__(self):
                value = await self.queue.get()
                if value is None:
                    raise StopAsyncIteration
                return value

            async def send_bytes(self, pcm):
                self.audio.append(pcm)

            async def send_str(self, value):
                self.command = json.loads(value)
                await self.queue.put(
                    json.dumps(
                        {
                            "is_final": True,
                            "channel": {"alternatives": [{"transcript": "Привет"}]},
                        }
                    )
                )
                await self.queue.put(None)

            async def close(self):
                self.closed = True

        class Session:
            def __init__(self):
                self.finals = []

            async def final(self, *args):
                self.finals.append(args)

        sockets = []

        async def connect(url, key):
            self.assertIn("model=nova-3", url)
            self.assertIn("sample_rate=48000", url)
            self.assertEqual(key, "fixture")
            socket = Socket()
            sockets.append(socket)
            return socket

        session = Session()
        stt = NovaStreamingSTT("fixture", connect)
        stt.bind(session)
        await stt.connect()
        self.assertEqual(sockets, [])
        await stt.begin_utterance(2, 3)
        await stt.send_audio(b"aa")
        await stt.end_utterance()
        await asyncio.wait_for(stt.finalizer, 1)
        self.assertEqual(session.finals, [("Привет", 2, 3)])
        self.assertEqual(sockets[0].audio, [b"aa"])
        await stt.begin_utterance(2, 4)
        self.assertTrue(sockets[0].closed)
        await stt.close()
        self.assertTrue(sockets[1].closed)

    @unittest.skipUnless(
        importlib.util.find_spec("aiohttp"), "provider runtime not installed"
    )
    async def test_nova_aiohttp_loopback_stream(self):
        from aiohttp import web, ClientSession, WSMsgType

        received = []

        async def handler(request):
            ws = web.WebSocketResponse()
            await ws.prepare(request)
            async for message in ws:
                if message.type == WSMsgType.BINARY:
                    received.append(message.data)
                elif message.type == WSMsgType.TEXT:
                    self.assertEqual(json.loads(message.data), {"type": "CloseStream"})
                    await ws.send_json(
                        {
                            "is_final": True,
                            "channel": {"alternatives": [{"transcript": "loopback"}]},
                        }
                    )
                    await ws.close()
            return ws

        app = web.Application()
        app.router.add_get("/listen", handler)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = runner.addresses[0][1]

        class Session:
            async def final(self, *args):
                self.result = args

        session = Session()
        try:
            async with ClientSession() as http:

                async def factory(url, key):
                    return await http.ws_connect(f"http://127.0.0.1:{port}/listen")

                stt = NovaStreamingSTT("", factory)
                stt.bind(session)
                try:
                    await stt.begin_utterance(1, 8)
                    await stt.send_audio(b"aa" * 1536)
                    await stt.end_utterance()
                    await asyncio.wait_for(stt.finalizer, 2)
                    self.assertEqual(session.result, ("loopback", 1, 8))
                    self.assertEqual(received, [b"aa" * 1536])
                finally:
                    await stt.close()
        finally:
            await runner.cleanup()

    async def test_stt_failure_cleanup_does_not_cancel_its_own_parent(self):
        class Socket:
            def __aiter__(self):
                return self

            async def __anext__(self):
                await asyncio.Future()

            async def send_str(self, value):
                raise RuntimeError("fixture")

            async def close(self):
                pass

        async def connect(url, key):
            return Socket()

        ended = asyncio.Event()
        stt = NovaStreamingSTT("fixture", connect)

        class Session:
            async def event(self, name):
                self.name = name
                await stt.close()
                ended.set()

        session = Session()
        stt.bind(session)
        await stt.begin_utterance(0, 1)
        await stt.end_utterance()
        await asyncio.wait_for(ended.wait(), 1)
        self.assertEqual(session.name, "CALL_ENDED")
        self.assertEqual(str(stt.error), "STT_PROVIDER_FAILED")

    async def test_agent_real_subprocess_json_interface(self):
        command = [
            sys.executable,
            "-c",
            'import sys,json; t=json.load(sys.stdin); print(json.dumps({"responseText":str(t["userId"])+t["transcript"],"endCall":True}))',
        ]
        agent = JsonCallAgent(command)
        self.assertEqual(
            await agent.run({"userId": 5, "transcript": "hello"}),
            {"responseText": "5hello", "endCall": True},
        )

    async def test_subprocess_timeout_kills_child(self):
        with tempfile.TemporaryDirectory() as directory:
            pidfile = Path(directory) / "pid"
            command = [
                sys.executable,
                "-c",
                'import os,time,pathlib; pathlib.Path(__import__("sys").argv[1]).write_text(str(os.getpid())); time.sleep(30)',
                str(pidfile),
            ]
            with self.assertRaises(asyncio.TimeoutError):
                await process_json(command, {}, timeout=0.2)
            import os

            with self.assertRaises(ProcessLookupError):
                os.kill(int(pidfile.read_text()), 0)

    async def test_tts_real_worker_pipe_and_explicit_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model = root / "model"
            model.write_bytes(b"fixture")
            worker = root / "worker.py"
            worker.write_text(
                'import json,sys; r=json.load(sys.stdin); assert r["speaker"]=="explicit"; sys.stdout.buffer.write(b"aa"*30000)'
            )
            tts = SileroTTS(
                sys.executable, model, hashlib.sha256(b"fixture").hexdigest(), worker
            )
            chunks = [
                pcm
                async for pcm in tts.synthesize(
                    "hello", VoiceProfile("bracho", "Брачо", "silero", "explicit")
                )
            ]
            self.assertEqual(list(map(len, chunks)), [48000, 12000])

    async def test_example_readiness_never_connects(self):
        config = json.loads(
            (
                Path(__file__).resolve().parents[1]
                / "features/telegram_client/providers.example.json"
            ).read_text()
        )
        result = readiness(config)
        self.assertFalse(result["configured"])
        self.assertFalse(result["voice_ready"])
        self.assertFalse(result["network_called"])


if __name__ == "__main__":
    unittest.main()
