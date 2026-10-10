import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makeTgHome, readHistory, removeTgHomes, runTg, sentRefs, startFakeBotApi, type TgHome } from './helpers/fake-bot-api';

// The REAL `tg` against a recording Bot API: what a long or attachment-carrying message turns
// into on the wire (docs/specs/auto-attach.md "Caption overflow", "Message splitting",
// "Ordering", "Attachment sanity checks"). Every chunk must be a message Telegram accepts on its
// own: ≤ 4096 chars, balanced HTML, no HTML entity cut in half, no lone surrogate.

const api = startFakeBotApi();
beforeEach(() => api.reset());
afterAll(() => {
  api.stop();
  removeTgHomes();
});

// A session whose [window] is the cwd basename — ASCII, so the header is Unicode-styled plain
// text and a plain body stays plain. With no agent detected the header line is the default
// folder emoji and the styled name; the body starts on the line below it.
function session(name = 'api-bot'): { h: TgHome; cwd: string } {
  const h = makeTgHome();
  const cwd = join(h.home, name);
  mkdirSync(cwd);
  return { h, cwd };
}
const HEADER = '📁 [𝗮𝗽𝗶-𝗯𝗼𝘁]\n';

const texts = (): string[] => api.calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.body.text));

// What Telegram's HTML parser refuses in a chunk: an unclosed or stray tag, or an `&` that does
// not start a complete entity ("Can't parse entities: character '&' is reserved").
function htmlProblems(chunk: string): string[] {
  const problems: string[] = [];
  const stack: string[] = [];
  for (const m of chunk.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)[^>]*>/g)) {
    const name = m[2].toLowerCase();
    if (m[1] !== '/') stack.push(name);
    else if (stack.pop() !== name) problems.push(`stray </${name}>`);
  }
  if (stack.length > 0) problems.push(`unclosed ${stack.map((t) => `<${t}>`).join('')}`);
  const text = chunk.replace(/<[^>]*>/g, '');
  for (const m of text.matchAll(/&(?!(?:amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+);)[^\s]{0,8}/g)) problems.push(`broken entity '${m[0]}'`);
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(chunk)) problems.push('lone surrogate');
  return problems;
}

test('a plain body over 4096 is split on paragraph boundaries into ≤4096 chunks that rebuild the body; only the first carries the header', async () => {
  const { h, cwd } = session();
  const paragraphs = Array.from({ length: 12 }, (_, i) => `Section ${i}: ${'status line.'.repeat(60)}`);
  const body = paragraphs.join('\n\n');
  const r = await runTg(api, h, [body], { cwd });
  expect(r.exitCode).toBe(0);
  const chunks = texts();
  expect(chunks.length).toBeGreaterThan(2);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4096);
  expect(chunks[0].startsWith(HEADER)).toBe(true);
  for (const c of chunks.slice(1)) expect(c).not.toContain('𝗮𝗽𝗶');
  // Cut between paragraphs, never mid-line: the pieces re-join into the exact body.
  expect(chunks.join('').slice(HEADER.length)).toBe(body);
  for (const c of chunks) expect(api.calls.find((x) => x.body.text === c)?.body.parse_mode).toBeUndefined();
});

test('an HTML body whose <b> and <pre><code class> span chunk boundaries is balanced in every chunk, each sent as HTML', async () => {
  const { h, cwd } = session();
  const code = Array.from({ length: 400 }, (_, i) => `const v${i} = compute(${i});`).join('\n');
  const body = `<b>${'bold prose '.repeat(500)}</b>\n<pre><code class="language-ts">${code}</code></pre>`;
  const r = await runTg(api, h, ['--format', 'html', body], { cwd });
  expect(r.exitCode).toBe(0);
  const chunks = texts();
  expect(chunks.length).toBeGreaterThan(2);
  for (const c of chunks) {
    expect(c.length).toBeLessThanOrEqual(4096);
    expect(htmlProblems(c)).toEqual([]);
  }
  for (const call of api.calls) expect(call.body.parse_mode).toBe('HTML');
  // A chunk that starts inside the code block reopens it WITH its language class.
  const continued = chunks.slice(1).filter((c) => c.includes('const v') && !c.includes('bold prose'));
  expect(continued.length).toBeGreaterThan(0);
  expect(continued.filter((c) => !c.startsWith('<pre><code class="language-ts">')).map((c) => c.slice(0, 60))).toEqual([]);
});

