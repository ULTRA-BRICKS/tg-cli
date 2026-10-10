import { expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join, relative } from 'path';

// tg-cli#481: Bun.spawnSync blocks its thread until the child exits — the whole send in `tg`,
// the daemon's single event loop in `tg-ctl run`. Every synchronous spawn the shipped code makes
// must therefore carry a `timeout` (features/util/spawn-timeout.ts), so a wedged child costs a
// bounded delay. This scans the two entrypoints and every non-test feature module and lists any
// Bun.spawnSync call whose options name no timeout.

const ROOT = join(import.meta.dir, '..');

function shippedSources(): string[] {
  const files = ['tg', 'tg-ctl'].map((f) => join(ROOT, f));
  for (const f of new Bun.Glob('features/**/*.ts').scanSync({ cwd: ROOT })) {
    if (!/\.test\.ts$/.test(f)) files.push(join(ROOT, f));
  }
  return files;
}

// The argument text of the call that opens at `open` (index of its `(`), by paren depth.
// String literals in these calls carry no unbalanced parens, so a plain count suffices.
function callArgs(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

test('every Bun.spawnSync in tg, tg-ctl and features/ is bounded by a timeout', () => {
  const unbounded: string[] = [];
  for (const file of shippedSources()) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/Bun\.spawnSync\(/g)) {
      const lineStart = src.lastIndexOf('\n', m.index) + 1;
      if (src.slice(lineStart, m.index).includes('//')) continue; // prose in a comment
      const args = callArgs(src, m.index + m[0].length - 1);
      if (!/\b(?:PROBE|TMUX_WRITE|ADMIN)_SPAWN\b|\btimeout\s*:/.test(args)) {
        const line = src.slice(0, m.index).split('\n').length;
        unbounded.push(`${relative(ROOT, file)}:${line}`);
      }
    }
  }
  expect(unbounded).toEqual([]);
});

// tg-cli#567: tmux calls go through ONE helper per entrypoint (tg-ctl tmuxSync, tg tmuxQuery),
// which bounds them and — in the daemon — logs a timeout with its subcommand.
test('tg-ctl and tg each spawn tmux from exactly one helper', () => {
  for (const file of ['tg', 'tg-ctl']) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    const tmuxSpawns = src.match(/Bun\.spawnSync\(\s*(?:\[\s*["'`]tmux["'`]|tmuxArgv|step\.argv)/g) ?? [];
    expect({ file, tmuxSpawns: tmuxSpawns.length }).toEqual({ file, tmuxSpawns: 1 });
  }
});
