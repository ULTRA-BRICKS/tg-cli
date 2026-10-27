"""Offline audit regressions for the acceptance runner, not live call acceptance.

Uses real runner/service/preparation paths with synthetic account and process boundaries.
No credentials, external network, Telegram, Fish, or native call effects are permitted.
"""
import asyncio
import io
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

REPO = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(REPO / 'scripts'), str(REPO / 'features'), str(REPO / 'tests'), str(REPO / 'tests/support')]
from call_acceptance import (
    cli,
    deployed,
    hermetic,
    live,
    owned_processes,
    probes,
    probes_runner,
    run_claim,
)
from call_acceptance.manifest import Suite
from call_acceptance.process import Outcome, run_bounded
from call_acceptance.report import Check
from call_runner_world import DRY_RUN, INTEGRATION, World
from telegram_call_test_support import FakeEffects
from telegram_client.core import AuthStore


class OwnerProtection(unittest.TestCase):
    def test_a01_call_probe_refuses_wrong_positive_owner_before_mirror_or_audio(self):
        class ExternalEffects(FakeEffects):
            async def get_me(self):
                return SimpleNamespace(id=1001)

            async def resolve(self, *args):
                return 9999

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = AuthStore(root / 'mtproto')
            for role, ident in (('personal', 1001), ('caller', 2002)):
                store.save(role, {'expected_id': ident, 'api_id': 1, 'api_hash': 'fixture',
                                  'session': 'fixture', 'origin': 'login'})
            effects = ExternalEffects()
            result = asyncio.run(probes.call_probe(store, root, 'audit-owner-761', '0' * 64, effects=effects))
            self.assertEqual(result.get('reason'), 'RECIPIENT_UNVERIFIED')
            self.assertEqual(effects.sent, [])
            self.assertFalse({'tts', 'dial'} & set(effects.events))


def gone(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    return False


def wait_until(predicate, seconds=3):
    deadline = time.monotonic() + seconds
    while not predicate():
        if time.monotonic() >= deadline:
            return False
        time.sleep(.01)
    return True


def run_cleanup_probe(timer, readiness, script, root, test):
    if timer:
        timer.start()
        with test.assertRaises(KeyboardInterrupt):
            run_bounded([sys.executable, '-c', script], 10,
                        env={'PATH': str(root), 'PYTHONPATH': str(REPO / 'features')})
        test.assertEqual(readiness, [True])
    else:
        result = run_bounded([sys.executable, '-c', script], 1,
                             env={'PATH': str(root), 'PYTHONPATH': str(REPO / 'features')})
        test.assertTrue(result.timed_out)



def cleanup_probe_fixture(timer, previous, marker, unrelated):
    if timer:
        timer.join(timeout=4)
    signal.signal(signal.SIGALRM, previous)
    if marker.exists():
        for pid in [int(p) for p in marker.read_text().split()][:1]:
            if not gone(pid):
                os.kill(pid, signal.SIGKILL)
    unrelated.terminate()
    unrelated.wait(timeout=3)



@unittest.skipUnless(owned_processes.available(), 'Linux pidfd/subreaper cleanup required')
class DetachedCleanup(unittest.TestCase):
    def exercise(self, preparation=False, cancel=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            marker = root / 'owned.pid'
            sleeper = ("import os,signal,time; from pathlib import Path; "
                       "signal.signal(signal.SIGTERM,signal.SIG_IGN); "
                       f"Path({str(marker)!r}).write_text(str(os.getpid())+' '+str(os.getppid())); time.sleep(60)")
            if preparation:
                (root / 'voice.json').write_text('{"version":1,"provider":"host"}')
                (root / 'voice.json').chmod(0o600)
                engine = root / 'espeak-ng'
                engine.write_text('#!' + sys.executable + '\n' + sleeper + '\n')
                engine.chmod(0o700)
                script = ("import asyncio; from pathlib import Path; from telegram_client.call_service import Effects; "
                          f"asyncio.run(Effects().synthesize('fixture',Path({str(root / 'out')!r}),Path({str(root)!r})))")
            else:
                script = (f"import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',{sleeper!r}],"
                          "start_new_session=True); time.sleep(60)")
            unrelated = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], start_new_session=True)
            previous = signal.signal(signal.SIGALRM, lambda *args: (_ for _ in ()).throw(KeyboardInterrupt()))
            readiness = []
            def interrupt_when_ready():
                readiness.append(wait_until(marker.exists))
                os.kill(os.getpid(), signal.SIGALRM)
            timer = threading.Thread(target=interrupt_when_ready) if cancel else None
            try:
                run_cleanup_probe(timer, readiness, script, root, self)
                self.assertTrue(marker.exists(), 'detached worker must really start')
                owned = [int(pid) for pid in marker.read_text().split()]
                for pid in owned if preparation else owned[:1]:
                    self.assertTrue(wait_until(lambda pid=pid: gone(pid)), f'owned pid {pid} survived')
                self.assertIsNone(unrelated.poll(), 'unrelated process was signalled')
            finally:
                cleanup_probe_fixture(timer, previous, marker, unrelated)

    def test_a02_timeout_reaps_detached_child_and_preserves_unrelated_sleeper(self):
        self.exercise()

    def test_a16_exited_leader_leaves_no_detached_child_with_or_without_open_pipes(self):
        for quiet in (False, True):
            with self.subTest(quiet=quiet), tempfile.TemporaryDirectory(prefix='audit-exited-761-') as directory:
                marker = Path(directory) / 'owned.pid'
                sleeper = f"import os,time; from pathlib import Path; Path({str(marker)!r}).write_text(str(os.getpid())); time.sleep(2)"
                output = ',stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL' if quiet else ''
                parent = (f"import subprocess,sys,time; from pathlib import Path; subprocess.Popen([sys.executable,'-c',{sleeper!r}],start_new_session=True{output}); "
                          f"p=Path({str(marker)!r})\nwhile not p.exists(): time.sleep(.001)\n")
                try:
                    result = run_bounded([sys.executable, '-c', parent], 1)
                    self.assertTrue(marker.exists())
                    self.assertEqual((result.code, result.timed_out), (0, False))
                    self.assertTrue(wait_until(lambda marker=marker: gone(int(marker.read_text())), .5))
                finally:
                    if marker.exists() and not gone(int(marker.read_text())):
                        os.kill(int(marker.read_text()), signal.SIGKILL)

    def test_a03_real_preparation_worker_is_reaped_on_timeout_and_cancel(self):
        for cancel in (False, True):
            with self.subTest(cancel=cancel):
                self.exercise(preparation=True, cancel=cancel)


