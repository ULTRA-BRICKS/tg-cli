// Integration coverage for tg#8672: `tg-ctl install-hooks` must delegate codex hook
// provisioning to rig (via python3 -m agenttools_rig_delegate) when rig is present, and fall
// back to its own direct ~/.codex/hooks.json write when rig is absent. Uses a fully isolated
// fake `rig` + fake `agenttools_rig_delegate` package (see tests/ctl-rig-delegate.test.ts for
// the same fixture pattern) so this never depends on — or touches — a real rig install.
import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { codexUsageHookInstalled } from '../features/tg-ctl/hook-install';
import { tempDir } from './helpers/test-temp';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const CODEX_USAGE_CMD = 'tg-ctl codex-usage-hook';

// Isolated PATH containing only what the test needs (python3 + optionally a fake rig) so a real
// system `rig` install (this dev machine has one) can never leak into a test that expects it
// absent.
const PYTHON3_DIR = require('path').dirname(Bun.which('python3') ?? '/usr/bin/python3');
// bun's own dir + the real PATH — needed so `run()` can exec `bun <TG_CTL>` and so the fake
// binDir (prepended per-test, ahead of any real `rig`) actually wins name resolution.
const BASE_PATH = `${require('path').dirname(Bun.which('bun') ?? '/usr/bin/bun')}:${PYTHON3_DIR}:${process.env.PATH ?? ''}`;

function fakeEnv() {
  const home = tempDir('tgctl-rigdelegate-home-');
  const cfg = tempDir('tgctl-rigdelegate-cfg-');
  writeFileSync(join(cfg, '.env'), 'TG_BOT_TOKEN=123456:FAKE\nTG_CHAT_ID=42\n');
  return { home, cfg };
}

// Fake agent-tools checkout with a minimal agenttools_rig_delegate CLI mirror (matches the real
// detect/delegate contract from agent-tools PR #282) plus an optional fake `rig` binary that logs
// its argv to `rig.log` and exits with `rigExitCode`.
function fakeAgentToolsCheckout(root: string, opts: { withRig: boolean; rigExitCode?: number; delegateSentinel?: boolean }): { source: string; binDir: string; rigLog: string } {
  const source = join(root, 'agent-tools');
  const pkgDir = join(source, 'lib', 'agenttools_rig_delegate');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, '__init__.py'), '');
  const binDir = join(root, 'bin');
  const rigLog = join(root, 'rig.log');
  mkdirSync(binDir, { recursive: true });
  if (opts.withRig) {
    const rigBin = join(binDir, 'rig');
    writeFileSync(rigBin, `#!/bin/sh\necho "$@" >> ${JSON.stringify(rigLog)}\nexit ${opts.rigExitCode ?? 0}\n`);
    chmodSync(rigBin, 0o755);
  }
  // `delegateSentinel` simulates rig going ABSENT between `detect` and `delegate` (a race, or a
  // helper that resolves rig differently for the two calls): `detect` still finds `rig` on PATH,
  // but `delegate` returns the NO_RIG_EXIT sentinel. Lets us assert the caller falls back on the
  // sentinel (rig absent) rather than propagating it as a failure.
  const delegateBody = opts.delegateSentinel
    ? ['    if cmd == "delegate":', '        return NO_RIG_EXIT']
    : [
        '    if cmd == "delegate":',
        '        rig = find_rig()',
        '        if rig is None:',
        '            return NO_RIG_EXIT',
        '        return subprocess.run([rig, *rest]).returncode',
      ];
  writeFileSync(
    join(pkgDir, '__main__.py'),
    [
      'import shutil, subprocess, sys',
      'NO_RIG_EXIT = 97',
      'def find_rig():',
      '    return shutil.which("rig")',
      'def main():',
      '    args = sys.argv[1:]',
      '    if not args:',
      '        return 2',
      '    cmd, rest = args[0], args[1:]',
      '    if cmd == "detect":',
      '        rig = find_rig()',
      '        if rig is None:',
      '            return 1',
      '        print(rig)',
      '        return 0',
      ...delegateBody,
      '    return 2',
      'if __name__ == "__main__":',
      '    raise SystemExit(main())',
    ].join('\n'),
  );
  return { source, binDir, rigLog };
}

function run(args: string[], env: Record<string, string>) {
  return Bun.spawnSync(['bun', TG_CTL, ...args], { env });
}

test('install-hooks: rig present, telemetry not yet rig-provisioned — delegates AND writes hooks.json directly (no telemetry loss)', () => {
  const root = tempDir('tgctl-rigdelegate-root-');
  const { home, cfg } = fakeEnv();
  const { source, binDir, rigLog } = fakeAgentToolsCheckout(root, { withRig: true, rigExitCode: 0 });

  const proc = run(['install-hooks'], {
    HOME: home,
    TG_CTL_CONFIG_DIR: cfg,
    RIG_AGENT_TOOLS_SOURCE: source,
    PATH: `${binDir}:${BASE_PATH}`,
  });
  expect(proc.exitCode).toBe(0);
  const out = proc.stdout.toString();
  expect(out).toContain('delegated codex hook provisioning via `rig apply --only harness`');
  expect(out).toContain('rig does not yet provision the codex usage-telemetry Stop hook');

  // rig was actually invoked SCOPED — `apply --only harness`, never a full unrestricted apply.
  expect(readFileSync(rigLog, 'utf8').trim()).toBe('apply --only harness');

  // Telemetry was still written directly — never lost.
  const codexHooks = JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8'));
  expect(codexUsageHookInstalled(codexHooks, CODEX_USAGE_CMD)).toBe(true);
});

