"""`tg auth user` / `tg call` / `tg user send` sidecar: fakes only, no network, no credentials.

Covers the store location (config dir, never the repo checkout), login (phone, 2FA, QR,
identity gates), peer parsing/resolution, TTS selection, call preflight and the
`python -m telegram_client` entry the Bun `tg` spawns.
"""

import asyncio
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest

FEATURES = Path(__file__).resolve().parents[1] / "features"
sys.path.insert(0, str(FEATURES))
from telegram_client.core import AuthStore, ClientError, auth_origin

AUTH = dict(expected_id=7, api_id=11, api_hash="fixture-hash", session="fixture-session")


class SessionPasswordNeeded(Exception):
    """Same class name pyrogram raises; the sidecar matches on the name, not the import."""


class PeerIdInvalid(Exception):
    pass


def run(coro):
    return asyncio.run(coro)


def sidecar(*args, env=None, stdin=None):
    base = {"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", "/tmp")}
    return subprocess.run(
        [sys.executable, "-m", "telegram_client", *args],
        cwd=FEATURES,
        env={**base, "PYTHONPATH": str(FEATURES), **(env or {})},
        input=stdin,
        capture_output=True,
        text=True,
        timeout=20,
    )


class FakeLoginClient:
    """Records the calls a phone/QR login makes; raises like pyrofork where asked."""

    instances = []

    def __init__(self, name, **kwargs):
        self.kwargs = kwargs
        self.calls = []
        self.is_connected = False
        self.user = SimpleNamespace(id=7, is_bot=False, username="alex", first_name="Alex")
        self.password_needed = False
        self.qr_tokens = 0
        FakeLoginClient.instances.append(self)

    async def connect(self):
        self.is_connected = True
        return False

    async def disconnect(self):
        self.is_connected = False

    async def send_code(self, phone):
        self.calls.append(("send_code", phone))
        return SimpleNamespace(phone_code_hash="hash-1")

    async def sign_in(self, phone, code_hash, code):
        self.calls.append(("sign_in", phone, code_hash, code))
        if self.password_needed:
            raise SessionPasswordNeeded()
        return self.user

    async def check_password(self, password):
        self.calls.append(("check_password", password))
        return self.user

    async def sign_in_qrcode(self):
        self.calls.append(("sign_in_qrcode",))
        if self.qr_tokens > 0:
            self.qr_tokens -= 1
            return SimpleNamespace(token="t", expires=10**12)
        if self.password_needed:
            self.password_needed = False
            raise SessionPasswordNeeded()
        return self.user

    async def export_session_string(self):
        return "exported-session"

    async def log_out(self):
        self.calls.append(("log_out",))
        self.is_connected = False


class FakeCopyClient:
    """What import_session touches on the pyrogram copy: storage + export only."""

    def __init__(self, name, **kwargs):
        self.storage = self
        self.conn = None

    async def open(self):
        self.conn = True

    async def close(self):
        self.conn = None

    async def user_id(self):
        return 7

    async def is_bot(self):
        return False

    async def auth_key(self):
        return b"k"

    async def export_session_string(self):
        return "copied-session"


def prompts(*answers):
    queue = list(answers)
    asked = []

    def prompt(text):
        asked.append(text)
        return queue.pop(0)

    prompt.asked = asked
    return prompt


class PathTests(unittest.TestCase):
    def test_store_lives_in_the_tg_config_dir_never_the_repo_clone_dir(self):
        from telegram_client.paths import default_store, receipt_path

        self.assertEqual(default_store({"TG_CTL_CONFIG_DIR": "/x/cfg"}), Path("/x/cfg/mtproto"))
        self.assertEqual(
            default_store({}), Path.home() / ".config" / "tg-cli" / "mtproto"
        )
        self.assertNotIn(".local/share", str(default_store({})))
        self.assertNotIn(".local/share", str(receipt_path({})))


class StoreOriginTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = AuthStore(Path(self.temp.name) / "mtproto")

    def tearDown(self):
        self.temp.cleanup()

    def test_origin_is_kept_and_missing_origin_counts_as_import(self):
        self.store.save("personal", dict(AUTH, origin="login"))
        self.assertEqual(auth_origin(self.store.load("personal")), "login")
        self.store.save("caller", dict(AUTH))
        self.assertEqual(auth_origin(self.store.load("caller")), "import")

    def test_unknown_origin_is_refused(self):
        with self.assertRaisesRegex(ClientError, "INVALID_AUTH_STORE"):
            self.store.save("personal", dict(AUTH, origin="stolen"))

    def test_remove_deletes_only_that_role(self):
        self.store.save("personal", dict(AUTH, origin="login"))
        self.store.save("caller", dict(AUTH, expected_id=8, origin="login"))
        self.store.remove("personal")
        self.assertFalse(self.store.path("personal").exists())
        self.assertTrue(self.store.path("caller").exists())
        with self.assertRaisesRegex(ClientError, "SESSION_MISSING"):
            self.store.remove("personal")

    def test_import_session_saves_an_import_origin_copy_for_the_chosen_role(self):
        import sqlite3
        from unittest.mock import patch
        from telegram_client.runtime import import_session

        source = Path(self.temp.name) / "voice_caller.session"
        sqlite3.connect(source).close()
        config = Path(self.temp.name) / "calendar.env"
        config.write_text("MTPROTO_API_ID=11\nMTPROTO_API_HASH=h\nMTPROTO_SERVICE_USER_ID=7\n")
        with patch("telegram_client.runtime.client_class", return_value=FakeCopyClient):
            result = run(import_session(self.store, "personal", source, config))
        self.assertEqual(result, {"imported": True, "online_verified": False, "role": "personal", "user_id": 7})
        saved = self.store.load("personal")
        self.assertEqual((saved["origin"], saved["session"]), ("import", "copied-session"))
        self.assertFalse(self.store.path("caller").exists())

    def test_import_origin_needs_idle_confirmation_before_any_client(self):
        from unittest.mock import patch
        from telegram_client.runtime import connected

        self.store.save("caller", dict(AUTH, origin="import"))

        async def attempt():
            with patch(
                "telegram_client.runtime.client_class",
                side_effect=AssertionError("no client may be built"),
            ):
                async with connected(self.store, "caller"):
                    self.fail("must refuse")

        with self.assertRaisesRegex(ClientError, "SOURCE_SESSION_OWNERSHIP_NOT_CONFIRMED"):
            run(attempt())


class LoginTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = AuthStore(Path(self.temp.name) / "mtproto")
        FakeLoginClient.instances = []

    def tearDown(self):
        self.temp.cleanup()

    def login(self, role="personal", prompt=None, env=None, qr=False, expected=None, client=None):
        from telegram_client.account import login

        async def no_scan():
            return None

        return run(
            login(
                self.store,
                role,
                expected=expected,
                qr=qr,
                env=env if env is not None else {"TG_API_ID": "11", "TG_API_HASH": "h"},
                prompt=prompt or prompts("+381600000000", "12345"),
                isatty=lambda: True,
                client_class=lambda: client or FakeLoginClient,
                wait_scan=lambda app: no_scan(),
            )
        )

    def test_phone_login_saves_private_login_session_for_the_signed_in_account(self):
        prompt = prompts("+381600000000", "12345")
        result = self.login(prompt=prompt)
        self.assertEqual(result["user_id"], 7)
        saved = self.store.load("personal")
        self.assertEqual(saved["expected_id"], 7)
        self.assertEqual(saved["session"], "exported-session")
        self.assertEqual(saved["origin"], "login")
        self.assertEqual(self.store.path("personal").stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.store.root.stat().st_mode & 0o777, 0o700)
        self.assertNotIn("exported-session", json.dumps(result))
        app = FakeLoginClient.instances[0]
        self.assertEqual(
            app.calls[:2],
            [("send_code", "+381600000000"), ("sign_in", "+381600000000", "hash-1", "12345")],
        )
        self.assertTrue(app.kwargs["in_memory"])
        self.assertFalse(app.is_connected)

    def test_two_factor_password_is_asked_only_when_telegram_requires_it(self):
        class TwoFactor(FakeLoginClient):
            def __init__(self, name, **kw):
                super().__init__(name, **kw)
                self.password_needed = True

        prompt = prompts("+381600000000", "12345", "pw")
        self.login(prompt=prompt, client=TwoFactor)
        self.assertIn(("check_password", "pw"), FakeLoginClient.instances[0].calls)
        self.assertEqual(len(prompt.asked), 3)

    def test_expected_id_mismatch_logs_the_new_authorization_out_and_saves_nothing(self):
        with self.assertRaisesRegex(ClientError, "ACCOUNT_IDENTITY_MISMATCH"):
            self.login(expected=99)
        self.assertIn(("log_out",), FakeLoginClient.instances[0].calls)
        self.assertFalse(self.store.path("personal").exists())

    def test_bot_account_is_refused(self):
        class Bot(FakeLoginClient):
            def __init__(self, name, **kw):
                super().__init__(name, **kw)
                self.user = SimpleNamespace(id=7, is_bot=True, username="b", first_name="B")

        with self.assertRaisesRegex(ClientError, "ACCOUNT_IDENTITY_MISMATCH"):
            self.login(client=Bot)
        self.assertFalse(self.store.path("personal").exists())

    def test_caller_must_be_a_different_account_from_personal(self):
        self.store.save("personal", dict(AUTH, origin="login"))
        with self.assertRaisesRegex(ClientError, "ACCOUNTS_MUST_DIFFER"):
            self.login(role="caller")
        self.assertFalse(self.store.path("caller").exists())

    def test_existing_session_is_never_overwritten_and_no_prompt_runs(self):
        self.store.save("personal", dict(AUTH, origin="login"))
        prompt = prompts()
        with self.assertRaisesRegex(ClientError, "SESSION_ALREADY_EXISTS"):
            self.login(prompt=prompt)
        self.assertEqual(prompt.asked, [])
        self.assertEqual(FakeLoginClient.instances, [])

    def test_no_terminal_refuses_before_prompting(self):
        from telegram_client.account import login

        with self.assertRaisesRegex(ClientError, "LOGIN_REQUIRES_PRIVATE_TERMINAL"):
            run(
                login(
                    self.store,
                    "personal",
                    env={},
                    prompt=prompts(),
                    isatty=lambda: False,
                    client_class=lambda: FakeLoginClient,
                )
            )

    def test_api_credentials_env_then_other_role_then_prompt(self):
        from telegram_client.account import api_credentials

        self.assertEqual(
            api_credentials(self.store, "personal", {"TG_API_ID": "5", "TG_API_HASH": "e"}, prompts()),
            (5, "e"),
        )
        self.store.save("caller", dict(AUTH, origin="import"))
        self.assertEqual(api_credentials(self.store, "personal", {}, prompts()), (11, "fixture-hash"))
        self.store.remove("caller")
        prompt = prompts("12", "typed-hash")
        self.assertEqual(api_credentials(self.store, "personal", {}, prompt), (12, "typed-hash"))
        with self.assertRaisesRegex(ClientError, "API_ID_INVALID"):
            api_credentials(self.store, "personal", {}, prompts("abc", "h"))

    def test_qr_login_waits_for_scan_then_asks_2fa_and_saves(self):
        class Qr(FakeLoginClient):
            def __init__(self, name, **kw):
                super().__init__(name, **kw)
                self.qr_tokens = 2
                self.password_needed = True

        prompt = prompts("pw")
        result = self.login(qr=True, prompt=prompt, client=Qr)
        app = FakeLoginClient.instances[0]
        self.assertEqual([c for c in app.calls if c[0] == "sign_in_qrcode"], [("sign_in_qrcode",)] * 3)
        self.assertIn(("check_password", "pw"), app.calls)
        self.assertFalse(app.kwargs["no_updates"], "QR login needs updates for UpdateLoginToken")
        self.assertEqual(result["user_id"], 7)
        self.assertEqual(self.store.load("personal")["origin"], "login")

    def test_a_failed_save_logs_the_new_authorization_out(self):
        from unittest.mock import patch

        with patch.object(AuthStore, "save", side_effect=ClientError("INSECURE_STORE_DIRECTORY")):
            with self.assertRaisesRegex(ClientError, "INSECURE_STORE_DIRECTORY"):
                self.login()
        self.assertIn(("log_out",), FakeLoginClient.instances[0].calls)

    def test_qr_login_still_completes_when_pyrofork_lacks_the_private_wait_helper(self):
        from telegram_client.account import qr_sign_in, wait_for_login_token

        class Qr(FakeLoginClient):
            """An already-expired token: the 1-second minimum wait, then the re-poll succeeds."""

            async def sign_in_qrcode(self):
                self.calls.append(("sign_in_qrcode",))
                if len(self.calls) == 1:
                    return SimpleNamespace(token="t", expires=0)
                return self.user

        app = Qr("x")
        self.assertFalse(hasattr(app, "_wait_for_update_login_token"))
        clock = iter(range(0, 10_000, 10))
        user = run(qr_sign_in(app, prompts(), lambda: wait_for_login_token(app), now=lambda: next(clock)))
        self.assertEqual(user.id, 7)
        self.assertEqual(len(app.calls), 2)

    def test_qr_login_gives_up_at_the_deadline(self):
        from telegram_client.account import qr_sign_in

        class Forever(FakeLoginClient):
            async def sign_in_qrcode(self):
                return SimpleNamespace(token="t", expires=0)

        clock = iter(range(0, 10_000, 100))

        async def scan_never():
            await asyncio.sleep(0)

        with self.assertRaisesRegex(ClientError, "QR_LOGIN_TIMEOUT"):
            run(qr_sign_in(Forever("x"), prompts(), scan_never, now=lambda: next(clock), deadline=300))