class ExitContracts(unittest.TestCase):
    def check_with(self, function, outcome):
        world = World(self)
        ctx = world.context()
        ctx.deployed_repo = world.installed
        ctx.run = lambda *args, **kwargs: outcome
        check = Check('exit-contract', 'exit contract', 'deployed', 'fixture')
        function(check, ctx, None)
        return check

    def test_a04_dry_run_rejects_invalid_exit_contract_and_malformed_schema(self):
        import json
        for code, payload in ((1, DRY_RUN), (3, {**DRY_RUN, 'ready': True}), (0, {'dry_run': True}),
                              (0, {**DRY_RUN, 'ready': 'yes'})):
            with self.subTest(code=code, payload=payload):
                check = self.check_with(deployed.frontdoor_dry_run, Outcome(code, json.dumps(payload), ''))
                self.assertEqual(check.status, 'fail')
        self.assertEqual(self.check_with(deployed.frontdoor_dry_run, Outcome(3, json.dumps(DRY_RUN), '')).status, 'pass')

    def test_a05_status_rejects_nonzero_even_with_current_code_and_enabled_autostart(self):
        outcome = Outcome(1, 'code: abc1234 (current)\nautostart: enabled\n', '')
        self.assertEqual(self.check_with(deployed.tg_ctl, outcome).status, 'fail')

    def test_a06_probe_rejects_good_json_from_nonzero_exit(self):
        world = World(self)
        ctx = world.context()
        ctx.run = lambda *a, **kw: Outcome(1, '{"ok":true}', '')
        result = probes_runner.run_probe(ctx, ['voice-profile'], world.installed)
        self.assertEqual(result, {'ok': False, 'error': 'PROBE_EXIT_NONZERO'})


