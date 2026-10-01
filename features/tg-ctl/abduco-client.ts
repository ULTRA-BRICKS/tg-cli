// The one impure piece of abduco PTY injection: a unix-socket client implementing the
// PtySocket contract of abduco-pty.ts (write resolves once the kernel took the bytes,
// rejects once the connection is gone). Everything else about the wire format and the
// recipe is pure and lives there.

import { PartialWriteError, type PtySocket } from './abduco-pty';

// A server that accepted nothing for this long is wedged, not busy: its socket exists but
// nobody answers. Bounded so one dead session cannot hold the daemon's delivery loop.
const CONNECT_TIMEOUT_MS = 3000;
// A connected server that stops reading (SIGSTOPped, wedged) never fires `drain`, so a write
// that cannot make progress for this long fails instead of holding the delivery claim — and
// the daemon's whole update batch — forever. Per stall, not per message: a slow reader that
// keeps draining is never cut off.
const DRAIN_TIMEOUT_MS = 5000;

export function connectAbducoSocket(path: string): Promise<PtySocket> {
  const { promise, resolve, reject } = Promise.withResolvers<PtySocket>();
  let failure: Error | null = null;
  let drainWaiter: PromiseWithResolvers<void> | null = null;
  const fail = (err: Error): void => {
    failure ??= err;
    drainWaiter?.reject(failure);
    drainWaiter = null;
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    reject(new Error(`no answer within ${CONNECT_TIMEOUT_MS} ms`));
  }, CONNECT_TIMEOUT_MS);
  Bun.connect({
    unix: path,
    socket: {
      open(sock) {
        clearTimeout(timer);
        // The caller was told it failed; a connection that completes late must not leak.
        if (timedOut) return void sock.end();
        resolve({
          async write(packet) {
            let off = 0;
            try {
              while (off < packet.length) {
                if (failure) throw failure;
                const wrote = sock.write(packet.subarray(off));
                if (wrote < 0) throw new Error('socket write failed');
                off += wrote;
                if (off < packet.length) {
                  drainWaiter = Promise.withResolvers<void>();
                  const stalled = setTimeout(() => fail(new Error(`the abduco server stopped reading for ${DRAIN_TIMEOUT_MS} ms`)), DRAIN_TIMEOUT_MS);
                  try {
                    await drainWaiter.promise;
                  } finally {
                    clearTimeout(stalled);
                  }
                }
              }
              if (failure) throw failure;
            } catch (err) {
              // Bytes already handed to the kernel may reach the PTY: not a clean failure.
              throw off > 0 && err instanceof Error ? new PartialWriteError(err.message) : err;
            }
          },
          async close() {
            sock.end();
          },
        });
      },
      // The server echoes the session's screen to every attached client; we only type.
      data() {},
      drain() {
        drainWaiter?.resolve();
        drainWaiter = null;
      },
      close() {
        fail(new Error('connection closed by the abduco server'));
      },
      error(_sock, err) {
        fail(err);
      },
      connectError(_sock, err) {
        clearTimeout(timer);
        reject(err);
      },
    },
  }).catch((err: unknown) => {
    clearTimeout(timer);
    reject(err instanceof Error ? err : new Error(String(err)));
  });
  return promise;
}
