// Characterization of two daemon-runtime modules whose big functions were decomposed
// (guardian-817): alert-commands (`tg-ctl alert send` paths the lifecycle/remediation
// integrations leave thin) and stranded-inbox (the inbox sweep / archive / grant-notice
// routing, called directly against a temp config dir — no Telegram, no tmux).
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { captureStdoutLines } from './helpers/stdout-lines';
import { tempDir, trackChild } from './helpers/test-temp';
import { COMPLETE_PROBLEM } from './fixtures/intent-gate/problem-remediation';
import { ctlPaths } from '../features/tg-ctl/lock';
import { hatchGrantNoticeText } from '../features/tg-ctl/grants';
import { agentInboxKey } from '../features/tg-ctl/unreachable';
import type { ButtonRequest } from '../features/tg-ctl/questions';
import type { Ctx } from '../features/tg-ctl/daemon-runtime/ctx-io';
import { archiveDeliveredInboxes, listInboxKeys, pendingInboxCount, queueToInbox, routeGrantNotice, runInboxCommand, strandedInboxGroups, sweepStrandedInbox, type StrandedSweep } from '../features/tg-ctl/daemon-runtime/stranded-inbox';

const ROOT = join(import.meta.dir, '..');

// ───────────────────────── alert send (spawned tg-ctl against a fake Bot API) ─────────────────────────

