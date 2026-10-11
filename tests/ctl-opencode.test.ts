import { expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  isOpencodeBridgeRequest,
  opencodeEventToButtonRequest,
  opencodeRefOf,
  opencodeReplyPlan,
  type OpencodeEvent,
} from '../features/tg-ctl/opencode';

test('opencodeEventToButtonRequest maps question.asked into a button request', () => {
  const req = opencodeEventToButtonRequest({
    type: 'question.asked',
    properties: {
      sessionID: 'ses_1',
      id: 'que_1',
      questions: [
        {
          question: 'Pick a branch',
          header: 'Branch',
          custom: false,
          options: [
            { label: 'main', description: 'stable' },
            { label: 'feature', description: 'current branch' },
          ],
        },
      ],
    },
  });
  expect(req).toEqual({
    requestId: 'oc_ses_1_que_1',
    agent: 'opencode',
    kind: 'question',
    title: 'Branch',
    question: 'Pick a branch',
    options: [
      { label: 'main', description: 'stable' },
      { label: 'feature', description: 'current branch' },
    ],
    opencode: { sessionId: 'ses_1', requestId: 'que_1', replyKind: 'question' },
  });
});

test('opencodeEventToButtonRequest maps question.v2.asked to the v2 session reply kind', () => {
  const req = opencodeEventToButtonRequest({
    type: 'question.v2.asked',
    properties: {
      sessionID: 'ses_1',
      id: 'que_1',
      questions: [
        {
          question: 'Pick a branch',
          header: 'Branch',
          custom: false,
          options: [{ label: 'main', description: 'stable' }],
        },
      ],
    },
  });
  expect(req).toMatchObject({
    requestId: 'oc_ses_1_que_1',
    agent: 'opencode',
    kind: 'question',
    opencode: { sessionId: 'ses_1', requestId: 'que_1', replyKind: 'question-v2' },
  });
});

test('opencodeEventToButtonRequest returns null for multi-question prompts instead of dropping answers', () => {
  const req = opencodeEventToButtonRequest({
    type: 'question.asked',
    properties: {
      sessionID: 'ses_1',
      id: 'que_1',
      questions: [
        { question: 'Pick a branch', header: 'Branch', options: [{ label: 'main' }] },
        { question: 'Pick a region', header: 'Region', options: [{ label: 'eu' }] },
      ],
    },
  });
  expect(req).toBe(null);
});

test('opencodeEventToButtonRequest returns null for multi-select prompts instead of dropping answers', () => {
  const req = opencodeEventToButtonRequest({
    type: 'question.asked',
    properties: {
      sessionID: 'ses_1',
      id: 'que_1',
      questions: [
        {
          question: 'Pick branches',
          header: 'Branches',
          multiple: true,
          options: [{ label: 'main' }, { label: 'feature' }],
        },
      ],
    },
  });
  expect(req).toBe(null);
});

test('opencodeEventToButtonRequest returns null for custom questions without concrete options', () => {
  const req = opencodeEventToButtonRequest({
    type: 'question.asked',
    properties: {
      sessionID: 'ses_1',
      id: 'que_1',
      questions: [
        {
          question: 'Enter a branch name',
          header: 'Branch',
          custom: true,
        },
      ],
    },
  });
  expect(req).toBe(null);
});

test('opencodeEventToButtonRequest returns null when custom is omitted because opencode defaults it on', () => {
  const req = opencodeEventToButtonRequest({
    type: 'question.asked',
    properties: {
      sessionID: 'ses_1',
      id: 'que_1',
      questions: [
        {
          question: 'Pick or type a branch',
          header: 'Branch',
          options: [{ label: 'main' }],
        },
      ],
    },
  });
  expect(req).toBe(null);
});

test('opencodeEventToButtonRequest maps permission.asked into approve/reject request', () => {
  const req = opencodeEventToButtonRequest({
    type: 'permission.asked',
    properties: {
      sessionID: 'ses_1',
      id: 'per_1',
      permission: 'bash',
      metadata: { command: 'bun test' },
      patterns: [],
      always: [],
    },
  });
  expect(req).toMatchObject({
    requestId: 'oc_ses_1_per_1',
    agent: 'opencode',
    kind: 'permission',
    title: 'bash',
    question: 'bash\nbun test',
    opencode: { sessionId: 'ses_1', requestId: 'per_1', replyKind: 'permission' },
  });
});

test('opencodeEventToButtonRequest includes permission patterns and resources in the prompt', () => {
  const req = opencodeEventToButtonRequest({
    type: 'permission.asked',
    properties: {
      sessionID: 'ses_1',
      id: 'per_1',
      permission: 'edit',
      metadata: { input: { file: 'src/app.ts' } },
      patterns: ['src/*.ts'],
      resources: ['src/app.ts'],
      always: ['src/*.ts'],
      tool: { messageID: 'msg_1', callID: 'call_1' },
    },
  });
  expect(req?.question).toContain('edit');
  expect(req?.question).toContain('input: {"file":"src/app.ts"}');
  expect(req?.question).toContain('patterns: src/*.ts');
  expect(req?.question).toContain('resources: src/app.ts');
  expect(req?.question).toContain('always: src/*.ts');
  expect(req?.question).toContain('tool: {"messageID":"msg_1","callID":"call_1"}');
});

