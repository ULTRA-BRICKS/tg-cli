import { afterEach, describe, expect, test } from 'bun:test';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CAPABILITIES, ownerOnlyAnswerAllowed, parseGenericAskArgv } from '../features/tg-ctl/generic-ask';
import { normalizeButtonRequest } from '../tg-ctl';
import { parseQuestionStore, serializeQuestionStore } from '../features/tg-ctl/question-store';
import { stepUpdates, type StepOpts } from '../features/tg-ctl/updates';
import { DEFAULT_CONTROL, type TgUpdate } from '../features/tg-ctl/types';
import { tempDir } from './helpers/test-temp';

const CTL = join(import.meta.dir, '..', 'tg-ctl');
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function setup(chatId: string | null) {
  const home = tempDir('ctl-oo-home-');
  const cfg = tempDir('ctl-oo-cfg-');
  if (chatId !== null) writeFileSync(join(cfg, '.env'), `TG_BOT_TOKEN=123:fake\nTG_CHAT_ID=${chatId}\n`);
  let requests = 0;
  const server = Bun.serve({ port: 0, fetch() { requests++; return Response.json({ ok: true, result: [] }); } });
  cleanups.push(() => { server.stop(true); });
  return { home, cfg, base: `http://127.0.0.1:${server.port}`, count: () => requests };
}

async function run(args: string[], s: ReturnType<typeof setup>) {
  const p = Bun.spawn(['bun', CTL, ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: s.home, TG_CTL_CONFIG_DIR: s.cfg, TG_API_BASE: s.base },
    stdout: 'pipe', stderr: 'pipe',
  });
  const timer = setTimeout(() => p.kill(), 15000);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { out, err, code };
}

describe('tg-ctl capabilities', () => {
  test('--json prints markers with no config, network or files', async () => {
    const s = setup(null);
    const before = readdirSync(s.cfg).sort();
    const r = await run(['capabilities', '--json'], s);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.schema_version).toBe(1);
    expect(j.capabilities).toContain('ask-owner-only-v1');
    expect(s.count()).toBe(0);
    expect(readdirSync(s.cfg).sort()).toEqual(before);
  });
  test('without --json is a usage error', async () => {
    const s = setup(null);
    expect((await run(['capabilities'], s)).code).toBe(2);
    expect((await run(['capabilities', '--json', 'x'], s)).code).toBe(2);
    expect(s.count()).toBe(0);
  });
});

describe('tg-ctl ask --owner-only CLI', () => {
  for (const args of [['--owner-only'], ['--owner-only', '--timeout', '5'], ['--owner-only', '--help'], ['--owner-only', '-h'], ['--help', '--owner-only']]) {
    test(`ask ${args.join(' ')} → usage exit 2, no requests`, async () => {
      const s = setup('1000');
      const r = await run(['ask', ...args], s);
      expect(r.code).toBe(2);
      expect(r.err).toContain('usage: tg-ctl ask --owner-only');
      expect(s.count()).toBe(0);
    });
  }
  for (const chat of ['-100123', 'abc']) {
    test(`TG_CHAT_ID=${chat} → denied exit 1, no requests`, async () => {
      const s = setup(chat);
      const r = await run(['ask', '--owner-only', 'deploy?', '--timeout', '5'], s);
      expect(r.code).toBe(1);
      expect(r.err).toContain('denied');
      expect(s.count()).toBe(0);
    });
  }
  test('plain ask --help still exits 0', async () => {
    const s = setup('1000');
    expect((await run(['ask', '--help'], s)).code).toBe(0);
  });
});

describe('parse + predicate', () => {
  test('parseGenericAskArgv strips --owner-only', () => {
    expect(parseGenericAskArgv(['--owner-only', 'deploy', '--timeout', '9'])).toMatchObject({ question: 'deploy', ownerOnly: true });
    expect(parseGenericAskArgv(['deploy'])).toMatchObject({ question: 'deploy', ownerOnly: false });
  });
  test('ownerOnlyAnswerAllowed matrix', () => {
    expect(CAPABILITIES).toContain('ask-owner-only-v1');
    expect(ownerOnlyAnswerAllowed(1000, { userId: 1000, chatId: 1000 })).toBe(true);
    expect(ownerOnlyAnswerAllowed(1000, { userId: 2000, chatId: 1000 })).toBe(false);
    expect(ownerOnlyAnswerAllowed(1000, { userId: 1000, chatId: 2000 })).toBe(false);
    expect(ownerOnlyAnswerAllowed(1000, { userId: null, chatId: 1000 })).toBe(false);
    expect(ownerOnlyAnswerAllowed(1000, undefined)).toBe(false);
    expect(ownerOnlyAnswerAllowed(-100, { userId: -100, chatId: -100 })).toBe(false);
  });
});

