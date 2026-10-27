#!/usr/bin/env python3
"""Child-side live probes, run by verify-calls with PYTHONPATH=<deployed checkout>/features.

    probes.py voice-profile
    probes.py tts      --work-dir DIR --text-kind check|call --run-id ID
    probes.py telegram --run-id ID [--source-session-idle-confirmed]
    probes.py call     --work-dir DIR --run-id ID [--source-session-idle-confirmed]

Each prints exactly one JSON line and nothing else on stdout. The probes call the PRODUCTION
modules (connected, resolve_call_peer, call_mirror, Effects().synthesize, run_call) and report
only fixed codes, booleans, counts and public ids; exception text and credentials never leave.
The recipient is fixed: the caller account reaches the OWNER (`me`). There is no peer argument.
"""
import argparse
import asyncio
import hashlib
import json
import math
import os
import re
import uuid
import wave
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

LABEL = "INTEGRATION TEST—NO CALL"
SAY_CHECK = "Проверка голоса. Это тест интеграции звонков, звонка нет."
SAY_CALL = "Проверка связи. Это тест интеграции звонков. Пожалуйста, не отвечайте."
SAFE_CODE = re.compile(r"[A-Z][A-Z0-9_]{0,79}")
RUN_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{7,63}")
CLIPPING_LIMIT = 0.01


def code_of(error):
    text = str(error)
    return text if type(error).__name__ == "ClientError" and SAFE_CODE.fullmatch(text) else type(error).__name__


def say_args(say, run_id, title, idle=False, token=None):
    return SimpleNamespace(peer="me", say=say, audio=None, timeout=45, dry_run=False, kind="report",
                           agent="verify-calls", task=run_id, task_title=title, project=None, session=None,
                           transcript=None, topic=None, reply_to=None, idempotency_key=token,
                           source_session_idle_confirmed=idle)


def config_dir():
    from telegram_client.paths import config_dir as locate
    return locate()


def voice_profile():
    from telegram_client.tts_config import load_config
    config = load_config(config_dir())
    return {"ok": True, "provider": config.provider, "model": config.model, "voice_id": config.voice_id,
            "latency": config.latency, "credential_source": (config.credential_source or {}).get("type")}


def audio_facts(path):
    with wave.open(str(path), "rb") as source:
        frames, rate, channels = source.getnframes(), source.getframerate(), source.getnchannels()
    return {"frames": frames, "sample_rate_hz": rate, "channels": channels,
            "duration_ms": frames * 1000 / rate if rate else 0}


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def tts_probe(work_dir, text_kind, run_id):
    """Actual Effects().synthesize for one fixed benign text; pinned profile or refusal."""
    from telegram_client.call_identity import prepare
    from telegram_client.call_service import Effects, tts_metadata
    from telegram_client.tts import speech_chunks
    from telegram_client.tts_config import load_config
    configured = load_config(config_dir())
    if configured.provider != "fish_audio":
        return {"ok": False, "error": "TTS_PROFILE_NOT_NEURAL"}
    say = SAY_CALL if text_kind == "call" else SAY_CHECK
    title = "INTEGRATION TEST—CALL" if text_kind == "call" else LABEL
    spoken = prepare(say_args(say, run_id, title), {})["spoken_text"]
    pieces = list(speech_chunks(spoken))
    if len(pieces) != 1:
        return {"ok": False, "error": "TTS_CORPUS_NOT_SINGLE_SEGMENT"}
    work = Path(work_dir)
    target = work / "tts"
    audio = asyncio.run(Effects().synthesize(pieces[0], target, config_dir()))
    meta = tts_metadata(target)
    facts = audio_facts(audio)
    mode = lambda p: Path(p).lstat().st_mode & 0o777
    block = meta.get("audio", {})
    problems = tts_problems(meta, configured, facts, audio, target, mode)
    clipping = block.get("clipping_ratio")
    first, total = meta.get("time_to_first_audio_byte_ms"), meta.get("total_synth_ms")
    return {"ok": not problems, "problems": problems, "provider": meta.get("provider"),
            "model": meta.get("model"), "voice_id": meta.get("voice_id"), "latency": meta.get("latency"),
            "engine": meta.get("engine"), "segments": len(pieces), "text_sha256": hashlib.sha256(pieces[0].encode()).hexdigest(),
            "audio_duration_ms": facts["duration_ms"], "sample_rate_hz": facts["sample_rate_hz"],
            "channels": facts["channels"], "total_synth_ms": total, "time_to_first_audio_byte_ms": first,
            "clipping_ratio": clipping, "peak_dbfs": block.get("peak_dbfs"), "file_mode": mode(audio),
            "dir_mode": mode(target), "wer": block.get("wer"), "cer": block.get("cer"),
            "naturalness_score": block.get("naturalness_score")}