const sent: Array<Record<string, unknown>> = [];
let rejectPost = false;
let holdFirstPost: Promise<void> | null = null;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    if (!new URL(req.url).pathname.endsWith('/sendMessage')) return new Response('unexpected', { status: 404 });
    sent.push((await req.json()) as Record<string, unknown>);
    if (holdFirstPost) {
      const hold = holdFirstPost;
      holdFirstPost = null;
      await hold;
    }
    return rejectPost
      ? Response.json({ ok: false, description: 'fixture rejects the post' }, { status: 400 })
      : Response.json({ ok: true, result: { message_id: 900 + sent.length } });
  },
});
const home = tempDir('tgctl-rt-alert-');
const cfg = join(home, '.config', 'tg-cli');
mkdirSync(cfg, { recursive: true });
writeFileSync(join(cfg, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
const receivedLog = join(home, 'received.jsonl');
writeFileSync(receivedLog, '');
const procs: Subprocess[] = [];
const env = { ...process.env, HOME: home, TG_CTL_CONFIG_DIR: cfg, TG_API_BASE: `http://127.0.0.1:${server.port}`, TG_LAYA: '0' };

afterAll(async () => {
  server.stop(true);
  for (const p of procs) p.kill();
  await Promise.all(procs.map((p) => p.exited));
});

async function host(session: string, fail = false): Promise<Subprocess> {
  const script = `
    import { startLiveEndpoint } from ${JSON.stringify(join(ROOT, 'features/tg-ctl/omp-live-runtime.mjs'))};
    import { appendFileSync } from 'node:fs';
    const ep = await startLiveEndpoint({ root: ${JSON.stringify(join(cfg, 'omp-live'))},
      snapshot: () => ({ sessionId: ${JSON.stringify(session)}, sessionFile: null, cwd: ${JSON.stringify(home)}, title: ${JSON.stringify(session)}, busy: false }),
      send: (text) => {
        if (${fail}) throw new Error('refused');
        appendFileSync(${JSON.stringify(receivedLog)}, JSON.stringify({ session: ${JSON.stringify(session)}, text }) + '\\n');
      } });
    process.on('SIGTERM', async () => { await ep.close(); process.exit(0); });
    process.stdout.write('ready\\n');
  `;
  const proc = trackChild(Bun.spawn(['bun', '-e', script], { env, stdout: 'pipe', stderr: 'pipe' }));
  procs.push(proc);
  const reader = proc.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  expect(new TextDecoder().decode(value)).toContain('ready');
  return proc;
}
async function stop(proc: Subprocess): Promise<void> {
  proc.kill('SIGTERM');
  await proc.exited;
}
async function ctl(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = trackChild(Bun.spawn(['bun', join(ROOT, 'tg-ctl'), 'alert', ...args], { env, stdout: 'pipe', stderr: 'pipe' }));
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}
const sendAlert = (source: string, severity: string, text: string, ...extra: string[]) => ctl('send', '--source', source, '--severity', severity, '--key', 'k', '--text', text, ...extra);
const received = (session: string): string[] =>
  readFileSync(receivedLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { session: string; text: string }).filter((r) => r.session === session).map((r) => r.text);

test('send: a concurrent second send of the same alert reports "in flight" and neither posts nor delivers', async () => {
  const before = sent.length;
  let release!: () => void;
  holdFirstPost = new Promise<void>((resolve) => { release = resolve; });
  const first = sendAlert('inflight-src', 'warning', COMPLETE_PROBLEM);
  const deadline = Date.now() + 15_000;
  // Real clock on purpose: the second send must race a first one still inside its `tg` post.
  while (sent.length === before && Date.now() < deadline) await Bun.sleep(25);
  expect(sent.length).toBe(before + 1);
  const second = await sendAlert('inflight-src', 'warning', COMPLETE_PROBLEM);
  expect(second.code).toBe(0);
  expect(second.out).toMatch(/^in flight: another tg-ctl alert is posting inflight-src\/k\/warning \(claimed .+ ago\)\n$/u);
  expect(sent.length).toBe(before + 1);
  release();
  const done = await first;
  expect(done.code).toBe(0);
  expect(done.out).toBe(`OK tg#${900 + before + 1} sessions=0\n`);
}, 30_000);

test('send: a rejected owner post of a non-problem alert prints FAILED tg#? and releases the claim for the retry', async () => {
  rejectPost = true;
  let failed: Awaited<ReturnType<typeof ctl>>;
  try { failed = await sendAlert('report-src', 'info', COMPLETE_PROBLEM); }
  finally { rejectPost = false; }
  expect(failed!.code).toBe(1);
  expect(failed!.out).toBe('FAILED tg#? sessions=0\n');
  expect(failed!.err).toContain('tg-ctl alert: Telegram post failed (tg exit ');
  const retry = await sendAlert('report-src', 'info', COMPLETE_PROBLEM);
  expect(retry.code).toBe(0);
  expect(retry.out).toStartWith('OK tg#');
}, 30_000);

test('send: a session that refused the copy is reported failed (exit 1) and the throttled repeat catches it up once it is back', async () => {
  const session = 'rt-catchup';
  const refusing = await host(session, true);
  expect((await ctl('subscribe', '--pid', String(refusing.pid), '--sources', 'catchup-src')).code).toBe(0);
  const first = await sendAlert('catchup-src', 'warning', COMPLETE_PROBLEM);
  expect(first.code).toBe(1);
  expect(first.out).toMatch(/^OK tg#\d+ sessions=0 failed=1\n$/u);
  expect(first.err).toContain(`tg-ctl alert: session delivery failed — ${session} (pid ${refusing.pid}): `);
  const messageId = /tg#(\d+)/u.exec(first.out)![1];
  await stop(refusing);

  const resumed = await host(session);
  const before = sent.length;
  const repeat = await sendAlert('catchup-src', 'warning', COMPLETE_PROBLEM);
  expect(repeat.code).toBe(0);
  expect(repeat.out).toMatch(new RegExp(`^throttled tg#${messageId} \\(catchup-src/k/warning sent .+ ago, window .+; delivered to 1 pending session\\(s\\)\\)\\n$`, 'u'));
  expect(sent.length).toBe(before);
  expect(received(session)).toHaveLength(1);
  expect(received(session)[0]).toStartWith(`[alert tg#${messageId} · catchup-src · warning] `);
  // The pending receipt is settled: a third send delivers nothing more.
  const third = await sendAlert('catchup-src', 'warning', COMPLETE_PROBLEM);
  expect(third.out).toMatch(/^throttled tg#\d+ \(catchup-src\/k\/warning sent .+ ago, window [^;]+\)\n$/u);
  expect(received(session)).toHaveLength(1);
  await stop(resumed);
}, 40_000);

test('send: a throttle store another alert holds locked for over 2 s changes nothing (exit 1)', async () => {
  const lock = `${ctlPaths(cfg, '123').alertThrottle}.lock`;
  writeFileSync(lock, String(process.pid), { flag: 'wx' });
  const before = sent.length;
  try {
    const busy = await sendAlert('busy-src', 'warning', COMPLETE_PROBLEM);
    expect(busy.code).toBe(1);
    expect(busy.out).toBe('');
    expect(busy.err).toContain('tg-ctl alert: state file locked by another tg-ctl alert for over 2 s; nothing changed');
    expect(sent.length).toBe(before);
  } finally {
    unlinkSync(lock);
  }
}, 30_000);

test('send: a raw incident whose internal copy exceeds the omp-live limit is refused before any receipt or delivery', async () => {
  const agent = await host('rt-oversize');
  expect((await ctl('subscribe', '--pid', String(agent.pid), '--sources', 'oversize-src')).code).toBe(0);
  const before = sent.length;
  const big = await sendAlert('oversize-src', 'critical', `Memory usage 97%; ${'ж'.repeat(31_900)}`);
  expect(big.code).toBe(1);
  expect(big.err).toContain('tg-ctl alert: the internal copy exceeds 64000 bytes (shorten --text)');
  expect(received('rt-oversize')).toHaveLength(0);
  expect(sent.length).toBe(before);
  await stop(agent);
}, 30_000);

// ───────────────────────── stranded inbox (direct calls) ─────────────────────────

let configDir: string;
let ctx: Ctx;
let logs: string[];
let errSpy: { mockRestore(): void };
let priorConfigDir: string | undefined;

beforeEach(() => {
  configDir = tempDir('tgctl-rt-inbox-');
  // Only the fields the inbox module reads are real; the rest of the daemon context is not touched by it.
  ctx = { configDir, paths: ctlPaths(configDir, '123') } as Ctx;
  logs = [];
  errSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  // routeGrantNotice probes the omp-live registry, which resolves from this variable: keep it off the developer's real endpoints.
  priorConfigDir = process.env.TG_CTL_CONFIG_DIR;
  process.env.TG_CTL_CONFIG_DIR = configDir;
});
afterEach(() => {
  errSpy.mockRestore();
  if (priorConfigDir === undefined) delete process.env.TG_CTL_CONFIG_DIR;
  else process.env.TG_CTL_CONFIG_DIR = priorConfigDir;
});

const entryLine = (text: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ id: null, ts: '2026-09-30T09:00:00.000Z', from: 'tg', text, wrapped: text, ...extra });
const inboxDir = (key: string): string => join(configDir, 'inbox', key);
function seed(key: string, name: string, body: string): string {
  mkdirSync(inboxDir(key), { recursive: true, mode: 0o700 });
  const path = join(inboxDir(key), name);
  writeFileSync(path, body, { mode: 0o600 });
  return path;
}
const mode = (path: string): number => statSync(path).mode & 0o777;

test('queueToInbox: appends one complete line per entry, directories 0700 and files 0600 even from a loose umask', () => {
  queueToInbox(ctx, 'proj', { id: null, ts: 't1', from: 'tg', text: 'a', wrapped: 'a' });
  queueToInbox(ctx, 'proj', { id: null, ts: 't2', from: 'tg', text: 'b', wrapped: 'b' });
  const pending = join(inboxDir('proj'), 'pending.jsonl');
  expect(readFileSync(pending, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text)).toEqual(['a', 'b']);
  expect(mode(pending)).toBe(0o600);
  expect(mode(inboxDir('proj'))).toBe(0o700);
  expect(mode(join(configDir, 'inbox'))).toBe(0o700);
  expect(pendingInboxCount(ctx, 'proj')).toBe(2);
  expect(pendingInboxCount(ctx, 'absent')).toBe(0);
});

test('listInboxKeys: sorted directories only; a missing inbox root is an empty list', () => {
  expect(listInboxKeys(ctx)).toEqual([]);
  seed('zeta', 'pending.jsonl', '');
  seed('alpha', 'pending.jsonl', '');
  writeFileSync(join(configDir, 'inbox', 'stray-file'), '');
  expect(listInboxKeys(ctx)).toEqual(['alpha', 'zeta']);
});

test('archiveDeliveredInboxes: each delivered batch is appended whole to acked.jsonl and removed; temp batches and other files stay', () => {
  seed('k1', 'delivered-1-1-ab.jsonl', `${entryLine('one')}\n${entryLine('two')}\nnot json\n`);
  seed('k1', 'delivered-2-2-cd.jsonl', entryLine('no trailing newline'));
  seed('k1', 'delivered-3-3-ef.jsonl.tmp', entryLine('still being written'));
  seed('k1', 'pending.jsonl', `${entryLine('queued')}\n`);
  seed('k2', 'delivered-9-9-zz.jsonl', '');
  archiveDeliveredInboxes(ctx);
  expect(readdirSync(inboxDir('k1')).sort()).toEqual(['acked.jsonl', 'delivered-3-3-ef.jsonl.tmp', 'pending.jsonl']);
  // readdir order BETWEEN the two delivered batches is filesystem-dependent
  // (the baseline sweep is unsorted); each batch is appended WHOLE with its
  // internal line order fixed, so accept exactly either whole-batch
  // concatenation — nothing lost, duplicated or reordered within a batch.
  const acked = readFileSync(join(inboxDir('k1'), 'acked.jsonl'), 'utf8');
  const firstBatch = `${entryLine('one')}\n${entryLine('two')}\nnot json\n`;
  const secondBatch = `${entryLine('no trailing newline')}\n`;
  expect([`${firstBatch}${secondBatch}`, `${secondBatch}${firstBatch}`]).toContain(acked);
  expect(mode(join(inboxDir('k1'), 'acked.jsonl'))).toBe(0o600);
  // An empty batch is removed without creating an archive.
  expect(readdirSync(inboxDir('k2'))).toEqual([]);
  // Both archive log messages are exact; only their relative order follows
  // readdir, so assert the exact set without a cross-file order assumption.
  const archivedLogs = logs.filter((l) => l.includes('delivered by the Stop hook'));
  expect(archivedLogs).toHaveLength(2);
  expect(archivedLogs).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/inbox k1: 2 delivered by the Stop hook \(1 malformed\) — archived$/u),
      expect.stringMatching(/inbox k1: 1 delivered by the Stop hook \(0 malformed\) — archived$/u),
    ]),
  );
});

