// Characterization of the daemon hook-socket protocol handler and the daemon-side request
// validator (features/tg-ctl/daemon-runtime/{hook-socket,button-requests}.ts), called directly with
// a fake socket and an in-memory QuestionRuntime — no daemon, no Telegram, no network.
import { expect, test } from 'bun:test';
import type { Socket } from 'net';
import { tempDir } from './helpers/test-temp';
import { join } from 'path';
import type { GrantRecord } from '../features/tg-ctl/grants';
import type { ButtonRequest } from '../features/tg-ctl/questions';
import type { Ctx } from '../features/tg-ctl/daemon-runtime/ctx-io';
import {
  normalizeButtonRequest,
  type AbandonedButton,
  type PendingButton,
  type QuestionRuntime,
} from '../features/tg-ctl/daemon-runtime/button-requests';
import { handleHookSocketLine } from '../features/tg-ctl/daemon-runtime/hook-socket';

class FakeSocket {
  written: string[] = [];
  ended: string | null = null;
  destroyed = false;
  writableEnded = false;
  closeHandlers: Array<() => void> = [];
  on(event: string, cb: () => void): this {
    if (event === 'close') this.closeHandlers.push(cb);
    return this;
  }
  write(chunk: string): boolean {
    this.written.push(chunk);
    return true;
  }
  end(chunk?: string): void {
    this.ended = chunk ?? '';
    this.writableEnded = true;
  }
  /** Everything the peer would have read, as lines. */
  lines(): string[] {
    return [...this.written, ...(this.ended ? [this.ended] : [])].join('').split('\n').filter(Boolean);
  }
}

function asSocket(s: FakeSocket): Socket {
  return s as unknown as Socket;
}

function makeCtx(chatId: number): Ctx {
  const dir = tempDir('tg-ctl-hook-socket-');
  return { chatId, paths: { registration: join(dir, 'registration.json') } } as unknown as Ctx;
}

interface Calls {
  persist: number;
  persistGrants: number;
  closed: Array<[string, string]>;
}

function makeRuntime(opts: { persistGrantsOk?: boolean; open?: Array<{ key: string; req: ButtonRequest; at: number }> } = {}): {
  rt: QuestionRuntime;
  calls: Calls;
  grants: GrantRecord[];
} {
  const calls: Calls = { persist: 0, persistGrants: 0, closed: [] };
  const grants: GrantRecord[] = [];
  const rt: QuestionRuntime = {
    pending: new Map<string, PendingButton>(),
    activeKeys: new Set<string>(),
    abandoned: new Map<string, AbandonedButton>(),
    answered: new Map(),
    persist: () => {
      calls.persist++;
    },
    onRelease: () => {},
    onTerminalFallback: () => {},
    onUnscopedRelease: () => {},
    grants: { grace: [], grants, decided: [] },
    persistGrants: () => {
      calls.persistGrants++;
      return opts.persistGrantsOk ?? true;
    },
    onHatchExpired: () => {},
    closeCard: (key, status) => {
      calls.closed.push([key, status]);
      return true;
    },
    closableCards: () => opts.open ?? [],
    postCardToInbox: async () => null,
  };
  return { rt, calls, grants };
}

const HATCH_REQUEST_ID = 'hatch-myhook-0123456789ab';

function permissionReq(extra: Partial<ButtonRequest> = {}): ButtonRequest {
  return {
    requestId: HATCH_REQUEST_ID,
    agent: 'claude',
    kind: 'permission',
    question: 'run rm?',
    promptTurnId: 'turn-1',
    ...extra,
  };
}

function grantRecord(extra: Partial<GrantRecord> = {}): GrantRecord {
  return {
    approval_id: 'appr-1',
    request_id: 'orig-req',
    hook_id: 'myhook',
    operation: { fingerprint: 'fp', cwd: '/w' },
    route: null,
    approved_at: 1,
    expires_at: Date.now() + 60_000,
    consumed_at: null,
    ...extra,
  };
}

const VERIFY_PAYLOAD = {
  requestId: HATCH_REQUEST_ID,
  agent: 'claude',
  kind: 'permission',
  question: 'q',
  cwd: '/w',
  operation: { kind: 'bash', fingerprint: 'fp', cwd: '/w' },
};

// --- normalizeButtonRequest: the authoritative socket/disk validator ---

