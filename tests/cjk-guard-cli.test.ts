import { expect, test } from 'bun:test';
import { join } from 'path';
import { tempDir } from './helpers/test-temp';

// CLI wiring for the stray-CJK guard (features/cli/cjk-guard.ts). The guard runs
// in the `tg` entrypoint on the FINAL decoded caption/title, right before send.
//
// A BLOCK exits 1 BEFORE the transmitter, so those cases need only fake creds
// (to clear the credential gate) and never touch the network. A PASS-THROUGH
// case would proceed to transmit, so it points TG_API_BASE at a closed local
// port (fast ECONNREFUSED, no external traffic) and asserts the guard did NOT
// fire — i.e. the send failed for a network reason, not a CJK block.

const TG_SCRIPT = join(import.meta.dir, '..', 'tg');
const BASE_ENV = {
  PATH: process.env.PATH ?? '',
  HOME: tempDir('tg-cli-test-home-cjk-'),
  TG_BOT_TOKEN: 'fake-token',
  TG_CHAT_ID: '123456',
};
// A closed high local port so a pass-through send fails fast (ECONNREFUSED)
// instead of hitting the real Bot API.
const OFFLINE_ENV = { ...BASE_ENV, TG_API_BASE: 'http://127.0.0.1:57193' };

function run(args: string[], env: Record<string, string>, stdin?: string) {
  return Bun.spawnSync(['bun', TG_SCRIPT, ...args], {
    env,
    stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : undefined,
  });
}

test('blocks a plain message with a lone stray CJK char (exit 1, names char + position)', () => {
  const proc = run(['ка日eat'], BASE_ENV);
  expect(proc.exitCode).toBe(1);
  const err = proc.stderr.toString();
  expect(err).toContain('日');
  expect(err).toContain('U+65E5');
  expect(err).toContain('at position 3'); // 1-based: к а 日 → 3
  expect(err.toLowerCase()).toContain('cjk');
});

test('blocks stray CJK stuck before Cyrillic ("<CJK>ляет")', () => {
  const proc = run(['注ляет'], BASE_ENV);
  expect(proc.exitCode).toBe(1);
  expect(proc.stderr.toString()).toContain('注');
});

test('blocks stray CJK inside a --table cell (final assembled body is checked)', () => {
  const proc = run(['--table'], BASE_ENV, 'ка日eat\tok\n');
  expect(proc.exitCode).toBe(1);
  expect(proc.stderr.toString()).toContain('日');
});

test('blocks stray CJK in the --title header (clean body), naming char + position', () => {
  const proc = run(['--title', 'ка日eat', 'clean body'], BASE_ENV);
  expect(proc.exitCode).toBe(1);
  const err = proc.stderr.toString();
  expect(err).toContain('日');
  expect(err).toContain('at position 3');
});

test('blocks stray CJK in the body when the --title is clean (both fields are scanned)', () => {
  const proc = run(['--title', 'Clean header', 'ка日eat'], BASE_ENV);
  expect(proc.exitCode).toBe(1);
  expect(proc.stderr.toString()).toContain('日');
});

// The pass-through cases proceed past the guard to the offline transmit, which
// fails to connect. We assert the guard did NOT fire (no CJK error) AND that the
// process reached the transmit (non-zero exit for a *network* reason), so an
// unrelated early crash can't masquerade as a guard-pass.
function expectPassedGuardThenFailedOffline(proc: ReturnType<typeof run>) {
  const err = proc.stderr.toString().toLowerCase();
  expect(err).not.toContain('stray cjk');
  expect(proc.exitCode).not.toBe(0);
}

test('does NOT block a genuinely CJK message (guard passes; failure is the offline send)', () => {
  const proc = run(['これは日本語のメッセージです。全て日本語です。'], OFFLINE_ENV);
  expectPassedGuardThenFailedOffline(proc);
});

test('does NOT block a lone kanji that no letter follows, even via the CLI ("done\\n日 done")', () => {
  // A lone CJK with a space after it (no following letter) is not the bug shape,
  // so the CLI must let it through to the (offline) transmit.
  const proc = run(['done\\n日 done'], OFFLINE_ENV);
  expectPassedGuardThenFailedOffline(proc);
});

test('does NOT block a legit Korean-particle bilingual message ("React를 배포")', () => {
  const proc = run(['React를 배포 done'], OFFLINE_ENV);
  expectPassedGuardThenFailedOffline(proc);
});

test('--no-feature cjk-guard lets a stray-CJK message past the guard', () => {
  const proc = run(['--no-feature', 'cjk-guard', 'ка日eat'], OFFLINE_ENV);
  expectPassedGuardThenFailedOffline(proc);
});
