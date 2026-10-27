"""Hermetic level: run the manifest suites in a private empty HOME. No live host state is read.

Suites get a scrubbed environment (no TG_*/credentials/proxies, empty HOME and config), so the
default run can neither ring nor reach Telegram/Fish. Output is parsed strictly: a suite whose
output cannot be understood, or whose exit status disagrees with its output, FAILS.
"""
import re
import tempfile

from .report import Check
from .mutations import collect_results, scenario_ids
from .scenario_inventory import (
    REGRESSION_SCENARIO_IDS,
    REQUIRED_MUTATIONS,
    REQUIRED_SCENARIOS,
)

RESULT = re.compile(r"^(OK|FAILED)(?: \((.*)\))?$", re.MULTILINE)
RAN = re.compile(r"^Ran (\d+) tests? in [\d.]+s$", re.MULTILINE)
TEST_LINE = re.compile(r"^(test\w*) \(.+?\) \.\.\. (.*)$", re.MULTILINE)
SCENARIO = re.compile(r"^test_i(\d+[a-z]?)_")
BUN_PASS = re.compile(r"^\s*(\d+) pass$", re.MULTILINE)
BUN_FAIL = re.compile(r"^\s*(\d+) fail$", re.MULTILINE)
BUN_SKIP = re.compile(r"^\s*(\d+) (?:skip|todo)$", re.MULTILINE)


def parse_unittest(text):
    """(ran, ok, counts, tests) or None when the output is not a unittest report."""
    ran, result = RAN.search(text), RESULT.search(text)
    if not ran or not result:
        return None
    counts = {key: int(value) for key, value in (item.split("=") for item in (result.group(2) or "").split(", ") if "=" in item)}
    tests = {name: outcome.strip() for name, outcome in TEST_LINE.findall(text)}
    return int(ran.group(1)), result.group(1) == "OK", counts, tests


def parse_bun(text):
    passed, failed = BUN_PASS.search(text), BUN_FAIL.search(text)
    if not passed or not failed:
        return None
    return int(passed.group(1)), int(failed.group(1))


def suite_environment(home):
    return {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": home, "TMPDIR": home, "LANG": "C.UTF-8",
            "TG_CTL_CONFIG_DIR": f"{home}/config", "PYTHONDONTWRITEBYTECODE": "1"}


def run_suite(ctx, suite, check, tests_sink):
    path = ctx.tested_repo / suite.path
    if not path.is_file():
        return check.failed("suite_missing", suite=suite.path)
    missing = [name for name in suite.requires if ctx.which(name) is None]
    if missing:
        return check.blocked("prerequisite_missing", tools=missing, path=suite.path)
    with tempfile.TemporaryDirectory(prefix="verify-calls-home-") as home:
        env = suite_environment(home)
        env["PATH"] = f"{env['PATH']}:{ctx.env.get('PATH', '')}"
        argv, timeout = suite_command(ctx, suite, path)
        outcome = ctx.run(argv, timeout, env=env, cwd=str(ctx.tested_repo))
    label = {"label": suite.label, "kind": suite.kind, "path": suite.path}
    if outcome.timed_out:
        return check.failed("timeout", **label)
    if outcome.error or outcome.code is None:
        return check.failed("spawn_failed", **label)
    if outcome.truncated:
        return check.failed("output_unparseable", exit_code=outcome.code, **label)
    text = outcome.stderr + "\n" + outcome.stdout
    if suite.kind == "mutation":
        return _mutation_result(outcome, text, check, label, tests_sink)
    if suite.kind == "bun":
        return _bun_result(outcome, text, check, label)
    return _python_result(outcome, text, suite, check, label, tests_sink)


def _mutation_result(outcome, text, check, label, tests_sink):
    count = len(REQUIRED_MUTATIONS)
    summary = f"MUTATION_SUMMARY {count}/{count} baseline=pass"
    signals_valid = collect_results(text, tests_sink)
    if outcome.code != 0 or summary not in text.splitlines() or not signals_valid:
        return check.failed("mutation_controls_incomplete", exit_code=outcome.code, **label)
    return check.passed("all_required_mutations_killed", killed=count, **label)