test('archiveDeliveredInboxes: a key whose directory cannot be swept is logged and the other keys are still archived', () => {
  const blocked = seed('a-blocked', 'delivered-1-1-ab.jsonl', `${entryLine('x')}\n`);
  seed('b-ok', 'delivered-1-1-ab.jsonl', `${entryLine('y')}\n`);
  chmodSync(inboxDir('a-blocked'), 0o500); // listing works, unlink does not
  try {
    archiveDeliveredInboxes(ctx);
  } finally {
    chmodSync(inboxDir('a-blocked'), 0o700);
  }
  if (process.getuid?.() === 0) return; // root ignores directory modes
  expect(existsSync(blocked)).toBe(true);
  expect(logs.some((l) => l.includes('inbox a-blocked: delivered-batch sweep failed:'))).toBe(true);
  expect(existsSync(join(inboxDir('b-ok'), 'acked.jsonl'))).toBe(true);
});

test('strandedInboxGroups: archived stranded-*.jsonl per key, sorted, with parsed entries and malformed counts', () => {
  seed('b', 'stranded-2.jsonl', `${entryLine('b2')}\n`);
  seed('b', 'stranded-1.jsonl', `${entryLine('b1')}\nnot json\n`);
  seed('b', 'pending.jsonl', `${entryLine('ignored')}\n`);
  seed('a', 'stranded-1.jsonl', `${entryLine('a1')}\n`);
  expect(strandedInboxGroups(ctx).map((g) => [g.file, g.entries.map((e) => e.text), g.malformed])).toEqual([
    ['a/stranded-1.jsonl', ['a1'], 0],
    ['b/stranded-1.jsonl', ['b1'], 1],
    ['b/stranded-2.jsonl', ['b2'], 0],
  ]);
});

