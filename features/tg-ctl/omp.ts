/**
 * OMP process/session discovery. Live delivery uses omp-live-runtime + the
 * extension in the ORIGINAL process. Never use ACP session/load or --resume -p to
 * attach to an already-live TUI: both create another history writer (#450).
 */

import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchAgentCommand, paneIdByPid } from './discover';
import type { AgentKind, PaneInfo, ProcInfo } from './types';
import { uniqueProjectSelectorHits, type AgentCandidate } from './agent-match';
import { hostOriginId } from './host-registry';
import { resolveSessionName } from './session-name';
import { normalizeTty, parseAgentNameFromCommand } from './unreachable';

export interface LiveOmpAgent {
  /** Verified live-process bridge generation, when installed. */
  instanceId?: string;
  pid: number;
  cwd: string | null;
  sessionFile: string | null;
  sessionId: string | null;
  /** omp's own session title — never a cwd-basename guess. */
  title: string | null;
  paneId: string | null;
  tty: string | null;
  /** `--name` from the process argv when present. */
  name?: string | null;
}

export interface OmpSessionMeta {
  title: string | null;
  sessionId: string | null;
  cwd: string | null;
}

const PRIMARY_SESSION_FILE =
  /(^|\/)\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-fA-F-]+\.jsonl$/;

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

function argvRest(command: string): string {
  const trimmed = command.trim();
  const sp = trimmed.indexOf(' ');
  return sp < 0 ? '' : trimmed.slice(sp + 1);
}

/** Interactive user omp — not workers, not `omp acp`, not `--print`. */
export function isOmpLiveSessionCommand(command: string): boolean {
  if (matchAgentCommand(command) !== 'omp') return false;
  const rest = argvRest(command);
  if (/\b__omp_worker_/.test(command)) return false;
  if (/(?:^|\s)acp(?:\s|$)/.test(rest)) return false;
  if (/(?:^|\s)--mode=(?:rpc|acp)(?:\s|$)/.test(rest)) return false;
  // omp `-p` / `--print` is non-interactive (unlike codex `-p` = profile).
  if (/(?:^|\s)(?:--print|-p)(?:\s|$)/.test(rest)) return false;
  return true;
}

export function isPrimaryOmpSessionFile(path: string): boolean {
  return PRIMARY_SESSION_FILE.test(path);
}

export function parseOmpSessionMeta(jsonl: string): OmpSessionMeta {
  let title: string | null = null;
  let sessionId: string | null = null;
  let cwd: string | null = null;
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (
      !trimmed.includes('"type":"session"') &&
      !trimmed.includes('"type":"title"') &&
      !trimmed.includes('"type":"title_change"')
    ) {
      continue;
    }
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (rec.type === 'session') {
      if (typeof rec.id === 'string' && rec.id) sessionId = rec.id;
      if (typeof rec.cwd === 'string' && rec.cwd) cwd = rec.cwd;
      if (typeof rec.title === 'string' && rec.title && title === null) title = rec.title;
    }
    if ((rec.type === 'title' || rec.type === 'title_change') && typeof rec.title === 'string' && rec.title) {
      title = rec.title;
    }
  }
  return { title, sessionId, cwd };
}

export function parseLsofJsonlPaths(out: string): string[] {
  const paths: string[] = [];
  for (const line of out.split('\n')) {
    if (!line.startsWith('n')) continue;
    const p = line.slice(1);
    if (p.endsWith('.jsonl')) paths.push(p);
  }
  return paths;
}

// A subagent transcript lives under its parent session's folder
// (`…/<ts>_<sessionId>/<Agent>.jsonl`, possibly nested deeper), so the parent
// session jsonl is that folder + `.jsonl`.
const SUBAGENT_SESSION_DIR =
  /^(.*?\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-fA-F-]+)\/.+\.jsonl$/;

/**
 * The omp's own session jsonl among its open files. omp does not keep the main
 * jsonl open between writes, so an idle session often holds only its subagent
 * transcripts open (tg-cli#487); their shared parent folder names the session.
 * Transcripts from two different sessions are ambiguous: null, never a guess.
 */
export function pickPrimaryOmpSessionFile(paths: readonly string[]): string | null {
  const primary = paths.find(isPrimaryOmpSessionFile);
  if (primary) return primary;
  let derived: string | null = null;
  for (const p of paths) {
    const match = SUBAGENT_SESSION_DIR.exec(p);
    if (!match) continue;
    const file = `${match[1]}.jsonl`;
    if (derived !== null && derived !== file) return null;
    derived = file;
  }
  return derived;
}

