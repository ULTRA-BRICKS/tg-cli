// Parse a captured tmux pane's TEXT for Claude Code's numbered permission menu
// ("Do you want to proceed? \n ❯ 1. Yes \n 2. No") and pick which digit
// answers a given allow/deny decision.
//
// PURE — takes the raw `tmux capture-pane -pJ` output as a string, returns
// data. The tg-ctl entrypoint owns the actual capture (spawnSync) and the
// digit injection (features/tg-ctl/inject.ts's buildDigitInjectPlan).
//
// Why this exists: a PERMISSION request whose hook socket already closed
// (Claude Code's ~120s hook budget elapsed) has no live socket to write a
// structured JSON reply to — the harness has already fallen back to its OWN
// interactive terminal prompt. That prompt can still be answered directly by
// injecting the matching digit keypress, instead of queuing the decision and
// hoping a hook reconnect happens (which may never come — nothing about a
// terminal fallback causes Claude Code to fire a fresh hook). See tg-ctl's
// late-delivery-for-permissions path (tg-cli#267).
//
// CONFIRMED LIVE (2026-08-18, throwaway tmux session): a Bash-tool
// PermissionRequest renders exactly the "Do you want to proceed?" / numbered
// Yes-No menu this module parses, and a bare digit keypress submits it
// instantly (no Enter). NOT yet confirmed, tracked as tg-cli#268: edit/
// write-tool prompts ("Do you want to make this edit to …?") or
// plan-approval ("Would you like to proceed?" with "Yes, and auto-accept
// edits" / "No, keep planning" options) may use different marker text and/or
// option wording — those fall through to the existing queue-and-wait path
// today (parsePermissionMenu returns null / pickPermissionMenuDigit returns
// null for them), not because they're deliberately unsupported, but because
// they're unverified. Also tg-cli#268: the real rendered deny label may be a
// verbose form ("No, and tell Claude what to do differently") that
// pickPermissionMenuDigit's exact "No" match doesn't recognize — same safe
// fall-through.
//
// The command's identity is checked STRUCTURALLY when the box has the dashed
// command rules Claude Code 2.1.296 draws (tg-cli#283, evidence in
// docs/research/2026-10-11-claude-code-bash-permission-box.md): the rows
// between those rules must be the command's lines, all of them, exactly. A
// multi-line command (heredocs, several statements) can be answered that way;
// before, it never matched and stranded in the queue.

export interface PermissionMenuOption {
  digit: string;
  label: string;
}

export interface ParsedPermissionMenu {
  options: PermissionMenuOption[];
  // A BOUNDED window ending at the menu (the last few lines before it, plus
  // the marker/options themselves) — NOT the whole pane. Identity matching
  // (permissionMenuMatchesRequest) MUST use this, never the raw pane text:
  // searching the whole pane re-admits an older, already-RESOLVED permission
  // whose command is still visible higher up in scrollback (e.g. its
  // execution echo, "⏺ Bash(pkill -f x)") — a stale tap for that old request
  // would then match text that has nothing to do with the CURRENT live menu
  // (review finding: two independent reviewers found this exact bypass). A
  // dashed-rule command block (locateCommandBlock) is included whole, however
  // tall, back to its upper rule.
  context: string;
  // Does any option line still carry the "❯" cursor glyph? A live, currently-
  // answerable menu always has one (Claude Code's selection cursor); a
  // RESOLVED prompt that a terminal leaves visible in scrollback (rather than
  // erasing it) would still contain the marker text and numbered options but
  // NOT an active cursor — text presence alone can't tell live from resolved
  // once the app has moved on, because we don't have confirmed evidence
  // either way about whether Claude Code erases the box on resolve or leaves
  // it as static history (review finding: the post-inject "is it gone"
  // confirmation must not assume erasure). This field is what the
  // post-inject confirmation actually gates on, not `options.length > 0`.
  hasLiveCursor: boolean;
}

