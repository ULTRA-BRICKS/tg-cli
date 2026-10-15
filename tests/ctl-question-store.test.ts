import { expect, test } from 'bun:test';
import {
  MAX_ANSWERED_RECORDS,
  parseQuestionStore,
  serializeQuestionStore,
  type QuestionStoreData,
} from '../features/tg-ctl/question-store';

const NOW = 1_000_000_000_000;

function scopedQuestionReq(id: string): Record<string, unknown> {
  return {
    requestId: id,
    agent: 'claude',
    kind: 'question',
    paneId: '%1',
    question: 'Where should I deploy?',
    title: 'Deploy',
    options: [{ label: 'Staging' }, { label: 'Production' }],
  };
}

test('serialize → parse round-trips questions and answered within the window', () => {
  const data: QuestionStoreData = {
    questions: [{ req: scopedQuestionReq('q1'), messageId: 77, at: NOW - 1000 }],
    answered: [{ key: 'q0', value: 'Production', label: 'Production', at: NOW - 2000, delivery: 'socket' }],
  };
  const restored = parseQuestionStore(serializeQuestionStore(data), NOW, 60_000, 60_000);
  expect(restored.questions).toHaveLength(1);
  expect(restored.questions[0].req).toEqual(scopedQuestionReq('q1'));
  expect(restored.questions[0].messageId).toBe(77);
  expect(restored.answered).toEqual([{ key: 'q0', value: 'Production', label: 'Production', decision: undefined, at: NOW - 2000, delivery: 'socket' }]);
});

test('a questions file written before tg-cli#705 still restores: its old criticalState field is ignored', () => {
  const raw = JSON.stringify({
    v: 1,
    questions: [
      {
        req: { requestId: 'c1', agent: 'claude', kind: 'permission', paneId: '%1', question: 'Allow?', critical: true },
        messageId: 12,
        at: NOW - 1000,
        criticalState: { lastReminderAt: NOW - 500, lastReminderMessageId: 501, lastReminderChatId: -100777 },
      },
    ],
    answered: [],
  });
  const restored = parseQuestionStore(raw, NOW, 60_000, 60_000);
  expect(restored.questions).toHaveLength(1);
  expect(restored.questions[0]).toEqual({
    req: { requestId: 'c1', agent: 'claude', kind: 'permission', paneId: '%1', question: 'Allow?', critical: true },
    messageId: 12,
    at: NOW - 1000,
  });
});

test('a queued permission decision survives the round-trip (a daemon restart must not lose it)', () => {
  const data: QuestionStoreData = {
    questions: [
      {
        req: { requestId: 'p1', agent: 'claude', kind: 'permission', paneId: '%1', question: 'Allow rm -rf /tmp/x?' },
        messageId: 12,
        at: NOW - 1000,
        queuedDecision: { value: 'allow', label: 'Approve', decision: 'allow', at: NOW - 500 },
      },
    ],
    answered: [],
  };
  const restored = parseQuestionStore(serializeQuestionStore(data), NOW, 60_000, 60_000);
  expect(restored.questions[0].queuedDecision).toEqual({ value: 'allow', label: 'Approve', decision: 'allow', at: NOW - 500 });
});

test('a retained question with no queued decision round-trips with queuedDecision undefined', () => {
  const data: QuestionStoreData = {
    questions: [{ req: scopedQuestionReq('q1'), messageId: 77, at: NOW - 1000 }],
    answered: [],
  };
  const restored = parseQuestionStore(serializeQuestionStore(data), NOW, 60_000, 60_000);
  expect(restored.questions[0].queuedDecision).toBeUndefined();
});

test('a malformed queuedDecision is dropped, not corrupting the whole record', () => {
  const blob = JSON.stringify({
    v: 1,
    questions: [
      { req: scopedQuestionReq('q'), messageId: 1, at: NOW, queuedDecision: { value: 'allow' /* missing label */ } },
    ],
    answered: [],
  });
  const restored = parseQuestionStore(blob, NOW, 60_000, 60_000);
  expect(restored.questions).toHaveLength(1);
  expect(restored.questions[0].queuedDecision).toBeUndefined();
});

test('a queuedDecision with a missing/invalid decision (allow|deny) is dropped, not delivered as a malformed reply', () => {
  const blob = JSON.stringify({
    v: 1,
    questions: [
      {
        req: scopedQuestionReq('q'),
        messageId: 1,
        at: NOW,
        // value/label/at are all valid, but `decision` is what the delivery path
        // (formatAgentHookOutput) actually uses to build {behavior: 'allow'|'deny'}
        // — a corrupt/legacy record with no valid decision must not survive and be
        // auto-delivered as a malformed or wrong permission reply on reconnect.
        queuedDecision: { value: 'allow', label: 'Approve', at: NOW },
      },
    ],
    answered: [],
  });
  const restored = parseQuestionStore(blob, NOW, 60_000, 60_000);
  expect(restored.questions).toHaveLength(1);
  expect(restored.questions[0].queuedDecision).toBeUndefined();
});

