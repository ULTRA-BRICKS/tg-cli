import { afterEach, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { parseHistory } from '../features/replies/history';
import { LOCAL_PANE, LOCAL_PID, createHubKit, makeHubHarness, recordLine, socketRequest, waitFor, type FakeTg, type HubHarness } from './helpers/remote-hub-harness';

// The daemon HOST side of the remote ctl feature (docs/specs/2026-10-28-remote-ctl-server.md §5 "Reply"),
// driven end to end: a REAL `tg-ctl run` against a fake Bot API, a fake tmux with ONE local agent
// pane %3 / pid 3003 — the very pane id and pid the remote machine's route carries — and a fake
// `tg-remote`. Nothing reaches Telegram, ssh or a real tmux.

const kit = createHubKit();
afterEach(kit.cleanup);

const REMOTE_ANCHOR = '[clvm/remoteproj] report from the remote machine';

interface LedgerEvent {
  event: string;
  msg?: number;
  target?: string;
}

function ledger(h: HubHarness): LedgerEvent[] {
  return (h.read('tg-ctl.123.delivery.jsonl') ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l) as LedgerEvent);
}

const finalState = (h: HubHarness, msg: number): string | undefined =>
  ledger(h).filter((e) => e.msg === msg && ['delivered', 'failed', 'uncertain', 'duplicate'].includes(e.event)).at(-1)?.event;

async function boot(opts: Parameters<typeof makeHubHarness>[0] = { remoteMachines: 'clvm=ultra@65.21.40.51' }): Promise<{ h: HubHarness; tg: FakeTg }> {
  const h = makeHubHarness({ localRoutes: [500], ...opts });
  const tg = kit.tg();
  await kit.daemon(h, tg);
  return { h, tg };
}

async function record(h: HubHarness, id = 700, peer = 'clvm'): Promise<void> {
  const reply = JSON.parse(await socketRequest(h, recordLine({}, peer, { ids: [{ id, threadId: null }] })));
  expect(reply).toMatchObject({ ok: true, applied: true });
}

test('a reply to a clvm message goes ONLY to the clvm deliver; the same-numbered local pane is never typed into', async () => {
  const { h, tg } = await boot();
  const routesBefore = h.read('tg-ctl.123.routes.json');
  await record(h);

  tg.pushReply(600, 10, 700, 'ok go ahead', REMOTE_ANCHOR);
  expect(await waitFor(() => h.remote.delivers('clvm').length === 1 && finalState(h, 10) === 'delivered')).toBe(true);
  await Bun.sleep(300);

  const [call] = h.remote.delivers();
  expect(h.remote.delivers()).toHaveLength(1);
  expect(call.machine).toBe('clvm');
  expect(call.isolated).toBe(1); // python3 -I
  expect(call.request).toMatchObject({
    idem: '1:10',
    replyTo: { id: 700 },
    route: { paneId: LOCAL_PANE, agentPid: LOCAL_PID, serverPid: 4321, panePid: 5555 },
  });
  expect(String(call.request.text)).toContain('ok go ahead');
  expect(String(call.request.text)).toContain('tg#10');

  // Never typed into the local pane, no picker, no local anchor, no remote locator in local stores.
  expect(h.injected()).toEqual([]);
  expect(tg.sends.some((s) => s.hasMarkup)).toBe(false);
  expect(h.read('tg-ctl.123.last-user-target.json')).toBeNull();
  expect(h.read('tg-ctl.123.routes.json')).toBe(routesBefore);
  expect(h.read('tg-ctl.123.sessions.json') ?? '').not.toContain('remoteproj');
  expect(ledger(h).find((e) => e.event === 'claimed' && e.msg === 10)?.target).toBe(`machine:clvm/cc:pane:4321/${LOCAL_PANE}/5555`);
}, 30_000);

