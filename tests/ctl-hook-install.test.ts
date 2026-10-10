import { expect, test } from 'bun:test';
import {
  withClaudeHooks,
  claudeHooksInstalled,
  withHarnessHooks,
  harnessHooksInstalled,
  withClaudeStatusLineTelemetry,
  claudeStatusLineTelemetryInstalled,
  withCodexUsageHook,
  codexUsageHookInstalled,
  reconcileClaudeHooks,
  claudeHooksFullyInstalled,
  planClaudeHookSelfHeal,
} from '../features/tg-ctl/hook-install';

const CMD = 'tg-ctl ask';
const HARNESS_CMD = 'tg-ctl harness-event';
const STATUSLINE_TELEMETRY_CMD = 'tg-ctl harness-event --agent claude';
const CODEX_USAGE_CMD = 'tg-ctl codex-usage-hook';

test('empty settings → both hook groups added, changed=true', () => {
  const { settings, changed } = withClaudeHooks({}, CMD);
  expect(changed).toBe(true);
  const hooks = settings.hooks as Record<string, unknown[]>;
  // ExitPlanMode (plan-approval) is NOT given its own PreToolUse matcher — it is
  // delivered exactly once by the PermissionRequest `*` catch-all (a dedicated
  // PreToolUse matcher would double-forward it; both events fire for that call).
  expect(hooks.PreToolUse).toEqual([
    { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: CMD, timeout: 120 }] },
  ]);
  expect(hooks.PermissionRequest).toEqual([
    { matcher: '*', hooks: [{ type: 'command', command: CMD, timeout: 120 }] },
  ]);
  expect(claudeHooksInstalled(settings, CMD)).toBe(true);
});

test('idempotent: re-running does not duplicate, changed=false', () => {
  const once = withClaudeHooks({}, CMD).settings;
  const twice = withClaudeHooks(once, CMD);
  expect(twice.changed).toBe(false);
  expect((twice.settings.hooks as Record<string, unknown[]>).PreToolUse.length).toBe(1);
});

test('preserves existing unrelated hooks', () => {
  const existing = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk.sh' }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'tg install-skill' }] }],
    },
  };
  const { settings, changed } = withClaudeHooks(existing, CMD);
  expect(changed).toBe(true);
  const hooks = settings.hooks as Record<string, unknown[]>;
  // Bash hook still there, AskUserQuestion added alongside
  expect(hooks.PreToolUse.length).toBe(2);
  expect(hooks.PreToolUse[0]).toMatchObject({ matcher: 'Bash' });
  expect(hooks.SessionStart).toEqual(existing.hooks.SessionStart);
});

test('claudeHooksInstalled: false when only one of the two groups present', () => {
  const partial = { hooks: { PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: CMD }] }] } };
  expect(claudeHooksInstalled(partial, CMD)).toBe(false); // PermissionRequest missing
});

test('detects a catch-all PermissionRequest with a missing matcher as installed', () => {
  const s = withClaudeHooks({}, CMD).settings;
  // simulate a hand-written group with no matcher (== '*')
  (s.hooks as Record<string, unknown[]>).PermissionRequest = [{ hooks: [{ type: 'command', command: CMD }] }];
  expect(claudeHooksInstalled(s, CMD)).toBe(true);
});

// --- StopFailure harness hook provisioning (#113) ---

test('harness hook: empty settings → StopFailure * group added, changed=true', () => {
  const { settings, changed } = withHarnessHooks({}, HARNESS_CMD);
  expect(changed).toBe(true);
  const hooks = settings.hooks as Record<string, unknown[]>;
  expect(hooks.StopFailure).toEqual([
    { matcher: '*', hooks: [{ type: 'command', command: HARNESS_CMD, timeout: 30 }] },
  ]);
  expect(harnessHooksInstalled(settings, HARNESS_CMD)).toBe(true);
});

