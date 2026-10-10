import { expect, test } from 'bun:test';
import { join } from 'path';
import { tempDir } from './helpers/test-temp';

// CLI wiring for the mixed-script "garbage token" guard
// (features/cli/mixed-script-guard.ts). It runs in the `tg` entrypoint on the
// FINAL decoded caption/title, right before send, under the SAME `cjk-guard`
// feature flag as the stray-CJK guard.
//
// A BLOCK exits 1 BEFORE the transmitter, so those cases need only fake creds
// and never touch the network. A PASS-THROUGH case would proceed to transmit, so
// it points TG_API_BASE at a closed local port (fast ECONNREFUSED) and asserts
// the guard did NOT fire — the send failed for a network reason, not a block.

const TG_SCRIPT = join(import.meta.dir, '..', 'tg');
const BASE_ENV = {
  PATH: process.env.PATH ?? '',
  HOME: tempDir('tg-cli-test-home-mixed-script-'),
  TG_BOT_TOKEN: 'fake-token',
  TG_CHAT_ID: '123456',
};
const OFFLINE_ENV = { ...BASE_ENV, TG_API_BASE: 'http://127.0.0.1:57197' };

function run(args: string[], env: Record<string, string>, stdin?: string) {
  return Bun.spawnSync(['bun', TG_SCRIPT, ...args], {
    env,
    stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : undefined,
  });
}

test('blocks the reported "почčesна" mojibake title (exit 1, names token + position)', () => {
  const proc = run(['--title', 'почčesна', 'clean body'], BASE_ENV);
  expect(proc.exitCode).toBe(1);
  const err = proc.stderr.toString();
  expect(err).toContain('почčesна');
  expect(err).toContain('at position 1');
  expect(err.toLowerCase()).toContain('mixed');
});

test('blocks a mixed-script garbage word in the plain body', () => {
  const proc = run(['задача починeна'], BASE_ENV); // Latin "e" in a Cyrillic word
  expect(proc.exitCode).toBe(1);
  expect(proc.stderr.toString()).toContain('починeна');
});

test('blocks a mixed-script token inside a --table cell (assembled body is checked)', () => {
  const proc = run(['--table'], BASE_ENV, 'почčesна\tok\n');
  expect(proc.exitCode).toBe(1);
  expect(proc.stderr.toString()).toContain('почčesна');
});

function expectPassedGuardThenFailedOffline(proc: ReturnType<typeof run>) {
  const err = proc.stderr.toString().toLowerCase();
  // A phrase unique to the guard's error text (the worktree PATH itself contains
  // "mixed-script", so we cannot key on that substring).
  expect(err).not.toContain('mixes cyrillic');
  expect(proc.exitCode).not.toBe(0);
  // Positively confirm the send reached the (offline) transmitter rather than
  // failing early for an unrelated reason that would also clear the checks above.
  expect(err).toContain('connect');
}

test('does NOT block a message with separate Cyrillic and Latin words ("влил PR gh ship")', () => {
  const proc = run(['влил PR gh ship готово'], OFFLINE_ENV);
  expectPassedGuardThenFailedOffline(proc);
});

test('does NOT block a hyphenated Latin+Cyrillic compound ("PR-ревью прошло")', () => {
  const proc = run(['PR-ревью прошло, MCP-сервер поднят'], OFFLINE_ENV);
  expectPassedGuardThenFailedOffline(proc);
});

test('does NOT block a clean pure-Cyrillic message ("починена")', () => {
  const proc = run(['задача починена, тесты зелёные'], OFFLINE_ENV);
  expectPassedGuardThenFailedOffline(proc);
});

test('does NOT block a glued Latin-acronym + Cyrillic-suffix compound ("IDшник")', () => {
  const proc = run(['IDшник обновлён, APIшка готова'], OFFLINE_ENV);
  expectPassedGuardThenFailedOffline(proc);
});

// tg-cli#224: the guard is BIDIRECTIONAL — a Cyrillic letter sandwiched inside
// a Latin word ("mіr" = Latin m + Cyrillic і U+0456 + Latin r) is blocked the
// same way as a Latin fragment inside a Cyrillic word. Pinned at the CLI so the
// documented contract matches what ships.
test('blocks a Cyrillic letter sandwiched inside a Latin word ("mіr", foreign→Cyrillic→foreign)', () => {
  const proc = run(['hello mіr'], BASE_ENV);
  expect(proc.exitCode).toBe(1);
  expect(proc.stderr.toString()).toContain('mіr');
});

// tg-cli#215 / #226: Russian dev slang and acronym islands glue a Cyrillic
// prefix AND suffix onto an untouched English stem — legit, not mojibake.
test('does NOT block Russian dev slang / acronym islands ("заpushил", "антиDDoSный")', () => {
  const proc = run(['заpushил фикс, заmergeил PR, заcommitил, отdebugил, антиDDoSный фильтр'], OFFLINE_ENV);
  expectPassedGuardThenFailedOffline(proc);
});

// tg-cli#227: an invisible format char must not split a garbage run in two.
test('blocks a mojibake token split by a zero-width space ("поч\\u200Bčesна")', () => {
  const proc = run(['задача поч\u200Bčesна'], BASE_ENV);
  expect(proc.exitCode).toBe(1);
  expect(proc.stderr.toString()).toContain('čes');
});

test('does NOT block a clean --title + clean body (positive pass path for --title)', () => {
  const proc = run(['--title', 'Задача починена', 'все тесты зелёные'], OFFLINE_ENV);
  expectPassedGuardThenFailedOffline(proc);
});

test('--no-feature cjk-guard lets a mixed-script message past the guard', () => {
  const proc = run(['--no-feature', 'cjk-guard', 'почčesна'], OFFLINE_ENV);
  expectPassedGuardThenFailedOffline(proc);
});

test('when a message carries BOTH a stray-CJK and a mixed-script token, the CJK guard wins', () => {
  // Both guards share the pre-send gate and the stray-CJK check runs first, so
  // its error is the one surfaced. Locks the ordering.
  const proc = run(['ка日eat потом почčesна'], BASE_ENV);
  expect(proc.exitCode).toBe(1);
  const err = proc.stderr.toString();
  expect(err).toContain('日'); // the CJK guard's error, not the mixed-script one
  expect(err.toLowerCase()).not.toContain('mixes cyrillic');
});
