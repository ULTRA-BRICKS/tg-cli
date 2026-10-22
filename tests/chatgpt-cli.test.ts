import { describe, expect, test } from 'bun:test';
import { EXIT_OK, EXIT_PM_ERROR, EXIT_UNAVAILABLE, EXIT_UNCERTAIN, EXIT_USAGE, runChatgptCli } from '../features/chatgpt/cli';
import { errEnvelope, fakePm, SESSIONS_FIXTURE, type FakeHandler } from './helpers/fake-pm';

const REQUEST = { request_id: 'req-1', status: 'pending', action: 'pause', workspace: 'home', chat: 'c1', expected_turn: null, expires_at: 1_790_000_900 };

async function cli(argv: string[], handlers: Record<string, FakeHandler> = {}) {
  const pm = fakePm(handlers);
  const res = await runChatgptCli(argv, { run: pm.run });
  return { ...res, calls: pm.calls };
}

describe('help and usage', () => {
  test('help topics print usage on stdout, exit 0, no pm call', async () => {
    for (const argv of [['help'], ['--help'], []]) {
      const r = await cli(argv);
      expect(r.exitCode).toBe(EXIT_OK);
      expect(r.stdout).toContain('tg chatgpt');
      expect(r.stdout).toContain('continue');
      expect(r.calls).toHaveLength(0);
    }
  });
  test.each([
    [['bogus']],
    [['list', '--workspace', 'nope']],
    [['list', '--bogus']],
    [['list', 'extra']],
    [['show', 'home']],
    [['show', 'home', 'c', 'extra']],
    [['show', 'other', 'c']],
    [['show', 'home', '--evil']],
    [['show', 'home', '-x']],
    [['show', 'home', 'bad chat!']],
    [['show', 'home', 'a'.repeat(200)]],
    [['pause', 'all', 'c']],
    [['continue', 'all', 'c']],
    [['service', 'start', 'all']],
    [['service', 'restart', 'home']],
    [['service', 'start']],
    [['connector']],
    [['connector', 'request']],
    [['connector', 'request', 'evil']],
    [['connector', 'list', 'x']],
    [['requests', 'a', 'b']],
    [['requests', 'bad id!']],
    [['accounts', 'x']],
    [['api', 'sessions.list']],
    [['--params', '{}']],
    [['watch', 'home']],
  ])('usage error %j exits 2 on stderr and never calls pm', async (argv) => {
    const r = await cli(argv);
    expect(r.exitCode).toBe(EXIT_USAGE);
    expect(r.stdout).toBe('');
    expect(r.stderr.length).toBeGreaterThan(0);
    expect(r.calls).toHaveLength(0);
  });
});

