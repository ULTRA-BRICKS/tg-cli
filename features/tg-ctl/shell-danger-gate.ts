// Content gate for tg-ctl's `!<shell command>` Telegram passthrough.
//
// Why this exists: `textAction()`, `topicActionFor()`'s bound-topic branch, its
// closed-topic (`topic-dead`) branch, and the flat entrypoint's `!`-reply path
// (all in `updates.ts`) inject a `!`-prefixed message VERBATIM into the attached
// harness's live tmux pane the instant it arrives. The ONLY check upstream is
// `senderAllowed` — an IDENTITY check (is this Telegram user on the allowlist?).
// There is zero CONTENT inspection: an allowed sender's `!rm -rf /` runs exactly
// as fast as their `!git status`. agent-tools' `workflow-danger-gate` hook looks
// like it should cover this but does not — it gates Claude Code's own `Workflow`
// tool via a PreToolUse hook, a completely different surface that never sees
// tg-ctl's Telegram text. This module is the narrow gate that closes THAT gap,
// mirroring `workflow-danger-gate`'s named-rule-denylist shape (same rule-id
// convention, same short-flag-cluster regex trick) but matching raw shell text
// instead of embedded JS.
//
// Non-goal: this is not a sandbox and does not attempt to parse or execute the
// shell. It is a narrow list of named catastrophic-shape patterns — the same
// honest scope caveat as workflow-danger-gate: it does not catch every
// destructive command, only the handful of shapes that have burned someone
// before. A sender who wants to run something dangerous can still do so by
// prefixing it with `!!` (see `shellPassthroughGate` below) — the point is to
// force a deliberate second look, not to build an unbypassable sandbox.

// Short-flag cluster containing `r` (`-r`, `-Rd`, …) — the STANDALONE half used to
// catch `-r -f` typed as two separate flags rather than one `-rf` cluster.
const SHORT_R = String.raw`(?<![-\w])-[a-zA-Z]*r[a-zA-Z]*(?![-\w])`;
// Short-flag cluster containing `f` (`-f`, `-rf`, `-fr`, `-fdx`, …). Single dash
// only — `--force` is handled separately per-rule so `--force-with-lease` lives.
const SHORT_F = String.raw`(?<![-\w])-[a-zA-Z]*f[a-zA-Z]*(?![-\w])`;
// Short-flag cluster containing BOTH `r` and `f` in either order (`-rf`, `-fr`,
// `-Rf`, `-frd`, …) — the classic `rm -rf` shape typed as ONE cluster.
const SHORT_RF = String.raw`(?<![-\w])-[a-zA-Z]*(?:r[a-zA-Z]*f|f[a-zA-Z]*r)[a-zA-Z]*(?![-\w])`;
// `--recursive`/`-r` and `--force`/`-f`, each as a standalone alternative — used to
// catch `rm -r -f`, `rm --recursive -f`, `rm -r --force` (letters split across
// separate flags, not one cluster — a perfectly ordinary way to type the command,
// not obfuscation).
const RECURSIVE_FLAG = String.raw`(?:${SHORT_R}|--recursive\b)`;
const FORCE_FLAG = String.raw`(?:${SHORT_F}|--force\b)`;
// Connector between a trigger word and its dangerous flag. Deliberately does NOT
// exclude `\n`: the harness's `!` convention explicitly supports multi-line bodies
// (bracketed paste), so a rule that only matched within one line would miss a
// pasted script with a line continuation (`rm \` / `-rf /`) — a real bypass, not
// just a theoretical one. `;`/`&`/`|` stay excluded so the scan doesn't bleed past
// a command separator into an unrelated statement.
const CONNECTOR = String.raw`[^;&|]*`;

