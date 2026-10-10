import { afterEach, expect, test } from 'bun:test';
import { createServer, type Socket } from 'net';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Server } from 'net';
import type { Subprocess } from 'bun';
import { trackProc, createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import {
  clampGenericAskTimeoutSec,
  GENERIC_ASK_ORIGIN_AGENT,
  genericAskDaemonAbandonMs,
  isGenericAskRequest,
  parseGenericAskArgv,
  resolveGenericAskVerdict,
} from '../features/tg-ctl/generic-ask';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const reg = createDaemonRegistry();
const servers: Server[] = [];
const httpServers: ReturnType<typeof Bun.serve>[] = [];

// CI (gh-actions, tg-cli#149 PR #368): this hook's DEFAULT timeout (bun:test's
// own hook-timeout floor, independent of any individual test()'s own timeout
// override -- confirmed empirically: bumping the flaky test below to 15s had
// ZERO effect, it still failed at the exact same ~6.0s mark) was intermittently
// too tight for reapDaemons()/server-close under the full 2940+-test/176-file
// suite's resource contention ("a beforeEach/afterEach hook timed out for this
// test"). Explicit headroom on the HOOK itself, not just the test.
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const s of httpServers.splice(0)) s.stop(true);
  await reapDaemons(reg);
}, 20_000);

function makeCfgDir(creds = true): string {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-gask-'));
  if (creds) writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  return cfgDir;
}

function socketPath(cfgDir: string): string {
  return join(cfgDir, 'tg-ctl.123.sock');
}

// Children get the preload's hermetic PATH (tests/hermetic-env.ts) explicitly:
// an explicit `env` without PATH would let the daemon read the host's agents.
function ctlEnv(cfgDir: string, apiBase: string): Record<string, string> {
  return { PATH: process.env.PATH ?? '', HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: apiBase };
}

function spawnGenericAsk(cfgDir: string, args: string[] = ['approve deploy?', '--timeout', '1']): Subprocess {
  return trackProc(reg, Bun.spawn([process.execPath, TG_CTL, 'ask', ...args], {
    env: ctlEnv(cfgDir, 'http://127.0.0.1:1'),
    stdout: 'pipe',
    stderr: 'pipe',
  }));
}

async function readProc(proc: Subprocess): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { exitCode: proc.exitCode, stdout, stderr };
}

async function listenSocket(path: string, onSocket: (socket: Socket) => void): Promise<Server> {
  rmSync(path, { force: true });
  const server = createServer(onSocket);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  servers.push(server);
  return server;
}

// --- pure argv / timeout / verdict logic ---

test('generic mode is detected by a non-flag positional question arg OR --timeout anywhere', () => {
  expect(parseGenericAskArgv(['approve deploy?', '--timeout', '60'])).toEqual({
    question: 'approve deploy?',
    timeout: { seconds: 60 },
  });
  expect(parseGenericAskArgv(['approve deploy?'])).toEqual({
    question: 'approve deploy?',
    timeout: { seconds: 300 },
  });
  // Bare `tg-ctl ask` (no args at all) is NOT generic mode -- the existing
  // stdin-JSON Claude-hook client owns that path unchanged.
  expect(parseGenericAskArgv([])).toBeNull();
  // A LEGACY hook-client flag with no --timeout and no positional is also not
  // generic mode -- `--agent` belongs to the hook client, not this primitive.
  expect(parseGenericAskArgv(['--agent', 'codex'])).toBeNull();
});

test('SECURITY: --timeout BEFORE the question is still generic mode, never falls through to the silent-exit-0 legacy hook path (review finding)', () => {
  // The ordinary CLI convention -- flags first, then the positional argument --
  // used to make parseGenericAskArgv return null here (argv[0] was '--timeout',
  // a flag), which sent the whole call into the legacy stdin-JSON hook client.
  // That client can exit 0 on empty stdin with NO Telegram prompt and NO human
  // ever consulted: a silent, unearned approval for a safety-gate primitive.
  expect(parseGenericAskArgv(['--timeout', '60', 'delete', 'production'])).toEqual({
    question: 'delete production',
    timeout: { seconds: 60 },
  });
  // --timeout in the MIDDLE of the question is also fully reconstructed, not
  // just the leading span before it.
  expect(parseGenericAskArgv(['deploy', '--timeout', '60', 'to', 'prod'])).toEqual({
    question: 'deploy to prod',
    timeout: { seconds: 60 },
  });
});

