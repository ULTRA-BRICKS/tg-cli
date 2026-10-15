// The intent gate end to end through the real `tg` (tg-cli#706): an agent sender (TG_AI_MODEL
// set) against a mock Bot API. A blocked body never reaches the API; a follow-up body is sent
// and its obligation recorded; a reply under it settles it; `tg obligations` reports and
// checks; a sender with no agent identity is not gated.
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tempDir } from './helpers/test-temp';

const TG = join(import.meta.dir, '..', 'tg');
const fixture = (name: string): string => readFileSync(join(import.meta.dir, 'fixtures', 'intent-gate', name), 'utf8');

let nextId = 600;
let sent: Array<Record<string, unknown>> = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/sendMessage') || url.pathname.endsWith('/sendRichMessage')) {
      sent.push((await req.json()) as Record<string, unknown>);
      nextId += 1;
      return Response.json({ ok: true, result: { message_id: nextId } });
    }
    return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
  },
});
afterAll(() => server.stop(true));

function makeHome(): string {
  const home = tempDir('tg-intent-gate-');
  const cfg = join(home, '.config', 'tg-cli');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  return home;
}

async function tg(home: string, args: string[], agent = true): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(['bun', TG, ...args], {
    cwd: home,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
      TMUX: '',
      TG_LAYA: '0',
      TG_AI_EMOJI: 'bot',
      ...(agent ? { TG_AI_MODEL: 'claude' } : {}),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

test('fixture 1 — an untagged prose decision is BLOCKED (exit 1) and nothing reaches Telegram', async () => {
  sent = [];
  const home = makeHome();
  const r = await tg(home, [fixture('malformed-decision.txt')]);
  expect(r.code).toBe(1);
  expect(r.err).toContain('intent gate: BLOCKED');
  expect(r.err).toContain('ask: «Решай, оставлять его или закрыть.»');
  expect(r.err).toContain('Glossary');
  expect(sent).toHaveLength(0);
});

test('fixture 2 — a report with a question is SENT, the follow-up recorded, and a decision reply settles it', async () => {
  sent = [];
  const home = makeHome();
  const r = await tg(home, [fixture('report-with-question.txt')]);
  expect(r.code).toBe(0);
  const id = Number(/^OK tg#(\d+)/m.exec(r.out)?.[1]);
  expect(sent).toHaveLength(1);
  expect(r.err).toContain('FOLLOW-UP REQUIRED');
  expect(r.err).toContain(`tg --reply-to ${id} --tag decision --format html`);

  const owed = await tg(home, ['obligations', '--check']);
  expect(owed.code).toBe(1);
  expect(owed.out).toContain(`${id}.1  [decision] «Кстати, что делать с #566`);

  const reply = await tg(home, ['--reply-to', String(id), '--tag', 'decision', '--format', 'html', fixture('well-formed-decision.html')]);
  expect(reply.code).toBe(0);
  expect(reply.err).toContain(`follow-up settled under tg#${id}`);
  const after = await tg(home, ['obligations', '--check']);
  expect(after.code).toBe(0);
  expect(after.out).toContain('No follow-ups owed.');
});

test('fixture 3 — a well-formed decision passes and sends', async () => {
  sent = [];
  const home = makeHome();
  const r = await tg(home, ['--tag', 'decision', '--format', 'html', fixture('well-formed-decision.html')]);
  expect(r.code).toBe(0);
  expect(r.err).not.toContain('intent gate');
  expect(sent).toHaveLength(1);
});

test('--dry-run shows the three verdicts without sending or recording anything', async () => {
  sent = [];
  const home = makeHome();
  const block = await tg(home, ['--dry-run', fixture('malformed-decision.txt')]);
  expect(block.code).toBe(1);
  const followUp = await tg(home, ['--dry-run', fixture('report-with-question.txt')]);
  expect(followUp.code).toBe(0);
  expect(followUp.out).toContain('FOLLOW-UP REQUIRED (1 item(s)');
  const pass = await tg(home, ['--dry-run', '--tag', 'decision', '--format', 'html', fixture('well-formed-decision.html')]);
  expect(pass.code).toBe(0);
  expect(pass.out).toContain('message is well-formed');
  expect(sent).toHaveLength(0);
  expect((await tg(home, ['obligations'])).out).toContain('No follow-ups owed.');
});

test('two concurrent replies under a message owing two decisions settle both, never the same one twice', async () => {
  const home = makeHome();
  const twoAsks = 'Готово: смержил #690, тесты зелёные. Включать private_topics по умолчанию? Удалять ветку hotfix?';
  const first = await tg(home, [twoAsks]);
  const id = Number(/^OK tg#(\d+)/m.exec(first.out)?.[1]);
  expect((await tg(home, ['obligations', '--json'])).out).toContain(`"${id}.2"`);
  const reply = ['--reply-to', String(id), '--tag', 'decision', '--format', 'html', fixture('well-formed-decision.html')];
  const [a, b] = await Promise.all([tg(home, reply), tg(home, reply)]);
  expect([a.code, b.code]).toEqual([0, 0]);
  const after = await tg(home, ['obligations', '--check']);
  expect(after.out).toContain('No follow-ups owed.');
  expect(after.code).toBe(0);
});

test('a dismiss racing a reply under one message closes two different items', async () => {
  const home = makeHome();
  const first = await tg(home, ['Готово: смержил #690, тесты зелёные. Включать private_topics по умолчанию? Удалять ветку hotfix?'])
  const id = Number(/^OK tg#(\d+)/m.exec(first.out)?.[1]);
  const reply = ['--reply-to', String(id), '--tag', 'decision', '--format', 'html', fixture('well-formed-decision.html')];
  const [dismissed, replied] = await Promise.all([
    tg(home, ['obligations', 'dismiss', `${id}.1`, '--reason', 'answered in person']),
    tg(home, reply),
  ]);
  expect([dismissed.code, replied.code]).toEqual([0, 0]);
  const after = await tg(home, ['obligations', '--check']);
  expect(after.out).toContain('No follow-ups owed.');
});

test('a dismissed follow-up stops being owed; the sender is reminded of an open one on the next send', async () => {
  const home = makeHome();
  const first = await tg(home, [fixture('report-with-question.txt')]);
  const id = Number(/^OK tg#(\d+)/m.exec(first.out)?.[1]);
  const next = await tg(home, ['ок, принял, начинаю следующую задачу']);
  expect(next.err).toContain('1 earlier follow-up(s) still owed');
  expect((await tg(home, ['obligations', 'dismiss', `${id}.1`, '--reason', 'asked in person'])).code).toBe(0);
  expect((await tg(home, ['obligations', '--check'])).code).toBe(0);
});

test('a sender with no agent identity (a cron job) is not gated', async () => {
  sent = [];
  const home = makeHome();
  const r = await tg(home, [fixture('malformed-decision.txt')], false);
  expect(r.code).toBe(0);
  expect(r.err).not.toContain('intent gate');
  expect(sent).toHaveLength(1);
});

test('--automated skips the report format; ESCALATION_GATE_ENFORCE=0 downgrades a block to a warning', async () => {
  sent = [];
  const home = makeHome();
  expect((await tg(home, ['Готово, задеплоил.'])).code).toBe(1);
  expect((await tg(home, ['--automated', '--tag', 'report', 'Готово, задеплоил.'])).code).toBe(0);
  const proc = Bun.spawn(['bun', TG, fixture('malformed-decision.txt')], {
    cwd: home,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
      TMUX: '',
      TG_LAYA: '0',
      TG_AI_MODEL: 'claude',
      ESCALATION_GATE_ENFORCE: '0',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const err = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(0);
  expect(err).toContain('advisory; sending anyway');
});
