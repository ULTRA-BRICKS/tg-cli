// Typing into an abduco session's PTY (docs/specs/2026-09-30-harness-agnostic-control.md §4).
//
// abduco's server owns the PTY master of a hosted session. Any local process may connect
// to its unix socket as a short-lived CLIENT — MSG_ATTACH (low priority: it never steals
// the session from a human attached elsewhere), MSG_CONTENT packets (the bytes go to the
// PTY exactly as if typed into an attached terminal), MSG_DETACH. So a wrapper-hosted
// harness is driven through the terminal it already reads; no second process loads its
// history and the harness stays the only writer of it.
//
// Wire format (abduco 0.6, verified 2026-09-30 against `brew install abduco`): a 16-byte
// header — u32 type at 0, u64 payload length at 8, both native-endian (little-endian on
// every platform tg-cli runs on) — then the payload. A payload never exceeds the server's
// BUFSIZ: 1024 on Darwin, larger on Linux, so 1024 is safe on both.
//
// The injection recipe is the tmux one (inject.ts): a one-line message is typed as is
// (`send-keys -l`), a multi-line one is a single bracketed paste (a typed newline would submit
// early), then a real gap, then a SEPARATE Enter — an Ink TUI drops a submit that arrives glued
// to the text. The paste markers are only ever sent for multi-line text: the wire has no way to
// know whether the harness enabled bracketed-paste mode, and a harness that did not would show
// the markers as literal characters.
//
// The packet/recipe builders are PURE; `injectIntoAbducoSession` takes the socket as a
// dependency so its ordering and failure semantics are unit-tested without a server.

export const MSG_CONTENT = 0;
export const MSG_ATTACH = 1;
export const MSG_DETACH = 2;
const CLIENT_LOWPRIO = 2;
const HEADER_BYTES = 16;
export const MAX_CONTENT_BYTES = 1024;
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const SUBMIT_GAP_MS = 500;
const FLUSH_MS = 100;

export function encodePacket(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, type, true);
  view.setBigUint64(8, BigInt(payload.length), true);
  out.set(payload, HEADER_BYTES);
  return out;
}

export function attachPacket(): Uint8Array {
  const flags = new Uint8Array(4);
  new DataView(flags.buffer).setUint32(0, CLIENT_LOWPRIO, true);
  return encodePacket(MSG_ATTACH, flags);
}

export function detachPacket(): Uint8Array {
  return encodePacket(MSG_DETACH, new Uint8Array(0));
}

// Raw bytes → MSG_CONTENT packets of at most MAX_CONTENT_BYTES payload each. Split on bytes,
// not characters: the PTY reassembles a multi-byte sequence split across packets.
export function contentPackets(bytes: Uint8Array): Uint8Array[] {
  const packets: Uint8Array[] = [];
  for (let off = 0; off < bytes.length; off += MAX_CONTENT_BYTES) {
    packets.push(encodePacket(MSG_CONTENT, bytes.subarray(off, off + MAX_CONTENT_BYTES)));
  }
  return packets;
}

// What may be typed. Newlines and tabs stay; CR/CRLF become LF; every other control
// character — above all ESC, which could close the bracketed paste early and turn the rest
// of the message into keystrokes — is dropped. Printable text of every script is untouched.
export function sanitizeForPty(text: string): string {
  // C1 controls (U+0080-009F) go too: U+009B is the one-character CSI, so `U+009B 201~` would
  // close the paste as ESC [ 201 ~ does on a terminal that honours 8-bit controls.
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

export interface PtyInjection {
  // Exactly the bytes to type (or paste) before the gap; empty when nothing typeable is left.
  text: Uint8Array;
  gapMs: number;
  submit: Uint8Array;
}

export function buildPtyInjection(text: string, gapMs: number = SUBMIT_GAP_MS): PtyInjection {
  const enc = new TextEncoder();
  const clean = sanitizeForPty(text);
  let typed = '';
  if (clean.trim() !== '') {
    // A multi-line message is one bracketed paste, so a tab stays a literal tab inside it. A
    // single line is typed key by key, where a TUI would read a tab as completion / focus
    // movement: it becomes a space. (tmux send-keys -l has no such split; this is deliberate.)
    typed = clean.includes('\n') ? `${PASTE_START}${clean}${PASTE_END}` : clean.replace(/\t/g, ' ');
  }
  return { text: enc.encode(typed), gapMs, submit: enc.encode('\r') };
}

// A connected abduco client socket. `write` resolves once the bytes are handed to the
// kernel and REJECTS when the connection is gone; the implementation discards whatever
// the server sends back (screen output) so it can never block on a full pipe.
export interface PtySocket {
  write(packet: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

// Thrown by a socket whose write failed after SOME of the packet's bytes were already handed to
// the kernel: those may have reached the PTY, so the delivery is uncertain, not retry-safe.
export class PartialWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PartialWriteError';
  }
}

export interface PtyDeps {
  connect(socketPath: string): Promise<PtySocket>;
  sleep(ms: number): Promise<void>;
}

// `uncertain`: bytes of the message were already written when the connection failed — the
// text may sit in the harness's prompt, so the caller must not treat a retry as safe.
export type PtyInjectResult = { ok: true } | { ok: false; error: string; uncertain: boolean };

export async function injectIntoAbducoSession(deps: PtyDeps, socketPath: string, text: string): Promise<PtyInjectResult> {
  const recipe = buildPtyInjection(text);
  if (recipe.text.length === 0) return { ok: false, error: 'the message has nothing typeable in it', uncertain: false };
  let sent = false;
  let socket: PtySocket;
  try {
    socket = await deps.connect(socketPath);
  } catch (err) {
    return { ok: false, error: `cannot connect to the abduco session (${err instanceof Error ? err.message : String(err)})`, uncertain: false };
  }
  try {
    await socket.write(attachPacket());
    for (const packet of contentPackets(recipe.text)) {
      await socket.write(packet);
      sent = true;
    }
    await deps.sleep(recipe.gapMs);
    for (const packet of contentPackets(recipe.submit)) await socket.write(packet);
    await deps.sleep(FLUSH_MS);
    // Everything is written; a connection lost now changes nothing about the delivery.
    await socket.write(detachPacket()).catch(() => undefined);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `the abduco session dropped the connection (${err instanceof Error ? err.message : String(err)})`, uncertain: sent || err instanceof PartialWriteError };
  } finally {
    await socket.close().catch(() => undefined);
  }
}
