import { describe, expect, test } from 'bun:test';
import { parseAuthArgs, type AuthCommand } from '../features/auth/args';
import { markAuthBound, newNonce, parsePending, serializePending, waitingPending } from '../features/auth/binding';
import { runAuth, type AuthDeps } from '../features/auth/cli';

// docs/specs/tg-auth.md — runAuth orchestration with every effect faked: a fake
// Bot API (fetch), an in-memory config dir, a virtual clock, scripted stdin and
// an injectable daemon. The real-binary path is covered by auth-integration.test.ts.

const NOW = 1_800_000_000_000;
const TOKEN = '123:secret';
const ENV_PATH = '/cfg/.env';
const PENDING_PATH = '/cfg/tg-ctl.123.auth-pending.json';
// runAuth draws the nonce from deps.randomBytes, which the fake fills with 1s.
const NONCE = newNonce(new Uint8Array(24).fill(1));
const BOT = { id: 123, is_bot: true, username: 'my_bot', first_name: 'My Bot' };
const ALEX = { id: 42, type: 'private', first_name: 'Alex', username: 'alex' };

type Reply = { status?: number; body: unknown };
type Handler = (params: Record<string, unknown>) => Reply | Promise<Reply>;

function startMsg(updateId: number, text: string, chat: Record<string, unknown> = ALEX) {
  return { update_id: updateId, message: { message_id: updateId, text, chat, from: { id: chat.id, first_name: 'x' }, date: 1 } };
}

function world(opts: { files?: Record<string, string>; env?: Record<string, string>; handlers?: Record<string, Handler>; tty?: boolean; lines?: string[] } = {}) {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}));
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const out: string[] = [];
  const err: string[] = [];
  const lines = [...(opts.lines ?? [])];
  const interrupts = new Set<() => void>();
  const state = { t: NOW, daemonPid: null as number | null, onSleep: null as null | (() => void) };
  const handlers: Record<string, Handler> = {
    getMe: () => ({ body: { ok: true, result: BOT } }),
    getChat: (p) => ({ body: { ok: true, result: { ...ALEX, id: Number(p.chat_id) } } }),
    sendMessage: () => ({ body: { ok: true, result: { message_id: 1 } } }),
    getUpdates: (p) => {
      state.t += Number(p.timeout ?? 0) * 1000 + 1;
      return { body: { ok: true, result: [] } };
    },
    ...opts.handlers,
  };
  const deps: AuthDeps = {
    configDir: '/cfg',
    env: opts.env ?? {},
    apiBase: 'http://api',
    fetch: async (url, init) => {
      const method = String(url).split('/').pop() ?? '';
      const params = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      calls.push({ method, params });
      const h = handlers[method];
      if (!h) return Response.json({ ok: false, description: `no handler ${method}` }, { status: 404 });
      const r = await h(params);
      return Response.json(r.body, { status: r.status ?? 200 });
    },
    readFile: (p) => files.get(p) ?? null,
    writeFileAtomic: (p, c) => void files.set(p, c),
    removeFile: (p) => void files.delete(p),
    now: () => state.t,
    withLock: (_lockPath, body) => body(),
    onInterrupt: (cleanup) => {
      interrupts.add(cleanup);
      return () => void interrupts.delete(cleanup);
    },
    sleep: async (ms) => {
      state.t += ms;
      state.onSleep?.();
    },
    randomBytes: (n) => new Uint8Array(n).fill(1),
    stdinIsTTY: opts.tty ?? false,
    readLine: async () => lines.shift() ?? null,
    daemonPid: () => state.daemonPid,
    out: (l) => void out.push(l),
    err: (l) => void err.push(l),
  };
  return { deps, files, calls, out, err, state, interrupts, methods: () => calls.map((c) => c.method) };
}

function cmd(...argv: string[]): AuthCommand {
  const parsed = parseAuthArgs(['auth', ...argv]);
  if (parsed === null || 'error' in parsed) throw new Error(`bad test argv ${argv.join(' ')}`);
  return parsed;
}

