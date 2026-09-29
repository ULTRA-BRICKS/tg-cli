// install-skill: make agent harnesses aware that `tg` exists.
//
// Writes a SKILL.md (Agent Skills standard, ~/.agents/skills/) read by Claude
// Code, Codex, opencode, Gemini, Cursor; a short always-on blurb into each
// DETECTED harness's global instruction file; and an idempotent SessionStart
// hook that surfaces every installed agent-CLI at the top of each session.
//
// Mirror of the Python implementation in review-cli/draw-cli (same layout,
// markers, and hook command) so all three tools register identically.

import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { escapeRegExp } from '../util/regex';

// Read a UTF-8 file, returning undefined when it does not exist (ENOENT) and
// re-throwing any other error. Replaces an `existsSync(p) ? readFileSync(p) : …`
// pair: that check-then-read on the same path is a TOCTOU race (js/file-system-
// race) because the file can vanish or be swapped between the two syscalls. A
// single read that catches ENOENT is atomic — there is no window to race.
function readTextIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

// Prefer $HOME (what `tg` itself uses) over os.homedir(), which under Bun reads
// getpwuid and ignores $HOME — so this stays consistent and unit-testable.
function resolveHome(): string {
  return process.env.HOME || homedir();
}

const SKILL_NAME = 'tg';

