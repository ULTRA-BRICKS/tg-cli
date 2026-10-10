// The daemon's agent discovery (tmux list-panes, ps, one lsof per out-of-tmux omp) must never
// hold the single event-loop thread (tg-cli#547, tg-cli#537): a hook-socket ask and a tap on a
// question card are the user's only way to unblock an agent, and they must not queue behind a
// scan whose result the idle exit needs only at minute granularity.
//
// The host's ps/lsof are replaced by shims that sleep before answering (a busy machine with many
// live omp sessions, compressed), and the fake Telegram answers getUpdates at once, so the poll
// loop ticks as fast as the daemon lets it. A scan that blocks the event loop shows up as an ask
// or a callback answer that takes as long as the shims sleep.
import { afterAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon, trackProc } from './helpers/daemon-lifecycle';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
// How long each ps/lsof shim call sleeps while "slow". Every bound below sits well under it, so a
// scan running on the event loop cannot pass by luck.
const SLOW_SEC = 2.5;
const BOUND_MS = 1500;

const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-discovery-nonblocking-'));
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: cfgDir }));
const bin = join(cfgDir, 'bin');
mkdirSync(bin);
const delayFile = join(cfgDir, 'shim-delay');
const callLog = join(cfgDir, 'shim-calls.log');
writeFileSync(delayFile, '0');
// No tmux server: every agent is out of tmux, so discovery takes the ps + lsof paths.
writeFileSync(join(bin, 'tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
// One interactive omp (pid 999999 — never a real process, so /proc/<pid>/cwd misses and the
// cwd comes from lsof, like on macOS) with a tty, so the live-omp scan pays its per-agent lsof.
writeFileSync(
  join(bin, 'ps'),
  `#!/bin/sh
echo "ps $* $(date +%s%N)" >> '${callLog}'
sleep "$(cat '${delayFile}')"
case "$*" in
  *tty=*) printf '    1 ?\\n999999 pts/7\\n' ;;
  *etime=*) printf '999999 01:00\\n' ;;
  *) printf '    1     0 /sbin/init\\n999999     1 omp\\n' ;;
esac
`,
  { mode: 0o755 },
);
writeFileSync(
  join(bin, 'lsof'),
  `#!/bin/sh
echo "lsof $* $(date +%s%N)" >> '${callLog}'
sleep "$(cat '${delayFile}')"
exit 1
`,
  { mode: 0o755 },
);

let getUpdatesCalls = 0;
let callbackData: string | null = null;
let callbackServedAt: number | null = null;
let cardPostedAt: number | null = null;
let callbackAnsweredAt: number | null = null;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/getUpdates')) {
      getUpdatesCalls++;
      if (callbackData && callbackServedAt === null) {
        callbackServedAt = Date.now();
        return Response.json({
          ok: true,
          result: [
            {
              update_id: 300,
              callback_query: {
                id: 'cb-slow',
                from: { id: 1, first_name: 'Alex' },
                message: { message_id: 77, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) },
                data: callbackData,
              },
            },
          ],
        });
      }
      // Answer at once: the poll loop ticks as fast as the daemon lets it.
      return Response.json({ ok: true, result: [] });
    }
    if (url.pathname.endsWith('/sendMessage')) {
      const body = await req.json();
      if (body.reply_markup?.inline_keyboard) {
        cardPostedAt = Date.now();
        callbackData = body.reply_markup.inline_keyboard[0][0].callback_data;
      }
      return Response.json({ ok: true, result: { message_id: 77 } });
    }
    if (url.pathname.endsWith('/answerCallbackQuery')) {
      callbackAnsweredAt = Date.now();
      return Response.json({ ok: true, result: true });
    }
    return Response.json({ ok: true, result: true });
  },
});

const reg = createDaemonRegistry();

afterAll(async () => {
  await reapDaemons(reg);
  server.stop(true);
});

function shimCalls(): string[] {
  return existsSync(callLog) ? readFileSync(callLog, 'utf8').split('\n').filter(Boolean) : [];
}

// Polls a condition another process makes true (the daemon, the fake Telegram); there is no
// in-process event to await across the process boundary.
async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await Bun.sleep(20);
  }
  return cond();
}

const env = {
  PATH: `${bin}:${process.env.PATH ?? ''}`,
  HOME: cfgDir,
  TG_CTL_CONFIG_DIR: cfgDir,
  TG_API_BASE: `http://127.0.0.1:${server.port}`,
  // The idle-liveness scan interval, shortened so a scan starts within the test's patience.
  TG_CTL_LIVENESS_SCAN_MS: '3000',
};

test('the poll loop scans for agents at most once per interval, not once per getUpdates (tg-cli#547)', async () => {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  await spawnDaemon(reg, { tgCtlPath: TG_CTL, cfgDir, env, logFd });
  closeSync(logFd);
  expect(existsSync(join(cfgDir, 'tg-ctl.123.sock'))).toBe(true);
  // Fast shims here: count scans, not their cost. Let the startup work settle first.
  expect(await waitFor(() => getUpdatesCalls >= 3, 5000)).toBe(true);
  const ticksBefore = getUpdatesCalls;
  const callsBefore = shimCalls().length;
  // A real-time window on purpose: the property is "scans per wall-clock interval" of a separate
  // daemon process, which fake timers in this process cannot drive.
  await Bun.sleep(2000);
  const ticks = getUpdatesCalls - ticksBefore;
  const scans = shimCalls().slice(callsBefore).filter((l) => l.startsWith('ps -axo pid=,ppid=,command='));
  // Enough ticks that a per-tick scan could not hide under the bound below, even on a slow host.
  expect(ticks).toBeGreaterThanOrEqual(5);
  // A per-tick scan would run the full process-table read on every one of those ticks.
  expect(scans.length).toBeLessThanOrEqual(2);
}, 20_000);

test('a hook-socket ask and a question-card tap are answered while a slow discovery scan is in flight (tg-cli#547, tg-cli#537)', async () => {
  writeFileSync(delayFile, String(SLOW_SEC));
  // Ask the moment a slow scan has STARTED (a shim logged its call): the daemon is mid-scan.
  const callsBefore = shimCalls().length;
  expect(await waitFor(() => shimCalls().length > callsBefore, 15_000)).toBe(true);
  const askStartedAt = Date.now();
  const ask = trackProc(
    reg,
    Bun.spawn([process.execPath, TG_CTL, 'ask'], { env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }),
  );
  ask.stdin.write(
    JSON.stringify({
      requestId: 'q_slow',
      cwd: cfgDir,
      agent: 'claude',
      kind: 'question',
      title: 'Deploy',
      question: 'Where should I deploy?',
      options: [{ label: 'Staging' }, { label: 'Production' }],
    }) + '\n',
  );
  ask.stdin.end();

  await waitFor(() => cardPostedAt !== null, 30_000);
  const askRoundTripMs = (cardPostedAt ?? Infinity) - askStartedAt;
  await waitFor(() => callbackAnsweredAt !== null, 30_000);
  const tapAnswerMs = (callbackAnsweredAt ?? Infinity) - (callbackServedAt ?? 0);
  expect(askRoundTripMs).toBeLessThan(BOUND_MS);
  expect(tapAnswerMs).toBeLessThan(BOUND_MS);
  const stdout = await new Response(ask.stdout).text();
  await ask.exited;
  expect(JSON.parse(stdout).hookSpecificOutput.updatedInput.answers).toEqual({ 'Where should I deploy?': 'Staging' });
}, 90_000);
