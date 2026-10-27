"""Deployed level: metadata and read-only probes of the INSTALLED tools. Nothing here rings or sends.

* credential files: `lstat` only. Contents are never opened, read or hashed.
* frontdoor dry-run: offline by construction (no network, no TTS, no auth read).
* history: a read. Journal metadata may change concurrently (another agent's call), so no
  global before/after equality is claimed; "reads write nothing" is proven in the isolated
  hermetic scenario (hermetic.scenario.I06B), not against live state.
"""
import json
import os
import re
import stat
import uuid
from pathlib import Path

from .context import code_digest, installed_env

VERSION_LINE = re.compile(r"^tg (\S+) \(([0-9a-f]{7,40}|unknown)\)")
FRONTDOORS = ("tg", "call-cli")
SERVICE_MARKER = Path("features") / "telegram_client" / "call_service.py"
DRY_RUN_ARGS = ["--say=verify-calls offline dry run", "--agent=verify-calls", "--dry-run", "--json"]


def resolve_repo(ctx):
    """The checkout the installed `tg` alias resolves to (also for runs without --deployed)."""
    if ctx.deployed_repo is None:
        path = ctx.which("tg")
        if path:
            repo = Path(os.path.realpath(path)).parent
            if (repo / SERVICE_MARKER).is_file():
                ctx.deployed_repo = repo
    return ctx.deployed_repo


def alias_realpath(check, ctx, opts):
    found = {}
    for name in FRONTDOORS:
        path = ctx.which(name)
        if not path:
            return check.failed(f"alias_missing:{name}")
        found[name] = Path(os.path.realpath(path))
    if (found["tg"].name, found["call-cli"].name) != ("tg", "call-cli"):
        return check.failed("alias_target_name_mismatch", tg=found["tg"].name, call_cli=found["call-cli"].name)
    if found["tg"].parent != found["call-cli"].parent:
        return check.failed("aliases_resolve_to_different_checkouts")
    repo = found["tg"].parent
    if not (repo / SERVICE_MARKER).is_file():
        return check.failed("deployed_checkout_has_no_call_service")
    if opts.deployed_repo is not None and Path(os.path.realpath(opts.deployed_repo)) != repo:
        return check.failed("alias_realpath_differs_from_expected_checkout", resolved=str(repo))
    ctx.deployed_repo = repo
    return check.passed("aliases_share_one_checkout", checkout=str(repo))


def installed_version(check, ctx, opts):
    repo = resolve_repo(ctx)
    if repo is None:
        return check.failed("deployed_checkout_unresolved")
    outcome = ctx.run([str(repo / "tg"), "--version"], 30, env=installed_env(ctx.env), cwd=str(ctx.home))
    match = VERSION_LINE.match(outcome.stdout) if outcome.code == 0 else None
    if not match:
        return check.failed("version_output_unrecognized")
    reported, short = match.groups()
    try:
        package = json.loads((repo / "package.json").read_text())["version"]
    except (OSError, ValueError, KeyError, TypeError):
        return check.failed("package_version_unreadable")
    sha = ctx.git(repo, "rev-parse", "HEAD")
    if not sha or not re.fullmatch(r"[0-9a-f]{40}", sha):
        return check.failed("deployed_sha_unreadable")
    ctx.deployed_sha, ctx.deployed_version = sha, package
    ctx.deployed_digest = code_digest(repo)
    tested_digest = code_digest(ctx.tested_repo)
    evidence = {"reported_version": reported, "package_version": package, "deployed_sha": sha, "reported_short": short,
                "deployed_code_sha256": ctx.deployed_digest, "tested_code_sha256": tested_digest}
    if reported != package:
        return check.failed("installed_version_differs_from_package", **evidence)
    if short != "unknown" and not sha.startswith(short):
        return check.failed("installed_hash_differs_from_checkout_head", **evidence)
    if opts.expect_version is not None and reported != opts.expect_version:
        return check.failed("version_differs_from_expected", expected=opts.expect_version, **evidence)
    tested = ctx.tested_sha
    if not tested:
        return check.failed("tested_sha_unknown", **evidence)
    if sha != tested:
        return check.failed("deployed_sha_differs_from_tested_sha", tested_sha=tested, **evidence)
    if not ctx.deployed_digest or ctx.deployed_digest != tested_digest:
        return check.failed("deployed_code_differs_from_tested_source", tested_sha=tested, **evidence)
    return check.passed("deployed_matches_tested_source", tested_sha=tested, **evidence)


