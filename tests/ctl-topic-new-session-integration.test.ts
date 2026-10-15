import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { tempDir } from './helpers/test-temp';
import { parseHolds, parseTopics, type TopicHold } from '../features/tg-ctl/topics';

// The unknown-topic picker's ➕ New session button (tg-cli#735), end to end: the REAL daemon, a
// fake Telegram server and a fake tmux. A tap runs the /new directory → harness → model flow inside
// the held topic, and the spawn takes THAT topic as the new session's own: TG_TOPIC=<thread>, a
// bound binding, no createForumTopic, the topic renamed, and the held text as the initial task.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const SPAWNED_PANE = '%8';
const THREAD = 77;

setDefaultTimeout(30_000);

const reg = createDaemonRegistry();
const servers: Array<{ stop: (c?: boolean) => Promise<void> | void }> = [];
const cfgDirs: string[] = [];

afterEach(async () => {
  await reapDaemons(reg);
  for (const s of servers.splice(0)) await s.stop(true);
  for (const d of cfgDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeTmux(cwd: string, spawnLog: string): string {
  return `#!/bin/sh
sub="$1"; shift
case "$sub" in
  list-panes)
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '%1' '4241' 'claude' 'main' '' '${cwd}'
    ;;
  display-message) printf 'main\\n' ;;
  new-window)
    printf 'new-window %s\\n' "$*" >> '${spawnLog}'
    printf '%s\\n' '${SPAWNED_PANE}'
    ;;
  set-option) : ;;
  send-keys) printf 'send-keys %s\\n' "$*" >> '${spawnLog}' ;;
  load-buffer) cat > /dev/null ;;
esac
exit 0
`;
}

function makeCfgDir(): { cfgDir: string; spawnLog: string } {
  const cfgDir = tempDir('tgctl-tns-');
  cfgDirs.push(cfgDir);
  const spawnLog = join(cfgDir, 'spawn.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n  private_topics: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: '%1', cwd: cfgDir }));
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmux(cfgDir, spawnLog), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), "#!/bin/sh\nprintf '%s %s %s\\n' '4241' '1' 'claude'\n", { mode: 0o755 });
  return { cfgDir, spawnLog };
}

const nowSec = (): number => Math.floor(Date.now() / 1000);
const from = { id: 1, first_name: 'Alex' };

function topicMsg(id: number, extra: Record<string, unknown>): unknown {
  return {
    update_id: id,
    message: { message_id: id, from, chat: { id: 1 }, date: nowSec(), message_thread_id: THREAD, is_topic_message: true, ...extra },
  };
}

function tap(id: number, messageId: number, data: string): unknown {
  return {
    update_id: id,
    callback_query: { id: `cb${id}`, from, message: { message_id: messageId, chat: { id: 1 }, date: 0, message_thread_id: THREAD }, data },
  };
}

type Keyboard = Array<Array<{ text: string; callback_data: string }>>;
type Sent = Record<string, unknown> & { message_id: number };

function startServer(queue: unknown[][]) {
  const sends: Sent[] = [];
  const calls: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const method = url.pathname.split('/').at(-1) ?? '';
      if (method === 'getUpdates') {
        const batch = queue.shift();
        if (batch) return Response.json({ ok: true, result: batch });
        // An empty long poll: the daemon re-polls at once, so a short hold keeps it from spinning.
        await Bun.sleep(60);
        return Response.json({ ok: true, result: [] });
      }
      if (method === 'getMe') return Response.json({ ok: true, result: { id: 123, is_bot: true, username: 'bot', has_topics_enabled: true } });
      const parsed: unknown = await req.json().catch(() => ({}));
      const body: Record<string, unknown> = parsed && typeof parsed === 'object' ? { ...parsed } : {};
      calls.push({ method, ...body });
      if (method === 'sendMessage') {
        const message_id = 900 + sends.length;
        sends.push({ ...body, message_id });
        return Response.json({ ok: true, result: { message_id } });
      }
      if (method === 'createForumTopic') return Response.json({ ok: true, result: { message_thread_id: 4242, name: body.name } });
      return Response.json({ ok: true, result: true });
    },
  });
  servers.push(server);
  return { server, sends, calls };
}

