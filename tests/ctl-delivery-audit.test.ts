// Tests for `tg-ctl audit-delivery` (tg-cli#299): the pure core (features/tg-ctl/delivery-audit.ts)
// — what counts as a delivery or a duplicate in a harness transcript, and how history, ledger,
// transcripts and the daemon log combine into the report — and the command's transcript scan.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { buildAuditReport, logDeliveryIds, transcriptCopies, type AuditInput } from '../features/tg-ctl/delivery-audit';
import type { HistoryRecord } from '../features/replies/history';
import { tempDir } from './helpers/test-temp';

const CHAT = 5;

function ompPrompt(id: string, text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'message', id, timestamp: '2026-09-21T21:28:29.987Z', message: { role: 'user', content: [{ type: 'text', text }], ...extra } });
}

function ccPrompt(uuid: string, content: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'user', uuid, timestamp: '2026-08-19T15:07:31.000Z', message: { role: 'user', content }, ...extra });
}

function row(msg: number, text: string, ts = 1_790_000_000 + msg): HistoryRecord {
  return { ts, message_id: msg, chat_id: CHAT, direction: 'user', from: 'Alex', text, pane: '%1', targetAgent: 'rig' };
}

function input(over: Partial<AuditInput>): AuditInput {
  return { chatId: CHAT, history: [], ledger: [], copies: [], logAttempts: new Set(), sinceSec: null, untilSec: null, ...over };
}

describe('transcriptCopies', () => {
  test('one message typed into one session several times is several copies in that file', () => {
    const wrap = '↩ tg#900000 «[2026-09-21 23:01] …»\n[TG from Alex tg#900001] merge it locally';
    const raw = [ompPrompt('a', wrap), ompPrompt('b', wrap), ompPrompt('c', wrap)].join('\n');
    const copies = transcriptCopies(raw, 's.jsonl');
    expect(copies.map((c) => [c.msg, c.recordId, c.mirror])).toEqual([
      [900001, 'a', false],
      [900001, 'b', false],
      [900001, 'c', false],
    ]);
  });

  test('the wrap counts only at the start of a prompt (under an anchor or banner line)', () => {
    const raw = [
      ccPrompt('u1', 'Review this diff:\n+  "[TG from Alex tg#900002] fixture"'),
      ccPrompt('u2', '⚠ This pane is currently on branch x (not main/master, tree clean). Commit first.\n[TG from Alex tg#900003] go'),
      ccPrompt('u3', [{ type: 'tool_result', content: '[TG from Alex tg#900004] echoed' }]),
      ccPrompt('u4', '[TG from Alex tg#900005] summary', { isCompactSummary: true }),
    ].join('\n');
    expect(transcriptCopies(raw, 'cc.jsonl').map((c) => c.msg)).toEqual([900003]);
  });

  test('an advisor mirror and a post-compaction re-submit prove delivery but are not new copies', () => {
    const mirror = ompPrompt('m', '### Session update\n\n**user**:\n[TG from Alex tg#900006] hi\n\n**assistant**:\nok', { synthetic: true });
    expect(transcriptCopies(mirror, '/s/__advisor.default.jsonl').map((c) => [c.msg, c.mirror])).toEqual([[900006, true]]);

    const cc = [
      ccPrompt('u1', '[TG from Alex tg#900007] check the style'),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' }),
      ccPrompt('u2', '[TG from Alex tg#900007] check the style'),
      ccPrompt('u3', '[TG from Alex tg#900007] check the style'),
    ].join('\n');
    expect(transcriptCopies(cc, 'cc.jsonl').map((c) => c.mirror)).toEqual([false, true, false]);
  });

  test('a wrap without an id keeps its body for matching', () => {
    expect(transcriptCopies(ccPrompt('u', '[TG from Alex] какой статус?'), 'cc.jsonl').map((c) => [c.msg, c.body])).toEqual([[null, 'какой статус?']]);
  });

  test('a Claude prompt queued while the agent was busy is one delivery, its enqueue only evidence', () => {
    const text = '↩ tg#900020 «[2026-08-17 04:38] …»\n[TG from Alex tg#900021] решай сам';
    const raw = [
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: 't', content: text }),
      JSON.stringify({ type: 'queue-operation', operation: 'remove', timestamp: 't', content: text }),
      JSON.stringify({ type: 'attachment', uuid: 'q1', isSidechain: false, attachment: { type: 'queued_command', prompt: text } }),
      JSON.stringify({ type: 'attachment', uuid: 'q2', isSidechain: true, attachment: { type: 'queued_command', prompt: '[TG from Alex tg#900022] x' } }),
    ].join('\n');
    expect(transcriptCopies(raw, 'cc.jsonl').map((c) => [c.msg, c.recordId, c.mirror])).toEqual([
      [900021, 'L1', true],
      [900021, 'q1', false],
    ]);
  });
});

test('logDeliveryIds reads the ids quoted by delivery log lines', () => {
  const log = '[t] inject: target=%11 autoBind=true text="[TG from Alex tg#900010] Ответь"\n[t] reply-route: replyTo=1 → %8 msg="↩ tg#900011 «…»"';
  expect([...logDeliveryIds(log)]).toEqual([900010]);
});