const SKILL_MD = `---
name: tg
description: >-
  Send Telegram messages, files, photos, and reports from any agent or shell. Use to
  report results, push a status/question to the user's phone, or format HTML — e.g.
  \`tg "done"\`, \`tg --file out.pdf "caption"\`. Replies come back by text or VOICE
  (\`tg voice setup\`). Prefer this over direct curl to the Telegram API.
metadata:
  author: alex-mextner
  repo: https://github.com/alex-mextner/tg-cli
---

# tg — Telegram bridge for agents

Push reports and files to Telegram; the user can reply back (tmux pane, or the Stop-hook inbox for an agent outside tmux).

## Invocation
\`\`\`
tg "text message"
tg --format html "<b>Title</b>\\nbody"
tg --format html "<h2>Heading</h2><table><tr><td>a</td><td>b</td></tr></table>"  # native rich table
tg --file report.pdf "caption"
tg --photo image.png "caption"
tg --reply-to 1234 --tag answer "answer that threads under message 1234"
printf 'task\\tstatus\\nship\\tdone' | tg --table   # plain monospace <pre> fallback
tg help format                                      # what formatting is supported
\`\`\`

## When to use
- Report a finished task / status / blocker / question to the user's phone.
- Send a generated artifact (file, photo, PDF) produced during a session.
- Long or multi-step work — push a full status update, not a one-liner.
- Need a SYNCHRONOUS human decision from a harness with no native question hook:
  run \`tg-ctl ask "question"\` (optionally \`--timeout <seconds>\`). This works
  without tmux and blocks until the Telegram Approve/Reject tap arrives. Exit 0
  means approved; reject, timeout, missing daemon, or malformed response fail closed.
  Use this fallback for shell-capable harnesses such as pi/CommandCode/Aider; Claude,
  Codex, OMP and OpenCode should use their native hook/ACP/SSE adapters when available.

## Header tag + title (\`--tag\` / \`--title\`)
The message header is \`✳️ [window]\`. The message BODY always stays BELOW it —
it is never pulled up onto the header line. Two optional flags put explicit
content on the header line:

- \`--title <text>\` — an explicit headline shown as \`✳️ [window] <title>\`.
  ONLY this explicit title ever appears there; the message body is never used.
- \`--tag <tag>\` — an emoji badge labeling what the message IS. Composes with
  \`--title\`: \`✳️ [window] 🔵 ANSWER — <title>\`.

Tags are LOWERCASE ENGLISH ONLY — \`answer\` / \`decision\` / \`problem\` / \`report\`.
The badge (the unicode fallback non-premium clients see) is a colored dot + the
English word:

| Tag | Badge | Use it for |
|-----|-------|------------|
| answer | 🔵 ANSWER | answering the user's question |
| decision | 🟠 DECISION | a decision you need the user to make / confirm |
| problem | 🔴 PROBLEM | a blocker / problem report |
| report | 🟢 REPORT | a status / result report |

There is NO \`question\` tag: an open question for the user IS a decision request —
send it as \`decision\` in the decision-request format (\`--tag question\` is refused
with exactly that hint).

\`decision\` is an ESCALATION — it asks the CTO to choose — and tg
REQUIRES the decision-request format on it, DENY-BY-DEFAULT (skill:
decision-request-discipline). A malformed send is BLOCKED (exit 1) with a
checklist of what's missing. The message must be a self-contained, STRUCTURED
Rich Message the human can answer in ~30s without opening the repo AND without
reading a wall of text. Required:
- Context (one line: \`file:line\` + what it does),
- Options as a real \`<table>\` (or \`<ul>\`/\`<ol>\`) with pros/cons per option,
- a Recommendation (which option, why),
- Where to look (a \`file:line\` reference),
- STRUCTURE: each section under its own \`<h3>\`/\`<h4>\`, enumerations as short
  \`<ul>\`/\`<li>\` items (never inline "плюсы: a, b, c"), \`<hr>\` dividers, short
  lines — sent with \`--format html\`.
Markdown pipe grids (\`| a | b |\`) are AUTO-CONVERTED to a real \`<table>\`, so an
options grid renders even if typed as markdown. See \`tg help format\` for a
copy-pasteable GOOD vs BAD example. The one documented escape, for a genuine
non-escalation / urgent edge case, is \`ESCALATION_GATE_ENFORCE=0\` (downgrades
the block to an advisory warning). \`report\` / \`answer\` / \`problem\` are NOT
gated.

Uppercase (\`ANSWER\`), Cyrillic (\`ОТВЕТ\`), and unknown tags are REJECTED with a
clear error and a non-zero exit — use a lowercase-english tag from the table.

In a PUSH NOTIFICATION (rendered by the OS, which can't load the pill image) the
badge shows as \`<color>▫️▫️\` — ONE colored dot identifies the tag's CLASS
(🔵 answer / 🟠 decision / 🔴 problem / 🟢 report), the rest are neutral
squares. The tag word is not in the badge (any text after the dots is your
\`--title\`/body). In-app, premium clients see the full wordmark pill
(ANSWER/DECISION/PROBLEM/REPORT).

## Subagent identification (\`--subagent <label>\`) — REQUIRED when dispatching subagents
The header shows the sender as \`✳️ [window] [subagent]\`. The MAIN/orchestrator agent
needs NO flag: the \`[window]\` bracket already carries the project — it is the tmux window
name, or the pane's cwd basename when the window is auto-renamed to a version/shell (so a
session in \`~/xp/rig-cli\` shows \`[rig-cli]\`, never \`[2.1.207]\`).

If you are an orchestrator dispatching subagents (Claude Code Task tool or equivalent),
and a subagent may call \`tg\` itself, ALWAYS pass \`--subagent <descriptive-name>\` from that
subagent so the recipient can tell WHICH subagent sent a message, not just that some AI
did: \`tg --subagent hyperide-fixer "done, PR #123 open"\` → \`✳️ [window] [hyperide-fixer] …\`.

There is NO env-based auto-detection of a subagent (\`CLAUDE_CODE_CHILD_SESSION\` is not a
reliable main-vs-subagent signal), so the subagent bracket is explicit-only: pass
\`--subagent\` whenever the identity matters. \`TG_AGENT\` env has the same effect (flag wins).
The deprecated alias \`--agent\` still works. Check the resolved \`[window]\` label for the
current shell: \`tg --detect-agent\`.

(Not the same flag as \`tg-ctl\`'s own \`--agent <name>\` — that one selects a closed
harness kind for inbound telemetry, on a different binary.)

## Threaded replies (\`--reply-to <message_id>\`)
To answer a SPECIFIC inbound message and have your reply thread under it in
Telegram, pass its message_id: \`tg --reply-to <id> "answer"\` (sets
\`reply_to_message_id\`). The \`tg-ctl\` daemon surfaces the inbound id in the
injected wrap — \`[TG from Alex #1234] …\` — so the id to reply to is right there
in your pane. The id is Telegram's own per-chat message_id; nothing to compute.

The **answer** tag REQUIRES \`--reply-to\` (answering means answering a
specific message); without it \`tg\` errors with a clear message. The other tags
do not require it.

## Rich messages — tables, headings, lists, formulas (\`--format html\`, auto-routed)
\`--format html\` has TWO tiers, chosen AUTOMATICALLY by the tags in your body —
ONE flag, no \`--rich\`:
- **Basic** tags only (b/i/u/s/code/pre/a/blockquote/tg-emoji/tg-time/spoiler) →
  normal message (\`sendMessage\`).
- Any **rich** tag → a native Telegram **Rich Message** (\`sendRichMessage\`):
  real bordered tables (\`<table>\`/\`<tr>\`/\`<td>\`, \`align\`/\`colspan\`/\`<caption>\`),
  headings (\`<h1>\`..\`<h6>\`), lists (\`<ul>\`/\`<ol>\`/\`<li>\`), dividers (\`<hr>\`),
  collapsible \`<details>\`, and LaTeX formulas (\`<tg-math>\` inline / \`<tg-math-block>\`).
\`\`\`
tg --format html '<table bordered><tr><th>task</th><th>status</th></tr><tr><td>ship</td><td align="center">done</td></tr></table>'
tg --format html '<h2>Plan</h2><ul><li>step one</li><li>step two</li></ul><tg-math-block>E = mc^2</tg-math-block>'
\`\`\`
\`--tag\`/\`--title\`/\`--reply-to\` compose with rich. Rich limits: ≤ 32768 chars,
≤ 500 blocks, ≤ 16 nesting levels, ≤ 50 media, ≤ 20 table columns (\`tg\` errors
clearly if you exceed them).

## Plain table fallback (\`tg --table\`)
For a quick aligned grid WITHOUT authoring HTML, \`tg --table\` reads delimited rows
from STDIN (TSV, or \`a | b\` per line), auto-sizes columns, box-draws borders,
HTML-escapes cells, and sends a monospace \`<pre>\` block — the plain fallback. A
REAL bordered table comes from \`--format html\` with \`<table>\` (above). Composes
with \`--tag\`/\`--title\`; argv text becomes a heading above the table. Keep cells
ASCII/Cyrillic — double-width emoji/CJK push columns out of alignment.
\`\`\`
printf 'task\\tstatus\\nship\\tdone\\nreview\\twip' | tg --table
\`\`\`

## Formatting reference (\`tg help format\`)
\`tg help format\` prints the supported HTML tags and entities — the BASIC tier
plus the RICH tier (tables, headings, lists, formulas) auto-sent through the same
\`--format html\` — with a \`<table>\` example and the rich limits. Run it instead of
guessing at markup. (\`tg --format-help\` is a back-compat alias for the same.)

## Dictionary gate (banned wording — ALWAYS on, NO bypass)
Every send — \`--title\`, body, and \`--photo\`/\`--file\` captions, for every tag and
both formats, \`--dry-run\` included — is checked against the shared dictionary of
banned words at \`~/.claude/DICT.json\` (path override: \`TG_DICT_PATH\`). A hit
REFUSES the send (exit 1) and prints every match with the rule id, the matched
text in context and the replacement to use: rewrite the wording and resend.
There is no flag or env var to skip it. The text is matched as the reader sees it:
under \`--format html\`, text inside \`<code>\`/\`<pre>\` is exempt (quoting a banned
word to discuss it is fine) and other tags / entities are resolved before matching,
so markup cannot hide a word; under plain format everything is literal, so
\`<code>\` exempts nothing. Gated: \`--title\`, the \`--subagent\` label, body /
caption, \`--table\` heading + rows (autolink-inlined external titles and a
\`--file\` filename are not). A missing file at the DEFAULT path turns the gate off
silently; an explicit \`TG_DICT_PATH\` that does not exist refuses; a malformed file (bad JSON / a regex that does not compile)
refuses EVERY send, naming the file and rule, until it is fixed. File format:
\`{"version":1,"rules":[{"id","pattern","flags":"iu","only_if_cyrillic"?,"replacement","why"}]}\`
— \`pattern\` is a JS regex source (always compiled with \`u\`) whose \`\\b\` is Unicode-aware;
\`only_if_cyrillic\` rules apply only when the message contains Cyrillic. Full
description: \`tg help format\`.

## Code/config files → mobile PDF (\`--with-original\` / \`--no-pdf\`)
Attaching a code/config file (\`.ts\`, \`.tsx\`, \`.json\`, \`.yaml\`, \`.toml\`, \`.py\`,
\`.go\`, \`.rs\`, \`.sql\`, \`Dockerfile\`, …) renders it to a MOBILE,
syntax-highlighted, soft-wrapped PDF — Telegram iOS previews the raw source
uselessly, so the PDF is what's actually readable on a phone.

- **Default: ONLY the PDF is sent.** The raw file is NOT attached (it's noise on
  iOS). This is the right default — just \`tg --file server.ts "look"\`.
- \`--with-original\` — also attach the raw file alongside the PDF.
- \`--no-pdf\` — skip the PDF, attach the raw file (the pre-feature behavior).
- \`--pdf-device <name>\` — page size: \`iphone15pro\` (default), \`iphone15promax\`,
  \`iphonese\`, \`a4\`. Also \`TG_PDF_DEVICE\` / \`TG_PDF_THEME\` (highlight style).

Markdown (\`.md\`) keeps its own \`.md\`→PDF path; non-code files are unchanged.
Requires pandoc + Google Chrome; on any failure the raw file is sent unchanged.

## Voice input (inbound STT — talk instead of type)
The user can answer the agent by sending a Telegram VOICE note instead of typing.
The \`tg-ctl\` daemon downloads the audio, transcodes it with \`ffmpeg\`, runs a
local Whisper (whisper.cpp or faster-whisper), and injects the transcript into
the agent's pane — routed exactly like a typed reply (a voice note sent as a
reply keeps the quote anchor and reaches the replied-to origin pane).

- \`tg voice setup\` — discover a local Whisper (\`~/xp\` first) + a model, check
  for \`ffmpeg\`, and persist the config. Run once.
- If a voice note arrives before voice is configured, the bot replies with a
  guided setup flow instead of dropping it.
- Config lives in the \`voice:\` block of \`~/.config/tg-cli/config.yaml\`
  (\`enabled\`, \`runner\`, \`bin_path\`, \`model_path\`, \`language\` — default
  \`auto\`, covering ru + en).
- Inbound media downloads (voice / photo / doc) retry with backoff on a
  transient network blip (3 attempts, jittered ~300ms→2.7s) before giving up,
  so a momentary hiccup no longer silently drops the message.

## Inbound works with and without tmux
\`tg-ctl\` prefers each harness's real control surface instead of assuming a pane:
OMP uses ACP, OpenCode uses its HTTP/SSE API, and native Claude/Codex hook requests
are session-scoped even when \`TMUX_PANE\` is absent. In tmux, pane injection remains
the fast universal floor. Harnesses that have neither a native control API nor a
live pane use the durable Stop-hook inbox for ordinary inbound text when supported.

For a question initiated BY such a harness, do not scrape its terminal UI. Call
\`tg-ctl ask \"question\"\` synchronously; it is the owner-local Telegram decision
bridge and does not require tmux.

Always use \`tg\` / \`tg-ctl ask\`, never direct curl to the Telegram API.
`;