describe('command to PM method mapping', () => {
  test('accounts', async () => {
    const r = await cli(['accounts'], { 'accounts.list': () => ({ accounts: [{ workspace: 'home', configured: true, service: { active: 'active' }, monitor: { ok: true, sessions: 1, running: 1 } }] }) });
    expect(r.exitCode).toBe(0);
    expect(r.calls.map((c) => [c.method, c.params])).toEqual([['accounts.list', {}]]);
    expect(r.stdout).toContain('home');
  });
  test('list defaults to all workspaces and renders every account separately', async () => {
    const r = await cli(['list'], { 'sessions.list': () => SESSIONS_FIXTURE });
    expect(r.calls[0]).toMatchObject({ method: 'sessions.list', params: { workspace: 'all' } });
    expect(r.stdout).toContain('home');
    expect(r.stdout).toContain('glide.vc');
    // same chat id lives in two accounts — both rows stay visible with their own account
    const lines = r.stdout.split('\n').filter((l) => l.includes('11111111-1111-4111-8111-111111111111'));
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.includes('home'))).toBe(true);
    expect(lines.some((l) => l.includes('glide.vc'))).toBe(true);
  });
  test.each(['home', 'glide.vc', 'all'])('list --workspace %s', async (ws) => {
    const r = await cli(['list', '--workspace', ws], { 'sessions.list': () => SESSIONS_FIXTURE });
    expect(r.calls[0].params).toEqual({ workspace: ws });
    const eq = await cli(['list', `--workspace=${ws}`], { 'sessions.list': () => SESSIONS_FIXTURE });
    expect(eq.calls[0].params).toEqual({ workspace: ws });
  });
  test('show', async () => {
    const r = await cli(['show', 'glide.vc', 'chat-1'], { 'sessions.get': () => ({ account: { workspace: 'glide.vc' }, session: { chat: 'chat-1', title: 'T', status: 'working', latest_turn: 'turn-9' } }) });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ method: 'sessions.get', params: { workspace: 'glide.vc', chat: 'chat-1' } });
    expect(r.stdout).toContain('chat-1');
    expect(r.stdout).toContain('turn-9');
  });
  test('events filters the list response to events only', async () => {
    const r = await cli(['events', '--workspace', 'home'], { 'sessions.list': () => SESSIONS_FIXTURE });
    expect(r.calls[0]).toMatchObject({ method: 'sessions.list', params: { workspace: 'home' } });
    expect(r.stdout).toContain('sent go');
    expect(r.stdout).toContain('service restarted');
    expect(r.stdout).not.toContain('Canvas');
  });
  test('requests lists and gets one', async () => {
    const list = await cli(['requests'], { 'requests.list': () => ({ requests: [REQUEST] }) });
    expect(list.calls[0]).toMatchObject({ method: 'requests.list', params: {} });
    expect(list.stdout).toContain('req-1');
    const one = await cli(['requests', 'req-1'], { 'requests.get': () => REQUEST });
    expect(one.calls[0]).toMatchObject({ method: 'requests.get', params: { request_id: 'req-1' } });
    expect(one.stdout).toContain('pending');
  });
  test.each(['watch', 'unwatch', 'pause', 'resume'])('%s queues one actions.request with fixed fields only', async (action) => {
    const r = await cli([action, 'home', 'c1'], { 'actions.request': () => ({ ...REQUEST, action }) });
    expect(r.exitCode).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].method).toBe('actions.request');
    expect(Object.keys(r.calls[0].params).sort()).toEqual(['action', 'chat', 'reason', 'workspace']);
    expect(r.calls[0].params).toMatchObject({ workspace: 'home', chat: 'c1', action });
    expect(r.stdout).toContain('req-1');
    expect(r.stdout.toLowerCase()).toContain('approval');
  });
  test('continue binds the latest turn from sessions.get', async () => {
    const r = await cli(['continue', 'glide.vc', 'c1'], {
      'sessions.get': () => ({ session: { chat: 'c1', latest_turn: 'turn-42' } }),
      'actions.request': () => ({ ...REQUEST, action: 'continue', workspace: 'glide.vc', expected_turn: 'turn-42' }),
    });
    expect(r.calls.map((c) => c.method)).toEqual(['sessions.get', 'actions.request']);
    expect(r.calls[1].params).toMatchObject({ workspace: 'glide.vc', chat: 'c1', action: 'continue', expected_turn: 'turn-42' });
    expect(r.stdout).toContain('turn-42');
  });
  test('continue binds latest_turn, never a historical continuation turn', async () => {
    const r = await cli(['continue', 'home', 'c1'], {
      'sessions.get': () => ({ session: { chat: 'c1', continuation_turn: 'turn-old', previous_turn: 'turn-older', latest_turn: 'turn-new' } }),
      'actions.request': () => ({ ...REQUEST, action: 'continue', expected_turn: 'turn-new' }),
    });
    expect(r.calls[1].params).toMatchObject({ expected_turn: 'turn-new' });
  });
  test('continue refuses (no request) when sessions.get exposes no turn', async () => {
    const r = await cli(['continue', 'home', 'c1'], { 'sessions.get': () => ({ session: { chat: 'c1' } }) });
    expect(r.exitCode).toBe(EXIT_PM_ERROR);
    expect(r.calls.map((c) => c.method)).toEqual(['sessions.get']);
    expect(r.stderr).toContain('turn');
  });
  test('continue stops when sessions.get fails', async () => {
    const r = await cli(['continue', 'home', 'c1'], { 'sessions.get': () => errEnvelope('not_found', 'gone') });
    expect(r.exitCode).toBe(EXIT_PM_ERROR);
    expect(r.calls).toHaveLength(1);
  });
  test('service start/stop map to service-start/service-stop without a chat', async () => {
    for (const [verb, action] of [['start', 'service-start'], ['stop', 'service-stop']] as const) {
      const r = await cli(['service', verb, 'home'], { 'actions.request': () => ({ ...REQUEST, action }) });
      expect(r.calls[0].params).toMatchObject({ workspace: 'home', action });
      expect('chat' in r.calls[0].params).toBe(false);
    }
  });
  test('connector list and request guardian', async () => {
    const l = await cli(['connector', 'list'], { 'connectors.list': () => ({ connectors: [{ connector: 'guardian', state: 'not-installed' }] }) });
    expect(l.calls[0]).toMatchObject({ method: 'connectors.list', params: {} });
    const q = await cli(['connector', 'request', 'guardian'], { 'connectors.request': () => ({ request_id: 'req-c', status: 'pending' }) });
    expect(q.calls[0]).toMatchObject({ method: 'connectors.request', params: { connector: 'guardian', target: 'chatgpt' } });
    expect(q.stdout).toContain('req-c');
  });
});

