import { expect, test } from 'bun:test';
import { join } from 'path';
import { tempDir } from './helpers/test-temp';

const TG_SCRIPT = join(import.meta.dir, '..', 'tg');
const ENV = { PATH: process.env.PATH ?? '', HOME: tempDir('tg-stdin-body-home-') };

function run(args: string[], stdin: string) {
  const p = Bun.spawnSync(['bun', TG_SCRIPT, ...args], { env: ENV, stdin: new TextEncoder().encode(stdin) });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

test('`-` reads the body from stdin', () => {
  const r = run(['--dry-run', '-'], 'hello-stdin');
  expect(r.out).toContain('hello-stdin');
});

test('implicit stdin body when no argv body', () => {
  const r = run(['--dry-run'], 'hello-implicit');
  expect(r.out).toContain('hello-implicit');
});

test('argv text wins; stdin ignored', () => {
  const r = run(['--dry-run', 'argv text'], 'from-stdin-ignored');
  expect(r.out).toContain('argv text');
  expect(r.out).not.toContain('from-stdin-ignored');
});

test('empty stdin does not invent a body', () => {
  const r = run(['--dry-run'], '');
  expect(r.out).not.toContain('undefined');
  expect(r.out).toContain('Usage:');
});

test('a list body with dashed lines is text via `-`', () => {
  const r = run(['--dry-run', '-'], '- a\n- b');
  expect(r.code).toBe(0);
  expect(r.out).toContain('- a');
  expect(r.out).toContain('- b');
});

test('a list body with dashed lines is text via implicit stdin', () => {
  const r = run(['--dry-run'], '- a\n- b');
  expect(r.code).toBe(0);
  expect(r.out).toContain('- a');
  expect(r.out).toContain('- b');
});

test('a body starting with --tag is text, not a flag', () => {
  const r = run(['--dry-run', '-'], '--tag report is literal');
  expect(r.code).toBe(0);
  expect(r.out).toContain('--tag report is literal');
  const implicit = run(['--dry-run'], '-- x');
  expect(implicit.code).toBe(0);
  expect(implicit.out).toContain('-- x');
});

test('whitespace-only stdin via `-` invents no body', () => {
  const r = run(['--dry-run', '-'], ' \n');
  expect(r.out).toContain('Usage:');
});

test('multi-line body keeps its line breaks', () => {
  const r = run(['--dry-run', '-'], '- a\n- b');
  expect(r.out).toContain('- a\n- b');
});

// Pins current behaviour (not a design statement): the first `-` is dropped from argv wherever it
// sits, and the stdin body is appended AFTER every argv text part — `tg "Header" -` and
// `tg - "Header"` both send "Header <body>".
test.each([
  ['after the argv text', ['Header', '-']],
  ['before the argv text', ['-', 'Header']],
])('`-` %s: the stdin body is appended last', (_where, argv) => {
  const r = run(['--dry-run', ...argv], 'piped-body');
  expect(r.code).toBe(0);
  expect(r.out).toContain('Header piped-body');
});

test('a second `-` is not a second stdin read: it is an unknown flag', () => {
  const r = run(['--dry-run', '-', '-'], 'piped-body');
  expect(r.code).toBe(1);
  expect(r.out).toContain('unknown flag: -');
});
