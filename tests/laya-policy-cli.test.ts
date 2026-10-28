// The Laya policy end to end through the real `tg` (tg-cli#830): fallback with a stated reason,
// `laya.required` failing BEFORE any Bot API request, an invalid `laya:` config exiting 78, and
// `--dry-run` never starting the caller. Most scenarios replace the Python caller with a fake
// interpreter (TG_PYTHON) so each answer shape is exact; the last ones run the real
// `python3 -I <repo>/tg-laya` against a fake `task` and a real unix-socket server.
import { afterAll, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tempDir } from './helpers/test-temp';
import { COMPLETE_PROBLEM } from './fixtures/intent-gate/problem-remediation';

const root = join(import.meta.dir, '..');
// Long enough for the ask check (40+ prose chars), no question in it: the heuristic finds no ask,
// so Laya is consulted.
const REPORT = 'Готово: #690 смержен, CI зелёный, деплой прошёл на стенд.';
let sent: unknown[] = [];
const api = Bun.serve({ port: 0, async fetch(req) {
  sent.push(await req.json());
  return Response.json({ ok: true, result: { message_id: 800 + sent.length } });
} });
afterAll(() => api.stop(true));

function makeHome(config = ''): string {
  const home = tempDir('tg-laya-policy-');
  const cfg = join(home, '.config', 'tg-cli');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, '.env'), 'TG_BOT_TOKEN=123:fixture\nTG_CHAT_ID=1\n');
  if (config) writeFileSync(join(cfg, 'config.yaml'), config);
  return home;
}

async function run(home: string, args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, join(root, 'tg'), ...args], {
    cwd: home,
    env: { PATH: process.env.PATH ?? '', HOME: home, TMUX: '', TG_API_BASE: `http://127.0.0.1:${api.port}`, TG_AI_EMOJI: 'bot', TG_AI_MODEL: 'claude', TG_LAYA: '1', ...env },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, out, err };
}

/** A fake interpreter that records that it ran, then answers with `lines`. */
function fakeCaller(home: string, lines: object[]): { python: string; ran: () => boolean } {
  const python = join(home, 'fake-python.sh');
  const marker = join(home, 'caller-ran');
  const body = lines.map((l) => `echo '${JSON.stringify(l)}'`).join('\n');
  writeFileSync(python, `#!/bin/sh\ntouch '${marker}'\ncat > /dev/null\n${body}\n`);
  chmodSync(python, 0o755);
  return { python, ran: () => existsSync(marker) };
}

// A problem report from a sender with no agent identity is gated only by the remediation facts.
const NO_AGENT = { TG_AI_MODEL: '' };
const budget = { status: 'budget', total_ms: 5000 };
const unavailable = (extra: Record<string, string> = {}) => ({
  status: 'unavailable', reason: 'timeout', detail: 'no reply before the deadline',
  attempt: 'asked /s/laya.sock: no reply within 3000 ms', remedy: 'run: task classify-server start', policy: 'fallback', ...extra,
});

test('fallback: the ask check names the reason, what was tried and the next step, and the message is sent', async () => {
  sent = [];
  const home = makeHome();
  const { python } = fakeCaller(home, [budget, unavailable()]);
  const r = await run(home, [REPORT], { TG_PYTHON: python });
  expect(r.code).toBe(0);
  expect(sent).toHaveLength(1);
  expect(r.err).toContain('tg: hint: Laya ask check unavailable (timeout): tried asked /s/laya.sock: no reply within 3000 ms. Next: run: task classify-server start');
});

test('an explicitly disabled Laya stays quiet on the ask path', async () => {
  sent = [];
  const home = makeHome();
  const { python } = fakeCaller(home, [budget, unavailable({ reason: 'disabled' })]);
  const r = await run(home, [REPORT], { TG_PYTHON: python });
  expect(r.code).toBe(0);
  expect(sent).toHaveLength(1);
  expect(r.err).not.toContain('Laya ask check');
});

