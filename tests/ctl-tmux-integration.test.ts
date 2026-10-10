import { afterAll, expect, test } from 'bun:test';
import { existsSync, rmSync, statSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { buildKeyInjectPlan, buildTextInjectPlan } from '../features/tg-ctl/inject';
import { messageStillTyped } from '../features/tg-ctl/input-box';
import { permissionMenuUnchanged } from '../features/tg-ctl/permission-menu';
import type { AgentKind, InjectStep } from '../features/tg-ctl/types';
import { tempDir } from './helpers/test-temp';

// Real-tmux integration (spec §11): InjectStep plans executed against a live
// tmux pane running a readline stub. Everything runs on a THROWAWAY socket
// (-L tgctl-test-<pid>) so the user's real tmux server is never touched; the
// §2 capture-pane ban applies to the production round-trip only — tests may
// use it for assertions.

const SOCKET = `tgctl-test-${process.pid}`;

// The on-disk path tmux uses for a `-L <label>` server: `$TMUX_TMPDIR | /tmp`
// + `/tmux-<uid>/<label>`. `kill-server` ends the server PROCESS but on macOS
// does NOT unlink this socket file — that gap leaked ~185 `tgctl-test-*` /
// `rigtest-*` sockets into /tmp/tmux-501/ and once starved the dev's tmux
// server. afterAll unlinks it explicitly.
//
// This MUST mirror tmux's own candidate selection or afterAll deletes the wrong
// path and the leak persists. Verified against tmux 3.5a (make_label): the base
// is `$TMUX_TMPDIR` when set, ELSE `/tmp`. tmux does NOT require it to be
// absolute — a RELATIVE TMUX_TMPDIR is resolved against cwd and honored (a
// `tgctl-test-*` socket really lands there). It only falls back to `/tmp` when
// the chosen directory is unusable (e.g. an absolute but MISSING TMUX_TMPDIR:
// tmux can't create `tmux-<uid>` under a missing parent, so it uses /tmp).
//
// We deliberately make the path absolute (resolve) but do NOT realpath it: tmux
// builds the socket path from TMUX_TMPDIR as given, so canonicalizing symlinks
// here would diverge from where tmux actually creates the socket (e.g. a
// symlinked TMUX_TMPDIR) and afterAll would unlink the wrong path. statSync
// follows the symlink for the existence/dir check without rewriting the path.
function tmuxTmpBase(): string {
  const raw = (process.env.TMUX_TMPDIR || '').trim();
  if (!raw) return '/tmp';
  // Resolve relative paths against cwd (tmux honors a relative TMUX_TMPDIR);
  // keep the path otherwise as-given so it matches tmux's own socket location.
  const resolved = resolve(raw);
  try {
    return statSync(resolved).isDirectory() ? resolved : '/tmp';
  } catch {
    return '/tmp'; // missing / unreadable TMUX_TMPDIR → tmux uses /tmp
  }
}

function socketPathFor(label: string): string {
  return join(tmuxTmpBase(), `tmux-${process.getuid?.() ?? 0}`, label);
}

const SOCKET_PATH = socketPathFor(SOCKET);

// Env without TMUX: tmux refuses new-session from inside another tmux
// ("sessions should be nested with care") even on a different socket.
const tmuxEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (k !== 'TMUX' && v !== undefined) tmuxEnv[k] = v;
}

let tmuxAvailable = false;
try {
  tmuxAvailable = Bun.spawnSync(['tmux', '-V'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
} catch {
  // no tmux binary at all
}

function tmux(args: string[], stdin?: string): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(['tmux', '-L', SOCKET, ...args], {
    stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : undefined,
    stdout: 'pipe',
    stderr: 'pipe',
    env: tmuxEnv,
  });
  return { exitCode: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

// Same executor shape as tg-ctl's (module-private) executeInjectSteps, with
// three test-bench substitutions: the throwaway -L socket is spliced into every
// argv, verify-pane checks pane existence on that socket (the real one
// requires an agent process, which the stub deliberately is not), and the
// submit-check's agent is given (the real one is what verify-pane found).
async function executeSteps(steps: InjectStep[], agent: AgentKind = 'claude'): Promise<'delivered' | 'unsubmitted'> {
  for (const step of steps) {
    if (step.kind === 'verify-pane') {
      const list = tmux(['list-panes', '-a', '-F', '#{pane_id}']);
      expect(list.stdout.split('\n')).toContain(step.paneId);
    } else if (step.kind === 'verify-permission-menu') {
      // tg-ctl's verify-permission-menu: same `capture-pane -p -J` read, same pure check.
      expect(permissionMenuUnchanged(tmux(['capture-pane', '-p', '-J', '-t', step.paneId]).stdout, step.target)).toBe(true);
    } else if (step.kind === 'submit-check') {
      // tg-ctl's submitCheckStep: same `capture-pane -p -J` read, same adapter call.
      const typed = messageStillTyped(agent, tmux(['capture-pane', '-p', '-J', '-t', step.paneId]).stdout, step.text);
      if (!typed) return 'delivered';
      if (step.final) return 'unsubmitted';
    } else if (step.kind === 'tmux') {
      expect(step.argv[0]).toBe('tmux'); // plans must target tmux, nothing else
      const r = tmux(step.argv.slice(1), step.stdin);
      if (r.exitCode !== 0) {
        throw new Error(`${step.argv.join(' ')} failed (${r.exitCode}): ${r.stderr.trim()}`);
      }
    } else {
      await Bun.sleep(step.ms);
    }
  }
  return 'delivered';
}

// The "agent": prints READY, then echoes GOT:<line> per submitted line. Echoed
// keystrokes never start with "GOT:", so GOT-lines count submissions exactly.
const stubDir = tempDir('tgctl-tmux-');
const stubPath = join(stubDir, 'stub.ts');
writeFileSync(stubPath, "console.log('READY');\nfor await (const line of console) console.log(`GOT:${line}`);\n");

function capture(paneId: string): string {
  return tmux(['capture-pane', '-p', '-t', paneId]).stdout;
}

async function waitForCapture(
  paneId: string,
  pred: (out: string) => boolean,
  timeoutMs = 5000,
): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const out = capture(paneId);
    if (pred(out)) return out;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`capture-pane condition not met in ${timeoutMs}ms; last capture:\n${out}`);
    }
    await Bun.sleep(100);
  }
}