test('sweepStrandedInbox: claims pending.jsonl, archives every line as stranded-<stamp> (0600), reports once and skips already-reported archives', () => {
  seed('proj', 'pending.jsonl', `${entryLine('first')}\n${entryLine('second')}\n`);
  seed('empty', 'acked.jsonl', '');
  const sweep = sweepStrandedInbox(ctx, new Set());
  expect(sweep.complete).toBe(true);
  expect(sweep.count).toBe(2);
  expect(sweep.files).toHaveLength(1);
  expect(sweep.files[0]).toMatch(/^proj\/stranded-\d+-.+\.jsonl$/u);
  expect(sweep.text).toContain('proj — first');
  expect(sweep.text).toContain('proj — second');
  expect(existsSync(join(inboxDir('proj'), 'pending.jsonl'))).toBe(false);
  expect(readdirSync(inboxDir('proj')).filter((n) => n.startsWith('claim-sweep-'))).toEqual([]);
  const archive = join(configDir, 'inbox', sweep.files[0]);
  expect(readFileSync(archive, 'utf8')).toBe(`${entryLine('first')}\n${entryLine('second')}\n`);
  expect(mode(archive)).toBe(0o600);

  // Everything already reported: nothing to say, still complete, the archive untouched.
  const again = sweepStrandedInbox(ctx, new Set(sweep.files));
  expect(again).toEqual({ text: null, count: 0, complete: true, files: [] });
  expect(readFileSync(archive, 'utf8')).toBe(`${entryLine('first')}\n${entryLine('second')}\n`);
});