const PROCEED_MARKER = 'Do you want to proceed?';
// A SINGLE digit only (not \d+): with bare-digit-submits-instantly semantics,
// a two-digit capture like "10" would inject as "1" then "0" — two separate
// keypresses that could select and then misfire on whatever follows. Claude
// Code's menus never realistically reach 10 options; this is cheap insurance
// against the parser and the injector silently disagreeing about what
// "digit" means (review finding).
const OPTION_LINE = /^\s*(?:❯\s*)?(\d)\.\s+(.+?)\s*$/;

// Generous bound on Claude Code's permission box (tool header + command +
// optional description + rule text): every real capture seen so far fits
// well under this. Sized to comfortably include the CURRENT menu's own
// identifying text while excluding an older, unrelated interaction's leftover
// scrollback further up the pane. A dashed-rule command block taller than this
// is taken whole (locateCommandBlock): it is bounded by its own rules.
const MENU_CONTEXT_LINES = 12;

// Claude Code 2.1.296 draws a Bash command between two full-width rules of "╌",
// directly above the menu: a short one-line command as ONE unprefixed row, any
// other as one " │ " row per line — and per row Claude Code wrapped a long line
// into, which looks the same. Between the lower rule and the marker there is at
// most a "This command requires approval" line. Above the upper rule are the
// tool header and the model-written description, which are NOT the command.
const COMMAND_RULE = /^\s*╌{3,}\s*$/;
const COMMAND_ROW = /^\s*│(?: (.*))?$/;
const RULE_TO_MARKER_MAX_LINES = 3;
// Measured: a row holds rule width − 4 characters (76 on an 80-column pane).
const ROW_WIDTH_INSET = 4;
// Spare columns when proving a row break is a newline, not a wrap: the wrap
// rule was measured on one wrapper version; being short of it only refuses more.
const WRAP_SAFETY_COLUMNS = 2;
// Measured: a tab is drawn as spaces to the next multiple of 8 columns.
const TAB_STOP = 8;
// The permission box opens with a full-width "─" border at column 0, then the
// tool header, a tip line and the description, then the upper "╌" rule.
const BOX_TOP = /^─{3,}\s*$/;
const BOX_TOP_TO_RULE_MAX_LINES = 8;

// What sits between the rules above the live marker:
//   absent       — no rule right above it: an older box shape or another tool
//   offscreen    — the rows run up to the top of the capture; the command is
//                  taller than the pane and its first lines are not on screen
//   unrecognized — rules, but not one plain row or a run of " │ " rows
//   rows         — the drawn rows, without their " │ " prefix
// `start` is the first line of the region inspected — for `rows` the box's top
// border when it is there (so the box fingerprint covers the header and the
// description too: the same command asked again with another description is
// another box), else the upper rule; otherwise the line that broke the run. A
// context cut from `start` re-locates the same.
type CommandBlock =
  | { kind: 'absent' }
  | { kind: 'offscreen' | 'unrecognized'; start: number }
  | { kind: 'rows'; start: number; rows: string[]; rowWidth: number };

function boxTopAbove(lines: string[], upperRule: number): number {
  for (let i = upperRule - 1; i >= Math.max(0, upperRule - BOX_TOP_TO_RULE_MAX_LINES); i--) {
    if (BOX_TOP.test(lines[i])) return i;
    if (lines[i].includes(PROCEED_MARKER) || OPTION_LINE.test(lines[i]) || COMMAND_RULE.test(lines[i])) break;
  }
  return upperRule;
}

