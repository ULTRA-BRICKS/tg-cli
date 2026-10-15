import { expect, test } from 'bun:test';
import {
  parseFeatureConfig,
  resolveFeatures,
  applyFeatureFlags,
  DEFAULT_FEATURES,
} from '../features/auto-attach/feature-flags';

// --- config.yaml parsing (tiny hand-rolled parser, no yaml dep) ---
test('parseFeatureConfig reads features.<name> booleans', () => {
  const yaml = `features:\n  md-as-pdf: true\n  other: false\n`;
  expect(parseFeatureConfig(yaml)).toEqual({ 'md-as-pdf': true, other: false });
});

test('parseFeatureConfig tolerates blank/comment lines and missing block', () => {
  expect(parseFeatureConfig('')).toEqual({});
  expect(parseFeatureConfig('# just a comment\n')).toEqual({});
  expect(parseFeatureConfig('features:\n  # c\n  md-as-pdf: false\n')).toEqual({
    'md-as-pdf': false,
  });
});

test('parseFeatureConfig accepts yes/no/on/off/1/0', () => {
  const yaml = `features:\n  a: yes\n  b: no\n  c: on\n  d: off\n  e: 1\n  f: 0\n`;
  expect(parseFeatureConfig(yaml)).toEqual({
    a: true,
    b: false,
    c: true,
    d: false,
    e: true,
    f: false,
  });
});

// --- defaults ---
test('md-as-pdf defaults ON when config is empty', () => {
  const r = resolveFeatures({}, { enable: [], disable: [] });
  expect(r['md-as-pdf']).toBe(true);
});

// tg-cli#648: attaching files named in the message text is gone, not a
// default-ON (or default-OFF) toggle.
test('DEFAULT_FEATURES has no text-path attach feature', () => {
  expect('auto-attach' in DEFAULT_FEATURES).toBe(false);
  expect('recursive-attach' in DEFAULT_FEATURES).toBe(false);
});

test('DEFAULT_FEATURES has cjk-guard true (guard is ON by default)', () => {
  expect(DEFAULT_FEATURES['cjk-guard']).toBe(true);
});

test('DEFAULT_FEATURES has screenshot-guard true (guard is ON by default)', () => {
  expect(DEFAULT_FEATURES['screenshot-guard']).toBe(true);
});

test('DEFAULT_FEATURES has file-mention-guard true (guard is ON by default)', () => {
  expect(DEFAULT_FEATURES['file-mention-guard']).toBe(true);
});

// --- config overrides default ---
test('config can disable md-as-pdf', () => {
  const r = resolveFeatures({ 'md-as-pdf': false }, { enable: [], disable: [] });
  expect(r['md-as-pdf']).toBe(false);
});

// --- CLI flags override config ---
test('--feature overrides config-disabled back ON', () => {
  const r = resolveFeatures({ 'md-as-pdf': false }, { enable: ['md-as-pdf'], disable: [] });
  expect(r['md-as-pdf']).toBe(true);
});

test('--no-feature overrides config/default OFF', () => {
  const r = resolveFeatures({}, { enable: [], disable: ['md-as-pdf'] });
  expect(r['md-as-pdf']).toBe(false);
});

// --- applyFeatureFlags strips --feature/--no-feature from argv, collects names ---
test('applyFeatureFlags extracts --feature/--no-feature and returns remaining args', () => {
  const r = applyFeatureFlags(['--feature', 'md-as-pdf', 'hi', '--no-feature', 'x']);
  expect(r.enable).toEqual(['md-as-pdf']);
  expect(r.disable).toEqual(['x']);
  expect(r.rest).toEqual(['hi']);
});

test('applyFeatureFlags with a missing value reports an error', () => {
  const r = applyFeatureFlags(['--feature']);
  expect(r.error).toBeTruthy();
});

test('applyFeatureFlags leaves other flags untouched', () => {
  const r = applyFeatureFlags(['--format', 'html', 'msg']);
  expect(r.enable).toEqual([]);
  expect(r.disable).toEqual([]);
  expect(r.rest).toEqual(['--format', 'html', 'msg']);
  expect(r.error).toBeUndefined();
});
