// Reload nested implementation changes without restarting the original OMP process.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const source = new URL('../features/tg-ctl/omp-live-extension.mjs', import.meta.url);
const runtime = new URL('../features/tg-ctl/omp-live-runtime.mjs', import.meta.url);
const revision = createHash('sha256').update(readFileSync(source)).update(readFileSync(runtime)).digest('hex');
source.searchParams.set('tg_revision', revision);
export default (await import(source.href)).default;