describe('buildAuditReport', () => {
  test('classifies every received message by its strongest evidence', () => {
    const report = buildAuditReport(
      input({
        history: [
          row(1, 'typed, seen in a transcript'),
          row(2, 'delivered per the ledger'),
          row(3, 'sent per the log only'),
          row(4, 'nothing anywhere'),
          row(5, '/status'),
          row(6, '!ls -la'),
          row(7, '/agent rig deploy now'),
          row(8, 'failed, told the CTO'),
          row(9, 'waiting behind a question'),
          row(10, 'какой статус?'),
          row(11, 'typed, Enter lost'),
        ],
        ledger: [
          { ts: 1, event: 'delivered', chat: CHAT, msg: 2, target: '%1' },
          { ts: 1, event: 'failed', chat: CHAT, msg: 8, target: '%1', error: 'pane gone' },
          { ts: 1, event: 'queued', chat: CHAT, msg: 9, target: '%1', hold: 'deferred' },
          { ts: 1, event: 'unsubmitted', chat: CHAT, msg: 11, target: '%1' },
        ],
        copies: [
          { msg: 1, body: 'typed, seen in a transcript', file: 'a.jsonl', recordId: 'x', ts: null, mirror: false },
          { msg: null, body: 'какой статус?', file: 'b.jsonl', recordId: 'y', ts: null, mirror: false },
        ],
        logAttempts: new Set([3]),
      }),
    );
    expect(report.received).toBe(11);
    expect(report.delivered).toBe(3); // 1 transcript, 2 ledger, 10 id-less body match
    expect(report.unconfirmed.map((m) => m.msg)).toEqual([3]);
    // No evidence either way is not a loss; only the ledger's recorded failures are.
    expect(report.unverified.map((m) => m.msg)).toEqual([4, 7]);
    expect(report.undelivered.map((m) => [m.msg, m.reason])).toEqual([
      [8, 'failed, CTO notified: pane gone'],
      [11, 'typed into the pane but never submitted, CTO notified'],
    ]);
    expect(report.pending.map((m) => [m.msg, m.hold])).toEqual([[9, 'deferred']]);
    expect(report.notForDelivery).toBe(2);
  });

  test('reports a message typed more than once into one session, but not a mirror of it', () => {
    const copy = { msg: 1, body: 'x', ts: null };
    const report = buildAuditReport(
      input({
        history: [row(1, 'x')],
        copies: [
          { ...copy, file: 's.jsonl', recordId: 'a', mirror: false },
          { ...copy, file: 's.jsonl', recordId: 'b', mirror: false },
          { ...copy, file: 's.jsonl', recordId: 'b', mirror: false },
          { ...copy, file: '__advisor.jsonl', recordId: 'c', mirror: true },
          { ...copy, file: '__advisor.jsonl', recordId: 'd', mirror: true },
          { ...copy, file: 'other.jsonl', recordId: 'e', mirror: false },
        ],
      }),
    );
    expect(report.duplicated.map((d) => [d.msg, d.copies, d.file])).toEqual([[1, 2, 's.jsonl']]);
    expect(report.delivered).toBe(1);
  });

  test('reports update ids the daemon never received, with the dates around the gap', () => {
    const report = buildAuditReport(
      input({
        ledger: [
          { ts: 1, event: 'received', chat: CHAT, msg: 20, update: 100, date: 1_790_000_000 },
          { ts: 2, event: 'received', chat: CHAT, msg: 21, update: 101, date: 1_790_000_060 },
          { ts: 3, event: 'received', chat: CHAT, msg: 25, update: 105, date: 1_790_000_600 },
          { ts: 3, event: 'delivered', chat: CHAT, msg: 20, target: '%1' },
          { ts: 3, event: 'delivered', chat: CHAT, msg: 21, target: '%1' },
          { ts: 3, event: 'delivered', chat: CHAT, msg: 25, target: '%1' },
        ],
      }),
    );
    expect(report.updateGaps).toEqual([{ from: 102, to: 104, count: 3, afterDate: 1_790_000_060, beforeDate: 1_790_000_600 }]);
    expect(report.received).toBe(3);
    expect(report.delivered).toBe(3);
  });

  test('--since/--until bound the window and other chats are ignored', () => {
    const report = buildAuditReport(
      input({
        history: [row(1, 'old', 100), row(2, 'in', 200), row(3, 'late', 300), { ...row(4, 'other chat', 200), chat_id: CHAT + 1 }],
        sinceSec: 150,
        untilSec: 250,
      }),
    );
    expect(report.received).toBe(1);
    expect(report.unverified.map((m) => m.msg)).toEqual([2]);
  });
});

// With no inbound history left (trimmed, or a fresh box) there is no window start: the scan
// must still read every transcript, or the ledger's messages all look undelivered.
test('audit-delivery reads transcripts when history holds no inbound message', () => {
  const cfgDir = tempDir('tgctl-audit-');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  const date = Math.floor(Date.now() / 1000) - 60;
  writeFileSync(join(cfgDir, 'tg-ctl.123.delivery.jsonl'), `${JSON.stringify({ ts: Date.now(), event: 'received', update: 1, date, chat: 1, msg: 42 })}\n`);
  const sessions = join(cfgDir, 'sessions');
  mkdirSync(sessions);
  const wrap = '[TG from Alex tg#42] ship it';
  writeFileSync(join(sessions, 's.jsonl'), `${[ompPrompt('a', wrap), ompPrompt('b', wrap)].join('\n')}\n`);
  const r = Bun.spawnSync(['bun', join(import.meta.dir, '..', 'tg-ctl'), 'audit-delivery', '--json', '--transcripts', sessions], {
    env: { ...process.env, HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir },
    timeout: 30_000,
  });
  expect(r.exitCode).toBe(0);
  const report = JSON.parse(r.stdout.toString()) as { duplicated: Array<{ msg: number; copies: number }> };
  expect(report.duplicated.map((d) => [d.msg, d.copies])).toEqual([[42, 2]]);
}, 40_000);
