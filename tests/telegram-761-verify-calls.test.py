"""Acceptance runner (scripts/verify-calls.py) behavior, exercised through its real entry points.

Every run below is the real `call_acceptance.cli.main` driving REAL subprocesses (python suites, `git`,
installed-looking `tg`/`call-cli`/`tg-ctl` executables in a temporary world). Nothing here reads a
live config, reaches a network or sends anything. The runner's own manifest is NEVER executed (that
would recurse into this file): every hermetic run patches `manifest.GROUPS` to tiny temp suites, and
the recording `run` hook refuses to launch this very file.

Scenario ids (R-NN) are mapped to acceptance requirements in tests/call-integration.md.
"""
import asyncio
import io
import json
import os
import platform
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from xml.etree import ElementTree

HERE = Path(__file__).resolve()
REPO = HERE.parents[1]
sys.path.insert(0, str(REPO / "tests" / "support"))
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(REPO / "features"))
from call_acceptance import (
    cli,
    deployed,
    hermetic,
    live,
    manifest,
    owned_processes,
    probes,
    probes_runner,
    report,
)
from call_acceptance.context import Context, code_digest, installed_env
from call_acceptance.manifest import Suite
from call_acceptance.process import Outcome, run_bounded
from call_acceptance.scenario_inventory import REQUIRED_SCENARIOS
from call_runner_world import (
    CANARY,
    DRY_RUN,
    FAILING,
    FIXTURE_VALUE,
    INTEGRATION,
    INTEGRATION_WITH_SKIP,
    LEAKY,
    PASSING,
    RUN_ID,
    World,
    leaked,
)


class RunnerCase(unittest.TestCase):
    def world(self, **options):
        return World(self, **options)

    def run_main(self, world, *args, ctx=None, expect=None):
        out, err = io.StringIO(), io.StringIO()
        ctx = ctx or world.context()
        with world.patched_manifest():
            code = cli.main(list(args), ctx=ctx, out=out, err=err)
        if expect is not None:
            self.assertEqual(code, expect, (out.getvalue(), err.getvalue()))
        return code, out.getvalue(), err.getvalue()

    def report_of(self, world, *args, expect=None, ctx=None, junit=False):
        target = world.root / f"report-{len(list(world.root.glob('report-*.json')))}.json"
        extra = ["--report-junit", str(target.with_suffix(".xml"))] if junit else []
        code, out, err = self.run_main(world, *args, "--report-json", str(target), *extra, ctx=ctx, expect=expect)
        data = json.loads(target.read_text())
        data["_code"], data["_out"], data["_err"] = code, out, err
        data["_junit"] = str(target.with_suffix(".xml"))
        return data

    @staticmethod
    def by_id(data):
        return {c["id"]: c for c in data["checks"]}


class DefaultHermetic(RunnerCase):
    def test_r01_default_run_is_hermetic_only_and_reports_source_sha_version_and_runtime(self):
        world = self.world()
        data = self.report_of(world, expect=0)
        self.assertEqual(data["run"]["levels"], ["hermetic"])
        self.assertEqual(data["run"]["tested"]["sha"], world.sha())
        self.assertEqual(data["run"]["tested"]["version"], "1.2.3")
        self.assertEqual(data["run"]["tested"]["code_sha256"], code_digest(world.tested))
        self.assertRegex(data["run"]["tested"].get("verification_sha256", ""), r"^[0-9a-f]{64}$")
        self.assertEqual(data["run"]["interpreter"]["version"], platform.python_version())
        self.assertEqual(data["run"]["interpreter"]["executable"], sys.executable)
        self.assertEqual(data["run"]["runtimes"]["python"], platform.python_version())
        self.assertRegex(data["run"]["runtimes"]["bun"] or "", r"^\d+\.\d+")
        self.assertEqual(data["run"]["deployed"], {"inspected": False, "repo": None, "sha": None, "version": None, "code_sha256": None})
        self.assertEqual([c["id"] for c in data["checks"]], ["hermetic.regression.alpha", "hermetic.regression.beta"])
        self.assertEqual(data["summary"], {"overall": "pass", "exit_code": 0, "total": 2,
                                           "counts": {"pass": 2, "fail": 0, "blocked": 0, "not_run": 0}})
        self.assertEqual({c["scope"] for c in data["checks"]}, {"fixture"})
        self.assertEqual(data["checks"][0]["evidence"]["ran"], 2)
        # No installed tool, probe or live level was touched.
        self.assertEqual(world.invocations(), [])
        self.assertEqual(world.recorder.installed(world), [])
        self.assertEqual(world.recorder.live_probes(), [])

    def test_r01b_suites_see_a_scrubbed_private_home_and_no_credentials(self):
        world = self.world()
        probe = ("import os, unittest\n\nclass T(unittest.TestCase):\n    def test_env(self):\n"
                 f"        for key in {sorted(LEAKY)!r}:\n            self.assertNotIn(key, os.environ)\n"
                 f"        self.assertNotEqual(os.environ['HOME'], {str(world.home)!r})\n"
                 "        self.assertTrue(os.environ['TG_CTL_CONFIG_DIR'].startswith(os.environ['HOME']))\n"
                 "        self.assertEqual(os.listdir(os.environ['HOME']), [])\n\nunittest.main()\n")
        (world.tested / "tests" / "alpha.test.py").write_text(probe)
        world.suites = world.suites[:1]
        self.report_of(world, ctx=world.context(**LEAKY), expect=0)

    def test_r02_failure_garbage_disagreement_and_missing_suites_each_fail_the_run(self):
        cases = {
            "fails": (FAILING, "tests_failed"),
            "garbage": ("print('hello')\n", "output_unparseable"),
            "disagree": ("import sys\nsys.stderr.write('Ran 1 test in 0.001s\\n\\nOK\\n')\nsys.exit(3)\n", "exit_status_disagrees_with_output"),
            "missing": ("x", "suite_missing"),
        }
        world = self.world(suites={name: body for name, (body, _) in cases.items()})
        (world.tested / "tests" / "missing.test.py").unlink()
        data = self.report_of(world, expect=1)
        found = self.by_id(data)
        for name, (_, detail) in cases.items():
            check = found[f"hermetic.regression.{name}"]
            self.assertEqual((check["status"], check["detail"]), ("fail", detail), name)
        self.assertEqual(data["summary"]["counts"]["fail"], 4)
        self.assertEqual(data["summary"]["exit_code"], 1)
        # A failing suite's own output (here a secret-looking line) never enters the report or the console.
        self.assertNotIn(CANARY, json.dumps(data))
        self.assertNotIn(CANARY, data["_out"] + data["_err"])

    @unittest.skipUnless(owned_processes.available(), 'Linux pidfd/subreaper cleanup required')
    def test_r03_timeout_ends_the_whole_process_group_and_reports_timeout(self):
        world = self.world(suites={"slow": "x"})
        pidfile = world.tested / "tests" / "child.pid"
        (world.tested / "tests" / "slow.test.py").write_text(
            "import subprocess, time\nchild = subprocess.Popen(['sleep', '300'])\n"
            f"open({str(pidfile)!r}, 'w').write(str(child.pid))\ntime.sleep(300)\n")
        data = self.report_of(world, ctx=world.context(timeout=2), expect=1)
        check = data["checks"][0]
        self.assertEqual((check["status"], check["detail"]), ("fail", "timeout"))
        with self.assertRaises(ProcessLookupError):
            os.kill(int(pidfile.read_text()), 0)

    def test_r04_integration_suite_must_run_every_test_unskipped_and_yields_scenario_checks(self):
        world = self.world(suites={"integ": INTEGRATION})
        world.suites = (Suite("integration", "tests/integ.test.py", "python", "integration"),)
        world.group = "integration"
        data = self.report_of(world, expect=0)
        self.assertEqual([c["id"] for c in data["checks"]],
                         ["hermetic.integration.integration", *["hermetic.scenario.I" + name.split("_")[1][1:].upper() for name in REQUIRED_SCENARIOS]])
        self.assertEqual(data["checks"][0]["evidence"]["ran"], len(REQUIRED_SCENARIOS) + 1)
        self.assertEqual(data["summary"]["total"], len(REQUIRED_SCENARIOS) + 1)
        found = self.by_id(data)
        self.assertEqual(found["hermetic.scenario.I01"]["evidence"]["label"], "integration")
        self.assertEqual(found["hermetic.scenario.I18"]["evidence"]["label"], "regression")

        skipped = self.world(suites={"integ": INTEGRATION_WITH_SKIP})
        skipped.suites = (Suite("integration", "tests/integ.test.py", "python", "integration"),)
        skipped.group = "integration"
        data = self.report_of(skipped, expect=1)
        self.assertEqual(data["checks"][0]["detail"], "integration_must_run_every_test_unskipped")
        self.assertEqual(data["checks"][0]["evidence"]["skipped"], 1)

    def test_r04b_regression_dependency_skip_is_blocked_not_green(self):
        world = self.world(suites={"optional": INTEGRATION_WITH_SKIP})
        data = self.report_of(world, expect=2)
        check = data["checks"][0]
        self.assertEqual((check["status"], check["detail"]),
                         ("blocked", "required_tests_skipped"))
        self.assertEqual(check["evidence"]["skipped"], 1)

    def test_r04c_missing_integration_tool_blocks_before_suite_spawn(self):
        world = self.world(suites={"integ": INTEGRATION})
        world.suites = (Suite("integration", "tests/integ.test.py", "python", "integration", ("ffmpeg",)),)
        ctx = world.context()
        ctx.which = lambda name: None
        data = self.report_of(world, ctx=ctx, expect=2)
        self.assertEqual(data["checks"][0]["detail"], "prerequisite_missing")
        self.assertFalse(any("integ.test.py" in part for a in world.recorder.argvs for part in a))

    def test_r04d_bun_skips_and_truncated_output_never_pass(self):
        world = self.world(suites={"tiny": PASSING})
        suite = Suite("tiny", "tests/tiny.test.py", "bun", "regression")
        for text, truncated, state in ((" 2 pass\n 0 fail\n 1 skip\n", False, "blocked"),
                                       (" 2 pass\n 0 fail\n", True, "fail")):
            ctx = world.context()
            ctx.run = lambda *a, text=text, truncated=truncated, **kw: Outcome(0, "", text, truncated=truncated)
            check = report.Check("tiny", "tiny", "hermetic", "fixture")
            hermetic.run_suite(ctx, suite, check, [])
            self.assertEqual(check.status, state)

    def test_r05_selecting_an_unknown_suite_group_is_a_usage_error_that_runs_nothing(self):
        world = self.world()
        code = self.run_main(world, "--suite", "nonexistent")[0]
        self.assertEqual(code, report.EXIT_USAGE)
        self.assertEqual(world.recorder.argvs, [])

    def test_r06_the_real_manifest_names_this_file_but_the_runner_tests_never_use_it(self):
        suites = [s for group in manifest.GROUPS.values() for s in group]
        names = [suite.path for suite in suites]
        self.assertIn("tests/telegram-761-verify-calls.test.py", names)
        self.assertIn("tests/telegram-761-call-integration.test.py", names)
        for suite in suites:
            self.assertTrue((REPO / suite.path).is_file(), suite.path)
        self.assertEqual(len(names), len(set(names)))
        with self.assertRaises(AssertionError):
            self.world().recorder([sys.executable, str(HERE)], 5)

    def test_r07_output_parsers_are_strict(self):
        self.assertIsNone(hermetic.parse_unittest("nothing"))
        text = "test_a (m.T.test_a) ... ok\ntest_b (m.T.test_b) ... skipped 'x'\n\nRan 2 tests in 0.001s\n\nOK (skipped=1)\n"
        ran, ok, counts, tests = hermetic.parse_unittest(text)
        self.assertEqual((ran, ok, counts), (2, True, {"skipped": 1}))
        self.assertEqual(tests, {"test_a": "ok", "test_b": "skipped 'x'"})
        ran, ok, counts, _ = hermetic.parse_unittest("Ran 3 tests in 1.5s\n\nFAILED (failures=1, errors=1)\n")
        self.assertEqual((ran, ok, counts), (3, False, {"failures": 1, "errors": 1}))
        self.assertEqual(hermetic.parse_bun(" 4 pass\n 0 fail\n"), (4, 0))
        self.assertIsNone(hermetic.parse_bun("4 pass\n"))


