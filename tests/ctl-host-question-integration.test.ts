import { afterAll, beforeAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon, trackProc } from './helpers/daemon-lifecycle';

// tg-cli#544 / #535 (docs/specs/2026-09-30-harness-agnostic-control.md §4.1): a Claude Code
// session the rig wrapper hosts in abduco OUTSIDE tmux forwards its native question and
// permission cards. The hook (`tg-ctl ask`, no TMUX_PANE) scopes its request to `host:<name>`
// from $RIG_SESSION — only when its own process tree runs under that host's abduco server —
// and the daemon believes the scope only while the host registry proves the host live. A
// scoped hosted question defers inbound for ITS session only; late answers and hatch grant
// notices are typed into the session's PTY through the abduco client protocol, exactly once.
//
// Three hosts (landing, billing, flaky) under PATH-shimmed ps; the `tg-ctl ask` process itself
// is listed under landing's claude (the shim prints `$PPID`, the process that ran ps). The abduco
// stand-ins record every packet a client sends, so each byte typed into a PTY is observable;
// flaky's drops the connection as soon as text arrives (the "may be in its prompt" case).

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const A = 'claude-aaaaaaaaaaaa';
const B = 'claude-bbbbbbbbbbbb';
const C = 'claude-cccccccccccc';
const A_CWD = '/Users/u/work/landing';
const SLOW = 60_000;

const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-hostq-'));
// Under /tmp, not tmpdir(): a unix socket path must fit sun_path (104 bytes on Darwin).
const sockDir = mkdtempSync('/tmp/tgq-');
const socketOf = (name: string): string => join(sockDir, `${name}@testhost`);
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
// NO registration file: the wrapper's live host record is the hosted session's registration.

mkdirSync(join(cfgDir, 'hosts'), { mode: 0o700 });
function writeRecord(name: string, label: string, cwd: string, serverPid: number): void {
  writeFileSync(
    join(cfgDir, 'hosts', `${name}.json`),
    JSON.stringify({
      v: 1,
      name,
      harness: 'claude',
      label,
      cwd,
      socket: socketOf(name),
      serverPid,
      harnessPid: serverPid + 2,
      role: 'coordinator',
      startedAt: '2026-10-10T08:00:00Z',
      updatedAt: '2026-10-10T08:00:00Z',
    }),
    { mode: 0o600 },
  );
}
writeRecord(A, 'landing', A_CWD, 41000);
writeRecord(B, 'billing', '/Users/u/work/billing', 42000);
writeRecord(C, 'flaky', '/Users/u/work/flaky', 43000);

