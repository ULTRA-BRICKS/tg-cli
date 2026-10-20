// tests/report-attachments.test.ts — `tg report --photo/--file` end to end (tg-cli#775).
// The REAL `tg` binary against a mock Bot API: a structured report that cites a screenshot
// must be sendable with the image attached, and --dry-run must validate (not refuse) attachments.
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tempDir } from './helpers/test-temp';

const TG_SCRIPT = join(import.meta.dir, '..', 'tg');

let calls: string[];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const method = new URL(req.url).pathname.split('/').pop() ?? '';
    if (['sendMessage', 'sendRichMessage', 'sendPhoto', 'sendDocument', 'sendMediaGroup'].includes(method)) {
      calls.push(method);
      return Response.json({ ok: true, result: { message_id: calls.length } });
    }
    return Response.json({ ok: false, description: `unexpected: ${method}` }, { status: 404 });
  },
});

const dirs: string[] = [];
afterAll(() => {
  server.stop(true);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function makeHome(): string {
  const home = tempDir('tg-report-attach-');
  dirs.push(home);
  const cfg = join(home, '.config', 'tg-cli');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  return home;
}

function reportArgs(extra: string[], impact = 'the screenshot shows the fixed dialog'): string[] {
  return [
    'report',
    '--title', 'Dialog fixed',
    '--ticket', 'https://example.com/issues/1',
    '--impact', impact,
    '--verify-cmd', 'bun test',
    '--verify-result', 'all green',
    ...extra,
  ];
}

async function run(home: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', TG_SCRIPT, ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: home, TG_API_BASE: `http://127.0.0.1:${server.port}` },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode: await proc.exited, stdout, stderr };
}

function writePng(home: string, name = 'shot.png'): string {
  const p = join(home, name);
  writeFileSync(p, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  return p;
}

test('a report that cites a screenshot is sent with the photo attached (guard satisfied)', async () => {
  calls = [];
  const home = makeHome();
  const { exitCode, stderr } = await run(home, reportArgs(['--photo', writePng(home)]));
  expect(stderr).not.toContain('mentions a screenshot');
  expect(exitCode).toBe(0);
  expect(calls).toContain('sendPhoto');
  expect(calls).toContain('sendRichMessage');
});

test('the same report without --photo is still refused by the screenshot guard', async () => {
  calls = [];
  const home = makeHome();
  const { exitCode, stderr } = await run(home, reportArgs([]));
  expect(exitCode).toBe(1);
  expect(stderr).toContain('screenshot');
  // the hint names the report form, not only the plain `tg --photo`
  expect(stderr).toContain('tg report --photo <path>');
  expect(calls).toHaveLength(0);
});

test('a --photo that does not exist does not satisfy the guard', async () => {
  calls = [];
  const home = makeHome();
  const { exitCode, stderr } = await run(home, reportArgs(['--photo', join(home, 'missing.png')]));
  expect(exitCode).toBe(1);
  expect(stderr).toContain('screenshot');
  expect(calls).toHaveLength(0);
});

test('--file attaches a document with the report', async () => {
  calls = [];
  const home = makeHome();
  const log = join(home, 'run.log');
  writeFileSync(log, 'all green\n');
  const { exitCode } = await run(home, reportArgs(['--file', log], 'users stop seeing the crash'));
  expect(exitCode).toBe(0);
  expect(calls).toContain('sendDocument');
  expect(calls).toContain('sendRichMessage');
});

test('a --file on the never-attach denylist is an error and nothing is sent', async () => {
  calls = [];
  const home = makeHome();
  const secret = join(home, '.env');
  writeFileSync(secret, 'TOKEN=x\n');
  const { exitCode, stderr } = await run(home, reportArgs(['--file', secret], 'users stop seeing the crash'));
  expect(exitCode).not.toBe(0);
  expect(stderr.toLowerCase()).toContain('denylist');
  expect(calls).toHaveLength(0);
});

test('a missing --file is skipped with a warning and the report text still goes out', async () => {
  calls = [];
  const home = makeHome();
  const { exitCode, stderr } = await run(
    home,
    reportArgs(['--file', join(home, 'gone.log')], 'users stop seeing the crash'),
  );
  expect(exitCode).toBe(0);
  expect(stderr).toContain('skipping attachment');
  expect(calls).toEqual(['sendRichMessage']);
});

test('tg report --dry-run --photo validates the attachment, succeeds and sends nothing', async () => {
  calls = [];
  const home = makeHome();
  const { exitCode, stdout } = await run(home, reportArgs(['--dry-run', '--photo', writePng(home)]));
  expect(exitCode).toBe(0);
  expect(stdout).toContain('tg --dry-run: OK');
  expect(stdout).toContain('attachments (not uploaded)');
  expect(stdout).toContain('photo');
  expect(calls).toHaveLength(0);
});

test('--dry-run reports a missing attachment as one that would be skipped', async () => {
  calls = [];
  const home = makeHome();
  const { exitCode, stdout } = await run(
    home,
    reportArgs(['--dry-run', '--file', join(home, 'gone.log')], 'users stop seeing the crash'),
  );
  expect(exitCode).toBe(0);
  expect(stdout).toContain('would be skipped');
  expect(stdout).toContain('file not found');
  expect(calls).toHaveLength(0);
});