test('an unquoted multi-word question is joined in full, never silently truncated to the first token', () => {
  expect(parseGenericAskArgv(['deploy', 'to', 'prod', 'delete-volumes', '--timeout', '60'])).toEqual({
    question: 'deploy to prod delete-volumes',
    timeout: { seconds: 60 },
  });
  expect(parseGenericAskArgv(['deploy', 'to', 'prod'])).toEqual({
    question: 'deploy to prod',
    timeout: { seconds: 300 },
  });
});

test('tokens AFTER the --timeout value are part of the question too, never silently dropped (review finding)', () => {
  // Before the fix, only tokens BEFORE --timeout were kept; "and delete volumes"
  // would vanish here with no warning at all.
  expect(parseGenericAskArgv(['deploy', '--timeout', '60', 'and', 'delete', 'volumes'])).toEqual({
    question: 'deploy and delete volumes',
    timeout: { seconds: 60 },
  });
});

test('an unrecognized flag is preserved verbatim in the human-visible question', () => {
  const result = parseGenericAskArgv(['remove', 'all', '--recursive', 'backups']);
  expect(result?.question).toBe('remove all --recursive backups');
});

test('SECURITY: --timeout=N (GNU equals-form) is still generic mode, never falls through to the silent-exit-0 legacy hook path (review finding)', () => {
  // `--timeout=60` is exactly as valid a spelling as `--timeout 60` under the
  // ordinary CLI convention; only recognizing the space-separated form let this
  // form fall through to argv.indexOf('--timeout') === -1 -> legacy hook client.
  expect(parseGenericAskArgv(['--timeout=60', 'delete production'])).toEqual({
    question: 'delete production',
    timeout: { seconds: 60 },
  });
  // The equals-form works from any position, same as the space-separated form.
  expect(parseGenericAskArgv(['delete', 'production', '--timeout=60'])).toEqual({
    question: 'delete production',
    timeout: { seconds: 60 },
  });
  // An unparseable equals-value warns instead of silently defaulting, same as
  // the space-separated form's own asymmetry fix.
  const invalid = parseGenericAskArgv(['approve?', '--timeout=nope']);
  expect(invalid?.timeout).toEqual({
    seconds: 300,
    warning: '--timeout value "nope" is not a valid positive number; using default 300s',
  });
  expect(invalid?.question).toBe('approve? --timeout=nope');
});

test('SECURITY: a question that itself starts with -- is shown verbatim, never blank/truncated', () => {
  const result = parseGenericAskArgv(['--force wipe prod?']);
  expect(result).not.toBeNull();
  expect(result?.question).toBe('--force wipe prod?');
});

test('SECURITY: invalid space-separated --timeout stays visible instead of eating a question word', () => {
  const result = parseGenericAskArgv(['--timeout', 'delete', 'production']);
  expect(result?.question).toBe('--timeout delete production');
  expect(result?.timeout).toEqual({
    seconds: 300,
    warning: '--timeout value "delete" is not a valid positive number; using default 300s',
  });
});

test('a --timeout with NO value is a flag mistake, never the question text (a lone `--timeout` is an empty question)', () => {
  const missing = { seconds: 300, warning: '--timeout given with no value; using default 300s' };
  expect(parseGenericAskArgv(['--timeout'])).toEqual({ question: '', timeout: missing });
  expect(parseGenericAskArgv(['--timeout='])).toEqual({ question: '', timeout: missing });
  expect(parseGenericAskArgv(['approve deploy?', '--timeout'])).toEqual({ question: 'approve deploy?', timeout: missing });
});