class Reports(RunnerCase):
    def test_r08_json_and_junit_reports_are_private_create_only_and_match_each_other(self):
        world = self.world(suites={"good": PASSING, "bad": FAILING})
        data = self.report_of(world, expect=1, junit=True)
        json_path = world.root / "report-0.json"
        for path in (json_path, Path(data["_junit"])):
            self.assertEqual(stat.S_IMODE(path.lstat().st_mode), 0o600)
        suite = ElementTree.parse(data["_junit"]).getroot()
        self.assertEqual((suite.get("tests"), suite.get("failures"), suite.get("errors"), suite.get("skipped")), ("2", "1", "0", "0"))
        self.assertEqual(sorted(case.get("name") for case in suite.iter("testcase")), ["hermetic.regression.bad", "hermetic.regression.good"])
        failing = next(case for case in suite.iter("testcase") if case.get("name").endswith("bad"))
        self.assertEqual(failing.find("failure").get("message"), "tests_failed")
        prop = {p.get("name"): p.get("value") for p in suite.iter("property")}
        self.assertEqual(prop["tested_sha"], world.sha())
        self.assertEqual(prop["tested_code_sha256"], data["run"]["tested"]["code_sha256"])
        self.assertEqual(prop["tested_version"], "1.2.3")
        self.assertEqual(prop["deployed_version"], "None")
        self.assertEqual(prop["overall"], "fail")
        # create-only: a second run to the same path is a usage error and leaves the first report intact.
        before = json_path.read_bytes()
        code, out, err = self.run_main(world, "--report-json", str(json_path))
        self.assertEqual(code, report.EXIT_USAGE)
        self.assertIn("create-only", err)
        self.assertEqual(json_path.read_bytes(), before)
        self.assertEqual(out, "")

    def test_r09_reports_never_follow_symlinks_or_overwrite_and_directories_are_validated(self):
        world = self.world()
        victim = world.root / "victim.txt"
        victim.write_text("keep")
        link = world.root / "link.json"
        link.symlink_to(victim)
        code, _, err = self.run_main(world, "--report-json", str(link))
        self.assertEqual(code, report.EXIT_USAGE)
        self.assertEqual(victim.read_text(), "keep")
        code, _, err = self.run_main(world, "--report-json", str(world.root / "same"), "--report-junit", str(world.root / "same"))
        self.assertEqual((code, "differ" in err), (report.EXIT_USAGE, True))
        with self.assertRaisesRegex(report.ReportPathError, "REPORT_DIRECTORY_INVALID"):
            report.write_create_only(str(world.root / "missing-dir" / "x.json"), "{}")
        real = world.root / "realdir"
        real.mkdir()
        (world.root / "dirlink").symlink_to(real)
        with self.assertRaisesRegex(report.ReportPathError, "REPORT_DIRECTORY_INVALID"):
            report.write_create_only(str(world.root / "dirlink" / "x.json"), "{}")
        report.write_create_only(str(real / "ok.json"), "{}")
        with self.assertRaisesRegex(report.ReportPathError, "REPORT_EXISTS"):
            report.write_create_only(str(real / "ok.json"), "other")
        self.assertEqual((real / "ok.json").read_text(), "{}")
        self.assertEqual(sorted(p.name for p in real.iterdir()), ["ok.json"], "no temp file left behind")

    def test_r10_exit_codes_distinguish_failed_blocked_not_run_and_never_call_blocked_green(self):
        def checks(*statuses):
            result = []
            for index, status in enumerate(statuses):
                check = report.Check(f"c{index}", "t", "hermetic", "fixture")
                check.settle(status, "x")
                result.append(check)
            return result
        self.assertEqual(report.exit_code(checks("pass", "pass")), 0)
        self.assertEqual(report.exit_code(checks("pass", "blocked")), 2)
        self.assertEqual(report.exit_code(checks("pass", "not_run")), 3)
        self.assertEqual(report.exit_code(checks("blocked", "not_run")), 2)
        self.assertEqual(report.exit_code(checks("blocked", "fail", "not_run")), 1)
        self.assertEqual(report.exit_code([]), 3)
        self.assertEqual(report.overall(checks("pass", "blocked")), "incomplete_blocked")
        self.assertNotIn("skipped", report.STATUSES)
        with self.assertRaises(AssertionError):
            report.Check("x", "t", "hermetic", "fixture").settle("skipped", "x")

    def test_r11_secrets_in_evidence_and_exception_text_never_reach_any_output(self):
        for text in (leaked(), leaked("session", ": "), leaked("TOKEN", " = "), leaked("password"), leaked("api-hash", ":")):
            self.assertNotIn(CANARY, report.clean(text))
        cleaned = report.clean({"a": [leaked("secret")], "b": {"c": leaked()}, "e": RuntimeError(CANARY)})
        self.assertNotIn(CANARY, json.dumps(cleaned))
        self.assertEqual(cleaned["e"], "RuntimeError")
        check = report.Check("x", "t", "deployed", "real").failed(leaked(), detail_error=leaked("token"))
        self.assertNotIn(CANARY, json.dumps(check.as_dict()))
        self.assertEqual(report.clean("x" * 500, 20), "x" * 20)
        # An exception raised INSIDE a check becomes a fixed code + type; its text goes nowhere.
        world = self.world()

        def exploding(check, ctx, opts):
            raise RuntimeError(leaked("token") + " " + leaked())
        with mock.patch.object(deployed, "alias_realpath", exploding):
            data = self.report_of(world, "--deployed", junit=True)
        self.assertEqual(self.by_id(data)["deployed.alias_realpath"]["detail"], "internal_error")
        self.assertEqual(self.by_id(data)["deployed.alias_realpath"]["evidence"], {"error_type": "RuntimeError"})
        everything = json.dumps(data) + Path(data["_junit"]).read_text()
        self.assertNotIn(CANARY, everything)

    def test_r11b_probe_error_codes_carry_no_exception_text(self):
        from telegram_client.core import ClientError
        self.assertEqual(probes.code_of(RuntimeError(leaked())), "RuntimeError")
        self.assertEqual(probes.code_of(ClientError(leaked("token"))), "ClientError")
        self.assertEqual(probes.code_of(ClientError("TTS_PROVIDER_FAILED")), "TTS_PROVIDER_FAILED")
        for payload in ({"ok": False, "error": f"x {CANARY}"}, {"ok": False, "problems": [CANARY]}):
            for validate in (probes_runner.validate_tts, probes_runner.validate_telegram):
                self.assertNotIn(CANARY, str(validate(payload)))
        self.assertNotIn(CANARY, str(probes_runner.validate_call({"error": CANARY})))


