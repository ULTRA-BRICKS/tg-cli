import { afterAll, expect, test } from 'bun:test';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { createConnection } from 'net';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, trackCfgDir, trackProc } from './helpers/daemon-lifecycle';
import { tempDir } from './helpers/test-temp';

// Full inbound-VOICE round-trip against a Bot-API fake (mirrors
// ctl-daemon-integration.test.ts). The Whisper + ffmpeg binaries are PATH shims
// (a fixture transcript, no real model needed); tmux is shimmed to report ONE
// pane that hosts a `claude` agent (ps shim agrees), so the transcribed text is
// actually INJECTED and we capture it from the tmux shim log — proving voice
// routes exactly like a typed message. A SECOND daemon run with no voice config
// proves the unconfigured note triggers the onboarding reply instead of a drop.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const nowSec = Math.floor(Date.now() / 1000);
const TRANSCRIPT = 'add a retry to the upload handler';
const CONFIRMATION_PREFIX = '🎤 Расшифровка: ';

type FakeVoiceUpdate = {
  update_id: number;
  message: {
    message_id: number;
    from: { id: number; first_name: string };
    chat: { id: number };
    date: number;
    voice: { file_id: string; duration: number; mime_type: string; file_size: number };
    reply_to_message?: {
      message_id: number;
      chat: { id: number };
      date: number;
      text: string;
    };
  };
};

type FakeCallbackUpdate = {
  update_id: number;
  callback_query: {
    id: string;
    from: { id: number; first_name: string };
    message: { message_id: number; chat: { id: number }; date: number };
    data: string;
  };
};

type FakeUpdate = FakeVoiceUpdate | FakeCallbackUpdate;

// A single voice note from the allowed sender.
const QUEUE_CONFIGURED: FakeUpdate[] = [
  {
    update_id: 200,
    message: {
      message_id: 10,
      from: { id: 1, first_name: 'Alex' },
      chat: { id: 1 },
      date: nowSec,
      voice: { file_id: 'voice-xyz', duration: 4, mime_type: 'audio/ogg', file_size: 4096 },
    },
  },
];

const QUEUE_REPLY_CONFIGURED: FakeUpdate[] = [
  {
    update_id: 300,
    message: {
      message_id: 11,
      from: { id: 1, first_name: 'Alex' },
      chat: { id: 1 },
      date: nowSec,
      voice: { file_id: 'voice-xyz', duration: 4, mime_type: 'audio/ogg', file_size: 4096 },
      reply_to_message: {
        message_id: 77,
        chat: { id: 1 },
        date: nowSec,
        text: 'Проверь деплой',
      },
    },
  },
];

function makeServer(queue: FakeUpdate[]) {
  const updates: FakeUpdate[] = [...queue];
  const state = {
    offsets: [] as number[],
    sent: [] as {
      chat_id: number;
      text: string;
      reply_to_message_id?: number;
      message_id?: number;
      reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    }[],
    reactions: [] as { chat_id: number; message_id: number; reaction: Array<{ type: string; emoji: string }> }[],
    fetchedFileId: null as string | null,
    fileDownloaded: false,
    serveCount: 0,
    // When set, the queue is withheld until the test flips it true. Lets a test
    // configure the daemon BEFORE the (at-most-once) note is ever delivered.
    releaseQueue: true,
    // When set, getFile returns a non-JSON body so the daemon's `.json()` throws.
    brokenGetFile: false,
    nextMessageId: 1,
    pushCallback(updateId: number, data: string, messageId: number): void {
      updates.push({
        update_id: updateId,
        callback_query: {
          id: `cb${updateId}`,
          from: { id: 1, first_name: 'Alex' },
          message: { message_id: messageId, chat: { id: 1 }, date: nowSec },
          data,
        },
      });
    },
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        const offset = Number(url.searchParams.get('offset') ?? '0');
        state.offsets.push(offset);
        const pending = state.releaseQueue ? updates.filter((u) => u.update_id >= offset) : [];
        if (pending.length) {
          state.serveCount += 1;
          return Response.json({ ok: true, result: pending });
        }
        await Bun.sleep(1200);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = (await req.json()) as {
          chat_id: number;
          text: string;
          reply_to_message_id?: number;
          reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
        };
        const messageId = state.nextMessageId++;
        state.sent.push({ ...body, message_id: messageId });
        return Response.json({ ok: true, result: { message_id: messageId } });
      }
      if (url.pathname.endsWith('/setMessageReaction')) {
        state.reactions.push(
          (await req.json()) as { chat_id: number; message_id: number; reaction: Array<{ type: string; emoji: string }> },
        );
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/answerCallbackQuery') || url.pathname.endsWith('/editMessageText')) {
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/getFile')) {
        state.fetchedFileId = url.searchParams.get('file_id');
        // brokenGetFile: a non-JSON body so the daemon's `.json()` THROWS — the
        // download helper must catch it (not lose the note + crash the loop).
        if (state.brokenGetFile) return new Response('<html>502 bad gateway</html>');
        return Response.json({ ok: true, result: { file_path: 'voice/file_0.oga' } });
      }
      if (url.pathname.startsWith('/file/bot')) {
        state.fileDownloaded = true;
        return new Response('OGGOPUSBYTES');
      }
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  return { server, state };
}

