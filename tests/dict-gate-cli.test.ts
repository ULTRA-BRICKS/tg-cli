import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tempDir } from './helpers/test-temp';

// CLI wiring for the dictionary gate (features/cli/dict-gate.ts, tg-cli#302).
// The gate runs in the `tg` entrypoint on the FINAL assembled caption/title,
// next to the cjk/mixed-script guards, BEFORE the dry-run short-circuit and
// before any transport — so a refusal never touches the network.
//
// Same harness as tests/cjk-guard-cli.test.ts: a BLOCK exits 1 with fake
// creds; a PASS-THROUGH case reaches the transport, which points at a closed
// local port, and asserts the gate did NOT fire (the send failed for a network
// reason).

const TG_SCRIPT = join(import.meta.dir, '..', 'tg');
const FIXTURE_DICT = join(import.meta.dir, 'fixtures', 'DICT.json');

let scratch: string;
let photoPath: string;
const OFFLINE = { TG_API_BASE: 'http://127.0.0.1:57194' };

beforeAll(() => {
  scratch = tempDir('tg-dict-gate-');
  // A minimal valid 1x1 PNG so `--photo` resolves at parse time.
  photoPath = join(scratch, 'shot.png');
  writeFileSync(
    photoPath,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: join(scratch, 'home-empty'),
    TG_BOT_TOKEN: 'fake-token',
    TG_CHAT_ID: '123456',
    TG_DICT_PATH: FIXTURE_DICT,
    // A closed high local port so a send that reaches the transport fails fast
    // (ECONNREFUSED) — the suite must NEVER hit the real Telegram API, not even
    // when a mis-wired gate lets a message through.
    ...OFFLINE,
    ...extra,
  };
}

function run(args: string[], env: Record<string, string>, stdin?: string) {
  const proc = Bun.spawnSync(['bun', TG_SCRIPT, ...args], {
    env,
    stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : undefined,
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function expectRefused(r: ReturnType<typeof run>, ruleId: string, matched: string) {
  expect(r.exitCode).toBe(1);
  expect(r.stderr).toContain(ruleId);
  expect(r.stderr).toContain(matched);
  expect(r.stderr).toContain(FIXTURE_DICT);
}

// The pass-through cases proceed past the gate to the offline transmit, which
// fails to connect: no dictionary error AND a non-zero exit for a network
// reason, so an unrelated early crash can't masquerade as a gate pass.
function expectPassedGateThenFailedOffline(r: ReturnType<typeof run>) {
  expect(r.stderr.toLowerCase()).not.toContain('dictionary');
  expect(r.exitCode).not.toBe(0);
  // The transport was actually reached: the closed port refused the connection.
  expect(r.stderr).toMatch(/ConnectionRefused|Unable to connect/);
}

test('refuses a plain body with a почт- verb form, naming rule, match and replacement', () => {
  const r = run(['Я почтил баг в парсере'], baseEnv());
  expectRefused(r, 'pochtit-as-fix', 'почтил');
  expect(r.stderr).toContain('починил');
});

test('refuses a banned word in the --title over a clean body', () => {
  const r = run(['--title', 'Скамейка запасных', 'всё готово'], baseEnv());
  expectRefused(r, 'skameyka-for-bench', 'Скамейка');
  expect(r.stderr).toContain('--title');
});

test('refuses "landing" inside Russian text for a --tag report --format html send', () => {
  const r = run(
    ['--tag', 'report', '--format', 'html', '<b>Готово</b>: после landing фикса всё ок'],
    baseEnv(),
  );
  expectRefused(r, 'land-landing-in-russian', 'landing');
});

test('refuses a --photo caption (the gate fires before any upload)', () => {
  const r = run(['--photo', photoPath, 'стиль сел в DOM'], baseEnv());
  expectRefused(r, 'sit-lie-for-apply', 'сел');
});

test('refuses a --file caption', () => {
  const r = run(['--file', photoPath, 'провайдер на скамье'], baseEnv());
  expectRefused(r, 'skameyka-for-bench', 'скамье');
});

test('reports EVERY hit across body and title in one refusal', () => {
  const r = run(['--title', 'Landing', 'Я почтил баг, стиль сел в DOM'], baseEnv());
  expect(r.exitCode).toBe(1);
  expect(r.stderr).toContain('pochtit-as-fix');
  expect(r.stderr).toContain('sit-lie-for-apply');
  expect(r.stderr).toContain('land-landing-in-russian');
});

test('--dry-run runs the same check and reports hits the same way (exit 1, nothing OK)', () => {
  const r = run(['--dry-run', 'Я почтил баг'], baseEnv());
  expectRefused(r, 'pochtit-as-fix', 'почтил');
  expect(r.stdout).not.toContain('tg --dry-run: OK');
});

test('--dry-run passes a clean message', () => {
  const r = run(['--dry-run', 'Баг починен, стиль применяется'], baseEnv());
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('tg --dry-run: OK');
});

test('a banned word quoted in <code> is ignored (passes the gate; failure is the offline send)', () => {
  const r = run(['--format', 'html', 'слово <code>почтил</code> запрещено, пиши починил'], baseEnv());
  expectPassedGateThenFailedOffline(r);
});

test('PLAIN format (the default): a banned word between < and > is delivered verbatim, so it is refused', () => {
  const r = run(['фикс: <скамейка запасных> влит'], baseEnv());
  expectRefused(r, 'skameyka-for-bench', 'скамейка');
});

test('implicit HTML (no --format html): <code> is exempt because detectHtmlTags upgrades the send to HTML', () => {
  const r = run(['слово <code>почтил</code> запрещено, пиши починил'], baseEnv());
  expectPassedGateThenFailedOffline(r);
});

test('implicit HTML (no --format html): a tag-split banned word is refused (reader sees почтил)', () => {
  const r = run(['я почт<b>ил</b> баг'], baseEnv());
  expectRefused(r, 'pochtit-as-fix', 'почтил');
});

test('only_if_cyrillic counts Cyrillic quoted in <code>: an English title over it is refused', () => {
  const r = run(['--format', 'html', '--title', 'Landing done', 'see <code>правку</code> for details'], baseEnv());
  expectRefused(r, 'land-landing-in-russian', 'Landing');
});

test('--no-feature dict-gate is NOT an off-switch (the no-bypass contract)', () => {
  const r = run(['--no-feature', 'dict-gate', 'Я почтил баг'], baseEnv());
  expectRefused(r, 'pochtit-as-fix', 'почтил');
});

test('"the fix landed" with no Cyrillic passes the gate', () => {
  const r = run(['the fix landed on main'], baseEnv());
  expectPassedGateThenFailedOffline(r);
});

test('a missing dictionary at the DEFAULT path disables the gate silently', () => {
  const home = join(scratch, 'home-no-dict');
  mkdirSync(home, { recursive: true });
  const env = baseEnv({ HOME: home });
  delete env.TG_DICT_PATH;
  const r = run(['Я почтил баг'], env);
  expectPassedGateThenFailedOffline(r);
});

test('an EXPLICIT TG_DICT_PATH that does not exist refuses to send (not an off-switch)', () => {
  const absent = join(scratch, 'absent.json');
  const r = run(['совершенно чистое сообщение'], baseEnv({ TG_DICT_PATH: absent }));
  expect(r.exitCode).toBe(1);
  expect(r.stderr).toContain(absent);
  expect(r.stderr).toContain('TG_DICT_PATH');
});

test('TG_DICT_PATH set in ~/.config/tg-cli/.env is honored (the merged config env)', () => {
  const home = join(scratch, 'home-cfg-env');
  mkdirSync(join(home, '.config', 'tg-cli'), { recursive: true });
  writeFileSync(join(home, '.config', 'tg-cli', '.env'), `TG_DICT_PATH=${FIXTURE_DICT}\n`);
  const env = baseEnv({ HOME: home });
  delete env.TG_DICT_PATH;
  const r = run(['Я почтил баг'], env);
  expectRefused(r, 'pochtit-as-fix', 'почтил');
});

test('the --subagent label is header text the agent authors, so it is gated', () => {
  const r = run(['--subagent', 'скамейка-критик', 'всё готово'], baseEnv());
  expectRefused(r, 'skameyka-for-bench', 'скамейка');
  expect(r.stderr).toContain('--subagent');
});

test('the default path is ~/.claude/DICT.json under HOME when TG_DICT_PATH is unset', () => {
  const home = join(scratch, 'home-with-dict');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(
    join(home, '.claude', 'DICT.json'),
    JSON.stringify({
      version: 1,
      rules: [{ id: 'home-rule', pattern: '\\bскамейк[а-яё]*', flags: 'iu', replacement: 'бенч', why: '' }],
    }),
  );
  const env = baseEnv({ HOME: home });
  delete env.TG_DICT_PATH;
  const r = run(['на скамейке'], env);
  expect(r.exitCode).toBe(1);
  expect(r.stderr).toContain('home-rule');
  expect(r.stderr).toContain(join(home, '.claude', 'DICT.json'));
});

test('TG_DICT_PATH overrides the default path', () => {
  const home = join(scratch, 'home-with-dict-2');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'DICT.json'), JSON.stringify({ version: 1, rules: [] }));
  const r = run(['Я почтил баг'], baseEnv({ HOME: home }));
  expectRefused(r, 'pochtit-as-fix', 'почтил');
});

test('a malformed dictionary refuses to send, naming the file (fail closed)', () => {
  const bad = join(scratch, 'bad.json');
  writeFileSync(bad, '{ "rules": [ oops');
  const r = run(['совершенно чистое сообщение'], baseEnv({ TG_DICT_PATH: bad }));
  expect(r.exitCode).toBe(1);
  expect(r.stderr).toContain(bad);
  expect(r.stderr.toLowerCase()).toContain('dictionary');
});

test('an invalid regex refuses to send, naming the file and the rule', () => {
  const bad = join(scratch, 'bad-regex.json');
  writeFileSync(
    bad,
    JSON.stringify({ version: 1, rules: [{ id: 'broken-rule', pattern: '(oops', flags: 'iu', replacement: 'x', why: '' }] }),
  );
  const r = run(['clean message'], baseEnv({ TG_DICT_PATH: bad }));
  expect(r.exitCode).toBe(1);
  expect(r.stderr).toContain(bad);
  expect(r.stderr).toContain('broken-rule');
});

test('a malformed dictionary does not break --help / help format / --version', () => {
  const bad = join(scratch, 'bad2.json');
  writeFileSync(bad, 'nope');
  for (const args of [['--help'], ['help', 'format'], ['--version']]) {
    const r = run(args, baseEnv({ TG_DICT_PATH: bad }));
    expect(r.exitCode).toBe(0);
  }
});

test('tg help format documents the dictionary file format', () => {
  const r = run(['help', 'format'], baseEnv());
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('DICT.json');
  expect(r.stdout).toContain('TG_DICT_PATH');
  expect(r.stdout).toContain('only_if_cyrillic');
  expect(r.stdout).toContain('replacement');
});

test('--table rows are checked too', () => {
  const r = run(['--table'], baseEnv(), 'задача\tстатус\nпочтил баг\tготово\n');
  expectRefused(r, 'pochtit-as-fix', 'почтил');
  expect(r.stderr).toContain('table rows');
});

test('--table heading is checked too', () => {
  const r = run(['--table', 'провайдер на скамейке'], baseEnv(), 'задача\tстатус\nготово\tда\n');
  expectRefused(r, 'skameyka-for-bench', 'скамейке');
  expect(r.stderr).toContain('table heading');
});

test('a dictionary path that is a directory refuses to send, naming the path (fail closed, not ENOENT)', () => {
  const dir = join(scratch, 'dict-is-a-dir');
  mkdirSync(dir, { recursive: true });
  const r = run(['clean message'], baseEnv({ TG_DICT_PATH: dir }));
  expect(r.exitCode).toBe(1);
  expect(r.stderr).toContain(dir);
  expect(r.stderr.toLowerCase()).toContain('dictionary');
});

test('a TG_DICT_PATH whose parent is a FILE (ENOTDIR) refuses to send, naming the path — not silently off', () => {
  const parentFile = join(scratch, 'notes.txt');
  writeFileSync(parentFile, 'x');
  const bad = join(parentFile, 'DICT.json');
  const r = run(['clean message'], baseEnv({ TG_DICT_PATH: bad }));
  expect(r.exitCode).toBe(1);
  expect(r.stderr).toContain(bad);
  expect(r.stderr.toLowerCase()).toContain('dictionary');
});

test('with neither TG_DICT_PATH nor HOME the gate is disabled (no literal ~ path)', () => {
  const env = baseEnv();
  delete env.TG_DICT_PATH;
  delete env.HOME;
  const r = run(['Я почтил баг'], env);
  expectPassedGateThenFailedOffline(r);
});