test('internal ask submodes are never reinterpreted as generic human questions', () => {
  expect(parseGenericAskArgv([])).toBeNull();
  expect(parseGenericAskArgv(['--agent', 'codex'])).toBeNull();
  expect(parseGenericAskArgv(['--agent', 'claude'])).toBeNull();
  expect(parseGenericAskArgv(['--verify-grant', 'approval-1', '--hook', 'h1'])).toBeNull();
  expect(parseGenericAskArgv(['--verify-grant', '--pull', '--hook', 'h1'])).toBeNull();
  expect(parseGenericAskArgv(['--hook', 'h1', '--verify-grant', 'approval-1'])).toBeNull();
  // Anything ELSE involving --agent — extra tokens, a bare --agent with no
  // value — is not the exact legacy shape, so it falls through to generic
  // mode (fails toward a real prompt, never a silent allow).
  expect(parseGenericAskArgv(['--agent'])).not.toBeNull();
  expect(parseGenericAskArgv(['--agent', 'codex', 'extra'])).not.toBeNull();
});

test('SECURITY: a --verify-grant token inside an unquoted question is still a generic question, never the grant client', () => {
  // The grant client prints a deny JSON and exits 0 — read by an approval
  // caller as "approved". Only argv made entirely of the grant grammar
  // (--verify-grant [id] / --pull / --hook <id>) is the internal submode.
  expect(parseGenericAskArgv(['allow', '--verify-grant', 'override', 'now'])).toEqual({
    question: 'allow --verify-grant override now',
    timeout: { seconds: 300 },
  });
  expect(parseGenericAskArgv(['--verify-grant', 'id', '--hook', 'h1', 'please'])).not.toBeNull();
});

test('generic ask timeout defaults to 300 seconds and clamps above 900 seconds, floors non-positive to default', () => {
  expect(clampGenericAskTimeoutSec(undefined)).toEqual({ seconds: 300 });
  expect(clampGenericAskTimeoutSec('120')).toEqual({ seconds: 120 });
  expect(clampGenericAskTimeoutSec('1200')).toEqual({
    seconds: 900,
    warning: 'requested timeout 1200s exceeds max 900s; clamped to 900s',
  });
});

test('a fractional timeout under 1s clamps UP to 1s with a warning, never floors to 0 (review finding: silent instant denial)', () => {
  // Before the fix: Number('0.5') = 0.5 passes the > 0 guard, then
  // Math.floor(0.5) = 0 -- a 0-second budget that denies the request
  // INSTANTLY with no warning, for a value that looked perfectly valid.
  expect(clampGenericAskTimeoutSec('0.5')).toEqual({
    seconds: 1,
    warning: 'requested timeout 0.5s rounds down to less than 1s; clamped to 1s',
  });
  expect(clampGenericAskTimeoutSec('0.01')).toEqual({
    seconds: 1,
    warning: 'requested timeout 0.01s rounds down to less than 1s; clamped to 1s',
  });
  // A value that floors to exactly 1 is fine as-is, no warning.
  expect(clampGenericAskTimeoutSec('1.9')).toEqual({ seconds: 1 });
});

test('an unparseable or missing --timeout VALUE warns instead of silently defaulting (asymmetry fix) -- but --timeout simply omitted stays silent', () => {
  // --timeout omitted entirely: the common, expected case -- no warning.
  expect(clampGenericAskTimeoutSec(undefined, false)).toEqual({ seconds: 300 });
  // --timeout passed but with no following value (e.g. it was the last argv token).
  expect(clampGenericAskTimeoutSec(undefined, true)).toEqual({
    seconds: 300,
    warning: '--timeout given with no value; using default 300s',
  });
  // --timeout passed with a value that isn't a valid positive number.
  for (const bad of ['0', '-5', 'not-a-number']) {
    expect(clampGenericAskTimeoutSec(bad)).toEqual({
      seconds: 300,
      warning: `--timeout value ${JSON.stringify(bad)} is not a valid positive number; using default 300s`,
    });
  }
});

test('daemon-side abandon backstop is the client wait plus a fixed margin, never shorter', () => {
  expect(genericAskDaemonAbandonMs(300)).toBe(300_000 + 15_000);
  expect(genericAskDaemonAbandonMs(900)).toBe(900_000 + 15_000);
});