// Build a config dir with shimmed ffmpeg + whisper-cli + tmux + ps. The whisper
// shim ignores its args and prints the fixture transcript with whisper-style
// noise to prove cleaning; ffmpeg just `touch`es the output wav (the daemon
// checks it exists). tmux/ps shims describe ONE claude-hosting pane.
// voiceMode: 'configured' (enabled + paths), 'disabled' (paths but
// enabled:false — the master opt-out), 'absent' (no voice block at all),
// 'stale-faster' (enabled faster-whisper whose CT2 model dir does not exist).
function makeCfgDir(opts: {
  voiceMode: 'configured' | 'disabled' | 'absent' | 'stale-faster';
  withFfmpeg?: boolean;
  slowMs?: number;
  transcript?: string;
}): {
  cfgDir: string;
  shimDir: string;
  tmuxLog: string;
  whisperBin: string;
  modelPath: string;
} {
  const withFfmpeg = opts.withFfmpeg ?? true;
  const cfgDir = tempDir('tgctl-voice-');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');

  const shimDir = join(cfgDir, 'bin');
  mkdirSync(shimDir);

  // ffmpeg: parse `-i <in>` ... `<out>` (out is the last argv) and create it.
  // Omitted in the missing-ffmpeg test (the daemon runs with an isolated PATH
  // so the real ffmpeg is invisible — Bun.spawnSync throws ENOENT, which the
  // fix must catch into a failure reply rather than a lost note).
  if (withFfmpeg) {
    writeFileSync(
      join(shimDir, 'ffmpeg'),
      [
        '#!/bin/sh',
        'out=""',
        'for a in "$@"; do out="$a"; done', // last arg = output wav
        ': > "$out"',
        'exit 0',
      ].join('\n'),
      { mode: 0o755 },
    );
  }

  // whisper-cli: print the fixture transcript wrapped in whisper-style noise so
  // cleanTranscript has something to strip. Args ignored. slowMs simulates a
  // long transcription so the test can prove the daemon stays responsive (the
  // event loop must keep servicing other messages while whisper runs).
  const whisperBin = join(shimDir, 'whisper-cli');
  const sleepLine = opts.slowMs ? `sleep ${(opts.slowMs / 1000).toFixed(2)}\n` : '';
  const transcript = opts.transcript ?? TRANSCRIPT;
  writeFileSync(whisperBin, `#!/bin/sh\n${sleepLine}printf '[BLANK_AUDIO]\\n  ${transcript}  \\n'\nexit 0\n`, {
    mode: 0o755,
  });

  // A throwaway "model" file so voiceReady's existsSync passes.
  const modelPath = join(cfgDir, 'ggml-large-v3.bin');
  writeFileSync(modelPath, 'FAKEMODEL');

  // tmux shim: list-panes → one pane (pid 4242, claude); send-keys/load-buffer/
  // paste-buffer → log argv; everything else exits 0.
  const tmuxLog = join(cfgDir, 'tmux-calls.log');
  writeFileSync(
    join(shimDir, 'tmux'),
    [
      '#!/bin/sh',
      `echo "$@" >> '${tmuxLog}'`,
      'case "$1" in',
      '  list-panes)',
      // session\twindow\tpane\tpid\tcommand\twindow_name\tpath
      `    printf 'work\\t0\\t%%1\\t4242\\t2.1.150\\twork\\t/tmp/proj\\n' ;;`,
      '  load-buffer)',
      `    cat >> '${tmuxLog}' ;;`,
      '  *) : ;;',
      'esac',
      'exit 0',
    ].join('\n'),
    { mode: 0o755 },
  );

  // ps shim: report the claude process as pane_pid 4242 so findAgentInPane
  // matches. Format: `pid ppid command`.
  writeFileSync(join(shimDir, 'ps'), ['#!/bin/sh', "printf '4242 1 claude\\n'", 'exit 0'].join('\n'), { mode: 0o755 });

  const block = (enabled: boolean): string =>
    [
      'voice:',
      `  enabled: ${enabled ? 'true' : 'false'}`,
      '  runner: whisper.cpp',
      `  bin_path: "${whisperBin}"`,
      `  model_path: "${modelPath}"`,
      '  language: auto',
      '',
    ].join('\n');
  // faster-whisper pointed at a CT2 model DIRECTORY that does not exist on disk.
  const staleFasterBlock = [
    'voice:',
    '  enabled: true',
    '  runner: faster-whisper',
    `  bin_path: "${whisperBin}"`, // any existing executable; voiceReady checks bin existence
    `  model_path: "${join(cfgDir, 'ct2-model-GONE')}"`, // a path (has a slash) that does NOT exist
    '  language: auto',
    '',
  ].join('\n');
  const voiceBlock =
    opts.voiceMode === 'configured'
      ? block(true)
      : opts.voiceMode === 'disabled'
        ? block(false)
        : opts.voiceMode === 'stale-faster'
          ? staleFasterBlock
          : '';
  writeFileSync(join(cfgDir, 'config.yaml'), `control:\n  enabled: true\n${voiceBlock}`);

  return { cfgDir, shimDir, tmuxLog, whisperBin, modelPath };
}

const reg = createDaemonRegistry();
const servers: { stop: (force?: boolean) => void }[] = [];

afterAll(async () => {
  await reapDaemons(reg);
  for (const s of servers) s.stop(true);
});

async function runDaemon(
  cfgDir: string,
  shimDir: string,
  apiBase: string,
  opts: { isolatePath?: boolean } = {},
): Promise<Subprocess> {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  // Default: shimDir FIRST so the fake tmux/ps/ffmpeg/whisper win over the real
  // ones. isolatePath: ONLY shimDir, so a binary not shimmed (ffmpeg in the
  // missing-ffmpeg test) is genuinely absent and the spawn throws ENOENT.
  const PATH = opts.isolatePath ? shimDir : `${shimDir}:${process.env.PATH ?? ''}`;
  const daemon = Bun.spawn([process.execPath, TG_CTL, 'run'], {
    env: { PATH, HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: apiBase },
    stdio: ['ignore', logFd, logFd],
  });
  // Track immediately (before the caller's first assertion) + record the temp
  // cfgDir for the scoped backstop sweep.
  trackProc(reg, daemon);
  trackCfgDir(reg, cfgDir);
  closeSync(logFd);
  return daemon;
}