test('a queuedDecision where value and decision DISAGREE is dropped (never deliver one while displaying the other)', () => {
  const blob = JSON.stringify({
    v: 1,
    questions: [
      {
        req: scopedQuestionReq('q'),
        messageId: 1,
        at: NOW,
        // A corrupt/crafted record: the card would show "Reject" (value/label) but
        // the hook would actually be told "allow" (decision) — a dangerous
        // display/delivery mismatch that must never survive to be delivered.
        queuedDecision: { value: 'deny', label: 'Reject', decision: 'allow', at: NOW },
      },
    ],
    answered: [],
  });
  const restored = parseQuestionStore(blob, NOW, 60_000, 60_000);
  expect(restored.questions).toHaveLength(1);
  expect(restored.questions[0].queuedDecision).toBeUndefined();
});

test('a queuedDecision with a future-dated `at` is dropped (a bad clock value must not defeat the delivery/retention TTLs)', () => {
  const blob = JSON.stringify({
    v: 1,
    questions: [
      {
        req: scopedQuestionReq('q'),
        messageId: 1,
        at: NOW,
        // now - at would be NEGATIVE, which is always "within" any window — a
        // corrupted future timestamp must not make the queue look permanently
        // fresh to tg-ctl's demote/expire sweeps.
        queuedDecision: { value: 'allow', label: 'Approve', decision: 'allow', at: NOW + 60_000 },
      },
    ],
    answered: [],
  });
  const restored = parseQuestionStore(blob, NOW, 60_000, 60_000);
  expect(restored.questions).toHaveLength(1);
  expect(restored.questions[0].queuedDecision).toBeUndefined();
});

test('an answered permission decision survives the round-trip', () => {
  const data: QuestionStoreData = {
    questions: [],
    answered: [{ key: 'p1', value: 'allow', label: 'Approve', decision: 'allow', at: NOW, delivery: 'socket' }],
  };
  const restored = parseQuestionStore(serializeQuestionStore(data), NOW, 60_000, 60_000);
  expect(restored.answered[0].decision).toBe('allow');
});

test('the answer delivery channel (pane vs socket) survives the round-trip; missing defaults to socket', () => {
  const data: QuestionStoreData = {
    questions: [],
    answered: [{ key: 'late', value: 'Yes', label: 'Yes', at: NOW, delivery: 'pane' }],
  };
  expect(parseQuestionStore(serializeQuestionStore(data), NOW, 60_000, 60_000).answered[0].delivery).toBe('pane');
  // A legacy record with no `delivery` field defaults to socket (preserves #98 replay).
  const legacy = JSON.stringify({ v: 1, questions: [], answered: [{ key: 'k', value: 'v', label: 'l', at: NOW }] });
  expect(parseQuestionStore(legacy, NOW, 60_000, 60_000).answered[0].delivery).toBe('socket');
});

test('questions and answered get SEPARATE age windows', () => {
  const blob = serializeQuestionStore({
    questions: [{ req: scopedQuestionReq('q'), messageId: 1, at: NOW - 20_000 }],
    answered: [{ key: 'a', value: 'v', label: 'l', at: NOW - 20_000, delivery: 'socket' }],
  });
  // Question window 60s (keeps it), answer window 10s (drops it).
  const restored = parseQuestionStore(blob, NOW, 60_000, 10_000);
  expect(restored.questions).toHaveLength(1);
  expect(restored.answered).toHaveLength(0);
});

test('an unknown format version is ignored (forward-compat), not mis-parsed', () => {
  const future = JSON.stringify({ v: 999, questions: [{ req: scopedQuestionReq('q'), messageId: 1, at: NOW }], answered: [] });
  expect(parseQuestionStore(future, NOW, 60_000, 60_000)).toEqual({ questions: [], answered: [] });
  const noVersion = JSON.stringify({ questions: [{ req: scopedQuestionReq('q'), messageId: 1, at: NOW }], answered: [] });
  expect(parseQuestionStore(noVersion, NOW, 60_000, 60_000)).toEqual({ questions: [], answered: [] });
});

test('entries older than the window are dropped on parse (no stale resurrection)', () => {
  const data: QuestionStoreData = {
    questions: [
      { req: scopedQuestionReq('fresh'), messageId: 1, at: NOW - 1000 },
      { req: scopedQuestionReq('stale'), messageId: 2, at: NOW - 90_000 },
    ],
    answered: [
      { key: 'fresh-a', value: 'x', label: 'x', at: NOW - 1000, delivery: 'socket' },
      { key: 'stale-a', value: 'y', label: 'y', at: NOW - 90_000, delivery: 'socket' },
    ],
  };
  const restored = parseQuestionStore(serializeQuestionStore(data), NOW, 60_000, 60_000);
  expect(restored.questions.map((q) => q.req.requestId)).toEqual(['fresh']);
  expect(restored.answered.map((a) => a.key)).toEqual(['fresh-a']);
});

