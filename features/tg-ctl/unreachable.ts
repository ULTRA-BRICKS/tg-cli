// Agents running OUTSIDE tmux (tg-cli#306, tg-cli#456): discovery from the process
// table, the inbox KEY shared with agent-tools, and the human-facing texts (status
// lines, the no-agent listing, the `/agent` refusal).
//
// PURE — the tg-ctl entrypoint runs `ps -axo pid=,tty=` / `lsof -a -p <pid> -d cwd -Fn`
// and hands the raw stdout here. Everything below is plain data work.
//
// WHY: tg-ctl discovers agents via `tmux list-panes` and delivers via `tmux send-keys`,
// so an interactive `claude`/`codex`/`opencode` started from a plain terminal tab does
// not exist for it — silently (incident 2026-09-05: agents `landing` and `rig-fable`).
// This module makes such agents VISIBLE (status + the no-agent reply list them as
// unreachable with the reason) and turns `/agent <name> …` to one into a one-line
// refusal naming how to start it under the rig wrapper or inside tmux. Outside tmux only omp
// (through omp-live, omp.ts) and sessions a rig wrapper hosts in abduco (host-registry.ts) are
// reachable (tg-cli#456, CTO 2026-09-29; harness-agnostic control 2026-09-30).
// The Stop-hook inbox that used to carry `/agent` text to them delivered only at the
// agent's next turn end, so an idle session never got it (17 messages stranded).
//
// THE INBOX KEY CONTRACT (shared with agent-tools `lib/agenttools_tg_inbox` — the two
// implementations MUST stay byte-identical, both READMEs document it). tg-ctl still
// derives it for the grant route identity (grants.ts `inbox:<key>`) and for omp's
// grant-notice fallback, which the omp Stop bridge consumes at its next yield — both
// ALWAYS take the cwd form (grants.ts grantInboxKey): omp has no `--name`, and a subagent
// label two projects share must never key a grant notice (tg-cli#433):
//   key = sanitized(--name value)                  when the agent argv carries `--name X`
//       = "cwd-" + sha256(cwd)[:16] (hex)          otherwise
//   sanitized(x) = every char outside [A-Za-z0-9._-] → "_", truncated to 64 chars;
//                  an empty result counts as "no name".
//   cwd is the agent process's working directory with trailing "/" stripped ("/" stays).
//   inbox dir = <tg-cli config dir>/inbox/<key>/   (config dir = $TG_CTL_CONFIG_DIR or
//               ~/.config/tg-cli) — file layout in inbox.ts

import { createHash } from 'crypto';
import type { AgentKind, PaneInfo, ProcInfo } from './types';
import { matchAgentCommand } from './discover';

export interface UnreachableAgent {
  pid: number;
  agent: AgentKind;
  tty: string | null;
  command: string;
  name: string | null; // the `--name` value as typed (unsanitized), null when absent
  cwd: string | null; // resolved by the caller (lsof); null when unresolvable
}

// "No controlling terminal" sentinels `ps` prints for the tty column: `?` (Linux),
// `??` (macOS), `-` (some BSDs). Shared by `parsePidTtyList` (drops these rows outright)
// and `normalizeTty` (collapses them to a display `null`) so the two can't silently
// diverge on what counts as "no tty".
const NO_TTY_SENTINELS = new Set(['?', '??', '-']);

// `ps -axo pid=,tty=` → pid → tty. A sentinel tty (see `NO_TTY_SENTINELS`) means NO
// controlling terminal (a daemon, a `-p` run under a tool, a launchd child) and is
// dropped. Lines with extra tokens are skipped — this keeps the parser inert against
// the legacy 3-column fake `ps` scripts the integration suite ships (they ignore
// their argv and print `pid ppid command`), so those tests see no tty map at all.
export function parsePidTtyList(out: string): Map<number, string> {
  const ttyByPid = new Map<number, string>();
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s*$/);
    if (!m) continue;
    const tty = m[2];
    if (NO_TTY_SENTINELS.has(tty)) continue;
    ttyByPid.set(Number(m[1]), tty);
  }
  return ttyByPid;
}

