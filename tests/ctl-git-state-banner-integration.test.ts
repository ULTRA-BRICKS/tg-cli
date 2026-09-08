import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BANNER_ADVICE } from '../features/tg-ctl/git-state';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';

// End-to-end verification of the git-state-check banner (features/tg-ctl/git-state.ts):
// the REAL `tg-ctl run` daemon, against a fake Telegram + a fake tmux/ps that report ONE
// live agent pane whose cwd is a REAL git fixture directory (real `git` runs against it —
// only tmux/ps are shimmed). A plain, non-reply inbound message auto-binds to that pane
// (the exact HYP-915 shape), so the injected text is asserted to carry the banner when the
// fixture is mid-flight (uncommitted changes / non-main branch) and to be byte-identical to
// the plain wrap when the fixture is clean-on-main or not a git repo at all.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const PANE_ID = '%2';
const PANE_PID = 2002;

const reg = createDaemonRegistry();
const servers: Array<{ stop: (closeActiveConnections?: boolean) => void }> = [];

afterAll(async () => {
  await reapDaemons(reg);
  for (const s of servers.splice(0)) s.stop(true);
});

function gitFixture(kind: 'dirty-feature-branch' | 'clean-main' | 'not-a-repo'): string {
  const dir = mkdtempSync(join(tmpdir(), `tgctl-gitstate-${kind}-`));
  if (kind === 'not-a-repo') return dir;

  const git = (...args: string[]): void => {
    // -c core.hooksPath=/dev/null: this dev machine wires a GLOBAL pre-commit review gate
    // (core.hooksPath) into every repo; it has nothing to do with this disposable git-state
    // FIXTURE (not real reviewable content), so neutralize it for just this invocation rather
    // than reach for --no-verify (which would also suppress any real hook the fixture SHOULD run).
    const r = Bun.spawnSync(['git', '-C', dir, '-c', 'core.hooksPath=/dev/null', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.toString()}`);
  };
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.com');
  git('config', 'user.name', 'Fixture');
  writeFileSync(join(dir, 'committed.txt'), 'v1\n');
  git('add', 'committed.txt');
  git('commit', '-q', '-m', 'initial');
  git('checkout', '-q', '-B', 'main'); // pin a deterministic branch name regardless of git's init.defaultBranch

  if (kind === 'dirty-feature-branch') {
    git('checkout', '-q', '-B', 'feat/uncommitted-fixture');
    writeFileSync(join(dir, 'wip.txt'), 'work in progress\n'); // untracked → uncommittedCount > 0
  }
  // 'clean-main': stays on main, nothing further written → `git status --porcelain` is empty.
  return dir;
}

// tmux/ps PATH shim: ONE live agent pane at `%2` (pid 2002, cwd = the fixture dir). Every
// `send-keys -l` (single-line) and every multi-line `load-buffer -`/`paste-buffer` pair is
// logged so the test can read back the EXACT text the daemon injected.
function writeShim(shimDir: string, injectLog: string, bufferLog: string, cwd: string): void {
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(
    join(shimDir, 'tmux'),
    `#!/bin/sh
sub="$1"; shift
case "$sub" in
  list-panes)
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '${PANE_ID}' '${PANE_PID}' 'claude' 'w' '${cwd}'
    ;;
  send-keys)
    pane=""; text=""; is_enter=0
    while [ $# -gt 0 ]; do
      if [ "$1" = "-t" ]; then pane="$2"; fi
      if [ "$1" = "-l" ]; then text="$2"; fi
      if [ "$1" = "Enter" ]; then is_enter=1; fi
      shift
    done
    if [ "$is_enter" = "0" ] && [ -n "$pane" ]; then printf '%s\\t%s\\n' "$pane" "$text" >> '${injectLog}'; fi
    ;;
  load-buffer)
    cat > '${bufferLog}'
    ;;
  paste-buffer)
    pane=""
    while [ $# -gt 0 ]; do if [ "$1" = "-t" ]; then pane="$2"; fi; shift; done
    if [ -n "$pane" ]; then printf '%s\\tPASTE\\n' "$pane" >> '${injectLog}'; fi
    ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(join(shimDir, 'ps'), `#!/bin/sh\nprintf '%s %s %s\\n' '${PANE_PID}' '1' 'claude'\nexit 0\n`, {
    mode: 0o755,
  });
}

