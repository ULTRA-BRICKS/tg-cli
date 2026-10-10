"""Sidecar commands; status is offline and login is always explicit.

Entry points: `python -m telegram_client personal|caller …` (what `tg` spawns) and the
`tg-mtproto` (personal) / `tg-call` (caller) scripts. Stdout is JSON lines only.
"""

import argparse
import asyncio
import importlib.util
from datetime import timezone
import json
from pathlib import Path
import shutil
import sys
import tempfile
import time
from .core import AuthStore, ClientError, TriggerStore, auth_origin, check_identity
from .paths import default_store, receipt_path
from .runtime import connected, import_session, place_call

CALL_LIBRARIES = ("pyrogram", "pytgcalls", "ntgcalls")


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def add_call_parser(commands):
    q = commands.add_parser(
        "call", help="ring a user once and play audio (or --say text); --dry-run is offline"
    )
    q.add_argument("--peer", required=True, help="@username, numeric user id, or me")
    media = q.add_mutually_exclusive_group(required=True)
    media.add_argument("--audio", type=Path)
    media.add_argument("--say")
    q.add_argument("--timeout", type=int, default=60, help="ring and playback bound, seconds")
    q.add_argument("--dry-run", action="store_true")
    q.add_argument("--source-session-idle-confirmed", action="store_true")


def parser(role):
    p = argparse.ArgumentParser(prog="tg-mtproto" if role == "personal" else "tg-call")
    p.add_argument("--store", type=Path, default=default_store())
    commands = p.add_subparsers(dest="command", required=True)
    for name in ("doctor", "status"):
        q = commands.add_parser(
            name, help="offline metadata only; never log in or ring"
        )
        q.add_argument(
            "--providers-config",
            type=Path,
            help="offline provider readiness, no secret values",
        )
        q.add_argument(
            "--online", action="store_true", help="verify get_me without login"
        )
        q.add_argument("--source-session-idle-confirmed", action="store_true")
    q = commands.add_parser(
        "login", help="new interactive login (phone+code+2FA, or --qr); never overwrites"
    )
    q.add_argument("--qr", action="store_true")
    q.add_argument("--expected-id", type=int, help="refuse any other account")
    q = commands.add_parser(
        "import-session",
        help="offline copy of an existing pyrogram SQLite session; source stays read-only",
    )
    q.add_argument("--source-session", type=Path, required=True)
    q.add_argument("--source-config", type=Path, required=True)
    q.add_argument(
        "--expected-id",
        type=int,
        help="independently confirmed account ID; never inferred",
    )
    commands.add_parser("logout", help="delete the local session file only")
    add_call_parser(commands)
    if role == "caller":
        commands.add_parser(
            "library-info", help="shared package version and module path; offline"
        )
        q = commands.add_parser(
            "start", help="explicit conversational call; fails closed before connection"
        )
        q.add_argument("--providers-config", type=Path, required=True)
        q.add_argument("--confirm-call", action="store_true")
        q.add_argument("--allow-provider-network", action="store_true")
        q.add_argument("--source-session-idle-confirmed", action="store_true")
        q.add_argument("--maximum-seconds", type=int, default=1800)
        commands.add_parser(
            "live-smoke",
            help="offline duplex integration with fake audio; no call or provider network",
        )
    else:
        q = commands.add_parser("send", help="send stdin text as the user")
        q.add_argument("--peer", required=True, help="@username, numeric id, or me (Saved Messages)")
        q.add_argument("--dry-run", action="store_true")
        q.add_argument("--source-session-idle-confirmed", action="store_true")
        q = commands.add_parser(
            "dialogs", help="bounded dialog/unread inventory; no mark-read call"
        )
        q.add_argument("--limit", type=int, default=30)
        q.add_argument("--source-session-idle-confirmed", action="store_true")
        q = commands.add_parser("history", help="bounded history; no mark-read call")
        q.add_argument("--peer", type=int, required=True)
        q.add_argument("--limit", type=int, default=30)
        q.add_argument("--before-id", type=int, default=0)
        q.add_argument("--source-session-idle-confirmed", action="store_true")
        q = commands.add_parser(
            "arm", help="record current message watermark for a confirmed contact"
        )
        q.add_argument("--peer", type=int, required=True)
        q.add_argument("--trigger", type=Path, required=True)
        q.add_argument("--source-session-idle-confirmed", action="store_true")
        q = commands.add_parser(
            "watch-call",
            help="real incoming updates; one call attempt, no history replay",
        )
        q.add_argument("--trigger", type=Path, required=True)
        q.add_argument(
            "--audio",
            type=Path,
            required=True,
            help="prepared notification speech file",
        )
        q.add_argument("--source-session-idle-confirmed", action="store_true")
    return p


