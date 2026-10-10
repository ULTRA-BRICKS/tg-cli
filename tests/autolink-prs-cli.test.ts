import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tempDir } from './helpers/test-temp';

// End to end: the real `tg` binary resolves `#N` refs against the Forgejo repo of its cwd
// (origin remote → REST API with the fj key-store token) and links them in the sent HTML.
// One mock server plays both the Bot API and the forge.

const TG_SCRIPT = join(import.meta.dir, '..', 'tg');

const sent: Array<Record<string, unknown>> = [];
const forgeRequests: Array<{ path: string; authorization: string | null; userAgent: string | null }> = [];

const issues: Record<number, unknown> = {
  5: {
    number: 5,
    title: 'Ship the board',
    state: 'closed',
    html_url: 'https://git.hyperide.ai/ultrabricks/tg-cli/pulls/5',
    pull_request: { merged: true, draft: false, html_url: 'https://git.hyperide.ai/ultrabricks/tg-cli/pulls/5' },
  },
  7: { number: 7, title: 'Board is missing', state: 'open', html_url: 'https://git.hyperide.ai/ultrabricks/tg-cli/issues/7', pull_request: null },
};

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/v1/')) {
      forgeRequests.push({ path: url.pathname, authorization: req.headers.get('authorization'), userAgent: req.headers.get('user-agent') });
      const m = url.pathname.match(/^\/api\/v1\/repos\/ultrabricks\/tg-cli\/issues\/(\d+)$/);
      const issue = m ? issues[Number(m[1])] : undefined;
      return issue ? Response.json(issue) : Response.json({ message: 'not found' }, { status: 404 });
    }
    if (url.pathname.endsWith('/sendMessage')) {
      sent.push((await req.json()) as Record<string, unknown>);
      return Response.json({ ok: true, result: { message_id: 1 } });
    }
    return Response.json({ ok: true, result: {} });
  },
});

afterAll(() => {
  server.stop(true);
});

function setup(originUrl: string): { home: string; repo: string } {
  const home = tempDir('tg-autolink-forgejo-');
  mkdirSync(join(home, '.config', 'tg-cli'), { recursive: true });
  writeFileSync(join(home, '.config', 'tg-cli', '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  const keysDir = join(home, '.local', 'share', 'forgejo-cli');
  mkdirSync(keysDir, { recursive: true });
  writeFileSync(join(keysDir, 'keys.json'), JSON.stringify({ hosts: { [`127.0.0.1:${server.port}`]: { type: 'Application', name: 't', token: 'tok' } }, aliases: {} }));
  const repo = join(home, 'repo');
  mkdirSync(repo);
  Bun.spawnSync(['git', 'init', '-q', repo]);
  Bun.spawnSync(['git', '-C', repo, 'remote', 'add', 'origin', originUrl]);
  return { home, repo };
}

async function send(text: string, home: string, cwd: string): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(['bun', TG_SCRIPT, text], {
    cwd,
    env: { PATH: process.env.PATH ?? '', HOME: home, TG_API_BASE: `http://127.0.0.1:${server.port}` },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stderr = await new Response(proc.stderr).text();
  return { exitCode: await proc.exited, stderr };
}

test('tg links Forgejo #N refs from the cwd origin and caches the verdicts', async () => {
  sent.length = 0;
  forgeRequests.length = 0;
  const { home, repo } = setup(`http://127.0.0.1:${server.port}/ultrabricks/tg-cli.git`);

  const first = await send('merged #5, tracked in #7, unrelated #9', home, repo);
  expect(first.stderr).toBe('');
  expect(first.exitCode).toBe(0);
  const html = sent[0].text as string;
  expect(html).toContain('<a href="https://git.hyperide.ai/ultrabricks/tg-cli/pulls/5">#5</a>');
  expect(html).toContain('<a href="https://git.hyperide.ai/ultrabricks/tg-cli/issues/7">#7</a>');
  expect(html).toContain('Ship the board (merged)');
  expect(html).toContain('Board is missing');
  expect(html).not.toContain('/9"');
  expect(forgeRequests.map((r) => r.path)).toEqual([
    '/api/v1/repos/ultrabricks/tg-cli/issues/5',
    '/api/v1/repos/ultrabricks/tg-cli/issues/7',
    '/api/v1/repos/ultrabricks/tg-cli/issues/9',
  ]);
  for (const r of forgeRequests) {
    expect(r.authorization).toBe('token tok');
    expect(r.userAgent).toBe('tg-cli-forgejo/1');
  }
  expect(existsSync(join(home, '.cache', 'tg-cli', 'forgejo-cache.json'))).toBe(true);
  expect(readFileSync(join(home, '.cache', 'tg-cli', 'forgejo-cache.json'), 'utf8')).toContain(`127.0.0.1:${server.port}/ultrabricks/tg-cli#9`);

  // Second send: positive and verified-absent verdicts come from the cache, no forge call.
  forgeRequests.length = 0;
  const second = await send('again #5 and #9', home, repo);
  expect(second.exitCode).toBe(0);
  expect(sent[1].text as string).toContain('<a href="https://git.hyperide.ai/ultrabricks/tg-cli/pulls/5">#5</a>');
  expect(forgeRequests).toEqual([]);
}, 30_000);

test('tg leaves #N plain and asks nothing of any forge when the origin is GitHub', async () => {
  sent.length = 0;
  forgeRequests.length = 0;
  const { home, repo } = setup('https://github.com/alex-mextner/tg-cli.git');
  const r = await send('see #5', home, repo);
  expect(r.exitCode).toBe(0);
  expect(r.stderr).toBe('');
  expect(sent[0].text as string).not.toContain('<a href');
  expect(forgeRequests).toEqual([]);
}, 30_000);
