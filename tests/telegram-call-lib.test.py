"""Consumer acceptance: one shared distribution, fail-closed start, no real call."""

import json
import importlib
import os
import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
CLI = Path(os.environ.get("TG_CALL_TEST_ENTRY", str(ROOT / "tg-call")))


class CallLibTests(unittest.TestCase):
    def test_cli_start_exists_and_refuses_unready_before_auth(self):
        result = subprocess.run(
            [
                sys.executable,
                str(CLI),
                "--store",
                "/nonexistent-auth-fixture",
                "start",
                "--providers-config",
                str(ROOT / "features/telegram_client/providers.example.json"),
                "--confirm-call",
                "--allow-provider-network",
                "--source-session-idle-confirmed",
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertEqual(json.loads(result.stdout)["error"], "PROVIDERS_NOT_CONFIGURED")

    def test_package_declares_single_source(self):
        path = ROOT / "pyproject.toml"
        self.assertTrue(path.is_file(), "call-lib distribution metadata is missing")


if os.environ.get("TG_CALL_TEST_INSTALLED") != "1":
    sys.path.insert(0, str(ROOT / "features"))
call_lib = importlib.import_module("telegram_client.call_lib")
cli = importlib.import_module("telegram_client.cli")
bridge = importlib.import_module("telegram_client.bridge")
ClientError = importlib.import_module("telegram_client.core").ClientError


class SharedConsumerTests(unittest.IsolatedAsyncioTestCase):
    def config(self):
        return {
            "voice": {"status": "confirmed"},
            "agent": {"protocol": "call-agent-json-v1"},
        }

    async def test_cli_and_calbot_runner_share_module_version_and_fake_audio(self):
        from telegram_client.smoke import smoke

        class Owner:
            def __init__(self):
                self.opens = 0
                self.disposed = 0

            def readiness(self, config):
                return {"configured": True}

            async def prepare(self, config):
                return "fixture"

            @asynccontextmanager
            async def open(self, store, config, prepared):
                self.opens += 1
                self.proof = await smoke()
                finished = asyncio.Event()
                finished.set()
                yield SimpleNamespace(finished=finished, failure=None)

            async def dispose(self, prepared):
                self.disposed += 1

        owner = Owner()
        a = await cli.conversational_start(
            None, self.config(), call_lib.Consent(True, True, True), owner
        )
        b = await bridge.dispatch(
            {
                "protocol": 1,
                "action": "start",
                "config": self.config(),
                "consent": {
                    "call": True,
                    "provider_network": True,
                    "source_idle": True,
                },
            },
            owner,
        )
        self.assertEqual(a["library"], b["library"])
        self.assertEqual(a["library"]["version"], "0.1.0")
        self.assertEqual(owner.opens, 2)
        self.assertEqual(owner.disposed, 2)
        self.assertTrue(owner.proof["hangup_cleanup"])
        self.assertEqual(owner.proof["audio_output_chunks"], 2)

    async def test_missing_voice_agent_or_consent_never_opens_transport(self):
        class Owner:
            def readiness(self, config):
                return {"configured": True}

            async def prepare(self, config):
                raise AssertionError("must not prepare")

        cases = [
            ({}, call_lib.Consent(), "LIVE_START_NOT_AUTHORIZED"),
            ({}, call_lib.Consent(True, True, True), "VOICE_PROFILE_UNCONFIRMED"),
            (
                {"voice": {"status": "confirmed"}},
                call_lib.Consent(True, True, True),
                "AGENT_PROTOCOL_UNCONFIRMED",
            ),
        ]
        for config, consent, error in cases:
            with self.assertRaisesRegex(ClientError, error):
                await call_lib.start_conversation(None, config, consent, Owner())

    async def test_timeout_and_cancellation_release_shared_owner(self):
        class Owner:
            closed = disposed = 0

            def readiness(self, config):
                return {"configured": True}

            async def prepare(self, config):
                return None

            @asynccontextmanager
            async def open(self, store, config, prepared):
                try:
                    yield SimpleNamespace(finished=asyncio.Event(), failure=None)
                finally:
                    self.closed += 1

            async def dispose(self, prepared):
                self.disposed += 1

        owner = Owner()
        task = asyncio.create_task(
            call_lib.start_conversation(
                None, self.config(), call_lib.Consent(True, True, True), owner
            )
        )
        await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual((owner.closed, owner.disposed), (1, 1))
        with self.assertRaisesRegex(ClientError, "CALL_DURATION_EXCEEDED"):
            await call_lib.start_conversation(
                None,
                self.config(),
                call_lib.Consent(True, True, True),
                owner,
                maximum_seconds=1,
            )
        self.assertEqual((owner.closed, owner.disposed), (2, 2))

    async def test_mock_agent_cannot_be_used_as_production_agent(self):
        config = {
            "agent": {
                "command": [
                    sys.executable,
                    str(ROOT / "features/telegram_client/mock_agent.py"),
                ]
            }
        }
        with self.assertRaisesRegex(ClientError, "AGENT_NOT_PRODUCTION_READY"):
            await call_lib.NativeOwner().prepare(config)

    async def test_mock_protocol_roundtrip_and_descriptor(self):
        from telegram_client.providers import JsonCallAgent

        agent = JsonCallAgent(
            [sys.executable, str(ROOT / "features/telegram_client/mock_agent.py")]
        )
        self.assertEqual((await agent.describe())["backend"], "mock")
        self.assertEqual(
            await agent.run({"userId": 42, "transcript": "hello"}),
            {"responseText": "Mock: hello", "endCall": False},
        )


if __name__ == "__main__":
    unittest.main()
