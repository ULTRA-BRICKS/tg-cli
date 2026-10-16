// Offline frontdoor contracts: fake sidecar and temporary config; no API sockets.
import { expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseUserAccountArgs } from '../features/user-account/args';
import { runUserAccount } from '../features/user-account/cli';
import { sidecarInvocation } from '../features/user-account/sidecar';
import * as configEnv from '../features/config/env';
import { userAccountDeps } from '../features/user-account/sidecar-fs';
import { ctlPaths } from '../features/tg-ctl/lock';
import { tempDir } from './helpers/test-temp';

const root = join(import.meta.dir, '..');

test('metadata options, stable ids, titles and URLs travel over stdin without speech in argv', () => {
  const parsed = parseUserAccountArgs(['call', 'me', '--say', 'secret $(literal)', '--agent', 'worker', '--task', 'OPS-1', '--task-title', 'Print Ops', '--task-url', 'https://example.test/OPS-1', '--session', 'omp:session', '--project', 'house', '--kind', 'problem']);
  expect(parsed?.kind).toBe('call');
  if (!parsed || parsed.kind !== 'call') throw new Error('call parse');
  const invocation = sidecarInvocation(parsed, '/cfg/mtproto');
  expect(invocation.args.join(' ')).not.toContain('secret');
  expect(invocation.args.join(' ')).not.toContain('Print Ops');
  expect(JSON.parse(invocation.stdin ?? '')).toMatchObject({ say: 'secret $(literal)', agent: 'worker', task: 'OPS-1', task_title: 'Print Ops', kind: 'problem', session: 'omp:session' });
  expect(parseUserAccountArgs(['call', 'me', '--say', 'x', '--kind', 'robot'])).toMatchObject({ kind: 'error' });
  expect(parseUserAccountArgs(['call', 'me', '--say', 'x', '--agent', '--dry-run'])).toMatchObject({ kind: 'error' });
});

test('tg and call-cli use identical shared sidecar/store and private stdin payload', async () => {
  const home = tempDir('call-frontdoor-');
  const config = join(home, 'cfg');
  mkdirSync(join(config, 'mtproto'), { recursive: true });
  writeFileSync(join(config, 'mtproto', 'caller.json'), '{}');
  writeFileSync(join(config, 'mtproto', 'personal.json'), '{}');
  const fake = join(home, 'sidecar');
  writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE.argv"\ncat > "$CAPTURE.stdin"\nprintf \'{"state":"audio_stream_ended","call_id":"fixture"}\\n\'\n');
  chmodSync(fake, 0o755);
  const invocations = [];
  for (const [name, prefix] of [['tg', ['call']], ['call-cli', []]] as const) {
    const capture = join(home, name);
    const proc = Bun.spawn(['bun', join(root, name), ...prefix, 'me', '--say', 'secret text', '--agent', 'explicit', '--task', 'OPS-7', '--json'], {
      env: { ...process.env, HOME: home, TG_CTL_CONFIG_DIR: config, TG_MTPROTO_SIDECAR: fake, CAPTURE: capture, TG_SESSION: 'inherited', RIG_AGENT_ID: 'fallback' },
      stdout: 'pipe', stderr: 'pipe', timeout: 5000,
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ stdout, stderr, code }).toMatchObject({ code: 0, stderr: '' });
    const argv = readFileSync(capture + '.argv', 'utf8');
    const payload = JSON.parse(readFileSync(capture + '.stdin', 'utf8'));
    expect(argv).not.toContain('secret text');
    expect(argv).toContain(`--store=${join(config, 'mtproto')}`);
    expect(payload).toMatchObject({ say: 'secret text', agent: 'explicit', task: 'OPS-7', session: 'inherited' });
    invocations.push({ argv, payload });
  }
  expect(invocations[0]).toEqual(invocations[1]);
});

