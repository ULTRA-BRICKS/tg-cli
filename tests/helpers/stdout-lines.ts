// Captures what a command writes to the real stdout boundary, one entry per written line.
// A chunk that does not end in exactly the line terminator is a parity bug, so it throws.
import { spyOn } from 'bun:test';
import { stdoutSink } from '../../features/cli/stdout-line';

export function captureStdoutLines(sink: string[]): { mockRestore(): void } {
  return spyOn(stdoutSink, 'write').mockImplementation((text: string) => {
    if (!text.endsWith('\n')) throw new Error(`stdout chunk is not newline-terminated: ${JSON.stringify(text)}`);
    sink.push(text.slice(0, -1));
  });
}
