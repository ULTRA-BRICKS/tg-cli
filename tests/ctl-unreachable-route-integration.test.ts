import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { hatchGrantNoticeText } from '../features/tg-ctl/grants';
import { agentInboxKey } from '../features/tg-ctl/unreachable';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { TMUX_NO_SERVER_SHIM } from './helpers/hermetic-host';
import { tempDir } from './helpers/test-temp';

// Integration test (tg-cli#456, replacing the tg-cli#306 inbox channel): Claude Code and
// Codex are reached through a tmux pane or a rig-wrapper host. An interactive claude/codex
// running OUTSIDE tmux and outside the wrapper is still listed (never silently invisible),
// but `/agent <name> …` to it gets a ONE-line refusal naming how to restart it, and nothing
// is written to its Stop-hook inbox. Messages the
// retired channel queued before (stranded in pending.jsonl) are listed to the CTO ONCE
// through the daemon's own reply path and archived — a restarted daemon never repeats it.
// tmux / ps / lsof are PATH-shimmed with a fake process table.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const cfgDir = tempDir('tgctl-unreachable-');
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');

const binDir = join(cfgDir, 'bin');
mkdirSync(binDir);
// No tmux panes at all.
writeFileSync(join(binDir, 'tmux'), TMUX_NO_SERVER_SHIM, { mode: 0o755 });
// ps: the 3-column tree read AND the 2-column `pid tty` read, keyed off argv.
writeFileSync(
  join(binDir, 'ps'),
  `#!/bin/sh
case "$*" in
  *tty*)
    printf '    1 ??\\n'
    printf ' 6001 ttys004\\n'
    printf ' 7103 ttys004\\n'
    printf ' 7200 ttys005\\n'
    printf ' 8000 ??\\n'
    ;;
  *)
    printf '    1     0 /sbin/launchd\\n'
    printf ' 6001     1 -zsh\\n'
    printf ' 7103  6001 claude --permission-mode bypassPermissions --name landing\\n'
    printf ' 7200  6001 codex\\n'
    printf ' 8000     1 /Users/u/.local/bin/claude --print --output-format text\\n'
    ;;
esac
exit 0
`,
  { mode: 0o755 },
);
// lsof -a -p <pid> -d cwd -Fn -n → that pid's cwd.
writeFileSync(
  join(binDir, 'lsof'),
  `#!/bin/sh
pid=""
while [ $# -gt 0 ]; do [ "$1" = "-p" ] && pid="$2"; shift; done
case "$pid" in
  7103) printf 'p7103\\nfcwd\\nn/Users/u/work/landing\\n' ;;
  7200) printf 'p7200\\nfcwd\\nn/Users/u/work/api\\n' ;;
esac
exit 0
`,
  { mode: 0o755 },
);