function locateCommandBlock(lines: string[], markerIdx: number): CommandBlock {
  // The nearest rule within the whole context window: one further up than
  // RULE_TO_MARKER_MAX_LINES (a notice wrapped in a narrow pane) still means
  // this is the dashed shape — refuse it, never fall back to the any-line match.
  let lower = -1;
  for (let i = markerIdx - 1; i >= Math.max(0, markerIdx - MENU_CONTEXT_LINES); i--) {
    if (COMMAND_RULE.test(lines[i])) {
      lower = i;
      break;
    }
  }
  if (lower === -1) return { kind: 'absent' };
  if (markerIdx - 1 - lower > RULE_TO_MARKER_MAX_LINES) return { kind: 'unrecognized', start: lower };
  const rowWidth = lines[lower].trim().length - ROW_WIDTH_INSET;
  if (lower >= 1 && COMMAND_ROW.test(lines[lower - 1])) {
    let top = lower - 1;
    while (top > 0 && COMMAND_ROW.test(lines[top - 1])) top--;
    if (top === 0) return { kind: 'offscreen', start: 0 };
    if (!COMMAND_RULE.test(lines[top - 1])) return { kind: 'unrecognized', start: top - 1 };
    const rows = lines.slice(top, lower).map((l) => l.match(COMMAND_ROW)?.[1] ?? '');
    return { kind: 'rows', start: boxTopAbove(lines, top - 1), rows, rowWidth };
  }
  const single = lines[lower - 1] ?? '';
  if (lower >= 2 && COMMAND_RULE.test(lines[lower - 2]) && single.trim() !== '' && !COMMAND_RULE.test(single)) {
    return { kind: 'rows', start: boxTopAbove(lines, lower - 2), rows: [single.replace(/^ /, '')], rowWidth };
  }
  return { kind: 'unrecognized', start: Math.max(0, lower - 2) };
}

// Returns null when the pane text doesn't currently show a menu (already
// resolved, a different prompt, or the pane is gone). Scans from the LAST
// "Do you want to proceed?" occurrence, not the first: the marker text can
// also appear in the agent's own scrollback (e.g. relaying a past prompt in
// its output), and the live, currently-answerable menu — if any — is always
// the most recent one (review finding). The first option must appear within
// ONE line of the marker (real captures always have it on the very next
// line; one blank line is tolerated) — this is NOT an unbounded scan: every
// non-blank line before an option is found aborts the parse (review finding
// — an earlier version skipped arbitrarily far ahead looking for the first
// option, which could pair a stale/relayed marker with an UNRELATED numbered
// list much further down the pane, and silently un-bounded `context` below
// along with it). Once options begin, collects consecutive numbered lines
// and stops at the first non-matching line (works whether the menu has 2
// options — "Yes"/"No" — or 3 — with a "don't ask again" variant).
export function parsePermissionMenu(paneText: string): ParsedPermissionMenu | null {
  const lines = paneText.split('\n');
  const startIdx = lines.map((line) => line.includes(PROCEED_MARKER)).lastIndexOf(true);
  if (startIdx === -1) return null;

  const options: PermissionMenuOption[] = [];
  let endIdx = startIdx;
  let blankTolerance = 1;
  let hasLiveCursor = false;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const match = lines[i].match(OPTION_LINE);
    if (match) {
      options.push({ digit: match[1], label: match[2] });
      if (match[0].includes('❯')) hasLiveCursor = true;
      endIdx = i;
      continue;
    }
    if (options.length > 0) break;
    if (lines[i].trim() === '' && blankTolerance > 0) {
      blankTolerance--;
      continue;
    }
    return null; // anything else before the first option means this isn't a live menu right here
  }
  if (options.length === 0) return null;

  // The context never reaches back past an EARLIER menu's marker or option
  // lines: a resolved box Claude Code leaves in scrollback directly above the
  // live one fits inside MENU_CONTEXT_LINES, and its command line would
  // otherwise bind a stale tap for THAT request to the live menu below it
  // (tg-cli#309 review finding).
  let contextStart = Math.max(0, startIdx - MENU_CONTEXT_LINES);
  for (let i = startIdx - 1; i >= contextStart; i--) {
    if (lines[i].includes(PROCEED_MARKER) || OPTION_LINE.test(lines[i])) {
      contextStart = i + 1;
      break;
    }
  }
  const block = locateCommandBlock(lines, startIdx);
  if (block.kind !== 'absent') contextStart = Math.min(contextStart, block.start);
  return { options, context: lines.slice(contextStart, endIdx + 1).join('\n'), hasLiveCursor };
}

