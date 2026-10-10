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
// KNOWN LIMITATION: a command containing a real newline (heredocs, multi-
// line strings) can never satisfy permissionMenuMatchesRequest's per-line
// exact match, and always falls through to queuing — fail-soft, but it
// excludes some of the long-running commands most likely to blow the 120s
// hook budget in the first place.

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
  // (review finding: two independent reviewers found this exact bypass).
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
// scrollback further up the pane.
const MENU_CONTEXT_LINES = 12;

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
// LINE-EXACT, not a substring/blob/prefix search: Claude Code renders the
// command as its OWN physical line in the box (every real capture confirms
// this), so matching is done per-line — does ANY line of the context,
// whitespace-normalized, equal the FULL identity exactly? A stale "git push"
// tap must NOT match a live menu whose command line is "git push --force", and
// a command must not match another that shares its first 100 chars (tg-cli#309)
// — any prefix-style check, even boundary-aware, accepts both. `tmux
// capture-pane -pJ` (capturePane) joins tmux's internal line-wrap breaks first,
// so a long command that LOOKS wrapped in the terminal is still one logical
// line by the time it reaches here.
//
// An identity ending in "…" never matches: whether it is a truncated summary or
// the box rendering a long command shortened, the visible line cannot prove
// which full command it stands for — refuse, the caller keeps the decision
// queued.
export function permissionMenuMatchesRequest(context: string, identity: string): boolean {
  return identityLineIndex(context.split('\n').map(normalizeLine), identity) !== -1;
}

function identityLineIndex(lines: string[], identity: string): number {
  const needle = normalizeLine(identity);
  if (!needle || needle.endsWith('…')) return -1;
  return lines.lastIndexOf(needle);
}

// What a pane-inject is about to answer: the digit for the decision, plus the
// menu's own BOX — the whitespace-normalized lines from the request's command
// line through the last option (cursor position included). The box is the
// fingerprint re-checked immediately before the digit is sent and after it:
// a different permission, the same command re-asked with different text, or a
// human moving the cursor at the keyboard all change it.
export interface PermissionMenuTarget {
  identity: string;
  decision: 'allow' | 'deny';
  digit: string;
  box: string;
}

export type PermissionMenuSkipReason = 'identity-unverifiable' | 'no-menu' | 'no-live-cursor' | 'identity-mismatch' | 'no-pickable-option';

export type PermissionMenuLookup = { ok: true; target: PermissionMenuTarget } | { ok: false; reason: PermissionMenuSkipReason };

// Find the live menu for THIS request in a capture and the digit answering
// `decision`. Each failure carries its own reason so field logs tell "menu
// already resolved" (no-live-cursor) from "a live menu shows a different
// command" (identity-mismatch) from "nothing exact to bind to"
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
  const lines = menu.context.split('\n').map(normalizeLine);
  const at = identityLineIndex(lines, identity);
  if (at === -1) return { ok: false, reason: 'identity-mismatch' };
  const digit = pickPermissionMenuDigit(menu.options, decision);
  if (digit === null) return { ok: false, reason: 'no-pickable-option' };
  const box = lines.slice(at).filter(Boolean).join('\n');
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
//                   asked again — either way delivery is not confirmed
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
  return permissionMenuMatchesRequest(menu.context, target.identity) ? 'still-pending' : 'next-menu';
}
