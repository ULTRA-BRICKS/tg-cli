import { startLiveEndpoint } from '../features/tg-ctl/omp-live-runtime.mjs';
const ep = await startLiveEndpoint({
  root: process.argv[2],
  snapshot: () => ({ sessionId: 'child-original', sessionFile: null, cwd: process.cwd(), busy: false }),
  send: text => { process.send({ pid: process.pid, text }); },
});
process.on('SIGTERM', async () => { await ep.close(); process.exit(0); });
process.send({ pid: process.pid });
