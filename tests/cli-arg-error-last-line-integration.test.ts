import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tempDir } from './helpers/test-temp';

// tg-cli#660: an argument error must END stderr with the `Error: …` line. tg
// used to print the error first and then the ~200-line USAGE (which ends with a
// blank line), so an agent running `tg … 2>&1 | tail -1` saw only a blank line —
// the refused send (here an `--tag answer` without `--reply-to`) looked like a
// silent success. Runs the REAL tg, with credentials, against a fake Bot API.

const TG_SCRIPT = join(import.meta.dir, '..', 'tg');

const apiCalls: string[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    apiCalls.push(new URL(req.url).pathname);
    return Response.json({ ok: true, result: { message_id: 1 } });
  },
});

const home = tempDir('tg-arg-error-home-');
const cfg = join(home, '.config', 'tg-cli');
mkdirSync(cfg, { recursive: true });
writeFileSync(join(cfg, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');

afterAll(() => {
  server.stop(true);
  rmSync(home, { recursive: true, force: true });
});

const ENV = { PATH: process.env.PATH ?? '', HOME: home, TG_API_BASE: `http://127.0.0.1:${server.port}` };

function lastNonEmptyLine(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  return lines[lines.length - 1] ?? '';
}

test('--tag answer without --reply-to: exits 1, sends nothing, and the error is the LAST stderr line', () => {
  apiCalls.length = 0;
  const proc = Bun.spawnSync(['bun', TG_SCRIPT, '--tag', 'answer', '--format', 'html', '<b>an answer</b>'], { env: ENV });
  expect(proc.exitCode).toBe(1);
  expect(proc.stdout.toString()).toBe('');
  expect(apiCalls).toEqual([]);
  const stderr = proc.stderr.toString();
  expect(stderr.endsWith('\n')).toBe(true);
  expect(stderr.trimEnd().split('\n').at(-1)).toStartWith('Error: --tag answer must reply to a specific message');
});

// The production repro verbatim: the agent trimmed the output with `tail -1`.
test.each([
  [['--tag', 'answer', '--format', 'html', 'x'], 'Error: --tag answer must reply to a specific message'],
  [['--bogus-flag', 'x'], 'Error: unknown flag: --bogus-flag'],
  [['--feature'], 'Error: --feature requires a feature name'],
])('`tg %p 2>&1 | tail -1` shows the Error line', (args, expected) => {
  apiCalls.length = 0;
  const quoted = args.map((a) => `'${a}'`).join(' ');
  const proc = Bun.spawnSync(['bash', '-c', `bun '${TG_SCRIPT}' ${quoted} 2>&1 | tail -1; echo "rc=\${PIPESTATUS[0]}"`], {
    env: ENV,
  });
  const out = proc.stdout.toString();
  expect(out).toContain('rc=1');
  expect(lastNonEmptyLine(out.replace(/rc=\d+\n?$/, ''))).toStartWith(expected);
  expect(apiCalls).toEqual([]);
});

test.each([
  ['\n', '\\n'],
  ['\r', '\\r'],
  ['\u2028', '\\u2028'],
  ['\u2029', '\\u2029'],
])('a line break (%j) inside an unknown flag cannot forge a line after the Error line', (sep, shown) => {
  apiCalls.length = 0;
  const proc = Bun.spawnSync(['bun', TG_SCRIPT, `--bogus${sep}FORGED`, 'x'], { env: ENV });
  expect(proc.exitCode).toBe(1);
  const last = proc.stderr.toString().trimEnd().split(/\r\n|[\n\r\u2028\u2029]/u).at(-1);
  expect(last).toBe(`Error: unknown flag: --bogus${shown}FORGED`);
  expect(apiCalls).toEqual([]);
});