async function startDaemon(cfgDir: string, port: number): Promise<void> {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: { PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`, HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${port}` },
    logFd,
  });
  closeSync(logFd);
}

// Polls a condition (not a guessed delay); a timeout names the condition and dumps the daemon log.
async function waitFor(pred: () => boolean, diag: () => string, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 >= ms) throw new Error(`waitFor timed out: ${pred.toString()}\n${diag()}`);
    await Bun.sleep(50);
  }
}

function keyboardOf(s: Sent | undefined): Keyboard {
  const markup = s?.reply_markup;
  if (!markup || typeof markup !== 'object' || !('inline_keyboard' in markup) || !Array.isArray(markup.inline_keyboard)) return [];
  return markup.inline_keyboard;
}
const findSend = (sends: Sent[], needle: string): Sent | undefined => sends.find((s) => String(s.text ?? '').includes(needle));
const holds = (cfgDir: string): TopicHold[] => {
  const p = join(cfgDir, 'tg-ctl.123.topic-holds.json');
  return existsSync(p) ? parseHolds(readFileSync(p, 'utf8')) : [];
};
const heldCount = (cfgDir: string): number => holds(cfgDir)[0]?.payloads.length ?? 0;
const spawns = (spawnLog: string): string[] =>
  existsSync(spawnLog) ? readFileSync(spawnLog, 'utf8').split('\n').filter((l) => l.startsWith('new-window')) : [];

test('➕ New session in an unknown topic spawns an agent bound to THAT topic, with the held text as its task', async () => {
  const { cfgDir, spawnLog } = makeCfgDir();
  const queue: unknown[][] = [];
  const { server, sends, calls } = startServer(queue);
  await startDaemon(cfgDir, server.port);
  const diag = () => `${readFileSync(join(cfgDir, 'daemon.log'), 'utf8')}\nsends=${JSON.stringify(sends)}`;

  queue.push([topicMsg(15, { text: 'fix the login bug' })]);
  await waitFor(() => sends.some((s) => keyboardOf(s).length > 0), diag);
  const picker = sends.find((s) => keyboardOf(s).length > 0)!;
  expect(picker.message_thread_id).toBe(THREAD);
  expect(keyboardOf(picker).at(-1)).toEqual([{ text: '➕ New session', callback_data: `tgn:${THREAD}` }]);

  // A photo joins the hold; it cannot ride the initial prompt, so it is answered after the spawn.
  queue.push([topicMsg(16, { photo: [{ file_id: 'p1', file_unique_id: 'u1', width: 1, height: 1 }] })]);
  await waitFor(() => heldCount(cfgDir) === 2, diag);

  queue.push([tap(17, picker.message_id, `tgn:${THREAD}`)]);
  await waitFor(() => !!findSend(sends, 'Pick a recent project'), diag);
  const dirPrompt = findSend(sends, 'Pick a recent project')!;
  expect(dirPrompt.message_thread_id).toBe(THREAD);
  const dirButton = keyboardOf(dirPrompt).flat().find((b) => b.text === cfgDir)!;
  expect(dirButton).toBeDefined();

  queue.push([tap(18, dirPrompt.message_id, dirButton.callback_data)]);
  await waitFor(() => !!findSend(sends, 'Which harness'), diag);
  const harnessPrompt = findSend(sends, 'Which harness')!;
  expect(harnessPrompt.message_thread_id).toBe(THREAD);
  const claude = keyboardOf(harnessPrompt).flat().find((b) => b.callback_data.endsWith(':claude'))!;

  queue.push([tap(19, harnessPrompt.message_id, claude.callback_data)]);
  await waitFor(() => !!findSend(sends, 'model should'), diag);
  const modelPrompt = findSend(sends, 'model should')!;
  const model = keyboardOf(modelPrompt).flat().find((b) => b.callback_data.endsWith(':claude-default'))!;

  queue.push([tap(20, modelPrompt.message_id, model.callback_data)]);
  await waitFor(() => spawns(spawnLog).length > 0 && !!findSend(sends, 'not passed'), diag);

  const argv = spawns(spawnLog);
  expect(argv).toHaveLength(1);
  expect(argv[0]).toContain(`-e TG_TOPIC=${THREAD}`);
  expect(argv[0]).toContain(`-c ${cfgDir}`);
  expect(argv[0]).toContain('fix the login bug');
  expect(calls.some((c) => c.method === 'createForumTopic')).toBe(false);

  const name = basename(cfgDir);
  const binding = parseTopics(readFileSync(join(cfgDir, 'tg-ctl.123.topics.json'), 'utf8')).find((t) => t.threadId === THREAD);
  expect(binding).toMatchObject({ status: 'bound', paneId: SPAWNED_PANE, name, path: cfgDir, model: 'claude-default' });
  expect(calls.some((c) => c.method === 'editForumTopic' && c.message_thread_id === THREAD && c.name === name)).toBe(true);
  expect(holds(cfgDir)).toEqual([]);
  expect(calls.some((c) => c.method === 'editMessageText' && c.message_id === picker.message_id)).toBe(true);
  expect(findSend(sends, 'not passed')?.message_thread_id).toBe(THREAD);
});

