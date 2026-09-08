// tmux pane discovery for tg-ctl (spec §5.2 target discovery, §10 ambiguity).
//
// Everything here is PURE — the tg-ctl entrypoint runs
//   tmux list-panes -a -F '#{session_name}\t#{window_index}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{window_name}\t#{pane_current_path}'
//   ps -axo pid=,ppid=,command=
// and hands the raw stdout to these parsers. Picking the injection target from
// the parsed snapshots is plain data work, trivially unit-testable.

import type {
  AgentKind,
  DiscoverResult,
  PaneInfo,
  ProcInfo,
  Registration,
  TargetPane,
} from './types';

// Tab-separated on purpose: pane_current_path may contain spaces, and tmux
// format fields never contain tabs. Malformed lines are skipped, not fatal —
// a half-broken snapshot should degrade to "fewer candidates", never crash.
export function parsePaneList(out: string): PaneInfo[] {
  const panes: PaneInfo[] = [];
  for (const rawLine of out.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const windowIndex = Number(parts[1]);
    const panePid = Number(parts[3]);
    if (!Number.isInteger(windowIndex) || !Number.isInteger(panePid)) continue;
    // Field layout: session, window_index, pane_id, pane_pid, command, window_name, [spawn_token,]
    // path(greedy). The `@tg_spawn_token` field (index 6) is the forum-topics increment-4 addition.
    // Accept BOTH the 8-field shape (token at index 6) and the legacy 7-field shape (no token field).
    // DISAMBIGUATION (codex r12 P2): a 7-field line whose PATH contains a literal tab ALSO yields 8+
    // parts — but its parts[6] is a path fragment, NOT a token. Our tokens have fixed shapes
    // (`<threadId>-<unixSec>-<nonce>` for topic spawns, `new-<sessionToken>-<unixSec>` for flat
    // /new spawns) and an unset option is ''. So treat parts[6] as a token ONLY when it is '' or
    // matches one of those shapes; otherwise it's a tab-split path (legacy) and the path is the
    // greedy tail from index 6.
    const tokenField = parts.length >= 8 ? parts[6] : undefined;
    const looksLikeToken =
      tokenField !== undefined && (tokenField === '' || /^\d+-\d+-\d+$/.test(tokenField) || /^new-[A-Za-z0-9_-]+-\d+$/.test(tokenField));
    panes.push({
      sessionName: parts[0],
      windowIndex,
      paneId: parts[2],
      panePid,
      paneCommand: parts[4],
      windowName: parts[5],
      spawnToken: looksLikeToken ? (tokenField as string) : '',
      // The path is the greedy tail (it CAN contain a tab) so it stays LAST and rejoins the rest.
      panePath: (looksLikeToken ? parts.slice(7) : parts.slice(6)).join('\t'),
    });
  }
  return panes;
}

// `ps -axo pid=,ppid=,command=`: two right-aligned ints, then the command line
// (which freely contains spaces) to the end of the line.
export function parseProcList(out: string): ProcInfo[] {
  const procs: ProcInfo[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S.*)$/);
    if (!m) continue;
    procs.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  return procs;
}

function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

// Match a single process command line to an agent. Shells (-zsh, bash, …) and
// everything else fall through to null — they are traversed, never matched.
export function matchAgentCommand(command: string): AgentKind | null {
  const trimmed = command.trim();
  const argv0 = trimmed.split(/\s+/, 1)[0] ?? '';
  const base = basename(argv0);
  // claude also matches via a wrapper argv0 (e.g. `node …/.claude/local/claude --resume`).
  if (
    base === 'claude' ||
    trimmed === 'claude' ||
    trimmed.startsWith('claude ') ||
    trimmed.includes('/claude ')
  ) {
    return 'claude';
  }
  if (base === 'opencode' || base === 'opencode.exe') return 'opencode';
  if (base === 'codex') return 'codex';
  if (base === 'pi') return 'pi';
  if (base === 'aider') return 'aider';
  // omp (Oh My Pi) is a compiled Bun binary — its argv0 basename is literally
  // 'omp' (e.g. /opt/homebrew/bin/omp). One row feeds every inbound gate
  // (findAgentInPane BFS, inject verify-pane, reply-route liveness) AND the
  // outbound ancestry branding (findAgentInAncestry). EXACT basename only:
  // a merely-containing binary ('ompi-info') never matches. Worker helpers
  // (`__omp_worker_daemon_broker`, `__omp_worker_js_eval_process`) share the
  // same argv0 — they are not the user session (243 still matches the TUI).
  if (base === 'omp') {
    if (/\b__omp_worker_/.test(trimmed)) return null;
    return 'omp';
  }
  return null;
}