// What the retired channel left behind: hatch grant notices nobody consumed.
const STRANDED_KEY = 'cwd-55302326138d2374';
const stranded = [
  { key: STRANDED_KEY, ts: '2026-09-18T12:15:28.116Z', text: 'Your earlier hatch request hatch-orchestrator-stays-thin-b3402ca21251 was APPROVED belatedly' },
  { key: STRANDED_KEY, ts: '2026-09-19T10:44:29.092Z', text: 'Your earlier hatch request hatch-orchestrator-stays-thin-745de35e9cc2 was APPROVED belatedly' },
  { key: 'subagent', ts: '2026-09-27T10:08:19.249Z', text: 'Your earlier hatch request hatch-orchestrator-stays-thin-79425d36a1c0 was APPROVED belatedly' },
];
for (const s of stranded) {
  const dir = join(cfgDir, 'inbox', s.key);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const line = JSON.stringify({ id: null, ts: s.ts, from: 'tg', text: s.text, wrapped: s.text });
  writeFileSync(join(dir, 'pending.jsonl'), `${line}\n`, { flag: 'a', mode: 0o600 });
}
// A previous sweep that crashed after claiming its pending.jsonl — here after writing the
// claim's archive but before removing the claim — leaves claim-sweep-*.jsonl behind: those
// messages must still be reported, exactly once, from a single archive.
const leftover = { key: 'crashed', ts: '2026-09-20T08:00:00.000Z', text: 'queued before a sweep crashed mid-archive' };
const leftoverLine = `${JSON.stringify({ id: null, ts: leftover.ts, from: 'tg', text: leftover.text, wrapped: leftover.text })}\n`;
mkdirSync(join(cfgDir, 'inbox', leftover.key), { recursive: true, mode: 0o700 });
writeFileSync(join(cfgDir, 'inbox', leftover.key, 'claim-sweep-999-2026-09-29T00-00-00-000Z.jsonl'), leftoverLine, { mode: 0o600 });
writeFileSync(join(cfgDir, 'inbox', leftover.key, 'stranded-999-2026-09-29T00-00-00-000Z.jsonl'), leftoverLine, { mode: 0o600 });
// A key whose pending.jsonl the sweep cannot claim (its directory is read-only): the sweep
// is incomplete, so the marker says so and the next start sweeps again — reporting ONLY
// what the first report did not list, never the same messages twice.
const locked = { key: 'locked', ts: '2026-09-21T09:00:00.000Z', text: 'queued where the sweep could not claim it' };
const lockedDir = join(cfgDir, 'inbox', locked.key);
mkdirSync(lockedDir, { recursive: true, mode: 0o700 });
writeFileSync(join(lockedDir, 'pending.jsonl'), `${JSON.stringify({ id: null, ts: locked.ts, from: 'tg', text: locked.text, wrapped: locked.text })}\n`, { mode: 0o600 });
chmodSync(lockedDir, 0o500);
// A batch the omp Stop bridge delivered: the daemon archives it to acked.jsonl and removes it.
const deliveredBatch = join(cfgDir, 'inbox', 'subagent', 'delivered-1-1-ab.jsonl');
writeFileSync(deliveredBatch, `${JSON.stringify({ id: null, ts: 't', from: 'tg', text: 'omp got this', wrapped: 'omp got this', delivered_ts: 't' })}\n`, { mode: 0o600 });
// omp's own grant-notice fallback, queued by the previous daemon for a grant that is still
// live: it shares the cwd key with a stranded entry and must survive the sweep for the omp hook.
const OMP_APPROVAL = 'hgr-0123456789ab';
const ompNotice = hatchGrantNoticeText({
  requestId: 'hatch-omp-hook-aaaaaaaaaaaa',
  question: 'Allow rig hatch escalation: omp-hook?',
  hookId: 'omp-hook',
  approvalId: OMP_APPROVAL,
  approvedAt: Date.parse('2026-09-30T09:00:00.000Z'),
  expiresAt: Date.parse('2026-10-01T09:00:00.000Z'),
});
// An omp ask without an origin block (`agent: "omp"` only): its grant carries no origin and
// routes to the inbox key — only its grace record's request says omp. Kept as well.
const BARE_OMP_APPROVAL = 'hgr-abcdef012345';
const BARE_OMP_REQUEST = 'hatch-omp-hook-cccccccccccc';
const bareOmpNotice = hatchGrantNoticeText({
  requestId: BARE_OMP_REQUEST,
  question: 'Allow rig hatch escalation: omp-hook?',
  hookId: 'omp-hook',
  approvalId: BARE_OMP_APPROVAL,
  approvedAt: Date.parse('2026-09-30T09:30:00.000Z'),
  expiresAt: Date.parse('2026-10-01T09:30:00.000Z'),
});
writeFileSync(
  join(cfgDir, 'inbox', STRANDED_KEY, 'pending.jsonl'),
  [ompNotice, bareOmpNotice].map((text) => `${JSON.stringify({ id: null, ts: '2026-09-30T09:00:00.000Z', from: 'tg', text, wrapped: text })}\n`).join(''),
  { flag: 'a' },
);
const now = Date.now();
writeFileSync(
  join(cfgDir, 'tg-ctl.123.grants.json'),
  JSON.stringify({
    version: 1,
    grace: [
      {
        key: BARE_OMP_REQUEST,
        requestId: BARE_OMP_REQUEST,
        hookId: 'omp-hook',
        req: {
          requestId: BARE_OMP_REQUEST,
          agent: 'omp',
          kind: 'permission',
          question: 'Allow rig hatch escalation: omp-hook?',
          permissionEvent: 'PermissionRequest',
          hookId: 'omp-hook',
          operation: { kind: 'bash', fingerprint: 'sha256:fp', cwd: '/repo' },
          cwd: '/repo',
        },
        route: `inbox:${STRANDED_KEY}`,
        messageId: 5,
        expiredAt: now - 3600_000,
        graceExpiresAt: now + 20 * 3600_000,
      },
    ],
    grants: [
      {
        approval_id: OMP_APPROVAL,
        request_id: 'hatch-omp-hook-aaaaaaaaaaaa',
        hook_id: 'omp-hook',
        origin: { agent: 'omp', sessionId: 'omp-session-1' },
        route: 'acp:omp-session-1',
        approved_at: now,
        expires_at: now + 24 * 3600_000,
        consumed_at: null,
      },
      {
        approval_id: BARE_OMP_APPROVAL,
        request_id: BARE_OMP_REQUEST,
        hook_id: 'omp-hook',
        operation: { kind: 'bash', fingerprint: 'sha256:fp', cwd: '/repo' },
        route: `inbox:${STRANDED_KEY}`,
        approved_at: now,
        expires_at: now + 24 * 3600_000,
        consumed_at: null,
      },
    ],
  }),
  { mode: 0o600 },
);

