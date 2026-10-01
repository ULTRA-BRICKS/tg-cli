import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { connectAbducoSocket } from '../features/tg-ctl/abduco-client';
import { MSG_ATTACH, MSG_CONTENT, MSG_DETACH, attachPacket, contentPackets, detachPacket, injectIntoAbducoSession } from '../features/tg-ctl/abduco-pty';

// The real unix-socket client against an in-process stand-in for abduco's server: what
// reaches the socket must decode as the same packet stream, in order, and a dead
// connection must reject writes instead of pretending they were delivered.

const dirs: string[] = [];
const stops: Array<() => void> = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tg-abc-'));
  dirs.push(dir);
  return join(dir, 's');
}

// Serves `path`; `received` resolves with every byte the client sent once it disconnects.
function fakeServer(path: string, opts: { hangUpAfterBytes?: number } = {}) {
  const chunks: Buffer[] = [];
  const done = Promise.withResolvers<Buffer>();
  const server = Bun.listen({
    unix: path,
    socket: {
      data(sock, data) {
        chunks.push(Buffer.from(data));
        if (opts.hangUpAfterBytes !== undefined && Buffer.concat(chunks).length >= opts.hangUpAfterBytes) sock.end();
      },
      close() {
        done.resolve(Buffer.concat(chunks));
      },
    },
  });
  stops.push(() => server.stop(true));
  return { received: done.promise };
}

function decodeTypes(stream: Uint8Array): number[] {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const types: number[] = [];
  for (let off = 0; off < stream.length; off += 16 + Number(view.getBigUint64(off + 8, true))) types.push(view.getUint32(off, true));
  return types;
}

test('the bytes written arrive in order as one intact packet stream', async () => {
  const path = sockPath();
  const server = fakeServer(path);
  const socket = await connectAbducoSocket(path);
  const big = contentPackets(new Uint8Array(5000).fill(0x61));
  for (const p of [attachPacket(), ...big, detachPacket()]) await socket.write(p);
  await socket.close();
  const received = await server.received;
  const expected = Buffer.concat([attachPacket(), ...big, detachPacket()]);
  expect(received.equals(expected)).toBe(true);
  expect(decodeTypes(received)).toEqual([MSG_ATTACH, ...big.map(() => MSG_CONTENT), MSG_DETACH]);
});

test('nothing listens on the path: connect rejects', async () => {
  await expect(connectAbducoSocket(sockPath())).rejects.toThrow();
});

test('the server hangs up: later writes reject rather than report a delivery', async () => {
  const path = sockPath();
  const server = fakeServer(path, { hangUpAfterBytes: 1 });
  const socket = await connectAbducoSocket(path);
  await socket.write(attachPacket());
  await server.received; // the server has closed its end
  await expect(
    (async () => {
      // the client learns of the hang-up asynchronously; the write loop must fail within a few packets
      for (let i = 0; i < 200; i++) await socket.write(contentPackets(new Uint8Array(1024))[0]);
    })(),
  ).rejects.toThrow();
});

test('injectIntoAbducoSession over the real client: attach, paste, Enter, detach reach the server once', async () => {
  const path = sockPath();
  const server = fakeServer(path);
  const res = await injectIntoAbducoSession({ connect: connectAbducoSocket, sleep: async () => undefined }, path, 'hello äö');
  expect(res).toEqual({ ok: true });
  const received = await server.received;
  expect(decodeTypes(received)).toEqual([MSG_ATTACH, MSG_CONTENT, MSG_CONTENT, MSG_DETACH]);
  expect(received.toString('utf8')).toContain('hello äö');
});

// --- real abduco 0.6 (skipped where it is not installed) ---

const abduco = Bun.which('abduco');

