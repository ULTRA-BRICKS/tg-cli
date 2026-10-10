import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import {
  gatePhotos,
  hooksActive,
  loadDescriptors,
  runPreSendPhotoHooks,
  toolHooksDir,
  trustFile,
  auditFile,
} from '../features/hooks/run-photo-hooks';
import { invocationDigest } from '../features/hooks/types';
import { tempDir } from './helpers/test-temp';

// Each test builds an isolated fake $HOME with ~/.agents/hooks/ underneath.
let home: string;
let pngPath: string;

beforeEach(() => {
  home = tempDir('tg-hooks-home-');
  pngPath = join(home, 'shot.png');
  writeFileSync(pngPath, 'PNGDATA');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function hooksDir(): string {
  const d = toolHooksDir(home);
  mkdirSync(d, { recursive: true });
  return d;
}

// Write an executable hook script (bash) and return its absolute path + sha.
function writeHookScript(name: string, body: string): { path: string; sha: string } {
  const skillDir = join(home, '.agents', 'skills', 'fake', 'hooks');
  mkdirSync(skillDir, { recursive: true });
  const path = join(skillDir, name);
  const script = `#!/usr/bin/env bash\n${body}\n`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  const sha = createHash('sha256').update(readFileSync(path)).digest('hex');
  return { path, sha };
}

function writeDescriptor(file: string, obj: Record<string, unknown>): void {
  writeFileSync(join(hooksDir(), file), JSON.stringify(obj, null, 2));
}

function sha256Str(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// Pin a trust entry. `cmd` (the descriptor's executable path) is used to derive
// the invocation digest; pass a `cmdShaOverride` to force a mismatching cmd sha
// (the "changed executable" test). args is undefined in these tests.
function pinTrust(id: string, cmd: string, onError: 'open' | 'closed', cmdShaOverride?: string): void {
  const cmdSha = cmdShaOverride ?? createHash('sha256').update(readFileSync(cmd)).digest('hex');
  // Mirror the runner's real digest (cmd + args + timeout). These descriptors set
  // no args / no timeout_ms, so pass undefined for both — exactly what the runner
  // does for them.
  const invocationSha = sha256Str(invocationDigest(cmd, undefined, undefined));
  const t = {
    [`${id}.pre-send-photo`]: {
      cmd_sha256: cmdSha,
      invocation_sha256: invocationSha,
      point: 'pre-send-photo',
      on_error: onError,
    },
  };
  writeFileSync(trustFile(home), JSON.stringify(t, null, 2));
}

// --- the non-breaking guard ------------------------------------------------

test('hooksActive false when ~/.agents/hooks/tg/ absent', () => {
  expect(hooksActive({}, home)).toBe(false);
});

test('hooksActive true when the dir exists', () => {
  hooksDir();
  expect(hooksActive({}, home)).toBe(true);
});

test('AGENTS_HOOKS=0 hard-bypasses even with a dir present', () => {
  hooksDir();
  expect(hooksActive({ AGENTS_HOOKS: '0' }, home)).toBe(false);
});

// --- no descriptors = no block, no run -------------------------------------

test('empty hooks dir → not blocked', () => {
  hooksDir();
  const v = runPreSendPhotoHooks({ imagePath: pngPath }, {}, home);
  expect(v.blocked).toBe(false);
  expect(v.results.length).toBe(0);
});

// --- a real allowing hook (exit 0) -----------------------------------------

test('trusted hook exiting 0 → send proceeds', () => {
  const { path: cmd } = writeHookScript('ok.sh', 'echo \'{"decision":"allow"}\'; exit 0');
  writeDescriptor('ok.pre-send-photo.json', {
    id: 'ok',
    point: 'pre-send-photo',
    cmd,
  });
  pinTrust('ok', cmd, 'open');
  const v = runPreSendPhotoHooks({ imagePath: pngPath }, {}, home);
  expect(v.blocked).toBe(false);
  expect(v.results[0].quarantined).toBe(false);
  expect(v.results[0].decision).toBe('allow');
});

// --- a real blocking hook (exit 10) ----------------------------------------

test('trusted hook exiting 10 → HELD with message', () => {
  const cmd = join(home, '.agents', 'skills', 'fake', 'hooks', 'block.sh');
  writeHookScript('block.sh', 'echo \'{"message":"Unstyled render (score 0.10)"}\'; exit 10');
  writeDescriptor('block.pre-send-photo.json', { id: 'block', point: 'pre-send-photo', cmd });
  pinTrust('block', cmd, 'open');
  const v = runPreSendPhotoHooks({ imagePath: pngPath }, {}, home);
  expect(v.blocked).toBe(true);
  expect(v.blockMessage).toContain('Unstyled render');
});

// --- fail-open on a crashing hook ------------------------------------------

test('trusted hook crashing (exit 1) with on_error open → send proceeds', () => {
  const cmd = join(home, '.agents', 'skills', 'fake', 'hooks', 'crash.sh');
  writeHookScript('crash.sh', 'echo "boom" >&2; exit 1');
  writeDescriptor('crash.pre-send-photo.json', { id: 'crash', point: 'pre-send-photo', cmd, on_error: 'open' });
  pinTrust('crash', cmd, 'open');
  const v = runPreSendPhotoHooks({ imagePath: pngPath }, {}, home);
  expect(v.blocked).toBe(false);
  expect(v.results[0].errored).toBe(true);
});

// --- trust-by-default: a dropped descriptor RUNS with no pin (the common path) ---

test('untrusted (no pin) blocking hook RUNS by default → BLOCKS', () => {
  const cmd = join(home, '.agents', 'skills', 'fake', 'hooks', 'block.sh');
  writeHookScript('block.sh', 'echo \'{"message":"unstyled"}\'; exit 10');
  writeDescriptor('block.pre-send-photo.json', { id: 'block', point: 'pre-send-photo', cmd });
  // NO pinTrust — trust-by-default means it still runs.
  const v = runPreSendPhotoHooks({ imagePath: pngPath }, {}, home);
  expect(v.blocked).toBe(true);
  expect(v.results[0].quarantined).toBe(false);
  expect(v.results[0].trustState).toBe('trusted-default');
});

// --- AGENTS_HOOKS_TRUST=1 re-engages the TOFU quarantine -------------------

test('AGENTS_HOOKS_TRUST=1: untrusted (no pin) blocking hook is QUARANTINED → does NOT block', () => {
  const cmd = join(home, '.agents', 'skills', 'fake', 'hooks', 'block.sh');
  writeHookScript('block.sh', 'exit 10');
  writeDescriptor('block.pre-send-photo.json', { id: 'block', point: 'pre-send-photo', cmd });
  // guard ON + no pin → quarantined
  const v = runPreSendPhotoHooks({ imagePath: pngPath }, { AGENTS_HOOKS_TRUST: '1' }, home);
  expect(v.blocked).toBe(false);
  expect(v.results[0].quarantined).toBe(true);
});

test('AGENTS_HOOKS_TRUST=1 + a matching pin → the hook runs and blocks', () => {
  const cmd = join(home, '.agents', 'skills', 'fake', 'hooks', 'block.sh');
  writeHookScript('block.sh', 'echo \'{"message":"unstyled"}\'; exit 10');
  writeDescriptor('block.pre-send-photo.json', { id: 'block', point: 'pre-send-photo', cmd });
  pinTrust('block', cmd, 'open');
  const v = runPreSendPhotoHooks({ imagePath: pngPath }, { AGENTS_HOOKS_TRUST: '1' }, home);
  expect(v.blocked).toBe(true);
  expect(v.results[0].trustState).toBe('trusted');
});

test('AGENTS_HOOKS_TRUST=auto activates an unpinned hook (escape hatch under the guard)', () => {
  const cmd = join(home, '.agents', 'skills', 'fake', 'hooks', 'block.sh');
  writeHookScript('block.sh', 'echo \'{"message":"blocked"}\'; exit 10');
  writeDescriptor('block.pre-send-photo.json', { id: 'block', point: 'pre-send-photo', cmd });
  const v = runPreSendPhotoHooks({ imagePath: pngPath }, { AGENTS_HOOKS_TRUST: 'auto' }, home);
  expect(v.blocked).toBe(true);
});

// --- changed executable re-quarantines (only under the guard) --------------

test('AGENTS_HOOKS_TRUST=1: a pinned hook whose executable changed is re-quarantined', () => {
  const cmd = join(home, '.agents', 'skills', 'fake', 'hooks', 'block.sh');
  writeHookScript('block.sh', 'exit 10');
  writeDescriptor('block.pre-send-photo.json', { id: 'block', point: 'pre-send-photo', cmd });
  pinTrust('block', cmd, 'open', 'STALE_SHA_DOES_NOT_MATCH');
  const v = runPreSendPhotoHooks({ imagePath: pngPath }, { AGENTS_HOOKS_TRUST: '1' }, home);
  expect(v.blocked).toBe(false);
  expect(v.results[0].trustState).toBe('quarantined-changed');
});

test('AGENTS_HOOKS_TRUST=1: changing descriptor ARGS (same cmd bytes) re-quarantines — TOFU not bypassable', () => {
  // A trusted interpreter `cmd` with pinned args, then the descriptor is edited
  // to repoint args. The executable bytes are unchanged, but the invocation
  // digest differs → quarantined-changed (re-trust required). This is the
  // interpreter-args escape that pinning only cmd bytes would miss.
  const cmd = join(home, '.agents', 'skills', 'fake', 'hooks', 'block.sh');
  writeHookScript('block.sh', 'echo \'{"message":"x"}\'; exit 10');
  writeDescriptor('block.pre-send-photo.json', {
    id: 'block',
    point: 'pre-send-photo',
    cmd,
    args: ['--safe'],
  });
  // Pin with the ORIGINAL args (--safe).
  const cmdSha = createHash('sha256').update(readFileSync(cmd)).digest('hex');
  writeFileSync(
    trustFile(home),
    JSON.stringify({
      'block.pre-send-photo': {
        cmd_sha256: cmdSha,
        invocation_sha256: sha256Str(invocationDigest(cmd, ['--safe'], undefined)),
        point: 'pre-send-photo',
        on_error: 'open',
      },
    }),
  );
  // Now an attacker repoints args WITHOUT touching the executable bytes.
  writeDescriptor('block.pre-send-photo.json', {
    id: 'block',
    point: 'pre-send-photo',
    cmd,
    args: ['--evil'],
  });
  const v = runPreSendPhotoHooks({ imagePath: pngPath }, { AGENTS_HOOKS_TRUST: '1' }, home);
  expect(v.blocked).toBe(false);
  expect(v.results[0].trustState).toBe('quarantined-changed');
});

// --- audit log written -----------------------------------------------------

test('a firing writes an audit.jsonl line', () => {
  const cmd = join(home, '.agents', 'skills', 'fake', 'hooks', 'ok.sh');
  writeHookScript('ok.sh', 'exit 0');
  writeDescriptor('ok.pre-send-photo.json', { id: 'ok', point: 'pre-send-photo', cmd });
  pinTrust('ok', cmd, 'open');
  runPreSendPhotoHooks({ imagePath: pngPath }, {}, home);
  const log = readFileSync(auditFile(home), 'utf8').trim().split('\n');
  expect(log.length).toBe(1);
  const line = JSON.parse(log[0]);
  expect(line.hook_id).toBe('ok');
  expect(line.tool).toBe('tg');
  expect(line.decision).toBe('allow');
});

// --- malformed descriptor skipped (kills only itself) ----------------------

test('a malformed descriptor JSON is skipped, others still load', () => {
  writeFileSync(join(hooksDir(), 'broken.pre-send-photo.json'), '{ not json');
  const cmd = join(home, '.agents', 'skills', 'fake', 'hooks', 'ok.sh');
  writeHookScript('ok.sh', 'exit 0');
  writeDescriptor('ok.pre-send-photo.json', { id: 'ok', point: 'pre-send-photo', cmd });
  const loaded = loadDescriptors('pre-send-photo', home);
  expect(loaded.length).toBe(1);
  expect(loaded[0].descriptor.id).toBe('ok');
});

// --- gatePhotos iterates, returns first block ------------------------------

test('gatePhotos returns the first blocked photo + message', () => {
  const cmd = join(home, '.agents', 'skills', 'fake', 'hooks', 'block.sh');
  writeHookScript('block.sh', 'echo \'{"message":"nope"}\'; exit 10');
  writeDescriptor('block.pre-send-photo.json', { id: 'block', point: 'pre-send-photo', cmd });
  pinTrust('block', cmd, 'open');
  const r = gatePhotos([pngPath], {}, {}, home);
  expect(r.blocked).toBe(true);
  expect(r.blockedPath).toBe(pngPath);
  expect(r.message).toBe('nope');
});

test('gatePhotos skips a non-existent path', () => {
  const cmd = join(home, '.agents', 'skills', 'fake', 'hooks', 'block.sh');
  writeHookScript('block.sh', 'exit 10');
  writeDescriptor('block.pre-send-photo.json', { id: 'block', point: 'pre-send-photo', cmd });
  pinTrust('block', cmd, 'open');
  const r = gatePhotos([join(home, 'missing.png')], {}, {}, home);
  expect(r.blocked).toBe(false);
});

// --- timeout fail-open -----------------------------------------------------

test('a hook that overruns timeout_ms → fail-open (proceeds)', () => {
  const cmd = join(home, '.agents', 'skills', 'fake', 'hooks', 'slow.sh');
  writeHookScript('slow.sh', 'sleep 5; exit 10');
  writeDescriptor('slow.pre-send-photo.json', {
    id: 'slow',
    point: 'pre-send-photo',
    cmd,
    timeout_ms: 200,
    on_error: 'open',
  });
  pinTrust('slow', cmd, 'open');
  const v = runPreSendPhotoHooks({ imagePath: pngPath }, {}, home);
  expect(v.blocked).toBe(false);
  expect(v.results[0].errored).toBe(true);
});