test('same pane id and pid on both machines: a reply to the LOCAL message still types locally, the remote one only goes out', async () => {
  const { h, tg } = await boot();
  await record(h);

  tg.pushReply(600, 10, 500, 'for the local agent');
  expect(await waitFor(() => h.injected().length > 0)).toBe(true);
  tg.pushReply(601, 11, 700, 'for the clvm agent', REMOTE_ANCHOR);
  expect(await waitFor(() => h.remote.delivers().length === 1)).toBe(true);
  await Bun.sleep(300);

  // The wrapped reply is multi-line (quote anchor + wrap), so the fake tmux logs it as a paste.
  expect(h.injected().join('\n')).toContain(`${LOCAL_PANE}\t↩ tg#500`);
  expect(h.injected().join('\n')).toContain('for the local agent');
  expect(h.injected().join('\n')).not.toContain('for the clvm agent');
  expect(String(h.remote.delivers()[0].request.text)).toContain('for the clvm agent');
  expect(String(h.remote.delivers()[0].request.text)).not.toContain('for the local agent');
}, 30_000);

test('two remote machines with the same pane id: the reply goes to the machine that sent the message', async () => {
  const machines = [{ name: 'clvm', target: 'ultra@h1' }, { name: 'lab', target: 'ultra@h2' }];
  const { h, tg } = await boot({ remoteMachines: 'clvm=ultra@h1,lab=ultra@h2', machines });
  await record(h, 700, 'clvm');
  await record(h, 701, 'lab');

  tg.pushReply(600, 10, 701, 'to the lab agent', '[lab/remoteproj] hi');
  expect(await waitFor(() => h.remote.delivers().length === 1)).toBe(true);
  await Bun.sleep(300);

  expect(h.remote.delivers().map((d) => d.machine)).toEqual(['lab']);
  expect(h.injected()).toEqual([]);
}, 30_000);

test('a plain failure posts "<machine> unreachable; tg#<id> not delivered": no local delivery, no picker, nothing remembered', async () => {
  const { h, tg } = await boot();
  await record(h);
  h.remote.setDeliver('clvm', { stdout: '{"ok":false,"error":"ssh","uncertain":false,"detail":"connection refused"}\n' });

  tg.pushReply(600, 10, 700, 'anyone there', REMOTE_ANCHOR);
  expect(await waitFor(() => tg.sends.some((s) => s.text.includes('unreachable')))).toBe(true);
  await Bun.sleep(300);

  expect(tg.sends.find((s) => s.text.includes('unreachable'))?.text).toBe('clvm unreachable; tg#10 not delivered');
  expect(h.remote.delivers()).toHaveLength(1);
  expect(h.injected()).toEqual([]);
  expect(tg.sends.some((s) => s.hasMarkup)).toBe(false);
  expect(h.read('tg-ctl.123.last-user-target.json')).toBeNull();
  expect(finalState(h, 10)).toBe('failed');
}, 30_000);

test('the link dropping after the write is uncertain: the owner is told, and a replay of the update is never re-sent', async () => {
  const { h, tg } = await boot();
  await record(h);
  h.remote.setDeliver('clvm', { stdout: '{"ok":false,"error":"link-dropped","uncertain":true}\n' });

  tg.pushReply(600, 10, 700, 'did it arrive', REMOTE_ANCHOR);
  expect(await waitFor(() => finalState(h, 10) === 'uncertain')).toBe(true);
  expect(tg.sends.find((s) => s.text.includes('may or may not'))?.text).toContain('NOT sent again');

  // Telegram redelivers the same message under a new update id; the link is healthy again.
  h.remote.setDeliver('clvm', { stdout: '{"ok":true,"sink":"tmux"}\n' });
  tg.pushReply(601, 10, 700, 'did it arrive', REMOTE_ANCHOR);
  expect(await waitFor(() => ledger(h).some((e) => e.event === 'duplicate' && e.msg === 10))).toBe(true);
  await Bun.sleep(300);

  expect(h.remote.delivers()).toHaveLength(1);
  expect(h.injected()).toEqual([]);
}, 30_000);

