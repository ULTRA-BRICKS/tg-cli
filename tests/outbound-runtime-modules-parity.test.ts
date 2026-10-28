// Behaviour-parity net for the outbound `tg` decomposition (tg-cli#817).
//
// Every case runs the REAL `tg` entrypoint in a private HOME with no Telegram credentials and no
// reachable network (--dry-run, info flags, local-only subcommands and refusals), and compares
// stdout / stderr / exit code with the capture taken from the pre-decomposition entrypoint
// (tests/fixtures/outbound-runtime/parity.json). Paths under the private HOME are normalised.
//
// Re-record ONLY from a known-good entrypoint: OUTBOUND_PARITY_RECORD=1 bun test <this file>.
import { expect, test } from 'bun:test';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { tempDir } from './helpers/test-temp';

const root = join(import.meta.dir, '..');
const fixturePath = join(import.meta.dir, 'fixtures', 'outbound-runtime', 'parity.json');
const RECORD = process.env.OUTBOUND_PARITY_RECORD === '1';

interface Case {
  name: string;
  args: string[];
  env?: Record<string, string>;
  stdin?: string;
  // Files created under HOME before the run: relative path → content.
  files?: Record<string, string>;
  // Credentials in the config dir's .env (default: none).
  credentials?: boolean;
}
interface Outcome {
  code: number | null;
  out: string;
  err: string;
}

const fixture = (name: string): string => readFileSync(join(import.meta.dir, 'fixtures', 'intent-gate', name), 'utf8');
const DECISION_BODY = fixture('well-formed-decision.html');
const REPORT_WITH_QUESTION = fixture('report-with-question.txt');

