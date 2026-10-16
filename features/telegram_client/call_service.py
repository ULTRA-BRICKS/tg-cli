"""One-shot call owner: prepare → durable intent → exact chat mirror → TTS → one dial.

Used by tg, call-cli and tg-call. All online effects are injectable. Runtime owns role
locks and source-idle checks. No exception messages, auth dictionaries or recordings enter
history. Observed outcomes survive journal failures; saved_state is the last confirmed write.
A killed process leaves an intent/attempt requiring manual reconciliation.
"""
import asyncio
import json
import math
import os
import stat
from pathlib import Path
import re
import socket
import inspect
import tempfile
from .core import ClientError, auth_origin
from .call_identity import prepare
from .call_journal import Journal
from . import call_mirror


def safe_error(error):
    if isinstance(error, ClientError) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,79}", str(error)):
        return str(error)
    return type(error).__name__


class Effects:
    def parse_mode(self):
        from pyrogram.enums import ParseMode
        return ParseMode.DISABLED

    def connection(self, store, role, idle):
        from .runtime import connected
        return connected(store, role, source_idle_confirmed=idle)

    async def resolve(self, app, store, role, peer):
        from .account import resolve_call_peer
        return await asyncio.wait_for(resolve_call_peer(app, role, peer, store), 30)

    async def synthesize(self, text, directory, config_dir):
        from .preparation import prepare_audio
        return await prepare_audio('synthesize', text=text, directory=str(directory), config_dir=str(config_dir))

    async def join_audio(self, intro, audio, directory):
        from .preparation import prepare_audio
        return await prepare_audio('join', intro=str(intro), audio=str(audio), directory=str(directory))

    async def dial(self, store, role, recipient, audio, timeout, idle):
        from .runtime import place_call
        await place_call(store, role, str(recipient), audio, timeout=timeout, source_idle_confirmed=idle)


def tts_metadata(directory):
    """Read only bounded, known signal fields; provider/request text never enters history."""
    path = Path(directory) / "tts.json"
    if not path.exists() and not path.is_symlink():
        return {}
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 65536:
                raise ValueError()
            payload = source.read(65537)
        if len(payload) > 65536:
            raise ValueError()
        raw = json.loads(payload, parse_constant=lambda value: (_ for _ in ()).throw(ValueError()))
        if not isinstance(raw, dict):
            raise ValueError()
        strings = {"provider", "model", "voice_id", "latency", "engine", "voice", "language"}
        numbers = {"version", "time_to_first_audio_byte_ms", "total_synth_ms", "duration_ms", "elapsed_ms", "characters", "sample_rate"}
        result = {}
        for key in strings | numbers:
            if key not in raw:
                continue
            value = raw[key]
            if value is None:
                result[key] = None
            elif key in strings and isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", value):
                result[key] = value
            elif key in numbers and type(value) in (int, float) and 0 <= value <= 1e12 and math.isfinite(value):
                result[key] = value
            else:
                raise ValueError()
        if "audio" in raw:
            if not isinstance(raw["audio"], dict):
                raise ValueError()
            audio = {}
            fields = {"audio_duration_ms", "sample_rate_hz", "channels", "synth_ms", "real_time_factor", "peak", "rms", "peak_dbfs", "rms_dbfs", "clipping_ratio", "clipping_threshold", "silence_threshold_dbfs", "silence_window_ms", "internal_silence_min_ms", "leading_silence_ms", "trailing_silence_ms", "internal_silence_ms", "internal_silence_count", "naturalness_score", "wer", "cer", "word_errors", "character_errors", "reference_words", "reference_characters"}
            for key in fields & raw["audio"].keys():
                value = raw["audio"][key]
                if value is not None and (type(value) not in (int, float) or abs(value) > 1e12 or not math.isfinite(value)):
                    raise ValueError()
                if value is not None:
                    if key.endswith("dbfs"):
                        if value > 0:
                            raise ValueError()
                    elif value < 0:
                        raise ValueError()
                    if key in ("peak", "rms", "clipping_ratio", "clipping_threshold") and value > 1:
                        raise ValueError()
                audio[key] = value
            if "asr_status" in raw["audio"]:
                value = raw["audio"]["asr_status"]
                if value not in ("not_measured", "measured"):
                    raise ValueError()
                audio["asr_status"] = value
            result["audio"] = audio
        return result
    except (OSError, ValueError, RecursionError):
        raise ClientError("TTS_METADATA_INVALID") from None


def tts_summary(segments):
    """Aggregate measured generated segments only; playback latency is unobserved."""
    synth = [part.get("total_synth_ms") for part in segments]
    durations = [part.get("audio", {}).get("audio_duration_ms") for part in segments]
    complete_synth = bool(synth) and all(type(value) in (int, float) for value in synth)
    complete_duration = bool(durations) and all(type(value) in (int, float) and value > 0 for value in durations)
    total = sum(synth) if complete_synth else None
    duration = sum(durations) if complete_duration else None
    return {"segments": segments, "aggregate": {
        "generated_segments": len(segments), "total_synth_ms": total,
        "audio_duration_ms": duration,
        "real_time_factor": total / duration if total is not None and duration else None,
        "time_to_first_playback_ms": None,
        "scope": "generated_segments_only"}}


async def prepared_effect(value):
    """Production effects await child ownership; simple in-memory fakes may be immediate."""
    return await value if inspect.isawaitable(value) else value


