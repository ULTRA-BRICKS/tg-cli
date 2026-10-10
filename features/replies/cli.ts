// `tg replies` subcommand handler. Effectful orchestration kept testable via
// dependency injection (the same pattern as features/hooks/cli.ts): the I/O
// (history file read, tmux pane detection, stdout) arrives as `deps` so the
// pure args/select/format modules can be exercised without touching disk/tmux.
//
// Returns an EXIT CODE when it handled `replies`, or null when argv[0] is not
// `replies` (the caller then falls through to the normal send path). Exact-match
// leading token only, so `tg "replies ..."` as a plain message still sends.

import { parseRepliesArgs, type AgentScope, type RepliesQuery } from './args';
import { parseHistory } from './history';
import { buildJsonOutput, collapseMultiPartSends, formatLines, selectHistory, type SessionScope } from './select';

export interface RepliesCliDeps {
  // The raw JSONL history blob, or null when the file is absent/unreadable.
  readHistory: () => string | null;
  // The current tmux pane id for default session scoping, or null when not in
  // tmux / undetectable (then the default scope degrades to all-sessions).
  detectPane: () => string | null;
  // The reader's OWN agent name — resolveSessionName().primary over the current pane's
  // window name + cwd (the SAME derivation tg-ctl stamps as targetAgent). null
  // when not in tmux / unresolvable; the default `current` scope then degrades
  // to showing untagged rows plus a note. Optional so existing callers/tests
  // that predate agent scoping keep compiling (undefined ⇒ null ⇒ untagged).
  currentAgent?: () => string | null;
  // The session registry (sessions.json) as `tg replies` needs it, with the key
  // of the reader's own session when `tg` resolved it (spec §3.3). The default
  // scope is that SESSION — across renames and panes; null (no registry / not
  // registered) falls back to the pane + `currentAgent` name.
  sessions?: () => SessionScope | null;
  // Resolve a tmux WINDOW NAME (`--session ext`) to the pane ids of every window
  // whose name exactly equals it — a union, since a name can repeat across
  // sessions. Empty when none match / not in tmux (→ a structured not-found error).
  resolveWindow: (name: string) => string[];
  // Render a unix-seconds timestamp (injected so the entrypoint uses LOCAL time
  // while tests stay deterministic).
  fmtTime: (unixSec: number) => string;
  log: (msg: string) => void;
  errlog: (msg: string) => void;
}

export const REPLIES_USAGE = `Usage: tg replies [user|agent|all] [list | find <query>] [flags]

Recall what was sent over Telegram — by default the messages YOU (the user) sent
to THIS agent session (its registry session, so a tmux window rename or an omp
/rename keeps its history together), oldest first, with timestamps, #message-ids,
and a [→ <agent>] mark showing which agent each message went to, by its current
name ([→ ?] = untagged / legacy / no target).

Direction (1st positional, default: user):
  user        only messages you sent to the agent (the default)
  agent       only messages the agent sent via tg
  all         both, prefixed ← (you) / → (agent)

Action (2nd positional, default: list):
  list                 recent messages (default)
  find <query>         case-insensitive substring search (add --regex for regex)

Agent scope (default: the CURRENT session — else this pane's window/project):
  --agent <name>       only messages for the named agent (case-insensitive); a
                       name a session had before a rename still finds it
  --all                every agent's messages (tagged and untagged)
  --untagged           only untagged messages (legacy history / no target)
                       (--agent/--all/--untagged are mutually exclusive; when the
                        current agent can't be resolved — e.g. outside tmux — the
                        default shows untagged only, with a note on stderr)

Flags:
  -n, --limit <N>      max SENDS to show (default 20) — a >4096-char split or a
                       media-group album counts as ONE send, never truncated
                       mid-send, so --json can return more than N rows when
                       the tail includes one (tg-cli#131 follow-up)
  --full               do not truncate long messages (~200 chars otherwise)
  --json               machine-readable JSON array (ts ms, id, direction, from,
                       text, pane, targetAgent, sessionKey) — one row per Telegram message_id,
                       so a multi-part send is several rows sharing one ts/text
  --regex              treat the find <query> as a regular expression
  --all-sessions       ignore the current pane; search across every session
  --session <window|paneId>
                       scope to a tmux WINDOW NAME (e.g. ext — exact match, all
                       its panes across sessions) or a pane id (e.g. %7)
  --since <date>       only messages at or after this date (inclusive)
  --until <date>       only messages at or before this date (inclusive)
  -h, --help           show this help

Date formats for --since / --until:
  2026-06-28            ISO date (midnight UTC)
  2026-06-28T10:00      ISO datetime (UTC)
  2026-06-28T10:00Z     ISO datetime with a zone (Z or ±HH:MM; seconds/fractions ok)
  3d / 24h / 7d         relative — N days or hours ago from now

Line format:  [YYYY-MM-DD HH:MM] #<id> [→ <agent>] <text>
Examples:
  tg replies                               # what you sent to THIS agent
  tg replies all                           # full back-and-forth for this agent
  tg replies --all                         # every agent's inbound messages
  tg replies --agent rig                   # messages routed to the "rig" agent
  tg replies --untagged                    # legacy / no-target messages only
  tg replies --session ext                 # messages in the tmux window named "ext"
  tg replies user find deploy              # your messages mentioning "deploy"
  tg replies agent --all --all-sessions    # everything the agents have sent, anywhere
  tg replies user --since 2026-06-28       # your messages from June 28 onward
  tg replies user --since 3d              # your messages in the last 3 days
  tg replies all --since 2026-06-28 --until 2026-06-30  # a date range`;

// The effective pane scope: a set of pane ids, null for "all sessions" (no
// scope), or a structured error when a named window can't be resolved.
type Scope = { panes: string[] | null } | { error: string };