test('harness hook: idempotent re-run does not duplicate', () => {
  const once = withHarnessHooks({}, HARNESS_CMD).settings;
  const twice = withHarnessHooks(once, HARNESS_CMD);
  expect(twice.changed).toBe(false);
  expect((twice.settings.hooks as Record<string, unknown[]>).StopFailure.length).toBe(1);
});

test('harness hook merges ALONGSIDE the q→buttons hooks without clobbering them', () => {
  const q = withClaudeHooks({}, CMD).settings;
  const { settings } = withHarnessHooks(q, HARNESS_CMD);
  const hooks = settings.hooks as Record<string, unknown[]>;
  // both feature sets present
  expect(claudeHooksInstalled(settings, CMD)).toBe(true);
  expect(harnessHooksInstalled(settings, HARNESS_CMD)).toBe(true);
  expect(hooks.PreToolUse.length).toBe(1);
  expect(hooks.StopFailure.length).toBe(1);
});

test('harnessHooksInstalled: false on empty settings', () => {
  expect(harnessHooksInstalled({}, HARNESS_CMD)).toBe(false);
});

// --- Claude statusLine proactive usage telemetry (#132 follow-up) ---

test('statusLine telemetry: wraps an existing statusLine command and preserves its output path', () => {
  const existing = {
    statusLine: {
      type: 'command',
      command: 'input=$(cat); printf "model=%s" "$(echo "$input" | jq -r .model.display_name)"',
    },
  };
  const { settings, changed } = withClaudeStatusLineTelemetry(existing, STATUSLINE_TELEMETRY_CMD);
  expect(changed).toBe(true);
  const statusLine = settings.statusLine as { type: string; command: string };
  expect(statusLine.type).toBe('command');
  expect(statusLine.command).toContain('tg-ctl-statusline-usage');
  expect(statusLine.command).toContain(STATUSLINE_TELEMETRY_CMD);
  expect(statusLine.command).toContain('mktemp');
  expect(statusLine.command).toContain('chmod 600');
  expect(statusLine.command).toContain('trap');
  expect(statusLine.command).toContain('TG_CTL_STATUSLINE_MIN_INTERVAL_SEC');
  expect(statusLine.command).toContain('tg-claude-statusline-usage.stamp');
  expect(statusLine.command).toContain("sh -c 'input=$(cat); printf");
  expect(statusLine.command).not.toContain('&;');
  expect(statusLine.command).not.toContain('tg-claude-statusline-usage.$$');
  expect(claudeStatusLineTelemetryInstalled(settings, STATUSLINE_TELEMETRY_CMD)).toBe(true);
});

test('statusLine telemetry: without an existing statusLine it installs a silent collector, not a new jq display', () => {
  const { settings } = withClaudeStatusLineTelemetry({}, STATUSLINE_TELEMETRY_CMD);
  const statusLine = settings.statusLine as { command: string };
  expect(statusLine.command).toContain("sh -c ':'");
  expect(statusLine.command).not.toContain('jq -r');
});

test('statusLine telemetry: idempotent re-run does not wrap twice', () => {
  const once = withClaudeStatusLineTelemetry({}, STATUSLINE_TELEMETRY_CMD).settings;
  const twice = withClaudeStatusLineTelemetry(once, STATUSLINE_TELEMETRY_CMD);
  expect(twice.changed).toBe(false);
  const statusLine = twice.settings.statusLine as { command: string };
  expect(statusLine.command.match(/tg-ctl-statusline-usage/g)?.length).toBe(1);
});

test('statusLine telemetry: current display-only statusLine is not considered installed', () => {
  const displayOnly = {
    statusLine: {
      type: 'command',
      command: 'input=$(cat); cwd=$(echo "$input" | jq -r \'.workspace.current_dir\'); printf "%s" "$cwd"',
    },
  };
  expect(claudeStatusLineTelemetryInstalled(displayOnly, STATUSLINE_TELEMETRY_CMD)).toBe(false);
});

