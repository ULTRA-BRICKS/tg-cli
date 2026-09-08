import { expect, test } from 'bun:test';
import { transmit, visibleLength, type Transport } from '../features/auto-attach/transmitter';
import type { SendPlan, SendItem } from '../features/auto-attach/types';

test('visibleLength ignores HTML tags + counts unescaped entities', () => {
  expect(visibleLength('plain', 'plain')).toBe(5);
  expect(visibleLength('<b>hi</b>', 'html')).toBe(2);
  expect(visibleLength('a &lt; b &amp; c', 'html')).toBe('a < b & c'.length);
});

test('visibleLength: single-pass decode does not double-unescape, tag-strip is complete', () => {
  // js/double-escaping guard: `&amp;lt;` must decode to the literal `&lt;`
  // (4 chars), never collapse to `<`.
  expect(visibleLength('&amp;lt;', 'html')).toBe('&lt;'.length);
  // js/incomplete-multi-character-sanitization guard: a dangling, unterminated
  // tag at end-of-string contributes ZERO visible length (it is stripped, not
  // left behind as it was under the old /<[^>]+>/g). An unescaped trailing `<b`
  // is malformed Telegram HTML anyway (a real `<` must be `&lt;`).
  expect(visibleLength('hi <script', 'html')).toBe('hi '.length);
  expect(visibleLength('see a<b', 'html')).toBe('see a'.length);
});

test('HTML caption: raw length > 1024 but VISIBLE <= 1024 still rides as caption', () => {
  const calls: Array<{ method: string }> = [];
  const t: Transport = {
    sendMessage: async () => {
      calls.push({ method: 'sendMessage' });
    },
    sendPhoto: async () => {
      calls.push({ method: 'sendPhoto' });
    },
    sendDocument: async () => {
      calls.push({ method: 'sendDocument' });
    },
    sendMediaGroup: async () => {
      calls.push({ method: 'sendMediaGroup' });
    },
    sendRich: async () => {
      calls.push({ method: 'sendRich' });
    },
  };
  // 1000 visible chars wrapped in a tag → raw length > 1024 but visible 1000.
  const text = '<b>' + 'x'.repeat(1000) + '</b>';
  const plan: SendPlan = {
    photos: [{ type: 'photo', source: { kind: 'disk', path: '/a.png' } }],
    textMessages: [{ text, format: 'html' }],
    documents: [],
  };
  return transmit(plan, t).then(() => {
    // Rode as the photo caption → no separate sendMessage.
    expect(calls.map((c) => c.method)).toEqual(['sendPhoto']);
  });
});

// A fake transport records every call instead of hitting the network.
function fakeTransport() {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const t: Transport = {
    sendMessage: async (text, format) => {
      calls.push({ method: 'sendMessage', args: { text, format } });
    },
    sendPhoto: async (item, caption, format) => {
      calls.push({ method: 'sendPhoto', args: { item, caption, format } });
    },
    sendDocument: async (item, caption, format) => {
      calls.push({ method: 'sendDocument', args: { item, caption, format } });
    },
    sendMediaGroup: async (kind, items, caption, format) => {
      calls.push({ method: 'sendMediaGroup', args: { kind, items, caption, format } });
    },
    sendRich: async (html) => {
      calls.push({ method: 'sendRich', args: { html } });
    },
  };
  return { t, calls };
}

const photo = (path: string): SendItem => ({ type: 'photo', source: { kind: 'disk', path } });
const doc = (path: string): SendItem => ({ type: 'document', source: { kind: 'disk', path } });

function plan(p: Partial<SendPlan>): SendPlan {
  return { photos: [], textMessages: [], documents: [], ...p };
}

test('ordering: photos → text → documents (sandwich)', async () => {
  const { t, calls } = fakeTransport();
  // Use a >1024 caption so the text does NOT ride a media caption and is sent
  // as a separate middle message — the case that exercises all three sections.
  const big = 'x'.repeat(2000);
  await transmit(
    plan({
      photos: [photo('/a.png')],
      textMessages: [{ text: big, format: 'plain' }],
      documents: [doc('/b.pdf')],
    }),
    t,
  );
  expect(calls.map((c) => c.method)).toEqual(['sendPhoto', 'sendMessage', 'sendDocument']);
});