const CASES: Case[] = [
  { name: 'help flag', args: ['--help'] },
  { name: 'no args prints help', args: [] },
  { name: 'version flag', args: ['--version'] },
  { name: 'help topic format', args: ['help', 'format'] },
  { name: 'help topic obligations', args: ['help', 'obligations'] },
  { name: 'help topic unknown', args: ['help', 'nonsense'] },
  { name: 'help topic config', args: ['help', 'config'] },
  { name: 'config validate without file', args: ['config', 'validate'] },
  { name: 'config validate help', args: ['config', 'validate', '--help'] },
  { name: 'format-help alias', args: ['--format-help'] },
  { name: 'unknown flag', args: ['--bogus'] },
  { name: 'feature flag error', args: ['--feature'] },
  { name: 'format value error', args: ['--format', 'xml', 'hello'] },
  { name: 'list emoji helpers', args: ['--ls-emoji-helpers'] },
  { name: 'list emoji helpers with env ids', args: ['--ls-emoji-helpers'], env: { TG_EMOJI_ID_claude: '1234567890123456789', TG_EMOJI_ID_codex: 'bad' } },
  { name: 'emoji ids json invalid', args: ['--detect-model'], env: { TG_EMOJI_IDS: '{nope', TG_AI_MODEL: 'claude-3' } },
  { name: 'emoji ids reserved key', args: ['--detect-model'], env: { TG_EMOJI_IDS: '{"__proto__":"1234567890123456789","x":5,"y":"12"}', TG_AI_MODEL: 'gpt-4o' } },
  { name: 'emoji ids array', args: ['--detect-model'], env: { TG_EMOJI_IDS: '[1]', TG_AI_MODEL: 'unknown-model' } },
  { name: 'detect model env override', args: ['--detect-model'], env: { TG_AI_MODEL: 'claude-3' } },
  { name: 'detect model with emoji override', args: ['--detect-model'], env: { TG_AI_MODEL: 'codex', TG_AI_EMOJI: 'X' } },
  { name: 'detect model claude marker', args: ['--detect-model'], env: { CLAUDECODE: '1' } },
  { name: 'detect agent none', args: ['--detect-agent'] },
  { name: 'detect agent subagent env', args: ['--detect-agent'], env: { TG_AGENT: 'worker-1' } },
  { name: 'session id none', args: ['--session-id'] },
  { name: 'session topic none', args: ['--session-topic'] },
  { name: 'send without credentials', args: ['hello'] },
  { name: 'dry run plain', args: ['--dry-run', 'hello world'] },
  { name: 'dry run html tag', args: ['--dry-run', '--format', 'html', '--tag', 'report', '<b>Done</b> shipped'] },
  { name: 'dry run title and subagent', args: ['--dry-run', '--title', 'Status', '--subagent', 'fixer', 'body text'] },
  { name: 'dry run from stdin dash', args: ['--dry-run', '-'], stdin: 'body from stdin\n' },
  { name: 'dry run implicit stdin', args: ['--dry-run'], stdin: 'implicit stdin body\n' },
  { name: 'dry run table', args: ['--dry-run', '--table', 'Heading'], stdin: 'task\tstatus\nship\tdone\n' },
  { name: 'dry run table empty stdin', args: ['--dry-run', '--table'], stdin: '' },
  { name: 'dry run table wide glyph', args: ['--dry-run', '--table'], stdin: 'a\tb\n✅\tok\n' },
  { name: 'dry run pipe table converts', args: ['--dry-run', '| a | b |\n|---|---|\n| 1 | 2 |'] },
  { name: 'dry run long unstructured warning', args: ['--dry-run', 'word '.repeat(400)] },
  { name: 'answer without reply-to', args: ['--dry-run', '--tag', 'answer', 'ok'] },
  { name: 'answer with reply-to', args: ['--dry-run', '--tag', 'answer', '--reply-to', '12', 'ok'] },
  { name: 'tag uppercase refused', args: ['--dry-run', '--tag', 'REPORT', 'x'] },
  { name: 'decision malformed blocked', args: ['--dry-run', '--tag', 'decision', 'which one?'] },
  { name: 'decision malformed advisory', args: ['--dry-run', '--tag', 'decision', 'which one?'], env: { ESCALATION_GATE_ENFORCE: '0' } },
  { name: 'decision well formed', args: ['--dry-run', '--format', 'html', '--tag', 'decision', DECISION_BODY] },
  { name: 'agent report with a question follows up', args: ['--dry-run', '--tag', 'report', REPORT_WITH_QUESTION], env: { TG_AI_MODEL: 'claude-3' } },
  { name: 'untagged agent decision fixture', args: ['--dry-run', fixture('malformed-decision.txt')], env: { TG_AI_MODEL: 'claude-3' } },
  { name: 'decision via table blocked', args: ['--dry-run', '--tag', 'decision', '--table'], stdin: 'a\tb\n1\t2\n' },
  { name: 'cjk stray blocked', args: ['--dry-run', 'ка\u4e2deat now'] },
  { name: 'mixed script blocked', args: ['--dry-run', 'почčesна слово'] },
  { name: 'cjk title blocked', args: ['--dry-run', '--title', 'ка\u4e2deat', 'fine body'] },
  { name: 'cjk guard disabled', args: ['--dry-run', '--no-feature', 'cjk-guard', 'ка\u4e2deat now'] },
  { name: 'screenshot mention blocked', args: ['--dry-run', 'see the screenshot above'] },
  { name: 'screenshot mention report tag', args: ['--dry-run', '--tag', 'report', 'скриншот готов'] },
  { name: 'screenshot guard disabled', args: ['--dry-run', '--no-feature', 'screenshot-guard', 'screenshot ok'] },
  { name: 'title ticket refused', args: ['--dry-run', '--title', 'HYP-12 fix', 'body'] },
  { name: 'title msgref refused', args: ['--dry-run', '--title', 'see tg#12', 'body'] },
  { name: 'tg topic env invalid', args: ['--dry-run', 'hi'], env: { TG_TOPIC: 'abc' } },
  { name: 'topic flag invalid', args: ['--dry-run', '--topic', '0', 'hi'] },
  { name: 'session pin unknown', args: ['--dry-run', '--session', 'omp:missing', 'hi'] },
  { name: 'session env pin unknown', args: ['--dry-run', 'hi'], env: { TG_SESSION: 'nope' } },
  { name: 'automated problem needs remediation', args: ['--dry-run', '--automated', '--tag', 'problem', 'it is broken'] },
  { name: 'agent env question blocked', args: ['--dry-run', 'Should we ship this today or wait for review?'], env: { TG_AI_MODEL: 'claude-3' } },
  { name: 'agent env statement passes', args: ['--dry-run', 'Build finished and everything is fine.'], env: { TG_AI_MODEL: 'claude-3' } },
  { name: 'dictionary hit refused', args: ['--dry-run', 'ворота закрыты'], files: { 'dict.json': JSON.stringify({ version: 1, rules: [{ id: 'gate', pattern: 'ворота', replacement: 'гейт' }] }) }, env: { TG_DICT_PATH: '$HOME/dict.json' } },
  { name: 'dictionary explicit path missing', args: ['--dry-run', 'hello'], env: { TG_DICT_PATH: '$HOME/absent.json' } },
  { name: 'dictionary malformed fails closed', args: ['--dry-run', 'hello'], files: { 'bad.json': '{nope' }, env: { TG_DICT_PATH: '$HOME/bad.json' } },
  { name: 'dry run attachments ok and missing', args: ['--dry-run', '--file', '$HOME/a.txt', '--file', '$HOME/gone.txt', 'with files'], files: { 'a.txt': 'hello\n' } },
  { name: 'dry run attachment empty', args: ['--dry-run', '--photo', '$HOME/empty.png', 'caption'], files: { 'empty.png': '' } },
  { name: 'denylist file refused', args: ['--dry-run', '--file', '$HOME/.env', 'creds'], files: { '.env': 'SECRET=1\n' } },
  { name: 'denylist disabled', args: ['--dry-run', '--no-feature', 'attach-denylist', '--file', '$HOME/.env', 'creds'], files: { '.env': 'SECRET=1\n' } },
  { name: 'obligations empty list', args: ['obligations'] },
  { name: 'obligations json', args: ['obligations', '--json'] },
  { name: 'obligations help', args: ['obligations', '--help'] },
  { name: 'obligations dismiss unknown', args: ['obligations', 'dismiss', 'zzz', '--reason', 'no longer relevant'], files: { '.config/tg-cli/.keep': '' } },
  { name: 'obligations bad option', args: ['obligations', '--bogus'] },
  { name: 'replies empty', args: ['replies'] },
  { name: 'replies json', args: ['replies', 'all', '--json'] },
  { name: 'user shorthand', args: ['user'] },
  { name: 'report help', args: ['report', '--help'] },
  { name: 'report missing fields', args: ['report', '--title', 'T'] },
  { name: 'report dry run', args: ['report', '--dry-run', '--title', 'Shipped', '--ticket', 'ABC-1', '--impact', 'Users see the fix', '--verify-cmd', 'bun test', '--verify-result', '12 passed'] },
  { name: 'hooks list', args: ['hooks', 'list'] },
  { name: 'auth garbage is prose', args: ['--dry-run', 'auth is broken'] },
  { name: 'config prose is a message', args: ['--dry-run', 'config validate my file now'] },
  { name: 'chatgpt unknown subcommand', args: ['chatgpt', 'bogus'] },
  { name: 'user account call missing peer', args: ['call'] },
  { name: 'ticket autolink is not network in dry-run', args: ['--dry-run', 'see HYP-576 and #12 and tg#5'] },
  { name: 'feature override and no-feature', args: ['--dry-run', '--feature', 'flood-cap', '--no-feature', 'autolink-tasks', 'x'] },
];

