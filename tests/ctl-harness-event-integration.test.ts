import { afterAll, afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tempDir, trackChild } from './helpers/test-temp';

// Integration test for `tg-ctl harness-event` (tg-cli#113) against a fake Bot
// API. Proves: (1) a StopFailure payload with a parseable reset produces a
// notification WITH the auto-continue button; (2) the staleness guard suppresses
// a past-reset alert (the bug that leaked); (3) --dry-run sends NOTHING (test
// isolation — bug a); (4) the stalled reaction (😴) is set on the source message.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const cfgDir = tempDir('tgctl-harness-');
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');

const sentMessages: any[] = [];
const reactions: any[] = [];
let failNextSendMessage = false;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/sendMessage')) {
      if (failNextSendMessage) {
        failNextSendMessage = false;
        return Response.json({ ok: false, description: 'forced failure' }, { status: 500 });
      }
      sentMessages.push(await req.json());
      return Response.json({ ok: true, result: { message_id: 77 } });
    }
    if (url.pathname.endsWith('/setMessageReaction')) {
      reactions.push(await req.json());
      return Response.json({ ok: true, result: true });
    }
    return Response.json({ ok: true, result: {} });
  },
});

afterAll(() => {
  killOverloadRetryChildren();
  server.stop(true);
});

afterEach(() => {
  failNextSendMessage = false;
});

