// tests/no-telegram-desktop-launch.test.ts — tg-cli#420 regression guard.
//
// tg-cli#420: Alex reported the Telegram DESKTOP app on his Mac keeps auto-opening/stealing
// focus unprompted ("почему у меня клиент телеги на компе сейчас постоянно сам открывается?!").
// The issue's own investigation grepped tg-cli and agent-tools for anything that could
// foreground/launch an external app — `open -a Telegram`, NSWorkspace, osascript, a shelled-out
// `tg://` open — and found ZERO call sites. This test is a second, independent pass over the
// same question (re-verified against this exact tree) AND turns that negative result into a
// permanent guard: this codebase talks to the Telegram Bot API over HTTPS only, and MUST NEVER
// grow a code path that shells out to an OS app-opener or otherwise foregrounds an external
// application as a side effect of sending, receiving, or approving anything.
//
// This is a STATIC guard, not a functional test: it scans every tracked source file this repo
// ships (ts/js/mjs/cjs/py/sh under features/, the tg-ctl and tg entrypoints, scripts/) for the
// spawn/exec/AppleScript shapes that would open or foreground an external app. It passes
// trivially today (there are none) — that IS the proof; it becomes a failing test the moment
// anyone (human or agent) introduces one, closing the "never fix" trap tg-cli#420 sat in for
// over a week.
import { expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(import.meta.dir, '..');

// Tracked source files only (mirrors ci/leftover-grep's include/exclude) via `git ls-files` — no
// worktrees, no node_modules, no build output, no test fixtures.
function trackedSourceFiles(): string[] {
  const proc = Bun.spawnSync(['git', 'ls-files'], { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) throw new Error(`git ls-files failed: ${proc.stderr.toString()}`);
  return proc.stdout
    .toString()
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => /\.(ts|tsx|js|mjs|cjs|py|sh)$/.test(f))
    .filter((f) => !/(^|\/)(node_modules|dist|build|\.worktrees|tests)\//.test(f));
}

// Shapes that would open/foreground an external app as a side effect: the macOS/Linux app
// openers (`open`, `xdg-open`) invoked as a spawned command, NSWorkspace (the native opener API —
// not reachable from this TS/Bun/Python codebase today, banned outright if it ever shows up), and
// `osascript` driving an app's `activate` / `open location` (the AppleScript equivalents of the
// same side effect). Deliberately NOT matching the bare English word "open" — it appears all over
// this codebase for unrelated things (`on_error: 'open'`, GitHub/Forgejo issue state, `openExternal`-
// less doc prose) — only actual invocation shapes count as a violation.
const FORBIDDEN_PATTERNS: Array<{ name: string; re: RegExp }> = [
  {
    name: 'spawn-os-opener',
    re: /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*\[\s*['"`](?:\/usr\/bin\/)?(?:open|xdg-open)['"`]/,
  },
  { name: 'shell-string-opener', re: /(?:\$`|exec\(['"`]|execSync\(['"`])\s*(?:\/usr\/bin\/)?(?:open|xdg-open)\b/ },
  { name: 'nsworkspace', re: /NSWorkspace/ },
  { name: 'osascript-activate', re: /osascript[\s\S]{0,120}(?:\bactivate\b|open location)/i },
];

test('no tracked source file spawns an OS app-opener or foregrounds an external app (tg-cli#420 guard)', () => {
  const violations: string[] = [];
  for (const file of trackedSourceFiles()) {
    const content = readFileSync(join(REPO_ROOT, file), 'utf8');
    for (const { name, re } of FORBIDDEN_PATTERNS) {
      if (re.test(content)) violations.push(`${file}: ${name}`);
    }
  }
  expect(violations).toEqual([]);
});

test('every tg:// literal in source is documented markup, never handed to a spawn/opener (tg-cli#420)', () => {
  // tg:// literals DO legitimately appear: features/render/rich.ts emits them as HTML markup
  // (`tg://user?id=…`, `tg://emoji?id=…`) for Telegram's OWN client apps to interpret when a
  // user taps a rendered message — that is data written into an outbound message body, never
  // opened/spawned by our own code (already covered by FORBIDDEN_PATTERNS above regardless of
  // this allowlist). This lookup locks the current, audited set of tg://-referencing files so a
  // NEW one is a deliberate, reviewed addition — not a silent slip only a re-run of the
  // tg-cli#420 investigation would catch.
  const KNOWN_TG_SCHEME_FILES: Record<string, true> = { 'features/render/rich.ts': true };
  const proc = Bun.spawnSync(['git', 'grep', '-lF', 'tg://', '--', '*.ts', '*.tsx', '*.js', '*.py'], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // exit code 1 = grep found nothing, which is a valid (if unexpected) outcome, not an error.
  if (proc.exitCode !== 0 && proc.exitCode !== 1) throw new Error(`git grep failed: ${proc.stderr.toString()}`);
  const files = proc.stdout
    .toString()
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => !f.startsWith('tests/') && !/(^|\/)(node_modules|dist|build|\.worktrees)\//.test(f));
  const unexpected = files.filter((f) => !KNOWN_TG_SCHEME_FILES[f]);
  expect(unexpected).toEqual([]);
});