test('statusLine telemetry: old predictable-temp wrapper is treated as stale and rewritten', () => {
  const stale = {
    statusLine: {
      type: 'command',
      command:
        'input=$(cat); tmp="${TMPDIR:-/tmp}/tg-claude-statusline-usage.$$.$RANDOM.json"; printf \'%s\' "$input" > "$tmp"; nohup sh -c \'tg-ctl harness-event --agent claude < "$1"; rm -f "$1"\' sh "$tmp" >/dev/null 2>&1 & printf \'%s\' "$input" | sh -c \':\'; # tg-ctl-statusline-usage',
    },
  };
  expect(claudeStatusLineTelemetryInstalled(stale, STATUSLINE_TELEMETRY_CMD)).toBe(false);
  const rewritten = withClaudeStatusLineTelemetry(stale, STATUSLINE_TELEMETRY_CMD);
  expect(rewritten.changed).toBe(true);
  const statusLine = rewritten.settings.statusLine as { command: string };
  expect(statusLine.command).toContain('mktemp');
  expect(statusLine.command).not.toContain('tg-claude-statusline-usage.$$');
});

test('statusLine telemetry: secure wrapper without throttle is treated as stale and rewritten', () => {
  const stale = {
    statusLine: {
      type: 'command',
      command:
        'input=$(cat); tmp=$(mktemp "${TMPDIR:-/tmp}/tg-claude-statusline-usage.XXXXXX"); trap \'rm -f "$tmp"\' EXIT INT TERM; printf \'%s\' "$input" > "$tmp"; nohup sh -c \'tg-ctl harness-event --agent claude < "$1"\' sh "$tmp" >/dev/null 2>&1 & printf \'%s\' "$input" | sh -c \':\'; # tg-ctl-statusline-usage',
    },
  };
  expect(claudeStatusLineTelemetryInstalled(stale, STATUSLINE_TELEMETRY_CMD)).toBe(false);

  const rewritten = withClaudeStatusLineTelemetry(stale, STATUSLINE_TELEMETRY_CMD);
  expect(rewritten.changed).toBe(true);
  const statusLine = rewritten.settings.statusLine as { command: string };
  expect(statusLine.command).toContain('TG_CTL_STATUSLINE_MIN_INTERVAL_SEC');
  expect(statusLine.command).toContain('tg-claude-statusline-usage.stamp');
});

test('statusLine telemetry: stale rewrap preserves a display command containing quotes and nested sh -c', () => {
  const displayCommand = 'printf \'cwd: %s\' "$PWD"; printf \'%s\' "$input" | sh -c \'cat >/dev/null\'';
  const wrapped = withClaudeStatusLineTelemetry(
    { statusLine: { type: 'command', command: displayCommand } },
    STATUSLINE_TELEMETRY_CMD,
  ).settings;
  const stale = {
    ...wrapped,
    statusLine: {
      ...(wrapped.statusLine as Record<string, unknown>),
      command: ((wrapped.statusLine as { command: string }).command).replace('mktemp', 'mktmp-old'),
    },
  };

  const rewritten = withClaudeStatusLineTelemetry(stale, STATUSLINE_TELEMETRY_CMD);
  expect(rewritten.changed).toBe(true);
  const statusLine = rewritten.settings.statusLine as { command: string };
  expect(statusLine.command).toContain('mktemp');
  expect(statusLine.command).toContain('cwd: %s');
  expect(statusLine.command).toContain('cat >/dev/null');
  expect(statusLine.command.match(/tg-ctl-statusline-usage/g)?.length).toBe(1);
});

test('statusLine telemetry: primitive or array statusLine installs the silent collector', () => {
  for (const statusLine of ['printf nope', [], { type: 'command' }]) {
    const { settings } = withClaudeStatusLineTelemetry({ statusLine }, STATUSLINE_TELEMETRY_CMD);
    expect((settings.statusLine as { command: string }).command).toContain("sh -c ':'");
  }
});

