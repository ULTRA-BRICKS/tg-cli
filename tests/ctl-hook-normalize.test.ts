import { expect, test } from 'bun:test';
import { normalizeHookPayload, normalizeHookRequests, type HookEnv } from '../features/tg-ctl/hook-normalize';
import { hasUnpairedSurrogate } from '../features/tg-ctl/text-util';

const env: HookEnv = {
  agent: 'claude',
  paneId: '%5',
  cwd: '/env/cwd',
  sessionName: 'work',
  windowName: 'ext',
  subagent: 'review-worker',
  invocationNonce: 'env-nonce-1',
};

test('Claude AskUserQuestion (single, options) → question request', () => {
  const req = normalizeHookPayload(
    {
      session_id: 'abcdef123456',
      cwd: '/proj',
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          { header: 'Deploy', question: 'Where to deploy?', options: [{ label: 'Staging' }, { label: 'Prod', description: 'live' }] },
        ],
      },
    },
    env,
  );
  expect(req).toMatchObject({
    agent: 'claude',
    kind: 'question',
    question: 'Where to deploy?',
    title: 'Deploy',
    options: [{ label: 'Staging' }, { label: 'Prod', description: 'live' }],
    paneId: '%5',
    cwd: '/proj', // payload cwd wins over env
    sessionName: 'work',
    windowName: 'ext',
    subagent: 'review-worker',
  });
  expect(req!.requestId).toMatch(/^claude-/);
});

test('AskUserQuestion with multiple questions → null from the SINGLE-request contract (normalizeHookPayload)', () => {
  const req = normalizeHookPayload(
    { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'a', options: [{ label: 'x' }] }, { question: 'b', options: [{ label: 'y' }] }] } },
    env,
  );
  expect(req).toBeNull();
});

test('normalizeHookRequests: multi-question AskUserQuestion → one request per question (tg#5741)', () => {
  const tool_input = {
    questions: [
      { header: 'Deploy', question: 'Where to deploy?', options: [{ label: 'Staging' }, { label: 'Prod', description: 'live' }] },
      { header: 'Timing', question: 'Deploy when?', options: [{ label: 'Now' }, { label: 'Tonight' }] },
    ],
  };
  const reqs = normalizeHookRequests(
    { session_id: 'abcdef123456', cwd: '/proj', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input },
    env,
  );
  expect(reqs).toHaveLength(2);
  expect(reqs![0]).toMatchObject({
    agent: 'claude',
    kind: 'question',
    question: 'Where to deploy?',
    title: 'Deploy (1/2)', // progress suffix so the human expects the next card
    options: [{ label: 'Staging' }, { label: 'Prod', description: 'live' }],
    paneId: '%5',
    cwd: '/proj',
    toolInput: tool_input, // the ORIGINAL input rides every request for the answer echo
  });
  expect(reqs![1]).toMatchObject({
    question: 'Deploy when?',
    title: 'Timing (2/2)',
    toolInput: tool_input,
  });
  // Per-question STABLE requestIds (replay/reconnect dedup is per sub-question).
  expect(reqs![0].requestId).toMatch(/^claude-/);
  expect(reqs![1].requestId).toMatch(/^claude-/);
  expect(reqs![0].requestId).not.toBe(reqs![1].requestId);
});

test('normalizeHookRequests: single question keeps the plain header title and yields one request', () => {
  const reqs = normalizeHookRequests(
    {
      session_id: 'abcdef123456',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ header: 'Deploy', question: 'Where?', options: [{ label: 'A' }, { label: 'B' }] }] },
    },
    env,
  );
  expect(reqs).toHaveLength(1);
  expect(reqs![0]).toMatchObject({ question: 'Where?', title: 'Deploy' });
});

test('normalizeHookRequests: ALL-OR-NOTHING — any multiSelect/free-form question bails the whole call', () => {
  // A partial forward could only produce a partial answers record, which the
  // reply path must never emit — so one bad question sends ALL of them local.
  expect(
    normalizeHookRequests(
      {
        tool_name: 'AskUserQuestion',
        tool_input: {
          questions: [
            { question: 'ok?', options: [{ label: 'x' }] },
            { question: 'multi?', multiSelect: true, options: [{ label: 'y' }] },
          ],
        },
      },
      env,
    ),
  ).toBeNull();
  expect(
    normalizeHookRequests(
      { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'ok?', options: [{ label: 'x' }] }, { question: 'free-form?' }] } },
      env,
    ),
  ).toBeNull();
  // Beyond the tool's own 4-question schema cap → malformed → local UI.
  expect(
    normalizeHookRequests(
      {
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [1, 2, 3, 4, 5].map((i) => ({ question: `q${i}?`, options: [{ label: 'x' }] })) },
      },
      env,
    ),
  ).toBeNull();
});