test('opencodeEventToButtonRequest maps permission.v2.asked to the v2 session reply kind', () => {
  const req = opencodeEventToButtonRequest({
    type: 'permission.v2.asked',
    properties: {
      sessionID: 'ses_1',
      id: 'per_1',
      permission: 'bash',
      metadata: { command: 'bun test' },
    },
  });
  expect(req).toMatchObject({
    requestId: 'oc_ses_1_per_1',
    agent: 'opencode',
    kind: 'permission',
    opencode: { sessionId: 'ses_1', requestId: 'per_1', replyKind: 'permission-v2' },
  });
});

test('opencodeReplyPlan builds question and permission reply endpoints', () => {
  expect(
    opencodeReplyPlan('http://127.0.0.1:4096', {
      requestId: 'oc_ses_1_req_1',
      agent: 'opencode',
      kind: 'question',
      question: 'Pick',
      opencode: { sessionId: 'ses_1', requestId: 'req_1', replyKind: 'question' },
    }, 'main'),
  ).toEqual({
    method: 'POST',
    url: 'http://127.0.0.1:4096/question/req_1/reply',
    body: { answers: [['main']] },
  });

  expect(
    opencodeReplyPlan('http://127.0.0.1:4096', {
      requestId: 'oc_ses_1_perm_1',
      agent: 'opencode',
      kind: 'permission',
      question: 'Run?',
      opencode: { sessionId: 'ses_1', requestId: 'perm_1', replyKind: 'permission' },
    }, 'allow'),
  ).toEqual({
    method: 'POST',
    url: 'http://127.0.0.1:4096/permission/perm_1/reply',
    body: { reply: 'once' },
  });
});

test('opencodeReplyPlan routes v2 question replies through the session endpoint', () => {
  expect(
    opencodeReplyPlan('http://127.0.0.1:4096', {
      requestId: 'oc_ses_1_req_1',
      agent: 'opencode',
      kind: 'question',
      question: 'Pick',
      opencode: { sessionId: 'ses_1', requestId: 'req_1', replyKind: 'question-v2' },
    }, 'main'),
  ).toEqual({
    method: 'POST',
    url: 'http://127.0.0.1:4096/api/session/ses_1/question/request/req_1/reply',
    body: { answers: [['main']] },
  });
});

test('opencodeReplyPlan routes v2 permission replies through the session endpoint', () => {
  expect(
    opencodeReplyPlan('http://127.0.0.1:4096', {
      requestId: 'oc_ses_1_perm_1',
      agent: 'opencode',
      kind: 'permission',
      question: 'Run?',
      opencode: { sessionId: 'ses_1', requestId: 'perm_1', replyKind: 'permission-v2' },
    }, 'allow'),
  ).toEqual({
    method: 'POST',
    url: 'http://127.0.0.1:4096/api/session/ses_1/permission/request/perm_1/reply',
    body: { reply: 'once' },
  });
});

test('opencodeReplyPlan maps permission deny to reject', () => {
  expect(
    opencodeReplyPlan('http://127.0.0.1:4096', {
      requestId: 'oc_ses_1_perm_1',
      agent: 'opencode',
      kind: 'permission',
      question: 'Run?',
      opencode: { sessionId: 'ses_1', requestId: 'perm_1', replyKind: 'permission' },
    }, 'deny'),
  ).toMatchObject({
    body: { reply: 'reject', message: 'Rejected from Telegram' },
  });
});