test('fallback: the problem check shows the same reason, attempt and remedy and the deterministic check decides', async () => {
  sent = [];
  const home = makeHome();
  const { python } = fakeCaller(home, [budget, unavailable({ reason: 'autostart-skipped', attempt: 'skipped autostart: last failure 12 s ago' })]);
  // --automated: hints reach stderr only for a sender with an identity (a bare cron stays quiet).
  const r = await run(home, ['--automated', '--tag', 'problem', COMPLETE_PROBLEM], { TG_PYTHON: python });
  expect(r.code).toBe(0);
  expect(sent).toHaveLength(1);
  expect(r.err).toContain('Laya problem check unavailable (autostart-skipped): tried skipped autostart: last failure 12 s ago. Next: run: task classify-server start');
});

test('required: an unavailable Laya fails the ask check before any Bot API request, exit 1', async () => {
  sent = [];
  const home = makeHome();
  const { python } = fakeCaller(home, [budget, unavailable({ policy: 'required' })]);
  const r = await run(home, [REPORT], { TG_PYTHON: python });
  expect(r.code).toBe(1);
  expect(sent).toHaveLength(0);
  expect(r.err).toContain('tg: Laya is required (laya.required: true) but unavailable: timeout. Tried: asked /s/laya.sock: no reply within 3000 ms. Next: run: task classify-server start.');
  expect(r.err).toContain('Blocked: nothing was sent');
});

test('required: the same for the problem check, and ESCALATION_GATE_ENFORCE=0 does not bypass it', async () => {
  sent = [];
  const home = makeHome();
  const { python } = fakeCaller(home, [budget, unavailable({ policy: 'required', reason: 'cold-timeout' })]);
  const r = await run(home, ['--tag', 'problem', COMPLETE_PROBLEM], { TG_PYTHON: python, ESCALATION_GATE_ENFORCE: '0', ...NO_AGENT });
  expect(r.code).toBe(1);
  expect(sent).toHaveLength(0);
  expect(r.err).toContain('unavailable: cold-timeout.');
});

test('an invalid laya config exits 78 where Laya is consulted and sends nothing', async () => {
  sent = [];
  const home = makeHome();
  const { python } = fakeCaller(home, [budget, unavailable({ reason: 'invalid-config', detail: 'laya.warm_timeout_ms must be a positive integer (got soon)', remedy: 'fix the setting named above' })]);
  const r = await run(home, [REPORT], { TG_PYTHON: python });
  expect(r.code).toBe(78);
  expect(sent).toHaveLength(0);
  expect(r.err).toContain("tg: Laya configuration is invalid: laya.warm_timeout_ms must be a positive integer (got soon). Next: fix the setting named above.");
});

test('--dry-run never starts the caller, on the ask path or the problem path, and needs no credentials', async () => {
  sent = [];
  const home = makeHome();
  const caller = fakeCaller(home, [budget, unavailable({ policy: 'required' })]);
  const ask = await run(home, ['--dry-run', REPORT], { TG_PYTHON: caller.python });
  expect(ask.code).toBe(0);
  const problem = await run(home, ['--dry-run', '--automated', '--tag', 'problem', COMPLETE_PROBLEM], { TG_PYTHON: caller.python });
  expect(problem.code).toBe(0);
  expect(problem.err).toContain('skipped for offline --dry-run');
  expect(caller.ran()).toBe(false);
  expect(sent).toHaveLength(0);
});

test('a sender with no agent identity and no problem tag never consults Laya at all', async () => {
  sent = [];
  const home = makeHome();
  const caller = fakeCaller(home, [budget, unavailable({ policy: 'required' })]);
  const r = await run(home, [REPORT], { TG_PYTHON: caller.python, ...NO_AGENT });
  expect(r.code).toBe(0);
  expect(caller.ran()).toBe(false);
});

test('required + a broken interpreter: the send still fails, the config is read without the helper', async () => {
  sent = [];
  const home = makeHome('laya:\n  required: true\n');
  const r = await run(home, [REPORT], { TG_PYTHON: join(home, 'no-such-python') });
  expect(r.code).toBe(1);
  expect(sent).toHaveLength(0);
  expect(r.err).toContain('unavailable: helper-failed.');
  expect(r.err).toContain('TG_PYTHON');
});

test('real caller: required with an unreachable pinned socket fails before the API with the typed reason', async () => {
  sent = [];
  const home = makeHome('laya:\n  required: true\n');
  const socket = join(home, 'private', 'laya.sock');
  mkdirSync(join(home, 'private'), { mode: 0o700 });
  const r = await run(home, [REPORT], { TG_LAYA_SOCKET: socket });
  expect(r.code).toBe(1);
  expect(sent).toHaveLength(0);
  expect(r.err).toContain(`but unavailable: no-socket. Tried: connected to the pinned socket ${socket}`);
});