test('a typed path in the topic answers its ➕ New session prompt and is not held for the new agent', async () => {
  const { cfgDir } = makeCfgDir();
  const queue: unknown[][] = [];
  const { server, sends, calls } = startServer(queue);
  await startDaemon(cfgDir, server.port);
  const diag = () => `${readFileSync(join(cfgDir, 'daemon.log'), 'utf8')}\nsends=${JSON.stringify(sends)}`;

  queue.push([topicMsg(15, { text: 'hello' })]);
  await waitFor(() => sends.some((s) => keyboardOf(s).length > 0), diag);
  const picker = sends.find((s) => keyboardOf(s).length > 0)!;
  queue.push([tap(16, picker.message_id, `tgn:${THREAD}`)]);
  await waitFor(() => !!findSend(sends, 'Pick a recent project'), diag);
  // A second tap while the flow is open neither restarts it nor posts another prompt.
  queue.push([tap(20, picker.message_id, `tgn:${THREAD}`)]);
  await waitFor(() => calls.filter((c) => c.method === 'answerCallbackQuery').length === 2, diag);
  expect(calls.filter((c) => c.method === 'answerCallbackQuery').at(-1)?.text).toContain('already started');
  expect(sends.filter((s) => String(s.text ?? '').includes('Pick a recent project'))).toHaveLength(1);

  // A mistyped directory is answered as one, in the topic — not queued as a message for the agent.
  queue.push([topicMsg(17, { text: join(cfgDir, 'nope') })]);
  await waitFor(() => !!findSend(sends, 'not an absolute path to an existing directory'), diag);
  expect(findSend(sends, 'not an absolute path to an existing directory')?.message_thread_id).toBe(THREAD);
  // A bare `/word` too: the topic has no agent a harness command could be meant for.
  queue.push([topicMsg(19, { text: '/nope' })]);
  await waitFor(() => findSend(sends, '`/nope` is not an absolute path') !== undefined, diag);

  // A path with spaces is a directory answer too (here: an existing one).
  const spaced = join(cfgDir, 'my project');
  mkdirSync(spaced);
  queue.push([topicMsg(18, { text: spaced })]);
  await waitFor(() => !!findSend(sends, 'Which harness'), diag);
  expect(findSend(sends, 'Which harness')?.message_thread_id).toBe(THREAD);
  expect(heldCount(cfgDir)).toBe(1);
});

