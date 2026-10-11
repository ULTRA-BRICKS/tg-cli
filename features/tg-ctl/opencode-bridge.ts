// tg-ctl's opencode bridge (tg-cli#533): discovers live opencode servers, holds one
// event-stream subscription per server, and turns each question/permission ask into a card
// through the daemon's own hook socket — the same ButtonRequest path every hook ask takes
// (registration gate, dedupe, expiry, callbacks). The tapped answer goes back through
// opencode's reply route (opencodeReplyPlan).
//
// Everything here is async and bounded: a subscription is a fetch stream that never blocks
// the Telegram poll loop, reconnects with capped backoff, caps its event buffer, and caps the
// number of asks it holds open. All host I/O is injected (BridgeIo) so the tg-ctl entrypoint
// keeps only the real ps/lsof/file/socket wiring.
//
// Discovery covers both opencode generations:
//   - 2.x: one background service shared by every session, announced in
//     `$XDG_STATE_HOME/opencode/service.json` ({ url, pid, password }); `/api/*` routes,
//     HTTP Basic auth `opencode:<password>`.
//   - 1.x: a server per TUI session on its own (often random) port: the listening ports of
//     `opencode` processes, kept when `GET /session` answers a JSON session list.

import { opencodeEventToButtonRequest, opencodeReplyPlan, recordOf, type OpencodeEvent } from './opencode';
import type { ButtonRequest } from './questions';
import type { OpencodeSessionRecord } from '../agent-role/role';

export interface OpencodeServer {
  url: string;
  protocol: 'api' | 'legacy';
  authorization?: string;
}

