import test from 'node:test';
import assert from 'node:assert/strict';
import * as runtime from '../features/tg-ctl/omp-live-runtime.mjs';

function source(text) {
  const content = Buffer.from(text);
  return { read: async (buffer, offset, length, position) => {
    const count = Math.min(2, length, Math.max(0, content.length - position));
    content.copy(buffer, offset, position, position + count);
    return { bytesRead: count };
  } };
}

test('bounded FD reads assemble legal short reads without truncating UTF-8', async () => {
  assert.equal(typeof runtime.readBoundedUtf8, 'function');
  assert.equal(await runtime.readBoundedUtf8(source('token-✓'), 9, 'too_large'), 'token-✓');
});

test('bounded FD reads reject the byte beyond the cap, including across short reads', async () => {
  assert.equal(typeof runtime.readBoundedUtf8, 'function');
  await assert.rejects(runtime.readBoundedUtf8(source('123456'), 5, 'too_large'), /too_large/);
  assert.equal(await runtime.readBoundedUtf8(source('12345'), 5, 'too_large'), '12345');
});