class Usage(RunnerCase):
    def test_r12_usage_errors_exit_64_before_anything_runs_or_is_written(self):
        world = self.world()
        good = ["--deployed", "--telegram", "--tts", "--call", "--run-id", RUN_ID]
        bad = [
            ["--call"], ["--call", "--run-id", RUN_ID], ["--call", "--deployed", "--tts", "--run-id", RUN_ID],
            [*good[:-1], "short"], [*good[:-1], "has space and !"], ["--run-id", "../../etc/passwd"],
            ["--block", "tts"], ["--block", "network:denied"], ["--block", "tts:Bad Reason"],
            ["--timeout", "0"], ["--timeout", "99999"], ["--expect-voice-id", "xyz"], ["--expect-model", "bad model!"],
            ["--unknown-flag"], ["--suite", "nope"],
        ]
        for args in bad:
            code, out, err = self.run_main(world, *args)
            self.assertEqual(code, report.EXIT_USAGE, args)
            self.assertIn("usage error", err)
            self.assertEqual(out, "")
        self.assertEqual(world.recorder.argvs, [])
        self.assertEqual(list(world.root.glob("report-*")), [])

    def test_r12b_invalid_report_parent_refuses_before_any_check(self):
        world = self.world()
        code, _, _ = self.run_main(world, "--report-json", str(world.root / "missing" / "new.json"))
        self.assertEqual(code, report.EXIT_USAGE)
        self.assertEqual(world.recorder.argvs, [])

    def test_r13_help_and_import_have_no_external_or_state_effects(self):
        home = Path(tempfile.mkdtemp(prefix="verify-help-"))
        self.addCleanup(shutil.rmtree, home, True)
        work = home / "cwd"
        work.mkdir()
        before = sorted(p.name for p in home.rglob("*"))
        guard = (
            "import sys\nhits=[]\n"
            "def hook(event, args):\n"
            "    if event in ('subprocess.Popen','os.system','os.exec','os.posix_spawn','os.fork','socket.connect','socket.getaddrinfo','shutil.rmtree','os.remove','os.unlink','os.mkdir','os.rename'):\n"
            "        hits.append(event)\n"
            "    if event == 'open' and args[1] is not None and any(c in str(args[1]) for c in 'wax+'):\n"
            "        hits.append(('write-open', str(args[0])))\n"
            "sys.addaudithook(hook)\n"
            f"sys.path.insert(0, {str(REPO / 'scripts')!r})\n"
            "import call_acceptance.cli, call_acceptance.deployed, call_acceptance.live, call_acceptance.hermetic, call_acceptance.probes_runner\n"
            "import call_acceptance.probes\n"
            "print('IMPORT-HITS', hits)\n"
            "try:\n    call_acceptance.cli.main(['--help'])\nexcept SystemExit as stop:\n    print('HELP-EXIT', stop.code)\n"
            "print('FINAL-HITS', hits)\n")
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(home), "PYTHONDONTWRITEBYTECODE": "1"}
        done = subprocess.run([sys.executable, "-c", guard], capture_output=True, text=True, env=env, cwd=work,
                              timeout=60, stdin=subprocess.DEVNULL, check=False)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("IMPORT-HITS []", done.stdout)
        self.assertIn("HELP-EXIT 0", done.stdout)
        self.assertIn("usage: verify-calls", done.stdout)
        self.assertIn("FINAL-HITS []", done.stdout)
        self.assertEqual(sorted(p.name for p in home.rglob("*")), before)
        # And the real script entry point agrees (exit 0, nothing created).
        entry = subprocess.run([sys.executable, str(REPO / "scripts" / "verify-calls.py"), "--help"], capture_output=True,
                               text=True, env=env, cwd=work, timeout=60, stdin=subprocess.DEVNULL, check=False)
        self.assertEqual((entry.returncode, "--deployed" in entry.stdout, "--two-way" in entry.stdout), (0, True, True))
        self.assertEqual(sorted(p.name for p in home.rglob("*")), before)


