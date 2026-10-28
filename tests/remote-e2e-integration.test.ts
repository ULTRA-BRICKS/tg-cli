import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { clientFixture, runEntry } from './helpers/client-send';
import { createRig, useOmpHarness, type Rig } from './helpers/remote-e2e-rig';
import { waitFor } from './helpers/remote-hub-harness';

// The REAL halves of the remote ctl feature against each other (docs/specs/2026-10-28-remote-ctl-server.md
// §4, §5, §8): the real `tg` and `python3 -I tg-remote` on a client machine, the real `tg-remote server` /
// `satellite serve` and real `tg-ctl run` / `satellite-deliver` on the others, joined only by a fake `ssh`
// that runs the far end locally (tests/helpers/fake-ssh-link.ts). The Python and the TypeScript suites each
// ran against a FAKE of the other side; this file is where they have to agree on the wire.
//
// ONE rig for the file: a hub daemon, a client machine, separate config dirs/homes/fake tmux. Both machines
// have an agent in pane %3 at pid 3003 — the hub's is the decoy a misrouted reply would type into. Scenarios
// use distinct message ids and assert on their own ids, never on totals.

let rig: Rig;
const SSH_OPTIONS = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2'];
// spec §4.3, verbatim.
const CLIENT_ARGV = [...SSH_OPTIONS, '--', 'tg-ctl-ubuntu', 'tg-remote', 'server', '--peer', 'clvm'];
const HUB_ARGV = [...SSH_OPTIONS, '-o', 'StrictHostKeyChecking=yes', '--', 'ultra@127.0.0.1', 'tg-remote', 'satellite', 'serve'];

let hubRoutesBefore: string | null;
let nextUpdate = 600;

beforeAll(async () => {
  rig = await createRig();
  hubRoutesBefore = rig.hub.read('tg-ctl.123.routes.json');
});
afterAll(async () => {
  await rig.cleanup();
});

/** `tg <text>` on the client; the id Telegram gave the first message. */
async function send(text: string, opts: { stdin?: string; extra?: string[]; env?: Record<string, string> } = {}): Promise<{ id: number; code: number; err: string }> {
  const r = await rig.tg([...(opts.extra ?? []), text], { stdin: opts.stdin, env: opts.env });
  const id = Number(/OK tg#(\d+)/.exec(r.out)?.[1] ?? NaN);
  if (!(id > 0)) throw new Error(`tg did not send (exit ${r.code}): ${r.out}${r.err}`);
  return { id, code: r.code, err: r.err };
}

const routeIds = (id: number): number => rig.remoteRoutes().filter((r) => r.id === id).length;
const historyRows = (id: number) => rig.history().filter((h) => h.message_id === id);
const journalFile = (id: number): string => join(rig.client.configDir, 'remote', 'journal', `1_${id}.json`);
const marker = (msg: number): string => join(rig.client.configDir, 'remote', 'delivered', `1-${msg}.json`);

/** A Telegram reply of the owner to message `replyTo`, as the hub's poller sees it; resolves once processed. */
async function reply(msg: number, replyTo: number, text: string): Promise<number> {
  const update = nextUpdate++;
  rig.hubApi.pushReply(update, msg, replyTo, text, rig.client.sent().at(-1)?.text);
  expect(await waitFor(() => rig.ledger().some((e) => e.event === 'processed' && e.update === update), 20_000)).toBe(true);
  return update;
}

const typed = (): string => rig.client.injected().join('\n');

// --- (1) send -> routes + history ----------------------------------------------------------------

test('(1) a client send is recorded on the hub under the clvm namespace, over the exact §4.3 argv; a replayed journal entry changes nothing', async () => {
  const sent = await send('hello from clvm');

  expect(sent.code).toBe(0);
  expect(sent.err).toBe('');
  expect(sent.id).toBeGreaterThan(0);
  const calls = rig.ssh.of('server');
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ argv: CLIENT_ARGV, op: 'record' });

  expect(rig.remoteRoutes().filter((r) => r.id === sent.id)).toMatchObject([
    { machine: 'clvm', chat: '1', route: { paneId: '%3', agentPid: 3003, serverPid: 9999, panePid: 3003 } },
  ]);
  expect(historyRows(sent.id)).toMatchObject([
    { text: 'hello from clvm', direction: 'agent', pane: 'clvm/%3', targetAgent: 'clvm/clproj', machine: 'clvm', chat_id: 1 },
  ]);

  // The hub's own (local) files are not the remote machine's: no row, no key, no session of clvm.
  expect(rig.hub.read('tg-ctl.123.routes.json')).toBe(hubRoutesBefore);
  expect(rig.hub.read('tg-ctl.123.last-user-target.json')).toBeNull();
  expect(rig.hub.read('tg-ctl.123.sessions.json') ?? '').not.toContain('clproj');
  expect(rig.hub.injected()).toEqual([]);
  // And the two machines cannot read each other's files: the hub owns the routes, the client owns the journal.
  expect(existsSync(join(rig.hub.cfgDir, 'remote'))).toBe(false);
  expect(existsSync(join(rig.client.configDir, 'tg-ctl.123.remote-routes.json'))).toBe(false);
  expect(existsSync(join(rig.client.configDir, 'tg-ctl.123.sock'))).toBe(false);

  // Journal replay: the same record arrives twice (a lost ack), then again — one route, one history group.
  rig.ssh.setMode({ server: { exit: 255, stderr: 'ssh: connect to host tg-ctl-ubuntu port 22: Connection refused\n' } });
  const kept = await send('replay me');
  rig.ssh.reset();
  expect(kept.code).toBe(0);
  const entry = readFileSync(journalFile(kept.id));
  const flush = async () => rig.clientRemote(['client', 'flush']);
  expect((await flush()).code).toBe(0);
  expect(existsSync(journalFile(kept.id))).toBe(false);
  expect(routeIds(kept.id)).toBe(1);
  expect(historyRows(kept.id)).toHaveLength(1);
  writeFileSync(journalFile(kept.id), entry, { mode: 0o600 });
  const again = await flush();
  expect(again.code).toBe(0);
  expect(JSON.parse(again.out)).toMatchObject({ status: 'flushed', sent: 1, remaining: 0 });
  expect(existsSync(journalFile(kept.id))).toBe(false);
  expect(routeIds(kept.id)).toBe(1);
  expect(historyRows(kept.id)).toHaveLength(1);
  expect(rig.hub.read('daemon.log')).toContain(`ids=${kept.id} applied=false history=0`);
}, 30_000);

