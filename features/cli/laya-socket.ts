/**
 * @file laya's verdict for the intent gate: glue to the Python caller `tgcli.laya`
 * (src/tgcli/laya, stdlib only), which owns the `laya:` config, socket discovery and trust,
 * autostart of task-cli's classify server, the unix-socket client and every timeout. This module
 * only spawns it, reads its JSON lines and keeps the parts that are TS-only because the intent
 * gate is TS: the question texts, the problem-evidence message and reply-probability parsing.
 *
 * Accessed via: the `tg` entrypoint for explicit problem reports, or when the deterministic
 * detector found no ask in another body (intent-gate.ts `layaWorthAsking`). Never on dry-run
 * (agent-gates.ts decides before calling in here).
 *
 * WIRE: `python3 -I <repo>/tg-laya ask --config-dir <dir>` (`TG_PYTHON` replaces `python3`; `-I` plus
 * the launcher's own `sys.path.insert(<repo>/src)` mean nothing in the cwd or PYTHON* can shadow
 * the package), stdin one JSON `{message, questions}`. stdout: a first `{"status":"budget",
 * "total_ms"}` line (how long the call may take: the kill timer is armed from it, so no config is
 * parsed here), then `{"status":"ok","line","policy"}` or `{"status":"unavailable","reason",
 * "detail","attempt","remedy","policy"}`. stderr is inherited: a cold start says so while it waits.
 *
 * Every failure is a typed unavailable reply; whether the send may go on without the model is the
 * policy the gate applies (laya.required), not decided here.
 */
import { readFileSync } from 'fs';
import type { Subprocess } from 'bun';
import type { ConfigDiagnostic } from '../config/validate';
import { join } from 'path';
import {
  problemRemediationEvidence,
  LAYA_REASONS,
  type LayaReason,
  type LayaUnavailable,
  type ProblemLayaAssessment,
} from './problem-remediation';

// The one question asked. `noul` = a calibrated P(true) in `answers.<name>.noul`.
export const LAYA_QUESTIONS = {
  asks_reader: {
    type: 'noul',
    instructions: 'Does the message ask the reader to decide, choose, approve, or answer an open question?',
  },
} as const;

// laya reads a few hundred tokens per state; the head of a long body is what it sees anyway.
const MAX_MESSAGE_CHARS = 2000;
// Interpreter start plus config parse; the budget line arrives right after.
const HELPER_STARTUP_MS = 15_000;
// On top of the helper's own budget: it enforces every deadline itself, this only reaps a hang.
const HELPER_KILL_MARGIN_MS = 5_000;
const REPO_ROOT = join(import.meta.dir, '..', '..');

export const LAYA_PROBLEM_QUESTIONS = {
  has_done: {
    type: 'noul',
    instructions: 'Does the author state a concrete diagnostic or recovery action they already performed AND its observed result? Failed attempts count. Future plans, headings alone and quoted examples do not count.',
  },
  has_current: {
    type: 'noul',
    instructions: 'Does the author state a concrete recovery action currently in progress, or an exact external blocker with the verification/retry when it clears? Passive monitoring, "under observation", headings alone and future promises do not count.',
  },
} as const;

function probability(line: string, name: string): number | null {
  try {
    const reply = JSON.parse(line) as { ok?: unknown; result?: { answers?: Record<string, { noul?: unknown }> } };
    const p = reply.ok === true ? reply.result?.answers?.[name]?.noul : undefined;
    return typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1 ? p : null;
  } catch { return null; }
}

/** P(asks the reader) from a classify-server reply line, or null when it is not one. */
export function parseLayaReply(line: string): number | null {
  return probability(line, 'asks_reader');
}

export type LayaReply = { status: 'ok'; line: string; policy: 'required' | 'fallback' } | Required<LayaUnavailable>;
export type LayaAskResult = { status: 'ok'; probability: number } | Required<LayaUnavailable>;

export interface LayaHelperOptions {
  /** Test seam: the kill margin after the helper's announced budget. */
  killMarginMs?: number;
  startupMs?: number;
}

// The helper gets what it needs and nothing else: no bot token, no agent variables and no PYTHON*
// (isolated mode ignores them anyway; this keeps them out of its children too).
const FORWARDED = /^(?:PATH|HOME|USER|LOGNAME|LANG|TMPDIR|XDG_.*|TASK_.*|LC_.*|TG_LAYA(?:_.*)?)$/u;

function helperEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined && FORWARDED.test(key)) out[key] = value;
  return out;
}

/** `python3 -I <repo>/tg-laya <args>`: isolated interpreter, trusted import root added by the launcher. */
export function layaCommand(env: NodeJS.ProcessEnv, ...args: string[]): string[] {
  return [env.TG_PYTHON || 'python3', '-I', join(REPO_ROOT, 'tg-laya'), ...args];
}

type Policy = 'required' | 'fallback';

// The documented runtime boolean tokens (docs/configuration.md), case-insensitive. Python
// (src/tgcli/laya/config.py `_TRUE`) is the source; tests/laya-socket.test.ts pins this copy.
export const LAYA_TRUE_TOKENS = ['true', '1', 'yes', 'on'] as const;