def credential_metadata(check, ctx, opts):
    """Owner/mode/type of the canonical private files via lstat. NEVER opens a credential."""
    store = ctx.config_dir / "mtproto"
    getuid = os.getuid()
    problems, seen = [], {}
    try:
        info = os.lstat(store)
    except OSError:
        return check.failed("credential_directory_missing")
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != getuid or info.st_mode & 0o077:
        problems.append("directory_not_private_0700")
    seen["mtproto"] = oct(stat.S_IMODE(info.st_mode))
    for role in ("personal", "caller"):
        try:
            info = os.lstat(store / f"{role}.json")
        except OSError:
            problems.append(f"{role}_session_missing")
            continue
        seen[role] = oct(stat.S_IMODE(info.st_mode))
        if not stat.S_ISREG(info.st_mode) or info.st_uid != getuid or stat.S_IMODE(info.st_mode) & 0o177:
            problems.append(f"{role}_session_not_private_0600")
    if problems:
        return check.failed(problems[0], problems=problems, modes=seen)
    return check.passed("canonical_private_files_present", modes=seen, contents_read=False)


def tg_ctl(check, ctx, opts):
    repo = resolve_repo(ctx)
    path = ctx.which("tg-ctl") or (str(repo / "tg-ctl") if repo else None)
    if not path:
        return check.failed("tg_ctl_missing")
    outcome = ctx.run([path, "status", "--dry-run"], 30, env=installed_env(ctx.env), cwd=str(ctx.home))
    if outcome.code != 0 or outcome.timed_out or outcome.truncated or outcome.error:
        return check.failed("status_command_failed")
    text = outcome.stdout
    code = re.search(r"^code: (.+)$", text, re.MULTILINE)
    autostart = re.search(r"^autostart: (.+)$", text, re.MULTILINE)
    if not code or not autostart:
        return check.failed("status_output_unrecognized")
    code_line, autostart_line = code.group(1), autostart.group(1)
    if "STALE" in code_line or code_line.startswith("unknown"):
        return check.failed("daemon_code_stale_or_unknown", code=code_line)
    if not re.match(r"^[0-9a-f]{7,40} \((?:current|checkout at [0-9a-f]{7,40} — no daemon code changed)\)", code_line):
        return check.failed("status_output_unrecognized")
    if not autostart_line.startswith("enabled"):
        return check.failed("autostart_not_enabled", autostart=autostart_line)
    return check.passed("daemon_code_current_and_autostart_enabled", code=code_line, autostart=autostart_line)


def requested_peer_matches(payload, expected_peer):
    """The response must describe the requested recipient, including in offline plans."""
    return payload.get("peer") == expected_peer


def frontdoor_dry_run(check, ctx, opts):
    repo = resolve_repo(ctx)
    if repo is None:
        return check.failed("deployed_checkout_unresolved")
    results = {}
    expected_peer = "@verifycalls"
    for name, argv in (("tg", [str(repo / "tg"), "call"]), ("call-cli", [str(repo / "call-cli")])):
        outcome = ctx.run([*argv, expected_peer, *DRY_RUN_ARGS], 60, env=installed_env(ctx.env), cwd=str(ctx.home))
        payload, invalid = decode_offline_plan(outcome, expected_peer, name, check)
        if invalid is not None:
            return invalid
        invalid = validate_offline_plan(payload, expected_peer, name, check)
        if invalid is not None:
            return invalid
        results[name] = (outcome.code, payload)
    if results["tg"] != results["call-cli"]:
        return check.failed("frontdoor_dry_runs_differ")
    code, payload = results["tg"]
    return check.passed("identical_offline_only_identity_unverified_not_ready_to_ring", exit_code=code, ready=payload.get("ready"),
                        spoken_text=payload.get("spoken_text"))


def history_read(check, ctx, opts):
    repo = resolve_repo(ctx)
    if repo is None:
        return check.failed("deployed_checkout_unresolved")
    counts, snapshots = {}, {}
    for name, argv in (("tg", [str(repo / "tg"), "call"]), ("call-cli", [str(repo / "call-cli")])):
        outcome = ctx.run([*argv, "history", "list", "--json", "--limit=1"], 60, env=installed_env(ctx.env), cwd=str(ctx.home))
        if outcome.code != 0:
            return check.failed(f"{name}_history_failed")
        calls, invalid = decode_history(outcome, name, check)
        if invalid is not None:
            return invalid
        counts[name] = len(calls)
        snapshots[name] = calls
    if snapshots["tg"] != snapshots["call-cli"]:
        return check.failed("frontdoor_histories_differ", concurrent_change_possible=True)
    return check.passed("history_readable_through_both_frontdoors", rows_seen=counts,
                        no_write_proof="hermetic.scenario.I06B")


