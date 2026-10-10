import { expect, test } from 'bun:test';
import { PidFacts } from '../features/tg-ctl/pid-facts';

test('PidFacts: a fact is reused until its ttl, then read again', () => {
  const facts = new PidFacts<string>(30_000);
  facts.set(42, 'omp', '/work/a', 1_000);
  expect(facts.get(42, 'omp', 1_000)).toBe('/work/a');
  expect(facts.get(42, 'omp', 30_999)).toBe('/work/a');
  expect(facts.get(42, 'omp', 31_000)).toBeUndefined();
});

test('PidFacts: a recycled pid running another command never inherits the old fact', () => {
  const facts = new PidFacts<string>(30_000);
  facts.set(42, 'omp', '/work/a', 0);
  expect(facts.get(42, 'claude', 10)).toBeUndefined();
});

test('PidFacts: retain drops every pid the process table no longer shows', () => {
  const facts = new PidFacts<string | null>(30_000);
  facts.set(1, 'omp', '/a', 0);
  facts.set(2, 'omp', null, 0);
  facts.retain(new Set([2]), 0);
  expect(facts.get(1, 'omp', 0)).toBeUndefined();
  expect(facts.get(2, 'omp', 0)).toBeNull();
});

test('PidFacts: a read that started earlier but finished later never replaces a newer fact', () => {
  // An async scan's lsof started at 1_000 and returned after a sync scan stored its fresher read.
  const facts = new PidFacts<string>(30_000);
  facts.set(42, 'omp', '/new', 2_000);
  facts.set(42, 'omp', '/old', 1_000);
  expect(facts.get(42, 'omp', 2_000)).toBe('/new');
});

test('PidFacts: retain against an older process table keeps a fact a newer read stored', () => {
  // The process started after the older table was read: that table cannot prove it gone.
  const facts = new PidFacts<string>(30_000);
  facts.set(7, 'omp', '/a', 5_000);
  facts.retain(new Set(), 4_000);
  expect(facts.get(7, 'omp', 5_000)).toBe('/a');
  facts.retain(new Set(), 5_000);
  expect(facts.get(7, 'omp', 5_000)).toBeUndefined();
});
