import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { PM_MAX_STDOUT_BYTES, callPm, isMutatingMethod, parseEnvelope, pmArgv, type PmRunner } from '../features/chatgpt/pm-client';
import { spawnPmRunner } from '../features/chatgpt/pm-runner';
import { hostHasSystemCli } from './helpers/system-cli';
import { tempDir } from './helpers/test-temp';
import { errEnvelope, fakePm, okEnvelope } from './helpers/fake-pm';

const HOST_HAS_PM = hostHasSystemCli('pm');

describe('pmArgv', () => {
  test('is a fixed argv array with JSON params, never a shell string', () => {
    expect(pmArgv('sessions.get', { workspace: 'home', chat: 'abc' })).toEqual(['pm', 'chatgpt', 'api', 'sessions.get', '--params', '{"workspace":"home","chat":"abc"}']);
  });
  test('params with shell metacharacters stay one argv element', () => {
    const argv = pmArgv('sessions.get', { workspace: 'home', chat: 'a b;$(rm -rf /)' });
    expect(argv).toHaveLength(6);
    expect(JSON.parse(argv[5]).chat).toBe('a b;$(rm -rf /)');
  });
});

describe('parseEnvelope', () => {
  test('accepts ok envelopes and ignores extra keys', () => {
    expect(parseEnvelope('{"ok":true,"result":{"a":1},"extra":9}\n')).toEqual({ kind: 'ok', result: { a: 1 } });
  });
  test('accepts error envelopes', () => {
    expect(parseEnvelope('{"ok":false,"error":{"code":"nope","message":"bad"}}')).toEqual({ kind: 'error', code: 'nope', message: 'bad' });
  });
  test.each([
    ['non-JSON', 'Traceback (most recent call last)'],
    ['empty', ''],
    ['array', '[1]'],
    ['no ok flag', '{"result":1}'],
    ['ok without result', '{"ok":true}'],
    ['error without code', '{"ok":false,"error":{"message":"x"}}'],
    ['error with non-string message', '{"ok":false,"error":{"code":"a","message":5}}'],
    ['two envelopes', '{"ok":true,"result":1}\n{"ok":true,"result":2}'],
  ])('rejects %s', (_name, text) => {
    expect(parseEnvelope(text).kind).toBe('invalid');
  });
  test('truncates a huge error message', () => {
    const parsed = parseEnvelope(JSON.stringify({ ok: false, error: { code: 'x', message: 'm'.repeat(5000) } }));
    expect(parsed.kind).toBe('error');
    if (parsed.kind === 'error') expect(parsed.message.length).toBeLessThanOrEqual(500);
  });
});

