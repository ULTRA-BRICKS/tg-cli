import { expect, test } from 'bun:test';
import { validateConfigWithLaya, withoutLayaBlock } from '../features/config/validate-laya';

test('the laya block is blanked line for line, everything else stays', () => {
  const raw = 'control:\n  enabled: true\nlaya:\n  autostart: perhaps\n  # note\n  bogus: 1\nvoice:\n  enabled: false\n';
  expect(withoutLayaBlock(raw)).toBe('control:\n  enabled: true\n\n\n\n\nvoice:\n  enabled: false\n');
  expect(withoutLayaBlock('laya: true\ncontrol:\n  enabled: true\n')).toBe('\ncontrol:\n  enabled: true\n');
});

test('laya entries are not judged by the generic validator; the caller diagnostics are merged by line', () => {
  const raw = 'laya:\n  warm_timeout_ms: soon\ncontrol:\n  enabled: maybe\n';
  const caller = [{ line: 2, severity: 'error' as const, message: 'laya.warm_timeout_ms must be a positive integer' }];
  expect(validateConfigWithLaya(raw, caller).map((d) => `${d.line}:${d.message}`)).toEqual([
    '2:laya.warm_timeout_ms must be a positive integer',
    '4:control.enabled must be true or false (got "maybe")',
  ]);
});

test('the top-level hints name laya as a fourth section', () => {
  expect(validateConfigWithLaya('extra: 1\n', []).map((d) => d.message)).toEqual([
    'extra is not a known top-level key (expected control, voice, features or laya)',
  ]);
  expect(validateConfigWithLaya('just words\n', []).map((d) => d.message)).toEqual([
    'top level must be a mapping of control, voice, features and laya blocks',
  ]);
});