test('statusLine telemetry: a user command containing the marker is preserved if it is not our wrapper', () => {
  const command = 'printf "literal tg-ctl-statusline-usage marker"';
  const { settings } = withClaudeStatusLineTelemetry({ statusLine: { type: 'command', command } }, STATUSLINE_TELEMETRY_CMD);
  const statusLine = settings.statusLine as { command: string };
  expect(statusLine.command).toContain(command);
  expect(statusLine.command).not.toContain("sh -c ':'");
});

// --- Codex Stop-hook usage telemetry collector (#176) ---

test('Codex usage hook: empty hooks → Stop collector added, changed=true', () => {
  const { settings, changed } = withCodexUsageHook({}, CODEX_USAGE_CMD);
  expect(changed).toBe(true);
  const hooks = settings.hooks as Record<string, unknown[]>;
  expect(hooks.Stop).toEqual([
    { hooks: [{ type: 'command', command: CODEX_USAGE_CMD, timeout: 30 }] },
  ]);
  expect(codexUsageHookInstalled(settings, CODEX_USAGE_CMD)).toBe(true);
});

test('Codex usage hook: idempotent re-run does not duplicate', () => {
  const once = withCodexUsageHook({}, CODEX_USAGE_CMD).settings;
  const twice = withCodexUsageHook(once, CODEX_USAGE_CMD);
  expect(twice.changed).toBe(false);
  expect((twice.settings.hooks as Record<string, unknown[]>).Stop.length).toBe(1);
});

test('Codex usage hook: preserves unrelated hook groups', () => {
  const existing = {
    hooks: {
      PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: 'tg-ctl ask --agent codex' }] }],
    },
  };
  const { settings } = withCodexUsageHook(existing, CODEX_USAGE_CMD);
  const hooks = settings.hooks as Record<string, unknown[]>;
  expect(hooks.PermissionRequest).toEqual(existing.hooks.PermissionRequest);
  expect(hooks.Stop).toHaveLength(1);
});

// --- daemon startup self-heal (regression: settings.json rewritten to Claude
// Code's own keys drops all three tg-ctl hook channels; the daemon kept running
// but "question asked" / "tokens running low" stopped surfacing until a manual
// `tg-ctl install-hooks`). reconcileClaudeHooks + claudeHooksFullyInstalled are
// the shared engine the daemon calls on startup to re-merge them idempotently. ---
const CLAUDE_CMDS = { question: CMD, harness: HARNESS_CMD, statusLine: STATUSLINE_TELEMETRY_CMD };

test('reconcileClaudeHooks: gutted settings (only Claude-managed keys) → all three channels re-merged', () => {
  // The exact shape a settings.json rewrite left behind: our hooks + statusLine gone.
  const gutted = { permissions: { defaultMode: 'auto' }, skipWorkflowUsageWarning: true };
  expect(claudeHooksFullyInstalled(gutted, CLAUDE_CMDS)).toBe(false);
  const { settings, changed } = reconcileClaudeHooks(gutted, CLAUDE_CMDS);
  expect(changed).toBe(true);
  // Both question channels, the StopFailure limit channel, and the statusLine are back.
  expect(claudeHooksInstalled(settings, CMD)).toBe(true);
  expect(harnessHooksInstalled(settings, HARNESS_CMD)).toBe(true);
  expect(claudeStatusLineTelemetryInstalled(settings, STATUSLINE_TELEMETRY_CMD)).toBe(true);
  expect(claudeHooksFullyInstalled(settings, CLAUDE_CMDS)).toBe(true);
  // The pre-existing Claude-managed keys are preserved untouched.
  expect((settings.permissions as Record<string, unknown>).defaultMode).toBe('auto');
  expect(settings.skipWorkflowUsageWarning).toBe(true);
});

test('reconcileClaudeHooks: fully-installed settings → no-op (changed=false)', () => {
  const once = reconcileClaudeHooks({}, CLAUDE_CMDS).settings;
  expect(claudeHooksFullyInstalled(once, CLAUDE_CMDS)).toBe(true);
  const twice = reconcileClaudeHooks(once, CLAUDE_CMDS);
  expect(twice.changed).toBe(false);
});

