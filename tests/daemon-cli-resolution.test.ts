import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fallbackDirs, findKnownCli, resolveKnownCli, serviceChildEnv } from '../features/tg-ctl/dependency-path';
import { SEARCHED_PLACES, describeDependencyProblem, interpreterFailureReason, isInterpreterMissing } from '../features/tg-ctl/dependency-problem';
import { hostHasSystemCli } from './helpers/system-cli';
import { tempDir } from './helpers/test-temp';

const options = (paths: readonly string[], path = '/usr/bin:/bin', home = '/Users/danny') => ({
  path,
  home,
  isExecutable: (candidate: string) => paths.includes(candidate),
});

describe('daemon CLI resolution (tg-cli#804)', () => {
  test('uses an installed pm visible to the daemon before home fallback', () => {
    expect(resolveKnownCli('pm', options(['/opt/tools/pm', '/Users/danny/.files/bin/pm'], '/opt/tools:/usr/bin'))).toBe('/opt/tools/pm');
  });
  test('recovers pm from the installed user bin when launchd hides it', () => {
    expect(resolveKnownCli('pm', options(['/Users/danny/.files/bin/pm']))).toBe('/Users/danny/.files/bin/pm');
  });
  test('recovers rig from Linux local user bin with a service PATH', () => {
    expect(resolveKnownCli('rig', options(['/home/ultra/.local/bin/rig'], '/usr/bin:/bin', '/home/ultra'))).toBe('/home/ultra/.local/bin/rig');
  });
  test('does not use missing or non-executable candidates', () => {
    expect(resolveKnownCli('rig', options([]))).toBeNull();
  });
  test('ignores empty and relative PATH segments to avoid executing cwd tools', () => {
    expect(resolveKnownCli('rig', options(['/Users/danny/.files/bin/rig', './rig', 'rig'], ':.:relative:/bin'))).toBe('/Users/danny/.files/bin/rig');
  });
  test('does not probe arbitrary homes or unknown dependency names', () => {
    expect(resolveKnownCli('pm', options(['/pm'], '/bin', '/'))).toBeNull();
    expect(resolveKnownCli('curl' as 'pm', options(['/Users/danny/.local/bin/curl']))).toBeNull();
  });
});

// launchd's default service PATH (see the `default environment` fixture in ctl-autostart.test.ts).
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

describe('service PATH recovery, platform independent (tg-cli#804)', () => {
  test.each([
    ['Linux ~/.local/bin', '/home/ultra', '/home/ultra/.local/bin/rig'],
    ['macOS ~/.local/bin', '/Users/danny', '/Users/danny/.local/bin/rig'],
    ['macOS ~/.files/bin', '/Users/danny', '/Users/danny/.files/bin/rig'],
    ['Apple Silicon Homebrew', '/Users/danny', '/opt/homebrew/bin/rig'],
    ['Intel Homebrew / manual', '/Users/danny', '/usr/local/bin/rig'],
  ])('finds rig under the launchd PATH: %s', (_label, home, installed) => {
    expect(resolveKnownCli('rig', options([installed], LAUNCHD_PATH, home))).toBe(installed);
  });
  test('the daemon PATH still wins over every fallback directory', () => {
    const found = resolveKnownCli('pm', options(['/usr/bin/pm', '/opt/homebrew/bin/pm', '/Users/danny/.local/bin/pm'], LAUNCHD_PATH));
    expect(found).toBe('/usr/bin/pm');
  });
  test('user bins are tried before the system-wide fallbacks', () => {
    expect(resolveKnownCli('pm', options(['/opt/homebrew/bin/pm', '/Users/danny/.local/bin/pm'], LAUNCHD_PATH))).toBe('/Users/danny/.local/bin/pm');
  });
  test('system-wide fallbacks work even with no HOME', () => {
    expect(resolveKnownCli('rig', { path: LAUNCHD_PATH, isExecutable: (c) => c === '/opt/homebrew/bin/rig' })).toBe('/opt/homebrew/bin/rig');
  });
});

describe.skipIf(hostHasSystemCli('rig'))('findKnownCli (real filesystem, same process, no restart)', () => {
  test('a tool installed after the first miss is found by the next lookup', () => {
    const home = tempDir('late-install-home-');
    const env = { PATH: LAUNCHD_PATH, HOME: home };
    expect(findKnownCli('rig', env)).toBeNull();
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    const exe = join(home, '.local', 'bin', 'rig');
    writeFileSync(exe, '#!/bin/sh\nexit 0\n');
    expect(findKnownCli('rig', env)).toBeNull(); // not executable yet
    chmodSync(exe, 0o755);
    expect(findKnownCli('rig', env)).toBe(exe);
  });
  test('a directory named like the tool is not an executable', () => {
    const home = tempDir('dir-named-rig-home-');
    mkdirSync(join(home, '.local', 'bin', 'rig'), { recursive: true });
    expect(findKnownCli('rig', { PATH: LAUNCHD_PATH, HOME: home })).toBeNull();
  });
});

