// CLI wiring for the markdown pipe-table → <table> auto-conversion in the `tg`
// entrypoint (features/render/table.ts pipeTableToHtml), exercised through
// `tg --dry-run`, which runs every local guard and the conversion, prints the
// effective format and the assembled body, and never touches the network.
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LONG_UNSTRUCTURED_MESSAGE_WARNING } from '../features/cli/message-structure';

const TG_SCRIPT = join(import.meta.dir, '..', 'tg');
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function dryRun(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const home = mkdtempSync(join(tmpdir(), 'tg-pipe-table-cli-'));
  dirs.push(home);
  const proc = Bun.spawnSync(['bun', TG_SCRIPT, '--dry-run', ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: home, TMUX: '', TG_AI_MODEL: 'unknown-model', TG_AI_EMOJI: 'bot' },
  });
  return { exitCode: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

const GRID = ['| Option | Cons |', '| --- | --- |', '| A | slow |', '| B | risky |'].join('\n');

test('a plain pipe table converts to a <table> and the send goes out as html', () => {
  const { exitCode, stdout } = dryRun([`Pick one:\n${GRID}`]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain('format=html');
  expect(stdout).toContain('<tr><th>Option</th><th>Cons</th></tr>');
});

// tg-cli#219: the long-unstructured warning must judge the CONVERTED body in
// its effective (html) format — a converted table is structure, not a wall.
test('#219: a long plain message whose pipe table was converted gets no unstructured-message warning', () => {
  const prose = Array.from({ length: 90 }, (_, i) => `detail${i}`).join(' ');
  const { exitCode, stdout, stderr } = dryRun([`${prose}\n${GRID}`]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain('format=html');
  expect(stderr).not.toContain(LONG_UNSTRUCTURED_MESSAGE_WARNING);
});

// tg-cli#210: a pipe-table EXAMPLE inside a code fence is content to show
// verbatim, not a table to convert.
test('#210: a pipe table inside a ``` fence is sent verbatim, not converted', () => {
  const body = ['Markdown example:', '```', GRID, '```'].join('\n');
  const { exitCode, stdout } = dryRun([body]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain('format=plain');
  expect(stdout).not.toContain('<table>');
  expect(stdout).toContain('| --- | --- |');
});

// tg-cli#218: an existing HTML table earlier in the body must not stop a later
// markdown grid from converting.
test('#218: a pipe table after an existing HTML table is converted; the HTML table is left alone', () => {
  const html = '<table><tr><th>Env</th><th>State</th></tr><tr><td>prod</td><td>green</td></tr></table>';
  const { exitCode, stdout } = dryRun(['--format', 'html', `${html}\nThen:\n${GRID}`]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain(html);
  expect(stdout).toContain('<tr><th>Option</th><th>Cons</th></tr>');
  expect(stdout).not.toContain('| --- | --- |');
});