async function waitFor(predicate: () => boolean, timeoutMs = 12_000, intervalMs = 100): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (predicate()) return;
    await Bun.sleep(intervalMs);
  }
  expect(predicate()).toBe(true);
}

function tmuxText(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function hasReaction(
  reactions: Array<{ message_id: number; reaction: Array<{ emoji: string }> }>,
  messageId: number,
  emoji: string,
): boolean {
  return reactions.some((r) => r.message_id === messageId && r.reaction[0]?.emoji === emoji);
}

function startAsk(cfgDir: string, shimDir: string, apiBase: string): Subprocess {
  const ask = Bun.spawn([process.execPath, TG_CTL, 'ask'], {
    env: {
      PATH: `${shimDir}:${process.env.PATH ?? ''}`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: apiBase,
      TMUX_PANE: '%1',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  trackProc(reg, ask);
  ask.stdin.write(JSON.stringify({
    requestId: 'voice_defer_block',
    agent: 'claude',
    kind: 'question',
    paneId: '%1',
    cwd: '/tmp/proj',
    question: 'Proceed?',
    options: [{ label: 'Yes' }],
  }) + '\n');
  ask.stdin.end();
  return ask;
}

test('configured voice note → downloaded, transcribed, transcript injected into the agent pane', async () => {
  const { server, state } = makeServer(QUEUE_CONFIGURED);
  servers.push(server);
  const { cfgDir, shimDir, tmuxLog } = makeCfgDir({ voiceMode: 'configured' });
  const daemon = await runDaemon(cfgDir, shimDir, `http://127.0.0.1:${server.port}`);

  const t0 = Date.now();
  while (Date.now() - t0 < 12_000) {
    if (state.offsets.includes(201)) break;
    await Bun.sleep(100);
  }

  // The voice file was resolved + downloaded.
  expect(state.fetchedFileId).toBe('voice-xyz');
  expect(state.fileDownloaded).toBe(true);

  // The OGG was saved under the daemon-chosen name <update_id>.ogg.
  const saved = join(cfgDir, '.cache', 'tg-cli', 'inbound', '200.ogg');
  expect(readFileSync(saved, 'utf8')).toBe('OGGOPUSBYTES');

  // The CLEANED transcript (noise stripped, trimmed) was injected into the agent pane
  // as a 🎤-marked quote — proving voice routes like typed text but is visibly tagged
  // as transcribed speech.
  const tmuxCalls = readFileSync(tmuxLog, 'utf8');
  expect(tmuxCalls).toContain('list-panes'); // discovery ran through the shim
  // The wrap carries the inbound message_id as `tg#10` (the message-ref
  // convention, tg#28) so the agent can answer with `tg --reply-to 10`
  // (threaded replies) and quote the ref back without colliding with a #N PR.
  expect(tmuxCalls).toContain(`[TG from Alex tg#10] 🎤 «${TRANSCRIPT}»`);
  // The whisper noise marker must NOT survive into the injected text.
  expect(tmuxCalls).not.toContain('BLANK_AUDIO');

  // No error reply was sent (the inject succeeded).
  expect(state.sent.some((m) => /failed|no agent|not set up/i.test(m.text))).toBe(false);
  expect(state.sent).toContainEqual(expect.objectContaining({
    chat_id: 1,
    text: `${CONFIRMATION_PREFIX}${TRANSCRIPT}`,
    reply_to_message_id: 10,
  }));
  expect(state.reactions).toContainEqual({
    chat_id: 1,
    message_id: 10,
    reaction: [{ type: 'emoji', emoji: '👀' }],
  });

  daemon.kill('SIGTERM');
  await Promise.race([daemon.exited, Bun.sleep(4000)]);
}, 20_000);

test('configured voice reply confirms transcript and marks both the voice and replied-to messages', async () => {
  const { server, state } = makeServer(QUEUE_REPLY_CONFIGURED);
  servers.push(server);
  const { cfgDir, shimDir, tmuxLog } = makeCfgDir({ voiceMode: 'configured' });
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.routes.json'),
    JSON.stringify([{ id: 77, paneId: '%1', cwd: '/tmp/proj', ts: nowSec }]),
  );
  const daemon = await runDaemon(cfgDir, shimDir, `http://127.0.0.1:${server.port}`);

  const t0 = Date.now();
  while (Date.now() - t0 < 12_000) {
    if (state.offsets.includes(301)) break;
    await Bun.sleep(100);
  }

  const tmuxCalls = readFileSync(tmuxLog, 'utf8');
  expect(tmuxCalls).toContain('↩ tg#77 ');
  expect(tmuxCalls).toContain(`[TG from Alex tg#11] 🎤 «${TRANSCRIPT}»`);
  expect(state.sent).toContainEqual(expect.objectContaining({
    chat_id: 1,
    text: `${CONFIRMATION_PREFIX}${TRANSCRIPT}`,
    reply_to_message_id: 11,
  }));
  expect(state.reactions).toContainEqual({
    chat_id: 1,
    message_id: 11,
    reaction: [{ type: 'emoji', emoji: '👀' }],
  });
  expect(state.reactions).toContainEqual({
    chat_id: 1,
    message_id: 77,
    reaction: [{ type: 'emoji', emoji: '👀' }],
  });

  daemon.kill('SIGTERM');
  await Promise.race([daemon.exited, Bun.sleep(4000)]);
}, 20_000);

test('configured voice reply through picker marks the replied-to message only after the picker delivers', async () => {
  const { server, state } = makeServer(QUEUE_REPLY_CONFIGURED);
  servers.push(server);
  const { cfgDir, shimDir, tmuxLog } = makeCfgDir({ voiceMode: 'configured' });
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.routes.json'),
    JSON.stringify([{ id: 77, paneId: '%gone', cwd: '/tmp/gone', ts: nowSec }]),
  );
  const daemon = await runDaemon(cfgDir, shimDir, `http://127.0.0.1:${server.port}`);

  // The daemon sends the transcript confirmation, the picker and the ✍️ "waiting for a target"
  // mark as separate requests; wait until all three arrived.
  await waitFor(
    () =>
      state.sent.some((m) => m.reply_markup) &&
      state.sent.some((m) => m.reply_to_message_id === 11 && m.text === `${CONFIRMATION_PREFIX}${TRANSCRIPT}`) &&
      hasReaction(state.reactions, 11, '✍️'),
  );

  const picker = state.sent.find((m) => m.reply_markup);
  expect(picker).toBeDefined();
  expect(state.sent).toContainEqual(expect.objectContaining({
    chat_id: 1,
    text: `${CONFIRMATION_PREFIX}${TRANSCRIPT}`,
    reply_to_message_id: 11,
  }));
  expect(state.reactions.filter((r) => r.message_id === 77)).toHaveLength(0);
  expect(state.reactions).toContainEqual({
    chat_id: 1,
    message_id: 11,
    reaction: [{ type: 'emoji', emoji: '✍️' }],
  });

  const button = picker!.reply_markup!.inline_keyboard.flat()[0]!;
  state.pushCallback(301, button.callback_data, picker!.message_id!);

  const t1 = Date.now();
  while (Date.now() - t1 < 12_000) {
    const delivered = readFileSync(tmuxLog, 'utf8').includes(`[TG from Alex tg#11] 🎤 «${TRANSCRIPT}»`);
    const voiceSeen = state.reactions.some((r) => r.message_id === 11 && r.reaction[0]?.emoji === '👀');
    const replySeen = state.reactions.some((r) => r.message_id === 77 && r.reaction[0]?.emoji === '👀');
    if (delivered && voiceSeen && replySeen) break;
    await Bun.sleep(100);
  }

  expect(readFileSync(tmuxLog, 'utf8')).toContain(`[TG from Alex tg#11] 🎤 «${TRANSCRIPT}»`);
  expect(state.reactions).toContainEqual({
    chat_id: 1,
    message_id: 11,
    reaction: [{ type: 'emoji', emoji: '👀' }],
  });
  expect(state.reactions).toContainEqual({
    chat_id: 1,
    message_id: 77,
    reaction: [{ type: 'emoji', emoji: '👀' }],
  });

  daemon.kill('SIGTERM');
  await Promise.race([daemon.exited, Bun.sleep(4000)]);
}, 20_000);

test('configured voice reply through picker preserves replied-to reaction across deferred delivery', async () => {
  const { server, state } = makeServer(QUEUE_REPLY_CONFIGURED);
  servers.push(server);
  state.releaseQueue = false;
  const { cfgDir, shimDir, tmuxLog } = makeCfgDir({ voiceMode: 'configured' });
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.registration.json'),
    JSON.stringify({ paneId: '%1', cwd: '/tmp/proj' }),
  );
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.routes.json'),
    JSON.stringify([{ id: 77, paneId: '%gone', cwd: '/tmp/gone', ts: nowSec }]),
  );
  const daemon = await runDaemon(cfgDir, shimDir, `http://127.0.0.1:${server.port}`);
  await waitFor(() => existsSync(join(cfgDir, 'tg-ctl.123.sock')), 5_000, 50);

  const ask = startAsk(cfgDir, shimDir, `http://127.0.0.1:${server.port}`);
  await waitFor(() => state.sent.some((m) => m.reply_markup), 5_000, 50);
  const question = state.sent.find((m) => m.reply_markup)!;
  const questionButton = question.reply_markup!.inline_keyboard.flat()[0]!;

  state.releaseQueue = true;
  await waitFor(() => state.sent.filter((m) => m.reply_markup).length >= 2);
  const picker = state.sent.find((m) => m.reply_markup && m.message_id !== question.message_id)!;
  const pickerButton = picker.reply_markup!.inline_keyboard.flat()[0]!;

  state.pushCallback(301, pickerButton.callback_data, picker.message_id!);
  await waitFor(() => hasReaction(state.reactions, 11, '✍️'), 8_000, 50);

  expect(tmuxText(tmuxLog)).not.toContain(`[TG from Alex tg#11] 🎤 «${TRANSCRIPT}»`);
  expect(state.reactions.filter((r) => r.message_id === 77)).toHaveLength(0);

  state.pushCallback(302, questionButton.callback_data, question.message_id!);
  const askOut = await new Response(ask.stdout).text();
  await ask.exited;
  expect(askOut.length).toBeGreaterThan(0);

  await waitFor(
    () =>
      tmuxText(tmuxLog).includes(`[TG from Alex tg#11] 🎤 «${TRANSCRIPT}»`) &&
      hasReaction(state.reactions, 11, '👀') &&
      hasReaction(state.reactions, 77, '👀'),
    12_000,
    50,
  );

  expect(state.reactions).toContainEqual({
    chat_id: 1,
    message_id: 11,
    reaction: [{ type: 'emoji', emoji: '👀' }],
  });
  expect(state.reactions).toContainEqual({
    chat_id: 1,
    message_id: 77,
    reaction: [{ type: 'emoji', emoji: '👀' }],
  });

  daemon.kill('SIGTERM');
  await Promise.race([daemon.exited, Bun.sleep(4000)]);
}, 25_000);