test('reconcileClaudeHooks: partial (only q→buttons present) is re-merged and flagged changed', () => {
  const partial = withClaudeHooks({}, CMD).settings; // question channel only
  expect(claudeHooksFullyInstalled(partial, CLAUDE_CMDS)).toBe(false);
  const { settings, changed } = reconcileClaudeHooks(partial, CLAUDE_CMDS);
  expect(changed).toBe(true);
  expect(claudeHooksFullyInstalled(settings, CLAUDE_CMDS)).toBe(true);
  // The already-present question channel is not duplicated.
  expect((settings.hooks as Record<string, unknown[]>).PreToolUse.length).toBe(1);
});

test('reconcileClaudeHooks: partial (only StopFailure present) is completed, changed=true', () => {
  const partial = withHarnessHooks({}, HARNESS_CMD).settings; // limit channel only
  expect(claudeHooksFullyInstalled(partial, CLAUDE_CMDS)).toBe(false);
  const { settings, changed } = reconcileClaudeHooks(partial, CLAUDE_CMDS);
  expect(changed).toBe(true);
  expect(claudeHooksFullyInstalled(settings, CLAUDE_CMDS)).toBe(true);
  expect((settings.hooks as Record<string, unknown[]>).StopFailure.length).toBe(1);
});

test('reconcileClaudeHooks: partial (only statusLine telemetry present) is completed, changed=true', () => {
  const partial = withClaudeStatusLineTelemetry({}, STATUSLINE_TELEMETRY_CMD).settings;
  expect(claudeHooksFullyInstalled(partial, CLAUDE_CMDS)).toBe(false);
  const { settings, changed } = reconcileClaudeHooks(partial, CLAUDE_CMDS);
  expect(changed).toBe(true);
  expect(claudeHooksFullyInstalled(settings, CLAUDE_CMDS)).toBe(true);
  // Only one statusLine wrapper — the pre-existing telemetry is not re-wrapped.
  const statusLine = settings.statusLine as { command: string };
  expect(statusLine.command.match(/tg-ctl-statusline-usage/g)?.length).toBe(1);
});

test('reconcileClaudeHooks: preserves and wraps a user-supplied statusLine display command', () => {
  const gutted = {
    permissions: { defaultMode: 'auto' },
    statusLine: { type: 'command', command: 'printf "my-prompt"' },
  };
  const { settings, changed } = reconcileClaudeHooks(gutted, CLAUDE_CMDS);
  expect(changed).toBe(true);
  const statusLine = settings.statusLine as { command: string };
  // Telemetry added, but the user's own display command is still invoked (wrapped, not replaced).
  expect(statusLine.command).toContain('tg-ctl-statusline-usage');
  expect(statusLine.command).toContain("sh -c 'printf \"my-prompt\"'");
  expect(claudeHooksFullyInstalled(settings, CLAUDE_CMDS)).toBe(true);
});

// --- planClaudeHookSelfHeal: the daemon startup decision, made pure so every
// branch (opt-in gate, malformed file, no-op, restore) is testable without I/O. ---
const GUTTED = JSON.stringify({ permissions: { defaultMode: 'auto' }, skipWorkflowUsageWarning: true });

test('planClaudeHookSelfHeal: not opted in → skip, never auto-installs', () => {
  const plan = planClaudeHookSelfHeal(GUTTED, false, CLAUDE_CMDS);
  expect(plan).toEqual({ action: 'skip', reason: 'not-opted-in' });
});

test('planClaudeHookSelfHeal: opted in + gutted file → write with backup restoring all three channels', () => {
  const plan = planClaudeHookSelfHeal(GUTTED, true, CLAUDE_CMDS);
  expect(plan.action).toBe('write');
  if (plan.action !== 'write') throw new Error('unreachable');
  expect(plan.backup).toBe(GUTTED); // prior content preserved for recovery
  const restored = JSON.parse(plan.settingsJson);
  expect(claudeHooksFullyInstalled(restored, CLAUDE_CMDS)).toBe(true);
  expect(restored.permissions.defaultMode).toBe('auto'); // pre-existing keys kept
});