test('install-hooks: rig provisions telemetry in config.toml — skips the direct hooks.json write (no duplication)', () => {
  const root = tempDir('tgctl-rigdelegate-root-');
  const { home, cfg } = fakeEnv();
  const { source, binDir, rigLog } = fakeAgentToolsCheckout(root, { withRig: true, rigExitCode: 0 });

  // Simulate a FUTURE rig that folds the usage-telemetry Stop hook into the AUTHORITATIVE
  // artifact it owns — ~/.codex/config.toml — by pre-seeding it there. The post-delegation
  // check must re-read config.toml (NOT a stale hooks.json snapshot) and back the direct write
  // off because rig now owns the hook.
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(
    join(home, '.codex', 'config.toml'),
    `# >>> rig managed: codex hook bridge\n[hooks]\nStop = [{hooks = [{type = "command", command = "${CODEX_USAGE_CMD}"}]}]\n`,
  );

  const proc = run(['install-hooks'], {
    HOME: home,
    TG_CTL_CONFIG_DIR: cfg,
    RIG_AGENT_TOOLS_SOURCE: source,
    PATH: `${binDir}:${BASE_PATH}`,
  });
  expect(proc.exitCode).toBe(0);
  const out = proc.stdout.toString();
  expect(out).toContain('rig now provisions the codex usage-telemetry Stop hook');
  expect(out).toContain('skipping the direct hooks.json write');
  expect(readFileSync(rigLog, 'utf8').trim()).toBe('apply --only harness');

  // The direct writer never ran: no hooks.json was created.
  expect(existsSync(join(home, '.codex', 'hooks.json'))).toBe(false);
});

test('install-hooks: a PRESENT rig that FAILS surfaces the exit code and does NOT write hooks.json', () => {
  const root = tempDir('tgctl-rigdelegate-root-');
  const { home, cfg } = fakeEnv();
  const { source, binDir } = fakeAgentToolsCheckout(root, { withRig: true, rigExitCode: 7 });

  const proc = run(['install-hooks'], {
    HOME: home,
    TG_CTL_CONFIG_DIR: cfg,
    RIG_AGENT_TOOLS_SOURCE: source,
    PATH: `${binDir}:${BASE_PATH}`,
  });
  // present-but-failing rig -> surface the exit code, no fallback direct write (the shared
  // contract: fallback is for ABSENT rig only).
  expect(proc.exitCode).toBe(7);
  expect(proc.stderr.toString()).toContain('rig apply failed');
  expect(existsSync(join(home, '.codex', 'hooks.json'))).toBe(false);
});

test('install-hooks: a real rig failure with exit 3 PROPAGATES and does NOT fall back (3 is EXIT_DRIFT, not the sentinel)', () => {
  // Guards the "branch on 97 EXACTLY, not any nonzero" invariant. Before agent-tools#282 the
  // NO_RIG sentinel WAS 3, colliding with rig's own EXIT_DRIFT=3; a caller keying on 3 would
  // wrongly fall back on a genuine rig drift/failure. Exit 3 must now propagate like any failure.
  const root = tempDir('tgctl-rigdelegate-root-');
  const { home, cfg } = fakeEnv();
  const { source, binDir } = fakeAgentToolsCheckout(root, { withRig: true, rigExitCode: 3 });

  const proc = run(['install-hooks'], {
    HOME: home,
    TG_CTL_CONFIG_DIR: cfg,
    RIG_AGENT_TOOLS_SOURCE: source,
    PATH: `${binDir}:${BASE_PATH}`,
  });
  expect(proc.exitCode).toBe(3); // surfaced, NOT swallowed into a fallback
  expect(proc.stderr.toString()).toContain('rig apply failed');
  expect(existsSync(join(home, '.codex', 'hooks.json'))).toBe(false); // no direct write
});

test('install-hooks: delegate returns the NO_RIG_EXIT sentinel (97) — treated as rig ABSENT, falls back to the direct write', () => {
  // agent-tools#282 moved the "rig absent" sentinel off 3 (collided with rig's EXIT_DRIFT) to 97.
  // detectRig said present, but `delegate` reports rig gone (uninstalled mid-flight). The caller
  // must recognize the sentinel as ABSENCE and self-install — NOT propagate 97 as a rig failure.
  const root = tempDir('tgctl-rigdelegate-root-');
  const { home, cfg } = fakeEnv();
  const { source, binDir } = fakeAgentToolsCheckout(root, { withRig: true, delegateSentinel: true });

  const proc = run(['install-hooks'], {
    HOME: home,
    TG_CTL_CONFIG_DIR: cfg,
    RIG_AGENT_TOOLS_SOURCE: source,
    PATH: `${binDir}:${BASE_PATH}`,
  });
  expect(proc.exitCode).toBe(0); // sentinel is NOT surfaced as a failure
  expect(proc.stdout.toString()).toContain('rig reported absent (sentinel 97)');

  // Telemetry was written directly (the fallback ran) — never lost.
  const codexHooks = JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8'));
  expect(codexUsageHookInstalled(codexHooks, CODEX_USAGE_CMD)).toBe(true);
});

test('install-hooks: rig absent (agent-tools package unresolvable) — falls back to the direct write, unaffected', () => {
  const root = tempDir('tgctl-rigdelegate-root-');
  const { home, cfg } = fakeEnv();

  const proc = run(['install-hooks'], {
    HOME: home,
    TG_CTL_CONFIG_DIR: cfg,
    RIG_AGENT_TOOLS_SOURCE: join(root, 'does-not-exist'),
    PATH: BASE_PATH,
  });
  expect(proc.exitCode).toBe(0);
  const out = proc.stdout.toString();
  expect(out).not.toContain('delegated codex hook provisioning');
  expect(out).toContain('installed Codex Stop usage telemetry collector');

  const codexHooks = JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8'));
  expect(codexUsageHookInstalled(codexHooks, CODEX_USAGE_CMD)).toBe(true);
});