test('same question text with DIFFERENT options gets a DIFFERENT requestId (no stale-card re-attach)', () => {
  // Reconnect re-attach and answered-replay key on the requestId. A later call
  // re-asking the same text with different options must get a fresh id — a
  // retained stale card's buttons would otherwise resolve by index against the
  // NEW options. A true re-fire (same text AND same options) keeps its id, so
  // tg-cli#97 dedup/replay is unchanged.
  const payload = (options: Array<{ label: string }>) => ({
    session_id: 'abcdef123456',
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ header: 'Timing', question: 'Deploy when?', options }] },
  });
  const a = normalizeHookRequests(payload([{ label: 'Now' }, { label: 'Tonight' }]), env);
  const b = normalizeHookRequests(payload([{ label: 'Tomorrow' }, { label: 'Next week' }]), env);
  const again = normalizeHookRequests(payload([{ label: 'Now' }, { label: 'Tonight' }]), env);
  expect(a![0].requestId).not.toBe(b![0].requestId);
  expect(a![0].requestId).toBe(again![0].requestId);
});

test('normalizeHookRequests: duplicate question texts bail (requestIds and answers are keyed by text)', () => {
  // The tool's own schema refines question texts unique; a duplicate would
  // collide the per-question requestIds AND collapse the merged answers record,
  // silently dropping one answer — so the whole call goes local instead.
  expect(
    normalizeHookRequests(
      {
        tool_name: 'AskUserQuestion',
        tool_input: {
          questions: [
            { question: 'same?', options: [{ label: 'a' }, { label: 'b' }] },
            { question: 'same?', options: [{ label: 'c' }, { label: 'd' }] },
          ],
        },
      },
      env,
    ),
  ).toBeNull();
});

test('normalizeHookRequests: PermissionRequest-delivered AskUserQuestion copy still drops (tg-cli#97)', () => {
  expect(
    normalizeHookRequests(
      {
        hook_event_name: 'PermissionRequest',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'a?', options: [{ label: 'x' }] }, { question: 'b?', options: [{ label: 'y' }] }] },
      },
      env,
    ),
  ).toBeNull();
});

test('normalizeHookRequests: non-AskUserQuestion payloads delegate to the single-request path', () => {
  const reqs = normalizeHookRequests(
    { session_id: 'sid', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } },
    env,
  );
  expect(reqs).toHaveLength(1);
  expect(reqs![0]).toMatchObject({ kind: 'permission', question: 'Allow Bash? ls' });
  expect(normalizeHookRequests('nope', env)).toBeNull();
  expect(normalizeHookRequests({ hook_event_name: 'SessionStart' }, env)).toBeNull();
});

test('normalizeHookPayload: a single AskUserQuestion now carries the original tool_input for the answer echo', () => {
  const tool_input = { questions: [{ header: 'Deploy', question: 'Where?', options: [{ label: 'A' }, { label: 'B' }] }] };
  const req = normalizeHookPayload({ session_id: 'sid', tool_name: 'AskUserQuestion', tool_input }, env);
  expect(req?.toolInput).toEqual(tool_input);
});

test('AskUserQuestion multiSelect → null', () => {
  const req = normalizeHookPayload(
    { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'a', multiSelect: true, options: [{ label: 'x' }] }] } },
    env,
  );
  expect(req).toBeNull();
});

test('AskUserQuestion with no concrete options → null', () => {
  const req = normalizeHookPayload({ tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'free?' }] } }, env);
  expect(req).toBeNull();
});