// --- (2) reply -> exactly one satellite delivery -------------------------------------------------

test('(2) a Telegram reply is typed on the CLIENT machine exactly once; the same-numbered pane on the hub is never touched', async () => {
  const sent = await send('question for the owner');
  const helloBefore = rig.ssh.of('satellite', 'hello').length;

  await reply(10, sent.id, 'ok go ahead');

  expect(rig.finalState(10)).toBe('delivered');
  expect(rig.ledger().find((e) => e.event === 'claimed' && e.msg === 10)?.target).toBe('machine:clvm/%3');
  const delivers = rig.ssh.of('satellite', 'deliver');
  expect(delivers).toHaveLength(1);
  expect(delivers[0]!.argv).toEqual(HUB_ARGV);
  expect(rig.ssh.of('satellite', 'hello')).toHaveLength(helloBefore + 1);
  expect(rig.ssh.of('satellite', 'hello').at(-1)!.argv).toEqual(HUB_ARGV);

  expect(typed()).toContain('[TG from Alex tg#10] ok go ahead');
  expect(typed().match(/ok go ahead/g)).toHaveLength(1);
  expect(JSON.parse(readFileSync(marker(10), 'utf8')).state).toBe('delivered');

  // The decoy: pane %3 / pid 3003 / tmux server 9999 on the hub. Nothing typed, no picker, no notice.
  expect(rig.hub.injected()).toEqual([]);
  expect(rig.hubApi.sends).toEqual([]);
  expect(rig.hub.read('tg-ctl.123.last-user-target.json')).toBeNull();
  expect(rig.hub.read('tg-ctl.123.routes.json')).toBe(hubRoutesBefore);
  expect(rig.hub.read('tg-ctl.123.sessions.json') ?? '').not.toContain('clproj');
}, 40_000);

// --- (3) the link is down --------------------------------------------------------------------------