async function runHarnessEvent(args: string[], stdin: string, extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn([process.execPath, TG_CTL, 'harness-event', ...args], {
    env: { HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}`, ...extraEnv },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  proc.stdin.write(stdin);
  proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return { code: proc.exitCode ?? 1, stdout };
}

async function runCodexUsageHook(stdin: string, extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, TG_CTL, 'codex-usage-hook'], {
    env: { HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}`, ...extraEnv },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  proc.stdin.write(stdin);
  proc.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { code: proc.exitCode ?? 1, stdout, stderr };
}

async function runAutoContinueOnce(args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, TG_CTL, 'auto-continue-once', ...args], {
    env: { HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}`, ...extraEnv },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { code: proc.exitCode ?? 1, stdout, stderr };
}

function futureResetSeconds(minutes: number): number {
  return Math.floor((Date.now() + minutes * 60_000) / 1000);
}

function clearUsageWarningState(): void {
  const path = join(cfgDir, 'tg-ctl.123.usage-warnings.json');
  rmSync(path, { force: true });
  rmSync(`${path}.lock`, { force: true });
}

function clearUsageLatestState(): void {
  const path = join(cfgDir, 'tg-ctl.123.usage-latest.json');
  rmSync(path, { force: true });
  rmSync(`${path}.lock`, { force: true });
}

function clearOverloadRetryState(): void {
  const path = join(cfgDir, 'tg-ctl.123.overload-retries.json');
  killOverloadRetryChildren(path);
  rmSync(path, { force: true });
  rmSync(`${path}.lock`, { force: true });
}

function killOverloadRetryChildren(path = join(cfgDir, 'tg-ctl.123.overload-retries.json')): void {
  if (!existsSync(path)) return;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { retries?: Array<{ pid?: unknown }> };
    for (const rec of parsed.retries ?? []) {
      if (typeof rec.pid !== 'number' || rec.pid <= 0) continue;
      try {
        process.kill(rec.pid, 'SIGTERM');
      } catch {}
    }
  } catch {}
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Bounded by the test's own timeout: a SIGTERMed retry child on a loaded host can take longer
// than any fixed poll count to exit.
async function waitForPidExit(pid: number): Promise<void> {
  while (pidAlive(pid)) await Bun.sleep(50);
}

test('a session-limit with a parseable reset → notification + auto-continue button + stalled reaction', async () => {
  sentMessages.length = 0;
  reactions.length = 0;
  const payload = JSON.stringify({
    reason: 'session_limit',
    message: 'You have hit your session limit · resets 4:10am (Europe/Belgrade)',
  });
  const { code } = await runHarnessEvent(['--agent', 'hyperide', '--pane', '%3', '--source-message-id', '55'], payload);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  const msg = sentMessages[0];
  expect(msg.chat_id).toBe(1);
  expect(msg.text).toContain('hyperide');
  expect(msg.text).toContain('session limit');
  // bug (c): no unrendered placeholder leaked into the live message.
  expect(msg.text).not.toMatch(/%\d/);
  // auto-continue button present, encoding pane + reset + source message id (55).
  const button = msg.reply_markup.inline_keyboard[0][0];
  expect(button.callback_data).toMatch(/^lc:%3:\d+:55$/);
  // stalled reaction (😴) on the source message.
  expect(reactions).toHaveLength(1);
  expect(reactions[0]).toMatchObject({ chat_id: 1, message_id: 55, reaction: [{ type: 'emoji', emoji: '😴' }] });
});

test('staleness guard: a past reset time emits NOTHING (no send, no reaction)', async () => {
  sentMessages.length = 0;
  reactions.length = 0;
  const { code } = await runHarnessEvent(
    ['--reason', 'session_limit', '--reset-at', '2000-01-01T00:00:00Z', '--source-message-id', '55'],
    JSON.stringify({ message: 'limit' }),
  );
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(0);
  expect(reactions).toHaveLength(0);
});

test('--dry-run sends nothing (isolation, bug a) and prints the rendered notification', async () => {
  sentMessages.length = 0;
  reactions.length = 0;
  const { code, stdout } = await runHarnessEvent(
    ['--dry-run', '--agent', 'hyperide', '--pane', '%3', '--source-message-id', '55'],
    JSON.stringify({ reason: 'session_limit', message: 'resets 4:10am' }),
  );
  expect(code).toBe(0);
  expect(stdout).toContain('DRY-RUN');
  expect(stdout).toContain('[button]');
  expect(sentMessages).toHaveLength(0);
  expect(reactions).toHaveLength(0);
});

test('production path: a JSONL transcript_path (not flags) yields the reset + clean detail', async () => {
  sentMessages.length = 0;
  reactions.length = 0;
  // A realistic Claude transcript: per-line JSON with timestamps; the limit is the
  // last assistant message. This is the prod shape the bare hook feeds (no message
  // flag). Proves the reset is parsed from prose (not a line stamp) and the detail
  // is clean (not raw JSONL) — the two prod bugs the review caught.
  const transcript = join(cfgDir, 'transcript.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' }, timestamp: '2020-01-01T00:00:00.000Z' }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'You have hit your session limit · resets 4:10am (Europe/Belgrade)' }] },
      timestamp: '2026-07-02T10:00:00.000Z',
    }),
  ].join('\n');
  writeFileSync(transcript, lines);
  // stdin carries ONLY the hook envelope (reason + transcript_path), no message.
  const payload = JSON.stringify({ reason: 'session_limit', transcript_path: transcript });
  const { code } = await runHarnessEvent(['--agent', 'hyperide', '--pane', '%3'], payload);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  const msg = sentMessages[0];
  expect(msg.text).toContain('session limit');
  // detail (blockquote) is clean prose — no raw JSON / timestamp leaked
  expect(msg.text).not.toContain('timestamp');
  expect(msg.text).not.toContain('"role"');
  // the button's reset came from the 4:10am prose, not the 2020 line stamp
  expect(msg.reply_markup.inline_keyboard[0][0].callback_data).toMatch(/^lc:%3:\d+$/);
});

test('transcript_path-only JSON payload is still treated as an explicit failure', async () => {
  sentMessages.length = 0;
  reactions.length = 0;
  const transcript = join(cfgDir, 'transcript-only.jsonl');
  writeFileSync(
    transcript,
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'You have hit your session limit · resets 4:10am (Europe/Belgrade)' }] },
    }),
  );
  const { code } = await runHarnessEvent(['--agent', 'hyperide', '--pane', '%3'], JSON.stringify({ transcript_path: transcript }));
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  const msg = sentMessages[0];
  expect(msg.text).toContain('session limit');
  expect(msg.reply_markup.inline_keyboard[0][0].callback_data).toMatch(/^lc:%3:\d+$/);
  expect(reactions).toHaveLength(0);
});

test('an API error with no reset → alert, no button', async () => {
  sentMessages.length = 0;
  const { code } = await runHarnessEvent(['--agent', 'hyperide'], JSON.stringify({ reason: 'overloaded', message: 'overloaded_error (529)' }));
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text).toContain('API error');
  expect(sentMessages[0].reply_markup).toBeUndefined();
});

test('JSON error field alone is treated as an explicit failure, not ignored telemetry', async () => {
  sentMessages.length = 0;
  reactions.length = 0;
  const { code } = await runHarnessEvent(['--agent', 'hyperide'], JSON.stringify({ error: 'server_error (500)' }));
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text).toContain('API error');
  expect(sentMessages[0].text).toContain('server_error');
  expect(sentMessages[0].reply_markup).toBeUndefined();
  expect(reactions).toHaveLength(0);
});

// PR #120 review: the REAL bare-hook payload uses `error_type`/`error`, not our
// test-only `reason`/`message` shape. Proves a live StopFailure hook (no
// --reason/--message flags, no `reason`/`message` fields on the payload) still
// classifies correctly and shows the real error text instead of "unknown".
test('production StopFailure shape (error_type/error, no reason/message) is read correctly', async () => {
  sentMessages.length = 0;
  // error_type deliberately does NOT contain "limit" (classifyFailure keys off
  // that substring) so this exercises the api-error path cleanly.
  const payload = JSON.stringify({
    session_id: 'abc123',
    hook_event_name: 'StopFailure',
    error_type: 'overloaded',
    error: 'The service is temporarily overloaded. Please retry.',
  });
  const { code } = await runHarnessEvent(['--agent', 'hyperide'], payload);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  const msg = sentMessages[0];
  // carries the REAL error_type matcher, not the "unknown" fallback the old
  // reason/matcher-only parser produced against this payload shape.
  expect(msg.text).toContain('API error');
  expect(msg.text).toContain('overloaded');
  expect(msg.text).not.toContain('unknown');
  // the real `error` string reached the detail blockquote, not a raw JSON dump.
  expect(msg.text).toContain('The service is temporarily overloaded. Please retry.');
  expect(msg.text).not.toContain('"error_type"');
});

test('retryable 529 overload StopFailure dry-run shows delayed English auto-continue', async () => {
  sentMessages.length = 0;
  reactions.length = 0;
  const payload = JSON.stringify({
    session_id: 'abc123',
    hook_event_name: 'StopFailure',
    error_type: 'unknown',
    error: 'API Error: 529 Overloaded. Provider is temporarily overloaded, please try again at 4:10pm.',
  });
  const { code, stdout } = await runHarnessEvent(['--dry-run', '--agent', 'ext', '--window-name', 'ext', '--pane', '%3'], payload);
  expect(code).toBe(0);
  expect(stdout).toContain('API error');
  expect(stdout).toContain('[auto-continue]');
  expect(stdout).toContain('continue');
  expect(stdout).toMatch(/attempt 1/);
  expect(sentMessages).toHaveLength(0);
  expect(reactions).toHaveLength(0);
});

test('retryable overload without a window guard notifies but does not claim auto-continue', async () => {
  clearOverloadRetryState();
  sentMessages.length = 0;
  reactions.length = 0;
  const payload = JSON.stringify({
    session_id: 'abc123',
    hook_event_name: 'StopFailure',
    error_type: 'overloaded',
    error: 'API Error: 529 Overloaded. Provider is temporarily overloaded.',
  });
  const dryRun = await runHarnessEvent(['--dry-run', '--agent', 'ext', '--pane', '%3'], payload);
  expect(dryRun.code).toBe(0);
  expect(dryRun.stdout).toContain('API error');
  expect(dryRun.stdout).not.toContain('[auto-continue]');

  const prod = await runHarnessEvent(['--agent', 'ext', '--pane', '%3'], payload, { TG_CTL_OVERLOAD_AUTO_CONTINUE_TEST_DELAY_MS: '1000' });
  expect(prod.code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  expect(existsSync(join(cfgDir, 'tg-ctl.123.overload-retries.json'))).toBe(false);
});

test('retryable overload production path stores one pending retry across equivalent reasons', async () => {
  clearOverloadRetryState();
  sentMessages.length = 0;
  reactions.length = 0;
  const env = { TG_CTL_OVERLOAD_AUTO_CONTINUE_TEST_DELAY_MS: '60000' };
  const first = JSON.stringify({
    session_id: 'abc123',
    hook_event_name: 'StopFailure',
    error_type: 'unknown',
    error: 'API Error: 529 Overloaded. Provider is temporarily overloaded.',
  });
  const second = JSON.stringify({
    session_id: 'abc123',
    hook_event_name: 'StopFailure',
    error_type: 'overloaded',
    error: 'API Error: 529 Overloaded. Provider is temporarily overloaded.',
  });
  expect((await runHarnessEvent(['--agent', 'ext', '--window-name', 'ext', '--pane', '%3'], first, env)).code).toBe(0);
  expect((await runHarnessEvent(['--agent', 'ext', '--window-name', 'ext', '--pane', '%3'], second, env)).code).toBe(0);
  expect(sentMessages).toHaveLength(2);

  const retryState = JSON.parse(readFileSync(join(cfgDir, 'tg-ctl.123.overload-retries.json'), 'utf8')) as {
    retries: Array<{ key: string; attempt: number; pid: number; nextAt: number }>;
  };
  expect(retryState.retries).toHaveLength(1);
  expect(JSON.parse(retryState.retries[0].key)).toEqual(['%3', 'abc123', 'ext']);
  expect(retryState.retries[0].attempt).toBe(1);
  expect(retryState.retries[0].pid).toBeGreaterThan(0);
  expect(retryState.retries[0].nextAt).toBeGreaterThan(Date.now());
  killOverloadRetryChildren();
});

test('auto-continue-once requires a persisted retry key before it can inject', async () => {
  clearOverloadRetryState();
  const res = await runAutoContinueOnce([
    '--pane', '%999999',
    '--delay-ms', '0',
    '--text', 'continue',
    '--window-name', 'ext',
  ]);
  expect(res.code).toBe(2);
  expect(existsSync(join(cfgDir, 'tg-ctl.123.overload-retries.json'))).toBe(false);
});

test('auto-continue-once marks its matching retry record as finished history after a terminal skip', async () => {
  clearOverloadRetryState();
  const retryPath = join(cfgDir, 'tg-ctl.123.overload-retries.json');
  const retryKey = JSON.stringify(['%999999', 'abc123', 'ext']);
  const proc = Bun.spawn([
    process.execPath,
    TG_CTL,
    'auto-continue-once',
    '--pane',
    '%999999',
    '--delay-ms',
    '250',
    '--text',
    'continue',
    '--window-name',
    'ext',
    '--retry-key',
    retryKey,
  ], {
    env: { HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}` },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  writeFileSync(retryPath, `${JSON.stringify({
    version: 1,
    retries: [{
      key: retryKey,
      attempt: 8,
      pid: proc.pid,
      lastFailureAt: Date.now(),
      nextAt: Date.now() + 250,
    }],
  })}\n`);
  await new Response(proc.stdout).text();
  await new Response(proc.stderr).text();
  await proc.exited;
  expect(proc.exitCode).toBe(0);
  const retryState = JSON.parse(readFileSync(retryPath, 'utf8')) as {
    retries: Array<{ key: string; attempt: number; pid: number | null; nextAt: number }>;
  };
  expect(retryState.retries).toHaveLength(1);
  expect(retryState.retries[0].key).toBe(retryKey);
  expect(retryState.retries[0].attempt).toBe(8);
  expect(retryState.retries[0].pid).toBeNull();
  expect(retryState.retries[0].nextAt).toBeLessThanOrEqual(Date.now());
});