// CRITICAL repo fact (verified live on CC 2.1.150): a Claude Code pane reports
// its VERSION string (e.g. '2.1.150') as pane_current_command, NOT 'claude'.
// Pane-command matching therefore does NOT work for cc — only walking the
// process tree under pane_pid does. BFS includes pane_pid itself (an agent
// launched directly by tmux IS the pane process) and stops at the first match,
// so the shallowest agent wins. A visited set guards against pid-reuse
// artifacts in the ps snapshot.
export function findAgentInPane(
  pane: PaneInfo,
  procs: ProcInfo[],
): { agent: AgentKind; pid?: number } | null {
  const byPid = new Map<number, ProcInfo>();
  const byPpid = new Map<number, ProcInfo[]>();
  for (const p of procs) {
    byPid.set(p.pid, p);
    const siblings = byPpid.get(p.ppid);
    if (siblings) siblings.push(p);
    else byPpid.set(p.ppid, [p]);
  }

  const queue: number[] = [pane.panePid];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const proc = byPid.get(pid);
    if (proc) {
      const agent = matchAgentCommand(proc.command);
      if (agent) return { agent, pid: proc.pid };
    }
    for (const child of byPpid.get(pid) ?? []) queue.push(child.pid);
  }
  return null;
}

// Walk UP the ppid chain from `startPid`, returning the nearest ancestor that
// matches an agent. This is the outbound mirror of findAgentInPane (which walks
// DOWN to a pane's children): when `tg` runs, it asks "which agent launched
// me?" by climbing its own ancestry. Codex/aider/pi/omp export no env marker
// (only Claude Code sets CLAUDECODE), so the process tree is the reliable signal —
// and a background ollama daemon is a sibling, never an ancestor, so it is
// correctly ignored. The visited set guards against pid-reuse cycles in the
// ps snapshot, matching findAgentInPane's robustness.
export function findAgentInAncestry(
  procs: ProcInfo[],
  startPid: number,
): { agent: AgentKind; pid: number } | null {
  const byPid = new Map<number, ProcInfo>();
  for (const p of procs) byPid.set(p.pid, p);

  const seen = new Set<number>();
  let pid: number | undefined = startPid;
  while (pid !== undefined && pid > 1 && !seen.has(pid)) {
    seen.add(pid);
    const proc = byPid.get(pid);
    if (!proc) break;
    const agent = matchAgentCommand(proc.command);
    if (agent) return { agent, pid: proc.pid };
    pid = proc.ppid;
  }
  return null;
}

// Pick the injection target (spec §10 priority chain):
//   1. registration paneId — but only if that pane STILL hosts an agent
//      (the snapshot may be minutes old; never inject into a bare shell);
//   2. fixed `control.session` — sole agent pane there wins, several there
//      is already ambiguous (the user pinned the session on purpose);
//   3. registration cwd === pane_current_path;
//   4. the sole agent pane on the whole tmux server.
// Each tier falls through when it matches nothing; a tier matching several
// panes returns 'ambiguous' with ITS narrowed candidates so the TG reply can
// name the realistic choices.
export function pickTargetPane(
  panes: PaneInfo[],
  procs: ProcInfo[],
  reg: Registration | null,
  fixedSession?: string,
): DiscoverResult {
  const candidates: TargetPane[] = [];
  for (const pane of panes) {
    const found = findAgentInPane(pane, procs);
    if (found) candidates.push({ pane, agent: found.agent, agentPid: found.pid });
  }

  if (reg?.paneId) {
    const hit = candidates.find((c) => c.pane.paneId === reg.paneId);
    if (hit) return { ok: true, target: hit };
  }

  if (fixedSession) {
    const inSession = candidates.filter((c) => c.pane.sessionName === fixedSession);
    if (inSession.length === 1) return { ok: true, target: inSession[0] };
    if (inSession.length > 1) return { ok: false, reason: 'ambiguous', candidates: inSession };
  }

  if (reg?.cwd) {
    const byCwd = candidates.filter((c) => c.pane.panePath === reg.cwd);
    if (byCwd.length === 1) return { ok: true, target: byCwd[0] };
    if (byCwd.length > 1) return { ok: false, reason: 'ambiguous', candidates: byCwd };
  }

  if (candidates.length === 1) return { ok: true, target: candidates[0] };
  if (candidates.length > 1) return { ok: false, reason: 'ambiguous', candidates };
  return { ok: false, reason: 'no-agent', candidates: [] };
}

