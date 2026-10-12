// Real CLI wiring against a private fake Bot API: command-looking payloads must
// never execute account, hook, voice, report, recall or installation subcommands.
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tempDir } from './helpers/test-temp';
import { isRecord } from '../features/tg-ctl/guards';

const root = tempDir('tg-send-command-');
mkdirSync(join(root, 'config'));
writeFileSync(join(root, 'config', 'config.yaml'), 'control:\n  enabled: false\n');
const sent: string[] = [];
const server = Bun.serve({ port: 0, async fetch(req) {
  if (new URL(req.url).pathname.endsWith('/sendMessage')) {
    const value: unknown = await req.json();
    if (!isRecord(value) || typeof value.text !== 'string') throw new Error('Invalid send payload');
    sent.push(value.text);
    return Response.json({ok: true, result: {message_id: 100 + sent.length, chat: {id: 1, type: 'private'}}});
  }
  return Response.json({ok: true, result: {id: 123, is_bot: true, first_name: 'fixture', username: 'fixture_bot'}});
}});
afterAll(() => { server.stop(true); rmSync(root, {recursive: true, force: true}); });

async function run(args: string[], stdin?: string) {
  const p = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'tg'), ...args], {
    env: {PATH: process.env.PATH ?? '', HOME: root, TG_CTL_CONFIG_DIR: join(root, 'config'), TG_API_BASE: `http://127.0.0.1:${server.port}`, TG_BOT_TOKEN: '123:fixture', TG_CHAT_ID: '1'},
    stdout: 'pipe', stderr: 'pipe', stdin: stdin === undefined ? 'ignore' : 'pipe',
  });
  if (stdin !== undefined && p.stdin) { p.stdin.write(stdin); p.stdin.end(); }
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return {out, err, code};
}

test('explicit send and implicit literal forms reach only the fake sender', async () => {
  for (const [args, body] of [[['send', 'hello'], 'hello'], [['send'], 'send'], [['send hello'], 'send hello'], [['--literal', 'send', 'hello'], 'send hello'], [['send', '--', 'send', 'hello'], 'send hello'], [['--', '--', 'send', 'hello'], 'send hello'], [['--no-feature', 'prefix', 'send', 'hello'], 'send hello']] satisfies Array<[string[], string]>) {
    const before = sent.length; const result = await run(args);
    expect(result.code).toBe(0);
    expect(sent.length).toBe(before + 1);
    expect(sent.at(-1)?.endsWith(body)).toBe(true);
  }
}, 15000);

test('command names inside explicit send do not execute subcommands', async () => {
  for (const words of [['auth', 'user', 'logout'], ['hooks', 'trust'], ['voice', 'setup'], ['report', '--help'], ['replies', 'user'], ['install-skill']]) {
    const args = words.includes('--help') ? ['send', '--', ...words] : ['send', ...words];
    const before = sent.length; const result = await run(args);
    expect(result.code).toBe(0);
    expect(sent.length).toBe(before + 1);
    expect(sent.at(-1)?.endsWith(words.join(' '))).toBe(true);
  }
  expect(existsSync(join(root, '.agents', 'skills', 'tg'))).toBe(false);
  expect(existsSync(join(root, 'config', 'mtproto'))).toBe(false);
}, 15000);

test('literal flags stay body text and table stdin retains the sending pipeline', async () => {
  const result = await run(['send', '--', '--photo', 'private.txt', '--feature', 'unknown', '--version']);
  expect(result.code).toBe(0);
  expect(sent.at(-1)?.endsWith('--photo private.txt --feature unknown --version')).toBe(true);
  const table = await run(['send', '--table'], 'name\tvalue\nfixture\t1\n');
  expect(table.code).toBe(0);
  expect(sent.at(-1)).toContain('fixture');
}, 15000);

test('no-send options and malformed flags do not contact the sender', async () => {
  const before = sent.length;
  for (const args of [['send', '--help'], ['send', '--version'], ['send', ''], ['help', 'format'], ['report', '--help'], ['replies', '--help'], ['auth', '--help']]) expect((await run(args)).code).toBe(0);
  for (const args of [['send', '--unknown'], ['send', '--format'], ['send', '--photo']]) expect((await run(args)).code).not.toBe(0);
  expect(sent.length).toBe(before);
}, 15000);
