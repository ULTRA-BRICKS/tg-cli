import { describe, expect, test } from 'bun:test';
import { buildMenu, handleCallback, type BotDeps, type InlineKeyboard } from '../features/chatgpt/bot';
import { errEnvelope, fakePm, SESSIONS_FIXTURE, type FakeCall, type FakeHandler } from './helpers/fake-pm';

const OWNER = 5150;
const NOW_MS = 1_790_000_000_000;

interface Harness {
  deps: BotDeps;
  calls: FakeCall[];
  store: { text: string | null; writes: number };
  clock: { ms: number };
}

function harness(handlers: Record<string, FakeHandler>, over: Partial<BotDeps> = {}): Harness {
  const pm = fakePm(handlers);
  const store = { text: null as string | null, writes: 0 };
  const clock = { ms: NOW_MS };
  let n = 0;
  const deps: BotDeps = {
    run: pm.run,
    now: () => clock.ms,
    randomId: () => `ref${String(++n).padStart(16, '0')}`,
    readStore: () => store.text,
    writeStore: (t) => {
      store.text = t;
      store.writes++;
    },
    ownerChatId: OWNER,
    ...over,
  };
  return { deps, calls: pm.calls, store, clock };
}

const REQ = { request_id: 'req-77', status: 'pending', action: 'pause', workspace: 'home', chat: 'c', expected_turn: null, expires_at: 1_790_000_900 };

const baseHandlers = (): Record<string, FakeHandler> => ({
  'sessions.list': () => SESSIONS_FIXTURE,
  'sessions.get': (p) => ({ session: { chat: p.chat, title: 'T', status: 'complete', latest_turn: 'turn-glide-canvas-7' } }),
  'actions.request': (p) => ({ ...REQ, action: p.action, workspace: p.workspace, chat: p.chat ?? null, expected_turn: p.expected_turn ?? null }),
  'requests.list': () => ({ requests: [REQ] }),
  'requests.get': () => ({ ...REQ, status: 'approved' }),
});

function buttons(kb: InlineKeyboard | undefined) {
  return (kb?.inline_keyboard ?? []).flat();
}
function find(kb: InlineKeyboard | undefined, label: RegExp) {
  return buttons(kb).filter((b) => label.test(b.text));
}

