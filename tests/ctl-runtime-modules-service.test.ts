// Characterization of daemon-runtime service-area modules pinned during the guardian-817
// decomposition: the flock reader, install-hooks, overload-retry store parsing, the usage-schedule
// check, and voice-setup's dry-run paths. Hermetic: temp dirs only, no network, rig forced absent.
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { LOCK_EX_NB, LOCK_UN, flock, procFlockHolders } from '../features/tg-ctl/daemon-runtime/daemon-lock';
import { installHooks } from '../features/tg-ctl/daemon-runtime/hooks-setup';
import { parseOverloadRetryRecords } from '../features/tg-ctl/daemon-runtime/usage-records';
import { runUsageScheduleCheck } from '../features/tg-ctl/daemon-runtime/usage-schedule';
import { runVoiceSetup } from '../features/tg-ctl/daemon-runtime/voice-setup';
import { captureStdoutLines } from './helpers/stdout-lines';
import { tempDir } from './helpers/test-temp';

let logs: string[] = [];
let errors: string[] = [];
let logSpy: ReturnType<typeof captureStdoutLines>;
let errSpy: ReturnType<typeof spyOn>;
const savedEnv = { ...process.env };

beforeEach(() => {
  logs = [];
  errors = [];
  logSpy = captureStdoutLines(logs);
  errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.join(' ')));
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  process.env = { ...savedEnv };
});

// --- procFlockHolders (tg-cli#490) ---

test.skipIf(process.platform !== 'linux')('procFlockHolders: no lock file → [] (nobody holds it)', () => {
  expect(procFlockHolders(join(tempDir('tg-svc-lock-'), 'absent.lock'))).toEqual([]);
});

test.skipIf(process.platform !== 'linux')('procFlockHolders: unlocked file → []; flocked by this process → [pid]', () => {
  const lockPath = join(tempDir('tg-svc-lock-'), 'x.lock');
  writeFileSync(lockPath, '');
  expect(procFlockHolders(lockPath)).toEqual([]);
  const fd = openSync(lockPath, 'r');
  try {
    expect(flock(fd, LOCK_EX_NB)).toBe(0);
    expect(procFlockHolders(lockPath)).toEqual([process.pid]);
    flock(fd, LOCK_UN);
    expect(procFlockHolders(lockPath)).toEqual([]);
  } finally {
    closeSync(fd);
  }
});

test.skipIf(process.platform !== 'linux')('procFlockHolders: an unstattable path other than ENOENT → null (no confident answer)', () => {
  const dir = tempDir('tg-svc-lock-');
  writeFileSync(join(dir, 'file'), '');
  // ENOTDIR, not ENOENT
  expect(procFlockHolders(join(dir, 'file', 'x.lock'))).toBeNull();
});

// --- parseOverloadRetryRecords ---

const NOW = 2_000_000_000_000;
const good = { key: 'k1', attempt: 2, pid: 42, lastFailureAt: NOW - 1000, nextAt: NOW + 1000 };

test('parseOverloadRetryRecords: keeps valid rows, normalizes absent/null pid, drops each malformed field', () => {
  const rows = [
    good,
    { ...good, key: 'nopid', pid: undefined },
    { ...good, key: 'nullpid', pid: null },
    { ...good, key: 3 },
    { ...good, key: 'a0', attempt: 0 },
    { ...good, key: 'afrac', attempt: 1.5 },
    { ...good, key: 'astr', attempt: '1' },
    { ...good, key: 'lf', lastFailureAt: 0 },
    { ...good, key: 'nxt', nextAt: -1 },
    { ...good, key: 'pidneg', pid: -3 },
    { ...good, key: 'pidfrac', pid: 1.5 },
    { ...good, key: 'pidstr', pid: '7' },
    null,
    'junk',
  ];
  const out = parseOverloadRetryRecords(JSON.stringify({ retries: rows }), NOW);
  expect(out).toEqual([
    { key: 'k1', attempt: 2, pid: 42, lastFailureAt: NOW - 1000, nextAt: NOW + 1000 },
    { key: 'nopid', attempt: 2, pid: null, lastFailureAt: NOW - 1000, nextAt: NOW + 1000 },
    { key: 'nullpid', attempt: 2, pid: null, lastFailureAt: NOW - 1000, nextAt: NOW + 1000 },
  ]);
});

