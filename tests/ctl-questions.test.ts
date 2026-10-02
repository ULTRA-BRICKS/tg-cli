import { expect, test } from 'bun:test';
import {
  buildButtonMessage,
  buildClaudeQuestionAnswerOutput,
  collectQuestionAnswers,
  extractAnswersFromHookReply,
  formatAgentHookOutput,
  formatAnsweredButtonMessage,
  parseButtonCallback,
  questionCapability,
  registrationAllowsHook,
  repairClaudeQuestionReply,
  resolveButtonCallback,
  type ButtonRequest,
} from '../features/tg-ctl/questions';

const QUESTION: ButtonRequest = {
  requestId: 'q_123',
  agent: 'claude',
  kind: 'question',
  title: 'Pick deploy target',
  question: 'Where should I deploy?',
  options: [
    { label: 'Staging', description: 'Safe validation environment' },
    { label: 'Production', description: 'Customer-facing environment' },
  ],
};

test('registrationAllowsHook: paneId match wins, paneId contradiction rejects despite cwd match', () => {
  const reg = { paneId: '%32', cwd: '/proj', sessionName: 'work' };
  expect(registrationAllowsHook(reg, { paneId: '%32' })).toBe(true);
  // A second keyboard session in the SAME cwd but a different pane must
  // fast-pass to the local UI, not block on Telegram.
  expect(registrationAllowsHook(reg, { paneId: '%40', cwd: '/proj' })).toBe(false);
  expect(registrationAllowsHook(reg, { paneId: '%40', sessionName: 'work' })).toBe(false);
});

test('registrationAllowsHook: cwd and sessionName match when paneId is unknown on either side', () => {
  const reg = { paneId: '%32', cwd: '/proj', sessionName: 'work' };
  expect(registrationAllowsHook(reg, { cwd: '/proj' })).toBe(true);
  expect(registrationAllowsHook(reg, { sessionName: 'work' })).toBe(true);
  expect(registrationAllowsHook(reg, { cwd: '/other' })).toBe(false);
  expect(registrationAllowsHook({ cwd: '/proj' }, { paneId: '%40', cwd: '/proj' })).toBe(true);
});

test('registrationAllowsHook: missing registration or no overlapping fields rejects', () => {
  expect(registrationAllowsHook(null, { paneId: '%32' })).toBe(false);
  expect(registrationAllowsHook({}, { paneId: '%32', cwd: '/proj', sessionName: 'work' })).toBe(false);
});

test('registrationAllowsHook: cwd comparison goes through the injected path resolver', () => {
  const reg = { cwd: '/proj/sub/..' };
  const resolver = (p: string) => p.replace('/sub/..', '');
  expect(registrationAllowsHook(reg, { cwd: '/proj' }, resolver)).toBe(true);
});

test('questionCapability is explicit: claude/codex/opencode support buttons, pi is limited', () => {
  expect(questionCapability('claude')).toBe('buttons');
  expect(questionCapability('codex')).toBe('buttons');
  expect(questionCapability('opencode')).toBe('buttons');
  expect(questionCapability('pi')).toBe('unsupported');
});

test('buildButtonMessage renders a question as Telegram inline keyboard payload', () => {
  const payload = buildButtonMessage(1000, QUESTION);
  expect(payload.chat_id).toBe(1000);
  expect(payload.text).toContain('Question from claude');
  expect(payload.text).toContain('Pick deploy target');
  expect(payload.text).toContain('Where should I deploy?');
  expect(payload.reply_markup).toEqual({
    inline_keyboard: [
      [{ text: 'Staging', callback_data: 'tgq:q_123:o0' }],
      [{ text: 'Production', callback_data: 'tgq:q_123:o1' }],
    ],
  });
});

test('formatAnsweredButtonMessage keeps the original question, answer, agent, and subagent context', () => {
  const text = formatAnsweredButtonMessage(
    {
      ...QUESTION,
      paneId: '%7',
      cwd: '/work/project-a',
      sessionName: 'topic-ext',
      subagent: 'planner',
    },
    {
      status: 'answered',
      requestId: 'q_123',
      label: 'Production',
      value: 'Production',
    },
  );

  expect(text).toContain('Question answered');
  expect(text).toContain('Agent: claude');
  expect(text).toContain('Subagent: planner');
  expect(text).toContain('Context: session topic-ext, pane %7, project project-a');
  expect(text).toContain('Asked:\nWhere should I deploy?');
  expect(text).toContain('Selected:\nProduction');
  expect(text).not.toBe('answered: Production');
});