test('offline runtime selection for history and dry-run never bootstraps dependencies', async () => {
  const home = tempDir('call-offline-');
  const deps = userAccountDeps(join(home, 'config'), root, home);
  expect(await deps.sidecarCommand(true)).toEqual({ argv: ['python3', '-m', 'telegram_client'] });
  expect(existsSync(join(home, '.cache'))).toBe(false);
  expect(parseUserAccountArgs(['call', 'history', 'show', 'id', '--json'])).toMatchObject({ kind: 'call-history', action: 'show', callId: 'id', json: true });
});

test('registry provides session title separately and never treats cwd or title as task id', () => {
  const home = tempDir('call-registry-');
  const config = join(home, 'cfg');
  mkdirSync(config);
  writeFileSync(join(config, '.env'), 'TG_BOT_TOKEN=9:fixture\n');
  writeFileSync(ctlPaths(config, '9').sessions, JSON.stringify({ schemaVersion: 2, sessions: [{ key: 'omp:s-1', harness: 'omp', sessionId: 's-1', state: 'live', firstSeen: 'now', lastSeen: 'now', locators: { pid: 22 }, name: { primary: '3d-house', secondary: 'Print Ops' }, cwd: '/task/this-is-not-an-id' }] }));
  const deps = userAccountDeps(config, root, home);
  const parsed = parseUserAccountArgs(['call', 'me', '--say', 'x', '--session', 's-1']);
  if (!parsed || parsed.kind !== 'call') throw new Error('call parse');
  const context = deps.callContext?.(parsed);
  expect(context).toMatchObject({ session: 'omp:s-1', sessionTitle: 'Print Ops' });
  expect(context?.task).toBeUndefined();
  expect(context?.project).toBeUndefined();
});

