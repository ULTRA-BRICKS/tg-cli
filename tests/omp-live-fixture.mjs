import { startLiveEndpoint } from '../features/tg-ctl/omp-live-runtime.mjs';
const ep = await startLiveEndpoint({
  root: process.argv[2],
  snapshot: () => ({ sessionId: 'child-original', sessionFile: null, cwd: process.cwd(), busy: false }),
  send: text => { process.send({ pid: process.pid, text }); },
});
process.on('SIGTERM', async () => { await ep.close(); process.exit(0); });
// Simulate an original OMP whose event loop is busy in a long synchronous step;
// the ack is flushed before the loop blocks.
process.on('message', m => { if (m?.blockMs) process.send({ blocking: true }, () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, m.blockMs)); });
process.send({ pid: process.pid });
