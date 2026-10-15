import { expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseHistory } from '../features/replies/history';
import { tempDir, trackChild } from './helpers/test-temp';

// tg-cli#136: `tg` (outbound) and the daemon (inbound) both read-modify-write
// history.jsonl. Unlocked, two concurrent writers lose each other's rows.
//
// The contract (AGENTS.md "Concurrency (#136)") is best-effort, not zero-loss: an
// append whose lock stays contended past its budget is SKIPPED and reports false.
// So the file must hold exactly the rows whose append returned true — none lost,
// none duplicated, nothing from a skipped append. Counting every attempted row
// instead failed CI whenever a loaded runner made one append give up (tg-cli#519).

const WRITER = join(import.meta.dir, '..', 'features', 'replies', 'history-file.ts');

test('concurrent writers never lose a row whose append reported success', async () => {
  const dir = tempDir('tg-history-lock-');
  const path = join(dir, 'history.jsonl');
  const writers = 6;
  const perWriter = 25;
  const script = `
    import { appendHistoryFile } from ${JSON.stringify(WRITER)};
    const w = Number(process.env.WRITER);
    const written = [];
    const skipped = [];
    for (let i = 0; i < ${perWriter}; i++) {
      const id = w * 1000 + i;
      const ok = appendHistoryFile(${JSON.stringify(path)}, [{ ts: 1, message_id: id, direction: 'agent', from: 'agent', text: 'x', pane: null }]);
      (ok ? written : skipped).push(id);
    }
    process.stdout.write(JSON.stringify({ written, skipped }));
  `;
  const procs = Array.from({ length: writers }, (_, w) =>
    trackChild(Bun.spawn(['bun', '-e', script], { env: { ...process.env, WRITER: String(w) }, stdout: 'pipe', stderr: 'inherit' })),
  );
  const reports = await Promise.all(
    procs.map(async (p) => {
      const out = await new Response(p.stdout).text();
      expect(await p.exited).toBe(0);
      return JSON.parse(out) as { written: number[]; skipped: number[] };
    }),
  );
  const written = reports.flatMap((r) => r.written);
  const skipped = reports.flatMap((r) => r.skipped);
  expect(written.length + skipped.length).toBe(writers * perWriter);
  // Somebody always gets the lock, so the race was actually exercised.
  expect(written.length).toBeGreaterThan(0);

  const ids = parseHistory(readFileSync(path, 'utf8')).map((r) => r.message_id);
  // Exactly the reported-written rows, each once: a lost row, a duplicate, or a
  // row from an append that reported a skip all break this.
  expect(ids.sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(written.sort((a, b) => a - b));
  expect(statSync(path).mode & 0o777).toBe(0o600);
}, 60_000);
