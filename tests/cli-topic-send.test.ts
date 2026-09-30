import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// End-to-end forum-topics OUTBOUND threading (docs/specs/tg-forum-topics.md §8,
// increment 2): run the REAL `tg` binary against a mock Bot-API server
// (TG_API_BASE) and assert the wire-level sendMessage carries (or omits)
// message_thread_id. This is the agent's own `tg` reply path — the piece that
// makes a bound topic actually thread the agent's output back instead of
// scattering it to General.
//
// The load-bearing guarantees:
//   1. `tg --topic <id>` → sendMessage with message_thread_id = <id>.
//   2. TG_TOPIC env → same, when --topic is absent (the daemon can stamp the
//      pane env so the agent need not pass the flag — increment-4 hook-up).
//   3. An explicit --topic WINS over TG_TOPIC.
//   4. REGRESSION: no --topic and no TG_TOPIC → NO message_thread_id on the wire
//      (the daily-critical 1:1 path stays byte-identical).

const TG_SCRIPT = join(import.meta.dir, '..', 'tg');

// Every sendMessage body the mock saw, in order.
let sent: Array<Record<string, unknown>>;
// Every multipart send the mock saw, as { method, threadId } — for the --photo path.
let multipart: Array<{ method: string; threadId: string | null }>;
// When true, the mock REJECTS any send carrying a thread id (mimicking a stale /
// closed TG_TOPIC) and accepts the retry without it — to exercise the advisory
// fallback through the real binary.
let rejectThread = false;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/sendMessage')) {
      const body = (await req.json()) as Record<string, unknown>;
      sent.push(body);
      if (rejectThread && 'message_thread_id' in body) {
        // The real Telegram shape: HTTP 400 with { ok:false, description }.
        return Response.json({ ok: false, description: 'Bad Request: message thread not found' }, { status: 400 });
      }
      return Response.json({ ok: true, result: { message_id: 1 } });
    }
    if (url.pathname.endsWith('/sendPhoto') || url.pathname.endsWith('/sendDocument')) {
      const form = await req.formData();
      const threadId = form.get('message_thread_id') as string | null;
      multipart.push({ method: url.pathname.split('/').pop() ?? '', threadId });
      if (rejectThread && threadId !== null) {
        // The advisory fallback resends the upload without the thread.
        return Response.json({ ok: false, description: 'Bad Request: message thread not found' }, { status: 400 });
      }
      return Response.json({ ok: true, result: { message_id: 1 } });
    }
    return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
  },
});

const dirs: string[] = [];
afterAll(() => {
  server.stop(true);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// A throwaway HOME with a tg-cli config holding fake creds, so `tg` clears its
// credential gate and actually hits our mock. The auto-attach worktree scan and
// the ctl auto-start are both inert here (no TMUX, no MODEL).
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'tg-topic-home-'));
  dirs.push(home);
  const cfg = join(home, '.config', 'tg-cli');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  return home;
}

// MUST be async (Bun.spawn, not spawnSync): the mock Bot-API server runs on this
// same process's event loop, so a synchronous spawn would block the loop and
// deadlock — `tg`'s sendMessage would never get a response. Awaiting Bun.spawn
// keeps the loop free to serve the request.
async function runSend(
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ exitCode: number; stderr: string }> {
  const home = makeHome();
  const proc = Bun.spawn(['bun', TG_SCRIPT, ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
      ...extraEnv,
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stderr };
}

test('`tg --topic 7` posts sendMessage with message_thread_id = 7', async () => {
  sent = [];
  const { exitCode } = await runSend(['--topic', '7', 'status update']);
  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  expect(sent[0].message_thread_id).toBe(7);
  expect(sent[0].text).toContain('status update');
});

test('TG_TOPIC env threads the send when --topic is absent', async () => {
  sent = [];
  const { exitCode } = await runSend(['env-routed message'], { TG_TOPIC: '42' });
  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  expect(sent[0].message_thread_id).toBe(42);
});

test('an explicit --topic WINS over TG_TOPIC', async () => {
  sent = [];
  const { exitCode } = await runSend(['--topic', '7', 'flag wins'], { TG_TOPIC: '42' });
  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  expect(sent[0].message_thread_id).toBe(7);
});

test('a malformed TG_TOPIC is IGNORED (posts to General), the send still succeeds', async () => {
  sent = [];
  const { exitCode, stderr } = await runSend(['bad env'], { TG_TOPIC: 'not-a-number' });
  // Non-fatal: the message still goes (to General), and stderr warns.
  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  expect('message_thread_id' in sent[0]).toBe(false);
  expect(stderr).toContain('TG_TOPIC');
});

test('REGRESSION: no --topic and no TG_TOPIC → NO message_thread_id (1:1 path byte-identical)', async () => {
  sent = [];
  const { exitCode } = await runSend(['plain 1:1 message']);
  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  expect('message_thread_id' in sent[0]).toBe(false);
});

test('--topic carries message_thread_id on the multipart --photo path too (end-to-end)', async () => {
  multipart = [];
  // A throwaway PNG to attach.
  const home = makeHome();
  const img = join(home, 'shot.png');
  writeFileSync(img, 'PNGDATA');
  const proc = Bun.spawn(['bun', TG_SCRIPT, '--topic', '7', '--photo', img, 'cap'], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(0);
  const photo = multipart.find((m) => m.method === 'sendPhoto');
  expect(photo?.threadId).toBe('7');
});

test('a --photo with a STALE TG_TOPIC falls back to General like a text send (multipart advisory fallback)', async () => {
  multipart = [];
  rejectThread = true;
  try {
    const home = makeHome();
    const img = join(home, 'shot.png');
    writeFileSync(img, 'PNGDATA');
    const proc = Bun.spawn(['bun', TG_SCRIPT, '--photo', img, 'cap'], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        TG_API_BASE: `http://127.0.0.1:${server.port}`,
        TG_TOPIC: '88', // stale, server rejects it
      },
      stdout: 'ignore',
      stderr: 'pipe',
    });
    await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    expect(multipart.filter((m) => m.method === 'sendPhoto').map((m) => m.threadId)).toEqual(['88', null]);
  } finally {
    rejectThread = false;
  }
});

test('a numeric-but-STALE TG_TOPIC (server rejects the thread) falls back to General — send still succeeds', async () => {
  sent = [];
  rejectThread = true;
  try {
    // 88 is well-formed (passes the regex) but the "server" rejects the thread —
    // the env path is ADVISORY, so the send must retry to General, not hard-fail.
    const { exitCode, stderr } = await runSend(['agent reply'], { TG_TOPIC: '88' });
    expect(exitCode).toBe(0);
    // Two POSTs: the rejected thread send, then the General retry.
    expect(sent).toHaveLength(2);
    expect(sent[0].message_thread_id).toBe(88);
    expect('message_thread_id' in sent[1]).toBe(false);
    expect(stderr).toContain('resending to General');
  } finally {
    rejectThread = false;
  }
});

test('an EXPLICIT --topic that the server rejects FAILS (no silent General retry)', async () => {
  sent = [];
  rejectThread = true;
  try {
    const { exitCode } = await runSend(['--topic', '88', 'explicit must not silently retry']);
    // Strict path: the send fails (checkResponse exits non-zero); exactly one POST.
    expect(exitCode).not.toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].message_thread_id).toBe(88);
  } finally {
    rejectThread = false;
  }
});
