#!/usr/bin/env node
/** Standalone entrypoint for the transport component; NOT a replacement tg-ctl daemon. */
import { lstat, mkdir, open, link, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { defaultRegistryRoot, listLiveEndpoints, sendLiveMessage, readBoundedUtf8 } from '../features/tg-ctl/omp-live-runtime.mjs';

const usage = `Usage:
  node tools/omp-live-cli.mjs status --json
  node tools/omp-live-cli.mjs send <pid> --request-id <id> [--session <id>] <text...>
  node tools/omp-live-cli.mjs install [--agent-root /absolute/path]

This client never creates or resumes an OMP agent. status/send require the live extension.
install adds one extension loader. Existing OMP needs a one-time saved stop/resume;
/reload in OMP 18.3 reloads plugins, not JS extension modules. Never resume a second copy.
`;

export async function installOmpLiveExtension(agentRoot) {
  if (!agentRoot.startsWith('/')) throw new Error('agent_root_must_be_absolute');
  const directory = join(agentRoot, 'extensions');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o022)) throw new Error('unsafe_extensions_directory');
  const target = join(directory, 'tg-omp-live.ts');
  const source = fileURLToPath(new URL('../features/tg-ctl/omp-live-extension.mjs', import.meta.url));
  const LOADER_MAX_BYTES = 65536;
  const marker = '// Managed by tg-cli omp-live (v1).';
  const runtime = new URL('../features/tg-ctl/omp-live-runtime.mjs', import.meta.url);
  const desired = `${marker}\nimport { readFileSync } from 'node:fs';\nimport { createHash } from 'node:crypto';\nconst source = new URL(${JSON.stringify(pathToFileURL(source).href)});\nconst runtime = new URL(${JSON.stringify(runtime.href)});\nconst revision = createHash('sha256').update(readFileSync(source)).update(readFileSync(runtime)).digest('hex');\nsource.searchParams.set('tg_revision', revision);\nexport default (await import(source.href)).default;\n`;
  let current = null;
  try {
    // Pin the inode before inspecting it: never read a pathname after checking it.
    // NONBLOCK makes a planted FIFO rejectable without blocking this installer.
    const existing = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const old = await existing.stat();
      if (!old.isFile() || (process.getuid && old.uid !== process.getuid()) || (old.mode & 0o022) || old.size > LOADER_MAX_BYTES) throw new Error('unsafe_extension_target');
      current = await readBoundedUtf8(existing, LOADER_MAX_BYTES, 'unsafe_extension_target');
    } finally { await existing.close(); }
    if (current === desired) return { installed: true, changed: false, path: target, restartRequired: true };
    // No force flag: user-owned contents are not silently repurposed.
    if (!current.startsWith(marker + '\n')) throw new Error('extension_target_is_user_owned');
    throw new Error('managed_loader_path_changed_requires_review');
  } catch (e) {
    if (['ELOOP', 'ENXIO', 'ENOTDIR'].includes(e.code)) throw new Error('unsafe_extension_target');
    if (e.code !== 'ENOENT') throw e;
  }
  const temp = `${target}.${randomBytes(8).toString('hex')}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(desired); } finally { await file.close(); }
  try { await link(temp, target); } finally { await unlink(temp).catch(() => {}); }
  return { installed: true, changed: true, path: target, restartRequired: true };
}

async function main(args) {
  if (!args.length || args[0] === '--help') { console.log(usage); return; }
  if (args[0] === 'status' && args.length === 2 && args[1] === '--json') {
    console.log(JSON.stringify(await listLiveEndpoints(defaultRegistryRoot())));
    return;
  }
  if (args[0] === 'install' && (args.length === 1 || (args.length === 3 && args[1] === '--agent-root'))) {
    console.log(JSON.stringify(await installOmpLiveExtension(args[2] ?? join(homedir(), '.omp', 'agent'))));
    return;
  }
  if (args[0] === 'send') {
    const pid = Number(args[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('exact_pid_required');
    let requestId, sessionId, i = 2;
    while (i < args.length && args[i].startsWith('--')) {
      if (args[i] === '--') { i++; break; }
      if (args[i] === '--request-id' && args[i + 1] && requestId === undefined) { requestId = args[i + 1]; i += 2; }
      else if (args[i] === '--session' && args[i + 1] && sessionId === undefined) { sessionId = args[i + 1]; i += 2; }
      else throw new Error('invalid_arguments');
    }
    if (!requestId) throw new Error('request_id_required');
    console.log(JSON.stringify(await sendLiveMessage({ pid, sessionId, requestId, text: args.slice(i).join(' ') })));
    return;
  }
  throw new Error('invalid_arguments');
}
export async function runOmpLiveCommand(args) {
  try { await main(args); return 0; }
  catch (e) {
    const message = /^[a-z_]+$/.test(e.message ?? '') ? e.message : 'operation_failed';
    console.error(JSON.stringify({ ok: false, error: message }));
    return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runOmpLiveCommand(process.argv.slice(2));
}