test('normalizeButtonRequest rejects non-objects and any missing/empty required field', () => {
  const ok = { requestId: 'r', agent: 'claude', kind: 'question', question: 'q' };
  expect(normalizeButtonRequest(null)).toBeNull();
  expect(normalizeButtonRequest('x')).toBeNull();
  expect(normalizeButtonRequest(ok)).not.toBeNull();
  for (const bad of [
    { ...ok, requestId: '' },
    { ...ok, requestId: 5 },
    { ...ok, agent: '' },
    { ...ok, agent: undefined },
    { ...ok, kind: 'other' },
    { ...ok, question: '' },
  ]) {
    expect(normalizeButtonRequest(bad)).toBeNull();
  }
});

test('normalizeButtonRequest options: drops non-objects and label-less entries, keeps description only when a string', () => {
  const req = normalizeButtonRequest({
    requestId: 'r',
    agent: 'claude',
    kind: 'question',
    question: 'q',
    options: [{ label: 'A', description: 'da' }, { label: 'B', description: 3 }, { label: '' }, { description: 'x' }, 'str', null, { label: 7 }],
  });
  expect(req?.options).toEqual([{ label: 'A', description: 'da' }, { label: 'B' }]);
  expect(normalizeButtonRequest({ requestId: 'r', agent: 'claude', kind: 'question', question: 'q', options: 'nope' })?.options).toBeUndefined();
});

test('normalizeButtonRequest decisionLabels need two non-empty strings, else undefined', () => {
  const base = { requestId: 'r', agent: 'claude', kind: 'permission', question: 'q' };
  expect(normalizeButtonRequest({ ...base, decisionLabels: { allow: 'Proceed', deny: 'Keep planning' } })?.decisionLabels).toEqual({
    allow: 'Proceed',
    deny: 'Keep planning',
  });
  for (const dl of [{ allow: 'Proceed' }, { allow: '', deny: 'x' }, { allow: 'a', deny: 2 }, 'str', null]) {
    expect(normalizeButtonRequest({ ...base, decisionLabels: dl })?.decisionLabels).toBeUndefined();
  }
});

test('normalizeButtonRequest scalar fields: tolerant typing, sessionPin capped at 128, permissionEvent only PreToolUse', () => {
  const req = normalizeButtonRequest({
    requestId: 'r',
    agent: 'codex',
    kind: 'permission',
    question: 'q',
    paneId: '%1',
    cwd: 4,
    toolInput: { a: 1 },
    permissionEvent: 'PreToolUse',
    multiQuestion: true,
    ownerOnly: 'yes',
    critical: true,
    promptTurnId: 't',
    hookId: 'h',
    timeoutMs: 600000,
    sessionPin: 'p'.repeat(200),
    sessionKey: 'omp:x',
  });
  expect(req).toMatchObject({
    paneId: '%1',
    cwd: undefined,
    toolInput: { a: 1 },
    permissionEvent: 'PreToolUse',
    multiQuestion: true,
    ownerOnly: undefined,
    critical: true,
    promptTurnId: 't',
    hookId: 'h',
    timeoutMs: 600000,
    sessionKey: 'omp:x',
  });
  expect(req?.sessionPin).toBe('p'.repeat(128));
  const loose = normalizeButtonRequest({
    requestId: 'r',
    agent: 'claude',
    kind: 'permission',
    question: 'q',
    toolInput: [1],
    permissionEvent: 'PermissionRequest',
    timeoutMs: 0,
    hookId: '',
  });
  expect(loose?.toolInput).toBeUndefined();
  expect(loose?.permissionEvent).toBeUndefined();
  expect(loose?.timeoutMs).toBeUndefined();
  expect(loose?.hookId).toBeUndefined();
});

// --- handleHookSocketLine: dispatch + door checks ---

test('an unparsable line is dropped with a status line then null', async () => {
  const { rt } = makeRuntime();
  const socket = new FakeSocket();
  await handleHookSocketLine(makeCtx(123), rt, asSocket(socket), 'not json');
  expect(socket.lines()).toEqual([
    JSON.stringify({ tgctl: 'ask-status', state: 'dropped', reason: 'unparsable-payload' }),
    'null',
  ]);
});

