/**
 * @file Live omp (Oh My Pi) control via ACP — not tmux send-keys, not `omp --resume -p`.
 *
 * Accessed via: tg-ctl inbound inject / question taps → this module (pure
 * encode/decode + discovery) → the entrypoint owns the `omp acp` stdio child.
 *
 * Assumptions: the live binary is omp 18.1.14. Session titles live in omp's
 * own jsonl (`type:title` / `type:session`). ACP does not attach to a TUI
 * process's stdin; a pane AND an ACP child at once still use ACP only.
 *
 * Past bugs: PR 322 used `omp --resume --print`, which forks the session
 * parent-chain. Do not revive that. `omp join` is a collab relay, not local
 * attach. RPC `--mode=rpc` is NDJSON `{type:"prompt", message}` — we speak
 * ACP JSON-RPC instead. Framing is NDJSON (one JSON-RPC object per line);
 * LSP Content-Length makes `omp acp` exit 0 with empty stdout (tg-cli#341,
 * the 15s initialize timeout).
 *
 * ACP methods used (proven on omp 18.1.14, 2026-09-08):
 *   initialize                  → agentInfo.name "oh-my-pi"
 *   session/new {cwd, mcpServers:[]} → sessionId (no live session jsonl)
 *   session/load {cwd, mcpServers:[], sessionId} → the process-table session
 *   session/prompt {sessionId, prompt:[{type:"text", text}]}
 *   session/update              → session_info_update.title (name from omp)
 *   session/request_permission  → Telegram buttons; reply is the JSON-RPC result
 *                                 {outcome:{outcome:"selected", optionId}}
 *
 * Out-of-tmux replies (tg-cli#339): `tg` stamps route paneId omp:<pid>; the
 * daemon recognizes that origin and session/load-s the live session id, never
 * tmux send-keys and never an ephemeral session/new --no-session sibling.
 *
 */

import { matchAgentCommand } from './discover';
import type { AgentKind, PaneInfo, ProcInfo } from './types';
import type { ButtonOption, ButtonRequest } from './questions';
import { uniqueProjectSelectorHits, type AgentCandidate } from './agent-match';
import { normalizeTty, parseAgentNameFromCommand } from './unreachable';

export interface LiveOmpAgent {
  pid: number;
  cwd: string | null;
  sessionFile: string | null;
  sessionId: string | null;
  /** omp's own session title — never a cwd-basename guess. */
  title: string | null;
  paneId: string | null;
  tty: string | null;
  /** `--name` from the process argv when present (claude-rotate / omp). */
  name?: string | null;
}

export interface OmpSessionMeta {
  title: string | null;
  sessionId: string | null;
  cwd: string | null;
}

export interface OmpRequestRef {
  sessionId: string;
  rpcId: string | number;
}

export interface AcpRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface AcpResponse {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: unknown;
  method?: string;
  params?: unknown;
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

export function pickPrimaryOmpSessionFile(paths: readonly string[]): string | null {
  return paths.find(isPrimaryOmpSessionFile) ?? null;
}

function pidsUnderPanes(panes: PaneInfo[], procs: ProcInfo[]): Map<number, string> {
  const byPpid = new Map<number, number[]>();
  for (const p of procs) {
    const sib = byPpid.get(p.ppid);
    if (sib) sib.push(p.pid);
    else byPpid.set(p.ppid, [p.pid]);
  }
  const paneByPid = new Map<number, string>();
  for (const pane of panes) {
    const queue = [pane.panePid];
    const seen = new Set<number>();
    while (queue.length > 0) {
      const pid = queue.shift()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      paneByPid.set(pid, pane.paneId);
      for (const child of byPpid.get(pid) ?? []) queue.push(child);
    }
  }
  return paneByPid;
}

/**
 * Interactive omp processes, whether or not they sit in a tmux pane OR have a
 * controlling tty at all. `isOmpLiveSessionCommand` already narrows `procs` to
 * the genuine top-level interactive CLI (never a worker, `omp acp` child, or a
 * `-p`/`--print` one-shot) — anything left IS a live conversational session, so
 * `preferOmpApiOverTmux` is always true for omp and ACP delivery (promptOmpAcp /
 * ensureOmpAcp) needs only the pid's cwd, never a tty or a pane.
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
  const paneByPid = pidsUnderPanes(panes, procs);
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

export function liveOmpLabel(a: LiveOmpAgent): string {
  if (a.title && a.title.trim()) return a.title.trim();
  const short = a.sessionId ? a.sessionId.replace(/-/g, '').slice(0, 8) : String(a.pid);
  return `omp · ${short}`;
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
 * Origin id `tg` stamps on an outbound route. A real tmux pane wins; otherwise
 * the omp ancestor pid so a Telegram reply can find a session with no pane.
 */
export function outboundOriginPaneId(opts: {
  tmuxPane?: string | null;
  ompAncestorPid?: number | null;
}): string | null {
  const pane = opts.tmuxPane?.trim();
  if (pane) return pane;
  const pid = opts.ompAncestorPid;
  if (pid && pid > 0) return liveOmpPaneId(pid);
  return null;
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

/** argv after `omp`. Loading a live session must NOT pass --no-session (ephemeral sibling). */
export function ompAcpSpawnArgv(opts: { cwd: string; loadSession: boolean }): string[] {
  const args = ['acp', '--allow-home', `--cwd=${opts.cwd}`];
  if (!opts.loadSession) args.splice(1, 0, '--no-session');
  return args;
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
    ...(name ? { aliases: [name] } : {}),
  };
}

/** Out-of-tmux omp join the /agent picker; skip any already sitting in a tmux pane. */
export function mergeLiveOmpCandidates(
  tmux: AgentCandidate[],
  live: LiveOmpAgent[],
): AgentCandidate[] {
  const out = tmux.map((c) => ({ ...c }));
  const extra: AgentCandidate[] = [];
  for (const a of live) {
    if (a.paneId) {
      const existing = out.find((c) => c.paneId === a.paneId);
      if (existing?.agent === 'omp') {
        existing.windowName = liveOmpLabel(a);
        const name = (a.name ?? '').trim();
        if (name) existing.aliases = [name];
      }
      continue;
    }
    extra.push(liveOmpToCandidate(a));
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

export function describeLiveOmp(a: LiveOmpAgent): string {
  const parts = [
    a.paneId ? `pane ${a.paneId}` : 'no tmux',
    `cwd ${a.cwd ?? '?'}`,
    `title ${a.title ?? '-'}`,
    `pid ${a.pid}`,
  ];
  return `${liveOmpLabel(a)} · omp — ACP (${parts.join(', ')})`;
}

// --- ACP framing (NDJSON JSON-RPC over stdio; omp 18.1.14) ---

export function encodeAcpFrame(message: object): string {
  return `${JSON.stringify(message)}\n`;
}

export function decodeAcpFrames(chunk: string): { messages: unknown[]; rest: string } {
  const messages: unknown[] = [];
  let rest = chunk;
  while (rest.length > 0) {
    const nl = rest.indexOf('\n');
    if (nl < 0) break;
    const line = rest.slice(0, nl).replace(/\r$/, '').trim();
    rest = rest.slice(nl + 1);
    if (!line.startsWith('{')) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      /* drop malformed */
    }
  }
  return { messages, rest };
}

export function buildAcpInitialize(id: string | number): AcpRequest {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: 1,
      clientInfo: { name: 'tg-ctl', version: '1.49.1' },
      clientCapabilities: {},
    },
  };
}

