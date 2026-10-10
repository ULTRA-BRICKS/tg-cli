import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tempDir } from './helpers/test-temp';

// Regression coverage for the `--dry-run` flag (tg-cli issue: a subagent
// iterating against the strict `--tag decision` escalation-format
// gate had no way to test structural compliance except a REAL send. A
// structurally-compliant draft — even one still carrying scaffold/placeholder
// text like "foo bar baz test" / "Option A" pros "ok" cons "bad" / "foo.ts:1"
// (the literal shape of escalationFormatMessage's own example) — sailed
// straight through the gate and hit the live Telegram chat. Confirmed from
// the real outbound history log: message_id 10195-10200, six live sends in
// under 90 seconds, two of them (10199/10200) still carrying "foo bar baz
// test." verbatim, before the caller finally landed the real content in
// 10201/10202.
//
// `--dry-run` runs every local guard (escalation-format gate, cjk-guard,
// screenshot-guard, pipe-table conversion) and prints the outcome, but MUST NEVER reach the
// network — proven here with a mock Bot-API server that records every
// request it receives: a `--dry-run` send, compliant OR malformed, must
// leave that recorder empty.

const TG_SCRIPT = join(import.meta.dir, '..', 'tg');

let received: Array<Record<string, unknown>>;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    // `--format html` sends go out via the Bot API's sendRichMessage (see
    // features/transport/telegram.ts); plain sends use sendMessage. Record both.
    if (url.pathname.endsWith('/sendMessage') || url.pathname.endsWith('/sendRichMessage')) {
      const body = (await req.json()) as Record<string, unknown>;
      received.push(body);
      return Response.json({ ok: true, result: { message_id: 1 } });
    }
    return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
  },
});