test('single photo with short caption rides as the photo caption', async () => {
  const { t, calls } = fakeTransport();
  await transmit(plan({ photos: [photo('/a.png')], textMessages: [{ text: 'small', format: 'plain' }] }), t);
  expect(calls.length).toBe(1);
  expect(calls[0].method).toBe('sendPhoto');
  expect(calls[0].args.caption).toBe('small');
});

test('caption > 1024: photo sent WITHOUT caption + text sent as separate message', async () => {
  const { t, calls } = fakeTransport();
  const big = 'x'.repeat(2000);
  await transmit(plan({ photos: [photo('/a.png')], textMessages: [{ text: big, format: 'plain' }] }), t);
  const photoCall = calls.find((c) => c.method === 'sendPhoto')!;
  expect(photoCall.args.caption).toBeUndefined();
  const msgCall = calls.find((c) => c.method === 'sendMessage')!;
  expect(msgCall.args.text).toBe(big);
  // Order is still photo before the separate text message.
  expect(calls.indexOf(photoCall)).toBeLessThan(calls.indexOf(msgCall));
});

test('text > 4096 is split into multiple sendMessage calls', async () => {
  const { t, calls } = fakeTransport();
  const huge = ('para ' + 'y'.repeat(900) + '\n\n').repeat(8); // > 4096
  await transmit(plan({ textMessages: [{ text: huge, format: 'plain' }] }), t);
  const msgs = calls.filter((c) => c.method === 'sendMessage');
  expect(msgs.length).toBeGreaterThan(1);
  for (const m of msgs) expect((m.args.text as string).length).toBeLessThanOrEqual(4096);
});

// FIX 2 (album restore): >=2 photos go out as ONE sendMediaGroup, not N
// individual sendPhoto messages. The short caption rides the album (first item).
test('multiple photos with short caption: ONE sendMediaGroup album, caption on the album', async () => {
  const { t, calls } = fakeTransport();
  await transmit(
    plan({
      photos: [photo('/a.png'), photo('/b.png')],
      textMessages: [{ text: 'cap', format: 'plain' }],
    }),
    t,
  );
  // Exactly one album call carrying both photos — no separate sendPhoto calls.
  expect(calls.map((c) => c.method)).toEqual(['sendMediaGroup']);
  const album = calls[0];
  expect(album.args.kind).toBe('photo');
  expect((album.args.items as SendItem[]).length).toBe(2);
  expect(album.args.caption).toBe('cap');
});

test('FIX 2: exactly ONE photo still uses sendPhoto (a 1-item album is invalid)', async () => {
  const { t, calls } = fakeTransport();
  await transmit(plan({ photos: [photo('/a.png')], textMessages: [{ text: 'cap', format: 'plain' }] }), t);
  expect(calls.map((c) => c.method)).toEqual(['sendPhoto']);
  expect(calls[0].args.caption).toBe('cap');
});

test('FIX 2: >=2 documents go out as ONE sendMediaGroup document album', async () => {
  const { t, calls } = fakeTransport();
  await transmit(
    plan({ documents: [doc('/a.pdf'), doc('/b.pdf')], textMessages: [{ text: 'note', format: 'plain' }] }),
    t,
  );
  expect(calls.map((c) => c.method)).toEqual(['sendMediaGroup']);
  expect(calls[0].args.kind).toBe('document');
  expect((calls[0].args.items as SendItem[]).length).toBe(2);
  expect(calls[0].args.caption).toBe('note');
});

test('FIX 2: photo album + >1024 caption → album caption-less + SEPARATE text message', async () => {
  const { t, calls } = fakeTransport();
  const big = 'x'.repeat(2000);
  await transmit(
    plan({ photos: [photo('/a.png'), photo('/b.png')], textMessages: [{ text: big, format: 'plain' }] }),
    t,
  );
  const album = calls.find((c) => c.method === 'sendMediaGroup')!;
  expect(album.args.caption).toBeUndefined();
  const msg = calls.find((c) => c.method === 'sendMessage')!;
  expect(msg.args.text).toBe(big);
  // Album (photos) still precedes the separate text message.
  expect(calls.indexOf(album)).toBeLessThan(calls.indexOf(msg));
});