// Normalize a raw `ttyByPid` value into a display/gating value: no map entry, or any
// `NO_TTY_SENTINELS` value, collapses to null. Shared by `findUnreachableAgents` here and
// `findLiveOmpAgents` in `omp.ts` so the sentinel list can't silently diverge between the
// two discovery paths — and so a caller that hands either function a RAW, un-parsed map
// (as `ctl-omp-acp.test.ts` already does for `findLiveOmpAgents`) gets the same sentinel
// treatment `parsePidTtyList` would have applied, both for display AND for gating.
export function normalizeTty(tty: string | undefined): string | null {
  return tty && !NO_TTY_SENTINELS.has(tty) ? tty : null;
}

// `lsof -a -p <pid> -d cwd -Fn` prints field lines: `p<pid>`, `fcwd`, `n<path>`.
// Returns the first `n` path, or null when lsof printed nothing usable.
export function parseLsofCwd(out: string): string | null {
  for (const line of out.split('\n')) {
    if (line.startsWith('n') && line.length > 1) return line.slice(1).replace(/\r$/, '');
  }
  return null;
}

// The `--name <value>` / `--name=<value>` an interactive Claude Code session was
// started with (undocumented in `claude --help`, but it is what `tg-ctl` labels a tmux
// pane by and what the user types to address the agent). Returns the value AS TYPED;
// `agentInboxKey` sanitizes it. Null when absent or when the flag has no value.
// `ps` flattens argv into one space-joined string, so a multi-word value (`--name "my
// agent"`) yields only its FIRST word — the Python reader in agent-tools reads the same
// flattened `ps -o args=` line and splits the same way, so both sides agree on `my`.
export function parseAgentNameFromCommand(command: string): string | null {
  const tokens = command.trim().split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--name') {
      const v = tokens[i + 1];
      return v && !v.startsWith('-') ? v : null;
    }
    if (t.startsWith('--name=')) {
      const v = t.slice('--name='.length);
      return v ? v : null;
    }
  }
  return null;
}

// Sanitize a `--name` value into a filesystem-safe key segment. Empty → null. A value
// made only of dots (`.`, `..`) is null too: dots are allowed characters, so it would
// otherwise survive and resolve `inbox/<key>` to the inbox root or its PARENT — this is
// the single gate between a user-typed value and a path (review finding).
export function sanitizeAgentName(name: string): string | null {
  const s = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  if (!s || /^\.+$/.test(s)) return null;
  return s;
}

function normalizeCwd(cwd: string): string {
  const stripped = cwd.replace(/\/+$/, '');
  return stripped ? stripped : '/';
}

// THE shared key (see the contract at the top of this file).
export function agentInboxKey(name: string | null | undefined, cwd: string): string {
  const safe = name ? sanitizeAgentName(name) : null;
  if (safe) return safe;
  const digest = createHash('sha256').update(normalizeCwd(cwd), 'utf8').digest('hex');
  return `cwd-${digest.slice(0, 16)}`;
}

