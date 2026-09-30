// Coordinator vs subagent — the ONE role model every tg / tg-ctl consumer uses
// (docs/specs/agent-role-model.md). PURE: callers pass the env / hook payload /
// harness session record.
//
// role = subagent  iff a TRUSTED subagent signal is present; coordinator otherwise.
// A signal is trusted only when the harness or the launcher writes it and the model
// cannot forge it:
//   - a harness hook payload's TOP-LEVEL `agent_id` / `agent_type` — Claude Code
//     (verified live on 2.1.285: present only for tool calls inside a Task/Agent
//     subagent) and Codex (0.153.4 hook schema). Copies inside `tool_input` are
//     model-controlled and ignored.
//   - an opencode session record with a `parentID` (a `task` child session).
//   - launcher env set on a detached child at exec: `RIG_AGENT_ID=<name>` or
//     `RIG_DETACHED_AGENT=1`. omp also sets `RIG_AGENT_ID` on an in-process task
//     subagent's bash and unsets it on the main session's bash.
//   - `TG_AGENT` — the agent's own explicit label (same meaning as `--subagent`).
// There is deliberately NO positive "coordinator" env marker (env is inherited by
// every child), and these are NOT role signals: CLAUDE_CODE_CHILD_SESSION (set on
// the main thread too), CLAUDECODE / AI_AGENT (harness identity; omp exports
// CLAUDECODE as well), session_id / transcript_path (subagent hooks carry the
// parent's), RIG_SESSION / RIG_OMP_SESSION (session membership), tmux pane, cwd,
// window/title.

export type AgentRole = 'coordinator' | 'subagent';

// Where a subagent verdict came from, most specific first.
export type RoleSource = 'flag' | 'hook-payload' | 'session-parent' | 'tg-agent-env' | 'launcher-env' | 'none';

export interface RoleVerdict {
  role: AgentRole;
  // The label a subagent is shown under (`[label]` bracket, card "subagent=").
  // Absent for a coordinator.
  label?: string;
  source: RoleSource;
}

// Only the env keys the model reads; callers pass `process.env` (or a merge).
export interface RoleEnv {
  TG_AGENT?: string;
  RIG_AGENT_ID?: string;
  RIG_DETACHED_AGENT?: string;
}

// Label for an anonymous detached child (`RIG_DETACHED_AGENT=1`, no id) — the same
// token the agent-tools hook bridges use for that marker.
export const DETACHED_LABEL = 'detached';

// A fresh literal per call: verdicts are plain mutable records and must never alias.
const coordinator = (): RoleVerdict => ({ role: 'coordinator', source: 'none' });

function nonBlank(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

// The env-carried subagent identity, explicit label first: `TG_AGENT`, then the
// launcher/harness-managed `RIG_AGENT_ID`, then the anonymous detached marker.
export function envRole(env: RoleEnv): RoleVerdict {
  const explicit = nonBlank(env.TG_AGENT);
  if (explicit) return { role: 'subagent', label: explicit, source: 'tg-agent-env' };
  const launcher = nonBlank(env.RIG_AGENT_ID);
  if (launcher) return { role: 'subagent', label: launcher, source: 'launcher-env' };
  if (nonBlank(env.RIG_DETACHED_AGENT) === '1') return { role: 'subagent', label: DETACHED_LABEL, source: 'launcher-env' };
  return coordinator();
}

// The role of the agent sending an outbound `tg` message: `--subagent <label>`
// wins, then the env signals. A coordinator passes nothing and gets no bracket.
// Claude Code / Codex / opencode IN-PROCESS subagents share their coordinator's
// process env byte-for-byte, so they are only labelled by an explicit
// `--subagent` / `TG_AGENT`.
export function senderRole(flag: string | undefined, env: RoleEnv): RoleVerdict {
  const explicit = nonBlank(flag);
  if (explicit) return { role: 'subagent', label: explicit, source: 'flag' };
  return envRole(env);
}

// The subagent verdict the harness wrote on a RAW Claude Code / Codex hook payload
// (TOP-LEVEL fields only), or null when the call fired on the coordinator's own
// thread. The type names WHAT the subagent is, the short id tells two concurrent
// subagents of one type apart.
export function hookPayloadRole(payload: unknown): RoleVerdict | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const agentId = nonBlank(p.agent_id);
  if (!agentId) return null;
  const agentType = nonBlank(p.agent_type);
  // The RANDOM tail, not the head: Codex ids are UUIDv7, whose first 8 hex chars are a
  // timestamp that stays equal for ~65 s (two workers fanned out together share it).
  const label = agentType ? `${agentType}#${agentId.replaceAll('-', '').slice(-8)}` : agentId;
  return { role: 'subagent', label, source: 'hook-payload' };
}

export interface OpencodeSessionRecord {
  id?: string;
  parentID?: string | null;
  title?: string;
}

// An opencode session record (`GET /session/:id`): a `task` subagent runs as a CHILD
// session whose `parentID` names its coordinator's session; a top-level session has
// none. The title (`… (@explore subagent)`) is the human label, the id the fallback.
export function opencodeSessionRole(session: OpencodeSessionRecord | undefined): RoleVerdict {
  if (!session || !nonBlank(session.parentID)) return coordinator();
  const label = nonBlank(session.title) ?? nonBlank(session.id) ?? 'subagent';
  return { role: 'subagent', label, source: 'session-parent' };
}
