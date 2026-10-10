import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseArgs } from '../features/cli/args';
import { tempDir } from './helpers/test-temp';

// End-to-end through parseArgs against a real temp filesystem — same pattern
// as worktree-integration.test.ts. parseArgs is invoked WITHOUT an injected
// worktree-roots thunk (default "no roots"), so recursion runs in its
// outside-a-git-repo mode with cwd as the single search root.

let root: string;
const HOME = '/home/tester';
const REL = 'docs/specs/2026-06-10-design.md';

beforeAll(() => {
  root = tempDir('tg-rec-');
  mkdirSync(join(root, 'docs', 'specs'), { recursive: true });
  writeFileSync(join(root, REL), '# spec body');
  // A same-named file buried in node_modules must never be found.
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'pkg', 'buried.md'), 'nope');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

test('bare filename mentioned in text resolves recursively and attaches', () => {
  const r = parseArgs(['see 2026-06-10-design.md please'], root, HOME);
  if (r.action !== 'send') throw new Error(`expected send, got ${r.action}`);
  expect(r.items.map((i) => i.path)).toContain(join(root, REL));
  // The token stays in the caption (never excised).
  expect(r.caption).toContain('2026-06-10-design.md');
});

test('relative suffix path resolves recursively', () => {
  const r = parseArgs(['specs/2026-06-10-design.md'], root, HOME);
  if (r.action !== 'send') throw new Error(`expected send, got ${r.action}`);
  expect(r.items.map((i) => i.path)).toContain(join(root, REL));
});

test('files under node_modules are invisible to recursion', () => {
  const r = parseArgs(['see buried.md'], root, HOME);
  if (r.action !== 'send') throw new Error(`expected send, got ${r.action}`);
  expect(r.items).toHaveLength(0);
});

test('recursion is OFF when auto-attach is OFF', () => {
  const r = parseArgs(['see 2026-06-10-design.md'], root, HOME, false);
  if (r.action !== 'send') throw new Error(`expected send, got ${r.action}`);
  expect(r.items).toHaveLength(0);
});

test('line-spec on a recursively-resolved file yields a quote anchor', () => {
  const r = parseArgs(['look 2026-06-10-design.md:1'], root, HOME);
  if (r.action !== 'send') throw new Error(`expected send, got ${r.action}`);
  expect(r.items.map((i) => i.path)).toContain(join(root, REL));
  const withSpec = r.items.find((i) => i.lineSpec);
  expect(withSpec?.lineSpec?.startLine).toBe(1);
});
