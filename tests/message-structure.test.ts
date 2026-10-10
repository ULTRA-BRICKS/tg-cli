import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tempDir } from './helpers/test-temp';
import {
  LONG_UNSTRUCTURED_MESSAGE_WARNING,
  shouldWarnLongUnstructuredPlainMessage,
} from '../features/cli/message-structure';

const denseLongText = Array.from({ length: 90 }, (_, i) => `detail${i}`).join(' ');
const unicodeHeading = '\u0418\u0442\u043e\u0433\u0438';
const unicodeTitleCaseHeading = '\u041f\u043b\u0430\u043d \u0414\u0435\u0439\u0441\u0442\u0432\u0438\u0439';
const unicodeProseColon = '\u041e\u043d \u0441\u043a\u0430\u0437\u0430\u043b \u0441\u043b\u0435\u0434\u0443\u044e\u0449\u0435\u0435';

test('warns for long plain text-only messages with no visible structure', () => {
  expect(
    shouldWarnLongUnstructuredPlainMessage({
      text: denseLongText,
      format: 'plain',
    }),
  ).toBe(true);
});

test('does not warn for short one-line messages', () => {
  expect(
    shouldWarnLongUnstructuredPlainMessage({
      text: 'short status ping',
      format: 'plain',
    }),
  ).toBe(false);
});

test('does not warn or throw when plain text is absent', () => {
  expect(
    shouldWarnLongUnstructuredPlainMessage({
      format: 'plain',
    }),
  ).toBe(false);
});

test('warns only at the long-message threshold', () => {
  expect(
    shouldWarnLongUnstructuredPlainMessage({
      text: 'a'.repeat(499),
      format: 'plain',
    }),
  ).toBe(false);
  expect(
    shouldWarnLongUnstructuredPlainMessage({
      text: 'a'.repeat(500),
      format: 'plain',
    }),
  ).toBe(true);
});

test('uses normalized visible text length for the long-message threshold', () => {
  const visiblyShort = Array.from({ length: 250 }, () => 'a').join('   ');
  const visiblyLong = Array.from({ length: 251 }, () => 'a').join('   ');
  expect(
    shouldWarnLongUnstructuredPlainMessage({
      text: ` \n ${visiblyShort} \n `,
      format: 'plain',
    }),
  ).toBe(false);
  expect(
    shouldWarnLongUnstructuredPlainMessage({
      text: ` \n ${visiblyLong} \n `,
      format: 'plain',
    }),
  ).toBe(true);
});

test('does not warn when the send already has a structural mode or artifact', () => {
  expect(
    shouldWarnLongUnstructuredPlainMessage({
      text: denseLongText,
      format: 'html',
    }),
  ).toBe(false);
  expect(
    shouldWarnLongUnstructuredPlainMessage({
      text: denseLongText,
      format: 'plain',
      table: true,
    }),
  ).toBe(false);
  expect(
    shouldWarnLongUnstructuredPlainMessage({
      text: denseLongText,
      format: 'plain',
      items: [{ type: 'document', path: '/tmp/report.txt' }],
    }),
  ).toBe(false);
});

test('does not warn for already structured plain text', () => {
  const cases = [
    `Summary\n\n${denseLongText}`,
    `Summary\r\n\r\n${denseLongText}`,
    `# Summary\n${denseLongText}`,
    `Summary:\n${denseLongText}`,
    `Next Steps:\n${denseLongText}`,
    `Action items:\n${denseLongText}`,
    `Details of the new feature:\n${denseLongText}`,
    `Status of the latest build:\n${denseLongText}`,
    `Improvements to the system:\n${denseLongText}`,
    `Status (Latest):\n${denseLongText}`,
    `Phase 1 - Details:\n${denseLongText}`,
    `A Plan for Action:\n${denseLongText}`,
    `${unicodeHeading}:\n${denseLongText}`,
    `${unicodeTitleCaseHeading}:\n${denseLongText}`,
    `- ${denseLongText}\n- next item`,
    `\u2022 ${denseLongText}\n\u2022 next item`,
    `1. ${denseLongText}\n2. next item`,
    `> ${denseLongText}`,
    `Name | Status\nship | done\nqa | passing`,
    `name\tstatus\nship\tdone`,
    `<b>Summary</b> ${denseLongText}`,
    `<b>Summary:</b> ${denseLongText}`,
    `<strong>Status</strong>: ${denseLongText}`,
    `Output\n\`\`\`\n${denseLongText}\n\`\`\``,
    `<pre>${denseLongText}</pre>`,
    `<blockquote>${denseLongText}</blockquote>`,
    `<blockquote expandable>${denseLongText}</blockquote>`,
    `┌──────┬────────┐\n│ Name │ Status │\n└──────┴────────┘\n${denseLongText}`,
  ];
  for (const text of cases) {
    expect(
      shouldWarnLongUnstructuredPlainMessage({
        text,
        format: 'plain',
      }),
    ).toBe(false);
  }
});

