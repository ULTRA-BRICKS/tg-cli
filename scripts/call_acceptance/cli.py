"""verify-calls orchestration: plan every requested check up front, run, report, exit.

Nothing runs unless requested. No flags = the hermetic level only (scrubbed temp HOME, no
credentials, no network, no ringing). A planned check that does not pass (including blocked and
not_run) keeps the run from being green. Usage errors exit 64 before anything runs or is written.
"""
import argparse
import json
import re
import secrets
import shutil
import signal
import sys
from pathlib import Path

from . import deployed, hermetic, live, manifest, run_claim
from .context import Context, code_digest, verification_digest
from .report import (
    BLOCKED,
    EXIT_FAILED,
    EXIT_USAGE,
    NOT_RUN,
    PASS,
    Check,
    ReportPathError,
    build,
    exit_code,
    junit,
    utc_now,
    write_create_only,
)

RUN_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{7,63}")
BLOCK = re.compile(r"(tts|telegram|call|deployed):([a-z0-9][a-z0-9_.-]{0,62})")
VOICE_ID = re.compile(r"[a-fA-F0-9]{32}")
MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}")


class UsageError(Exception):
    pass


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise UsageError(message)


def build_parser():
    p = Parser(prog="verify-calls", description=(
        "Acceptance runner for identified calls (#761). No flags = hermetic only (no live credentials, "
        "network or ringing), including required scenario inventory and mutation controls. "
        "Exit: 0 all requested checks passed, 1 failed, 2 blocked, 3 not run, 64 usage."))
    g = p.add_argument_group("levels")
    g.add_argument("--hermetic", action="store_true", help="manifest suites in a scrubbed temp HOME (default)")
    g.add_argument("--suite", action="append", choices=sorted(manifest.GROUPS), help="limit hermetic suites (repeatable)")
    g.add_argument("--deployed", action="store_true", help="read-only checks of the INSTALLED tools (metadata only)")
    g.add_argument("--telegram", action="store_true", help="LIVE: exact-self mirror send/edit/readback (no call)")
    g.add_argument("--tts", action="store_true", help="LIVE: one fresh neural synthesis through Effects().synthesize")
    g.add_argument("--call", action="store_true", help="LIVE: one call; requires all prerequisite flags, Linux pidfds, and a new durable run ID before any live stage")
    g.add_argument("--two-way", action="store_true", help="request the live two-way conversation (reported unsupported)")
    p.add_argument("--run-id", help="unique safe ID; --call consumes it permanently under CONFIG/acceptance-runs before any live stage; repeats fail without replay")
    p.add_argument("--block", action="append", default=[], metavar="CAPABILITY:REASON",
                   help="record a capability as blocked, e.g. tts:tool-denied; never run, dependents blocked")
    p.add_argument("--expect-voice-id", help="optional pinned neural voice id the profile must match")
    p.add_argument("--expect-model", help="optional pinned neural model the profile must match")
    p.add_argument("--expect-version", help="optional installed version the deployed tool must report")
    p.add_argument("--deployed-repo", help="optional checkout the installed aliases must resolve to")
    p.add_argument("--config-dir", help="tg config dir (default $TG_CTL_CONFIG_DIR or ~/.config/tg-cli)")
    p.add_argument("--source-session-idle-confirmed", action="store_true", help="operator asserts any imported session is idle")
    p.add_argument("--timeout", type=int, default=120, help="per-subprocess bound in seconds (default 120)")
    p.add_argument("--report-json", help="write a private create-only JSON report to this new path")
    p.add_argument("--report-junit", help="write a private create-only JUnit XML report to this new path")
    return p


def parse(argv):
    opts = build_parser().parse_args(argv)
    validate_options(opts)
    opts.blocks = parse_blocks(opts.block)
    if not (opts.hermetic or opts.deployed or opts.telegram or opts.tts or opts.call or opts.two_way):
        opts.hermetic = True
    opts.groups = opts.suite or list(manifest.DEFAULT_GROUPS)
    opts.run_id = opts.run_id or f"verify-{utc_now().replace('-', '').replace(':', '').lower()}-{secrets.token_hex(4)}"
    return opts