test('voice transcript confirmation is capped to one Telegram message', async () => {
  const longTranscript = '🫧'.repeat(2300);
  const { server, state } = makeServer(QUEUE_CONFIGURED);
  servers.push(server);
  const { cfgDir, shimDir } = makeCfgDir({ voiceMode: 'configured', transcript: longTranscript });
  const daemon = await runDaemon(cfgDir, shimDir, `http://127.0.0.1:${server.port}`);

  const t0 = Date.now();
  while (Date.now() - t0 < 12_000) {
    if (state.sent.some((m) => m.reply_to_message_id === 10)) break;
    await Bun.sleep(100);
  }

  const confirmation = state.sent.find((m) => m.reply_to_message_id === 10);
  expect(confirmation).toBeDefined();
  expect(confirmation!.text.length).toBeLessThanOrEqual(4096);
  expect(confirmation!.text).toStartWith(CONFIRMATION_PREFIX);
  expect(confirmation!.text).toContain('🫧');
  expect(confirmation!.text).toContain('полный текст не обрезается перед маршрутизацией');

  daemon.kill('SIGTERM');
  await Promise.race([daemon.exited, Bun.sleep(4000)]);
}, 20_000);

test('unconfigured voice note → onboarding reply, never silently dropped', async () => {
  const { server, state } = makeServer(QUEUE_CONFIGURED);
  servers.push(server);
  const { cfgDir, shimDir } = makeCfgDir({ voiceMode: 'absent' });
  const daemon = await runDaemon(cfgDir, shimDir, `http://127.0.0.1:${server.port}`);

  const t0 = Date.now();
  while (Date.now() - t0 < 12_000) {
    if (state.sent.length >= 1 && state.offsets.includes(201)) break;
    await Bun.sleep(100);
  }

  // A guided onboarding message was sent back to the user (🎙️ marker), and the
  // voice file was NOT downloaded (we short-circuit before getFile).
  const onboarding = state.sent.find((m) => m.text.includes('🎙️'));
  expect(onboarding).toBeDefined();
  expect(state.fetchedFileId).toBeNull();

  daemon.kill('SIGTERM');
  await Promise.race([daemon.exited, Bun.sleep(4000)]);
}, 20_000);