const HOME_TOKEN = '$HOME';

function materialise(value: string, home: string): string {
  return value.split(HOME_TOKEN).join(home);
}

async function runCase(c: Case): Promise<Outcome> {
  const home = tempDir('tg-parity-', { short: true });
  for (const [rel, content] of Object.entries(c.files ?? {})) {
    mkdirSync(join(home, rel, '..'), { recursive: true });
    writeFileSync(join(home, rel), content);
  }
  if (c.credentials) {
    const config = join(home, '.config', 'tg-cli');
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, '.env'), 'TG_BOT_TOKEN=123:fixture\nTG_CHAT_ID=1\n');
  }
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    TMUX: '',
    TG_LAYA: '0',
    TG_API_BASE: 'http://127.0.0.1:9',
    TG_DICT_PATH: join(home, 'no-dictionary.json-unset'),
    ...Object.fromEntries(Object.entries(c.env ?? {}).map(([k, v]) => [k, materialise(v, home)])),
  };
  // A default dictionary path that does not exist would be an explicit-path refusal; only set it
  // when the case did not choose one, and drop it entirely otherwise so the gate stays dormant.
  if (!c.env?.TG_DICT_PATH) delete env.TG_DICT_PATH;
  const proc = Bun.spawn([process.execPath, join(root, 'tg'), ...c.args.map((a) => materialise(a, home))], {
    cwd: home,
    env,
    stdin: c.stdin === undefined ? 'ignore' : new Blob([c.stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  // The version header embeds the build commit, which changes on every commit.
  // Normalise ONLY that first `tg <semver> (<sha>)` line: anchored to the very
  // start of the stream (no `m` flag), so nothing else can ever be masked.
  const norm = (s: string): string =>
    s
      .split(home)
      .join('<HOME>')
      .replace(/\d+\.\d+\.\d+-[0-9a-f]{6,}/g, '<VERSION>')
      .replace(/^(tg \d+\.\d+\.\d+) \([0-9a-f]{7,40}\)/, '$1 (<COMMIT>)');
  return { code, out: norm(out), err: norm(err) };
}

async function runAll(): Promise<Record<string, Outcome>> {
  const results = await Promise.all(CASES.map(async (c) => [c.name, await runCase(c)] as const));
  return Object.fromEntries(results);
}

test('case names are unique', () => {
  expect(new Set(CASES.map((c) => c.name)).size).toBe(CASES.length);
});

test('entrypoint output matches the pre-decomposition capture', async () => {
  const actual = await runAll();
  if (RECORD) {
    mkdirSync(join(fixturePath, '..'), { recursive: true });
    writeFileSync(fixturePath, `${JSON.stringify(actual, null, 2)}\n`);
    return;
  }
  const expected = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, Outcome>;
  expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
  for (const name of Object.keys(expected)) {
    expect({ name, ...actual[name] }).toEqual({ name, ...expected[name] });
  }
}, 120_000);

// ---------------------------------------------------------------------------------------------
// Send path: the same entrypoint against a local fake Bot API. What reaches the wire (method +
// JSON/multipart fields), the stdout/stderr/exit code and the bookkeeping files (routes, history,
// outbox, obligations) are captured. Nothing leaves the machine.
// ---------------------------------------------------------------------------------------------
const sendFixturePath = join(import.meta.dir, 'fixtures', 'outbound-runtime', 'send-parity.json');

interface SendCase {
  name: string;
  args: string[];
  env?: Record<string, string>;
  files?: Record<string, string>;
  // The fake API answers every send with this HTTP status (default 200).
  apiStatus?: number;
  // Extra control: `control:` block written to config.yaml.
  config?: string;
  // Hermetic toolchain: PATH contains only the stub bin dir above (no host
  // pandoc/Chrome), so the outcome cannot depend on what the recording
  // machine happened to have installed.
  hermeticPath?: boolean;
}

const SEND_CASES: SendCase[] = [
  { name: 'plain text', args: ['hello there'] },
  { name: 'html with tag and title', args: ['--format', 'html', '--tag', 'report', '--title', 'Status', '<b>Done</b> shipped'] },
  { name: 'subagent label', args: ['--subagent', 'fixer', 'hi from the subagent'] },
  { name: 'agent env branding', args: ['hello from an agent'], env: { TG_AI_MODEL: 'claude-3' } },
  { name: 'answer reply-to marks done', args: ['--tag', 'answer', '--reply-to', '41', 'the answer'] },
  { name: 'topic flag', args: ['--topic', '7', 'into a topic'] },
  { name: 'topic env', args: ['into the env topic'], env: { TG_TOPIC: '9' } },
  { name: 'table send', args: ['--table', 'Heading'] },
  { name: 'document attachment', args: ['--file', '$HOME/notes.txt', 'see attached'], files: { 'notes.txt': 'plain notes\n' } },
  { name: 'photo attachment', args: ['--photo', '$HOME/p.png', 'a picture'], files: { 'p.png': 'not really a png' } },
  { name: 'missing attachment is skipped', args: ['--file', '$HOME/gone.txt', 'text still goes'] },
  { name: 'line spec quote', args: ['--no-pdf', '--file', '$HOME/code.ts', 'look at code.ts:2-3'], files: { 'code.ts': 'const a = 1\nconst b = 2\nconst c = 3\nconst d = 4\n' } },
  // Hermetic fallback: pandoc is absent from the private PATH, and
  // TG_CHROME_PATH points at a case-owned dummy file — findChrome only checks
  // existence, and pandoc is missing so the dummy is never executed; the send
  // must fall back to the original .md with the pandoc-not-found warning.
  { name: 'markdown attachment without pandoc', args: ['--file', '$HOME/doc.md', 'doc'], files: { 'doc.md': '# Title\n\ntext\n', 'chrome-dummy': 'never executed\n' }, env: { TG_CHROME_PATH: '$HOME/chrome-dummy' }, hermeticPath: true },
  { name: 'long message is split', args: ['x'.repeat(5000)] },
  { name: 'flood cap refuses', args: ['y'.repeat(30000)] },
  { name: 'ticket and pr refs stay plain without cli', args: ['see HYP-576 and #12 and tg#5'] },
  { name: 'agent report with a question records follow-up', args: ['--tag', 'report', REPORT_WITH_QUESTION], env: { TG_AI_MODEL: 'claude-3' } },
  { name: 'pane origin records route and history', args: ['routed message'], env: { TMUX: '/tmp/x,1,0', TMUX_PANE: '%7' } },
  { name: 'telegram 500 queues to the outbox', args: ['queued message'], apiStatus: 500 },
  { name: 'telegram 400 fails', args: ['bad request message'], apiStatus: 400 },
];

interface WireRequest {
  method: string;
  fields: Record<string, unknown>;
}
interface SendOutcome extends Outcome {
  wire: WireRequest[];
  files: Record<string, string>;
}

async function readWire(req: Request): Promise<WireRequest> {
  const method = new URL(req.url).pathname.replace(/^\/bot[^/]+\//, '');
  const type = req.headers.get('content-type') ?? '';
  if (type.includes('multipart/form-data')) {
    const form = await req.formData();
    const fields: Record<string, unknown> = {};
    for (const [key, value] of form.entries()) {
      fields[key] = typeof value === 'string' ? value : { file: basename(value.name), size: value.size };
    }
    return { method, fields };
  }
  const text = await req.text();
  return { method, fields: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path, base));
    else out.push(path.slice(base.length + 1));
  }
  return out.sort();
}

function stableState(text: string): string {
  return text
    .replace(/"ts":\d+/g, '"ts":0')
    .replace(/"createdAt":\d+/g, '"createdAt":0')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<UUID>')
    .replace(/\[\d{4}-\d\d-\d\dT[\d:.]+Z\]/g, '[<TIME>]')
    .replace(/\d{15}-\d+-[0-9a-f]{8}/g, '<OUTBOX-ID>')
    .replace(/"at":\d+/g, '"at":0')
    .replace(/ts=\d+/g, 'ts=0');
}

async function runSendCase(c: SendCase): Promise<SendOutcome> {
  const home = tempDir('tg-send-parity-', { short: true });
  const config = join(home, '.config', 'tg-cli');
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, '.env'), 'TG_BOT_TOKEN=123:fixture\nTG_CHAT_ID=-100123\n');
  if (c.config) writeFileSync(join(config, 'config.yaml'), c.config);
  for (const [rel, content] of Object.entries(c.files ?? {})) {
    mkdirSync(join(home, rel, '..'), { recursive: true });
    writeFileSync(join(home, rel), content);
  }
  // Fixed cwd name (the header window name derives from it) and stub CLIs: the autolink probes
  // must see the same "installed but not logged in" host on every machine.
  const work = join(home, 'work');
  mkdirSync(work, { recursive: true });
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const cli of ['gh', 'linear']) {
    writeFileSync(join(bin, cli), '#!/bin/sh\necho "not logged in: authentication required" >&2\nexit 1\n', { mode: 0o755 });
  }
  const wire: WireRequest[] = [];
  let nextId = 100;
  const api = Bun.serve({
    port: 0,
    async fetch(req) {
      wire.push(await readWire(req));
      if ((c.apiStatus ?? 200) !== 200) return Response.json({ ok: false, description: 'fake failure' }, { status: c.apiStatus });
      nextId += 1;
      return Response.json({ ok: true, result: { message_id: nextId } });
    },
  });
  try {
    const stdin = c.args.includes('--table') ? new Blob(['task\tstatus\nship\tdone\n']) : 'ignore';
    const proc = Bun.spawn([process.execPath, join(root, 'tg'), ...c.args.map((a) => materialise(a, home))], {
      cwd: work,
      env: {
        PATH: c.hermeticPath ? bin : `${bin}:${process.env.PATH ?? ''}`,
        HOME: home,
        TMUX: '',
        TG_LAYA: '0',
        TG_API_BASE: `http://127.0.0.1:${api.port}`,
        TG_SEND_RETRY_BUDGET_MS: '0',
        ...Object.fromEntries(Object.entries(c.env ?? {}).map(([k, v]) => [k, materialise(v, home)])),
      },
      stdin,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const norm = (s: string): string => stableState(s.split(home).join('<HOME>'));
    const files: Record<string, string> = {};
    for (const rel of listFiles(config)) {
      if (rel === '.env' || rel.endsWith('.schema.json')) continue;
      const path = join(config, rel);
      files[rel.replace(/\d{15}-\d+-[0-9a-f]{8}/, '<OUTBOX-ID>').replace(/\d{4,}/g, '<N>')] = norm(readFileSync(path, 'utf8'));
    }
    return { code, out: norm(out), err: norm(err), wire, files };
  } finally {
    api.stop(true);
  }
}

test('send-case names are unique', () => {
  expect(new Set(SEND_CASES.map((c) => c.name)).size).toBe(SEND_CASES.length);
});

test('send path wire traffic and bookkeeping match the pre-decomposition capture', async () => {
  const results: Record<string, SendOutcome> = {};
  for (const c of SEND_CASES) results[c.name] = await runSendCase(c);
  if (RECORD) {
    writeFileSync(sendFixturePath, `${JSON.stringify(results, null, 2)}\n`);
    return;
  }
  const expected = JSON.parse(readFileSync(sendFixturePath, 'utf8')) as Record<string, SendOutcome>;
  expect(Object.keys(results).sort()).toEqual(Object.keys(expected).sort());
  for (const name of Object.keys(expected)) {
    expect({ name, ...results[name] }).toEqual({ name, ...expected[name] });
  }
}, 180_000);