def plan(opts):
    """[(check, function)] in execution order for exactly the requested levels."""
    items = []
    if opts.hermetic:
        items.extend(hermetic_plan(opts))
    if opts.deployed:
        alias = "deployed.alias_realpath"
        for id, title, function, depends in (
                (alias, "installed aliases resolve to one checkout", deployed.alias_realpath, ()),
                ("deployed.installed_version", "installed version and SHA equal the tested source", deployed.installed_version, (alias,)),
                ("deployed.credential_metadata", "private credential files (metadata only)", deployed.credential_metadata, ()),
                ("deployed.tg_ctl", "tg-ctl daemon code current and autostart enabled", deployed.tg_ctl, ()),
                ("deployed.frontdoor_dry_run", "installed tg/call-cli dry-runs are identical", deployed.frontdoor_dry_run, (alias,)),
                ("deployed.history_read", "history is a nonmutating read through both frontdoors", deployed.history_read, (alias,)),
                ("deployed.voice_profile", "configured neural profile", deployed.voice_profile, (alias,))):
            items.append((Check(id, title, "deployed", "real", depends), function))
    claim_dependencies = ("call.run_claim",) if opts.call else ()
    if opts.call:
        required = tuple(check.id for check, _ in items)
        items.append((Check("call.run_claim", "durable exclusive run ID before live effects", "call", "real", required), run_claim.claim))
    if opts.telegram:
        items.append((Check("telegram.sessions_online", "both sessions online with verified identity", "telegram", "real", claim_dependencies), live.sessions_online))
        items.append((Check("telegram.mirror_roundtrip", "exact-self mirror send/edit/readback (INTEGRATION TEST—NO CALL)", "telegram", "real",
                            ("telegram.sessions_online", *claim_dependencies)), live.mirror_roundtrip))
    if opts.tts:
        items.append((Check("tts.synthesis", "fresh neural synthesis through Effects().synthesize", "tts", "real", claim_dependencies), live.tts_synthesis))
    if opts.call:
        items.append((Check("call.dial", "one audited call through run_call", "call", "real",
                            ("call.run_claim", "deployed.alias_realpath", "deployed.installed_version", "telegram.sessions_online",
                             "telegram.mirror_roundtrip", "tts.synthesis")), live.call_dial))
    if opts.two_way:
        items.append((Check("call.two_way", "live two-way conversation", "call", "real"), live.two_way))
    return items


def settle_preconditions(check, results, blocks):
    """True when the check may run; otherwise it is settled blocked or not_run here."""
    if check.capability in blocks:
        check.blocked(f"blocked:{blocks[check.capability]}")
        return False
    for dependency in check.depends:
        state = results.get(dependency)
        if state is None or state.status == PASS:
            continue
        if state.status == BLOCKED:
            check.blocked(f"dependency_blocked:{dependency}")
        else:
            check.settle(NOT_RUN, f"dependency_{state.status}:{dependency}")
        return False
    return True


def presettle_blocked(items, results, blocks):
    """Settle every blocked capability (and what depends on it) BEFORE any check has an effect."""
    presettle_claim(results, blocks)
    for check, _ in items:
        if check.status == BLOCKED:
            continue
        presettle_check(check, results, blocks)


def execute(opts, ctx):
    ctx.tested_sha = ctx.git(ctx.tested_repo, "rev-parse", "HEAD")
    dirty = ctx.git(ctx.tested_repo, "status", "--porcelain")
    items = plan(opts)
    checks, results, extra = [], {}, []
    for check, _ in items:
        checks.append(check)
        results[check.id] = check
    interrupted = False
    presettle_blocked(items, results, opts.blocks)
    interrupted = run_items(opts, ctx, items, checks, results)
    package = ctx.tested_repo / "package.json"
    try:
        tested_version = json.loads(package.read_text()).get("version")
    except (OSError, ValueError):
        tested_version = None
    inspected = ctx.deployed_repo is not None
    metadata = {
        "utc": utc_now(),
        "tested": {"repo": str(ctx.tested_repo), "sha": ctx.tested_sha, "version": tested_version,
                   "dirty": None if dirty is None else bool(dirty),
                   "code_sha256": code_digest(ctx.tested_repo),
                   "verification_sha256": verification_digest(ctx.tested_repo)},
        "deployed": {"inspected": inspected, "repo": str(ctx.deployed_repo) if inspected else None,
                     "sha": ctx.deployed_sha, "version": ctx.deployed_version, "code_sha256": ctx.deployed_digest},
        "interpreter": ctx.interpreter(),
        "runtimes": {"python": ctx.interpreter()["version"], "bun": ctx.bun_version() if opts.hermetic else None},
        "levels": [name for name in ("hermetic", "deployed", "telegram", "tts", "call", "two_way")
                   if getattr(opts, name)],
        "run_id": opts.run_id, "blocked_capabilities": dict(opts.blocks), "interrupted": interrupted,
        "scope_note": "fixture = fakes at external boundaries; real = installed tools / live Telegram or Fish",
    }
    return build(metadata, checks, live.UNSUPPORTED), checks


def summary(report, checks):
    lines = [f"{check.status.upper():8} {check.scope:7} {check.id} — {check.detail}" for check in checks
             if check.status != PASS or not check.id.startswith("hermetic.scenario.")]
    lines.append(f"overall: {report['summary']['overall']} (exit {report['summary']['exit_code']}); "
                 f"{report['summary']['counts']}; unsupported: {', '.join(report['unsupported_capabilities'])}")
    return "\n".join(lines)


