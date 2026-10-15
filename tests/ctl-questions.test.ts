import { expect, test } from 'bun:test';
import {
  abandonedMultiText,
  abandonedPermissionText,
  buildAnsweredQuestionText,
  buildButtonMessage,
  buildClaudeQuestionAnswerOutput,
  buildPostTimeoutQuestionMessage,
  collectQuestionAnswers,
  extractAnswersFromHookReply,
  formatAgentHookOutput,
  hatchAbandonedPermissionText,
  hatchGrantApprovedText,
  hatchParseMode,
  parseButtonCallback,
  parseQuestionCloseCallback,
  parseDecisionReplyToken,
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

test('buildButtonMessage renders a hatch permission verbatim as HTML with parse_mode set', () => {
  const hatchReq: ButtonRequest = {
    requestId: 'hatch-block-reset-hard-aaaaaaaaaaaa',
    agent: 'claude',
    kind: 'permission',
    question: '<b>Hatch approval request</b>\n\n<b>Hook:</b> <code>block-reset-hard</code>\n<b>Justification:</b> testing',
    title: 'Hatch: block-reset-hard',
  };
  const payload = buildButtonMessage(1000, hatchReq);
  expect(payload.text).toBe(hatchReq.question);
  expect(payload.parse_mode).toBe('HTML');
  expect(payload.text).not.toContain('Permission request from claude');
});

test('buildButtonMessage leaves a non-hatch permission on the plain-text path (no parse_mode)', () => {
  const payload = buildButtonMessage(1000, {
    requestId: 'p_plain',
    agent: 'claude',
    kind: 'permission',
    question: 'run rm -rf /tmp/x?',
  });
  expect(payload.parse_mode).toBeUndefined();
  expect(payload.text).toContain('Permission request from claude');
});

test('hatchParseMode gates on isHatchPermissionRequest, same as buildButtonMessage', () => {
  expect(hatchParseMode({
    requestId: 'hatch-block-reset-hard-aaaaaaaaaaaa',
    agent: 'claude',
    kind: 'permission',
    question: 'x',
  })).toBe('HTML');
  expect(hatchParseMode({
    requestId: 'p_plain',
    agent: 'claude',
    kind: 'permission',
    question: 'x',
  })).toBeUndefined();
});

test('hatchAbandonedPermissionText: the original HTML prompt rides through verbatim, and the new grant-window status carries no unescaped placeholder', () => {
  const hatchReq: ButtonRequest = {
    requestId: 'hatch-block-reset-hard-aaaaaaaaaaaa',
    agent: 'claude',
    kind: 'permission',
    question: '<b>Hatch approval request</b>',
  };
  const text = hatchAbandonedPermissionText(hatchReq, 'block-reset-hard');
  // The ORIGINAL prompt (buildQuestionText's hatch early-return) rides through verbatim —
  // it is agent-tools' own pre-escaped HTML, not this function's concern.
  expect(text).toContain('<b>Hatch approval request</b>');
  // Grant protocol v1.1 (tg-cli#398): the abandoned card no longer promises an
  // automatic env-var replay — it advertises the 24h grace window a late Approve
  // tap mints a grant from. No unescaped placeholder rides along either.
  expect(text).toContain('24h');
  expect(text).toContain('one-time grant');
  expect(text).not.toContain('<justification');
});

test('hatchGrantApprovedText escapes its literal <HOOK> placeholder (undelivered branch) so parse_mode: HTML never rejects the edit', () => {
  const hatchReq: ButtonRequest = {
    requestId: 'hatch-block-reset-hard-aaaaaaaaaaaa',
    agent: 'claude',
    kind: 'permission',
    question: '<b>Hatch approval request</b>',
  };
  const text = hatchGrantApprovedText(hatchReq, 'hgr-abc123def456', false);
  // The ORIGINAL prompt still rides through verbatim.
  expect(text).toContain('<b>Hatch approval request</b>');
  // The undelivered-notice status hand-authors a literal `RIG_HATCH_REQUEST_<HOOK>=…`
  // placeholder — sent under parse_mode: 'HTML' (hatchParseMode), an unescaped `<HOOK>`
  // is an unrecognized Telegram tag and the WHOLE edit gets rejected with a 400,
  // silently dropped by botPost. Escaped, it renders as the literal placeholder text.
  expect(text).toContain('&lt;HOOK&gt;');
  expect(text).not.toContain('RIG_HATCH_REQUEST_<HOOK>');
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

test('queuedDecisionStillWaitingText: WITH promptTurnId, keeps the queue alive and visible', () => {
  const text = queuedDecisionStillWaitingText({ ...PERMISSION, promptTurnId: 'turn-a' }, 'rig', 'Approve');
  expect(text).toContain('still waiting to reconnect for rig');
  expect(text).toContain('queued "Approve"');
  expect(text).toContain('NOT been discarded');
  expect(text).toContain('will still be delivered automatically');
  // No give-up notice exists any more (tg-cli#705 removed the retention timer), so none is promised.
  expect(text.toLowerCase()).not.toContain('separate notice');
});

test('queuedDecisionStillWaitingText: WITHOUT promptTurnId, self-gates and does NOT promise automatic delivery (defense-in-depth, review finding)', () => {
  const text = queuedDecisionStillWaitingText(PERMISSION, 'rig', 'Approve');
  expect(text).toContain('still waiting to reconnect for rig');
  expect(text).toContain('queued "Approve"');
  expect(text).toContain('NOT been discarded');
  expect(text).not.toContain('will still be delivered automatically');
  expect(text.toLowerCase()).toContain("won't auto-deliver");
  expect(text.toLowerCase()).not.toContain('separate notice');
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

test('parseDecisionReplyToken recognizes affirmative/negative tokens, case/whitespace-insensitive', () => {
  expect(parseDecisionReplyToken('yes')).toBe('allow');
  expect(parseDecisionReplyToken('YES')).toBe('allow');
  expect(parseDecisionReplyToken('  ok  ')).toBe('allow');
  expect(parseDecisionReplyToken('go')).toBe('allow');
  expect(parseDecisionReplyToken('да')).toBe('allow');
  expect(parseDecisionReplyToken('но')).toBe(null);
  expect(parseDecisionReplyToken('no')).toBe('deny');
  expect(parseDecisionReplyToken('stop')).toBe('deny');
  expect(parseDecisionReplyToken('нет')).toBe('deny');
  expect(parseDecisionReplyToken('maybe later')).toBe(null);
  expect(parseDecisionReplyToken('')).toBe(null);
});

test('parseDecisionReplyToken: Object.prototype keys never resolve as a decision (prototype-pollution guard)', () => {
  expect(parseDecisionReplyToken('constructor')).toBe(null);
  expect(parseDecisionReplyToken('toString')).toBe(null);
  expect(parseDecisionReplyToken('__proto__')).toBe(null);
  expect(parseDecisionReplyToken('hasOwnProperty')).toBe(null);
  expect(parseDecisionReplyToken('valueOf')).toBe(null);
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