describe('/chatgpt menu rendering', () => {
  test('lists sessions per account with Details/Pause/Resume/Watch/Continue buttons and Requests/Refresh', async () => {
    const h = harness(baseHandlers());
    const view = await buildMenu(h.deps, 'all');
    expect(view.html).toContain('home');
    expect(view.html).toContain('glide.vc');
    for (const label of [/Details/, /Pause/, /Resume/, /Watch/, /Continue/, /Requests/, /Refresh/]) {
      expect(find(view.keyboard, label).length).toBeGreaterThan(0);
    }
    // 3 sessions: details x3, pause x3, resume x3, watch x3; continue only for the 2 rows exposing a turn
    expect(find(view.keyboard, /Details/)).toHaveLength(3);
    expect(find(view.keyboard, /Continue/)).toHaveLength(2);
  });
  test('callback_data is an opaque cgp: reference, unique, at most 64 bytes, and leaks no chat ids', async () => {
    const h = harness(baseHandlers());
    const view = await buildMenu(h.deps, 'all');
    const data = buttons(view.keyboard).map((b) => b.callback_data);
    expect(new Set(data).size).toBe(data.length);
    for (const d of data) {
      expect(d.startsWith('cgp:')).toBe(true);
      expect(Buffer.byteLength(d)).toBeLessThanOrEqual(64);
      expect(d).not.toContain('11111111');
      expect(d).not.toContain('turn-');
    }
  });
  test('the durable store holds only the fixed schema, never PM text', async () => {
    const h = harness(baseHandlers());
    await buildMenu(h.deps, 'all');
    expect(h.store.text).not.toBeNull();
    const parsed = JSON.parse(h.store.text!);
    expect(Object.keys(parsed).sort()).toEqual(['refs', 'version']);
    for (const ref of parsed.refs) {
      expect(Object.keys(ref).sort()).toEqual(['chat', 'createdAt', 'expectedTurn', 'expiresAt', 'id', 'kind', 'ownerChatId', 'requestId', 'used', 'workspace']);
    }
    expect(h.store.text).not.toContain('Workshop');
    expect(h.store.text).not.toContain('quota stop');
    const mode = JSON.stringify(parsed.refs.map((r: { ownerChatId: number }) => r.ownerChatId));
    expect(mode).toContain(String(OWNER));
  });
  test('HTML is escaped (chat titles with < & and quotes)', async () => {
    const h = harness(baseHandlers());
    const view = await buildMenu(h.deps, 'all');
    expect(view.html).toContain('Workshop &lt;&amp;&gt; "plan"'.replace(/"/g, '&quot;'));
    expect(view.html).not.toContain('<&>');
    // only our own tags survive
    const tags = [...view.html.matchAll(/<\/?([a-z-]+)[^>]*>/g)].map((m) => m[1]);
    expect(tags.every((t) => ['b', 'i', 'code'].includes(t))).toBe(true);
  });
  test('same chat id in two accounts gets separate refs bound to each account', async () => {
    const h = harness(baseHandlers());
    await buildMenu(h.deps, 'all');
    const refs = JSON.parse(h.store.text!).refs as { kind: string; workspace: string; chat: string }[];
    const details = refs.filter((r) => r.kind === 'details' && r.chat === '11111111-1111-4111-8111-111111111111');
    expect(details.map((r) => r.workspace).sort()).toEqual(['glide.vc', 'home']);
  });
  test('a pm failure renders an honest error without buttons', async () => {
    const h = harness({ 'sessions.list': () => errEnvelope('boom', 'pm is sad') });
    const view = await buildMenu(h.deps, 'all');
    expect(view.html).toContain('pm is sad');
    expect(buttons(view.keyboard)).toHaveLength(0);
  });
  test('no configured owner refuses to render a menu', async () => {
    const h = harness(baseHandlers(), { ownerChatId: 0 });
    const view = await buildMenu(h.deps, 'all');
    expect(buttons(view.keyboard)).toHaveLength(0);
    expect(h.calls).toHaveLength(0);
  });
});

async function tap(h: Harness, label: RegExp, view?: { keyboard?: InlineKeyboard }, nth = 0) {
  const v = view ?? (await buildMenu(h.deps, 'all'));
  const b = find(v.keyboard, label)[nth];
  expect(b).toBeDefined();
  return { data: b.callback_data, view: v };
}

describe('state-changing taps', () => {
  test('Pause queues exactly one owner-approval request bound to account+chat', async () => {
    const h = harness(baseHandlers());
    const { data } = await tap(h, /Pause/, undefined, 1); // glide.vc Canvas row (second session)
    const before = h.calls.length;
    const res = await handleCallback(h.deps, { data, chatId: OWNER });
    const reqs = h.calls.slice(before).filter((c) => c.method === 'actions.request');
    expect(reqs).toHaveLength(1);
    expect(reqs[0].params).toMatchObject({ workspace: 'glide.vc', chat: '11111111-1111-4111-8111-111111111111', action: 'pause' });
    expect('approved' in reqs[0].params).toBe(false);
    const text = `${res.toast} ${res.reply?.html ?? ''}`;
    expect(text).toContain('Approval requested');
    expect(text).toContain('req-77');
    expect(text).toContain('confirm in the approval prompt');
    expect(find(res.reply?.keyboard, /status/i).length).toBeGreaterThan(0);
  });
  test('Resume and Watch map to their actions', async () => {
    const h = harness(baseHandlers());
    const view = await buildMenu(h.deps, 'all');
    for (const [label, action] of [[/Resume/, 'resume'], [/Watch/, 'watch']] as const) {
      const { data } = await tap(h, label, view, 0);
      await handleCallback(h.deps, { data, chatId: OWNER });
      expect(h.calls.at(-1)).toMatchObject({ method: 'actions.request', params: { action, workspace: 'home' } });
    }
  });
  test('the ref is consumed durably BEFORE the pm call', async () => {
    let usedAtCallTime = null as boolean | null;
    const hd = baseHandlers();
    const h = harness(hd);
    hd['actions.request'] = (p) => {
      const refs = JSON.parse(h.store.text!).refs as { used: boolean; kind: string; workspace: string }[];
      usedAtCallTime = refs.find((r) => r.kind === 'pause' && r.workspace === p.workspace)?.used ?? null;
      return { ...REQ };
    };
    const { data } = await tap(h, /Pause/, undefined, 0);
    await handleCallback(h.deps, { data, chatId: OWNER });
    expect(usedAtCallTime).toBe(true);
  });
  test('replaying a consumed ref makes zero pm calls and says expired', async () => {
    const h = harness(baseHandlers());
    const { data } = await tap(h, /Pause/);
    await handleCallback(h.deps, { data, chatId: OWNER });
    const calls = h.calls.length;
    const again = await handleCallback(h.deps, { data, chatId: OWNER });
    expect(again.toast).toBe('expired');
    expect(h.calls).toHaveLength(calls);
  });
  test('two concurrent taps of one ref produce a single request', async () => {
    const h = harness(baseHandlers());
    const { data } = await tap(h, /Pause/);
    const before = h.calls.length;
    await Promise.all([handleCallback(h.deps, { data, chatId: OWNER }), handleCallback(h.deps, { data, chatId: OWNER })]);
    expect(h.calls.slice(before).filter((c) => c.method === 'actions.request')).toHaveLength(1);
  });
  test('no durable store write means no pm call (fail closed)', async () => {
    const h = harness(baseHandlers());
    const { data } = await tap(h, /Pause/);
    const before = h.calls.length;
    h.deps.writeStore = () => {
      throw new Error('disk full');
    };
    const res = await handleCallback(h.deps, { data, chatId: OWNER });
    expect(h.calls).toHaveLength(before);
    expect(res.toast).not.toContain('Approval requested');
  });
  test('an uncertain timeout is reported, never retried', async () => {
    const hd = baseHandlers();
    hd['actions.request'] = () => ({ kind: 'timeout' });
    const h = harness(hd);
    const { data } = await tap(h, /Pause/);
    const before = h.calls.length;
    const res = await handleCallback(h.deps, { data, chatId: OWNER });
    expect(h.calls.slice(before).filter((c) => c.method === 'actions.request')).toHaveLength(1);
    expect(`${res.toast} ${res.reply?.html ?? ''}`).toContain('tg chatgpt requests');
  });
  test('a pm error is reported and the ref stays consumed', async () => {
    const hd = baseHandlers();
    hd['actions.request'] = () => errEnvelope('refused', 'not allowed right now');
    const h = harness(hd);
    const { data } = await tap(h, /Pause/);
    const res = await handleCallback(h.deps, { data, chatId: OWNER });
    expect(`${res.toast} ${res.reply?.html ?? ''}`).toContain('not allowed right now');
    const calls = h.calls.length;
    expect((await handleCallback(h.deps, { data, chatId: OWNER })).toast).toBe('expired');
    expect(h.calls).toHaveLength(calls);
  });
});

describe('Continue binds and re-verifies the turn', () => {
  test('tap with an unchanged turn requests continue with expected_turn from the render', async () => {
    const h = harness(baseHandlers());
    const { data } = await tap(h, /Continue/, undefined, 1); // Canvas row
    const before = h.calls.length;
    await handleCallback(h.deps, { data, chatId: OWNER });
    const after = h.calls.slice(before).map((c) => c.method);
    expect(after).toEqual(['sessions.get', 'actions.request']);
    expect(h.calls.at(-1)?.params).toMatchObject({ workspace: 'glide.vc', action: 'continue', expected_turn: 'turn-glide-canvas-7' });
  });
  test('a stale (reordered, old) callback is refused when the latest turn moved on', async () => {
    const hd = baseHandlers();
    hd['sessions.get'] = (p) => ({ session: { chat: p.chat, latest_turn: 'turn-glide-canvas-8' } });
    const h = harness(hd);
    const { data } = await tap(h, /Continue/, undefined, 1);
    const before = h.calls.length;
    const res = await handleCallback(h.deps, { data, chatId: OWNER });
    expect(h.calls.slice(before).map((c) => c.method)).toEqual(['sessions.get']);
    expect(`${res.toast} ${res.reply?.html ?? ''}`.toLowerCase()).toContain('state changed');
    expect(`${res.toast} ${res.reply?.html ?? ''}`.toLowerCase()).toContain('refresh');
  });
  test('refuses when sessions.get exposes no turn or fails', async () => {
    for (const handler of [() => ({ session: { chat: 'x' } }), () => errEnvelope('down', 'x')]) {
      const hd = baseHandlers();
      hd['sessions.get'] = handler;
      const h = harness(hd);
      const { data } = await tap(h, /Continue/, undefined, 1);
      await handleCallback(h.deps, { data, chatId: OWNER });
      expect(h.calls.some((c) => c.method === 'actions.request')).toBe(false);
    }
  });
  test('no Continue button when the listing exposes no turn', async () => {
    const h = harness({ 'sessions.list': () => ({ ...SESSIONS_FIXTURE, sessions: [{ account: 'home', chat: 'c1', title: 'x', status: 'complete' }] }) });
    const view = await buildMenu(h.deps, 'all');
    expect(find(view.keyboard, /Continue/)).toHaveLength(0);
    expect(find(view.keyboard, /Pause/)).toHaveLength(1);
  });
});

describe('authorization and forged callbacks', () => {
  test.each(['cgp:', 'cgp:short', 'cgp:AAAAAAAAAAAAAAAAAAAAAAAA', 'cgp:' + 'x'.repeat(80), 'cgp:../../etc', 'other', '', 'cgp:ref0000000000000009;rm -rf'])('forged/unknown ref %j is expired with zero pm calls', async (data) => {
    const h = harness(baseHandlers());
    await buildMenu(h.deps, 'all');
    const before = h.calls.length;
    const res = await handleCallback(h.deps, { data, chatId: OWNER });
    expect(res.toast).toBe('expired');
    expect(h.calls).toHaveLength(before);
  });
  test('a tap from another chat is "not allowed", makes no pm call and does not consume the ref', async () => {
    const h = harness(baseHandlers());
    const { data } = await tap(h, /Pause/);
    const before = h.calls.length;
    const res = await handleCallback(h.deps, { data, chatId: OWNER + 1 });
    expect(res.toast).toBe('not allowed');
    expect(h.calls).toHaveLength(before);
    const ok = await handleCallback(h.deps, { data, chatId: OWNER });
    expect(`${ok.toast} ${ok.reply?.html ?? ''}`).toContain('Approval requested');
  });
  test.each([0, Number.NaN, -0.5])('no configured owner (%p) fails closed', async (owner) => {
    const good = harness(baseHandlers());
    const { data } = await tap(good, /Pause/);
    const h = harness(baseHandlers(), { ownerChatId: owner, readStore: () => good.store.text });
    const res = await handleCallback(h.deps, { data, chatId: owner });
    expect(res.toast).toBe('not allowed');
    expect(h.calls).toHaveLength(0);
  });
  test('a ref minted for another owner chat is refused', async () => {
    const minted = harness(baseHandlers(), { ownerChatId: 111 });
    const { data } = await tap(minted, /Pause/);
    const h = harness(baseHandlers(), { ownerChatId: 222, readStore: () => minted.store.text });
    const res = await handleCallback(h.deps, { data, chatId: 222 });
    expect(res.toast).toBe('not allowed');
    expect(h.calls).toHaveLength(0);
  });
  test('an expired ref (past its TTL) is expired with zero pm calls', async () => {
    const h = harness(baseHandlers());
    const { data } = await tap(h, /Pause/);
    h.clock.ms += 3600_000;
    const before = h.calls.length;
    expect((await handleCallback(h.deps, { data, chatId: OWNER })).toast).toBe('expired');
    expect(h.calls).toHaveLength(before);
  });
  test('a corrupt or hostile store file is treated as empty', async () => {
    for (const text of ['not json', '{"version":1,"refs":[{"id":"x","kind":"rm -rf","used":false}]}', '{"version":99,"refs":[]}', '[]']) {
      const h = harness(baseHandlers(), { readStore: () => text });
      const res = await handleCallback(h.deps, { data: 'cgp:ref0000000000000001', chatId: OWNER });
      expect(res.toast).toBe('expired');
      expect(h.calls).toHaveLength(0);
    }
  });
  test('a store record with an unknown action kind is never executed', async () => {
    const rec = { id: 'ref0000000000000042', kind: 'service-stop', workspace: 'home', chat: null, expectedTurn: null, requestId: null, ownerChatId: OWNER, createdAt: NOW_MS, expiresAt: NOW_MS + 60_000, used: false };
    const h = harness(baseHandlers(), { readStore: () => JSON.stringify({ version: 1, refs: [rec] }) });
    const res = await handleCallback(h.deps, { data: 'cgp:ref0000000000000042', chatId: OWNER });
    expect(res.toast).toBe('expired');
    expect(h.calls).toHaveLength(0);
  });
});

describe('read taps', () => {
  test('Details fetches sessions.get, escapes output and offers fresh action buttons', async () => {
    const hd = baseHandlers();
    hd['sessions.get'] = () => ({ session: { chat: 'c', title: 'A <b>bold</b> & "q"', status: 'complete', latest_turn: 'turn-5', reason: 'x<y' } });
    const h = harness(hd);
    const { data } = await tap(h, /Details/);
    const res = await handleCallback(h.deps, { data, chatId: OWNER });
    expect(h.calls.at(-1)?.method).toBe('sessions.get');
    expect(res.reply?.html).toContain('A &lt;b&gt;bold&lt;/b&gt; &amp; &quot;q&quot;');
    expect(res.reply?.html).not.toContain('<b>bold</b>');
    expect(find(res.reply?.keyboard, /Pause/)).toHaveLength(1);
    expect(find(res.reply?.keyboard, /Continue/)).toHaveLength(1);
    // the old ref is consumed; a replay does nothing
    const calls = h.calls.length;
    expect((await handleCallback(h.deps, { data, chatId: OWNER })).toast).toBe('expired');
    expect(h.calls).toHaveLength(calls);
  });
  test('Refresh re-renders the menu with fresh refs', async () => {
    const h = harness(baseHandlers());
    const view = await buildMenu(h.deps, 'all');
    const { data } = await tap(h, /Refresh/, view);
    const res = await handleCallback(h.deps, { data, chatId: OWNER });
    expect(res.reply?.html).toContain('home');
    const fresh = buttons(res.reply?.keyboard).map((b) => b.callback_data);
    const old = new Set(buttons(view.keyboard).map((b) => b.callback_data));
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((d) => !old.has(d))).toBe(true);
  });
  test('Requests lists requests with a status button; the status button calls requests.get', async () => {
    const h = harness(baseHandlers());
    const { data } = await tap(h, /Requests/);
    const res = await handleCallback(h.deps, { data, chatId: OWNER });
    expect(h.calls.at(-1)?.method).toBe('requests.list');
    expect(res.reply?.html).toContain('req-77');
    const st = find(res.reply?.keyboard, /req-77|status/i)[0];
    expect(st).toBeDefined();
    const res2 = await handleCallback(h.deps, { data: st.callback_data, chatId: OWNER });
    expect(h.calls.at(-1)).toMatchObject({ method: 'requests.get', params: { request_id: 'req-77' } });
    expect(res2.reply?.html).toContain('approved');
  });
  test('the request status button after a mutation reads requests.get', async () => {
    const h = harness(baseHandlers());
    const { data } = await tap(h, /Pause/);
    const res = await handleCallback(h.deps, { data, chatId: OWNER });
    const st = find(res.reply?.keyboard, /status/i)[0];
    await handleCallback(h.deps, { data: st.callback_data, chatId: OWNER });
    expect(h.calls.at(-1)).toMatchObject({ method: 'requests.get', params: { request_id: 'req-77' } });
  });
  test('output never contains secret-looking values', async () => {
    const secret = ['sk', 'FAKE', 'ABCDEF0123456789abcdef0123456789'].join('-');
    const hd = baseHandlers();
    hd['sessions.get'] = () => ({ session: { chat: 'c', title: `x ${secret}`, status: 'ok', reason: `Bearer ${secret}`, latest_turn: 't1' } });
    const h = harness(hd);
    const { data } = await tap(h, /Details/);
    const res = await handleCallback(h.deps, { data, chatId: OWNER });
    expect(res.reply?.html ?? '').not.toContain(secret);
    expect(res.toast).not.toContain(secret);
  });
});