class Deployed(RunnerCase):
    DEPLOYED = ("deployed.alias_realpath", "deployed.installed_version", "deployed.credential_metadata", "deployed.tg_ctl",
                "deployed.frontdoor_dry_run", "deployed.history_read", "deployed.voice_profile")

    def test_r14_deployed_checks_the_installed_binaries_and_records_both_hashes_distinctly(self):
        world = self.world()
        data = self.report_of(world, "--deployed", expect=0)
        found = self.by_id(data)
        deployed_checks = [c for c in data["checks"] if c["capability"] == "deployed"]
        self.assertEqual(tuple(c["id"] for c in deployed_checks), self.DEPLOYED)
        self.assertEqual({c["status"] for c in deployed_checks}, {"pass"}, [(c["id"], c["detail"]) for c in deployed_checks])
        self.assertEqual({c["scope"] for c in deployed_checks}, {"real"})
        run = data["run"]
        self.assertEqual(run["deployed"]["repo"], str(world.installed))
        self.assertEqual(run["tested"]["repo"], str(world.tested))
        self.assertNotEqual(run["tested"]["repo"], run["deployed"]["repo"])
        self.assertEqual((run["tested"]["sha"], run["deployed"]["sha"]), (world.sha(), world.sha(world.installed)))
        self.assertEqual(run["deployed"]["code_sha256"], code_digest(world.installed))
        self.assertEqual(run["deployed"]["version"], "1.2.3")
        version = found["deployed.installed_version"]["evidence"]
        self.assertEqual(version["reported_version"], "1.2.3")
        self.assertEqual(version["deployed_code_sha256"], version["tested_code_sha256"])
        self.assertEqual(found["deployed.alias_realpath"]["evidence"]["checkout"], str(world.installed))
        dry = found["deployed.frontdoor_dry_run"]["evidence"]
        self.assertEqual((dry["ready"], dry["spoken_text"]), (False, DRY_RUN["spoken_text"]))
        self.assertEqual(found["deployed.history_read"]["evidence"]["rows_seen"], {"tg": 0, "call-cli": 0})
        self.assertEqual(found["deployed.voice_profile"]["evidence"]["provider"], "fish_audio")
        self.assertIs(found["deployed.voice_profile"]["evidence"]["credentials_checked"], False)
        self.assertIs(found["deployed.credential_metadata"]["evidence"]["contents_read"], False)

    def test_r14b_exactly_the_read_only_installed_commands_ran_with_a_scrubbed_environment(self):
        world = self.world()
        self.report_of(world, "--deployed", expect=0, ctx=world.context(**LEAKY))
        self.assertEqual(sorted(world.invocations()), sorted([
            "tg --version",
            "tg call @verifycalls --say=verify-calls offline dry run --agent=verify-calls --dry-run --json",
            "call-cli @verifycalls --say=verify-calls offline dry run --agent=verify-calls --dry-run --json",
            "tg call history list --json --limit=1", "call-cli history list --json --limit=1", "tg-ctl status --dry-run"]))
        keys = set(world.invocations("env-keys.log"))
        for forbidden in LEAKY:
            self.assertNotIn(forbidden, keys)
        self.assertEqual(world.recorder.live_probes(), [])

    def test_r15_stale_deployed_code_fails_even_when_head_is_equal(self):
        world = self.world()
        (world.installed / "features" / "telegram_client" / "call_service.py").write_text("# an uncommitted edit\n")
        data = self.report_of(world, "--deployed", expect=1)
        check = self.by_id(data)["deployed.installed_version"]
        self.assertEqual(check["detail"], "deployed_code_differs_from_tested_source")
        self.assertEqual(check["evidence"]["tested_sha"], check["evidence"]["deployed_sha"])
        self.assertNotEqual(check["evidence"]["tested_code_sha256"], check["evidence"]["deployed_code_sha256"])
        self.assertNotEqual(data["run"]["tested"]["code_sha256"], data["run"]["deployed"]["code_sha256"])

    def test_r15b_a_different_installed_commit_and_a_wrong_reported_version_fail(self):
        world = self.world()
        (world.installed / "extra.txt").write_text("x")
        world.git(world.installed, "add", "-A")
        world.git(world.installed, "commit", "-q", "-m", "newer")
        data = self.report_of(world, "--deployed", expect=1)
        self.assertEqual(self.by_id(data)["deployed.installed_version"]["detail"], "deployed_sha_differs_from_tested_sha")
        self.assertNotEqual(data["run"]["tested"]["sha"], data["run"]["deployed"]["sha"])

        other = self.world()
        (other.installed / "knob-version.txt").write_text("tg 9.9.9 ")
        data = self.report_of(other, "--deployed", expect=1)
        self.assertEqual(self.by_id(data)["deployed.installed_version"]["detail"], "installed_version_differs_from_package")
        pinned = self.world()
        data = self.report_of(pinned, "--deployed", "--expect-version", "0.0.1", expect=1)
        self.assertEqual(self.by_id(data)["deployed.installed_version"]["detail"], "version_differs_from_expected")

    def test_r16_alias_failures_fail_and_dependents_are_not_run(self):
        world = self.world()
        git = world.bin / "git"
        self.assertTrue(git.is_symlink(), "the private PATH must expose the resolved Git executable")
        self.assertEqual(git.resolve(), Path(shutil.which("git")).resolve())
        result = run_bounded(["git", "-C", str(world.tested), "rev-parse", "HEAD"], 10,
                             env={**world.env(), "PATH": str(world.bin)})
        self.assertEqual((result.code, result.stdout.strip()), (0, world.sha()))
        host_bin = world.root / "host-bin"
        host_bin.mkdir()
        (host_bin / "call-cli").symlink_to(world.installed / "call-cli")
        (host_bin / "tg").symlink_to(world.installed / "tg")
        (world.bin / "call-cli").unlink()
        with mock.patch.dict(os.environ, {"PATH": f"{host_bin}:{os.environ.get('PATH', '')}"}):
            self.assertEqual(shutil.which("call-cli"), str(host_bin / "call-cli"))
            self.assertIsNone(world.context().which("call-cli"))
            self.assertEqual(world.context().which("tg"), str(world.bin / "tg"))
            self.assertNotIn(str(host_bin), world.env()["PATH"])
            data = self.report_of(world, "--deployed", expect=1)
        found = self.by_id(data)
        self.assertEqual(found["deployed.alias_realpath"]["detail"], "alias_missing:call-cli")
        for dependent in ("deployed.installed_version", "deployed.frontdoor_dry_run", "deployed.history_read", "deployed.voice_profile"):
            self.assertEqual((found[dependent]["status"], found[dependent]["detail"]), ("not_run", "dependency_fail:deployed.alias_realpath"))
        self.assertEqual(world.invocations(), ["tg-ctl status --dry-run"], "only independent checks ran")

        split = self.world()
        other = split.root / "other-install"
        shutil.copytree(split.installed, other, symlinks=True)
        (split.bin / "call-cli").unlink()
        (split.bin / "call-cli").symlink_to(other / "call-cli")
        data = self.report_of(split, "--deployed", expect=1)
        self.assertEqual(self.by_id(data)["deployed.alias_realpath"]["detail"], "aliases_resolve_to_different_checkouts")

        pinned = self.world()
        data = self.report_of(pinned, "--deployed", "--deployed-repo", str(pinned.tested), expect=1)
        self.assertEqual(self.by_id(data)["deployed.alias_realpath"]["detail"], "alias_realpath_differs_from_expected_checkout")

    def test_r17_dry_runs_must_be_identical_real_dry_runs(self):
        world = self.world()
        (world.installed / "knob-dryrun-call-cli.json").write_text(json.dumps({**DRY_RUN, "spoken_text": "different"}))
        found = self.by_id(self.report_of(world, "--deployed", expect=1))
        self.assertEqual(found["deployed.frontdoor_dry_run"]["detail"], "frontdoor_dry_runs_differ")
        for body, detail in (("not json", "tg_dry_run_output_invalid"), ('{"dry_run": false}', "tg_dry_run_not_a_dry_run"),
                             ("[]", "tg_dry_run_not_a_dry_run"),
                             (json.dumps({**DRY_RUN, "ready": False, "missing": ["tts"]}), "tg_dry_run_not_ready")):
            broken = self.world()
            (broken.installed / "knob-dryrun-tg.json").write_text(body)
            found = self.by_id(self.report_of(broken, "--deployed", expect=1))
            self.assertEqual(found["deployed.frontdoor_dry_run"]["detail"], detail)

    def test_r18_history_read_checks_row_shape_and_both_frontdoors(self):
        row = {"call_id": "11111111-1111-4111-8111-111111111111", "status": "audio_stream_ended"}
        world = self.world()
        (world.installed / "knob-history.json").write_text(json.dumps({"calls": [row]}))
        found = self.by_id(self.report_of(world, "--deployed", expect=0))
        self.assertEqual(found["deployed.history_read"]["evidence"]["rows_seen"], {"tg": 1, "call-cli": 1})
        for payload in ({"calls": [{**row, "call_id": "nope"}]}, {"calls": [row, row]}, {"calls": [{"call_id": row["call_id"], "status": 5}]},
                        {"calls": "x"}, {"rows": []}):
            broken = self.world()
            (broken.installed / "knob-history.json").write_text(json.dumps(payload))
            found = self.by_id(self.report_of(broken, "--deployed", expect=1))
            self.assertEqual(found["deployed.history_read"]["detail"], "tg_history_output_invalid", payload)

    def test_r18b_different_frontdoor_histories_cannot_pass(self):
        world = self.world()
        row = {"call_id": "11111111-1111-4111-8111-111111111111", "status": "failed"}
        (world.installed / "knob-history-other.json").write_text(json.dumps({"calls": [row]}))
        script = world.installed / "call-cli"
        script.write_text(script.read_text().replace("knob-history.json", "knob-history-other.json"))
        ctx = world.context()
        check = report.Check("history", "history", "deployed", "real")
        deployed.history_read(check, ctx, None)
        self.assertEqual((check.status, check.detail), ("fail", "frontdoor_histories_differ"))
        self.assertNotIn(row["call_id"], json.dumps(check.as_dict()))

    def test_r19_daemon_code_must_be_current_and_autostart_enabled(self):
        for text, detail in (("code: STALE (running abc, disk def)\nautostart: enabled\n", "daemon_code_stale_or_unknown"),
                             ("code: unknown\nautostart: enabled\n", "daemon_code_stale_or_unknown"),
                             ("code: abc1234 (current)\nautostart: disabled\n", "autostart_not_enabled"),
                             ("code: random words\nautostart: enabled\n", "status_output_unrecognized"),
                             ("garbage\n", "status_output_unrecognized")):
            world = self.world()
            (world.installed / "knob-status.txt").write_text(text)
            self.assertEqual(self.by_id(self.report_of(world, "--deployed", expect=1))["deployed.tg_ctl"]["detail"], detail)

    def test_r20_default_store_metadata_is_lstat_only_and_private(self):
        world = self.world()
        opened = []
        armed = threading.Event()

        def spy(event, args):
            if armed.is_set() and event == "open" and "mtproto" in str(args[0]):
                opened.append(str(args[0]))
        # An audit hook cannot be removed, so it is armed only inside this test.
        sys.addaudithook(spy)
        armed.set()
        try:
            found = self.by_id(self.report_of(world, "--deployed", expect=0))
        finally:
            armed.clear()
        self.assertEqual(opened, [], "credential files were opened")
        self.assertEqual(found["deployed.credential_metadata"]["evidence"]["modes"], {"mtproto": "0o700", "personal": "0o600", "caller": "0o600"})
        loose = self.world()
        os.chmod(loose.lab.store / "caller.json", 0o644)
        self.assertEqual(self.by_id(self.report_of(loose, "--deployed", expect=1))["deployed.credential_metadata"]["detail"], "caller_session_not_private_0600")
        os.chmod(loose.lab.store / "caller.json", 0o600)
        os.chmod(loose.lab.store, 0o755)
        self.assertEqual(self.by_id(self.report_of(loose, "--deployed", expect=1))["deployed.credential_metadata"]["detail"], "directory_not_private_0700")
        os.chmod(loose.lab.store, 0o700)
        (loose.lab.store / "personal.json").unlink()
        self.assertEqual(self.by_id(self.report_of(loose, "--deployed", expect=1))["deployed.credential_metadata"]["detail"], "personal_session_missing")
        shutil.rmtree(loose.lab.store)
        self.assertEqual(self.by_id(self.report_of(loose, "--deployed", expect=1))["deployed.credential_metadata"]["detail"], "credential_directory_missing")

    def test_r20b_config_dir_flag_selects_one_store_for_metadata_and_child_tools(self):
        world = self.world()
        other = world.root / "alt-config"
        shutil.copytree(world.config, other)
        shutil.rmtree(world.config)
        ctx = Context(tested_repo=world.tested, env={k: v for k, v in world.env().items() if k != "TG_CTL_CONFIG_DIR"},
                      run=world.recorder, timeout=60, config_dir=other)
        self.assertEqual(ctx.env["TG_CTL_CONFIG_DIR"], str(other))
        found = self.by_id(self.report_of(world, "--deployed", "--config-dir", str(other), ctx=ctx, expect=0))
        self.assertEqual(found["deployed.voice_profile"]["status"], "pass")
        self.assertEqual(found["deployed.credential_metadata"]["status"], "pass")

    def test_r21_voice_profile_must_be_a_configured_neural_voice_matching_pins(self):
        world = self.world()
        voice = json.loads((world.config / "voice.json").read_text())
        found = self.by_id(self.report_of(world, "--deployed", "--expect-voice-id", voice["voice_id"], "--expect-model", voice["model"], expect=0))
        self.assertIs(found["deployed.voice_profile"]["evidence"]["voice_expectation_given"], True)
        wrong = self.by_id(self.report_of(world, "--deployed", "--expect-voice-id", "cd" * 16, expect=1))
        self.assertEqual(wrong["deployed.voice_profile"]["detail"], "voice_id_differs_from_expected")
        wrong = self.by_id(self.report_of(world, "--deployed", "--expect-model", "other-model", expect=1))
        self.assertEqual(wrong["deployed.voice_profile"]["detail"], "model_differs_from_expected")
        (world.config / "voice.json").unlink()
        missing = self.by_id(self.report_of(world, "--deployed", expect=1))
        self.assertEqual(missing["deployed.voice_profile"]["status"], "fail")
        self.assertNotIn(voice["voice_id"], json.dumps(missing))


