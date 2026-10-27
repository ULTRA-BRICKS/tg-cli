// The unattached-file gate end to end through the real `tg` (features/cli/file-mention-gate.ts):
// an agent sender (TG_AI_MODEL set) against a mock Bot API. tg#22056 reached the CTO as
// "Черновик недельного отчёта для Мари: ~/work/weekly-report-mari.md, проверь перед
// отправкой." with nothing attached. A body like that is refused before any API call, with
// the `--file` command that delivers it; the same body with the file attached goes out.
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tempDir } from './helpers/test-temp';

const TG = join(import.meta.dir, '..', 'tg');

let nextId = 900;
let calls: string[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const method = new URL(req.url).pathname.split('/').pop() as string;
    if (['sendMessage', 'sendDocument', 'sendPhoto', 'sendMediaGroup'].includes(method)) {
      calls.push(method);
      nextId += 1;
      return Response.json({ ok: true, result: { message_id: nextId } });
    }
    return Response.json({ ok: false, description: `unexpected: ${method}` }, { status: 404 });
  },
});
afterAll(() => server.stop(true));

// A home with the report draft and a work directory, like the conloca session's.
function makeHome(): string {
  const home = tempDir('tg-file-mention-');
  const cfg = join(home, '.config', 'tg-cli');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  // md-as-pdf would shell out to pandoc; the gate is about the text, not the conversion.
  writeFileSync(join(cfg, 'config.yaml'), 'features:\n  md-as-pdf: false\n');
  mkdirSync(join(home, 'work', 'wt-gl361'), { recursive: true });
  writeFileSync(join(home, 'work', 'weekly-report-mari.md'), '# Week\n\nHi @Mariam!\n');
  writeFileSync(join(home, 'work', 'chart.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return home;
}

const DRAFT_LINE = 'Черновик недельного отчёта для Мари: ~/work/weekly-report-mari.md, проверь перед отправкой.';

async function tg(
  home: string,
  args: string[],
  agent = true,
  stdin?: string,
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(['bun', TG, ...args], {
    ...(stdin !== undefined ? { stdin: new Blob([stdin]) } : {}),
    cwd: join(home, 'work'),
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
      TMUX: '',
      TG_LAYA: '0',
      TG_AI_EMOJI: 'bot',
      ...(agent ? { TG_AI_MODEL: 'claude' } : {}),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

test('--table: a path in the stdin rows counts, and the resend command says to pipe the rows again', async () => {
  calls = [];
  const home = makeHome();
  const r = await tg(home, ['--dry-run', '--table', 'Итоги'], true, `draft\t${join(home, 'work', 'weekly-report-mari.md')}\n`);
  expect(r.code).toBe(1);
  expect(r.err).toContain(`<the same table rows> | tg --file ${join(home, 'work', 'weekly-report-mari.md')} --dry-run --table 'Итоги'`);
  expect(calls).toEqual([]);
});

test('a file attached with --photo counts as attached', async () => {
  calls = [];
  const home = makeHome();
  const r = await tg(home, ['--photo', join(home, 'work', 'chart.png'), 'График: ~/work/chart.png']);
  expect(r.err).not.toContain('without attaching');
  expect(r.code).toBe(0);
  expect(calls).toContain('sendPhoto');
});

test('tg#22056: an agent message naming an existing file it does not attach is refused, nothing sent', async () => {
  calls = [];
  const home = makeHome();
  const r = await tg(home, [DRAFT_LINE]);
  expect(r.code).toBe(1);
  expect(r.err).toContain('~/work/weekly-report-mari.md');
  expect(r.err).toContain(`tg --file ${join(home, 'work', 'weekly-report-mari.md')} '<the same message text>'`);
  expect(r.err).toContain('nothing was sent');
  expect(calls).toEqual([]);
});

test('--dry-run shows the same refusal; the resend command keeps --dry-run (dry-run takes attachments)', async () => {
  calls = [];
  const home = makeHome();
  const r = await tg(home, ['--dry-run', '--tag', 'report', DRAFT_LINE]);
  expect(r.code).toBe(1);
  expect(r.err).toContain(`tg --file ${join(home, 'work', 'weekly-report-mari.md')} --dry-run --tag report '<the same message text>'`);
  expect(r.out).not.toContain('tg --dry-run: OK');
  expect(calls).toEqual([]);
});

test('the same message with the file attached goes out: the text and the document', async () => {
  calls = [];
  const home = makeHome();
  // The shell expands `~` in a real command line; argv here carries the expanded path.
  const r = await tg(home, ['--file', join(home, 'work', 'weekly-report-mari.md'), DRAFT_LINE]);
  expect(r.err).not.toContain('not attached');
  expect(r.code).toBe(0);
  expect(calls).toContain('sendDocument');
});

test('a path in backticks, a directory or a missing file does not trigger the gate', async () => {
  calls = [];
  const home = makeHome();
  const r = await tg(home, ['Проверил `cat ~/work/weekly-report-mari.md`. Worktree: ~/work/wt-gl361, старый ~/work/gone.md удалён.']);
  expect(r.err).not.toContain('not attached');
  expect(r.code).toBe(0);
  expect(calls).toEqual(['sendMessage']);
});

test('a sender with no agent identity is not gated', async () => {
  calls = [];
  const home = makeHome();
  const r = await tg(home, [DRAFT_LINE], false);
  expect(r.code).toBe(0);
  expect(calls).toEqual(['sendMessage']);
});

test('--no-feature file-mention-guard turns the gate off', async () => {
  calls = [];
  const home = makeHome();
  const r = await tg(home, ['--no-feature', 'file-mention-guard', DRAFT_LINE]);
  expect(r.code).toBe(0);
  expect(calls).toEqual(['sendMessage']);
});

test('an --automated send (a program run from an agent session) is not gated', async () => {
  calls = [];
  const home = makeHome();
  const r = await tg(home, ['--automated', DRAFT_LINE]);
  expect(r.err).not.toContain('without attaching');
  expect(r.code).toBe(0);
  expect(calls).toEqual(['sendMessage']);
});