// Runs one full daemon round-trip delivered to the ONE live pane rooted at `fixtureDir`.
// In `auto` mode it sends `text` directly; in `selected` mode it first sends bare
// `/agent`, taps the picker, then sends `text`. Returns the exact text the daemon
// injected (the multi-line `load-buffer` payload when a banner was prepended, else
// the plain wrap/passthrough).
async function injectedTextFor(fixtureDir: string, text = 'fix the other thing', mode: 'auto' | 'selected' = 'auto'): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-gitstate-cfg-'));
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');

  const shimDir = join(cfgDir, 'bin');
  const injectLog = join(cfgDir, 'inject.log');
  const bufferLog = join(cfgDir, 'buffer.log');
  writeFileSync(injectLog, '');
  writeFileSync(bufferLog, '');
  writeShim(shimDir, injectLog, bufferLog, fixtureDir);

  const sent: Array<{ chat_id: number; text: string; reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } }> = [];
  let pickerCallbackData: string | null = null;
  let pickerMessageId: number | null = null;
  let callbackServed = false;
  let selectedTextServed = false;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/setMyCommands')) {
        await req.json();
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/getUpdates')) {
        const offset = Number(url.searchParams.get('offset') ?? '0');
        if (mode === 'auto' && offset === 0) {
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 500,
                message: { message_id: 1, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text },
              },
            ],
          });
        }
        if (mode === 'selected' && offset <= 500 && sent.length === 0) {
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 500,
                message: { message_id: 1, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text: '/agent' },
              },
            ],
          });
        }
        if (mode === 'selected' && offset <= 501 && pickerCallbackData && pickerMessageId !== null && !callbackServed) {
          callbackServed = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 501,
                callback_query: {
                  id: 'cb-selected',
                  from: { id: 1, first_name: 'Alex' },
                  message: { message_id: pickerMessageId, chat: { id: 1 }, date: nowSec },
                  data: pickerCallbackData,
                },
              },
            ],
          });
        }
        if (mode === 'selected' && offset <= 502 && callbackServed && !selectedTextServed) {
          selectedTextServed = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 502,
                message: { message_id: 2, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text },
              },
            ],
          });
        }
        await Bun.sleep(1500);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = (await req.json()) as { chat_id: number; text: string; reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } };
        sent.push(body);
        const firstButton = body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
        if (firstButton) {
          pickerCallbackData = firstButton;
          pickerMessageId = 100 + sent.length;
        }
        return Response.json({ ok: true, result: { message_id: 100 + sent.length } });
      }
      if (url.pathname.endsWith('/answerCallbackQuery') || url.pathname.endsWith('/editMessageText')) {
        await req.json();
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/setMessageReaction')) {
        await req.json();
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  servers.push(server);

  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: {
      PATH: `${shimDir}:${process.env.PATH ?? ''}`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
    },
  });

  const t0 = Date.now();
  while (Date.now() - t0 < 10_000) {
    if (existsSync(injectLog) && readFileSync(injectLog, 'utf8').trim() !== '') break;
    await Bun.sleep(100);
  }

  const log = readFileSync(injectLog, 'utf8').trim();
  const buffered = existsSync(bufferLog) ? readFileSync(bufferLog, 'utf8') : '';

  daemon.kill('SIGTERM');
  await Promise.race([daemon.exited, Bun.sleep(4000)]);

  if (mode === 'auto') {
    expect(sent).toEqual([]); // no guard/error reply — the inject was attempted, not rejected
  } else {
    expect(sent[0]?.text).toBe('Pick an agent to send message:');
  }
  // A banner adds a newline, forcing inject.ts's multi-line load-buffer/paste-buffer path; the
  // plain single-line wrap (no banner) goes through send-keys -l instead — read back whichever
  // path actually fired.
  if (log.includes(`${PANE_ID}\tPASTE`)) return buffered;
  const [loggedPane, ...rest] = log.split('\t');
  expect(loggedPane).toBe(PANE_ID);
  return rest.join('\t');
}