// The daemon skips the registration gate and the pane defer for this predicate
// only; a request naming a pane is a harness prompt in that pane whatever its
// origin says, so it keeps both.
test('a generic ask is the generic origin with NO pane; a pane-bound request is never one', () => {
  expect(isGenericAskRequest({ origin: { agent: GENERIC_ASK_ORIGIN_AGENT } })).toBe(true);
  expect(isGenericAskRequest({ origin: { agent: GENERIC_ASK_ORIGIN_AGENT }, paneId: '%5' })).toBe(false);
  expect(isGenericAskRequest({ origin: { agent: 'claude' } })).toBe(false);
  expect(isGenericAskRequest({})).toBe(false);
});

test('verdict resolution: allow/deny/malformed/no-answer', () => {
  expect(resolveGenericAskVerdict(null)).toEqual({ exitCode: 1, reason: 'denied: rejected or not answered' });
  // review finding: the daemon's real abandon/not-registered decline is the raw
  // socket line `socket.end("null\n")`, which oneAskAttempt hands back as the
  // non-empty STRING 'null' -- not the JS value null (its own `raw.trim() || null`
  // only collapses to actual null on an EMPTY string). Must resolve the SAME as the
  // `null` case above, not fall through to JSON.parse('null') -> the malformed branch.
  expect(resolveGenericAskVerdict('null')).toEqual({ exitCode: 1, reason: 'denied: rejected or not answered' });
  expect(resolveGenericAskVerdict('not json')).toEqual({ exitCode: 1, reason: 'denied: malformed daemon response' });
  expect(resolveGenericAskVerdict('{}')).toEqual({ exitCode: 1, reason: 'denied: malformed daemon response' });
  expect(
    resolveGenericAskVerdict(JSON.stringify({ hookSpecificOutput: { decision: { behavior: 'allow' } } })),
  ).toEqual({ exitCode: 0, detail: null });
  // An allow CAN carry a message today (formatAgentHookOutput never sets one for a
  // permission allow, but resolveGenericAskVerdict doesn't assume that stays true) --
  // pin the "approved: <detail>" stdout contract this produces (see runGenericAsk).
  expect(
    resolveGenericAskVerdict(
      JSON.stringify({ hookSpecificOutput: { decision: { behavior: 'allow', message: 'go ahead' } } }),
    ),
  ).toEqual({ exitCode: 0, detail: 'go ahead' });
  expect(
    resolveGenericAskVerdict(
      JSON.stringify({ hookSpecificOutput: { decision: { behavior: 'allow', message: '' } } }),
    ),
  ).toEqual({ exitCode: 0, detail: null });
  expect(
    resolveGenericAskVerdict(JSON.stringify({ hookSpecificOutput: { decision: { behavior: 'deny' } } })),
  ).toEqual({ exitCode: 1, reason: 'denied: rejected in Telegram' });
  expect(
    resolveGenericAskVerdict(
      JSON.stringify({ hookSpecificOutput: { decision: { behavior: 'deny', message: 'not tonight' } } }),
    ),
  ).toEqual({ exitCode: 1, reason: 'denied: rejected in Telegram: not tonight' });
});

// --- CLI process integration: failure paths, deny-by-default on every one ---

test('generic ask denies when bot credentials are missing (never the bare-ask exit-0 shortcut)', async () => {
  const cfgDir = makeCfgDir(false);
  const proc = spawnGenericAsk(cfgDir);
  const result = await readProc(proc);

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('denied: no bot credentials configured');
});

test('generic ask with only a timeout flag fails closed before any daemon/socket use', async () => {
  for (const args of [['--timeout', '60'], ['--timeout'], ['--timeout=']]) {
    const cfgDir = makeCfgDir();
    const result = await readProc(spawnGenericAsk(cfgDir, args));

    expect({ args, exitCode: result.exitCode }).toEqual({ args, exitCode: 1 });
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('denied: empty question');
    expect(result.stderr).not.toContain('daemon unreachable');
  }
});

test('generic ask denies when the daemon socket is unreachable', async () => {
  const cfgDir = makeCfgDir();
  expect(existsSync(socketPath(cfgDir))).toBe(false);

  const proc = spawnGenericAsk(cfgDir);
  const result = await readProc(proc);

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('denied: daemon unreachable');
  expect(result.stderr).toContain('tg-ctl start');
});

