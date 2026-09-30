import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';

// Integration test (tg-cli#306): an interactive claude that runs OUTSIDE tmux (a tty,
// no pane) is not silently invisible. `/agent landing <msg>` with NO tmux candidate
// must (1) queue the wrapped message to that agent's Stop-hook inbox on disk and
// (2) reply with an explicit "outside tmux — queued" text; a plain message that
// finds no pane must LIST the unreachable agent instead of the bare guard text.
// tmux / ps / lsof are PATH-shimmed with a fake process table.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-unreachable-'));
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');

const binDir = join(cfgDir, 'bin');
mkdirSync(binDir);
// No tmux panes at all.
writeFileSync(join(binDir, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
// ps: the 3-column tree read AND the 2-column `pid tty` read, keyed off argv.
writeFileSync(
  join(binDir, 'ps'),
  `#!/bin/sh
case "$*" in
  *tty*)
    printf '    1 ??\\n'
    printf ' 6001 ttys004\\n'
    printf ' 7103 ttys004\\n'
    printf ' 8000 ??\\n'
    ;;
  *)
    printf '    1     0 /sbin/launchd\\n'
    printf ' 6001     1 -zsh\\n'
    printf ' 7103  6001 claude --permission-mode bypassPermissions --name landing\\n'
    printf ' 8000     1 /Users/u/.local/bin/claude --print --output-format text\\n'
    ;;
esac
exit 0
`,
  { mode: 0o755 },
);
writeFileSync(join(binDir, 'lsof'), "#!/bin/sh\nprintf 'p7103\\nfcwd\\nn/Users/u/work/landing\\n'\nexit 0\n", { mode: 0o755 });

const sentMessages: Array<Record<string, unknown>> = [];
const reactions: Array<Record<string, unknown>> = [];
let served = 0;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/getUpdates')) {
      const offset = Number(url.searchParams.get('offset') ?? '0');
      if (offset <= 100 && served === 0) {
        served = 1;
        return Response.json({
          ok: true,
          result: [
            { update_id: 100, message: { message_id: 10, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: 1, text: '/agent landing deploy now' } },
            { update_id: 101, message: { message_id: 11, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: 1, text: 'plain message, nobody in tmux' } },
          ],
        });
      }
      await Bun.sleep(80);
      return Response.json({ ok: true, result: [] });
    }
    if (url.pathname.endsWith('/sendMessage')) {
      sentMessages.push((await req.json()) as Record<string, unknown>);
      return Response.json({ ok: true, result: { message_id: 77 } });
    }
    if (url.pathname.endsWith('/setMessageReaction')) {
      const body = (await req.json()) as Record<string, unknown>;
      reactions.push(body);
      // First attempt: a transient 5xx — the batch must be KEPT and retried, not discarded.
      if (reactions.length === 1) return new Response('{"ok":false,"description":"boom"}', { status: 502 });
      return Response.json({ ok: true, result: true });
    }
    return Response.json({ ok: true, result: {} });
  },
});

const reg = createDaemonRegistry();
afterAll(async () => {
  await reapDaemons(reg);
  server.stop(true);
});

test('/agent <name> to an agent outside tmux queues to its inbox and replies explicitly; plain no-agent lists it', async () => {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'w');
  await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: { PATH: `${binDir}:${process.env.PATH ?? ''}`, HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}` },
    logFd,
  });
  closeSync(logFd);

  const t0 = Date.now();
  while (Date.now() - t0 < 10_000 && sentMessages.length < 2) await Bun.sleep(100);

  // The no-agent listing for tg#11 explains the inbox too; both replies race, so match the
  // reply to tg#10 by its own wording, not by list order.
  const queuedReply = sentMessages.find((m) => String(m.text).includes('— queued to its Stop-hook inbox'));
  expect(queuedReply?.text).toContain('landing is running outside tmux (tty ttys004, cwd /Users/u/work/landing)');

  const pending = join(cfgDir, 'inbox', 'landing', 'pending.jsonl');
  expect(existsSync(pending)).toBe(true);
  const entries = readFileSync(pending, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ id: 10, from: 'Alex', text: 'deploy now' });
  expect(entries[0].wrapped).toContain('tg#10');
  expect(entries[0].wrapped).toContain('deploy now');

  const listing = sentMessages.find((m) => String(m.text).includes('OUTSIDE tmux'));
  expect(listing?.text).toContain('landing · claude — unreachable: not in tmux (tty ttys004, cwd /Users/u/work/landing, name landing, pid 7103)');
  // the legacy bare guard text never went out on its own
  expect(sentMessages.some((m) => String(m.text).startsWith('Claude Code not in tmux'))).toBe(false);

  // Private: the inbox holds the user's Telegram text — dirs 0700, files 0600.
  const inboxDir = join(cfgDir, 'inbox', 'landing');
  expect(statSync(join(cfgDir, 'inbox')).mode & 0o777).toBe(0o700);
  expect(statSync(inboxDir).mode & 0o777).toBe(0o700);
  expect(statSync(pending).mode & 0o777).toBe(0o600);

  // The Stop hook publishes a complete delivered batch (temp + rename) → the daemon reacts
  // 👌 on tg#10, archives it to acked.jsonl and removes the batch. The mock fails the
  // first reaction with a 502: the batch must survive that and be retried.
  const batch = join(inboxDir, 'delivered-1-1-ab.jsonl');
  const record = JSON.stringify({ ...entries[0], delivered_ts: 't', session_id: 's' });
  writeFileSync(`${batch}.tmp`, `${record}\n`);
  renameSync(`${batch}.tmp`, batch);
  const t1 = Date.now();
  while (Date.now() - t1 < 10_000 && existsSync(batch)) await Bun.sleep(100);
  expect(existsSync(batch)).toBe(false);
  expect(reactions.length).toBeGreaterThanOrEqual(2);
  expect(reactions.every((r) => r.message_id === 10)).toBe(true);
  expect(readFileSync(join(inboxDir, 'acked.jsonl'), 'utf8')).toContain('"delivered_ts":"t"');
}, 25_000);