class LiveGates(RunnerCase):
    def test_r22_block_tts_settles_before_any_effect_and_propagates_to_the_call(self):
        world = self.world()
        args = ["--deployed", "--telegram", "--tts", "--call", "--run-id", RUN_ID, "--block", "tts:tool-denied"]
        with world.patched_manifest():
            opts = cli.parse(args)
        items = cli.plan(opts)
        results = {check.id: check for check, _ in items}
        # Settlement happens in the pre-pass: before a single subprocess has been launched.
        cli.presettle_blocked(items, results, opts.blocks)
        self.assertEqual(world.recorder.argvs, [])
        self.assertEqual((results["tts.synthesis"].status, results["tts.synthesis"].detail), ("blocked", "blocked:tool-denied"))
        self.assertEqual((results["call.dial"].status, results["call.dial"].detail), ("blocked", "dependency_blocked:call.run_claim"))
        self.assertEqual(results["telegram.sessions_online"].status, "blocked")
        self.assertEqual(results["deployed.alias_realpath"].status, "not_run")

    def test_r22b_block_tts_allows_read_only_deployed_checks_but_no_live_stage_or_claim(self):
        world = self.world()
        data = self.report_of(world, "--deployed", "--telegram", "--tts", "--call", "--run-id", RUN_ID,
                              "--block", "tts:tool-denied", junit=True)
        found = self.by_id(data)
        self.assertEqual((found["tts.synthesis"]["status"], found["tts.synthesis"]["detail"]), ("blocked", "blocked:tool-denied"))
        self.assertEqual((found["call.dial"]["status"], found["call.dial"]["detail"]), ("blocked", "dependency_blocked:call.run_claim"))
        for check in Deployed.DEPLOYED:
            self.assertEqual(found[check]["status"], "pass", (check, found[check]["detail"]))
        self.assertEqual(found["telegram.sessions_online"]["detail"], "dependency_blocked:call.run_claim")
        self.assertFalse(any("auth" in row for row in world.invocations()))
        self.assertFalse((world.config / "acceptance-runs").exists())
        self.assertEqual(world.recorder.probes("tts", "call", "telegram"), [])
        self.assertEqual(found["telegram.mirror_roundtrip"]["status"], "blocked")
        self.assertEqual(data["_code"], 2)
        self.assertEqual(data["summary"]["counts"], {"pass": 7, "fail": 0, "blocked": 5, "not_run": 0})
        self.assertNotIn("skipped", json.dumps(data["summary"]))
        suite = ElementTree.parse(data["_junit"]).getroot()
        self.assertEqual((suite.get("skipped"), suite.get("failures"), suite.get("errors")), ("0", "0", "5"))
        blocked = [c for c in suite.iter("testcase") if c.find("error") is not None and c.find("error").get("type") == "blocked"]
        self.assertEqual(sorted(c.get("name") for c in blocked), ["call.dial", "call.run_claim", "telegram.mirror_roundtrip", "telegram.sessions_online", "tts.synthesis"])

    def test_r22c_blocked_requested_checks_make_the_run_exit_2_and_run_nothing_live(self):
        world = self.world()
        data = self.report_of(world, "--deployed", "--telegram", "--tts", "--call", "--run-id", RUN_ID,
                              "--block", "tts:tool-denied", "--block", "telegram:operator-hold", expect=2)
        found = self.by_id(data)
        for check in ("telegram.sessions_online", "telegram.mirror_roundtrip", "tts.synthesis", "call.dial"):
            self.assertEqual(found[check]["status"], "blocked", check)
        self.assertEqual(found["telegram.mirror_roundtrip"]["detail"], "blocked:operator-hold")
        self.assertEqual(found["call.dial"]["detail"][:19], "dependency_blocked:")
        self.assertEqual(data["summary"]["overall"], "incomplete_blocked")
        self.assertEqual(world.recorder.live_probes(), [])
        self.assertNotIn("tg auth user status --online --json", world.invocations())
        self.assertEqual({found[c]["status"] for c in Deployed.DEPLOYED}, {"pass"})

    def test_r23_two_way_is_reported_blocked_and_never_a_pass(self):
        world = self.world()
        data = self.report_of(world, "--two-way", expect=2)
        check = self.by_id(data)["call.two_way"]
        self.assertEqual(check["status"], "blocked")
        self.assertIn("CONVERSATION_REQUIRES_IDENTIFIED_SERVICE", check["detail"])
        self.assertEqual(data["unsupported_capabilities"], ["live_two_way_conversation"])
        self.assertEqual(data["run"]["levels"], ["two_way"])
        self.assertEqual({a[0] for a in world.recorder.argvs}, {"git"}, "only the read-only source description ran")
        both = self.report_of(self.world(), "--two-way", "--hermetic", expect=2)
        self.assertEqual((both["summary"]["counts"]["pass"], both["summary"]["counts"]["blocked"]), (2, 1))

    @unittest.skipUnless(owned_processes.available(), 'Linux pidfd/subreaper cleanup required')
    def test_r24_telegram_without_a_built_runtime_fails_closed_before_any_send(self):
        world = self.world()
        found = self.by_id(self.report_of(world, "--deployed", "--telegram", expect=1))
        identity = found["telegram.sessions_online"]
        self.assertEqual((identity["status"], identity["detail"]), ("fail", "sidecar_runtime_not_built"))
        self.assertEqual(found["telegram.mirror_roundtrip"]["status"], "not_run")
        self.assertFalse(any("auth" in row for row in world.invocations()))
        self.assertEqual(world.recorder.probes("telegram"), [])

    @unittest.skipUnless(owned_processes.available(), 'Linux pidfd/subreaper cleanup required')
    def test_r24b_an_offline_or_misidentified_session_fails_and_skips_the_mirror(self):
        for auth in ({"configured": True, "online_verified": False, "user_id": 5, "expected_id": 5},
                     {"configured": True, "online_verified": True, "user_id": 6, "expected_id": 5},
                     {"configured": True, "online_verified": True, "user_id": True, "expected_id": True},
                     {"configured": False}):
            world = self.world()
            world.runtime_python()
            (world.installed / "knob-auth.json").write_text(json.dumps(auth))
            found = self.by_id(self.report_of(world, "--telegram", "--deployed", expect=1))
            self.assertEqual(found["telegram.sessions_online"]["detail"], "session_not_online_and_identity_verified", auth)
            mirror = found["telegram.mirror_roundtrip"]
            self.assertEqual((mirror["status"], mirror["detail"]), ("not_run", "dependency_fail:telegram.sessions_online"))
            self.assertEqual(world.recorder.probes("telegram"), [])

    @unittest.skipUnless(owned_processes.available(), 'Linux pidfd/subreaper cleanup required')
    def test_r25_the_call_needs_a_prior_same_run_tts_and_is_attempted_at_most_once(self):
        world = self.world()
        world.runtime_python()
        with world.patched_manifest():
            opts = cli.parse(["--deployed", "--telegram", "--tts", "--call", "--run-id", RUN_ID])
        ctx = world.context()
        check = report.Check("call.dial", "t", "call", "real")
        live.call_dial(check, ctx, opts)
        self.assertEqual((check.status, check.detail), ("fail", "no_fresh_synthesis_to_dial"))
        ctx.tts_result, ctx.tts_work, ctx.calls_attempted = {"text_sha256": "0" * 64}, str(world.root), 1
        check = report.Check("call.dial", "t", "call", "real")
        live.call_dial(check, ctx, opts)
        self.assertEqual((check.status, check.detail), ("fail", "one_call_per_run"))
        self.assertEqual(ctx.calls_attempted, 1)
        self.assertEqual(world.recorder.probes("call"), [])
        # A failed prerequisite settles the call as not_run without launching a probe.
        other = self.world()
        found = self.by_id(self.report_of(other, "--deployed", "--telegram", "--tts", "--call", "--run-id", RUN_ID))
        self.assertEqual(found["call.dial"]["status"], "not_run")
        self.assertEqual(other.recorder.probes("call"), [])

    def test_r25b_call_requires_every_prerequisite_level_and_depends_on_identity_mirror_and_tts(self):
        world = self.world()
        for args in (["--call", "--run-id", RUN_ID], ["--call", "--deployed", "--telegram", "--run-id", RUN_ID],
                     ["--call", "--deployed", "--telegram", "--tts"]):
            self.assertEqual(self.run_main(world, *args)[0], report.EXIT_USAGE, args)
        with world.patched_manifest():
            plan = cli.plan(cli.parse(["--deployed", "--telegram", "--tts", "--call", "--run-id", RUN_ID]))
            without_call = cli.plan(cli.parse(["--deployed", "--telegram", "--tts", "--run-id", RUN_ID]))
        dial = next(check for check, _ in plan if check.id == "call.dial")
        self.assertEqual(set(dial.depends), {"call.run_claim", "deployed.alias_realpath", "deployed.installed_version", "telegram.sessions_online",
                                             "telegram.mirror_roundtrip", "tts.synthesis"})
        self.assertNotIn("call.dial", [check.id for check, _ in without_call])

    def test_r26_probe_parser_refuses_arbitrary_peer_or_chat_before_any_effect(self):
        for command, required in (("telegram", []), ("tts", ["--work-dir", "/unused", "--text-kind", "check"]),
                                  ("call", ["--work-dir", "/unused", "--text-sha256", "0" * 64])):
            for flag in ("--peer", "--chat"):
                with self.subTest(command=command, flag=flag), mock.patch("sys.stderr", io.StringIO()) as err, \
                        mock.patch.object(probes, "config_dir", side_effect=AssertionError("unexpected config access")), \
                        self.assertRaises(SystemExit) as raised:
                    probes.main([command, "--run-id", RUN_ID, *required, flag, "arbitrary-recipient"])
                self.assertEqual(raised.exception.code, 2)
                self.assertIn(f"unrecognized arguments: {flag}", err.getvalue())
        args = probes.say_args("x", RUN_ID, "t", token=f"verify-calls-{RUN_ID}")
        self.assertEqual((args.peer, args.idempotency_key, args.dry_run, args.topic, args.reply_to, args.audio),
                         ("me", f"verify-calls-{RUN_ID}", False, None, None, None))

    def test_r26b_invalid_run_id_is_refused_by_the_probe_before_any_effect(self):
        buffer = io.StringIO()
        with mock.patch("sys.stdout", buffer):
            code = probes.main(["telegram", "--run-id", "bad id"])
        self.assertEqual((code, json.loads(buffer.getvalue())), (1, {"ok": False, "error": "RUN_ID_INVALID"}))