/**
 * `laya.required` as far as this glue can tell WITHOUT the Python caller (which owns the real parse
 * and validation): consulted only when that caller itself failed, so a broken interpreter can never
 * silently turn a required Laya into a fallback. It errs towards `required`: the environment first,
 * then the first `required:` of the `laya:` block, however the rest of the file reads.
 */
function policyWithoutHelper(env: NodeJS.ProcessEnv, configDir: string): Policy {
  const isTrue = (value: string): boolean => (LAYA_TRUE_TOKENS as readonly string[]).includes(value.trim().toLowerCase());
  const forced = (env.TG_LAYA_REQUIRED ?? '').trim();
  if (forced !== '') return isTrue(forced) ? 'required' : 'fallback';
  let text = '';
  try { text = readFileSync(join(configDir, 'config.yaml'), 'utf8'); } catch { return 'fallback'; }
  let inBlock = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/u, '');
    if (/^\s*(?:#|$)/u.test(line)) continue;
    if (/^\S/u.test(line)) inBlock = /^laya:\s*$/u.test(line);
    else if (inBlock && isTrue(/^\s+required:\s*(.*)$/u.exec(line)?.[1] ?? '')) return 'required';
  }
  return 'fallback';
}

function helperFailure(reason: 'helper-failed' | 'helper-timeout', detail: string, attempt: string, remedy: string, policy: Policy): Required<LayaUnavailable> {
  return { status: 'unavailable', reason, detail, attempt, remedy, policy };
}

const HELPER_REMEDY = 'install python3 (3.12+) or point TG_PYTHON at one, then retry; `python3 -I <checkout>/tg-laya` must run';

type HelperLine = { status?: unknown; total_ms?: unknown } & Partial<Required<LayaUnavailable>> & { line?: unknown };

function parseLine(text: string): HelperLine | null {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === 'object' && value !== null ? (value as HelperLine) : null;
  } catch { return null; }
}

function toReply(line: HelperLine): LayaReply | null {
  const policy = line.policy === 'required' ? 'required' : 'fallback';
  if (line.status === 'ok' && typeof line.line === 'string') return { status: 'ok', line: line.line, policy };
  if (line.status !== 'unavailable' || typeof line.reason !== 'string') return null;
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  const known = (LAYA_REASONS as readonly string[]).includes(line.reason);
  // A reason this glue does not know is a contract break: never forward it as if typed.
  if (!known) return invalidResponse(policy, `the Python caller reported an unknown reason ${JSON.stringify(line.reason).slice(0, 60)}`);
  return { status: 'unavailable', reason: line.reason as LayaReason, detail: text(line.detail), attempt: text(line.attempt), remedy: text(line.remedy), policy };
}

/** One predict request through the Python caller. Never throws. */
export async function askLaya(
  message: string,
  questions: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  configDir: string,
  options: LayaHelperOptions = {},
): Promise<LayaReply> {
  const command = layaCommand(env, 'ask', '--config-dir', configDir);
  const attempt = `ran \`${command.join(' ')}\``;
  let proc: Subprocess;
  try {
    proc = Bun.spawn(command, { env: helperEnv(env), stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' });
  } catch (error) {
    return helperFailure('helper-failed', error instanceof Error ? error.message : String(error), attempt, HELPER_REMEDY, policyWithoutHelper(env, configDir));
  }
  // A killed helper's own children may keep its stdout pipe open: the kill, not EOF, ends the wait.
  const kill = { timedOut: false, timer: undefined as NodeJS.Timeout | undefined, onKilled: () => {} };
  const killed = new Promise<null>((resolve) => { kill.onKilled = () => resolve(null); });
  const arm = (ms: number): void => {
    clearTimeout(kill.timer);
    kill.timer = setTimeout(() => { kill.timedOut = true; proc.kill('SIGKILL'); kill.onKilled(); }, ms);
  };
  arm(options.startupMs ?? HELPER_STARTUP_MS);
  try {
    const stdin = proc.stdin as { write(data: string): unknown; end(): unknown };
    stdin.write(JSON.stringify({ message, questions }));
    stdin.end();
  } catch { /* the helper died before reading; its exit is reported below */ }
  const reply = await Promise.race([readHelperReply(proc, (budgetMs) => arm(budgetMs + (options.killMarginMs ?? HELPER_KILL_MARGIN_MS))), killed]);
  const code = await proc.exited;
  clearTimeout(kill.timer);
  if (kill.timedOut) {
    return helperFailure('helper-timeout', 'the Python caller did not finish within its own announced budget', attempt, 'retry; if it repeats run `task classify-server start` by hand and check `python3 -I <checkout>/tg-laya` runs', policyWithoutHelper(env, configDir));
  }
  // The caller reporting its own failure (unreadable config, bad state dir) could not read `required`.
  if (reply?.status === 'unavailable' && reply.reason === 'helper-failed') return { ...reply, policy: policyWithoutHelper(env, configDir) };
  if (reply !== null) return reply;
  return helperFailure('helper-failed', `the Python caller exited ${code} without a reply (see its stderr above)`, attempt, HELPER_REMEDY, policyWithoutHelper(env, configDir));
}

/** The helper's stdout lines: its budget announcement re-arms the kill timer, the last reply wins. */
async function readHelperReply(proc: Subprocess, onBudget: (totalMs: number) => void): Promise<LayaReply | null> {
  const state: { reply: LayaReply | null } = { reply: null };
  const consume = (text: string): void => {
    const parsed = parseLine(text);
    if (parsed === null) return;
    if (parsed.status === 'budget' && typeof parsed.total_ms === 'number') onBudget(parsed.total_ms);
    else state.reply = toReply(parsed) ?? state.reply;
  };
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });
    for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
      consume(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
  }
  if (pending.trim()) consume(pending);
  return state.reply;
}

