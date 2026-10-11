import { expect, test } from 'bun:test';
import {
  ctlPaths,
  botIdFromToken,
  flockPidsForInode,
  readPidFile,
  ownsPidFile,
  shouldAutoStart,
  planLegacyLastUserTargetMigration,
  removeStalePidfile,
} from '../features/tg-ctl/lock';
import { DEFAULT_CONTROL, type ControlConfig } from '../features/tg-ctl/types';

const cfg = (over: Partial<ControlConfig> = {}): ControlConfig => ({
  ...DEFAULT_CONTROL,
  ...over,
});

// --- ctlPaths: all state files are tg-ctl.<botid>.* under configDir ---
test('ctlPaths builds lock/pid/offset/registration/socket/log under configDir', () => {
  const p = ctlPaths('/home/u/.config/tg-cli', '123456');
  expect(p.lock).toBe('/home/u/.config/tg-cli/tg-ctl.123456.lock');
  expect(p.pid).toBe('/home/u/.config/tg-cli/tg-ctl.123456.pid');
  expect(p.offset).toBe('/home/u/.config/tg-cli/tg-ctl.123456.offset');
  expect(p.registration).toBe('/home/u/.config/tg-cli/tg-ctl.123456.registration.json');
  expect(p.socket).toBe('/home/u/.config/tg-cli/tg-ctl.123456.sock');
  expect(p.log).toBe('/home/u/.config/tg-cli/tg-ctl.123456.log');
  expect(p.routes).toBe('/home/u/.config/tg-cli/tg-ctl.123456.routes.json');
  expect(p.history).toBe('/home/u/.config/tg-cli/tg-ctl.123456.history.jsonl');
  expect(p.topics).toBe('/home/u/.config/tg-cli/tg-ctl.123456.topics.json');
  expect(p.questions).toBe('/home/u/.config/tg-cli/tg-ctl.123456.questions.json');
  expect(p.schedules).toBe('/home/u/.config/tg-cli/tg-ctl.123456.schedules.json');
  expect(p.overloadRetries).toBe('/home/u/.config/tg-cli/tg-ctl.123456.overload-retries.json');
  expect(p.usageWarnings).toBe('/home/u/.config/tg-cli/tg-ctl.123456.usage-warnings.json');
  expect(p.usageLatest).toBe('/home/u/.config/tg-cli/tg-ctl.123456.usage-latest.json');
  expect(p.deferred).toBe('/home/u/.config/tg-cli/tg-ctl.123456.deferred.json');
  expect(p.lastUserTarget).toBe('/home/u/.config/tg-cli/tg-ctl.123456.last-user-target.json');
});

test('ctlPaths tolerates a trailing slash in configDir', () => {
  const p = ctlPaths('/tmp/cfg/', '99');
  expect(p.lock).toBe('/tmp/cfg/tg-ctl.99.lock');
});

// --- botIdFromToken: digits before the colon, nothing else ---
test('botIdFromToken extracts the numeric id before the colon', () => {
  expect(botIdFromToken('123456:ABC-DEF1234')).toBe('123456');
});

test('botIdFromToken returns empty string for malformed tokens', () => {
  expect(botIdFromToken('')).toBe('');
  expect(botIdFromToken('no-colon-here')).toBe('');
  expect(botIdFromToken(':ABC')).toBe('');
  expect(botIdFromToken('12ab34:XYZ')).toBe(''); // non-digit id → not a bot id
});

// --- readPidFile: trim + NaN-safe, only positive integers count ---
test('readPidFile parses a plain pid with surrounding whitespace', () => {
  expect(readPidFile('12345\n')).toBe(12345);
  expect(readPidFile('  777  ')).toBe(777);
});

test('readPidFile rejects missing/empty/garbage content', () => {
  expect(readPidFile(null)).toBeNull();
  expect(readPidFile('')).toBeNull();
  expect(readPidFile('   \n')).toBeNull();
  expect(readPidFile('abc')).toBeNull();
  expect(readPidFile('12.5')).toBeNull();
  expect(readPidFile('0')).toBeNull(); // kill(0, …) targets the process group
  expect(readPidFile('-5')).toBeNull();
});

// --- ownsPidFile: cleanExit may unlink the pidfile ONLY when it is ours (tg#93) ---
test('ownsPidFile is true only when the pidfile content equals our pid', () => {
  expect(ownsPidFile('4242\n', 4242)).toBe(true);
  expect(ownsPidFile('  4242  ', 4242)).toBe(true);
});