const binDir = join(cfgDir, 'bin');
mkdirSync(binDir);
writeFileSync(join(binDir, 'tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
writeFileSync(
  join(binDir, 'ps'),
  `#!/bin/sh
case "$*" in
  *tty*)
    printf '    1 ??\\n'
    printf '41002 ttys010\\n'
    printf '42002 ttys011\\n'
    ;;
  *)
    printf '    1     0 /sbin/launchd\\n'
    printf '41000     1 abduco -n ${A} rig host-run ${A}\\n'
    printf '41001 41000 /opt/homebrew/bin/python3 /Users/u/bin/rig host-run ${A}\\n'
    printf '41002 41001 /Users/u/.local/bin/claude --name landing\\n'
    printf '41003 41002 /bin/sh -c tg-ctl ask\\n'
    printf '%s 41003 bun tg-ctl ask\\n' "$PPID"
    printf '42000     1 abduco -n ${B} rig host-run ${B}\\n'
    printf '42001 42000 /opt/homebrew/bin/python3 /Users/u/bin/rig host-run ${B}\\n'
    printf '42002 42001 /Users/u/.local/bin/claude --name billing\\n'
    printf '43000     1 abduco -n ${C} rig host-run ${C}\\n'
    printf '43001 43000 /opt/homebrew/bin/python3 /Users/u/bin/rig host-run ${C}\\n'
    printf '43002 43001 /Users/u/.local/bin/claude --name flaky\\n'
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
  41002) printf 'p41002\\nfcwd\\nn${A_CWD}\\n' ;;
  42002) printf 'p42002\\nfcwd\\nn/Users/u/work/billing\\n' ;;
esac
exit 0
`,
  { mode: 0o755 },
);

// --- abduco stand-ins: per host, one entry per client connection, the packets it sent ---
interface Packet {
  type: number;
  payload: Buffer;
}
function decode(buf: Buffer): Packet[] {
  const out: Packet[] = [];
  for (let off = 0; off + 16 <= buf.length; ) {
    const len = Number(buf.readBigUInt64LE(off + 8));
    out.push({ type: buf.readUInt32LE(off), payload: buf.subarray(off + 16, off + 16 + len) });
    off += 16 + len;
  }
  return out;
}
const connections: Record<string, Packet[][]> = { [A]: [], [B]: [], [C]: [] };
const abducos = [A, B, C].map((name) =>
  Bun.listen<{ chunks: Buffer[] }>({
    unix: socketOf(name),
    socket: {
      open(sock) {
        sock.data = { chunks: [] };
      },
      data(sock, data) {
        sock.data.chunks.push(Buffer.from(data));
        // flaky: the session goes away right after the text reached it, before the Enter.
        if (name === C && decode(Buffer.concat(sock.data.chunks)).some((p) => p.type === 0)) sock.end();
      },
      close(sock) {
        connections[name].push(decode(Buffer.concat(sock.data.chunks)));
      },
    },
  }),
);
// What was typed into a host's PTY, per connection: the MSG_CONTENT payloads, joined.
const typed = (name: string): string[] =>
  connections[name].map((c) =>
    c
      .filter((p) => p.type === 0)
      .map((p) => p.payload.toString('utf8'))
      .join(''),
  );

// --- fake Bot API: a queue of update batches; every sent/edited message recorded ---
// A Bot API request body, read field by field (the daemon is the code under test, not a trusted typer).
const field = (body: unknown, key: string): unknown => (body !== null && typeof body === 'object' && key in body ? Reflect.get(body, key) : undefined);
// The callback_data of every inline-keyboard button, row by row.
function callbackData(body: unknown): string[] {
  const rows = field(field(body, 'reply_markup'), 'inline_keyboard');
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => (Array.isArray(row) ? row.map((b) => String(field(b, 'callback_data'))) : []));
}
interface Sent {
  id: number;
  text: string;
  buttons: string[];
}
const updateQueue: unknown[][] = [];
const sent: Sent[] = [];
const edited: Array<{ messageId: unknown; text: string }> = [];
const callbackToasts: string[] = [];
let nextId = 100;
const nowSec = (): number => Math.floor(Date.now() / 1000);
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/getUpdates')) {
      const batch = updateQueue.shift();
      if (batch) return Response.json({ ok: true, result: batch });
      await Bun.sleep(60); // the long poll's idle wait, so the daemon does not spin
      return Response.json({ ok: true, result: [] });
    }
    if (url.pathname.endsWith('/sendMessage')) {
      const id = ++nextId;
      const body: unknown = await req.json();
      sent.push({ id, text: String(field(body, 'text')), buttons: callbackData(body) });
      return Response.json({ ok: true, result: { message_id: id } });
    }
    if (url.pathname.endsWith('/editMessageText')) {
      const body: unknown = await req.json();
      edited.push({ messageId: field(body, 'message_id'), text: String(field(body, 'text')) });
      return Response.json({ ok: true, result: true });
    }
    if (url.pathname.endsWith('/answerCallbackQuery')) {
      callbackToasts.push(String(field(await req.json(), 'text')));
      return Response.json({ ok: true, result: true });
    }
    return Response.json({ ok: true, result: true });
  },
});

let updateSeq = 1000;
const message = (message_id: number, text: string, replyTo?: number) => ({
  update_id: ++updateSeq,
  message: {
    message_id,
    from: { id: 1, first_name: 'Alex' },
    chat: { id: 1 },
    date: nowSec(),
    text,
    ...(replyTo ? { reply_to_message: { message_id: replyTo, date: nowSec(), chat: { id: 1 }, text: 'card' } } : {}),
  },
});
const tap = (data: string, cardId: number) => ({
  update_id: ++updateSeq,
  callback_query: {
    id: `cb${updateSeq}`,
    from: { id: 1, first_name: 'Alex' },
    message: { message_id: cardId, chat: { id: 1 }, date: nowSec() },
    data,
  },
});

