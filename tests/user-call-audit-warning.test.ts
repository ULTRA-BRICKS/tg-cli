// A completed call must not conceal loss of audit persistence in human CLI output.
import { expect, test } from 'bun:test';
import { parseUserAccountArgs } from '../features/user-account/args';
import { runUserAccount } from '../features/user-account/cli';

test('human call results surface failed audit persistence on success, failure and interruption', async () => {
  for (const [state, error, exitCode] of [
    ['audio_stream_ended', undefined, 0], ['failed', 'CALL_ATTEMPT_FAILED', 3], ['cancelled', 'INTERRUPTED', 130],
  ] as const) {
    const parsed = parseUserAccountArgs(['call', 'me', '--say', 'test']);
    if (!parsed || parsed.kind !== 'call') throw new Error('parse failed');
    const errors: string[] = [];
    const out = { call_id: 'known-call', state, saved_state: 'attempting', persistence_failed: true,
      audit_warning: 'CALL_JOURNAL_WRITE_FAILED', ...(error ? { error } : {}) };
    const code = await runUserAccount(parsed, {
      configDir: '/unused', exists: () => true, sidecarCommand: async () => ({ argv: ['fake'] }),
      spawn: async () => ({ exitCode, stdout: JSON.stringify(out) }), readStdin: async () => null,
      log: () => {}, errlog: (line) => errors.push(line),
    });
    expect(code).toBe(exitCode);
    expect(errors.join('\n')).toContain('CALL_JOURNAL_WRITE_FAILED');
    expect(errors.join('\n')).toContain('known-call');
    expect(errors.join('\n')).toContain('observed: ' + state);
    expect(errors.join('\n')).toContain('saved: attempting');
  }
});

test('JSON call diagnostics stay machine-readable without extra stderr narration', async () => {
  const parsed = parseUserAccountArgs(['call', 'me', '--say', 'test', '--json']);
  if (!parsed || parsed.kind !== 'call') throw new Error('parse failed');
  const errors: string[] = [], logs: string[] = [];
  const out = { call_id: 'known-call', state: 'audio_stream_ended', saved_state: 'attempting',
    persistence_failed: true, audit_warning: 'CALL_JOURNAL_WRITE_FAILED' };
  await runUserAccount(parsed, {
    configDir: '/unused', exists: () => true, sidecarCommand: async () => ({ argv: ['fake'] }),
    spawn: async () => ({ exitCode: 0, stdout: JSON.stringify(out) }), readStdin: async () => null,
    log: (line) => logs.push(line), errlog: (line) => errors.push(line),
  });
  expect(errors).toEqual([]);
  expect(logs).toEqual([JSON.stringify(out)]);
});