test('natural prose colon lines do not count as headings by themselves', () => {
  expect(
    shouldWarnLongUnstructuredPlainMessage({
      text: `Then he said:\n${denseLongText}`,
      format: 'plain',
    }),
  ).toBe(true);
  expect(
    shouldWarnLongUnstructuredPlainMessage({
      text: `Basically:\n${denseLongText}`,
      format: 'plain',
    }),
  ).toBe(true);
  expect(
    shouldWarnLongUnstructuredPlainMessage({
      text: `${unicodeProseColon}:\n${denseLongText}`,
      format: 'plain',
    }),
  ).toBe(true);
});

test('sentence-like styled labels do not count as headings by themselves', () => {
  expect(
    shouldWarnLongUnstructuredPlainMessage({
      text: `<b>Then he said</b> ${denseLongText}`,
      format: 'plain',
    }),
  ).toBe(true);
});

test('rich-only HTML tags in plain sends do not count as readable structure', () => {
  for (const text of [`<h1>Summary</h1> ${denseLongText}`, `<table><tr><td>${denseLongText}</td></tr></table>`]) {
    expect(
      shouldWarnLongUnstructuredPlainMessage({
        text,
        format: 'plain',
      }),
    ).toBe(true);
  }
});

test('loose pipe characters do not count as a table by themselves', () => {
  expect(
    shouldWarnLongUnstructuredPlainMessage({
      text: `the command returned foo|bar and then it returned baz|qux ${denseLongText}`,
      format: 'plain',
    }),
  ).toBe(true);
  expect(
    shouldWarnLongUnstructuredPlainMessage({
      text: `foo|bar\nbaz|qux\n${denseLongText}`,
      format: 'plain',
    }),
  ).toBe(true);
});

test('a stray box-drawing character does not count as a table by itself', () => {
  expect(
    shouldWarnLongUnstructuredPlainMessage({
      text: `the log prefix used a \u2502 separator before dense prose ${denseLongText}`,
      format: 'plain',
    }),
  ).toBe(true);
});

const TG_SCRIPT = join(import.meta.dir, '..', 'tg');
let sent: Array<Record<string, unknown>> = [];

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/sendMessage')) {
      const body = (await req.json()) as Record<string, unknown>;
      sent.push(body);
      return Response.json({ ok: true, result: { message_id: 1 } });
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
  const home = tempDir('tg-message-structure-');
  dirs.push(home);
  const cfg = join(home, '.config', 'tg-cli');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  return home;
}

async function runSend(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const home = makeHome();
  const proc = Bun.spawn(['bun', TG_SCRIPT, ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
      TMUX: '',
      TG_AI_MODEL: 'unknown-model',
      TG_AI_EMOJI: 'bot',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout: await stdoutPromise, stderr };
}

test('real tg send warns on stderr but still sends a long unstructured plain message', async () => {
  sent = [];
  const { exitCode, stdout, stderr } = await runSend([denseLongText]);
  expect(exitCode).toBe(0);
  expect(sent.length).toBeGreaterThan(0);
  expect(stderr).toContain(LONG_UNSTRUCTURED_MESSAGE_WARNING);
  expect(stdout.trim()).toBe('OK tg#1');
});

test('real tg send does not warn for structured plain text', async () => {
  sent = [];
  const { exitCode, stderr } = await runSend([`Summary\n\n${denseLongText}`]);
  expect(exitCode).toBe(0);
  expect(sent.length).toBeGreaterThan(0);
  expect(stderr).not.toContain(LONG_UNSTRUCTURED_MESSAGE_WARNING);
});

test('real tg send does not warn for recognized Telegram HTML tags', async () => {
  sent = [];
  const { exitCode, stderr } = await runSend([`<b>Summary</b> ${denseLongText}`]);
  expect(exitCode).toBe(0);
  expect(sent.length).toBeGreaterThan(0);
  expect(stderr).not.toContain(LONG_UNSTRUCTURED_MESSAGE_WARNING);
});

test('real tg send warns for rich-only HTML tags sent without --format html', async () => {
  sent = [];
  const { exitCode, stderr } = await runSend([`<h1>Summary</h1> ${denseLongText}`]);
  expect(exitCode).toBe(0);
  expect(sent.length).toBeGreaterThan(0);
  expect(stderr).toContain(LONG_UNSTRUCTURED_MESSAGE_WARNING);
});
