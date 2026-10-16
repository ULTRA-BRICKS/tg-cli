// `tg auth user|caller`, `tg call`, `tg user send` — the Bun side of the MTProto sidecar
// (docs/specs/independent-telegram-clients.md §1). Pure parsing/handoff tests, then the REAL
// `tg` binary spawned against a fake sidecar (TG_MTPROTO_SIDECAR) to prove the argv/env/stdin
// it hands over and the "not logged in" path, which must never start the sidecar.
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tempDir } from './helpers/test-temp';
import { parseUserAccountArgs } from '../features/user-account/args';
import {
  BUILD_STEP_TIMEOUT_MS,
  buildBusyError,
  buildWaitMs,
  runtimeDir,
  runtimeSetupSteps,
  sidecarInvocation,
} from '../features/user-account/sidecar';
import { ensureSidecarRuntime } from '../features/user-account/sidecar-fs';
import { describeError } from '../features/user-account/messages';
import { USER_ACCOUNT_HELP } from '../features/user-account/help';

const TG = join(import.meta.dir, '..', 'tg');

describe('parseUserAccountArgs', () => {
  test('is null for everything that is not ours, so plain sends still send', () => {
    expect(parseUserAccountArgs(['call me later'])).toBeNull();
    expect(parseUserAccountArgs(['user'])).toBeNull();
    expect(parseUserAccountArgs(['user', 'find', 'x'])).toBeNull();
    expect(parseUserAccountArgs(['hello'])).toBeNull();
    // `tg auth …` (bot AND user/caller) belongs to the one auth parser (tests/auth-args.test.ts).
    expect(parseUserAccountArgs(['auth'])).toBeNull();
    expect(parseUserAccountArgs(['auth', 'user'])).toBeNull();
    expect(parseUserAccountArgs(['auth', 'caller', 'status'])).toBeNull();
  });

  test('tg call: peer, media, --from, me implies the caller account', () => {
    expect(parseUserAccountArgs(['call', '@alice', '--say', 'hi'])).toEqual({
      kind: 'call', role: 'personal', peer: '@alice', say: 'hi', dryRun: false, json: false, sourceIdle: false,
    });
    expect(parseUserAccountArgs(['call', 'me', '--audio', 'a.ogg', '--dry-run', '--timeout', '30'])).toEqual({
      kind: 'call', role: 'caller', peer: 'me', audio: 'a.ogg', timeout: '30', dryRun: true, json: false, sourceIdle: false,
    });
    expect(parseUserAccountArgs(['call', '@bob', '--from', 'caller', '--say', 'x', '--source-idle-confirmed'])).toMatchObject({
      role: 'caller', sourceIdle: true,
    });
    const errors: string[][] = [
      ['call'],
      ['call', '@a'],
      ['call', '@a', '--say', 'x', '--audio', 'y'],
      ['call', 'me', '--from', 'user', '--say', 'x'],
      ['call', '@a', '--from', 'robot', '--say', 'x'],
      ['call', '@a', 'extra', '--say', 'x'],
      ['call', '@a', '--timeout', 'soon', '--say', 'x'],
      ['call', '@a', '--bogus'],
    ];
    for (const argv of errors) expect(parseUserAccountArgs(argv)).toMatchObject({ kind: 'error' });
    expect(parseUserAccountArgs(['call', '--help'])).toEqual({ kind: 'help', topic: 'call' });
  });

  // docs/specs/independent-telegram-clients.md §1 "Flag values never swallow flags".
  test('tg call: a flag after --say/--audio/--from/--timeout is never taken as its value', () => {
    for (const argv of [
      ['call', '@a', '--say', '--dry-run'],
      ['call', '@a', '--audio', '--dry-run'],
      ['call', '@a', '--say', '--json', '--dry-run'],
      ['call', '@a', '--say', '-h'],
      ['call', '@a', '--say', 'x', '--from', '--dry-run'],
      ['call', '@a', '--say', 'x', '--timeout', '--dry-run'],
      ['call', '@a', '--dry-run', '--say', '--source-idle-confirmed'],
      // `=` form carries any text, but not one of the command's own flags
      ['call', '@a', '--say=--dry-run'],
      ['call', '@a', '--audio=--json'],
      // booleans take no value; `call` has no `--`, so no flag-looking peer
      ['call', '@a', '--say', 'x', '--dry-run=1'],
      ['call', '--', '--dry-run', '--say', 'x'],
      ['call', '@a', '--say', 'x', '--', '--dry-run'],
    ]) {
      expect({ argv, parsed: parseUserAccountArgs(argv) }).toMatchObject({ argv, parsed: { kind: 'error' } });
    }
    expect(parseUserAccountArgs(['call', '@a', '--say', '--dry-run'])).toEqual({
      kind: 'error', message: expect.stringContaining('--say='),
    });
    expect(parseUserAccountArgs(['call', '@a', '--say=-5 °C outside', '--dry-run'])).toMatchObject({
      kind: 'call', say: '-5 °C outside', dryRun: true,
    });
    expect(parseUserAccountArgs(['call', '@a', '--audio=/tmp/a.ogg', '--timeout=30'])).toMatchObject({
      kind: 'call', audio: '/tmp/a.ogg', timeout: '30', dryRun: false,
    });
  });

  test('tg user send: text from argv or stdin; `--` ends options; flags anywhere', () => {
    expect(parseUserAccountArgs(['user', 'send', '@alice', 'hello', 'there'])).toEqual({
      kind: 'send', peer: '@alice', text: 'hello there', dryRun: false, json: false, sourceIdle: false,
    });
    expect(parseUserAccountArgs(['user', 'send', 'me', '--dry-run'])).toEqual({
      kind: 'send', peer: 'me', dryRun: true, json: false, sourceIdle: false,
    });
    expect(parseUserAccountArgs(['user', 'send', '@a', 'hi', '--dry-run'])).toMatchObject({ text: 'hi', dryRun: true });
    expect(parseUserAccountArgs(['user', 'send', '@a', '--', '--not-a-flag', 'x'])).toMatchObject({
      text: '--not-a-flag x', dryRun: false,
    });
    expect(parseUserAccountArgs(['user', 'send', '-100123', 'hi'])).toMatchObject({ peer: '-100123', text: 'hi' });
    expect(parseUserAccountArgs(['user', 'send'])).toMatchObject({ kind: 'error' });
    expect(parseUserAccountArgs(['user', 'send', '@a', '--dry-run=yes'])).toMatchObject({ kind: 'error' });
  });
});