class PeerTests(unittest.TestCase):
    def test_parse_peer(self):
        from telegram_client.account import parse_peer

        self.assertEqual(parse_peer("me"), "me")
        self.assertEqual(parse_peer("@Some_User"), "Some_User")
        self.assertEqual(parse_peer("some_user5"), "some_user5")
        self.assertEqual(parse_peer("123456"), 123456)
        for bad in ["", "@", "1.5", "-5", "a b", "@ab"]:
            with self.assertRaisesRegex(ClientError, "PEER_INVALID"):
                parse_peer(bad)

    def make_app(self, users, dialogs=()):
        class App:
            me = SimpleNamespace(id=50)
            warmed = False

            async def get_users(self, peer):
                if peer in users and (peer != 404 or App.warmed):
                    return users[peer]
                raise PeerIdInvalid()

            async def get_dialogs(self, limit):
                App.warmed = True
                for d in dialogs:
                    yield d

        return App()

    def test_resolve_call_peer(self):
        from telegram_client.account import resolve_call_peer

        with tempfile.TemporaryDirectory() as directory:
            store = AuthStore(Path(directory) / "mtproto")
            store.save("personal", dict(AUTH, origin="login"))
            app = self.make_app(
                {
                    "alice": SimpleNamespace(id=9, is_bot=False),
                    "robot": SimpleNamespace(id=10, is_bot=True),
                    7: SimpleNamespace(id=7, is_bot=False),
                    404: SimpleNamespace(id=404, is_bot=False),
                    50: SimpleNamespace(id=50, is_bot=False),
                }
            )
            self.assertEqual(run(resolve_call_peer(app, "caller", "@alice", store)), 9)
            self.assertEqual(run(resolve_call_peer(app, "caller", "me", store)), 7)
            self.assertEqual(run(resolve_call_peer(app, "caller", "404", store)), 404)
            for role, peer, code in [
                ("personal", "me", "CALL_RECIPIENT_IS_CALLER"),
                ("caller", "@robot", "PEER_IS_BOT"),
                ("caller", "50", "CALL_RECIPIENT_IS_CALLER"),
                ("caller", "@nobody", "PEER_NOT_FOUND"),
            ]:
                with self.assertRaisesRegex(ClientError, code):
                    run(resolve_call_peer(app, role, peer, store))

    def test_a_stray_key_error_is_not_reported_as_peer_not_found(self):
        from telegram_client.account import with_peer_warmup

        async def broken():
            raise KeyError("unrelated bug")

        with self.assertRaises(KeyError):
            run(with_peer_warmup(SimpleNamespace(), broken))

    def test_send_text_validates_and_returns_ids_only(self):
        from telegram_client.account import send_text

        sent = []

        class App:
            async def send_message(self, chat, text):
                sent.append((chat, text))
                return SimpleNamespace(id=31, chat=SimpleNamespace(id=-100))

        self.assertEqual(
            run(send_text(App(), "me", "hi")), {"sent": True, "chat_id": -100, "message_id": 31}
        )
        self.assertEqual(sent, [("me", "hi")])
        with self.assertRaisesRegex(ClientError, "TEXT_EMPTY"):
            run(send_text(App(), "me", " \n"))
        with self.assertRaisesRegex(ClientError, "TEXT_TOO_LONG"):
            run(send_text(App(), "me", "x" * 4097))