const SKILL_BLURB =
  '`tg` — send Telegram messages/files/reports: `tg "msg"`, ' +
  '`tg --format html "..."`, `tg --file f.pdf "cap"`, `tg --photo p.png`. ' +
  'Label messages with `--tag <answer|decision|problem|report>` ' +
  '(lowercase english only) and set an explicit header line with ' +
  '`--title "..."` (the body is never pulled up). ' +
  'Reply UNDER a specific inbound message with `--reply-to <message_id>` (the id ' +
  'shows up in the injected `[TG from … #<id>]` wrap); the answer tag ' +
  'requires it. ' +
  'If you are an ORCHESTRATOR dispatching subagents that may call `tg` themselves, ' +
  'ALWAYS pass `--subagent <descriptive-name>` from each subagent so the recipient can ' +
  'tell WHICH subagent sent a message — there is no env-based auto-detection, and the ' +
  'main agent auto-labels `[window]` from its tmux window/cwd with no flag. ' +
  '`--format html` auto-sends a native Rich Message (tables, ' +
  'headings, lists, LaTeX formulas) when the body has a rich tag like `<table>`/' +
  '`<h1>`/`<ul>` — same flag, tg routes by content. `tg --table` is the plain ' +
  'monospace `<pre>` fallback grid. `tg help format` lists every supported ' +
  'HTML tag/entity (basic + rich tiers). ' +
  'Attaching a code/config file (.ts/.json/.yaml/.py/…) renders a mobile, ' +
  'syntax-highlighted PDF and by DEFAULT sends ONLY the PDF (raw file is useless ' +
  'on iOS); `--with-original` sends both, `--no-pdf` sends the raw file. ' +
  'The user can reply by VOICE — a voice note is transcribed by a local Whisper ' +
  '(`tg voice setup`) and injected like a typed reply. ' +
  'For a synchronous human approval from a shell-capable harness without a native prompt hook, ' +
  'use `tg-ctl ask "question"`; it works without tmux and fails closed on reject/timeout. ' +
  'Use to report results/questions to the user. Never curl Telegram directly.';

