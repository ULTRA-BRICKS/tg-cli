// A host that answers `stale_identity` never read the frame, so the pin THIS attempt recorded
// goes; a pin an earlier (possibly accepted) attempt left must survive, or a later generation
// would replay an incident that may already have been delivered.
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { tempDir } from './helpers/test-temp';
import { claimInternalAlert, serializeAlertThrottle, parseAlertThrottle, type AlertThrottleStore } from '../features/tg-ctl/alert-subscriptions';
import { sendPinnedInternalFrame, type AlertHost } from '../features/tg-ctl/daemon-runtime/alert-commands';
import type { Ctx } from '../features/tg-ctl/daemon-runtime/ctx-io';
import type { OriginalOmpEndpoint } from '../features/tg-ctl/omp-live-routing';

const NOW = 1_800_000_000_000;
const KEY = 'internal:src|memory|critical';
const SESSION = 'session-1';
const ep = { sessionId: SESSION, pid: 7, instanceId: 'a'.repeat(32) } as OriginalOmpEndpoint;

function setup(prior: AlertThrottleStore['sent'][number]['internalAttempts']) {
  const dir = tempDir('tgctl-pin-release-', { short: true });
  const path = join(dir, 'throttle.json');
  const claimed = claimInternalAlert({ sent: [] }, KEY, NOW, 'incident', [SESSION]);
  const entry = { ...claimed.sent[0], internalAttempts: prior ?? [] };
  writeFileSync(path, serializeAlertThrottle({ sent: [entry] }, NOW));
  const host = { ctx: { paths: { alertThrottle: path } } as unknown as Ctx, now: NOW, endpoints: [], registryError: null } as AlertHost;
  const attempts = () => parseAlertThrottle(readFileSync(path, 'utf8'), NOW).sent[0].internalAttempts;
  return { host, entry, attempts };
}

const staleAfterPin = (async (opts: { beforeSend?: (current: OriginalOmpEndpoint) => void }) => {
  opts.beforeSend?.(ep);
  throw Object.assign(new Error('stale_identity'), { code: 'stale_identity' });
}) as never;

test('stale_identity releases the pin this attempt just recorded', async () => {
  const { host, entry, attempts } = setup([]);
  await expect(sendPinnedInternalFrame(host, KEY, entry, ep, staleAfterPin)).rejects.toMatchObject({ code: 'stale_identity' });
  expect(attempts()).toEqual([]);
});

test('stale_identity keeps a pin an earlier attempt left: that frame may have been accepted', async () => {
  const older = [{ sessionId: SESSION, pid: 7, instanceId: 'a'.repeat(32) }];
  const { host, entry, attempts } = setup(older);
  await expect(sendPinnedInternalFrame(host, KEY, entry, ep, staleAfterPin)).rejects.toMatchObject({ code: 'stale_identity' });
  expect(attempts()).toEqual(older);
});