test('an owner-only ask without a private owner chat is dropped before anything is registered', async () => {
  const { rt } = makeRuntime();
  const socket = new FakeSocket();
  const line = JSON.stringify({ ...permissionReq(), ownerOnly: true });
  await handleHookSocketLine(makeCtx(-100123), rt, asSocket(socket), line);
  expect(socket.lines()).toEqual([
    JSON.stringify({ tgctl: 'ask-status', state: 'dropped', reason: 'owner-only-needs-private-owner-chat' }),
    'null',
  ]);
  expect(rt.activeKeys.size).toBe(0);
});

test('a withdraw line closes the named cards and replies with the closed count', async () => {
  const open = [{ key: 'k1', req: permissionReq({ requestId: 'req-w' }), at: 1 }];
  const { rt, calls } = makeRuntime({ open });
  rt.pending.set('k1', { req: open[0].req, socket: asSocket(new FakeSocket()), messageId: 7, at: 1 });
  const socket = new FakeSocket();
  await handleHookSocketLine(makeCtx(123), rt, asSocket(socket), JSON.stringify({ withdraw: 'req-w', reason: 'gone' }));
  expect(calls.closed).toEqual([['k1', '⏹ withdrawn: gone']]);
  expect(socket.lines()).toEqual([JSON.stringify({ tgctl: 'withdrawn', closed: 1 })]);

  const none = new FakeSocket();
  await handleHookSocketLine(makeCtx(123), rt, asSocket(none), JSON.stringify({ withdraw: 'nope' }));
  expect(none.lines()).toEqual([JSON.stringify({ tgctl: 'withdrawn', closed: 0 })]);
});

test('a re-forward of a request already in flight is dropped as duplicate-in-flight', async () => {
  const { rt } = makeRuntime();
  rt.activeKeys.add(HATCH_REQUEST_ID);
  const socket = new FakeSocket();
  await handleHookSocketLine(makeCtx(123), rt, asSocket(socket), JSON.stringify(permissionReq()));
  expect(socket.lines()).toEqual([
    JSON.stringify({ tgctl: 'ask-status', state: 'dropped', reason: 'duplicate-in-flight' }),
    'null',
  ]);
});

// --- reconnect re-attach (queued permission decision) ---

function retainedWithQueuedDecision(req: ButtonRequest): AbandonedButton {
  return {
    req,
    messageId: null,
    at: 1,
    queuedDecision: { value: 'allow', label: 'Approve', decision: 'allow', at: 2 },
  };
}

test('a reconnect matching the retained permission gets the queued decision down its socket and no card', async () => {
  const { rt, calls } = makeRuntime();
  rt.abandoned.set(HATCH_REQUEST_ID, retainedWithQueuedDecision(permissionReq()));
  const socket = new FakeSocket();
  await handleHookSocketLine(makeCtx(123), rt, asSocket(socket), JSON.stringify(permissionReq()));
  const [reply] = socket.lines();
  expect(JSON.parse(reply)).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } });
  expect(rt.abandoned.has(HATCH_REQUEST_ID)).toBe(false);
  expect(rt.pending.size).toBe(0);
  expect(rt.activeKeys.size).toBe(0);
  expect(rt.answered.size).toBe(0);
  expect(calls.persist).toBe(1);
});

test('a reconnect whose promptTurnId differs does not take the queued decision: it re-attaches as a live pending card', async () => {
  const { rt, calls } = makeRuntime();
  rt.abandoned.set(HATCH_REQUEST_ID, retainedWithQueuedDecision(permissionReq()));
  const socket = new FakeSocket();
  await handleHookSocketLine(makeCtx(123), rt, asSocket(socket), JSON.stringify(permissionReq({ promptTurnId: 'turn-2' })));
  expect(socket.lines()).toEqual([]);
  expect(rt.abandoned.has(HATCH_REQUEST_ID)).toBe(false);
  expect(rt.activeKeys.has(HATCH_REQUEST_ID)).toBe(true);
  expect(rt.pending.get(HATCH_REQUEST_ID)?.req.promptTurnId).toBe('turn-2');
  expect(socket.closeHandlers.length).toBe(1);
  expect(calls.persist).toBe(1);
});

// --- verify-grant ---

async function verify(rt: QuestionRuntime, rec: Record<string, unknown>): Promise<Record<string, unknown>> {
  const socket = new FakeSocket();
  await handleHookSocketLine(makeCtx(123), rt, asSocket(socket), JSON.stringify({ tgctl: 'verify-grant', ...rec }));
  return JSON.parse(socket.lines()[0]) as Record<string, unknown>;
}