test('(3) ssh failing (exit 255): tg still exits 0 with a warning and a journal file; the next send flushes it and the hub applies it once', async () => {
  rig.ssh.setMode({ server: { exit: 255, stderr: 'ssh: connect to host tg-ctl-ubuntu port 22: Connection refused\n' } });
  const down = await send('sent while the link is down');
  rig.ssh.reset();

  expect(down.code).toBe(0);
  expect(down.id).toBeGreaterThan(0);
  expect(down.err).toContain('ctl server ssh://tg-ctl-ubuntu did not take the record');
  expect(down.err).toContain('Connection refused');
  expect(down.err).toContain(journalFile(down.id));
  expect(existsSync(journalFile(down.id))).toBe(true);
  expect(routeIds(down.id)).toBe(0);

  const next = await send('link is back');

  expect(next.code).toBe(0);
  expect(next.err).toBe('');
  expect(existsSync(journalFile(down.id))).toBe(false);
  expect(rig.journal()).toEqual([]);
  expect(routeIds(down.id)).toBe(1);
  expect(routeIds(next.id)).toBe(1);
  expect(historyRows(down.id)).toHaveLength(1);
  expect(historyRows(next.id)).toHaveLength(1);
  expect(down.id).toBeLessThan(next.id);
}, 40_000);

// --- (4) the link dies after the deliver request was written ----------------------------------------

test('(4) ssh dying AFTER the deliver request was written is uncertain: the owner is told, and replaying the update never delivers again', async () => {
  const sent = await send('reply expected on this one');
  const typedBefore = rig.client.injected().length;
  const deliversBefore = rig.ssh.of('satellite', 'deliver').length;
  // The satellite RUNS the deliver (the text is typed on the client), then the link drops with no reply line.
  rig.ssh.setMode({ satellite: { dropReply: true, onlyOp: 'deliver' } });

  await reply(20, sent.id, 'did it arrive');
  rig.ssh.reset();

  expect(rig.finalState(20)).toBe('uncertain');
  expect(rig.hubApi.sends.find((s) => s.text.includes('may or may not'))?.text).toContain('NOT sent again');
  expect(rig.ssh.of('satellite', 'deliver')).toHaveLength(deliversBefore + 1);
  expect(rig.client.injected().length).toBeGreaterThan(typedBefore);
  expect(typed().match(/did it arrive/g)).toHaveLength(1);
  expect(JSON.parse(readFileSync(marker(20), 'utf8')).state).toBe('delivered'); // the client's ledger knows better

  // Telegram redelivers the same message under a new update id, the link is healthy again.
  const injectedAfter = rig.client.injected().length;
  await reply(20, sent.id, 'did it arrive');

  expect(rig.ledger().some((e) => e.event === 'duplicate' && e.msg === 20)).toBe(true);
  expect(rig.ssh.of('satellite', 'deliver')).toHaveLength(deliversBefore + 1);
  expect(rig.client.injected()).toHaveLength(injectedAfter);
  expect(rig.hub.injected()).toEqual([]);
}, 60_000);

// --- (5) configuration that must stop everything ---------------------------------------------------------

test('(5) an invalid client config and `tg-ctl run` on a client both stop with exit 78', async () => {
  const bad = clientFixture('control:\n  server: ssh://-oProxyCommand=x\n  machine: clvm\n');
  const dry = await runEntry('tg', ['--dry-run', 'hello'], bad, { TG_API_BASE: 'http://127.0.0.1:1' });
  expect(dry.code).toBe(78);
  expect(dry.err).toContain('control.server');
  const sendBad = await runEntry('tg', ['hello'], bad, { TG_API_BASE: 'http://127.0.0.1:1' });
  expect(sendBad.code).toBe(78);

  const client = clientFixture();
  const run = await runEntry('tg-ctl', ['run'], client, {});
  expect(run.code).toBe(78);
  expect(run.err).toContain('this machine is a ctl client of ssh://tg-ctl-ubuntu; it must not poll Telegram');
  expect(existsSync(join(client.configDir, 'tg-ctl.123.sock'))).toBe(false);

  const bothRoles = clientFixture('control:\n  server: ssh://tg-ctl-ubuntu\n  machine: clvm\n  remote_machines: "clvm=ultra@127.0.0.1"\n');
  expect((await runEntry('tg-ctl', ['run'], bothRoles, {})).code).toBe(78);
}, 60_000);

// --- (6) hostile and large text --------------------------------------------------------------------------

const CAP = 256 * 1024;

