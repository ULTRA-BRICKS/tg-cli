// The ONE writer of history.jsonl for both producers: `tg` (outbound) and the
// tg-ctl daemon (inbound). Each append is a read-modify-write (the file is
// trimmed to MAX_HISTORY), so two concurrent writers used to lose each other's
// rows (tg-cli#136). The RMW now runs under the same O_EXCL lockfile protocol as
// routes.json (`withRoutesLock` / `fsRoutesLockIo`: PID-liveness staleness; a
// pid-less lock is treated as a live writer mid-acquire until it is older than
// ORPHAN_LOCK_AGE_MS, tg-cli#519; the rare paths that can still break a live lock
// are tracked in tg-cli#680).
//
// Best-effort, like the log itself: when live writers hold the lock past the
// budget this append is SKIPPED (running unlocked could clobber the holder's
// rows); I/O errors propagate to the caller, which swallows them so history
// bookkeeping never breaks a send or an inject.

import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { fsRoutesLockIo, withRoutesLock } from '../tg-ctl/routes';
import { appendRecordsToBlob, type HistoryRecord } from './history';

// ~1 s (100 × 10 ms): a holder does one read + one write of a bounded (≤ MAX_HISTORY line) file.
const LOCK_ATTEMPTS = 100;
const LOCK_DELAY_MS = 10;

// Returns false when the lock stayed contended and nothing was written.
export function appendHistoryFile(path: string, records: HistoryRecord[]): boolean {
  if (records.length === 0) return true;
  const done = withRoutesLock(
    fsRoutesLockIo(`${path}.lock`),
    () => {
      let raw: string | null;
      try {
        raw = readFileSync(path, 'utf8');
      } catch (err) {
        // Only a missing file is a first write; any other read error must not
        // overwrite (and so truncate) an existing log: it propagates, nothing is written.
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
        raw = null;
      }
      // 0o600: the log is a conversation transcript — owner-only, like the daemon socket.
      writeFileSync(path, appendRecordsToBlob(raw, records), { mode: 0o600 });
      chmodSync(path, 0o600); // enforce on a pre-existing, looser-perm file too
      return true;
    },
    { attempts: LOCK_ATTEMPTS, delayMs: LOCK_DELAY_MS, onContended: 'skip' },
  );
  return done === true;
}
