// Shared config-file I/O for the transmitter and daemon. Metadata is best-effort:
// an editor schema must never prevent a readable user config from being loaded.
import { accessSync, chmodSync, chownSync, closeSync, constants, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync, type Stats } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { createHash, randomUUID } from 'node:crypto';
import { fsRoutesLockIo, withRoutesLock, type RoutesLockIo } from '../tg-ctl/routes';
import { configSchemaText } from './schema';

export const CONFIG_MODELINE = '# yaml-language-server: $schema=./config.schema.json';

// Only inspect the comment/blank preamble: a similar line inside a YAML scalar
// is user data. Keep the original BOM, line endings, comments, and trailing bytes.
export function withConfigModeline(raw: string): string {
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = raw.slice(bom.length);
  const eol = body.match(/\r?\n/)?.[0] ?? '\n';
  const lines = body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let preamble = true;
  const kept = lines.filter((line) => {
    const text = line.replace(/\r?\n$/, '');
    if (preamble && /^#\s*yaml-language-server\s*:.*\$schema\s*=/.test(text)) return false;
    if (text.trim() !== '' && !text.trimStart().startsWith('#')) preamble = false;
    return true;
  }).join('');
  return `${bom}${CONFIG_MODELINE}${eol}${kept}`;
}

export interface ConfigFileOptions {
  // Help, version and dry-run paths explicitly opt out of all filesystem writes.
  readOnly?: boolean;
  // Injectable to exercise contention and read-after-acquire without processes.
  lockIo?: RoutesLockIo;
}

function readOrMissing(path: string): string {
  try { return readFileSync(path, 'utf8'); }
  catch (error) {
    // A dangling symlink is not an absent config; never replace it with defaults.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !existsSync(path)) {
      try { lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''; }
    }
    throw error;
  }
}

function targetPath(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try { lstatSync(path); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        // Resolve existing ancestors too: a missing config under a symlinked
        // directory must keep the same lock identity once the file is created.
        const parent = dirname(resolve(path));
        if (parent !== resolve(path)) return join(targetPath(parent), basename(path));
      }
    }
    throw error;
  }
}

function directoryWritable(path: string): boolean {
  try {
    if ((statSync(path).mode & 0o222) === 0) return false;
    accessSync(path, constants.W_OK);
    return true;
  } catch { return false; }
}

// One namespace for ALL config writers, independent of HOME/TMPDIR and parent
// permissions. Never switch lock paths as permissions change. The private root
// is validated rather than repairing or following an unsafe existing entry.
// This coordinates this OS user's local app processes, not other users/hosts.
function configLockIo(target: string): RoutesLockIo {
  const uid = process.geteuid?.() ?? process.getuid?.();
  if (uid === undefined) throw new Error('config locking requires a Unix user identity');
  const root = join('/tmp', `tg-cli-config-locks-${uid}`);
  try { mkdirSync(root, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const info = lstatSync(root);
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0) {
    throw new Error('unsafe config lock directory');
  }
  const hash = createHash('sha256').update(target).digest('hex');
  return fsRoutesLockIo(join(root, `${hash}.lock`));
}

// Explicit writes can retain hard links and group-writable foreign ownership by
// updating the same inode. This rare fallback is NOT atomic for readers: they may
// observe intermediate bytes, and an I/O error can leave a partial update. Metadata
// refreshes never use it. The application lock still serializes our own writers.
function replaceInPlace(path: string, value: string, expected: string, original: Stats): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== original.dev || opened.ino !== original.ino ||
        opened.uid !== original.uid || opened.gid !== original.gid || (opened.mode & 0o222) === 0) return false;
    if (readFileSync(fd, 'utf8') !== expected) return false;
    // Validate the named entry again after opening, as well as the fd identity:
    // a swapped symlink must not redirect an in-place write to another file.
    const latest = lstatSync(path);
    if (!latest.isFile() || latest.dev !== opened.dev || latest.ino !== opened.ino) return false;
    const bytes = Buffer.from(value, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (written === 0) throw new Error('config write made no progress');
      offset += written;
    }
    ftruncateSync(fd, bytes.length);
    return true;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Single-link replacements are atomic for readers. External editors do not take