// Map an allow/deny decision to the menu's matching digit. EXACT match on
// "Yes"/"No" (not a prefix) — Claude Code has multiple WIDE "yes" variants
// beyond the "don't ask again" one already excluded here (e.g. "Yes, allow
// all edits during this session"), and a Telegram "Approve" tap must never
// silently grant one of those broader standing decisions instead of a plain
// one-time yes (review finding: a prefix/blocklist match is safe only by
// accident of option ordering — an exact allowlist match enforces the
// invariant structurally). Matches by label text, not the Telegram button's
// own wording ("Approve"/"Reject", or a plan-approval's "Proceed"/"Keep
// planning"). No match returns null — the caller's safe fallback is to queue
// for a hook reconnect, never to guess (this is also why an unverified
// plan-approval menu, whose options are never a plain "Yes"/"No", safely
// falls through to queuing instead of matching something it shouldn't).
export function pickPermissionMenuDigit(
  options: PermissionMenuOption[],
  decision: 'allow' | 'deny',
): string | null {
  const wanted = decision === 'allow' ? 'yes' : 'no';
  const found = options.find((o) => o.label.trim().toLowerCase() === wanted);
  return found?.digit ?? null;
}

// The identifying text for a permission request — the same fields
// hook-normalize.ts's summarizeInput prioritizes (command > file_path > path
// > url) when the original tool_input survived, else the `question` field
// with its "Allow <Tool>? " boilerplate prefix stripped. Used to bind a
// captured menu to the SPECIFIC request being late-delivered, never to
// whatever permission happens to be on screen right now. The prefix regex
// requires the "<Tool>" token to be a single whitespace-free word (matching
// hook-normalize.ts's literal `Allow ${toolName}? ` construction) — a looser
// `[^?]*` would also gobble a multi-word manual/back-compat question like
// "Allow bash command: pkill -f x?" down to an empty string, destroying the
// one piece of identifying text it had.
//
// null = no EXACT identity exists, so the caller must not inject at all:
// nothing after the prefix, or a question summary hook-normalize cut at 100
// chars ("…"). A truncated summary names every command that shares its first
// 99 chars — the long-command class this feature exists for — so treating it
// as a prefix could approve a different command than the one on the card
// (tg-cli#309).
export function extractPermissionIdentity(req: { question: string; toolInput?: Record<string, unknown> }): string | null {
  const input = req.toolInput;
  if (input) {
    const field = ['command', 'file_path', 'path', 'url'].find((k) => typeof input[k] === 'string');
    if (field) return input[field] as string;
  }
  const summary = req.question.replace(/^Allow \S+\?\s*/, '').trim();
  return summary === '' || summary.endsWith('…') ? null : summary;
}

const normalizeLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

// Does the captured menu's BOUNDED context (never the whole pane — see
// ParsedPermissionMenu.context) still identify THIS request, not a newer,
// unrelated permission the harness has since moved on to within the
// retention window? Without this the pane-inject path could act on a
// completely different pending command than the one the human tapped
// Approve/Reject for — a permission-escalation-shaped bug, worse than the
// pre-existing queue-and-wait behavior (which never touches a live pane).
//
// Never a substring/blob/prefix search: a stale "git push" tap must NOT match
// a live menu whose command is "git push --force", and a command must not
// match another that shares its first 100 chars (tg-cli#309) — any
// prefix-style check, even boundary-aware, accepts both. An identity ending in
// "…" never matches: whether it is a truncated summary or the box rendering a
// long command shortened, the visible text cannot prove which full command it
// stands for — refuse, the caller keeps the decision queued.
export function permissionMenuMatchesRequest(context: string, identity: string): boolean {
  return typeof locateIdentity(context.split('\n'), identity) === 'number';
}

