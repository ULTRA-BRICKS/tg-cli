// Fake `pm chatgpt api` runner for the chatgpt tests: records every argv and answers from a
// per-method handler, so no test spawns a process or touches a real pm.
import type { PmRunner, RunnerResult } from '../../features/chatgpt/pm-client';

export interface FakeCall {
  argv: string[];
  method: string;
  params: Record<string, unknown>;
}

export type FakeHandler = (params: Record<string, unknown>) => RunnerResult | unknown;

export function okEnvelope(result: unknown): RunnerResult {
  return { kind: 'exit', code: 0, stdout: `${JSON.stringify({ ok: true, result })}\n`, stderr: '' };
}

export function errEnvelope(code: string, message: string): RunnerResult {
  return { kind: 'exit', code: 1, stdout: `${JSON.stringify({ ok: false, error: { code, message } })}\n`, stderr: '' };
}

function isRunnerResult(v: unknown): v is RunnerResult {
  return typeof v === 'object' && v !== null && 'kind' in v && ['exit', 'timeout', 'oversize', 'spawn-error'].includes((v as { kind: string }).kind);
}

export function fakePm(handlers: Record<string, FakeHandler>): { run: PmRunner; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const run: PmRunner = async (argv) => {
    const method = argv[3] ?? '';
    const params = argv[4] === '--params' ? (JSON.parse(argv[5] ?? '{}') as Record<string, unknown>) : {};
    calls.push({ argv: [...argv], method, params });
    const handler = handlers[method];
    if (!handler) return errEnvelope('unknown_method', `no fake for ${method}`);
    const out = handler(params);
    return isRunnerResult(out) ? out : okEnvelope(out);
  };
  return { run, calls };
}

// A realistic combined sessions.list result (shape of pmlib/chatgpt_monitor.combine()).
export const SESSIONS_FIXTURE = {
  workspace: 'all',
  accounts: [
    { workspace: 'home', ok: true, error: null, stale: false, generated_at: 1_790_000_000, summary: { enrolled: 1, present: 1, running: 1, blocked: 0 } },
    { workspace: 'glide.vc', ok: true, error: null, stale: false, generated_at: 1_790_000_000, summary: { enrolled: 2, present: 2, running: 1, blocked: 0 } },
  ],
  sessions: [
    {
      account: 'home',
      chat: 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111',
      title: 'Workshop <&> "plan"',
      status: 'working',
      continuation: 'running',
      reason: 'generating',
      model: 'gpt-5',
      effort: 'high',
      last_checked_at: 1_790_000_000,
      last_go_at: 1_789_999_000,
      last_go_state: 'sent',
      next_check_at: 1_790_000_060,
      latest_turn: 'turn-home-1',
    },
    {
      account: 'glide.vc',
      chat: '11111111-1111-4111-8111-111111111111',
      title: 'Canvas',
      status: 'complete',
      continuation: 'complete',
      reason: 'quota stop',
      last_checked_at: 1_790_000_000,
      latest_turn: 'turn-glide-canvas-7',
    },
    { account: 'glide.vc', chat: 'state-lib-chat', title: 'State-lib', status: 'working', continuation: 'running' },
  ],
  events: [
    { account: 'home', at: 1_789_999_500, chat: '11111111-1111-4111-8111-111111111111', kind: 'go', message: 'sent go' },
    { account: 'glide.vc', at: 1_789_999_600, kind: 'service', message: 'service restarted' },
  ],
  limitations: ['Coverage is limited to observed sessions.'],
};