test('(6) hostile text never reaches a shell and round-trips byte for byte, to the hub and back to the client', async () => {
  const sentinels = [join(rig.client.home, 'SENTINEL'), join(rig.client.cwd, 'SENTINEL'), join(rig.hub.cfgDir, 'SENTINEL')];
  const touch = sentinels.map((s) => `touch ${s}`);
  const body = [
    `$(${touch[0]})`,
    `\`${touch[1]}\``,
    `; ${touch[2]} && ${touch[0]} | ${touch[1]}`,
    `quote ' " \\ end`,
    'astral 😀🧑‍💻 rtl שלום עולם مرحبا بالعالم combining e\u0301 bidi \u202eabc\u202c',
  ].join('\n');

  const sent = await send(body);

  expect(sent.code).toBe(0);
  expect(sent.err).not.toContain('ctl server');
  expect(historyRows(sent.id)).toMatchObject([{ text: body, machine: 'clvm' }]);

  const hostileReply = `$(${touch[2]})\n\`${touch[0]}\` 😀 שלום`;
  await reply(30, sent.id, hostileReply);
  expect(rig.finalState(30)).toBe('delivered');
  expect(typed()).toContain(hostileReply.split('\n')[0]!);
  expect(typed()).toContain(hostileReply.split('\n')[1]!);
  for (const path of sentinels) expect(existsSync(path)).toBe(false);
}, 60_000);

test('(6b) a 200 KiB body round-trips exactly; one over the 256 KiB cap is cut on a character boundary and says so', async () => {
  // `tg` drops the one trailing newline of a stdin body.
  const body = `${'x'.repeat(1023)}\n`.repeat(200).slice(0, -1);
  const small = await send('-', { stdin: `${body}\n`, extra: ['--no-feature', 'flood-cap'] });
  const smallWire = rig.ssh.of('server', 'record').at(-1)!.record!;
  expect(small.code).toBe(0);
  expect(smallWire).toMatchObject({ truncated: false, textBytes: Buffer.byteLength(body) });
  expect(smallWire.ids).toBeGreaterThan(1); // 4096-character messages: one record carries every id
  const smallRows = rig.history().filter((h) => h.message_id >= small.id && h.message_id < small.id + smallWire.ids);
  expect(smallRows).toHaveLength(smallWire.ids);
  expect(smallRows.every((h) => h.text === body)).toBe(true);
  // A reply to ANY chunk of the split message finds the one recorded route.
  await reply(60, small.id + smallWire.ids - 1, 'reply to the last chunk');
  expect(rig.finalState(60)).toBe('delivered');
  expect(typed()).toContain('reply to the last chunk');

  const huge = '😀'.repeat(75_000); // 300 000 bytes, 4 bytes each
  const big = await send('-', { stdin: huge, extra: ['--no-feature', 'flood-cap'] });
  const bigWire = rig.ssh.of('server', 'record').at(-1)!.record!;
  expect(big.code).toBe(0);
  expect(bigWire).toMatchObject({ truncated: true, textBytes: CAP });
  const rows = historyRows(big.id);
  expect(rows).toHaveLength(1);
  expect(Buffer.byteLength(rows[0]!.text)).toBe(CAP);
  expect(rows[0]!.text).toBe(huge.slice(0, CAP / 2)); // UTF-16: two code units per emoji
  expect(rows[0]!.text).not.toContain('\ufffd');
}, 60_000);

// --- (7) a planted package in the sender's cwd ---------------------------------------------------------------

test('(7) a ./tgcli/__init__.py planted in the sender cwd, the hub home and the client home never executes', async () => {
  const dirs = [rig.client.cwd, rig.client.home, rig.hub.cfgDir];
  const ran = (dir: string): string => join(dir, 'PLANT_RAN');
  for (const dir of dirs) {
    mkdirSync(join(dir, 'tgcli'), { recursive: true });
    writeFileSync(join(dir, 'tgcli', '__init__.py'), `open(${JSON.stringify(ran(dir))}, 'w').close()\n`);
  }
  // Armed: a plain interpreter in the sender's cwd, or one given PYTHONPATH, DOES import it (so the assertions
  // below are not vacuous). `tg` itself runs with PYTHONPATH pointing at the plant too.
  for (const env of [{ PATH: process.env.PATH ?? '' }, { PATH: process.env.PATH ?? '', PYTHONPATH: rig.client.cwd }]) {
    const control = Bun.spawnSync(['python3', '-c', 'import tgcli'], { cwd: env.PYTHONPATH ? rig.client.binDir : rig.client.cwd, env });
    expect(control.exitCode).toBe(0);
    expect(existsSync(ran(rig.client.cwd))).toBe(true);
    rmSync(ran(rig.client.cwd));
  }

  const sent = await send('with a planted package', { env: { PYTHONPATH: rig.client.cwd } });
  expect(sent.code).toBe(0);
  expect(sent.err).toBe('');
  expect(routeIds(sent.id)).toBe(1);
  await reply(40, sent.id, 'reply with a planted package around');
  expect(rig.finalState(40)).toBe('delivered');

  for (const dir of dirs) expect(existsSync(ran(dir))).toBe(false);
}, 60_000);