// opencode 2.x (recorded from 2.0.20's `GET /api/event`, tests/fixtures/opencode): the event
// envelope carries `data`, not `properties`; questions are `form.created` forms.
const v2Events = readFileSync(join(import.meta.dir, 'fixtures', 'opencode', 'opencode-2.0.20-events.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as OpencodeEvent);
const v2Event = (type: string): OpencodeEvent => v2Events.find((e) => e.type === type)!;

test('opencode 2.x permission.asked maps to a permission card replied through the session api route', () => {
  const req = opencodeEventToButtonRequest(v2Event('permission.asked'))!;
  expect(req).toMatchObject({
    agent: 'opencode',
    kind: 'permission',
    title: 'external_directory',
    question: 'external_directory\nresources: /opt/zz/*',
    opencode: { sessionId: 'ses_ed6592116ffe9n2bwWhaJox73j', requestId: 'per_129a70817001cL8CAS6aA3PpGw', replyKind: 'permission-api' },
  });
  expect(opencodeReplyPlan('http://127.0.0.1:49374/', req, 'allow')).toEqual({
    method: 'POST',
    url: 'http://127.0.0.1:49374/api/session/ses_ed6592116ffe9n2bwWhaJox73j/permission/per_129a70817001cL8CAS6aA3PpGw/reply',
    body: { decision: 'once' },
  });
  expect(opencodeReplyPlan('http://127.0.0.1:49374', req, 'deny')?.body).toEqual({ decision: 'reject', message: 'Rejected from Telegram' });
});

test('opencode 2.x single-choice form maps to option buttons; the tapped label replies with its value', () => {
  const req = opencodeEventToButtonRequest(v2Event('form.created'))!;
  expect(req).toMatchObject({
    agent: 'opencode',
    kind: 'question',
    title: 'Pick one',
    question: 'Which?',
    options: [{ label: 'Alpha' }, { label: 'Beta' }],
    opencode: { sessionId: 'ses_ed6592116ffe9n2bwWhaJox73j', requestId: 'frm_129a6ecea001fjH5B15p5Kvriv', replyKind: 'form' },
  });
  expect(opencodeReplyPlan('http://127.0.0.1:49374', req, 'Beta')).toEqual({
    method: 'POST',
    url: 'http://127.0.0.1:49374/api/session/ses_ed6592116ffe9n2bwWhaJox73j/form/frm_129a6ecea001fjH5B15p5Kvriv/reply',
    body: { answer: { choice: 'b' } },
  });
});

test('opencode 2.x forms that buttons cannot answer stay in the terminal', () => {
  const field = { key: 'choice', title: 'Which?', type: 'string', options: [{ value: 'a', label: 'Alpha' }], custom: false };
  const variant = (fields: Record<string, unknown>[]): OpencodeEvent => ({
    type: 'form.created',
    data: { form: { id: 'frm_1', sessionID: 'ses_1', title: 'Pick one', fields } },
  });
  expect(opencodeEventToButtonRequest(variant([field]))).not.toBeNull();
  expect(opencodeEventToButtonRequest(variant([{ ...field, custom: true }]))).toBeNull();
  expect(opencodeEventToButtonRequest(variant([{ ...field, type: 'multiselect' }]))).toBeNull();
  expect(opencodeEventToButtonRequest(variant([field, { ...field, key: 'second' }]))).toBeNull();
  expect(opencodeEventToButtonRequest(variant([{ key: 'name', type: 'string', custom: false }]))).toBeNull();
  const twoYes = [{ value: 'a', label: 'Yes' }, { value: 'b', label: 'Yes' }];
  expect(opencodeEventToButtonRequest(variant([{ ...field, options: twoYes }]))).toBeNull();
});

test('opencode 2.x ask from a child session carries the session title as the subagent label', () => {
  const req = opencodeEventToButtonRequest(v2Event('permission.asked'), {
    id: 'ses_ed6592116ffe9n2bwWhaJox73j',
    parentID: 'ses_parent',
    title: 'Scan repo (@explore subagent)',
  });
  expect(req?.subagent).toBe('Scan repo (@explore subagent)');
});

// tg-cli#687: the reply route survives the daemon socket and the question store, so a card
// restored after a daemon restart can still be answered in opencode.
test('opencodeRefOf reads back a stored reply route and rejects a malformed one', () => {
  const ref = {
    sessionId: 'ses_1',
    requestId: 'frm_1',
    replyKind: 'form',
    form: { fieldKey: 'choice', values: { Alpha: 'a' } },
    serverUrl: 'http://127.0.0.1:4096',
  };
  expect(opencodeRefOf(JSON.parse(JSON.stringify(ref)))).toEqual(ref);
  expect(opencodeRefOf({ ...ref, replyKind: 'shell' })).toBeUndefined();
  expect(opencodeRefOf({ ...ref, sessionId: 7 })).toBeUndefined();
  expect(opencodeRefOf({ ...ref, form: { fieldKey: 'choice', values: { Alpha: 1 } } })?.form).toBeUndefined();
  expect(opencodeRefOf('ses_1')).toBeUndefined();
});

test('only a paneless opencode ask carrying its server is a bridge ask', () => {
  const opencode = { sessionId: 's', requestId: 'r', replyKind: 'permission-api' as const, serverUrl: 'http://127.0.0.1:4096' };
  const base = { requestId: 'oc_s_r', agent: 'opencode' as const, kind: 'permission' as const, question: 'edit' };
  expect(isOpencodeBridgeRequest({ ...base, opencode })).toBe(true);
  expect(isOpencodeBridgeRequest({ ...base, opencode, paneId: '%1' })).toBe(false);
  expect(isOpencodeBridgeRequest({ ...base, opencode: { ...opencode, serverUrl: undefined } })).toBe(false);
  expect(isOpencodeBridgeRequest({ ...base, agent: 'claude', opencode })).toBe(false);
});