test('git-state banner: uncommitted changes on a feature branch → banner prepended', async () => {
  const fixture = gitFixture('dirty-feature-branch');
  const text = await injectedTextFor(fixture);
  expect(text).toContain('⚠');
  expect(text).toContain('feat/uncommitted-fixture');
  expect(text).toContain(BANNER_ADVICE);
  expect(text).toContain('[TG from Alex'); // the original wrap still follows, verbatim
  expect(text).toContain('fix the other thing');
}, 15_000);

test('git-state banner: selected /agent route also prepends banner on a dirty pane', async () => {
  const fixture = gitFixture('dirty-feature-branch');
  const text = await injectedTextFor(fixture, 'fix the selected thing', 'selected');
  expect(text).toContain('⚠');
  expect(text).toContain('feat/uncommitted-fixture');
  expect(text).toContain(BANNER_ADVICE);
  expect(text).toContain('[TG from Alex');
  expect(text).toContain('fix the selected thing');
}, 15_000);

test('git-state banner: clean checkout on main → no banner, plain wrap only', async () => {
  const fixture = gitFixture('clean-main');
  const text = await injectedTextFor(fixture);
  expect(text).not.toContain('⚠');
  expect(text.trim().startsWith('[TG from Alex')).toBe(true);
}, 15_000);

test('git-state banner: pane cwd is not a git repo → no banner', async () => {
  const fixture = gitFixture('not-a-repo');
  const text = await injectedTextFor(fixture);
  expect(text).not.toContain('⚠');
  expect(text.trim().startsWith('[TG from Alex')).toBe(true);
}, 15_000);

// Regression (review catch on PR #153): an unrecognized `/command` (e.g. `/compact`) is emitted
// as inject-text VERBATIM — no wrap — so the harness TUI can execute it as a slash command.
// Prepending the banner ahead of it would push the leading `/` off the first character, so the
// harness would read it as plain prompt text instead of a real command. Even on a DIRTY pane, a
// slash-command passthrough must reach the pane untouched, banner-free.
test('git-state banner: never prepended to a slash-command passthrough, even on a dirty pane', async () => {
  const fixture = gitFixture('dirty-feature-branch');
  const text = await injectedTextFor(fixture, '/compact keep the notes');
  expect(text).toBe('/compact keep the notes');
  expect(text).not.toContain('⚠');
  expect(text.startsWith('/')).toBe(true);
}, 15_000);

// Same invariant for a `!shell` passthrough (harness `!` convention): a message starting with `!`
// is injected VERBATIM so the harness runs it as an in-session shell command. The banner would push
// the `!` off column 0 and defeat the convention, so even on a DIRTY pane it must reach the pane
// untouched, banner-free.
test('git-state banner: never prepended to a `!shell` passthrough, even on a dirty pane', async () => {
  const fixture = gitFixture('dirty-feature-branch');
  const text = await injectedTextFor(fixture, '!git status');
  expect(text).toBe('!git status');
  expect(text).not.toContain('⚠');
  expect(text.startsWith('!')).toBe(true);
}, 15_000);

// Locks in the invariant withGitStateBanner's slash-guard depends on (review follow-up): at the
// FLAT (non-topic) level, updates.ts's textAction gates on a bare `startsWith('/')` — a path-like
// message that merely LOOKS like a command (`/etc/hosts is broken`, no recognized verb) is
// ALSO passed through verbatim, same as a real `/compact`. It is never wrapped, so it never gets
// banered — same behavior with or without this PR (updates.ts is unmodified). This is the ONLY
// way the slash-guard could ever eat a legitimate banner (if wrapping ever changed to cover this
// case), so it's pinned here rather than left as a documented-but-unverified assumption.
test('git-state banner: a path-like message (not a real command) also passes through unbannered', async () => {
  const fixture = gitFixture('dirty-feature-branch');
  const text = await injectedTextFor(fixture, '/etc/hosts is broken');
  expect(text).toBe('/etc/hosts is broken');
  expect(text).not.toContain('⚠');
}, 15_000);
