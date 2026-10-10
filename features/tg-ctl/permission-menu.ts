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
// instantly (no Enter). Measured for the other shapes by the tg-cli#304 study
// (docs/research/2026-09-04-claude-code-tmux-prompts.md, Claude Code 2.1.261):
// an Edit prompt's marker is "Do you want to make this edit to <relative
// path>?" and plan approval's is "… Would you like to proceed?" with options
// "Yes, auto-accept edits" / "Yes, manually approve edits" / "Tell Claude what
// to change" — neither matches PROCEED_MARKER, so both fall through to the
// queue-and-wait path (tg-cli#268 tracks widening it). The deny label of both
// Bash and Edit menus is a plain "No", which pickPermissionMenuDigit matches.
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

  const contextStart = Math.max(0, startIdx - MENU_CONTEXT_LINES);
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

// Best-effort identifying text for a permission request — the same fields
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
export function extractPermissionIdentity(req: { question: string; toolInput?: Record<string, unknown> }): string {
  const input = req.toolInput;
  if (input) {
    const field = ['command', 'file_path', 'path', 'url'].find((k) => typeof input[k] === 'string');
    if (field) return input[field] as string;
  }
  return req.question.replace(/^Allow \S+\?\s*/, '');
}

// Does the captured menu's BOUNDED context (never the whole pane — see
// ParsedPermissionMenu.context) still identify THIS request, not a newer,
// unrelated permission the harness has since moved on to within the
// retention window? Without this the pane-inject path could act on a
// completely different pending command than the one the human tapped
// Approve/Reject for — a permission-escalation-shaped bug, worse than the
// pre-existing queue-and-wait behavior (which never touches a live pane).
//
// LINE-EXACT, not a substring/blob search: Claude Code renders the command as
// its OWN physical line in the box (every real capture confirms this), so
// matching is done per-line — does ANY line of the context, whitespace-
// normalized, equal the identity exactly? This is what actually closes the
// escalation case a naive substring/boundary check cannot: a stale "git
// push" tap must NOT match a live menu whose command line is "git push
// --force" — as whole lines they are simply not equal, whereas ANY
// substring-style check (even boundary-aware) still finds "git push" sitting
// at the start of "git push --force" (review finding, confirmed by two
// independent reviewers as the concrete residual risk of a boundary-only
// fix). `tmux capture-pane -pJ` (capturePane) joins tmux's internal line-wrap
// breaks first, so a long command that LOOKS wrapped in the terminal is
// still one logical line by the time it reaches here.
//
// For a TRUNCATED identity (hook-normalize.ts's 100-char cap, trailing "…"),
// only a prefix is known — falls back to a prefix-of-line match, still
// requiring the prefix to end at a line-internal word boundary so "rm" (as a
// truncated prefix, which can't happen at 100 chars but is defensive anyway)
// doesn't prefix-match "rm -rf /tmp/abc" as a different, longer command.
export function permissionMenuMatchesRequest(context: string, identity: string): boolean {
  const normalizeLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
  const truncated = identity.trim().endsWith('…');
  const needle = normalizeLine(identity).replace(/…$/, '').trim();
  if (!needle) return false;
  const lines = context.split('\n').map(normalizeLine).filter(Boolean);
  if (!truncated) return lines.includes(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefixMatch = new RegExp(`^${escaped}(\\s|$)`);
  return lines.some((line) => prefixMatch.test(line));
}