test('formatAnsweredButtonMessage stays under the Telegram edit limit for long prompts', () => {
  const text = formatAnsweredButtonMessage(
    {
      ...QUESTION,
      title: 'T'.repeat(1200),
      question: 'Q'.repeat(5000),
      subagent: 'planner',
    },
    {
      status: 'answered',
      requestId: 'q_123',
      label: 'Approve',
      value: 'Approve',
    },
  );

  expect(text.length).toBeLessThanOrEqual(3900);
  expect(text).toContain('Question answered');
  expect(text).toContain('Agent: claude');
  expect(text).toContain('Subagent: planner');
  expect(text).toContain('Asked:\n');
  expect(text).toContain('Selected:\nApprove');
});

test('buildButtonMessage uses short buttonId for callback data when requestId is long or opaque', () => {
  const payload = buildButtonMessage(1000, {
    requestId: 'oc:ses_12345678901234567890:que_12345678901234567890',
    buttonId: 'b1',
    agent: 'opencode',
    kind: 'question',
    question: 'Pick one',
    options: [{ label: 'A' }],
  });
  expect(payload.reply_markup.inline_keyboard).toEqual([
    [{ text: 'A', callback_data: 'tgq:b1:o0' }],
  ]);
  expect(payload.reply_markup.inline_keyboard[0][0].callback_data.length).toBeLessThanOrEqual(64);
});

test('buildButtonMessage ignores invalid buttonId values', () => {
  const payload = buildButtonMessage(1000, {
    requestId: 'safe_request',
    buttonId: 'bad:id:that:cannot:roundtrip',
    agent: 'claude',
    kind: 'question',
    question: 'Pick one',
    options: [{ label: 'A' }],
  });
  expect(payload.reply_markup.inline_keyboard).toEqual([
    [{ text: 'A', callback_data: 'tgq:safe_request:o0' }],
  ]);
});

test('permission requests render approve/reject buttons', () => {
  const payload = buildButtonMessage(1000, {
    requestId: 'p_9',
    agent: 'codex',
    kind: 'permission',
    question: 'Run: rm -rf dist?',
  });
  expect(payload.text).toContain('Permission request from codex');
  expect(payload.reply_markup.inline_keyboard).toEqual([
    [
      { text: 'Approve', callback_data: 'tgq:p_9:allow' },
      { text: 'Reject', callback_data: 'tgq:p_9:deny' },
    ],
  ]);
});

test('parseButtonCallback accepts only tg-cli callback data', () => {
  expect(parseButtonCallback('tgq:q_123:o1')).toEqual({
    requestId: 'q_123',
    value: 'o1',
  });
  expect(parseButtonCallback('other:q_123:o1')).toBe(null);
  expect(parseButtonCallback('tgq:q_123')).toBe(null);
  expect(parseButtonCallback('tgq::o1')).toBe(null);
});

test('resolveButtonCallback maps option callbacks to labels', () => {
  expect(resolveButtonCallback(QUESTION, { requestId: 'q_123', value: 'o1' })).toEqual({
    status: 'answered',
    requestId: 'q_123',
    label: 'Production',
    value: 'Production',
  });
});

test('resolveButtonCallback resolves the default OK button when no options are supplied', () => {
  expect(
    resolveButtonCallback(
      { requestId: 'q_no_options', agent: 'claude', kind: 'question', question: 'Continue?' },
      { requestId: 'q_no_options', value: 'o0' },
    ),
  ).toEqual({
    status: 'answered',
    requestId: 'q_no_options',
    label: 'OK',
    value: 'OK',
  });
});

test('resolveButtonCallback accepts the short buttonId while preserving the full requestId', () => {
  expect(
    resolveButtonCallback(
      {
        requestId: 'oc:ses_12345678901234567890:que_12345678901234567890',
        buttonId: 'b1',
        agent: 'opencode',
        kind: 'question',
        question: 'Pick one',
        options: [{ label: 'A' }],
      },
      { requestId: 'b1', value: 'o0' },
    ),
  ).toMatchObject({
    status: 'answered',
    requestId: 'oc:ses_12345678901234567890:que_12345678901234567890',
    label: 'A',
  });
});