const HOOK_MARKER = '# agent-tools-awareness';
const HOOK_COMMAND =
  `sh -c 'd="$HOME/.agents/skills/.blurbs"; ls "$d"/*.md >/dev/null 2>&1 && ` +
  `{ printf "Agent CLI tools installed on this machine (prefer them):\\n"; ` +
  `cat "$d"/*.md; }' ${HOOK_MARKER}`;

function detected(cmd: string, ...dirs: string[]): boolean {
  const probe = Bun.spawnSync(['sh', '-c', `command -v ${cmd}`], { stdout: 'ignore', stderr: 'ignore' });
  if (probe.exitCode === 0) return true;
  const home = resolveHome();
  return dirs.some((d) => existsSync(d.startsWith('~/') ? join(home, d.slice(2)) : d));
}

function appendMarked(path: string, tool: string, blurb: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const start = `<!-- skill:${tool} -->`;
  const end = `<!-- /skill:${tool} -->`;
  let existing = readTextIfExists(path) ?? '';
  const re = new RegExp(escapeRegExp(start) + '[\\s\\S]*?' + escapeRegExp(end) + '\\n?', 'g');
  existing = existing.replace(re, '');
  const block = `${start}\n${blurb}\n${end}\n`;
  writeFileSync(path, existing.trim() ? existing.replace(/\s+$/, '') + '\n\n' + block : block);
}

