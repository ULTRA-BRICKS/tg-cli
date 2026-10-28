import { describe, expect, spyOn, test } from 'bun:test';
import { stdoutSink, writeStdoutLine } from '../features/cli/stdout-line';

function captureWrites(run: () => void): string[] {
  const chunks: string[] = [];
  const spy = spyOn(stdoutSink, 'write').mockImplementation((text: string) => {
    chunks.push(text);
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return chunks;
}

describe('writeStdoutLine', () => {
  test('writes the line and exactly one newline in a single chunk', () => {
    expect(captureWrites(() => writeStdoutLine('OK tg#5'))).toEqual(['OK tg#5\n']);
  });

  test('no argument is the blank line', () => {
    expect(captureWrites(() => writeStdoutLine())).toEqual(['\n']);
  });

  test('keeps embedded newlines and adds one trailing newline, like the console call it replaces', () => {
    expect(captureWrites(() => writeStdoutLine('a\nb\n'))).toEqual(['a\nb\n\n']);
  });

  test('real process stdout bytes are the line plus newline', async () => {
    const script = `import { writeStdoutLine } from './features/cli/stdout-line'; writeStdoutLine('→ ünï'); writeStdoutLine();`;
    const proc = Bun.spawn(['bun', '-e', script], { cwd: `${import.meta.dir}/..`, stdout: 'pipe', stderr: 'pipe' });
    const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    expect(await proc.exited).toBe(0);
    expect(Buffer.from(out).toString('utf8')).toBe('→ ünï\n\n');
  });

  test('a 1 MiB line survives a slow reader and an immediate process.exit', async () => {
    const script = `import { writeStdoutLine } from './features/cli/stdout-line'; process.stderr.write('go\\n'); writeStdoutLine('x'.repeat(1048576)); process.exit(0);`;
    const proc = Bun.spawn(['bun', '-e', script], { cwd: `${import.meta.dir}/..`, stdout: 'pipe', stderr: 'pipe' });
    // 1 MiB exceeds the pipe buffer, so the child blocks mid-write until we read; start reading only after its signal.
    await proc.stderr.getReader().read();
    const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    expect(await proc.exited).toBe(0);
    expect(out.length).toBe(1048577);
  });

  test('a closed reader (EPIPE) does not fail the writer', async () => {
    const script = `import { writeStdoutLine } from './features/cli/stdout-line'; writeStdoutLine('x'.repeat(1000000)); process.exit(0);`;
    const proc = Bun.spawn(['bun', '-e', script], { cwd: `${import.meta.dir}/..`, stdout: 'pipe', stderr: 'pipe' });
    await proc.stdout.cancel();
    expect(await proc.exited).toBe(0);
  });
});
