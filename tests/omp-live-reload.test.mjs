// Installed OMP requires a saved restart, NOT hot reload, for JS extension changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, appendFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const exec = promisify(execFile);
test('a fresh process loads current adapter and runtime after a saved restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omp-loader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of ['extensions/omp-live.ts', 'features/tg-ctl/omp-live-extension.mjs', 'features/tg-ctl/omp-live-runtime.mjs']) {
    const dst = join(root, file); await mkdir(join(dst, '..'), { recursive: true });
    await copyFile(new URL('../' + file, import.meta.url), dst);
  }
  const runner = join(root, 'probe.mjs');
  await writeFile(runner, "import bridge from './extensions/omp-live.ts'; console.log(JSON.stringify({type:typeof bridge,revision:globalThis.__loaderTestRevision??'initial'}));\n");
  const launch = async () => JSON.parse((await exec(process.execPath, [runner], { timeout: 5000 })).stdout);
  assert.deepEqual(await launch(), { type: 'function', revision: 'initial' });
  await appendFile(join(root, 'features/tg-ctl/omp-live-runtime.mjs'), "\nglobalThis.__loaderTestRevision = 'runtime-updated';\n");
  assert.deepEqual(await launch(), { type: 'function', revision: 'runtime-updated' });
  await appendFile(join(root, 'features/tg-ctl/omp-live-extension.mjs'), "\nglobalThis.__loaderTestRevision += '+adapter-updated';\n");
  assert.deepEqual(await launch(), { type: 'function', revision: 'runtime-updated+adapter-updated' });
});
