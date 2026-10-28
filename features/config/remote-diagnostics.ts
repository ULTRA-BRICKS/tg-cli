// `tg config validate` errors for control.server / machine / remote_machines.
//
// The rules live once, in Python (`tg-remote config check`, reached via resolveRemoteMode); this
// module only places each reported error on the line of its key. Pure: the caller resolves the mode.
import type { RemoteMode } from '../tg-ctl/remote-config';
import type { ConfigDiagnostic } from './validate';

const REMOTE_KEY_LINE = /^\s+(server|machine|remote_machines)\s*:/;

function remoteKeyLines(raw: string): Map<string, number> {
  const lines = new Map<string, number>();
  let inControl = false;
  raw.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((text, index) => {
    if (/^\S/.test(text) && !text.startsWith('#')) inControl = /^control\s*:/.test(text);
    const key = inControl ? REMOTE_KEY_LINE.exec(text)?.[1] : undefined;
    if (key !== undefined && !lines.has(key)) lines.set(key, index + 1);
  });
  return lines;
}

/** Each error lands on its key's line; one that names no key lands on the first remote key (else line 1). */
export function remoteModeDiagnostics(raw: string, mode: RemoteMode): ConfigDiagnostic[] {
  if (mode.mode !== 'invalid') return [];
  const keyLines = remoteKeyLines(raw);
  const first = Math.min(...keyLines.values()); // Infinity when no remote key is written
  const fallback = Number.isFinite(first) ? first : 1;
  return mode.errors.map((message) => {
    const key = /^control\.([a-z_]+):/.exec(message)?.[1];
    return { line: (key !== undefined && keyLines.get(key)) || fallback, severity: 'error' as const, message };
  });
}
