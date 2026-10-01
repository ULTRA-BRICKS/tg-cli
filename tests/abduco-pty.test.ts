import { expect, test } from 'bun:test';
import {
  MAX_CONTENT_BYTES,
  MSG_ATTACH,
  MSG_CONTENT,
  MSG_DETACH,
  attachPacket,
  buildPtyInjection,
  contentPackets,
  detachPacket,
  encodePacket,
  injectIntoAbducoSession,
  PartialWriteError,
  sanitizeForPty,
  type PtyDeps,
  type PtySocket,
} from '../features/tg-ctl/abduco-pty';

// abduco 0.6 wire format (verified 2026-09-30): 16-byte header — u32 type @0, u64 payload
// length @8, little-endian — then the payload; MSG_ATTACH carries u32 client flags.

interface Decoded {
  type: number;
  payload: Uint8Array;
}

// Splits a recorded byte stream back into packets, the way abduco's server reads it.
function decode(stream: Uint8Array): Decoded[] {
  const out: Decoded[] = [];
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  let off = 0;
  while (off < stream.length) {
    const type = view.getUint32(off, true);
    const len = Number(view.getBigUint64(off + 8, true));
    out.push({ type, payload: stream.subarray(off + 16, off + 16 + len) });
    off += 16 + len;
  }
  return out;
}

const concat = (parts: Uint8Array[]): Uint8Array => new Uint8Array(parts.flatMap((p) => [...p]));
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

