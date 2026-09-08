import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// End-to-end wiring proof (tg-cli#207 / tg-cli#208): run the REAL `tg` binary
// against a mock Bot-API server and assert the actual wire calls, not just the
// pure `transmit()` unit tests. This is what catches a wiring regression the
// transmitter tests can't see — e.g. the `tg` entrypoint forgetting to pass
// `checkFile`/`allowFlood` (the permissive `() => 'ok'` default would make that
// silent) or `--no-feature flood-cap` not reaching `TransmitOptions.allowFlood`.

const TG_SCRIPT = join(import.meta.dir, '..', 'tg');

type SentCall = { kind: 'sendMessage' | 'sendDocument'; body: Record<string, unknown> };
let sent: SentCall[];

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/sendMessage')) {
      const body = (await req.json()) as Record<string, unknown>;
      sent.push({ kind: 'sendMessage', body });
      return Response.json({ ok: true, result: { message_id: sent.length } });
    }
    if (url.pathname.endsWith('/sendDocument')) {
      const form = await req.formData();
      const body: Record<string, unknown> = {};
      for (const [k, v] of form.entries()) body[k] = v instanceof Blob ? `<blob:${v.size}b>` : v;
      sent.push({ kind: 'sendDocument', body });
      return Response.json({ ok: true, result: { message_id: sent.length } });
    }
    return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
  },
});

const dirs: string[] = [];
afterAll(() => {
  server.stop(true);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'tg-flood-home-'));
  dirs.push(home);
  const cfg = join(home, '.config', 'tg-cli');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  return home;
}

async function runSend(
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ exitCode: number; stderr: string }> {
  const home = makeHome();
  const proc = Bun.spawn(['bun', TG_SCRIPT, ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
      ...extraEnv,
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stderr };
}

// --- tg-cli#207: real fs wiring (checkAttachmentFile, wired to statSync/
// accessSync inline in the `tg` entrypoint) ---

test('wiring: a real 0-byte file on disk is skipped by the real `tg` binary, text still delivers', async () => {
  sent = [];
  const home = mkdtempSync(join(tmpdir(), 'tg-flood-scratch-'));
  dirs.push(home);
  const emptyFile = join(home, 'empty.log');
  writeFileSync(emptyFile, '');
  const { exitCode, stderr } = await runSend([`please check ${emptyFile} for errors`]);
  expect(exitCode).toBe(0);
  expect(sent.map((c) => c.kind)).toEqual(['sendMessage']);
  expect(sent[0].body.text as string).toContain(emptyFile);
  expect(stderr).toContain(emptyFile);
  expect(stderr).toMatch(/empty/i);
});

test('wiring: an explicit --file pointing at a missing path is skipped, caption still delivers', async () => {
  sent = [];
  const home = mkdtempSync(join(tmpdir(), 'tg-flood-scratch-'));
  dirs.push(home);
  const missing = join(home, 'does-not-exist.pdf');
  const { exitCode, stderr } = await runSend(['--file', missing, 'weekly report']);
  expect(exitCode).toBe(0);
  expect(sent.map((c) => c.kind)).toEqual(['sendMessage']);
  expect(sent[0].body.text as string).toContain('weekly report');
  expect(stderr).toContain(missing);
});

// review-cli round-2 finding: code-as-pdf/md-as-pdf conversion ran BEFORE the
// #207 validation, so an empty ORIGINAL source could be silently replaced by
// a generated (non-empty) PDF that then passed the check unrevalidated. `tg`
// now pre-filters `plan.documents` through the SAME checkAttachmentFile
// before either conversion pass runs, so a bad original is dropped before
// conversion is even attempted — no PDF, no send, just a skip warning. This
// is robust regardless of whether pandoc/Chrome are installed on this box,
// because conversion never starts on the empty file in the first place.
test('wiring: an empty ORIGINAL .ts file is dropped BEFORE code-as-pdf conversion runs (no PDF, no sendDocument)', async () => {
  sent = [];
  const home = mkdtempSync(join(tmpdir(), 'tg-flood-scratch-'));
  dirs.push(home);
  const emptySource = join(home, 'empty.ts');
  writeFileSync(emptySource, '');
  const { exitCode, stderr } = await runSend(['--file', emptySource, 'source review']);
  expect(exitCode).toBe(0);
  expect(sent.map((c) => c.kind)).toEqual(['sendMessage']);
  expect(sent[0].body.text as string).toContain('source review');
  expect(stderr).toContain(emptySource);
  expect(stderr).toMatch(/empty/i);
});

// --- tg-cli#208: --no-feature flood-cap wiring ---

test('wiring: an oversized plain body is refused by the real `tg` binary (flood cap ON by default)', async () => {
  sent = [];
  const huge = 'z'.repeat(30000);
  const { exitCode, stderr } = await runSend([huge]);
  expect(exitCode).not.toBe(0);
  expect(sent).toHaveLength(0);
  expect(stderr).toMatch(/refusing/i);
  // The final char count includes the branded prefix tg prepends, so it's a
  // little over the raw 30000 — assert the shape, not a hardcoded literal.
  expect(stderr).toMatch(/refusing 3\d{4}-character message: it would send as \d+ messages/);
});

test('wiring: --no-feature flood-cap bypasses the refusal and sends every fragment', async () => {
  sent = [];
  const huge = 'z'.repeat(30000);
  const { exitCode } = await runSend(['--no-feature', 'flood-cap', huge]);
  expect(exitCode).toBe(0);
  const messages = sent.filter((c) => c.kind === 'sendMessage');
  expect(messages.length).toBeGreaterThan(6);
});