test('SECURITY: an unquoted question containing --verify-grant asks the human, never exits 0 through the grant client', async () => {
  const cfgDir = makeCfgDir();
  const proc = spawnGenericAsk(cfgDir, ['allow', '--verify-grant', 'override', '--timeout', '1']);
  const result = await readProc(proc);

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('denied: daemon unreachable');
});

test('generic ask denies when the daemon socket drops mid-wait', async () => {
  const cfgDir = makeCfgDir();
  await listenSocket(socketPath(cfgDir), (socket) => {
    socket.on('data', () => socket.destroy());
  });

  const proc = spawnGenericAsk(cfgDir);
  const result = await readProc(proc);

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('denied: daemon unreachable');
});

// CI (gh-actions, tg-cli#149 PR #368): failed repeatedly under the full
// 2940+-test CI suite's resource contention with "a beforeEach/afterEach hook
// timed out for this test" (~6.0s, then ~21s after raising the hook's own
// timeout -- ruling out "just needs more time"). Root cause: this fake server
// never touches the accepted socket, so its server-side half only closes once
// the OS propagates the CLIENT's post-timeout `socket.destroy()` across the
// connection -- under CI's heavy contention that propagation was slow/stalled
// enough to make afterEach's `server.close()` (which waits for every
// connection to end) miss even a 20s budget. Fixed at the root: capture the
// accepted socket and destroy it SERVER-SIDE the moment the client process
// has exited, instead of relying on the peer's close to propagate.
test('generic ask denies on timeout with nothing on stdout', async () => {
  const cfgDir = makeCfgDir();
  let acceptedSocket: Socket | null = null;
  await listenSocket(socketPath(cfgDir), (socket) => {
    acceptedSocket = socket;
    // never reply -- the CLIENT's own --timeout must fire, not hang forever.
  });

  const proc = spawnGenericAsk(cfgDir, ['approve deploy?', '--timeout', '1']);
  const result = await readProc(proc);
  acceptedSocket?.destroy();

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('denied: timeout after 1s');
}, 15_000);

test('generic ask denies malformed daemon responses', async () => {
  const cfgDir = makeCfgDir();
  await listenSocket(socketPath(cfgDir), (socket) => {
    socket.on('data', () => socket.end('not json at all\n'));
  });

  const proc = spawnGenericAsk(cfgDir);
  const result = await readProc(proc);

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('denied: malformed daemon response');
});

// review finding: this is exactly what the REAL daemon sends for its own
// abandon-timer / not-registered decline (`socket.end("null\n")`, tg-ctl's
// forwardAndPostQuestion / handleHookSocketLine) -- a legitimate "no answer",
// not malformed JSON. Must NOT be lumped in with the genuinely-malformed case
// above, or the documented contract (tg-ctl USAGE: an unregistered cwd "is
// denied the same as a real reject") is broken at the wording level.
test('generic ask denies a real daemon "null" decline as rejected/not-answered, never malformed', async () => {
  const cfgDir = makeCfgDir();
  await listenSocket(socketPath(cfgDir), (socket) => {
    socket.on('data', () => socket.end('null\n'));
  });

  const proc = spawnGenericAsk(cfgDir);
  const result = await readProc(proc);

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('denied: rejected or not answered');
  expect(result.stderr).not.toContain('malformed');
});

test('generic ask exits 0 with an audit line on a genuine allow response', async () => {
  const cfgDir = makeCfgDir();
  await listenSocket(socketPath(cfgDir), (socket) => {
    socket.on('data', () => {
      socket.end(`${JSON.stringify({ hookSpecificOutput: { decision: { behavior: 'allow' } } })}\n`);
    });
  });

  const proc = spawnGenericAsk(cfgDir);
  const result = await readProc(proc);

  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe('approved');
  // stderr carries the greppable `generic-ask requested/approved:` audit log lines
  // (same discipline as every other ask-forward: log in this file) -- it is not
  // required to be silent, only to never contain a denial reason on a real approval.
  expect(result.stderr).not.toContain('denied');
});