test('configured voice but ffmpeg MISSING → failure reply, daemon survives, offset advances', async () => {
  const { server, state } = makeServer(QUEUE_CONFIGURED);
  servers.push(server);
  // configured=true (whisper-cli + model present), withFfmpeg=false, and an
  // ISOLATED PATH so the real ffmpeg is invisible → spawn throws ENOENT, which
  // the fix must catch into a "transcription failed" reply (not a lost note +
  // dead daemon).
  const { cfgDir, shimDir } = makeCfgDir({ voiceMode: 'configured', withFfmpeg: false });
  const daemon = await runDaemon(cfgDir, shimDir, `http://127.0.0.1:${server.port}`, { isolatePath: true });

  const t0 = Date.now();
  while (Date.now() - t0 < 12_000) {
    if (state.sent.length >= 1 && state.offsets.includes(201)) break;
    await Bun.sleep(100);
  }

  // The note reached transcription (download happened), then ffmpeg failed → a
  // failure reply went back instead of the note vanishing.
  expect(state.fetchedFileId).toBe('voice-xyz');
  expect(state.sent.some((m) => /transcription failed/i.test(m.text))).toBe(true);
  // The daemon survived the missing-binary spawn (offset advanced past it).
  expect(state.offsets).toContain(201);
  expect(daemon.exitCode).toBeNull(); // still running, not crashed

  daemon.kill('SIGTERM');
  await Promise.race([daemon.exited, Bun.sleep(4000)]);
}, 20_000);

test('voice.enabled: false → note dropped silently (no transcribe, no onboarding reply)', async () => {
  const { server, state } = makeServer(QUEUE_CONFIGURED);
  servers.push(server);
  // A discoverable Whisper IS present (paths set), but the user opted out.
  const { cfgDir, shimDir, tmuxLog } = makeCfgDir({ voiceMode: 'disabled' });
  const daemon = await runDaemon(cfgDir, shimDir, `http://127.0.0.1:${server.port}`);

  const t0 = Date.now();
  while (Date.now() - t0 < 12_000) {
    if (state.offsets.includes(201)) break;
    await Bun.sleep(100);
  }
  await Bun.sleep(400); // let any (wrong) reply/inject surface

  // The master switch held: nothing downloaded, nothing transcribed/injected,
  // and NO onboarding reply (that would re-prompt a user who opted out).
  expect(state.fetchedFileId).toBeNull();
  expect(state.sent).toHaveLength(0);
  expect(readFileSync(tmuxLog, 'utf8')).not.toContain('send-keys');

  daemon.kill('SIGTERM');
  await Promise.race([daemon.exited, Bun.sleep(4000)]);
}, 20_000);