async def watch(store, args):
    from pyrogram.handlers import MessageHandler
    from pyrogram import filters

    trigger = TriggerStore(args.trigger)
    if trigger.status() != "armed":
        raise ClientError("TRIGGER_NOT_ARMED")
    owner, peer = trigger.config()
    if not args.audio.is_file():
        raise ClientError("AUDIO_FILE_MISSING")
    idle = args.source_session_idle_confirmed
    # Verify the recipient is the personal owner before subscribing or claiming.
    async with connected(store, "caller", source_idle_confirmed=idle) as caller:
        if caller.me.id == owner:
            raise ClientError("CALL_RECIPIENT_IS_CALLER")
    async with connected(
        store, "personal", updates=True, source_idle_confirmed=idle
    ) as app:
        check_identity(owner, app.me.id, app.me.is_bot)
        finished = asyncio.Event()

        async def incoming(_, message):
            if not message.from_user or message.from_user.id != peer:
                return
            timestamp = message.date.replace(tzinfo=timezone.utc).timestamp()
            if not trigger.claim(
                owner, message.chat.id, message.id, timestamp, bool(message.outgoing)
            ):
                return
            success = False
            try:
                await place_call(
                    store, "caller", str(owner), args.audio, source_idle_confirmed=idle
                )
                success = True
            except Exception:
                emit({"event": "call_uncertain", "automatic_retry": False})
            finally:
                trigger.finish(success)
                finished.set()

        app.add_handler(
            MessageHandler(
                incoming, filters.private & filters.incoming & filters.user(peer)
            )
        )
        await app.initialize()
        emit(
            {
                "watching": True,
                "owner_id": owner,
                "peer_id": peer,
                "historical_messages": False,
            }
        )
        await finished.wait()
        emit({"state": trigger.status()})


async def conversational_start(
    store, config, consent, backend=None, maximum_seconds=1800
):
    from . import call_lib

    return await call_lib.start_conversation(
        store, config, consent, backend, maximum_seconds
    )


def session_preflight(store, role, idle_confirmed):
    """(auth or None, missing) — the session part every dry run reports the same way."""
    try:
        auth = store.load(role)
    except ClientError as error:
        if str(error) != "SESSION_MISSING":
            raise
        return None, ["session"]
    if auth_origin(auth) == "import" and not idle_confirmed:
        return auth, ["source_session_idle_confirmed"]
    return auth, []


def call_plan(store, role, args, which=shutil.which, find_spec=importlib.util.find_spec):
    """Offline `call --dry-run`: everything a real call needs, without connecting."""
    from .account import parse_peer
    from .tts import TEXT_LIMIT, tts_engine

    target = parse_peer(args.peer)
    if target == "me" and role != "caller":
        raise ClientError("CALL_RECIPIENT_IS_CALLER")
    _, missing = session_preflight(store, role, args.source_session_idle_confirmed)
    recipient = target if isinstance(target, int) else None
    if target == "me":
        try:
            recipient = store.load("personal")["expected_id"]
        except ClientError:
            missing.append("personal_session")
    engine = None
    if args.audio is not None:
        if not args.audio.is_file():
            missing.append("audio_file")
    else:
        if not args.say.strip():
            raise ClientError("TEXT_EMPTY")
        if len(args.say) > TEXT_LIMIT:
            raise ClientError("TEXT_TOO_LONG")
        engine = tts_engine(which)
        if engine is None:
            missing.append("tts")
    if not which("ffmpeg"):
        missing.append("ffmpeg")
    if not all(find_spec(name) is not None for name in CALL_LIBRARIES):
        missing.append("call_libraries")
    return {
        "dry_run": True,
        "role": role,
        "peer": args.peer,
        "recipient_id": recipient,
        "media": "audio" if args.audio is not None else "say",
        "tts_engine": engine,
        "missing": missing,
        "ready": not missing,
    }


async def call(store, role, args):
    from .account import parse_peer
    from .tts import synthesize

    if not 1 <= args.timeout <= 600:
        raise ClientError("TIMEOUT_MUST_BE_1_TO_600")
    if args.dry_run:
        plan = call_plan(store, role, args)
        emit(plan)
        return 0 if plan["ready"] else 3
    parse_peer(args.peer)
    options = dict(timeout=args.timeout, source_idle_confirmed=args.source_session_idle_confirmed)
    if args.audio is not None:
        await place_call(store, role, args.peer, args.audio, **options)
    else:
        with tempfile.TemporaryDirectory(prefix="tg-say-") as directory:
            audio = synthesize(args.say, Path(directory) / "tts")
            await place_call(store, role, args.peer, audio, **options)
    emit({"state": "completed", "role": role, "peer": args.peer})
    return 0


async def send(store, args):
    from .account import parse_peer, send_text, validate_text

    text = sys.stdin.read()
    if args.dry_run:
        validate_text(text)
        parse_peer(args.peer, allow_chats=True)
        auth, missing = session_preflight(
            store, "personal", args.source_session_idle_confirmed
        )
        if importlib.util.find_spec("pyrogram") is None:
            missing.append("client_library")
        emit(
            {
                "dry_run": True,
                "peer": args.peer,
                "characters": len(text),
                "user_id": auth["expected_id"] if auth else None,
                "missing": missing,
                "ready": not missing,
            }
        )
        return 0 if not missing else 3
    async with connected(
        store, "personal", source_idle_confirmed=args.source_session_idle_confirmed
    ) as app:
        emit(await send_text(app, args.peer, text))
    return 0


