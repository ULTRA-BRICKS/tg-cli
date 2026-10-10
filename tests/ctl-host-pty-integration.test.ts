import { afterAll, beforeAll, expect, test } from 'bun:test';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { TMUX_NO_SERVER_SHIM } from './helpers/hermetic-host';
import { tempDir } from './helpers/test-temp';

// docs/specs/2026-09-30-harness-agnostic-control.md: a Claude Code session a rig wrapper hosts
// in abduco OUTSIDE tmux is reachable. The daemon runs its REAL discovery against PATH-shimmed
// tmux (no panes) and ps (the abduco server → supervisor → claude tree of the record), reads the
// record the wrapper wrote, and types into the session through abduco's client protocol — here
// served by an in-process stand-in on the record's socket, so every byte the PTY would receive
// is observable. One unhosted claude stays unreachable and is refused with the rig command.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const NAME = 'claude-3f9a0c1d2e4b';

const cfgDir = tempDir('tgctl-hostpty-');
// A short socket dir: a unix socket path is limited to 104 bytes on Darwin.
const sockDir = tempDir('tgh-', { short: true });
const socketPath = join(sockDir, `${NAME}@testhost`);
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');

// The wrapper's record.
mkdirSync(join(cfgDir, 'hosts'), { mode: 0o700 });
writeFileSync(
  join(cfgDir, 'hosts', `${NAME}.json`),
  JSON.stringify({
    v: 1,
    name: NAME,
    harness: 'claude',
    label: 'landing',
    cwd: '/Users/u/work/landing',
    socket: socketPath,
    serverPid: 41000,
    harnessPid: 41002,
    role: 'coordinator',
    startedAt: '2026-09-30T21:30:00Z',
    updatedAt: '2026-09-30T21:30:00Z',
  }),
  { mode: 0o600 },
);
// A route the hosted claude left behind with `tg` (origin host:<name>) — the target of a reply.
const OUTBOUND_ID = 500;
writeFileSync(
  join(cfgDir, 'tg-ctl.123.routes.json'),
  JSON.stringify([{ id: OUTBOUND_ID, paneId: `host:${NAME}`, cwd: '/Users/u/work/landing', ts: Math.floor(Date.now() / 1000) }]),
);

const binDir = join(cfgDir, 'bin');
mkdirSync(binDir);
writeFileSync(join(binDir, 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });
writeFileSync(
  join(binDir, 'ps'),
  `#!/bin/sh
case "$*" in
  *tty*)
    printf '    1 ??\\n'
    printf '41002 ttys010\\n'
    printf ' 7103 ttys004\\n'
    ;;
  *)
    printf '    1     0 /sbin/launchd\\n'
    printf '41000     1 abduco -n ${NAME} rig host-run ${NAME}\\n'
    printf '41001 41000 /opt/homebrew/bin/python3 /Users/u/bin/rig host-run ${NAME}\\n'
    printf '41002 41001 /Users/u/.local/bin/claude --name landing\\n'
    printf ' 6001     1 -zsh\\n'
    printf ' 7103  6001 claude --name stray\\n'
    ;;
esac
exit 0
`,
  { mode: 0o755 },
);
writeFileSync(
  join(binDir, 'lsof'),
  `#!/bin/sh
pid=""
while [ $# -gt 0 ]; do [ "$1" = "-p" ] && pid="$2"; shift; done
case "$pid" in
  41002) printf 'p41002\\nfcwd\\nn/Users/u/work/landing\\n' ;;
  7103) printf 'p7103\\nfcwd\\nn/Users/u/work/stray\\n' ;;
esac
exit 0
`,
  { mode: 0o755 },
);

// --- the abduco stand-in: one entry per client connection, the packets it sent ---
interface Packet {
  type: number;
  payload: Buffer;
}
const connections: Packet[][] = [];
function decode(buf: Buffer): Packet[] {
  const out: Packet[] = [];
  for (let off = 0; off < buf.length; ) {
    const len = Number(buf.readBigUInt64LE(off + 8));
    out.push({ type: buf.readUInt32LE(off), payload: buf.subarray(off + 16, off + 16 + len) });
    off += 16 + len;
  }
  return out;
}
const abduco = Bun.listen<{ chunks: Buffer[] }>({
  unix: socketPath,
  socket: {
    open(sock) {
      sock.data = { chunks: [] };
    },
    data(sock, data) {
      sock.data.chunks.push(Buffer.from(data));
    },
    close(sock) {
      connections.push(decode(Buffer.concat(sock.data.chunks)));
    },
  },
});
// What was typed per connection: the MSG_CONTENT payloads, in order, joined.
const typed = (): string[] =>
  connections.map((c) =>
    c
      .filter((p) => p.type === 0)
      .map((p) => p.payload.toString('utf8'))
      .join(''),
  );