test('an HTML body dense with escaped entities and no spaces is never cut inside an entity', async () => {
  const { h, cwd } = session();
  const body = `<code>${'q=a&amp;b'.repeat(1100)}</code>`;
  const r = await runTg(api, h, ['--format', 'html', body], { cwd });
  expect(r.exitCode).toBe(0);
  const chunks = texts();
  expect(chunks.length).toBeGreaterThan(1);
  for (const c of chunks) expect(htmlProblems(c)).toEqual([]);
});

test('a plain body forced to HTML by a Cyrillic window name is escaped, and its &-entities survive the split', async () => {
  // A non-Latin window name cannot be Unicode-styled, so the header falls back to <b>…</b> and
  // the whole message goes out as HTML (docs/specs/unicode-prefix-styling.md): the plain body is
  // escaped, and every `&` becomes `&amp;` that the splitter must not cut.
  const { h, cwd } = session('проект');
  const body = 'a&b'.repeat(3000);
  const r = await runTg(api, h, [body], { cwd });
  expect(r.exitCode).toBe(0);
  const chunks = texts();
  expect(chunks[0].startsWith('📁 [<b>проект</b>]\n')).toBe(true);
  for (const call of api.calls) expect(call.body.parse_mode).toBe('HTML');
  for (const c of chunks) expect(htmlProblems(c)).toEqual([]);
});

test('a long line of emoji (surrogate pairs) with no spaces is never cut between the halves of a pair', async () => {
  const { h, cwd } = session();
  const r = await runTg(api, h, ['🚀'.repeat(3000)], { cwd });
  expect(r.exitCode).toBe(0);
  const chunks = texts();
  expect(chunks.length).toBeGreaterThan(1);
  for (const c of chunks) expect(htmlProblems(c)).toEqual([]);
});

test('a photo with a caption of exactly 1024 visible chars (header included) rides as the caption — no separate text', async () => {
  const { h, cwd } = session();
  const photo = join(cwd, 'shot.png');
  writeFileSync(photo, 'png-bytes');
  const header = HEADER;
  const body = 'x'.repeat(1024 - header.length);
  const r = await runTg(api, h, ['--photo', photo, body], { cwd });
  expect(r.exitCode).toBe(0);
  expect(api.calls.map((c) => c.method)).toEqual(['sendPhoto']);
  expect(api.calls[0].body.caption).toBe(header + body);
});

test('one char over the 1024 caption limit: the photo goes caption-less FIRST, then the full text as its own message', async () => {
  const { h, cwd } = session();
  const photo = join(cwd, 'shot.png');
  writeFileSync(photo, 'png-bytes');
  const header = HEADER;
  const body = 'x'.repeat(1025 - header.length);
  const r = await runTg(api, h, ['--photo', photo, body], { cwd });
  expect(r.exitCode).toBe(0);
  expect(api.calls.map((c) => c.method)).toEqual(['sendPhoto', 'sendMessage']);
  expect(api.calls[0].body.caption).toBeUndefined();
  expect(api.calls[1].body.text).toBe(header + body);
});

test('an HTML caption measures VISIBLE length: markup past 1024 raw chars still rides as the caption', async () => {
  const { h, cwd } = session();
  const photo = join(cwd, 'shot.png');
  writeFileSync(photo, 'png-bytes');
  const body = Array.from({ length: 120 }, (_, i) => `<b>r${String(i).padStart(3, '0')}</b>`).join(' ');
  expect(body.length).toBeGreaterThan(1024);
  const r = await runTg(api, h, ['--format', 'html', '--photo', photo, body], { cwd });
  expect(r.exitCode).toBe(0);
  expect(api.calls.map((c) => c.method)).toEqual(['sendPhoto']);
  expect(api.calls[0].body.parse_mode).toBe('HTML');
  expect(String(api.calls[0].body.caption)).toContain('<b>r119</b>');
});