test('a packet is a 16-byte header (u32 type, u64 length, little-endian) plus the payload', () => {
  const pkt = encodePacket(MSG_CONTENT, new Uint8Array([0x61, 0x62]));
  expect([...pkt.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
  expect([...pkt.subarray(8, 16)]).toEqual([2, 0, 0, 0, 0, 0, 0, 0]);
  expect([...pkt.subarray(16)]).toEqual([0x61, 0x62]);
  expect(pkt.length).toBe(18);
});

test('attach is low priority (never steals the session from a human), detach carries no payload', () => {
  expect(decode(attachPacket())).toEqual([{ type: MSG_ATTACH, payload: new Uint8Array([2, 0, 0, 0]) }]);
  expect(decode(detachPacket())).toEqual([{ type: MSG_DETACH, payload: new Uint8Array(0) }]);
});

test('content is split into packets of at most 1024 bytes that reassemble byte-for-byte', () => {
  const bytes = new TextEncoder().encode('ж'.repeat(1500) + '😀'.repeat(300));
  const packets = decode(concat(contentPackets(bytes)));
  expect(packets.length).toBeGreaterThan(2);
  for (const p of packets) {
    expect(p.type).toBe(MSG_CONTENT);
    expect(p.payload.length).toBeLessThanOrEqual(MAX_CONTENT_BYTES);
  }
  expect(text(concat(packets.map((p) => p.payload)))).toBe('ж'.repeat(1500) + '😀'.repeat(300));
  expect(contentPackets(new Uint8Array(0))).toEqual([]);
});

test('sanitize: newlines and tabs stay, CR/CRLF become LF, ESC and other control bytes are dropped', () => {
  expect(sanitizeForPty('a\r\nb\rc\nd\te')).toBe('a\nb\nc\nd\te');
  expect(sanitizeForPty('x\x1b[201~rm -rf ~\x1b[200~y')).toBe('x[201~rm -rf ~[200~y');
  expect(sanitizeForPty('a\x00b\x07c\x08d\x7fe')).toBe('abcde');
  // the one-character CSI (U+009B) could close a bracketed paste on an 8-bit-control terminal
  expect(sanitizeForPty('x\u009b201~y\u0080z\u009f')).toBe('x201~yz');
  expect(sanitizeForPty('привет 你好 😀 ½ [TG from Alex tg#17]')).toBe('привет 你好 😀 ½ [TG from Alex tg#17]');
});

test('a one-line message is typed as is (the tmux `send-keys -l` recipe), then a gap, then a separate Enter', () => {
  const inj = buildPtyInjection('[TG from Alex tg#17] deploy now');
  expect(text(inj.text)).toBe('[TG from Alex tg#17] deploy now');
  expect(text(inj.submit)).toBe('\r');
  expect(inj.gapMs).toBeGreaterThanOrEqual(300);
});

test('a multi-line message is one bracketed paste — a typed newline would submit early', () => {
  const inj = buildPtyInjection('line one\nline two');
  expect(text(inj.text)).toBe('\x1b[200~line one\nline two\x1b[201~');
});

test('a typed line never contains a Tab (it would trigger completion) — it becomes a space; a paste keeps it', () => {
  expect(text(buildPtyInjection('a\tb').text)).toBe('a b');
  expect(text(buildPtyInjection('a\tb\nc').text)).toBe('\x1b[200~a\tb\nc\x1b[201~');
});

test('a message cannot close the paste early and have its tail typed as keystrokes', () => {
  const inj = buildPtyInjection('hi\x1b[201~\rrm -rf ~\nmore');
  const body = text(inj.text);
  expect(body.startsWith('\x1b[200~')).toBe(true);
  expect(body.endsWith('\x1b[201~')).toBe(true);
  expect(body.slice(6, -6)).not.toContain('\x1b');
  expect(body.slice(6, -6)).not.toContain('\r');
});

test('a typed line carries no control byte that could act as a keystroke', () => {
  // eslint-disable-next-line no-control-regex
  expect(text(buildPtyInjection('ab\x1b[A\x03\x7fcd').text)).not.toMatch(/[\x00-\x1f\x7f]/);
});

// --- the injector, against a recording fake socket ---

function fakeSocket(opts: { failOnWrite?: number } = {}) {
  const writes: Uint8Array[] = [];
  const events: string[] = [];
  const socket: PtySocket = {
    async write(packet) {
      if (opts.failOnWrite !== undefined && writes.length + 1 === opts.failOnWrite) throw new Error('EPIPE');
      writes.push(packet);
      events.push(`write:${decode(packet)[0].type}`);
    },
    async close() {
      events.push('close');
    },
  };
  const deps: PtyDeps = {
    connect: async () => socket,
    sleep: async (ms) => {
      events.push(`sleep:${ms}`);
    },
  };
  return { deps, writes, events };
}

test('injection order: attach, the paste, a gap, the Enter, a flush, detach, close', async () => {
  const f = fakeSocket();
  const res = await injectIntoAbducoSession(f.deps, '/s/x', 'hello');
  expect(res).toEqual({ ok: true });
  const packets = f.writes.flatMap((w) => decode(w));
  expect(packets.map((p) => p.type)).toEqual([MSG_ATTACH, MSG_CONTENT, MSG_CONTENT, MSG_DETACH]);
  expect(text(packets[1].payload)).toBe('hello');
  expect(text(packets[2].payload)).toBe('\r');
  expect(f.events.filter((e) => e.startsWith('sleep')).length).toBe(2);
  // the Enter is written only AFTER the gap, and the socket is closed last
  const i = f.events;
  expect(i.indexOf('sleep:500')).toBeLessThan(i.lastIndexOf('write:0'));
  expect(i[i.length - 1]).toBe('close');
});

test('a long message is sent as several content packets before the gap', async () => {
  const f = fakeSocket();
  await injectIntoAbducoSession(f.deps, '/s/x', 'x'.repeat(3000));
  const packets = f.writes.flatMap((w) => decode(w));
  const body = packets.filter((p) => p.type === MSG_CONTENT).slice(0, -1);
  expect(body.length).toBe(3);
  expect(text(concat(body.map((p) => p.payload)))).toBe('x'.repeat(3000));
});

test('a message with nothing typeable is refused before the session is touched', async () => {
  const f = fakeSocket();
  const res = await injectIntoAbducoSession(f.deps, '/s/x', '\x1b\x07  \n');
  expect(res).toMatchObject({ ok: false, uncertain: false });
  expect(f.writes).toEqual([]);
});

test('cannot connect: nothing was written, so a retry is safe (not uncertain)', async () => {
  const deps: PtyDeps = { connect: async () => Promise.reject(new Error('ECONNREFUSED')), sleep: async () => undefined };
  const res = await injectIntoAbducoSession(deps, '/s/x', 'hi');
  expect(res).toMatchObject({ ok: false, uncertain: false });
  expect(res.ok === false && res.error).toMatch(/ECONNREFUSED/);
});

test('the connection drops before any content: not uncertain', async () => {
  const f = fakeSocket({ failOnWrite: 2 }); // attach written, first content packet fails
  const res = await injectIntoAbducoSession(f.deps, '/s/x', 'hi');
  expect(res).toMatchObject({ ok: false, uncertain: false });
  expect(f.events.at(-1)).toBe('close');
});

test('a write that failed part-way through a packet is uncertain: some bytes may have reached the PTY', async () => {
  const f = fakeSocket();
  let n = 0;
  const deps: PtyDeps = {
    ...f.deps,
    connect: async () => ({
      write: async () => {
        if (++n === 2) throw new PartialWriteError('EPIPE after 512 bytes'); // the first content packet
      },
      close: async () => undefined,
    }),
  };
  const res = await injectIntoAbducoSession(deps, '/s/x', 'hello');
  expect(res).toMatchObject({ ok: false, uncertain: true });
});

test('the connection drops after content was written: uncertain — the text may be in the prompt', async () => {
  const f = fakeSocket({ failOnWrite: 3 }); // attach + paste written, the Enter fails
  const res = await injectIntoAbducoSession(f.deps, '/s/x', 'hi');
  expect(res).toMatchObject({ ok: false, uncertain: true });
});

test('a failing detach after everything was written is still a delivery', async () => {
  const f = fakeSocket({ failOnWrite: 4 });
  expect(await injectIntoAbducoSession(f.deps, '/s/x', 'hi')).toEqual({ ok: true });
});