test('planClaudeHookSelfHeal: opted in + already fully installed → skip (no needless write)', () => {
  const full = JSON.stringify(reconcileClaudeHooks({}, CLAUDE_CMDS).settings);
  expect(planClaudeHookSelfHeal(full, true, CLAUDE_CMDS)).toEqual({ action: 'skip', reason: 'already-installed' });
});

test('planClaudeHookSelfHeal: opted in + no file yet → write with null backup', () => {
  const plan = planClaudeHookSelfHeal(null, true, CLAUDE_CMDS);
  expect(plan.action).toBe('write');
  if (plan.action !== 'write') throw new Error('unreachable');
  expect(plan.backup).toBeNull();
  expect(claudeHooksFullyInstalled(JSON.parse(plan.settingsJson), CLAUDE_CMDS)).toBe(true);
});

test('planClaudeHookSelfHeal: opted in + empty file → write with null backup (no clobbered backup)', () => {
  const plan = planClaudeHookSelfHeal('', true, CLAUDE_CMDS);
  expect(plan.action).toBe('write');
  if (plan.action !== 'write') throw new Error('unreachable');
  expect(plan.backup).toBeNull();
});

test('planClaudeHookSelfHeal: unparseable JSON → skip, leaves a hand-broken file alone', () => {
  expect(planClaudeHookSelfHeal('{ not json', true, CLAUDE_CMDS)).toEqual({ action: 'skip', reason: 'unparseable' });
});

test('planClaudeHookSelfHeal: non-object JSON (array) → skip', () => {
  expect(planClaudeHookSelfHeal('[]', true, CLAUDE_CMDS)).toEqual({ action: 'skip', reason: 'not-object' });
});

// --- runClaudeHookSelfHeal: the daemon IO orchestration, driven over an in-memory
// fake fs so the sentinel gate, unreadable-file guard, backup-once, and
// skip-means-no-write invariants are all covered without touching a real disk. ---
import { runClaudeHookSelfHeal } from '../features/tg-ctl/hook-install';

const SETTINGS = '/home/.claude/settings.json';
const SETTINGS_DIR = '/home/.claude';
const SENTINEL = '/cfg/claude-hooks-installed';
const SELF_PATHS = { settingsPath: SETTINGS, settingsDir: SETTINGS_DIR, sentinelPath: SENTINEL };

function fakeFs(seed: Record<string, string>, opts: { unreadable?: string[] } = {}) {
  const files = new Map(Object.entries(seed));
  const unreadable = new Set(opts.unreadable ?? []);
  const dirs: string[] = [];
  return {
    files,
    dirs,
    fs: {
      exists: (p: string) => files.has(p),
      read: (p: string) => (unreadable.has(p) ? null : files.get(p) ?? null),
      backup: (p: string, c: string) => { files.set(p, c); },
      writeAtomic: (p: string, c: string) => { files.set(p, c); },
      ensureDir: (d: string) => { dirs.push(d); },
      markOptedIn: (p: string) => { files.set(p, 'migrated\n'); },
    },
  };
}

test('runClaudeHookSelfHeal: no sentinel → skipped not-opted-in, nothing written', () => {
  const { files, fs } = fakeFs({ [SETTINGS]: GUTTED });
  const res = runClaudeHookSelfHeal(fs, SELF_PATHS, CLAUDE_CMDS);
  expect(res).toEqual({ outcome: 'skipped', reason: 'not-opted-in' });
  expect(files.get(SETTINGS)).toBe(GUTTED); // untouched
  expect(files.has(`${SETTINGS}.selfheal.bak`)).toBe(false);
});