describe('login — tg auth polls itself', () => {
  test('first-time setup: token → getMe → deep link → /start → .env written, offsets confirmed', async () => {
    const w = world({
      files: { [ENV_PATH]: '# keep me\nOTHER=1\n' },
      handlers: {
        getUpdates: (p) => {
          if (p.offset === undefined) return { body: { ok: true, result: [startMsg(5, 'hello', { id: 9, type: 'private' }), startMsg(6, `/start ${NONCE}`)] } };
          return { body: { ok: true, result: [] } };
        },
      },
    });
    const code = await runAuth(cmd('login', '--token', TOKEN), w.deps);
    expect(code).toBe(0);
    expect(w.files.get(ENV_PATH)).toBe(`# keep me\nOTHER=1\nTG_BOT_TOKEN=${TOKEN}\nTG_CHAT_ID=42\n`);
    expect(w.files.has(PENDING_PATH)).toBe(false);
    const polls = w.calls.filter((c) => c.method === 'getUpdates');
    // confirm mode: long-poll, then an ack past the /start update
    expect(Number(polls[0].params.timeout)).toBeGreaterThan(0);
    expect(polls.at(-1)?.params.offset).toBe(7);
    expect(polls.every((c) => c.params.allowed_updates === undefined)).toBe(true);
    const text = w.out.join('\n');
    expect(text).toContain(`https://t.me/my_bot?start=${NONCE}`);
    expect(text).toContain('bot:    @my_bot (My Bot) · id 123');
    expect(text).toContain('chat:   Alex (@alex) · private · id 42');
    expect(w.methods()).not.toContain('sendMessage');
  });

  test('the pending file is written before polling and holds only the nonce hash', async () => {
    let seen: string | undefined;
    const w = world({
      handlers: {
        getUpdates: () => {
          seen = w.files.get(PENDING_PATH);
          return { body: { ok: true, result: [startMsg(1, `/start ${NONCE}`)] } };
        },
      },
    });
    expect(await runAuth(cmd('login', '--token', TOKEN), w.deps)).toBe(0);
    expect(seen).toBeDefined();
    expect(seen).not.toContain(NONCE);
    expect(parsePending(seen ?? null)?.status).toBe('waiting');
  });

  test('--test sends exactly one confirmation to the bound chat', async () => {
    const w = world({ handlers: { getUpdates: () => ({ body: { ok: true, result: [startMsg(1, `/start ${NONCE}`)] } }) } });
    expect(await runAuth(cmd('login', '--token', TOKEN, '--test'), w.deps)).toBe(0);
    const sends = w.calls.filter((c) => c.method === 'sendMessage');
    expect(sends).toHaveLength(1);
    expect(sends[0].params.chat_id).toBe(42);
  });

  test('rebind with a chat already bound and no daemon: peek only, never confirm an offset', async () => {
    let n = 0;
    const w = world({
      files: { [ENV_PATH]: `TG_BOT_TOKEN=${TOKEN}\nTG_CHAT_ID=1\n` },
      handlers: {
        getUpdates: () => {
          n += 1;
          return { body: { ok: true, result: n < 3 ? [startMsg(3, 'pending for daemon', { id: 1, type: 'private' })] : [startMsg(3, 'x', { id: 1, type: 'private' }), startMsg(4, `/start ${NONCE}`)] } };
        },
      },
    });
    expect(await runAuth(cmd('login'), w.deps)).toBe(0);
    const polls = w.calls.filter((c) => c.method === 'getUpdates');
    expect(polls.length).toBe(3);
    expect(polls.every((c) => c.params.offset === undefined && Number(c.params.timeout) === 0)).toBe(true);
    expect(w.files.get(ENV_PATH)).toBe(`TG_BOT_TOKEN=${TOKEN}\nTG_CHAT_ID=42\n`);
  });

  test('a group /start with the right nonce is ignored; the wait times out (exit 4) and leaves .env alone', async () => {
    const w = world({
      handlers: { getUpdates: (p) => ({ body: { ok: true, result: p.offset === undefined ? [startMsg(1, `/start ${NONCE}`, { id: -5, type: 'group', title: 'g' })] : [] } }) },
    });
    // getUpdates in the base world advances the clock by the poll timeout; the
    // override above does not, so advance it here via timeout bookkeeping:
    const base = w.deps.fetch;
    w.deps.fetch = async (url, init) => {
      w.state.t += 30_000;
      return base(url, init);
    };
    expect(await runAuth(cmd('login', '--token', TOKEN, '--timeout', '60'), w.deps)).toBe(4);
    expect(w.files.has(ENV_PATH)).toBe(false);
    expect(w.files.has(PENDING_PATH)).toBe(false);
    expect(w.err.join('\n')).toMatch(/timed out/i);
  });
});