async def status(store, role, args):
    try:
        auth = store.load(role)
        result = {
            "role": role,
            "configured": True,
            "expected_id": auth["expected_id"],
            "origin": auth_origin(auth),
            "online_verified": False,
        }
    except ClientError as error:
        result = {
            "role": role,
            "configured": False,
            "reason": str(error),
            "online_verified": False,
        }
    result["dependencies"] = {
        name: importlib.util.find_spec(name) is not None
        for name in CALL_LIBRARIES  # both roles can place calls
    }
    if role == "caller":
        from .providers import media_readiness

        result["media"] = media_readiness(receipt_path())
        result["conversation"] = {
            "native_adapter": True,
            "live_transport_verified": False,
            "providers_configured": False,
            "bracho": "unresolved",
            "smoke_command": "tg-call live-smoke",
            "ready": False,
        }
    if args.providers_config:
        from .providers import readiness

        result["provider_readiness"] = readiness(
            json.loads(args.providers_config.read_text())
        )
        if role == "caller":
            result["conversation"]["providers_configured"] = result[
                "provider_readiness"
            ]["configured"]
            result["conversation"]["bracho"] = (
                "configured"
                if result["provider_readiness"]["voice_ready"]
                else "unresolved"
            )
    if args.online:
        async with connected(
            store, role, source_idle_confirmed=args.source_session_idle_confirmed
        ) as app:
            result.update(
                online_verified=True, user_id=app.me.id, username=app.me.username
            )
    emit(result)
    ready = result["configured"] and (
        not args.providers_config or result["provider_readiness"]["configured"]
    )
    return 0 if ready else 3


async def personal_reads(store, args):
    command = args.command
    if hasattr(args, "limit") and not 1 <= args.limit <= 100:
        raise ClientError("LIMIT_MUST_BE_1_TO_100")
    async with connected(
        store, "personal", source_idle_confirmed=args.source_session_idle_confirmed
    ) as app:
        if command == "dialogs":
            async for dialog in app.get_dialogs(limit=args.limit):
                chat = dialog.chat
                emit(
                    {
                        "chat_id": chat.id,
                        "name": chat.title or chat.first_name,
                        "username": chat.username,
                        "unread_count": dialog.unread_messages_count,
                    }
                )
        elif command == "history":
            async for m in app.get_chat_history(
                args.peer, limit=args.limit, offset_id=args.before_id
            ):
                emit(
                    {
                        "id": m.id,
                        "chat_id": m.chat.id,
                        "from_id": m.from_user.id if m.from_user else None,
                        "date": m.date.isoformat(),
                        "outgoing": bool(m.outgoing),
                        "text": m.text or m.caption,
                        "reply_to_message_id": m.reply_to_message_id,
                        "link": m.link,
                    }
                )
        elif command == "arm":
            check_identity(args.peer, args.peer)
            after = 0
            async for m in app.get_chat_history(args.peer, limit=1):
                after = m.id
            TriggerStore(args.trigger).arm(app.me.id, args.peer, after, time.time())
            emit(
                {
                    "state": "armed",
                    "owner_id": app.me.id,
                    "peer_id": args.peer,
                    "after_id": after,
                }
            )
    return 0


async def execute(role, args):
    store = AuthStore(args.store)
    command = args.command
    if command == "library-info":
        from .call_lib import identity

        emit(identity())
        return 0
    if command == "start":
        from .call_lib import Consent

        config = json.loads(args.providers_config.read_text())
        emit(
            await conversational_start(
                store,
                config,
                Consent(
                    args.confirm_call,
                    args.allow_provider_network,
                    args.source_session_idle_confirmed,
                ),
                maximum_seconds=args.maximum_seconds,
            )
        )
        return 0
    if command == "live-smoke":
        from .smoke import smoke

        emit(await smoke())
        return 0
    if command in ("doctor", "status"):
        return await status(store, role, args)
    if command == "login":
        from .account import login

        emit(await login(store, role, expected=args.expected_id, qr=args.qr))
        return 0
    if command == "import-session":
        emit(
            await import_session(
                store, role, args.source_session, args.source_config, args.expected_id
            )
        )
        return 0
    if command == "logout":
        store.remove(role)
        emit({"logged_out": True, "role": role})
        return 0
    if command == "call":
        return await call(store, role, args)
    if command == "send":
        return await send(store, args)
    if command == "watch-call":
        await watch(store, args)
        return 0
    return await personal_reads(store, args)


def main(role, argv=None):
    args = parser(role).parse_args(argv)
    # These commands must never expose underlying library exceptions (which may contain
    # auth); the class name alone (PeerIdInvalid, FloodWait, …) is safe and diagnosable.
    try:
        return asyncio.run(execute(role, args))
    except ClientError as error:
        emit({"ok": False, "error": str(error)})
        return 3
    except KeyboardInterrupt:
        emit({"ok": False, "error": "INTERRUPTED"})
        return 130
    except Exception as error:
        emit({"ok": False, "error": "CLIENT_OPERATION_FAILED", "detail": type(error).__name__})
        return 1


def caller_main():
    return main("caller")


def personal_main():
    return main("personal")