// Each rule is [id, regex]. The id names the matched shape and is echoed back in
// the warning so a human (and a test) can see WHICH form fired.
// Every rule is case-INSENSITIVE (`i` flag): a plain-case-only regex is one Shift-key
// away from defeating the entire gate (`!Rm -rf /`, `!SUDO rm -rf /etc`, `!Git push
// --force` would otherwise inject with zero warning — not even routed through the
// `!!` confirmation UX).
export const SHELL_DANGER_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  [
    'rm-rf',
    new RegExp(
      String.raw`\brm\b${CONNECTOR}(?:${SHORT_RF}|${RECURSIVE_FLAG}${CONNECTOR}${FORCE_FLAG}|${FORCE_FLAG}${CONNECTOR}${RECURSIVE_FLAG})`,
      'i',
    ),
  ],
  // Adjacency (`sudo` directly followed by `rm`, optionally through no-value short
  // flags like `-E`) — not a loose `sudo ... rm` scan, which would also trip on
  // routine `sudo docker rm`/`sudo apt rm-tool` (the daemon's own daily-use
  // false-positive report; a gate that fires on routine ops teaches the sender to
  // reflexively type `!!` past every warning, eroding it for the shapes it exists
  // to catch).
  ['sudo-rm', new RegExp(String.raw`\bsudo\b\s+(?:-\S+\s+)*rm\b`, 'i')],
  ['reset-hard', new RegExp(String.raw`\bgit\b${CONNECTOR}\sreset\b${CONNECTOR}\s--hard\b`, 'i')],
  [
    'force-push',
    new RegExp(
      String.raw`\bgit\b${CONNECTOR}\spush\b${CONNECTOR}(?:--force(?!-with-lease)\b|${SHORT_F}|\s\+[^\s;&|]+)`,
      'i',
    ),
  ],
  ['clean-force', new RegExp(String.raw`\bgit\b${CONNECTOR}\sclean\b${CONNECTOR}(?:--force\b|${SHORT_F})`, 'i')],
  ['mkfs', /\bmkfs\b/i],
  // `(?!null\b|zero\b)` excludes the standard `dd ... of=/dev/null`/`of=/dev/zero`
  // read-benchmark/discard idioms — routine, not destructive.
  ['dd-to-device', new RegExp(String.raw`\bdd\b${CONNECTOR}\bof=\/dev\/(?!null\b|zero\b)`, 'i')],
  ['disk-redirect', />>?\s*\/dev\/(?:disk|[sh]d|nvme|rdisk|xvd|vd|mmcblk)\w*/i],
  // `:(){ :|:& };:` — whitespace-tolerant so `: ( ) { : | : & } ; :` still trips.
  ['fork-bomb', /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/],
  ['pipe-to-shell', /\b(?:curl|wget)\b[^;&]*\|\s*(?:sudo\s+)?(?:bash|sh|zsh)\b/i],
];

/** First matching rule id for `cmd`, or null when nothing trips the denylist. */
export function findShellDanger(cmd: string): string | null {
  for (const [id, rx] of SHELL_DANGER_RULES) {
    if (rx.test(cmd)) return id;
  }
  return null;
}

// `text` is the caller's `!`-prefixed Telegram message — every callsite in
// updates.ts only reaches this function after `text.startsWith('!')` already
// held, so that invariant is assumed, not re-checked here.
export function shellPassthroughGate(text: string): { injectText: string; warning: string | null } {
  const leadingBangs = /^!+/.exec(text)?.[0].length ?? 1;
  const rest = text.slice(leadingBangs);
  // 2+ leading bangs = explicit "confirm and run anyway" — COLLAPSE to exactly ONE
  // `!` (not just peel one) so the harness sees its own single-`!` passthrough
  // marker at column 0. Collapsing matters for 3+ bangs: merely peeling one would
  // leave a stray `!!cmd`/`!!!cmd` injected verbatim, and inside an interactive
  // bash session a line starting with `!` (beyond the harness's own stripped one)
  // is itself a history-expansion event designator — the shell could resolve it to
  // a DIFFERENT command from history, not the sender's literal text. The denylist
  // is deliberately NOT re-run here: doubling the bang IS the confirmation.
  if (leadingBangs >= 2) return { injectText: '!' + rest, warning: null };
  const ruleId = findShellDanger(rest);
  if (!ruleId) return { injectText: text, warning: null };
  return {
    injectText: text,
    warning:
      `blocked: this looks like a destructive command (matched rule "${ruleId}") and was NOT run.\n` +
      `If you meant it, resend it prefixed with !! to confirm and run it anyway.`,
  };
}