test('runClaudeHookSelfHeal: opted in + gutted → healed, backup written once, dir ensured', () => {
  const { files, dirs, fs } = fakeFs({ [SENTINEL]: 'x', [SETTINGS]: GUTTED });
  const res = runClaudeHookSelfHeal(fs, SELF_PATHS, CLAUDE_CMDS);
  expect(res).toEqual({ outcome: 'healed' });
  expect(claudeHooksFullyInstalled(JSON.parse(files.get(SETTINGS)!), CLAUDE_CMDS)).toBe(true);
  expect(files.get(`${SETTINGS}.selfheal.bak`)).toBe(GUTTED);
  expect(dirs).toContain(SETTINGS_DIR);
});

test('runClaudeHookSelfHeal: existing backup is NOT overwritten by a second heal', () => {
  const priorBackup = JSON.stringify({ the: 'earliest good snapshot' });
  const { files, fs } = fakeFs({ [SENTINEL]: 'x', [SETTINGS]: GUTTED, [`${SETTINGS}.selfheal.bak`]: priorBackup });
  runClaudeHookSelfHeal(fs, SELF_PATHS, CLAUDE_CMDS);
  expect(files.get(`${SETTINGS}.selfheal.bak`)).toBe(priorBackup); // preserved
});

test('runClaudeHookSelfHeal: opted in + already installed → skipped, file untouched', () => {
  const full = JSON.stringify(reconcileClaudeHooks({}, CLAUDE_CMDS).settings);
  const { files, fs } = fakeFs({ [SENTINEL]: 'x', [SETTINGS]: full });
  const res = runClaudeHookSelfHeal(fs, SELF_PATHS, CLAUDE_CMDS);
  expect(res).toEqual({ outcome: 'skipped', reason: 'already-installed' });
  expect(files.get(SETTINGS)).toBe(full);
});

test('runClaudeHookSelfHeal: file EXISTS but unreadable → skipped unreadable, never clobbered', () => {
  const { files, fs } = fakeFs({ [SENTINEL]: 'x', [SETTINGS]: 'secret' }, { unreadable: [SETTINGS] });
  const res = runClaudeHookSelfHeal(fs, SELF_PATHS, CLAUDE_CMDS);
  expect(res).toEqual({ outcome: 'skipped', reason: 'unreadable' });
  expect(files.get(SETTINGS)).toBe('secret'); // NOT overwritten with a fresh install
});

test('runClaudeHookSelfHeal: restore-only — no settings file → skipped, never first-time-created', () => {
  const { files, fs } = fakeFs({ [SENTINEL]: 'x' });
  const res = runClaudeHookSelfHeal(fs, SELF_PATHS, CLAUDE_CMDS);
  expect(res).toEqual({ outcome: 'skipped', reason: 'no-settings-file' });
  expect(files.has(SETTINGS)).toBe(false); // the user's deletion is respected
});

test('runClaudeHookSelfHeal: unparseable settings → skipped, no write and no backup (hand-broken file left alone)', () => {
  const { files, fs } = fakeFs({ [SENTINEL]: 'x', [SETTINGS]: '{ broken' });
  const res = runClaudeHookSelfHeal(fs, SELF_PATHS, CLAUDE_CMDS);
  expect(res).toEqual({ outcome: 'skipped', reason: 'unparseable' });
  expect(files.get(SETTINGS)).toBe('{ broken'); // untouched
  expect(files.has(`${SETTINGS}.selfheal.bak`)).toBe(false);
});

test('runClaudeHookSelfHeal: no sentinel takes precedence even over an unreadable file', () => {
  const { fs } = fakeFs({ [SETTINGS]: 'secret' }, { unreadable: [SETTINGS] });
  // sentinel absent → not-opted-in wins; the unreadable file is never even read.
  expect(runClaudeHookSelfHeal(fs, SELF_PATHS, CLAUDE_CMDS)).toEqual({ outcome: 'skipped', reason: 'not-opted-in' });
});

