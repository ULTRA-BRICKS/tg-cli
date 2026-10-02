// Proves the prepared calbot consumer invokes the same independent Python library.
import { expect, test } from 'bun:test';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
test('calbot adapter is supplied without modifying calbot', async () => {
  expect(await Bun.file(join(root, 'adapters/calbot/call-lib.ts')).exists()).toBe(true);
});

test('CLI can report the shared library identity without auth', () => {
  const result = Bun.spawnSync(['python3', join(root, 'tg-call'), 'library-info']);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(new TextDecoder().decode(result.stdout)).distribution).toBe('tg-call-lib');
});

test('calbot JSON runner resolves exactly the CLI library module/version', async () => {
  const { callLib } = await import('../adapters/calbot/call-lib');
  const shared = await callLib(['python3', '-m', 'telegram_client.bridge'], { protocol: 1, action: 'describe' },
    { env: { ...process.env, PYTHONPATH: join(root, 'features') }, timeoutMs: 5000 });
  const cli = Bun.spawnSync(['python3', join(root, 'tg-call'), 'library-info']);
  expect(shared.library).toEqual(JSON.parse(new TextDecoder().decode(cli.stdout)));
});

test('calbot bridge refuses live start with missing consent before auth', async () => {
  const { callLib } = await import('../adapters/calbot/call-lib');
  await expect(callLib(['python3', '-m', 'telegram_client.bridge'], {
    protocol: 1, action: 'start', config: {},
    consent: { call: false, provider_network: false, source_idle: false },
  }, { env: { ...process.env, PYTHONPATH: join(root, 'features') }, timeoutMs: 5000 })).rejects.toThrow('LIVE_START_NOT_AUTHORIZED');
});

test('calbot cancellation terminates only its owned bridge process', async () => {
  const { callLib } = await import('../adapters/calbot/call-lib');
  const controller = new AbortController();
  const task = callLib(['python3', '-c', 'import sys,time; sys.stdin.read(); time.sleep(30)'],
    { protocol: 1, action: 'describe' }, { signal: controller.signal, timeoutMs: 5000 });
  controller.abort();
  await expect(task).rejects.toThrow('CALL_LIB_CANCELLED');
});