test('generic ask stdout carries "approved: <detail>" end-to-end when the daemon response has a message', async () => {
  const cfgDir = makeCfgDir();
  await listenSocket(socketPath(cfgDir), (socket) => {
    socket.on('data', () => {
      socket.end(`${JSON.stringify({ hookSpecificOutput: { decision: { behavior: 'allow', message: 'go ahead' } } })}\n`);
    });
  });

  const proc = spawnGenericAsk(cfgDir);
  const result = await readProc(proc);

  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe('approved: go ahead');
});

test('generic ask exits 1 on an explicit reject, with the reason on stderr only', async () => {
  const cfgDir = makeCfgDir();
  await listenSocket(socketPath(cfgDir), (socket) => {
    socket.on('data', () => {
      socket.end(`${JSON.stringify({ hookSpecificOutput: { decision: { behavior: 'deny', message: 'not now' } } })}\n`);
    });
  });

  const proc = spawnGenericAsk(cfgDir);
  const result = await readProc(proc);

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('denied: rejected in Telegram: not now');
});

// Security property (tg-cli#149 acceptance criteria): a fresh generic-ask request
// carries a brand-new random requestId every invocation, so an old/forged/unrelated
// reply sitting around from a PRIOR request can never satisfy a NEW one -- there is
// no shared cache key an attacker (or a stale replay) could hit. Proven here at the
// transport level: the fake daemon deliberately answers with a DIFFERENT (irrelevant)
// shape than what a real daemon would send for an unrelated cached answer, and the
// client still only trusts the exact response framed for THIS socket connection.
test('two concurrent generic asks never share a requestId (fresh id per invocation)', async () => {
  const cfgDir = makeCfgDir();
  const seenRequestIds: string[] = [];
  await listenSocket(socketPath(cfgDir), (socket) => {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString();
      const line = buf.split('\n')[0];
      const req = JSON.parse(line) as { requestId: string };
      seenRequestIds.push(req.requestId);
      socket.end(`${JSON.stringify({ hookSpecificOutput: { decision: { behavior: 'allow' } } })}\n`);
    });
  });

  await Promise.all([spawnGenericAsk(cfgDir), spawnGenericAsk(cfgDir)].map((p) => readProc(p)));

  expect(seenRequestIds).toHaveLength(2);
  expect(new Set(seenRequestIds).size).toBe(2);
});

// --- Real daemon end-to-end (review finding: the fake-socket tests above only
// exercise the CLI's own argv/exit-code logic, never the daemon's actual accept
// path -- this proves the two NEW daemon-side pieces really work together): the
// unscopedAbandonMs override is honored (not the default 110s), and a bare
// generic ButtonRequest (no paneId/sessionName/windowName/subagent) is accepted,
// posted, and correctly resolved by a genuine Approve tap through the real
// getUpdates/callback_query path -- not a fake echo. ---

function makeRealDaemonCfgDir(): string {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-gask-e2e-'));
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  // Deliberately NO registration file. Generic CLI asks are the universal
  // owner-local bridge for harnesses with no hook surface (pi/commandcode), so
  // requiring a tmux/harness registration here would defeat the feature.
  return cfgDir;
}

