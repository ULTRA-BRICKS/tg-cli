"""Small independent commands; status is offline and login is always explicit."""

import argparse
import asyncio
import importlib.util
from datetime import timezone
import json
from pathlib import Path
import time
from .core import AuthStore, ClientError, TriggerStore, check_identity
from .runtime import connected, import_calendar, login, notification_call


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def parser(role):
    p = argparse.ArgumentParser(prog="tg-mtproto" if role == "personal" else "tg-call")
    p.add_argument(
        "--store", type=Path, default=Path.home() / ".local/share/tg-cli/auth"
    )
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
        if role == "caller":
            q.add_argument("--source-session-idle-confirmed", action="store_true")
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
        q = commands.add_parser(
            "import-calendar",
            help="offline consistent snapshot; source stays read-only",
        )
        q.add_argument("--source-session", type=Path, required=True)
        q.add_argument("--source-config", type=Path, required=True)
        q.add_argument(
            "--expected-id",
            type=int,
            help="independently confirmed service account ID; never inferred",
        )
        q = commands.add_parser(
            "notify", help="place an explicitly requested audio call"
        )
        q.add_argument("--recipient", type=int, required=True)
        q.add_argument("--audio", type=Path, required=True)
        q.add_argument(
            "--source-session-idle-confirmed", action="store_true", required=True
        )
    else:
        q = commands.add_parser(
            "login", help="new login only after explicit user authorization"
        )
        q.add_argument("--begin-login", action="store_true", required=True)
        q.add_argument("--expected-id", type=int, required=True)
        q.add_argument(
            "--reuse-caller-api",
            action="store_true",
            help="reuse app ID/hash only; create separate personal authorization",
        )
        q = commands.add_parser(
            "dialogs", help="bounded dialog/unread inventory; no mark-read call"
        )
        q.add_argument("--limit", type=int, default=30)
        q = commands.add_parser("history", help="bounded history; no mark-read call")
        q.add_argument("--peer", type=int, required=True)
        q.add_argument("--limit", type=int, default=30)
        q.add_argument("--before-id", type=int, default=0)
        q = commands.add_parser(
            "arm", help="record current message watermark for a confirmed contact"
        )
        q.add_argument("--peer", type=int, required=True)
        q.add_argument("--trigger", type=Path, required=True)
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
        q.add_argument(
            "--source-session-idle-confirmed", action="store_true", required=True
        )
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
    # Verify the recipient is the personal owner before subscribing or claiming.
    async with connected(store, "caller") as caller:
        if caller.me.id == owner:
            raise ClientError("CALL_RECIPIENT_IS_CALLER")
    async with connected(store, "personal", updates=True) as app:
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
                await notification_call(store, owner, args.audio)
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
        try:
            auth = store.load(role)
            result = {
                "role": role,
                "configured": True,
                "expected_id": auth["expected_id"],
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
            for name in (
                ("pyrogram",)
                if role == "personal"
                else ("pyrogram", "pytgcalls", "ntgcalls")
            )
        }
        if role == "caller":
            from .providers import media_readiness

            result["media"] = media_readiness(
                Path.home() / ".local/share/tg-cli/ntgcalls-runtime-receipt.json"
            )
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
            if role == "caller" and not args.source_session_idle_confirmed:
                raise ClientError("SOURCE_SESSION_OWNERSHIP_NOT_CONFIRMED")
            async with connected(store, role) as app:
                result.update(
                    online_verified=True, user_id=app.me.id, username=app.me.username
                )
        emit(result)
        ready = result["configured"] and (
            not args.providers_config or result["provider_readiness"]["configured"]
        )
        return 0 if ready else 3
    if command == "import-calendar":
        emit(
            await import_calendar(
                store, args.source_session, args.source_config, args.expected_id
            )
        )
    elif command == "login":
        await login(store, args.expected_id, args.reuse_caller_api)
        emit({"configured": True, "role": "personal"})
    elif command == "notify":
        await notification_call(store, args.recipient, args.audio)
        emit({"state": "completed"})
    elif command == "watch-call":
        await watch(store, args)
    else:
        if hasattr(args, "limit") and not 1 <= args.limit <= 100:
            raise ClientError("LIMIT_MUST_BE_1_TO_100")
        async with connected(store, "personal") as app:
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


def main(role):
    args = parser(role).parse_args()
    # These commands must never expose underlying library exceptions (which may contain auth).
    try:
        return asyncio.run(execute(role, args))
    except ClientError as error:
        emit({"ok": False, "error": str(error)})
        return 3
    except KeyboardInterrupt:
        emit({"ok": False, "error": "INTERRUPTED"})
        return 130
    except Exception:
        emit({"ok": False, "error": "CLIENT_OPERATION_FAILED"})
        return 1


def caller_main():
    return main("caller")


def personal_main():
    return main("personal")
