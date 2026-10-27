"""Runner side of the live probes: locate the right interpreter, run one bounded child, validate.

Validation is strict and total: a probe result that is missing a field, has an extra field, a
wrong type, a non-finite number or an unexpected value FAILS the check. Nothing is inferred.
"""
import hashlib
import json
import math
import re
import uuid
from pathlib import Path

from .context import installed_env

PROBE = Path(__file__).with_name("probes.py")
RUNTIME_MARKER = ".tg-ready"


def reject_constant(name):
    raise ValueError("non-finite JSON number")


def parse_last_json(text):
    if len(text) > 65536:
        return None
    lines = [line for line in text.splitlines() if line.strip()]
    if not lines:
        return None
    try:
        value = json.loads(lines[-1], parse_constant=reject_constant)
    except (ValueError, RecursionError):
        return None
    return value if isinstance(value, dict) else None


def runtime_python(ctx, repo):
    """The hash-locked sidecar venv's python (pyrofork/pytgcalls), or None when not built."""
    try:
        sha = hashlib.sha256((repo / "requirements-call.txt").read_bytes()).hexdigest()
    except OSError:
        return None
    cache = Path(ctx.env.get("XDG_CACHE_HOME") or ctx.home / ".cache")
    venv = cache / "tg-cli" / f"mtproto-runtime-{sha[:12]}"
    try:
        marker = (venv / RUNTIME_MARKER).read_text().strip()
    except OSError:
        return None
    python = venv / "bin" / "python"
    return str(python) if marker == sha and python.is_file() else None


def run_probe(ctx, args, repo, *, python=None, timeout=None):
    env = installed_env(ctx.env)
    env["PYTHONPATH"] = str(Path(repo) / "features")
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    outcome = ctx.run([python or ctx.python, str(PROBE), *args], timeout or ctx.timeout, env=env, cwd=str(ctx.home))
    if outcome.timed_out:
        return {"ok": False, "error": "PROBE_TIMEOUT"}
    if outcome.error or outcome.truncated:
        return {"ok": False, "error": "PROBE_OUTPUT_INVALID"}
    result = parse_last_json(outcome.stdout)
    if outcome.code != 0:
        failure = sanitize_failure(result)
        reason = failure.pop("error")
        failure["error"] = "PROBE_EXIT_NONZERO"
        if reason != "PROBE_OUTPUT_INVALID":
            failure["reason"] = reason
        return failure
    if result is None:
        return {"ok": False, "error": "PROBE_OUTPUT_INVALID"}
    return result if result.get("ok") is True else sanitize_failure(result)


# Only known boundary codes may reach reports; even a code-shaped string can be a secret.
FAILURE_CODES = frozenset((
    "FLOOD_WAIT", "RuntimeError", "INTERRUPTED", "RECIPIENT_UNVERIFIED",
    "CALL_MIRROR_RECIPIENT_MISMATCH", "ACCOUNT_IDENTITY_MISMATCH", "SESSION_MISSING",
    "SESSION_UNAUTHORIZED", "CLIENT_ALREADY_RUNNING", "SOURCE_SESSION_BUSY",
    "SOURCE_SESSION_MISSING", "SOURCE_SESSION_OWNERSHIP_NOT_CONFIRMED",
    "TTS_PROFILE_NOT_NEURAL", "TTS_CORPUS_NOT_SINGLE_SEGMENT", "RUN_ID_INVALID",
    "TTS_CONFIG_MISSING", "TTS_CONFIG_INVALID", "TTS_CREDENTIAL_MISSING",
))


def sanitize_failure(result):
    """Retain only fixed reasons and bounded attributed partial-send ids, never logs."""
    invalid = {"ok": False, "error": "PROBE_OUTPUT_INVALID"}
    if (not isinstance(result, dict) or result.get("ok") is not False
            or not check_keys(result, ("ok",), ("error", "partial", "message_ids"))):
        return invalid
    error = result.get("error")
    failure = {"ok": False, "error": error if isinstance(error, str) and error in FAILURE_CODES else "PROBE_OUTPUT_INVALID"}
    if "partial" in result or "message_ids" in result:
        ids = result.get("message_ids")
        if (result.get("partial") is not True or not isinstance(ids, list) or len(ids) > 8
                or not all(is_int(i) for i in ids) or len(set(ids)) != len(ids)):
            return invalid
        failure.update(message_ids=ids, partial=True)
    return failure


def is_int(value, minimum=1):
    return type(value) is int and value >= minimum


def is_finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def check_keys(result, required, optional=()):
    return set(result) >= set(required) and set(result) <= set(required) | set(optional)


TELEGRAM_KEYS = ("ok", "recipient_id", "caller_id", "anchor_id", "message_ids", "count", "ids_verified",
                 "chat_verified", "text_verified", "reply_links_verified", "edit_verified", "label_verified")