def voice_profile(check, ctx, opts):
    from .probes_runner import run_probe
    repo = resolve_repo(ctx)
    if repo is None:
        return check.failed("deployed_checkout_unresolved")
    result = run_probe(ctx, ["voice-profile"], repo)
    if not isinstance(result, dict) or result.get("ok") is not True:
        return check.failed(result.get("error", "probe_failed") if isinstance(result, dict) else "probe_output_invalid")
    profile = {key: result.get(key) for key in ("provider", "model", "voice_id", "latency")}
    if profile["provider"] != "fish_audio" or not all(isinstance(profile[k], str) and profile[k] for k in ("model", "voice_id", "latency")):
        return check.failed("profile_is_not_a_configured_neural_voice", provider=profile["provider"])
    if opts.expect_voice_id is not None and profile["voice_id"] != opts.expect_voice_id:
        return check.failed("voice_id_differs_from_expected", configured=profile["voice_id"], expected=opts.expect_voice_id)
    if opts.expect_model is not None and profile["model"] != opts.expect_model:
        return check.failed("model_differs_from_expected", configured=profile["model"], expected=opts.expect_model)
    return check.passed("neural_profile_configured", credentials_checked=False,
                        voice_expectation_given=opts.expect_voice_id is not None, **profile)


def validate_offline_plan(payload, expected_peer, name, check):
    checks = payload.get("session_checks")
    unchecked = ("auth_contents_checked", "credentials_checked", "identity_checked",
                 "ownership_checked", "identity_verified", "origin_verified")
    if (not isinstance(checks, dict) or set(checks) != set(unchecked) |
            {"session_file_present", "personal_session_file_present"}
            or checks.get("session_file_present") is not True
            or any(checks.get(key) is not False for key in unchecked)
            or checks.get("personal_session_file_present") is not (True if expected_peer == "me" else None)):
        return check.failed(f"{name}_dry_run_schema_invalid")
    invalid = validate_missing_reasons(payload, expected_peer, name, check)
    if invalid is not None:
        return invalid
    tts = payload.get("tts")
    if (not isinstance(tts, dict) or tts.get("credentials_checked") is not False
            or tts.get("provider") != "fish_audio"
            or not all(isinstance(tts.get(key), str) and tts[key] for key in ("model", "voice_id", "latency"))):
        return check.failed(f"{name}_dry_run_schema_invalid")


def validate_missing_reasons(payload, expected_peer, name, check):
    expected = ["session_identity_unverified", "source_session_origin_unverified"]
    if expected_peer == "me":
        expected.append("recipient_identity_unverified")
    if (payload["ready"] is not False or payload.get("missing") != expected or payload.get("missing_reasons") !=
            [{"component": key, "code": key} for key in expected]):
        return check.failed(f"{name}_dry_run_not_ready")


def decode_offline_plan(outcome, expected_peer, name, check):
    if outcome.code not in (0, 3) or outcome.timed_out or outcome.truncated or outcome.error:
        return None, check.failed(f"{name}_dry_run_command_failed")
    try:
        payload = json.loads(outcome.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return None, check.failed(f"{name}_dry_run_output_invalid")
    if not isinstance(payload, dict) or payload.get("dry_run") is not True:
        return None, check.failed(f"{name}_dry_run_not_a_dry_run")
    if not requested_peer_matches(payload, expected_peer):
        return None, check.failed(f"{name}_dry_run_peer_mismatch")
    if type(payload.get("ready")) is not bool or not isinstance(payload.get("spoken_text"), str) or not payload["spoken_text"]:
        return None, check.failed(f"{name}_dry_run_schema_invalid")
    if outcome.code != (0 if payload["ready"] else 3):
        return None, check.failed(f"{name}_dry_run_command_failed")
    return payload, None


def decode_history(outcome, name, check):
    try:
        calls = json.loads(outcome.stdout.strip().splitlines()[-1])["calls"]
        if not isinstance(calls, list):
            raise TypeError()
        if len(calls) > 1:
            raise ValueError()
        for row in calls:
            uuid.UUID(row["call_id"])
            if not isinstance(row["status"], str):
                raise TypeError()
    except (ValueError, IndexError, KeyError, TypeError, AttributeError):
        return None, check.failed(f"{name}_history_output_invalid")
    return calls, None
