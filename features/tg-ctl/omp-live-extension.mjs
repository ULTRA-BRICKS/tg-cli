/** OMP extension: publish a socket owned by the original interactive session only. */
const runtimeUrl = new URL('./omp-live-runtime.mjs', import.meta.url);
const revision = new URL(import.meta.url).searchParams.get('tg_revision');
if (revision) runtimeUrl.searchParams.set('tg_revision', revision);
const { startLiveEndpoint, defaultRegistryRoot } = await import(runtimeUrl.href);

// One process hosts one TUI session but many factory bindings: OMP binds the same
// prepared factory again for every in-process task subagent (#462), and an
// mtime-busted reload may bind another module instance. Only a binding that sees
// the original interactive session CLAIMS this process-global owner slot; binding,
// starting or shutting down any other binding never touches the owner's endpoint.
const OWNER_KEY = Symbol.for('tg-cli.omp-live.endpoint.v1');

export default function ompLiveExtension(pi) {
  const self = { endpoint: null, generation: 0, queue: Promise.resolve(), stopped: false, shutdown: false, warned: false };

  function report(ctx, message) {
    // Do not turn optional transport failure into an exception in an existing session.
    try { ctx.ui?.notify?.(message, 'warning'); } catch { /* UI may be shutting down. */ }
  }
  function isOriginalInteractive(ctx) {
    if (ctx.hasUI !== true || (ctx.mode !== undefined && ctx.mode !== 'tui')) return false;
    if (typeof ctx.getAgentId === 'function' && ctx.getAgentId()) return false;
    return true;
  }
  const owns = () => globalThis[OWNER_KEY] === self;
  function claim() {
    const prior = globalThis[OWNER_KEY];
    if (prior === self) return;
    globalThis[OWNER_KEY] = self;
    if (!prior) return;
    // A newer binding of the SAME original session (reload) replaces the prior one.
    prior.stopped = true;
    prior.generation++;
    const closePrior = Promise.resolve(prior.queue).catch(() => {}).then(() => prior.endpoint?.close());
    self.queue = Promise.all([self.queue.catch(() => {}), closePrior]);
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
    // Subagent, print and ACP bindings neither claim nor withdraw anything (#462).
    if (!isOriginalInteractive(ctx)) return;
    claim();
    const generation = ++self.generation;
    self.stopped = false;
    self.shutdown = false;
    const live = () => generation === self.generation && !self.stopped && owns();
    self.queue = self.queue.catch(() => {}).then(async () => {
      await self.endpoint?.close();
      self.endpoint = null;
      if (!live()) return;
      const endpoint = await startLiveEndpoint({
        root: defaultRegistryRoot(),
        snapshot: () => contextSnapshot(ctx),
        send: text => {
          if (!live()) throw new Error('stale_extension');
          // OMP schedules this in this process. It preserves normal hooks and permissions.
          return pi.sendUserMessage(text, { deliverAs: ctx.isIdle() ? 'aside' : 'followUp' });
        },
      });
      if (!live()) { await endpoint.close(); return; }
      self.endpoint = endpoint;
      self.warned = false;
    }).catch(() => {
      // Self-heal retries every turn; warn once per outage, not once per turn.
      if (self.warned) return;
      self.warned = true;
      report(ctx, 'Live Telegram bridge unavailable. The existing OMP session continues; no replacement agent was started.');
    });
    await self.queue;
  }
  // #458: republish at a turn boundary when this session's registration is missing.
  async function heal(ctx) {
    if (self.shutdown || !isOriginalInteractive(ctx)) return;
    const owner = globalThis[OWNER_KEY];
    // A newer binding of this session owns the endpoint; a stale binding never steals it.
    if (owner && owner !== self && !owner.stopped) return;
    await self.queue.catch(() => {});
    if (owns() && !self.stopped && await self.endpoint?.published()) return;
    await publish(ctx);
  }
  pi.on('session_start', async (_event, ctx) => publish(ctx));
  pi.on('session_switch', async (_event, ctx) => publish(ctx));
  pi.on('turn_end', async (_event, ctx) => heal(ctx));
  pi.on('agent_end', async (_event, ctx) => heal(ctx));
  pi.on('session_shutdown', async () => {
    // Only this binding's own endpoint; a subagent shutdown owns none.
    self.shutdown = true;
    self.stopped = true;
    self.generation++;
    await self.queue.catch(() => {});
    await self.endpoint?.close();
    self.endpoint = null;
    if (owns()) delete globalThis[OWNER_KEY];
  });
}
