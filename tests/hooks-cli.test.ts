import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { runHooksCli } from '../features/hooks/cli';
import { toolHooksDir, trustFile } from '../features/hooks/run-photo-hooks';
import { tempDir } from './helpers/test-temp';

// `tg hooks trust/list/untrust`. Hooks are trust-by-default, so `trust` is a
// no-op unless the AGENTS_HOOKS_TRUST=1 guard re-engages the TOFU pin path — at
// which point the quarantine banner points users back here.

// The opt-in guard env, passed explicitly to runHooksCli so these tests don't
// depend on the ambient AGENTS_HOOKS_TRUST of the test runner.
const GUARD = { AGENTS_HOOKS_TRUST: '1' } as NodeJS.ProcessEnv;
const NO_GUARD = {} as NodeJS.ProcessEnv;

let home: string;
let logs: string[];
let errs: string[];
let origLog: typeof console.log;
let origErr: typeof console.error;

beforeEach(() => {
  home = tempDir('tg-hooks-cli-');
  logs = [];
  errs = [];
  origLog = console.log;
  origErr = console.error;
  console.log = (...a: unknown[]) => logs.push(a.join(' '));
  console.error = (...a: unknown[]) => errs.push(a.join(' '));
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  rmSync(home, { recursive: true, force: true });
});

function writeExe(name: string): { path: string; sha: string } {
  const dir = join(home, '.agents', 'skills', 'fake', 'hooks');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(path, 0o755);
  return { path, sha: createHash('sha256').update(readFileSync(path)).digest('hex') };
}