describe('callPm', () => {
  test('returns the result of an ok envelope and passes bounds to the runner', async () => {
    let seen: { timeoutMs: number; maxBytes: number } | null = null;
    const run: PmRunner = async (_argv, o) => {
      seen = { timeoutMs: o.timeoutMs, maxBytes: o.maxBytes };
      return okEnvelope({ accounts: [] });
    };
    const out = await callPm(run, 'accounts.list', {});
    expect(out).toEqual({ kind: 'ok', result: { accounts: [] } });
    expect(seen).not.toBeNull();
    expect(seen!.maxBytes).toBe(PM_MAX_STDOUT_BYTES);
    expect(seen!.timeoutMs).toBeGreaterThan(0);
  });
  test('refuses a method outside the allowlist without running anything', async () => {
    const { run, calls } = fakePm({});
    const out = await callPm(run, 'shell.exec' as never, {});
    expect(out.kind).toBe('pm-error');
    expect(calls).toHaveLength(0);
  });
  test('spawn failure is pm-unavailable', async () => {
    const out = await callPm(async () => ({ kind: 'spawn-error' }), 'accounts.list', {});
    expect(out.kind).toBe('pm-unavailable');
  });
  test('a classified missing pm explains the feature and the fix for a shell, not the daemon', async () => {
    const out = await callPm(async () => ({ kind: 'spawn-error', problem: { kind: 'not-found', searchedPath: '/usr/bin:/bin' } }), 'accounts.list', {});
    expect(out.kind).toBe('pm-unavailable');
    if (out.kind !== 'pm-unavailable') return;
    expect(out.problem).toEqual({ kind: 'not-found', searchedPath: '/usr/bin:/bin' });
    expect(out.message).toContain('tg chatgpt');
    expect(out.message).toContain('/usr/bin:/bin');
    expect(out.message).toContain('run the command again');
    expect(out.message).not.toMatch(/daemon|restart|spawn|is it installed and on PATH/i);
  });
  test('a found-but-unstartable pm is reported as such', async () => {
    const out = await callPm(async () => ({ kind: 'spawn-error', problem: { kind: 'not-startable', path: '/h/.local/bin/pm', reason: 'EACCES' } }), 'accounts.list', {});
    if (out.kind !== 'pm-unavailable') throw new Error('expected pm-unavailable');
    expect(out.message).toContain('/h/.local/bin/pm');
    expect(out.message).toContain('EACCES');
  });
  test('error envelope is pm-error with the pm code', async () => {
    const { run } = fakePm({ 'sessions.get': () => errEnvelope('not_found', 'no such chat') });
    expect(await callPm(run, 'sessions.get', { workspace: 'home', chat: 'x' })).toEqual({ kind: 'pm-error', code: 'not_found', message: 'no such chat' });
  });
  test('non-JSON stdout is invalid-response', async () => {
    const out = await callPm(async () => ({ kind: 'exit', code: 0, stdout: 'hello', stderr: '' }), 'accounts.list', {});
    expect(out.kind).toBe('invalid-response');
  });
  test('wrong envelope shape is invalid-response', async () => {
    const out = await callPm(async () => ({ kind: 'exit', code: 0, stdout: '{"ok":"yes"}', stderr: '' }), 'accounts.list', {});
    expect(out.kind).toBe('invalid-response');
  });
  test('ok envelope with a failing exit code is invalid-response', async () => {
    const out = await callPm(async () => ({ kind: 'exit', code: 3, stdout: '{"ok":true,"result":1}', stderr: '' }), 'accounts.list', {});
    expect(out.kind).toBe('invalid-response');
  });
  test('oversize read output is invalid-response', async () => {
    expect((await callPm(async () => ({ kind: 'oversize' }), 'sessions.list', { workspace: 'all' })).kind).toBe('invalid-response');
  });
  test('a READ timeout is a plain pm-error', async () => {
    const out = await callPm(async () => ({ kind: 'timeout' }), 'sessions.list', { workspace: 'all' });
    expect(out).toMatchObject({ kind: 'pm-error', code: 'timeout' });
  });
  test('a MUTATING timeout is uncertain and is never retried', async () => {
    let calls = 0;
    const out = await callPm(
      async () => {
        calls++;
        return { kind: 'timeout' };
      },
      'actions.request',
      { workspace: 'home', chat: 'c', action: 'pause' },
    );
    expect(out.kind).toBe('uncertain');
    if (out.kind === 'uncertain') expect(out.message).toContain('tg chatgpt requests');
    expect(calls).toBe(1);
  });
  test('a MUTATING oversize kill is uncertain', async () => {
    expect((await callPm(async () => ({ kind: 'oversize' }), 'connectors.request', { connector: 'guardian', target: 'chatgpt' })).kind).toBe('uncertain');
  });
  test('a MUTATING garbage answer is invalid-response that points at the requests list', async () => {
    const out = await callPm(async () => ({ kind: 'exit', code: 1, stdout: 'boom', stderr: '' }), 'actions.request', { workspace: 'home', action: 'pause' });
    expect(out.kind).toBe('invalid-response');
    if (out.kind === 'invalid-response') expect(out.message).toContain('tg chatgpt requests');
  });
  test('mutating classification', () => {
    expect(isMutatingMethod('actions.request')).toBe(true);
    expect(isMutatingMethod('connectors.request')).toBe(true);
    expect(isMutatingMethod('sessions.list')).toBe(false);
  });
});

