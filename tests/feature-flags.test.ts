import { expect, test } from 'bun:test';
import {
  parseFeatureConfig,
  resolveFeatures,
  applyFeatureFlags,
  DEFAULT_FEATURES,
} from '../features/auto-attach/feature-flags';

// --- config.yaml parsing (tiny hand-rolled parser, no yaml dep) ---
test('parseFeatureConfig reads features.<name> booleans', () => {
  const yaml = `features:\n  auto-attach: true\n  other: false\n`;
  expect(parseFeatureConfig(yaml)).toEqual({ 'auto-attach': true, other: false });
});

test('parseFeatureConfig tolerates blank/comment lines and missing block', () => {
  expect(parseFeatureConfig('')).toEqual({});
  expect(parseFeatureConfig('# just a comment\n')).toEqual({});
  expect(parseFeatureConfig('features:\n  # c\n  auto-attach: false\n')).toEqual({
    'auto-attach': false,
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

// --- default ON ---
test('auto-attach defaults ON when config is empty', () => {
  const r = resolveFeatures({}, { enable: [], disable: [] });
  expect(r['auto-attach']).toBe(true);
});

test('DEFAULT_FEATURES has auto-attach true', () => {
  expect(DEFAULT_FEATURES['auto-attach']).toBe(true);
});

test('DEFAULT_FEATURES has cjk-guard true (guard is ON by default)', () => {
  expect(DEFAULT_FEATURES['cjk-guard']).toBe(true);
});

test('DEFAULT_FEATURES has screenshot-guard true (guard is ON by default)', () => {
  expect(DEFAULT_FEATURES['screenshot-guard']).toBe(true);
});

// --- config overrides default ---
test('config can disable auto-attach', () => {
  const r = resolveFeatures({ 'auto-attach': false }, { enable: [], disable: [] });
  expect(r['auto-attach']).toBe(false);
});

// --- CLI flags override config ---
test('--feature overrides config-disabled back ON', () => {
  const r = resolveFeatures({ 'auto-attach': false }, { enable: ['auto-attach'], disable: [] });
  expect(r['auto-attach']).toBe(true);
});

test('--no-feature overrides config/default OFF', () => {
  const r = resolveFeatures({}, { enable: [], disable: ['auto-attach'] });
  expect(r['auto-attach']).toBe(false);
});

// --- applyFeatureFlags strips --feature/--no-feature from argv, collects names ---
test('applyFeatureFlags extracts --feature/--no-feature and returns remaining args', () => {
  const r = applyFeatureFlags(['--feature', 'auto-attach', 'hi', '--no-feature', 'x']);
  expect(r.enable).toEqual(['auto-attach']);
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
