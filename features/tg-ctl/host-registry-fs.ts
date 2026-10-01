// Reading the wrapper-written host records from disk (host-registry.ts holds the format,
// validation and liveness rules; this is only the filesystem half, shared by `tg-ctl` — every
// record — and `tg` — its own). Read-only: tg-cli never writes or deletes a record.

import { lstatSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { hostRecordPath, hostsDir, parseHostRecord, type HostParse, type HostRecord } from './host-registry';

const SUFFIX = '.json';

// One record file; null when it vanished between listing and reading (the wrapper deleted
// it on a user-requested exit — not a problem). The uid is the reader's own: a record
// another user could have planted is never trusted.
export function readHostRecordFile(dir: string, file: string, ownUid: number): HostParse | null {
  try {
    const path = join(dir, file);
    const st = lstatSync(path);
    const raw = st.isFile() ? readFileSync(path, 'utf8') : '';
    return parseHostRecord(file.slice(0, -SUFFIX.length), raw, { isRegularFile: st.isFile(), isSymlink: st.isSymbolicLink(), uid: st.uid }, ownUid);
  } catch {
    return null;
  }
}

// Every valid record in `dir` (a missing dir is no hosts); `rejected` names each bad file
// and why, for a log line. Temp files the wrapper renames into place do not end in `.json`.
export function readHostRecords(dir: string, ownUid: number): { records: HostRecord[]; rejected: Array<{ file: string; reason: string }> } {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return { records: [], rejected: [] };
  }
  const records: HostRecord[] = [];
  const rejected: Array<{ file: string; reason: string }> = [];
  for (const file of files) {
    if (!file.endsWith(SUFFIX)) continue;
    const parsed = readHostRecordFile(dir, file, ownUid);
    if (parsed === null) continue;
    if (parsed.ok) records.push(parsed.record);
    else rejected.push({ file, reason: parsed.reason });
  }
  return { records, rejected };
}

// The record of the session `rigSession` ($RIG_SESSION, exported by the wrapper) names, for
// the `tg` running inside it; null when unset, not a valid session id, or not a valid record.
export function readOwnHostRecord(configDir: string, rigSession: string | undefined, ownUid: number): HostRecord | null {
  const name = rigSession?.trim();
  if (!name || hostRecordPath(configDir, name) === null) return null;
  const parsed = readHostRecordFile(hostsDir(configDir), `${name}${SUFFIX}`, ownUid);
  return parsed?.ok ? parsed.record : null;
}