test('a replay answered by the client marker is mapped by its ORIGINAL outcome; anything but delivered is uncertain', async () => {
  const { h, tg } = await boot();
  await record(h);
  const cases: [number, string, string][] = [
    [20, '{"ok":true,"duplicate":true,"outcome":"delivered"}\n', 'delivered'],
    [21, '{"ok":false,"duplicate":true,"outcome":"uncertain","uncertain":true}\n', 'uncertain'],
    [22, '{"ok":true,"duplicate":true}\n', 'uncertain'],
  ];
  for (const [msg, stdout, expected] of cases) {
    h.remote.setDeliver('clvm', { stdout });
    tg.pushReply(600 + msg, msg, 700, `reply ${msg}`, REMOTE_ANCHOR);
    expect(await waitFor(() => finalState(h, msg) === expected)).toBe(true);
  }
  expect(h.remote.delivers()).toHaveLength(3);
  expect(h.injected()).toEqual([]);
}, 40_000);

test('an unrecognised reply on a hub is NEVER auto-injected into the single local agent: the picker, with the link line', async () => {
  const { h, tg } = await boot();

  tg.pushReply(600, 10, 999, 'who is this for', 'some message nobody recorded');
  expect(await waitFor(() => tg.sends.some((s) => s.hasMarkup))).toBe(true);
  await Bun.sleep(300);

  expect(h.injected()).toEqual([]);
  expect(h.remote.delivers()).toHaveLength(0);
  const picker = tg.sends.find((s) => s.hasMarkup);
  expect(picker?.text).toContain('if this was for a clvm agent, its link may be down');
  expect(picker?.text).toContain('Route to which agent?');
}, 30_000);

test('a reply whose anchor names a known machine but has no recorded route says so and delivers nowhere', async () => {
  const { h, tg } = await boot();

  tg.pushReply(600, 10, 999, 'hello clvm?', '[clvm/remoteproj] a report whose record never arrived');
  expect(await waitFor(() => tg.sends.some((s) => s.text.includes('route not recorded')))).toBe(true);
  await Bun.sleep(300);

  expect(tg.sends.some((s) => s.hasMarkup)).toBe(false);
  expect(h.injected()).toEqual([]);
  expect(h.remote.delivers()).toHaveLength(0);
  expect(finalState(h, 10)).toBeUndefined();
}, 30_000);

test('a photo reply to a remote route is refused with a notice (its path is local to this host)', async () => {
  const { h, tg } = await boot();
  await record(h);

  tg.pushPhotoReply(600, 10, 700, REMOTE_ANCHOR);
  expect(await waitFor(() => tg.sends.some((s) => s.text.includes('cannot be forwarded')))).toBe(true);
  await Bun.sleep(300);

  expect(h.remote.delivers()).toHaveLength(0);
  expect(h.injected()).toEqual([]);
}, 30_000);

test('the inbound history row of a reply to a remote message is attributed <machine>/<name>, never a local pane', async () => {
  const { h, tg } = await boot();
  await record(h);

  tg.pushReply(600, 10, 700, 'attribution check', REMOTE_ANCHOR);
  expect(await waitFor(() => parseHistory(h.read('tg-ctl.123.history.jsonl')).some((r) => r.direction === 'user' && r.message_id === 10))).toBe(true);

  const row = parseHistory(h.read('tg-ctl.123.history.jsonl')).find((r) => r.direction === 'user' && r.message_id === 10);
  expect(row).toMatchObject({ pane: `clvm/${LOCAL_PANE}`, targetAgent: 'clvm/remoteproj', sessionKey: `clvm/cc:pane:4321/${LOCAL_PANE}/5555` });
}, 30_000);

test('hub OFF (no remote_machines): no tg-remote spawn at all, no remote files, and the single-agent auto-inject is unchanged', async () => {
  const { h, tg } = await boot({});

  tg.pushReply(600, 10, 999, 'plain unrecognised reply', 'not recorded anywhere');
  expect(await waitFor(() => h.injected().length > 0)).toBe(true);
  await Bun.sleep(500);

  expect(h.injected().join('\n')).toContain('plain unrecognised reply');
  expect(tg.sends.some((s) => s.hasMarkup)).toBe(false);
  expect(h.remote.calls()).toEqual([]);
  for (const name of ['tg-ctl.123.remote-routes.json', 'tg-ctl.123.remote-status.json', 'remote']) expect(existsSync(h.file(name))).toBe(false);
  expect(readFileSync(h.file('tg-ctl.123.history.jsonl'), 'utf8')).not.toContain('"machine"');
}, 30_000);
