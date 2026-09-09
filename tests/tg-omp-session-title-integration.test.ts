import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Integration (tg-cli#358): outbound tg --detect-agent shows the omp session jsonl
// title when a live omp ancestor is present, even with TMUX unset.

const TG = join(import.meta.dir, '..', 'tg');

test('tg --detect-agent prints omp session title with TMUX unset (tg-cli#358)', () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tg-omp-title-'));
  const binDir = join(cfgDir, 'bin');
  mkdirSync(binDir);

  const sessionDir = join(cfgDir, 'sessions');
  mkdirSync(sessionDir);
  const sessionFile = join(sessionDir, '2026-09-07T20-28-22-700Z_01a07d8e-c12c-7433-903d-e98726bfda37.jsonl');
  writeFileSync(
    sessionFile,
    [
      '{"type":"title","v":1,"title":"OmpHeaderTitle","source":"auto"}',
      '{"type":"session","version":3,"id":"01a07d8e-c12c-7433-903d-e98726bfda37","cwd":"/Users/u/work/review-cli","title":"OmpHeaderTitle"}',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(binDir, 'lsof'),
    [
      '#!/bin/sh',
      "printf 'p7103\\n'",
      "printf 'fcwd\\n'",
      "printf 'n/Users/u/work/review-cli\\n'",
      `printf 'n${sessionFile}\\n'`,
      'exit 0',
    ].join('\n') + '\n',
    { mode: 0o755 },
  );

  const launcher = join(cfgDir, 'run-detect-agent.sh');
  writeFileSync(
    launcher,
    [
      '#!/bin/sh',
      'MY_PID=$$',
      `cat > "${binDir}/ps" << EOF`,
      '#!/bin/sh',
      "printf '    1     0 /sbin/launchd\\n'",
      "printf ' 7103     1 /opt/homebrew/bin/omp\\n'",
      "printf ' ${MY_PID}     7103 /opt/homebrew/bin/bun\\n'",
      'EOF',
      `chmod +x "${binDir}/ps"`,
      `bun "${TG}" --detect-agent`,
    ].join('\n') + '\n',
    { mode: 0o755 },
  );

  const proc = Bun.spawnSync([launcher], {
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      HOME: cfgDir,
      TMUX: '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) {
    console.error(proc.stderr.toString());
  }
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString().trim()).toBe('OmpHeaderTitle');
});