test('planClaudeHookSelfHeal: whitespace-only settings → write with null backup', () => {
  const plan = planClaudeHookSelfHeal('   \n', true, CLAUDE_CMDS);
  expect(plan.action).toBe('write');
  if (plan.action !== 'write') throw new Error('unreachable');
  expect(plan.backup).toBeNull();
  expect(claudeHooksFullyInstalled(JSON.parse(plan.settingsJson), CLAUDE_CMDS)).toBe(true);
});

// --- #211: a pre-sentinel install (settings.json already carries every tg-ctl
// hook, but predates the opt-in sentinel) migrates to opted-in. ---

test('runClaudeHookSelfHeal #211: no sentinel + fully installed settings → sentinel written, migrated', () => {
  const full = JSON.stringify(reconcileClaudeHooks({}, CLAUDE_CMDS).settings);
  const { files, fs } = fakeFs({ [SETTINGS]: full });
  expect(runClaudeHookSelfHeal(fs, SELF_PATHS, CLAUDE_CMDS)).toEqual({ outcome: 'migrated' });
  expect(files.has(SENTINEL)).toBe(true);
  expect(files.get(SETTINGS)).toBe(full); // settings untouched
  // the next start sees the sentinel and takes the normal opted-in path
  expect(runClaudeHookSelfHeal(fs, SELF_PATHS, CLAUDE_CMDS)).toEqual({ outcome: 'skipped', reason: 'already-installed' });
});

test('runClaudeHookSelfHeal #211: no sentinel + PARTIAL hooks → still not-opted-in, no sentinel written', () => {
  const full = reconcileClaudeHooks({}, CLAUDE_CMDS).settings as Record<string, unknown>;
  const partial = JSON.stringify({ ...full, statusLine: undefined });
  const { files, fs } = fakeFs({ [SETTINGS]: partial });
  expect(runClaudeHookSelfHeal(fs, SELF_PATHS, CLAUDE_CMDS)).toEqual({ outcome: 'skipped', reason: 'not-opted-in' });
  expect(files.has(SENTINEL)).toBe(false);
});

// --- #212: the real-disk writer must write THROUGH a symlinked settings.json
// (dotfile managers) and keep the file's mode, never swap in a 0600 regular file. ---
import { writeSettingsPreservingLink } from '../features/tg-ctl/hook-install';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('writeSettingsPreservingLink #212: symlinked settings.json stays a symlink, target updated, mode kept', () => {
  const home = mkdtempSync(join(tmpdir(), 'tg-212-'));
  mkdirSync(join(home, 'dotfiles'));
  mkdirSync(join(home, '.claude'));
  const target = join(home, 'dotfiles', 'claude-settings.json');
  writeFileSync(target, '{}\n');
  chmodSync(target, 0o644);
  const link = join(home, '.claude', 'settings.json');
  symlinkSync(target, link);

  writeSettingsPreservingLink(link, '{"healed":true}\n');

  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readlinkSync(link)).toBe(target);
  expect(readFileSync(target, 'utf8')).toBe('{"healed":true}\n');
  expect(statSync(target).mode & 0o777).toBe(0o644);
});

test('writeSettingsPreservingLink #212: regular file keeps its mode (not forced to 0600)', () => {
  const home = mkdtempSync(join(tmpdir(), 'tg-212-'));
  const p = join(home, 'settings.json');
  writeFileSync(p, '{}\n');
  chmodSync(p, 0o640);
  writeSettingsPreservingLink(p, '{"a":1}\n');
  expect(lstatSync(p).isSymbolicLink()).toBe(false);
  expect(readFileSync(p, 'utf8')).toBe('{"a":1}\n');
  expect(statSync(p).mode & 0o777).toBe(0o640);
});

test('writeSettingsPreservingLink #212: missing file → created with the private 0600 default', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'tg-212-')), 'settings.json');
  writeSettingsPreservingLink(p, '{}\n');
  expect(readFileSync(p, 'utf8')).toBe('{}\n');
  expect(statSync(p).mode & 0o777).toBe(0o600);
});
