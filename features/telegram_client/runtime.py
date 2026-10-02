"""Lazy MTProto/call adapters; authentication never starts during reads or doctor."""

import asyncio
from contextlib import asynccontextmanager, contextmanager, closing
import fcntl
import logging
import os
from pathlib import Path
import sqlite3
import tempfile
import time
from .core import ClientError, check_identity, private_directory


@contextmanager
def role_lock(store, role):
    private_directory(store.root)
    fd = os.open(
        store.root / (role + ".lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600
    )
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ClientError("CLIENT_ALREADY_RUNNING") from None
        yield
    finally:
        os.close(fd)


def client_class():
    logging.getLogger("pyrogram").disabled = True
    try:
        from pyrogram import Client

        return Client
    except ImportError:
        raise ClientError("PYROFORK_NOT_INSTALLED") from None


@asynccontextmanager
async def connected(store, role, updates=False):
    auth = store.load(role)
    with role_lock(store, role):
        app = client_class()(
            role,
            api_id=auth["api_id"],
            api_hash=auth["api_hash"],
            session_string=auth["session"],
            in_memory=True,
            no_updates=not updates,
        )
        try:
            if not await asyncio.wait_for(app.connect(), 20):
                raise ClientError("SESSION_UNAUTHORIZED")
            me = await asyncio.wait_for(app.get_me(), 20)
            check_identity(auth["expected_id"], me.id, me.is_bot)
            app.me = me
            yield app
        finally:
            if app.is_initialized:
                await app.terminate()
            if app.is_connected:
                await app.disconnect()


def sqlite_snapshot(source, destination):
    """SQLite's backup API includes committed WAL; never open original writable."""
    source = Path(source)
    if not source.is_file() or source.is_symlink():
        raise ClientError("SOURCE_SESSION_MISSING")
    deadline = time.monotonic() + 10

    def progress(status, remaining, total):
        if time.monotonic() > deadline:
            raise ClientError("SOURCE_SESSION_BUSY")

    with closing(
        sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True, timeout=2)
    ) as src:
        fd = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
        with closing(sqlite3.connect(destination)) as dst:
            src.backup(dst, pages=32, progress=progress, sleep=0.05)


def calendar_config(path, expected_id=None):
    """Read only selected existing settings in-process; never source shell code."""
    names = {"MTPROTO_API_ID", "MTPROTO_API_HASH", "MTPROTO_SERVICE_USER_ID"}
    values = {}
    for line in Path(path).read_text().splitlines():
        key, separator, value = line.strip().partition("=")
        if separator and key in names:
            values[key] = value.strip().strip("\"'")
    try:
        api_id = int(values.get("MTPROTO_API_ID", "0"))
        configured = int(values.get("MTPROTO_SERVICE_USER_ID", "0"))
        if expected_id is not None and configured and expected_id != configured:
            raise ClientError("ACCOUNT_IDENTITY_MISMATCH")
        expected = expected_id if expected_id is not None else configured
        api_hash = values.get("MTPROTO_API_HASH", "")
        if api_id <= 0 or expected <= 0 or not api_hash:
            raise ValueError()
        return api_id, api_hash, expected
    except ValueError:
        raise ClientError("SERVICE_IDENTITY_OR_API_CONFIG_MISSING") from None


async def import_calendar(store, source, config, expected_id=None):
    """Offline import; no call, login, get_me, or source file mutation."""
    api_id, api_hash, expected = calendar_config(config, expected_id)
    if store.path("caller").exists():
        raise ClientError("SESSION_ALREADY_EXISTS")
    private_directory(store.root)
    with role_lock(store, "caller"):
        with tempfile.TemporaryDirectory(
            prefix="migration-", dir=store.root
        ) as directory:
            sqlite_snapshot(source, Path(directory) / "copy.session")
            app = client_class()(
                "copy",
                api_id=api_id,
                api_hash=api_hash,
                workdir=directory,
                no_updates=True,
            )
            try:
                await app.storage.open()
                check_identity(
                    expected, await app.storage.user_id(), await app.storage.is_bot()
                )
                if not await app.storage.auth_key():
                    raise ClientError("SESSION_UNAUTHORIZED")
                session = await app.export_session_string()
                store.save(
                    "caller",
                    dict(
                        expected_id=expected,
                        api_id=api_id,
                        api_hash=api_hash,
                        session=session,
                    ),
                )
            finally:
                if app.storage.conn is not None:
                    await app.storage.close()
    return {"imported": True, "online_verified": False, "role": "caller"}


