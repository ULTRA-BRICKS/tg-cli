import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { formatSendOk } from '../features/cli/send-output';
import { tempDir } from './helpers/test-temp';

test('formatSendOk keeps OK first and appends reusable tg# refs', () => {
  expect(formatSendOk([])).toBe('OK');
  expect(formatSendOk([123])).toBe('OK tg#123');
  expect(formatSendOk([123, 124, 126])).toBe('OK tg#123 tg#124 tg#126');
});

test('formatSendOk ignores invalid ids without dropping returned repeats', () => {
  expect(formatSendOk([0, 9, 9, -1, 10.5, 10])).toBe('OK tg#9 tg#9 tg#10');
});

const TG_SCRIPT = join(import.meta.dir, '..', 'tg');

type ServerMode = 'ok' | 'fail-first' | 'fail-second';
let mode: ServerMode = 'ok';
let sentMessages = 0;
let sentRich = 0;
let sentAlbums = 0;
let sentSingleMedia = 0;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/sendMessage')) {
      sentMessages += 1;
      if (mode === 'fail-first' || (mode === 'fail-second' && sentMessages === 2)) {
        return Response.json({ ok: false, description: 'forced failure' }, { status: 400 });
      }
      return Response.json({ ok: true, result: { message_id: 7000 + sentMessages } });
    }
    if (url.pathname.endsWith('/sendRichMessage')) {
      sentRich += 1;
      return Response.json({ ok: true, result: { message_id: 7500 + sentRich } });
    }
    if (url.pathname.endsWith('/sendMediaGroup')) {
      sentAlbums += 1;
      const form = await req.formData();
      const mediaRaw = form.get('media');
      const count = typeof mediaRaw === 'string' ? (JSON.parse(mediaRaw) as unknown[]).length : 0;
      return Response.json({
        ok: true,
        result: Array.from({ length: count }, (_v, i) => ({ message_id: 9000 + sentAlbums * 10 + i })),
      });
    }
    if (url.pathname.endsWith('/sendPhoto') || url.pathname.endsWith('/sendDocument')) {
      sentSingleMedia += 1;
      return Response.json({ ok: true, result: { message_id: 8000 + sentSingleMedia } });
    }
    return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
  },
});

const dirs: string[] = [];
afterAll(() => {
  server.stop(true);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function makeHome(): string {
  const home = tempDir('tg-send-output-');
  dirs.push(home);
  const cfg = join(home, '.config', 'tg-cli');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  return home;
}

async function runSend(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const home = makeHome();
  const proc = Bun.spawn(['bun', TG_SCRIPT, ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
      TMUX: '',
      TG_AI_MODEL: 'unknown-model',
      TG_AI_EMOJI: 'bot',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout: await stdoutPromise, stderr: await stderrPromise };
}

function resetServer(nextMode: ServerMode = 'ok'): void {
  mode = nextMode;
  sentMessages = 0;
  sentRich = 0;
  sentAlbums = 0;
  sentSingleMedia = 0;
}

test('real tg text send prints OK plus the sent message ref', async () => {
  resetServer();
  const { exitCode, stdout } = await runSend(['status']);
  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe('OK tg#7001');
});

test('real tg split text send prints every sent message ref', async () => {
  resetServer();
  const { exitCode, stdout } = await runSend(['x'.repeat(4500)]);
  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe('OK tg#7001 tg#7002');
});

test('real tg rich send prints the returned message ref', async () => {
  resetServer();
  const { exitCode, stdout } = await runSend(['--format', 'html', '<h1>Status</h1><p>done</p>']);
  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe('OK tg#7501');
});

test('real tg media album send prints every returned album ref', async () => {
  resetServer();
  const home = makeHome();
  const a = join(home, 'a.png');
  const b = join(home, 'b.png');
  writeFileSync(a, 'PNG A');
  writeFileSync(b, 'PNG B');
  const proc = Bun.spawn(['bun', TG_SCRIPT, '--photo', a, '--photo', b, 'screens'], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
      TMUX: '',
      TG_AI_MODEL: 'unknown-model',
      TG_AI_EMOJI: 'bot',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  await stderrPromise;
  expect(exitCode).toBe(0);
  expect((await stdoutPromise).trim()).toBe('OK tg#9010 tg#9011');
});

test('real tg single media sends print their returned refs', async () => {
  resetServer();
  const home = makeHome();
  const photo = join(home, 'single.png');
  const doc = join(home, 'report.txt');
  writeFileSync(photo, 'PNG');
  writeFileSync(doc, 'report');

  const photoRun = await runSend(['--photo', photo, 'single photo']);
  expect(photoRun.exitCode).toBe(0);
  expect(photoRun.stdout.trim()).toBe('OK tg#8001');

  const docRun = await runSend(['--file', doc, 'single document']);
  expect(docRun.exitCode).toBe(0);
  expect(docRun.stdout.trim()).toBe('OK tg#8002');
});

test('real tg mixed media sends print refs in send order', async () => {
  resetServer();
  const home = makeHome();
  const photo = join(home, 'mixed.png');
  const doc = join(home, 'mixed.txt');
  writeFileSync(photo, 'PNG');
  writeFileSync(doc, 'document');

  const proc = Bun.spawn(['bun', TG_SCRIPT, '--photo', photo, '--file', doc, 'mixed send'], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
      TMUX: '',
      TG_AI_MODEL: 'unknown-model',
      TG_AI_EMOJI: 'bot',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  await stderrPromise;
  expect(exitCode).toBe(0);
  expect((await stdoutPromise).trim()).toBe('OK tg#8001 tg#8002');
});

test('failed sends do not print fake refs, even after an earlier chunk succeeded', async () => {
  resetServer('fail-second');
  const { exitCode, stdout, stderr } = await runSend(['x'.repeat(4500)]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain('forced failure');
  expect(stdout).not.toContain('tg#');
  expect(stdout.trim()).toBe('');
});

test('failed first sends do not print refs or OK', async () => {
  resetServer('fail-first');
  const { exitCode, stdout, stderr } = await runSend(['status']);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain('forced failure');
  expect(stdout).not.toContain('OK');
  expect(stdout).not.toContain('tg#');
  expect(stdout.trim()).toBe('');
});