test('voice config written AFTER the daemon started is reloaded per note (no restart needed)', async () => {
  const { server, state } = makeServer(QUEUE_CONFIGURED);
  servers.push(server);
  // Boot the daemon with NO voice block and the note WITHHELD; write the
  // configured block while it is up, then release the note. The reload-per-note
  // logic must pick up the mid-run config without a restart.
  state.releaseQueue = false;
  const { cfgDir, shimDir, tmuxLog, whisperBin, modelPath } = makeCfgDir({ voiceMode: 'absent' });
  const daemon = await runDaemon(cfgDir, shimDir, `http://127.0.0.1:${server.port}`);

  // Configure only once the daemon is polling with the empty config: the note must find it
  // already running, so only the per-note reload can pick the voice block up.
  await waitFor(() => state.offsets.length > 0);
  writeFileSync(
    join(cfgDir, 'config.yaml'),
    [
      'control:',
      '  enabled: true',
      'voice:',
      '  enabled: true',
      '  runner: whisper.cpp',
      `  bin_path: "${whisperBin}"`,
      `  model_path: "${modelPath}"`,
      '  language: auto',
      '',
    ].join('\n'),
  );
  state.releaseQueue = true;

  const t0 = Date.now();
  while (Date.now() - t0 < 12_000) {
    if (readFileSync(tmuxLog, 'utf8').includes(TRANSCRIPT)) break;
    await Bun.sleep(150);
  }

  // The transcript was injected even though the daemon booted unconfigured —
  // proving the per-note config reload picked up the mid-run `tg voice setup`.
  expect(readFileSync(tmuxLog, 'utf8')).toContain(`[TG from Alex tg#10] 🎤 «${TRANSCRIPT}»`);
  expect(state.fetchedFileId).toBe('voice-xyz');

  daemon.kill('SIGTERM');
  await Promise.race([daemon.exited, Bun.sleep(4000)]);
}, 20_000);

test('configured voice but getFile returns garbage → failure reply, daemon survives, no lost note', async () => {
  const { server, state } = makeServer(QUEUE_CONFIGURED);
  servers.push(server);
  state.brokenGetFile = true; // non-JSON body → `.json()` throws inside the helper
  const { cfgDir, shimDir } = makeCfgDir({ voiceMode: 'configured' });
  const daemon = await runDaemon(cfgDir, shimDir, `http://127.0.0.1:${server.port}`);

  const t0 = Date.now();
  while (Date.now() - t0 < 12_000) {
    if (state.sent.length >= 1 && state.offsets.includes(201)) break;
    await Bun.sleep(100);
  }

  // The throw was caught → a "media download failed" reply went back, the offset
  // advanced, and the daemon is still alive (the bug would crash the poll loop
  // body and lose the note with no reply).
  expect(state.fetchedFileId).toBe('voice-xyz');
  expect(state.sent.some((m) => /download failed/i.test(m.text))).toBe(true);
  expect(state.offsets).toContain(201);
  expect(daemon.exitCode).toBeNull();

  daemon.kill('SIGTERM');
  await Promise.race([daemon.exited, Bun.sleep(4000)]);
}, 20_000);

test('faster-whisper with a missing CT2 model dir → onboarding, note NOT downloaded', async () => {
  const { server, state } = makeServer(QUEUE_CONFIGURED);
  servers.push(server);
  // enabled faster-whisper, but model_path is a directory path that does not
  // exist → voiceReady must fail the artifact gate and fall back to onboarding
  // instead of downloading and failing deep inside Python.
  const { cfgDir, shimDir } = makeCfgDir({ voiceMode: 'stale-faster' });
  const daemon = await runDaemon(cfgDir, shimDir, `http://127.0.0.1:${server.port}`);

  const t0 = Date.now();
  while (Date.now() - t0 < 12_000) {
    if (state.sent.length >= 1 && state.offsets.includes(201)) break;
    await Bun.sleep(100);
  }

  // Onboarding reply (🎙️) and NO download — the stale model never reaches Python.
  expect(state.sent.some((m) => m.text.includes('🎙️'))).toBe(true);
  expect(state.fetchedFileId).toBeNull();

  daemon.kill('SIGTERM');
  await Promise.race([daemon.exited, Bun.sleep(4000)]);
}, 20_000);

test('daemon stays responsive (socket accepts) DURING a slow transcription — async spawn frees the event loop', async () => {
  const { server, state } = makeServer(QUEUE_CONFIGURED);
  servers.push(server);
  // A 3s whisper. With the old blocking spawnSync the daemon's event loop would
  // be frozen for those 3s and the Unix control socket could not accept a
  // connection; with async Bun.spawn the socket server keeps servicing.
  const { cfgDir, shimDir, tmuxLog } = makeCfgDir({ voiceMode: 'configured', slowMs: 3000 });
  const daemon = await runDaemon(cfgDir, shimDir, `http://127.0.0.1:${server.port}`);
  const sockPath = join(cfgDir, 'tg-ctl.123.sock');

  // Wait until transcription has STARTED: the OGG was downloaded (getFile fired)
  // but the transcript is not yet injected (whisper still sleeping).
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    if (state.fetchedFileId === 'voice-xyz' && !readFileSync(tmuxLog, 'utf8').includes(TRANSCRIPT)) break;
    await Bun.sleep(50);
  }
  expect(state.fetchedFileId).toBe('voice-xyz'); // transcription is in flight

  // While whisper sleeps, the daemon's control socket must still ACCEPT — proof
  // the event loop is not blocked. (We don't speak the protocol; a clean connect
  // is enough.) Retry briefly in case the socket file is mid-creation.
  const connected = await new Promise<boolean>((resolve) => {
    const tryConnect = (attemptsLeft: number): void => {
      if (!existsSync(sockPath)) {
        if (attemptsLeft <= 0) return resolve(false);
        setTimeout(() => tryConnect(attemptsLeft - 1), 100);
        return;
      }
      const c = createConnection(sockPath);
      const onDone = (ok: boolean): void => {
        c.destroy();
        resolve(ok);
      };
      c.once('connect', () => onDone(true));
      c.once('error', () => {
        if (attemptsLeft <= 0) return onDone(false);
        setTimeout(() => tryConnect(attemptsLeft - 1), 100);
      });
      c.setTimeout(1500, () => onDone(false));
    };
    tryConnect(15); // ~1.5s of retries, all WITHIN the 3s whisper sleep
  });
  expect(connected).toBe(true);

  // And the transcription still completes correctly afterwards.
  const t1 = Date.now();
  while (Date.now() - t1 < 8000) {
    if (readFileSync(tmuxLog, 'utf8').includes(TRANSCRIPT)) break;
    await Bun.sleep(100);
  }
  expect(readFileSync(tmuxLog, 'utf8')).toContain(`[TG from Alex tg#10] 🎤 «${TRANSCRIPT}»`);

  daemon.kill('SIGTERM');
  await Promise.race([daemon.exited, Bun.sleep(4000)]);
}, 25_000);