class RequiredInventory(unittest.TestCase):
    def mutation_result(self, records):
        world = World(self)
        ctx = world.context()
        text = '\n'.join('MUTATION_RESULT ' + json.dumps(row) for row in records)
        text += '\nMUTATION_SUMMARY 8/8 baseline=pass\n'
        ctx.run = lambda *args, **kw: Outcome(0, text, '')
        check = Check('mutation', 'mutation', 'hermetic', 'fixture')
        extra = []
        hermetic.run_suite(ctx, Suite('mutation', 'tests/alpha.test.py', 'mutation', 'regression'), check, extra)
        return check, extra

    def mutation_records(self):
        expected = {'wrong-chat-accepted': 'I08', 'mirror-failure-ignored': 'I08',
                    'raw-audio-prefix-swapped': 'I02', 'parse-mode-not-literal': 'I01',
                    'token-not-enforced': 'I12', 'dial-retried': 'I11',
                    'anchor-not-edited': 'I01', 'required-scenario-deleted': 'I01'}
        return [{'name': 'baseline', 'status': 'pass', 'expected_failed_ids': [],
                 'observed_failed_ids': [], 'error_ids': [], 'reason': 'baseline_passed'}] + [
            {'name': name, 'status': 'pass', 'expected_failed_ids': [ident],
             'observed_failed_ids': [ident], 'error_ids': [], 'reason':
                'required_scenarios_missing' if name == 'required-scenario-deleted' else 'intended_assertion_failed'}
            for name, ident in expected.items()]

    def test_mutations_reject_unrelated_failure_even_with_success_summary(self):
        records = self.mutation_records()
        records[1]['observed_failed_ids'] = ['I17']
        result, _ = self.mutation_result(records)
        self.assertEqual(result.status, 'fail')

    def test_mutations_require_every_named_result_and_baseline(self):
        records = self.mutation_records()
        for missing in range(len(records)):
            with self.subTest(missing=missing):
                result, _ = self.mutation_result(records[:missing] + records[missing + 1:])
                self.assertEqual(result.status, 'fail')

    def test_mutations_export_exact_signals_as_individual_checks(self):
        result, extra = self.mutation_result(self.mutation_records())
        self.assertEqual(result.status, 'pass')
        self.assertEqual(len(extra), 9)
        self.assertEqual({c.id for c in extra}, {'hermetic.mutation.' + row['name']
                         for row in self.mutation_records()})
        self.assertEqual(extra[1].evidence['observed_failed_ids'], ['I08'])
        from call_acceptance.report import build, junit
        report = build({'utc': '2026-10-27T00:00:00Z', 'tested': {}, 'deployed': {}}, extra, ())
        document = junit(report)
        for item in extra:
            self.assertIn('name="' + item.id + '"', document)

    def test_mutations_reject_errors_and_failed_baseline(self):
        for index, patch in ((0, {'status': 'fail'}), (1, {'error_ids': ['I08']}),
                             (1, {'expected_failed_ids': ['I17']})):
            records = self.mutation_records()
            records[index].update(patch)
            result, _ = self.mutation_result(records)
            self.assertEqual(result.status, 'fail')

    def test_a07_helper_only_integration_is_not_accepted(self):
        body = "import unittest\nclass T(unittest.TestCase):\n def test_helper(self): pass\nunittest.main()\n"
        world = World(self, suites={'tiny': body})
        check = Check('inventory', 'inventory', 'hermetic', 'fixture')
        hermetic.run_suite(world.context(), Suite('tiny', 'tests/tiny.test.py', 'python', 'integration'), check, [])
        self.assertEqual((check.status, check.detail), ('fail', 'required_scenarios_missing'))
        self.assertIn('test_i01_quick_intro_exact_mirror_effect_order_and_same_anchor_edit', check.evidence['missing'])

    def test_a11_deleting_one_required_scenario_is_not_accepted(self):
        name = 'test_i01_quick_intro_exact_mirror_effect_order_and_same_anchor_edit'
        world = World(self, suites={'tiny': INTEGRATION.replace(name, 'test_removed_scenario')})
        check = Check('inventory', 'inventory', 'hermetic', 'fixture')
        hermetic.run_suite(world.context(), Suite('tiny', 'tests/tiny.test.py', 'python', 'integration'), check, [])
        self.assertEqual(check.status, 'fail')
        self.assertEqual(check.evidence['missing'], [name])

    def test_deleted_scenario_is_identified_when_discovery_control_also_fails(self):
        name = 'test_i01_quick_intro_exact_mirror_effect_order_and_same_anchor_edit'
        body = INTEGRATION.replace(name, 'test_removed_scenario').replace(
            'def test_helper(self):\n        pass',
            "def test_helper(self):\n        self.fail('missing required scenario')")
        world = World(self, suites={'tiny': body})
        check = Check('inventory', 'inventory', 'hermetic', 'fixture')
        hermetic.run_suite(world.context(), Suite('tiny', 'tests/tiny.test.py', 'python', 'integration'), check, [])
        self.assertEqual(check.detail, 'required_scenarios_missing')
        self.assertEqual(check.evidence['missing'], [name])
        from call_acceptance.mutations import detector_result
        report = {'summary': {'overall': 'fail'}, 'checks': [
            {**check.as_dict(), 'id': 'hermetic.integration.integration'}]}
        result = detector_result('required-scenario-deleted', report, Outcome(1, '', ''))
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(result['observed_failed_ids'], ['I01'])
        report['checks'][0]['evidence']['missing'].append(
            'test_i08_mirror_failures_and_wrong_chat_never_reach_tts_or_dial')
        self.assertEqual(detector_result('required-scenario-deleted', report,
                                        Outcome(1, '', ''))['status'], 'fail')

    def test_a12_mutation_manifest_requires_every_control(self):
        world = World(self)
        suite = Suite('mutation', 'tests/alpha.test.py', 'mutation', 'regression')
        for summary, expected in (('MUTATION_SUMMARY 7/8 baseline=pass', 'fail'),
                                  ('MUTATION_SUMMARY 8/8 baseline=pass', 'fail')):
            ctx = world.context()
            ctx.run = lambda *a, summary=summary, **kw: Outcome(0, summary, '')
            check = Check('mutation', 'mutation', 'hermetic', 'fixture')
            hermetic.run_suite(ctx, suite, check, [])
            self.assertEqual(check.status, expected)

    def test_mutation_detector_requires_the_expected_assertion_not_an_unrelated_error(self):
        from call_acceptance.mutations import detector_result
        def report(evidence, detail='tests_failed'):
            return {'summary': {'overall': 'fail'}, 'checks': [
                {'id': 'hermetic.integration.integration', 'detail': detail, 'evidence': evidence}]}
        for evidence in ({'assertion_failed_ids': ['I17'], 'error_ids': []},
                         {'assertion_failed_ids': [], 'error_ids': ['I08']},
                         {'assertion_failed_ids': ['I08'], 'error_ids': ['I17']}):
            result = detector_result('wrong-chat-accepted', report(evidence), Outcome(1, '', ''))
            self.assertEqual(result['status'], 'fail')
        result = detector_result('wrong-chat-accepted', report(
            {'assertion_failed_ids': ['I08'], 'error_ids': []}), Outcome(1, '', ''))
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(result['observed_failed_ids'], ['I08'])

    def test_integration_failure_evidence_keeps_only_scenario_ids(self):
        name = 'test_i08_mirror_failures_and_wrong_chat_never_reach_tts_or_dial'
        for statement, field in (("self.fail('private fixture trace')", 'assertion_failed_ids'),
                                 ("raise RuntimeError('private fixture trace')", 'error_ids')):
            body = INTEGRATION.replace(f'def {name}(self):\n        pass',
                                       f'def {name}(self):\n        {statement}')
            world = World(self, suites={'tiny': body})
            check = Check('inventory', 'inventory', 'hermetic', 'fixture')
            hermetic.run_suite(world.context(), Suite('tiny', 'tests/tiny.test.py', 'python', 'integration'), check, [])
            self.assertEqual(check.status, 'fail')
            self.assertEqual(check.evidence[field], ['I08'])
            self.assertNotIn('private fixture trace', json.dumps(check.as_dict()))