// Where THIS request's box starts in `lines` (a menu's context), or why it
// does not match. Two shapes:
//
// With the dashed command rules, only the block attached to the live marker
// counts — not the description row above it, not the transcript echo of the
// live command above that, not an older box (real captures show all three as
// lines that equal some command). Its rows must equal the identity's lines:
// the same count, each one exactly (tabs expanded as drawn, trailing
// whitespace dropped — the screen does not show it). It refuses when the top
// of the block is off the screen, when the dashed shape is there but not as
// measured (command-unrecognized), when any row shows "…", when a row before
// the last ends in a backslash ("\" continues the line, "\ " followed by an
// undrawn space ends it — a second command), and when a row break could be
// Claude Code's own word wrap: the next row's first word would have fit on the
// row above, so the break must be a newline. What no screen shows, this cannot
// check (tg-cli#683): a run of spaces wide enough to fill a row is drawn
// exactly like a line break, a tab like spaces.
//
// Without the rules (older Claude Code, other tools): does ANY whitespace-
// normalized line of the context equal the FULL one-line identity? The command
// is its own physical line in that box; `tmux capture-pane -pJ` (capturePane)
// joins tmux's own wrap breaks first. A multi-line identity never matches
// there — normalizing its newlines to spaces would approve a different command.
type IdentityLocation = number | 'identity-mismatch' | 'command-partly-visible' | 'command-unrecognized';

function locateIdentity(lines: string[], identity: string): IdentityLocation {
  const marker = lines.map((line) => line.includes(PROCEED_MARKER)).lastIndexOf(true);
  const block: CommandBlock = marker === -1 ? { kind: 'absent' } : locateCommandBlock(lines, marker);
  if (block.kind === 'absent') {
    const needle = normalizeLine(identity);
    if (!needle || needle.endsWith('…') || identity.includes('\n')) return 'identity-mismatch';
    const at = lines.map(normalizeLine).lastIndexOf(needle);
    return at === -1 ? 'identity-mismatch' : at;
  }
  if (block.kind === 'offscreen') return 'command-partly-visible';
  if (block.kind === 'unrecognized') return 'command-unrecognized';
  return commandRowsMatch(block.rows, block.rowWidth, identity) ? block.start : 'identity-mismatch';
}

// A tab or newline is how the command is laid out; any other control
// character (a carriage return, an escape sequence) is drawn in ways not
// measured — refuse rather than guess. A blank command identifies nothing.
const UNDRAWN_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

function commandRowsMatch(rows: string[], rowWidth: number, identity: string): boolean {
  if (identity.trim() === '' || UNDRAWN_CONTROL.test(identity)) return false;
  const want = identity.split('\n').map((line) => expandTabs(line).trimEnd());
  const drawn = rows.map((row) => row.trimEnd());
  if (want.length !== drawn.length || want.some((line, i) => line !== drawn[i])) return false;
  if (drawn.some((row) => row.includes('…'))) return false;
  if (drawn.slice(0, -1).some((row) => row.endsWith('\\'))) return false;
  return drawn.every((row, i) => i === drawn.length - 1 || !couldBeWordWrap(row, drawn[i + 1], rowWidth));
}

function expandTabs(line: string): string {
  let out = '';
  for (const ch of line) out += ch === '\t' ? ' '.repeat(TAB_STOP - (out.length % TAB_STOP)) : ch;
  return out;
}

// Could Claude Code have broken one long line here? It moves a word down only
// when it no longer fits, so if the next row's first word (with any indent)
// fits after this row and a space, the break was a newline. Widths are counted
// high (two columns for anything outside printable ASCII), so a wide character
// can only make this refuse.
function couldBeWordWrap(row: string, next: string, rowWidth: number): boolean {
  const firstWord = next.match(/^\s*\S*/)?.[0] ?? '';
  return columns(row) + 1 + columns(firstWord) > rowWidth - WRAP_SAFETY_COLUMNS;
}

function columns(text: string): number {
  let width = 0;
  for (const ch of text) width += ch >= ' ' && ch <= '~' ? 1 : 2;
  return width;
}