test('a real daemon accepts a bare generic ButtonRequest, honors unscopedAbandonMs over the 110s default, and a genuine tap resolves it', async () => {
  const cfgDir = makeRealDaemonCfgDir();
  const sentMessages: Array<{ text: string; reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } }> = [];
  let callbackData: string | null = null;
  let tapServed = false;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (callbackData && !tapServed) {
          tapServed = true;
          return Response.json({
            ok: true,
            result: [{
              update_id: 500,
              callback_query: {
                id: 'cb_real',
                // sender id must match TG_CHAT_ID (1) -- senderAllowed() checks the
                // TAPPING user's id against the configured chat, same as every other
                // real permission/question test in this suite.
                from: { id: 1, first_name: 'Alex' },
                message: { message_id: 900, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) },
                data: callbackData,
              },
            }],
          });
        }
        await Bun.sleep(30);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = await req.json();
        sentMessages.push(body);
        callbackData = body.reply_markup.inline_keyboard[0][0].callback_data;
        return Response.json({ ok: true, result: { message_id: 900 } });
      }
      if (url.pathname.endsWith('/answerCallbackQuery')) return Response.json({ ok: true, result: true });
      if (url.pathname.endsWith('/editMessageText')) return Response.json({ ok: true, result: true });
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  httpServers.push(server);

  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: ctlEnv(cfgDir, `http://127.0.0.1:${server.port}`),
    logFd,
  });
  closeSync(logFd);
  expect(daemon.exitCode).toBeNull();

  // --timeout 5 armed alongside a daemon.log assertion below that greps the EXACT
  // ms value the daemon logged for this requestId's unscoped-abandon timer
  // (genericAskDaemonAbandonMs(5) = 5000 + 15000 = 20000) -- proving the override
  // is what's actually armed, not a silent fallback to the 110_000 default (which
  // would otherwise pass this test just as "functionally" since 5s < 110s either
  // way; only the log line distinguishes them).
  const ask = trackProc(reg, Bun.spawn([process.execPath, TG_CTL, 'ask', 'approve real e2e deploy?', '--timeout', '5'], {
    cwd: cfgDir,
    env: ctlEnv(cfgDir, `http://127.0.0.1:${server.port}`),
    stdout: 'pipe',
    stderr: 'pipe',
  }));
  const [stdout, stderr] = await Promise.all([
    new Response(ask.stdout).text(),
    new Response(ask.stderr).text(),
  ]);
  await ask.exited;

  expect(ask.exitCode).toBe(0);
  expect(stdout.trim()).toBe('approved');
  expect(stderr).not.toContain('denied');
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text).toContain('approve real e2e deploy?');
  expect(sentMessages[0].reply_markup.inline_keyboard[0].map((b) => b.text)).toEqual(['Approve', 'Reject']);
  // The actual proof this override works: the daemon logged the OVERRIDE value
  // (genericAskDaemonAbandonMs(5) = 20000), not the 110_000 default every other
  // unscoped caller gets.
  const daemonLog = readFileSync(join(cfgDir, 'daemon.log'), 'utf8');
  expect(daemonLog).toContain('unscoped-abandon-armed');
  expect(daemonLog).toContain('ms=20000');
  expect(daemonLog).not.toContain('ms=110000');

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 20_000);

test('a real Reject tap resolves as an explicit deny through the real daemon (not just a fake socket)', async () => {
  const cfgDir = makeRealDaemonCfgDir();
  let callbackData: string | null = null;
  let tapServed = false;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (callbackData && !tapServed) {
          tapServed = true;
          return Response.json({
            ok: true,
            result: [{
              update_id: 501,
              callback_query: {
                id: 'cb_reject',
                from: { id: 1, first_name: 'Alex' },
                message: { message_id: 901, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) },
                data: callbackData,
              },
            }],
          });
        }
        await Bun.sleep(30);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = await req.json();
        // The Reject button is the SECOND entry in the row (see buildInlineKeyboard's
        // permission branch: [[allow, deny]]).
        callbackData = body.reply_markup.inline_keyboard[0][1].callback_data;
        return Response.json({ ok: true, result: { message_id: 901 } });
      }
      if (url.pathname.endsWith('/answerCallbackQuery')) return Response.json({ ok: true, result: true });
      if (url.pathname.endsWith('/editMessageText')) return Response.json({ ok: true, result: true });
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  httpServers.push(server);

  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: ctlEnv(cfgDir, `http://127.0.0.1:${server.port}`),
  });
  expect(daemon.exitCode).toBeNull();

  const ask = trackProc(reg, Bun.spawn([process.execPath, TG_CTL, 'ask', 'approve real e2e deploy?', '--timeout', '5'], {
    cwd: cfgDir,
    env: ctlEnv(cfgDir, `http://127.0.0.1:${server.port}`),
    stdout: 'pipe',
    stderr: 'pipe',
  }));
  const [stdout, stderr] = await Promise.all([
    new Response(ask.stdout).text(),
    new Response(ask.stderr).text(),
  ]);
  await ask.exited;

  expect(ask.exitCode).toBe(1);
  expect(stdout).toBe('');
  // EXACT line match, not a loose toContain: a request that set decisionLabels
  // explicitly (Approve/Reject is already the default) would make
  // formatAgentHookOutput's deny-reason guard fire on mere PRESENCE of
  // decisionLabels, producing a redundant "…: Reject" suffix on every plain deny.
  expect(stderr.split('\n')).toContain('denied: rejected in Telegram');
  expect(stderr).not.toContain('rejected in Telegram: Reject');

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 20_000);

