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
  // The `tg`/`tg-ctl` entrypoints are extensionless (`#!/usr/bin/env bun` shebang scripts, no
  // `.ts` suffix) and do virtually all of this repo's real process spawning — they must be in
  // the corpus by name, not just by extension, or the guard's own header claim of covering them
  // (line 14) would be false.
  const ENTRYPOINT_FILES: Record<string, true> = { tg: true, 'tg-ctl': true };
  return proc.stdout
    .toString()
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => /\.(ts|tsx|js|mjs|cjs|py|sh)$/.test(f) || ENTRYPOINT_FILES[f])
    .filter((f) => !/(^|\/)(node_modules|dist|build|\.worktrees|tests)\//.test(f));
}

// Shapes that would open/foreground an external app as a side effect: the macOS/Linux app
// openers (`open`, `xdg-open`) invoked as a spawned command (array-argv `spawn`/`execFile`, a
// bare positional string first arg to `spawn`/`spawnSync`/`execFile`/`execFileSync`, or wrapped
// in a `['sh'|'bash', '-c', …]` shell-wrapper argv — the idiom this repo's own
// `features/install-skill/install.ts` already uses for unrelated commands), the same openers
// invoked from Python (`subprocess.run/call/Popen/check_call/check_output` — list argv, string
// argv, or `os.popen` —, `os.system` — including an `f`/`r`/`b`-prefixed string —,
// `os.startfile`), a bare shell command word (optionally preceded by `sudo`/`nohup`/`env`/
// `command`/`timeout <n>`) with no wrapper at all, NSWorkspace (the native opener API — not
// reachable from this TS/Bun/Python codebase today, banned outright if it ever shows up), and
// `osascript` driving an app's `activate` / `open location` (the AppleScript equivalents of the
// same side effect). Every pattern below has a designated known-bad snippet enforced by name in
// the self-test below it, so this list can't silently rot into matching nothing.
// Deliberately NOT matching the bare English word "open" as an identifier/string-literal token —
// it appears all over this codebase for unrelated things (`on_error: 'open'`, GitHub/Forgejo
// issue state, `openExternal`-less doc prose) — only actual invocation shapes count as a
// violation. `bare-shell-opener` is additionally restricted (via `extensions`) to `.sh` files
// only — its command-word anchor (start of line, or right after `;`/`&&`/`|`) is intentionally
// loose to catch an unwrapped shell one-liner, and a `.sh`-only scope keeps that looseness from
// ever being able to false-positive on a `.ts`/`.py` comment, doc string, or table-shaped prose
// elsewhere in the tree. This remains a STATIC textual guard, not a shell parser: it cannot
// distinguish a real command separator from the same punctuation inside a quoted string or
// comment, and it cannot enumerate every possible wrapper (`env -S`, a custom launcher script,
// etc.) — it raises the bar against the specific shapes tg-cli#420's own investigation named,
// it does not prove their absence in general.
const FORBIDDEN_PATTERNS: Array<{ name: string; re: RegExp; extensions?: string[] }> = [
  {
    name: 'spawn-array-opener',
    re: /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*\[\s*['"`](?:\/usr\/bin\/)?(?:open|xdg-open)['"`]/,
  },
  {
    name: 'positional-string-opener',
    re: /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*['"`](?:\/usr\/bin\/)?(?:open|xdg-open)['"`]/,
  },
  {
    // Window is same-line only (`[^\n]`, not `[\s\S]`) — real `sh -c '…'`/array-wrapper call sites
    // in this repo are single-line, and a cross-newline window would let an unrelated comment or
    // statement on a FOLLOWING line (which just happens to contain the bare word "open") trip a
    // violation attributed to an unrelated preceding line — a real, undiagnosable false-positive
    // class given this repo's own `sh -c '` string-literal idiom (see `sh-c-string-opener` below).
    name: 'sh-wrapper-opener',
    re: /\[\s*['"`](?:\/(?:usr\/)?bin\/)?(?:ba|z|da|k)?sh['"`]\s*,\s*['"`]-c['"`][^\n]{0,160}?(?<![\w-])(?:open|xdg-open)(?![\w-])/,
  },
  {
    // The same `sh -c '…open…'` wrapper, but as a POSITIONAL argv0 (`spawn('sh', ['-c', …])`)
    // instead of a single array literal — a distinct call shape `sh-wrapper-opener` cannot see,
    // since that pattern requires `[` immediately after the shell name's quote.
    name: 'sh-wrapper-positional-opener',
    re: /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*['"`](?:\/(?:usr\/)?bin\/)?(?:ba|z|da|k)?sh['"`]\s*,\s*\[[^\n]{0,160}?(?<![\w-])(?:open|xdg-open)(?![\w-])/,
  },
  {
    // `exec(`/`execSync(`/`` $` ``-prefixed calls directly followed by the opener.
    name: 'shell-string-opener',
    re: /(?:\$`|exec\(['"`]|execSync\(['"`])\s*(?:\/usr\/bin\/)?(?:open|xdg-open)\b/,
  },
  {
    // The string-composed `sh -c "…open…"` idiom — no array, no exec-call prefix required, since
    // `sh -c` is inherently a shell invocation regardless of what JS/TS function passed it in. A
    // separate, self-test-pinned pattern (not folded into `shell-string-opener` above) so this
    // alternative can't silently stop matching without its own positive control catching it. The
    // leading `\b` is required: without it, an unanchored `(?:ba)?sh` matches the trailing "sh" of
    // any longer word (e.g. "publish -c" contains "sh -c"), a real forward-looking false-positive
    // risk pinned by the benign-snippet negative control below.
    name: 'sh-c-string-opener',
    re: /\b(?:ba|z|da|k)?sh\s+-c\s+['"`][^\n]{0,80}?(?<![\w-])(?:open|xdg-open)(?![\w-])/,
  },
  {
    name: 'python-subprocess-opener',
    re: /\bsubprocess\.(?:run|call|Popen|check_call|check_output)\s*\(\s*\[[^\]]{0,80}?['"](?:\/usr\/bin\/)?(?:open|xdg-open)['"]/,
  },
  {
    name: 'python-subprocess-string-opener',
    re: /\bsubprocess\.(?:run|call|Popen|check_call|check_output)\s*\(\s*[fFrRbB]{0,2}['"](?:\/usr\/bin\/)?(?:open|xdg-open)\b/,
  },
  { name: 'python-os-system-opener', re: /\bos\.(?:system|popen)\s*\(\s*[fFrRbB]{0,2}['"`][^'"`]*\b(?:open|xdg-open)\b/ },
  { name: 'python-os-startfile', re: /\bos\.startfile\s*\(/ },
  {
    name: 'bare-shell-opener',
    re: /(^|[;&|])\s*(?:sudo|nohup|env|command|timeout\s+\S+)?\s*(?:\/usr\/bin\/)?(?:open|xdg-open)(?=[\s;&|]|$)/m,
    extensions: ['sh'],
  },
  { name: 'nsworkspace', re: /NSWorkspace/ },
  { name: 'osascript-activate', re: /osascript[\s\S]{0,120}(?:\bactivate\b|open location)/i },
];

// Pure per-file matcher extracted so the extension-gate mechanism (the `.sh`-only restriction on
// `bare-shell-opener`) is itself directly unit-testable below, not only exercised incidentally by
// scanning the real tree.
function violationsForFile(file: string, content: string): string[] {
  const hits: string[] = [];
  for (const { name, re, extensions } of FORBIDDEN_PATTERNS) {
    if (extensions && !extensions.some((ext) => file.endsWith(`.${ext}`))) continue;
    if (re.test(content)) hits.push(name);
  }
  return hits;
}

test('no tracked source file spawns an OS app-opener or foregrounds an external app (tg-cli#420 guard)', () => {
  const files = trackedSourceFiles();
  // Pins the corpus itself, not just the scan result: if a future exclusion-regex change (or an
  // empty `git ls-files` in some CI context) ever made `trackedSourceFiles()` return nothing, the
  // violations check below would vacuously pass (`expect([]).toEqual([])`) while proving nothing.
  expect(files.length).toBeGreaterThan(50);
  // Pins the diff's own stated purpose directly: a future rename/drop of `ENTRYPOINT_FILES` (or
  // of the entrypoints themselves) would still clear the size floor above (features/ alone has
  // 100+ files) while silently dropping the two files most likely to actually spawn an opener.
  expect(files).toContain('tg');
  expect(files).toContain('tg-ctl');
  const violations: string[] = [];
  for (const file of files) {
    const content = readFileSync(join(REPO_ROOT, file), 'utf8');
    for (const name of violationsForFile(file, content)) violations.push(`${file}: ${name}`);
  }
  expect(violations).toEqual([]);
});

test('the .sh-only extension gate on bare-shell-opener actually gates (self-test)', () => {
  // Direct unit test of the `extensions` filter itself: the SAME bare command-word text is a
  // violation in a `.sh` file and a non-issue in a `.ts`/`.py` file, so the gate's on/off
  // behavior is pinned independently of what happens to exist in the real tree today.
  const badShellLine = 'open -a Telegram\n';
  expect(violationsForFile('scripts/launch.sh', badShellLine)).toContain('bare-shell-opener');
  expect(violationsForFile('features/render/notes.ts', badShellLine)).not.toContain('bare-shell-opener');
  expect(violationsForFile('scripts/build.py', badShellLine)).not.toContain('bare-shell-opener');
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

test('the detector patterns actually match known-bad snippets (self-test)', () => {
  // Positive control keyed BY PATTERN NAME (not a loose snippet list) so the invariant is
  // enforced structurally in both directions: every entry in FORBIDDEN_PATTERNS must have a
  // designated bad snippet, that pattern's OWN regex must match it, AND every snippet here must
  // still name a live pattern — a stale snippet left behind after a pattern is renamed or
  // removed is caught rather than silently passing forever.
  const KNOWN_BAD_SNIPPETS: Record<string, string> = {
    'spawn-array-opener': `Bun.spawnSync(['open', '-a', 'Telegram']);`,
    'positional-string-opener': `spawn('open', ['-a', 'Telegram']);`,
    'sh-wrapper-opener': `Bun.spawnSync(['sh', '-c', 'open -a Telegram']);`,
    'sh-wrapper-positional-opener': `spawn('sh', ['-c', 'open -a Telegram']);`,
    'shell-string-opener': `execSync('open -a Telegram');`,
    'sh-c-string-opener': `exec('sh -c "open -a Telegram"');`,
    'python-subprocess-opener': `subprocess.run(['open', '-a', 'Telegram'])`,
    'python-subprocess-string-opener': `subprocess.run("open -a Telegram", shell=True)`,
    'python-os-system-opener': `os.system(f'open -a {app}')`,
    'python-os-startfile': `os.startfile('C:\\\\Telegram\\\\Telegram.exe')`,
    'bare-shell-opener': `#!/bin/sh\nsudo open -a Telegram\n`,
    nsworkspace: `NSWorkspace.shared.open(url)`,
    'osascript-activate': `osascript -e 'tell application "Telegram" to activate'`,
  };
  const missingSnippet: string[] = [];
  const patternMissesOwnSnippet: string[] = [];
  for (const { name, re } of FORBIDDEN_PATTERNS) {
    const snippet = KNOWN_BAD_SNIPPETS[name];
    if (snippet === undefined) {
      missingSnippet.push(name);
      continue;
    }
    if (!re.test(snippet)) patternMissesOwnSnippet.push(name);
  }
  const orphanedSnippets = Object.keys(KNOWN_BAD_SNIPPETS).filter(
    (name) => !FORBIDDEN_PATTERNS.some((p) => p.name === name),
  );
  expect(missingSnippet).toEqual([]);
  expect(patternMissesOwnSnippet).toEqual([]);
  expect(orphanedSnippets).toEqual([]);
});

test('benign real-tree idioms never trip the detectors (negative control)', () => {
  // Mirror image of the positive-control self-test above: pins that ordinary, unrelated uses of
  // the bare word "open" (a config value, a Python builtin/PIL method, an object-literal key, and
  // the repo's own real `['sh', '-c', …]` non-opener call site verbatim) stay clean. Without this,
  // a future widening of any pattern is checked for false positives only against whatever happens
  // to exist in the tree today — which silently stops testing the exact idiom it broke once that
  // idiom is edited or removed from the real tree.
  const KNOWN_BENIGN_SNIPPETS: Record<string, string> = {
    'yaml-config-value': `on_error: 'open'`,
    'python-image-open': `img = Image.open(path)`,
    'python-builtin-open': `with open(path) as f:`,
    'js-object-literal-key': `const opts = { open: true };`,
    'python-subprocess-non-opener-argv': `subprocess.run(["rsvg-convert", "-o", out])`,
    // Forward-looking false-positive risk for `sh-c-string-opener`'s unanchored shell-name
    // match: "publish" ends in the letters "sh", so an unanchored regex could mistake
    // `publish -c` for a `(?:ba)?sh -c` shell invocation.
    'shell-name-word-boundary': `// run \`npm publish -c\` then open the changelog`,
    // features/install-skill/install.ts:291 verbatim — the repo's own real `sh -c` wrapper call,
    // which must stay clean since it is not an opener.
    'real-sh-wrapper-non-opener': `const probe = Bun.spawnSync(['sh', '-c', \`command -v \${cmd}\`], { stdout: 'ignore', stderr: 'ignore' });`,
  };
  for (const [label, snippet] of Object.entries(KNOWN_BENIGN_SNIPPETS)) {
    expect(violationsForFile(`features/example-${label}.ts`, snippet)).toEqual([]);
  }
});