test('resolveButtonCallback maps permission callbacks to allow/deny decisions', () => {
  const req: ButtonRequest = {
    requestId: 'p_9',
    agent: 'codex',
    kind: 'permission',
    question: 'Run command?',
  };
  expect(resolveButtonCallback(req, { requestId: 'p_9', value: 'allow' })).toMatchObject({
    status: 'answered',
    decision: 'allow',
  });
  expect(resolveButtonCallback(req, { requestId: 'p_9', value: 'deny' })).toMatchObject({
    status: 'answered',
    decision: 'deny',
  });
});

test('formatAgentHookOutput emits Claude AskUserQuestion updatedInput answer shape (hookEventName REQUIRED)', () => {
  const output = formatAgentHookOutput(QUESTION, {
    status: 'answered',
    requestId: 'q_123',
    label: 'Staging',
    value: 'Staging',
  });
  // hookEventName is load-bearing: Claude Code (verified on 2.1.198) discards
  // the ENTIRE hook output when hookSpecificOutput lacks it, so the tapped
  // answer never reaches the agent while the card reads "answered" (tg#5741).
  expect(output).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: {
        questions: [
          {
            header: 'Pick deploy target',
            question: 'Where should I deploy?',
            options: [
              { label: 'Staging', description: 'Safe validation environment' },
              { label: 'Production', description: 'Customer-facing environment' },
            ],
          },
        ],
        answers: {
          'Where should I deploy?': 'Staging',
        },
      },
    },
  });
});

test('formatAgentHookOutput echoes the ORIGINAL tool_input when the request carries it', () => {
  // Claude Code schema-validates updatedInput wholesale against the tool's input
  // schema (option `description` is REQUIRED there, previews must survive), so the
  // envelope must echo the original input — not a lossy rebuild — whenever the
  // request carries it.
  const toolInput = {
    questions: [
      {
        header: 'Deploy',
        question: 'Where should I deploy?',
        options: [
          { label: 'Staging', description: 'Safe', preview: 'staging.example.com' },
          { label: 'Production', description: 'Live' },
        ],
        multiSelect: false,
      },
    ],
    metadata: { source: 'unit-test' },
  };
  const output = formatAgentHookOutput({ ...QUESTION, toolInput }, {
    status: 'answered',
    requestId: 'q_123',
    label: 'Production',
    value: 'Production',
  });
  expect(output).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: {
        ...toolInput,
        answers: { 'Where should I deploy?': 'Production' },
      },
    },
  });
});

test('extractAnswersFromHookReply reads current AND legacy (pre-hookEventName) envelopes', () => {
  const answers = { 'Where should I deploy?': 'Staging' };
  const current = JSON.stringify(buildClaudeQuestionAnswerOutput({ questions: [] }, answers));
  expect(extractAnswersFromHookReply(current)).toEqual(answers);
  // The RUNNING daemon may be older than the hook client (live-symlink deploy):
  // its reply lacks hookEventName but still carries updatedInput.answers.
  const legacy = JSON.stringify({
    hookSpecificOutput: { permissionDecision: 'allow', updatedInput: { questions: [], answers } },
  });
  expect(extractAnswersFromHookReply(legacy)).toEqual(answers);
});

test('extractAnswersFromHookReply rejects declines, non-question envelopes, and garbage', () => {
  expect(extractAnswersFromHookReply(null)).toBeNull();
  expect(extractAnswersFromHookReply('null')).toBeNull();
  expect(extractAnswersFromHookReply('not json')).toBeNull();
  expect(extractAnswersFromHookReply('{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}')).toBeNull();
  // Non-string answer values must not leak through as answers.
  expect(extractAnswersFromHookReply('{"hookSpecificOutput":{"updatedInput":{"answers":{"q":42}}}}')).toBeNull();
  expect(extractAnswersFromHookReply('{"hookSpecificOutput":{"updatedInput":{"answers":[]}}}')).toBeNull();
});

test('collectQuestionAnswers merges one answer per question, sequentially', async () => {
  const q1: ButtonRequest = { ...QUESTION, requestId: 'q_1', question: 'Q one?' };
  const q2: ButtonRequest = { ...QUESTION, requestId: 'q_2', question: 'Q two?' };
  const asked: string[] = [];
  const answers = await collectQuestionAnswers([q1, q2], async (req) => {
    asked.push(req.requestId);
    return JSON.stringify(
      buildClaudeQuestionAnswerOutput({ questions: [] }, { [req.question]: `answer for ${req.requestId}` }),
    );
  });
  expect(asked).toEqual(['q_1', 'q_2']);
  expect(answers).toEqual({ 'Q one?': 'answer for q_1', 'Q two?': 'answer for q_2' });
});