class TtsTests(unittest.TestCase):
    def test_engine_choice_and_argv_never_carry_the_text(self):
        from telegram_client.tts import tts_argv, tts_engine

        def which(found):
            return lambda name: f"/bin/{name}" if name in found else None

        self.assertEqual(tts_engine(which({"say", "espeak-ng"}), "Darwin"), "say")
        self.assertEqual(tts_engine(which({"espeak-ng"}), "Linux"), "espeak-ng")
        self.assertEqual(tts_engine(which({"say"}), "Linux"), None)
        self.assertIsNone(tts_engine(which(set()), "Darwin"))
        say = tts_argv("say", "Тони написал в Telegram", Path("/t/in.txt"), Path("/t/out"))
        self.assertEqual(say[0], "say")
        self.assertIn("Milena", say)
        self.assertNotIn("Тони написал в Telegram", say)
        espeak = tts_argv("espeak-ng", "hello", Path("/t/in.txt"), Path("/t/out"))
        self.assertEqual(espeak[:3], ["espeak-ng", "-v", "en"])
        self.assertNotIn("hello", espeak)

    def test_synthesize_writes_text_privately_and_reports_failures(self):
        from telegram_client.tts import synthesize

        with tempfile.TemporaryDirectory() as directory:
            seen = {}

            def ok(argv, **kw):
                seen["text"] = Path(argv[argv.index("-f") + 1]).read_text()
                seen["mode"] = Path(argv[argv.index("-f") + 1]).stat().st_mode & 0o777
                Path(argv[-1]).write_bytes(b"RIFF")
                return SimpleNamespace(returncode=0)

            out = synthesize("привет", Path(directory), run=ok, which=lambda n: n, system="Linux")
            self.assertTrue(out.is_file())
            self.assertEqual(seen, {"text": "привет", "mode": 0o600})
            with self.assertRaisesRegex(ClientError, "TTS_FAILED"):
                synthesize("x", Path(directory) / "b", run=lambda a, **k: SimpleNamespace(returncode=1), which=lambda n: n, system="Linux")
            with self.assertRaisesRegex(ClientError, "TTS_UNAVAILABLE"):
                synthesize("x", Path(directory) / "c", run=ok, which=lambda n: None, system="Linux")
            with self.assertRaisesRegex(ClientError, "TEXT_TOO_LONG"):
                synthesize("x" * 1001, Path(directory) / "d", run=ok, which=lambda n: n, system="Linux")