test('FIX 2: ordering with albums — photo album → text → document album', async () => {
  const { t, calls } = fakeTransport();
  const big = 'x'.repeat(2000); // >1024 so text does NOT ride a caption
  await transmit(
    plan({
      photos: [photo('/a.png'), photo('/b.png')],
      textMessages: [{ text: big, format: 'plain' }],
      documents: [doc('/c.pdf'), doc('/d.pdf')],
    }),
    t,
  );
  expect(calls.map((c) => c.method)).toEqual(['sendMediaGroup', 'sendMessage', 'sendMediaGroup']);
  expect((calls[0].args.items as SendItem[]).length).toBe(2);
  expect(calls[0].args.kind).toBe('photo');
  expect((calls[2].args.items as SendItem[]).length).toBe(2);
  expect(calls[2].args.kind).toBe('document');
});

test('FIX 2: >10 photos are chunked into 10-item albums (Telegram cap), caption on the very first', async () => {
  const { t, calls } = fakeTransport();
  const photos = Array.from({ length: 23 }, (_, i) => photo(`/p${i}.png`));
  await transmit(plan({ photos, textMessages: [{ text: 'cap', format: 'plain' }] }), t);
  // 23 → albums of 10 + 10 + 3.
  expect(calls.map((c) => c.method)).toEqual(['sendMediaGroup', 'sendMediaGroup', 'sendMediaGroup']);
  expect((calls[0].args.items as SendItem[]).length).toBe(10);
  expect((calls[1].args.items as SendItem[]).length).toBe(10);
  expect((calls[2].args.items as SendItem[]).length).toBe(3);
  // Caption only on the first album.
  expect(calls[0].args.caption).toBe('cap');
  expect(calls[1].args.caption).toBeUndefined();
  expect(calls[2].args.caption).toBeUndefined();
});

test('FIX 2: a trailing single item after a full album falls back to sendPhoto (1-item group is invalid)', async () => {
  const { t, calls } = fakeTransport();
  const photos = Array.from({ length: 11 }, (_, i) => photo(`/p${i}.png`));
  await transmit(plan({ photos }), t);
  // 11 → album of 10 + a lone sendPhoto (a 1-item group would be rejected).
  expect(calls.map((c) => c.method)).toEqual(['sendMediaGroup', 'sendPhoto']);
  expect((calls[0].args.items as SendItem[]).length).toBe(10);
});

test('FIX 2: short caption rides the PHOTO album when both albums present', async () => {
  const { t, calls } = fakeTransport();
  await transmit(
    plan({
      photos: [photo('/a.png'), photo('/b.png')],
      textMessages: [{ text: 'cap', format: 'plain' }],
      documents: [doc('/c.pdf'), doc('/d.pdf')],
    }),
    t,
  );
  expect(calls.map((c) => c.method)).toEqual(['sendMediaGroup', 'sendMediaGroup']);
  // Photo album carries the caption; document album does not.
  expect(calls[0].args.kind).toBe('photo');
  expect(calls[0].args.caption).toBe('cap');
  expect(calls[1].args.kind).toBe('document');
  expect(calls[1].args.caption).toBeUndefined();
});

test('text-only with documents: caption rides the first document when short', async () => {
  const { t, calls } = fakeTransport();
  await transmit(plan({ documents: [doc('/a.pdf')], textMessages: [{ text: 'note', format: 'plain' }] }), t);
  // No photos → text can ride as the document caption.
  expect(calls.length).toBe(1);
  expect(calls[0].method).toBe('sendDocument');
  expect(calls[0].args.caption).toBe('note');
});

test('text-only plan sends a single message', async () => {
  const { t, calls } = fakeTransport();
  await transmit(plan({ textMessages: [{ text: 'just text', format: 'plain' }] }), t);
  expect(calls).toEqual([{ method: 'sendMessage', args: { text: 'just text', format: 'plain' } }]);
});

