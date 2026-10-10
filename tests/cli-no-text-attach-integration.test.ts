import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tempDir } from './helpers/test-temp';

// tg-cli#648: the message text is NEVER resolved into file paths. Only an
// explicit --file/--photo attaches a file. Runs the REAL `tg` against a fake
// Bot API and asserts the wire calls: a body naming an existing file (relative,
// absolute, image, line-spec, deeper in the tree) must produce sendMessage
// only — never sendDocument/sendPhoto/sendMediaGroup.

const TG_SCRIPT = join(import.meta.dir, '..', 'tg');

type Kind = 'sendMessage' | 'sendDocument' | 'sendPhoto' | 'sendMediaGroup';
type SentCall = { kind: Kind; body: Record<string, unknown> };
let sent: SentCall[];

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const method = new URL(req.url).pathname.split('/').pop() as string;
    if (method === 'sendMessage') {
      sent.push({ kind: method, body: (await req.json()) as Record<string, unknown> });
      return Response.json({ ok: true, result: { message_id: sent.length } });
    }
    if (method === 'sendDocument' || method === 'sendPhoto' || method === 'sendMediaGroup') {
      const form = await req.formData();
      const body: Record<string, unknown> = {};
      for (const [k, v] of form.entries()) body[k] = v instanceof Blob ? `<blob:${v.size}b>` : v;
      sent.push({ kind: method, body });
      return Response.json({ ok: true, result: { message_id: sent.length } });
    }
    return Response.json({ ok: false, description: `unexpected: ${method}` }, { status: 404 });
  },
});

afterAll(() => {
  server.stop(true);
});

// A work dir holding files a message might name: AGENTS.md at the top, an
// image, a text file for a line-spec, and a markdown file two levels down
// (the old recursive-attach walk found it by basename).
function makeWorkDir(): string {
  const dir = tempDir('tg-648-cwd-');
  writeFileSync(join(dir, 'AGENTS.md'), '# private agent notes\n');
  writeFileSync(join(dir, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  writeFileSync(join(dir, 'notes.txt'), 'one\ntwo\nthree\n');
  mkdirSync(join(dir, 'docs', 'specs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'specs', 'deep-design.md'), '# deep\n');
  writeFileSync(join(dir, 'report.pdf'), '%PDF-1.4 dummy\n');
  return dir;
}

async function runTg(
  args: string[],
  cwd: string,
  configYaml = '',
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const home = tempDir('tg-648-home-');
  const cfg = join(home, '.config', 'tg-cli');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  if (configYaml) writeFileSync(join(cfg, 'config.yaml'), configYaml);
  const proc = Bun.spawn(['bun', TG_SCRIPT, ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode: await proc.exited, stdout, stderr };
}

async function expectTextOnly(text: string, cwd: string, extraArgs: string[] = [], configYaml = ''): Promise<void> {
  sent = [];
  const { exitCode, stderr } = await runTg([...extraArgs, text], cwd, configYaml);
  expect(stderr).not.toMatch(/error/i);
  expect(exitCode).toBe(0);
  expect(sent.map((c) => c.kind)).toEqual(['sendMessage']);
  // The whole text, path token included, goes out verbatim.
  expect(String(sent[0].body.text)).toContain(text);
}

test('#648: a relative path to an existing file in the text is not attached', async () => {
  await expectTextOnly('see AGENTS.md', makeWorkDir());
});

test('#648: an absolute path to an existing file in the text is not attached', async () => {
  const dir = makeWorkDir();
  await expectTextOnly(`see ${join(dir, 'AGENTS.md')}`, tempDir('tg-648-elsewhere-'));
});

test('#648: an image path in the text is not sent as a photo', async () => {
  const dir = makeWorkDir();
  await expectTextOnly(`look at ${join(dir, 'shot.png')}`, dir);
});

test('#648: a path with a line-spec in the text is not attached', async () => {
  await expectTextOnly('the bug is at notes.txt:2', makeWorkDir());
});

test('#648: a bare filename that exists deeper in the tree is not attached', async () => {
  await expectTextOnly('read deep-design.md', makeWorkDir());
});

// The removed feature names are inert: re-enabling them by flag or config
// must not bring the text scan back.
test('#648: --feature auto-attach / recursive-attach do not attach a named file', async () => {
  await expectTextOnly('see AGENTS.md', makeWorkDir(), ['--feature', 'auto-attach']);
  await expectTextOnly('read deep-design.md', makeWorkDir(), ['--feature', 'recursive-attach']);
});

test('#648: features.auto-attach / recursive-attach: true in config.yaml do not attach a named file', async () => {
  const yaml = 'features:\n  auto-attach: true\n  recursive-attach: true\n';
  await expectTextOnly('see AGENTS.md', makeWorkDir(), [], yaml);
  await expectTextOnly('read deep-design.md', makeWorkDir(), [], yaml);
});

test('#648: tg --dry-run "see AGENTS.md" validates the text and reports no attachment', async () => {
  sent = [];
  const { exitCode, stdout, stderr } = await runTg(['--dry-run', 'see AGENTS.md'], makeWorkDir());
  expect(stderr).not.toMatch(/attachment/i);
  expect(exitCode).toBe(0);
  expect(stdout).toContain('see AGENTS.md');
  expect(sent).toHaveLength(0);
});

test('#648: an explicit --file still attaches the named file', async () => {
  sent = [];
  const dir = makeWorkDir();
  const { exitCode } = await runTg(['--file', 'report.pdf', 'weekly report, see AGENTS.md'], dir);
  expect(exitCode).toBe(0);
  const kinds = sent.map((c) => c.kind);
  expect(kinds).toEqual(['sendDocument']);
  expect(sent[0].body.document as string).toMatch(/^<blob:\d+b>$/);
  expect(sent[0].body.caption as string).toContain('see AGENTS.md');
});

test('#648: an explicit --photo still attaches the named image', async () => {
  sent = [];
  const dir = makeWorkDir();
  const { exitCode } = await runTg(['--photo', join(dir, 'shot.png'), 'screenshot'], dir);
  expect(exitCode).toBe(0);
  expect(sent.map((c) => c.kind)).toEqual(['sendPhoto']);
});