// --- `tg-ctl voice-setup` CLI exit codes (no Bot API, no daemon) ---

// Build a HOME with a fake whisper.cpp install (executable + a real-looking
// ggml model) so decideOnboarding returns 'ready'. The config dir + ffmpeg on
// PATH are caller-controlled.
function fakeWhisperHome(): { home: string; binDir: string } {
  const home = tempDir('tgctl-vsetup-');
  const wc = join(home, 'xp', 'whisper.cpp');
  mkdirSync(join(wc, 'build', 'bin'), { recursive: true });
  mkdirSync(join(wc, 'models'), { recursive: true });
  writeFileSync(join(wc, 'build', 'bin', 'whisper-cli'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(wc, 'models', 'ggml-large-v3.bin'), 'FAKE');
  // a PATH dir carrying a fake ffmpeg so decideOnboarding sees ffmpegFound.
  const binDir = join(home, 'bin');
  mkdirSync(binDir);
  writeFileSync(join(binDir, 'ffmpeg'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { home, binDir };
}

async function runVoiceSetupCli(home: string, binDir: string, configDir: string): Promise<number> {
  const proc = Bun.spawn([process.execPath, TG_CTL, 'voice-setup'], {
    env: { PATH: `${binDir}:${process.env.PATH ?? ''}`, HOME: home, TG_CTL_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await proc.exited;
  return proc.exitCode ?? 1;
}

test('tg-ctl voice-setup exits 0 when a Whisper is found and config persists', async () => {
  const { home, binDir } = fakeWhisperHome();
  const configDir = join(home, '.config', 'tg-cli');
  const code = await runVoiceSetupCli(home, binDir, configDir);
  expect(code).toBe(0);
  expect(readFileSync(join(configDir, 'config.yaml'), 'utf8')).toContain('runner: whisper.cpp');
}, 15_000);

test('tg-ctl voice-setup exits NON-ZERO when a ready install cannot be persisted', async () => {
  const { home, binDir } = fakeWhisperHome();
  // A read-only config dir → the write fails → setup must NOT report success.
  const configDir = join(home, '.config', 'tg-cli');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.yaml'), 'control:\n  enabled: true\n');
  chmodSync(join(configDir, 'config.yaml'), 0o444); // read-only file
  chmodSync(configDir, 0o555); // read-only dir (no create/replace)
  try {
    const code = await runVoiceSetupCli(home, binDir, configDir);
    expect(code).not.toBe(0);
  } finally {
    chmodSync(configDir, 0o755); // restore so afterAll/tmp cleanup works
  }
}, 15_000);

// --- `tg-ctl voice-setup`: keep, plan, install (tg-cli#711) ---

// Only the test's shims plus the system dirs (`which`, `sh`, `cp`, `mkdir`): no Homebrew, uv or
// whisper-cli from the developer's machine reaches the probe.
const systemPath = (binDir: string): string => `${binDir}:/usr/bin:/bin`;

async function runSetup(
  home: string,
  path: string,
  configDir: string,
  args: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, TG_CTL, 'voice-setup', ...args], {
    env: { PATH: path, HOME: home, TG_CTL_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { code: proc.exitCode ?? 1, stdout, stderr };
}

// A HOME with no Whisper and a PATH dir holding a fake ffmpeg and a fake `uv`. The fake uv
// logs its argv; `uv venv <dir>` creates <dir>/bin/python, a shim that imports anything and,
// asked to download a model, writes the CT2 files into <output_dir>. `uvExit` ≠ 0 makes uv fail.
function bareHome(uvExit = 0): { home: string; binDir: string; uvLog: string } {
  const home = tempDir('tgctl-vinstall-');
  const binDir = join(home, 'bin');
  mkdirSync(binDir);
  writeFileSync(join(binDir, 'ffmpeg'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const fakePython = join(binDir, 'fake-python');
  writeFileSync(
    fakePython,
    '#!/bin/sh\ncase "$*" in *download_model*) for a; do last=$a; done; mkdir -p "$last"; for f in model.bin config.json tokenizer.json vocabulary.json; do : > "$last/$f"; done;; esac\nexit 0\n',
    { mode: 0o755 },
  );
  const uvLog = join(home, 'uv.log');
  writeFileSync(
    join(binDir, 'uv'),
    [
      '#!/bin/sh',
      `echo "$*" >> '${uvLog}'`,
      `[ ${uvExit} -ne 0 ] && exit ${uvExit}`,
      `if [ "$1" = venv ]; then for a; do last=$a; done; mkdir -p "$last/bin"; cp '${fakePython}' "$last/bin/python"; fi`,
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { home, binDir, uvLog };
}

test('tg-ctl voice-setup keeps a configured runner whose files exist, even with another Whisper discoverable', async () => {
  const { home, binDir } = fakeWhisperHome(); // a whisper.cpp in ~/xp the probe would pick
  const python = join(home, 'custom', '.venv', 'bin', 'python');
  const model = join(home, 'custom', 'models', 'my-turbo');
  mkdirSync(join(home, 'custom', '.venv', 'bin'), { recursive: true });
  mkdirSync(model, { recursive: true });
  for (const f of ['model.bin', 'config.json', 'tokenizer.json', 'vocabulary.json']) writeFileSync(join(model, f), 'FAKE');
  writeFileSync(python, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const configDir = join(home, '.config', 'tg-cli');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'config.yaml'),
    `voice:\n  enabled: false\n  runner: faster-whisper\n  bin_path: "${python}"\n  model_path: "${model}"\n  language: auto\n  threads: 6\n`,
  );
  const { code } = await runSetup(home, systemPath(binDir), configDir);
  expect(code).toBe(0);
  const yaml = readFileSync(join(configDir, 'config.yaml'), 'utf8');
  expect(yaml).toContain('enabled: true');
  expect(yaml).toContain('runner: faster-whisper');
  expect(yaml).toContain(`bin_path: "${python}"`);
  expect(yaml).toContain(`model_path: "${model}"`);
  expect(yaml).toContain('threads: 6');
}, 15_000);

test('tg-ctl voice-setup --dry-run prints the prebuilt install plan and writes nothing', async () => {
  const { home, binDir, uvLog } = bareHome();
  const configDir = join(home, '.config', 'tg-cli');
  const { code, stdout } = await runSetup(home, systemPath(binDir), configDir, ['--dry-run']);
  expect(code).toBe(0);
  expect(stdout).toContain(`${binDir}/uv venv --python 3.12`);
  expect(stdout).toContain('--only-binary :all: faster-whisper==1.2.1');
  expect(stdout).toContain('large-v3-turbo');
  expect(existsSync(join(configDir, 'config.yaml'))).toBe(false);
  expect(existsSync(uvLog)).toBe(false); // nothing ran
}, 15_000);

test('tg-ctl voice-setup installs with uv, re-probes, and configures what it installed', async () => {
  const { home, binDir, uvLog } = bareHome();
  const configDir = join(home, '.config', 'tg-cli');
  const { code, stdout, stderr } = await runSetup(home, systemPath(binDir), configDir);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  const uvCalls = readFileSync(uvLog, 'utf8').trim().split('\n');
  expect(uvCalls[0]).toStartWith('venv --python 3.12');
  expect(uvCalls[1]).toContain('pip install --python');
  expect(uvCalls[1]).toContain('--only-binary :all:');
  const root = join(home, '.local', 'share', 'tg-cli-voice', 'faster-whisper');
  const yaml = readFileSync(join(configDir, 'config.yaml'), 'utf8');
  expect(yaml).toContain('runner: faster-whisper');
  expect(yaml).toContain(`bin_path: "${join(root, '.venv', 'bin', 'python')}"`);
  expect(yaml).toContain(`model_path: "${join(root, 'models', 'large-v3-turbo')}"`);
  expect(stdout).toContain('configured');
}, 30_000);

test('tg-ctl voice-setup exits non-zero and writes no config when an install step fails', async () => {
  const { home, binDir } = bareHome(1);
  const configDir = join(home, '.config', 'tg-cli');
  const { code, stderr } = await runSetup(home, systemPath(binDir), configDir);
  expect(code).not.toBe(0);
  expect(stderr).toContain('failed (exit 1)');
  expect(existsSync(join(configDir, 'config.yaml'))).toBe(false);
}, 15_000);

test('tg-ctl voice-setup rejects an unknown argument', async () => {
  const { home, binDir } = bareHome();
  const { code } = await runSetup(home, systemPath(binDir), join(home, '.config', 'tg-cli'), ['--install-everything']);
  expect(code).toBe(2);
}, 15_000);

test('tg-ctl voice-setup finishes a setup install whose model download was cut off (model.bin without its config)', async () => {
  const { home, binDir } = bareHome();
  const root = join(home, '.local', 'share', 'tg-cli-voice', 'faster-whisper');
  mkdirSync(join(root, '.venv', 'bin'), { recursive: true });
  writeFileSync(join(root, '.venv', 'bin', 'python'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  mkdirSync(join(root, 'models', 'large-v3-turbo'), { recursive: true });
  writeFileSync(join(root, 'models', 'large-v3-turbo', 'model.bin'), 'PARTIAL');
  const configDir = join(home, '.config', 'tg-cli');
  const unconfigured = await runSetup(home, systemPath(binDir), configDir, ['--dry-run']);
  expect(unconfigured.code).toBe(0);
  expect(unconfigured.stdout).toContain('download_model');
  expect(unconfigured.stdout).not.toContain('would write');
  // Configured to it already (the cut-off dir got into config.yaml): not kept either.
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'config.yaml'),
    `voice:\n  enabled: true\n  runner: faster-whisper\n  bin_path: "${join(root, '.venv', 'bin', 'python')}"\n` +
      `  model_path: "${join(root, 'models', 'large-v3-turbo')}"\n  language: auto\n`,
  );
  const configured = await runSetup(home, systemPath(binDir), configDir, ['--dry-run']);
  expect(configured.code).toBe(0);
  expect(configured.stdout).toContain('download_model');
}, 15_000);
