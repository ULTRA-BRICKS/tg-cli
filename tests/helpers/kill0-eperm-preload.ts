// Bun preload for tg-cli#748 tests: every signal-0 liveness probe in the child answers EPERM, as
// kill(2) does when the target exists but the caller may not signal it.
// Use: `bun --preload tests/helpers/kill0-eperm-preload.ts <script> …`.
import { stubKill0 } from './kill0-stub';

stubKill0({ code: 'EPERM', syscall: 'kill' });