test('corrupt / non-object / empty input parses to empty, never throws', () => {
  expect(parseQuestionStore(null, NOW, 60_000, 60_000)).toEqual({ questions: [], answered: [] });
  expect(parseQuestionStore('not json {', NOW, 60_000, 60_000)).toEqual({ questions: [], answered: [] });
  expect(parseQuestionStore('[1,2,3]', NOW, 60_000, 60_000)).toEqual({ questions: [], answered: [] });
  expect(parseQuestionStore('{"v":1,"questions":"nope","answered":42}', NOW, 60_000, 60_000)).toEqual({ questions: [], answered: [] });
});

test('malformed records inside the arrays are skipped individually', () => {
  const blob = JSON.stringify({
    v: 1,
    questions: [
      { req: scopedQuestionReq('ok'), messageId: 5, at: NOW },
      { req: 'not-an-object', messageId: 5, at: NOW }, // bad req
      { req: scopedQuestionReq('no-at'), messageId: 5 }, // missing at
      { req: scopedQuestionReq('bad-mid'), messageId: 'x', at: NOW }, // bad messageId
    ],
    answered: [
      { key: 'ok', value: 'v', label: 'l', at: NOW },
      { key: '', value: 'v', label: 'l', at: NOW }, // empty key
      { value: 'v', label: 'l', at: NOW }, // missing key
    ],
  });
  const restored = parseQuestionStore(blob, NOW, 60_000, 60_000);
  expect(restored.questions.map((q) => q.req.requestId)).toEqual(['ok']);
  expect(restored.answered.map((a) => a.key)).toEqual(['ok']);
});

test('a null messageId is preserved (card not yet confirmed)', () => {
  const restored = parseQuestionStore(
    serializeQuestionStore({ questions: [{ req: scopedQuestionReq('q'), messageId: null, at: NOW }], answered: [] }),
    NOW,
    60_000,
    60_000,
  );
  expect(restored.questions[0].messageId).toBeNull();
});

// tg-cli#707: every record in `questions` is an OPEN card (pending or abandoned) — it closes only
// on a relevance signal (#705), never by age or count. Only the answered-replay cache (closed
// records) is count-capped.
const OPEN_OVER_CAP = MAX_ANSWERED_RECORDS + 51;

test('serialize keeps EVERY open question and caps only the answered (closed) records on WRITE', () => {
  const questions = Array.from({ length: OPEN_OVER_CAP }, (_, i) => ({
    req: scopedQuestionReq(`q${i}`),
    messageId: i,
    at: NOW - i, // higher i = older
  }));
  const answered = Array.from({ length: MAX_ANSWERED_RECORDS + 30 }, (_, i) => ({
    key: `a${i}`,
    value: 'v',
    label: 'l',
    at: NOW - i,
    delivery: 'socket' as const,
  }));
  // Inspect the RAW serialized JSON directly (NOT via parseQuestionStore) to prove the WRITE
  // itself keeps every open card and bounds the closed ones.
  const raw = JSON.parse(serializeQuestionStore({ questions, answered }));
  expect(raw.questions).toHaveLength(OPEN_OVER_CAP);
  expect(raw.answered).toHaveLength(MAX_ANSWERED_RECORDS);
  expect(raw.answered[0].key).toBe('a0'); // freshest closed record kept
});

test('a restart restores every one of 250+ open questions, the oldest included; the answered cache stays capped', () => {
  const questions = Array.from({ length: OPEN_OVER_CAP }, (_, i) => ({
    req: scopedQuestionReq(`q${i}`),
    messageId: i,
    at: NOW - i, // higher i = older
    ...(i % 2 === 0 ? { pending: true as const } : {}),
  }));
  const answered = Array.from({ length: MAX_ANSWERED_RECORDS + 50 }, (_, i) => ({
    key: `a${i}`,
    value: 'v',
    label: 'l',
    at: NOW - i,
    delivery: 'socket' as const,
  }));
  const restored = parseQuestionStore(serializeQuestionStore({ questions, answered }), NOW, Number.MAX_SAFE_INTEGER, 10 * 60_000);
  expect(restored.questions).toHaveLength(OPEN_OVER_CAP);
  expect(new Set(restored.questions.map((q) => q.req.requestId))).toEqual(new Set(questions.map((q) => q.req.requestId)));
  expect(restored.answered).toHaveLength(MAX_ANSWERED_RECORDS);
  // Freshest closed records kept (i=0 newest); the oldest 50 dropped.
  expect(restored.answered.every((a) => Number(a.key.slice(1)) < MAX_ANSWERED_RECORDS)).toBe(true);
});

test('a file an older daemon left above the old 200 cap still restores every open question', () => {
  const raw = JSON.stringify({
    v: 1,
    questions: Array.from({ length: OPEN_OVER_CAP }, (_, i) => ({ req: scopedQuestionReq(`q${i}`), messageId: i, at: NOW - i })),
    answered: [],
  });
  expect(parseQuestionStore(raw, NOW, Number.MAX_SAFE_INTEGER, 60_000).questions).toHaveLength(OPEN_OVER_CAP);
});