test('AskUserQuestion delivered via the PermissionRequest matcher → null (no double-cover, tg-cli#97)', () => {
  // Claude installs BOTH a PreToolUse:AskUserQuestion matcher AND a
  // PermissionRequest:* catch-all, so an AskUserQuestion fires the hook twice and
  // both copies normalize to the SAME stable requestId. Only the PreToolUse copy
  // forwards; the PermissionRequest-delivered copy must drop so a re-fire after the
  // answer can't post a second, "expired"-reading card.
  const payload = {
    session_id: 'abcdef123456',
    cwd: '/proj',
    hook_event_name: 'PermissionRequest',
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [{ header: 'Deploy', question: 'Where to deploy?', options: [{ label: 'Staging' }, { label: 'Prod' }] }],
    },
  };
  expect(normalizeHookPayload(payload, env)).toBeNull();

  // The dedicated PreToolUse copy of the very same question still forwards.
  expect(normalizeHookPayload({ ...payload, hook_event_name: 'PreToolUse' }, env)).toMatchObject({
    kind: 'question',
    question: 'Where to deploy?',
  });

  // Back-compat: a payload with NO hook_event_name (manual callers / very old
  // installs that never wrote the event) is NOT the PermissionRequest catch-all,
  // so it must still forward — the drop is strictly the PermissionRequest copy.
  const { hook_event_name, ...noEvent } = payload;
  void hook_event_name;
  expect(normalizeHookPayload(noEvent, env)).toMatchObject({ kind: 'question', question: 'Where to deploy?' });
});

test('PermissionRequest → permission with a tool + command summary', () => {
  const req = normalizeHookPayload(
    { session_id: 'sid', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/x' } },
    env,
  );
  expect(req).toMatchObject({ kind: 'permission', title: 'Bash', question: 'Allow Bash? rm -rf /tmp/x', paneId: '%5' });
});

test('Codex PermissionRequest uses the --agent kind', () => {
  const req = normalizeHookPayload(
    { hook_event_name: 'PermissionRequest', tool_name: 'shell', tool_input: { command: 'ls' } },
    { ...env, agent: 'codex' },
  );
  expect(req).toMatchObject({ agent: 'codex', kind: 'permission', question: 'Allow shell? ls' });
});

test('an already-normalized ButtonRequest passes through, env fills missing routing', () => {
  const req = normalizeHookPayload(
    { requestId: 'r1', agent: 'claude', kind: 'question', question: 'q?', options: [{ label: 'ok' }] },
    env,
  );
  expect(req).toMatchObject({
    requestId: 'r1',
    kind: 'question',
    question: 'q?',
    paneId: '%5',
    cwd: '/env/cwd',
    windowName: 'ext',
    subagent: 'review-worker',
  });
});

test('an already-normalized ButtonRequest keeps explicit source fields over env defaults', () => {
  const req = normalizeHookPayload(
    {
      requestId: 'r2',
      agent: 'claude',
      kind: 'permission',
      question: 'ok?',
      windowName: 'api',
      subagent: 'qa-worker',
      paneId: '%9',
      cwd: '/payload/cwd',
      sessionName: 'payload-session',
    },
    env,
  );
  expect(req).toMatchObject({
    requestId: 'r2',
    kind: 'permission',
    question: 'ok?',
    windowName: 'api',
    subagent: 'qa-worker',
    paneId: '%9',
    cwd: '/payload/cwd',
    sessionName: 'payload-session',
  });
});

test('garbage → null', () => {
  expect(normalizeHookPayload(null, env)).toBeNull();
  expect(normalizeHookPayload({ hook_event_name: 'SessionStart' }, env)).toBeNull();
  expect(normalizeHookPayload('nope', env)).toBeNull();
});

// requestId must be scoped to the PROMPT TURN (Claude Code's `prompt_id`, Codex's
// `turn_id`), not just the session — otherwise two DIFFERENT turns in the same
// long-running session that happen to ask an identical permission/question collide
// on the same requestId, which is what let a QUEUED permission decision be
// auto-delivered onto a materially later, unrelated request (the bug this hardens
// against — tg-ctl no longer time-bounds queued-decision delivery, so the identity
// check alone must be airtight).
test('PermissionRequest: same session/tool/command but a DIFFERENT prompt_id (a later, unrelated turn) gets a DIFFERENT requestId', () => {
  const base = { session_id: 'sid12345', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } };
  const first = normalizeHookPayload({ ...base, prompt_id: 'prompt-a' }, env);
  const later = normalizeHookPayload({ ...base, prompt_id: 'prompt-b' }, env);
  expect(first!.requestId).not.toBe(later!.requestId);
});