// Resolve `--session` / `--all-sessions` / the detected pane into a pane SET:
//   • --all-sessions        → null (no scope)
//   • --session %7          → [%7]            (a `%`-prefixed arg is a pane id)
//   • --session ext         → resolveWindow('ext') (its panes; ERROR if none)
//   • no --session, explicit agent scope (--all/--agent/--untagged) → null
//        The AGENT filter is the requested axis; a leftover current-pane default
//        would wrongly hide another agent's messages (they were routed to ITS
//        pane, not the reader's). So an explicit agent scope drops the pane
//        default and lets the agent filter do the scoping.
//   • no --session, default `current` scope → [detectedPane] or null (not in tmux)
//        Kept as a sensible per-session default: the current pane ≈ the current
//        agent, and the `current` agent filter narrows within it. Dropped when
//        the reader's registry session is known: the session key IS the scope,
//        and a pane filter would hide its rows from a previous pane or process.
// A `%`-prefixed value is treated as a pane id verbatim (backward compatible);
// anything else is a tmux window NAME resolved to its pane-id set.
function resolveScope(parsed: RepliesQuery, deps: RepliesCliDeps, ownSession: boolean): Scope {
  if (parsed.allSessions) return { panes: null };
  const sess = parsed.session;
  if (sess === undefined) {
    if (parsed.agentScope.mode !== 'current' || ownSession) return { panes: null };
    const detected = deps.detectPane();
    return { panes: detected ? [detected] : null };
  }
  if (sess.startsWith('%')) return { panes: [sess] };
  const panes = deps.resolveWindow(sess);
  if (panes.length === 0) return { error: `no tmux window named '${sess}'` };
  return { panes };
}

// A human label for the empty-result note describing the AGENT scope searched:
// ` for agent 'rig'` (current/named), ` (untagged)`, or '' for --all.
function agentScopeSuffix(scope: AgentScope, currentAgent: string | null): string {
  switch (scope.mode) {
    case 'all':
      return '';
    case 'untagged':
      return ' (untagged)';
    case 'named':
      return ` for agent '${scope.name}'`;
    case 'current':
      return currentAgent === null ? ' (untagged)' : ` for agent '${currentAgent}'`;
  }
}

// A human label for the empty-result note, matching how the scope was requested:
// a window name, a pane id, or nothing for all-sessions.
function scopeSuffix(parsed: RepliesQuery, panes: string[] | null): string {
  if (panes === null) return '';
  const sess = parsed.session;
  if (sess !== undefined && !sess.startsWith('%')) return ` in window '${sess}'`;
  return panes.length === 1 ? ` in pane ${panes[0]}` : '';
}

export function runReplies(argv: string[], deps: RepliesCliDeps): number | null {
  if (argv[0] !== 'replies') return null;

  const parsed = parseRepliesArgs(argv.slice(1));
  if (parsed.kind === 'help') {
    deps.log(REPLIES_USAGE);
    return 0;
  }
  if (parsed.kind === 'error') {
    deps.errlog(`tg replies: ${parsed.message}`);
    return 1;
  }

  // The registry view and the reader's own session in it (null when unknown).
  const sessions = deps.sessions?.() ?? null;
  const own = sessions?.sessions.find((s) => s.key === sessions.current) ?? null;

  const scope = resolveScope(parsed, deps, own !== null);
  if ('error' in scope) {
    deps.errlog(`tg replies: ${scope.error}`);
    return 1;
  }
  const panes = scope.panes;

  const records = parseHistory(deps.readHistory());

  // The reader's own agent name — its session's current name, else the tmux
  // pane's; the `current` scope falls back to filtering on it.
  const paneAgent = deps.currentAgent?.() ?? null;
  const currentAgent = own?.name ?? paneAgent;
  // When the reader can't tell which agent it is AND no explicit agent scope was
  // given, `current` degrades to untagged (see filterByAgent); tell the user why
  // so an empty/partial view isn't mistaken for "no messages".
  if (parsed.agentScope.mode === 'current' && currentAgent === null) {
    deps.errlog(
      'tg replies: could not determine the current agent (not in tmux?) — showing untagged messages only; use --agent <name> or --all',
    );
  }

  let selected;
  try {
    selected = selectHistory(records, parsed, panes, paneAgent, sessions);
  } catch (err) {
    // The only throw is an invalid regex from searchHistory.
    deps.errlog(`tg replies: invalid regex: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  if (parsed.json) {
    // Every outbound message_id, uncollapsed — a multi-part send's chunks/
    // album-items each keep their own row so `select(.id == <tg#>)` can find
    // any of them (tg-cli#131).
    deps.log(JSON.stringify(buildJsonOutput(selected)));
    return 0;
  }

  // The plain listing collapses a multi-part send back to ONE line (see
  // collapseMultiPartSends) — emptiness is unaffected by collapsing.
  const displayed = collapseMultiPartSends(selected);
  if (displayed.length === 0) {
    const suffix = scopeSuffix(parsed, panes);
    const what = parsed.action === 'find' ? ` matching "${parsed.query}"` : '';
    const agentSuffix = agentScopeSuffix(parsed.agentScope, currentAgent);
    deps.log(`no ${parsed.direction === 'all' ? '' : parsed.direction + ' '}messages${what}${agentSuffix}${suffix}.`);
    return 0;
  }

  for (const line of formatLines(displayed, {
    direction: parsed.direction,
    full: parsed.full,
    fmtTime: deps.fmtTime,
    names: new Map(sessions?.sessions.map((s) => [s.key, s.name]) ?? []),
  })) {
    deps.log(line);
  }
  return 0;
}
