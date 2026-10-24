import { expect, test } from 'bun:test';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newestTranscriptWriteMs } from '../features/tg-ctl/omp-activity-fs';
import { tempDir } from './helpers/test-temp';

const SESSION = '2026-10-24T19-09-21-588Z_01a16f51-4d34-7688-a2bf-beef754249ca';

function touch(path: string, atSeconds: number): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '{}\n');
  utimesSync(path, atSeconds, atSeconds);
}

test('newest write wins across the session transcript and a nested subagent transcript', () => {
  const dir = tempDir('omp-activity-');
  const file = join(dir, `${SESSION}.jsonl`);
  touch(file, 1_000);
  touch(join(dir, SESSION, 'Sub.jsonl'), 3_000);
  touch(join(dir, SESSION, 'Sub', 'Deep.jsonl'), 5_000);
  touch(join(dir, SESSION, '1.bash.log'), 9_000); // a tool log is not a transcript
  expect(newestTranscriptWriteMs(file)).toBe(5_000_000);
});

test('a session with no subagent folder reports its own transcript write', () => {
  const dir = tempDir('omp-activity-');
  const file = join(dir, `${SESSION}.jsonl`);
  touch(file, 2_000);
  expect(newestTranscriptWriteMs(file)).toBe(2_000_000);
});

test('an unreadable or non-jsonl path reports null', () => {
  expect(newestTranscriptWriteMs(null)).toBeNull();
  expect(newestTranscriptWriteMs('/nonexistent/x.jsonl')).toBeNull();
  expect(newestTranscriptWriteMs('/tmp/not-a-transcript.txt')).toBeNull();
});