describe('login — a running daemon', () => {
  test('daemon alive for the configured token: tg auth never polls, the daemon claims via the pending file', async () => {
    const w = world({ files: { [ENV_PATH]: `TG_BOT_TOKEN=${TOKEN}\nTG_CHAT_ID=1\n` } });
    w.state.daemonPid = 999;
    w.state.onSleep = () => {
      const p = parsePending(w.files.get(PENDING_PATH) ?? null);
      if (p?.status === 'waiting') {
        w.files.set(ENV_PATH, `TG_BOT_TOKEN=${TOKEN}\nTG_CHAT_ID=77\n`);
        w.files.set(PENDING_PATH, serializePending(markAuthBound(p, { id: 77, type: 'private', first_name: 'Bea' }, w.state.t)));
      }
    };
    expect(await runAuth(cmd('login'), w.deps)).toBe(0);
    expect(w.methods()).not.toContain('getUpdates');
    expect(w.files.get(ENV_PATH)).toBe(`TG_BOT_TOKEN=${TOKEN}\nTG_CHAT_ID=77\n`);
    expect(w.files.has(PENDING_PATH)).toBe(false);
    expect(w.out.join('\n')).toContain('chat:   Bea · private · id 77');
    expect(w.out.join('\n')).toMatch(/tg-ctl/);
  });

  test('a 409 while tg auth polls hands off to a daemon that appeared mid-flow', async () => {
    const w = world({
      handlers: {
        getUpdates: () => {
          w.state.daemonPid = 555;
          return { status: 409, body: { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' } };
        },
      },
    });
    w.state.onSleep = () => {
      const p = parsePending(w.files.get(PENDING_PATH) ?? null);
      if (p?.status === 'waiting') w.files.set(PENDING_PATH, serializePending(markAuthBound(p, ALEX, w.state.t)));
    };
    expect(await runAuth(cmd('login', '--token', TOKEN), w.deps)).toBe(0);
    expect(w.calls.filter((c) => c.method === 'getUpdates')).toHaveLength(1);
    expect(w.files.get(ENV_PATH)).toBe(`TG_BOT_TOKEN=${TOKEN}\nTG_CHAT_ID=42\n`);
  });

  test('a 409 with no local daemon is another consumer: exit 5, nothing written', async () => {
    const w = world({
      handlers: { getUpdates: () => ({ status: 409, body: { ok: false, description: 'Conflict: terminated by other getUpdates request' } }) },
    });
    expect(await runAuth(cmd('login', '--token', TOKEN), w.deps)).toBe(5);
    expect(w.files.has(ENV_PATH)).toBe(false);
    expect(w.files.has(PENDING_PATH)).toBe(false);
    expect(w.err.join('\n')).toMatch(/another/i);
  });

  test('a webhook 409 names deleteWebhook', async () => {
    const w = world({
      handlers: { getUpdates: () => ({ status: 409, body: { ok: false, description: "Conflict: can't use getUpdates method while webhook is active" } }) },
    });
    expect(await runAuth(cmd('login', '--token', TOKEN), w.deps)).toBe(5);
    expect(w.err.join('\n')).toContain('deleteWebhook');
  });

  test('a daemon that records a failed claim → exit 1 with its error', async () => {
    const w = world({ files: { [ENV_PATH]: `TG_BOT_TOKEN=${TOKEN}\nTG_CHAT_ID=1\n` } });
    w.state.daemonPid = 999;
    w.state.onSleep = () => {
      const raw = w.files.get(PENDING_PATH) ?? null;
      const p = parsePending(raw);
      if (p?.status === 'waiting') w.files.set(PENDING_PATH, JSON.stringify({ ...JSON.parse(raw ?? '{}'), status: 'failed', error: 'EACCES' }));
    };
    expect(await runAuth(cmd('login'), w.deps)).toBe(1);
    expect(w.err.join('\n')).toContain('EACCES');
    expect(w.files.get(ENV_PATH)).toBe(`TG_BOT_TOKEN=${TOKEN}\nTG_CHAT_ID=1\n`);
  });

  test('binding a DIFFERENT bot while a daemon runs the old one tells the user to restart it', async () => {
    const w = world({
      files: { [ENV_PATH]: 'TG_BOT_TOKEN=999:old\nTG_CHAT_ID=1\n' },
      handlers: { getUpdates: () => ({ body: { ok: true, result: [startMsg(1, `/start ${NONCE}`)] } }) },
    });
    w.deps.daemonPid = (botId) => (botId === '999' ? 31337 : null);
    expect(await runAuth(cmd('login', '--token', TOKEN), w.deps)).toBe(0);
    expect(w.out.join('\n')).toContain('tg-ctl restart');
  });
});

describe('login — token sources and errors', () => {
  test('a rejected token (401) → exit 3, nothing written', async () => {
    const w = world({ handlers: { getMe: () => ({ status: 401, body: { ok: false, description: 'Unauthorized' } }) } });
    expect(await runAuth(cmd('login', '--token', TOKEN), w.deps)).toBe(3);
    expect(w.files.size).toBe(0);
    expect(w.err.join('\n')).toMatch(/BotFather/);
  });

  test('a network failure → exit 1', async () => {
    const w = world();
    w.deps.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    expect(await runAuth(cmd('login', '--token', TOKEN), w.deps)).toBe(1);
    expect(w.err.join('\n')).toContain('ECONNREFUSED');
  });

  test('a malformed token → exit 2 before any network call', async () => {
    const w = world();
    expect(await runAuth(cmd('login', '--token', 'nonsense'), w.deps)).toBe(2);
    expect(w.calls).toHaveLength(0);
  });

  test('no token anywhere and no terminal → exit 2 with the ways to pass one', async () => {
    const w = world();
    expect(await runAuth(cmd('login'), w.deps)).toBe(2);
    expect(w.err.join('\n')).toContain('--token');
  });

  test('--token - reads the first stdin line', async () => {
    const w = world({ lines: [`  ${TOKEN}  `], handlers: { getUpdates: () => ({ body: { ok: true, result: [startMsg(1, `/start ${NONCE}`)] } }) } });
    expect(await runAuth(cmd('login', '--token', '-'), w.deps)).toBe(0);
    expect(w.files.get(ENV_PATH)).toContain(`TG_BOT_TOKEN=${TOKEN}\n`);
  });

  test('on a terminal with no token it prompts for one', async () => {
    const w = world({ tty: true, lines: [TOKEN], handlers: { getUpdates: () => ({ body: { ok: true, result: [startMsg(1, `/start ${NONCE}`)] } }) } });
    expect(await runAuth(cmd(), w.deps)).toBe(0);
    expect(w.err.join('\n')).toMatch(/BotFather/);
    expect(w.files.get(ENV_PATH)).toContain('TG_CHAT_ID=42');
  });

  test('a TG_CHAT_ID in the environment that overrides the file is flagged after binding', async () => {
    const w = world({ env: { TG_CHAT_ID: '5' }, handlers: { getUpdates: () => ({ body: { ok: true, result: [startMsg(1, `/start ${NONCE}`)] } }) } });
    expect(await runAuth(cmd('login', '--token', TOKEN), w.deps)).toBe(0);
    expect(w.err.join('\n')).toMatch(/TG_CHAT_ID.*environment/);
  });

  test('the QR renderer, when present, receives the deep link', async () => {
    const w = world({ handlers: { getUpdates: () => ({ body: { ok: true, result: [startMsg(1, `/start ${NONCE}`)] } }) } });
    const seen: string[] = [];
    w.deps.renderQr = (s) => {
      seen.push(s);
      return '[QR]';
    };
    expect(await runAuth(cmd('login', '--token', TOKEN), w.deps)).toBe(0);
    expect(seen).toEqual([`https://t.me/my_bot?start=${NONCE}`]);
    expect(w.out).toContain('[QR]');
  });
});

describe('auto, status, logout', () => {
  const configured = { [ENV_PATH]: `TG_BOT_TOKEN=${TOKEN}\nTG_CHAT_ID=42\n` };

  test('bare `tg auth` on a connected config prints status and never re-binds', async () => {
    const w = world({ files: configured });
    expect(await runAuth(cmd(), w.deps)).toBe(0);
    expect(w.methods()).toEqual(['getMe', 'getChat']);
    expect(w.out.join('\n')).toContain('chat:   Alex (@alex) · private · id 42');
    expect(w.out.join('\n')).toContain('tg auth login');
  });

  test('status: full block, exit 0', async () => {
    const w = world({ files: configured });
    w.state.daemonPid = 4242;
    expect(await runAuth(cmd('status'), w.deps)).toBe(0);
    expect(w.out.join('\n')).toBe(
      ['bot:    @my_bot (My Bot) · id 123', 'chat:   Alex (@alex) · private · id 42', `config: ${ENV_PATH}`, 'daemon: running (pid 4242)'].join('\n'),
    );
  });

  test('status: nothing configured → exit 78 with the tg auth hint, no network', async () => {
    const w = world();
    expect(await runAuth(cmd('status'), w.deps)).toBe(78);
    expect(w.err.join('\n')).toContain('tg auth');
    expect(w.calls).toHaveLength(0);
  });

  test('status: token but no chat → exit 78, bot still shown', async () => {
    const w = world({ files: { [ENV_PATH]: `TG_BOT_TOKEN=${TOKEN}\n` } });
    expect(await runAuth(cmd('status'), w.deps)).toBe(78);
    expect(w.out.join('\n')).toContain('@my_bot');
    expect(w.out.join('\n')).toContain('not bound');
  });

  test('status: unreachable chat → exit 1', async () => {
    const w = world({ files: configured, handlers: { getChat: () => ({ status: 400, body: { ok: false, description: 'Bad Request: chat not found' } }) } });
    expect(await runAuth(cmd('status'), w.deps)).toBe(1);
    expect(w.out.join('\n')).toContain('unreachable: Bad Request: chat not found');
  });

  test('status: revoked token → exit 3', async () => {
    const w = world({ files: configured, handlers: { getMe: () => ({ status: 401, body: { ok: false, description: 'Unauthorized' } }) } });
    expect(await runAuth(cmd('status'), w.deps)).toBe(3);
  });

  test('logout --yes removes only the two keys', async () => {
    const w = world({ files: { [ENV_PATH]: `# c\nTG_BOT_TOKEN=${TOKEN}\nOTHER=1\nTG_CHAT_ID=42\n` } });
    expect(await runAuth(cmd('logout', '--yes'), w.deps)).toBe(0);
    expect(w.files.get(ENV_PATH)).toBe('# c\nOTHER=1\n');
  });

  test('logout without --yes and no terminal → exit 2, unchanged', async () => {
    const w = world({ files: configured });
    expect(await runAuth(cmd('logout'), w.deps)).toBe(2);
    expect(w.files.get(ENV_PATH)).toBe(configured[ENV_PATH]);
  });

  test('logout on a terminal: "n" keeps everything (exit 1), "y" removes', async () => {
    const no = world({ files: configured, tty: true, lines: ['n'] });
    expect(await runAuth(cmd('logout'), no.deps)).toBe(1);
    expect(no.files.get(ENV_PATH)).toBe(configured[ENV_PATH]);
    const yes = world({ files: configured, tty: true, lines: ['y'] });
    expect(await runAuth(cmd('logout'), yes.deps)).toBe(0);
    expect(yes.files.get(ENV_PATH)).toBe('');
  });

  test('logout with nothing configured is a no-op success', async () => {
    const w = world();
    expect(await runAuth(cmd('logout', '--yes'), w.deps)).toBe(0);
    expect(w.files.has(ENV_PATH)).toBe(false);
  });

  test('logout while the daemon runs names tg-ctl stop', async () => {
    const w = world({ files: configured });
    w.state.daemonPid = 7;
    expect(await runAuth(cmd('logout', '--yes'), w.deps)).toBe(0);
    expect(w.out.join('\n')).toContain('tg-ctl stop');
  });

  test('help prints usage, exit 0', async () => {
    const w = world();
    expect(await runAuth(cmd('--help'), w.deps)).toBe(0);
    expect(w.out.join('\n')).toContain('tg auth status');
  });
});

test('a stale bound pending file from an earlier run does not short-circuit a new login', async () => {
  const stale = serializePending(markAuthBound(waitingPending('A'.repeat(32), NOW - 1), ALEX, NOW - 1));
  const w = world({ files: { [PENDING_PATH]: stale }, handlers: { getUpdates: () => ({ body: { ok: true, result: [startMsg(1, `/start ${NONCE}`, { id: 8, type: 'private', first_name: 'Cy' })] } }) } });
  expect(await runAuth(cmd('login', '--token', TOKEN), w.deps)).toBe(0);
  expect(w.files.get(ENV_PATH)).toContain('TG_CHAT_ID=8');
});

describe('review fixes', () => {
  test('a second login while another one still waits for its tap is refused (exit 1), the first link stays valid', async () => {
    const live = serializePending(waitingPending('B'.repeat(32), NOW + 60_000));
    const w = world({ files: { [PENDING_PATH]: live } });
    expect(await runAuth(cmd('login', '--token', TOKEN), w.deps)).toBe(1);
    expect(w.files.get(PENDING_PATH)).toBe(live);
    expect(w.methods()).not.toContain('getUpdates');
    expect(w.err.join('\n')).toMatch(/already waiting/);
  });

  test('an expired waiting record from a killed login does not block a new one', async () => {
    const dead = serializePending(waitingPending('B'.repeat(32), NOW - 1));
    const w = world({ files: { [PENDING_PATH]: dead }, handlers: { getUpdates: () => ({ body: { ok: true, result: [startMsg(1, `/start ${NONCE}`)] } }) } });
    expect(await runAuth(cmd('login', '--token', TOKEN), w.deps)).toBe(0);
  });

  test('a daemon that saved the chat but never confirmed: the timeout says so instead of "nothing changed"', async () => {
    const w = world({ files: { [ENV_PATH]: `TG_BOT_TOKEN=${TOKEN}\nTG_CHAT_ID=1\n` } });
    w.state.daemonPid = 999;
    w.state.onSleep = () => w.files.set(ENV_PATH, `TG_BOT_TOKEN=${TOKEN}\nTG_CHAT_ID=77\n`);
    expect(await runAuth(cmd('login', '--timeout', '3'), w.deps)).toBe(4);
    const err = w.err.join('\n');
    expect(err).not.toContain('Nothing was changed');
    expect(err).toContain('TG_CHAT_ID=77');
    expect(err).toContain('tg auth status');
  });

  test('the environment-override warning names the key, never the token value', async () => {
    const w = world({ env: { TG_BOT_TOKEN: '555:envsecret' }, handlers: { getUpdates: () => ({ body: { ok: true, result: [startMsg(1, `/start ${NONCE}`)] } }) } });
    expect(await runAuth(cmd('login', '--token', TOKEN), w.deps)).toBe(0);
    const err = w.err.join('\n');
    expect(err).toMatch(/TG_BOT_TOKEN.*environment/);
    expect(err).not.toContain('envsecret');
  });
});

describe('review round 2', () => {
  test('the pending check-and-write runs under the lock: a lock held by a live writer counts as busy, nothing is touched', async () => {
    const winner = serializePending(waitingPending('C'.repeat(32), NOW + 60_000));
    const w = world({ files: { [PENDING_PATH]: winner } });
    const locks: string[] = [];
    w.deps.withLock = (lockPath) => {
      locks.push(lockPath);
      return undefined; // contended: another login is mid-claim
    };
    expect(await runAuth(cmd('login', '--token', TOKEN), w.deps)).toBe(1);
    expect(locks).toEqual([`${PENDING_PATH}.lock`]);
    expect(w.files.get(PENDING_PATH)).toBe(winner);
    expect(w.methods()).not.toContain('getUpdates');
  });

  test('a login that times out never deletes a record a newer login wrote meanwhile', async () => {
    const newer = serializePending(waitingPending('D'.repeat(32), NOW + 600_000));
    let n = 0;
    const w = world({
      handlers: {
        getUpdates: () => {
          n += 1;
          if (n === 1) w.files.set(PENDING_PATH, newer);
          w.state.t += 30_000;
          return { body: { ok: true, result: [] } };
        },
      },
    });
    expect(await runAuth(cmd('login', '--token', TOKEN, '--timeout', '40'), w.deps)).toBe(4);
    expect(w.files.get(PENDING_PATH)).toBe(newer);
  });

  test('`tg auth constructor` (an Object.prototype name) is prose, not a crash', () => {
    expect(parseAuthArgs(['auth', 'constructor', '--timeout', '5'])).toBeNull();
    expect(parseAuthArgs(['auth', 'toString'])).toBeNull();
  });

  test('after a daemon hand-off the .env it already wrote is not rewritten', async () => {
    const w = world({ files: { [ENV_PATH]: `TG_BOT_TOKEN=${TOKEN}\nTG_CHAT_ID=1\n` } });
    w.state.daemonPid = 999;
    let envWrites = 0;
    const write = w.deps.writeFileAtomic;
    w.deps.writeFileAtomic = (p, c) => {
      if (p === ENV_PATH) envWrites += 1;
      write(p, c);
    };
    w.state.onSleep = () => {
      const p = parsePending(w.files.get(PENDING_PATH) ?? null);
      if (p?.status === 'waiting') {
        w.files.set(ENV_PATH, `TG_BOT_TOKEN=${TOKEN}\nTG_CHAT_ID=77\n`);
        w.files.set(PENDING_PATH, serializePending(markAuthBound(p, { id: 77, type: 'private' }, w.state.t)));
      }
    };
    expect(await runAuth(cmd('login'), w.deps)).toBe(0);
    expect(envWrites).toBe(0);
  });
});

describe('review round 4', () => {
  test('Ctrl-C runs the same guarded release: our record goes, a newer login\'s record stays', async () => {
    const newer = serializePending(waitingPending('E'.repeat(32), NOW + 600_000));
    const seen: Array<string | undefined> = [];
    const w = world({
      handlers: {
        getUpdates: () => {
          for (const cleanup of w.interrupts) cleanup(); // SIGINT while ours is on disk
          seen.push(w.files.get(PENDING_PATH));
          w.files.set(PENDING_PATH, newer);
          for (const cleanup of w.interrupts) cleanup(); // SIGINT after a newer login took over
          seen.push(w.files.get(PENDING_PATH));
          return { status: 409, body: { ok: false, description: 'Conflict: terminated by other getUpdates request' } };
        },
      },
    });
    expect(await runAuth(cmd('login', '--token', TOKEN), w.deps)).toBe(5);
    expect(seen).toEqual([undefined, newer]);
    expect(w.interrupts.size).toBe(0); // unregistered once the login ended
  });
});