test('sandwich order: photo album → text → document album, with the long text split in the middle', async () => {
  const { h, cwd } = session();
  const files: string[] = [];
  for (const name of ['a.png', 'b.png', 'c.bin', 'd.bin']) {
    const p = join(cwd, name);
    writeFileSync(p, `bytes of ${name}`);
    files.push(p);
  }
  const body = Array.from({ length: 8 }, () => 'paragraph text '.repeat(50)).join('\n\n');
  const r = await runTg(api, h, ['--photo', files[0], '--photo', files[1], '--file', files[2], '--file', files[3], body], { cwd });
  expect(r.exitCode).toBe(0);
  const methods = api.calls.map((c) => c.method);
  expect(methods[0]).toBe('sendMediaGroup');
  expect(methods.at(-1)).toBe('sendMediaGroup');
  expect(methods.slice(1, -1).every((m) => m === 'sendMessage')).toBe(true);
  expect(methods.length).toBeGreaterThan(3);
  const albumTypes = (i: number): string[] => (JSON.parse(String(api.calls[i].body.media)) as Array<{ type: string }>).map((m) => m.type);
  expect(albumTypes(0)).toEqual(['photo', 'photo']);
  expect(albumTypes(methods.length - 1)).toEqual(['document', 'document']);
  // The overflowing text never rides an album as a caption.
  for (const i of [0, methods.length - 1]) expect(JSON.parse(String(api.calls[i].body.media))[0].caption).toBeUndefined();
  // Every message id of the send — both albums' items and every chunk — is on the OK line.
  expect(sentRefs(r.stdout)).toHaveLength(2 + (methods.length - 2) + 2);
});

test('a missing --photo and an empty --file are skipped with a warning naming each, and the text still goes out', async () => {
  const { h, cwd } = session();
  const empty = join(cwd, 'empty.log');
  writeFileSync(empty, '');
  const missing = join(cwd, 'gone.png');
  const r = await runTg(api, h, ['--photo', missing, '--file', empty, 'deploy finished'], { cwd });
  expect(r.exitCode).toBe(0);
  expect(api.calls.map((c) => c.method)).toEqual(['sendMessage']);
  expect(api.calls[0].body.text).toBe(`${HEADER}deploy finished`);
  expect(r.stderr).toContain(`skipping attachment ${missing}: file not found`);
  expect(r.stderr).toContain(`skipping attachment ${empty}: file is empty`);
});

test('every attachment bad and no text: refused non-zero with nothing sent, never a silent OK', async () => {
  const { h, cwd } = session();
  const r = await runTg(api, h, ['--file', join(cwd, 'gone.bin')], { cwd });
  expect(r.exitCode).not.toBe(0);
  expect(r.stdout).not.toContain('OK');
  expect(api.calls).toEqual([]);
});

test('a body that would split into 7 messages is refused before ANY send, naming the counts', async () => {
  const { h, cwd } = session();
  const body = Array.from({ length: 7 }, () => 'line of a runaway report '.repeat(160).trim()).join('\n\n');
  const r = await runTg(api, h, [body], { cwd });
  expect(r.exitCode).toBe(1);
  expect(api.calls).toEqual([]);
  expect(r.stderr).toContain(`refusing ${body.length + HEADER.length}-character message: it would send as 7 messages`);
});

test('a multi-chunk send writes one history row per message id, all sharing one groupId; a single send has none', async () => {
  const { h, cwd } = session();
  const body = Array.from({ length: 3 }, () => 'history paragraph '.repeat(150).trim()).join('\n\n');
  const r = await runTg(api, h, [body], { cwd });
  expect(r.exitCode).toBe(0);
  const ids = sentRefs(r.stdout);
  expect(ids.length).toBeGreaterThan(1);
  const rows = readHistory(h).filter((row) => row.direction === 'agent');
  expect(rows.map((row) => row.message_id)).toEqual(ids);
  const groups = new Set(rows.map((row) => row.groupId));
  expect(groups.size).toBe(1);
  expect([...groups][0]).toMatch(/^[0-9a-f-]{36}$/);
  for (const row of rows) {
    expect(row.text).toBe(body);
    expect(row.pane).toBe('%9');
  }

  api.reset();
  const single = await runTg(api, h, ['short one'], { cwd });
  const last = readHistory(h).at(-1)!;
  expect(last.message_id).toBe(sentRefs(single.stdout)[0]);
  expect(last.groupId).toBeUndefined();
});

test('a photo-only send is recalled as [photo]; a photo + text send records the body under both ids', async () => {
  const { h, cwd } = session();
  const photo = join(cwd, 'shot.png');
  writeFileSync(photo, 'png-bytes');
  await runTg(api, h, ['--photo', photo], { cwd });
  // The header alone rides the photo as its caption; recall shows what the agent sent.
  expect(readHistory(h).at(-1)?.text).toBe('[photo]');

  const long = 'caption that will not fit '.repeat(50).trim();
  const r = await runTg(api, h, ['--photo', photo, long], { cwd });
  const ids = sentRefs(r.stdout);
  expect(ids).toHaveLength(2);
  const rows = readHistory(h).slice(-2);
  expect(rows.map((row) => row.message_id)).toEqual(ids);
  expect(rows.map((row) => row.text)).toEqual([long, long]);
  expect(rows[0].groupId).toBe(rows[1].groupId!);
});