def preflight_reports(opts):
    import os
    for path in (opts.report_json, opts.report_junit):
        if not path:
            continue
        if os.path.lexists(path):
            raise UsageError("report path already exists; reports are create-only")
        parent = Path(path).parent
        if not parent.is_dir() or parent.is_symlink() or not os.access(parent, os.W_OK):
            raise UsageError("report directory must exist and be writable without a symlink")
    if opts.report_json and opts.report_junit and opts.report_json == opts.report_junit:
        raise UsageError("report paths must differ")


def main(argv=None, ctx=None, out=sys.stdout, err=sys.stderr):
    try:
        opts = parse(sys.argv[1:] if argv is None else argv)
        preflight_reports(opts)
    except UsageError as error:
        print(f"verify-calls: usage error: {error}", file=err)
        return EXIT_USAGE
    ctx = ctx or Context(timeout=opts.timeout, config_dir=opts.config_dir)

    def terminate(signum, frame):
        raise KeyboardInterrupt()
    previous = signal.signal(signal.SIGTERM, terminate)
    try:
        report, checks = execute(opts, ctx)
    finally:
        signal.signal(signal.SIGTERM, previous)
    code = exit_code(checks)
    print(summary(report, checks), file=out)
    for path, text in ((opts.report_json, lambda: json.dumps(report, indent=2, ensure_ascii=False) + "\n"),
                       (opts.report_junit, lambda: junit(report))):
        if not path:
            continue
        try:
            write_create_only(path, text())
        except ReportPathError as error:
            print(f"verify-calls: report not written: {error}", file=err)
            code = code or EXIT_FAILED
    return code


def validate_options(opts):
    if not 1 <= opts.timeout <= 3600:
        raise UsageError("--timeout must be 1..3600")
    if opts.call and not (opts.tts and opts.telegram and opts.deployed):
        raise UsageError("--call requires --deployed --telegram --tts (verified prerequisites)")
    if opts.call and not (opts.run_id and RUN_ID.fullmatch(opts.run_id)):
        raise UsageError("--call requires a unique --run-id matching [A-Za-z0-9][A-Za-z0-9._-]{7,63}")
    if opts.run_id and not RUN_ID.fullmatch(opts.run_id):
        raise UsageError("--run-id must match [A-Za-z0-9][A-Za-z0-9._-]{7,63}")
    if opts.expect_voice_id and not VOICE_ID.fullmatch(opts.expect_voice_id):
        raise UsageError("--expect-voice-id must be 32 hex characters")
    if opts.expect_model and not MODEL.fullmatch(opts.expect_model):
        raise UsageError("--expect-model is not a model id")


def parse_blocks(values):
    blocks = {}
    for item in values:
        match = BLOCK.fullmatch(item)
        if not match:
            raise UsageError("--block takes CAPABILITY:REASON with capability tts|telegram|call|deployed")
        blocks[match.group(1)] = match.group(2)
    return blocks


def hermetic_plan(opts):
    items = []
    for group in opts.groups:
        for suite in manifest.GROUPS[group]:
            title = f"{suite.label} suite {suite.path}"
            items.append((Check(f"hermetic.{suite.label}.{suite.id}", title, "hermetic", "fixture"), suite))
    return items


def presettle_claim(results, blocks):
    claim = results.get("call.run_claim")
    if claim is not None:
        for capability in ("tts", "telegram", "deployed", "call"):
            if capability in blocks:
                claim.blocked(f"dependency_blocked:{capability}:{blocks[capability]}")
                break


def run_items(opts, ctx, items, checks, results):
    interrupted = False
    extra = []
    try:
        for check, target in items:
            if check.status != NOT_RUN:
                continue
            if not settle_preconditions(check, results, opts.blocks):
                continue
            run_item(check, target, ctx, opts, checks, results, extra)
            if check.status == NOT_RUN:
                check.failed("check_did_not_settle")
    except KeyboardInterrupt:
        interrupted = True
        for check in checks:
            if check.status == NOT_RUN:
                check.settle(NOT_RUN, "interrupted")
    finally:
        if ctx.tts_work:
            shutil.rmtree(ctx.tts_work, ignore_errors=True)
    return interrupted


def run_item(check, target, ctx, opts, checks, results, extra):
    try:
        if check.capability == "hermetic":
            hermetic.run_suite(ctx, target, check, extra)
            checks.extend(extra)
            results.update({c.id: c for c in extra})
            extra.clear()
        else:
            target(check, ctx, opts)
    except Exception as error:  # noqa: BLE001 — convert unexpected boundary failures to redacted results.
        check.failed("internal_error", error_type=type(error).__name__)


def presettle_check(check, results, blocks):
    if check.capability in blocks:
        check.blocked(f"blocked:{blocks[check.capability]}")
    else:
        blocked = [d for d in check.depends if d in results and results[d].status == BLOCKED]
        if blocked:
            check.blocked(f"dependency_blocked:{blocked[0]}")