// Per-harness command-line shapes. The CLIs disagree on what a token means — `-p` is
// `--print` (headless) for claude but `--profile <name>` (interactive) for codex — so
// the tables are keyed by the resolved binary, never merged, and `shapeFor` is an
// exhaustive switch over AgentKind: a new harness fails to compile until it gets a row.
interface CommandShape {
  headlessOptions: Set<string>; // an option that makes the run a one-shot / helper
  headlessSubcommands: Set<string>; // the FIRST positional word with the same meaning
  valueOptions: Set<string>; // options that ALWAYS take a value — the value is skipped
  // True when this harness's headless/one-shot shapes are enumerated above, so
  // `isInteractiveAgentCommand` alone can tell a genuinely interactive session apart
  // from a cron/launchd one-shot. False (ALWAYS_INTERACTIVE_SHAPE) means tg-ctl has NO
  // per-shape headless detection for this kind — a controlling tty remains the only
  // signal `findUnreachableAgents` has, so it is still required there (tg-cli#413
  // follow-up: removing the tty requirement is only safe for a headless-aware shape).
  headlessAware: boolean;
}
// tg-ctl's own launcher flags, understood by every harness row (`rig harness run` passes
// `--name <label>` to whichever binary it starts): applied on top of each shape so a
// label like `daemon`/`exec`/`run` is never read as a subcommand.
const LAUNCHER_VALUE_OPTIONS = new Set(['--name']);
const CLAUDE_SHAPE: CommandShape = {
  headlessAware: true,
  headlessOptions: new Set(['--print', '-p', '--bg', '--background']),
  // `mcp` mirrors codex/opencode's own row below — `claude mcp serve`/`claude mcp list`
  // are one-shot/server subcommands, never the interactive TUI (tg-cli#413 follow-up
  // review: this table is now load-bearing for headless-aware kinds, not just a tty
  // tie-breaker, so a missing row here is a false-positive unreachable listing, not
  // merely a missed tty-present one).
  headlessSubcommands: new Set(['daemon', 'bg-pty-host', 'bg-spare', 'mcp']),
  // `-r/--resume [id]` and `-w/--worktree [name]` take an OPTIONAL value (verified in
  // `claude --help`), so they are deliberately NOT here: a value-less `-w` followed by a
  // real subcommand must still reach that subcommand. Their optional value is a plain
  // positional and never a headless subcommand name in practice.
  valueOptions: new Set([
    '--model', '--session-id', '--add-dir', '--permission-mode', '--append-system-prompt',
    '--system-prompt', '--allowedTools', '--disallowedTools', '--mcp-config', '--settings',
    '--output-format', '--input-format', '--max-turns', '--agent', '--agents', '--fallback-model',
  ]),
};
const CODEX_SHAPE: CommandShape = {
  headlessAware: true,
  headlessOptions: new Set<string>(),
  headlessSubcommands: new Set(['exec', 'e', 'login', 'logout', 'mcp', 'app-server', 'apply', 'completion', 'debug', 'sandbox', 'features']),
  valueOptions: new Set(['-c', '--config', '-m', '--model', '-p', '--profile', '-s', '--sandbox', '-a', '--ask-for-approval', '-C', '--cd', '--add-dir', '-i', '--image']),
};
const OPENCODE_SHAPE: CommandShape = {
  headlessAware: true,
  headlessOptions: new Set<string>(),
  headlessSubcommands: new Set(['run', 'serve', 'web', 'acp', 'auth', 'agent', 'upgrade', 'export', 'import', 'github', 'models', 'stats', 'mcp']),
  valueOptions: new Set(['-m', '--model', '--agent', '-s', '--session', '--port', '--hostname', '--prompt']),
};
// Harnesses tg-ctl knows only by name (no headless mode it can tell apart): every
// invocation with a tty counts as interactive. Not headless-aware — `findUnreachableAgents`
// keeps requiring a real tty map entry for these kinds (pi/aider/omp/unknown), since a tty
// is the only signal that separates a live session from a one-shot cron/launchd invocation.
const ALWAYS_INTERACTIVE_SHAPE: CommandShape = {
  headlessAware: false,
  headlessOptions: new Set<string>(),
  headlessSubcommands: new Set<string>(),
  valueOptions: new Set<string>(),
};
function assertNever(x: never): never {
  throw new Error(`unhandled AgentKind: ${String(x)}`);
}
function shapeFor(agent: AgentKind): CommandShape {
  switch (agent) {
    case 'claude':
      return CLAUDE_SHAPE;
    case 'codex':
      return CODEX_SHAPE;
    case 'opencode':
      return OPENCODE_SHAPE;
    case 'pi':
    case 'aider':
    case 'omp':
    case 'unknown':
      return ALWAYS_INTERACTIVE_SHAPE;
    default:
      return assertNever(agent);
  }
}

// Only the REAL option / subcommand positions count: an agent CLI accepts an arbitrary
// initial prompt, so `claude "please exec tests"` must stay interactive. Scanning stops
// at `--`; a positional is checked only when it is the first one (the subcommand slot);
// a path-like positional is skipped so the launcher shape `node …/claude daemon` still
// reaches its real subcommand; the value of a value-taking option is skipped so
// `--name daemon` / `codex -p work` are never mistaken for a subcommand or a flag.
export function isInteractiveAgentCommand(command: string, agent: AgentKind): boolean {
  const shape = shapeFor(agent);
  const tokens = command.trim().split(/\s+/).slice(1);
  let sawPositional = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--') break;
    if (t.startsWith('-')) {
      if (shape.headlessOptions.has(t)) return false;
      if (shape.valueOptions.has(t) || LAUNCHER_VALUE_OPTIONS.has(t)) i++;
      continue;
    }
    if (t.includes('/')) continue;
    if (!sawPositional) {
      sawPositional = true;
      if (shape.headlessSubcommands.has(t)) return false;
    }
  }
  return true;
}

