"""User-account login, peer handling and sending: the `tg auth user` / `tg user send` core.

Telegram I/O goes through an injected pyrofork-shaped client so tests pass fakes. Pyrogram
exceptions are matched by class NAME, so this module imports no Telegram library.
"""

import asyncio
from contextlib import redirect_stdout
import getpass
import os
import re
import sys
import time

from .core import ClientError, check_identity
from .runtime import client_class as default_client_class, role_lock

ROLES = ("personal", "caller")
USERNAME = re.compile(r"[A-Za-z][A-Za-z0-9_]{3,31}")
QR_DEADLINE_SECONDS = 300
TEXT_LIMIT = 4096
# pyrogram's own names for "this account cannot see that peer" (matched by name so this
# module imports no Telegram library). A builtin like KeyError is deliberately absent: it
# would turn an unrelated bug into a confident "peer not found".
PEER_NOT_FOUND_ERRORS = {"PeerIdInvalid", "UsernameNotOccupied", "UsernameInvalid"}


def other_role(role):
    return "caller" if role == "personal" else "personal"


def err(message):
    print(message, file=sys.stderr, flush=True)


def api_credentials(store, role, env, prompt):
    """Env first, then the other role's app registration, then a hidden prompt."""
    env_id, env_hash = env.get("TG_API_ID"), env.get("TG_API_HASH")
    if env_id and env_hash:
        return parse_api_id(env_id), env_hash
    try:
        other = store.load(other_role(role))
        return other["api_id"], other["api_hash"]
    except ClientError as error:
        if str(error) != "SESSION_MISSING":
            raise
    err(
        "Telegram needs an app registration for a user login (one time): open "
        "https://my.telegram.org/apps, create an app, then enter its API ID and hash."
    )
    api_id = parse_api_id(prompt("API ID: "))
    api_hash = prompt("API hash: ").strip()
    if not api_hash:
        raise ClientError("API_HASH_MISSING")
    return api_id, api_hash


def parse_api_id(text):
    try:
        value = int(str(text).strip())
    except ValueError:
        raise ClientError("API_ID_INVALID") from None
    if value <= 0:
        raise ClientError("API_ID_INVALID")
    return value


def parse_peer(text, allow_chats=False):
    """`me`, a username (with or without @) or a numeric id; chats only when allowed."""
    text = str(text).strip()
    if text == "me":
        return "me"
    if re.fullmatch(r"-?[0-9]+", text):
        value = int(text)
        if value > 0 or (allow_chats and value < 0):
            return value
        raise ClientError("PEER_INVALID")
    name = text[1:] if text.startswith("@") else text
    if USERNAME.fullmatch(name):
        return name
    raise ClientError("PEER_INVALID")


def is_password_needed(error):
    return type(error).__name__ == "SessionPasswordNeeded"


async def phone_sign_in(app, prompt):
    phone = prompt("Phone number (international format, e.g. +381…): ").strip()
    sent = await app.send_code(phone)
    code = prompt("Login code Telegram just sent you: ").strip()
    try:
        return await app.sign_in(phone, sent.phone_code_hash, code)
    except Exception as error:
        if not is_password_needed(error):
            raise
    return await app.check_password(prompt("Two-step verification password: "))


async def qr_sign_in(app, prompt, wait_scan, now=time.time, deadline=QR_DEADLINE_SECONDS):
    """pyrofork's sign_in_qrcode draws a QR and returns a token until the scan lands.

    Its drawing goes to stderr: stdout is the JSON channel `tg` reads.
    """
    end = now() + deadline
    while now() < end:
        try:
            with redirect_stdout(sys.stderr):
                result = await app.sign_in_qrcode()
        except Exception as error:
            if not is_password_needed(error):
                raise
            return await app.check_password(prompt("Two-step verification password: "))
        if hasattr(result, "id"):
            return result
        err("Scan it in Telegram → Settings → Devices → Link Desktop Device.")
        wait = max(1, min(result.expires - now(), end - now()))
        try:
            await asyncio.wait_for(wait_scan(), wait)
        except asyncio.TimeoutError:
            pass
    raise ClientError("QR_LOGIN_TIMEOUT")


