// The pre-send-text sibling of tests/hooks-photo-integration.test.ts: exercises
// the generic hook-firing mechanics (non-breaking guard, allow/block, trust-
// by-default, fail-open) for run-text-hooks.ts's gateText/runPreSendTextHooks,
// using a fake bash hook.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { gateText, runPreSendTextHooks } from '../features/hooks/run-text-hooks';
import { hooksActive, toolHooksDir } from '../features/hooks/run-photo-hooks';
import { tempDir } from './helpers/test-temp';

let home: string;

beforeEach(() => {
  home = tempDir('tg-text-hooks-home-');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function hooksDir(): string {
  const d = toolHooksDir(home);
  mkdirSync(d, { recursive: true });
  return d;
}

function writeHookScript(name: string, body: string): string {
  const skillDir = join(home, '.agents', 'skills', 'fake', 'hooks');
  mkdirSync(skillDir, { recursive: true });
  const path = join(skillDir, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function writeDescriptor(file: string, obj: Record<string, unknown>): void {
  writeFileSync(join(hooksDir(), file), JSON.stringify(obj, null, 2));
}

test('hooksActive gates the point exactly like pre-send-photo (shared guard)', () => {
  expect(hooksActive({}, home)).toBe(false);
  hooksDir();
  expect(hooksActive({}, home)).toBe(true);
});

test('no descriptors for pre-send-text → not blocked, no hooks run', () => {
  hooksDir();
  const v = runPreSendTextHooks({ body: 'hello' }, {}, home);
  expect(v.blocked).toBe(false);
  expect(v.results.length).toBe(0);
});

test('a pre-send-PHOTO descriptor is NOT picked up by the text point (points are isolated)', () => {
  const cmd = writeHookScript('photo-only.sh', 'echo \'{"decision":"block"}\'; exit 10');
  writeDescriptor('photo-only.pre-send-photo.json', { id: 'photo-only', point: 'pre-send-photo', cmd });
  const v = runPreSendTextHooks({ body: 'hello' }, {}, home);
  expect(v.blocked).toBe(false);
  expect(v.results.length).toBe(0);
});

test('trusted-by-default text hook exiting 0 → send proceeds', () => {
  const cmd = writeHookScript('ok.sh', 'echo \'{"decision":"allow"}\'; exit 0');
  writeDescriptor('ok.pre-send-text.json', { id: 'ok', point: 'pre-send-text', cmd });
  const v = runPreSendTextHooks({ body: 'hello', tag: 'report' }, {}, home);
  expect(v.blocked).toBe(false);
  expect(v.results[0].decision).toBe('allow');
});

test('trusted-by-default text hook exiting 10 → gateText reports blocked with the message', () => {
  const cmd = writeHookScript('block.sh', 'echo \'{"message":"policy violation"}\'; exit 10');
  writeDescriptor('block.pre-send-text.json', { id: 'block', point: 'pre-send-text', cmd });
  const result = gateText('hello', { tag: 'decision' }, {}, home);
  expect(result.blocked).toBe(true);
  expect(result.message).toContain('policy violation');
});

test('a crashing hook with on_error open fails open (send proceeds)', () => {
  const cmd = writeHookScript('crash.sh', 'echo "boom" >&2; exit 1');
  writeDescriptor('crash.pre-send-text.json', { id: 'crash', point: 'pre-send-text', cmd, on_error: 'open' });
  const v = runPreSendTextHooks({ body: 'hello' }, {}, home);
  expect(v.blocked).toBe(false);
  expect(v.results[0].errored).toBe(true);
});

test('gateText skips an empty/whitespace-only body — nothing for a hook to inspect', () => {
  const cmd = writeHookScript('block.sh', 'exit 10');
  writeDescriptor('block.pre-send-text.json', { id: 'block', point: 'pre-send-text', cmd });
  expect(gateText('', { tag: 'decision' }, {}, home).blocked).toBe(false);
  expect(gateText('   ', { tag: 'decision' }, {}, home).blocked).toBe(false);
});

test('the event handed to the hook carries body/tag/chat_id (not the old image_path shape)', () => {
  const argsFile = join(home, 'event-args.json');
  const cmd = writeHookScript('capture.sh', `cat > '${argsFile}'\necho '{"decision":"allow"}'\nexit 0`);
  writeDescriptor('capture.pre-send-text.json', { id: 'capture', point: 'pre-send-text', cmd });
  const v = runPreSendTextHooks({ body: 'the body text', tag: 'decision', chatId: '999' }, {}, home);
  expect(v.blocked).toBe(false);
  const event = JSON.parse(readFileSync(argsFile, 'utf8'));
  expect(event.point).toBe('pre-send-text');
  expect(event.args).toEqual({ body: 'the body text', tag: 'decision', chat_id: '999' });
});