def login_api(store, reuse_caller_api):
    """Reuse only application credentials, never the caller authorization."""
    import getpass

    if reuse_caller_api:
        caller = store.load("caller")
        return {"api_id": caller["api_id"], "api_hash": caller["api_hash"]}
    return {
        "api_id": int(getpass.getpass("Existing Telegram API ID: ")),
        "api_hash": getpass.getpass("Existing Telegram API hash: "),
    }


async def login(store, expected, reuse_caller_api=False):
    """Explicit user-operated secure prompts; never used as an auth fallback."""
    import getpass
    from pyrogram.errors import SessionPasswordNeeded

    if not os.isatty(0):
        raise ClientError("LOGIN_REQUIRES_PRIVATE_TERMINAL")
    if store.path("personal").exists():
        raise ClientError("SESSION_ALREADY_EXISTS")
    check_identity(expected, expected)
    api = login_api(store, reuse_caller_api)
    api_id, api_hash = api["api_id"], api["api_hash"]
    phone = getpass.getpass("Phone: ")
    with role_lock(store, "personal"):
        app = client_class()(
            "personal-login",
            api_id=api_id,
            api_hash=api_hash,
            in_memory=True,
            no_updates=True,
        )
        try:
            await app.connect()
            sent = await app.send_code(phone)
            try:
                await app.sign_in(
                    phone, sent.phone_code_hash, getpass.getpass("Telegram code: ")
                )
            except SessionPasswordNeeded:
                await app.check_password(getpass.getpass("Telegram 2FA password: "))
            me = await app.get_me()
            check_identity(expected, me.id, me.is_bot)
            store.save(
                "personal",
                dict(
                    expected_id=expected,
                    api_id=api_id,
                    api_hash=api_hash,
                    session=await app.export_session_string(),
                ),
            )
        finally:
            if app.is_connected:
                await app.disconnect()


async def notification_call(store, recipient, audio, timeout=60):
    """Success means the outbound audio ended; queueing/ringing is not success."""
    logging.getLogger("pytgcalls").disabled = True
    try:
        from pytgcalls import PyTgCalls
        from pytgcalls.types import MediaStream, StreamEnded, ChatUpdate, Device
        from ntgcalls import NTgCalls
    except ImportError:
        raise ClientError("CALL_DEPENDENCIES_MISSING") from None
    if not Path(audio).is_file():
        raise ClientError("AUDIO_FILE_MISSING")
    check_identity(recipient, recipient)
    NTgCalls.enable_glib_loop(True)
    async with connected(store, "caller", updates=True) as app:
        if recipient == app.me.id:
            raise ClientError("CALL_RECIPIENT_IS_CALLER")
        calls = PyTgCalls(app)
        done = asyncio.Event()
        completed = False

        @calls.on_update()
        async def update(_, event):
            nonlocal completed
            if event.chat_id != recipient:
                return
            if (
                isinstance(event, StreamEnded)
                and event.stream_type == StreamEnded.Type.AUDIO
                and event.device == Device.MICROPHONE
            ):
                completed = True
                done.set()
            elif (
                isinstance(event, ChatUpdate)
                and event.status & ChatUpdate.Status.LEFT_CALL
            ):
                done.set()

        try:
            await app.initialize()
            await calls.start()
            await asyncio.wait_for(
                calls.play(
                    recipient,
                    MediaStream(
                        str(Path(audio).resolve()), video_flags=MediaStream.Flags.IGNORE
                    ),
                ),
                timeout,
            )
            await asyncio.wait_for(done.wait(), timeout)
            if not completed:
                raise ClientError("CALL_INCOMPLETE")
        finally:
            try:
                await asyncio.wait_for(calls.leave_call(recipient), 5)
            except Exception:
                pass