describe('spawnPmRunner (real process, fake pm on PATH)', () => {
  function fakeBin(script: string): string {
    const dir = tempDir('chatgpt-fake-pm-');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'pm');
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
    return dir;
  }
  async function withPath<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    const prior = process.env.PATH;
    process.env.PATH = `${dir}:${prior}`;
    try {
      return await fn();
    } finally {
      process.env.PATH = prior;
    }
  }

  test('captures stdout and exit code, passing argv verbatim', async () => {
    const dir = fakeBin('printf "%s|" "$@"');
    const res = await withPath(dir, () => spawnPmRunner(pmArgv('sessions.get', { workspace: 'home', chat: 'a b' }), { timeoutMs: 5000, maxBytes: 4096 }));
    expect(res).toMatchObject({ kind: 'exit', code: 0 });
    if (res.kind === 'exit') expect(res.stdout).toBe('chatgpt|api|sessions.get|--params|{"workspace":"home","chat":"a b"}|');
  });
  test.skipIf(HOST_HAS_PM)('a missing pm binary in both daemon PATH and user bins is spawn-error', async () => {
    const prior = process.env.PATH;
    const home = process.env.HOME;
    process.env.PATH = '/nonexistent-dir-for-test';
    process.env.HOME = tempDir('missing-pm-home-');
    try {
      expect(await spawnPmRunner(['pm', 'chatgpt', 'api', 'accounts.list', '--params', '{}'], { timeoutMs: 2000, maxBytes: 1024 })).toEqual({ kind: 'spawn-error', problem: { kind: 'not-found', searchedPath: '/nonexistent-dir-for-test' } });
    } finally {
      process.env.PATH = prior;
      if (home === undefined) delete process.env.HOME;
      else process.env.HOME = home;
    }
  });
  test('a pm whose interpreter is missing is found-but-unstartable, not an "invalid response"', async () => {
    const homeDir = tempDir('broken-pm-home-');
    const binDir = join(homeDir, '.local', 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'pm'), '#!/usr/bin/env definitely-missing-interpreter-804\n');
    chmodSync(join(binDir, 'pm'), 0o755);
    const priorPath = process.env.PATH;
    const priorHome = process.env.HOME;
    process.env.PATH = '/usr/bin:/bin';
    process.env.HOME = homeDir;
    try {
      const res = await spawnPmRunner(pmArgv('actions.request', { workspace: 'home', chat: 'c' }), { timeoutMs: 5000, maxBytes: 4096 });
      expect(res).toMatchObject({ kind: 'spawn-error', problem: { kind: 'not-startable', path: join(binDir, 'pm') } });
      const out = await callPm(spawnPmRunner, 'actions.request', { workspace: 'home', chat: 'c' });
      expect(out.kind).toBe('pm-unavailable'); // never "the request may have been queued"
    } finally {
      process.env.PATH = priorPath;
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }
  });
  test.skipIf(HOST_HAS_PM)('a pm that ran and exited 127 itself is not "unavailable"; a mutating call stays possibly-queued', async () => {
    const homeDir = tempDir('exit127-pm-home-');
    const binDir = join(homeDir, '.local', 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'pm'), "#!/bin/sh\necho 'pm: helper missing' >&2\nexit 127\n");
    chmodSync(join(binDir, 'pm'), 0o755);
    const priorPath = process.env.PATH;
    const priorHome = process.env.HOME;
    process.env.PATH = '/usr/bin:/bin';
    process.env.HOME = homeDir;
    try {
      const out = await callPm(spawnPmRunner, 'actions.request', { workspace: 'home', chat: 'c' });
      expect(out.kind).toBe('invalid-response');
      if (out.kind === 'invalid-response') expect(out.message).toContain('may have been queued');
    } finally {
      process.env.PATH = priorPath;
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }
  });
  test.skipIf(HOST_HAS_PM)('a hidden pm executable under the user bin works from a service PATH', async () => {
    const homeDir = tempDir('service-pm-home-');
    const binDir = join(homeDir, '.files', 'bin');
    mkdirSync(binDir, { recursive: true });
    const executable = join(binDir, 'pm');
    writeFileSync(executable, '#!/bin/sh\nprintf "service-pm:%s" "$1"\n');
    chmodSync(executable, 0o755);
    const priorPath = process.env.PATH;
    const priorHome = process.env.HOME;
    process.env.PATH = '/usr/bin:/bin';
    process.env.HOME = homeDir;
    try {
      const res = await spawnPmRunner(pmArgv('accounts.list', {}), { timeoutMs: 5000, maxBytes: 4096 });
      expect(res).toMatchObject({ kind: 'exit', code: 0 });
      if (res.kind === 'exit') expect(res.stdout).toBe('service-pm:chatgpt');
      chmodSync(executable, 0o644);
      expect(await spawnPmRunner(pmArgv('accounts.list', {}), { timeoutMs: 1000, maxBytes: 1024 })).toMatchObject({ kind: 'spawn-error', problem: { kind: 'not-found' } });
      // The same running process picks up a repair: no restart between the miss and the fix.
      chmodSync(executable, 0o755);
      expect(await spawnPmRunner(pmArgv('accounts.list', {}), { timeoutMs: 5000, maxBytes: 4096 })).toMatchObject({ kind: 'exit', code: 0 });
    } finally {
      process.env.PATH = priorPath;
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }
  });
  test('oversize output kills the whole process group', async () => {
    const dir = fakeBin('yes x');
    const res = await withPath(dir, () => spawnPmRunner(['pm', 'chatgpt', 'api', 'x', '--params', '{}'], { timeoutMs: 5000, maxBytes: 2048 }));
    expect(res.kind).toBe('oversize');
  });
  test('timeout kills the child AND its descendants', async () => {
    const dir = fakeBin(`sleep 60 &\necho $! > "${join('$(dirname "$0")', 'child.pid')}"\nwait`);
    const res = await withPath(dir, () => spawnPmRunner(['pm', 'chatgpt', 'api', 'x', '--params', '{}'], { timeoutMs: 400, maxBytes: 1024 }));
    expect(res.kind).toBe('timeout');
    const pidFile = join(dir, 'child.pid');
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number((await Bun.file(pidFile).text()).trim());
    // Real process table: poll for the group kill to land (a signalled child dies asynchronously);
    // fake timers cannot observe another process.
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try {
        process.kill(pid, 0);
        await Bun.sleep(20);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });
});
