/**
 * Local, process-bound OMP transport. This module never spawns or resumes an agent.
 * A receipt confirms acceptance by the original host, not model reading/completion.
 * POSIX-only; built from Node APIs also available in Bun. No external dependency.
 */
import { createServer, createConnection } from 'node:net';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, unlink, readdir, chmod, rmdir } from 'node:fs/promises';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

const VERSION = 1;
const FRAME_MAX = 100_000;
const TEXT_MAX = 64_000;
const META_MAX = 32_000;
const TIMEOUT_MS = 2_000;
const MAX_RECEIPTS = 4096;
const MAX_CONNECTIONS = 32;
const HEX32 = /^[a-f0-9]{32}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const uid = () => process.getuid?.();
const failure = code => Object.assign(new Error(code), { code });
const safeString = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max;
const owns = info => uid() === undefined || info.uid === uid();
const privateMode = info => (info.mode & 0o077) === 0;
const processExists = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

export function defaultRegistryRoot() {
  return join(process.env.TG_CTL_CONFIG_DIR || join(homedir(), '.config', 'tg-cli'), 'omp-live');
}

async function directoryIsPrivate(path, create = false) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  let info;
  try { info = await lstat(path); } catch (e) { if (e.code === 'ENOENT' && !create) return false; throw e; }
  if (info.isSymbolicLink() || !info.isDirectory() || !owns(info) || !privateMode(info)) throw failure('unsafe_registry');
  return true;
}

/** Read a pinned regular-file descriptor through EOF, bounded even if it grows. */
export async function readBoundedUtf8(handle, limit, errorCode) {
  const buffer = Buffer.alloc(limit + 1);
  let total = 0;
  while (total <= limit) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
    if (bytesRead === 0) return buffer.subarray(0, total).toString('utf8');
    total += bytesRead;
  }
  throw failure(errorCode);
}

async function readPrivateMetadata(path, requireSocket = true) {
  // Inspect the opened inode, not a pathname that can change after lstat.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const after = await handle.stat();
    if (!after.isFile() || !owns(after) || !privateMode(after) || after.size > META_MAX) throw failure('unsafe_metadata');
    const raw = await readBoundedUtf8(handle, META_MAX, 'unsafe_metadata');
    const meta = JSON.parse(raw);
    if (meta.v !== VERSION || !Number.isSafeInteger(meta.pid) || meta.pid <= 0 || !HEX32.test(meta.instanceId) || !TOKEN.test(meta.token)
      || !safeString(meta.sessionId, 512) || !safeString(meta.cwd, 4096) || !isAbsolute(meta.cwd)
      || !safeString(meta.socket, 1024) || !isAbsolute(meta.socket)) throw failure('unsafe_metadata');
    if (!requireSocket) return meta;
    // A planted descriptor cannot point at a foreign/world-readable Unix socket.
    await directoryIsPrivate(dirname(meta.socket));
    const socketInfo = await lstat(meta.socket);
    if (!socketInfo.isSocket() || !owns(socketInfo) || !privateMode(socketInfo)) throw failure('unsafe_socket');
    return meta;
  } finally { await handle.close(); }
}

function publicSnapshot(raw, pid, instanceId) {
  if (!raw || !safeString(raw.sessionId, 512) || !safeString(raw.cwd, 4096) || !isAbsolute(raw.cwd)) throw failure('invalid_host_state');
  return {
    pid, instanceId, sessionId: raw.sessionId,
    sessionFile: typeof raw.sessionFile === 'string' && raw.sessionFile.length <= 8192 ? raw.sessionFile : null,
    cwd: raw.cwd, durableSession: typeof raw.durableSession === 'string' ? raw.durableSession.slice(0, 256) : null,
    busy: typeof raw.busy === 'boolean' ? raw.busy : null,
    title: typeof raw.title === 'string' ? raw.title.slice(0, 1024) : null,
  };
}