test('collectQuestionAnswers is ALL-OR-NOTHING: a decline aborts without asking the rest', async () => {
  const q1: ButtonRequest = { ...QUESTION, requestId: 'q_1', question: 'Q one?' };
  const q2: ButtonRequest = { ...QUESTION, requestId: 'q_2', question: 'Q two?' };
  const q3: ButtonRequest = { ...QUESTION, requestId: 'q_3', question: 'Q three?' };
  const asked: string[] = [];
  const answers = await collectQuestionAnswers([q1, q2, q3], async (req) => {
    asked.push(req.requestId);
    if (req.requestId === 'q_2') return null; // timeout / decline
    return JSON.stringify(buildClaudeQuestionAnswerOutput({ questions: [] }, { [req.question]: 'ok' }));
  });
  expect(answers).toBeNull();
  expect(asked).toEqual(['q_1', 'q_2']); // q_3 is never asked once the call is doomed
});

test('collectQuestionAnswers rejects a reply that answers a DIFFERENT question', async () => {
  const q1: ButtonRequest = { ...QUESTION, requestId: 'q_1', question: 'Q one?' };
  const answers = await collectQuestionAnswers([q1], async () =>
    JSON.stringify(buildClaudeQuestionAnswerOutput({ questions: [] }, { 'Some other question?': 'ok' })),
  );
  expect(answers).toBeNull();
});

test('repairClaudeQuestionReply rebuilds a legacy daemon reply from the carried tool_input', () => {
  const toolInput = {
    questions: [
      {
        header: 'Deploy',
        question: 'Where should I deploy?',
        options: [
          { label: 'Staging', description: 'Safe' },
          { label: 'Production', description: 'Live' },
        ],
      },
    ],
  };
  const legacy = JSON.stringify({
    hookSpecificOutput: {
      permissionDecision: 'allow',
      updatedInput: { questions: [], answers: { 'Where should I deploy?': 'Staging' } },
    },
  });
  const repaired = repairClaudeQuestionReply({ ...QUESTION, toolInput }, legacy);
  expect(repaired).not.toBeNull();
  expect(JSON.parse(repaired!)).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { ...toolInput, answers: { 'Where should I deploy?': 'Staging' } },
    },
  });
});

test('repairClaudeQuestionReply declines when it cannot rebuild faithfully', () => {
  const toolInput = { questions: [] };
  // No carried tool_input → nothing schema-valid to echo → pass through verbatim.
  expect(repairClaudeQuestionReply(QUESTION, '{"hookSpecificOutput":{"updatedInput":{"answers":{"Where should I deploy?":"x"}}}}')).toBeNull();
  // A permission request is a different envelope entirely.
  expect(
    repairClaudeQuestionReply(
      { requestId: 'p_1', agent: 'claude', kind: 'permission', question: 'Allow?', toolInput },
      '{"hookSpecificOutput":{"updatedInput":{"answers":{"Allow?":"x"}}}}',
    ),
  ).toBeNull();
  // A reply without a recognizable answer for THIS question.
  expect(repairClaudeQuestionReply({ ...QUESTION, toolInput }, 'null')).toBeNull();
  expect(repairClaudeQuestionReply({ ...QUESTION, toolInput }, '{"hookSpecificOutput":{"updatedInput":{"answers":{"other?":"x"}}}}')).toBeNull();
});

test('formatAgentHookOutput emits Codex PermissionRequest shape', () => {
  const output = formatAgentHookOutput(
    { requestId: 'p_9', agent: 'codex', kind: 'permission', question: 'Run command?' },
    { status: 'answered', requestId: 'p_9', label: 'Reject', value: 'deny', decision: 'deny' },
  );
  expect(output).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'deny',
        message: 'Rejected from Telegram',
      },
    },
  });
});

test('formatAgentHookOutput returns null for unsupported pi so local UI takes over', () => {
  const output = formatAgentHookOutput(
    { requestId: 'pi_1', agent: 'pi', kind: 'question', question: 'Continue?' },
    { status: 'unsupported', requestId: 'pi_1', reason: 'native question forwarding is not available for pi' },
  );
  expect(output).toBe(null);
});
