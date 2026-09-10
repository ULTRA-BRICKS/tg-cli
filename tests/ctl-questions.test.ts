import { expect, test } from 'bun:test';
import {
  abandonedLongOutageText,
  abandonedMultiText,
  abandonedPermissionText,
  buildAnsweredQuestionText,
  buildButtonMessage,
  buildClaudeQuestionAnswerOutput,
  buildPostTimeoutQuestionMessage,
  collectQuestionAnswers,
  extractAnswersFromHookReply,
  formatAgentHookOutput,
  parseButtonCallback,
  parseQuestionCloseCallback,
  isHatchPermissionRequest,
  questionCapability,
  queuedDecisionCanAutoDeliver,
  queuedDecisionStillWaitingText,
  queuedPermissionDecisionText,
  registrationAllowsHook,
  repairClaudeQuestionReply,
  resolveButtonCallback,
  type ButtonRequest,
} from '../features/tg-ctl/questions';
import { HOOK_AGENT_KINDS, isHookAgentKind } from '../features/tg-ctl/types';

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

const PERMISSION: ButtonRequest = {
  requestId: 'p_123',
  agent: 'claude',
  kind: 'permission',
  question: 'Allow bash command: rm -rf /tmp/test?',
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

test('isHatchPermissionRequest: permission whose requestId starts with hatch- only', () => {
  expect(isHatchPermissionRequest({
    kind: 'permission',
    requestId: 'hatch-no-long-inline-process-abc123',
  })).toBe(true);
  expect(isHatchPermissionRequest({
    kind: 'permission',
    requestId: 'hatch-',
  })).toBe(true);
  // A normal permission must still go through the registration gate.
  expect(isHatchPermissionRequest(PERMISSION)).toBe(false);
  // Kind matters: a question that merely reuses the prefix is not a hatch.
  expect(isHatchPermissionRequest({
    kind: 'question',
    requestId: 'hatch-no-long-inline-process-abc123',
  })).toBe(false);
  expect(isHatchPermissionRequest({
    kind: 'permission',
    requestId: 'no-long-inline-process-hatch-abc',
  })).toBe(false);
});

test('questionCapability is explicit: claude/codex/opencode/omp support buttons, pi/aider are limited', () => {
  expect(questionCapability('claude')).toBe('buttons');
  expect(questionCapability('codex')).toBe('buttons');
  expect(questionCapability('opencode')).toBe('buttons');
  expect(questionCapability('omp')).toBe('buttons');
  expect(questionCapability('pi')).toBe('unsupported');
  expect(questionCapability('aider')).toBe('unsupported');
});

test('HOOK_AGENT_KINDS accepts omp (ask --agent omp classifies as omp, not a claude fallback)', () => {
  // Pins the single source hookAgentFromArgv validates against: dropping 'omp'
  // from this list would silently give an explicit omp ask claude semantics.
  expect(HOOK_AGENT_KINDS).toContain('omp');
  expect(HOOK_AGENT_KINDS).toContain('pi');
  expect(HOOK_AGENT_KINDS).toContain('aider');
  // The guard narrows without coercion: typos, non-kinds, and
  // Object.prototype keys are all rejected (Object.hasOwn, not `in`).
  expect(isHookAgentKind('omp')).toBe(true);
  expect(isHookAgentKind('opm')).toBe(false);
  expect(isHookAgentKind('unknown')).toBe(false);
  expect(isHookAgentKind('toString')).toBe(false);
  expect(isHookAgentKind('constructor')).toBe(false);
});

test('buildButtonMessage renders a question as Telegram inline keyboard payload', () => {
  const payload = buildButtonMessage(1000, QUESTION);
  expect(payload.chat_id).toBe(1000);
  expect(payload.text).toContain('Question from claude');
  expect(payload.text).toContain('Source: agent=claude');
  expect(payload.text).toContain('Pick deploy target');
  expect(payload.text).toContain('Where should I deploy?');
  expect(payload.reply_markup).toEqual({
    inline_keyboard: [
      [{ text: 'Staging', callback_data: 'tgq:q_123:o0' }],
      [{ text: 'Production', callback_data: 'tgq:q_123:o1' }],
    ],
  });
});

test('buildButtonMessage includes source agent, subagent, window, pane, session, and cwd', () => {
  const payload = buildButtonMessage(1000, {
    requestId: 'p_src',
    agent: 'claude',
    subagent: 'review-worker',
    windowName: 'ext',
    paneId: '%7',
    sessionName: 'work',
    cwd: '/Users/ultra/work/hyperide',
    kind: 'permission',
    title: 'Bash',
    question: 'Allow Bash? pkill -9 hvsc',
  });
  expect(payload.text).toContain('Permission request from claude');
  expect(payload.text).toContain('Source: agent=claude · subagent=review-worker · window=ext · pane=%7 · session=work');
  expect(payload.text).toContain('Cwd: /Users/ultra/work/hyperide');
});

test('buildPostTimeoutQuestionMessage preserves the original question and accepts a text reply', () => {
  const payload = buildPostTimeoutQuestionMessage(1000, QUESTION);
  expect(payload.chat_id).toBe(1000);
  expect(payload.text).toContain('Question from claude');
  expect(payload.text).toContain('Pick deploy target');
  expect(payload.text).toContain('Where should I deploy?');
  expect(payload.text).toContain('Options:');
  expect(payload.text).toContain('1. Staging - Safe validation environment');
  expect(payload.text).toContain('2. Production - Customer-facing environment');
  expect(payload.text).toContain('Time-out expired.');
  expect(payload.text).toContain('Reply to this message with your answer');
  expect(payload.reply_markup).toEqual({
    inline_keyboard: [[{ text: 'Close', callback_data: 'tgqc:q_123' }]],
  });
});

test('abandonedPermissionText identifies which pane disconnected, never promises a reconnect, says a tap is queued, and keeps the original prompt visible', () => {
  const text = abandonedPermissionText(PERMISSION, 'rig');
  expect(text).toContain('rig');
  expect(text).toContain('hook disconnected');
  // Must read as a transient, uncertain socket close — not agent death, and NOT a
  // false promise that reconnect WILL happen (tg-cli UX complaint: "текст
  // дурацкий" — the old wording sounded terminal AND overclaimed reconnect).
  expect(text).toContain('if it reconnects');
  expect(text).toContain('queued');
  expect(text.toLowerCase()).not.toContain('dead');
  // The original permission prompt must still be visible — a bare status line
  // inviting a tap on generic Approve/Reject buttons with no clue what they
  // authorize is worse than the socket never closing at all (review finding).
  expect(text).toContain('rm -rf /tmp/test');
  // PERMISSION has no promptTurnId, so the "delivered the moment that happens"
  // promise must NOT appear — a tap on THIS card can never auto-deliver
  // (Codex review finding: this initial disconnect card overclaimed the same
  // way queuedPermissionDecisionText's tap-time text used to).
  expect(text).not.toContain('delivered the moment that happens');
  expect(text).toContain("won't auto-deliver");
});

test('abandonedPermissionText: WITH promptTurnId, the "delivered the moment that happens" promise is honest and appears', () => {
  const text = abandonedPermissionText({ ...PERMISSION, promptTurnId: 'turn-a' }, 'rig');
  expect(text).toContain('delivered the moment that happens');
});

test('queuedDecisionCanAutoDeliver: true only when promptTurnId is a non-empty string', () => {
  expect(queuedDecisionCanAutoDeliver({ ...PERMISSION, promptTurnId: 'turn-a' })).toBe(true);
  expect(queuedDecisionCanAutoDeliver(PERMISSION)).toBe(false);
  expect(queuedDecisionCanAutoDeliver({ ...PERMISSION, promptTurnId: '' })).toBe(false);
});

test('queuedPermissionDecisionText names the queued choice and the pane, without claiming it was delivered, and keeps the original prompt visible', () => {
  const text = queuedPermissionDecisionText(PERMISSION, 'rig', 'Approve');
  expect(text).toContain('rig');
  expect(text).toContain('Approve');
  expect(text).toContain('queued');
  expect(text.toLowerCase()).not.toContain('sent to the agent');
  expect(text).toContain('rm -rf /tmp/test');
});

test('queuedPermissionDecisionText: with promptTurnId, promises automatic delivery on reconnect (that promise is true for this case)', () => {
  const text = queuedPermissionDecisionText({ ...PERMISSION, promptTurnId: 'turn-a' }, 'rig', 'Approve');
  expect(text).toContain('delivered automatically once the hook reconnects');
});

test('queuedPermissionDecisionText: WITHOUT promptTurnId, does NOT promise automatic delivery — that would be false (review finding)', () => {
  const text = queuedPermissionDecisionText(PERMISSION, 'rig', 'Approve');
  expect(text).not.toContain('delivered automatically once the hook reconnects');
  expect(text.toLowerCase()).toContain("won't auto-deliver");
  expect(text).toContain('queued "Approve"');
});

test('abandonedMultiText identifies which pane disconnected, points at the terminal without promising reconnect, and keeps the original prompt visible', () => {
  const text = abandonedMultiText(QUESTION, 'ext');
  expect(text).toContain('ext');
  expect(text).toContain('hook disconnected');
  expect(text).toContain('answer all questions in the terminal');
  expect(text).toContain('if it reconnects');
  expect(text).toContain('Where should I deploy?');
});

test('abandonedLongOutageText reports the persisted uncertainty instead of leaving it silent, and keeps the original prompt visible', () => {
  const text = abandonedLongOutageText(PERMISSION, 'rig');
  expect(text).toContain('rig');
  expect(text.toLowerCase()).toContain('long wait');
  expect(text).toContain('terminal');
  expect(text).toContain('rm -rf /tmp/test');
});

test('abandonedLongOutageText names the queued decision when one was pending instead of implying nothing was ever chosen', () => {
  const text = abandonedLongOutageText(PERMISSION, 'rig', 'Approve');
  expect(text).toContain('queued "Approve"');
  expect(text).toContain('never delivered');
  expect(text).toContain('rig');
});

test('queuedDecisionStillWaitingText: WITH promptTurnId, keeps the queue alive and visible, and does NOT overpromise unbounded delivery', () => {
  const text = queuedDecisionStillWaitingText({ ...PERMISSION, promptTurnId: 'turn-a' }, 'rig', 'Approve');
  expect(text).toContain('still waiting to reconnect for rig');
  expect(text).toContain('queued "Approve"');
  expect(text).toContain('NOT been discarded');
  expect(text).toContain('will still be delivered automatically');
  // Must not promise delivery with no bound at all — the daemon still gives up
  // at ABANDONED_RETAIN_MS and sends a SEPARATE notice when it does (review
  // finding: "however long that takes" overpromised past that point).
  expect(text).not.toContain('however long that takes');
  expect(text.toLowerCase()).toContain('separate notice');
});

test('queuedDecisionStillWaitingText: WITHOUT promptTurnId, self-gates and does NOT promise automatic delivery (defense-in-depth, review finding)', () => {
  const text = queuedDecisionStillWaitingText(PERMISSION, 'rig', 'Approve');
  expect(text).toContain('still waiting to reconnect for rig');
  expect(text).toContain('queued "Approve"');
  expect(text).toContain('NOT been discarded');
  expect(text).not.toContain('will still be delivered automatically');
  expect(text.toLowerCase()).toContain("won't auto-deliver");
  expect(text.toLowerCase()).toContain('separate notice');
});

test('buildAnsweredQuestionText keeps the prompt context with the selected answer', () => {
  const text = buildAnsweredQuestionText(QUESTION, 'Production');
  expect(text).toContain('Question from claude');
  expect(text).toContain('Source: agent=claude');
  expect(text).toContain('Pick deploy target');
  expect(text).toContain('Where should I deploy?');
  expect(text).toContain('Selected answer: Production');
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

test('parseQuestionCloseCallback accepts only close-card callbacks', () => {
  expect(parseQuestionCloseCallback('tgqc:q_123')).toEqual({ requestId: 'q_123' });
  expect(parseQuestionCloseCallback('tgq:q_123:o1')).toBe(null);
  expect(parseQuestionCloseCallback('tgqc:')).toBe(null);
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
