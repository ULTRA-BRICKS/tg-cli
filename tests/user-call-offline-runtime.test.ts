// Offline preflight must inspect the installed runtime, without building one or reading auth.
import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { userAccountDeps } from '../features/user-account/sidecar-fs';
import { runtimeDir } from '../features/user-account/sidecar';
import { tempDir } from './helpers/test-temp';

async function runtimeFixture(ready: boolean | 'stale' | 'linked' | 'oversized' | 'boundary', interpreter: boolean, expected: 'cached' | 'system') {
  const home = tempDir('call-offline-runtime-');
  const repo = join(home, 'repo');
  const cache = join(home, 'cache');
  mkdirSync(repo, { recursive: true });
  const lock = 'fixture-only pinned requirements\n';
  writeFileSync(join(repo, 'requirements-call.txt'), lock);
  const sha = new Bun.CryptoHasher('sha256').update(lock).digest('hex');
  const venv = runtimeDir(cache, sha);
  mkdirSync(join(venv, 'bin'), { recursive: true });
  if (ready === 'linked') {
    const linked = join(home, 'other-marker');
    writeFileSync(linked, sha);
    symlinkSync(linked, join(venv, '.tg-ready'));
  } else if (ready) {
    const body = ready === true ? sha : ready === 'oversized' ? sha + ' '.repeat(100)
      : ready === 'boundary' ? sha + ' '.repeat(64) : 'stale-lock-hash';
    writeFileSync(join(venv, '.tg-ready'), body);
  }
  if (interpreter) {
    writeFileSync(join(venv, 'bin', 'python'), '#!/bin/sh\nexit 99\n');
    chmodSync(join(venv, 'bin', 'python'), 0o755);
  }
  const previousCache = process.env.XDG_CACHE_HOME;
  const previousOverride = process.env.TG_MTPROTO_SIDECAR;
  process.env.XDG_CACHE_HOME = cache;
  delete process.env.TG_MTPROTO_SIDECAR;
  try {
    const result = await userAccountDeps(join(home, 'config'), repo, home).sidecarCommand(true);
    expect(result).toEqual({ argv: [expected === 'cached' ? join(venv, 'bin', 'python') : 'python3', '-m', 'telegram_client'] });
  } finally {
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousCache;
    if (previousOverride === undefined) delete process.env.TG_MTPROTO_SIDECAR;
    else process.env.TG_MTPROTO_SIDECAR = previousOverride;
  }
}

test('offline preflight reuses the completed pinned runtime without executing or rebuilding it', () => runtimeFixture(true, true, 'cached'));
test('offline preflight never uses a half-built runtime', () => runtimeFixture(false, true, 'system'));
test('offline preflight ignores a completion marker whose interpreter is missing', () => runtimeFixture(true, false, 'system'));

test('offline preflight refuses a completion marker for different requirements', () => runtimeFixture('stale', true, 'system'));

test.skipIf(process.platform === 'win32')('offline preflight refuses a redirected completion marker', () => runtimeFixture('linked', true, 'system'));
test('offline preflight bounds reads of an oversized completion marker', () => runtimeFixture('oversized', true, 'system'));
test('offline preflight accepts the documented marker size boundary', () => runtimeFixture('boundary', true, 'cached'));
