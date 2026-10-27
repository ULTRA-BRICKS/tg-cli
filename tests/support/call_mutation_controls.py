#!/usr/bin/env python3
"""Red-first controls: break production in a COPY of this checkout, require the suite to fail.

    python3 tests/support/call_mutation_controls.py [NAME ...]    (default: all)

Each mutation removes one guarantee the hermetic call integration suite claims to enforce
(exact mirror peer, mirror failure blocks dial, raw-audio prefix order, literal parse mode,
one-shot tokens, no redial, same-anchor edit). The suite must exit nonzero for every mutant; the checkout is untouched.
Exit 0 only if every mutant is killed.
"""
import os
import json
import shutil
import sys
import tempfile
from pathlib import Path

SRC = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SRC / "scripts"))
from call_acceptance.process import run_bounded
from call_acceptance.scenario_inventory import REQUIRED_MUTATIONS
from call_acceptance.mutations import PREFIX, detector_result

SERVICE = "features/telegram_client/call_service.py"
MIRROR = "features/telegram_client/call_mirror.py"
JOURNAL = "features/telegram_client/call_journal.py"
MUTATIONS = {
    "wrong-chat-accepted": (MIRROR, "if message.chat.id != recipient or not isinstance(message.id, int) or message.id <= 0:", "if False:"),
    "mirror-failure-ignored": (SERVICE, '            await call_mirror.mirror(app, recipient, record, save, effects.parse_mode(), getattr(args, "reply_to", None))',
                               '            try:\n                await call_mirror.mirror(app, recipient, record, save, effects.parse_mode(), getattr(args, "reply_to", None))\n            except Exception:\n                pass'),
    "raw-audio-prefix-swapped": (SERVICE, "effects.join_audio(audio, args.audio, directory)", "effects.join_audio(args.audio, audio, directory)"),
    "parse-mode-not-literal": (MIRROR, "recipient, text, parse_mode=parse_mode, reply_to_message_id=reply,", 'recipient, text, parse_mode="ParseMode.MARKDOWN", reply_to_message_id=reply,'),
    "token-not-enforced": (JOURNAL, '(call_id, token, at, "intent"', '(call_id, None, at, "intent"'),
    "dial-retried": (SERVICE, '            await effects.dial(store, role, recipient, audio, args.timeout, idle)\n            record = persist("audio_stream_ended", required=False)',
                     '            try:\n                await effects.dial(store, role, recipient, audio, args.timeout, idle)\n            except TimeoutError:\n                await effects.dial(store, role, recipient, audio, args.timeout, idle)\n            record = persist("audio_stream_ended", required=False)'),
    "anchor-not-edited": (MIRROR, "app.edit_message_text(", "app.send_message("),
    "required-scenario-deleted": ("tests/telegram-761-call-integration.test.py", 'if __name__ == "__main__":',
        'delattr(SuccessfulOneShot, "test_i01_quick_intro_exact_mirror_effect_order_and_same_anchor_edit")\nif __name__ == "__main__":'),
}


def run_integration(repo, name, env=None):
    with tempfile.TemporaryDirectory(prefix="tg-mutation-report-") as folder:
        report_path = Path(folder) / "result.json"
        run = run_bounded([sys.executable, str(repo / "scripts/verify-calls.py"),
                           "--hermetic", "--suite", "integration", "--report-json", str(report_path)],
                          300, env=env)
        try:
            report = json.loads(report_path.read_text())
        except (OSError, ValueError):
            report = {}
    result = detector_result(name, report, run)
    print(PREFIX + json.dumps(result, sort_keys=True), flush=True)
    return result["status"] == "pass"


def kill(name):
    path, old, new = MUTATIONS[name]
    with tempfile.TemporaryDirectory(prefix="tg-mutant-") as folder:
        copy = Path(folder) / "repo"
        shutil.copytree(SRC, copy, symlinks=True, ignore=shutil.ignore_patterns(
            ".git", ".worktrees", "node_modules", "__pycache__"))
        target = copy / path
        text = target.read_text()
        if old not in text:
            raise SystemExit(f"{name}: mutation anchor not found in {path}")
        target.write_text(text.replace(old, new, 1))
        env = dict(os.environ, TG_CALL_REPO=str(copy))
        return run_integration(copy, name, env)


if __name__ == "__main__":
    if set(MUTATIONS) != set(REQUIRED_MUTATIONS):
        raise SystemExit("required mutation inventory differs")
    names = sys.argv[1:] or list(REQUIRED_MUTATIONS)
    unknown = sorted(set(names) - MUTATIONS.keys())
    if unknown:
        raise SystemExit("unknown mutation: " + ", ".join(unknown))
    missing = [name for name in ("bun", "ffmpeg") if shutil.which(name) is None]
    if missing:
        print("BLOCKED: prerequisite missing: " + ", ".join(missing))
        raise SystemExit(2)
    if not run_integration(SRC, "baseline"):
        print("INCONCLUSIVE: unmodified integration baseline must pass first")
        raise SystemExit(2)
    results = [kill(name) for name in names]
    print(f"MUTATION_SUMMARY {sum(results)}/{len(REQUIRED_MUTATIONS)} baseline=pass")
    sys.exit(0 if all(results) else 1)