const dirs: string[] = [];
afterAll(() => {
  server.stop(true);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// A throwaway HOME with real (fake) credentials configured, so a regression
// that lets --dry-run fall through to the credential gate and beyond would
// actually reach the mock server instead of dying earlier on missing creds —
// the strongest form of this regression test.
function makeHomeWithCreds(): string {
  const home = tempDir('tg-dry-run-home-');
  dirs.push(home);
  const cfg = join(home, '.config', 'tg-cli');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  return home;
}

async function run(
  args: string[],
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', TG_SCRIPT, ...args], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

// The EXACT placeholder body sent live in the incident (history log message_id
// 10199), reconstructed verbatim.
const PLACEHOLDER_BODY = [
  '<h3>Context</h3><p>foo bar baz test.</p><hr>',
  '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr>',
  '<tr><td>A</td><td>ok</td><td>bad</td></tr><tr><td>B</td><td>safe</td><td>slow</td></tr></table><hr>',
  '<h3>Recommendation</h3><ul><li>C wins</li></ul><hr>',
  '<h4>Where to look</h4><ul><li>foo.ts:1</li></ul>',
].join('\n');

const COMPLIANT_BODY = [
  '<h3>Context</h3><p>The resolver in features/foo.ts:42 picks the wrong click target on cold maps.</p><hr>',
  '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr>',
  '<tr><td>A</td><td>fast</td><td>risky</td></tr><tr><td>B</td><td>safe</td><td>slow</td></tr></table><hr>',
  '<h3>Recommendation</h3><ul><li>I recommend A because it is faster</li></ul><hr>',
  '<h4>Where to look</h4><ul><li>features/foo.ts:42</li></ul>',
].join('\n');

test('--dry-run with a structurally-COMPLIANT decision body: exits 0, prints OK, sends NOTHING to the mock server', async () => {
  received = [];
  const home = makeHomeWithCreds();
  const { exitCode, stdout } = await run(
    ['--dry-run', '--tag', 'decision', '--format', 'html', COMPLIANT_BODY],
    { PATH: process.env.PATH ?? '', HOME: home, TG_API_BASE: `http://127.0.0.1:${server.port}` },
  );
  expect(exitCode).toBe(0);
  expect(stdout).toContain('tg --dry-run: OK');
  expect(stdout).toContain('No network call was made');
  expect(received).toHaveLength(0);
});

// The regression this exists to catch: exactly the incident body, still
// carrying "foo bar baz test" / "Option A" ok/bad / "foo.ts:1" placeholder
// text. At the time this test was written it was structurally compliant
// (headings, table, pros/cons keywords, a recommendation, a file:line ref,
// <hr> dividers) INCLUDING Context, so the OLD code (no --dry-run) sent it
// for real.
//
// tg-cli#262 (escalation-format's Context-prose check) subsequently tightened
// what counts as "Context — a sentence of prose": this exact body's Context
// line, "foo bar baz test.", is only 13 real (\p{L}/\p{N}) characters — under
// the 20-char floor — and used to clear it only because pre-#262 counted
// glued HTML tag-name characters toward the total (the same class of bug
// #262 fixed for the wall-of-text check). Post-#262 this incident body is
// REJECTED by the format gate itself, with or without --dry-run — a strictly
// better outcome than before (the gate alone now prevents this exact
// incident, not just --dry-run). Both tests below assert that.
test('--dry-run with the incident PLACEHOLDER body ("foo bar baz test" / Option A "ok"/"bad"): now hard-blocked by the format gate itself, still sends NOTHING', async () => {
  received = [];
  const home = makeHomeWithCreds();
  const { exitCode, stderr } = await run(
    ['--dry-run', '--tag', 'decision', '--format', 'html', PLACEHOLDER_BODY],
    { PATH: process.env.PATH ?? '', HOME: home, TG_API_BASE: `http://127.0.0.1:${server.port}` },
  );
  expect(exitCode).toBe(1);
  expect(stderr).toContain('Blocked:');
  expect(received).toHaveLength(0);
});

// Contrast case: with tg-cli#262 landed, the SAME placeholder body no longer
// reaches the wire even WITHOUT --dry-run — the format gate itself now
// catches this incident's root cause (insufficient real Context prose)
// before any network attempt. This is the defense-in-depth improvement:
// --dry-run is no longer the only thing standing between this exact junk
// body and a live send.
test('the SAME placeholder body WITHOUT --dry-run is now also blocked before reaching the mock server (defense in depth, post-#262)', async () => {
  received = [];
  const home = makeHomeWithCreds();
  const { exitCode } = await run(
    ['--tag', 'decision', '--format', 'html', PLACEHOLDER_BODY],
    { PATH: process.env.PATH ?? '', HOME: home, TG_API_BASE: `http://127.0.0.1:${server.port}` },
  );
  expect(exitCode).toBe(1);
  expect(received).toHaveLength(0);
});

test('--dry-run with a MALFORMED decision body: still hard-blocks (exit 1) before ever reaching the dry-run OK path', async () => {
  received = [];
  const home = makeHomeWithCreds();
  const { exitCode, stdout, stderr } = await run(
    ['--dry-run', '--tag', 'decision', 'ship it or not?'],
    { PATH: process.env.PATH ?? '', HOME: home, TG_API_BASE: `http://127.0.0.1:${server.port}` },
  );
  expect(exitCode).toBe(1);
  expect(stderr).toContain('Blocked:');
  expect(stdout).not.toContain('tg --dry-run: OK');
  expect(received).toHaveLength(0);
});

test('--dry-run needs NO credentials at all: works with a HOME that has no ~/.config/tg-cli/.env', async () => {
  const home = tempDir('tg-dry-run-no-creds-');
  dirs.push(home);
  const { exitCode, stdout, stderr } = await run(['--dry-run', 'plain status update, no tag'], {
    PATH: process.env.PATH ?? '',
    HOME: home,
  });
  expect(exitCode).toBe(0);
  expect(stdout).toContain('tg --dry-run: OK');
  expect(stderr).not.toContain('TG_BOT_TOKEN');
});

test('--dry-run prints the rendered body it would have sent', async () => {
  const home = tempDir('tg-dry-run-preview-');
  dirs.push(home);
  const { stdout } = await run(['--dry-run', 'hello from a dry run'], {
    PATH: process.env.PATH ?? '',
    HOME: home,
  });
  expect(stdout).toContain('--- rendered body (pre-autolink) ---');
  expect(stdout).toContain('hello from a dry run');
});

// review finding: a --dry-run OK must never imply "attachments validated too"
// when attachments are not even inspected — reject explicitly instead of a
// silent partial pass.
test('--dry-run with an attachment (--photo/--file) is a hard error, not a silent partial OK', async () => {
  const home = tempDir('tg-dry-run-attach-');
  dirs.push(home);
  const missingPhoto = join(home, 'nonexistent.png');
  const { exitCode, stdout, stderr } = await run(
    ['--dry-run', '--photo', missingPhoto, 'caption'],
    { PATH: process.env.PATH ?? '', HOME: home },
  );
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain('--dry-run does not support attachments');
  expect(stdout).not.toContain('tg --dry-run: OK');
});

test('--dry-run with the removed --tag question is REFUSED even with a compliant body (tg-cli#301)', async () => {
  received = [];
  const home = makeHomeWithCreds();
  const { exitCode, stdout, stderr } = await run(
    ['--dry-run', '--tag', 'question', '--format', 'html', COMPLIANT_BODY],
    { PATH: process.env.PATH ?? '', HOME: home, TG_API_BASE: `http://127.0.0.1:${server.port}` },
  );
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain('--tag question was removed');
  expect(stderr).toContain('use --tag decision');
  expect(stdout).not.toContain('tg --dry-run: OK');
  expect(received).toHaveLength(0);
});

test('--dry-run --table (rows via stdin) validates the FINAL rendered table and sends NOTHING', async () => {
  received = [];
  const home = makeHomeWithCreds();
  const proc = Bun.spawn(
    ['bun', TG_SCRIPT, '--dry-run', '--table'],
    {
      env: { PATH: process.env.PATH ?? '', HOME: home, TG_API_BASE: `http://127.0.0.1:${server.port}` },
      stdin: new TextEncoder().encode('task\tstatus\nship\tdone'),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  expect(exitCode).toBe(0);
  expect(stdout).toContain('tg --dry-run: OK');
  expect(stdout).toContain('ship');
  expect(received).toHaveLength(0);
});

test('--dry-run still hard-blocks a cjk-guard violation (stray CJK glyph) before printing OK', async () => {
  const home = tempDir('tg-dry-run-cjk-');
  dirs.push(home);
  // A lone CJK ideograph glued mid-word into Latin text — the exact shape the
  // cjk-guard exists to catch (see features/cli/cjk-guard.ts).
  const { exitCode, stdout, stderr } = await run(['--dry-run', 'hello文world'], {
    PATH: process.env.PATH ?? '',
    HOME: home,
  });
  expect(exitCode).toBe(1);
  expect(stderr).toContain('Error:');
  expect(stdout).not.toContain('tg --dry-run: OK');
});