describe('machine output and exit codes', () => {
  test('--json prints a stable {ok:true,result} envelope (flag position free)', async () => {
    for (const argv of [['--json', 'accounts'], ['accounts', '--json']]) {
      const r = await cli(argv, { 'accounts.list': () => ({ accounts: [] }) });
      expect(JSON.parse(r.stdout)).toEqual({ ok: true, result: { accounts: [] } });
      expect(r.exitCode).toBe(0);
    }
  });
  test('--json failure prints {ok:false,error} on stdout', async () => {
    const r = await cli(['--json', 'show', 'home', 'c'], { 'sessions.get': () => errEnvelope('not_found', 'gone') });
    expect(JSON.parse(r.stdout)).toEqual({ ok: false, error: { code: 'not_found', message: 'gone' } });
    expect(r.exitCode).toBe(EXIT_PM_ERROR);
  });
  test('pm unavailable exits 69', async () => {
    const r = await runChatgptCli(['accounts'], { run: async () => ({ kind: 'spawn-error' }) });
    expect(r.exitCode).toBe(EXIT_UNAVAILABLE);
    expect(r.stderr).toContain('pm');
    const j = await runChatgptCli(['--json', 'accounts'], { run: async () => ({ kind: 'spawn-error' }) });
    expect(JSON.parse(j.stdout).error.code).toBe('pm-unavailable');
  });
  test('mutating timeout exits 75 and tells the user to check requests; read timeout exits 1', async () => {
    const m = await runChatgptCli(['pause', 'home', 'c1'], { run: async () => ({ kind: 'timeout' }) });
    expect(m.exitCode).toBe(EXIT_UNCERTAIN);
    expect(m.stderr).toContain('tg chatgpt requests');
    const r = await runChatgptCli(['list'], { run: async () => ({ kind: 'timeout' }) });
    expect(r.exitCode).toBe(EXIT_PM_ERROR);
  });
  test('exit codes are distinct and documented values', () => {
    expect([EXIT_OK, EXIT_PM_ERROR, EXIT_USAGE, EXIT_UNAVAILABLE, EXIT_UNCERTAIN]).toEqual([0, 1, 2, 69, 75]);
  });
});

describe('output safety', () => {
  // Fake credential material, assembled at runtime so no literal looks like a real secret.
  const SECRET = ['sk', 'FAKE', 'ABCDEF0123456789abcdef0123456789'].join('-');
  const HEX = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6';
  const PW = ['FAKE', 'PW', 'VALUE'].join('_');
  const OTHER = ['FAKE', 'OTHER', 'VALUE'].join('_');
  const dirty = {
    ...SESSIONS_FIXTURE,
    accounts: [{ workspace: 'home', ok: true, token: SECRET, api_key: SECRET, authorization: `Bearer ${SECRET}`, summary: { enrolled: 1, present: 1, running: 1, blocked: 0 } }],
    sessions: [{ account: 'home', chat: 'c1', title: `token ${HEX} Bearer ${SECRET}`, status: 'working', reason: `password=${PW} ${SECRET}`, password: PW, secret: OTHER }],
    events: [],
  };
  test('human output never contains secret values', async () => {
    const r = await cli(['list'], { 'sessions.list': () => dirty });
    for (const s of [SECRET, HEX, PW, OTHER]) expect(r.stdout + r.stderr).not.toContain(s);
  });
  test('--json output redacts secret-looking keys and values', async () => {
    const r = await cli(['--json', 'list'], { 'sessions.list': () => dirty });
    for (const s of [SECRET, HEX, PW, OTHER]) expect(r.stdout).not.toContain(s);
    expect(JSON.parse(r.stdout).ok).toBe(true);
  });
  test('error messages from pm are redacted too', async () => {
    const r = await cli(['accounts'], { 'accounts.list': () => errEnvelope('boom', `bad Bearer ${SECRET}`) });
    expect(r.stderr).not.toContain(SECRET);
  });
  test('long display strings are truncated', async () => {
    const long = { ...SESSIONS_FIXTURE, sessions: [{ account: 'home', chat: 'c1', title: 'T'.repeat(500), reason: 'R '.repeat(400), status: 'working' }], events: [] };
    const r = await cli(['list'], { 'sessions.list': () => long });
    expect(r.stdout).not.toContain('T'.repeat(200));
    expect(r.stdout).not.toContain('R '.repeat(150));
  });
  test('missing optional fields render an em dash, never fabricated values', async () => {
    const sparse = { workspace: 'home', accounts: [], sessions: [{ account: 'home', chat: 'c1' }], events: [] };
    const r = await cli(['list'], { 'sessions.list': () => sparse });
    expect(r.stdout).toContain('—');
  });
  test('unknown extra keys and hostile control characters are ignored/stripped', async () => {
    const hostile = { ...SESSIONS_FIXTURE, junk: { a: 1 }, sessions: [{ account: 'home', chat: 'c1', title: 'a\u001b[31mred\u0007', status: 'working', surprise: 1 }], events: [] };
    const r = await cli(['list'], { 'sessions.list': () => hostile });
    expect(r.stdout).not.toContain('\u001b');
    expect(r.stdout).not.toContain('\u0007');
  });
});
