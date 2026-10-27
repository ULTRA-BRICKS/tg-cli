"""Opt-in LIVE checks: Telegram self-mirror, one fresh neural synthesis, at most one call.

Nothing here is reachable without its flag. The recipient is fixed to the caller->owner `me`
route inside the child probe: there is no peer parameter anywhere in this module. Live checks
never delete messages, change auth, log in again, retry, or send in bulk.
"""
import json
import tempfile

from .context import installed_env
from .deployed import resolve_repo
from .owned_processes import available
from .probes_runner import (
    parse_last_json,
    run_probe,
    runtime_python,
    validate_call,
    validate_telegram,
    validate_tts,
)

UNSUPPORTED = ["live_two_way_conversation"]


def _tg_auth_online(ctx, repo, role, idle):
    argv = [str(repo / "tg"), "auth", role, "status", "--online", "--json"] + (["--source-idle-confirmed"] if idle else [])
    outcome = ctx.run(argv, 90, env=installed_env(ctx.env), cwd=str(ctx.home))
    result = parse_last_json(outcome.stdout) if outcome.code == 0 and not outcome.timed_out else None
    return (isinstance(result, dict) and result.get("configured") is True and result.get("online_verified") is True
            and type(result.get("user_id")) is int and result.get("user_id") == result.get("expected_id"))


def sessions_online(check, ctx, opts):
    if not available():
        return check.blocked("owned_process_cleanup_unavailable")
    repo = resolve_repo(ctx)
    if repo is None:
        return check.failed("deployed_checkout_unresolved")
    if runtime_python(ctx, repo) is None:
        return check.failed("sidecar_runtime_not_built")
    state = {role: _tg_auth_online(ctx, repo, role, opts.source_session_idle_confirmed) for role in ("user", "caller")}
    if not all(state.values()):
        return check.failed("session_not_online_and_identity_verified", **state)
    return check.passed("both_sessions_online_and_identity_verified", **state)


def mirror_roundtrip(check, ctx, opts):
    if not available():
        return check.blocked("owned_process_cleanup_unavailable")
    repo = resolve_repo(ctx)
    python = runtime_python(ctx, repo) if repo else None
    if python is None:
        return check.failed("sidecar_runtime_not_built")
    args = ["telegram", "--run-id", opts.run_id] + (["--source-session-idle-confirmed"] if opts.source_session_idle_confirmed else [])
    result = run_probe(ctx, args, repo, python=python, timeout=max(ctx.timeout, 120))
    failure = validate_telegram(result)
    ids = result.get("message_ids") if isinstance(result, dict) and isinstance(result.get("message_ids"), list) else []
    ids = [i for i in ids if type(i) is int][:8]
    if failure:
        return check.failed(failure, message_ids=ids, partial=bool(ids))
    return check.passed("exact_self_mirror_sent_edited_and_read_back", message_ids=result["message_ids"],
                        count=result["count"], anchor_id=result["anchor_id"], recipient="owner_self_only",
                        reply_links_verified=True, edit_verified=True, label="INTEGRATION TEST—NO CALL")


def tts_synthesis(check, ctx, opts):
    if not available():
        return check.blocked("owned_process_cleanup_unavailable")
    repo = resolve_repo(ctx)
    if repo is None:
        return check.failed("deployed_checkout_unresolved")
    ctx.tts_work = tempfile.mkdtemp(prefix="verify-calls-tts-")
    args = ["tts", "--work-dir", ctx.tts_work, "--run-id", opts.run_id, "--text-kind", "call" if opts.call else "check"]
    result = run_probe(ctx, args, repo, timeout=max(ctx.timeout, 120))
    failure = validate_tts(result, expect_voice_id=opts.expect_voice_id, expect_model=opts.expect_model)
    if failure:
        return check.failed(failure)
    ctx.tts_result = result
    evidence = {key: result[key] for key in ("provider", "model", "voice_id", "latency", "segments",
                                             "audio_duration_ms", "sample_rate_hz", "channels", "total_synth_ms",
                                             "time_to_first_audio_byte_ms", "clipping_ratio", "peak_dbfs",
                                             "file_mode", "dir_mode")}
    # Unmeasured values stay null: no recognizer or listener ran, so none is invented.
    return check.passed("fresh_neural_synthesis_validated", asr_wer=None, asr_cer=None, naturalness=None,
                        host_engine_used=False, **evidence)


def call_dial(check, ctx, opts):
    if not available():
        return check.blocked("owned_process_cleanup_unavailable")
    repo = resolve_repo(ctx)
    python = runtime_python(ctx, repo) if repo else None
    if python is None:
        return check.failed("sidecar_runtime_not_built")
    if ctx.tts_result is None or ctx.tts_work is None:
        return check.failed("no_fresh_synthesis_to_dial")
    if ctx.calls_attempted >= 1:
        return check.failed("one_call_per_run")
    ctx.calls_attempted += 1
    args = ["call", "--run-id", opts.run_id, "--work-dir", ctx.tts_work, "--text-sha256", ctx.tts_result["text_sha256"]]
    if opts.source_session_idle_confirmed:
        args.append("--source-session-idle-confirmed")
    result = run_probe(ctx, args, repo, python=python, timeout=max(ctx.timeout, 180))
    failure = validate_call(result)
    if failure:
        return check.failed(failure, call_id=result.get("call_id") if isinstance(result, dict) else None)
    return check.passed("audio_stream_ended_with_audited_attempt", call_id=result["call_id"],
                        receipt={"state": result["state"], "mirror_result": result["mirror_result"],
                                 "mirror_messages": result["mirror_ids_count"]},
                        meaning="outbound stream ended; not proof anyone heard it; no ASR, no two-way")


def two_way(check, ctx, opts):
    return check.blocked("unsupported:CONVERSATION_REQUIRES_IDENTIFIED_SERVICE",
                         reason="live two-way conversation is NOT_READY: the audited intro/transcript path is missing")


def dumps(value):
    return json.dumps(value, ensure_ascii=False)