test('photos + text + documents: text rides photo caption (short), docs follow', async () => {
  const { t, calls } = fakeTransport();
  await transmit(
    plan({
      photos: [photo('/a.png')],
      textMessages: [{ text: 'cap', format: 'plain' }],
      documents: [doc('/b.pdf')],
    }),
    t,
  );
  expect(calls.map((c) => c.method)).toEqual(['sendPhoto', 'sendDocument']);
  expect(calls[0].args.caption).toBe('cap');
  expect(calls[1].args.caption).toBeUndefined();
});

// --- rich-message routing (Bot API sendRichMessage) ------------------------

test('rich HTML body (table) routes to sendRich, NOT sendMessage', async () => {
  const { t, calls } = fakeTransport();
  const html = '<h1>Report</h1><table><tr><td>a</td></tr></table>';
  await transmit(plan({ textMessages: [{ text: html, format: 'html' }] }), t);
  expect(calls.length).toBe(1);
  expect(calls[0].method).toBe('sendRich');
  expect(calls[0].args.html).toBe(html);
});

test('basic HTML body (only <b>) routes to sendMessage, NOT sendRich', async () => {
  const { t, calls } = fakeTransport();
  const html = '<b>bold</b> plain report';
  await transmit(plan({ textMessages: [{ text: html, format: 'html' }] }), t);
  expect(calls.length).toBe(1);
  expect(calls[0].method).toBe('sendMessage');
});

test('a rich body is sent WHOLE (never 4096-split)', async () => {
  const { t, calls } = fakeTransport();
  // A rich body well over 4096 chars but under the 500-block / 32768-char rich
  // limits: 50 list items of ~100-char text = >5000 chars, 51 blocks. A plain
  // sendMessage would 4096-split it; sendRich sends it as one call.
  const items = `<li>${'word '.repeat(20)}</li>`.repeat(50);
  const html = '<ul>' + items + '</ul>';
  expect(html.length).toBeGreaterThan(4096);
  await transmit(plan({ textMessages: [{ text: html, format: 'html' }] }), t);
  expect(calls.length).toBe(1);
  expect(calls[0].method).toBe('sendRich');
});

test('a rich body never rides as a media caption', async () => {
  const { t, calls } = fakeTransport();
  // Short rich HTML (< 1024 visible) alongside a photo: a basic short caption
  // would ride the photo, but a rich body must be its own sendRich message.
  const html = '<table><tr><td>x</td></tr></table>';
  await transmit(plan({ photos: [photo('/a.png')], textMessages: [{ text: html, format: 'html' }] }), t);
  const methods = calls.map((c) => c.method);
  expect(methods).toContain('sendRich');
  expect(methods).toContain('sendPhoto');
  // The photo went out caption-less (the rich body did not ride it).
  const photoCall = calls.find((c) => c.method === 'sendPhoto')!;
  expect(photoCall.args.caption).toBeUndefined();
});

test('an in-document-link <a href="#..."> body routes to sendRich', async () => {
  const { t, calls } = fakeTransport();
  const html = 'jump to <a href="#chapter-2">chapter 2</a>';
  await transmit(plan({ textMessages: [{ text: html, format: 'html' }] }), t);
  expect(calls.length).toBe(1);
  expect(calls[0].method).toBe('sendRich');
});

test('invalid rich HTML + a photo: NOTHING is sent (preflight before media)', async () => {
  const { t, calls } = fakeTransport();
  const origExit = process.exit;
  let exitCode: number | undefined;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error('__exit__');
  }) as typeof process.exit;
  try {
    // 21 columns → over the 20-column limit. The photo must NOT be sent.
    const overWide = '<table><tr>' + '<td>c</td>'.repeat(21) + '</tr></table>';
    await expect(
      transmit(plan({ photos: [photo('/a.png')], textMessages: [{ text: overWide, format: 'html' }] }), t),
    ).rejects.toThrow('__exit__');
    expect(exitCode).toBe(1);
    // No send of any kind happened — the photo did not go out orphaned.
    expect(calls).toHaveLength(0);
  } finally {
    process.exit = origExit;
  }
});