def validate_telegram(result):
    """None when the round trip is fully proven, else a fixed failure code."""
    if not isinstance(result, dict):
        return "PROBE_OUTPUT_INVALID"
    if result.get("ok") is not True:
        return str(result.get("error", "probe_failed")) if re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,79}", str(result.get("error", ""))) else "probe_failed"
    if not check_keys(result, TELEGRAM_KEYS):
        return "PROBE_OUTPUT_INVALID"
    ids = result["message_ids"]
    if not (is_int(result["recipient_id"]) and is_int(result["caller_id"]) and is_int(result["anchor_id"])
            and isinstance(ids, list) and ids and all(is_int(i) for i in ids) and len(set(ids)) == len(ids)
            and is_int(result["count"]) and result["count"] == len(ids) and ids[0] == result["anchor_id"]):
        return "PROBE_OUTPUT_INVALID"
    if result["recipient_id"] == result["caller_id"]:
        return "RECIPIENT_IS_CALLER"
    if len(ids) != 2:
        return "MIRROR_GROUP_SIZE_UNEXPECTED"
    for flag in TELEGRAM_KEYS[6:]:
        if result[flag] is not True:
            return "READBACK_MISMATCH_" + flag.upper()
    return None


TTS_KEYS = ("ok", "problems", "provider", "model", "voice_id", "latency", "engine", "segments", "text_sha256",
            "audio_duration_ms", "sample_rate_hz", "channels", "total_synth_ms", "time_to_first_audio_byte_ms",
            "clipping_ratio", "peak_dbfs", "file_mode", "dir_mode", "wer", "cer", "naturalness_score")


def validate_tts(result, *, expect_voice_id=None, expect_model=None):
    if not isinstance(result, dict):
        return "PROBE_OUTPUT_INVALID"
    if result.get("ok") is not True:
        problems = result.get("problems")
        if isinstance(problems, list) and problems and all(isinstance(p, str) and re.fullmatch(r"[A-Z_]{1,60}", p) for p in problems):
            return problems[0]
        error = str(result.get("error", ""))
        return error if re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,79}", error) else "probe_failed"
    if not check_keys(result, TTS_KEYS):
        return "PROBE_OUTPUT_INVALID"
    profile_error = validate_tts_profile(result, expect_voice_id, expect_model)
    if profile_error is not None:
        return profile_error
    return validate_tts_metrics(result)


CALL_KEYS = ("ok", "state", "saved_state", "call_id", "attempt_audited", "mirror_ids_count", "mirror_result",
             "automatic_retry", "audio_reused", "error", "reason", "heard_claimed")


def validate_call(result):
    if not isinstance(result, dict):
        return "PROBE_OUTPUT_INVALID"
    if not check_keys(result, CALL_KEYS):
        error = result.get("error")
        return error if isinstance(error, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,79}", error) else "PROBE_OUTPUT_INVALID"
    try:
        valid_id = str(uuid.UUID(result["call_id"])) == result["call_id"]
    except (ValueError, TypeError, AttributeError):
        valid_id = False
    if not valid_id:
        return "PROBE_OUTPUT_INVALID"
    if result["state"] != "audio_stream_ended" or result["ok"] is not True:
        state = result["state"] if isinstance(result["state"], str) and re.fullmatch(r"[a-z_]{1,40}", result["state"]) else "unknown"
        return f"CALL_NOT_COMPLETED_{state.upper()}"
    if (result["saved_state"] != "audio_stream_ended" or result["attempt_audited"] is not True
            or result["automatic_retry"] is not False or result["audio_reused"] is not True
            or result["mirror_result"] != "updated" or not is_int(result["mirror_ids_count"], 2)
            or result["heard_claimed"] is not False):
        return "CALL_AUDIT_INCOMPLETE"
    return None


def validate_tts_metrics(result):
    for name in ("audio_duration_ms", "total_synth_ms", "time_to_first_audio_byte_ms", "clipping_ratio"):
        if not is_finite(result[name]) or result[name] < 0:
            return "METRIC_NOT_FINITE"
    if not 0 < result["audio_duration_ms"] <= 120000 or result["time_to_first_audio_byte_ms"] > result["total_synth_ms"]:
        return "TIMINGS_INVALID"
    if result["clipping_ratio"] > 0.01:
        return "CLIPPING"
    if not (is_int(result["sample_rate_hz"], 8000) and result["channels"] in (1, 2) and result["segments"] == 1):
        return "AUDIO_FORMAT_INVALID"
    if result["file_mode"] != 0o600 or result["dir_mode"] != 0o700:
        return "FILES_NOT_PRIVATE"
    if any(result[name] is not None for name in ("wer", "cer", "naturalness_score")):
        return "UNMEASURED_VALUE_PRESENT"
    if not (isinstance(result["text_sha256"], str) and re.fullmatch(r"[0-9a-f]{64}", result["text_sha256"])):
        return "PROBE_OUTPUT_INVALID"
    return None


def validate_tts_profile(result, expect_voice_id, expect_model):
    if result["problems"] != [] or result["provider"] != "fish_audio" or result["engine"] is not None:
        return "NOT_A_NEURAL_PROFILE_RESULT"
    if not (isinstance(result["voice_id"], str) and re.fullmatch(r"[a-fA-F0-9]{32}", result["voice_id"])
            and isinstance(result["model"], str) and result["model"] and isinstance(result["latency"], str)):
        return "PROFILE_FIELDS_INVALID"
    if expect_voice_id is not None and result["voice_id"] != expect_voice_id:
        return "VOICE_ID_DIFFERS_FROM_EXPECTED"
    if expect_model is not None and result["model"] != expect_model:
        return "MODEL_DIFFERS_FROM_EXPECTED"
