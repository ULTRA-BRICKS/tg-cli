import { afterAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { tempDir } from './helpers/test-temp';

// tg-cli#463 end to end through the real daemon: a Telegram message is typed into a
// claude pane, its Enter is lost, and the daemon must retry Enter once and — if the
// text is still in the input box — tell the CTO in the chat instead of staying silent.
// The pane is a fake tmux whose capture-pane draws a Claude Code 2.1 input box from
// what send-keys typed; its first `drops` Enters are lost. `reuse` hands the pane to a
// NEW claude process (pid 6001) right after the first Enter or the first capture.
// `second`: a second message for the same pane arrives in the same batch.
// `lockHeldMs`: another process (this test, pid alive) holds the pane's typing lock that long.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const reg = createDaemonRegistry();
const servers: Array<{ stop: (force?: boolean) => void }> = [];

afterAll(async () => {
  await reapDaemons(reg);
  for (const s of servers) s.stop(true);
});

// The unsubmitted report names the pane and agent and quotes the typed message.
const isReport = (text: string): boolean => text.includes('pane %5001 (claude)') && text.includes('tg#4242] deploy now');

type Reuse = 'none' | 'after-enter' | 'after-capture';

async function deliverWithLostEnters(
  drops: number,
  reuse: Reuse = 'none',
  second = false,
  lockHeldMs = 0,
): Promise<{ enters: number; captures: number; box: string; sent: string[]; seen: boolean; boxAtType: string[]; typedWhileLocked: boolean }> {
  const cfgDir = tempDir('tgctl-submit-check-');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: cfgDir }));
  const binDir = join(cfgDir, 'bin');
  mkdirSync(binDir);
  const boxFile = join(cfgDir, 'box.txt');
  const entersFile = join(cfgDir, 'enters.txt');
  const capturesFile = join(cfgDir, 'captures.txt');
  const boxAtTypeFile = join(cfgDir, 'box-at-type.txt');
  const panePidFile = join(cfgDir, 'pane-pid.txt');
  const reuseOnEnter = reuse === 'after-enter' ? `echo 6001 > '${panePidFile}'` : ':';
  const reuseOnCapture = reuse === 'after-capture' ? `echo 6001 > '${panePidFile}'` : ':';
  writeFileSync(
    join(binDir, 'tmux'),
    `#!/bin/sh
case "$*" in
  *list-panes*) printf '4\\t0\\t%%5001\\t%s\\tnode\\trig\\t/Users/u/xp/rig\\n' "$(cat '${panePidFile}' 2>/dev/null || echo 5001)"; exit 0 ;;
esac
case "$1" in
  send-keys)
    prev=""; lit=""; last=""
    for a in "$@"; do [ "$prev" = "-l" ] && lit="$a"; prev="$a"; last="$a"; done
    if [ -n "$lit" ]; then printf '[%s]\\n' "$(cat '${boxFile}' 2>/dev/null)" >> '${boxAtTypeFile}'; printf '%s' "$lit" >> '${boxFile}'
    elif [ "$last" = "Enter" ]; then
      echo Enter >> '${entersFile}'
      ${reuseOnEnter}
      [ "$(wc -l < '${entersFile}')" -gt ${drops} ] && : > '${boxFile}'
    fi ;;
  capture-pane)
    echo capture >> '${capturesFile}'
    printf '❯ earlier message\\n\\n────────────────────────────────\\n❯ %s\\n────────────────────────────────\\n  ⏵⏵ auto mode on\\n' "$(cat '${boxFile}' 2>/dev/null)"
    ${reuseOnCapture} ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(join(binDir, 'ps'), `#!/bin/sh\nprintf '    1     0 /sbin/launchd\\n'\nprintf ' 5001     1 claude --resume\\n'\nprintf ' 6001     1 claude\\n'\n`, { mode: 0o755 });

  const sent: string[] = [];
  const reactedTo: unknown[] = [];
  let served = false;
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
              { update_id: 100, message: { message_id: 4242, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: Math.floor(Date.now() / 1000), text: '/agent rig deploy now' } },
              ...(second ? [{ update_id: 101, message: { message_id: 4243, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: Math.floor(Date.now() / 1000), text: '/agent rig deploy later' } }] : []),
            ],
          });
        }
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body: unknown = await req.json();
        sent.push(body && typeof body === 'object' && 'text' in body ? String(body.text) : '');
        return Response.json({ ok: true, result: { message_id: 77 } });
      }
      if (url.pathname.endsWith('/setMessageReaction')) {
        const body: unknown = await req.json();
        if (body && typeof body === 'object' && 'message_id' in body) reactedTo.push(body.message_id);
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: true, result: true });
    },
  });
  servers.push(server);

  let typedWhileLocked = false;
  if (lockHeldMs > 0) {
    const lockFile = join(cfgDir, 'pane-locks', '_5001.lock');
    mkdirSync(join(cfgDir, 'pane-locks'));
    writeFileSync(lockFile, String(process.pid));
    setTimeout(() => {
      typedWhileLocked = existsSync(boxFile);
      unlinkSync(lockFile);
    }, lockHeldMs);
  }

  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: { PATH: `${binDir}:${process.env.PATH ?? ''}`, HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}` },
    logFd,
  });
  closeSync(logFd);

  // Done when the delivery resolved either way — the receipt reaction on 4242
  // (delivered) or the unsubmitted report; both come after the plan's last Enter.
  // Polled: the daemon is a separate process with no completion signal to await.
  const tEnd = Date.now() + 12_000;
  while (Date.now() < tEnd && !(reactedTo.includes(4242) && (!second || reactedTo.includes(4243))) && !sent.some(isReport)) {
    await Bun.sleep(80);
  }
  daemon.kill('SIGTERM');
  await daemon.exited;

  const lines = (f: string): number => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').length : 0);
  const box = existsSync(boxFile) ? readFileSync(boxFile, 'utf8') : '';
  const boxAtType = existsSync(boxAtTypeFile) ? readFileSync(boxAtTypeFile, 'utf8').trim().split('\n') : [];
  return { enters: lines(entersFile), captures: lines(capturesFile), box, sent, seen: reactedTo.includes(4242), boxAtType, typedWhileLocked };
}

test('an Enter lost once is retried: the message is submitted and nothing is reported', async () => {
  const r = await deliverWithLostEnters(1);
  expect(r.enters).toBe(2);
  expect(r.box).toBe('');
  expect(r.sent.filter(isReport)).toEqual([]);
  expect(r.seen).toBe(true);
}, 30_000);

test('still typed after the retry Enter: the CTO is told in the chat, with no third Enter', async () => {
  const r = await deliverWithLostEnters(99);
  expect(r.enters).toBe(2);
  expect(r.box).toContain('deploy now');
  expect(r.sent.filter(isReport)).toHaveLength(1);
  expect(r.seen).toBe(false);
}, 30_000);

// The pane changed hands during the settle wait (an agent exited and tmux reused %N):
// the box on screen is no longer the one the text was typed into, so it is neither
// read nor sent a second Enter — that Enter would submit whatever the new agent holds.
test('pane reused before the submit check: no capture, no retry Enter, nothing reported', async () => {
  const r = await deliverWithLostEnters(99, 'after-enter');
  expect(r.captures).toBe(0);
  expect(r.enters).toBe(1);
  expect(r.sent.filter(isReport)).toEqual([]);
}, 30_000);

test('pane reused between the submit check and the retry Enter: no retry Enter, nothing reported', async () => {
  const r = await deliverWithLostEnters(99, 'after-capture');
  expect(r.captures).toBe(1);
  expect(r.enters).toBe(1);
  expect(r.sent.filter(isReport)).toEqual([]);
}, 30_000);

// Two messages for one pane in the same batch are delivered concurrently by the daemon; typed
// together, the second would land in the first's box and the retry Enter would send both as one.
test('two messages for one pane are typed one after the other, each into an empty box', async () => {
  const r = await deliverWithLostEnters(0, 'none', true);
  expect(r.boxAtType).toEqual(['[]', '[]']);
  expect(r.enters).toBe(2);
  expect(r.box).toBe('');
}, 30_000);

// auto-continue-once is a separate process: its typing and the daemon's must not interleave, so a
// pane's typing turn is also a lock file. Held by a live process, the daemon types only after it
// is released — and then delivers normally.
test('a pane whose typing lock is held by another process is typed into only after release', async () => {
  const r = await deliverWithLostEnters(0, 'none', false, 1500);
  expect(r.typedWhileLocked).toBe(false);
  expect(r.seen).toBe(true);
  expect(r.enters).toBe(1);
  expect(r.box).toBe('');
}, 30_000);