test('➕ New session on a superseded notice is expired; the hold\'s own notice starts the flow', async () => {
  const { cfgDir } = makeCfgDir();
  const held = { type: 'text', text: '[TG from Alex tg#30] kept', from: 'Alex', messageId: 30 };
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topic-holds.json'),
    JSON.stringify({ version: 1, holds: [{ threadId: THREAD, firstAt: nowSec(), pickerMessageId: null, noSessionNoticeId: 501, payloads: [held] }] }),
  );
  const queue: unknown[][] = [];
  const { server, sends, calls } = startServer(queue);
  await startDaemon(cfgDir, server.port);
  const diag = () => `${readFileSync(join(cfgDir, 'daemon.log'), 'utf8')}\nsends=${JSON.stringify(sends)}`;

  queue.push([tap(15, 400, `tgn:${THREAD}`)]);
  await waitFor(() => calls.some((c) => c.method === 'answerCallbackQuery'), diag);
  expect(calls.find((c) => c.method === 'answerCallbackQuery')?.text).toContain('expired');
  expect(findSend(sends, 'Pick a recent project')).toBeUndefined();

  queue.push([tap(16, 501, `tgn:${THREAD}`)]);
  await waitFor(() => !!findSend(sends, 'Pick a recent project'), diag);
});

test('an attach pick that delivers the hold mid-flow leaves the ➕ New session flow nothing to spawn', async () => {
  const { cfgDir, spawnLog } = makeCfgDir();
  const queue: unknown[][] = [];
  const { server, sends } = startServer(queue);
  await startDaemon(cfgDir, server.port);
  const diag = () => `${readFileSync(join(cfgDir, 'daemon.log'), 'utf8')}\nsends=${JSON.stringify(sends)}`;

  queue.push([topicMsg(15, { text: 'for main' })]);
  await waitFor(() => sends.some((s) => keyboardOf(s).length > 0), diag);
  const picker = sends.find((s) => keyboardOf(s).length > 0)!;
  queue.push([tap(16, picker.message_id, `tgn:${THREAD}`)]);
  await waitFor(() => !!findSend(sends, 'Pick a recent project'), diag);
  const dirPrompt = findSend(sends, 'Pick a recent project')!;

  queue.push([tap(17, picker.message_id, `tgt:${THREAD}:%1`)]);
  await waitFor(() => holds(cfgDir).length === 0 && !!findSend(sends, 'this topic is now'), diag);

  const dirButton = keyboardOf(dirPrompt).flat().find((b) => b.text === cfgDir)!;
  queue.push([tap(18, dirPrompt.message_id, dirButton.callback_data)]);
  await waitFor(() => !!findSend(sends, 'Which harness'), diag);
  const harnessPrompt = findSend(sends, 'Which harness')!;
  const claude = keyboardOf(harnessPrompt).flat().find((b) => b.callback_data.endsWith(':claude'))!;
  queue.push([tap(19, harnessPrompt.message_id, claude.callback_data)]);
  await waitFor(() => !!findSend(sends, 'model should'), diag);
  const modelPrompt = findSend(sends, 'model should')!;
  const model = keyboardOf(modelPrompt).flat().find((b) => b.callback_data.endsWith(':claude-default'))!;
  queue.push([tap(20, modelPrompt.message_id, model.callback_data)]);

  await waitFor(() => !!findSend(sends, 'no new agent was spawned'), diag);
  expect(spawns(spawnLog)).toEqual([]);
});