const gotLines = (out: string): string[] => out.split('\n').filter((l) => l.startsWith('GOT:'));

// One session per test: a leftover ESC byte or pending line buffer in a shared
// pane would leak between tests. kill-server reaps them all.
async function newStubPane(name: string, script = stubPath, arg = ''): Promise<string> {
  const r = tmux([
    'new-session', '-d', '-P', '-F', '#{pane_id}',
    '-s', name, '-x', '80', '-y', '24',
    `"${process.execPath}" "${script}" ${arg}`,
  ]);
  expect(r.exitCode).toBe(0);
  const paneId = r.stdout.trim();
  await waitForCapture(paneId, (out) => out.includes('READY'));
  return paneId;
}

afterAll(() => {
  // Kill the throwaway server AND unlink its socket file. kill-server ends the
  // process but leaks the socket inode on macOS — unlink it so nothing piles up
  // under /tmp/tmux-<uid>/. Both steps best-effort: a server that never started
  // still needs the (possibly absent) socket file cleaned, and rmSync must not
  // throw on a missing path.
  if (tmuxAvailable) tmux(['kill-server']); // throwaway socket only
  rmSync(SOCKET_PATH, { force: true });
});

test.skipIf(!tmuxAvailable)('single-line plan lands as exactly one submission', async () => {
  const paneId = await newStubPane('single');
  await executeSteps(buildTextInjectPlan(paneId, 'hello from telegram'));
  const out = await waitForCapture(paneId, (o) => o.includes('GOT:hello from telegram'));
  expect(gotLines(out)).toEqual(['GOT:hello from telegram']);
}, 15_000);

test.skipIf(!tmuxAvailable)('3-line plan arrives complete via buffer paste + single Enter', async () => {
  const paneId = await newStubPane('multi');
  await executeSteps(buildTextInjectPlan(paneId, 'alpha\nbeta\ngamma'));
  // The last line has no trailing newline in the paste — it can only have been
  // submitted by the plan's single separate Enter. Substring matching, not
  // line-anchored: the tty echo of the pasted "gamma" leaves the cursor
  // mid-line, so the stub's first output can land glued to it
  // ("gammaGOT:alpha"). The pasted text itself never contains "GOT:", so
  // counting the marker still counts submissions exactly.
  await waitForCapture(paneId, (o) =>
    ['GOT:alpha', 'GOT:beta', 'GOT:gamma'].every((l) => o.includes(l)),
  );
  await Bun.sleep(250); // settle — a late duplicate submission must not escape the count
  const out = capture(paneId);
  expect(out.split('GOT:')).toHaveLength(4); // exactly 3 markers
}, 15_000);

test.skipIf(!tmuxAvailable)('Escape verb produces no submission', async () => {
  const paneId = await newStubPane('escape');
  await executeSteps(buildKeyInjectPlan(paneId, 'Escape'));
  await Bun.sleep(400); // give a wrong submission time to surface
  expect(gotLines(capture(paneId))).toEqual([]);
}, 15_000);