class FakeApp:
    """Fake pyrogram client for the probe's telegram round trip: records everything, forbids deletion."""

    def __init__(self, drift=None):
        self.drift, self.messages, self.calls = drift or {}, {}, []
        self.next = 500

    def __getattr__(self, name):
        if "delete" in name:
            raise AssertionError(f"forbidden call {name}")
        raise AttributeError(name)

    @staticmethod
    def message(identifier, chat, text="", reply=None):
        return type("M", (), {"id": identifier, "text": text, "reply_to_message_id": reply, "chat": type("C", (), {"id": chat})()})()

    async def send_message(self, chat_id, text, parse_mode=None, reply_to_message_id=None, disable_web_page_preview=None):
        self.next += 1
        self.messages[self.next] = {"text": text, "reply": reply_to_message_id, "chat": chat_id}
        self.calls.append(("send", chat_id, self.next))
        return self.message(self.next, chat_id)

    async def edit_message_text(self, chat_id, message_id, text, parse_mode=None, disable_web_page_preview=None):
        self.messages[message_id]["text"] = text
        self.calls.append(("edit", chat_id, message_id))
        return self.message(message_id, chat_id)

    async def get_messages(self, chat_id, ids):
        self.calls.append(("get", chat_id, tuple(ids)))
        result = []
        for number, mid in enumerate(ids):
            stored = {**self.messages[mid], **self.drift.get(number, {})}
            result.append(self.message(stored.get("id", mid), stored.get("chat", chat_id), stored["text"], stored["reply"]))
        return result


class TelegramProbe(unittest.TestCase):
    CALLER, OWNER = 2002, 1001

    def roundtrip(self, *, recipient=None, drift=None, app_class=FakeApp):
        from telegram_client import call_mirror
        from telegram_client.core import AuthStore
        recipient = self.OWNER if recipient is None else recipient
        app = app_class(drift)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        store = AuthStore(Path(directory.name) / "mtproto")
        record = {"expected_id": self.CALLER, "api_id": 1, "origin": "login"}
        record.update(api_hash=FIXTURE_VALUE, session=FIXTURE_VALUE)
        store.save("caller", record)
        store.save("personal", {**record, "expected_id": self.OWNER})
        owner = mock.Mock(get_me=mock.AsyncMock(return_value=SimpleNamespace(id=self.OWNER)))

        class Connected:
            def __init__(self, store_, role, **options):
                self.role = role

            async def __aenter__(self):
                return owner if self.role == "personal" else app

            async def __aexit__(self, *exc):
                return False

        resolve = mock.AsyncMock(return_value=recipient)
        with mock.patch("telegram_client.runtime.place_call", side_effect=AssertionError("unexpected dial")) as dial:
            result = asyncio.run(probes.telegram_roundtrip(store, Connected, resolve, call_mirror, "ParseMode.DISABLED", RUN_ID))
        owner.get_me.assert_awaited_once_with()
        resolve.assert_awaited_once_with(app, "caller", "me", store)
        dial.assert_not_called()
        return result, app

    def test_r27_a_good_round_trip_sends_two_messages_edits_the_anchor_and_reads_back_everything(self):
        result, app = self.roundtrip()
        self.assertIsNone(probes_runner.validate_telegram(result), result)
        self.assertEqual(result["count"], 2)
        anchor = result["anchor_id"]
        self.assertEqual(app.calls, [("send", self.OWNER, anchor),
                                     ("send", self.OWNER, result["message_ids"][1]),
                                     ("edit", self.OWNER, anchor),
                                     ("get", self.OWNER, tuple(result["message_ids"]))])
        self.assertIsNone(app.messages[anchor]["reply"])
        self.assertIn(probes.LABEL, app.messages[anchor]["text"])
        self.assertEqual(app.messages[result["message_ids"][1]]["reply"], anchor)
        self.assertEqual(result["message_ids"][0], anchor)
        self.assertIn("Статус: Текст отправлен", app.messages[anchor]["text"], "the anchor was edited")

    def test_r28_recipient_equal_to_the_caller_or_malformed_is_refused_before_any_message(self):
        for bad in (9999, self.CALLER, 0, -5, True):
            result, app = self.roundtrip(recipient=bad)
            self.assertEqual(result, {"ok": False, "error": "RECIPIENT_UNVERIFIED"}, bad)
            self.assertEqual(app.calls, [])

    def test_r29_any_readback_drift_fails_the_round_trip(self):
        for drift in ({0: {"text": "tampered"}}, {1: {"reply": None}}, {1: {"chat": 9999}}, {1: {"id": 1}}, {1: {"text": "x"}}):
            result, _ = self.roundtrip(drift=drift)
            self.assertIs(result["ok"], False, drift)
            failure = probes_runner.validate_telegram(result)
            self.assertTrue(failure in ("probe_failed",) or failure.startswith("READBACK_MISMATCH_"), (drift, failure))

    def test_r29b_a_transport_error_reports_the_ids_that_exist_without_deleting_or_retrying(self):
        class Failing(FakeApp):
            async def edit_message_text(self, *args, **options):
                self.calls.append(("edit-attempt",))
                raise RuntimeError(leaked())

        result, app = self.roundtrip(app_class=Failing)
        self.assertEqual(result, {"ok": False, "error": "RuntimeError", "message_ids": [501, 502], "partial": True})
        self.assertNotIn(CANARY, json.dumps(result))
        self.assertEqual([c[0] for c in app.calls], ["send", "send", "edit-attempt"], "no retry, no delete, no readback")
        self.assertEqual(probes_runner.validate_telegram(result), "RuntimeError")


def good_telegram():
    return {"ok": True, "recipient_id": 1001, "caller_id": 2002, "anchor_id": 501, "message_ids": [501, 502], "count": 2,
            "ids_verified": True, "chat_verified": True, "text_verified": True, "reply_links_verified": True,
            "edit_verified": True, "label_verified": True}


def good_tts():
    return {"ok": True, "problems": [], "provider": "fish_audio", "model": "m1", "voice_id": "ab" * 16, "latency": "balanced",
            "engine": None, "segments": 1, "text_sha256": "a" * 64, "audio_duration_ms": 3200.5, "sample_rate_hz": 24000,
            "channels": 1, "total_synth_ms": 900.0, "time_to_first_audio_byte_ms": 300.0, "clipping_ratio": 0.0,
            "peak_dbfs": -6.0, "file_mode": 0o600, "dir_mode": 0o700, "wer": None, "cer": None, "naturalness_score": None}


def good_call():
    return {"ok": True, "state": "audio_stream_ended", "saved_state": "audio_stream_ended",
            "call_id": "11111111-1111-4111-8111-111111111111", "attempt_audited": True, "mirror_ids_count": 2,
            "mirror_result": "updated", "automatic_retry": False, "audio_reused": True, "error": None, "reason": None,
            "heard_claimed": False}