function authenticated(expected, supplied) {
  if (typeof supplied !== 'string') return false;
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** @param {{root?:string, snapshot:()=>object, send:(text:string)=>void|Promise<void>}} options */
export async function startLiveEndpoint({ root = defaultRegistryRoot(), snapshot, send }) {
  if (process.platform === 'win32') throw failure('posix_required');
  if (typeof snapshot !== 'function' || typeof send !== 'function') throw failure('invalid_host_callbacks');
  root = resolve(root);
  await directoryIsPrivate(root, true);
  const pid = process.pid;
  const instanceId = randomBytes(16).toString('hex');
  const token = randomBytes(32).toString('hex');
  const stem = `${pid}-${instanceId}`;
  const metadataPath = join(root, `${stem}.json`);
  let socketPath = join(root, `${stem}.sock`);
  let fallbackDir = null;
  if (Buffer.byteLength(socketPath) > 100) {
    // Use /tmp rather than macOS's very long per-user TMPDIR. No shared permissive dir.
    fallbackDir = join('/tmp', `ol-${uid() ?? 'u'}-${randomBytes(12).toString('hex')}`);
    await directoryIsPrivate(fallbackDir, true);
    socketPath = join(fallbackDir, 'live.sock');
  }
  let closed = false;
  const sockets = new Set();
  const receipts = new Map();
  let deliveryChain = Promise.resolve();
  const state = () => publicSnapshot(snapshot(), pid, instanceId);
  let refreshChain = Promise.resolve();
  async function refresh() {
    const operation = refreshChain.then(async () => {
      if (closed) return;
      const data = JSON.stringify({ v: VERSION, ...state(), socket: socketPath, token });
      if (Buffer.byteLength(data) > META_MAX) throw failure('invalid_host_state');
      const tmp = `${metadataPath}.${randomBytes(6).toString('hex')}.tmp`;
      const file = await open(tmp, 'wx', 0o600);
      try { await file.writeFile(`${data}\n`); } finally { await file.close(); }
      try { if (!closed) await rename(tmp, metadataPath); } finally { await unlink(tmp).catch(() => {}); }
    });
    refreshChain = operation.catch(() => {});
    return operation;
  }
  async function dispatch(request) {
    if (closed) throw failure('endpoint_closed');
    if (!request || request.v !== VERSION) throw failure('unsupported_protocol');
    if (!authenticated(token, request.token)) throw failure('authentication_failed');
    if (request.pid !== pid || request.instanceId !== instanceId) throw failure('stale_identity');
    const current = state();
    if (request.op === 'status') return { ok: true, v: VERSION, ...current };
    if (request.op !== 'send') throw failure('invalid_operation');
    if (request.sessionId !== current.sessionId) throw failure('stale_session');
    if (!safeString(request.requestId, 256)) throw failure('invalid_request_id');
    if (typeof request.text !== 'string' || request.text.trim().length === 0) throw failure('invalid_message');
    if (Buffer.byteLength(request.text) > TEXT_MAX) throw failure('message_too_large');
    const hash = createHash('sha256').update(request.text).digest('hex');
    const key = `${current.sessionId}\0${request.requestId}`;
    const prior = receipts.get(key);
    if (prior) {
      if (prior.hash !== hash) throw failure('request_id_conflict');
      return await prior.result;
    }
    // Never evict an accepted receipt and accidentally replay it. Saturation fails closed.
    if (receipts.size >= MAX_RECEIPTS) throw failure('receipt_capacity_reached');
    const result = deliveryChain.then(async () => {
      try {
        // Re-check at admission, not only before waiting behind another input.
        if (closed) throw failure('endpoint_closed');
        if (state().sessionId !== current.sessionId) throw failure('stale_session');
        await send(request.text);
        return { ok: true, v: VERSION, accepted: true, status: 'accepted', requestId: request.requestId, pid, instanceId, sessionId: current.sessionId };
      } catch {
        // Uncertain side effect: retain the rejection; the same ID is never retried.
        return { ok: false, v: VERSION, error: 'delivery_failed' };
      }
    });
    receipts.set(key, { hash, result });
    deliveryChain = result.then(() => undefined, () => undefined);
    return result;
  }
  const server = createServer(socket => {
    if (sockets.size >= MAX_CONNECTIONS || closed) { socket.destroy(); return; }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy());
    let buffer = Buffer.alloc(0), handled = false;
    const respond = data => { if (!socket.destroyed) socket.end(`${JSON.stringify(data)}\n`); };
    socket.on('data', chunk => {
      if (handled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > FRAME_MAX) { handled = true; respond({ ok: false, v: VERSION, error: 'frame_too_large' }); return; }
      const nl = buffer.indexOf(10);
      if (nl < 0) return;
      handled = true;
      let request;
      try { request = JSON.parse(buffer.subarray(0, nl).toString('utf8')); }
      catch { respond({ ok: false, v: VERSION, error: 'malformed_request' }); return; }
      dispatch(request).then(respond, e => respond({ ok: false, v: VERSION, error: /^[a-z_]+$/.test(e?.code ?? '') ? e.code : 'host_unavailable' }));
    });
  });
  const close = async () => {
    if (closed) return;
    closed = true;
    await refreshChain;
    for (const socket of sockets) socket.destroy();
    await new Promise(resolveClose => server.close(() => resolveClose()));
    await unlink(metadataPath).catch(e => { if (e.code !== 'ENOENT') throw e; });
    await unlink(socketPath).catch(e => { if (e.code !== 'ENOENT') throw e; });
    if (fallbackDir) await rmdir(fallbackDir).catch(e => { if (e.code !== 'ENOENT') throw e; });
  };
  try {
    await new Promise((res, rej) => { server.once('error', rej); server.listen(socketPath, res); });
    await chmod(socketPath, 0o600);
    await refresh();
    // Runtime errors remain contained; the process's next reload can republish.
    server.on('error', () => {});
  } catch (e) { await close(); throw e; }
  return { metadataPath, instanceId, pid, refresh, close };
}

