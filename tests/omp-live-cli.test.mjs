import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, lstat, chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startLiveEndpoint } from '../features/tg-ctl/omp-live-runtime.mjs';
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../tools/omp-live-cli.mjs', import.meta.url));

test('standalone CLI lists and sends to an existing endpoint, not another OMP process', async t => {
  const config = await mkdtemp(join(tmpdir(), 'omp-cli-'));
  const received = [];
  const ep = await startLiveEndpoint({ root: join(config, 'omp-live'), snapshot: () => ({ sessionId: 'original', cwd: config, busy: false }), send: text => received.push(text) });
  t.after(async () => { await ep.close(); await rm(config, { recursive: true, force: true }); });
  const opts = { env: { ...process.env, TG_CTL_CONFIG_DIR: config }, timeout: 5000 };
  const status = JSON.parse((await exec(process.execPath, [cli, 'status', '--json'], opts)).stdout);
  assert.equal(status.length, 1);
  assert.equal(status[0].pid, process.pid);
  const reply = JSON.parse((await exec(process.execPath, [cli, 'send', String(process.pid), '--request-id', 'cli-proof', 'a real message'], opts)).stdout);
  assert.equal(reply.pid, process.pid);
  assert.deepEqual(received, ['a real message']);
});

test('installation is idempotent and does not overwrite a user-owned extension', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omp-cli-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const args = [cli, 'install', '--agent-root', root];
  assert.equal(JSON.parse((await exec(process.execPath, args)).stdout).changed, true);
  assert.equal(JSON.parse((await exec(process.execPath, args)).stdout).changed, false);
  const target = join(root, 'extensions', 'tg-omp-live.ts');
  await writeFile(target, '// personal extension\n');
  await assert.rejects(exec(process.execPath, args), e => e.stderr.includes('extension_target_is_user_owned'));
  assert.equal(await readFile(target, 'utf8'), '// personal extension\n');
});


test('new extension directory is private even under a permissive umask', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omp-cli-umask-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = `process.umask(0); const {runOmpLiveCommand}=await import(${JSON.stringify(new URL('../tools/omp-live-cli.mjs', import.meta.url).href)}); process.exitCode=await runOmpLiveCommand(['install','--agent-root',${JSON.stringify(root)}]);`;
  const result = await exec(process.execPath, ['--input-type=module', '-e', source]);
  assert.equal(JSON.parse(result.stdout).installed, true);
  assert.equal((await lstat(join(root, 'extensions'))).mode & 0o777, 0o700);
});

test('installation refuses an existing writable directory and a symlink target', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omp-cli-unsafe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'extensions');
  await mkdir(directory); await chmod(directory, 0o777);
  const args = [cli, 'install', '--agent-root', root];
  await assert.rejects(exec(process.execPath, args), e => e.stderr.includes('unsafe_extensions_directory'));
  assert.equal((await lstat(directory)).mode & 0o777, 0o777);
  await chmod(directory, 0o700);
  const personal = join(root, 'personal.ts'); await writeFile(personal, '// keep exactly');
  await symlink(personal, join(directory, 'tg-omp-live.ts'));
  await assert.rejects(exec(process.execPath, args), e => e.stderr.includes("unsafe_extension_target"));
  assert.equal(await readFile(personal, 'utf8'), '// keep exactly');
});


test('a planted FIFO cannot block extension installation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omp-cli-fifo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'extensions'), { mode: 0o700 });
  await exec('mkfifo', [join(root, 'extensions', 'tg-omp-live.ts')]);
  await assert.rejects(exec(process.execPath, [cli, 'install', '--agent-root', root], { timeout: 1500 }),
    e => !e.killed && e.stderr.includes('unsafe_extension_target'));
});


test('loader write permissions and size are rejected without modifying the file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omp-cli-target-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'extensions'), { mode: 0o700 });
  const target = join(root, 'extensions', 'tg-omp-live.ts');
  await writeFile(target, '// user file'); await chmod(target, 0o666);
  await assert.rejects(exec(process.execPath, [cli, 'install', '--agent-root', root]), e => e.stderr.includes('unsafe_extension_target'));
  assert.equal(await readFile(target, 'utf8'), '// user file');
  await chmod(target, 0o600); await writeFile(target, 'x'.repeat(65537));
  await assert.rejects(exec(process.execPath, [cli, 'install', '--agent-root', root]), e => e.stderr.includes('unsafe_extension_target'));
  assert.equal((await readFile(target)).length, 65537);
});
