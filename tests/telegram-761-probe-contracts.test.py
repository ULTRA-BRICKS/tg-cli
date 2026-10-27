"""Offline deployed/probe contracts; real plans, temporary metadata, mocked effects only.

Reached by the #761 Python manifest and Bun wrapper. No credentials are opened and no
network, synthesis or call boundary is allowed; nonzero children can never become green.
"""
import copy
import json
import io
from pathlib import Path
import sys
import unittest
from types import SimpleNamespace
from unittest import mock

REPO = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(REPO / 'scripts'), str(REPO / 'features'), str(REPO / 'tests' / 'support')]
from call_acceptance import cli as runner_cli, deployed, live, probes_runner
from call_acceptance.process import Outcome
from call_acceptance.process import run_bounded
from call_acceptance.report import Check
from call_lab import CallLab
from call_runner_world import World
from telegram_client import cli
from telegram_client.core import AuthStore

CANARY = 'SECRET_CANARY_761'


def check():
    return Check('contract', 'contract', 'deployed', 'fixture')


class ProbeContracts(unittest.TestCase):
    def setUp(self):
        self.lab = CallLab(accounts=('personal', 'caller'))
        self.addCleanup(self.lab.__exit__)
        args = cli.parser('caller').parse_args(['call', '--peer', '@verifycalls',
            '--say', 'verify-calls offline dry run', '--agent', 'verify-calls', '--dry-run'])
        with mock.patch.object(AuthStore, 'load', side_effect=AssertionError('auth read')), \
             mock.patch('telegram_client.tts_config.resolve_credential', side_effect=AssertionError('secret read')):
            self.plan = cli.call_plan(AuthStore(self.lab.store), 'caller', args,
                                      which=lambda _: '/fixture/tool', find_spec=lambda _: object())
        self.ctx = SimpleNamespace(home=self.lab.home, env={'HOME': str(self.lab.home)},
                                   python=sys.executable, timeout=5, deployed_repo=REPO)

    def frontdoors(self, payload=None, code=3, second=None):
        payload = self.plan if payload is None else payload
        outcomes = [Outcome(code, json.dumps(p), '') for p in (payload, second or payload)]
        self.ctx.run = mock.Mock(side_effect=outcomes)
        return deployed.frontdoor_dry_run(check(), self.ctx, SimpleNamespace())

    def probe(self, payload, code=1):
        text = payload if isinstance(payload, str) else json.dumps(payload)
        self.ctx.run = mock.Mock(return_value=Outcome(code, text, CANARY))
        return probes_runner.run_probe(self.ctx, ['telegram'], REPO)

    def test_real_healthy_offline_plan_passes_without_claiming_readiness(self):
        self.assertFalse(self.plan['ready'])
        self.assertEqual(set(self.plan['missing']), {'session_identity_unverified',
            'source_session_origin_unverified'})
        result = self.frontdoors()
        self.assertEqual(result.status, 'pass', result.as_dict())
        self.assertEqual(result.evidence['exit_code'], 3)
        self.assertIs(result.evidence['ready'], False)
        self.assertIn('offline', result.detail)
        self.assertIn('identity_unverified', result.detail)
        self.assertIn('not_ready_to_ring', result.detail)

    def test_status_on_current_source_preserves_config_without_schema_or_modeline(self):
        config = self.lab.config / 'config.yaml'
        config.write_text('control:\n  topics: false\n  private_topics: false\n')
        (self.lab.config / '.env').write_text('TG_BOT_TOKEN=123:fixture\nTG_CHAT_ID=456\n')
        before = {p.name: (p.read_bytes(), p.stat().st_mtime_ns)
                  for p in self.lab.config.iterdir() if p.is_file()}
        commands, outputs = [], []
        def run(argv, timeout, **options):
            commands.append(argv)
            outcome = run_bounded(argv, timeout, **options)
            outputs.append(outcome)
            return outcome
        self.ctx.env = {key: value for key, value in self.lab.environment().items()
                        if key in ('PATH', 'HOME', 'TMPDIR', 'TG_CTL_CONFIG_DIR', 'TMUX_TMPDIR')}
        self.ctx.which = lambda name: str(REPO / name)
        self.ctx.run = run
        deployed.tg_ctl(check(), self.ctx, SimpleNamespace())
        self.assertEqual(outputs[0].code, 0, outputs[0].stderr)
        self.assertIn('tg-ctl: not running', outputs[0].stdout)
        self.assertIn('autostart:', outputs[0].stdout)
        after = {p.name: (p.read_bytes(), p.stat().st_mtime_ns)
                 for p in self.lab.config.iterdir() if p.is_file()}
        self.assertEqual(after, before, 'status must not rewrite config or install schema metadata')
        self.assertEqual(commands, [[str(REPO / 'tg-ctl'), 'status', '--dry-run']])

    def test_exit_ready_pair_and_guards(self):
        for code in (0, 1, 137, -9):
            with self.subTest(code=code):
                self.assertEqual(self.frontdoors(code=code).status, 'fail')
        for patch in ({'ready': 0}, {'ready': True}, {'dry_run': 1},
                      {'spoken_text': ''}, {'session_checks': {}}, {'missing': []}):
            with self.subTest(patch=patch):
                self.assertEqual(self.frontdoors({**self.plan, **patch}).status, 'fail')
        for component in ('session', 'ffmpeg', 'call_libraries', 'tts', 'unknown_identity_unverified'):
            plan = copy.deepcopy(self.plan)
            plan['missing'].append(component)
            plan['missing_reasons'].append({'component': component, 'code': component})
            self.assertEqual(self.frontdoors(plan).status, 'fail', component)
        plan = copy.deepcopy(self.plan)
        plan['missing_reasons'][0]['code'] = 'WRONG_STATUS'
        self.assertEqual(self.frontdoors(plan).status, 'fail')
        plan = copy.deepcopy(self.plan)
        plan['session_checks']['identity_verified'] = 0
        self.assertEqual(self.frontdoors(plan).status, 'fail')

    def test_ready_true_cannot_hide_unverified_reasons(self):
        self.assertEqual(self.frontdoors({**self.plan, 'ready': True}, code=0).status, 'fail')

    def test_real_runner_accepts_healthy_offline_fixture(self):
        world = World(self)
        target = world.root / 'contracts-report.json'
        with world.patched_manifest():
            code = runner_cli.main(['--deployed', '--report-json', str(target)],
                ctx=world.context(), out=io.StringIO(), err=io.StringIO())
        result = json.loads(target.read_text())
        self.assertEqual(code, 0, result['checks'])
        dry = next(c for c in result['checks'] if c['id'] == 'deployed.frontdoor_dry_run')
        self.assertEqual(dry['status'], 'pass')
        self.assertEqual(dry['evidence']['exit_code'], 3)
        self.assertIs(dry['evidence']['ready'], False)
        self.assertEqual(world.recorder.live_probes(), [])

    def test_frontdoors_must_agree(self):
        result = self.frontdoors(second={**self.plan, 'spoken_text': 'different'})
        self.assertEqual(result.detail, 'frontdoor_dry_runs_differ')

    def test_missing_or_wrong_requested_peer_fails(self):
        for peer in (None, '@other', 'me'):
            plan = copy.deepcopy(self.plan)
            if peer is None:
                del plan['peer']
            else:
                plan['peer'] = peer
            with self.subTest(peer=peer):
                self.assertEqual(self.frontdoors(plan).status, 'fail')

    def test_partial_failure_survives_nonzero_with_fixed_reason(self):
        result = self.probe({'ok': False, 'error': 'FLOOD_WAIT', 'message_ids': [501], 'partial': True})
        self.assertEqual(result, {'ok': False, 'error': 'PROBE_EXIT_NONZERO',
                                 'reason': 'FLOOD_WAIT', 'message_ids': [501], 'partial': True})
        self.ctx.run = mock.Mock(return_value=Outcome(1, json.dumps({'ok': False,
            'error': 'FLOOD_WAIT', 'message_ids': [501], 'partial': True}), ''))
        with mock.patch.object(live, 'available', return_value=True), \
             mock.patch.object(live, 'runtime_python', return_value=sys.executable):
            result = live.mirror_roundtrip(check(), self.ctx,
                SimpleNamespace(run_id='verify-contracts', source_session_idle_confirmed=False))
        self.assertEqual(result.status, 'fail')
        self.assertEqual(result.evidence, {'message_ids': [501], 'partial': True})

    def test_nonzero_success_never_passes(self):
        self.assertEqual(self.probe({'ok': True, 'message_ids': [501]}),
                         {'ok': False, 'error': 'PROBE_EXIT_NONZERO'})

    def test_malformed_and_secret_failure_bodies_are_sanitized(self):
        for payload in ('{broken', '[' * 1500, ' ' * 65537, {'ok': False, 'error': CANARY},
                        {'ok': False, 'error': 'FLOOD_WAIT', 'log': CANARY},
                        {'ok': False, 'error': 'token=' + CANARY},
                        {'ok': False, 'error': 'FLOOD_WAIT', 'message_ids': [True, -1, CANARY]}):
            with self.subTest(payload=payload):
                result = self.probe(payload)
                self.assertIs(result['ok'], False)
                self.assertNotIn(CANARY, json.dumps(result))
                self.assertNotIn('message_ids', result)

    def test_zero_failure_stays_failure_and_sanitized(self):
        result = self.probe({'ok': False, 'error': 'FLOOD_WAIT', 'message_ids': [501], 'partial': True}, code=0)
        self.assertIs(result['ok'], False)
        self.assertEqual(result['error'], 'FLOOD_WAIT')
        self.assertEqual(result['message_ids'], [501])
        self.assertNotIn(CANARY, json.dumps(self.probe({'ok': False, 'error': CANARY}, code=0)))


if __name__ == '__main__':
    unittest.main()
