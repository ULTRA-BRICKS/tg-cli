import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseArgs } from '../features/cli/args';
import { tempDir } from './helpers/test-temp';

// Two simulated worktree roots. The mentioned file exists ONLY in `feature`.
// `parseArgs` is invoked with cwd == main; without worktree-aware resolution
// the relative path can't resolve under cwd → no attach. With it, the file is
// found in the feature worktree.
let main: string;
let feature: string;
const HOME = '/home/tester';
const REL = 'docs/specs/x.md';

beforeAll(() => {
  main = tempDir('tg-wt-main-');
  feature = tempDir('tg-wt-feat-');
  mkdirSync(join(feature, 'docs', 'specs'), { recursive: true });
  writeFileSync(join(feature, REL), '# spec body');
});

afterAll(() => {
  rmSync(main, { recursive: true, force: true });
  rmSync(feature, { recursive: true, force: true });
});

// cwd == main worktree; file lives only in the feature worktree. The thunk
// reports both roots in priority order. Worktree-aware resolution attaches it.
test('relative path present only in feature worktree resolves from main (auto-attach ON)', () => {
  const result = parseArgs(['look at', REL], main, HOME, true, () => [main, feature]);
  expect(result.action).toBe('send');
  if (result.action !== 'send') return;
  expect(result.items).toHaveLength(1);
  expect(result.items[0].path).toBe(join(feature, REL));
  // CORE CORRECTION: the path token stays in the caption verbatim.
  expect(result.caption).toContain(REL);
});

// Reverse direction: cwd == feature, file only in main → still resolves when
// main is in the root list.
test('relative path present only in main resolves from a sibling worktree', () => {
  // cwd is an EMPTY sibling worktree (no REL under it); the file lives only in
  // `onlyMain`. Plain cwd resolution fails → worktree fallback finds it in main.
  const cwdWt = tempDir('tg-wt-cwd-');
  const onlyMain = tempDir('tg-wt-onlymain-');
  mkdirSync(join(onlyMain, 'docs', 'specs'), { recursive: true });
  writeFileSync(join(onlyMain, REL), '# main spec');
  try {
    const result = parseArgs(['see', REL], cwdWt, HOME, true, () => [cwdWt, onlyMain]);
    expect(result.action).toBe('send');
    if (result.action !== 'send') return;
    expect(result.items[0].path).toBe(join(onlyMain, REL));
  } finally {
    rmSync(cwdWt, { recursive: true, force: true });
    rmSync(onlyMain, { recursive: true, force: true });
  }
});

// Flag OFF → no scan at all, worktree resolver never consulted.
test('auto-attach OFF → no attach even with a worktree resolver', () => {
  const result = parseArgs(['look at', REL], main, HOME, false, () => [main, feature]);
  expect(result.action).toBe('send');
  if (result.action !== 'send') return;
  expect(result.items).toHaveLength(0);
});

// The path-like gate: an ordinary prose word that doesn't exist anywhere must
// not even trigger the resolver (and certainly not resolve).
test('non-path-like prose word does not resolve via worktrees', () => {
  let called = 0;
  const result = parseArgs(['justwords', 'here'], main, HOME, true, () => {
    called++;
    return [main, feature];
  });
  expect(result.action).toBe('send');
  if (result.action !== 'send') return;
  expect(result.items).toHaveLength(0);
  // Resolver thunk never invoked for plain prose (perf gate).
  expect(called).toBe(0);
});

// Dedup + line-spec adoption across worktrees: the same cross-worktree file
// mentioned twice — second time with a :line spec — must attach ONCE and adopt
// the spec (regression guard for the dedup re-resolve consistency).
test('cross-worktree file mentioned twice with a line-spec → one attach, spec adopted', () => {
  const result = parseArgs(['first', REL, 'then', `${REL}:1`], main, HOME, true, () => [main, feature]);
  expect(result.action).toBe('send');
  if (result.action !== 'send') return;
  expect(result.items).toHaveLength(1);
  expect(result.items[0].path).toBe(join(feature, REL));
  expect(result.items[0].lineSpec).toBeDefined();
  expect(result.items[0].lineSpec?.startLine).toBe(1);
});

// ..-traversal must not escape a worktree root even with a resolver present.
test('..-traversal token does not resolve across worktrees', () => {
  const result = parseArgs(['evil', '../escape.md'], main, HOME, true, () => [main, feature]);
  expect(result.action).toBe('send');
  if (result.action !== 'send') return;
  expect(result.items).toHaveLength(0);
});
