import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tempDir } from './helpers/test-temp';

// CLI wiring for the screenshot-attach gate (features/cli/screenshot-guard.ts).
// A text send that mentions screenshot/скриншот with no photo attached must
// hard-block BEFORE the transmitter (tg-cli#337). A BLOCK exits 1 with the
// attach-the-image error, so those cases need only fake creds and never touch
// the network. A PASS-THROUGH case proceeds to transmit, so it points
// TG_API_BASE at a closed local port (fast ECONNREFUSED) and asserts the gate
// did NOT fire.

const TG_SCRIPT = join(import.meta.dir, '..', 'tg');
const BASE_ENV = {
  PATH: process.env.PATH ?? '',
  HOME: tempDir('tg-cli-test-home-screenshot-guard-'),
  TG_BOT_TOKEN: 'fake-token',
  TG_CHAT_ID: '123456',
};
const OFFLINE_ENV = { ...BASE_ENV, TG_API_BASE: 'http://127.0.0.1:57193' };

interface GuardProc {
  exitCode: number | null;
  stdout: { toString(): string };
  stderr: { toString(): string };
}

function run(args: string[], env: Record<string, string>): GuardProc {
  return Bun.spawnSync(['bun', TG_SCRIPT, ...args], { env });
}

function expectBlockedAttach(proc: GuardProc): void {
  expect(proc.exitCode).toBe(1);
  const err = proc.stderr.toString();
  expect(err.toLowerCase()).toContain('screenshot');
  expect(err).toContain('tg --photo');
  expect(err.toLowerCase()).toContain('attach');
  expect(err).toMatch(/do not dodge|don't dodge/i);
  expect(err.toLowerCase()).toContain('deleting the word');
  expect(err).not.toContain('ConnectionRefused');
  expect(err).not.toContain('sendMessage');
}

test('blocks a plain message that mentions screenshot without --photo', () => {
  const proc = run(['see screenshot foo.png'], BASE_ENV);
  expectBlockedAttach(proc);
});

test('blocks Cyrillic скриншот without --photo', () => {
  const proc = run(['см. скриншот foo.png'], BASE_ENV);
  expectBlockedAttach(proc);
});

test('blocks SCREENSHOT any-case without --photo', () => {
  const proc = run(['See SCREENSHOT of the dialog'], BASE_ENV);
  expectBlockedAttach(proc);
});

test('blocks --dry-run of a screenshot mention without a photo', () => {
  const proc = run(['--dry-run', 'see screenshot foo.png'], BASE_ENV);
  expectBlockedAttach(proc);
  expect(proc.stdout.toString()).not.toContain('well-formed');
});

test('error tells to attach the image, not to omit the word', () => {
  const proc = run(['see screenshot foo.png'], BASE_ENV);
  expectBlockedAttach(proc);
  const err = proc.stderr.toString().toLowerCase();
  expect(err).toContain('attach the screenshot');
  expect(err).not.toContain('remove the word');
  expect(err).not.toContain('omit the word');
});

test('blocks screenshot mention when --photo path is missing', () => {
  const proc = run(['--photo', '/no-such-screenshot-337.png', 'screenshot attached'], BASE_ENV);
  expectBlockedAttach(proc);
});

test('allows screenshot mention when --photo is attached', () => {
  const dir = tempDir('tg-screenshot-photo-');
  mkdirSync(dir, { recursive: true });
  const img = join(dir, 'x.png');
  writeFileSync(img, 'PNGDATA');
  const proc = run(['--photo', img, 'screenshot of the dialog'], OFFLINE_ENV);
  const err = proc.stderr.toString().toLowerCase();
  expect(err).not.toContain('do not dodge');
  expect(err).not.toContain('attach the screenshot');
  expect(proc.exitCode).not.toBe(0);
});