export interface DiscoveryIo {
  readServiceState(): Promise<string | null>;
  pidAlive(pid: number): boolean;
  opencodePids(): Promise<number[]>;
  listenUrls(pids: number[]): Promise<string[]>;
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export interface BridgeIo {
  discover(): Promise<OpencodeServer[]>;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  // One daemon round-trip for the ask; resolves with the daemon's reply line (null on a
  // decline/expiry/drop). Aborting the signal closes the socket, which retires the card.
  ask(req: ButtonRequest, signal: AbortSignal): Promise<string | null>;
  log(line: string): void;
  // A Telegram notice for an outcome the user must act on.
  notify(text: string): void;
}

export interface BridgeOptions {
  rescanMs: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  maxPendingAsks: number;
  maxEventBytes: number;
  requestTimeoutMs: number;
}

export const DEFAULT_BRIDGE_OPTIONS: BridgeOptions = {
  rescanMs: 15_000,
  reconnectMinMs: 1_000,
  reconnectMaxMs: 30_000,
  maxPendingAsks: 32,
  maxEventBytes: 1_000_000,
  requestTimeoutMs: 5_000,
};

const ASK_TYPES: Record<string, true> = {
  'question.asked': true, 'question.v2.asked': true, 'permission.asked': true, 'permission.v2.asked': true, 'form.created': true,
};
// Settled elsewhere (the TUI answered, the agent cancelled): retire the Telegram card.
const SETTLED_TYPES: Record<string, true> = {
  'question.replied': true, 'question.rejected': true, 'question.v2.replied': true, 'question.v2.rejected': true,
  'permission.replied': true, 'permission.v2.replied': true, 'form.replied': true, 'form.cancelled': true,
};

export function opencodeServiceFromState(text: string | null, pidAlive: (pid: number) => boolean): OpencodeServer | null {
  if (!text) return null;
  let state: unknown;
  try {
    state = JSON.parse(text);
  } catch {
    return null;
  }
  const rec = recordOf(state);
  const url = rec && typeof rec.url === 'string' ? rec.url : null;
  if (!rec || !url || !/^https?:\/\//.test(url)) return null;
  if (typeof rec.pid === 'number' && !pidAlive(rec.pid)) return null;
  const password = typeof rec.password === 'string' ? rec.password : null;
  return {
    url: url.replace(/\/+$/, ''),
    protocol: 'api',
    ...(password ? { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` } : {}),
  };
}

// `lsof -nP -a -iTCP -sTCP:LISTEN -p <pids> -Fn` name lines (`n127.0.0.1:4096`, `n*:4096`,
// `n[::1]:4096`) → loopback URLs. IPv4 and wildcard binds answer on 127.0.0.1; an IPv6 bind
// is dialled on [::1], since an IPv6-only listener refuses 127.0.0.1.
export function parseLsofListenUrls(out: string): string[] {
  const urls = new Set<string>();
  for (const line of out.split('\n')) {
    const m = line.match(/^n(127\.0\.0\.1|0\.0\.0\.0|\*|localhost|\[::1\]|\[::\]):(\d+)$/);
    if (m) urls.add(m[1].startsWith('[') ? `http://[::1]:${m[2]}` : `http://127.0.0.1:${m[2]}`);
  }
  return [...urls];
}

export async function discoverOpencodeServers(io: DiscoveryIo, timeoutMs: number): Promise<OpencodeServer[]> {
  const servers: OpencodeServer[] = [];
  const service = opencodeServiceFromState(await io.readServiceState(), (pid) => io.pidAlive(pid));
  if (service) servers.push(service);
  const pids = await io.opencodePids();
  if (!pids.length) return servers;
  for (const url of await io.listenUrls(pids)) {
    const port = new URL(url).port;
    if (servers.some((s) => new URL(s.url).port === port)) continue;
    try {
      const res = await io.fetch(`${url}/session`, { signal: AbortSignal.timeout(timeoutMs) });
      const body: unknown = res.ok && (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : null;
      if (Array.isArray(body)) servers.push({ url, protocol: 'legacy' });
    } catch {
      // not an opencode 1.x server (a 2.x standalone UI port, or gone): skip it
    }
  }
  return servers;
}

// Incremental `text/event-stream` decoder: calls onData with each event's joined `data:`
// lines. An event larger than maxBytes is discarded whole (its tail skipped up to the next
// blank line) so a runaway stream cannot grow the buffer without bound.
export function createSseDecoder(onData: (data: string) => void, maxBytes: number): (chunk: string) => void {
  let pending = '';
  let data: string[] = [];
  let size = 0;
  let skipping = false;
  return (chunk) => {
    pending += chunk;
    let nl: number;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl).replace(/\r$/, '');
      pending = pending.slice(nl + 1);
      if (line === '') {
        if (!skipping && data.length) onData(data.join('\n'));
        data = [];
        size = 0;
        skipping = false;
        continue;
      }
      if (skipping || !line.startsWith('data:')) continue;
      const value = line.slice(5).replace(/^ /, '');
      size += value.length;
      if (size > maxBytes) {
        skipping = true;
        data = [];
        continue;
      }
      data.push(value);
    }
    if (pending.length > maxBytes) {
      pending = '';
      skipping = true;
      data = [];
    }
  };
}

// Runs for the daemon's lifetime: rescans discovery every rescanMs and keeps one
// subscription per live server.
export function startOpencodeBridge(io: BridgeIo, options: BridgeOptions = DEFAULT_BRIDGE_OPTIONS): void {
  const subscriptions = new Map<string, AbortController>();
  const pending = new Map<string, AbortController>();

  const headers = (server: OpencodeServer, extra: Record<string, string> = {}): Record<string, string> =>
    server.authorization ? { ...extra, authorization: server.authorization } : extra;

  const fetchSession = async (server: OpencodeServer, sessionId: string): Promise<{ record?: OpencodeSessionRecord; cwd?: string }> => {
    const path = server.protocol === 'api' ? `/api/session/${encodeURIComponent(sessionId)}` : `/session/${encodeURIComponent(sessionId)}`;
    try {
      const res = await io.fetch(`${server.url}${path}`, { headers: headers(server), signal: AbortSignal.timeout(options.requestTimeoutMs) });
      if (!res.ok) return {};
      const body = recordOf(await res.json());
      const rec = server.protocol === 'api' ? recordOf(body?.data) : body;
      if (!rec) return {};
      const directory = recordOf(rec.location)?.directory ?? rec.directory;
      return {
        record: {
          id: typeof rec.id === 'string' ? rec.id : undefined,
          parentID: typeof rec.parentID === 'string' ? rec.parentID : null,
          title: typeof rec.title === 'string' ? rec.title : undefined,
        },
        cwd: typeof directory === 'string' ? directory : undefined,
      };
    } catch {
      return {};
    }
  };

  const deliver = async (server: OpencodeServer, req: ButtonRequest, raw: string | null): Promise<void> => {
    let answer: unknown;
    try {
      answer = raw ? recordOf(JSON.parse(raw))?.answer : undefined;
    } catch {
      answer = undefined;
    }
    if (typeof answer !== 'string') {
      io.log(`opencode: ask ${req.requestId} closed without an answer — it stays open in opencode`);
      return;
    }
    const plan = opencodeReplyPlan(server.url, req, answer);
    if (!plan) return;
    // The card already says the answer was sent; a refused reply must be said out loud.
    const refused = (why: string): void => {
      io.log(`opencode: reply ${req.requestId} → ${plan.url} ${why}`);
      io.notify(`opencode did not take the answer to "${req.title ?? req.question}" (${why}) — answer it in opencode.`);
    };
    try {
      const res = await io.fetch(plan.url, {
        method: plan.method,
        headers: headers(server, { 'content-type': 'application/json' }),
        body: JSON.stringify(plan.body),
        signal: AbortSignal.timeout(options.requestTimeoutMs),
      });
      if (res.ok) io.log(`opencode: reply ${req.requestId} → ${plan.url} ${res.status}`);
      else refused(`HTTP ${res.status}`);
    } catch (err) {
      refused(String(err));
    }
  };

  const onAsk = async (server: OpencodeServer, event: OpencodeEvent, signal: AbortSignal): Promise<void> => {
    const draft = opencodeEventToButtonRequest(event);
    if (!draft?.opencode) {
      io.log(`opencode: ${event.type} not forwardable as buttons — answer it in opencode`);
      return;
    }
    const serverPrefix = `${server.url}|`;
    const key = `${serverPrefix}${draft.opencode.sessionId}|${draft.opencode.requestId}`;
    if (pending.has(key)) return;
    // Capped per server, so one runaway session cannot crowd out another server's asks.
    const open = [...pending.keys()].filter((k) => k.startsWith(serverPrefix)).length;
    if (open >= options.maxPendingAsks) {
      io.log(`opencode: ${open} asks already open on ${server.url} — ${draft.requestId} left to the terminal`);
      return;
    }
    const controller = new AbortController();
    pending.set(key, controller);
    const onStop = (): void => controller.abort();
    signal.addEventListener('abort', onStop);
    try {
      const session = await fetchSession(server, draft.opencode.sessionId);
      const req = opencodeEventToButtonRequest(event, session.record);
      if (!req || controller.signal.aborted) return;
      const raw = await io.ask(session.cwd ? { ...req, cwd: session.cwd } : req, controller.signal);
      if (!controller.signal.aborted) await deliver(server, req, raw);
    } catch (err) {
      io.log(`opencode: ask ${draft.requestId} failed: ${String(err)}`);
    } finally {
      signal.removeEventListener('abort', onStop);
      pending.delete(key);
    }
  };

  const onEvent = (server: OpencodeServer, data: string, signal: AbortSignal): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const rec = recordOf(parsed);
    if (!rec || typeof rec.type !== 'string') return;
    const event: OpencodeEvent = { type: rec.type, properties: recordOf(rec.properties), data: rec.data };
    if (ASK_TYPES[rec.type] === true) {
      void onAsk(server, event, signal);
      return;
    }
    if (SETTLED_TYPES[rec.type] === true) {
      const p = recordOf(rec.properties) ?? recordOf(rec.data) ?? {};
      const requestId = p.requestID ?? p.requestId ?? p.id;
      const sessionId = p.sessionID ?? p.sessionId;
      if (typeof requestId === 'string' && typeof sessionId === 'string') {
        pending.get(`${server.url}|${sessionId}|${requestId}`)?.abort();
      }
    }
  };

  const subscribe = async (server: OpencodeServer, signal: AbortSignal): Promise<void> => {
    const path = server.protocol === 'api' ? '/api/event' : '/event';
    let backoff = options.reconnectMinMs;
    while (!signal.aborted) {
      try {
        const res = await io.fetch(`${server.url}${path}`, { headers: headers(server, { accept: 'text/event-stream' }), signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        io.log(`opencode: subscribed to ${server.url}${path}`);
        backoff = options.reconnectMinMs;
        const decode = createSseDecoder((data) => onEvent(server, data, signal), options.maxEventBytes);
        const text = new TextDecoder();
        for await (const chunk of res.body) decode(text.decode(chunk, { stream: true }));
        io.log(`opencode: ${server.url}${path} stream ended — reconnecting`);
      } catch (err) {
        if (signal.aborted) return;
        io.log(`opencode: ${server.url}${path} unavailable (${String(err)}) — retry in ${backoff}ms`);
      }
      await abortableSleep(backoff, signal);
      backoff = Math.min(backoff * 2, options.reconnectMaxMs);
    }
  };

  const rescan = async (): Promise<void> => {
    let servers: OpencodeServer[];
    try {
      servers = await io.discover();
    } catch (err) {
      io.log(`opencode: discovery failed: ${String(err)}`);
      return;
    }
    // Keyed by URL AND credentials: a restarted service that reuses its port but rotates its
    // password replaces the old subscription instead of retrying stale auth forever.
    const identity = (s: OpencodeServer): string => `${s.url} ${s.authorization ?? ''}`;
    const live = new Set(servers.map(identity));
    for (const [key, controller] of subscriptions) {
      if (live.has(key)) continue;
      controller.abort();
      subscriptions.delete(key);
      io.log(`opencode: ${key.split(' ')[0]} gone or re-keyed — unsubscribed`);
    }
    for (const server of servers) {
      if (subscriptions.has(identity(server))) continue;
      const controller = new AbortController();
      subscriptions.set(identity(server), controller);
      void subscribe(server, controller.signal);
    }
  };

  void (async () => {
    for (;;) {
      await rescan();
      await abortableSleep(options.rescanMs);
    }
  })();
}

// Unref'd so an idle bridge never keeps the process alive on its own.
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (signal?.aborted) {
    resolve();
    return promise;
  }
  const timer = setTimeout(done, ms);
  timer.unref?.();
  signal?.addEventListener('abort', done, { once: true });
  function done(): void {
    clearTimeout(timer);
    signal?.removeEventListener('abort', done);
    resolve();
  }
  return promise;
}
