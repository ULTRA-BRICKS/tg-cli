// A picker button for a rig-wrapper host that exited AFTER the picker was posted: the tap must
// not type into anything. The daemon re-verifies the host against a fresh process table inside
// the delivery claim and answers that it is no longer running; the surviving host is untouched.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const HOSTS = [
  { name: 'claude-aaaa00000001', label: 'alpha', serverPid: 41000, harnessPid: 41002 },
  { name: 'claude-bbbb00000002', label: 'beta', serverPid: 42000, harnessPid: 42002 },
] as const;

const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-stalepick-'));
// A short socket dir: a unix socket path is limited to 104 bytes on Darwin.
const sockDir = mkdtempSync('/tmp/tgs-');
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n  git_state_banner: false\n');
mkdirSync(join(cfgDir, 'hosts'), { mode: 0o700 });

// Connections each host's abduco stand-in accepted: any typing would open one.
const connectionsPerHost = new Map<string, number>();
const listeners: Array<{ stop(force?: boolean): void }> = [];
for (const h of HOSTS) {
  const socket = join(sockDir, `${h.name}@testhost`);
  writeFileSync(
    join(cfgDir, 'hosts', `${h.name}.json`),
    JSON.stringify({
      v: 1, name: h.name, harness: 'claude', label: h.label, cwd: `/work/${h.label}`, socket,
      serverPid: h.serverPid, harnessPid: h.harnessPid, role: 'coordinator',
      startedAt: '2026-09-30T21:30:00Z', updatedAt: '2026-09-30T21:30:00Z',
    }),
    { mode: 0o600 },
  );
  connectionsPerHost.set(h.name, 0);
  listeners.push(
    Bun.listen({
      unix: socket,
      socket: { open: () => connectionsPerHost.set(h.name, (connectionsPerHost.get(h.name) ?? 0) + 1), data() {}, close() {} },
    }),
  );
}

// The process table is a file the `ps` shim prints, so the test can make a host vanish.
const treeFile = join(cfgDir, 'ps-tree.txt');
const tree = (hosts: readonly (typeof HOSTS)[number][]): string =>
  '    1     0 /sbin/launchd\n' +
  hosts
    .map(
      (h) =>
        `${h.serverPid}     1 abduco -n ${h.name} rig host-run ${h.name}\n` +
        `${h.serverPid + 1} ${h.serverPid} /usr/bin/python3 rig host-run ${h.name}\n` +
        `${h.harnessPid} ${h.serverPid + 1} /Users/u/.local/bin/claude --name ${h.label}\n`,
    )
    .join('');
writeFileSync(treeFile, tree(HOSTS));
const binDir = join(cfgDir, 'bin');
mkdirSync(binDir);
writeFileSync(join(binDir, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
writeFileSync(join(binDir, 'ps'), `#!/bin/sh\ncase "$*" in *tty*) printf '    1 ??\\n';; *) cat '${treeFile}';; esac\nexit 0\n`, { mode: 0o755 });
writeFileSync(join(binDir, 'lsof'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

interface SentMessage {
  text?: unknown;
  reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> };
}
const sent: SentMessage[] = [];
const nowSec = (): number => Math.floor(Date.now() / 1000);
let phase: 'message' | 'wait-picker' | 'done' = 'message';
let tapSent = false;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/getUpdates')) {
      if (phase === 'message') {
        phase = 'wait-picker';
        return Response.json({ ok: true, result: [{ update_id: 1, message: { message_id: 10, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec(), text: 'which of you takes this' } }] });
      }
      const picker = sent.find((m) => m.reply_markup?.inline_keyboard);
      if (phase === 'wait-picker' && picker) {
        phase = 'done';
        // alpha exits after the picker is up; the tap on its button comes after that
        writeFileSync(treeFile, tree([HOSTS[1]]));
        await Bun.sleep(6000); // the daemon's process-table snapshot is cached for a few seconds
        const buttons = (picker.reply_markup?.inline_keyboard ?? []).flat();
        const alpha = buttons.find((b) => b.text.includes('alpha'));
        if (!alpha) throw new Error(`no alpha button in ${JSON.stringify(buttons)}`);
        tapSent = true;
        return Response.json({
          ok: true,
          result: [{ update_id: 2, callback_query: { id: 'cb1', from: { id: 1, first_name: 'Alex' }, message: { message_id: 7001, chat: { id: 1 }, date: nowSec() }, data: alpha.callback_data } }],
        });
      }
      await Bun.sleep(80);
      return Response.json({ ok: true, result: [] });
    }
    if (url.pathname.endsWith('/sendMessage')) {
      sent.push((await req.json()) as SentMessage);
      return Response.json({ ok: true, result: { message_id: 7000 + sent.length } });
    }
    return Response.json({ ok: true, result: {} });
  },
});

const reg = createDaemonRegistry();
afterAll(async () => {
  await reapDaemons(reg);
  server.stop(true);
  for (const l of listeners) l.stop(true);
});
beforeAll(async () => {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'w');
  await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    logFd,
    env: { PATH: `${binDir}:${process.env.PATH ?? ''}`, HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}` },
  });
  closeSync(logFd);
});

// The daemon is a real subprocess: poll for the observable condition, bounded.
async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms && !pred()) await Bun.sleep(50);
  return pred();
}

test('a tap on the picker button of a host that has since exited reports it gone and types into nobody', async () => {
  expect(await until(() => tapSent && sent.some((m) => String(m.text).includes('no longer running under the rig wrapper')), 40_000)).toBe(true);
  await Bun.sleep(500);
  expect(connectionsPerHost.get(HOSTS[0].name)).toBe(0);
  expect(connectionsPerHost.get(HOSTS[1].name)).toBe(0);
}, 60_000);