describe('serviceChildEnv', () => {
  test('keeps the daemon PATH first and appends the tool dir and fallbacks once', () => {
    const env = serviceChildEnv({ PATH: LAUNCHD_PATH, HOME: '/Users/danny', LANG: 'C' }, '/opt/homebrew/bin/rig');
    expect(env.PATH).toBe(`${LAUNCHD_PATH}:/opt/homebrew/bin:/Users/danny/.local/bin:/Users/danny/.files/bin:/usr/local/bin`);
    expect(env.LANG).toBe('C');
  });
  test('does not duplicate a dir already on PATH and never mutates the input', () => {
    const input = { PATH: '/usr/bin:/opt/homebrew/bin', HOME: '/Users/danny' };
    const env = serviceChildEnv(input, '/opt/homebrew/bin/pm');
    expect(env.PATH!.split(':').filter((d) => d === '/opt/homebrew/bin')).toHaveLength(1);
    expect(input.PATH).toBe('/usr/bin:/opt/homebrew/bin');
  });
});

describe('describeDependencyProblem: friendly Telegram text instead of a raw spawn error', () => {
  const notFound = { kind: 'not-found', searchedPath: LAUNCHD_PATH } as const;
  test('pm missing names /chatgpt, the searched places, and says no restart is needed', () => {
    const text = describeDependencyProblem('pm', notFound);
    expect(text).toContain('/chatgpt');
    expect(text).toContain('`pm`');
    expect(text).toContain(LAUNCHD_PATH);
    expect(text).toContain('~/.local/bin');
    expect(text).toContain('/opt/homebrew/bin');
    expect(text).toContain('no restart');
    expect(text).toContain('tg-ctl restart --if-stale');
    expect(text).not.toMatch(/spawn|Executable not found/i);
  });
  test('rig missing names /spend and /daily', () => {
    const text = describeDependencyProblem('rig', notFound);
    expect(text).toContain('/spend');
    expect(text).toContain('/daily');
    expect(text).toContain('`rig`');
  });
  test('a found-but-unstartable tool is classified as broken, with its path and reason', () => {
    const text = describeDependencyProblem('rig', { kind: 'not-startable', path: '/Users/danny/.local/bin/rig', reason: 'ENOEXEC' });
    expect(text).toContain('/Users/danny/.local/bin/rig');
    expect(text).toContain('ENOEXEC');
    expect(text).toMatch(/found .* could not (be )?start/i);
    expect(text).not.toContain('not found');
  });
  test('the fix comes before the PATH, and a very long PATH is shortened, never the fix', () => {
    const longPath = Array.from({ length: 80 }, (_, i) => `/very/long/service/dir-${i}`).join(':');
    const text = describeDependencyProblem('pm', { kind: 'not-found', searchedPath: longPath });
    expect(text.indexOf('no restart is needed')).toBeLessThan(text.indexOf('Searched:'));
    expect(text.length).toBeLessThan(700);
    expect(text).toContain('…');
  });
  test('the shell wording (tg chatgpt) never mentions the daemon or Telegram', () => {
    const text = describeDependencyProblem('pm', notFound, 'shell');
    expect(text).toContain('run the command again');
    expect(text).not.toMatch(/daemon|restart|\/chatgpt again/i);
  });
  test('the searched-places text mirrors fallbackDirs', () => {
    for (const dir of fallbackDirs('/Users/danny')) expect(SEARCHED_PLACES).toContain(dir.replace('/Users/danny', '~'));
  });
});

describe('isInterpreterMissing: only env\'s own message proves the tool never ran', () => {
  test('GNU and BSD env messages with exit 127', () => {
    expect(isInterpreterMissing(127, "env: 'python3': No such file or directory\n")).toBe(true);
    expect(isInterpreterMissing(127, 'env: python3: No such file or directory\n')).toBe(true);
    // CI shape: env invoked by path, curly quotes.
    expect(isInterpreterMissing(127, '/usr/bin/env: \u2018definitely-missing\u2019: No such file or directory\n')).toBe(true);
    expect(interpreterFailureReason('/usr/bin/env: \u2018definitely-missing\u2019: No such file or directory\n')).toBe('/usr/bin/env: \u2018definitely-missing\u2019: No such file or directory');
    expect(interpreterFailureReason("noise\nenv: 'python3': No such file or directory\n")).toBe("env: 'python3': No such file or directory");
  });
  test('the tool\'s own 127, silent 127 or another exit code is not an interpreter failure', () => {
    expect(isInterpreterMissing(127, 'gh: command not found\n')).toBe(false);
    expect(isInterpreterMissing(127, '')).toBe(false);
    expect(isInterpreterMissing(1, "env: 'python3': No such file or directory\n")).toBe(false);
    expect(isInterpreterMissing(null, "env: 'python3': No such file or directory\n")).toBe(false);
  });
});
