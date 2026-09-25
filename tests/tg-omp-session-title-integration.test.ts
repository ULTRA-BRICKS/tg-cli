import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Integration (tg-cli#358, revised by Alex escalation point 5, 2026-09-25):
// outbound `tg --detect-agent` resolves the `[window]` bracket ALWAYS from
// tmux (or an explicit "no tmux" marker for a detached/headless omp ancestor)
// and the omp session jsonl title as SEPARATE, additional info — never as a
// substitute for `[window]`. Before this fix, a live omp ancestor's session
// title silently REPLACED the tmux window name even from inside a real tmux
// pane, so a message sent from a tmux window showed no tmux window at all —
// exactly the bug Alex reported ("[Fix Missing Provisioned Skills in Rig]"
// with no tmux window shown).

const TG = join(import.meta.dir, '..', 'tg');

// Live-pid omp-ancestor fake `ps` (same helper as cli-omp-route-notmux.test.ts):
// derives the omp-ancestor pid from the CALLING process's own ppid at
// `ps`-invocation time, so no pre-baked `$$`-substitution launcher is needed.
function writeFakeOmpPs(dir: string): void {
  const script =
    '#!/bin/sh\n' +
    'TG="$PPID"\n' +
    'TGPPID=$(/bin/ps -o ppid= -p "$TG" 2>/dev/null | tr -d " ")\n' +
    '[ -z "$TGPPID" ] && TGPPID=900000\n' +
    'echo "$TG $TGPPID bun run tg"\n' +
    'echo "$TGPPID 1 /opt/homebrew/bin/omp"\n';
  writeFileSync(join(dir, 'ps'), script, { mode: 0o755 });
  chmodSync(join(dir, 'ps'), 0o755);
}

function setupOmpSession(cfgDir: string, title = 'OmpHeaderTitle'): { binDir: string } {
  const binDir = join(cfgDir, 'bin');
  mkdirSync(binDir);

  const sessionDir = join(cfgDir, 'sessions');
  mkdirSync(sessionDir);
  const sessionFile = join(sessionDir, '2026-09-07T20-28-22-700Z_01a07d8e-c12c-7433-903d-e98726bfda37.jsonl');
  writeFileSync(
    sessionFile,
    [
      `{"type":"title","v":1,"title":${JSON.stringify(title)},"source":"auto"}`,
      `{"type":"session","version":3,"id":"01a07d8e-c12c-7433-903d-e98726bfda37","cwd":"/Users/u/work/review-cli","title":${JSON.stringify(title)}}`,
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

  return { binDir };
}

// Writes the `ps` fake INSIDE the launcher (heredoc, expanded at runtime by
// the launcher's own shell) so `$MY_PID` — the actual pid `tg` sees as its
// parent — lands in the fake table, same pattern the original tg-cli#358
// test used.
function psHeredocLines(binDir: string): string[] {
  return [
    `cat > "${binDir}/ps" << EOF`,
    '#!/bin/sh',
    "printf '    1     0 /sbin/launchd\\n'",
    "printf ' 7103     1 /opt/homebrew/bin/omp\\n'",
    "printf ' ${MY_PID}     7103 /opt/homebrew/bin/bun\\n'",
    'EOF',
    `chmod +x "${binDir}/ps"`,
  ];
}

test('tg --detect-agent: detached omp session (no tmux) shows an explicit "no tmux" marker PLUS the session title on its own line', () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tg-omp-title-'));
  const { binDir } = setupOmpSession(cfgDir);

  const launcher = join(cfgDir, 'run-detect-agent.sh');
  writeFileSync(
    launcher,
    ['#!/bin/sh', 'MY_PID=$$', ...psHeredocLines(binDir), `bun "${TG}" --detect-agent`].join('\n') + '\n',
    { mode: 0o755 },
  );

  const proc = Bun.spawnSync([launcher], {
    env: { PATH: `${binDir}:${process.env.PATH ?? ''}`, HOME: cfgDir, TMUX: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) console.error(proc.stderr.toString());
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString().trim()).toBe('no tmux\ntitle: OmpHeaderTitle');
});

test('tg --detect-agent: a real tmux window name is NEVER replaced by the omp session title — both show (Alex escalation point 5 regression)', () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tg-omp-title-tmux-'));
  const { binDir } = setupOmpSession(cfgDir);
  writeFileSync(
    join(binDir, 'tmux'),
    [
      '#!/bin/sh',
      'sub="$1"; shift',
      'case "$sub" in',
      "  display-message) printf 'rig-cli\\t/Users/u/work/review-cli\\n' ;;",
      '  *) ;;',
      'esac',
      'exit 0',
    ].join('\n') + '\n',
    { mode: 0o755 },
  );

  const launcher = join(cfgDir, 'run-detect-agent.sh');
  writeFileSync(
    launcher,
    ['#!/bin/sh', 'MY_PID=$$', ...psHeredocLines(binDir), `bun "${TG}" --detect-agent`].join('\n') + '\n',
    { mode: 0o755 },
  );

  const proc = Bun.spawnSync([launcher], {
    env: { PATH: `${binDir}:${process.env.PATH ?? ''}`, HOME: cfgDir, TMUX: '/tmp/tmux-fake,1234,0', TMUX_PANE: '%3' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) console.error(proc.stderr.toString());
  expect(proc.exitCode).toBe(0);
  // The tmux window name ("rig-cli") is the [window] line — NEVER the omp
  // title — and the harness title is a SEPARATE, additional second line.
  expect(proc.stdout.toString().trim()).toBe('rig-cli\ntitle: OmpHeaderTitle');
});

test('a stray-CJK omp session title never blocks the send (guard scoped to explicit --title, harness title silently dropped)', async () => {
  // Review finding fixed alongside the point-5 change: piping the auto
  // harness title through the SAME variable the CJK/screenshot/dictionary
  // hard-fail guards scan would let content in the session's own auto-
  // generated jsonl title — never typed by the CTO, impossible for him to
  // fix — block an otherwise-clean outgoing message. "ка日eat" is the exact
  // stray-CJK fixture cjk-guard-cli.test.ts uses to prove the guard DOES
  // fire on agent-authored text; here it must NOT fire when it only exists
  // in the harness title.
  //
  // Uses `Bun.spawn` (ASYNC), not `Bun.spawnSync`: the mock Bot API below
  // runs in-process on this same thread, so a SYNC spawn would block this
  // thread's event loop and the mock could never answer the child's
  // request — a real deadlock, not a guard bug (caught while writing this
  // test). `writeFakeOmpPs` derives the omp-ancestor pid from the live
  // process's OWN ppid at `ps`-invocation time (same helper
  // cli-omp-route-notmux.test.ts uses), so no pre-baked launcher script or
  // `$$`-substitution heredoc is needed here.
  const cfgDir = mkdtempSync(join(tmpdir(), 'tg-omp-title-cjk-'));
  const { binDir } = setupOmpSession(cfgDir, 'Fix ка日eat bug');
  writeFakeOmpPs(binDir);
  const configDir = mkdtempSync(join(tmpdir(), 'tg-omp-title-cjk-cfg-'));
  writeFileSync(join(configDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');

  const received: Array<{ text: string }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/sendMessage')) {
        received.push((await req.json()) as { text: string });
        return Response.json({ ok: true, result: { message_id: 1 } });
      }
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });

  try {
    const proc = Bun.spawn(['bun', TG, 'clean message body'], {
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        HOME: cfgDir,
        TMUX: '',
        TG_CTL_CONFIG_DIR: configDir,
        TG_API_BASE: `http://127.0.0.1:${server.port}`,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (code !== 0) console.error(stderr);
    // The guard must NOT hard-fail this clean send just because the harness
    // title happens to be garbled.
    expect(code).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0].text).toContain('clean message body');
    // The harness title was DROPPED (failed the CJK guard silently) — it
    // must never leak into the sent header.
    expect(received[0].text).not.toContain('日');
    expect(received[0].text).not.toContain('ка日eat');
  } finally {
    server.stop(true);
  }
}, 15_000);