test('real caller: required with an unreachable YAML-pinned socket fails before the API and never starts task', async () => {
  sent = [];
  const home = makeHome();
  const socket = join(home, 'private', 'laya-ubuntu.sock');
  mkdirSync(join(home, 'private'), { mode: 0o700 });
  writeFileSync(join(home, '.config', 'tg-cli', 'config.yaml'), `laya:\n  required: true\n  autostart: true\n  socket: ${socket}\n`);
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const log = join(home, 'task.log');
  writeFileSync(join(bin, 'task'), `#!/bin/sh\necho "$@" >> '${log}'\nexit 1\n`);
  chmodSync(join(bin, 'task'), 0o755);
  const r = await run(home, [REPORT], { PATH: `${bin}:${process.env.PATH ?? ''}` });
  expect(r.code).toBe(1);
  expect(sent).toHaveLength(0);
  expect(r.err).toContain('but unavailable: no-socket.');
  expect(r.err).toContain(`the pinned socket ${socket} is served by an external supervisor`);
  expect(existsSync(log)).toBe(false);
});

test('real caller: a relative laya.socket exits 78 before any request', async () => {
  sent = [];
  const home = makeHome('laya:\n  socket: laya.sock\n');
  const r = await run(home, [REPORT]);
  expect(r.code).toBe(78);
  expect(sent).toHaveLength(0);
  expect(r.err).toContain('laya.socket must be an absolute path');
});

test('real caller: a bad laya block exits 78 naming the line-level problem', async () => {
  sent = [];
  const home = makeHome('laya:\n  warm_timeout_ms: soon\n  bogus: 1\n');
  const r = await run(home, [REPORT]);
  expect(r.code).toBe(78);
  expect(sent).toHaveLength(0);
  expect(r.err).toContain('laya.warm_timeout_ms must be a positive integer');
  expect(r.err).toContain('laya.bogus is not a known setting');
});

test('real caller: required together with TG_LAYA=0 is a configuration error (78), not a silent skip', async () => {
  sent = [];
  const home = makeHome('laya:\n  required: true\n');
  const r = await run(home, [REPORT], { TG_LAYA: '0' });
  expect(r.code).toBe(78);
  expect(r.err).toContain('laya.required: true conflicts with TG_LAYA=0');
});

test('real caller: nothing listening -> it starts Laya through `task`, then the ask is answered (autostart end to end)', async () => {
  sent = [];
  const home = makeHome();
  const bin = join(home, 'bin');
  const fakes = join(root, 'tests', 'py');
  const state = join(home, 'state');
  mkdirSync(join(state, 'task-cli', 'classify'), { recursive: true, mode: 0o700 });
  const made = Bun.spawnSync(['python3', '-c', 'import sys, pathlib, laya_fakes; laya_fakes.install_fake_task(pathlib.Path(sys.argv[1]))', bin], { cwd: fakes, env: { PATH: process.env.PATH ?? '', PYTHONPATH: fakes } });
  expect(made.exitCode).toBe(0);
  const socket = join(state, 'task-cli', 'classify', 'laya-fake.sock');
  const log = join(home, 'task.log');
  try {
    const r = await run(home, [REPORT], {
      PATH: `${bin}:${process.env.PATH ?? ''}`, XDG_STATE_HOME: state,
      TASK_FAKE_LOG: log, TASK_FAKE_SOCKET: socket, TASK_FAKE_PYTHON: 'python3', TASK_FAKE_SCRIPT: join(fakes, 'laya_fakes.py'),
    });
    expect(r.code).toBe(0);
    expect(r.err).toContain('starting it with `task classify-server start`');
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1);
    // The fake server scores every question 0.93: above the ask threshold, so the hint appears.
    expect(r.err).toContain('laya reads this message as asking the reader something (p=0.93)');
    expect(sent).toHaveLength(1);
  } finally {
    for (const name of readdirSync(join(state, 'task-cli', 'classify')).filter((n) => n.endsWith('.pid'))) {
      try { process.kill(Number(readFileSync(join(state, 'task-cli', 'classify', name), 'utf8')), 'SIGTERM'); } catch { /* already gone */ }
    }
  }
}, 30_000);