test('ownsPidFile is false for a FOREIGN pid — a departing daemon must NOT delete the live winner pidfile', () => {
  // The launchd-relaunch race: a newer winner already rewrote the pidfile with
  // its own pid (9999); the departing/loser daemon (pid 4242) running cleanExit
  // must see it is NOT the owner and leave the file alone.
  expect(ownsPidFile('9999\n', 4242)).toBe(false);
});

test('ownsPidFile is false for an absent or garbage pidfile', () => {
  expect(ownsPidFile(null, 4242)).toBe(false);
  expect(ownsPidFile('', 4242)).toBe(false);
  expect(ownsPidFile('   \n', 4242)).toBe(false);
  expect(ownsPidFile('not-a-pid', 4242)).toBe(false);
});

// --- shouldAutoStart: gate is TMUX + enabled, NOTHING else (spec §7) ---
test('shouldAutoStart fires inside tmux with control enabled', () => {
  expect(shouldAutoStart({ TMUX: '/tmp/tmux-501/default,123,0' }, cfg({ enabled: true }))).toBe(true);
});

test('shouldAutoStart is false without TMUX or with empty TMUX', () => {
  expect(shouldAutoStart({}, cfg({ enabled: true }))).toBe(false);
  expect(shouldAutoStart({ TMUX: '' }, cfg({ enabled: true }))).toBe(false);
});

test('shouldAutoStart is false when control is disabled', () => {
  expect(shouldAutoStart({ TMUX: '/tmp/tmux-501/default,123,0' }, cfg({ enabled: false }))).toBe(false);
});

// Spec §7 explicitly mandates NO TTY check: the agent calls tg through a piped
// Bash tool, so isatty is false in exactly the scenario that must fire. This
// test pins the gate to TMUX+enabled — no other env key may influence it.
test('shouldAutoStart ignores everything except TMUX (no TTY gate)', () => {
  const env = {
    TMUX: '/tmp/tmux-501/default,123,0',
    CI: 'true',
    SSH_TTY: '',
    TERM: 'dumb',
  };
  expect(shouldAutoStart(env, cfg({ enabled: true }))).toBe(true);
});

// --- planLegacyLastUserTargetMigration (tg-cli#281): plan only, `exists` is
// injected so this never touches real disk ---
test('plans a migration when only the legacy file exists', () => {
  const present = new Set(['/cfg/tg-ctl.123.last-alex-target.json']);
  const plan = planLegacyLastUserTargetMigration('/cfg', '123', (p) => present.has(p));
  expect(plan).toEqual({
    kind: 'migrate',
    from: '/cfg/tg-ctl.123.last-alex-target.json',
    to: '/cfg/tg-ctl.123.last-user-target.json',
  });
});

// review finding, round 3: if both exist, the legacy file must be REMOVED, not
// just skipped — leaving it would let a future restart, after a legitimate
// invalidation later clears the new file, silently resurrect this stale copy.
test('plans removal of the legacy file when the new file already exists — never overwrite live state, never let it linger to resurrect later', () => {
  const present = new Set([
    '/cfg/tg-ctl.123.last-alex-target.json',
    '/cfg/tg-ctl.123.last-user-target.json',
  ]);
  const plan = planLegacyLastUserTargetMigration('/cfg', '123', (p) => present.has(p));
  expect(plan).toEqual({ kind: 'remove-stale', path: '/cfg/tg-ctl.123.last-alex-target.json' });
});

test('plans nothing on a fresh install — neither file exists', () => {
  expect(planLegacyLastUserTargetMigration('/cfg', '123', () => false)).toBeNull();
});

// --- flockPidsForInode (tg-cli#490): who holds a flock, read from /proc/locks without
// taking the lock. A probe that TOOK the daemon flock for an instant made a successor
// starting in that instant exit 0, and `restart` left no daemon. ---
const PROC_LOCKS = [
  '1: POSIX  ADVISORY  READ 3305049 00:31:1968647 128 128',
  '2: FLOCK  ADVISORY  WRITE 4242 103:02:8705582 0 EOF',
  '2: -> FLOCK  ADVISORY  WRITE 5151 103:02:8705582 0 EOF',
  '3: OFDLCK ADVISORY  WRITE -1 103:02:8705582 0 EOF',
  '4: FLOCK  ADVISORY  WRITE 7777 00:1d:870558 0 EOF',
  '5: FLOCK  ADVISORY  WRITE 4242 08:01:8705582 0 EOF',
  '6: FLOCK  ADVISORY  WRITE 0 103:02:4410 0 EOF',
  '',
].join('\n');