// What a pane-inject is about to answer: the digit for the decision, plus the
// menu's own BOX — the whitespace-normalized lines from the request's command
// (its upper rule, for a dashed-rule block) through the last option (cursor
// position included). The box is the fingerprint re-checked immediately before
// the digit is sent and after it: a different permission, the same command
// re-asked with different text, or a human moving the cursor at the keyboard
// all change it.
export interface PermissionMenuTarget {
  identity: string;
  decision: 'allow' | 'deny';
  digit: string;
  box: string;
}

export type PermissionMenuSkipReason =
  | 'identity-unverifiable'
  | 'no-menu'
  | 'no-live-cursor'
  | 'identity-mismatch'
  | 'command-partly-visible'
  | 'command-unrecognized'
  | 'no-pickable-option';

export type PermissionMenuLookup = { ok: true; target: PermissionMenuTarget } | { ok: false; reason: PermissionMenuSkipReason };

// Find the live menu for THIS request in a capture and the digit answering
// `decision`. Each failure carries its own reason so field logs tell "menu
// already resolved" (no-live-cursor) from "a live menu shows a different
// command" (identity-mismatch) from "the command is taller than the pane"
// (command-partly-visible) from "a dashed box not shaped as measured"
// (command-unrecognized) from "nothing exact to bind to"
// (identity-unverifiable). hasLiveCursor gates the match: text alone does not
// prove the menu is the currently-answerable widget (see
// ParsedPermissionMenu.hasLiveCursor).
export function findPermissionMenuTarget(
  paneText: string | null,
  identity: string | null,
  decision: 'allow' | 'deny',
): PermissionMenuLookup {
  if (identity === null) return { ok: false, reason: 'identity-unverifiable' };
  const menu = paneText === null ? null : parsePermissionMenu(paneText);
  if (!menu) return { ok: false, reason: 'no-menu' };
  if (!menu.hasLiveCursor) return { ok: false, reason: 'no-live-cursor' };
  const lines = menu.context.split('\n');
  const at = locateIdentity(lines, identity);
  if (typeof at !== 'number') return { ok: false, reason: at };
  const digit = pickPermissionMenuDigit(menu.options, decision);
  if (digit === null) return { ok: false, reason: 'no-pickable-option' };
  const box = lines.slice(at).map(normalizeLine).filter(Boolean).join('\n');
  return { ok: true, target: { identity, decision, digit, box } };
}

// The pre-send gate, run inside the pane's typing turn IMMEDIATELY before the
// digit's send-keys: is the very menu `target` was resolved from still the
// live one — same identity line, same digit for the decision, same box? The
// first capture can be seconds old by then (the typing turn may wait behind
// another plan), and the human may have answered at the keyboard and let a
// different permission render in the same spot (tg-cli#309).
export function permissionMenuUnchanged(paneText: string | null, target: PermissionMenuTarget): boolean {
  const now = findPermissionMenuTarget(paneText, target.identity, target.decision);
  return now.ok && now.target.digit === target.digit && now.target.box === target.box;
}

// After the digit is sent, what does the pane say about it?
//   unreadable    — the re-capture failed; proves nothing, never "delivered"
//   still-pending — a live menu still shows THIS request's command: the key was
//                   swallowed (e.g. copy-mode), or the same command is being
//                   asked again — either way delivery is not confirmed. Also a
//                   live menu whose command block cannot be read (its top
//                   scrolled off, or not shaped as measured): it may be this one
//   next-menu     — THIS request's menu is gone and a live menu for a
//                   DIFFERENT command now occupies the spot (Claude Code asks
//                   for the next tool call at once): resolved, and the log
//                   names it so it is never mistaken for the original
//   resolved      — no live menu
export type PostInjectPaneState = 'unreadable' | 'still-pending' | 'next-menu' | 'resolved';

export function classifyPostInjectPane(paneText: string | null, target: PermissionMenuTarget): PostInjectPaneState {
  if (paneText === null) return 'unreadable';
  const menu = parsePermissionMenu(paneText);
  if (!menu?.hasLiveCursor) return 'resolved';
  const at = locateIdentity(menu.context.split('\n'), target.identity);
  return at === 'identity-mismatch' ? 'next-menu' : 'still-pending';
}
