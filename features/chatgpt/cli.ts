// `tg chatgpt …` orchestration with injected effects: parse → one or two pm API calls → render.
// Returns {exitCode, stdout, stderr}; the `tg` entrypoint prints it and ALWAYS exits with it, so a
// chatgpt invocation can never fall through to the generic Telegram send.

import { CHATGPT_USAGE, parseChatgptArgs, type ChatgptCommand } from './args';
import {
  display,
  redactValue,
  renderAccounts,
  renderConnectors,
  renderEvents,
  renderQueued,
  renderRequest,
  renderRequests,
  renderSessionDetail,
  renderSessionList,
} from './format';
import { latestTurnOf } from './model';
import { callPm, type PmMethod, type PmOutcome, type PmParams, type PmRunner } from './pm-client';

export const EXIT_OK = 0;
export const EXIT_PM_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_UNAVAILABLE = 69;
export const EXIT_UNCERTAIN = 75;

export interface ChatgptCliDeps {
  run: PmRunner;
}

export interface ChatgptCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// Fixed reason string: the client never forwards free text into a pm request.
const REQUEST_REASON = 'requested via tg chatgpt';

interface Failure {
  exitCode: number;
  code: string;
  message: string;
}

function failureOf(outcome: Exclude<PmOutcome, { kind: 'ok' }>): Failure {
  switch (outcome.kind) {
    case 'pm-unavailable':
      return { exitCode: EXIT_UNAVAILABLE, code: 'pm-unavailable', message: outcome.message };
    case 'uncertain':
      return { exitCode: EXIT_UNCERTAIN, code: 'uncertain', message: outcome.message };
    case 'invalid-response':
      return { exitCode: EXIT_PM_ERROR, code: 'invalid-response', message: outcome.message };
    case 'pm-error':
      return { exitCode: EXIT_PM_ERROR, code: outcome.code, message: outcome.message };
  }
}

type Step = { ok: true; result: unknown } | { ok: false; failure: Failure };

async function call(deps: ChatgptCliDeps, method: PmMethod, params: PmParams): Promise<Step> {
  const outcome = await callPm(deps.run, method, params);
  return outcome.kind === 'ok' ? { ok: true, result: outcome.result } : { ok: false, failure: failureOf(outcome) };
}

function requestParams(action: string, workspace: string, chat: string | null, expectedTurn: string | null): PmParams {
  return {
    workspace,
    ...(chat === null ? {} : { chat }),
    action,
    ...(expectedTurn === null ? {} : { expected_turn: expectedTurn }),
    reason: REQUEST_REASON,
  };
}

interface Rendered {
  human: string;
  result: unknown;
}

async function execute(command: ChatgptCommand, deps: ChatgptCliDeps): Promise<{ ok: true; value: Rendered } | { ok: false; failure: Failure }> {
  const done = (step: Step, render: (result: unknown) => string): { ok: true; value: Rendered } | { ok: false; failure: Failure } =>
    step.ok ? { ok: true, value: { human: render(step.result), result: step.result } } : step;
  switch (command.kind) {
    case 'help':
      return { ok: true, value: { human: CHATGPT_USAGE, result: null } };
    case 'accounts':
      return done(await call(deps, 'accounts.list', {}), renderAccounts);
    case 'list':
      return done(await call(deps, 'sessions.list', { workspace: command.workspace }), (r) => renderSessionList(r, command.workspace));
    case 'events':
      return done(await call(deps, 'sessions.list', { workspace: command.workspace }), renderEvents);
    case 'show':
      return done(await call(deps, 'sessions.get', { workspace: command.workspace, chat: command.chat }), (r) => renderSessionDetail(r, command.workspace));
    case 'requests':
      return command.requestId === null
        ? done(await call(deps, 'requests.list', {}), renderRequests)
        : done(await call(deps, 'requests.get', { request_id: command.requestId }), renderRequest);
    case 'action':
      return done(await call(deps, 'actions.request', requestParams(command.action, command.workspace, command.chat, null)), (r) => renderQueued(r, `${command.action} ${command.workspace}/${command.chat}`));
    case 'continue': {
      const current = await call(deps, 'sessions.get', { workspace: command.workspace, chat: command.chat });
      if (!current.ok) return current;
      const turn = latestTurnOf(current.result);
      if (turn === null) {
        return { ok: false, failure: { exitCode: EXIT_PM_ERROR, code: 'no-latest-turn', message: 'pm did not report the latest turn of this session, so a continuation cannot be bound to it; nothing was requested' } };
      }
      return done(await call(deps, 'actions.request', requestParams('continue', command.workspace, command.chat, turn)), (r) => renderQueued(r, `continue ${command.workspace}/${command.chat} on turn ${turn}`));
    }
    case 'service':
      return done(await call(deps, 'actions.request', requestParams(command.action, command.workspace, null, null)), (r) => renderQueued(r, `${command.action} ${command.workspace}`));
    case 'connector-list':
      return done(await call(deps, 'connectors.list', {}), renderConnectors);
    case 'connector-request':
      return done(await call(deps, 'connectors.request', { connector: 'guardian', target: 'chatgpt' }), (r) => renderQueued(r, 'install the guardian connector for chatgpt'));
  }
}

// --json result for `events`: only the events of the list response.
function jsonResultOf(command: ChatgptCommand, result: unknown): unknown {
  if (command.kind === 'events' && result !== null && typeof result === 'object' && 'events' in result) return { events: result.events };
  return result;
}

function line(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

export async function runChatgptCli(argv: readonly string[], deps: ChatgptCliDeps): Promise<ChatgptCliResult> {
  const parsed = parseChatgptArgs(argv);
  if (!parsed.ok) {
    return { exitCode: EXIT_USAGE, stdout: '', stderr: line(`tg chatgpt: ${parsed.message}\nRun \`tg help chatgpt\` for usage.`) };
  }
  const { json, command } = parsed.parsed;
  const outcome = await execute(command, deps);
  if (!outcome.ok) {
    const message = display(outcome.failure.message, 500);
    return json
      ? { exitCode: outcome.failure.exitCode, stdout: line(JSON.stringify({ ok: false, error: { code: display(outcome.failure.code, 64), message } })), stderr: '' }
      : { exitCode: outcome.failure.exitCode, stdout: '', stderr: line(`tg chatgpt: ${message}`) };
  }
  if (command.kind === 'help') return { exitCode: EXIT_OK, stdout: line(CHATGPT_USAGE), stderr: '' };
  const { human, result } = outcome.value;
  return json
    ? { exitCode: EXIT_OK, stdout: line(JSON.stringify({ ok: true, result: redactValue(jsonResultOf(command, result)) })), stderr: '' }
    : { exitCode: EXIT_OK, stdout: line(human), stderr: '' };
}
