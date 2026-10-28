// Real CLI + real private Unix socket + local fake Bot API. Nothing reaches Telegram.
// These tests catch missing wiring, --automated/non-agent bypasses and Python fall-through.
import { afterAll, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tempDir } from './helpers/test-temp';
import { BARE_PROBLEM, COMPLETE_PROBLEM, CURRENT_ACTION, PAST_ACTION, RICH_PROBLEM } from './fixtures/intent-gate/problem-remediation';

const root = join(import.meta.dir, '..');
const dir = tempDir('tg-remedy-sock-', { short: true });
chmodSync(dir, 0o700);
const socketPath = join(dir, 'laya-test.sock');
type Request = { op: string; message: string; questions: Record<string, { type: string; instructions: string }> };
let requests: Request[] = [];
let doneScore = 0.9;
let currentScore = 0.9;
let response: 'ok' | 'malformed' | 'timeout' = 'ok';
const laya = Bun.listen<{ input: string }>({
  unix: socketPath,
  socket: {
    open(socket) { socket.data = { input: '' }; },
    data(socket, chunk) {
      socket.data.input += Buffer.from(chunk).toString('utf8');
      if (!socket.data.input.includes('\n')) return;
      const req = JSON.parse(socket.data.input.split('\n')[0]) as Request;
      requests.push(req);
      if (response === 'timeout') return;
      if (response === 'malformed') { socket.write('not json\n'); return; }
      const answers = Object.fromEntries(Object.keys(req.questions).map((key) => [key, { type: 'noul', noul: key === 'has_done' ? doneScore : key === 'has_current' ? currentScore : 0.1 }]));
      socket.write(`${JSON.stringify({ ok: true, result: { answers } })}\n`);
    },
  },
});
let sent: unknown[] = [];
const api = Bun.serve({ port: 0, async fetch(req) {
  sent.push(await req.json());
  return Response.json({ ok: true, result: { message_id: 700 + sent.length } });
} });
afterAll(() => { laya.stop(true); api.stop(true); });

function makeHome(credentials = true): string {
  const home = tempDir('tg-remedy-cli-');
  if (credentials) {
    const config = join(home, '.config', 'tg-cli');
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, '.env'), 'TG_BOT_TOKEN=123:fixture\nTG_CHAT_ID=1\n');
  }
  return home;
}