async def verified_owner(store, connection):
    """Verify the personal session independently before trusting a self-route resolver."""
    from telegram_client.core import ClientError
    expected = store.load("personal")["expected_id"]
    async with connection as owner:
        actual = (await owner.get_me()).id
    if type(expected) is not int or expected <= 0 or type(actual) is not int or actual != expected:
        raise ClientError("RECIPIENT_UNVERIFIED")
    return expected


async def telegram_roundtrip(store, connect, resolve, mirror, parse_mode, run_id, idle=False):
    """One exact-self mirror group: send via production mirror, edit the anchor, read both back."""
    from telegram_client.call_identity import prepare
    from telegram_client.call_mirror import anchor_text, chunks
    auth = store.load("caller")
    owner_id = await verified_owner(store, connect(store, "personal", source_idle_confirmed=idle))
    plan = prepare(say_args("Проверка зеркала. Звонок не выполняется.", run_id, LABEL), {})
    async with connect(store, "caller", source_idle_confirmed=idle) as app:
        recipient = await resolve(app, "caller", "me", store)
        if type(recipient) is not int or recipient != owner_id or recipient == auth["expected_id"]:
            return {"ok": False, "error": "RECIPIENT_UNVERIFIED"}
        record = dict(plan, call_id=str(uuid.uuid4()), created_at=datetime.now(UTC).isoformat(),
                      caller_id=auth["expected_id"], recipient_id=recipient, status="mirroring", mirror_ids=[])
        sent = []
        try:
            await mirror.mirror(app, recipient, record, lambda ids: sent.__setitem__(slice(None), ids), parse_mode)
            record.update(mirror_ids=list(sent), status="mirrored")
            await mirror.finish(app, recipient, record, parse_mode)
        except Exception as error:  # noqa: BLE001 — convert unexpected boundary failures to redacted results.
            # Nothing is deleted or retried; the ids that exist are reported for manual cleanup.
            return {"ok": False, "error": code_of(error), "message_ids": list(sent), "partial": True}
        ids = list(record["mirror_ids"])
        messages = await app.get_messages(recipient, ids)
        messages = list(messages) if isinstance(messages, (list, tuple)) else [messages]
        body = "Расшифровка исходящего сообщения:\n" + record["spoken_text"]
        initial = anchor_text(record, "подготовка")
        expected = [anchor_text(record, "mirrored"), *chunks(body)]
        anchor_id = ids[0]
        facts = {
            "ids": [getattr(m, "id", None) for m in messages] == ids,
            "chat": all(getattr(getattr(m, "chat", None), "id", None) == recipient for m in messages),
            "text": [getattr(m, "text", None) for m in messages] == expected,
            "links": all(getattr(m, "reply_to_message_id", None) == anchor_id for m in messages[1:]),
            "edit": len(messages) > 0 and getattr(messages[0], "text", None) == expected[0] != initial,
            "label": all(LABEL in text for text in expected[:2]),
        }
        return {"ok": all(facts.values()) and len(ids) == len(expected), "recipient_id": recipient,
                "caller_id": auth["expected_id"], "anchor_id": anchor_id, "message_ids": ids, "count": len(ids),
                "ids_verified": facts["ids"], "chat_verified": facts["chat"], "text_verified": facts["text"],
                "reply_links_verified": facts["links"], "edit_verified": facts["edit"],
                "label_verified": facts["label"]}


class ReusedSynthesis:
    """Production Effects whose synthesis returns the already validated fresh neural audio."""

    def __init__(self, base, source, text_sha256, owner_id=None):
        self.base, self.source, self.sha = base, Path(source), text_sha256
        self.owner_id = owner_id
        self.used = 0

    def __getattr__(self, name):
        return getattr(self.base, name)

    async def resolve(self, app, store, role, peer):
        recipient = await self.base.resolve(app, store, role, peer)
        self.require_owner(recipient)
        return recipient

    def require_owner(self, recipient):
        if type(recipient) is not int or recipient != self.owner_id:
            from telegram_client.core import ClientError
            raise ClientError("RECIPIENT_UNVERIFIED")

    async def dial(self, store, role, recipient, audio, timeout, idle):
        self.require_owner(recipient)
        return await self.base.dial(store, role, recipient, audio, timeout, idle)

    async def synthesize(self, text, directory, config_dir):
        if hashlib.sha256(text.encode()).hexdigest() != self.sha or self.used:
            from telegram_client.core import ClientError
            raise ClientError("AUDIO_REUSE_MISMATCH")
        self.used += 1
        target = Path(directory)
        target.mkdir(mode=0o700)
        for name in ("say.wav", "tts.json"):
            fd = os.open(target / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "wb") as out:
                out.write((self.source / name).read_bytes())
        return target / "say.wav"


