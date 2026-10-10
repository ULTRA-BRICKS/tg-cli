// Run by temp-hygiene.test.ts as a child `bun test` that gets SIGTERMed mid-test: it makes a
// tracked temp dir, says so, and then waits to be killed.
import { test } from 'bun:test';
import { tempDir } from '../helpers/test-temp';

test('waits to be interrupted', async () => {
  console.log(`READY ${tempDir('tg-interrupted-')}`);
  await Promise.withResolvers<void>().promise;
}, 60_000);
