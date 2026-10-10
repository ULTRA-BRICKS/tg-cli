import { afterAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';

// tg-cli#481 follow-up: every tmux call the daemon makes is a Bun.spawnSync on its ONE event loop
// — the Telegram poll, the hook socket and button taps all wait while it runs. A wedged tmux
// server must cost a bounded delay, never a stalled daemon. The REAL `tg-ctl run` runs against a
// fake Telegram and a tmux/ps shim with ONE live claude pane; one tmux subcommand hangs. The
// daemon must type the message, give up on the hung call within its bound and poll Telegram
// again — and a hung TYPING call must be recorded `uncertain` (the keys may have landed), never
// `failed`, so a replay can never type the message twice.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const PANE_ID = '%2';
const PANE_PID = 2002;
// The tmux write bound is 5 s and a read probe 2 s (features/util/spawn-timeout.ts); the
// remainder is settle sleeps and one poll round-trip.
const RESPONSIVE_BOUND_MS = 9000;

const reg = createDaemonRegistry();
const servers: Array<{ stop: (closeActiveConnections?: boolean) => void }> = [];

afterAll(async () => {
  await reapDaemons(reg);
  for (const s of servers.splice(0)) s.stop(true);
});

type HangOn = 'capture-pane' | 'send-keys-text' | 'load-buffer';

// list-panes reports the claude pane; `hangOn` records the call and then hangs. Every
// other subcommand succeeds silently.
function writeShim(shimDir: string, callLog: string, cwd: string, hangOn: HangOn): void {
  mkdirSync(shimDir, { recursive: true });
  const hangTest = {
    'capture-pane': '[ "$sub" = "capture-pane" ]',
    'send-keys-text': '[ "$sub" = "send-keys" ] && [ "$has_literal" = "1" ]',
    'load-buffer': '[ "$sub" = "load-buffer" ]',
  }[hangOn];
  writeFileSync(
    join(shimDir, 'tmux'),
    `#!/bin/sh
sub="$1"
has_literal=0
for a in "$@"; do [ "$a" = "-l" ] && has_literal=1; done
printf '%s\\n' "$*" >> '${callLog}'
if ${hangTest}; then exec sleep 30; fi
case "$sub" in
  list-panes)
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '${PANE_ID}' '${PANE_PID}' 'claude' 'w' '${cwd}'
    ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(join(shimDir, 'ps'), `#!/bin/sh\nprintf '%s %s %s\\n' '${PANE_PID}' '1' 'claude'\nexit 0\n`, {
    mode: 0o755,
  });
}

async function runWithHang(
  hangOn: HangOn,
): Promise<{ callLog: string; ledger: string; daemonLog: string; pollGapMs: number | null; notices: string[] }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-bounded-cfg-'));
  const paneCwd = mkdtempSync(join(tmpdir(), 'tgctl-bounded-cwd-')); // not a git repo: no banner
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  const shimDir = join(cfgDir, 'bin');
  const callLog = join(cfgDir, 'tmux.calls');
  writeFileSync(callLog, '');
  writeShim(shimDir, callLog, paneCwd, hangOn);

  // The first poll that comes AFTER the update was handed out proves the tick that
  // delivered it finished.
  let servedAt: number | null = null;
  let nextPollAt: number | null = null;
  const notices: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (servedAt === null) {
          servedAt = Date.now();
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 700,
                // A multi-line message is typed through load-buffer + paste-buffer, a single line through send-keys -l.
                message: { message_id: 1, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text: hangOn === 'load-buffer' ? 'check\nthe build' : 'check the build' },
              },
            ],
          });
        }
        nextPollAt ??= Date.now();
        // Long-poll stand-in: hold an empty answer briefly so the daemon does not spin.
        await Bun.sleep(500);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body: unknown = await req.json();
        if (body && typeof body === 'object' && 'text' in body) notices.push(String(body.text));
        return Response.json({ ok: true, result: { message_id: 900 } });
      }
      if (req.method === 'POST') await req.text();
      return Response.json({ ok: true, result: true });
    },
  });
  servers.push(server);

  const daemonLogPath = join(cfgDir, 'daemon.log');
  const logFd = openSync(daemonLogPath, 'w');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    logFd,
    env: {
      PATH: `${shimDir}:${process.env.PATH ?? ''}`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
    },
  });
  closeSync(logFd);

  // Real-clock deadline, not a guessed wait: the loop exits the moment the daemon polls
  // again. The behavior under test is a child process's wall-clock hang.
  const deadline = Date.now() + RESPONSIVE_BOUND_MS * 2;
  while (Date.now() < deadline && nextPollAt === null) await Bun.sleep(100);

  daemon.kill('SIGTERM');
  await Promise.race([daemon.exited, Bun.sleep(4000)]);

  const ledgerPath = join(cfgDir, 'tg-ctl.123.delivery.jsonl');
  return {
    callLog: readFileSync(callLog, 'utf8'),
    ledger: existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : '',
    daemonLog: readFileSync(daemonLogPath, 'utf8'),
    pollGapMs: servedAt !== null && nextPollAt !== null ? nextPollAt - servedAt : null,
    notices,
  };
}

test('a hung `tmux capture-pane` in the submit check does not stall the daemon; the message counts as delivered', async () => {
  const res = await runWithHang('capture-pane');
  expect(res.callLog).toContain(`send-keys -t ${PANE_ID} -l`);
  expect(res.callLog).toContain('capture-pane');
  expect(res.pollGapMs).not.toBeNull();
  expect(res.pollGapMs!).toBeLessThan(RESPONSIVE_BOUND_MS);
  // An unreadable box is "submission not verified", the same as a missing tmux.
  expect(res.ledger).toContain('"event":"delivered"');
  // A wedged tmux shows up in the daemon log, named by its subcommand.
  expect(res.daemonLog).toContain('tmux capture-pane: no answer within 2000ms');
}, 40_000);

test('a hung `tmux send-keys -l` does not stall the daemon and is recorded uncertain, never failed', async () => {
  const res = await runWithHang('send-keys-text');
  expect(res.callLog).toContain(`send-keys -t ${PANE_ID} -l`);
  expect(res.pollGapMs).not.toBeNull();
  expect(res.pollGapMs!).toBeLessThan(RESPONSIVE_BOUND_MS);
  expect(res.ledger).toContain('"event":"uncertain"');
  expect(res.ledger).not.toContain('"event":"failed"');
  // The CTO hears that it may or may not have arrived — not an invitation to resend.
  expect(res.notices.some((n) => n.includes('may or may not have reached the pane'))).toBe(true);
}, 40_000);

// load-buffer only fills a tmux buffer; nothing reaches the pane until paste-buffer runs. A
// hung one proves the message did not arrive, so it is a plain failure — resendable — not uncertain.
test('a hung `tmux load-buffer` (multi-line message) is a plain failure: nothing reached the pane', async () => {
  const res = await runWithHang('load-buffer');
  expect(res.callLog).toContain('load-buffer -');
  expect(res.callLog).not.toContain('paste-buffer');
  expect(res.pollGapMs).not.toBeNull();
  expect(res.pollGapMs!).toBeLessThan(RESPONSIVE_BOUND_MS);
  expect(res.ledger).toContain('"event":"failed"');
  expect(res.ledger).not.toContain('"event":"uncertain"');
}, 40_000);