function invalidResponse(policy: 'required' | 'fallback', detail: string): Required<LayaUnavailable> {
  return {
    status: 'unavailable', reason: 'invalid-response', detail, policy,
    attempt: 'asked the classify server; its reply could not be used',
    remedy: 'run: task classify-server start (restart it); if it repeats, read the server log in ~/.local/state/task-cli/classify/',
  };
}

/**
 * laya's P(the body asks the reader something), or a typed unavailable reply.
 */
export async function layaAskProbability(body: string, env: NodeJS.ProcessEnv, configDir: string, options?: LayaHelperOptions): Promise<LayaAskResult> {
  const reply = await askLaya(body.slice(0, MAX_MESSAGE_CHARS), LAYA_QUESTIONS, env, configDir, options);
  if (reply.status !== 'ok') return reply;
  const p = parseLayaReply(reply.line);
  return p === null ? invalidResponse(reply.policy, 'the reply carried no asks_reader probability') : { status: 'ok', probability: p };
}

/** Full action sections, not the body's head; too large is unavailable, never a negative
 * inferred from truncated evidence.
 */
export async function layaProblemAssessment(body: string, env: NodeJS.ProcessEnv, configDir: string, options?: LayaHelperOptions): Promise<ProblemLayaAssessment> {
  const evidence = problemRemediationEvidence(body);
  // Only the author's words. Synthetic "attempts/results" headings around a bare
  // symptom can bias the classifier into claiming those facts exist.
  // A side without its own label falls back to the whole prose, which usually already holds
  // the other side: send that once. Two labelled sections are distinct text; send both. A
  // labelled done section that prose lacks (a `Result:` heading is kept only in done) is kept.
  const message = evidence.doneLabel && evidence.currentLabel ? `${evidence.done}\n${evidence.current}`
    : !evidence.doneLabel ? evidence.done
    : evidence.current.includes(evidence.done) ? evidence.current
    : `${evidence.done}\n${evidence.current}`;
  const reply = await askLaya(message, LAYA_PROBLEM_QUESTIONS, env, configDir, options);
  if (reply.status !== 'ok') return reply;
  const done = probability(reply.line, 'has_done');
  const current = probability(reply.line, 'has_current');
  return done === null || current === null
    ? invalidResponse(reply.policy, 'the reply carried no has_done/has_current probabilities')
    : { status: 'ok', done, current };
}

/** The refusal printed when `laya.required` is on and Laya did not answer. */
export function formatRequiredFailure(outcome: LayaUnavailable): string {
  const lines = [`tg: Laya is required (laya.required: true) but unavailable: ${outcome.reason}. Tried: ${outcome.attempt || 'nothing'}. Next: ${outcome.remedy || 'run: task classify-server start'}.`];
  if (outcome.detail) lines.push(`  Detail: ${outcome.detail}`);
  return lines.join('\n');
}

/** The refusal printed (exit 78) when the `laya:` config or its environment is invalid. */
export function formatConfigFailure(outcome: LayaUnavailable): string {
  return `tg: Laya configuration is invalid: ${outcome.detail}. Next: ${outcome.remedy}.`;
}

/**
 * `tg config validate`: the `laya:` block of this file, checked by the Python caller with the rules
 * the send path applies. A caller that cannot run is an error, not a pass: the block stays unchecked.
 */
export function layaConfigDiagnostics(configPath: string, env: NodeJS.ProcessEnv): ConfigDiagnostic[] {
  const unchecked = (why: string): ConfigDiagnostic[] => [{ line: 1, severity: 'error', message: `the laya: block could not be checked: ${why} (${HELPER_REMEDY})` }];
  try {
    const run = Bun.spawnSync(layaCommand(env, 'check-config', '--file', configPath), { env: helperEnv(env), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: HELPER_STARTUP_MS });
    const parsed = JSON.parse(run.stdout.toString()) as { diagnostics?: ConfigDiagnostic[] };
    return Array.isArray(parsed.diagnostics) ? parsed.diagnostics : unchecked(`exit ${run.exitCode}, ${run.stderr.toString().trim().slice(0, 200)}`);
  } catch (error) {
    return unchecked(error instanceof Error ? error.message : String(error));
  }
}
