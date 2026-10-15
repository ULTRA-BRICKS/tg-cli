// laya over task-cli's warm classify server (features/cli/laya-socket.ts, tg-cli#706),
// against a real unix socket speaking the server's protocol: one JSON request line in, one
// reply line out. No model is ever loaded here — the suite's TG_LAYA=0 is overridden per
// call with an env that points at a throwaway socket.
import { afterAll, expect, test } from 'bun:test';
import { chmodSync, mkdirSync } from 'fs';
import { join } from 'path';
import { layaAskProbability, layaSocketPath, parseLayaReply } from '../features/cli/laya-socket';
import { tempDir } from './helpers/test-temp';

const dir = tempDir('tg-laya-', { short: true });
chmodSync(dir, 0o700);
const sock = join(dir, 'laya-test.sock');
let requests: Array<{ op: string; message: string; questions: Record<string, unknown> }> = [];
let reply = (_message: string): string | null => JSON.stringify({ ok: true, result: { answers: { asks_reader: { type: 'noul', noul: 0.93 } } } });

const server = Bun.listen({
  unix: sock,
  socket: {
    data(socket, chunk) {
      const line = Buffer.from(chunk).toString('utf8').split('\n')[0];
      const req = JSON.parse(line);
      requests.push(req);
      const out = reply(req.message);
      if (out !== null) socket.write(`${out}\n`);
    },
  },
});
afterAll(() => server.stop(true));

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ TG_LAYA_SOCKET: sock, ...extra });

test('sends one predict request with the asks_reader question and reads P(true)', async () => {
  requests = [];
  expect(await layaAskProbability('Готово: #690 смержен, CI зелёный.', env())).toBe(0.93);
  expect(requests).toHaveLength(1);
  expect(requests[0].op).toBe('predict');
  expect(requests[0].message).toBe('Готово: #690 смержен, CI зелёный.');
  expect(Object.keys(requests[0].questions)).toEqual(['asks_reader']);
});

test('a server that never answers costs at most TG_LAYA_TIMEOUT_MS, then null', async () => {
  reply = () => null;
  const started = Date.now();
  expect(await layaAskProbability('x'.repeat(50), env({ TG_LAYA_TIMEOUT_MS: '150' }))).toBeNull();
  expect(Date.now() - started).toBeLessThan(1_000);
});

test('TG_LAYA=0, no socket, or a group-readable socket dir: null without connecting', async () => {
  requests = [];
  expect(await layaAskProbability('text', env({ TG_LAYA: '0' }))).toBeNull();
  expect(await layaAskProbability('text', { TG_LAYA_SOCKET: join(dir, 'missing.sock') })).toBeNull();
  const open = tempDir('tg-laya-open-', { short: true });
  chmodSync(open, 0o755);
  expect(layaSocketPath({ TG_LAYA_SOCKET: join(open, 'laya.sock') })).toBeNull();
  expect(requests).toHaveLength(0);
});

test('task-cli discovery: the newest laya-*.sock in $XDG_STATE_HOME/task-cli/classify', () => {
  const state = tempDir('tg-laya-state-', { short: true });
  const classify = join(state, 'task-cli', 'classify');
  mkdirSync(classify, { recursive: true, mode: 0o700 });
  chmodSync(classify, 0o700);
  expect(layaSocketPath({ XDG_STATE_HOME: state })).toBeNull();
  const live = Bun.listen({ unix: join(classify, 'laya-0.22.0.sock'), socket: { data() {} } });
  try {
    expect(layaSocketPath({ XDG_STATE_HOME: state })).toBe(join(classify, 'laya-0.22.0.sock'));
  } finally {
    live.stop(true);
  }
});

test('a reply that is not ok, or carries no probability, is null', () => {
  expect(parseLayaReply('{"ok":false,"error":"ValueError"}')).toBeNull();
  expect(parseLayaReply('{"ok":true,"result":{"answers":{}}}')).toBeNull();
  expect(parseLayaReply('not json')).toBeNull();
  expect(parseLayaReply('{"ok":true,"result":{"answers":{"asks_reader":{"noul":0.2}}}}')).toBe(0.2);
});