test('sweepStrandedInbox: a still-live omp grant notice is appended back to pending.jsonl (not duplicated on replay); the rest is stranded', () => {
  const notice = 'Your earlier hatch request hatch-omp-hook-aaaaaaaaaaaa was APPROVED belatedly';
  const ompKey = 'omp-proj';
  // The splitter keeps only genuine grant notices, so reuse the real text builder.
  const text = grantNoticeText('hatch-omp-hook-aaaaaaaaaaaa', 'hgr-0123456789ab');
  seed(ompKey, 'pending.jsonl', `${entryLine(text)}\n${entryLine(notice)}\n`);
  writeFileSync(
    ctx.paths.grants,
    JSON.stringify({
      version: 1,
      grace: [],
      grants: [grantRecord()],
      decided: [],
    }),
  );
  const first = sweepStrandedInbox(ctx, new Set());
  expect(first.complete).toBe(true);
  expect(first.count).toBe(1);
  expect(readFileSync(join(inboxDir(ompKey), 'pending.jsonl'), 'utf8')).toBe(`${entryLine(text)}\n`);
  // A later sweep re-claims the kept line: it is archived nowhere and re-queued exactly once.
  const second = sweepStrandedInbox(ctx, new Set(first.files));
  expect(second.count).toBe(0);
  expect(readFileSync(join(inboxDir(ompKey), 'pending.jsonl'), 'utf8')).toBe(`${entryLine(text)}\n`);
});

test('sweepStrandedInbox: an unclaimable key makes the sweep incomplete and logs it; other keys are still archived', () => {
  if (process.getuid?.() === 0) return; // root ignores directory modes
  seed('a-locked', 'pending.jsonl', `${entryLine('stuck')}\n`);
  seed('b-open', 'pending.jsonl', `${entryLine('free')}\n`);
  chmodSync(inboxDir('a-locked'), 0o500);
  let sweep: StrandedSweep;
  try {
    sweep = sweepStrandedInbox(ctx, new Set());
  } finally {
    chmodSync(inboxDir('a-locked'), 0o700);
  }
  expect(sweep.complete).toBe(false);
  expect(sweep.count).toBe(1);
  expect(sweep.files[0]).toStartWith('b-open/stranded-');
  expect(logs.some((l) => l.includes('inbox a-locked: could not claim the stranded pending.jsonl:'))).toBe(true);
  expect(readFileSync(join(inboxDir('a-locked'), 'pending.jsonl'), 'utf8')).toBe(`${entryLine('stuck')}\n`);
});

test('sweepStrandedInbox: a claim-sweep file left by a crashed sweep is archived under the archive name derived from the claim, then removed', () => {
  seed('crashed', 'claim-sweep-999-2026-09-29T00-00-00-000Z.jsonl', `${entryLine('left behind')}\n`);
  const sweep = sweepStrandedInbox(ctx, new Set());
  expect(sweep.complete).toBe(true);
  expect(sweep.files).toEqual(['crashed/stranded-999-2026-09-29T00-00-00-000Z.jsonl']);
  expect(readdirSync(inboxDir('crashed'))).toEqual(['stranded-999-2026-09-29T00-00-00-000Z.jsonl']);
});