// Set-aware target picker (tg-cli#67): the same §10 priority chain, but tier 1
// ("registration paneId") and tier 3 ("registration cwd") match against the
// per-pane registration SET instead of a single global slot. Behavior with ONE
// registered entry is byte-identical to pickTargetPane(reg); with SEVERAL
// registered live agent panes a tier returns 'ambiguous' (its narrowed
// candidates) rather than silently picking — a FRESH non-reply inbound to
// multiple registered agents is genuinely ambiguous, and disambiguating it is
// forum-topics' job, not this picker's (#67 scope note). The recognized-reply
// path (#55) and the unscoped fail-closed (#49) live in the daemon's routing
// above this and are unaffected.
export function pickTargetPaneFromSet(
  panes: PaneInfo[],
  procs: ProcInfo[],
  regs: Registration[],
  fixedSession?: string,
): DiscoverResult {
  const candidates: TargetPane[] = [];
  for (const pane of panes) {
    const found = findAgentInPane(pane, procs);
    if (found) candidates.push({ pane, agent: found.agent, agentPid: found.pid });
  }

  // Tier 1: live agent panes that ARE registered (paneId in the set). One → pick;
  // several → ambiguous among exactly those (never auto-collapse onto one).
  const registeredPaneIds = new Set(regs.map((r) => r.paneId).filter((p): p is string => !!p));
  if (registeredPaneIds.size > 0) {
    const hits = candidates.filter((c) => registeredPaneIds.has(c.pane.paneId));
    if (hits.length === 1) return { ok: true, target: hits[0] };
    if (hits.length > 1) return { ok: false, reason: 'ambiguous', candidates: hits };
  }

  if (fixedSession) {
    const inSession = candidates.filter((c) => c.pane.sessionName === fixedSession);
    if (inSession.length === 1) return { ok: true, target: inSession[0] };
    if (inSession.length > 1) return { ok: false, reason: 'ambiguous', candidates: inSession };
  }

  // Tier 3: panes whose path matches ANY registered entry's cwd (the paneless /
  // legacy fallback entries route here).
  const registeredCwds = new Set(regs.map((r) => r.cwd).filter((c): c is string => !!c));
  if (registeredCwds.size > 0) {
    const byCwd = candidates.filter((c) => registeredCwds.has(c.pane.panePath));
    if (byCwd.length === 1) return { ok: true, target: byCwd[0] };
    if (byCwd.length > 1) return { ok: false, reason: 'ambiguous', candidates: byCwd };
  }

  if (candidates.length === 1) return { ok: true, target: candidates[0] };
  if (candidates.length > 1) return { ok: false, reason: 'ambiguous', candidates };
  return { ok: false, reason: 'no-agent', candidates: [] };
}

// Resilient pane query (tg-ctl discovery): run `tmux list-panes -a` and parse, RETRYING the one
// transient flake. In the daemon's long-running launchd runtime the tmux query was observed to
// intermittently exit 0 with an EMPTY pane list (a momentary connect to the wrong/empty server) —
// which silently degraded EVERY inbound message to the "no agent" reply and idle-exited the daemon,
// despite live agent panes. We retry ONLY that case (exit 0 + empty); a non-zero exit is NOT
// retried (see the cost note below).
//
// COST, honestly: only the exit-0-but-EMPTY read is retried (the targeted flake), so the
// blocking cost is paid ONLY on that path — up to (attempts-1)×delayMs (~240ms) of sync sleep
// before giving up. Every other outcome breaks on the FIRST attempt with no delay: panes found
// (happy path), the tmux binary missing (run() → null), and ANY non-zero exit. A non-zero exit
// from `tmux list-panes` means the client could not reach a server (no server running, the socket
// is gone, connect failed) — which is the STEADY STATE whenever tmux is simply unused, not a
// flake; retrying it would block the daemon's single thread (and the Telegram long-poll) ~240ms on
// every inbound message in the whole "no agent right now" population. So we never retry a non-zero
// exit — that also makes the policy robust to tmux's varying no-server stderr wording (no fragile
// message match). PURE: the caller injects `run` (the real Bun.spawnSync) and `sleep`, so this is
// unit-testable. `run` returns null when the tmux binary is missing.
export function panesWithRetry(
  run: () => { exitCode: number; stdout: string } | null,
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => void } = {},
): PaneInfo[] {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const delayMs = Math.max(0, opts.delayMs ?? 120);
  let panes: PaneInfo[] = [];
  for (let i = 0; i < attempts; i++) {
    if (i > 0) opts.sleep?.(delayMs);
    const r = run();
    if (r === null) break; // tmux binary missing — retrying cannot help
    if (r.exitCode !== 0) break; // could not reach a server (no server / socket gone / connect failed) — not a flake
    panes = parsePaneList(r.stdout);
    if (panes.length > 0) break; // got panes — done
    // exit 0 but EMPTY → the transient wrong/empty-server read → retry
  }
  return panes;
}