class RunClaims(unittest.TestCase):
    def execute(self, world, blocks=(), interrupt=False):
        events = []
        def boundary(check, ctx, opts):
            self.assertEqual(len(list((world.config / 'acceptance-runs').glob('*.json'))), 1)
            events.append(check.id)
            if interrupt:
                raise KeyboardInterrupt()
            check.passed('synthetic_external_boundary')
        args = ['--deployed', '--telegram', '--tts', '--call', '--run-id', 'audit-run-761']
        for block in blocks:
            args += ['--block', block]
        with mock.patch.multiple(live, sessions_online=boundary, mirror_roundtrip=boundary,
                                 tts_synthesis=boundary, call_dial=boundary):
            result = cli.main(args, ctx=world.context(), out=io.StringIO(), err=io.StringIO())
        return result, events

    @unittest.skipUnless(owned_processes.available(), 'Linux pidfd/subreaper cleanup required')
    def test_a08_same_call_run_id_is_claimed_before_any_live_effect_and_never_replayed(self):
        world = World(self)
        world.runtime_python()
        first, events = self.execute(world)
        self.assertEqual(first, 0)
        self.assertEqual(events, ['telegram.sessions_online', 'telegram.mirror_roundtrip', 'tts.synthesis', 'call.dial'])
        second, replay = self.execute(world)
        self.assertEqual((second, replay), (1, []))

    def test_a09_blocked_tts_creates_no_claim_and_starts_no_live_stage(self):
        world = World(self)
        world.runtime_python()
        result, events = self.execute(world, ['tts:tool-denied'])
        self.assertEqual((result, events), (2, []))
        self.assertFalse((world.config / 'acceptance-runs').exists())

    def test_a10_missing_runtime_creates_no_claim_and_starts_no_live_stage(self):
        world = World(self)
        result, events = self.execute(world)
        self.assertNotEqual(result, 0)
        self.assertEqual(events, [])
        self.assertFalse((world.config / 'acceptance-runs').exists())

    @unittest.skipUnless(owned_processes.available(), 'Linux pidfd/subreaper cleanup required')
    def test_a13_concurrent_claims_have_one_winner_and_private_persistent_state(self):
        world = World(self)
        world.runtime_python()
        opts = SimpleNamespace(run_id='concurrent-audit-761')
        def attempt(number):
            ctx = world.context()
            ctx.deployed_repo = world.installed
            check = Check(str(number), 'claim', 'call', 'fixture')
            run_claim.claim(check, ctx, opts)
            return check.status
        with ThreadPoolExecutor(max_workers=3) as executor:
            results = list(executor.map(attempt, range(3)))
        self.assertEqual(sorted(results), ['fail', 'fail', 'pass'])
        directory = world.config / 'acceptance-runs'
        files = list(directory.iterdir())
        self.assertEqual(len(files), 1)
        self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
        self.assertEqual(files[0].stat().st_mode & 0o777, 0o600)

    @unittest.skipUnless(owned_processes.available(), 'Linux pidfd/subreaper cleanup required')
    def test_a14_interrupted_call_run_consumes_id_and_cannot_replay_live_stages(self):
        world = World(self)
        world.runtime_python()
        first, events = self.execute(world, interrupt=True)
        self.assertEqual((first, events), (3, ['telegram.sessions_online']))
        self.assertEqual(self.execute(world), (1, []))

    def test_a17_unavailable_cleanup_blocks_claim_and_every_live_effect(self):
        world = World(self)
        world.runtime_python()
        with mock.patch.object(owned_processes, 'available', return_value=False):
            result, events = self.execute(world)
        self.assertEqual((result, events), (2, []))
        self.assertFalse((world.config / 'acceptance-runs').exists())
        ctx = world.context()
        ctx.run = mock.Mock(side_effect=AssertionError('unavailable cleanup must prevent subprocess effects'))
        with mock.patch.object(owned_processes, 'available', return_value=False), \
                mock.patch.object(live, 'available', return_value=False):
            for function in (run_claim.claim, live.sessions_online, live.mirror_roundtrip,
                             live.tts_synthesis, live.call_dial):
                with self.subTest(function=function.__name__):
                    check = Check(function.__name__, 'capability', 'call', 'fixture')
                    function(check, ctx, SimpleNamespace())
                    self.assertEqual((check.status, check.detail),
                                     ('blocked', 'owned_process_cleanup_unavailable'))
        ctx.run.assert_not_called()
        self.assertEqual(ctx.calls_attempted, 0)
        self.assertIsNone(ctx.tts_work)


if __name__ == '__main__':
    unittest.main()