test('runInboxCommand: usage error on arguments; otherwise pending counts per key (swept or not) and the archived total, read-only', () => {
  const out: string[] = [];
  const logSpy = captureStdoutLines(out);
  try {
    expect(runInboxCommand(ctx, ['queue'])).toBe(1);
    expect(logs.at(-1)).toBe('usage: tg-ctl inbox   (`inbox queue` is gone: Claude Code and Codex are tmux-only, tg-cli#456)');
    expect(runInboxCommand(ctx, [])).toBe(0);
    expect(out.pop()).toBe('inbox: nothing pending');

    seed('proj', 'pending.jsonl', `${entryLine('p1')}\n${entryLine('p2')}\n`);
    seed('proj', 'stranded-1.jsonl', `${entryLine('s1')}\n`);
    expect(runInboxCommand(ctx, [])).toBe(0);
    expect(out.pop()).toBe(`  - proj: 2 pending (not swept yet: the daemon reports any cc/codex backlog here when it next starts)\n  archived: 1 stranded cc/codex message(s) in ${join(configDir, 'inbox')}/*/stranded-*.jsonl`);

    writeFileSync(join(configDir, 'inbox-stranded-report.json'), JSON.stringify({ complete: true, reported: [] }));
    expect(runInboxCommand(ctx, [])).toBe(0);
    expect(out.pop()).toContain("  - proj: 2 pending (omp grant notice, delivered at that omp's next yield)");
  } finally {
    logSpy.mockRestore();
  }
  expect(readFileSync(join(inboxDir('proj'), 'pending.jsonl'), 'utf8')).toBe(`${entryLine('p1')}\n${entryLine('p2')}\n`);
});

// routeGrantNotice: only the branches that never touch tmux/Telegram.
const grantReq = (over: Partial<ButtonRequest>): ButtonRequest => ({ requestId: 'r1', agent: 'omp', kind: 'permission', question: 'q', ...over });

test('routeGrantNotice: a Claude Code/Codex origin without a pane gets nothing queued (tmux-only, #456)', async () => {
  const delivered = await routeGrantNotice(ctx, grantReq({ agent: 'claude', cwd: '/work/p' }), 'notice', 'd1');
  expect(delivered).toBe(false);
  expect(logs.at(-1)).toMatch(/grant-notice: claude origin has no tmux pane — nothing queued \(Claude Code\/Codex are tmux-only\)$/u);
  expect(listInboxKeys(ctx)).toEqual([]);
});

test('routeGrantNotice: an omp origin with a cwd but no live session falls back to its project inbox as one daemon-authored line', async () => {
  const delivered = await routeGrantNotice(ctx, grantReq({ cwd: '/work/proj' }), 'notice text', 'd2');
  expect(delivered).toBe(true);
  const key = agentInboxKey(null, '/work/proj');
  expect(listInboxKeys(ctx)).toEqual([key]);
  const lines = readFileSync(join(inboxDir(key), 'pending.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ id: null, from: 'tg', text: 'notice text', wrapped: 'notice text' });
});

test('routeGrantNotice: an omp origin with no cwd has no project inbox — undelivered and logged, nothing written', async () => {
  const delivered = await routeGrantNotice(ctx, grantReq({ origin: { agent: 'omp' } }), 'notice text', 'd3');
  expect(delivered).toBe(false);
  expect(logs.at(-1)).toMatch(/grant-notice: omp origin has no cwd — no project inbox to queue to session=-$/u);
  expect(listInboxKeys(ctx)).toEqual([]);
});

test('routeGrantNotice: an inbox write failure is logged and reported undelivered', async () => {
  if (process.getuid?.() === 0) return; // root ignores directory modes
  mkdirSync(join(configDir, 'inbox'), { mode: 0o500 });
  try {
    const delivered = await routeGrantNotice(ctx, grantReq({ cwd: '/work/ro' }), 'notice text', 'd4');
    expect(delivered).toBe(false);
    expect(logs.at(-1)).toContain('grant-notice inbox route failed key-cwd=/work/ro:');
  } finally {
    chmodSync(join(configDir, 'inbox'), 0o700);
  }
});

// The same notice text the daemon queues (grants.hatchGrantNoticeText), so splitStrandedLines recognises it.
function grantNoticeText(requestId: string, approvalId: string): string {
  return hatchGrantNoticeText({ requestId, question: 'Allow rig hatch escalation: omp-hook?', hookId: 'omp-hook', approvalId, approvedAt: Date.parse('2026-09-30T09:00:00.000Z'), expiresAt: Date.parse('2026-10-01T09:00:00.000Z') });
}
function grantRecord(): Record<string, unknown> {
  const now = Date.now();
  return { approval_id: 'hgr-0123456789ab', request_id: 'hatch-omp-hook-aaaaaaaaaaaa', hook_id: 'omp-hook', origin: { agent: 'omp', sessionId: 'omp-session-1' }, route: 'acp:omp-session-1', approved_at: now, expires_at: now + 24 * 3_600_000, consumed_at: null };
}
