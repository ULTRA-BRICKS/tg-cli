// End-to-end coverage for tg-cli#316, driving the REAL `tg-ctl` binary against a throwaway HOME:
//   (a) `install-hooks` migrates the legacy Codex hooks.json Stop entry away once a rig apply has
//       left the same hook in config.toml, and is idempotent afterwards;
//   (b) `status` finds the Codex usage-telemetry hook in config.toml first, hooks.json as a legacy
//       fallback, names the file, and flags the dual-source state codex warns about.
//
// rig is either a FAKE (tests/helpers/fake-rig.ts — never a real rig install) or forced ABSENT
// (RIG_AGENT_TOOLS_SOURCE points nowhere).
import { expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BASE_PATH, fakeAgentToolsCheckout } from './helpers/fake-rig';
import { tempDir } from './helpers/test-temp';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const CMD = 'tg-ctl codex-usage-hook';
const NOWHERE = join(tmpdir(), 'tgctl-316-no-agent-tools');

// Every test spawns the real `tg-ctl` (status also snapshots live sessions): well under a second
// alone, but past bun's 5 s default when the full suite saturates the machine.
setDefaultTimeout(30_000);

// The file that had to be deleted by hand on the live machine — kept verbatim as the migration
// fixture (~/.codex/hooks.json.pre-308-migration.bak).
const LEGACY_HOOKS_JSON = `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: CMD, timeout: 30 }] }] } }, null, 2)}\n`;

// The Stop line rig actually writes: an absolute `bun <path>/tg-ctl codex-usage-hook` invocation
// sharing the array with agent-tools' own bridge hook.
function rigConfigToml(): string {
  return [
    '# >>> rig managed: codex hook bridge',
    '[hooks]',
    'Stop = [{hooks = [{type = "command", command = "PYTHONPATH=/x/lib python3 -m codex_hook_bridge Stop"}]}, ' +
      `{hooks = [{type = "command", command = "/opt/bun/bin/bun /opt/files/bin/${CMD}"}]}]`,
    '',
  ].join('\n');
}

function fakeEnv() {
  const home = tempDir('tgctl-316-home-');
  const cfg = tempDir('tgctl-316-cfg-');
  writeFileSync(join(cfg, '.env'), 'TG_BOT_TOKEN=123456:FAKE\nTG_CHAT_ID=42\n');
  const codex = join(home, '.codex');
  mkdirSync(codex, { recursive: true });
  return { home, cfg, codex, env: { HOME: home, TG_CTL_CONFIG_DIR: cfg, RIG_AGENT_TOOLS_SOURCE: NOWHERE, PATH: BASE_PATH } as Record<string, string> };
}

// A fake rig whose `apply` succeeds. The config.toml a test seeds stands in for what that apply
// leaves behind: tg-ctl re-reads it from disk only AFTER the delegation returns.
function withFakeRig(env: Record<string, string>): Record<string, string> {
  const { source, binDir } = fakeAgentToolsCheckout(tempDir('tgctl-316-rig-'), { withRig: true });
  return { ...env, RIG_AGENT_TOOLS_SOURCE: source, PATH: `${binDir}:${BASE_PATH}` };
}

function run(args: string[], env: Record<string, string>) {
  return Bun.spawnSync(['bun', TG_CTL, ...args], { env });
}

// --- (a) migration -------------------------------------------------------------------------------

test('install-hooks migrates the legacy hooks.json entry away when rig provisions the hook in config.toml, then is idempotent', () => {
  const { codex, env } = fakeEnv();
  const rigEnv = withFakeRig(env);
  writeFileSync(join(codex, 'config.toml'), rigConfigToml());
  writeFileSync(join(codex, 'hooks.json'), LEGACY_HOOKS_JSON);

  const first = run(['install-hooks'], rigEnv);
  expect(first.exitCode).toBe(0);
  const out = first.stdout.toString();
  expect(out).toContain('skipping the direct hooks.json write');
  expect(out).toContain('it held nothing else, so the file was removed');

  // The dual hook source is gone and the pre-migration content is recoverable.
  expect(existsSync(join(codex, 'hooks.json'))).toBe(false);
  expect(readFileSync(join(codex, 'hooks.json.pre-migration.bak'), 'utf8')).toBe(LEGACY_HOOKS_JSON);

  // Idempotent: a second run has nothing to migrate and does NOT recreate hooks.json.
  const second = run(['install-hooks'], rigEnv);
  expect(second.exitCode).toBe(0);
  expect(second.stdout.toString()).toContain('nothing to migrate');
  expect(existsSync(join(codex, 'hooks.json'))).toBe(false);
  expect(readFileSync(join(codex, 'hooks.json.pre-migration.bak'), 'utf8')).toBe(LEGACY_HOOKS_JSON);
});