describe('ownerOnly persistence', () => {
  const base = { requestId: 'r1', agent: 'claude', kind: 'permission', question: 'q', cwd: '/tmp' };
  test('normalizeButtonRequest keeps only a literal true', () => {
    expect(normalizeButtonRequest({ ...base, ownerOnly: true })?.ownerOnly).toBe(true);
    expect(normalizeButtonRequest({ ...base, ownerOnly: 'yes' })?.ownerOnly).toBeUndefined();
    expect(normalizeButtonRequest(base)?.ownerOnly).toBeUndefined();
  });
  test('survives the disk round trip (serialize → parse → normalize)', () => {
    const req = normalizeButtonRequest({ ...base, ownerOnly: true })!;
    const raw = serializeQuestionStore({ questions: [{ req: { ...req }, messageId: 5, at: Date.now() }], answered: [] });
    const back = parseQuestionStore(raw, Date.now(), 60_000, 60_000);
    expect(normalizeButtonRequest(back.questions[0]!.req)?.ownerOnly).toBe(true);
  });
});

const OWNER = 1000;
const NOW = 1_750_000_000;
const opts = (over: Partial<StepOpts> = {}): StepOpts => ({ cfg: { ...DEFAULT_CONTROL, allowedSenders: [2000] }, chatId: OWNER, nowSec: NOW, currentOffset: 1, wrap: (n, m) => `[${n}] ${m}`, ...over });
const msg = (text: string, from = OWNER, chat = OWNER, extra: object = {}): TgUpdate =>
  ({ update_id: 2, message: { message_id: 2, from: { id: from, first_name: 'X' }, chat: { id: chat }, date: NOW, text, ...extra } }) as TgUpdate;
const cb = (data: string, from: number, chat: number): TgUpdate =>
  ({ update_id: 3, callback_query: { id: 'c1', from: { id: from, first_name: 'X' }, data, message: { message_id: 9, chat: { id: chat }, date: NOW } } }) as TgUpdate;

describe('stepUpdates owner enforcement', () => {
  test('/chatgpt: other allowlisted sender dropped, owner ok, group owner id dropped', () => {
    expect(stepUpdates([msg('/chatgpt', 2000)], opts()).actions).toEqual([]);
    expect(stepUpdates([msg('/chatgpt@MyBot home', 2000)], opts()).actions).toEqual([]);
    expect(stepUpdates([msg('/chatgpt')], opts()).actions[0]).toMatchObject({ kind: 'chatgpt-menu' });
    expect(stepUpdates([msg('/chatgpt', -100, -100)], opts({ chatId: -100, cfg: { ...DEFAULT_CONTROL, allowedSenders: [-100] } })).actions).toEqual([]);
  });
  test('cgp: callback only from owner in owner chat', () => {
    const ref = 'cgp:AAAAAAAAAAAAAAAAAAAAAA';
    expect(stepUpdates([cb(ref, 2000, OWNER)], opts()).actions).toEqual([{ kind: 'answer-callback', callbackQueryId: 'c1', text: 'not allowed' }]);
    expect(stepUpdates([cb(ref, OWNER, OWNER)], opts()).actions[0]).toMatchObject({ kind: 'chatgpt-callback' });
  });
  test('answer-question carries the actor from a callback', () => {
    const r = stepUpdates([cb('tgq:q_1:o1', 2000, OWNER)], opts());
    expect(r.actions[0]).toMatchObject({ kind: 'answer-question', actor: { userId: 2000, chatId: OWNER } });
  });
  test('answer-question from a reply to a decision card carries the actor', () => {
    const r = stepUpdates([cb('tgq:q_1:o1', OWNER, 555)], opts());
    expect(r.actions[0]).toMatchObject({ actor: { userId: OWNER, chatId: 555 } });
  });
});