// tg-cli#463 fixture pane: a TUI drawn like Claude Code 2.1 (transcript, then a
// `───` rule, `❯ <input>`, a rule, a footer) that LOSES its first `argv[2]` Enters,
// as a busy TUI does. A submitted input is echoed into the transcript as `❯ <text>`
// (the harness echo the input-box adapter must not mistake for the box) plus a
// GOT:<text> marker; the footer counts every Enter the pane received.
const boxStubPath = join(stubDir, 'box-stub.ts');
writeFileSync(
  boxStubPath,
  `let drops = Number(process.argv[2] ?? 0);
let enters = 0;
let input = '';
let pending = '';
let inPaste = false;
const transcript = ['READY'];
const render = () => {
  const rule = '─'.repeat(process.stdout.columns || 80);
  const box = input.split('\\n').map((l, i) => (i === 0 ? '❯ ' : '  ') + l);
  process.stdout.write('\\x1b[2J\\x1b[H' + [...transcript, '', rule, ...box, rule, '  ENTERS:' + enters].join('\\r\\n'));
};
process.stdin.setRawMode(true);
process.stdout.write('\\x1b[?2004h'); // bracketed paste on, like the real TUIs
process.stdin.on('data', (chunk) => {
  pending += chunk.toString('utf8');
  while (pending.length > 0) {
    if (pending.startsWith('\\x1b[200~')) { inPaste = true; pending = pending.slice(6); continue; }
    if (pending.startsWith('\\x1b[201~')) { inPaste = false; pending = pending.slice(6); continue; }
    if (pending[0] === '\\x1b' && pending.length < 6) break; // a split paste marker: wait
    const ch = pending[0];
    pending = pending.slice(1);
    if (ch === '\\x03') process.exit(0);
    if (ch !== '\\r' && ch !== '\\n') { input += ch; continue; }
    if (inPaste) { input += '\\n'; continue; }
    enters++;
    if (drops > 0) { drops--; continue; }
    transcript.push('❯ ' + input.replace(/\\n/g, ' '), 'GOT:' + input.replace(/\\n/g, '|'));
    input = '';
  }
  render();
});
render();
`,
);
const entersSeen = (out: string): number => Number(/ENTERS:(\d+)/.exec(out)?.[1] ?? -1);

test.skipIf(!tmuxAvailable)('submit check: a delivered message gets no second Enter', async () => {
  const paneId = await newStubPane('box-ok', boxStubPath, '0');
  expect(await executeSteps(buildTextInjectPlan(paneId, '[TG from Alex tg#1] deploy now'))).toBe('delivered');
  const out = capture(paneId);
  expect(gotLines(out)).toEqual(['GOT:[TG from Alex tg#1] deploy now']);
  expect(entersSeen(out)).toBe(1);
}, 15_000);

test.skipIf(!tmuxAvailable)('submit check: a lost Enter is retried once and the message lands once', async () => {
  const paneId = await newStubPane('box-retry', boxStubPath, '1');
  expect(await executeSteps(buildTextInjectPlan(paneId, '[TG from Alex tg#2] deploy now'))).toBe('delivered');
  const out = capture(paneId);
  expect(gotLines(out)).toEqual(['GOT:[TG from Alex tg#2] deploy now']);
  expect(entersSeen(out)).toBe(2);
}, 15_000);

test.skipIf(!tmuxAvailable)('submit check: a multi-line paste whose Enter was lost is retried and lands whole', async () => {
  const paneId = await newStubPane('box-multi', boxStubPath, '1');
  expect(await executeSteps(buildTextInjectPlan(paneId, '[TG from Alex tg#3] alpha\nbeta\ngamma'))).toBe('delivered');
  const out = capture(paneId);
  expect(gotLines(out)).toEqual(['GOT:[TG from Alex tg#3] alpha|beta|gamma']);
  expect(entersSeen(out)).toBe(2);
}, 15_000);

test.skipIf(!tmuxAvailable)('submit check: still typed after the retry Enter → reported unsubmitted, never a third Enter', async () => {
  const paneId = await newStubPane('box-stuck', boxStubPath, '99');
  expect(await executeSteps(buildTextInjectPlan(paneId, '[TG from Alex tg#4] deploy now'))).toBe('unsubmitted');
  const out = capture(paneId);
  expect(gotLines(out)).toEqual([]);
  expect(out).toContain('❯ [TG from Alex tg#4] deploy now');
  expect(entersSeen(out)).toBe(2);
}, 15_000);

// REGRESSION: a throwaway `-L` server must leave NO socket file behind after
// teardown. `kill-server` alone leaks the socket inode on macOS; ~185 of those
// accumulated in /tmp/tmux-501/ and once starved the dev's tmux server. This
// drives the SAME kill+unlink the afterAll uses, on its own socket, and asserts
// the file is gone (not just the process).
test.skipIf(!tmuxAvailable)('teardown leaves no leaked tmux socket file', () => {
  const leakSocket = `tgctl-test-leakcheck-${process.pid}`;
  const leakPath = socketPathFor(leakSocket);
  const t = (args: string[]) =>
    Bun.spawnSync(['tmux', '-L', leakSocket, ...args], {
      stdout: 'ignore',
      stderr: 'ignore',
      env: tmuxEnv,
    });
  try {
    expect(t(['new-session', '-d', '-s', 'probe', 'tail -f /dev/null']).exitCode).toBe(0);
    expect(existsSync(leakPath)).toBe(true); // server created its socket

    // the exact teardown the afterAll performs
    t(['kill-server']);
    rmSync(leakPath, { force: true });

    expect(existsSync(leakPath)).toBe(false); // the leak this fixes
  } finally {
    t(['kill-server']);
    rmSync(leakPath, { force: true });
  }
});