test('auto-continue-once waits through short retry-store lock contention before finishing', async () => {
  clearOverloadRetryState();
  const retryPath = join(cfgDir, 'tg-ctl.123.overload-retries.json');
  const lockPath = `${retryPath}.lock`;
  const retryKey = JSON.stringify(['%999999', 'abc123', 'ext']);
  writeFileSync(lockPath, String(process.pid));
  const proc = Bun.spawn([
    process.execPath,
    TG_CTL,
    'auto-continue-once',
    '--pane',
    '%999999',
    '--delay-ms',
    '100',
    '--text',
    'continue',
    '--window-name',
    'ext',
    '--retry-key',
    retryKey,
  ], {
    env: { HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}` },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  writeFileSync(retryPath, `${JSON.stringify({
    version: 1,
    retries: [{
      key: retryKey,
      attempt: 2,
      pid: proc.pid,
      lastFailureAt: Date.now(),
      nextAt: Date.now() + 100,
    }],
  })}\n`);
  const release = setTimeout(() => rmSync(lockPath, { force: true }), 250);
  try {
    await new Response(proc.stdout).text();
    await new Response(proc.stderr).text();
    await proc.exited;
  } finally {
    clearTimeout(release);
    rmSync(lockPath, { force: true });
  }
  expect(proc.exitCode).toBe(0);
  const retryState = JSON.parse(readFileSync(retryPath, 'utf8')) as {
    retries: Array<{ key: string; attempt: number; pid: number | null; nextAt: number }>;
  };
  expect(retryState.retries).toHaveLength(1);
  expect(retryState.retries[0].key).toBe(retryKey);
  expect(retryState.retries[0].attempt).toBe(2);
  expect(retryState.retries[0].pid).toBeNull();
  expect(retryState.retries[0].nextAt).toBeLessThanOrEqual(Date.now());
});

test('retryable overload state is scoped by session id for the same pane/window', async () => {
  clearOverloadRetryState();
  sentMessages.length = 0;
  reactions.length = 0;
  const env = { TG_CTL_OVERLOAD_AUTO_CONTINUE_TEST_DELAY_MS: '60000' };
  const payload = (sessionId: string) => JSON.stringify({
    session_id: sessionId,
    hook_event_name: 'StopFailure',
    error_type: 'overloaded',
    error: 'API Error: 529 Overloaded. Provider is temporarily overloaded.',
  });
  expect((await runHarnessEvent(['--agent', 'ext', '--window-name', 'ext', '--pane', '%3'], payload('old-session'), env)).code).toBe(0);
  const firstState = JSON.parse(readFileSync(join(cfgDir, 'tg-ctl.123.overload-retries.json'), 'utf8')) as {
    retries: Array<{ key: string; attempt: number; pid: number; nextAt: number }>;
  };
  const oldPid = firstState.retries[0].pid;
  expect(pidAlive(oldPid)).toBe(true);
  expect((await runHarnessEvent(['--agent', 'ext', '--window-name', 'ext', '--pane', '%3'], payload('new-session'), env)).code).toBe(0);
  await waitForPidExit(oldPid);

  const retryState = JSON.parse(readFileSync(join(cfgDir, 'tg-ctl.123.overload-retries.json'), 'utf8')) as {
    retries: Array<{ key: string; attempt: number; pid: number; nextAt: number }>;
  };
  expect(retryState.retries).toHaveLength(1);
  expect(JSON.parse(retryState.retries[0].key)).toEqual(['%3', 'new-session', 'ext']);
  expect(retryState.retries[0].attempt).toBe(1);
  expect(retryState.retries[0].pid).not.toBe(oldPid);
  expect(pidAlive(oldPid)).toBe(false);
  killOverloadRetryChildren();
});

test('retryable overload backoff increments from completed retry history', async () => {
  clearOverloadRetryState();
  sentMessages.length = 0;
  reactions.length = 0;
  const retryPath = join(cfgDir, 'tg-ctl.123.overload-retries.json');
  const retryKey = JSON.stringify(['%3', 'abc123', 'ext']);
  writeFileSync(retryPath, `${JSON.stringify({
    version: 1,
    retries: [{
      key: retryKey,
      attempt: 1,
      pid: null,
      lastFailureAt: Date.now() - 1000,
      nextAt: Date.now() - 500,
    }],
  })}\n`);
  const payload = JSON.stringify({
    session_id: 'abc123',
    hook_event_name: 'StopFailure',
    error_type: 'overloaded',
    error: 'API Error: 529 Overloaded. Provider is temporarily overloaded.',
  });
  expect((await runHarnessEvent(
    ['--agent', 'ext', '--window-name', 'ext', '--pane', '%3'],
    payload,
    { TG_CTL_OVERLOAD_AUTO_CONTINUE_TEST_DELAY_MS: '60000' },
  )).code).toBe(0);

  const retryState = JSON.parse(readFileSync(retryPath, 'utf8')) as {
    retries: Array<{ key: string; attempt: number; pid: number | null; nextAt: number }>;
  };
  expect(retryState.retries).toHaveLength(1);
  expect(retryState.retries[0].key).toBe(retryKey);
  expect(retryState.retries[0].attempt).toBe(2);
  expect(retryState.retries[0].pid).toBeGreaterThan(0);
  expect(retryState.retries[0].nextAt).toBeGreaterThan(Date.now());
  killOverloadRetryChildren();
});

test('retryable overload re-arms a lost child without incrementing the attempt', async () => {
  clearOverloadRetryState();
  sentMessages.length = 0;
  reactions.length = 0;
  const retryPath = join(cfgDir, 'tg-ctl.123.overload-retries.json');
  const retryKey = JSON.stringify(['%3', 'abc123', 'ext']);
  const exited = Bun.spawn(['/bin/sh', '-c', 'exit 0']);
  const deadPid = exited.pid;
  await exited.exited;
  expect(pidAlive(deadPid)).toBe(false);
  writeFileSync(retryPath, `${JSON.stringify({
    version: 1,
    retries: [{
      key: retryKey,
      attempt: 3,
      pid: deadPid,
      lastFailureAt: Date.now() - 1000,
      nextAt: Date.now() + 60_000,
    }],
  })}\n`);
  const payload = JSON.stringify({
    session_id: 'abc123',
    hook_event_name: 'StopFailure',
    error_type: 'overloaded',
    error: 'API Error: 529 Overloaded. Provider is temporarily overloaded.',
  });
  expect((await runHarnessEvent(
    ['--agent', 'ext', '--window-name', 'ext', '--pane', '%3'],
    payload,
    { TG_CTL_OVERLOAD_AUTO_CONTINUE_TEST_DELAY_MS: '60000' },
  )).code).toBe(0);

  const retryState = JSON.parse(readFileSync(retryPath, 'utf8')) as {
    retries: Array<{ key: string; attempt: number; pid: number | null; nextAt: number }>;
  };
  expect(retryState.retries).toHaveLength(1);
  expect(retryState.retries[0].key).toBe(retryKey);
  expect(retryState.retries[0].attempt).toBe(3);
  expect(retryState.retries[0].pid).toBeGreaterThan(0);
  expect(retryState.retries[0].nextAt).toBeGreaterThan(Date.now());
  killOverloadRetryChildren();
});

test('retryable overload ignores a stale live pid that is not its retry child', async () => {
  clearOverloadRetryState();
  sentMessages.length = 0;
  reactions.length = 0;
  const retryPath = join(cfgDir, 'tg-ctl.123.overload-retries.json');
  const retryKey = JSON.stringify(['%3', 'abc123', 'ext']);
  writeFileSync(retryPath, `${JSON.stringify({
    version: 1,
    retries: [{
      key: retryKey,
      attempt: 3,
      pid: process.pid,
      lastFailureAt: Date.now() - 1000,
      nextAt: Date.now() + 60_000,
    }],
  })}\n`);
  const payload = JSON.stringify({
    session_id: 'abc123',
    hook_event_name: 'StopFailure',
    error_type: 'overloaded',
    error: 'API Error: 529 Overloaded. Provider is temporarily overloaded.',
  });
  expect((await runHarnessEvent(
    ['--agent', 'ext', '--window-name', 'ext', '--pane', '%3'],
    payload,
    { TG_CTL_OVERLOAD_AUTO_CONTINUE_TEST_DELAY_MS: '60000' },
  )).code).toBe(0);

  const retryState = JSON.parse(readFileSync(retryPath, 'utf8')) as {
    retries: Array<{ key: string; attempt: number; pid: number | null; nextAt: number }>;
  };
  expect(retryState.retries).toHaveLength(1);
  expect(retryState.retries[0].key).toBe(retryKey);
  expect(retryState.retries[0].attempt).toBe(3);
  expect(retryState.retries[0].pid).not.toBe(process.pid);
  expect(retryState.retries[0].pid).toBeGreaterThan(0);
  expect(pidAlive(process.pid)).toBe(true);
  killOverloadRetryChildren();
});

test('retryable overload does not duplicate a live pending child when ps cannot inspect it', async () => {
  clearOverloadRetryState();
  sentMessages.length = 0;
  reactions.length = 0;
  const retryPath = join(cfgDir, 'tg-ctl.123.overload-retries.json');
  const retryKey = JSON.stringify(['%3', 'abc123', 'ext']);
  // `sleep` itself, not `sh -c 'sleep 60'`: the SIGTERM below killed only the shell and orphaned
  // its sleep for a minute (tg-cli#486).
  const live = trackChild(Bun.spawn(['sleep', '60']));
  writeFileSync(retryPath, `${JSON.stringify({
    version: 1,
    retries: [{
      key: retryKey,
      attempt: 3,
      pid: live.pid,
      lastFailureAt: Date.now() - 1000,
      nextAt: Date.now() + 60_000,
    }],
  })}\n`);
  const fakeBin = tempDir('tgctl-fake-ps-');
  const fakePs = join(fakeBin, 'ps');
  writeFileSync(fakePs, '#!/bin/sh\nexit 1\n');
  chmodSync(fakePs, 0o755);
  const payload = JSON.stringify({
    session_id: 'abc123',
    hook_event_name: 'StopFailure',
    error_type: 'overloaded',
    error: 'API Error: 529 Overloaded. Provider is temporarily overloaded.',
  });
  try {
    expect((await runHarnessEvent(
      ['--agent', 'ext', '--window-name', 'ext', '--pane', '%3'],
      payload,
      {
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        TG_CTL_OVERLOAD_AUTO_CONTINUE_TEST_DELAY_MS: '60000',
      },
    )).code).toBe(0);
  } finally {
    try {
      process.kill(live.pid, 'SIGTERM');
    } catch {}
    await live.exited.catch(() => {});
    rmSync(fakeBin, { recursive: true, force: true });
  }

  const retryState = JSON.parse(readFileSync(retryPath, 'utf8')) as {
    retries: Array<{ key: string; attempt: number; pid: number | null }>;
  };
  expect(sentMessages).toHaveLength(1);
  expect(retryState.retries).toHaveLength(1);
  expect(retryState.retries[0]).toMatchObject({ key: retryKey, attempt: 3, pid: live.pid });
});

test('retryable overload waits through short retry-store lock contention instead of dropping recovery', async () => {
  clearOverloadRetryState();
  sentMessages.length = 0;
  reactions.length = 0;
  const retryPath = join(cfgDir, 'tg-ctl.123.overload-retries.json');
  const lockPath = `${retryPath}.lock`;
  writeFileSync(lockPath, String(process.pid));
  const release = setTimeout(() => rmSync(lockPath, { force: true }), 150);
  const payload = JSON.stringify({
    session_id: 'abc123',
    hook_event_name: 'StopFailure',
    error_type: 'overloaded',
    error: 'API Error: 529 Overloaded. Provider is temporarily overloaded.',
  });
  try {
    expect((await runHarnessEvent(
      ['--agent', 'ext', '--window-name', 'ext', '--pane', '%3'],
      payload,
      { TG_CTL_OVERLOAD_AUTO_CONTINUE_TEST_DELAY_MS: '60000' },
    )).code).toBe(0);
  } finally {
    clearTimeout(release);
    rmSync(lockPath, { force: true });
  }

  const retryState = JSON.parse(readFileSync(retryPath, 'utf8')) as {
    retries: Array<{ key: string; attempt: number; pid: number | null }>;
  };
  expect(sentMessages).toHaveLength(1);
  expect(retryState.retries).toHaveLength(1);
  expect(retryState.retries[0]).toMatchObject({
    key: JSON.stringify(['%3', 'abc123', 'ext']),
    attempt: 1,
    pid: expect.any(Number),
  });
  killOverloadRetryChildren();
});

test('retryable overload does not arm auto-continue when the Telegram alert fails to send', async () => {
  clearOverloadRetryState();
  sentMessages.length = 0;
  reactions.length = 0;
  failNextSendMessage = true;
  const retryPath = join(cfgDir, 'tg-ctl.123.overload-retries.json');
  const payload = JSON.stringify({
    session_id: 'abc123',
    hook_event_name: 'StopFailure',
    error_type: 'overloaded',
    error: 'API Error: 529 Overloaded. Provider is temporarily overloaded.',
  });
  expect((await runHarnessEvent(
    ['--agent', 'ext', '--window-name', 'ext', '--pane', '%3'],
    payload,
    { TG_CTL_OVERLOAD_AUTO_CONTINUE_TEST_DELAY_MS: '60000' },
  )).code).toBe(0);
  expect(sentMessages).toHaveLength(0);
  expect(existsSync(retryPath)).toBe(false);
});

test('retryable overload cap suppresses a ninth auto-continue in the same failure window', async () => {
  clearOverloadRetryState();
  sentMessages.length = 0;
  reactions.length = 0;
  const retryPath = join(cfgDir, 'tg-ctl.123.overload-retries.json');
  const retryKey = JSON.stringify(['%3', 'abc123', 'ext']);
  writeFileSync(retryPath, `${JSON.stringify({
    version: 1,
    retries: [{
      key: retryKey,
      attempt: 8,
      pid: null,
      lastFailureAt: Date.now() - 1000,
      nextAt: Date.now() - 500,
    }],
  })}\n`);
  const payload = JSON.stringify({
    session_id: 'abc123',
    hook_event_name: 'StopFailure',
    error_type: 'overloaded',
    error: 'API Error: 529 Overloaded. Provider is temporarily overloaded.',
  });
  expect((await runHarnessEvent(
    ['--agent', 'ext', '--window-name', 'ext', '--pane', '%3'],
    payload,
    { TG_CTL_OVERLOAD_AUTO_CONTINUE_TEST_DELAY_MS: '60000' },
  )).code).toBe(0);

  const retryState = JSON.parse(readFileSync(retryPath, 'utf8')) as {
    retries: Array<{ key: string; attempt: number; pid: number | null }>;
  };
  expect(sentMessages).toHaveLength(1);
  expect(retryState.retries).toHaveLength(1);
  expect(retryState.retries[0]).toMatchObject({ key: retryKey, attempt: 8, pid: null });
});

test('retryable 529 overload StopFailure uses Russian continue text for Russian sessions', async () => {
  sentMessages.length = 0;
  reactions.length = 0;
  const payload = JSON.stringify({
    hook_event_name: 'StopFailure',
    error_type: 'overloaded',
    error: 'API Error: 529 Overloaded. Provider is temporarily overloaded.',
  });
  const { code, stdout } = await runHarnessEvent(['--dry-run', '--agent', 'ext', '--window-name', 'ext', '--pane', '%3', '--language', 'ru'], payload);
  expect(code).toBe(0);
  expect(stdout).toContain('[auto-continue]');
  expect(stdout).toContain('продолжи');
  expect(stdout).not.toContain('[auto-continue] continue');
  expect(sentMessages).toHaveLength(0);
  expect(reactions).toHaveLength(0);
});

test('retryable 529 overload StopFailure falls back to locale for Russian continue text', async () => {
  sentMessages.length = 0;
  reactions.length = 0;
  const payload = JSON.stringify({
    hook_event_name: 'StopFailure',
    error_type: 'overloaded',
    error: 'API Error: 529 Overloaded. Provider is temporarily overloaded.',
  });
  const { code, stdout } = await runHarnessEvent(
    ['--dry-run', '--agent', 'ext', '--window-name', 'ext', '--pane', '%3'],
    payload,
    { LANG: 'ru_RU.UTF-8' },
  );
  expect(code).toBe(0);
  expect(stdout).toContain('[auto-continue]');
  expect(stdout).toContain('продолжи');
  expect(stdout).not.toContain('[auto-continue] continue');
  expect(sentMessages).toHaveLength(0);
  expect(reactions).toHaveLength(0);
});

test('non-retryable StopFailure dry-run does not show auto-continue', async () => {
  sentMessages.length = 0;
  reactions.length = 0;
  const payload = JSON.stringify({
    hook_event_name: 'StopFailure',
    error_type: 'billing_error',
    error: 'Billing quota exhausted.',
  });
  const { code, stdout } = await runHarnessEvent(['--dry-run', '--agent', 'ext', '--pane', '%3'], payload);
  expect(code).toBe(0);
  expect(stdout).toContain('API error');
  expect(stdout).not.toContain('[auto-continue]');
  expect(sentMessages).toHaveLength(0);
  expect(reactions).toHaveLength(0);
});

test('non-Codex usage-limit prose with try-again text does not get a reset button', async () => {
  sentMessages.length = 0;
  reactions.length = 0;
  const payload = JSON.stringify({
    hook_event_name: 'StopFailure',
    error_type: 'unknown',
    error: "You've hit your usage limit. Please try again at 4:10pm (Europe/Belgrade).",
  });
  const { code, stdout } = await runHarnessEvent(['--dry-run', '--agent', 'ext', '--pane', '%3'], payload);
  expect(code).toBe(0);
  expect(stdout).toContain('API error');
  expect(stdout).not.toContain('[button]');
  expect(stdout).not.toContain('Auto-continue');
  expect(sentMessages).toHaveLength(0);
  expect(reactions).toHaveLength(0);
});

test('Codex non-retryable usage-limit prose with try-again text does not get a reset button', async () => {
  sentMessages.length = 0;
  reactions.length = 0;
  const payload = JSON.stringify({
    hook_event_name: 'StopFailure',
    error_type: 'billing_error',
    error: "You've hit your usage limit. Please try again at 4:10pm (Europe/Belgrade).",
  });
  const { code, stdout } = await runHarnessEvent(['--dry-run', '--agent', 'codex', '--pane', '%3'], payload);
  expect(code).toBe(0);
  expect(stdout).toContain('API error');
  expect(stdout).not.toContain('[button]');
  expect(stdout).not.toContain('Auto-continue');
  expect(sentMessages).toHaveLength(0);
  expect(reactions).toHaveLength(0);
});

// Review round 2 (Opus, PR #120): the api-error test above deliberately picked
// a non-"limit" error_type, which left the actual TARGET scenario of this PR
// series untested against the real field names — a rate-limit stop, where the
// reset time must be parsed out of `error` (not `message`) and the
// auto-continue button must still get built + armed. `rate_limit` is one of
// the documented StopFailure error_type values and (like the test/manual
// `session_limit` reason used elsewhere in this file) matches classifyFailure's
// /limit/i check, so it takes the session-limit branch exactly like a real hit
// would.
test('production StopFailure shape for an ACTUAL limit: button + button data + reset all resolve from error_type/error', async () => {
  sentMessages.length = 0;
  const payload = JSON.stringify({
    session_id: 'abc123',
    hook_event_name: 'StopFailure',
    error_type: 'rate_limit',
    error: 'You have hit your rate limit · resets 4:10am (Europe/Belgrade)',
  });
  const { code } = await runHarnessEvent(['--agent', 'hyperide', '--pane', '%3', '--source-message-id', '55'], payload);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  const msg = sentMessages[0];
  expect(msg.text).toContain('hyperide');
  expect(msg.text).not.toMatch(/%\d/); // no unrendered placeholder
  // resetAt was parsed out of the real `error` field text (not `message`,
  // which is absent from this payload) — the button is present and encodes it.
  expect(msg.reply_markup).toBeDefined();
  const button = msg.reply_markup.inline_keyboard[0][0];
  expect(button.callback_data).toMatch(/^lc:%3:\d+:55$/);
  expect(button.text).toContain('Auto-continue');
});

test('StopFailure payload wins over embedded usage telemetry and keeps auto-continue', async () => {
  sentMessages.length = 0;
  reactions.length = 0;
  const payload = JSON.stringify({
    session_id: 'abc123',
    hook_event_name: 'StopFailure',
    error_type: 'rate_limit',
    error: 'You have hit your rate limit · resets 4:10am (Europe/Belgrade)',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: 91, window_minutes: 300, resets_at: futureResetSeconds(80) },
      },
    },
  });
  const { code } = await runHarnessEvent(['--agent', 'codex', '--pane', '%3', '--source-message-id', '55'], payload);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  const msg = sentMessages[0];
  expect(msg.text).toContain('hit its session limit');
  expect(msg.text).not.toContain('использовано');
  expect(msg.reply_markup).toBeDefined();
  expect(msg.reply_markup.inline_keyboard[0][0].callback_data).toMatch(/^lc:%3:\d+:55$/);
  expect(reactions[0]).toMatchObject({ chat_id: 1, message_id: 55, reaction: [{ type: 'emoji', emoji: '😴' }] });
});

test('stale StopFailure falls through to supported usage telemetry', async () => {
  clearUsageWarningState();
  sentMessages.length = 0;
  reactions.length = 0;
  const staleReset = new Date(Date.now() - 60 * 60_000).toISOString();
  const payload = JSON.stringify({
    hook_event_name: 'StopFailure',
    error_type: 'rate_limit',
    error: 'You have hit your rate limit.',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: 91, window_minutes: 300 },
      },
    },
  });
  const { code } = await runHarnessEvent(['--agent', 'codex', '--pane', '%3', '--reset-at', staleReset], payload);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text).toContain('is at');
  expect(sentMessages[0].text).toContain('91%');
  expect(sentMessages[0].reply_markup).toBeUndefined();
  expect(reactions).toHaveLength(0);
});

test('high usage payload at 90 percent sends a localized warning without auto-continue', async () => {
  clearUsageWarningState();
  sentMessages.length = 0;
  reactions.length = 0;
  const payload = JSON.stringify({
    agent: 'codex',
    user_language: 'ru',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: {
          used_percent: 91,
          window_minutes: 300,
          resets_at: futureResetSeconds(60),
        },
      },
    },
  });
  const { code } = await runHarnessEvent(['--agent', 'codex', '--pane', '%3'], payload);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  const msg = sentMessages[0];
  expect(msg.text).toContain('codex');
  expect(msg.text).toContain('использовано');
  expect(msg.text).toContain('91%');
  expect(msg.text).toContain('5-часового лимита');
  expect(msg.text).toContain('/usage');
  expect(msg.reply_markup).toBeUndefined();
  expect(reactions).toHaveLength(0);
});

test('repeated identical high usage payload is deduped', async () => {
  clearUsageWarningState();
  sentMessages.length = 0;
  reactions.length = 0;
  const reset = futureResetSeconds(90);
  const payload = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: 91, window_minutes: 300, resets_at: reset },
      },
    },
  });
  expect((await runHarnessEvent(['--agent', 'codex', '--pane', '%3'], payload)).code).toBe(0);
  expect((await runHarnessEvent(['--agent', 'codex', '--pane', '%3'], payload)).code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text).toContain('91%');
  expect(reactions).toHaveLength(0);
});

test('repeated Codex relative-reset usage payload is deduped despite Date.now drift', async () => {
  clearUsageWarningState();
  sentMessages.length = 0;
  reactions.length = 0;
  const payload = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: 91, window_minutes: 300, resets_in_seconds: 3600 },
      },
    },
  });
  expect((await runHarnessEvent(['--agent', 'codex', '--pane', '%3'], payload)).code).toBe(0);
  expect((await runHarnessEvent(['--agent', 'codex', '--pane', '%3'], payload)).code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text).toContain('91%');
  expect(reactions).toHaveLength(0);
});

test('concurrent identical high usage payloads claim the warning once', async () => {
  clearUsageWarningState();
  sentMessages.length = 0;
  reactions.length = 0;
  const payload = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: 91, window_minutes: 300, resets_in_seconds: 3600 },
      },
    },
  });
  const results = await Promise.all([
    runHarnessEvent(['--agent', 'codex', '--pane', '%3'], payload),
    runHarnessEvent(['--agent', 'codex', '--pane', '%3'], payload),
  ]);
  expect(results.map((r) => r.code)).toEqual([0, 0]);
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text).toContain('91%');
  expect(reactions).toHaveLength(0);
});

test('usage --language flag overrides payload language hints', async () => {
  clearUsageWarningState();
  sentMessages.length = 0;
  reactions.length = 0;
  const payload = JSON.stringify({
    user_language: 'en',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: 91, window_minutes: 300, resets_at: futureResetSeconds(100) },
      },
    },
  });
  const { code } = await runHarnessEvent(['--agent', 'codex', '--pane', '%3', '--language', 'ru'], payload);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text).toContain('использовано');
  expect(sentMessages[0].text).toContain('91%');
  expect(sentMessages[0].reply_markup).toBeUndefined();
  expect(reactions).toHaveLength(0);
});

test('Claude statusLine usage with transcript_path is still treated as usage telemetry', async () => {
  clearUsageWarningState();
  sentMessages.length = 0;
  reactions.length = 0;
  const payload = JSON.stringify({
    hook_event_name: 'Status',
    session_id: 'abc123',
    transcript_path: '/tmp/nonexistent-claude-transcript.jsonl',
    user_language: 'ru',
    rate_limits: {
      five_hour: {
        used_percentage: 91,
        resets_at: futureResetSeconds(110),
      },
    },
  });
  const { code } = await runHarnessEvent(['--agent', 'claude', '--pane', '%3'], payload);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  const msg = sentMessages[0];
  expect(msg.text).toContain('использовано');
  expect(msg.text).toContain('91%');
  expect(msg.reply_markup).toBeUndefined();
  expect(reactions).toHaveLength(0);
});

test('Claude statusLine usage records all latest buckets for /limit, including below-warning weekly usage', async () => {
  clearUsageWarningState();
  clearUsageLatestState();
  sentMessages.length = 0;
  reactions.length = 0;
  const fiveHourReset = futureResetSeconds(110);
  const weeklyReset = futureResetSeconds(24 * 60);
  const payload = JSON.stringify({
    hook_event_name: 'Status',
    session_id: 'abc123',
    user_language: 'ru',
    rate_limits: {
      five_hour: {
        used_percentage: 98,
        resets_at: fiveHourReset,
      },
      seven_day: {
        used_percentage: 64,
        resets_at: weeklyReset,
      },
    },
  });
  const { code } = await runHarnessEvent(['--agent', 'claude', '--pane', '%3'], payload);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text).toContain('98%');

  const latest = JSON.parse(readFileSync(join(cfgDir, 'tg-ctl.123.usage-latest.json'), 'utf8')) as {
    samples: Array<{ agent: string; limitName: string; percent: number; resetAt: number }>;
  };
  expect(latest.samples.map((s) => [s.agent, s.limitName, s.percent])).toEqual([
    ['claude', '5-hour', 98],
    ['claude', 'weekly', 64],
  ]);
  expect(latest.samples.map((s) => s.resetAt)).toEqual([fiveHourReset * 1000, weeklyReset * 1000]);
});

test('Claude statusLine usage without hook_event_name is not misrouted by transcript_path alone', async () => {
  clearUsageWarningState();
  sentMessages.length = 0;
  reactions.length = 0;
  const payload = JSON.stringify({
    session_id: 'abc123',
    transcript_path: '/tmp/nonexistent-claude-transcript.jsonl',
    user_language: 'ru',
    rate_limits: {
      five_hour: {
        used_percentage: 91,
        resets_at: futureResetSeconds(115),
      },
    },
  });
  const { code } = await runHarnessEvent(['--agent', 'claude', '--pane', '%3'], payload);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text).toContain('использовано');
  expect(sentMessages[0].text).toContain('91%');
  expect(sentMessages[0].text).not.toContain('API error');
  expect(sentMessages[0].reply_markup).toBeUndefined();
  expect(reactions).toHaveLength(0);
});

test('usage payload with harmless top-level message remains usage, not unknown API error', async () => {
  clearUsageWarningState();
  sentMessages.length = 0;
  reactions.length = 0;
  const payload = JSON.stringify({
    message: 'token telemetry sample',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: 91, window_minutes: 300, resets_at: futureResetSeconds(120) },
      },
    },
  });
  const { code } = await runHarnessEvent(['--agent', 'codex', '--pane', '%3'], payload);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text).toContain('is at');
  expect(sentMessages[0].text).not.toContain('API error');
});

test('unsupported telemetry with top-level message is ignored, not reported as unknown API error', async () => {
  sentMessages.length = 0;
  reactions.length = 0;
  const payload = JSON.stringify({
    message: 'token telemetry sample',
    type: 'message.updated',
    properties: { info: { providerID: 'opencode', tokens: { input: 120000, output: 10 } } },
  });
  const { code } = await runHarnessEvent(['--agent', 'opencode', '--pane', '%3'], payload);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(0);
  expect(reactions).toHaveLength(0);
});

test('usage payload below threshold is suppressed without falling back to unknown StopFailure', async () => {
  sentMessages.length = 0;
  reactions.length = 0;
  const payload = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: 89, window_minutes: 300 },
      },
    },
  });
  const { code } = await runHarnessEvent(['--agent', 'codex', '--pane', '%3'], payload);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(0);
  expect(reactions).toHaveLength(0);
});

test('usage payload with stale reset is suppressed', async () => {
  sentMessages.length = 0;
  reactions.length = 0;
  const payload = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: {
          used_percent: 91,
          window_minutes: 300,
          resets_at: Math.floor((Date.now() - 60 * 60_000) / 1000),
        },
      },
    },
  });
  const { code } = await runHarnessEvent(['--agent', 'codex', '--pane', '%3'], payload);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(0);
  expect(reactions).toHaveLength(0);
});

test('Codex hard usage-limit StopFailure diagnoses missing telemetry before the hard stop', async () => {
  clearUsageWarningState();
  clearUsageLatestState();
  sentMessages.length = 0;
  reactions.length = 0;
  const payload = JSON.stringify({
    hook_event_name: 'StopFailure',
    error_type: 'unknown',
    error: "You've hit your usage limit. Please try again at 4:10pm (Europe/Belgrade).",
  });
  const { code } = await runHarnessEvent(['--agent', 'codex', '--pane', '%3'], payload);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text).toContain('usage limit');
  expect(sentMessages[0].text).toContain('No supported Codex usage telemetry');
  expect(sentMessages[0].text).toContain('90% warning');
  expect(sentMessages[0].text).toContain('Banked/earned resets are not auto-consumed');
  expect(sentMessages[0].text).toContain('/usage');
  expect(sentMessages[0].reply_markup.inline_keyboard[0][0].callback_data).toMatch(/^lc:%3:\d+$/);
});

test('Codex hard usage-limit StopFailure does not claim missing telemetry after recent Codex usage samples', async () => {
  clearUsageWarningState();
  clearUsageLatestState();
  sentMessages.length = 0;
  reactions.length = 0;
  const telemetry = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: 80, window_minutes: 300, resets_at: futureResetSeconds(60) },
      },
    },
  });
  expect((await runHarnessEvent(['--agent', 'codex', '--pane', '%3'], telemetry)).code).toBe(0);
  expect(sentMessages).toHaveLength(0);

  const hardLimit = JSON.stringify({
    hook_event_name: 'StopFailure',
    error_type: 'unknown',
    error: "You've hit your usage limit. Please try again at 4:10pm (Europe/Belgrade).",
  });
  const { code } = await runHarnessEvent(['--agent', 'codex', '--pane', '%3'], hardLimit);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text).toContain('usage limit');
  expect(sentMessages[0].text).not.toContain('No supported Codex usage telemetry');
  expect(sentMessages[0].text).toContain('below the 90% warning threshold');
  expect(sentMessages[0].text).toContain('/usage');
});

test('Codex hard usage-limit StopFailure diagnoses already-high telemetry as shadowed or deduped if no warning was visible', async () => {
  clearUsageWarningState();
  clearUsageLatestState();
  sentMessages.length = 0;
  reactions.length = 0;
  const telemetry = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: 91, window_minutes: 300, resets_at: futureResetSeconds(60) },
      },
    },
  });
  expect((await runHarnessEvent(['--agent', 'codex', '--pane', '%3'], telemetry)).code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  sentMessages.length = 0;

  const hardLimit = JSON.stringify({
    hook_event_name: 'StopFailure',
    error_type: 'unknown',
    error: "You've hit your usage limit. Please try again at 4:10pm (Europe/Belgrade).",
  });
  const { code } = await runHarnessEvent(['--agent', 'codex', '--pane', '%3'], hardLimit);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text).toContain('at or above the 90% warning threshold');
  expect(sentMessages[0].text).toContain('shadowed');
  expect(sentMessages[0].text).toContain('deduped');
  expect(sentMessages[0].text).toContain('/usage');
});

test('Codex hard usage-limit StopFailure diagnoses stale stored telemetry distinctly from missing telemetry', async () => {
  clearUsageWarningState();
  clearUsageLatestState();
  sentMessages.length = 0;
  reactions.length = 0;
  writeFileSync(join(cfgDir, 'tg-ctl.123.usage-latest.json'), `${JSON.stringify({
    version: 1,
    samples: [{
      agent: 'codex',
      limitName: 'primary',
      percent: 91,
      resetAt: Date.now() - 60_000,
      language: 'en',
      detail: '',
      sampledAt: Date.now() - 120_000,
    }],
  })}\n`);

  const hardLimit = JSON.stringify({
    hook_event_name: 'StopFailure',
    error_type: 'unknown',
    error: "You've hit your usage limit. Please try again at 4:10pm (Europe/Belgrade).",
  });
  const { code } = await runHarnessEvent(['--agent', 'codex', '--pane', '%3'], hardLimit);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text).toContain('latest stored sample was stale');
  expect(sentMessages[0].text).not.toContain('No supported Codex usage telemetry');
  expect(sentMessages[0].text).toContain('/usage');
});

test('Codex usage Stop hook forwards a transcript token_count sample through harness-event', async () => {
  clearUsageWarningState();
  clearUsageLatestState();
  sentMessages.length = 0;
  reactions.length = 0;
  const transcript = join(cfgDir, 'codex-usage-high.jsonl');
  writeFileSync(transcript, [
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'working' } }),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: 91, window_minutes: 300, resets_at: futureResetSeconds(60) },
        },
      },
    }),
  ].join('\n'));

  const { code } = await runCodexUsageHook(JSON.stringify({
    hook_event_name: 'Stop',
    session_id: 'codex-session',
    transcript_path: transcript,
  }));

  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text).toContain('codex');
  expect(sentMessages[0].text).toContain('91%');
  expect(sentMessages[0].text).toContain('/usage');
  const latest = JSON.parse(readFileSync(join(cfgDir, 'tg-ctl.123.usage-latest.json'), 'utf8')) as {
    samples: Array<{ agent: string; percent: number; limitName: string | null }>;
  };
  expect(latest.samples).toEqual([
    expect.objectContaining({ agent: 'codex', percent: 91, limitName: '5-hour' }),
  ]);
});

test('Codex usage Stop hook reads only the transcript tail', async () => {
  clearUsageWarningState();
  clearUsageLatestState();
  sentMessages.length = 0;
  reactions.length = 0;
  const transcript = join(cfgDir, 'codex-usage-large.jsonl');
  const oldHighSample = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: 97, window_minutes: 300, resets_at: futureResetSeconds(60) },
      },
    },
  });
  writeFileSync(transcript, oldHighSample + '\n' + 'not json\n'.repeat(300_000));

  const { code } = await runCodexUsageHook(JSON.stringify({
    hook_event_name: 'Stop',
    session_id: 'codex-session',
    transcript_path: transcript,
  }));

  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(0);
});

test('Codex usage Stop hook stays quiet below threshold while updating /limit state', async () => {
  clearUsageWarningState();
  clearUsageLatestState();
  sentMessages.length = 0;
  reactions.length = 0;
  const transcript = join(cfgDir, 'codex-usage-low.jsonl');
  writeFileSync(transcript, JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: 89, window_minutes: 300, resets_at: futureResetSeconds(60) },
      },
    },
  }));

  const { code } = await runCodexUsageHook(JSON.stringify({
    hook_event_name: 'Stop',
    transcript_path: transcript,
  }));

  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(0);
  const latest = JSON.parse(readFileSync(join(cfgDir, 'tg-ctl.123.usage-latest.json'), 'utf8')) as {
    samples: Array<{ agent: string; percent: number; limitName: string | null }>;
  };
  expect(latest.samples).toEqual([
    expect.objectContaining({ agent: 'codex', percent: 89, limitName: '5-hour' }),
  ]);
});

test('Codex usage Stop hook relies on existing warning dedupe for repeated samples', async () => {
  clearUsageWarningState();
  clearUsageLatestState();
  sentMessages.length = 0;
  reactions.length = 0;
  const transcript = join(cfgDir, 'codex-usage-dedupe.jsonl');
  writeFileSync(transcript, JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: 92, window_minutes: 300, resets_at: futureResetSeconds(60) },
      },
    },
  }));
  const payload = JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcript });

  expect((await runCodexUsageHook(payload)).code).toBe(0);
  expect((await runCodexUsageHook(payload)).code).toBe(0);

  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text).toContain('92%');
});

// tg-cli#263: the bare installed StopFailure hook (`tg-ctl harness-event`, no `--agent`) must label
// the notification with the LIVE harness running in the pane, not the tmux window's (possibly
// stale/unrelated) name. A window named "codex" that currently hosts a `claude` process — e.g. a
// pane spawned once for one harness and later reused for another without renaming the window — must
// still report "claude" in the Telegram message, since that's the process that actually failed.
test('bare harness-event (no --agent) labels the notification with the live pane agent, not the tmux window name', async () => {
  sentMessages.length = 0;
  reactions.length = 0;
  const fakeBinDir = tempDir('tgctl-harness-fakebin-');
  writeFileSync(
    join(fakeBinDir, 'tmux'),
    `#!/bin/sh
sub="$1"; shift
case "$sub" in
  list-panes) printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '%9' '5301' 'claude' 'codex' '' '/tmp' ;;
  *) : ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(fakeBinDir, 'ps'),
    `#!/bin/sh
printf '%s %s %s\\n' '5301' '1' 'claude'
exit 0
`,
    { mode: 0o755 },
  );
  const payload = JSON.stringify({
    session_id: 'agent-label-1',
    hook_event_name: 'StopFailure',
    error_type: 'rate_limit',
    error: 'You have hit your usage limit. Try again later.',
  });
  try {
    const { code, stdout } = await runHarnessEvent(['--dry-run', '--pane', '%9'], payload, {
      PATH: `${fakeBinDir}:/usr/bin:/bin`,
    });
    expect(code).toBe(0);
    expect(stdout).toContain('<b>claude</b>');
    expect(stdout).not.toContain('<b>codex</b>');
    // The payload text also matches the codex hard-limit pattern (CODEX_HARD_USAGE_LIMIT_RE),
    // so pre-fix this claude session would ALSO have wrongly received the codex-only diagnostic
    // block gated on `ev.agent === 'codex'` (limits.ts buildCodexHardLimitDiagnostic).
    expect(stdout).not.toContain('Codex usage telemetry');
  } finally {
    rmSync(fakeBinDir, { recursive: true, force: true });
  }
});