// --- tg-cli#207: a missing/empty/unreadable disk attachment must never fail
// the whole send. `transmit` accepts an injected `checkFile` (defaults to a
// permissive 'ok' pass-through, so every test above that never passes it keeps
// today's behavior byte-for-byte) + `warn` (defaults to console.error). A
// disk item that fails the check is dropped from the plan and the send
// continues with whatever survives — the primary text always goes out. ---

test('tg-cli#207: a missing disk photo is skipped, the text still delivers', async () => {
  const { t, calls } = fakeTransport();
  const warnings: string[] = [];
  await transmit(
    plan({ photos: [photo('/missing.png')], textMessages: [{ text: 'status update', format: 'plain' }] }),
    t,
    { checkFile: () => 'missing', warn: (m) => warnings.push(m) },
  );
  expect(calls.map((c) => c.method)).toEqual(['sendMessage']);
  expect((calls[0].args as { text: string }).text).toBe('status update');
  expect(warnings.some((w) => w.includes('/missing.png'))).toBe(true);
});

test('tg-cli#207: an empty disk document is skipped, the text still delivers', async () => {
  const { t, calls } = fakeTransport();
  const warnings: string[] = [];
  await transmit(
    plan({ documents: [doc('/empty.log')], textMessages: [{ text: 'see /empty.log', format: 'plain' }] }),
    t,
    { checkFile: () => 'empty', warn: (m) => warnings.push(m) },
  );
  expect(calls.map((c) => c.method)).toEqual(['sendMessage']);
  expect(warnings.some((w) => w.includes('/empty.log') && /empty/i.test(w))).toBe(true);
});

test('tg-cli#207: an unreadable disk attachment is skipped with a distinct reason', async () => {
  const { t, calls } = fakeTransport();
  const warnings: string[] = [];
  await transmit(plan({ documents: [doc('/locked.pdf')], textMessages: [{ text: 'note', format: 'plain' }] }), t, {
    checkFile: () => 'unreadable',
    warn: (m) => warnings.push(m),
  });
  expect(calls.map((c) => c.method)).toEqual(['sendMessage']);
  expect(warnings[0]).toContain('/locked.pdf');
  expect(warnings[0]).toMatch(/unreadable/i);
});

test('tg-cli#207: a mix of good + bad attachments sends only the good ones', async () => {
  const { t, calls } = fakeTransport();
  const check = (p: string): 'ok' | 'missing' => (p === '/bad.pdf' ? 'missing' : 'ok');
  await transmit(
    plan({ documents: [doc('/good.pdf'), doc('/bad.pdf')], textMessages: [{ text: 'report', format: 'plain' }] }),
    t,
    { checkFile: check, warn: () => {} },
  );
  // Only one surviving document → a lone sendDocument (not a 2-item album), the
  // short caption rides it.
  expect(calls.map((c) => c.method)).toEqual(['sendDocument']);
  expect(calls[0].args.caption).toBe('report');
  const item = calls[0].args.item as SendItem;
  expect(item.source.kind === 'disk' && item.source.path).toBe('/good.pdf');
});

test('tg-cli#207: with no checkFile injected, disk attachments pass through unchanged (default = ok)', async () => {
  const { t, calls } = fakeTransport();
  await transmit(plan({ photos: [photo('/a.png')], textMessages: [{ text: 'x', format: 'plain' }] }), t);
  expect(calls.map((c) => c.method)).toEqual(['sendPhoto']);
});

test('tg-cli#207: an in-memory item (R4 fragment) is never checked, even when checkFile always says "missing"', async () => {
  const { t, calls } = fakeTransport();
  const memoryDoc: SendItem = { type: 'document', source: { kind: 'memory', filename: 'frag.ts', content: 'x' } };
  await transmit(
    plan({ documents: [memoryDoc], textMessages: [{ text: 'note', format: 'plain' }] }),
    t,
    { checkFile: () => 'missing', warn: () => {} },
  );
  // The memory item survives regardless of checkFile — it has no disk path to check.
  expect(calls.map((c) => c.method)).toEqual(['sendDocument']);
});