class Validators(unittest.TestCase):
    @staticmethod
    def mutated(base, **changes):
        value = dict(base())
        value.update(changes)
        return value

    def test_r30_good_results_validate_and_every_invalid_variant_is_refused_with_a_fixed_code(self):
        self.assertIsNone(probes_runner.validate_telegram(good_telegram()))
        self.assertIsNone(probes_runner.validate_tts(good_tts()))
        self.assertIsNone(probes_runner.validate_call(good_call()))
        telegram = {
            "caller recipient": ({"recipient_id": 2002}, "RECIPIENT_IS_CALLER"),
            "bool recipient": ({"recipient_id": True}, "PROBE_OUTPUT_INVALID"),
            "zero recipient": ({"recipient_id": 0}, "PROBE_OUTPUT_INVALID"),
            "string id": ({"message_ids": [501, "502"]}, "PROBE_OUTPUT_INVALID"),
            "duplicate ids": ({"message_ids": [501, 501]}, "PROBE_OUTPUT_INVALID"),
            "count mismatch": ({"count": 3}, "PROBE_OUTPUT_INVALID"),
            "anchor not first": ({"anchor_id": 502}, "PROBE_OUTPUT_INVALID"),
            "three messages": ({"message_ids": [501, 502, 503], "count": 3}, "MIRROR_GROUP_SIZE_UNEXPECTED"),
            "edit unverified": ({"edit_verified": False}, "READBACK_MISMATCH_EDIT_VERIFIED"),
            "text unverified": ({"text_verified": 1}, "READBACK_MISMATCH_TEXT_VERIFIED"),
            "extra key": ({"delete": True}, "PROBE_OUTPUT_INVALID"),
            "not ok": ({"ok": False, "error": "FLOOD_WAIT"}, "FLOOD_WAIT"),
            "hostile error": ({"ok": False, "error": "x y; rm -rf"}, "probe_failed"),
        }
        for name, (change, code) in telegram.items():
            self.assertEqual(probes_runner.validate_telegram(self.mutated(good_telegram, **change)), code, name)
        missing = good_telegram()
        del missing["count"]
        self.assertEqual(probes_runner.validate_telegram(missing), "PROBE_OUTPUT_INVALID")
        for junk in (None, [], "x", 5):
            self.assertEqual(probes_runner.validate_telegram(junk), "PROBE_OUTPUT_INVALID")
            self.assertEqual(probes_runner.validate_tts(junk), "PROBE_OUTPUT_INVALID")
            self.assertEqual(probes_runner.validate_call(junk), "PROBE_OUTPUT_INVALID")

    def test_r31_tts_results_must_be_a_fresh_valid_neural_synthesis(self):
        cases = {
            "voice id short": ({"voice_id": "ab"}, "PROFILE_FIELDS_INVALID"),
            "voice id non hex": ({"voice_id": "zz" * 16}, "PROFILE_FIELDS_INVALID"),
            "voice id not string": ({"voice_id": 12}, "PROFILE_FIELDS_INVALID"),
            "empty model": ({"model": ""}, "PROFILE_FIELDS_INVALID"),
            "host provider": ({"provider": "host"}, "NOT_A_NEURAL_PROFILE_RESULT"),
            "host engine used": ({"engine": "espeak"}, "NOT_A_NEURAL_PROFILE_RESULT"),
            "problems present": ({"problems": ["HOST_ENGINE_USED"]}, "NOT_A_NEURAL_PROFILE_RESULT"),
            "nan duration": ({"audio_duration_ms": float("nan")}, "METRIC_NOT_FINITE"),
            "inf synth": ({"total_synth_ms": float("inf")}, "METRIC_NOT_FINITE"),
            "negative ttfb": ({"time_to_first_audio_byte_ms": -1}, "METRIC_NOT_FINITE"),
            "string metric": ({"clipping_ratio": "0"}, "METRIC_NOT_FINITE"),
            "zero duration": ({"audio_duration_ms": 0}, "TIMINGS_INVALID"),
            "too long": ({"audio_duration_ms": 120001}, "TIMINGS_INVALID"),
            "ttfb after total": ({"time_to_first_audio_byte_ms": 901.0}, "TIMINGS_INVALID"),
            "clipping": ({"clipping_ratio": 0.5}, "CLIPPING"),
            "low rate": ({"sample_rate_hz": 4000}, "AUDIO_FORMAT_INVALID"),
            "surround": ({"channels": 6}, "AUDIO_FORMAT_INVALID"),
            "two segments": ({"segments": 2}, "AUDIO_FORMAT_INVALID"),
            "world readable": ({"file_mode": 0o644}, "FILES_NOT_PRIVATE"),
            "open dir": ({"dir_mode": 0o755}, "FILES_NOT_PRIVATE"),
            "invented wer": ({"wer": 0.0}, "UNMEASURED_VALUE_PRESENT"),
            "invented naturalness": ({"naturalness_score": 4.5}, "UNMEASURED_VALUE_PRESENT"),
            "bad hash": ({"text_sha256": "ABC"}, "PROBE_OUTPUT_INVALID"),
            "extra key": ({"fallback": "host"}, "PROBE_OUTPUT_INVALID"),
        }
        for name, (change, code) in cases.items():
            self.assertEqual(probes_runner.validate_tts(self.mutated(good_tts, **change)), code, name)
        self.assertEqual(probes_runner.validate_tts(good_tts(), expect_voice_id="cd" * 16), "VOICE_ID_DIFFERS_FROM_EXPECTED")
        self.assertEqual(probes_runner.validate_tts(good_tts(), expect_model="other"), "MODEL_DIFFERS_FROM_EXPECTED")
        self.assertIsNone(probes_runner.validate_tts(good_tts(), expect_voice_id="ab" * 16, expect_model="m1"))
        self.assertEqual(probes_runner.validate_tts({"ok": False, "problems": ["CLIPPING", "X"]}), "CLIPPING")
        self.assertEqual(probes_runner.validate_tts({"ok": False, "problems": ["bad code"]}), "probe_failed")

    def test_r32_call_results_must_prove_one_audited_unreplayed_stream_end_without_claiming_listening(self):
        cases = {
            "bad uuid": ({"call_id": "not-a-uuid"}, "PROBE_OUTPUT_INVALID"),
            "non canonical uuid": ({"call_id": "11111111111141118111111111111111"}, "PROBE_OUTPUT_INVALID"),
            "not completed": ({"state": "timeout", "ok": False}, "CALL_NOT_COMPLETED_TIMEOUT"),
            "ok false": ({"ok": False}, "CALL_NOT_COMPLETED_AUDIO_STREAM_ENDED"),
            "hostile state": ({"state": "X;rm", "ok": False}, "CALL_NOT_COMPLETED_UNKNOWN"),
            "saved differs": ({"saved_state": "attempting"}, "CALL_AUDIT_INCOMPLETE"),
            "no audited attempt": ({"attempt_audited": False}, "CALL_AUDIT_INCOMPLETE"),
            "retry": ({"automatic_retry": True}, "CALL_AUDIT_INCOMPLETE"),
            "audio not reused": ({"audio_reused": False}, "CALL_AUDIT_INCOMPLETE"),
            "mirror not updated": ({"mirror_result": "failed"}, "CALL_AUDIT_INCOMPLETE"),
            "no mirror ids": ({"mirror_ids_count": 1}, "CALL_AUDIT_INCOMPLETE"),
            "claims heard": ({"heard_claimed": True}, "CALL_AUDIT_INCOMPLETE"),
            "extra key": ({"transcript": "x"}, "PROBE_OUTPUT_INVALID"),
        }
        for name, (change, code) in cases.items():
            self.assertEqual(probes_runner.validate_call(self.mutated(good_call, **change)), code, name)

    def test_r33_probe_json_parsing_rejects_non_finite_non_object_and_empty_output(self):
        parse = probes_runner.parse_last_json
        self.assertEqual(parse("noise\n{\"ok\": true}\n\n"), {"ok": True})
        for text in ("", "\n\n", "[1]", "5", '{"a": NaN}', '{"a": Infinity}', '{"a": -Infinity}', "{broken", "null"):
            self.assertIsNone(parse(text), text)
        self.assertIsNone(parse('{"a": 1}\nnot json'), "only the LAST line counts")

    def test_r34_probe_run_wraps_timeouts_truncation_and_garbage_into_fixed_codes(self):
        root = Path(tempfile.mkdtemp(prefix="verify-probe-"))
        self.addCleanup(shutil.rmtree, root, True)
        for outcome, code in ((Outcome(None, "", "", timed_out=True), "PROBE_TIMEOUT"),
                              (Outcome(0, "x" * 10, "", truncated=True), "PROBE_OUTPUT_INVALID"),
                              (Outcome(0, "not json", ""), "PROBE_OUTPUT_INVALID"),
                              (Outcome(None, "", "", error="SPAWN_FAILED"), "PROBE_OUTPUT_INVALID")):
            ctx = Context(tested_repo=REPO, env={"HOME": str(root), "PATH": "/usr/bin"}, run=lambda *a, _o=outcome, **k: _o)
            self.assertEqual(probes_runner.run_probe(ctx, ["voice-profile"], root), {"ok": False, "error": code})