function writeDescriptor(id: string, cmd: string): void {
  const dir = toolHooksDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.pre-send-photo.json`),
    JSON.stringify({ id, point: 'pre-send-photo', cmd, on_error: 'open' }),
  );
}

test('non-hooks argv returns null (falls through to send)', () => {
  expect(runHooksCli(['hello world'], home, NO_GUARD)).toBeNull();
});

test('hooks list (guard OFF) shows a descriptor as trusted-by-default', () => {
  const { path } = writeExe('h.sh');
  writeDescriptor('review-visual', path);
  const code = runHooksCli(['hooks', 'list'], home, NO_GUARD);
  expect(code).toBe(0);
  expect(logs.join('\n')).toContain('review-visual');
  expect(logs.join('\n')).toContain('trusted (default)');
  expect(logs.join('\n')).toContain('trust-by-default');
});

test('hooks list (guard ON) shows an untrusted descriptor as quarantined', () => {
  const { path } = writeExe('h.sh');
  writeDescriptor('review-visual', path);
  const code = runHooksCli(['hooks', 'list'], home, GUARD);
  expect(code).toBe(0);
  expect(logs.join('\n')).toContain('review-visual');
  expect(logs.join('\n')).toContain('untrusted');
});

test('hooks list on an empty dir says so', () => {
  const code = runHooksCli(['hooks', 'list'], home, NO_GUARD);
  expect(code).toBe(0);
  expect(logs.join('\n')).toMatch(/No tg hooks installed|empty/);
});

test('hooks trust (guard OFF) is a friendly no-op, writes no trust.json', () => {
  const { path } = writeExe('h.sh');
  writeDescriptor('review-visual', path);
  const code = runHooksCli(['hooks', 'trust', 'review-visual'], home, NO_GUARD);
  expect(code).toBe(0);
  expect(logs.join('\n')).toContain('already runs (trust-by-default)');
  expect(existsSync(trustFile(home))).toBe(false);
});

test('hooks trust (guard ON) pins the descriptor sha into trust.json (0600)', () => {
  const { path, sha } = writeExe('h.sh');
  writeDescriptor('review-visual', path);
  const code = runHooksCli(['hooks', 'trust', 'review-visual'], home, GUARD);
  expect(code).toBe(0);
  const trust = JSON.parse(readFileSync(trustFile(home), 'utf8'));
  expect(trust['review-visual.pre-send-photo'].cmd_sha256).toBe(sha);
  expect(trust['review-visual.pre-send-photo'].on_error).toBe('open');
});

test('hooks trust (guard ON) with on_error override', () => {
  const { path } = writeExe('h.sh');
  writeDescriptor('review-visual', path);
  runHooksCli(['hooks', 'trust', 'review-visual', 'closed'], home, GUARD);
  const trust = JSON.parse(readFileSync(trustFile(home), 'utf8'));
  expect(trust['review-visual.pre-send-photo'].on_error).toBe('closed');
});

test('hooks trust with an INVALID policy arg errors (no silent default), even guard OFF', () => {
  const { path } = writeExe('h.sh');
  writeDescriptor('review-visual', path);
  const code = runHooksCli(['hooks', 'trust', 'review-visual', 'close'], home, NO_GUARD);
  expect(code).toBe(1);
  expect(errs.join('\n')).toContain("Invalid on_error 'close'");
});

test('hooks trust (guard ON) on an unknown id errors (exit 1)', () => {
  const code = runHooksCli(['hooks', 'trust', 'nope'], home, GUARD);
  expect(code).toBe(1);
  expect(errs.join('\n')).toContain('nope');
});

test('hooks trust without an id errors', () => {
  const code = runHooksCli(['hooks', 'trust'], home, NO_GUARD);
  expect(code).toBe(1);
});

test('after trust (guard ON) then list (guard ON) shows trusted', () => {
  const { path } = writeExe('h.sh');
  writeDescriptor('review-visual', path);
  runHooksCli(['hooks', 'trust', 'review-visual'], home, GUARD);
  logs.length = 0;
  runHooksCli(['hooks', 'list'], home, GUARD);
  expect(logs.join('\n')).toContain('trusted (on_error=open)');
});

test('hooks untrust removes the pin (re-quarantine)', () => {
  const { path } = writeExe('h.sh');
  writeDescriptor('review-visual', path);
  runHooksCli(['hooks', 'trust', 'review-visual'], home, GUARD);
  const code = runHooksCli(['hooks', 'untrust', 'review-visual'], home, NO_GUARD);
  expect(code).toBe(0);
  const trust = JSON.parse(readFileSync(trustFile(home), 'utf8'));
  expect(trust['review-visual.pre-send-photo']).toBeUndefined();
});

test('untrust matches the id EXACTLY (does not remove a dotted sibling)', () => {
  // Two hooks: id "review" and id "review.visual". `untrust review` must only
  // remove "review.<point>", never "review.visual.<point>".
  const a = writeExe('a.sh');
  const b = writeExe('b.sh');
  const dir = toolHooksDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'review.pre-send-photo.json'),
    JSON.stringify({ id: 'review', point: 'pre-send-photo', cmd: a.path, on_error: 'open' }),
  );
  writeFileSync(
    join(dir, 'review.visual.pre-send-photo.json'),
    JSON.stringify({ id: 'review.visual', point: 'pre-send-photo', cmd: b.path, on_error: 'open' }),
  );
  runHooksCli(['hooks', 'trust', 'review'], home, GUARD);
  runHooksCli(['hooks', 'trust', 'review.visual'], home, GUARD);
  const code = runHooksCli(['hooks', 'untrust', 'review'], home, NO_GUARD);
  expect(code).toBe(0);
  const trust = JSON.parse(readFileSync(trustFile(home), 'utf8'));
  expect(trust['review.pre-send-photo']).toBeUndefined();
  // the dotted sibling MUST survive
  expect(trust['review.visual.pre-send-photo']).toBeDefined();
});

test('unknown subcommand returns null (falls through to send — never steals a message)', () => {
  // `tg hooks frobnicate` is NOT a hooks command — it is an ordinary message that
  // starts with the word "hooks". It must fall through to the send path (null),
  // not be intercepted with a usage error, or `tg hooks are flaky` regresses.
  const code = runHooksCli(['hooks', 'frobnicate'], home, NO_GUARD);
  expect(code).toBeNull();
  expect(errs.join('\n')).toBe('');
});

test('multi-word message starting with "hooks" falls through to send (HYP regression)', () => {
  // The reported P1: `tg hooks are flaky` previously sent a message; the hooks
  // dispatcher must not swallow it. Only list/trust/untrust (and bare `tg hooks`)
  // are real subcommands.
  expect(runHooksCli(['hooks', 'are', 'flaky'], home, NO_GUARD)).toBeNull();
  expect(runHooksCli(['hooks', 'is', 'down'], home, GUARD)).toBeNull();
});

test('bare `tg hooks` still lists (discoverability), does not fall through', () => {
  const code = runHooksCli(['hooks'], home, NO_GUARD);
  expect(code).toBe(0);
});

// --- AGENTS_HOOKS_TRUST=auto: list reports the real (running) state -----------

test('hooks list under AGENTS_HOOKS_TRUST=auto reports trusted (auto), not quarantined', () => {
  const { path } = writeExe('h.sh');
  writeDescriptor('review-visual', path);
  const AUTO = { AGENTS_HOOKS_TRUST: 'auto' } as NodeJS.ProcessEnv;
  const code = runHooksCli(['hooks', 'list'], home, AUTO);
  expect(code).toBe(0);
  const out = logs.join('\n');
  expect(out).toContain('trusted (auto)');
  expect(out).not.toContain('quarantined');
});

test('hooks list tolerates a non-normalized AGENTS_HOOKS_TRUST value (` AUTO `)', () => {
  const { path } = writeExe('h.sh');
  writeDescriptor('review-visual', path);
  const AUTO = { AGENTS_HOOKS_TRUST: ' AUTO ' } as NodeJS.ProcessEnv;
  const code = runHooksCli(['hooks', 'list'], home, AUTO);
  expect(code).toBe(0);
  // guard is active (normalized) AND auto is recognized → trusted (auto), not quarantined.
  expect(logs.join('\n')).toContain('trusted (auto)');
});