test('tg-cli#207: filtering the photo host migrates the caption to the surviving document section', async () => {
  const { t, calls } = fakeTransport();
  await transmit(
    plan({
      photos: [photo('/bad.png')],
      documents: [doc('/good.pdf')],
      textMessages: [{ text: 'note', format: 'plain' }],
    }),
    t,
    { checkFile: (p) => (p === '/bad.png' ? 'missing' : 'ok'), warn: () => {} },
  );
  // The photo was dropped, so no sendPhoto — the caption rides the sole surviving document.
  expect(calls.map((c) => c.method)).toEqual(['sendDocument']);
  expect(calls[0].args.caption).toBe('note');
});

test('tg-cli#207: filtering 3 documents down to 2 still forms a sendMediaGroup album', async () => {
  const { t, calls } = fakeTransport();
  await transmit(
    plan({
      documents: [doc('/a.pdf'), doc('/bad.pdf'), doc('/b.pdf')],
      textMessages: [{ text: 'note', format: 'plain' }],
    }),
    t,
    { checkFile: (p) => (p === '/bad.pdf' ? 'missing' : 'ok'), warn: () => {} },
  );
  expect(calls.map((c) => c.method)).toEqual(['sendMediaGroup']);
  expect((calls[0].args.items as SendItem[]).length).toBe(2);
  expect(calls[0].args.caption).toBe('note');
});

test('tg-cli#207: everything filtered out and no text left → refuses loudly instead of a silent no-op OK', async () => {
  const { t, calls } = fakeTransport();
  const capture = captureExitAndErrors();
  try {
    await expect(
      transmit(plan({ documents: [doc('/bad.pdf')] }), t, { checkFile: () => 'missing', warn: () => {} }),
    ).rejects.toThrow('__exit__');
    expect(capture.getExitCode()).toBe(1);
    expect(calls).toHaveLength(0);
  } finally {
    capture.restore();
  }
});

// --- tg-cli#208: a body large enough to fragment into more than the flood
// cap must be REFUSED before anything is sent (same preflight posture as the
// invalid-rich-HTML case above), unless the caller opts in via
// `allowFlood: true` (the --no-feature flood-cap escape hatch). Rich bodies
// never split, so they are exempt regardless of length. ---

function captureExitAndErrors(): {
  errors: string[];
  getExitCode: () => number | undefined;
  restore: () => void;
} {
  const origExit = process.exit;
  const origError = console.error;
  const errors: string[] = [];
  let exitCode: number | undefined;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error('__exit__');
  }) as typeof process.exit;
  console.error = (...args: unknown[]) => {
    errors.push(args.join(' '));
  };
  return {
    errors,
    getExitCode: () => exitCode,
    restore: () => {
      process.exit = origExit;
      console.error = origError;
    },
  };
}

test('tg-cli#208: a plain message that would fragment into 7 messages is refused', async () => {
  const { t, calls } = fakeTransport();
  const capture = captureExitAndErrors();
  try {
    // No spaces/newlines → splitMessage hard-cuts at exactly 4096 chars/chunk,
    // so 4096*6 + 1 chars is deterministically 7 chunks (cap is 6).
    const huge = 'y'.repeat(4096 * 6 + 1);
    await expect(
      transmit(plan({ photos: [photo('/a.png')], textMessages: [{ text: huge, format: 'plain' }] }), t),
    ).rejects.toThrow('__exit__');
    expect(capture.getExitCode()).toBe(1);
    // Nothing sent at all — the photo did not go out orphaned.
    expect(calls).toHaveLength(0);
    const message = capture.errors.join('\n');
    expect(message).toContain(String(huge.length));
    expect(message).toMatch(/7/);
  } finally {
    capture.restore();
  }
});