class CallProbe(unittest.TestCase):
    """The call probe's own accounting, with the production call service replaced by a recorder."""

    def run_probe(self, *, transitions, state="audio_stream_ended", run_id=RUN_ID):
        from telegram_client import call_journal, call_service
        from telegram_client.core import AuthStore
        seen = {}
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        work = Path(directory.name)
        (work / "tts").mkdir()
        for name in ("say.wav", "tts.json"):
            (work / "tts" / name).write_bytes(b"fixture-" + name.encode())

        async def fake_run_call(store, role, args, effects=None):
            seen.update(role=role, args=args)
            audio = await effects.synthesize(probes.SAY_CALL, work / "dial-tts", work)
            seen["audio"] = Path(audio).read_bytes()
            return {"ok": True, "state": state, "saved_state": state, "call_id": "11111111-1111-4111-8111-111111111111",
                    "mirror_ids": [1, 2], "mirror_result": "updated", "automatic_retry": False}

        class FakeJournal:
            def __init__(self, root):
                pass

            def history(self, call_id=None):
                return [{"status": state, "transitions": transitions()}]

        sha = probes.hashlib.sha256(probes.SAY_CALL.encode()).hexdigest()
        store = AuthStore(work / "mtproto")
        store.save("personal", {"expected_id": 1001, "api_id": 1, "api_hash": "fixture", "session": "fixture", "origin": "login"})
        effects = mock.Mock()
        effects.connection.return_value = mock.AsyncMock()
        effects.connection.return_value.__aenter__.return_value.get_me = mock.AsyncMock(return_value=SimpleNamespace(id=1001))
        with mock.patch.object(call_service, "run_call", fake_run_call), mock.patch.object(call_journal, "Journal", FakeJournal):
            result = asyncio.run(probes.call_probe(store, work, run_id, sha, effects=effects))
        return result, seen

    def test_r35_attempt_audit_requires_an_attempting_transition_made_during_this_run(self):
        stale = lambda: [{"status": "attempting", "at": "2000-01-01T00:00:00+00:00"}]
        fresh = lambda: [{"status": "attempting", "at": "2999-01-01T00:00:00+00:00"}]
        other = lambda: [{"status": "mirrored", "at": "2999-01-01T00:00:00+00:00"}]
        result, seen = self.run_probe(transitions=fresh)
        self.assertIsNone(probes_runner.validate_call(result), result)
        self.assertEqual(seen["args"].idempotency_key, f"verify-calls-{RUN_ID}")
        self.assertEqual(seen["args"].peer, "me")
        self.assertIs(result["heard_claimed"], False)
        self.assertEqual(seen["audio"], b"fixture-say.wav", "the already validated fresh audio was dialed")
        self.assertIs(result["audio_reused"], True)
        for transitions in (stale, other):
            result, _ = self.run_probe(transitions=transitions)
            self.assertIs(result["attempt_audited"], False)
            self.assertEqual(probes_runner.validate_call(result), "CALL_AUDIT_INCOMPLETE")
        result, _ = self.run_probe(transitions=fresh, state="timeout")
        self.assertEqual(probes_runner.validate_call(result), "CALL_NOT_COMPLETED_TIMEOUT")

    def test_r36_idempotency_keys_are_unique_per_run_id_and_reused_audio_is_bound_to_one_text_once(self):
        fresh = lambda: [{"status": "attempting", "at": "2999-01-01T00:00:00+00:00"}]
        _, first = self.run_probe(transitions=fresh, run_id="verify-aaaaaaaa")
        _, second = self.run_probe(transitions=fresh, run_id="verify-bbbbbbbb")
        self.assertNotEqual(first["args"].idempotency_key, second["args"].idempotency_key)
        from telegram_client.core import ClientError
        source = Path(tempfile.mkdtemp(prefix="verify-reuse-"))
        self.addCleanup(shutil.rmtree, source, True)
        reuse = probes.ReusedSynthesis(mock.Mock(), source, "0" * 64)
        with self.assertRaises(ClientError) as raised:
            asyncio.run(reuse.synthesize("different text", source / "out", source))
        self.assertEqual(str(raised.exception), "AUDIO_REUSE_MISMATCH")
        self.assertEqual(reuse.used, 0)


class Interruption(RunnerCase):
    @unittest.skipUnless(owned_processes.available(), 'Linux pidfd/subreaper cleanup required')
    def test_r37_sigterm_stops_the_run_ends_the_suite_group_and_leaves_checks_not_run(self):
        world = self.world(suites={"slow": "x", "zlast": PASSING})
        pidfile = world.tested / "tests" / "child.pid"
        (world.tested / "tests" / "slow.test.py").write_text(
            "import subprocess, time\nchild = subprocess.Popen(['sleep', '300'])\n"
            f"from pathlib import Path\nPath({str(pidfile)!r}).write_text(str(child.pid))\ntime.sleep(300)\n")
        previous = signal.getsignal(signal.SIGTERM)
        handler_active, stop, sent = threading.Event(), threading.Event(), threading.Event()
        ctx = world.context(timeout=12)
        original_git = ctx.git

        def slow_git(*args):
            if not handler_active.is_set():
                self.assertTrue(callable(signal.getsignal(signal.SIGTERM)))
                self.assertIsNot(signal.getsignal(signal.SIGTERM), previous)
                handler_active.set()
                time.sleep(3)
            return original_git(*args)

        def interrupt_when_ready():
            deadline = time.monotonic() + 10
            while not stop.wait(0.01) and time.monotonic() < deadline:
                if handler_active.is_set() and pidfile.exists() and pidfile.read_text().strip():
                    if signal.getsignal(signal.SIGTERM) is not previous:
                        sent.set()
                        os.kill(os.getpid(), signal.SIGTERM)
                    return

        worker = threading.Thread(target=interrupt_when_ready)
        started = time.monotonic()
        worker.start()
        try:
            with mock.patch.object(ctx, "git", side_effect=slow_git):
                data = self.report_of(world, ctx=ctx)
        finally:
            stop.set()
            worker.join(timeout=1)
        self.assertFalse(worker.is_alive(), "no delayed signal may outlive the test")
        self.assertTrue(sent.is_set(), "child-ready handshake failed; no SIGTERM was sent")
        self.assertLess(time.monotonic() - started, 60)
        self.assertIs(data["run"]["interrupted"], True)
        self.assertEqual(data["_code"], report.EXIT_NOT_RUN)
        found = self.by_id(data)
        self.assertEqual(found["hermetic.regression.slow"]["status"], "not_run")
        self.assertEqual(found["hermetic.regression.zlast"]["detail"], "interrupted")
        self.assertNotIn("pass", {c["status"] for c in data["checks"]})
        with self.assertRaises(ProcessLookupError):
            os.kill(int(pidfile.read_text()), 0)
        self.assertEqual(signal.getsignal(signal.SIGTERM), previous, "the previous SIGTERM handler is restored")


class Contexts(unittest.TestCase):
    def test_r38_installed_env_passes_only_locating_variables(self):
        env = installed_env({"PATH": "/p", "HOME": "/h", **LEAKY, "TG_CTL_CONFIG_DIR": "/c", "LANG": "C"})
        self.assertEqual(env, {"PATH": "/p", "HOME": "/h", "TG_CTL_CONFIG_DIR": "/c", "LANG": "C"})

    def test_r39_code_digest_changes_with_any_call_surface_file_and_ignores_runtime_noise(self):
        root = Path(tempfile.mkdtemp(prefix="verify-digest-"))
        self.addCleanup(shutil.rmtree, root, True)
        (root / "features" / "telegram_client").mkdir(parents=True)
        (root / "features" / "user-account").mkdir()
        (root / "tg").write_text("a")
        (root / "requirements-call.txt").write_text("dependency==1")
        (root / "features" / "telegram_client" / "x.py").write_text("1")
        (root / "features" / "user-account" / "y.ts").write_text("1")
        base = code_digest(root)
        self.assertRegex(base, r"^[0-9a-f]{64}$")
        (root / "features" / "telegram_client" / "__pycache__").mkdir()
        (root / "features" / "telegram_client" / "__pycache__" / "x.pyc").write_text("junk")
        (root / "invocations.log").write_text("noise")
        self.assertEqual(code_digest(root), base)
        for path in (root / "tg", root / "requirements-call.txt", root / "features" / "telegram_client" / "x.py", root / "features" / "user-account" / "y.ts"):
            original = path.read_text()
            path.write_text(original + "!")
            self.assertNotEqual(code_digest(root), base, path.name)
            path.write_text(original)
        (root / "features" / "telegram_client" / "new.py").write_text("")
        self.assertNotEqual(code_digest(root), base)
        self.assertIsNone(code_digest(root / "nowhere"))

    @unittest.skipUnless(owned_processes.available(), 'Linux pidfd/subreaper cleanup required')
    def test_r40b_timeout_kills_descendant_that_ignores_term_after_leader_exits(self):
        child = "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print('ready',flush=True); time.sleep(60)"
        parent = ("import subprocess,sys,time; child=subprocess.Popen([sys.executable,'-c'," + repr(child) +
                  "],stdout=subprocess.PIPE); child.stdout.readline(); time.sleep(60)")
        def alarm(signum, frame):
            raise TimeoutError("group cleanup left a pipe-holding descendant")
        previous = signal.signal(signal.SIGALRM, alarm)
        try:
            signal.alarm(6)
            outcome = run_bounded([sys.executable, "-c", parent], 1)
            self.assertTrue(outcome.timed_out)
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, previous)

    def test_r40_bounded_runner_closes_stdin_caps_time_and_reports_spawn_failure(self):
        done = run_bounded([sys.executable, "-c", "import sys; print(repr(sys.stdin.read()))"], 20)
        self.assertEqual((done.code, done.stdout.strip()), (0, "''"), "stdin is closed, never inherited")
        self.assertTrue(run_bounded([sys.executable, "-c", "import time; time.sleep(60)"], 1).timed_out)
        self.assertEqual(run_bounded(["/nonexistent/binary"], 5).error, "SPAWN_FAILED")
        echoed = run_bounded([sys.executable, "-c", "import sys; print(sys.stdin.read().upper())"], 20, input="hi")
        self.assertEqual(echoed.stdout.strip(), "HI")


if __name__ == "__main__":
    unittest.main()
