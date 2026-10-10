// Integration coverage for tg#8672: `tg-ctl install-hooks` must delegate codex hook
// provisioning to rig (via python3 -m agenttools_rig_delegate) when rig is present, and fall
// back to its own direct ~/.codex/hooks.json write when rig is absent. Uses a fully isolated
// fake `rig` + fake `agenttools_rig_delegate` package (see tests/ctl-rig-delegate.test.ts for
// the same fixture pattern) so this never depends on — or touches — a real rig install.
import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { codexUsageHookInstalled } from '../features/tg-ctl/hook-install';
import { tempDir } from './helpers/test-temp';
// The fake agent-tools/rig fixture lives in a shared helper — tests/ctl-codex-status-e2e.test.ts
// drives the same delegation.
import { BASE_PATH, fakeAgentToolsCheckout } from './helpers/fake-rig';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const CODEX_USAGE_CMD = 'tg-ctl codex-usage-hook';

function fakeEnv() {
  const home = tempDir('tgctl-rigdelegate-home-');
  const cfg = tempDir('tgctl-rigdelegate-cfg-');
  writeFileSync(join(cfg, '.env'), 'TG_BOT_TOKEN=123456:FAKE\nTG_CHAT_ID=42\n');
  return { home, cfg };
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
