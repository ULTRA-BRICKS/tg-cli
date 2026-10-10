import { expect, test } from 'bun:test';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseHistory } from '../features/replies/history';
import { tempDir } from './helpers/test-temp';

// tg-cli#136: `tg` (outbound) and the daemon (inbound) both read-modify-write
// history.jsonl. Unlocked, two concurrent writers lose each other's rows.

const WRITER = join(import.meta.dir, '..', 'features', 'replies', 'history-file.ts');

test('concurrent writers never lose each other\'s history rows', async () => {
  const dir = tempDir('tg-history-lock-');
  try {
    const path = join(dir, 'history.jsonl');
    const writers = 6;
    const perWriter = 25;
    const script = `
      import { appendHistoryFile } from ${JSON.stringify(WRITER)};
      const w = Number(process.env.WRITER);
      for (let i = 0; i < ${perWriter}; i++) {
        appendHistoryFile(${JSON.stringify(path)}, [{ ts: 1, message_id: w * 1000 + i, direction: 'agent', from: 'agent', text: 'x', pane: null }]);
      }
    `;
    const procs = Array.from({ length: writers }, (_, w) =>
      Bun.spawn(['bun', '-e', script], { env: { ...process.env, WRITER: String(w) }, stdout: 'inherit', stderr: 'inherit' }),
    );
    expect(await Promise.all(procs.map((p) => p.exited))).toEqual(Array(writers).fill(0));
    const ids = parseHistory(readFileSync(path, 'utf8')).map((r) => r.message_id);
    expect(new Set(ids).size).toBe(writers * perWriter);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