const reg = createDaemonRegistry();
afterAll(async () => {
  await reapDaemons(reg);
  server.stop(true);
  for (const a of abducos) a.stop(true);
  rmSync(cfgDir, { recursive: true, force: true });
  rmSync(sockDir, { recursive: true, force: true });
});
const env = { PATH: `${binDir}:${process.env.PATH ?? ''}`, HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}` };
const daemonLog = (): string => (existsSync(join(cfgDir, 'daemon.log')) ? readFileSync(join(cfgDir, 'daemon.log'), 'utf8') : '');
// The daemon logs each PTY typing before it starts, so a count read after any later signal is complete.
const typingsInto = (name: string): number => daemonLog().split('\n').filter((l) => l.includes(`host-pty: `) && l.includes(` → ${name} (`)).length;
const cards = (): Sent[] => sent.filter((m) => m.buttons.length > 0);
// The delivery ledger (tg-cli#299): one JSON event per line.
const ledger = (): Array<{ event: unknown; msg: unknown; target: unknown }> =>
  readFileSync(join(cfgDir, 'tg-ctl.123.delivery.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => {
      const e: unknown = JSON.parse(l);
      return { event: field(e, 'event'), msg: field(e, 'msg'), target: field(e, 'target') };
    });

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

// `tg-ctl ask` exactly as Claude Code runs the installed hook inside the hosted session:
// no TMUX / TMUX_PANE, $RIG_SESSION exported by the wrapper.
function startAsk(payload: Record<string, unknown>, rigSession: string | null = A): Subprocess<'pipe', 'pipe', 'pipe'> {
  const ask = trackProc(
    reg,
    Bun.spawn([process.execPath, TG_CTL, 'ask'], {
      env: { ...env, ...(rigSession ? { RIG_SESSION: rigSession } : {}) },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  );
  ask.stdin.write(`${JSON.stringify(payload)}\n`);
  ask.stdin.end();
  return ask;
}
const askUserQuestion = (question: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'AskUserQuestion',
  session_id: 'a1b2c3d4-0000-4000-8000-000000000001',
  cwd: A_CWD,
  tool_input: {
    questions: [{ question, header: 'Deploy', multiSelect: false, options: [{ label: 'Staging', description: '' }, { label: 'Production', description: '' }] }],
  },
});

beforeAll(async () => {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'w');
  await spawnDaemon(reg, { tgCtlPath: TG_CTL, cfgDir, env, logFd });
  closeSync(logFd);
});

test('#544: a hosted question is scoped to host:<name> — it defers inbound for its own session only, and the answer reaches the hook', async () => {
  const ask = startAsk(askUserQuestion('Where should landing deploy?'));
  expect(await until(() => cards().length === 1, 10_000)).toBe(true);
  const card = cards()[0];
  expect(daemonLog()).toContain(`pane=host:${A}`);
  expect(daemonLog()).not.toContain('reason=not-registered');

  // The other hosted session is not blocked by landing's open question; landing's own message waits.
  updateQueue.push([message(10, '/agent billing hello billing'), message(11, '/agent landing hello landing')]);
  expect(await until(() => typed(B).some((t) => t.includes('hello billing')), 10_000)).toBe(true);
  expect(await until(() => ledger().some((e) => e.msg === 11 && e.event === 'queued' && e.target === `host:${A}`), 10_000)).toBe(true);
  expect(typed(A).some((t) => t.includes('hello landing'))).toBe(false);

  // The tap answers the live hook; then landing's queued message is typed into its PTY once.
  updateQueue.push([tap(card.buttons[1], card.id)]);
  const stdout = await new Response(ask.stdout).text();
  await ask.exited;
  expect(JSON.parse(stdout).hookSpecificOutput.updatedInput.answers).toEqual({ 'Where should landing deploy?': 'Production' });
  expect(await until(() => ledger().some((e) => e.msg === 11 && e.event === 'delivered' && e.target === `host:${A}`), 10_000)).toBe(true);
  expect(typed(A).filter((t) => t.includes('hello landing') && t.includes('tg#11'))).toHaveLength(1);
}, SLOW);

test('#535: a hosted question answered after its hook gave up is typed into the PTY exactly once — by tap and by text reply', async () => {
  // Tap path.
  const before = cards().length;
  const ask = startAsk(askUserQuestion('Ship the landing page?'));
  expect(await until(() => cards().length === before + 1, 10_000)).toBe(true);
  const card = cards()[before];
  ask.kill(9);
  await ask.exited;
  expect(await until(() => edited.some((e) => e.messageId === card.id), 10_000)).toBe(true);
  const typedBefore = typed(A).length;
  const typingsBefore = typingsInto(A);
  updateQueue.push([tap(card.buttons[0], card.id)]);
  expect(await until(() => typed(A).length === typedBefore + 1, 10_000)).toBe(true);
  expect(typed(A)[typedBefore]).toContain('Staging');
  expect(await until(() => callbackToasts.at(-1) === '✓ sent to the agent', 10_000)).toBe(true);
  // A second tap on the answered card is answered with a toast and types nothing.
  const toasts = callbackToasts.length;
  updateQueue.push([tap(card.buttons[0], card.id)]);
  expect(await until(() => callbackToasts.length === toasts + 1, 10_000)).toBe(true);
  expect(typingsInto(A)).toBe(typingsBefore + 1);

  // Text-reply path: the reply is the answer, recorded once in the ledger for host:<name>.
  const ask2 = startAsk(askUserQuestion('Which banner?'));
  expect(await until(() => cards().length === before + 2, 10_000)).toBe(true);
  const card2 = cards()[before + 1];
  ask2.kill(9);
  await ask2.exited;
  expect(await until(() => edited.some((e) => e.messageId === card2.id), 10_000)).toBe(true);
  updateQueue.push([message(20, 'the blue one', card2.id)]);
  expect(await until(() => ledger().some((e) => e.msg === 20 && e.event === 'delivered' && e.target === `host:${A}`), 10_000)).toBe(true);
  // A second reply to the answered card is no answer any more: it is routed like any message
  // (three sessions → the picker), never typed into the session that asked.
  updateQueue.push([message(21, 'the red one', card2.id)]);
  expect(await until(() => daemonLog().includes(`reply-route: replyTo=${card2.id} → 3 candidates`), 10_000)).toBe(true);
  expect(typed(A).filter((t) => t.includes('the blue one'))).toHaveLength(1);
  expect(daemonLog()).not.toContain('tg#21 → ');
}, SLOW);

test('#535: a late hatch approval from a hosted session types the grant notice into its PTY', async () => {
  const before = cards().length;
  const ask = startAsk({
    requestId: 'hatch-host-hook-aaaaaaaaaaaa',
    agent: 'claude',
    kind: 'permission',
    question: 'Allow rig hatch escalation: host-hook?',
    permissionEvent: 'PermissionRequest',
    hookId: 'host-hook',
    origin: { agent: 'claude' },
    operation: { kind: 'bash', fingerprint: 'sha256:fp-host', cwd: A_CWD },
    cwd: A_CWD,
  });
  expect(await until(() => cards().length === before + 1, 10_000)).toBe(true);
  const card = cards()[before];
  ask.kill(9);
  await ask.exited;
  expect(await until(() => edited.some((e) => e.messageId === card.id && e.text.includes('24h')), 10_000)).toBe(true);
  const typedBefore = typed(A).length;
  updateQueue.push([tap(card.buttons[0], card.id)]);
  expect(await until(() => callbackToasts.includes('✓ grant issued and sent to the agent'), 10_000)).toBe(true);
  const minted = daemonLog().match(/hatch-grant-minted: .* approvalId=(hgr-[0-9a-f]+) route=pane:host:claude-aaaaaaaaaaaa/);
  expect(minted).not.toBeNull();
  expect(await until(() => typed(A).length === typedBefore + 1, 10_000)).toBe(true);
  expect(typed(A)[typedBefore]).toContain(minted![1]);
}, SLOW);

test('#535: a late permission tap for a hosted session is queued for the reconnecting hook — no pane to re-verify, nothing typed', async () => {
  const before = cards().length;
  const ask = startAsk({ requestId: 'perm-host-1', agent: 'claude', kind: 'permission', question: 'Allow Bash? rm -rf build', permissionEvent: 'PermissionRequest', cwd: A_CWD });
  expect(await until(() => cards().length === before + 1, 10_000)).toBe(true);
  const card = cards()[before];
  ask.kill(9);
  await ask.exited;
  expect(await until(() => edited.some((e) => e.messageId === card.id), 10_000)).toBe(true);
  const typingsBefore = typingsInto(A);
  updateQueue.push([tap(card.buttons[0], card.id)]);
  expect(await until(() => daemonLog().includes('ask-permission-decision-queued: agent=claude kind=permission req=perm-host-1'), 10_000)).toBe(true);
  expect(await until(() => callbackToasts.at(-1)?.startsWith('queued') === true, 10_000)).toBe(true);
  expect(daemonLog()).not.toContain('ask-late-deliver-permission-pane');
  expect(typingsInto(A)).toBe(typingsBefore);
}, SLOW);

test('#535: a late answer whose host drops the connection after the text is reported in the chat and never typed again', async () => {
  const before = cards().length;
  // A hook in the flaky session: a normalized request carrying its host scope, verified live by the daemon.
  const ask = startAsk({ requestId: 'q-flaky', agent: 'claude', kind: 'question', question: 'Retry the deploy?', options: [{ label: 'Retry' }, { label: 'Skip' }], paneId: `host:${C}`, cwd: '/Users/u/work/flaky' }, null);
  expect(await until(() => cards().length === before + 1, 10_000)).toBe(true);
  const card = cards()[before];
  ask.kill(9);
  await ask.exited;
  expect(await until(() => edited.some((e) => e.messageId === card.id), 10_000)).toBe(true);
  updateQueue.push([tap(card.buttons[0], card.id)]);
  expect(await until(() => callbackToasts.at(-1) === 'typed but not sent — see the chat', 10_000)).toBe(true);
  expect(sent.some((m) => m.text.includes('may already be in its prompt'))).toBe(true);
  expect(typingsInto(C)).toBe(1);
  // A re-tap finds the answer claimed: nothing is typed a second time.
  const toasts = callbackToasts.length;
  updateQueue.push([tap(card.buttons[0], card.id)]);
  expect(await until(() => callbackToasts.length === toasts + 1, 10_000)).toBe(true);
  expect(typingsInto(C)).toBe(1);
}, SLOW);

test('#544: the host scope is never taken from env alone — a session the hook does not run under, or a host that is not live, stays unscoped', async () => {
  // $RIG_SESSION names billing, but the hook process runs under landing's abduco server.
  const forged = startAsk(askUserQuestion('Forged env question?'), B);
  await forged.exited;
  // A normalized request carrying a host scope with no live record behind it.
  const ghost = startAsk(
    { requestId: 'q-ghost', agent: 'claude', kind: 'question', question: 'Ghost?', options: [{ label: 'x' }], paneId: 'host:claude-dddddddddddd', cwd: '/nowhere' },
    null,
  );
  await ghost.exited;
  // A malformed host address is not a tmux pane either: dropped the same way.
  const malformed = startAsk(
    { requestId: 'q-malformed', agent: 'claude', kind: 'question', question: 'Malformed?', options: [{ label: 'x' }], paneId: 'host:../etc', cwd: '/nowhere' },
    null,
  );
  await malformed.exited;
  const log = daemonLog();
  expect(log).toMatch(/ask-forward dropped: reason=not-registered agent=claude kind=question req=\S+ subagent=- window=- pane=- cwd=\/Users\/u\/work\/landing/);
  expect(log).not.toContain(`pane=host:${B}`);
  expect(log).toContain('ask-forward host-unverified: host:claude-dddddddddddd');
  expect(log).toMatch(/ask-forward dropped: reason=not-registered agent=claude kind=question req=q-ghost .*pane=- /);
  expect(log).toContain('ask-forward host-unverified: host:../etc');
  expect(log).toMatch(/ask-forward dropped: reason=not-registered agent=claude kind=question req=q-malformed .*pane=- /);
}, SLOW);
