// tg-cli#486 / #550: a test run must leave nothing behind — no temp dir in TMPDIR, no daemon or
// abduco server. The guard keeps every temp dir going through tests/helpers/test-temp.ts (whose
// dirs the preload removes when the run ends); the leak check runs real integration files in a
// child `bun test` with a private TMPDIR and asserts that dir comes back empty and no process
// carrying it survives.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';
import { runProcesses, tempDir } from './helpers/test-temp';

const TESTS = import.meta.dir;
const ROOT = join(TESTS, '..');
const ALLOWED = new Set(['helpers/test-temp.ts', 'temp-hygiene.test.ts']);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'fixtures' ? [] : sources(path);
    return /\.(ts|mjs|js)$/.test(e.name) ? [path] : [];
  });
}

/**
 * True when this `bun test` runs the whole suite once: no `-t` filter, no watch mode, and every
 * path argument a directory (`bun test`, `bun test ./tests`). bun hides its own argv from the
 * test, so this reads /proc; elsewhere it answers false.
 */
function wholeSuiteRun(): boolean {
  let argv: string[];
  try {
    argv = readFileSync('/proc/self/cmdline', 'utf8').split('\0').filter(Boolean);
  } catch {
    return false;
  }
  const args = argv.slice(argv.indexOf('test') + 1);
  if (args.some((a) => a === '-t' || a.startsWith('--test-name-pattern') || a === '--watch')) return false;
  return args
    .filter((a) => !a.startsWith('-'))
    .every((a) => {
      try {
        return statSync(resolve(a)).isDirectory();
      } catch {
        return false;
      }
    });
}

describe('temp hygiene', () => {
  test('no test calls mkdtemp directly — temp dirs come from tempDir()', () => {
    const offenders = sources(TESTS)
      .filter((path) => !ALLOWED.has(relative(TESTS, path)))
      .filter((path) => /\bmkdtemp(Sync)?\s*\(/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(ROOT, path));
    expect(offenders).toEqual([]);
  });

  test('a run cut short by SIGTERM still removes its temp dirs', async () => {
    const tmp = tempDir('tg-interrupt-proof-');
    const child = Bun.spawn([process.execPath, 'test', './tests/fixtures/interrupted-run.fixture.ts'], {
      cwd: ROOT,
      env: { ...process.env, TMPDIR: tmp, BUN_TEST_LOCK_HELD: '1' },
      stdout: 'pipe',
      stderr: 'ignore',
    });
    // Signal only once the test is running and holds a tracked dir.
    const decoder = new TextDecoder();
    let out = '';
    for await (const chunk of child.stdout) {
      out += decoder.decode(chunk);
      if (out.includes('READY ')) break;
    }
    expect(out).toContain('READY ');
    child.kill('SIGTERM');
    expect(await child.exited).toBe(143);
    expect(readdirSync(tmp)).toEqual([]);
  }, 30_000);

  // Files that create config dirs, start detached daemons (`tg-ctl start`) and abduco servers.
  const SUBSET = [
    'tests/ctl-daemon-lifecycle-integration.test.ts',
    'tests/ctl-buttons-integration.test.ts',
    'tests/abduco-client.test.ts',
    'tests/ctl-host-pty-integration.test.ts',
  ];
  // ~25 s: only a whole-suite run pays for it, not `bun test <file>` while iterating.
  test.skipIf(!wholeSuiteRun())(
    'a child run of integration files leaves its TMPDIR empty and no process behind',
    async () => {
      const tmp = tempDir('tg-leak-proof-');
      // `tempDir(…, { short: true })` dirs skip TMPDIR (unix-socket length); this private base
      // keeps the child's apart from any other run's under /tmp.
      const shortTmp = tempDir('tgl-', { short: true });
      const child = Bun.spawn([process.execPath, 'test', ...SUBSET.map((f) => `./${f}`)], {
        cwd: ROOT,
        // BUN_TEST_LOCK_HELD: a host-level `bun test` serializer must not make the child queue
        // behind the run it is part of.
        env: { ...process.env, TMPDIR: tmp, TG_TEST_SHORT_TMPDIR: shortTmp, BUN_TEST_LOCK_HELD: '1' },
        stdout: 'ignore',
        stderr: 'pipe',
      });
      const [output, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
      expect({ code, tail: code === 0 ? '' : output.slice(-3000) }).toEqual({ code: 0, tail: '' });
      // SIGKILLed processes can linger in /proc for a moment; there is no event to await for another
      // process's teardown, so poll briefly.
      let survivors = runProcesses(tmp, shortTmp);
      for (let i = 0; i < 20 && survivors.length > 0; i++) {
        await Bun.sleep(100);
        survivors = runProcesses(tmp, shortTmp);
      }
      expect({ leftovers: readdirSync(tmp), shortLeftovers: readdirSync(shortTmp), survivors }).toEqual({
        leftovers: [],
        shortLeftovers: [],
        survivors: [],
      });
    },
    240_000,
  );
});