/** One request per connection, bounded and authenticated. Does not spawn any processes. */
export async function requestEndpoint(meta, payload, timeoutMs = TIMEOUT_MS) {
  const request = { ...payload, v: VERSION, pid: meta.pid, instanceId: meta.instanceId, token: meta.token };
  const wire = Buffer.from(`${JSON.stringify(request)}\n`);
  if (wire.length > FRAME_MAX) throw failure('frame_too_large');
  return await new Promise((resolveResult, reject) => {
    const socket = createConnection(meta.socket);
    let buffer = Buffer.alloc(0), settled = false;
    const finish = (err, result) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); err ? reject(err) : resolveResult(result); };
    const timer = setTimeout(() => finish(failure('endpoint_timeout')), timeoutMs);
    socket.on('error', () => finish(failure('endpoint_unavailable')));
    socket.on('end', () => { if (!settled) finish(failure('incomplete_reply')); });
    socket.on('connect', () => socket.write(wire));
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > FRAME_MAX) { finish(failure('response_too_large')); return; }
      const nl = buffer.indexOf(10);
      if (nl < 0) return;
      try {
        const reply = JSON.parse(buffer.subarray(0, nl).toString('utf8'));
        if (reply?.v !== VERSION) { finish(failure('invalid_reply')); return; }
        if (reply.ok !== true) { finish(failure(typeof reply.error === 'string' && /^[a-z_]+$/.test(reply.error) ? reply.error : 'invalid_reply')); return; }
        if (reply.pid !== meta.pid || reply.instanceId !== meta.instanceId) { finish(failure('stale_identity')); return; }
        finish(null, reply);
      } catch { finish(failure('malformed_reply')); }
    });
  });
}

async function pruneDeadMetadata(root, name, meta) {
  // Only our exact, private record for a positively absent PID can be removed.
  if (name !== `${meta.pid}-${meta.instanceId}.json` || processExists(meta.pid)) return;
  const file = join(root, name);
  const again = await readPrivateMetadata(file, false);
  if (again.instanceId !== meta.instanceId || again.token !== meta.token || processExists(meta.pid)) return;
  const stem = `${meta.pid}-${meta.instanceId}.sock`;
  const direct = meta.socket === join(root, stem);
  const fallback = new RegExp(`^/tmp/ol-${uid() ?? 'u'}-[a-f0-9]{24}/live\\.sock$`).test(meta.socket);
  if (direct || fallback) {
    try {
      await directoryIsPrivate(dirname(meta.socket));
      const info = await lstat(meta.socket);
      if (info.isSocket() && owns(info) && privateMode(info)) await unlink(meta.socket);
      if (fallback) await rmdir(dirname(meta.socket)).catch(() => {});
    } catch { /* Missing socket is normal after a crash. */ }
  }
  await unlink(file);
}

async function probed(root, exactPid) {
  root = resolve(root);
  if (!await directoryIsPrivate(root)) return [];
  const names = (await readdir(root)).filter(n => /^[0-9]+-[a-f0-9]{32}\.json$/.test(n)
    && (exactPid === undefined || n.startsWith(`${exactPid}-`)));
  if (names.length > 4096) throw failure('registry_capacity_exceeded');
  const candidates = [];
  // Files are checked in bounded batches; network probes share one deadline.
  for (let i = 0; i < names.length; i += 64) {
    await Promise.all(names.slice(i, i + 64).map(async name => {
      try {
        const meta = await readPrivateMetadata(join(root, name), false);
        if (!processExists(meta.pid)) { await pruneDeadMetadata(root, name, meta); return; }
        const checked = await readPrivateMetadata(join(root, name));
        candidates.push(checked);
      } catch { /* Unsafe and corrupt records never become live targets. */ }
    }));
  }
  if (candidates.length > 256) throw failure('registry_capacity_exceeded');
  const rows = (await Promise.all(candidates.map(async meta => {
    try {
      const status = await requestEndpoint(meta, { op: 'status' }, 350);
      return { meta, status: publicSnapshot(status, meta.pid, meta.instanceId) };
    } catch { return null; }
  }))).filter(Boolean);
  return rows.sort((a,b) => a.status.pid-b.status.pid || a.status.instanceId.localeCompare(b.status.instanceId));
}

export async function listLiveEndpoints(root = defaultRegistryRoot()) {
  return (await probed(root)).map(r => r.status);
}

export async function sendLiveMessage({ root = defaultRegistryRoot(), pid, instanceId, sessionId, requestId, text }) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw failure('exact_pid_required');
  if (typeof text !== 'string' || !text.trim()) throw failure('invalid_message');
  if (Buffer.byteLength(text) > TEXT_MAX) throw failure('message_too_large');
  const matches = (await probed(root, pid)).filter(r => r.status.pid === pid);
  // Duplicate metadata/process registrations are never resolved by cwd, title or newest timestamp.
  if (!matches.length) throw failure('endpoint_unavailable');
  if (matches.length !== 1) throw failure('ambiguous_endpoint');
  const { meta, status } = matches[0];
  if (instanceId !== undefined && instanceId !== status.instanceId) throw failure('stale_identity');
  if (sessionId !== undefined && sessionId !== status.sessionId) throw failure('stale_session');
  const reply = await requestEndpoint(meta, { op: 'send', sessionId: status.sessionId, requestId, text });
  if (reply.accepted !== true || reply.sessionId !== status.sessionId || reply.requestId !== requestId) throw failure('invalid_acceptance');
  return reply;
}
