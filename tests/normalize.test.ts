import { expect, test } from 'bun:test';
import { buildSendPlan, type ParsedItem } from '../features/auto-attach/normalize';

const photo = (path: string): ParsedItem => ({ type: 'photo', path });
const doc = (path: string): ParsedItem => ({ type: 'document', path });

test('base: items split into photos/documents, caption → one text message', () => {
  const plan = buildSendPlan([photo('/a.png'), doc('/b.pdf')], 'hi', 'plain');
  expect(plan.photos.map((p) => p.source)).toEqual([{ kind: 'disk', path: '/a.png' }]);
  expect(plan.documents.map((d) => d.source)).toEqual([{ kind: 'disk', path: '/b.pdf' }]);
  expect(plan.textMessages).toEqual([{ text: 'hi', format: 'plain' }]);
});

test('empty caption → no text message', () => {
  const plan = buildSendPlan([photo('/a.png')], '', 'plain');
  expect(plan.textMessages).toEqual([]);
});

test('empty prose but a non-empty prefix (renderText) → prefix rides as caption', () => {
  // Mirrors tg: even when the user's prose is empty, the AI-emoji/tmux prefix
  // produced by renderText survives as the (caption) text message — marked header-only, so the
  // transmitter drops it if every attachment it captions is gone (tg-cli#207).
  const plan = buildSendPlan([photo('/a.png')], '', 'plain', {
    renderText: (t) => ({ text: '\u{1F681}\n' + t, format: 'plain' }),
  });
  expect(plan.textMessages).toEqual([{ text: '\u{1F681}\n', format: 'plain', headerOnly: true }]);
});

test('a header with no attachments is the message itself, not a header-only caption', () => {
  const plan = buildSendPlan([], '', 'plain', {
    renderText: (t) => ({ text: '\u{1F681} [w] Deploy done\n' + t, format: 'plain' }),
  });
  expect(plan.textMessages).toEqual([{ text: '\u{1F681} [w] Deploy done\n', format: 'plain' }]);
});

test('truly empty render (no prefix, no prose) → no text message', () => {
  const plan = buildSendPlan([photo('/a.png')], '', 'plain', {
    renderText: (t, f) => ({ text: t, format: f }),
  });
  expect(plan.textMessages).toEqual([]);
});

// --- R2: duplicated file content stripped from the caption text ---
test('R2: pasted full file content is stripped from the message text', () => {
  const content = 'export const x = 1\nexport const y = 2\nexport const z = 3';
  const text = `Updated the module:\n${content}\nlet me know.`;
  const plan = buildSendPlan([doc('/m.ts')], text, 'plain', {
    fileContents: [{ path: '/m.ts', content }],
  });
  const body = plan.textMessages[0].text;
  expect(body).not.toContain('export const y = 2');
  expect(body).toContain('Updated the module:');
  expect(body).toContain('let me know.');
});

// --- R4: large free code block → fragment document, removed from text ---
test('R4: a >1024 fenced code block becomes an in-memory fragment document', () => {
  const big = 'row = 1\n'.repeat(200); // > 1024
  const text = `Here is the script:\n\`\`\`python\n${big}\`\`\`\ndone`;
  const plan = buildSendPlan([], text, 'plain');
  // The big block is gone from the text.
  expect(plan.textMessages[0]?.text ?? '').not.toContain('row = 1\nrow = 1');
  // A fragment document was added, in-memory, with a .py extension.
  expect(plan.documents.length).toBe(1);
  const src = plan.documents[0].source;
  expect(src.kind).toBe('memory');
  if (src.kind === 'memory') {
    expect(src.filename).toMatch(/\.py$/);
    expect(src.content).toContain('row = 1');
    // Marked as a fragment.
    expect(src.filename.toLowerCase()).toContain('script');
  }
});

// --- R4: two large blocks both extracted (span-splice order regression) ---
test('R4: two >1024 fenced blocks are both extracted, both removed from text', () => {
  const a = 'aaa = 1\n'.repeat(200);
  const b = 'bbb = 2\n'.repeat(200);
  const text = `first:\n\`\`\`python\n${a}\`\`\`\nmiddle\nsecond:\n\`\`\`js\n${b}\`\`\`\nlast`;
  const plan = buildSendPlan([], text, 'plain');
  expect(plan.documents.length).toBe(2);
  const body = plan.textMessages[0].text;
  expect(body).not.toContain('aaa = 1\naaa = 1');
  expect(body).not.toContain('bbb = 2\nbbb = 2');
  expect(body).toContain('middle');
  expect(body).toContain('last');
  // Each fragment has the right extension.
  const exts = plan.documents.map((d) => (d.source.kind === 'memory' ? d.source.filename : '')).sort();
  expect(exts.some((f) => f.endsWith('.py'))).toBe(true);
  expect(exts.some((f) => f.endsWith('.js'))).toBe(true);
});

// --- renderText hook applies to surviving prose only ---
test('renderText hook receives the post-extraction text', () => {
  const big = 'z = 1\n'.repeat(200);
  const text = `note:\n\`\`\`python\n${big}\`\`\`\nend`;
  let seen = '';
  const plan = buildSendPlan([], text, 'plain', {
    renderText: (t, f) => {
      seen = t;
      return { text: t.toUpperCase(), format: f };
    },
  });
  expect(seen).not.toContain('z = 1');
  expect(plan.textMessages[0].text).toBe(seen.toUpperCase());
});

// --- R3: a small fenced block stays inline, no attachment ---
test('R3: a <=1024 fenced block stays inline and is NOT attached', () => {
  const text = 'look:\n```ts\nconst a = 1\n```\nthanks';
  const plan = buildSendPlan([], text, 'plain');
  expect(plan.documents.length).toBe(0);
  expect(plan.textMessages[0].text).toContain('const a = 1');
});
