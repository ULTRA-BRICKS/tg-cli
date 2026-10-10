// Prepared calbot consumer: one owned Python JSON runner, no calendar business imports.
export type LibraryIdentity = { distribution: string; version: string; module: string };
export type CallLibRequest =
  | { protocol: 1; action: 'describe' }
  | { protocol: 1; action: 'start'; config: Record<string, unknown>; store?: string;
      consent: { call: boolean; provider_network: boolean; source_idle: boolean };
      maximum_seconds?: number };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function callLib(
  command: string[], request: CallLibRequest,
  options: { signal?: AbortSignal; timeoutMs?: number; env?: Record<string, string | undefined> } = {},
): Promise<{ library: LibraryIdentity; state?: string }> {
  if (options.signal?.aborted) throw new Error('CALL_LIB_CANCELLED');
  const proc = Bun.spawn(command, { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', env: options.env });
  let stopping = false;
  let force: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    proc.kill('SIGTERM');
    force = setTimeout(() => proc.kill('SIGKILL'), 5000);
  };
  const timeout = setTimeout(stop, options.timeoutMs ?? 1_820_000);
  options.signal?.addEventListener('abort', stop, { once: true });
  try {
    proc.stdin.write(JSON.stringify(request));
    proc.stdin.end();
    const [exit, output] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    if (stopping) throw new Error('CALL_LIB_CANCELLED');
    if (output.length > 1_048_576) throw new Error('CALL_LIB_RESPONSE_TOO_LARGE');
    let value: unknown;
    try { value = JSON.parse(output); } catch { throw new Error('CALL_LIB_INVALID_RESPONSE'); }
    if (!record(value)) throw new Error('CALL_LIB_INVALID_RESPONSE');
    if (exit !== 0) {
      const code = typeof value.error === 'string' && /^[A-Z_]+$/.test(value.error) ? value.error : 'CALL_LIB_FAILED';
      throw new Error(code);
    }
    const library = value.library;
    if (!record(library) || library.distribution !== 'tg-call-lib' || library.version !== '0.1.0' || typeof library.module !== 'string') {
      throw new Error('CALL_LIB_VERSION_MISMATCH');
    }
    return { library: { distribution: library.distribution, version: library.version, module: library.module },
      ...(typeof value.state === 'string' ? { state: value.state } : {}) };
  } finally {
    clearTimeout(timeout);
    if (force) clearTimeout(force);
    options.signal?.removeEventListener('abort', stop);
    if (proc.exitCode === null) { proc.kill('SIGKILL'); await proc.exited; }
  }
}