test('PermissionRequest: the SAME prompt_id AND the SAME invocationNonce (a genuine hook reconnect-and-resend, same process) gets the SAME requestId', () => {
  const payload = { session_id: 'sid12345', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' }, prompt_id: 'prompt-a' };
  const first = normalizeHookPayload(payload, env);
  const resent = normalizeHookPayload(payload, env); // same shared `env` object → same invocationNonce
  expect(first!.requestId).toBe(resent!.requestId);
});

// The core fix for the intra-turn hazard (review finding, tg#9982 follow-up):
// prompt_id alone scopes to the whole TURN, not the individual tool call — two
// DISTINCT invocations of the identical command in the SAME turn must still get
// DIFFERENT requestIds. env.invocationNonce (one per `tg-ctl ask` PROCESS, i.e.
// one per hook event in production) is what actually guarantees this.
test('PermissionRequest: SAME prompt_id but a DIFFERENT invocationNonce (two distinct tool calls in ONE turn) gets a DIFFERENT requestId', () => {
  const payload = { session_id: 'sid12345', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' }, prompt_id: 'prompt-a' };
  const first = normalizeHookPayload(payload, { ...env, invocationNonce: 'nonce-1' });
  const secondCallSameTurn = normalizeHookPayload(payload, { ...env, invocationNonce: 'nonce-2' });
  expect(first!.requestId).not.toBe(secondCallSameTurn!.requestId);
});

test('Codex PermissionRequest: turn_id scopes the requestId the same way prompt_id does for claude', () => {
  const codexEnv = { ...env, agent: 'codex' as const };
  const base = { session_id: 'sid12345', hook_event_name: 'PermissionRequest', tool_name: 'shell', tool_input: { command: 'ls' } };
  const first = normalizeHookPayload({ ...base, turn_id: 'turn-a' }, codexEnv);
  const later = normalizeHookPayload({ ...base, turn_id: 'turn-b' }, codexEnv);
  expect(first!.requestId).not.toBe(later!.requestId);
});

test('ExitPlanMode: a DIFFERENT prompt_id for the identical plan text gets a DIFFERENT requestId', () => {
  const base = { session_id: 'sid12345', hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: 'Do the thing' } };
  const first = normalizeHookPayload({ ...base, prompt_id: 'prompt-a' }, env);
  const later = normalizeHookPayload({ ...base, prompt_id: 'prompt-b' }, env);
  expect(first!.requestId).not.toBe(later!.requestId);
});

test('ExitPlanMode: SAME prompt_id but a DIFFERENT invocationNonce still gets a DIFFERENT requestId', () => {
  const payload = { session_id: 'sid12345', hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: 'Do the thing' }, prompt_id: 'prompt-a' };
  const first = normalizeHookPayload(payload, { ...env, invocationNonce: 'nonce-1' });
  const second = normalizeHookPayload(payload, { ...env, invocationNonce: 'nonce-2' });
  expect(first!.requestId).not.toBe(second!.requestId);
});

// tg-cli#424 review finding F1: clampPlan's PLAN_MAX=3000 cut is the exact
// same live-incident bug class (tg#17245) — an agent plan whose truncation
// boundary lands mid-emoji orphans a lone surrogate, and Telegram's
// sendMessage for the ExitPlanMode plan-approval card 400s wholesale.
test('ExitPlanMode: a plan that would split an emoji surrogate pair at the 3000-char cut is not orphaned', () => {
  // 2999 filler chars + 😀 (\uD83D\uDE00) puts the high surrogate exactly at
  // index 2999 — a naive `.slice(0, 3000)` keeps it and drops its
  // low-surrogate partner.
  const plan = `${'x'.repeat(2999)}\ud83d\ude00${'y'.repeat(50)}`;
  const req = normalizeHookPayload({ session_id: 'sid', hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { plan } }, env);
  expect(req!.question).toBe(`Proceed with this plan?\n\n${'x'.repeat(2999)}\n… (plan truncated — see the pane)`);
  expect(hasUnpairedSurrogate(req!.question)).toBe(false);
});

// tg-cli#424 review finding F2: summarizeInput's 100-char cut feeds the
// permission-prompt question — same bug class, same live failure mode.
test('PermissionRequest: a command summary that would split an emoji surrogate pair at the 100-char cut is not orphaned', () => {
  // 98 filler chars + 😀 (\uD83D\uDE00) puts the high surrogate exactly at
  // index 98 — a naive `.slice(0, 99)` keeps it and drops its low-surrogate
  // partner.
  const command = `${'x'.repeat(98)}\ud83d\ude00${'y'.repeat(20)}`;
  const req = normalizeHookPayload({ session_id: 'sid', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command } }, env);
  expect(req!.question).toBe(`Allow Bash? ${'x'.repeat(98)}…`);
  expect(hasUnpairedSurrogate(req!.question)).toBe(false);
});

test('a payload with no prompt_id/turn_id (older harness) still normalizes — env.invocationNonce alone still scopes it correctly', () => {
  const req = normalizeHookPayload(
    { session_id: 'sid12345', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } },
    env,
  );
  expect(req).toMatchObject({ kind: 'permission', question: 'Allow Bash? ls' });
});