test('a legacy entry that reappears after a migration is migrated again: the EARLIEST backup stays, the new content gets its own copy', () => {
  const { codex, env } = fakeEnv();
  const rigEnv = withFakeRig(env);
  writeFileSync(join(codex, 'config.toml'), rigConfigToml());
  writeFileSync(join(codex, 'hooks.json'), LEGACY_HOOKS_JSON);
  expect(run(['install-hooks'], rigEnv).exitCode).toBe(0);

  const reappeared = `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: CMD }] }, { hooks: [{ type: 'command', command: 'mine' }] }] } })}\n`;
  writeFileSync(join(codex, 'hooks.json'), reappeared);
  const again = run(['install-hooks'], rigEnv);
  expect(again.exitCode).toBe(0);
  expect(again.stdout.toString()).toContain('its other hooks were kept');
  expect(readFileSync(join(codex, 'hooks.json.pre-migration.bak'), 'utf8')).toBe(LEGACY_HOOKS_JSON);
  const snapshots = readdirSync(codex).filter((name) => /^hooks\.json\.pre-migration-\d+\.bak$/.test(name));
  expect(snapshots).toHaveLength(1);
  expect(readFileSync(join(codex, snapshots[0]), 'utf8')).toBe(reappeared);
});

// Skipped as root: a read-only directory does not stop root's write.
test.skipIf(process.getuid?.() === 0)('a backup that cannot be written ABORTS the migration — the legacy file is left exactly as it was', () => {
  const { codex, env } = fakeEnv();
  const rigEnv = withFakeRig(env);
  writeFileSync(join(codex, 'config.toml'), rigConfigToml());
  writeFileSync(join(codex, 'hooks.json'), LEGACY_HOOKS_JSON);
  // A read-only ~/.codex: the backup write is the first thing that fails.
  chmodSync(codex, 0o555);
  try {
    const proc = run(['install-hooks'], rigEnv);
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain('leaving the legacy entry in place');
    expect(readFileSync(join(codex, 'hooks.json'), 'utf8')).toBe(LEGACY_HOOKS_JSON);
    expect(existsSync(join(codex, 'hooks.json.pre-migration.bak'))).toBe(false);
  } finally {
    chmodSync(codex, 0o755);
  }
});

// Skipped as root: a read-only file does not stop root's write.
test.skipIf(process.getuid?.() === 0)('a rewrite that fails after the backup exits 1 and leaves the file and its backup intact', () => {
  const { codex, env } = fakeEnv();
  writeFileSync(join(codex, 'config.toml'), rigConfigToml());
  const mixed = `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: CMD }] }, { hooks: [{ type: 'command', command: 'mine' }] }] } })}\n`;
  const hooksJson = join(codex, 'hooks.json');
  writeFileSync(hooksJson, mixed);
  chmodSync(hooksJson, 0o444);
  try {
    const proc = run(['install-hooks'], withFakeRig(env));
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain(`could not rewrite ${hooksJson}`);
    expect(readFileSync(hooksJson, 'utf8')).toBe(mixed);
    expect(readFileSync(join(codex, 'hooks.json.pre-migration.bak'), 'utf8')).toBe(mixed);
  } finally {
    chmodSync(hooksJson, 0o644);
  }
});