// Every pid that lives UNDER some tmux pane (the pane process itself + all its
// descendants) — those agents are reachable via send-keys and are never "unreachable".
function pidsUnderPanes(panes: PaneInfo[], procs: ProcInfo[]): Set<number> {
  const byPpid = new Map<number, number[]>();
  for (const p of procs) {
    const kids = byPpid.get(p.ppid);
    if (kids) kids.push(p.pid);
    else byPpid.set(p.ppid, [p.pid]);
  }
  const covered = new Set<number>();
  for (const pane of panes) {
    const queue = [pane.panePid];
    while (queue.length > 0) {
      const pid = queue.shift()!;
      if (covered.has(pid)) continue;
      covered.add(pid);
      for (const kid of byPpid.get(pid) ?? []) queue.push(kid);
    }
  }
  return covered;
}

// Interactive agent processes that sit in NO tmux pane's process tree. A proc whose
// IMMEDIATE PARENT is itself a matched agent (a `node …/claude` launcher wrapping the
// real binary) is folded into that parent, so a wrapper + binary pair yields one agent,
// not two. Only the direct parent counts: a session started from another agent's shell
// tool (a nested `claude` a few hops below a `claude`) is a DISTINCT agent and must stay
// listed — verified live: the first cut folded on any ancestor and hid exactly the test
// session (tg-cli#306).
//
// Past bug (tg-cli#413 follow-up): for claude/codex/opencode this used to additionally
// require a `ttyByPid` entry ("drop anything with no controlling terminal"), which
// silently dropped a genuinely live, fully headless session (launched detached, no tty
// at all — e.g. under launchd/a daemon supervisor) even though listing it (and naming
// it in the `/agent` refusal) never needs a tty: pid/cwd/name only.
// `isInteractiveAgentCommand` already independently excludes headless CLI *shapes*
// (`--print`, `daemon`, `exec`, …) for those three harnesses, so the tty requirement
// added nothing but a silent drop THERE. A tty is still required for pi/aider/omp/unknown
// (`ALWAYS_INTERACTIVE_SHAPE`, `headlessAware: false`): tg-ctl has no per-shape headless
// detection for them, so a real tty remains the only signal that separates a live session
// from a one-shot cron/launchd invocation. `ttyByPid` is otherwise consulted only to fill
// the optional display field, mirroring the sibling `findLiveOmpAgents` in `omp.ts`.
// `cwd` is left null — the caller resolves it (lsof) because it is I/O.
export function findUnreachableAgents(
  panes: PaneInfo[],
  procs: ProcInfo[],
  ttyByPid: Map<number, string>,
): UnreachableAgent[] {
  const covered = pidsUnderPanes(panes, procs);
  const byPid = new Map<number, ProcInfo>();
  for (const p of procs) byPid.set(p.pid, p);
  const matched = new Map<number, AgentKind>();
  for (const p of procs) {
    if (covered.has(p.pid)) continue;
    const agent = matchAgentCommand(p.command);
    if (!agent || !isInteractiveAgentCommand(p.command, agent)) continue;
    const needsTty = !shapeFor(agent).headlessAware;
    if (needsTty && normalizeTty(ttyByPid.get(p.pid)) === null) continue;
    matched.set(p.pid, agent);
  }
  const out: UnreachableAgent[] = [];
  for (const [pid, agent] of matched) {
    const proc = byPid.get(pid)!;
    if (matched.has(proc.ppid)) continue; // the binary under its own launcher wrapper
    out.push({
      pid,
      agent,
      tty: normalizeTty(ttyByPid.get(pid)),
      command: proc.command,
      name: parseAgentNameFromCommand(proc.command),
      cwd: null,
    });
  }
  return out.sort((a, b) => a.pid - b.pid);
}