class EntryTests(unittest.TestCase):
    """`python -m telegram_client <role> …` — the exact argv the Bun `tg` spawns."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "mtproto"
        self.store = AuthStore(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def test_status_reports_origin_and_never_secrets(self):
        self.store.save("personal", dict(AUTH, origin="login"))
        result = sidecar("personal", "--store", str(self.root), "status")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        status = json.loads(result.stdout.splitlines()[-1])
        self.assertEqual((status["configured"], status["expected_id"], status["origin"]), (True, 7, "login"))
        self.assertNotIn("fixture", result.stdout + result.stderr)

    def test_missing_session_is_exit_3_with_a_code(self):
        result = sidecar("personal", "--store", str(self.root), "send", "--peer", "me", stdin="hi")
        self.assertEqual(result.returncode, 3)
        self.assertEqual(json.loads(result.stdout)["error"], "SESSION_MISSING")

    def test_logout_removes_the_local_session(self):
        self.store.save("caller", dict(AUTH, origin="login"))
        result = sidecar("caller", "--store", str(self.root), "logout")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertFalse(self.store.path("caller").exists())

    def test_default_store_follows_tg_ctl_config_dir(self):
        self.store.save("personal", dict(AUTH, origin="login"))
        result = sidecar("personal", "status", env={"TG_CTL_CONFIG_DIR": str(self.root.parent)})
        self.assertEqual(json.loads(result.stdout.splitlines()[-1])["configured"], True)

    def test_send_dry_run_reports_the_same_session_gates_as_a_real_send(self):
        self.store.save("personal", dict(AUTH, origin="import"))
        result = sidecar("personal", "--store", str(self.root), "send", "--peer", "me", "--dry-run", stdin="hi")
        plan = json.loads(result.stdout.splitlines()[-1])
        self.assertEqual(result.returncode, 3)
        self.assertFalse(plan["ready"])
        self.assertIn("source_session_idle_confirmed", plan["missing"])

    def test_call_dry_run_is_offline_and_lists_what_is_missing(self):
        self.store.save("caller", dict(AUTH, expected_id=8, origin="import"))
        self.store.save("personal", dict(AUTH, origin="login"))
        result = sidecar(
            "caller", "--store", str(self.root), "call", "--peer", "me", "--audio",
            str(Path(self.temp.name) / "missing.ogg"), "--dry-run",
        )
        plan = json.loads(result.stdout.splitlines()[-1])
        self.assertTrue(plan["dry_run"])
        self.assertEqual(plan["recipient_id"], 7)
        self.assertFalse(plan["ready"])
        self.assertIn("audio_file", plan["missing"])
        self.assertIn("source_session_idle_confirmed", plan["missing"])
        self.assertEqual(result.returncode, 3)
        self.assertNotIn("fixture", result.stdout + result.stderr)

    def test_tg_equals_form_carries_dash_leading_values_through_argparse(self):
        # tg hands values as ONE `--flag=value` token (independent-telegram-clients.md §1), so a
        # dash-leading --say text or a negative peer id is a value, never an option.
        self.store.save("caller", dict(AUTH, expected_id=8, origin="login"))
        self.store.save("personal", dict(AUTH, origin="login"))
        result = sidecar("caller", f"--store={self.root}", "call", "--peer=me", "--say=-5 °C", "--dry-run")
        self.assertNotEqual(result.returncode, 2, result.stderr)
        plan = json.loads(result.stdout.splitlines()[-1])
        self.assertTrue(plan["dry_run"])
        self.assertEqual(plan["media"], "say")
        sent = sidecar("personal", f"--store={self.root}", "send", "--peer=-100123", "--dry-run", stdin="hi")
        self.assertNotEqual(sent.returncode, 2, sent.stderr)
        self.assertTrue(json.loads(sent.stdout.splitlines()[-1])["dry_run"])

    def test_generic_failure_reports_class_name_not_message(self):
        from contextlib import redirect_stdout
        import io
        from unittest.mock import patch
        from telegram_client import cli

        async def boom(role, args):
            raise RuntimeError("auth-key-bytes-must-not-leak")

        out = io.StringIO()
        with patch.object(cli, "execute", boom), redirect_stdout(out):
            code = cli.main("personal", ["--store", str(self.root), "status"])
        self.assertEqual(code, 1)
        self.assertEqual(
            json.loads(out.getvalue()),
            {"ok": False, "error": "CLIENT_OPERATION_FAILED", "detail": "RuntimeError"},
        )


@unittest.skipUnless(
    importlib.util.find_spec("pyrogram"), "needs the sidecar runtime (python -m telegram_client)"
)
class InstalledPyroforkContract(unittest.TestCase):
    """The pinned pyrofork still has what account.py calls by name (run with the runtime python)."""

    def test_login_api_surface(self):
        from pyrogram import Client, errors
        from telegram_client.account import PEER_NOT_FOUND_ERRORS

        for name in (
            "send_code", "sign_in", "check_password", "sign_in_qrcode",
            "_wait_for_update_login_token", "export_session_string", "log_out",
        ):
            self.assertTrue(hasattr(Client, name), name)
        for name in ("SessionPasswordNeeded", *PEER_NOT_FOUND_ERRORS):
            self.assertTrue(hasattr(errors, name), name)


if __name__ == "__main__":
    unittest.main()
