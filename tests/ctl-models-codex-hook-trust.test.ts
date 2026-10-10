// tg#8708 (option a): a codex session spawned via `/new` gets `--dangerously-bypass-hook-trust`
// so rig-managed codex hooks (untrusted-by-default in an autonomous run) actually fire — rig
// vouches for them. The flag is added AT SPAWN TIME and ONLY when codex hooks are actually
// rig-managed (~/.codex/config.toml carries rig's bridge marker); it is NEVER baked into the
// pure model catalog, and NEVER applied to a user's own untrusted hooks on a machine without rig.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { MODEL_CATALOG, spawnArgvWithTask } from '../features/tg-ctl/models';
import { applyCodexHookTrustBypass, codexHooksRigManaged } from '../features/tg-ctl/rig-delegate';
import { tempDir } from './helpers/test-temp';

const FLAG = '--dangerously-bypass-hook-trust';
const RIG_MARKER = '# >>> rig managed: codex hook bridge';

let home: string;

beforeEach(() => {
  home = tempDir('tg-codex-trust-');
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeConfig(body: string): void {
  const codexDir = join(home, '.codex');
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(join(codexDir, 'config.toml'), body);
}

// --- the model catalog stays PURE (no flag baked in) -----------------------------------------

test('no catalog entry (codex included) carries the bypass flag — models.ts is pure', () => {
  for (const entry of MODEL_CATALOG) {
    expect(entry.argv('/tmp/proj')).not.toContain(FLAG);
  }
  expect(spawnArgvWithTask('codex-gpt-5.5', '/x', 'do it')).not.toContain(FLAG);
});

// --- codexHooksRigManaged: detects rig's bridge marker ---------------------------------------

test('codexHooksRigManaged is true only when the rig bridge marker is in config.toml', () => {
  const env = { HOME: home };
  expect(codexHooksRigManaged(env)).toBe(false); // no config.toml

  writeConfig('model = "gpt-5.6-sol"\n');
  expect(codexHooksRigManaged(env)).toBe(false); // config without the marker

  writeConfig(`model = "x"\n${RIG_MARKER}\n[hooks]\n`);
  expect(codexHooksRigManaged(env)).toBe(true); // marker present
});

// --- applyCodexHookTrustBypass: gated + codex-only -------------------------------------------

test('applyCodexHookTrustBypass adds the flag for a codex spawn WHEN hooks are rig-managed', () => {
  writeConfig(`${RIG_MARKER}\n[hooks]\nStop = []\n`);
  const env = { HOME: home };
  expect(applyCodexHookTrustBypass(['codex', '--model', 'gpt-5.5'], 'codex', env)).toEqual([
    'codex', '--model', 'gpt-5.5', FLAG,
  ]);
});

test('applyCodexHookTrustBypass inserts the flag BEFORE the `--` prompt separator (task present)', () => {
  // spawnArgvWithTask puts `--` before an initial task; the bypass is an OPTION and must land
  // ahead of `--`, else codex parses it as part of the prompt and the trust gate still fires.
  writeConfig(`${RIG_MARKER}\n[hooks]\nStop = []\n`);
  const env = { HOME: home };
  const argv = spawnArgvWithTask('codex-gpt-5.5', '/x', 'do it')!; // ['codex','--model','gpt-5.5','--','do it']
  expect(applyCodexHookTrustBypass(argv, 'codex', env)).toEqual([
    'codex', '--model', 'gpt-5.5', FLAG, '--', 'do it',
  ]);
});

test('applyCodexHookTrustBypass is idempotent — never emits a duplicate bypass flag', () => {
  writeConfig(`${RIG_MARKER}\n[hooks]\nStop = []\n`);
  const env = { HOME: home };
  const once = applyCodexHookTrustBypass(['codex', '--model', 'gpt-5.5', '--', 'do it'], 'codex', env);
  // Applying again must be a no-op, not a second --dangerously-bypass-hook-trust.
  expect(applyCodexHookTrustBypass(once, 'codex', env)).toEqual(once);
  expect(once.filter((a) => a === FLAG)).toHaveLength(1);
});

test('applyCodexHookTrustBypass does NOT add the flag when codex hooks are not rig-managed', () => {
  const env = { HOME: home }; // no config.toml at all
  expect(applyCodexHookTrustBypass(['codex'], 'codex', env)).toEqual(['codex']);
});

test('applyCodexHookTrustBypass never touches claude / opencode spawns', () => {
  writeConfig(`${RIG_MARKER}\n`); // even with rig-managed codex present
  const env = { HOME: home };
  expect(applyCodexHookTrustBypass(['claude', '--model', 'opus'], 'claude', env)).toEqual([
    'claude', '--model', 'opus',
  ]);
  expect(applyCodexHookTrustBypass(['opencode'], 'opencode', env)).toEqual(['opencode']);
});