// The first stranded-report send fails. While the daemon waits to retry, omp's fallback
// queues a notice for a grant that is no longer live (e.g. expired in between). The retry
// must resend the report it already built — same 3 messages — and never re-sweep
// pending.jsonl, which would archive and report that fresh omp notice as stranded.
const LATE_APPROVAL = 'hgr-fedcba987654';
const lateOmpNotice = hatchGrantNoticeText({
  requestId: 'hatch-omp-hook-bbbbbbbbbbbb',
  question: 'Allow rig hatch escalation: omp-hook?',
  hookId: 'omp-hook',
  approvalId: LATE_APPROVAL,
  approvedAt: Date.parse('2026-09-30T10:00:00.000Z'),
  expiresAt: Date.parse('2026-10-01T10:00:00.000Z'),
});
let failedReports = 0;

const sentMessages: Array<Record<string, unknown>> = [];
let polls = 0;
let served = 0;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/getUpdates')) {
      polls++;
      const offset = Number(url.searchParams.get('offset') ?? '0');
      if (offset <= 100 && served === 0) {
        served = 1;
        const msg = (message_id: number, text: string) => ({
          update_id: 90 + message_id,
          message: { message_id, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: 1, text },
        });
        return Response.json({
          ok: true,
          result: [
            msg(10, '/agent landing deploy now'),
            msg(11, '/agent api run the tests'),
            msg(12, 'plain message, nobody in tmux'),
            msg(13, '/agent landing'),
          ],
        });
      }
      // A real long-poll holds the request; without a short hold the daemon hot-loops.
      await Bun.sleep(80);
      return Response.json({ ok: true, result: [] });
    }
    if (url.pathname.endsWith('/sendMessage')) {
      const body = (await req.json()) as Record<string, unknown>;
      if (failedReports === 0 && isStrandedReport(String(body.text))) {
        failedReports++;
        writeFileSync(
          join(cfgDir, 'inbox', STRANDED_KEY, 'pending.jsonl'),
          `${JSON.stringify({ id: null, ts: '2026-09-30T10:00:00.000Z', from: 'tg', text: lateOmpNotice, wrapped: lateOmpNotice })}\n`,
          { flag: 'a' },
        );
        return Response.json({ ok: false, error_code: 502, description: 'Bad Gateway' }, { status: 502 });
      }
      sentMessages.push(body);
      return Response.json({ ok: true, result: { message_id: 77 } });
    }
    return Response.json({ ok: true, result: {} });
  },
});