// ButtonRequest.promptTurnId is the identity PROOF tg-ctl's reconnect branch
// requires before auto-delivering a queued permission decision with no time
// bound — it now comes from env.invocationNonce (always a fresh, non-empty
// string per `tg-ctl ask` process), so it is ALWAYS set for anything normalized
// from a raw harness payload, regardless of whether the harness itself sends
// prompt_id/turn_id (see AGENTS.md's "Queued permission decisions" entry).
test('promptTurnId is always set to env.invocationNonce for a raw harness payload, regardless of prompt_id/turn_id presence', () => {
  const withPromptId = normalizeHookPayload(
    { session_id: 'sid12345', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' }, prompt_id: 'prompt-a' },
    env,
  );
  expect(withPromptId!.promptTurnId).toBe('env-nonce-1');

  const withoutPromptId = normalizeHookPayload(
    { session_id: 'sid12345', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } },
    env,
  );
  expect(withoutPromptId!.promptTurnId).toBe('env-nonce-1');
});

test('promptTurnId is set on ExitPlanMode from env.invocationNonce', () => {
  const req = normalizeHookPayload(
    { session_id: 'sid12345', hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: 'Do the thing' } },
    env,
  );
  expect(req!.promptTurnId).toBe('env-nonce-1');
});

// The "already normalized" manual/back-compat pass-through is DELIBERATELY NOT
// force-overridden with env.invocationNonce (unlike the raw-harness branches
// above) — it's not real harness traffic (a genuine Claude Code/Codex hook
// always sends raw JSON, never an already-shaped ButtonRequest), so it stays
// free to explicitly omit promptTurnId. This is the one remaining way to model
// "no identity proof" in tests (see ctl-question-durable-integration.test.ts's
// "no promptTurnId" tests) — standing in for a genuinely pre-upgrade on-disk
// record from before this field existed.
test('an already-normalized ButtonRequest carries an explicit promptTurnId through unchanged (NOT overridden by env.invocationNonce)', () => {
  const req = normalizeHookPayload(
    { requestId: 'r9', agent: 'claude', kind: 'permission', question: 'ok?', promptTurnId: 'prompt-z' },
    env,
  );
  expect(req!.promptTurnId).toBe('prompt-z');
});

test('an already-normalized ButtonRequest with NO promptTurnId stays undefined (not backfilled from env.invocationNonce)', () => {
  const req = normalizeHookPayload(
    { requestId: 'r10', agent: 'claude', kind: 'permission', question: 'ok?' },
    env,
  );
  expect(req!.promptTurnId).toBeUndefined();
});

// DELIBERATE ASYMMETRY (regression guard): a QUESTION does NOT fold
// env.invocationNonce into its hash — only prompt_id/turn_id (invocationSeed).
// A question has no queuedDecision auto-delivery hazard, and the existing,
// TESTED multi-question retry contract (ctl-multi-question-abandon-integration
// .test.ts) needs a re-asked question from a genuinely NEW `tg-ctl ask` process
// (same content, same prompt_id) to hash IDENTICALLY so it re-attaches to its
// retained card instead of duplicating. This was tried the other way (folding
// the nonce into every kind uniformly) and broke that exact test — this guard
// pins the correct, asymmetric behavior so it can't regress silently again.
test('AskUserQuestion: SAME prompt_id but a DIFFERENT invocationNonce (a retry from a new process) gets the SAME requestId — no nonce folded in for questions', () => {
  const tool_input = { questions: [{ question: 'Where to deploy?', options: [{ label: 'Staging' }] }] };
  const payload = { session_id: 'sid12345', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input, prompt_id: 'prompt-a' };
  const first = normalizeHookPayload(payload, { ...env, invocationNonce: 'nonce-1' });
  const retriedFromNewProcess = normalizeHookPayload(payload, { ...env, invocationNonce: 'nonce-2' });
  expect(first!.requestId).toBe(retriedFromNewProcess!.requestId);
});

test('AskUserQuestion: promptTurnId comes from prompt_id/turn_id, NOT env.invocationNonce', () => {
  const tool_input = { questions: [{ question: 'Where to deploy?', options: [{ label: 'Staging' }] }] };
  const req = normalizeHookPayload(
    { session_id: 'sid12345', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input, prompt_id: 'prompt-a' },
    env,
  );
  expect(req!.promptTurnId).toBe('prompt-a');
});