async function run(args: string[], options: { env?: Record<string, string>; home?: string; python?: boolean } = {}) {
  const home = options.home ?? makeHome();
  const command = options.python
    ? ['python3', '-c', 'from tgcli.entry import tg; tg()', ...args]
    : [process.execPath, join(root, 'tg'), ...args];
  const proc = Bun.spawn(command, {
    cwd: home,
    env: {
      PATH: process.env.PATH ?? '', HOME: home, TMUX: '',
      TG_API_BASE: `http://127.0.0.1:${api.port}`,
      // The 150 ms budget only serves the no-answer case; a loaded suite must not turn an answered score into a timeout.
      TG_LAYA: '1', TG_LAYA_SOCKET: socketPath, TG_LAYA_TIMEOUT_MS: response === 'timeout' ? '150' : '5000',
      TG_AI_EMOJI: 'bot', TG_BUN: process.execPath, PYTHONPATH: join(root, 'src'),
      ...options.env,
    },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, out, err };
}

test('explicit problem reports cannot bypass action requirements via automation, missing agent identity, or generic gate override', async () => {
  sent = []; requests = [];
  for (const flags of [[], ['--automated']]) {
    const result = await run([...flags, '--tag', 'problem', BARE_PROBLEM], { env: { ESCALATION_GATE_ENFORCE: '0' } });
    expect(result.code).toBe(1);
    expect(result.err).toContain('Already tried');
    expect(result.err).toContain('Doing now');
    expect(result.err).not.toContain('sending anyway');
  }
  expect(sent).toHaveLength(0);
  expect(requests).toHaveLength(2);
  // Do not invent action headings around a bare problem: that can bias the classifier.
  expect(requests[0].message).toBe(BARE_PROBLEM);
});

test('a sender with no agent identity needs the remediation facts, not the agent report layout', async () => {
  sent = []; requests = [];
  const plain = 'Already tried: Checked browser state; result: tab missing.\nDoing now: Checking browser permissions.';
  const complete = await run(['--tag', 'problem', plain]);
  expect(complete.code).toBe(0);
  expect(sent).toHaveLength(1);
  sent = []; requests = [];
  const bare = await run(['--tag', 'problem', BARE_PROBLEM], { env: { TG_LAYA: '0' } });
  expect(bare.code).toBe(1);
  expect(bare.err).toContain('Already tried');
  expect(sent).toHaveLength(0);
});

test('a sender with no agent identity records no follow-up and prints no classifier hint for a sendable problem', async () => {
  sent = []; requests = [];
  const body = 'Already tried: Checked browser state; result: tab missing.\nDoing now: Checking browser permissions. Should the profile be reset?';
  const result = await run(['--tag', 'problem', body], { env: { TG_LAYA: '0' } });
  expect(result.code).toBe(0);
  expect(sent).toHaveLength(1);
  expect(result.err).not.toContain('Laya problem check');
  expect(result.err).not.toContain('follow-up');
  const obligations = await run(['obligations', '--check'], { env: { TG_LAYA: '0' } });
  expect(obligations.code).toBe(0);
});

test('real send asks the configured Laya socket both questions before allowing a complete autonomous problem', async () => {
  sent = []; requests = [];
  const result = await run(['--tag', 'problem', '--format', 'html', RICH_PROBLEM]);
  expect(result.code).toBe(0);
  expect(sent).toHaveLength(1);
  expect(requests).toHaveLength(1);
  expect(requests[0].op).toBe('predict');
  expect(Object.keys(requests[0].questions).sort()).toEqual(['has_current', 'has_done']);
  expect(requests[0].message).toContain('browser.tabs');
  expect(requests[0].message).toContain('Открываю сохранённый адрес');
});

test('positive Laya cannot pass future-only action claims through the actual automated send path', async () => {
  sent = []; requests = [];
  const result = await run(['--automated', '--tag', 'problem', 'Уже сделал: Проверю список вкладок, результат узнаю потом.\nСейчас делаю: Попробую открыть чат завтра.']);
  expect(result.code).toBe(1);
  expect(sent).toHaveLength(0);
  expect(requests).toHaveLength(1);
});

for (const negation of ['n&#111;t', 'n&#x6f;t']) {
  for (const mode of ['dry-run', 'disabled', 'malformed', 'positive'] as const) {
    test(`numeric-entity negation ${negation} is blocked by the actual HTML CLI with ${mode} Laya`, async () => {
      sent = []; requests = [];
      response = mode === 'malformed' ? 'malformed' : 'ok';
      try {
        const body = `Already tried: I have ${negation} checked browser permissions; result: permission denied.\nDoing now: I am ${negation} checking browser permissions.`;
        const result = await run([...(mode === 'dry-run' ? ['--dry-run'] : []), '--automated', '--tag', 'problem', '--format', 'html', body], {
          home: makeHome(mode !== 'dry-run'), env: mode === 'disabled' ? { TG_LAYA: '0' } : {},
        });
        expect(result.code).toBe(1);
        expect(result.err).toContain('Already tried');
        expect(result.err).toContain('Doing now');
        expect(sent).toHaveLength(0);
        expect(requests).toHaveLength(mode === 'dry-run' || mode === 'disabled' ? 0 : 1);
      } finally { response = 'ok'; }
    });
  }
}

test('encoded valid action text reaches the real classifier as visible evidence', async () => {
  sent = []; requests = [];
  const body = 'Already tried: Ch&#101;cked browser permissions; result: permission denied.\nDoing now: Ch&#x65;cking browser permissions.';
  const result = await run(['--automated', '--tag', 'problem', '--format', 'html', body]);
  expect(result.code).toBe(0);
  expect(sent).toHaveLength(1);
  expect(requests).toHaveLength(1);
  expect(requests[0].message).toContain('Checked browser permissions');
  expect(requests[0].message).toContain('Checking browser permissions');
  expect(requests[0].message).not.toContain('&#');
});

test('an invalid numeric reference cannot crash the HTML problem validator', async () => {
  sent = []; requests = [];
  const body = 'Already tried: Check&#1114112;ed browser permissions; result: permission denied.\nDoing now: Checking browser permissions.';
  const result = await run(['--dry-run', '--automated', '--tag', 'problem', '--format', 'html', body], { home: makeHome(false) });
  expect(result.code).toBe(1);
  expect(result.err).toContain('Already tried');
  expect(result.err).not.toContain('RangeError');
  expect(requests).toHaveLength(0);
  expect(sent).toHaveLength(0);
});

test('code and quoted blocker literals cannot pass the actual HTML CLI', async () => {
  const sample = 'Cannot continue because device policy denies access. Waiting for owner approval; once available, retry browser login.';
  for (const current of [`<code>${sample}</code>`, `"${sample}"`]) {
    for (const dryRun of [true, false]) {
      sent = []; requests = [];
      const body = `Already tried: Checked browser permissions; result: permission denied.\nDoing now: ${current}`;
      const result = await run([...(dryRun ? ['--dry-run'] : []), '--automated', '--tag', 'problem', '--format', 'html', body], {
        home: makeHome(!dryRun), env: { TG_LAYA: '0' },
      });
      expect(result.code).toBe(1);
      expect(result.err).toContain('Doing now');
      expect(result.err).not.toContain('Already tried —');
      expect(sent).toHaveLength(0);
      expect(requests).toHaveLength(0);
    }
  }
});

test('a line wrap or <br> cannot sever a negation in the actual CLI, offline or live', async () => {
  for (const [format, body] of [
    ['html', 'Already tried: Checked browser state; result: tab missing.\nDoing now: I am not<br>checking browser permissions.'],
    ['plain', 'Already tried: Checked browser state; result: tab missing.\nDoing now: I am not\nchecking browser permissions.'],
  ] as const) {
    for (const dryRun of [true, false]) {
      sent = []; requests = [];
      const result = await run([...(dryRun ? ['--dry-run'] : []), '--automated', '--tag', 'problem', ...(format === 'html' ? ['--format', 'html'] : []), body], {
        home: makeHome(!dryRun), env: { TG_LAYA: '0' },
      });
      expect(result.code).toBe(1);
      expect(result.err).toContain('Doing now');
      expect(result.err).not.toContain('Already tried —');
      expect(sent).toHaveLength(0);
      expect(requests).toHaveLength(0);
    }
  }
});

test('result words inside checked file literals and a Russian repair verb pass the actual CLI', async () => {
  for (const [format, body] of [
    ['html', 'Already tried: Checked <code>output.log</code>; result: permission denied.\nDoing now: Checking browser permissions.'],
    ['html', 'Already tried: Read <code>result.json</code>; result: permission denied.\nDoing now: Checking browser permissions.'],
    ['plain', 'Already tried: Checked `output.log`; result: permission denied.\nDoing now: Checking browser permissions.'],
    ['plain', 'Уже сделал: Посмотрел журнал Guardian; результат: HTTP 429 при открытии вкладки. Сейчас делаю: Чиню повторные попытки открытия вкладки с учётом Retry-After.'],
  ] as const) {
    sent = []; requests = [];
    const dry = await run(['--dry-run', '--automated', '--tag', 'problem', ...(format === 'html' ? ['--format', 'html'] : []), body], { home: makeHome(false) });
    expect(dry.code).toBe(0);
    expect(dry.err).toContain('skipped for offline --dry-run');
    expect(requests).toHaveLength(0);
    const live = await run(['--automated', '--tag', 'problem', ...(format === 'html' ? ['--format', 'html'] : []), body]);
    expect(live.code).toBe(0);
    expect(sent).toHaveLength(1);
  }
});

test('a separately headed result reaches Laya with its associated attempted action', async () => {
  sent = []; requests = [];
  const body = '<h3>Already tried</h3><p>Ran <code>pytest -q</code>.</p><hr><h3>Result</h3><p>3 tests failed with permission denied.</p><hr><h3>Doing now</h3><p>Fixing the failing database migration.</p>';
  const result = await run(['--automated', '--tag', 'problem', '--format', 'html', body]);
  expect(result.code).toBe(0);
  expect(sent).toHaveLength(1);
  expect(requests).toHaveLength(1);
  expect(requests[0].message).toContain('pytest -q');
  expect(requests[0].message).toContain('3 tests failed with permission denied');
});

test('a negative Laya verdict blocks delivery and identifies which evidence is missing', async () => {
  sent = []; requests = []; currentScore = 0.05;
  try {
    const result = await run(['--automated', '--tag', 'problem', COMPLETE_PROBLEM]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('Doing now — Laya');
    expect(sent).toHaveLength(0);
  } finally { currentScore = 0.9; }
});

test('disabled, malformed or timed-out classifier falls back explicitly to deterministic checks', async () => {
  for (const mode of ['disabled', 'malformed', 'timeout'] as const) {
    sent = []; requests = [];
    response = mode === 'disabled' ? 'ok' : mode;
    try {
      const result = await run(['--automated', '--tag', 'problem', COMPLETE_PROBLEM], { env: mode === 'disabled' ? { TG_LAYA: '0' } : {} });
      expect(result.code).toBe(0);
      expect(result.err).toContain(`unavailable (${mode === 'malformed' ? 'invalid-response' : mode})`);
      expect(sent).toHaveLength(1);
      if (mode === 'disabled') expect(requests).toHaveLength(0);
    } finally { response = 'ok'; }
  }
});

test('--dry-run has no classifier or Bot API calls and requires no credentials', async () => {
  sent = []; requests = [];
  const home = makeHome(false);
  const invalid = await run(['--dry-run', '--automated', '--tag', 'problem', BARE_PROBLEM], { home, env: { TG_AI_MODEL: 'claude' } });
  expect(invalid.code).toBe(1);
  const valid = await run(['--dry-run', '--tag', 'problem', '--format', 'html', RICH_PROBLEM], { home, env: { TG_AI_MODEL: 'claude' } });
  expect(valid.code).toBe(0);
  expect(valid.err).toContain('skipped for offline --dry-run');
  const nonProblem = await run(['--dry-run', 'Продолжаю изучать доступные варианты восстановления рабочего процесса.'], { home, env: { TG_AI_MODEL: 'claude' } });
  expect(nonProblem.code).toBe(0);
  expect(requests).toHaveLength(0);
  expect(sent).toHaveLength(0);
});

test('long problem sends complete remediation sections after the old 2000-character boundary to Laya', async () => {
  sent = []; requests = [];
  const body = `Guardian home:\n${'Сведения о состоянии браузера. '.repeat(100)}\n${PAST_ACTION}\n${CURRENT_ACTION}`;
  expect(body.indexOf(PAST_ACTION)).toBeGreaterThan(2000);
  const result = await run(['--automated', '--tag', 'problem', body]);
  expect(result.code).toBe(0);
  expect(requests).toHaveLength(1);
  expect(requests[0].message).toContain('чат 6ae07d22 отсутствует');
  expect(requests[0].message).toContain('проверяю его идентификатор');
  expect(Buffer.byteLength(JSON.stringify(requests[0]) + '\n')).toBeLessThanOrEqual(16 * 1024);
});

test('oversized remediation is never truncated into a semantic missing-action verdict', async () => {
  sent = []; requests = [];
  const body = `${PAST_ACTION} ${'Observed detail. '.repeat(1200)}\n${CURRENT_ACTION}`;
  const result = await run(['--automated', '--tag', 'problem', body]);
  expect(result.code).toBe(0);
  expect(result.err).toContain('unavailable (payload-too-large)');
  expect(requests).toHaveLength(0);
});

test('current Python facade fall-through enforces the same problem rule before sending', async () => {
  sent = []; requests = [];
  const result = await run(['--automated', '--tag', 'problem', BARE_PROBLEM], { python: true });
  expect(result.code).toBe(1);
  expect(result.err).toContain('Already tried');
  expect(result.err).toContain('Doing now');
  expect(sent).toHaveLength(0);
});

test('non-problem program notification keeps sending without the new classifier', async () => {
  sent = []; requests = [];
  const result = await run(['--automated', '--tag', 'report', 'Проверка завершена.']);
  expect(result.code).toBe(0);
  expect(sent).toHaveLength(1);
  expect(requests).toHaveLength(0);
});