test('flockPidsForInode lists the pids holding a FLOCK on that inode, once each', () => {
  expect(flockPidsForInode(PROC_LOCKS, '8705582')).toEqual([4242]);
});

test('flockPidsForInode ignores blocked waiters, POSIX/OFD locks and other inodes', () => {
  expect(flockPidsForInode(PROC_LOCKS, '1968647')).toEqual([]);
  expect(flockPidsForInode(PROC_LOCKS, '870558')).toEqual([7777]);
  expect(flockPidsForInode(PROC_LOCKS, '123')).toEqual([]);
  expect(flockPidsForInode('', '8705582')).toEqual([]);
});

// The kernel prints pid 0 for a holder outside the reader's pid namespace (or whose locker died
// while an inherited fd keeps the lock): the lock IS held, by someone this reader cannot name.
test('flockPidsForInode keeps an unnamed holder as 0 so the caller does not read the lock as free', () => {
  expect(flockPidsForInode(PROC_LOCKS, '4410')).toEqual([0]);
});

// tg-cli#399 review P2: `status` deletes a stale pidfile, but a daemon may start between the
// probe and the unlink. These fakes model each interleaving with a pidfile held in memory.
function fakePidfile(initial: number | null, holders: Array<number | 'unknown' | null>) {
  const state = { pid: initial, unlinks: 0 };
  const ops = {
    readPid: () => state.pid,
    lockHolder: () => holders.shift() ?? null,
    unlink: () => {
      state.unlinks++;
      state.pid = null;
    },
    writeIfAbsent: (pid: number) => {
      if (state.pid !== null) throw new Error('EEXIST');
      state.pid = pid;
    },
  };
  return { state, ops };
}

test('removeStalePidfile removes the pidfile when it still names the dead pid and nothing holds the lock', () => {
  const { state, ops } = fakePidfile(999999, [null, null]);
  expect(removeStalePidfile(999999, ops)).toBe('cleaned');
  expect(state).toEqual({ pid: null, unlinks: 1 });
});

test('removeStalePidfile keeps a pidfile a newly started daemon rewrote with its own pid', () => {
  const { state, ops } = fakePidfile(4242, [null]);
  expect(removeStalePidfile(999999, ops)).toBe('kept');
  expect(state).toEqual({ pid: 4242, unlinks: 0 });
});

test('removeStalePidfile keeps the pidfile while a process holds the daemon lock', () => {
  const { state, ops } = fakePidfile(999999, [4242]);
  expect(removeStalePidfile(999999, ops)).toBe('kept');
  expect(state).toEqual({ pid: 999999, unlinks: 0 });
});

// The successor outcome tells `status` its earlier "not running" probe is obsolete (review P1).
test('removeStalePidfile writes the lock holder back when a daemon took the lock during the unlink', () => {
  const { state, ops } = fakePidfile(999999, [null, 4242]);
  expect(removeStalePidfile(999999, ops)).toBe('successor');
  expect(state).toEqual({ pid: 4242, unlinks: 1 });
});

test('removeStalePidfile does not overwrite a pidfile the successor already wrote', () => {
  const { state, ops } = fakePidfile(999999, [null, 4242]);
  ops.unlink = () => {
    state.unlinks++;
    state.pid = 5151; // the successor rewrote it between our unlink and the re-check
  };
  expect(removeStalePidfile(999999, ops)).toBe('successor');
  expect(state).toEqual({ pid: 5151, unlinks: 1 });
});

test('removeStalePidfile reports no cleanup when the unlink fails', () => {
  const { state, ops } = fakePidfile(999999, [null]);
  ops.unlink = () => {
    throw new Error('EACCES');
  };
  expect(removeStalePidfile(999999, ops)).toBe('kept');
  expect(state.pid).toBe(999999);
});

test('removeStalePidfile keeps the pidfile when the lock holder cannot be inspected', () => {
  const { state, ops } = fakePidfile(999999, ['unknown']);
  expect(removeStalePidfile(999999, ops)).toBe('kept');
  expect(state).toEqual({ pid: 999999, unlinks: 0 });
});

test('removeStalePidfile asks for a re-probe, writing nothing, when the lock turns uninspectable after the unlink', () => {
  const { state, ops } = fakePidfile(999999, [null, 'unknown']);
  expect(removeStalePidfile(999999, ops)).toBe('successor');
  expect(state).toEqual({ pid: null, unlinks: 1 });
});