test('real call-cli dry-run without sessions returns composed plan and creates no state', async () => {
  const home = tempDir('call-plan-');
  const config = join(home, 'cfg');
  const proc = Bun.spawn(['bun', join(root, 'call-cli'), 'me', '--say', 'Принтер сломан', '--agent', '3d-house', '--task-title', 'Print Ops', '--kind', 'problem', '--dry-run', '--json'], {
    env: { PATH: process.env.PATH, HOME: home, TG_CTL_CONFIG_DIR: config },
    stdout: 'pipe', stderr: 'pipe', timeout: 5000,
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(stderr).toBe('');
  expect(code).toBe(3);
  expect(JSON.parse(stdout)).toMatchObject({ dry_run: true, references: { agent: { id: '3d-house' }, task: { title: 'Print Ops' } } });
  expect(JSON.parse(stdout).spoken_text).toContain('Привет! 3d-house. Проблема с Print Ops.');
  expect(existsSync(config)).toBe(false);
  expect(existsSync(join(home, '.cache'))).toBe(false);
});

test('history task and project filters share the Python frontdoor', () => {
  const parsed = parseUserAccountArgs(['call', 'history', 'list', '--task', 'OPS-7', '--project', 'house', '--json']);
  expect(parsed).toMatchObject({ kind: 'call-history', task: 'OPS-7', project: 'house' });
  if (!parsed || parsed.kind !== 'call-history') throw new Error('history parse');
  expect(sidecarInvocation(parsed, '/cfg/mtproto').args).toContain('--task=OPS-7');
  expect(sidecarInvocation(parsed, '/cfg/mtproto').args).toContain('--project=house');
});


test('explicit flags override env and registry while registry labels never become task ids', async () => {
  const home = tempDir('call-priority-');
  const config = join(home, 'cfg');
  mkdirSync(config);
  writeFileSync(join(config, '.env'), 'TG_BOT_TOKEN=9:fixture\n');
  writeFileSync(ctlPaths(config, '9').sessions, JSON.stringify({ schemaVersion: 2, sessions: [{ key: 'omp:s-1', harness: 'omp', sessionId: 's-1', state: 'live', firstSeen: 'now', lastSeen: 'now', locators: { pid: 22 }, name: { primary: 'Registry Agent', secondary: 'Registry Title' } }] }));
  const registryDeps = userAccountDeps(config, root, home);
  for (const explicit of [false, true]) {
    const parsed = parseUserAccountArgs(['call', 'me', '--say', 'x', '--session', 's-1', '--json', ...(explicit ? ['--agent', 'Flag Agent', '--session-title', 'Flag Title'] : [])]);
    if (!parsed || parsed.kind !== 'call') throw new Error('parse');
    let payload = {};
    await runUserAccount(parsed, {
      ...registryDeps, exists: () => true,
      sidecarCommand: async () => ({ argv: ['fixture'] }),
      spawn: async (_argv, stdin) => { payload = JSON.parse(stdin ?? '{}'); return { stdout: '{}', exitCode: 0 }; },
      log: () => {}, errlog: () => {},
    });
    expect(payload).toMatchObject(explicit ? { agent: 'Flag Agent', session_title: 'Flag Title' } : { session_title: 'Registry Title' });
    if (!explicit && !process.env.RIG_AGENT_ID) expect(payload).toMatchObject({ agent_title: 'Registry Agent' });
    expect(payload).not.toHaveProperty('task');
    expect(payload).not.toHaveProperty('project');
  }
});

test('environment agent wins registry label and environment session resolves registry title', async () => {
  const home = tempDir('call-env-priority-');
  const config = join(home, 'cfg');
  mkdirSync(config);
  writeFileSync(join(config, '.env'), 'TG_BOT_TOKEN=9:fixture\n');
  writeFileSync(ctlPaths(config, '9').sessions, JSON.stringify({ schemaVersion: 2, sessions: [{ key: 'omp:s-1', harness: 'omp', sessionId: 's-1', state: 'live', firstSeen: 'now', lastSeen: 'now', locators: { pid: 22 }, name: { primary: 'Registry Agent', secondary: 'Registry Title' } }] }));
  const fake = join(home, 'sidecar');
  writeFileSync(fake, '#!/bin/sh\ncat\n');
  chmodSync(fake, 0o755);
  const proc = Bun.spawn(['bun', join(root, 'call-cli'), 'me', '--say', 'x', '--dry-run', '--json'], {
    env: { PATH: process.env.PATH, HOME: home, TG_CTL_CONFIG_DIR: config, TG_MTPROTO_SIDECAR: fake, RIG_AGENT_ID: 'Environment Agent', TG_SESSION: 's-1', TG_BOT_TOKEN: '9:fixture' },
    stdout: 'pipe', stderr: 'pipe', timeout: 5000,
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect({ stderr, code }).toEqual({ stderr: '', code: 0 });
  expect(JSON.parse(stdout)).toMatchObject({ agent: 'Environment Agent', session: 'omp:s-1', session_title: 'Registry Title' });
  expect(JSON.parse(stdout)).not.toHaveProperty('agent_title');
});


test('offline dependency creation and dry-run never read the credential dotenv', async () => {
  const home = tempDir('call-no-credential-read-');
  const readEnv = spyOn(configEnv, 'loadEnv').mockImplementation(() => ({ TG_BOT_TOKEN: '9:fixture' }));
  try {
    const deps = userAccountDeps(join(home, 'cfg'), root, home);
    expect(readEnv).not.toHaveBeenCalled();
    const parsed = parseUserAccountArgs(['call', 'me', '--say', 'x', '--dry-run']);
    if (!parsed || parsed.kind !== 'call') throw new Error('parse');
    deps.callContext?.(parsed);
    await deps.sidecarCommand(true);
    const spawned = await deps.spawn(['bun', '-e', 'process.stdout.write((process.env.PYTHONDONTWRITEBYTECODE ?? "missing") + "\\n")'], undefined);
    expect(spawned.stdout.trim()).toBe('1');
    expect(readEnv).not.toHaveBeenCalled();
  } finally {
    readEnv.mockRestore();
  }
});
