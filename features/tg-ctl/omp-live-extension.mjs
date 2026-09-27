/** OMP extension: publish a socket owned by the original interactive session only. */
const runtimeUrl = new URL('./omp-live-runtime.mjs', import.meta.url);
const revision = new URL(import.meta.url).searchParams.get('tg_revision');
if (revision) runtimeUrl.searchParams.set('tg_revision', revision);
const { startLiveEndpoint, defaultRegistryRoot } = await import(runtimeUrl.href);

// Mtime-busted extension reloads may import another module instance; retain one owner.
const OWNER_KEY = Symbol.for('tg-cli.omp-live.endpoint.v1');

export default function ompLiveExtension(pi) {
  const owner = { endpoint: null, generation: 0, queue: Promise.resolve(), stopped: false };
  const prior = globalThis[OWNER_KEY];
  globalThis[OWNER_KEY] = owner;
  if (prior) { prior.stopped = true; prior.generation++; owner.queue = Promise.resolve(prior.queue).then(() => prior.endpoint?.close()); }

  function report(ctx, message) {
    // Do not turn optional transport failure into an exception in an existing session.
    try { ctx.ui?.notify?.(message, 'warning'); } catch { /* UI may be shutting down. */ }
  }
  function isOriginalInteractive(ctx) {
    if (ctx.hasUI !== true || (ctx.mode !== undefined && ctx.mode !== 'tui')) return false;
    if (typeof ctx.getAgentId === 'function' && ctx.getAgentId()) return false;
    return true;
  }
  function contextSnapshot(ctx) {
    return {
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.getSessionFile?.() ?? ctx.sessionManager.getSessionFile?.() ?? null,
      cwd: ctx.cwd,
      durableSession: process.env.RIG_OMP_SESSION ?? null,
      busy: !ctx.isIdle(),
      title: ctx.sessionManager.getHeader?.()?.title ?? null,
    };
  }
  async function publish(ctx) {
    const generation = ++owner.generation;
    owner.stopped = false;
    owner.queue = owner.queue.catch(() => {}).then(async () => {
      await owner.endpoint?.close();
      owner.endpoint = null;
      if (generation !== owner.generation || owner.stopped || globalThis[OWNER_KEY] !== owner || !isOriginalInteractive(ctx)) return;
      const endpoint = await startLiveEndpoint({
        root: defaultRegistryRoot(),
        snapshot: () => contextSnapshot(ctx),
        send: text => {
          if (owner.stopped || generation !== owner.generation || globalThis[OWNER_KEY] !== owner) throw new Error('stale_extension');
          // OMP schedules this in this process. It preserves normal hooks and permissions.
          return pi.sendUserMessage(text, { deliverAs: ctx.isIdle() ? 'aside' : 'followUp' });
        },
      });
      if (generation !== owner.generation || owner.stopped || globalThis[OWNER_KEY] !== owner) await endpoint.close();
      else owner.endpoint = endpoint;
    }).catch(() => report(ctx, 'Live Telegram bridge unavailable. The existing OMP session continues; no replacement agent was started.'));
    await owner.queue;
  }
  pi.on('session_start', async (_event, ctx) => publish(ctx));
  pi.on('session_switch', async (_event, ctx) => publish(ctx));
  pi.on('session_shutdown', async () => {
    owner.stopped = true;
    owner.generation++;
    await owner.queue.catch(() => {});
    await owner.endpoint?.close();
    owner.endpoint = null;
    if (globalThis[OWNER_KEY] === owner) delete globalThis[OWNER_KEY];
  });
}