test('parseOverloadRetryRecords: non-JSON, missing array, empty blob → []; rows older than 24 reset windows are dropped', () => {
  expect(parseOverloadRetryRecords(null, NOW)).toEqual([]);
  expect(parseOverloadRetryRecords('{', NOW)).toEqual([]);
  expect(parseOverloadRetryRecords('{"retries":"x"}', NOW)).toEqual([]);
  const ancient = { ...good, key: 'old', lastFailureAt: 1 };
  expect(parseOverloadRetryRecords(JSON.stringify({ retries: [ancient, good] }), NOW).map((r) => r.key)).toEqual(['k1']);
});

// --- installHooks ---

function hooksHome(): string {
  const home = tempDir('tg-svc-home-');
  process.env.RIG_AGENT_TOOLS_SOURCE = join(home, 'no-agent-tools'); // rig absent → direct codex write
  process.env.TG_CTL_CONFIG_DIR = join(home, 'cfg');
  delete process.env.CODEX_HOME;
  return home;
}

test('installHooks: fresh home installs claude + codex hooks, prints guidance, records the opt-in sentinel, exit 0', () => {
  const home = hooksHome();
  const cwdSpy = spyOn(process, 'cwd').mockReturnValue(home);
  try {
    expect(installHooks(home)).toBe(0);
  } finally {
    cwdSpy.mockRestore();
  }
  expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(true);
  expect(existsSync(join(home, '.claude', 'settings.json.bak'))).toBe(false);
  expect(existsSync(join(home, '.codex', 'hooks.json'))).toBe(true);
  expect(logs[0]).toStartWith(`tg-ctl: installed Claude Code q→buttons + StopFailure + statusLine usage telemetry → ${join(home, '.claude', 'settings.json')}`);
  expect(logs.some((l) => l.startsWith('tg-ctl: installed Codex Stop usage telemetry collector'))).toBe(true);
  expect(logs).toContain('');
  expect(logs).toContain('Restart any running agent session so it loads the new hooks.');
  expect(logs.at(-1)).toStartWith('The daemon will restore these hooks if a settings.json rewrite drops them.');
  expect(readdirNames(join(home, 'cfg'))).toHaveLength(1);
});

function readdirNames(dir: string): string[] {
  return Bun.spawnSync(['ls', dir], { stdout: 'pipe' }).stdout.toString().split('\n').filter(Boolean);
}

test('installHooks: second run is a no-op for claude and codex and does not touch backups', () => {
  const home = hooksHome();
  const cwdSpy = spyOn(process, 'cwd').mockReturnValue(home);
  try {
    installHooks(home);
    logs.length = 0;
    expect(installHooks(home)).toBe(0);
  } finally {
    cwdSpy.mockRestore();
  }
  expect(logs[0]).toBe('tg-ctl: Claude Code q→buttons + StopFailure + statusLine usage telemetry already installed — nothing to do.');
  expect(logs).toContain('tg-ctl: Codex Stop usage telemetry collector already installed — nothing to do.');
});

test('installHooks: pre-existing settings are backed up byte-for-byte before the rewrite', () => {
  const home = hooksHome();
  mkdirSync(join(home, '.claude'), { recursive: true });
  const original = '{"theme":"dark"}';
  writeFileSync(join(home, '.claude', 'settings.json'), original);
  const cwdSpy = spyOn(process, 'cwd').mockReturnValue(home);
  try {
    installHooks(home);
  } finally {
    cwdSpy.mockRestore();
  }
  expect(readFileSync(join(home, '.claude', 'settings.json.bak'), 'utf8')).toBe(original);
  expect(JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).theme).toBe('dark');
  expect(logs[0]).toEndWith(`(backup: ${join(home, '.claude', 'settings.json')}.bak)`);
});

class ExitCalled extends Error {
  constructor(readonly code: number | string | null | undefined) {
    super('exit');
  }
}

function runExpectingExit(fn: () => unknown): ExitCalled {
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitCalled(code);
  }) as never);
  try {
    fn();
  } catch (err) {
    if (err instanceof ExitCalled) return err;
    throw err;
  } finally {
    exitSpy.mockRestore();
  }
  throw new Error('process.exit was not called');
}

