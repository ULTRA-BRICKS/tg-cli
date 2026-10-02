import { expect, test } from 'bun:test';
import { normalizeHookPayload, normalizeHookRequests, type HookEnv } from '../features/tg-ctl/hook-normalize';

const env: HookEnv = { agent: 'claude', paneId: '%5', cwd: '/env/cwd', sessionName: 'work' };

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
  });
  expect(req!.requestId).toMatch(/^claude-/);
});

test('normalizeHookPayload preserves an explicit subagent label from normalized requests', () => {
  const req = normalizeHookPayload(
    {
      requestId: 'q_subagent',
      agent: 'claude',
      kind: 'question',
      question: 'Proceed?',
      options: [{ label: 'Yes' }],
      subagent: 'planner',
    },
    env,
  );

  expect(req).toMatchObject({
    requestId: 'q_subagent',
    subagent: 'planner',
    paneId: '%5',
    sessionName: 'work',
  });
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
  expect(req).toMatchObject({ requestId: 'r1', kind: 'question', question: 'q?', paneId: '%5', cwd: '/env/cwd' });
});

test('garbage → null', () => {
  expect(normalizeHookPayload(null, env)).toBeNull();
  expect(normalizeHookPayload({ hook_event_name: 'SessionStart' }, env)).toBeNull();
  expect(normalizeHookPayload('nope', env)).toBeNull();
});