async def call_probe(store, work_dir, run_id, text_sha256, idle=False, effects=None):
    from telegram_client.call_journal import Journal
    from telegram_client.call_service import Effects, run_call
    started = datetime.now(UTC).isoformat()
    base = effects or Effects()
    owner_id = await verified_owner(store, base.connection(store, "personal", idle))
    reuse = ReusedSynthesis(base, Path(work_dir) / "tts", text_sha256, owner_id)
    args = say_args(SAY_CALL, run_id, "INTEGRATION TEST—CALL", idle, token=f"verify-calls-{run_id}")
    result = await run_call(store, "caller", args, effects=reuse)
    rows = Journal(store.root).history(call_id=result["call_id"])
    row = rows[0] if rows else {}
    transitions = row.get("transitions", [])
    attempted = [t for t in transitions if t["status"] == "attempting" and t["at"] >= started]
    return {"ok": result.get("ok") is not False and result["state"] == "audio_stream_ended",
            "state": result["state"], "saved_state": result.get("saved_state"), "call_id": result["call_id"],
            "attempt_audited": bool(attempted) and row.get("status") == result["state"],
            "mirror_ids_count": len(result.get("mirror_ids") or []), "mirror_result": result.get("mirror_result"),
            "automatic_retry": result.get("automatic_retry"), "audio_reused": reuse.used == 1,
            "error": result.get("error"), "reason": result.get("reason"), "heard_claimed": False}


def main(argv=None):
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("voice-profile")
    for name in ("tts", "telegram", "call"):
        sub = commands.add_parser(name)
        sub.add_argument("--run-id", required=True)
        sub.add_argument("--source-session-idle-confirmed", action="store_true")
        if name != "telegram":
            sub.add_argument("--work-dir", required=True)
        if name == "tts":
            sub.add_argument("--text-kind", choices=("check", "call"), required=True)
        if name == "call":
            sub.add_argument("--text-sha256", required=True)
    args = parser.parse_args(argv)
    result = execute_probe(args)
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0 if result.get("ok") else 1




def tts_problems(meta, configured, facts, audio, target, mode):
    block = meta.get("audio", {})
    problems = []
    if not (meta.get("provider") == configured.provider and meta.get("model") == configured.model
            and meta.get("voice_id") == configured.voice_id and meta.get("latency") == configured.latency):
        problems.append("PINNED_PROFILE_MISMATCH")
    if meta.get("engine") is not None:
        problems.append("HOST_ENGINE_USED")
    if not (finite(facts["duration_ms"]) and 0 < facts["duration_ms"] <= 120000) or audio.stat().st_size <= 44:
        problems.append("AUDIO_EMPTY_OR_TOO_LONG")
    clipping = block.get("clipping_ratio")
    if not finite(clipping) or clipping > CLIPPING_LIMIT:
        problems.append("CLIPPING")
    first, total = meta.get("time_to_first_audio_byte_ms"), meta.get("total_synth_ms")
    if not (finite(first) and finite(total) and 0 <= first <= total):
        problems.append("TIMINGS_NOT_FINITE")
    if mode(audio) != 0o600 or mode(target) != 0o700 or mode(target / "tts.json") != 0o600:
        problems.append("FILES_NOT_PRIVATE")
    return problems


def execute_probe(args):
    if args.command != "voice-profile" and not RUN_ID.fullmatch(args.run_id):
        result = {"ok": False, "error": "RUN_ID_INVALID"}
    else:
        try:
            if args.command == "voice-profile":
                result = voice_profile()
            elif args.command == "tts":
                result = tts_probe(args.work_dir, args.text_kind, args.run_id)
            elif args.command == "telegram":
                from telegram_client import call_mirror
                from telegram_client.account import resolve_call_peer
                from telegram_client.call_service import Effects
                from telegram_client.core import AuthStore
                from telegram_client.paths import default_store
                from telegram_client.runtime import connected
                result = asyncio.run(telegram_roundtrip(
                    AuthStore(default_store()), connected, resolve_call_peer, call_mirror,
                    Effects().parse_mode(), args.run_id, args.source_session_idle_confirmed))
            else:
                from telegram_client.core import AuthStore
                from telegram_client.paths import default_store
                result = asyncio.run(call_probe(AuthStore(default_store()), args.work_dir, args.run_id,
                                                args.text_sha256, args.source_session_idle_confirmed))
        except (KeyboardInterrupt, asyncio.CancelledError):
            result = {"ok": False, "error": "INTERRUPTED"}
        except Exception as error:  # noqa: BLE001 — convert unexpected boundary failures to redacted results.
            result = {"ok": False, "error": code_of(error)}
    return result


if __name__ == "__main__":
    raise SystemExit(main())