const sentMessages: Array<Record<string, unknown>> = [];
const editedMessages: Array<Record<string, unknown>> = [];
let served = false;
let servedArmed = false;
const nowSec = (): number => Math.floor(Date.now() / 1000);
const msg = (message_id: number, text: string, replyTo?: number) => ({
  update_id: 900 + message_id,
  message: {
    message_id,
    from: { id: 1, first_name: 'Alex' },
    chat: { id: 1 },
    date: nowSec(),
    text,
    ...(replyTo ? { reply_to_message: { message_id: replyTo, date: nowSec(), chat: { id: 1 }, text: 'report' } } : {}),
  },
});
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/getUpdates')) {
      if (!served) {
        served = true;
        return Response.json({
          ok: true,
          result: [
            msg(10, '/agent landing deploy now'),
            msg(11, 'sole hosted session, plain text'),
            msg(12, 'replying to the hosted claude', OUTBOUND_ID),
            msg(13, '/agent stray hello'),
            // `/agent landing` alone ARMS a one-shot route to the hosted session; the next
            // ordinary message is delivered through it (injectIntoSelectedAgent, not auto-bind).
            msg(14, '/agent landing'),
            // Telegram redelivers message 10 under a NEW update id: it must not be typed twice.
            { ...msg(10, '/agent landing deploy now'), update_id: 990 },
          ],
        });
      }
      // updates are handled concurrently: the follow-up is sent once the arming card is out
      if (!servedArmed && sentMessages.some((m) => String(m.text).startsWith('selected landing'))) {
        servedArmed = true;
        await Bun.sleep(300);
        return Response.json({ ok: true, result: [msg(15, 'follow-up through the armed route')] });
      }
      await Bun.sleep(80);
      return Response.json({ ok: true, result: [] });
    }
    if (url.pathname.endsWith('/sendMessage')) {
      sentMessages.push((await req.json()) as Record<string, unknown>);
      return Response.json({ ok: true, result: { message_id: 7000 + sentMessages.length } });
    }
    if (url.pathname.endsWith('/editMessageText')) {
      editedMessages.push((await req.json()) as Record<string, unknown>);
      return Response.json({ ok: true, result: { message_id: 1 } });
    }
    return Response.json({ ok: true, result: {} });
  },
});

const reg = createDaemonRegistry();
afterAll(async () => {
  await reapDaemons(reg);
  server.stop(true);
  abduco.stop(true);
});
const env = { PATH: `${binDir}:${process.env.PATH ?? ''}`, HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}` };
const texts = (): string[] => sentMessages.map((m) => String(m.text));

// The daemon is a real subprocess (no in-process clock to fake): poll for the observable
// condition, bounded, instead of guessing a duration.
async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await Bun.sleep(50);
  }
  return pred();
}

beforeAll(async () => {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'w');
  await spawnDaemon(reg, { tgCtlPath: TG_CTL, cfgDir, env, logFd });
  closeSync(logFd);
});

test('a hosted Claude Code receives /agent, a plain message and a reply through its PTY — each exactly once', async () => {
  expect(await until(() => connections.length >= 4 && texts().some((t) => t.includes('Restart it with')), 20_000)).toBe(true);
  // let a (wrongly) repeated delivery of the replayed message 10 arrive before asserting its absence
  await Bun.sleep(1500);

  const lines = typed();
  expect(lines).toHaveLength(4);
  // one connection = attach, the typed line, the separate Enter, detach
  for (const c of connections) expect(c.map((p) => p.type)).toEqual([1, 0, 0, 2]);
  expect(lines[0]).toContain('deploy now');
  expect(lines[0]).toContain('tg#10');
  expect(lines.filter((l) => l.includes('deploy now'))).toHaveLength(1);
  expect(lines.some((l) => l.includes('sole hosted session, plain text') && l.includes('tg#11'))).toBe(true);
  expect(lines.some((l) => l.includes('replying to the hosted claude') && l.includes('tg#12'))).toBe(true);
  for (const c of connections) expect(c[2].payload.toString()).toBe('\r');
  // the armed one-shot route: typed once, and the selection card was edited to "→ <label>"
  expect(lines.filter((l) => l.includes('follow-up through the armed route') && l.includes('tg#15'))).toHaveLength(1);
  expect(editedMessages.some((m) => String(m.text).startsWith('→ landing'))).toBe(true);

  // The ledger: delivered once per message to host:<name>, and the redelivery suppressed.
  const ledger = readFileSync(join(cfgDir, 'tg-ctl.123.delivery.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { event: string; msg?: number; target?: string });
  for (const id of [10, 11, 12, 15]) {
    const events = ledger.filter((e) => e.msg === id && e.target === `host:${NAME}`).map((e) => e.event);
    expect(events.filter((e) => e === 'delivered')).toHaveLength(1);
  }
  expect(ledger.some((e) => e.event === 'duplicate' && e.msg === 10)).toBe(true);
}, 40_000);

test('an unhosted claude outside tmux is refused with the rig command, not typed into; the hosted one is not listed unreachable', async () => {
  const refusal = texts().find((t) => t.includes('stray · claude runs outside tmux'));
  expect(refusal).toBeDefined();
  expect(refusal!.endsWith('Restart it with: rig harness run claude --name stray (or in a tmux window)')).toBe(true);
  expect(refusal).not.toContain('claude-rotate');

  const status = Bun.spawnSync([process.execPath, TG_CTL, 'status'], { env, stdout: 'pipe', stderr: 'pipe' }).stdout.toString();
  expect(status).toContain('hosted (abduco, outside tmux): 1');
  expect(status).toContain(`landing · claude — abduco ${NAME}`);
  expect(status).toContain('unreachable (outside tmux and the rig wrapper): 1');
  expect(status).toContain('stray · claude — unreachable');
  expect(status).not.toContain('landing · claude — unreachable');
}, 30_000);