test('install-hooks keeps a hooks.json that still holds someone else’s hook, removing only our entry', () => {
  const { codex, env } = fakeEnv();
  writeFileSync(join(codex, 'config.toml'), rigConfigToml());
  writeFileSync(
    join(codex, 'hooks.json'),
    `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: CMD }] }, { hooks: [{ type: 'command', command: 'someone-elses-hook' }] }] } })}\n`,
  );

  const proc = run(['install-hooks'], withFakeRig(env));
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString()).toContain('its other hooks were kept');

  const kept = JSON.parse(readFileSync(join(codex, 'hooks.json'), 'utf8'));
  expect(kept).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'someone-elses-hook' }] }] } });
  expect(existsSync(join(codex, 'hooks.json.pre-migration.bak'))).toBe(true);
});

test('install-hooks does not mistake a COMMENTED-OUT config.toml Stop line for a provisioned hook', () => {
  const { codex, env } = fakeEnv();
  writeFileSync(join(codex, 'config.toml'), `[hooks]\n# Stop = [{hooks = [{type = "command", command = "${CMD}"}]}]\n`);

  const proc = run(['install-hooks'], withFakeRig(env));
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString()).toContain('rig does not yet provision the codex usage-telemetry Stop hook');
  expect(existsSync(join(codex, 'hooks.json'))).toBe(true);
});

test('install-hooks leaves hooks.json alone when rig is absent, even if config.toml carries the hook (a stale rig path must not cost the fallback)', () => {
  const { codex, env } = fakeEnv();
  writeFileSync(join(codex, 'config.toml'), rigConfigToml());
  writeFileSync(join(codex, 'hooks.json'), LEGACY_HOOKS_JSON);

  const proc = run(['install-hooks'], env);
  expect(proc.exitCode).toBe(0);
  expect(readFileSync(join(codex, 'hooks.json'), 'utf8')).toBe(LEGACY_HOOKS_JSON);
  expect(existsSync(join(codex, 'hooks.json.pre-migration.bak'))).toBe(false);
});

// --- (b) status detection ------------------------------------------------------------------------

test('status finds the telemetry hook in config.toml and names that file', () => {
  const { codex, env } = fakeEnv();
  writeFileSync(join(codex, 'config.toml'), rigConfigToml());
  const proc = run(['status'], env);
  expect(proc.exitCode).toBe(0);
  const out = proc.stdout.toString();
  expect(out).toContain('Codex usage telemetry: installed');
  expect(out).toContain(join(codex, 'config.toml'));
});

test('status falls back to the legacy hooks.json and says so', () => {
  const { codex, env } = fakeEnv();
  writeFileSync(join(codex, 'hooks.json'), LEGACY_HOOKS_JSON);
  const proc = run(['status'], env);
  expect(proc.exitCode).toBe(0);
  const out = proc.stdout.toString();
  expect(out).toContain('Codex usage telemetry: installed');
  expect(out).toContain(`legacy ${join(codex, 'hooks.json')}`);
});

test('status flags the hook living in BOTH files (the state codex warns about)', () => {
  const { codex, env } = fakeEnv();
  writeFileSync(join(codex, 'config.toml'), rigConfigToml());
  writeFileSync(join(codex, 'hooks.json'), LEGACY_HOOKS_JSON);
  const out = run(['status'], env).stdout.toString();
  expect(out).toContain(join(codex, 'config.toml'));
  expect(out).toContain(`the legacy ${join(codex, 'hooks.json')} still carries it too`);
});

test('status flags an ABSOLUTE-path legacy hooks.json entry too — the same entries install-hooks migrates', () => {
  const { codex, env } = fakeEnv();
  writeFileSync(join(codex, 'config.toml'), rigConfigToml());
  writeFileSync(join(codex, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `/opt/bun/bin/bun /opt/files/bin/${CMD}` }] }] } }));
  expect(run(['status'], env).stdout.toString()).toContain(`the legacy ${join(codex, 'hooks.json')} still carries it too`);
});

test('status reports NOT installed when neither file carries the hook', () => {
  const { env } = fakeEnv();
  expect(run(['status'], env).stdout.toString()).toContain('Codex usage telemetry: NOT installed');
});