def _bun_result(outcome, text, check, label):
    parsed = parse_bun(text)
    if parsed is None:
        return check.failed("output_unparseable", exit_code=outcome.code, **label)
    passed, failed = parsed
    if outcome.code != 0 or failed or not passed:
        return check.failed("tests_failed", passed=passed, failed=failed, exit_code=outcome.code, **label)
    skipped = sum(int(value) for value in BUN_SKIP.findall(text))
    if skipped:
        return check.blocked("required_tests_skipped", passed=passed, skipped=skipped, **label)
    return check.passed("ok", passed=passed, failed=0, **label)


def _python_result(outcome, text, suite, check, label, tests_sink):
    parsed = parse_unittest(text)
    if parsed is None or outcome.truncated:
        return check.failed("output_unparseable", exit_code=outcome.code, **label)
    ran, ok, counts, tests = parsed
    skipped = counts.get("skipped", 0)
    if ok != (outcome.code == 0):
        return check.failed("exit_status_disagrees_with_output", exit_code=outcome.code, **label)
    if suite.label == "integration":
        missing = missing_inventory(tests, ran, text, check, label)
        if missing is not None:
            return missing
    if not ok or not ran:
        failures = {}
        if suite.label == "integration":
            failures = {
                "assertion_failed_ids": scenario_ids(re.findall(r'^FAIL: (test\w+)', text, re.MULTILINE)),
                "error_ids": scenario_ids(re.findall(r'^ERROR: (test\w+)', text, re.MULTILINE)),
            }
        return check.failed("tests_failed", ran=ran, exit_code=outcome.code, **counts, **failures, **label)
    if suite.label == "integration":
        return _integration_result(tests, ran, skipped, check, label, tests_sink)
    if skipped:
        return check.blocked("required_tests_skipped", ran=ran, skipped=skipped, **label)
    return check.passed("ok", ran=ran, skipped=0, **label)



def _integration_result(tests, ran, skipped, check, label, tests_sink):
    if skipped or len(tests) != ran:
        return check.failed("integration_must_run_every_test_unskipped", ran=ran, skipped=skipped,
                            parsed=len(tests), **label)
    missing = sorted(set(REQUIRED_SCENARIOS) - tests.keys())
    if missing:
        return check.failed("required_scenarios_missing", missing=missing, ran=ran, **label)
    for name, outcome_text in tests.items():
        match = SCENARIO.match(name)
        if match:
            scenario = Check(f"hermetic.scenario.I{match.group(1).upper()}", name, "hermetic", "fixture")
            scenario_label = "regression" if f"I{match.group(1).upper()}" in REGRESSION_SCENARIO_IDS else "integration"
            scenario.settle("pass" if outcome_text == "ok" else "fail", "ok" if outcome_text == "ok" else outcome_text,
                            label=scenario_label)
            tests_sink.append(scenario)
    return check.passed("ok", ran=ran, skipped=0, **label)


def missing_inventory(tests, ran, text, check, label):
    # The discovery control itself fails on deletion, so inspect inventory before
    # the generic unittest failure. Preserve error IDs to reject unrelated errors.
    missing = sorted(set(REQUIRED_SCENARIOS) - tests.keys())
    if missing and len(tests) == ran:
        return check.failed("required_scenarios_missing", missing=missing, ran=ran,
                            error_ids=scenario_ids(re.findall(r'^ERROR: (test\w+)', text, re.MULTILINE)),
                            **label)


def suite_command(ctx, suite, path):
    if suite.kind != "bun":
        argv = [ctx.python, str(path)] + (["-v"] if suite.label == "integration" else [])
    else:
        argv = ["bun", "test", str(path)]
    timeout = max(ctx.timeout, 240) if suite.label == "integration" else ctx.timeout
    if suite.kind == "mutation":
        # Eight independent mutated integrations plus their unmodified baseline.
        timeout = max(ctx.timeout, 600)
    return argv, timeout