describe('sidecarInvocation', () => {
  test('maps each command onto `python -m telegram_client <role> --store=…`, values in `=` form', () => {
    const store = '/cfg/mtproto';
    const login = sidecarInvocation({ kind: 'login', role: 'caller', qr: true, expectedId: '42', json: false }, store);
    expect(login).toEqual({ args: ['caller', `--store=${store}`, 'login', '--qr', '--expected-id=42'] });
    expect(login.stdin).toBeUndefined(); // login prompts read tg's own terminal
    expect(
      sidecarInvocation({ kind: 'call', role: 'caller', peer: 'me', say: 'Тони написал', timeout: '30', dryRun: true, json: false, sourceIdle: true }, store),
    ).toEqual({
      args: ['caller', `--store=${store}`, 'call', '--peer=me', '--say-stdin', '--context-stdin', '--timeout=30', '--dry-run', '--source-session-idle-confirmed'],
      stdin: JSON.stringify({ say: 'Тони написал' }),
    });
    // A dash-leading value reaches argparse as one `--say=…` token, never as a separate word.
    expect(
      sidecarInvocation({ kind: 'call', role: 'personal', peer: '@a', say: '-5 °C', dryRun: false, json: false, sourceIdle: false }, store).args,
    ).toEqual(['personal', `--store=${store}`, 'call', '--peer=@a', '--say-stdin', '--context-stdin']);
    expect(
      sidecarInvocation({ kind: 'import', role: 'caller', session: '/s/v.session', config: '/s/.env', json: false }, store).args,
    ).toEqual(['caller', `--store=${store}`, 'import-session', '--source-session=/s/v.session', '--source-config=/s/.env']);
    const send = sidecarInvocation({ kind: 'send', peer: '-100123', text: 'secret plan', dryRun: false, json: false, sourceIdle: false }, store);
    expect(send).toEqual({ args: ['personal', `--store=${store}`, 'send', '--peer=-100123'], stdin: 'secret plan' });
    expect(send.args.join(' ')).not.toContain('secret plan');
  });

  test('a build waiter outlasts any live build and never advises deleting a live lock', () => {
    const steps = runtimeSetupSteps('/bin/uv', '/v', '/l').length;
    expect(buildWaitMs(steps)).toBeGreaterThanOrEqual(steps * BUILD_STEP_TIMEOUT_MS);
    const text = buildBusyError(4242, '/c/tg-cli/mtproto-runtime-abc', buildWaitMs(steps));
    expect(text).toContain('4242');
    expect(text).not.toMatch(/remove|delete|rm /i);
    expect(text).not.toContain('.building');
  });

  test('runtime dir is keyed by the lock hash so a lock change builds a fresh venv', () => {
    expect(runtimeDir('/home/u/.cache', 'abcdef0123456789')).toBe('/home/u/.cache/tg-cli/mtproto-runtime-abcdef012345');
  });

  test('error codes become WHAT/HOW text', () => {
    expect(describeError('SESSION_MISSING', 'caller')).toContain('tg auth caller');
    expect(describeError('SESSION_ALREADY_EXISTS', 'personal')).toContain('tg auth user logout');
    expect(describeError('TTS_UNAVAILABLE', 'personal')).toContain('voice.json');
    expect(describeError('TTS_UNAVAILABLE', 'personal')).toContain('raw audio still needs the spoken introduction');
    expect(describeError('SOMETHING_NEW', 'personal')).toContain('SOMETHING_NEW');
  });
});