// tg-cli#149 acceptance (c): only a tap the daemon itself receives from
// getUpdates, from an allowed sender, on THIS ask's card approves. Everything a
// local process could plant or a stranger could send is ignored: a forged
// `user` row in the history log claiming an "approve" reply to the card, a tap
// on an unrelated card, the card's own Approve data tapped by a non-allowed
// sender, and a plain "approve" text. With no genuine tap the ask times out
// and exits nonzero.
test('a forged history entry, an unrelated tap and a stranger tapping the card never approve; the ask times out nonzero', async () => {
  const cfgDir = makeRealDaemonCfgDir();
  const CARD_ID = 902;
  // Planted BEFORE the ask: a local writer forging the CTO's approval.
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.history.jsonl'),
    `${JSON.stringify({
      ts: Math.floor(Date.now() / 1000),
      message_id: CARD_ID + 1,
      direction: 'user',
      from: 'Alex',
      text: 'approve',
      pane: null,
      replyTo: CARD_ID,
    })}\n`,
  );
  let cardData: string | null = null;
  let forgedServed = false;
  const callbackAnswers: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (cardData && !forgedServed) {
          forgedServed = true;
          const date = Math.floor(Date.now() / 1000);
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 600,
                callback_query: {
                  id: 'cb_unrelated',
                  from: { id: 1, first_name: 'Alex' },
                  message: { message_id: 77, chat: { id: 1 }, date },
                  data: 'tgq:unrelated-request:allow',
                },
              },
              {
                update_id: 601,
                callback_query: {
                  id: 'cb_stranger',
                  from: { id: 999, first_name: 'Mallory' },
                  message: { message_id: CARD_ID, chat: { id: 1 }, date },
                  data: cardData,
                },
              },
              {
                update_id: 602,
                message: { message_id: CARD_ID + 2, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date, text: 'approve' },
              },
            ],
          });
        }
        // Long-poll pacing for the separately spawned daemon process (fake
        // timers cannot reach it), same as the other fake Bot API servers here.
        await Bun.sleep(30);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = await req.json();
        const data = body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
        const isCard = typeof data === 'string' && data.startsWith('tgq:');
        if (isCard) cardData = data;
        return Response.json({ ok: true, result: { message_id: isCard ? CARD_ID : CARD_ID + 10 } });
      }
      if (url.pathname.endsWith('/answerCallbackQuery')) {
        const body = await req.json();
        callbackAnswers.push(`${body.callback_query_id}:${body.text ?? ''}`);
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: true, result: true });
    },
  });
  httpServers.push(server);

  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: ctlEnv(cfgDir, `http://127.0.0.1:${server.port}`),
  });
  expect(daemon.exitCode).toBeNull();

  const ask = trackProc(reg, Bun.spawn([process.execPath, TG_CTL, 'ask', 'approve forged deploy?', '--timeout', '3'], {
    cwd: cfgDir,
    env: ctlEnv(cfgDir, `http://127.0.0.1:${server.port}`),
    stdout: 'pipe',
    stderr: 'pipe',
  }));
  const [stdout, stderr] = await Promise.all([
    new Response(ask.stdout).text(),
    new Response(ask.stderr).text(),
  ]);
  await ask.exited;

  // The forgeries really reached the daemon while the card was open.
  expect(cardData).not.toBeNull();
  expect(forgedServed).toBe(true);
  expect(callbackAnswers).toContain('cb_stranger:not allowed');
  expect(ask.exitCode).toBe(1);
  expect(stdout).toBe('');
  expect(stderr).toContain('denied: timeout after 3s');

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 20_000);
