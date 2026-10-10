// The agent-facing receipt for downloaded inbound media (features/tg-ctl/media-receipt.ts):
// one photo/file reads as before; an album (tg-cli#280) lists every local path once.

import { expect, test } from 'bun:test';
import { mediaReceipt } from '../features/tg-ctl/media-receipt';

test('one photo or file: the local path, then the caption', () => {
  expect(mediaReceipt([{ mediaKind: 'photo', path: '/c/1.jpg' }], 'look')).toBe('sent photo: /c/1.jpg\nlook');
  expect(mediaReceipt([{ mediaKind: 'document', path: '/c/2.pdf' }], undefined)).toBe('sent file: /c/2.pdf');
});

test('an album: a count line, one path per line, then the caption once', () => {
  const photos = [1, 2, 3].map((n) => ({ mediaKind: 'photo' as const, path: `/c/${n}.jpg` }));
  expect(mediaReceipt(photos, 'two screenshots of one bug')).toBe('sent 3 photos:\n/c/1.jpg\n/c/2.jpg\n/c/3.jpg\ntwo screenshots of one bug');
  expect(mediaReceipt([{ mediaKind: 'document', path: '/c/a.txt' }, { mediaKind: 'document', path: '/c/b.txt' }], undefined)).toBe(
    'sent 2 files:\n/c/a.txt\n/c/b.txt',
  );
});
