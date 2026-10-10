import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tempDir } from './helpers/test-temp';

// tg-cli#114 AC3: a `tg --tag answer --reply-to <id>` send flips the reaction on
// message <id> to the done mark (👌). Runs the REAL `tg` binary against a mock
// Bot API and asserts the wire-level setMessageReaction — and that a non-answer
// send (or an answer without a reply target) sets NO reaction.

const TG_SCRIPT = join(import.meta.dir, '..', 'tg');

let reactions: Array<Record<string, unknown>>;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/sendMessage')) {
      await req.json();
      return Response.json({ ok: true, result: { message_id: 1 } });
    }
    if (url.pathname.endsWith('/setMessageReaction')) {
      reactions.push(await req.json());
      return Response.json({ ok: true, result: true });
    }
    return Response.json({ ok: true, result: {} });
  },
});

const dirs: string[] = [];
afterAll(() => {
  server.stop(true);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function makeHome(): string {
  const home = tempDir('tg-answer-home-');
  dirs.push(home);
  const cfg = join(home, '.config', 'tg-cli');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  return home;
}

async function runSend(args: string[]): Promise<number> {
  const home = makeHome();
  const proc = Bun.spawn(['bun', TG_SCRIPT, ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: home, TG_API_BASE: `http://127.0.0.1:${server.port}` },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  await new Response(proc.stderr).text();
  return await proc.exited;
}

test('--tag answer --reply-to <id> flips message <id> to the done mark 👌', async () => {
  reactions = [];
  const code = await runSend(['--tag', 'answer', '--reply-to', '4321', 'here is the answer']);
  expect(code).toBe(0);
  expect(reactions).toHaveLength(1);
  expect(reactions[0]).toMatchObject({
    chat_id: '1', // tg sends CHAT_ID as the raw env string; Telegram accepts either
    message_id: 4321,
    reaction: [{ type: 'emoji', emoji: '👌' }],
  });
});

test('a non-answer tag with --reply-to sets NO reaction', async () => {
  reactions = [];
  const code = await runSend(['--tag', 'report', '--reply-to', '4321', 'just a report']);
  expect(code).toBe(0);
  expect(reactions).toHaveLength(0);
});

test('a plain message (no tag, no reply target) sets NO reaction', async () => {
  reactions = [];
  // The CLI rejects `--tag answer` without `--reply-to` (answer requires a
  // target), so the replyToMessageId==null branch is unreachable here — it is
  // covered by the doneReactionForSend unit test. This checks the everyday path.
  const code = await runSend(['plain message']);
  expect(code).toBe(0);
  expect(reactions).toHaveLength(0);
});
