import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makeTgHome, runTg, startFakeBotApi, writeShim, type HomeOptions, type TgHome } from './helpers/fake-bot-api';

// The REAL `tg` with a scripted `gh` on PATH, against a recording Bot API: what autolinking
// does to the wire body (docs/specs/autolink-prs.md, autolink-msgrefs.md), and the attachment
// conversions' fallback when no renderer exists (docs/specs/md-as-pdf.md: any failure attaches
// the original). Autolink must never block or fail a send.

const api = startFakeBotApi();
beforeEach(() => api.reset());
afterAll(() => {
  api.stop();
});

const PR_12 = { __typename: 'PullRequest', number: 12, title: 'Fix the splitter', url: 'https://github.com/o/a/pull/12', state: 'MERGED', isDraft: false };

// A `gh` that logs every invocation and answers `repo view` with $GH_REPO and `api graphql`
// with the JSON in $GH_RESPONSE.
function session(opts: HomeOptions = {}): { h: TgHome; cwd: string; ghLog: string; env: Record<string, string> } {
  const h = makeTgHome(opts);
  const cwd = join(h.home, 'api-bot');
  mkdirSync(cwd);
  const ghLog = join(h.home, 'gh.log');
  writeFileSync(ghLog, '');
  writeShim(
    h.bin,
    'gh',
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$GH_LOG"',
      'case "$1 $2" in',
      '  "repo view") printf "%s\\n" "$GH_REPO" ;;',
      '  "api graphql") printf "%s" "$GH_RESPONSE" ;;',
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  const env = { GH_LOG: ghLog, GH_REPO: 'o/a', GH_RESPONSE: JSON.stringify({ data: { repository: { n12: PR_12 } } }) };
  return { h, cwd, ghLog, env };
}

const graphqlQueries = (ghLog: string): string[] => readFileSync(ghLog, 'utf8').split('\n').filter((l) => l.startsWith('api graphql'));

test('a tg#<id> message ref is never resolved as a GitHub #<id>; the real #12 is linked and listed in its own PRs block', async () => {
  const { h, cwd, ghLog, env } = session();
  const r = await runTg(api, h, ['merged #12, as you asked in tg#3715'], { cwd, env });
  expect(r.exitCode).toBe(0);
  const queries = graphqlQueries(ghLog);
  expect(queries).toHaveLength(1);
  expect(queries[0]).toContain('issueOrPullRequest(number: 12)');
  expect(queries[0]).not.toContain('3715');
  const body = api.calls[0].body;
  expect(body.parse_mode).toBe('HTML');
  const text = String(body.text);
  expect(text).toContain('<a href="https://github.com/o/a/pull/12">#12</a>');
  expect(text).toMatch(/<blockquote expandable>PRs:\n<a href="https:\/\/github\.com\/o\/a\/pull\/12">#12<\/a> — Fix the splitter \(merged\)<\/blockquote>$/);
  // A private chat has no per-message URL: the ref is marked, never linked.
  expect(text).not.toContain('t.me/c/');
});

test('in a supergroup the tg#<id> ref becomes a t.me/c deep link to that message', async () => {
  const { h, cwd, env } = session({ chatId: -1001234567890 });
  const r = await runTg(api, h, ['see tg#3715'], { cwd, env });
  expect(r.exitCode).toBe(0);
  expect(String(api.calls[0].body.text)).toContain('<a href="https://t.me/c/1234567890/3715">');
});

test('a resolved #N is cached per repo: the same repo is not queried again, another repo with the same #N is', async () => {
  const { h, cwd, ghLog, env } = session();
  await runTg(api, h, ['first #12'], { cwd, env });
  await runTg(api, h, ['again #12'], { cwd, env });
  expect(graphqlQueries(ghLog)).toHaveLength(1);
  expect(String(api.calls[1].body.text)).toContain('<a href="https://github.com/o/a/pull/12">#12</a>');

  const other = { ...PR_12, title: 'Other repo PR', url: 'https://github.com/o/b/pull/12' };
  await runTg(api, h, ['other repo #12'], { cwd, env: { ...env, GH_REPO: 'o/b', GH_RESPONSE: JSON.stringify({ data: { repository: { n12: other } } }) } });
  expect(graphqlQueries(ghLog)).toHaveLength(2);
  expect(String(api.calls[2].body.text)).toContain('https://github.com/o/b/pull/12');
});

test('gh failing outright leaves the message as written — sent plain, exit 0', async () => {
  const { h, cwd, env } = session();
  const r = await runTg(api, h, ['fixed #12 & shipped'], { cwd, env: { ...env, GH_RESPONSE: 'not json' } });
  expect(r.exitCode).toBe(0);
  expect(api.calls).toHaveLength(1);
  expect(api.calls[0].body.parse_mode).toBeUndefined();
  expect(String(api.calls[0].body.text).endsWith('fixed #12 & shipped')).toBe(true);
});

test('a code file whose PDF cannot be rendered (no Chrome) is attached as the original, with a warning', async () => {
  const { h, cwd } = session();
  const src = join(cwd, 'split.ts');
  writeFileSync(src, 'export const LIMIT = 4096;\n');
  const r = await runTg(api, h, ['--file', src, 'the splitter'], { cwd });
  expect(r.exitCode).toBe(0);
  expect(api.calls.map((c) => c.method)).toEqual(['sendDocument']);
  const upload = Object.values(api.calls[0].files)[0];
  expect(upload.name.endsWith('/split.ts')).toBe(true);
  expect(upload.text).toBe('export const LIMIT = 4096;\n');
  expect(r.stderr).toContain(`code-as-pdf: ${src}`);
  expect(r.stderr).toContain('attaching the original file');
});
