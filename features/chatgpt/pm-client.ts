// PURE client for the frozen `pm chatgpt api METHOD --params JSON` contract.
//
// pm owns policy, approval and the ChatGPT sessions; tg is only a client. Every call is one fixed
// argv array (never a shell string) run through an INJECTED runner, so this module spawns nothing
// itself (the real runner is ./pm-runner.ts). pm prints exactly ONE stdout envelope:
//   {ok:true,result} | {ok:false,error:{code,message}}
// which is parsed against a bounded schema; extra keys are ignored.
//
// Outcomes are typed. A MUTATING call (actions.request, connectors.request) that times out, is
// killed for oversize output, or answers with garbage may already have queued a request inside pm,
// so it is NEVER retried and the user is pointed at `tg chatgpt requests`.

import { describeDependencyProblem, type DependencyProblem } from '../tg-ctl/dependency-problem';

export const PM_READ_METHODS = ['accounts.list', 'sessions.list', 'sessions.get', 'requests.list', 'requests.get', 'connectors.list'] as const;
export const PM_MUTATING_METHODS = ['actions.request', 'connectors.request'] as const;
export type PmMethod = (typeof PM_READ_METHODS)[number] | (typeof PM_MUTATING_METHODS)[number];

export type PmParams = Readonly<Record<string, string>>;

export const PM_MAX_STDOUT_BYTES = 256 * 1024;
export const PM_READ_TIMEOUT_MS = 20_000;
export const PM_MUTATION_TIMEOUT_MS = 30_000;
const MAX_PARAMS_BYTES = 4096;
const MAX_ERROR_MESSAGE = 500;
const MAX_ERROR_CODE = 64;

export interface RunnerOptions {
  timeoutMs: number;
  maxBytes: number;
  stdin?: string;
}

export type RunnerResult =
  | { kind: 'exit'; code: number | null; stdout: string; stderr: string }
  | { kind: 'timeout' }
  | { kind: 'oversize' }
  // `problem` classifies WHY pm could not run (not found vs found-but-unstartable); absent for a fake runner.
  | { kind: 'spawn-error'; problem?: DependencyProblem };

export type PmRunner = (argv: readonly string[], opts: RunnerOptions) => Promise<RunnerResult>;

export type PmOutcome =
  | { kind: 'ok'; result: unknown }
  // `problem` (when known) lets a Telegram surface word the fix for the daemon instead of the shell.
  | { kind: 'pm-unavailable'; message: string; problem?: DependencyProblem }
  | { kind: 'pm-error'; code: string; message: string }
  | { kind: 'invalid-response'; message: string }
  | { kind: 'uncertain'; message: string };

const REQUESTS_HINT = 'Do not retry; check `tg chatgpt requests` to see whether the request was queued.';

export function isMutatingMethod(method: string): boolean {
  return (PM_MUTATING_METHODS as readonly string[]).includes(method);
}

function isAllowedMethod(method: string): method is PmMethod {
  return (PM_READ_METHODS as readonly string[]).includes(method) || isMutatingMethod(method);
}

export function pmArgv(method: PmMethod, params: PmParams): string[] {
  return ['pm', 'chatgpt', 'api', method, '--params', JSON.stringify(params)];
}

export type ParsedEnvelope = { kind: 'ok'; result: unknown } | { kind: 'error'; code: string; message: string } | { kind: 'invalid'; detail: string };

export function parseEnvelope(stdout: string): ParsedEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return { kind: 'invalid', detail: 'pm output is not a single JSON envelope' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { kind: 'invalid', detail: 'pm envelope is not an object' };
  if (!('ok' in value)) return { kind: 'invalid', detail: 'pm envelope has no ok flag' };
  if (value.ok === true) {
    if (!('result' in value)) return { kind: 'invalid', detail: 'pm ok envelope has no result' };
    return { kind: 'ok', result: value.result };
  }
  if (value.ok !== false) return { kind: 'invalid', detail: 'pm envelope ok flag is not boolean' };
  const error = 'error' in value ? value.error : undefined;
  if (typeof error !== 'object' || error === null || !('code' in error) || !('message' in error)) return { kind: 'invalid', detail: 'pm error envelope has no code/message' };
  const { code, message } = error;
  if (typeof code !== 'string' || typeof message !== 'string' || code === '') return { kind: 'invalid', detail: 'pm error code/message are not text' };
  return { kind: 'error', code: code.slice(0, MAX_ERROR_CODE), message: message.slice(0, MAX_ERROR_MESSAGE) };
}

type NonExitRun = Exclude<RunnerResult, { kind: 'exit' }>;
type ExitRun = Extract<RunnerResult, { kind: 'exit' }>;

// The runner never got an answer: pm could not start, or it timed out / overflowed. A MUTATING call
// may already have queued a request, so only that case is `uncertain`.
function nonExitOutcome(res: NonExitRun, mutating: boolean): PmOutcome {
  if (res.kind === 'spawn-error') {
    return res.problem
      ? { kind: 'pm-unavailable', message: describeDependencyProblem('pm', res.problem, 'shell'), problem: res.problem }
      : { kind: 'pm-unavailable', message: 'could not start `pm` (is it installed and on PATH?)' };
  }
  if (res.kind === 'timeout') {
    return mutating
      ? { kind: 'uncertain', message: `pm did not answer in time; the request may or may not have been queued. ${REQUESTS_HINT}` }
      : { kind: 'pm-error', code: 'timeout', message: 'pm did not answer in time' };
  }
  return mutating
    ? { kind: 'uncertain', message: `pm output exceeded the size bound and was killed; the request may or may not have been queued. ${REQUESTS_HINT}` }
    : { kind: 'invalid-response', message: 'pm output exceeded the size bound' };
}

function exitOutcome(res: ExitRun, mutating: boolean): PmOutcome {
  const parsed = parseEnvelope(res.stdout);
  if (parsed.kind === 'error') return { kind: 'pm-error', code: parsed.code, message: parsed.message };
  if (parsed.kind === 'invalid' || res.code !== 0) {
    const detail = parsed.kind === 'invalid' ? parsed.detail : `pm exited ${res.code ?? 'by signal'} with an ok envelope`;
    return { kind: 'invalid-response', message: mutating ? `${detail}. The request may have been queued. ${REQUESTS_HINT}` : detail };
  }
  return { kind: 'ok', result: parsed.result };
}

export async function callPm(run: PmRunner, method: PmMethod, params: PmParams): Promise<PmOutcome> {
  if (!isAllowedMethod(method)) return { kind: 'pm-error', code: 'method-not-allowed', message: `method ${String(method)} is not an allowed pm API method` };
  const mutating = isMutatingMethod(method);
  const argv = pmArgv(method, params);
  if (Buffer.byteLength(argv[5]) > MAX_PARAMS_BYTES) return { kind: 'pm-error', code: 'params-too-large', message: 'request parameters exceed the size bound' };
  const res = await run(argv, { timeoutMs: mutating ? PM_MUTATION_TIMEOUT_MS : PM_READ_TIMEOUT_MS, maxBytes: PM_MAX_STDOUT_BYTES });
  return res.kind === 'exit' ? exitOutcome(res, mutating) : nonExitOutcome(res, mutating);
}