export function buildAcpSessionNew(id: string | number, cwd: string): AcpRequest {
  return {
    jsonrpc: '2.0',
    id,
    method: 'session/new',
    params: { cwd, mcpServers: [] },
  };
}

export function buildAcpSessionLoad(id: string | number, cwd: string, sessionId: string): AcpRequest {
  return {
    jsonrpc: '2.0',
    id,
    method: 'session/load',
    params: { cwd, mcpServers: [], sessionId },
  };
}

export function buildAcpSessionPrompt(id: string | number, sessionId: string, text: string): AcpRequest {
  return {
    jsonrpc: '2.0',
    id,
    method: 'session/prompt',
    params: {
      sessionId,
      prompt: [{ type: 'text', text }],
    },
  };
}

export function acpSessionIdFromResult(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const rec = message as Record<string, unknown>;
  const result = rec.result;
  if (!result || typeof result !== 'object') return null;
  const id = (result as Record<string, unknown>).sessionId;
  return typeof id === 'string' && id ? id : null;
}

export function acpSessionTitleFromUpdate(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const rec = message as Record<string, unknown>;
  if (rec.method !== 'session/update') return null;
  const params = rec.params;
  if (!params || typeof params !== 'object') return null;
  const update = (params as Record<string, unknown>).update;
  if (!update || typeof update !== 'object') return null;
  const u = update as Record<string, unknown>;
  if (u.sessionUpdate !== 'session_info_update') return null;
  return typeof u.title === 'string' && u.title ? u.title : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function acpPermissionToButtonRequest(message: unknown): ButtonRequest | null {
  if (!isRecord(message) || message.method !== 'session/request_permission') return null;
  if (message.id === undefined || message.id === null) return null;
  const params = message.params;
  if (!isRecord(params)) return null;
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
  if (!sessionId) return null;
  const toolCall = isRecord(params.toolCall) ? params.toolCall : {};
  const title = typeof toolCall.title === 'string' ? toolCall.title : 'omp permission';
  const rawOpts = Array.isArray(params.options) ? params.options : [];
  const options: ButtonOption[] = [];
  for (const item of rawOpts) {
    if (!isRecord(item)) continue;
    const optionId = typeof item.optionId === 'string' ? item.optionId : '';
    const name = typeof item.name === 'string' ? item.name : optionId;
    if (!optionId || !name) continue;
    options.push({ label: name, description: optionId });
  }
  if (options.length === 0) return null;
  const kinds = rawOpts.map((item) => (isRecord(item) ? item.kind : null));
  const hasReject = kinds.some((k) => k === 'reject_once' || k === 'reject_always');
  const kind = hasReject && options.length <= 2 ? 'permission' : 'question';
  const rpcId = message.id as string | number;
  return {
    requestId: `omp_${sessionId}_${String(rpcId)}`.replace(/[^A-Za-z0-9_-]/g, '_'),
    agent: 'omp',
    kind,
    question: title,
    options,
    omp: { sessionId, rpcId },
  };
}

export function acpPermissionReply(req: ButtonRequest, optionId: string): AcpResponse | null {
  if (!req.omp) return null;
  return {
    jsonrpc: '2.0',
    id: req.omp.rpcId,
    result: { outcome: { outcome: 'selected', optionId } },
  };
}

export function optionIdForAnswer(req: ButtonRequest, value: string, label: string): string {
  if (req.options) {
    const byDesc = req.options.find((o) => o.description === value);
    if (byDesc?.description) return byDesc.description;
    const byLabel = req.options.find((o) => o.label === label || o.label === value);
    if (byLabel?.description) return byLabel.description;
  }
  if (req.kind === 'permission') {
    if (value === 'allow' || value === 'deny') {
      const want = value === 'deny' ? 'reject' : 'allow';
      const hit = req.options?.find((o) => (o.description ?? '').includes(want));
      if (hit?.description) return hit.description;
    }
  }
  return value;
}
