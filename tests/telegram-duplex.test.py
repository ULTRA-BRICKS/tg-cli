"""No-network integration tests for native audio/interrupt/cleanup adapter."""

import asyncio
import importlib.util
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "features"))
from telegram_client.smoke import smoke
from telegram_client.duplex import NativeDuplex


class DuplexTests(unittest.IsolatedAsyncioTestCase):
    async def test_bidirectional_audio_interrupt_reconnect_cleanup(self):
        result = await smoke()
        self.assertTrue(result["ok"])
        self.assertEqual(result["audio_output_chunks"], 2)
        self.assertFalse(result["call_placed"])

    @unittest.skipUnless(
        importlib.util.find_spec("pytgcalls"), "native runtime not installed"
    )
    async def test_installed_native_event_binding_filters_peer_and_direction(self):
        from pytgcalls.types import StreamFrames, StreamEnded, Direction, Device, Frame
        from telegram_client.duplex import native_transport

        class Binding:
            def __init__(self):
                self.cleared = []

            async def set_stream_sources(self, *args):
                self.cleared.append(args)

        class Calls:
            def __init__(self):
                self._binding = Binding()

            def on_update(self):
                def register(handler):
                    self.handler = handler
                    return handler

                return register

            async def leave_call(self, peer):
                pass

        class Session:
            connected = True
            epoch = 0

            def __init__(self):
                self.events = []
                self.packets = []

            async def event(self, name):
                self.events.append(name)

            async def audio(self, packet, epoch):
                self.packets.append(packet)

        calls, session = Calls(), Session()
        port = native_transport(calls, 123, lambda pcm: True)
        port.session = session
        await port.stop_audio()
        self.assertEqual(calls._binding.cleared[0][0], 123)
        self.assertIsNone(calls._binding.cleared[0][2].microphone)
        port.done.clear()
        frames = [Frame(0, b"aa" * 1536, None)]
        await calls.handler(
            None, StreamFrames(999, Direction.INCOMING, Device.MICROPHONE, frames)
        )
        self.assertEqual(session.packets, [])
        await calls.handler(
            None, StreamFrames(123, Direction.INCOMING, Device.MICROPHONE, frames)
        )
        self.assertEqual(len(session.packets), 1)
        await calls.handler(
            None, StreamEnded(123, StreamEnded.Type.AUDIO, Device.MICROPHONE)
        )
        self.assertTrue(port.done.is_set())

        def broken_vad(pcm):
            raise RuntimeError("fixture")

        port.vad = broken_vad
        await calls.handler(
            None, StreamFrames(123, Direction.INCOMING, Device.MICROPHONE, frames)
        )
        self.assertEqual(session.events[-1], "CALL_ENDED")
        self.assertEqual(session.failure, "CALL_INPUT_FAILED")
        await port.hangup()

    @unittest.skipUnless(
        importlib.util.find_spec("pytgcalls"), "native runtime not installed"
    )
    async def test_native_cleanup_after_peer_left_is_idempotent(self):
        from ntgcalls import ConnectionNotFound
        from pytgcalls.exceptions import NotInCallError
        from telegram_client.duplex import native_transport

        class Binding:
            async def set_stream_sources(self, *args):
                raise ConnectionNotFound()

        class Calls:
            _binding = Binding()

            def on_update(self):
                return lambda handler: handler

            async def leave_call(self, peer):
                raise NotInCallError()

        port = native_transport(Calls(), 123, lambda pcm: False)
        await port.stop_audio()
        await port.hangup()
        self.assertTrue(port.closed)
        self.assertFalse(Path(port.directory.name).exists())

    async def test_native_play_failure_removes_private_audio(self):
        class Calls:
            async def play(self, peer, path):
                self.path = Path(path)
                raise RuntimeError("fixture")

            async def leave_call(self, peer):
                pass

        calls = Calls()
        port = NativeDuplex(calls, 1, lambda p: p, lambda: None, lambda p: False)
        with self.assertRaises(RuntimeError):
            await port.send_audio(b"aa", 0)
        self.assertFalse(calls.path.exists())
        await port.hangup()

    async def test_play_done_timeout_and_stale_generation(self):
        class Calls:
            plays = 0

            async def play(self, peer, path):
                self.plays += 1

            async def leave_call(self, peer):
                pass

        calls = Calls()
        port = NativeDuplex(
            calls, 1, lambda p: p, lambda: None, lambda p: False, timeout=0.01
        )
        await port.send_audio(b"aa", 99)
        self.assertEqual(calls.plays, 0)
        with self.assertRaises(asyncio.TimeoutError):
            await port.send_audio(b"aa", 0)
        self.assertEqual(list(Path(port.directory.name).iterdir()), [])
        await port.hangup()


if __name__ == "__main__":
    unittest.main()