async def ensure_distinct(store, role, user_id):
    try:
        other = store.load(other_role(role))
    except ClientError as error:
        if str(error) == "SESSION_MISSING":
            return
        raise
    if other["expected_id"] == user_id:
        raise ClientError("ACCOUNTS_MUST_DIFFER")


async def wait_for_login_token(app):
    """Return when Telegram pushes UpdateLoginToken (the scan), via pyrofork's private helper.

    Without it (a pyrofork that renamed it) this never returns and qr_sign_in re-polls at
    each token's expiry instead — slower, still correct.
    """
    wait = getattr(app, "_wait_for_update_login_token", None)
    if wait is None:
        await asyncio.Event().wait()
    else:
        await wait()


async def login(
    store,
    role,
    expected=None,
    qr=False,
    env=os.environ,
    prompt=getpass.getpass,
    isatty=lambda: os.isatty(0),
    client_class=default_client_class,
    wait_scan=wait_for_login_token,
):
    """New authorization for `role`; refuses to replace one, saves only a verified account."""
    if role not in ROLES:
        raise ClientError("INVALID_ROLE")
    if not isatty():
        raise ClientError("LOGIN_REQUIRES_PRIVATE_TERMINAL")
    if store.path(role).exists():  # before any prompt; re-checked under the lock
        raise ClientError("SESSION_ALREADY_EXISTS")
    if expected is not None:
        check_identity(expected, expected)
    api_id, api_hash = api_credentials(store, role, env, prompt)
    with role_lock(store, role):
        if store.path(role).exists():
            raise ClientError("SESSION_ALREADY_EXISTS")
        app = client_class()(
            role + "-login",
            api_id=api_id,
            api_hash=api_hash,
            in_memory=True,
            no_updates=not qr,
        )
        try:
            await app.connect()
            if qr:
                me = await qr_sign_in(app, prompt, lambda: wait_scan(app))
            else:
                me = await phone_sign_in(app, prompt)
            if not hasattr(me, "id"):
                raise ClientError("ACCOUNT_NOT_REGISTERED")
            try:
                check_identity(expected if expected is not None else me.id, me.id, me.is_bot)
                await ensure_distinct(store, role, me.id)
                store.save(
                    role,
                    dict(
                        expected_id=me.id,
                        api_id=api_id,
                        api_hash=api_hash,
                        session=await app.export_session_string(),
                        origin="login",
                    ),
                )
            except BaseException:
                # The authorization exists in Telegram now; unsaved, it must not dangle.
                try:
                    await app.log_out()
                except Exception:
                    pass
                raise
            return {
                "configured": True,
                "role": role,
                "user_id": me.id,
                "username": getattr(me, "username", None),
                "name": getattr(me, "first_name", None),
            }
        finally:
            if app.is_connected:
                await app.disconnect()


async def with_peer_warmup(app, lookup):
    """An in-memory session knows no peers; one bounded dialog scan fills the cache."""
    try:
        return await lookup()
    except Exception as error:
        if type(error).__name__ not in PEER_NOT_FOUND_ERRORS:
            raise
    async for _ in app.get_dialogs(limit=200):
        pass
    try:
        return await lookup()
    except Exception as error:
        if type(error).__name__ in PEER_NOT_FOUND_ERRORS:
            raise ClientError("PEER_NOT_FOUND") from None
        raise


async def resolve_call_peer(app, role, peer, store):
    """A user id to ring. `me` = the personal account, so only the caller can ring it."""
    target = parse_peer(peer)
    if target == "me":
        if role != "caller":
            raise ClientError("CALL_RECIPIENT_IS_CALLER")
        target = store.load("personal")["expected_id"]
    user = await with_peer_warmup(app, lambda: app.get_users(target))
    if getattr(user, "is_bot", False):
        raise ClientError("PEER_IS_BOT")
    if user.id == app.me.id:
        raise ClientError("CALL_RECIPIENT_IS_CALLER")
    return user.id


def validate_text(text):
    if not text.strip():
        raise ClientError("TEXT_EMPTY")
    if len(text) > TEXT_LIMIT:
        raise ClientError("TEXT_TOO_LONG")
    return text


async def send_text(app, peer, text):
    validate_text(text)
    target = parse_peer(peer, allow_chats=True)
    message = await with_peer_warmup(app, lambda: app.send_message(target, text))
    return {"sent": True, "chat_id": message.chat.id, "message_id": message.id}