test('tg-cli#208: a caption-riding message is exempt even when its RAW length would split into 7+ chunks', async () => {
  // review-cli round 2 finding: `<tg-emoji emoji-id="...">x</tg-emoji>` is ~53
  // raw chars per entity but collapses to 1 VISIBLE char (visibleLength, same
  // metric captionCandidate uses against CAPTION_LIMIT). 500 of them is >26000
  // raw chars (7 splitMessage chunks) but only 500 visible chars — well under
  // the 1024 caption limit, so this rides the photo as ONE caption and must
  // NOT be refused by the flood cap, which only applies to text that is
  // actually going out via the N-chunk sendText path.
  const { t, calls } = fakeTransport();
  const capture = captureExitAndErrors();
  try {
    const html = '<tg-emoji emoji-id="5274170649227600531">x</tg-emoji>'.repeat(500);
    expect(html.length).toBeGreaterThan(4096 * 6);
    await transmit(plan({ photos: [photo('/a.png')], textMessages: [{ text: html, format: 'html' }] }), t);
    expect(calls.map((c) => c.method)).toEqual(['sendPhoto']);
    expect(calls[0].args.caption).toBe(html);
    expect(capture.getExitCode()).toBeUndefined();
  } finally {
    capture.restore();
  }
});

test('tg-cli#208: the SAME heavy-entity body with NO media to ride still gets refused (exemption is not a blanket bypass)', async () => {
  const { t, calls } = fakeTransport();
  const capture = captureExitAndErrors();
  try {
    const html = '<tg-emoji emoji-id="5274170649227600531">x</tg-emoji>'.repeat(500);
    await expect(transmit(plan({ textMessages: [{ text: html, format: 'html' }] }), t)).rejects.toThrow('__exit__');
    expect(capture.getExitCode()).toBe(1);
    expect(calls).toHaveLength(0);
  } finally {
    capture.restore();
  }
});

test('tg-cli#208: exactly at the cap (6 messages) is NOT refused', async () => {
  const { t, calls } = fakeTransport();
  const capture = captureExitAndErrors();
  try {
    const atCap = 'y'.repeat(4096 * 6); // exactly 6 chunks
    await transmit(plan({ textMessages: [{ text: atCap, format: 'plain' }] }), t);
    const msgs = calls.filter((c) => c.method === 'sendMessage');
    expect(msgs.length).toBe(6);
    expect(capture.getExitCode()).toBeUndefined();
  } finally {
    capture.restore();
  }
});

test('tg-cli#208: allowFlood bypasses the refusal and sends every fragment', async () => {
  const { t, calls } = fakeTransport();
  const capture = captureExitAndErrors();
  try {
    const huge = 'y'.repeat(50000);
    await transmit(plan({ textMessages: [{ text: huge, format: 'plain' }] }), t, { allowFlood: true });
    const msgs = calls.filter((c) => c.method === 'sendMessage');
    expect(msgs.length).toBeGreaterThan(6);
    expect(capture.getExitCode()).toBeUndefined();
  } finally {
    capture.restore();
  }
});

test('tg-cli#208: a rich HTML body is exempt from the flood cap (never split)', async () => {
  const { t, calls } = fakeTransport();
  const capture = captureExitAndErrors();
  try {
    // Well past the 4096*6 flood threshold but under the rich 32768-char /
    // 500-block budget — must still send WHOLE via sendRich, never refused.
    const items = `<li>${'word '.repeat(20)}</li>`.repeat(230);
    const html = '<ul>' + items + '</ul>';
    expect(html.length).toBeGreaterThan(4096 * 6);
    await transmit(plan({ textMessages: [{ text: html, format: 'html' }] }), t);
    expect(calls.map((c) => c.method)).toEqual(['sendRich']);
    expect(capture.getExitCode()).toBeUndefined();
  } finally {
    capture.restore();
  }
});

test('tg-cli#208: a NON-rich HTML body (no table/heading/list/formula tags) over the cap is also refused', async () => {
  const { t, calls } = fakeTransport();
  const capture = captureExitAndErrors();
  try {
    // Basic HTML (only <b>, which is NOT a rich-only tag) — isRichHtml is false,
    // so this must go through the SAME flood-cap check as plain text, not the
    // rich exemption above.
    const huge = '<b>' + 'z'.repeat(4096 * 6 + 1) + '</b>';
    await expect(
      transmit(plan({ textMessages: [{ text: huge, format: 'html' }] }), t),
    ).rejects.toThrow('__exit__');
    expect(capture.getExitCode()).toBe(1);
    expect(calls).toHaveLength(0);
  } finally {
    capture.restore();
  }
});