/**
 * The `~/.omp/agent/terminal-sessions/<id>` breadcrumb name omp writes for this
 * process — the same precedence as omp's getTerminalId: the tty device first
 * (`/dev/pts/3` → `pts-3`), the tmux pane only when there is no tty.
 */
export function ompTerminalId(agent: Pick<LiveOmpAgent, 'tty' | 'paneId'>): string | null {
  if (agent.tty) return agent.tty.replace(/^\/dev\//, '').replace(/\//g, '-');
  return agent.paneId ? `tmux-${agent.paneId}` : null;
}

/**
 * Session file from an omp terminal breadcrumb (`<cwd>\n<sessionFile>\n…`). The
 * breadcrumb belongs to whichever omp last wrote it on that terminal, so it is
 * trusted only when its cwd is this process's cwd. omp records a `--session
 * <relative>` file relative to that cwd, so it is resolved against it.
 */
export function ompSessionFileFromBreadcrumb(content: string, processCwd: string | null): string | null {
  if (!processCwd) return null;
  const [cwd, file] = content.split('\n');
  if (cwd !== processCwd || !file || !isPrimaryOmpSessionFile(file)) return null;
  return isAbsolute(file) ? file : join(cwd, file);
}

/**
 * Interactive omp processes, whether or not they sit in a tmux pane OR have a
 * controlling tty at all. `isOmpLiveSessionCommand` already narrows `procs` to
 * the genuine top-level interactive CLI (never a worker, `omp acp` child, or a
 * `-p`/`--print` one-shot) — anything left IS a live conversational session, so
 * discovery keeps them visible. Delivery independently requires an authenticated
 * original-process endpoint; cwd alone can NEVER authorize a destination.
 *
 * Past bug (tg-cli#405 follow-up): this used to additionally require a tty OR a
 * pane ("drop daemons with neither") and silently dropped a genuinely live omp
 * session that has neither — e.g. one launched detached/headless (no controlling
 * terminal, not in tmux). Such a session is invisible to `listUnreachableAgents`
 * too (that path explicitly excludes `agent === "omp"`, since omp coverage is
 * this function's job), so it fell through every candidate list straight to the
 * bare "Claude Code not in tmux" legacy reply — even though ACP delivery to it
 * works exactly the same as any other omp session. Do not reintroduce a tty/pane
 * requirement here.
 */
export function findLiveOmpAgents(
  panes: PaneInfo[],
  procs: ProcInfo[],
  ttyByPid: Map<number, string>,
): LiveOmpAgent[] {
  const paneByPid = paneIdByPid(panes, procs);
  const out: LiveOmpAgent[] = [];
  for (const p of procs) {
    if (!isOmpLiveSessionCommand(p.command)) continue;
    const paneId = paneByPid.get(p.pid) ?? null;
    out.push({
      pid: p.pid,
      cwd: null,
      sessionFile: null,
      sessionId: null,
      title: null,
      paneId,
      tty: normalizeTty(ttyByPid.get(p.pid)),
      name: parseAgentNameFromCommand(p.command),
    });
  }
  return out;
}

// The name of an omp that is NOT shown in a tmux pane (the resolver's not-in-tmux
// tier): its own session title, else its cwd project, else a short session id/pid.
export function liveOmpLabel(a: LiveOmpAgent): string {
  const short = a.sessionId ? a.sessionId.replace(/-/g, '').slice(0, 8) : String(a.pid);
  return resolveSessionName({ cwd: a.cwd, harnessTitle: a.title, fallback: `omp · ${short}` }).primary;
}

export function matchLiveOmp(selector: string, agents: LiveOmpAgent[]): LiveOmpAgent[] {
  const want = selector.trim().toLowerCase();
  if (!want) return [];
  const byName = agents.filter((a) => (a.name ?? '').trim().toLowerCase() === want);
  if (byName.length > 0) return byName;
  const exactTitle = agents.filter((a) => (a.title ?? '').trim().toLowerCase() === want);
  if (exactTitle.length > 0) return exactTitle;
  const idPrefix = agents.filter((a) => (a.sessionId ?? '').toLowerCase().startsWith(want));
  if (idPrefix.length > 0) return idPrefix;
  const byPid = agents.filter((a) => String(a.pid) === want || `pid ${a.pid}` === want);
  if (byPid.length > 0) return byPid;
  const byCwd = agents.filter((a) => {
    const base = a.cwd ? basename(a.cwd).toLowerCase() : '';
    return base !== '' && base === want;
  });
  // Untitled sessions have no title/jsonl; only a unique cwd basename is safe.
  if (byCwd.length === 1) return byCwd;
  return uniqueProjectSelectorHits(selector, agents, (a) => (a.cwd ? basename(a.cwd) : ''));
}

/** Synthetic picker pane id for an omp that is not a tmux pane. Inject routes this to ACP. */
export function liveOmpPaneId(pid: number): string {
  return `omp:${pid}`;
}

const LIVE_OMP_ORIGIN = /^omp:(\d+)$/;

/** True when a routes.json paneId is the synthetic out-of-tmux omp origin. */
export function isLiveOmpOriginId(paneId: string): boolean {
  return LIVE_OMP_ORIGIN.test(paneId);
}

export function liveOmpPidFromOriginId(paneId: string): number | null {
  const m = LIVE_OMP_ORIGIN.exec(paneId);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Origin id `tg` stamps on an outbound route. A real tmux pane wins; otherwise the omp
 * ancestor pid so a Telegram reply can find a session with no pane; otherwise the abduco
 * session a rig wrapper hosts it in (`host:<name>`, host-registry.ts).
 */
export function outboundOriginPaneId(opts: {
  tmuxPane?: string | null;
  ompAncestorPid?: number | null;
  hostName?: string | null;
}): string | null {
  const pane = opts.tmuxPane?.trim();
  if (pane) return pane;
  const pid = opts.ompAncestorPid;
  if (pid && pid > 0) return liveOmpPaneId(pid);
  return opts.hostName ? hostOriginId(opts.hostName) : null;
}

/** Live omp process that owns this origin — synthetic omp:<pid> or a tmux pane id. */
export function matchLiveOmpOrigin(originPaneId: string, agents: LiveOmpAgent[]): LiveOmpAgent | null {
  const pid = liveOmpPidFromOriginId(originPaneId);
  if (pid !== null) return agents.find((a) => a.pid === pid) ?? null;
  return agents.find((a) => a.paneId === originPaneId) ?? null;
}

/**
 * An omp:<pid> origin identifies the live PROCESS, not a tmux pane. Pid match
 * is enough — tg often runs from /tmp so recorded cwd is not the session cwd
 * (Codex P1 on #340). Tmux pane origins still need the live cwd to equal the
 * recorded send-path.
 */
export function ompReplyOriginMatches(
  recognized: { paneId: string; cwd?: string },
  live: LiveOmpAgent,
): boolean {
  const pid = liveOmpPidFromOriginId(recognized.paneId);
  if (pid !== null) return pid === live.pid;
  return Boolean(recognized.cwd && live.cwd && recognized.cwd === live.cwd);
}

export function liveOmpToCandidate(a: LiveOmpAgent): AgentCandidate {
  const name = (a.name ?? '').trim();
  return {
    paneId: liveOmpPaneId(a.pid),
    sessionName: 'omp',
    windowIndex: a.pid,
    windowName: liveOmpLabel(a),
    agent: 'omp',
    panePath: a.cwd ?? undefined,
    harnessTitle: a.title,
    ...(name ? { aliases: [name] } : {}),
  };
}

/**
 * Out-of-tmux omp join the /agent picker as `omp:<pid>` rows. An omp shown in a
 * tmux pane keeps that pane's row: the tmux window name stays its name, and the
 * omp title rides along as the harness title (tg-cli#455 — never overwrite the
 * window name with the title).
 */
export function mergeLiveOmpCandidates(
  tmux: AgentCandidate[],
  live: LiveOmpAgent[],
): AgentCandidate[] {
  const out = tmux.map((c) => ({ ...c }));
  const extra: AgentCandidate[] = [];
  for (const a of live) {
    const existing = a.paneId ? out.find((c) => c.paneId === a.paneId) : undefined;
    if (!existing) {
      extra.push(liveOmpToCandidate(a));
      continue;
    }
    if (existing.agent !== 'omp') continue;
    if (a.title) existing.harnessTitle = a.title;
    const name = (a.name ?? '').trim();
    if (name) existing.aliases = [name];
  }
  return extra.length === 0 ? out : [...out, ...extra];
}

export function preferOmpApiOverTmux(agent: AgentKind): boolean {
  return agent === 'omp';
}

export function withOmpSession(
  agent: LiveOmpAgent,
  opts: { cwd?: string | null; sessionFile?: string | null; meta?: OmpSessionMeta | null },
): LiveOmpAgent {
  const file = opts.sessionFile ?? agent.sessionFile;
  const meta = opts.meta;
  const idFromFile = file && isPrimaryOmpSessionFile(file) ? basename(file).replace(/\.jsonl$/, '').split('_').slice(1).join('_') : null;
  return {
    ...agent,
    cwd: opts.cwd ?? meta?.cwd ?? agent.cwd,
    sessionFile: file,
    sessionId: meta?.sessionId ?? idFromFile ?? agent.sessionId,
    title: meta?.title ?? agent.title,
  };
}

// One status line. `pane` is the tmux pane the omp is shown in (when any), so the
// line leads with the SAME name the picker and the outbound header use.
export function describeLiveOmp(
  a: LiveOmpAgent,
  pane?: { windowName: string; panePath: string; paneTitle?: string | null } | null,
): string {
  let label = liveOmpLabel(a);
  if (pane) {
    const name = resolveSessionName({ tmuxWindow: pane.windowName, cwd: pane.panePath, harnessTitle: a.title, paneTitle: pane.paneTitle });
    label = name.secondary ? `${name.primary} · ${name.secondary}` : name.primary;
  }
  const parts = [
    a.paneId ? `pane ${a.paneId}` : 'no tmux',
    `cwd ${a.cwd ?? '?'}`,
    `title ${a.title ?? '-'}`,
    `pid ${a.pid}`,
  ];
  return `${label} · omp — ${a.instanceId ? 'bridge' : 'NO bridge'} (${parts.join(', ')})`;
}

// `ps -o pid=,etime= -p …` → pid → process start (ms epoch). etime is
// [[dd-]hh:]mm:ss, locale-independent unlike lstart; malformed rows are dropped.
export function parsePidStartList(out: string, nowMs: number): Map<number, number> {
  const starts = new Map<number, number>();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(line);
    if (!m) continue;
    const [days, hours, minutes, seconds] = [m[2], m[3], m[4], m[5]].map((v) => Number(v ?? 0));
    if (minutes >= 60 || seconds >= 60 || hours >= 24) continue;
    starts.set(Number(m[1]), nowMs - (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000);
  }
  return starts;
}

/** When the installed bridge (loader + the code it imports) last changed, and when each live omp started. */
export interface BridgeCodeAge {
  codeChangedAtMs: number | null;
  startedAtMs: ReadonlyMap<number, number>;
}

/**
 * Absolute file paths the managed `tg-omp-live.ts` loader imports (its `new URL("file://…")`
 * literals) — the code a NEW omp actually loads, which need not be this tg-ctl's checkout.
 */
export function ompLiveLoaderSources(loader: string): string[] {
  const paths: string[] = [];
  for (const m of loader.matchAll(/new URL\(("file:\/\/[^"\n]+")\)/g)) {
    try { paths.push(fileURLToPath(JSON.parse(m[1]))); } catch { /* not a file URL literal */ }
  }
  return paths;
}

// OMP binds an extension once per process and reuses that module for every in-process
// subagent, and 18.3 cannot reload JS extensions. An omp started before the installed
// bridge changed (or was first installed) keeps what it loaded — pre-#483 code dropped its
// endpoint at the first subagent spawn — until it is resumed; one started after it and
// still unbridged is a real failure.
function bridgeCodeVerdict(a: LiveOmpAgent, age: BridgeCodeAge | undefined): string | null {
  const started = age?.startedAtMs.get(a.pid);
  const changed = age?.codeChangedAtMs;
  if (started === undefined || changed === undefined || changed === null) return null;
  const at = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  return started < changed
    ? `started before the installed bridge code changed (${at(started)} < ${at(changed)} UTC) → runs an older or no bridge; save/stop + resume once`
    : `started after the installed bridge code (${at(changed)} UTC) yet unbridged → bridge failure, see ~/.omp/logs/omp.*.${a.pid}.log`;
}

/**
 * `tg-ctl status` block naming every live omp WITHOUT an original-process endpoint
 * (#458), how each is reached meanwhile, and whether it predates the bridge code.
 * `readAge` is asked only for the unbridged pids. Empty when every omp is bridged.
 */
export function describeUnbridgedOmp(
  agents: readonly LiveOmpAgent[],
  readAge?: (pids: number[]) => BridgeCodeAge | undefined,
): string[] {
  const missing = agents.filter((a) => !a.instanceId);
  if (missing.length === 0) return [];
  const age = readAge?.(missing.map((a) => a.pid));
  return [
    `omp without bridge: ${missing.length}`,
    ...missing.map((a) => {
      const name = (a.name ?? '').trim();
      const label = name && name !== liveOmpLabel(a) ? `${liveOmpLabel(a)} (--name ${name})` : liveOmpLabel(a);
      const reach = a.paneId ? `pane ${a.paneId} → tmux send-keys into its own TUI` : 'no tmux → unreachable until it loads the bridge';
      const verdict = bridgeCodeVerdict(a, age);
      return `  - ${[label, `pid ${a.pid}`, reach, ...(verdict ? [verdict] : [])].join(' · ')}`;
    }),
    '  fix: tg-ctl omp-live install, then save/stop + resume each once (never a second copy)',
  ];
}
