// `tg auth user|caller`, `tg call`, `tg user send` orchestration. Every effect (file checks,
// the runtime build, the spawn, stdout/stderr) is injected so tests pass fakes; the `tg`
// entrypoint supplies the real ones.
import type { CallContext, UserAccountArgs, UserAccountCommand } from './args';
import { describeError, describeResult, notLoggedIn } from './messages';
import { requiredSessions, sessionPath, sidecarInvocation, storeDir } from './sidecar';
import { USER_ACCOUNT_HELP } from './help';

export interface SidecarRun {
  exitCode: number;
  stdout: string;
}

export interface UserAccountDeps {
  configDir: string;
  callContext?: (cmd: Extract<UserAccountCommand, { kind: 'call' }>) => CallContext;
  exists: (path: string) => boolean;
  /** argv prefix that runs `python -m telegram_client`, or an error line (no uv, setup failed). */
  sidecarCommand: (offline?: boolean) => Promise<{ argv: string[] } | { error: string }>;
  /** `stdin` undefined = inherit tg's stdin (login prompts); stderr is always inherited. */
  spawn: (argv: string[], stdin: string | undefined) => Promise<SidecarRun>;
  /** Message text for `tg user send` without inline text; null when stdin is a terminal. */
  readStdin: () => Promise<string | null>;
  log: (line: string) => void;
  errlog: (line: string) => void;
}

function lastJson(stdout: string): Record<string, unknown> | null {
  const lines = stdout.trim().split('\n').filter((l) => l.trim() !== '');
  try {
    const value: unknown = JSON.parse(lines[lines.length - 1] ?? '');
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function runUserAccount(parsed: UserAccountArgs, deps: UserAccountDeps): Promise<number> {
  if (parsed.kind === 'help') {
    deps.log(USER_ACCOUNT_HELP[parsed.topic]);
    return 0;
  }
  if (parsed.kind === 'error') {
    deps.errlog(`Error: ${parsed.message}`);
    return 2;
  }
  let cmd: UserAccountCommand = parsed;
  for (const role of cmd.kind === 'call' && cmd.dryRun ? [] : requiredSessions(cmd)) {
    const path = sessionPath(deps.configDir, role);
    if (!deps.exists(path)) {
      deps.errlog(notLoggedIn(role, path));
      return 3;
    }
  }
  if (cmd.kind === 'send' && cmd.text === undefined) {
    const text = await deps.readStdin();
    if (text === null) {
      deps.errlog('Error: no message text. Pass it after the peer or pipe it on stdin. See `tg user send --help`.');
      return 2;
    }
    cmd = { ...cmd, text };
  }
  if (cmd.kind === 'call' && deps.callContext) cmd = { ...deps.callContext(cmd), ...cmd };
  const command = await deps.sidecarCommand(cmd.kind === 'call-history' || (cmd.kind === 'call' && cmd.dryRun));
  if ('error' in command) {
    deps.errlog(command.error);
    return 1;
  }
  const invocation = sidecarInvocation(cmd, storeDir(deps.configDir));
  const run = await deps.spawn([...command.argv, ...invocation.args], invocation.stdin);
  if (cmd.json || cmd.kind === 'call-history') {
    if (run.stdout) deps.log(run.stdout.trimEnd());
    return run.exitCode;
  }
  const out = lastJson(run.stdout);
  if (out === null) {
    deps.errlog(`Error: the Telegram sidecar exited ${run.exitCode} without a result.`);
    return run.exitCode === 0 ? 1 : run.exitCode;
  }
  if (out.persistence_failed === true) {
    const id = typeof out.call_id === 'string' ? out.call_id : 'unknown';
    const observed = typeof out.state === 'string' ? out.state : 'unknown';
    const saved = typeof out.saved_state === 'string' ? out.saved_state : 'unknown';
    deps.errlog(`Warning: CALL_JOURNAL_WRITE_FAILED. Call ${id}; observed: ${observed}; saved: ${saved}. History may be incomplete; do not automatically repeat the call.`);
  }
  if (typeof out.error === 'string') {
    const role = cmd.kind === 'send' ? 'personal' : cmd.role;
    const peer = cmd.kind === 'call' || cmd.kind === 'send' ? cmd.peer : undefined;
    const detail = typeof out.detail === 'string' ? ` [${out.detail}]` : '';
    deps.errlog(describeError(out.error, role, peer) + detail);
    if (typeof out.call_id === 'string') deps.errlog(`Call ${out.call_id}; inspect: tg call history show ${out.call_id} --json`);
    if (typeof out.reason === 'string') {
      deps.errlog(`Reason: ${out.reason}; stage: ${out.stage}.`);
      if (out.reason.startsWith('TTS_')) deps.errlog(describeError(out.reason, role, peer));
    }
    if (typeof out.warning === 'string') deps.errlog(`Warning: ${out.warning}`);
    return run.exitCode === 0 ? 1 : run.exitCode;
  }
  if (typeof out.warning === 'string') deps.errlog(`Warning: transcript mirror result update failed (${out.warning}); inspect call history.`);
  deps.log(describeResult(cmd, out));
  return run.exitCode;
}