// our lock: identity/content checks catch edits during preparation, but an editor
// can still race the final check→rename/write. This is not a transaction spanning
// editor processes or two files. Explicit writes alone may use the fallback above.
function replaceIfChanged(path: string, value: string, expected: string, allowInPlace = false): boolean {
  const original = existsSync(path) ? lstatSync(path) : undefined;
  // Config symlinks are resolved separately; schema symlinks are never followed.
  if (original && (!original.isFile() || (original.nlink > 1 && !allowInPlace))) return false;
  if (original && readFileSync(path, 'utf8') === value) return true;
  if (original) {
    // Rename in a writable directory could otherwise replace a read-only file.
    if ((original.mode & 0o222) === 0) return false;
    accessSync(path, constants.W_OK);
    if (original.nlink > 1) return replaceInPlace(path, value, expected, original);
  }
  if (!directoryWritable(dirname(path))) {
    return allowInPlace && original ? replaceInPlace(path, value, expected, original) : false;
  }
  const temp = join(dirname(path), `.config-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, value, { flag: 'wx', mode: original ? original.mode & 0o777 : 0o600 });
    if (original) {
      const created = statSync(temp);
      if (created.uid !== original.uid || created.gid !== original.gid) {
        try { chownSync(temp, original.uid, original.gid); }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (allowInPlace && (code === 'EPERM' || code === 'EINVAL')) return replaceInPlace(path, value, expected, original);
          throw error;
        }
        const owned = statSync(temp);
        if (owned.uid !== original.uid || owned.gid !== original.gid) {
          return allowInPlace ? replaceInPlace(path, value, expected, original) : false;
        }
      }
      // chown may clear mode bits, so restore permissions afterward.
      chmodSync(temp, original.mode & 0o777);
    }
    const latest = existsSync(path) ? lstatSync(path) : undefined;
    if (original ? !latest || !latest.isFile() || latest.nlink > 1 || latest.dev !== original.dev || latest.ino !== original.ino : !!latest) return false;
    if (readOrMissing(path) !== expected) return false;
    renameSync(temp, path);
    return true;
  } finally {
    try { unlinkSync(temp); } catch {}
  }
}

function installSchema(dir: string): void {
  const path = join(dir, 'config.schema.json');
  try { if (lstatSync(path).isSymbolicLink()) return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // Keep the logical pathname: rename replaces this entry rather than following
  // a schema link into an unrelated user file. Linked metadata is left alone.
  replaceIfChanged(path, configSchemaText(), readOrMissing(path));
}

// Returns false on lock contention, unreadable/readonly files, failed transforms
// or failed writes. Read the latest contents only after acquiring the same lock
// used by every config writer. No unlocked fallback on sustained contention.
function changeConfigFile(configDir: string, transform: (raw: string) => string, options: ConfigFileOptions, metadataOnly: boolean): boolean {
  if (options.readOnly) return false;
  try {
    const logical = resolve(configDir, 'config.yaml');
    const target = targetPath(logical);
    const parent = dirname(target);
    if (!existsSync(parent)) {
      let ancestor = parent;
      while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
      if (!directoryWritable(ancestor)) return false;
      mkdirSync(parent, { recursive: true });
    }
    const parentWritable = directoryWritable(parent);
    // Metadata never changes files in a read-only directory. An explicit update
    // can still use an existing writable inode, under the same external lock.
    if (!parentWritable && (metadataOnly || !existsSync(target))) return false;
    const result = withRoutesLock(options.lockIo ?? configLockIo(target), () => {
      if (targetPath(logical) !== target) return false;
      const current = readOrMissing(target);
      const updated = withConfigModeline(transform(current));
      // Relative schema references can be resolved against the logical path or
      // the symlink target, depending on the editor. Supply both local copies.
      for (const dir of new Set([dirname(logical), dirname(target)])) {
        try { installSchema(dir); } catch { /* schema metadata is optional */ }
      }
      if (targetPath(logical) !== target) return false;
      return replaceIfChanged(target, updated, current, !metadataOnly);
    }, { attempts: metadataOnly ? 1 : 200, delayMs: 10, onContended: 'skip' });
    return result === true;
  } catch { return false; }
}

// Metadata must not delay a send or alter hard-linked/group-owned user files
// through the non-atomic fallback. Contention is a best-effort skip on one try.
export function ensureConfigMetadata(configDir: string, options: ConfigFileOptions = {}): boolean {
  return changeConfigFile(configDir, (raw) => raw, options, true);
}

// Explicit updates wait up to about two seconds for cooperating writers, then
// fail rather than ever writing unlocked. They may retain an existing inode via
// the documented fallback when atomic replacement cannot preserve its identity.
export function updateConfigFile(configDir: string, transform: (raw: string) => string, options: ConfigFileOptions = {}): boolean {
  return changeConfigFile(configDir, transform, options, false);
}

export function readConfigFile(configDir: string, options: ConfigFileOptions = {}): string {
  const path = join(configDir, 'config.yaml');
  let raw: string;
  try { raw = readOrMissing(path); } catch { return ''; }
  if (options.readOnly) return raw;
  ensureConfigMetadata(configDir, options);
  try { return readOrMissing(path); } catch { return raw; }
}
