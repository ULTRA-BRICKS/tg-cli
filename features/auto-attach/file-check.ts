// Disk-attachment sanity check (tg-cli#207).
//
// A path can pass path-detection (features/cli/args.ts resolveExistingFile,
// which only checks `statSync(...).isFile()`) and then be gone, still empty,
// or unreadable by the time the transmitter uploads it — detection and send
// are two different points in time. Telegram rejects an empty/absent upload
// with "file must be non-empty", and that used to `process.exit` the WHOLE
// send. `checkAttachmentFile` re-validates right before upload so the
// transmitter can skip a bad item instead of failing everything.
//
// This module is PURE — no I/O (repo convention, AGENTS.md "Feature modules
// live in features/<feature-name>/ as pure TypeScript modules — no I/O; all
// external dependencies... are injected"). `checkAttachmentFile` is disk-free
// to unit test; the real `statSync`/`accessSync` wiring is the `tg`
// entrypoint's job, injected into `transmit()`'s `checkFile` option
// (features/auto-attach/transmitter.ts) the same way `readText`/`fileExistsAbs`
// wire other pure auto-attach helpers to real fs calls.

export type FileCheckResult = 'ok' | 'missing' | 'empty' | 'unreadable';

export interface FileCheckDeps {
  stat: (path: string) => { isFile(): boolean; size: number };
  canRead: (path: string) => boolean;
}

export function checkAttachmentFile(path: string, deps: FileCheckDeps): FileCheckResult {
  let stat: ReturnType<FileCheckDeps['stat']>;
  try {
    stat = deps.stat(path);
  } catch {
    return 'missing';
  }
  if (!stat.isFile()) return 'missing';
  if (stat.size <= 0) return 'empty';
  if (!deps.canRead(path)) return 'unreadable';
  return 'ok';
}
