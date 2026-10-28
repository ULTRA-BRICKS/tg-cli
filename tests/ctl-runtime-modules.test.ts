// Structure and import-safety of the tg-ctl daemon runtime split (guardian-817).
//
// `tg-ctl` used to be one 14000-line script. Its effectful code now lives in
// features/tg-ctl/daemon-runtime/*.ts and the root is only an entry point. These tests pin the
// properties the split must keep: nothing runs on import, the root still exports what the
// other tests/tools import, the modules stay inside the file-size gate, and the late-binding
// seam between daemon parts fails loudly instead of silently when misused.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tempDir } from './helpers/test-temp';
import { lateBindings } from '../features/tg-ctl/daemon-runtime/run-daemon';
import { registerRootScript, rootScriptPath } from '../features/tg-ctl/daemon-runtime/root-script';

const ROOT = join(import.meta.dir, '..');
const RUNTIME_DIR = join(ROOT, 'features', 'tg-ctl', 'daemon-runtime');
const MAX_FILE_LINES = 1200;

const runtimeModules = (): string[] => readdirSync(RUNTIME_DIR).filter((f) => f.endsWith('.ts')).sort();
const lineCount = (path: string): number => readFileSync(path, 'utf8').split('\n').length;

describe('file-size gate', () => {
  test('the root entry point and every daemon-runtime module stay within the line limit', () => {
    const tooBig = [join(ROOT, 'tg-ctl'), ...runtimeModules().map((f) => join(RUNTIME_DIR, f))]
      .map((path) => ({ path, lines: lineCount(path) }))
      .filter((f) => f.lines > MAX_FILE_LINES);
    expect(tooBig).toEqual([]);
  });

  test('the root script is a thin entry point, not a second copy of the daemon', () => {
    expect(lineCount(join(ROOT, 'tg-ctl'))).toBeLessThan(100);
  });
});

describe('importing the modules has no side effects', () => {
  test('loading every module in a fresh process prints nothing, exits 0 and writes nothing to HOME', async () => {
    const home = tempDir('ctl-runtime-import-');
    const specs = runtimeModules().map((f) => `./features/tg-ctl/daemon-runtime/${f.replace(/\.ts$/, '')}`);
    specs.push('./tg-ctl');
    // Runtime-selected specifiers by design: the test loads every module in a fresh process to prove import is inert.
    const script = `for (const s of ${JSON.stringify(specs)}) await import(s);`;
    const proc = Bun.spawn(['bun', '-e', script], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? '', HOME: home, TG_CTL_CONFIG_DIR: join(home, 'cfg') },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ code, out, err }).toEqual({ code: 0, out: '', err: '' });
    // `.bun` is the Bun runtime's own cache, not something the modules wrote.
    expect(readdirSync(home).filter((name) => name !== '.bun')).toEqual([]);
  });

  test('the root is import-safe: importing it does not dispatch the CLI', async () => {
    const proc = Bun.spawn(['bun', '-e', `const m = await import('./tg-ctl'); process.stdout.write(Object.keys(m).sort().join(',') + '\\n')`], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? '', HOME: tempDir('ctl-runtime-root-') },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    expect(out.trim()).toBe('NO_AGENT_REPLY,USAGE,decideQueuedPermissionReconnect,formatCandidates,loadEnv,normalizeButtonRequest,parseStartFlags,readOffset');
  });
});

describe('root script path', () => {
  test('before the root registers itself the path is the repository-relative script', () => {
    expect(rootScriptPath()).toBe(join(ROOT, 'tg-ctl'));
  });

  test('the root registers its own path, which is what re-executing code must use', () => {
    registerRootScript('/opt/tg-cli/tg-ctl');
    try {
      expect(rootScriptPath()).toBe('/opt/tg-cli/tg-ctl');
    } finally {
      registerRootScript(join(ROOT, 'tg-ctl'));
    }
  });
});

describe('late bindings between daemon parts', () => {
  test('an operation of a part that is not built yet names the part instead of failing obscurely', () => {
    const late = lateBindings({});
    expect(() => late.executeAction({ kind: 'noop' } as never, true)).toThrow('daemon part "execute-action" was called before it was built');
    expect(() => late.postRoutePicker([], 'x')).toThrow('daemon part "inbound-inject" was called before it was built');
  });

  test('once the part exists the call reaches it with the same arguments and result', async () => {
    const calls: unknown[][] = [];
    const late = lateBindings({
      execute: {
        executeAction: async (...args: unknown[]) => {
          calls.push(args);
          return true;
        },
      } as never,
    });
    const action = { kind: 'noop' } as never;
    expect(await late.executeAction(action, false)).toBe(true);
    expect(calls).toEqual([[action, false]]);
  });
});