function cwdBasename(path: string | null): string {
  if (!path) return '';
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

// The human label — the `--name` when given, else the cwd project dir: the SAME
// fallback tier `resolveSessionName` uses for a tmux pane whose window name is
// bare, so an agent is called the same thing whether or not it sits in tmux. An
// unnamed agent whose cwd could not be resolved is named by its pid (cwdBasename
// yields '' there, which `??` would NOT fall through — hence the `|| null`).
export function unreachableLabel(a: UnreachableAgent): string {
  return a.name ?? (cwdBasename(a.cwd) || null) ?? `pid ${a.pid}`;
}

// Match a typed `/agent <selector>` against unreachable agents: exact (case-insensitive)
// on the `--name`, then on the cwd basename. STRICT on purpose — this is the fallback
// consulted only after no tmux pane matched, and the refusal names a specific session,
// so no fuzzy tier here.
export function matchUnreachable(selector: string, agents: UnreachableAgent[]): UnreachableAgent[] {
  const sel = selector.trim().toLowerCase();
  if (!sel) return [];
  const byName = agents.filter((a) => a.name !== null && a.name.toLowerCase() === sel);
  if (byName.length > 0) return byName;
  return agents.filter((a) => cwdBasename(a.cwd).toLowerCase() === sel);
}

// One status line per unreachable agent (used by `tg-ctl status` and /status).
export function describeUnreachable(a: UnreachableAgent): string {
  const parts = [`tty ${a.tty ?? 'none'}`, `cwd ${a.cwd ?? '?'}`, `name ${a.name ?? '-'}`, `pid ${a.pid}`];
  return `${unreachableLabel(a)} · ${a.agent} — unreachable: not in tmux (${parts.join(', ')})`;
}

export const UNREACHABLE_HINT =
  'Not reachable — started outside tmux and outside the rig wrapper. ' +
  'Restart it with `rig harness run <harness> --name <label>` (or in a tmux window: `tmux new-window -n <label> <harness>`).';

// The reply for a message that could not be injected anywhere. With unreachable agents
// present it LISTS them (the whole point of #306: never a silent drop, never a bare
// "not in tmux" when the agent is right there); without any it is the legacy text.
export function noAgentReplyText(legacy: string, agents: UnreachableAgent[]): string {
  if (agents.length === 0) return legacy;
  const lines = agents.map((a) => `  - ${describeUnreachable(a)}`);
  return `No agent in tmux. Running OUTSIDE tmux (unreachable):\n${lines.join('\n')}\n${UNREACHABLE_HINT}`;
}

// A label as one POSIX shell word: bare when it has no shell metacharacters, else
// single-quoted with each embedded `'` spelled `'\''`.
function shellWord(s: string): string {
  return /^[A-Za-z0-9._@%+=:,/-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

// How to restart this agent under the rig wrapper, which hosts it in abduco where tg-ctl can
// type into its PTY (docs/specs/2026-09-30-harness-agnostic-control.md §5). Named like the
// agent is listed; a placeholder when neither --name nor cwd is known.
const WRAPPER_HARNESSES: ReadonlySet<string> = new Set(['omp', 'claude', 'codex', 'opencode']);
export function restartCommand(a: UnreachableAgent): string {
  const label = a.name ?? (cwdBasename(a.cwd) || null);
  const name = label === null ? '<label>' : shellWord(label);
  // The wrapper hosts exactly these; any other kind can only be restarted in a tmux window.
  return WRAPPER_HARNESSES.has(a.agent) ? `rig harness run ${a.agent} --name ${name}` : `tmux new-window -n ${name} ${a.agent}`;
}

// The ONE-line reply to `/agent <selector> …` that matched only agents outside tmux and
// outside the rig wrapper (tg-cli#456): who it is, that nothing was sent or queued, and how
// to restart it so it becomes reachable.
export function outsideTmuxRefusalText(selector: string, hits: UnreachableAgent[]): string {
  const who =
    hits.length === 1
      ? `${unreachableLabel(hits[0])} · ${hits[0].agent} runs outside tmux`
      : `'${selector}' matches ${hits.length} sessions outside tmux (${hits.map((a) => `${unreachableLabel(a)} · ${a.agent} pid ${a.pid}`).join(', ')})`;
  const restarts = [...new Set(hits.map(restartCommand))].join(' or ');
  return (
    `${who} and outside the rig wrapper — Telegram cannot reach ${hits.length === 1 ? 'it' : 'them'} there, ` +
    `so nothing was sent or queued. Restart it with: ${restarts}${restarts.includes('rig harness run') ? ' (or in a tmux window)' : ''}`
  );
}