test('held text past the argv size cap is answered, not passed — the spawn still succeeds', async () => {
  const { cfgDir, spawnLog } = makeCfgDir();
  const big = 'x'.repeat(40 * 1024);
  const held = [1, 2].map((n) => ({ type: 'text', text: `${n}${big}`, from: 'Alex', messageId: 30 + n }));
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topic-holds.json'),
    JSON.stringify({ version: 1, holds: [{ threadId: THREAD, firstAt: nowSec(), pickerMessageId: 500, payloads: held }] }),
  );
  const queue: unknown[][] = [];
  const { server, sends } = startServer(queue);
  await startDaemon(cfgDir, server.port);
  const diag = () => `${readFileSync(join(cfgDir, 'daemon.log'), 'utf8')}\nsends=${JSON.stringify(sends)}`;

  queue.push([tap(15, 500, `tgn:${THREAD}`)]);
  await waitFor(() => !!findSend(sends, 'Pick a recent project'), diag);
  queue.push([topicMsg(16, { text: cfgDir })]);
  await waitFor(() => !!findSend(sends, 'Which harness'), diag);
  const claude = keyboardOf(findSend(sends, 'Which harness')).flat().find((b) => b.callback_data.endsWith(':claude'))!;
  queue.push([tap(17, findSend(sends, 'Which harness')!.message_id, claude.callback_data)]);
  await waitFor(() => !!findSend(sends, 'model should'), diag);
  const model = keyboardOf(findSend(sends, 'model should')).flat().find((b) => b.callback_data.endsWith(':claude-default'))!;
  queue.push([tap(18, findSend(sends, 'model should')!.message_id, model.callback_data)]);

  await waitFor(() => spawns(spawnLog).length > 0 && !!findSend(sends, '1 held message(s) not passed'), diag);
  expect(spawns(spawnLog)[0]).toContain(`1${big}`);
  expect(spawns(spawnLog)[0]).not.toContain(`2${big}`);
});

test('a ➕ New session tap on a hold past its TTL is expired, even before the sweep ran', async () => {
  const { cfgDir, spawnLog } = makeCfgDir();
  // Three seconds short of the TTL: the startup sweep keeps it, the next timed sweep is 30 s away.
  const firstAt = nowSec() - 597;
  const held = { type: 'text', text: '[TG from Alex tg#30] old', from: 'Alex', messageId: 30 };
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.topic-holds.json'),
    JSON.stringify({ version: 1, holds: [{ threadId: THREAD, firstAt, pickerMessageId: 500, payloads: [held] }] }),
  );
  const queue: unknown[][] = [];
  const { server, sends, calls } = startServer(queue);
  await startDaemon(cfgDir, server.port);
  const diag = () => `${readFileSync(join(cfgDir, 'daemon.log'), 'utf8')}\nsends=${JSON.stringify(sends)}`;
  await waitFor(() => calls.some((c) => c.method === 'setMyCommands'), diag);
  expect(holds(cfgDir).map((h) => h.threadId)).toEqual([THREAD]); // still held after startup
  // Polls the clock, not a guessed delay: the tap must land once the hold is past its TTL.
  await waitFor(() => nowSec() - firstAt > 600, diag, 6000);

  queue.push([tap(15, 500, `tgn:${THREAD}`)]);
  await waitFor(() => calls.some((c) => c.method === 'answerCallbackQuery'), diag);
  expect(calls.find((c) => c.method === 'answerCallbackQuery')?.text).toContain('expired');
  expect(findSend(sends, 'Pick a recent project')).toBeUndefined();
  expect(findSend(sends, '1 message not delivered')?.message_thread_id).toBe(THREAD);
  expect(spawns(spawnLog)).toEqual([]);
});

test('a ➕ New session tap with nothing held spawns nothing and says so', async () => {
  const { cfgDir, spawnLog } = makeCfgDir();
  const queue: unknown[][] = [];
  const { server, sends, calls } = startServer(queue);
  await startDaemon(cfgDir, server.port);
  const diag = () => `${readFileSync(join(cfgDir, 'daemon.log'), 'utf8')}\nsends=${JSON.stringify(sends)}`;

  queue.push([tap(15, 500, `tgn:${THREAD}`)]);
  await waitFor(() => calls.some((c) => c.method === 'answerCallbackQuery'), diag);
  // The handler answers the tap last: once the answer is seen, no prompt or spawn can follow.
  expect(calls.find((c) => c.method === 'answerCallbackQuery')?.text).toContain('expired');
  expect(findSend(sends, 'Pick a recent project')).toBeUndefined();
  expect(spawns(spawnLog)).toEqual([]);
});