// --- (8) status on both sides is a real round trip -----------------------------------------------------------

test('(8) `tg-ctl status` shows measured facts on the client (server, daemon, journal, records) and on the hub (hello, records, last deliver)', async () => {
  const sent = await send('status check');
  await reply(70, sent.id, 'status reply');
  expect(rig.finalState(70)).toBe('delivered');

  const client = await runEntry('tg-ctl', ['status'], rig.client, { TG_REMOTE_SSH: rig.ssh.bin });
  expect(client.code).toBe(0);
  expect(client.out).toContain('server: ssh://tg-ctl-ubuntu (ssh stdio, machine clvm)');
  expect(client.out).toContain('link: ok (peer clvm)');
  expect(client.out).toContain(`daemon: up (pid ${rig.daemon.pid}, code `);
  expect(client.out).toContain('journal: empty');
  expect(client.out).toMatch(/records: \d+ recorded, last 20\d\d-/);
  expect(client.out).toMatch(/last deliver: (delivered|uncertain) at /);

  const hubSide = { home: rig.hub.cfgDir, configDir: rig.hub.cfgDir, binDir: join(rig.hub.cfgDir, 'bin'), cwd: rig.hub.cfgDir };
  const hub = await runEntry('tg-ctl', ['status'], hubSide, { TG_REMOTE_SSH: rig.ssh.bin, TG_API_BASE: 'http://127.0.0.1:1' });
  expect(hub.code).toBe(0);
  expect(hub.out).toContain('- clvm → ultra@127.0.0.1');
  expect(hub.out).toMatch(/hello: ok \(\d+ ms\)/);
  expect(hub.out).toMatch(/records: \d+, last /);
  expect(hub.out).not.toContain('last deliver: never');
}, 60_000);

// --- (9) session names the two validators must both accept -----------------------------------------------------

test('(9) unusual tmux window names are recorded, not rejected: Cyrillic/RTL/emoji, joiners and marks, 200 astral characters', async () => {
  // Python counts a label's length in code points, the TypeScript hub must too (200 emoji = 400 UTF-16 units).
  const names = ['проект 😀 שלום', 'dev🧑‍💻\u200f\u200e', '😀'.repeat(200)];
  try {
    for (const name of names) {
      rig.client.setWindowName(name);
      const sent = await send(`named ${[...name].length}`);

      expect(sent.err).not.toContain('ctl server');
      expect(rig.journal()).toEqual([]);
      expect(rig.remoteRoutes().find((r) => r.id === sent.id)).toMatchObject({ name: { primary: name } });
      expect(historyRows(sent.id)).toMatchObject([{ targetAgent: `clvm/${name}`, machine: 'clvm' }]);
    }
  } finally {
    rig.client.setWindowName('clproj');
  }
}, 60_000);

// --- (10) the sender is an out-of-tmux omp: the satellite types through its live endpoint ------------------------

test('(10) a reply to an omp session on the client reaches that omp through its endpoint; no pane, on either machine, is typed into', async () => {
  const omp = await useOmpHarness(rig.client);
  try {
    const sent = await send('from an omp session', { env: { TMUX: '', TMUX_PANE: '' } });
    expect(sent.err).not.toContain('ctl server');
    const stored = rig.remoteRoutes().find((r) => r.id === sent.id);
    expect(stored?.route.paneId).toBe(`omp:${process.pid}`);
    const typedBefore = rig.client.injected().length;

    await reply(50, sent.id, 'go on, omp');

    expect(rig.finalState(50)).toBe('delivered');
    expect(omp.received.join('\n')).toContain('go on, omp');
    expect(omp.received).toHaveLength(1);
    expect(rig.client.injected()).toHaveLength(typedBefore);
    expect(rig.hub.injected()).toEqual([]);
  } finally {
    await omp.stop();
  }
}, 60_000);
