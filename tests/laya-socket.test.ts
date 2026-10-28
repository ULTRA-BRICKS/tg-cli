// The TypeScript half of the Laya caller (features/cli/laya-socket.ts, tg-cli#706/#830): it spawns
// `python3 -I <repo>/tg-laya ask` and reads its JSON lines. The config rules, socket trust, autostart
// and timeouts are tested where they live (tests/py/test_laya_*.py); here a fake interpreter
// (TG_PYTHON) pins the spawn contract and what the glue does with every shape of answer.
import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { askLaya, formatConfigFailure, formatRequiredFailure, LAYA_TRUE_TOKENS, layaAskProbability, layaCommand, layaProblemAssessment, parseLayaReply } from '../features/cli/laya-socket';
import { LAYA_REASONS } from '../features/cli/problem-remediation';
import { tempDir } from './helpers/test-temp';

const root = tempDir('tg-laya-glue-');
const configDir = join(root, 'cfg');
mkdirSync(configDir);
let counter = 0;

interface Fake {
  python: string;
  stdin(): { message: string; questions: Record<string, unknown> };
  argv(): string[];
  env(): Record<string, string>;
}

/** A fake interpreter: records argv, stdin and env, then runs `tail` (shell) for its stdout. */
function fakePython(tail: string): Fake {
  const base = join(root, `fake-${++counter}`);
  const script = `${base}.sh`;
  writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > '${base}.argv'\ncat > '${base}.stdin'\nenv > '${base}.env'\n${tail}\n`);
  chmodSync(script, 0o755);
  return {
    python: script,
    stdin: () => JSON.parse(readFileSync(`${base}.stdin`, 'utf8')),
    argv: () => readFileSync(`${base}.argv`, 'utf8').trim().split('\n'),
    env: () => Object.fromEntries(readFileSync(`${base}.env`, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])),
  };
}

const budget = (ms: number): string => `echo '{"status":"budget","total_ms":${ms}}'`;
const ok = (line: object, policy = 'fallback'): string => `echo '${JSON.stringify({ status: 'ok', line: JSON.stringify(line), policy })}'`;
const answers = (scores: Record<string, number>): object => ({ ok: true, result: { answers: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, { type: 'noul', noul: v }])) } });
const base = (python: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: root, TG_PYTHON: python, ...extra });

test('spawns `python3 -I <repo>/tg-laya ask --config-dir`, feeds one JSON request and reads P(true)', async () => {
  const fake = fakePython(`${budget(1000)}\n${ok(answers({ asks_reader: 0.93 }))}`);
  const result = await layaAskProbability('Готово: #690 смержен, CI зелёный.', base(fake.python), configDir);
  expect(result).toEqual({ status: 'ok', probability: 0.93 });
  expect(fake.argv()).toEqual(['-I', join(import.meta.dir, '..', 'tg-laya'), 'ask', '--config-dir', configDir]);
  const request = fake.stdin();
  expect(request.message).toBe('Готово: #690 смержен, CI зелёный.');
  expect(Object.keys(request.questions)).toEqual(['asks_reader']);
});

test('the ask message is the head of the body, at most 2000 characters', async () => {
  const fake = fakePython(`${budget(1000)}\n${ok(answers({ asks_reader: 0.1 }))}`);
  await layaAskProbability('x'.repeat(5000), base(fake.python), configDir);
  expect(fake.stdin().message).toHaveLength(2000);
});

test('the helper sees only the variables it needs: no PYTHON*, no token, no agent markers', async () => {
  const fake = fakePython(`${budget(1000)}\n${ok(answers({ asks_reader: 0.1 }))}`);
  const env = base(fake.python, {
    PYTHONPATH: '/planted', PYTHONHOME: '/planted', PYTHONSTARTUP: '/planted/x.py',
    TG_BOT_TOKEN: '123:secret', TG_CHAT_ID: '1', ANTHROPIC_API_KEY: 'k', TG_AI_MODEL: 'claude',
    TG_LAYA: '1', TG_LAYA_TIMEOUT_MS: '2500', TG_LAYA_SOCKET: '/run/x/laya.sock', XDG_STATE_HOME: '/state', TASK_KEEP: 'yes', LANG: 'C.UTF-8',
  });
  await layaAskProbability('some body that is long enough to ask about', env, configDir);
  const seen = fake.env();
  for (const python of ['PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP']) expect(seen[python]).toBeUndefined();
  for (const kept of ['PATH', 'HOME', 'TG_LAYA', 'TG_LAYA_TIMEOUT_MS', 'TG_LAYA_SOCKET', 'XDG_STATE_HOME', 'TASK_KEEP', 'LANG']) expect(seen[kept]).toBeDefined();
  for (const dropped of ['TG_BOT_TOKEN', 'TG_CHAT_ID', 'ANTHROPIC_API_KEY', 'TG_AI_MODEL']) expect(seen[dropped]).toBeUndefined();
});

/**
 * Planted code that leaves `marker` behind when imported: a `tgcli` package (shadowing ours) and a
 * `json.py` (shadowing the standard library, which `tgcli.laya` imports and which the launcher's
 * own `sys.path.insert` alone could not protect: only `-I` keeps cwd and PYTHONPATH off the path).
 */
function plantTgcli(dir: string, marker: string): void {
  mkdirSync(join(dir, 'tgcli'), { recursive: true });
  const code = `open(${JSON.stringify(marker)}, 'w').write('planted code ran')\n`;
  writeFileSync(join(dir, 'tgcli', '__init__.py'), code);
  writeFileSync(join(dir, 'json.py'), code);
}

test('planted code never runs: a tgcli in the cwd or on PYTHONPATH loses to <repo>/src, which still imports', () => {
  const cwd = tempDir('tg-laya-cwd-');
  const planted = tempDir('tg-laya-pp-');
  plantTgcli(cwd, join(root, 'cwd-ran'));
  plantTgcli(planted, join(root, 'pythonpath-ran'));
  const config = join(root, 'planted-config.yaml');
  writeFileSync(config, 'laya:\n  autostart: perhaps\n');
  // The launcher itself, with the hostile environment handed straight to it (no helperEnv in between).
  const run = Bun.spawnSync(layaCommand({ TG_PYTHON: 'python3' }, 'check-config', '--file', config), {
    cwd, env: { PATH: process.env.PATH ?? '', PYTHONPATH: planted }, stdout: 'pipe', stderr: 'pipe',
  });
  expect(run.stderr.toString()).toBe('');
  expect(JSON.parse(run.stdout.toString()).diagnostics[0].message).toContain('laya.autostart must be true or false');
  expect(existsSync(join(root, 'cwd-ran'))).toBe(false);
  expect(existsSync(join(root, 'pythonpath-ran'))).toBe(false);
});

test('through askLaya from a hostile cwd the real caller runs from <repo>/src and answers', async () => {
  const cwd = tempDir('tg-laya-cwd2-');
  plantTgcli(cwd, join(root, 'cwd2-ran'));
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    const reply = await askLaya('m', {}, { PATH: process.env.PATH, HOME: root, PYTHONPATH: cwd, TG_LAYA: '0' }, configDir);
    expect(reply).toMatchObject({ status: 'unavailable', reason: 'disabled' });
  } finally {
    process.chdir(previous);
  }
  expect(existsSync(join(root, 'cwd2-ran'))).toBe(false);
});

test('an unavailable reply keeps its reason, attempt, remedy and policy', async () => {
  const reply = { status: 'unavailable', reason: 'cold-timeout', detail: 'no socket within 75 s', attempt: 'ran task classify-server start', remedy: 'run: task classify-server start', policy: 'required' };
  const fake = fakePython(`${budget(5000)}\necho '${JSON.stringify(reply)}'`);
  expect(await layaAskProbability('body', base(fake.python), configDir)).toEqual(reply);
});

test('a reply without the asked probability is invalid-response and keeps the policy it came with', async () => {
  const fake = fakePython(`${budget(1000)}\n${ok({ ok: false, error: 'ValueError' }, 'required')}`);
  const result = await layaAskProbability('body', base(fake.python), configDir);
  expect(result).toMatchObject({ status: 'unavailable', reason: 'invalid-response', policy: 'required' });
  expect(result.status === 'unavailable' && result.remedy).toContain('task classify-server start');
});

test('an unknown reason from the helper is invalid-response, never forwarded as a typed reason', async () => {
  const reply = { status: 'unavailable', reason: 'made-up', detail: 'x', attempt: 'y', remedy: 'z', policy: 'required' };
  const fake = fakePython(`${budget(1000)}\necho '${JSON.stringify(reply)}'`);
  const result = await layaAskProbability('body', base(fake.python), configDir);
  expect(result).toMatchObject({ status: 'unavailable', reason: 'invalid-response', policy: 'required' });
  expect(result.status === 'unavailable' && result.detail).toContain('made-up');
});

test.each([...LAYA_REASONS])('the known reason %s passes through unchanged', async (reason) => {
  const reply = { status: 'unavailable', reason, detail: 'd', attempt: 'a', remedy: 'r', policy: 'fallback' };
  const fake = fakePython(`${budget(1000)}\necho '${JSON.stringify(reply)}'`);
  expect(await layaAskProbability('body', base(fake.python), configDir)).toEqual(reply);
});

// The documented runtime boolean tokens (docs/configuration.md), any case.
const TRUE_TOKENS = ['true', 'True', 'TRUE', 'yes', 'Yes', 'on', 'ON', '1'];
const FALSE_TOKENS = ['false', 'False', 'FALSE', 'no', 'No', 'off', 'OFF', '0', 'maybe', '2'];

test('the glue\'s true tokens are exactly the ones Python accepts', () => {
  const python = readFileSync(join(import.meta.dir, '..', 'src', 'tgcli', 'laya', 'config.py'), 'utf8');
  const declared = /^_TRUE = \{(.*)\}$/mu.exec(python)?.[1].split(',').map((t) => t.trim().replace(/"/g, '')).sort();
  expect([...LAYA_TRUE_TOKENS].sort()).toEqual(declared);
});

test.each(TRUE_TOKENS)('a failed helper keeps `required` for the documented true token %s (environment and config)', async (token) => {
  const fake = fakePython('exit 4');
  expect(await askLaya('m', {}, base(fake.python, { TG_LAYA_REQUIRED: token }), configDir)).toMatchObject({ policy: 'required' });
  const dir = tempDir('tg-laya-token-');
  writeFileSync(join(dir, 'config.yaml'), `laya:\n  required: ${token}\n`);
  expect(await askLaya('m', {}, base(fake.python), dir)).toMatchObject({ policy: 'required' });
});

test.each(FALSE_TOKENS)('a failed helper falls back for the non-true token %s', async (token) => {
  const fake = fakePython('exit 4');
  expect(await askLaya('m', {}, base(fake.python, { TG_LAYA_REQUIRED: token }), configDir)).toMatchObject({ policy: 'fallback' });
  const dir = tempDir('tg-laya-token-');
  writeFileSync(join(dir, 'config.yaml'), `laya:\n  required: ${token}\n`);
  expect(await askLaya('m', {}, base(fake.python), dir)).toMatchObject({ policy: 'fallback' });
});

test('a helper that crashes without a reply is helper-failed, never an exception', async () => {
  const fake = fakePython('echo boom >&2\nexit 3');
  const result = await askLaya('m', {}, base(fake.python), configDir);
  expect(result).toMatchObject({ status: 'unavailable', reason: 'helper-failed', policy: 'fallback' });
  expect(result.status === 'unavailable' && result.detail).toContain('exited 3');
});

test('a missing interpreter is helper-failed with the TG_PYTHON remedy', async () => {
  const result = await askLaya('m', {}, base('/nonexistent/python3'), configDir);
  expect(result).toMatchObject({ status: 'unavailable', reason: 'helper-failed' });
  expect(result.status === 'unavailable' && result.remedy).toContain('TG_PYTHON');
});

test('a helper that hangs past its own announced budget is killed: helper-timeout', async () => {
  const fake = fakePython(`${budget(100)}\nsleep 30`);
  const started = Date.now();
  const result = await askLaya('m', {}, base(fake.python), configDir, { killMarginMs: 100 });
  expect(result).toMatchObject({ status: 'unavailable', reason: 'helper-timeout' });
  expect(Date.now() - started).toBeLessThan(5_000);
});

test('a helper that never announces a budget is killed after the startup allowance', async () => {
  const fake = fakePython('sleep 30');
  const started = Date.now();
  const result = await askLaya('m', {}, base(fake.python), configDir, { startupMs: 150 });
  expect(result).toMatchObject({ status: 'unavailable', reason: 'helper-timeout' });
  expect(Date.now() - started).toBeLessThan(5_000);
});

test('when the helper itself failed, a required Laya stays required (config file or environment)', async () => {
  const fake = fakePython('exit 4');
  const required = tempDir('tg-laya-required-');
  writeFileSync(join(required, 'config.yaml'), 'control:\n  enabled: true\nlaya:\n  autostart: false\n  required: true  # no downgrade\n');
  expect(await askLaya('m', {}, base(fake.python), required)).toMatchObject({ reason: 'helper-failed', policy: 'required' });
  expect(await askLaya('m', {}, base(fake.python, { TG_LAYA_REQUIRED: '1' }), configDir)).toMatchObject({ policy: 'required' });
  // The environment wins over the file here as it does in the helper.
  expect(await askLaya('m', {}, base(fake.python, { TG_LAYA_REQUIRED: '0' }), required)).toMatchObject({ policy: 'fallback' });
  const other = tempDir('tg-laya-other-');
  writeFileSync(join(other, 'config.yaml'), 'voice:\n  required: true\nlaya:\n  autostart: true\n');
  expect(await askLaya('m', {}, base(fake.python), other)).toMatchObject({ policy: 'fallback' });
});

test('a reply that is not ok, or carries no probability, is null', () => {
  expect(parseLayaReply('{"ok":false,"error":"ValueError"}')).toBeNull();
  expect(parseLayaReply('{"ok":true,"result":{"answers":{}}}')).toBeNull();
  expect(parseLayaReply('not json')).toBeNull();
  expect(parseLayaReply('{"ok":true,"result":{"answers":{"asks_reader":{"noul":0.2}}}}')).toBe(0.2);
});

test('failure texts name the reason, what was tried and the next step', () => {
  const outcome = { status: 'unavailable' as const, reason: 'timeout' as const, detail: 'no reply before the deadline', attempt: 'asked /s/laya.sock: no reply within 3000 ms', remedy: 'run: task classify-server start' };
  expect(formatRequiredFailure(outcome).split('\n')[0]).toBe(
    'tg: Laya is required (laya.required: true) but unavailable: timeout. Tried: asked /s/laya.sock: no reply within 3000 ms. Next: run: task classify-server start.',
  );
  expect(formatRequiredFailure(outcome)).toContain('Detail: no reply before the deadline');
  expect(formatConfigFailure({ status: 'unavailable', reason: 'invalid-config', detail: 'laya.enabled must be true or false', remedy: 'fix it' }))
    .toBe('tg: Laya configuration is invalid: laya.enabled must be true or false. Next: fix it.');
});

const problemReply = (): string => `${budget(1000)}\n${ok(answers({ has_done: 0.8, has_current: 0.7 }))}`;
const occurrences = (text: string, part: string): number => text.split(part).length - 1;

test('problem assessment sends an inline labelled report once, not done + whole body', async () => {
  const fake = fakePython(problemReply());
  const body = 'Already tried: Restarted Chrome; result: the tab is still missing. Doing now: Checking browser permissions.';
  expect(await layaProblemAssessment(body, base(fake.python), configDir)).toEqual({ status: 'ok', done: 0.8, current: 0.7 });
  const request = fake.stdin();
  expect(request.message).toBe(body);
  expect(Object.keys(request.questions).sort()).toEqual(['has_current', 'has_done']);
});

test('problem assessment keeps genuinely distinct sections, each once', async () => {
  const fake = fakePython(problemReply());
  await layaProblemAssessment('Problem: build fails.\nAlready tried: cleared the cache; it still fails.\nDoing now: bisecting the lockfile change.', base(fake.python), configDir);
  const { message } = fake.stdin();
  expect(occurrences(message, 'cleared the cache; it still fails.')).toBe(1);
  expect(occurrences(message, 'bisecting the lockfile change.')).toBe(1);
});

test('problem assessment keeps labelled sections when one is a substring of the other', async () => {
  const fake = fakePython(problemReply());
  await layaProblemAssessment('Already tried: restart\nDoing now: restart the worker after the config fix', base(fake.python), configDir);
  expect(fake.stdin().message).toBe('restart\nrestart the worker after the config fix');
});

test('problem assessment keeps a Result heading when the current action is unlabelled', async () => {
  const fake = fakePython(problemReply());
  await layaProblemAssessment('## Already tried\nrestarted the worker\n## Result\nthe queue is still stuck\nI am bisecting the config change.', base(fake.python), configDir);
  const { message } = fake.stdin();
  expect(message).toContain('Result: the queue is still stuck');
  expect(message).toContain('bisecting the config change');
});

test('problem assessment with identical or empty sections sends them once', async () => {
  const fake = fakePython(problemReply());
  await layaProblemAssessment('Build fails.', base(fake.python), configDir);
  expect(occurrences(fake.stdin().message, 'Build fails.')).toBe(1);
  await layaProblemAssessment('', base(fake.python), configDir);
  expect(fake.stdin().message).toBe('');
});

test('problem assessment without both probabilities is invalid-response', async () => {
  const fake = fakePython(`${budget(1000)}\n${ok(answers({ has_done: 0.8 }))}`);
  expect(await layaProblemAssessment('Build fails.', base(fake.python), configDir)).toMatchObject({ status: 'unavailable', reason: 'invalid-response' });
});
