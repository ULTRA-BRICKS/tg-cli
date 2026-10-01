// Reading the wrapper-written host records from disk (host-registry.ts holds the format,
// validation and liveness rules; this is only the filesystem half, shared by `tg-ctl` — every
// record — and `tg` — its own). Read-only: tg-cli never writes or deletes a record.

import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { hostRecordPath, hostsDir, parseHostRecord, type HostParse, type HostRecord } from './host-registry';

const SUFFIX = '.json';

// One record file; null when it vanished between listing and reading (the wrapper deleted
// it on a user-requested exit — not a problem). The uid is the reader's own: a record
// another user could have planted is never trusted. The file is classified through the
// descriptor it is read from (open, then fstat), never by a path check followed by a
// read: nothing can be swapped in between. O_NOFOLLOW refuses a symlink at open (ELOOP);
// O_NONBLOCK keeps a FIFO planted in the directory from hanging the open.
export function readHostRecordFile(dir: string, file: string, ownUid: number): HostParse | null {
  const stem = file.slice(0, -SUFFIX.length);
  let fd: number;
  try {
    fd = openSync(join(dir, file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    // The uid is irrelevant to every non-regular verdict: parseHostRecord refuses those first.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') return parseHostRecord(stem, '', { isRegularFile: false, isSymlink: true, uid: ownUid }, ownUid);
    // A socket or device node cannot be opened for reading: still "not a regular file", not "vanished".
    if (code === 'ENXIO' || code === 'ENODEV' || code === 'EOPNOTSUPP') return parseHostRecord(stem, '', { isRegularFile: false, isSymlink: false, uid: ownUid }, ownUid);
    return null;
  }
  try {
    const st = fstatSync(fd);
    const raw = st.isFile() ? readFileSync(fd, 'utf8') : '';
    return parseHostRecord(stem, raw, { isRegularFile: st.isFile(), isSymlink: false, uid: st.uid }, ownUid);
  } catch {
    return null;
  } finally {
    closeSync(fd);
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