test.each([
  ['claude', ['.claude', 'settings.json'], '{nope', 'is not valid JSON'],
  ['claude', ['.claude', 'settings.json'], '[1]', 'is not a JSON object'],
  ['codex', ['.codex', 'hooks.json'], '{nope', 'is not valid JSON'],
  ['codex', ['.codex', 'hooks.json'], '"str"', 'is not a JSON object'],
])('installHooks: %s file %s → exit 1 with a fix-it message, nothing written', (_label, rel, content, phrase) => {
  const home = hooksHome();
  const path = join(home, ...rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  const cwdSpy = spyOn(process, 'cwd').mockReturnValue(home);
  try {
    expect(runExpectingExit(() => installHooks(home)).code).toBe(1);
  } finally {
    cwdSpy.mockRestore();
  }
  expect(errors).toEqual([`tg-ctl: ${path} ${phrase} — fix or move it aside, then re-run`]);
  expect(readFileSync(path, 'utf8')).toBe(content);
  expect(existsSync(join(home, 'cfg'))).toBe(false);
});

// --- runUsageScheduleCheck ---
// PATH is replaced by a private shim dir so no real `tg` / `rig` is ever reached.

function shimBin(scripts: Record<string, string>): { bin: string; calls: string } {
  const bin = tempDir('tg-svc-bin-');
  const calls = join(bin, 'calls.log');
  for (const [name, body] of Object.entries(scripts)) {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${body.replaceAll('$CALLS', calls)}\n`);
    chmodSync(path, 0o755);
  }
  symlinkSync('/usr/bin/which', join(bin, 'which')); // voice-probe finds tools with `which`
  process.env.PATH = bin;
  return { bin, calls };
}

// Wednesday: both the previous week and the previous month have closed, and today is NOT a
// boundary day, so each due period is reported LATE with the missed-report notice (no `rig`).
const LATE = new Date(2026, 5, 10, 9, 0);

test('runUsageScheduleCheck: nothing due (watermark current) → exit 0, silent, no send, watermark untouched', async () => {
  const { calls } = shimBin({ tg: 'echo "$@" >> $CALLS' });
  const wm = join(tempDir('tg-svc-usage-'), 'wm.json');
  const current = { lastWeekReported: '2026-06-07', lastMonthReported: '2026-05' };
  writeFileSync(wm, JSON.stringify(current));
  expect(await runUsageScheduleCheck(new Date(2026, 5, 9, 9, 0), false, wm)).toBe(0);
  expect(logs).toEqual([]);
  expect(errors).toEqual([]);
  expect(existsSync(calls)).toBe(false);
  expect(JSON.parse(readFileSync(wm, 'utf8'))).toEqual(current);
});

test('runUsageScheduleCheck: late periods are sent via tg and the watermark advances after EACH successful send', async () => {
  const { calls } = shimBin({ tg: 'echo "$*" >> $CALLS' });
  const wm = join(tempDir('tg-svc-usage-'), 'wm.json');
  expect(await runUsageScheduleCheck(LATE, false, wm)).toBe(0);
  const sent = readFileSync(calls, 'utf8').trim().split('\n');
  expect(sent).toHaveLength(2);
  expect(sent[0]).toContain('--format html --automated --tag report --title Weekly usage report');
  expect(sent[1]).toContain('--title Monthly usage report');
  const mark = JSON.parse(readFileSync(wm, 'utf8'));
  expect(mark.lastWeekReported).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(mark.lastMonthReported).toMatch(/^\d{4}-\d{2}$/);
  expect(errors).toEqual([]);
});

test('runUsageScheduleCheck: a failed send leaves the period due (watermark not written) and says why', async () => {
  shimBin({ tg: 'echo boom >&2; exit 1' });
  const wm = join(tempDir('tg-svc-usage-'), 'wm.json');
  expect(await runUsageScheduleCheck(LATE, false, wm)).toBe(0);
  expect(existsSync(wm)).toBe(false);
  expect(errors).toEqual([
    'tg-ctl: usage-schedule: sending "Weekly usage report" failed (exit 1): boom',
    'tg-ctl: usage-schedule: sending "Monthly usage report" failed (exit 1): boom',
  ]);
});

test('runUsageScheduleCheck: dry-run logs each would-send (truncated body, LATE marker) and never sends or persists', async () => {
  const { calls } = shimBin({ tg: 'echo "$@" >> $CALLS' });
  const wm = join(tempDir('tg-svc-usage-'), 'wm.json');
  expect(await runUsageScheduleCheck(LATE, true, wm)).toBe(0);
  expect(existsSync(calls)).toBe(false);
  expect(existsSync(wm)).toBe(false);
  expect(logs).toHaveLength(2);
  expect(logs[0]).toMatch(/^tg-ctl: \[dry-run\] would send "Weekly usage report" \(period \d{4}-\d{2}-\d{2}, LATE\): /);
  expect(logs[1]).toMatch(/^tg-ctl: \[dry-run\] would send "Monthly usage report" \(period \d{4}-\d{2}, LATE\): /);
});

// --- runVoiceSetup ---

const voiceArgs = (home: string, current: Partial<Parameters<typeof runVoiceSetup>[0]['current']>, dryRun: boolean) => ({
  configDir: join(home, 'cfg'),
  home,
  current: { enabled: false, runner: 'faster-whisper' as const, binPath: '', modelPath: '', language: 'en', ...current },
  dryRun,
});

test.skipIf(process.platform !== 'linux')('runVoiceSetup: uv present, nothing installed, --dry-run → prints plan, runs nothing, returns true', () => {
  const { calls } = shimBin({ uv: 'echo uv >> $CALLS', ffmpeg: 'exit 0' });
  const home = tempDir('tg-svc-voice-');
  expect(runVoiceSetup(voiceArgs(home, {}, true))).toBe(true);
  expect(logs.at(-1)).toBe('--dry-run: nothing installed, config.yaml unchanged.');
  expect(existsSync(calls)).toBe(false);
  expect(existsSync(join(home, 'cfg', 'config.yaml'))).toBe(false);
});

test.skipIf(process.platform !== 'linux')('runVoiceSetup: a failing install step stops the plan, names the step and exit code, returns false', () => {
  const { calls } = shimBin({ uv: 'echo "uv $1" >> $CALLS; exit 3', ffmpeg: 'exit 0' });
  expect(runVoiceSetup(voiceArgs(tempDir('tg-svc-voice-'), {}, false))).toBe(false);
  expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['uv venv']);
  expect(logs.some((l) => l.startsWith('\n→ Python '))).toBe(true);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatch(/^✗ Python .* venv failed \(exit 3\)\. Fix the cause above and re-run `tg voice setup`\.$/);
});

test.skipIf(process.platform !== 'linux')('runVoiceSetup: a step whose binary cannot be spawned reports exit 127 after the earlier steps ran', () => {
  const { calls } = shimBin({ uv: 'echo "uv $1" >> $CALLS', ffmpeg: 'exit 0' });
  expect(runVoiceSetup(voiceArgs(tempDir('tg-svc-voice-'), {}, false))).toBe(false);
  expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['uv venv', 'uv pip']);
  expect(errors.at(-1)).toMatch(/^✗ Model .* failed \(exit 127\)\. Fix the cause above/);
});

test.skipIf(process.platform !== 'linux')('runVoiceSetup: a kept, still-present config is persisted to config.yaml, then the status message prints', () => {
  shimBin({ ffmpeg: 'exit 0' });
  const home = tempDir('tg-svc-voice-');
  const bin = join(home, 'py');
  writeFileSync(bin, '');
  const args = voiceArgs(home, { binPath: bin, modelPath: 'large-v3-turbo', enabled: true }, false);
  expect(runVoiceSetup(args)).toBe(true);
  const yaml = readFileSync(join(home, 'cfg', 'config.yaml'), 'utf8');
  expect(yaml).toContain('voice:');
  expect(yaml).toContain(bin);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain('✓');
});

test.skipIf(process.platform !== 'linux')('runVoiceSetup: ready + --dry-run shows the block it would write and returns true WITHOUT the status message', () => {
  shimBin({ ffmpeg: 'exit 0' });
  const home = tempDir('tg-svc-voice-');
  const bin = join(home, 'py');
  writeFileSync(bin, '');
  expect(runVoiceSetup(voiceArgs(home, { binPath: bin, modelPath: 'large-v3-turbo', enabled: true }, true))).toBe(true);
  expect(existsSync(join(home, 'cfg', 'config.yaml'))).toBe(false);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toStartWith(`--dry-run: ${join(home, 'cfg', 'config.yaml')} unchanged; tg voice setup would write:\n`);
});
