// A SIGKILL-orphan lockfile for the fsRoutesLockIo protocol (features/tg-ctl/routes.ts): pid-less
// content, backdated past ORPHAN_LOCK_AGE_MS. A FRESH pid-less lockfile is a live writer between
// its create and its pid write and must not be broken (tg-cli#519), so a test of the orphan path
// has to age it.
import { utimesSync, writeFileSync } from 'fs';
import { ORPHAN_LOCK_AGE_MS } from '../../features/tg-ctl/routes';

export function writeOrphanLock(lockPath: string, content = ''): void {
  writeFileSync(lockPath, content);
  const past = (Date.now() - ORPHAN_LOCK_AGE_MS - 1_000) / 1000;
  utimesSync(lockPath, past, past);
}