test('verify-grant without a hook id, or without an id or --pull, is denied as malformed with a null requestId', async () => {
  const { rt } = makeRuntime();
  for (const rec of [{ approvalId: 'a' }, { hookId: 'myhook' }, { hookId: '', pull: true }]) {
    const reply = await verify(rt, { ...rec, payload: VERIFY_PAYLOAD });
    expect(reply).toMatchObject({ requestId: null, hookSpecificOutput: { decision: { behavior: 'deny' } } });
  }
});

test('verify-grant by token consumes the grant, persists it, replies allow with ids, and closes sibling cards', async () => {
  const sibling = { key: 'sib', req: permissionReq({ requestId: 'hatch-myhook-aaaaaaaaaaaa', cwd: '/w' }), at: 1 };
  const { rt, calls, grants } = makeRuntime({ open: [sibling] });
  grants.push(grantRecord());
  const reply = await verify(rt, { hookId: 'myhook', approvalId: 'appr-1', payload: VERIFY_PAYLOAD });
  expect(reply).toMatchObject({ requestId: 'orig-req', approvalId: 'appr-1', hookSpecificOutput: { decision: { behavior: 'allow' } } });
  expect(grants[0].consumed_at).not.toBeNull();
  expect(calls.persistGrants).toBe(1);
  expect(calls.closed).toEqual([['sib', '✓ decided']]);

  const again = await verify(rt, { hookId: 'myhook', approvalId: 'appr-1', payload: VERIFY_PAYLOAD });
  expect(again).toMatchObject({ requestId: 'orig-req', hookSpecificOutput: { decision: { behavior: 'deny' } } });
  expect(calls.persistGrants).toBe(1);
});

test('verify-grant fails closed when the grant store cannot be written: rolled back, denied, nothing closed', async () => {
  const { rt, calls, grants } = makeRuntime({ persistGrantsOk: false });
  grants.push(grantRecord());
  const reply = await verify(rt, { hookId: 'myhook', approvalId: 'appr-1', payload: VERIFY_PAYLOAD });
  expect(reply).toMatchObject({ requestId: 'orig-req', hookSpecificOutput: { decision: { behavior: 'deny' } } });
  expect(grants[0].consumed_at).toBeNull();
  expect(calls.closed).toEqual([]);
});

test('verify-grant denies an unknown token, a wrong hook, and a mismatched operation without consuming', async () => {
  const { rt, calls, grants } = makeRuntime();
  grants.push(grantRecord());
  const unknown = await verify(rt, { hookId: 'myhook', approvalId: 'nope', payload: VERIFY_PAYLOAD });
  expect(unknown).toMatchObject({ requestId: HATCH_REQUEST_ID, hookSpecificOutput: { decision: { behavior: 'deny' } } });
  const wrongHook = await verify(rt, { hookId: 'other', approvalId: 'appr-1', payload: VERIFY_PAYLOAD });
  expect(wrongHook).toMatchObject({ requestId: 'orig-req', hookSpecificOutput: { decision: { behavior: 'deny' } } });
  const wrongOp = await verify(rt, {
    hookId: 'myhook',
    approvalId: 'appr-1',
    payload: { ...VERIFY_PAYLOAD, operation: { kind: 'bash', fingerprint: 'other', cwd: '/w' } },
  });
  expect(wrongOp).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } });
  expect(grants[0].consumed_at).toBeNull();
  expect(calls.persistGrants).toBe(0);
});

test('verify-grant --pull matches by hook + operation + route equality and uses the PreToolUse envelope when asked', async () => {
  const { rt, grants } = makeRuntime();
  grants.push(grantRecord({ route: 'pane:%3' }));
  const wrongRoute = await verify(rt, { hookId: 'myhook', pull: true, payload: { ...VERIFY_PAYLOAD, paneId: '%9' } });
  expect(wrongRoute).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } });
  expect(grants[0].consumed_at).toBeNull();

  const pre = await verify(rt, { hookId: 'myhook', pull: true, payload: { ...VERIFY_PAYLOAD, paneId: '%3', permissionEvent: 'PreToolUse' } });
  expect(pre).toMatchObject({ requestId: 'orig-req', approvalId: 'appr-1', hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
  expect(grants[0].consumed_at).not.toBeNull();
});