// --- the real `tg` binary against a fake sidecar ---------------------------------------

interface Fixture {
  home: string;
  configDir: string;
  capture: string;
  fake: string;
}

function fixture(): Fixture {
  const home = tempDir('tg-ua-home-');
  const configDir = join(home, 'cfg');
  const capture = join(home, 'capture');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(capture);
  const fake = join(home, 'fake-sidecar');
  writeFileSync(
    fake,
    [
      '#!/bin/sh',
      'printf "%s\\n" "$@" > "$TG_FAKE_CAPTURE/argv"',
      'env > "$TG_FAKE_CAPTURE/env"',
      'cat > "$TG_FAKE_CAPTURE/stdin"',
      'printf "%s\\n" "$TG_FAKE_STDOUT"',
      'exit "${TG_FAKE_EXIT:-0}"',
      '',
    ].join('\n'),
  );
  chmodSync(fake, 0o755);
  return { home, configDir, capture, fake };
}

function loggedIn(configDir: string, role: 'personal' | 'caller'): void {
  mkdirSync(join(configDir, 'mtproto'), { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir, 'mtproto', `${role}.json`), '{}', { mode: 0o600 });
}

async function tg(args: string[], f: Fixture, extra: Record<string, string> = {}, stdin?: string) {
  const proc = Bun.spawn(['bun', TG, ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: f.home,
      TG_CTL_CONFIG_DIR: f.configDir,
      TG_MTPROTO_SIDECAR: f.fake,
      TG_FAKE_CAPTURE: f.capture,
      TG_BOT_TOKEN: '1:bot-token-must-not-leak',
      ...extra,
    },
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe('tg → sidecar handoff (real binary, fake sidecar)', () => {
  test('tg call --dry-run hands the exact argv, config dir and features path to the sidecar', async () => {
    const f = fixture();
    loggedIn(f.configDir, 'caller');
    loggedIn(f.configDir, 'personal');
    writeFileSync(join(f.configDir, '.env'), 'TG_API_ID=5\nTG_API_HASH=dotenv-hash\nTG_BOT_TOKEN=9:from-dotenv\n');
    const plan = { dry_run: true, role: 'caller', peer: 'me', recipient_id: 7, media: 'say', tts_engine: 'say', missing: [], ready: true };
    const r = await tg(['call', 'me', '--say', 'Тони написал в Telegram', '--dry-run'], f, { TG_FAKE_STDOUT: JSON.stringify(plan) });
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(f.capture, 'argv'), 'utf8').trimEnd().split('\n')).toEqual([
      'caller', `--store=${join(f.configDir, 'mtproto')}`, 'call', '--peer=me', '--say-stdin', '--context-stdin', '--dry-run',
    ]);
    expect(JSON.parse(readFileSync(join(f.capture, 'stdin'), 'utf8')).say).toBe('Тони написал в Telegram');
    const env = readFileSync(join(f.capture, 'env'), 'utf8');
    expect(env).toContain(`TG_CTL_CONFIG_DIR=${f.configDir}\n`);
    expect(env).toContain(`PYTHONPATH=${join(import.meta.dir, '..', 'features')}`);
    expect(env).not.toContain('TG_API_ID=');
    expect(env).not.toContain('TG_API_HASH=');
    expect(env).toContain('PYTHONDONTWRITEBYTECODE=1\n');
    expect(env).not.toContain('from-dotenv');
    expect(env).not.toContain('bot-token-must-not-leak'); // exported in tg's own env by tg()
    expect(r.stdout).toContain('ready');
    expect(r.stdout).toContain('id 7');
  });

  test('not logged in: one actionable line, exit 3, sidecar never started', async () => {
    const f = fixture();
    const r = await tg(['call', '@alice', '--say', 'hi'], f);
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain('not logged in');
    expect(r.stderr).toContain('tg auth user');
    expect(existsSync(join(f.capture, 'argv'))).toBe(false);

    const me = await tg(['call', 'me', '--say', 'hi'], f);
    expect(me.exitCode).toBe(3);
    expect(me.stderr).toContain('tg auth caller');

    const send = await tg(['user', 'send', '@alice', 'hi'], f);
    expect(send.exitCode).toBe(3);
    expect(send.stderr).toContain('tg auth user');
    expect(existsSync(join(f.capture, 'argv'))).toBe(false);
  });

  test('tg user send pipes the text on stdin, never argv, and prints the sent id', async () => {
    const f = fixture();
    loggedIn(f.configDir, 'personal');
    writeFileSync(join(f.configDir, '.env'), 'TG_API_ID=5\nTG_API_HASH=dotenv-hash\n');
    const r = await tg(['user', 'send', '@alice'], f, { TG_FAKE_STDOUT: '{"sent": true, "chat_id": 9, "message_id": 31}' }, 'meet at 5');
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(f.capture, 'stdin'), 'utf8')).toBe('meet at 5');
    expect(readFileSync(join(f.capture, 'argv'), 'utf8')).not.toContain('meet at 5');
    expect(r.stdout).toContain('31');
    const env = readFileSync(join(f.capture, 'env'), 'utf8');
    expect(env).toContain('TG_API_ID=5\n');
    expect(env).toContain('TG_API_HASH=dotenv-hash\n');
  });

  test('a sidecar error code becomes a human message with the same exit code; --json stays raw', async () => {
    const f = fixture();
    loggedIn(f.configDir, 'personal');
    const out = '{"ok": false, "error": "PEER_NOT_FOUND"}';
    const r = await tg(['call', '@ghost', '--audio', 'x.ogg'], f, { TG_FAKE_STDOUT: out, TG_FAKE_EXIT: '3' });
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain('@ghost');
    const raw = await tg(['call', '@ghost', '--audio', 'x.ogg', '--json'], f, { TG_FAKE_STDOUT: out, TG_FAKE_EXIT: '3' });
    expect(raw.exitCode).toBe(3);
    expect(raw.stdout.trim()).toBe(out);
  });

  test('tg auth user status runs without a session and reports it', async () => {
    const f = fixture();
    const r = await tg(['auth', 'user', 'status'], f, {
      TG_FAKE_STDOUT: '{"role": "personal", "configured": false, "reason": "SESSION_MISSING"}',
      TG_FAKE_EXIT: '3',
    });
    expect(r.exitCode).toBe(3);
    expect(readFileSync(join(f.capture, 'argv'), 'utf8').trimEnd().split('\n')).toEqual([
      'personal', `--store=${join(f.configDir, 'mtproto')}`, 'status',
    ]);
    expect(r.stdout + r.stderr).toContain('tg auth user');
  });

  test('a usage error exits 2 before any sidecar', async () => {
    const f = fixture();
    loggedIn(f.configDir, 'personal');
    const r = await tg(['call', '@a', '--say', 'x', '--audio', 'y'], f);
    expect(r.exitCode).toBe(2);
    expect(existsSync(join(f.capture, 'argv'))).toBe(false);
  });

  test('`tg call @a --say --dry-run` is a usage error: no sidecar, no call', async () => {
    const f = fixture();
    loggedIn(f.configDir, 'personal');
    loggedIn(f.configDir, 'caller');
    for (const argv of [
      ['call', '@a', '--say', '--dry-run'],
      ['call', 'me', '--audio', '--dry-run'],
      ['call', '@a', '--say=--dry-run'],
      ['call', '@a', '--say', 'x', '--timeout', '--dry-run'],
    ]) {
      const r = await tg(argv, f, { TG_FAKE_STDOUT: '{"ok": true}' });
      expect({ argv, exitCode: r.exitCode }).toEqual({ argv, exitCode: 2 });
      expect(r.stderr).toContain('Error:');
      expect(existsSync(join(f.capture, 'argv'))).toBe(false);
    }
  });

  test('two first runs at once build the runtime once (uv venv + uv pip install --require-hashes)', async () => {
    const f = fixture();
    const bin = join(f.home, 'bin');
    mkdirSync(bin);
    const uvLog = join(f.home, 'uv.log');
    // Fake uv: logs each step; `venv` creates a python that answers like the sidecar's status.
    writeFileSync(
      join(bin, 'uv'),
      [
        '#!/bin/sh',
        'echo "$*" >> "$UV_LOG"',
        'if [ "$1" = venv ]; then',
        '  mkdir -p "$5/bin"',
        `  printf '#!/bin/sh\\necho "{\\\\"role\\\\": \\\\"personal\\\\", \\\\"configured\\\\": false}"\\nexit 3\\n' > "$5/bin/python"`,
        '  chmod +x "$5/bin/python"',
        '  sleep 1',
        'fi',
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, 'uv'), 0o755);
    const env = {
      TG_MTPROTO_SIDECAR: '',
      XDG_CACHE_HOME: join(f.home, 'cache'),
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      UV_LOG: uvLog,
    };
    const [a, b] = await Promise.all([tg(['auth', 'user', 'status'], f, env), tg(['auth', 'user', 'status'], f, env)]);
    for (const r of [a, b]) {
      expect(r.exitCode).toBe(3);
      expect(r.stdout).toContain('not logged in');
    }
    const steps = readFileSync(uvLog, 'utf8').trimEnd().split('\n');
    expect(steps.filter((s) => s.startsWith('venv '))).toHaveLength(1);
    expect(steps.filter((s) => s.startsWith('pip install')).map((s) => s.includes('--require-hashes'))).toEqual([true]);
  });

  test('a live builder is waited for, never overridden, and the error names its pid without advising lock removal', async () => {
    const f = fixture();
    const repo = join(f.home, 'repo');
    mkdirSync(join(repo, 'features', 'telegram_client'), { recursive: true });
    writeFileSync(join(repo, 'requirements-call.txt'), 'pkg==1 --hash=sha256:00\n');
    const cache = join(f.home, 'cache');
    const sha = new Bun.CryptoHasher('sha256').update('pkg==1 --hash=sha256:00\n').digest('hex');
    const lockDir = `${runtimeDir(cache, sha)}.building`;
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'pid'), String(process.pid)); // this test process: alive
    const r = await ensureSidecarRuntime(repo, cache, { uv: '/nonexistent/uv', waitMs: 300 });
    expect(r).toEqual({ error: expect.stringContaining(String(process.pid)) });
    expect('error' in r ? r.error : '').not.toMatch(/remove|delete|rm /i);
    expect(existsSync(join(lockDir, 'pid'))).toBe(true); // the live owner's lock is untouched
  });
});

test('call help describes configured neural TTS and honest stream completion', () => {
  const help = USER_ACCOUNT_HELP.call;
  expect(help).toContain('configured neural TTS');
  expect(help).toContain('host voice requires explicit opt-in');
  expect(help).toContain('no silent fallback');
  expect(help).toContain('audio_stream_ended');
  expect(help).toContain('not proof the recipient heard it');
  expect(help).toContain('<config>/mtproto/calls/journal.sqlite3');
  expect(help).not.toContain('Success = the audio played to the end');
  expect(help).not.toContain('or speaks the text with macOS');
});