// tg-cli#263 follow-up: the fix isn't just cosmetic — `ev.agent` also gates codex-specific
// behavior (extractFailure's `allowCodexTryAgainReset`, limits.ts:567), so a pane whose LIVE
// process is codex but whose window is named something else must now get the codex "try again
// at <time>" reset parsed (and the resulting auto-continue button), not just the right label.
// Before the fix this reset silently went unscheduled for any codex session in a non-"codex"-
// named window (the common case — windows are project-named, not harness-named).
test('bare harness-event (no --agent) applies codex try-again reset parsing for a live codex pane in a non-codex-named window', async () => {
  sentMessages.length = 0;
  reactions.length = 0;
  const fakeBinDir = tempDir('tgctl-harness-fakebin-');
  writeFileSync(
    join(fakeBinDir, 'tmux'),
    `#!/bin/sh
sub="$1"; shift
case "$sub" in
  list-panes) printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '%9' '5302' 'codex' 'project-x' '' '/tmp' ;;
  *) : ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(fakeBinDir, 'ps'),
    `#!/bin/sh
printf '%s %s %s\\n' '5302' '1' 'codex'
exit 0
`,
    { mode: 0o755 },
  );
  const payload = JSON.stringify({
    session_id: 'agent-label-2',
    hook_event_name: 'StopFailure',
    error_type: 'rate_limit',
    error: 'You have hit your usage limit. Try again at 11:59pm.',
  });
  try {
    const { code, stdout } = await runHarnessEvent(['--dry-run', '--pane', '%9'], payload, {
      PATH: `${fakeBinDir}:/usr/bin:/bin`,
    });
    expect(code).toBe(0);
    expect(stdout).toContain('<b>codex</b>');
    // The parsed try-again reset is what surfaces the auto-continue button — proof
    // `allowCodexTryAgainReset` actually fired for this pane, not just that the label is right.
    expect(stdout).toContain('[button]');
    expect(stdout).not.toContain('Reset time unknown');
  } finally {
    rmSync(fakeBinDir, { recursive: true, force: true });
  }
});