// The session is a real PTY with a bash that appends each line it reads; a second line that
// arrives within a second would be appended too, so a duplicated injection is visible.
// Real time is unavoidable here: abduco daemonizes, so the socket appears asynchronously, and
// the typed line reaches the file through a separate process — no in-process event to await.
test.skipIf(abduco === null)('real abduco: the text reaches the session PTY intact and exactly once', async () => {
  // a short base: a unix socket path (sun_path) is limited to 104 bytes on Darwin
  const dir = mkdtempSync('/tmp/tg-abd-');
  dirs.push(dir);
  const out = join(dir, 'typed.txt');
  const script = `IFS= read -r a; printf '%s\\n' "$a" >> '${out}'; if IFS= read -r -t 1 b; then printf '%s\\n' "$b" >> '${out}'; fi`;
  const env = { ...process.env, ABDUCO_SOCKET_DIR: dir };
  const created = Bun.spawnSync([abduco!, '-n', 'tgtest-pty', 'bash', '-c', script], { env });
  expect(created.exitCode).toBe(0);
  const socketDir = join(dir, 'abduco', process.env.USER ?? 'ultra');
  const findSocket = (): string | undefined => Bun.spawnSync(['ls', socketDir]).stdout.toString().split('\n').find((n) => n.startsWith('tgtest-pty'));
  for (let i = 0; i < 50 && findSocket() === undefined; i++) await Bun.sleep(50);
  const socketName = findSocket();
  expect(socketName).toBeDefined();
  const res = await injectIntoAbducoSession({ connect: connectAbducoSocket, sleep: (ms) => Bun.sleep(ms) }, join(socketDir, socketName!), 'hello from tg-ctl äö 你好');
  expect(res).toEqual({ ok: true });
  for (let i = 0; i < 60 && !(await Bun.file(out).exists()); i++) await Bun.sleep(50);
  await Bun.sleep(1200); // the window in which a duplicate would land
  expect(await Bun.file(out).text()).toBe('hello from tg-ctl äö 你好\n');
});

// A message longer than one MSG_CONTENT packet (1024 bytes), multi-line so it travels as a
// bracketed paste: abduco must accept the split packets and hand the PTY every byte in order,
// and the separate Enter must still submit it once. each line the PTY delivers is appended as is (the paste markers ride on the first and last line).
test.skipIf(abduco === null)('real abduco: a multi-packet multi-line message arrives whole, in order, exactly once', async () => {
  const dir = mkdtempSync('/tmp/tg-abd-');
  dirs.push(dir);
  const out = join(dir, 'typed.txt');
  const env = { ...process.env, ABDUCO_SOCKET_DIR: dir };
  const created = Bun.spawnSync([abduco!, '-n', 'tgtest-long', 'bash', '-c', `while IFS= read -r l; do printf '%s\\n' "$l" >> '${out}'; done`], { env });
  expect(created.exitCode).toBe(0);
  const socketDir = join(dir, 'abduco', process.env.USER ?? 'ultra');
  const findSocket = (): string | undefined => Bun.spawnSync(['ls', socketDir]).stdout.toString().split('\n').find((n) => n.startsWith('tgtest-long'));
  for (let i = 0; i < 50 && findSocket() === undefined; i++) await Bun.sleep(50);
  const lines = Array.from({ length: 60 }, (_, i) => `line ${String(i).padStart(2, '0')} ${'x'.repeat(50)}`);
  const message = lines.join('\n');
  expect(message.length).toBeGreaterThan(3 * 1024);
  const res = await injectIntoAbducoSession({ connect: connectAbducoSocket, sleep: (ms) => Bun.sleep(ms) }, join(socketDir, findSocket()!), message);
  expect(res).toEqual({ ok: true });
  for (let i = 0; i < 60 && !((await Bun.file(out).exists()) && (await Bun.file(out).text()).includes('line 59')); i++) await Bun.sleep(50);
  const typed = await Bun.file(out).text();
  for (const l of lines) expect(typed.split(l).length - 1).toBe(1);
  expect(typed.indexOf('line 00')).toBeLessThan(typed.indexOf('line 59'));
});