const reg = createDaemonRegistry();
afterAll(async () => {
  chmodSync(lockedDir, 0o700);
  await reapDaemons(reg);
  server.stop(true);
});

const env = { PATH: `${binDir}:${process.env.PATH ?? ''}`, HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}` };
const texts = (): string[] => sentMessages.map((m) => String(m.text));
const isStrandedReport = (t: string): boolean => t.startsWith('📭 The Stop-hook inbox no longer delivers to Claude Code and Codex');
const strandedReports = (): string[] => texts().filter(isStrandedReport);

// The daemon is a real subprocess (no in-process clock to fake): poll for the
// observable condition, bounded, instead of guessing a duration.
async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await Bun.sleep(50);
  }
  return pred();
}

// One daemon for the whole file, so each test can run alone (`-t stranded`) too.
beforeAll(async () => {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'w');
  await spawnDaemon(reg, { tgCtlPath: TG_CTL, cfgDir, env, logFd });
  closeSync(logFd);
});

test('/agent to a claude/codex outside tmux and the rig wrapper: a one-line refusal naming how to restart it, and nothing queued', async () => {
  // the actions run concurrently and the listing for the plain message also says "Restart it
  // with": wait for each refusal itself, not for a count of the phrase
  expect(
    await until(() => texts().filter((t) => t.includes('landing · claude runs outside tmux')).length >= 2 && texts().some((t) => t.includes('api · codex runs outside tmux')), 20_000),
  ).toBe(true);

  const refusals = texts().filter((t) => t.includes('runs outside tmux') && t.includes('Restart it with'));
  const cc = refusals.filter((t) => t.includes('landing · claude runs outside tmux'));
  // `/agent landing deploy now` AND a bare `/agent landing` both refuse the same way.
  expect(cc).toHaveLength(2);
  for (const t of refusals) expect(t).not.toContain('\n');
  expect(cc[0]).toContain('nothing was sent or queued');
  expect(cc[0].endsWith('Restart it with: rig harness run claude --name landing (or in a tmux window)')).toBe(true);
  const codex = refusals.find((t) => t.includes('api · codex runs outside tmux'));
  expect(codex?.endsWith('Restart it with: rig harness run codex --name api (or in a tmux window)')).toBe(true);

  // No inbox write for either agent (named key and cwd key alike).
  expect(existsSync(join(cfgDir, 'inbox', 'landing'))).toBe(false);
  expect(existsSync(join(cfgDir, 'inbox', agentInboxKey(null, '/Users/u/work/api')))).toBe(false);

  // A plain message that finds no pane still LISTS the agents outside tmux, with the restart hint.
  const listing = texts().find((t) => t.includes('OUTSIDE tmux'));
  expect(listing).toContain('landing · claude — unreachable: not in tmux (tty ttys004, cwd /Users/u/work/landing, name landing, pid 7103)');
  expect(listing).toContain('api · codex — unreachable: not in tmux');
  expect(listing).toContain('`rig harness run <harness> --name <label>`');
  expect(listing).not.toMatch(/queued|Stop-hook/);
  expect(texts().some((t) => t.startsWith('Claude Code not in tmux'))).toBe(false);
}, 30_000);

test('stranded inbox messages are listed to the CTO once and archived; a restarted daemon never repeats them', async () => {
  expect(await until(() => strandedReports().length === 1, 10_000)).toBe(true);
  expect(failedReports).toBe(1);
  const report = strandedReports()[0];
  expect(report).toContain('4 message(s)');
  expect(report).not.toContain(locked.text);
  expect(report).not.toContain(LATE_APPROVAL);
  expect(report).toContain('oldest 2026-09-18 12:15 UTC');
  for (const s of [...stranded, leftover]) expect(report).toContain(`${s.key} — ${s.text}`);
  // omp's live grant notice is not the retired channel's backlog: never reported.
  expect(report).not.toContain(OMP_APPROVAL);
  expect(report).not.toContain(BARE_OMP_APPROVAL);
  // Sent through the daemon's reply path: the control chat, plain text.
  const sent = sentMessages.find((m) => String(m.text) === report)!;
  expect(sent.chat_id).toBe(1);

  // Archived: the exact stranded lines live on in stranded-*.jsonl (0600).
  for (const key of [STRANDED_KEY, 'subagent', leftover.key]) {
    const dir = join(cfgDir, 'inbox', key);
    const archived = readdirSync(dir).filter((n) => n.startsWith('stranded-') && n.endsWith('.jsonl'));
    expect(archived).toHaveLength(1);
    expect(statSync(join(dir, archived[0])).mode & 0o777).toBe(0o600);
    const body = readFileSync(join(dir, archived[0]), 'utf8');
    for (const s of [...stranded, leftover].filter((x) => x.key === key)) expect(body).toContain(s.text);
    expect(body).not.toContain(OMP_APPROVAL);
    expect(body).not.toContain(BARE_OMP_APPROVAL);
    expect(body).not.toContain(LATE_APPROVAL);
  }
  expect(readdirSync(join(cfgDir, 'inbox', leftover.key)).filter((n) => n.startsWith('claim-sweep-'))).toEqual([]);
  // pending.jsonl holds ONLY omp's notices, still consumable by the omp Stop bridge: the live
  // one kept by the sweep, and the one queued during the send retry (never re-swept).
  expect(existsSync(join(cfgDir, 'inbox', 'subagent', 'pending.jsonl'))).toBe(false);
  const pending = readFileSync(join(cfgDir, 'inbox', STRANDED_KEY, 'pending.jsonl'), 'utf8').trim().split('\n');
  expect(pending.map((l) => JSON.parse(l).text)).toEqual([ompNotice, bareOmpNotice, lateOmpNotice]);
  // What the omp Stop bridge delivered is archived to acked.jsonl, and the batch removed.
  expect(await until(() => !existsSync(deliveredBatch), 5000)).toBe(true);
  expect(readFileSync(join(cfgDir, 'inbox', 'subagent', 'acked.jsonl'), 'utf8')).toContain('"delivered_ts":"t"');

  // The locked key could not be claimed: the marker (written right after the send)
  // records an incomplete sweep and the three archives already reported.
  const markerPath = join(cfgDir, 'inbox-stranded-report.json');
  const marker = (): { complete: boolean; reported: string[] } => JSON.parse(readFileSync(markerPath, 'utf8'));
  expect(await until(() => existsSync(markerPath), 5000)).toBe(true);
  expect(marker().complete).toBe(false);
  expect(marker().reported.map((f) => f.split('/')[0]).sort()).toEqual([leftover.key, STRANDED_KEY, 'subagent'].sort());
  expect(readFileSync(join(lockedDir, 'pending.jsonl'), 'utf8')).toContain(locked.text);

  const restart = async (log: string): Promise<void> => {
    for (const p of reg.procs) p.kill('SIGTERM');
    await Promise.all(reg.procs.map((p) => p.exited));
    const logFd = openSync(join(cfgDir, log), 'w');
    await spawnDaemon(reg, { tgCtlPath: TG_CTL, cfgDir, env, logFd });
    closeSync(logFd);
  };
  // Restart once the key is writable again: the successor re-sweeps and reports ONLY what
  // the first report did not list — the locked key's message, and the omp notice whose
  // grant is no longer live — never the four already sent.
  chmodSync(lockedDir, 0o700);
  await restart('daemon2.log');
  expect(await until(() => strandedReports().length === 2, 10_000)).toBe(true);
  const second = strandedReports()[1];
  expect(second).toContain('2 message(s)');
  expect(second).toContain(`${locked.key} — ${locked.text}`);
  for (const s of [...stranded, leftover]) expect(second).not.toContain(s.text);
  expect(second).not.toContain(OMP_APPROVAL);
  expect(await until(() => marker().complete, 5000)).toBe(true);

  // A complete marker: the next daemon polls several times and never reports again.
  await restart('daemon3.log');
  const before = polls;
  expect(await until(() => polls >= before + 3, 10_000)).toBe(true);
  expect(strandedReports()).toHaveLength(2);
}, 45_000);