async def run_call(store, role, args, effects=None, journal=None, env=None):
    from .account import parse_peer
    if not 1 <= args.timeout <= 600:
        raise ClientError("TIMEOUT_MUST_BE_1_TO_600")
    parse_peer(args.peer)
    plan = prepare(args, env)
    if args.dry_run:
        return dict(plan, dry_run=True, role=role, peer=args.peer)
    auth = store.load(role)
    idle = args.source_session_idle_confirmed
    if auth_origin(auth) == "import" and not idle:
        raise ClientError("SOURCE_SESSION_OWNERSHIP_NOT_CONFIRMED")
    if args.audio is not None and not args.audio.is_file():
        raise ClientError("AUDIO_FILE_MISSING")
    # Bot topic/reply ids belong to another chat/account namespace. Never guess a mapping.
    if getattr(args, "topic", None):
        raise ClientError("CALL_TOPIC_MAPPING_UNVERIFIED")
    effects = effects or Effects()
    journal = journal or Journal(store.root)
    record = journal.begin(dict(plan, host=socket.gethostname(), role=role,
        caller_id=auth["expected_id"], peer=args.peer, recipient_id=None,
        reply_to=getattr(args, "reply_to", None), mirror_transport="calling_account_private_chat"),
        getattr(args, "idempotency_key", None))
    call_id = record["call_id"]
    failure = None
    saved_state = record["status"]
    persistence_failed = False

    def persist(state, required=True, **fields):
        nonlocal record, saved_state, persistence_failed
        # Keep observed effects even when their audit write cannot complete. A failed
        # journal is never retried here, and mandatory writes fence every dial.
        record = dict(record, status=state, **fields)
        if persistence_failed:
            if required:
                raise ClientError("CALL_JOURNAL_UNAVAILABLE")
            return record
        try:
            record = journal.update(call_id, state, **fields)
            saved_state = record["status"]
        except Exception:
            persistence_failed = True
            if required:
                raise ClientError("CALL_JOURNAL_UNAVAILABLE") from None
        return record

    stage = "resolve"
    try:
        async with effects.connection(store, role, idle) as app:
            recipient = await effects.resolve(app, store, role, args.peer)
            if type(recipient) is not int or recipient <= 0 or recipient == auth["expected_id"]:
                raise ClientError("CALL_RECIPIENT_UNVERIFIED")
            record = persist("resolved", recipient_id=recipient)
            stage = "mirror"
            def save(ids):
                nonlocal record
                record = persist("mirroring", mirror_ids=ids)
            await call_mirror.mirror(app, recipient, record, save, effects.parse_mode(), getattr(args, "reply_to", None))
            record = persist("mirrored")
        stage = "prepare"
        with tempfile.TemporaryDirectory(prefix="tg-call-") as directory:
            # Speech counts Python characters; Telegram's UTF-16 limits do not apply.
            # Literal source/spoken transcripts remain in the durable plan unchanged.
            from .tts import speech_chunks
            pieces = list(speech_chunks(plan["spoken_text"]))
            audio = await prepared_effect(effects.synthesize(pieces[0], Path(directory) / "tts", store.root.parent))
            metrics = [dict(tts_metadata(Path(directory) / "tts"), segment=0, input_characters=len(pieces[0]))]
            record = persist("synthesizing", tts=tts_summary(metrics))
            for index, text in enumerate(pieces[1:]):
                segment = Path(directory) / f"tts-{index}"
                next_audio = await prepared_effect(effects.synthesize(text, segment, store.root.parent))
                metrics.append(dict(tts_metadata(segment), segment=index + 1, input_characters=len(text)))
                record = persist("synthesizing", tts=tts_summary(metrics))
                segment_dir = Path(directory) / f"join-{index}"
                segment_dir.mkdir(mode=0o700)
                audio = await prepared_effect(effects.join_audio(audio, next_audio, segment_dir))
            if args.audio is not None:
                audio = await prepared_effect(effects.join_audio(audio, args.audio, directory))
            record = persist("prepared", tts=tts_summary(metrics))
            stage = "dial"
            record = persist("attempting")
            await effects.dial(store, role, recipient, audio, args.timeout, idle)
            record = persist("audio_stream_ended", required=False)
    except BaseException as error:
        failure = error
        state = "cancelled" if isinstance(error, (asyncio.CancelledError, KeyboardInterrupt)) else "timeout" if isinstance(error, TimeoutError) else "failed"
        record = persist(state, required=False, failure=safe_error(error), failure_stage=stage,
                         automatic_retry=False)
    finally:
        if record["mirror_ids"]:
            mirror_fields = {"mirror_result": "updated"}
            try:
                async with effects.connection(store, role, idle) as app:
                    await call_mirror.finish(app, record["recipient_id"], record, effects.parse_mode())
            except (asyncio.CancelledError, KeyboardInterrupt) as error:
                mirror_fields = {"mirror_result": "update_cancelled"}
                if not isinstance(failure, (asyncio.CancelledError, KeyboardInterrupt)):
                    failure = error
            except Exception as error:
                mirror_fields = {"mirror_result": "update_failed", "mirror_warning": safe_error(error)}
            record = persist(record["status"], required=False, **mirror_fields)
    result = dict(call_id=call_id, state=record["status"], saved_state=saved_state,
                  persistence_failed=persistence_failed,
                  audit_warning="CALL_JOURNAL_WRITE_FAILED" if persistence_failed else None,
                  warning=record.get("mirror_warning"), mirror_warning=record.get("mirror_warning"),
                  mirror_result=record.get("mirror_result"), mirror_ids=record["mirror_ids"],
                  recipient_id=record.get("recipient_id"), automatic_retry=False)
    if record.get("failure"):
        result.update(ok=False, error="CALL_ATTEMPT_FAILED", reason=record["failure"],
                      stage=record["failure_stage"],
                      warning="Transcript mirror failed; no call placed" if record["failure_stage"] == "mirror" else record.get("mirror_warning"))
    if isinstance(failure, (asyncio.CancelledError, KeyboardInterrupt)):
        failure.call_result = result
        raise failure
    return result