// Idempotently add a SessionStart hook to ~/.claude/settings.json that surfaces
// installed agent CLIs. Conservative: never removes or rewrites unrelated config.
function ensureSessionStartHook(home: string): boolean {
  const settingsPath = join(home, '.claude', 'settings.json');
  if (!existsSync(join(home, '.claude'))) return false;
  // Read the existing settings ONCE into memory, then parse from and back up
  // from that same in-memory copy. A separate existsSync()/readFileSync() per
  // use would re-stat the path each time, racing with concurrent writers
  // (js/file-system-race); a single read snapshots the bytes we then act on.
  const original = readTextIfExists(settingsPath);
  let data: any;
  try {
    data = original !== undefined ? JSON.parse(original) : {};
  } catch {
    return false; // don't clobber a file we can't parse
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
  data.hooks ??= {};
  if (typeof data.hooks !== 'object' || data.hooks === null) return false;
  data.hooks.SessionStart ??= [];
  const sessionStart = data.hooks.SessionStart;
  if (!Array.isArray(sessionStart)) return false;
  for (const group of sessionStart) {
    const hooks = group && typeof group === 'object' ? group.hooks : null;
    if (Array.isArray(hooks)) {
      for (const h of hooks) {
        if (h && typeof h.command === 'string' && h.command.includes(HOOK_MARKER)) return false;
      }
    }
  }
  sessionStart.push({ hooks: [{ type: 'command', command: HOOK_COMMAND }] });
  // Back up the snapshot we already read (not a fresh read of the path) before
  // overwriting, so the .bak is exactly what we parsed and there is no second
  // check-then-read race.
  if (original !== undefined) writeFileSync(settingsPath + '.bak', original);
  writeFileSync(settingsPath, JSON.stringify(data, null, 2) + '\n');
  return true;
}

export function installSkill(): number {
  const home = resolveHome();
  const written: string[] = [];

  // Layer 1 — SKILL.md (Agent Skills standard) + blurb file for the hook.
  const skillDir = join(home, '.agents', 'skills', SKILL_NAME);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), SKILL_MD);
  written.push(join(skillDir, 'SKILL.md'));
  const blurbs = join(home, '.agents', 'skills', '.blurbs');
  mkdirSync(blurbs, { recursive: true });
  writeFileSync(join(blurbs, `${SKILL_NAME}.md`), `- ${SKILL_BLURB}\n`);

  // Claude Code also scans ~/.claude/skills — symlink for compatibility.
  const claudeSkills = join(home, '.claude', 'skills');
  if (existsSync(claudeSkills)) {
    const link = join(claudeSkills, SKILL_NAME);
    if (!existsSync(link)) {
      try {
        symlinkSync(join('..', '..', '.agents', 'skills', SKILL_NAME), link);
      } catch {
        // ignore — symlink unsupported or race
      }
    }
  }

  // Layer 2 — always-on blurb in each DETECTED harness's instruction file.
  const harnesses: [string, string, string[]][] = [
    ['claude', join(home, '.claude', 'CLAUDE.md'), ['~/.claude']],
    ['codex', join(home, '.codex', 'AGENTS.md'), ['~/.codex']],
    ['opencode', join(home, '.config', 'opencode', 'AGENTS.md'), ['~/.config/opencode']],
    ['gemini', join(home, '.gemini', 'GEMINI.md'), ['~/.gemini']],
  ];
  for (const [cmd, path, dirs] of harnesses) {
    if (detected(cmd, ...dirs)) {
      appendMarked(path, SKILL_NAME, SKILL_BLURB);
      written.push(path);
    }
  }

  // Layer 3 — SessionStart hook (Claude Code) aggregating all installed tools.
  if (existsSync(join(home, '.claude'))) {
    if (ensureSessionStartHook(home)) written.push('SessionStart hook -> ~/.claude/settings.json');
  }

  for (const w of written) console.log(`  ✓ ${w}`);
  console.log(`${SKILL_NAME}: install-skill done (${written.length} target(s)). Re-run anytime; idempotent.`);
  return 0;
}
