import { expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DETACHED_LABEL, envRole, hookPayloadRole, opencodeSessionRole, senderRole } from '../features/agent-role/role';
import { normalizeHookPayload, normalizeHookRequests, type HookEnv } from '../features/tg-ctl/hook-normalize';
import { opencodeEventToButtonRequest } from '../features/tg-ctl/opencode';

// Coordinator vs subagent, one fixture set per harness (docs/specs/agent-role-model.md §3).
// Claude Code: a LIVE capture of `claude -p` dispatching one Agent subagent. omp: a live
// capture of a task subagent's and a main session's bash env. Codex: hook payloads shaped
// by the 0.153.4 schema plus REAL recorded rollout session_meta (live hook capture is blocked
// by the Codex usage limit). opencode: REAL rows from opencode.db.

const FIXTURES = join(import.meta.dir, 'fixtures', 'agent-role');
const json = <T>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;

type Payload = Record<string, unknown>;
const ccHooks: Payload[] = readFileSync(join(FIXTURES, 'claude-code-2.1.285-hooks.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Payload);
const ccEnv = json<{ main: Record<string, string>; subagent: Record<string, string> }>('claude-code-2.1.285-bash-env.json');
const codexHooks = json<Record<string, Payload>>('codex-0.153.4-hooks.json');
const codexRollouts = json<Record<string, Record<string, unknown>>>('codex-0.153.4-rollouts.json');
const ompEnv = json<{ coordinator: Record<string, string>; subagent: Record<string, string> }>('omp-bash-env.json');
const ocSessions = json<{ subagentChild: { id: string; parentID: string; title: string }; topLevel: { id: string; title: string } }>(
  'opencode-1.18.30-sessions.json',
);

const hookEnv = (over: Partial<HookEnv> = {}): HookEnv => ({ agent: 'claude', invocationNonce: 'n1', ...over });

// ---------------------------------------------------------------- Claude Code

test('cc: only tool calls inside the Agent subagent carry a top-level agent_id; the coordinator never does', () => {
  const roles = ccHooks
    .filter((e) => e.hook_event_name === 'PreToolUse')
    .map((e) => [e.tool_name, hookPayloadRole(e)?.label ?? 'coordinator']);
  expect(roles).toEqual([
    ['Agent', 'coordinator'], // the coordinator DISPATCHING the subagent
    ['Bash', 'general-purpose#e69145c6'], // the subagent's own Bash
    ['Bash', 'coordinator'], // the coordinator's Bash after it returns
    ['Bash', 'coordinator'],
  ]);
});

test('cc: session_id, transcript_path and bash env are identical for main and subagent — only the payload agent_id tells them apart', () => {
  const sub = ccHooks.find((e) => e.agent_id && e.hook_event_name === 'PreToolUse')!;
  const main = ccHooks.find((e) => !e.agent_id && e.tool_name === 'Bash')!;
  expect(sub.session_id).toBe(main.session_id);
  expect(sub.transcript_path).toBe(main.transcript_path);
  expect(ccEnv.subagent).toEqual(ccEnv.main);
  // CLAUDE_CODE_CHILD_SESSION=1 is set on the MAIN thread of `claude -p` too: not a role signal.
  expect(ccEnv.main.CLAUDE_CODE_CHILD_SESSION).toBe('1');
  expect(envRole(ccEnv.main)).toEqual({ role: 'coordinator', source: 'none' });
  expect(envRole(ccEnv.subagent).role).toBe('coordinator');
});

test('cc: a PermissionRequest raised inside the subagent is labelled from the payload, the coordinator\'s is not', () => {
  const asPermission = (e: Payload): Payload => ({ ...e, hook_event_name: 'PermissionRequest' });
  const sub = ccHooks.find((e) => e.agent_id && e.tool_name === 'Bash')!;
  const main = ccHooks.find((e) => !e.agent_id && e.tool_name === 'Bash')!;
  expect(normalizeHookPayload(asPermission(sub), hookEnv())?.subagent).toBe('general-purpose#e69145c6');
  expect(normalizeHookPayload(asPermission(main), hookEnv())?.subagent).toBeUndefined();
});

// ---------------------------------------------------------------------- Codex

test('codex: PreToolUse and PermissionRequest of a spawned thread carry agent_id/agent_type; the coordinator\'s do not', () => {
  expect(hookPayloadRole(codexHooks.coordinatorPreToolUse)).toBeNull();
  expect(hookPayloadRole(codexHooks.coordinatorPermissionRequest)).toBeNull();
  for (const name of ['subagentPreToolUse', 'subagentPermissionRequest']) {
    expect(hookPayloadRole(codexHooks[name])).toEqual({ role: 'subagent', label: 'worker#096047ca', source: 'hook-payload' });
  }
  // "Subagent hooks use the parent session id": session_id cannot tell them apart.
  expect(codexHooks.subagentPreToolUse.session_id).toBe(codexHooks.coordinatorPreToolUse.session_id);
});

test('codex: a subagent\'s permission ask is labelled on the card, the coordinator\'s is not', () => {
  const env = hookEnv({ agent: 'codex' });
  expect(normalizeHookPayload(codexHooks.subagentPermissionRequest, env)?.subagent).toBe('worker#096047ca');
  expect(normalizeHookPayload(codexHooks.coordinatorPermissionRequest, env)?.subagent).toBeUndefined();
});

test('codex: two workers spawned seconds apart (UUIDv7 ids sharing their timestamp head) get different labels', () => {
  const a = hookPayloadRole({ agent_id: '01a09b1f-2948-77d1-b8fa-a84b096047ca', agent_type: 'worker' });
  const b = hookPayloadRole({ agent_id: '01a09b1f-3a7c-7e02-9c15-55f0c3d81b2e', agent_type: 'worker' });
  expect(a?.label).not.toBe(b?.label);
});

test('codex: the hook agent_id is the spawned thread\'s own rollout id; only user threads are coordinators', () => {
  const { coordinator, spawnedSubagent, guardianReview } = codexRollouts;
  expect(coordinator.thread_source).toBe('user');
  expect(coordinator.id).toBe(codexHooks.coordinatorPreToolUse.session_id);
  expect(spawnedSubagent.thread_source).toBe('subagent');
  expect(spawnedSubagent.id).toBe(codexHooks.subagentPreToolUse.agent_id);
  expect(spawnedSubagent.parent_thread_id).toBe(codexHooks.subagentPreToolUse.session_id);
  // A guardian-review thread hangs off a subagent thread: still not a coordinator.
  expect(guardianReview.thread_source).toBe('guardian_review');
  expect(guardianReview.parent_thread_id).toBe(spawnedSubagent.id);
});

// ------------------------------------------------------------------------ omp

test('omp: a task subagent\'s bash carries RIG_AGENT_ID; the main session\'s bash (omp unsets it) is the coordinator', () => {
  expect(envRole(ompEnv.subagent)).toEqual({ role: 'subagent', label: 'RoleAudit', source: 'launcher-env' });
  expect(envRole(ompEnv.coordinator)).toEqual({ role: 'coordinator', source: 'none' });
});

test('omp: session membership and harness identity are not role signals', () => {
  // Both roles export the SAME RIG_OMP_SESSION (membership) and CLAUDECODE (harness identity).
  expect(ompEnv.subagent.RIG_OMP_SESSION).toBe(ompEnv.coordinator.RIG_OMP_SESSION);
  expect(ompEnv.subagent.CLAUDECODE).toBe(ompEnv.coordinator.CLAUDECODE);
  const membershipOnly = { RIG_OMP_SESSION: 'omp-1', RIG_SESSION: 'omp-1', CLAUDECODE: '1', AI_AGENT: 'claude-code', TMUX_PANE: '%3' };
  expect(envRole(membershipOnly).role).toBe('coordinator');
});

// ------------------------------------------------------------------- opencode

test('opencode: a session with a parentID is a subagent labelled by its title; a top-level session is the coordinator', () => {
  expect(opencodeSessionRole(ocSessions.subagentChild)).toEqual({
    role: 'subagent',
    label: 'Audit wearable CAD (@explore subagent)',
    source: 'session-parent',
  });
  expect(opencodeSessionRole(ocSessions.topLevel)).toEqual({ role: 'coordinator', source: 'none' });
  expect(opencodeSessionRole(undefined).role).toBe('coordinator');
  expect(opencodeSessionRole({ id: 'ses_x', parentID: '  ' }).role).toBe('coordinator');
  expect(opencodeSessionRole({ id: 'ses_x', parentID: 'ses_p' }).label).toBe('ses_x');
});

test('opencode: a question raised in a child session is labelled with its subagent', () => {
  const ask = (sessionID: string) => ({
    type: 'question.asked',
    properties: {
      sessionID,
      id: 'que_1',
      questions: [{ question: 'Proceed?', header: 'Go', options: [{ label: 'Yes', description: '' }], custom: false }],
    },
  });
  const child = ask(ocSessions.subagentChild.id);
  expect(opencodeEventToButtonRequest(child, ocSessions.subagentChild)?.subagent).toBe('Audit wearable CAD (@explore subagent)');
  expect(opencodeEventToButtonRequest(child)?.subagent).toBeUndefined();
  expect(opencodeEventToButtonRequest(ask(ocSessions.topLevel.id), ocSessions.topLevel)?.subagent).toBeUndefined();
  // A record fetched for ANOTHER session — or one carrying no id — never labels this session's card.
  expect(opencodeEventToButtonRequest(child, { ...ocSessions.subagentChild, id: 'ses_other' })?.subagent).toBeUndefined();
  expect(opencodeEventToButtonRequest(child, { parentID: 'ses_p', title: 'Other' })?.subagent).toBeUndefined();
});

test('labels are one bounded line whatever the source (LLM-authored titles, launcher ids)', () => {
  const long = 'x'.repeat(300);
  expect(envRole({ RIG_AGENT_ID: long }).label).toBe('x'.repeat(80));
  expect(envRole({ TG_AGENT: 'a\n  b\tc' }).label).toBe('a b c');
  expect(senderRole(long, {}).label).toHaveLength(80);
  expect(opencodeSessionRole({ id: 's', parentID: 'p', title: `Audit\n${long}` }).label).toHaveLength(80);
  expect(hookPayloadRole({ agent_id: 'abc', agent_type: long })?.label).toHaveLength(80);
  // Capped by code point: an emoji at the cut is never split into a lone surrogate.
  expect(envRole({ RIG_AGENT_ID: '😀'.repeat(200) }).label).toBe('😀'.repeat(80));
});

// ---------------------------------------------------------- detached children

test('detached child: RIG_AGENT_ID names it, RIG_DETACHED_AGENT=1 is the anonymous marker, nothing else counts', () => {
  expect(envRole({ RIG_AGENT_ID: ' reviewer-1 ' })).toEqual({ role: 'subagent', label: 'reviewer-1', source: 'launcher-env' });
  expect(envRole({ RIG_DETACHED_AGENT: '1' })).toEqual({ role: 'subagent', label: DETACHED_LABEL, source: 'launcher-env' });
  for (const v of ['', '0', 'true', 'yes', ' ']) expect(envRole({ RIG_DETACHED_AGENT: v }).role).toBe('coordinator');
  expect(envRole({ RIG_AGENT_ID: '   ' }).role).toBe('coordinator');
  expect(envRole({}).role).toBe('coordinator');
});

test('env precedence: TG_AGENT > RIG_AGENT_ID > RIG_DETACHED_AGENT', () => {
  const all = { TG_AGENT: 'explicit', RIG_AGENT_ID: 'launcher', RIG_DETACHED_AGENT: '1' };
  expect(envRole(all)).toEqual({ role: 'subagent', label: 'explicit', source: 'tg-agent-env' });
  expect(envRole({ ...all, TG_AGENT: ' ' })).toEqual({ role: 'subagent', label: 'launcher', source: 'launcher-env' });
  expect(envRole({ ...all, TG_AGENT: '', RIG_AGENT_ID: '' })).toEqual({ role: 'subagent', label: DETACHED_LABEL, source: 'launcher-env' });
});

test('outbound sender: --subagent beats every env signal, a blank flag falls through to env', () => {
  const env = { TG_AGENT: 'from-tg-agent', RIG_AGENT_ID: 'from-rig' };
  expect(senderRole('from-flag', env)).toEqual({ role: 'subagent', label: 'from-flag', source: 'flag' });
  expect(senderRole('   ', env).label).toBe('from-tg-agent');
  expect(senderRole(undefined, { RIG_AGENT_ID: 'from-rig' }).label).toBe('from-rig');
  expect(senderRole(undefined, {})).toEqual({ role: 'coordinator', source: 'none' });
});

// ------------------------------------------- hook-normalize: payload before env

const subagentPayload = { agent_id: 'ac1ddb6e2e69145c6', agent_type: 'general-purpose' };
const SUB_LABEL = 'general-purpose#e69145c6';

test('hook payload agent_id beats the hook process env label on every forwarded request kind', () => {
  const env = hookEnv({ subagent: 'from-env' });
  const askInput = { questions: [{ question: 'Where?', options: [{ label: 'A' }] }, { question: 'When?', options: [{ label: 'B' }] }] };
  const ask = normalizeHookRequests({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: askInput, ...subagentPayload }, env);
  expect(ask?.map((r) => r.subagent)).toEqual([SUB_LABEL, SUB_LABEL]);
  const plan = normalizeHookPayload({ hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: 'p' }, ...subagentPayload }, env);
  expect(plan?.subagent).toBe(SUB_LABEL);
  const perm = normalizeHookPayload({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' }, ...subagentPayload }, env);
  expect(perm?.subagent).toBe(SUB_LABEL);
});

test('without a payload agent_id the hook env label (detached child) still applies', () => {
  const perm = normalizeHookPayload({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }, hookEnv({ subagent: 'detached-reviewer' }));
  expect(perm?.subagent).toBe('detached-reviewer');
});

test('an agent_id forged inside tool_input is never a role signal', () => {
  const forged = { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls', agent_id: 'forged', agent_type: 'worker' } };
  expect(hookPayloadRole(forged)).toBeNull();
  expect(normalizeHookPayload(forged, hookEnv())?.subagent).toBeUndefined();
});
