// The CLI's stdout boundary: one line of intended command output, newline-terminated.
// Replaces the console log call for user-facing text so stdout bytes stay exactly `${line}\n`.
// Written synchronously to fd 1: callers often `process.exit` right after, and an async
// `process.stdout.write` to a slow pipe would drop everything past the first pipe buffer.
import { writeSync } from "node:fs"

export const stdoutSink = {
  write(text: string): void {
    const bytes = Buffer.from(text)
    let offset = 0
    while (offset < bytes.length) {
      try {
        // codeql[js/http-to-file-access] Intentional: fd is the literal 1 (stdout); no untrusted value picks a path or descriptor.
        offset += writeSync(1, bytes, offset)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === "EAGAIN") continue
        if (code === "EPIPE") return
        throw err
      }
    }
  },
}

export function writeStdoutLine(line = ""): void {
  stdoutSink.write(`${line}\n`)
}
