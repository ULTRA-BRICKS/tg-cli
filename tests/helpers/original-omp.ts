// Real process-bound Unix socket fixture; no replacement process is ever spawned.
import { rmSync } from 'node:fs';
import { tempDir } from './test-temp';
import { startLiveEndpoint, sendLiveMessage, listLiveEndpoints } from '../../features/tg-ctl/omp-live-runtime.mjs';
export async function originalFixture(send?: (text: string) => void | Promise<void>) {
  const root = tempDir('omp-owned-test-');
  const state = { sessionId: 'original', sessionFile: null, cwd: '/same', title: 'Original', busy: true };
  const inputs: string[] = [];
  const endpoint = await startLiveEndpoint({ root, snapshot: () => ({ ...state }),
    send: send ?? ((text: string) => { inputs.push(text); }), });
  return { root, state, endpoint, inputs,
    status: () => listLiveEndpoints(root),
    send: (id: string, text: string, overrides: Record<string, unknown> = {}) => sendLiveMessage({ root,
      pid: process.pid, instanceId: endpoint.instanceId, sessionId: state.sessionId, requestId: id, text, ...overrides }),
    close: async () => { await endpoint.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
