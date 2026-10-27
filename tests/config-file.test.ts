import { afterEach, expect, test } from 'bun:test';
import { chmodSync, chownSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'node:crypto';
import { tempDir } from './helpers/test-temp';
import { CONFIG_MODELINE, readConfigFile, updateConfigFile, withConfigModeline } from '../features/config/config-file';
import { configSchemaText } from '../features/config/schema';
import { fsRoutesLockIo, type RoutesLockIo } from '../features/tg-ctl/routes';

const dirs: string[] = [];
function dir(): string { const p = tempDir('tg-config-file-'); dirs.push(p); return p; }
afterEach(() => { for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true }); });

test('annotation preserves BOM, CRLF, comments and unrelated YAML bytes; replaces stale preamble modelines', () => {
  const body = '# human comment\r\n# yaml-language-server: $schema=https://old.invalid/schema.json\r\n\r\ncontrol:\r\n  enabled: yes # keep\r\n';
  const expected = `\uFEFF${CONFIG_MODELINE}\r\n# human comment\r\n\r\ncontrol:\r\n  enabled: yes # keep\r\n`;
  expect(withConfigModeline(`\uFEFF${body}`)).toBe(expected);
  expect(withConfigModeline(expected)).toBe(expected);
  expect(withConfigModeline('message: |\n  # yaml-language-server: $schema=example\n')).toBe(`${CONFIG_MODELINE}\nmessage: |\n  # yaml-language-server: $schema=example\n`);
});

test('normal reads install current schema and annotation; repeat reads do not replace identical files', () => {
  const p = dir(); writeFileSync(join(p, 'config.yaml'), '# user\ncontrol:\n  enabled: true\n', { mode: 0o640 });
  expect(readConfigFile(p)).toContain('control:\n  enabled: true\n');
  expect(readFileSync(join(p, 'config.schema.json'), 'utf8')).toBe(configSchemaText());
  expect(readFileSync(join(p, 'config.yaml'), 'utf8')).toBe(`${CONFIG_MODELINE}\n# user\ncontrol:\n  enabled: true\n`);
  const config = statSync(join(p, 'config.yaml')); const schema = statSync(join(p, 'config.schema.json'));
  readConfigFile(p);
  expect(statSync(join(p, 'config.yaml')).ino).toBe(config.ino);
  expect(statSync(join(p, 'config.schema.json')).ino).toBe(schema.ino);
  expect(config.mode & 0o777).toBe(0o640);
});

test('read-only reads (help/version/dry-run callers) create nothing and retain existing bytes', () => {
  const p = join(dir(), 'absent'); expect(readConfigFile(p, { readOnly: true })).toBe(''); expect(existsSync(p)).toBe(false);
  mkdirSync(p); writeFileSync(join(p, 'config.yaml'), '# original\n');
  expect(readConfigFile(p, { readOnly: true })).toBe('# original\n');
  expect(existsSync(join(p, 'config.schema.json'))).toBe(false);
});

test('readable config survives metadata failures; read-only files cannot be replaced by writable-directory rename', () => {
  const p = dir(); writeFileSync(join(p, 'config.yaml'), 'control:\n  enabled: yes\n'); chmodSync(join(p, 'config.yaml'), 0o444);
  mkdirSync(join(p, 'config.schema.json'));
  expect(readConfigFile(p)).toBe('control:\n  enabled: yes\n');
  expect(updateConfigFile(p, () => 'replaced: true\n')).toBe(false);
  expect(readFileSync(join(p, 'config.yaml'), 'utf8')).toBe('control:\n  enabled: yes\n');
});

test('writes reread under the shared lock; contention skips rather than writing unlocked', () => {
  const p = dir(); const file = join(p, 'config.yaml'); writeFileSync(file, '# first\n');
  const lock: RoutesLockIo = { acquire: () => { writeFileSync(file, '# latest\n'); return true; }, release: () => {}, ownerDead: () => false, breakIfDead: () => {}, sleep: () => {} };
  expect(updateConfigFile(p, (raw) => `${raw}voice:\n  enabled: true\n`, { lockIo: lock })).toBe(true);
  expect(readFileSync(file, 'utf8')).toBe(`${CONFIG_MODELINE}\n# latest\nvoice:\n  enabled: true\n`);
  const held: RoutesLockIo = { ...lock, acquire: () => false };
  let called = false;
  expect(updateConfigFile(p, () => { called = true; return 'wrong'; }, { lockIo: held })).toBe(false);
  expect(called).toBe(false);
});

test('symlink config retains the link and resolves the local schema from both link and target directories', () => {
  const p = dir(); const targetDir = dir(); const target = join(targetDir, 'shared.yaml');
  writeFileSync(target, '# target\n'); symlinkSync(target, join(p, 'config.yaml'));
  readConfigFile(p);
  expect(lstatSync(join(p, 'config.yaml')).isSymbolicLink()).toBe(true);
  expect(readFileSync(target, 'utf8')).toBe(`${CONFIG_MODELINE}\n# target\n`);
  expect(readFileSync(join(p, 'config.schema.json'), 'utf8')).toBe(configSchemaText());
  expect(readFileSync(join(targetDir, 'config.schema.json'), 'utf8')).toBe(configSchemaText());
});

test('failed read never becomes a destructive empty-config write', () => {
  const p = dir(); mkdirSync(join(p, 'config.yaml'));
  expect(readConfigFile(p)).toBe('');
  expect(updateConfigFile(p, () => 'voice:\n')).toBe(false);
  expect(statSync(join(p, 'config.yaml')).isDirectory()).toBe(true);
});

test('voice updates retain unrelated CRLF bytes, comments and the annotation', async () => {
  const { upsertVoiceBlock, resolveVoiceConfig } = await import('../features/tg-ctl/voice');
  const p = dir();
  const before = '\uFEFF# owner\r\nfeatures:\r\n  auto-attach: false # retained\r\nvoice:\r\n  enabled: false\r\ncontrol:\r\n  enabled: true\r\n';
  writeFileSync(join(p, 'config.yaml'), before);
  expect(updateConfigFile(p, (raw) => upsertVoiceBlock(withConfigModeline(raw), resolveVoiceConfig({ enabled: true })))).toBe(true);
  const after = readFileSync(join(p, 'config.yaml'), 'utf8');
  expect(after.startsWith(`\uFEFF${CONFIG_MODELINE}\r\n# owner\r\nfeatures:\r\n  auto-attach: false # retained\r\n`)).toBe(true);
  expect(after.endsWith('control:\r\n  enabled: true\r\n')).toBe(true);
  expect(after.replace(/\r\n/g, '').includes('\n')).toBe(false);
});

test('external edits detected before rename are retained and reported as a failed write', () => {
  const p = dir(); const file = join(p, 'config.yaml'); writeFileSync(file, '# before\n');
  expect(updateConfigFile(p, () => { writeFileSync(file, '# editor saved\n'); return '# would clobber\n'; })).toBe(false);
  expect(readFileSync(file, 'utf8')).toBe('# editor saved\n');
});

test('normal reads replace stale schema metadata and initialize a missing config', () => {
  const p = dir(); writeFileSync(join(p, 'config.schema.json'), '{"old":true}\n');
  expect(readConfigFile(p)).toBe(`${CONFIG_MODELINE}\n`);
  expect(readFileSync(join(p, 'config.schema.json'), 'utf8')).toBe(configSchemaText());
});

test('a dangling symlink is never replaced with an empty config', () => {
  const p = dir(); const target = join(p, 'missing-target.yaml'); symlinkSync(target, join(p, 'config.yaml'));
  expect(readConfigFile(p)).toBe('');
  expect(updateConfigFile(p, () => 'voice:\n')).toBe(false);
  expect(lstatSync(join(p, 'config.yaml')).isSymbolicLink()).toBe(true);
  expect(existsSync(target)).toBe(false);
});


test('schema metadata symlinks are skipped without changing their target or the usable config', () => {
  const p = dir(); const target = join(dir(), 'unrelated.txt'); const schema = join(p, 'config.schema.json');
  writeFileSync(target, 'unrelated user contents\n');
  writeFileSync(join(p, 'config.yaml'), 'control:\n  enabled: true\n');
  symlinkSync(target, schema);
  const link = lstatSync(schema);
  expect(readConfigFile(p)).toBe(`${CONFIG_MODELINE}\ncontrol:\n  enabled: true\n`);
  expect(readFileSync(target, 'utf8')).toBe('unrelated user contents\n');
  expect(lstatSync(schema).isSymbolicLink()).toBe(true);
  expect(lstatSync(schema).ino).toBe(link.ino);
});

test('metadata skips hard-linked configs while explicit updates preserve their aliases and ownership', () => {
  const p = dir(); const file = join(p, 'config.yaml'); const alias = join(p, 'alias.yaml');
  const original = `control:\n  enabled: true\n# ${'previous setting '.repeat(20)}\n`;
  writeFileSync(file, original); linkSync(file, alias);
  const before = statSync(file);
  expect(readConfigFile(p)).toBe(original);
  expect(statSync(file).ino).toBe(before.ino);
  expect(readFileSync(alias, 'utf8')).toBe(original);
  expect(updateConfigFile(p, () => 'voice:\n  enabled: true\n')).toBe(true);
  const updated = `${CONFIG_MODELINE}\nvoice:\n  enabled: true\n`;
  expect(statSync(file).ino).toBe(before.ino);
  expect(statSync(alias).ino).toBe(before.ino);
  expect(statSync(file).uid).toBe(before.uid);
  expect(statSync(file).gid).toBe(before.gid);
  expect(readFileSync(file, 'utf8')).toBe(updated);
  expect(readFileSync(alias, 'utf8')).toBe(updated);
});

test('metadata refresh skips a held lock immediately while explicit writes retry under the lock', async () => {
  const { ensureConfigMetadata } = await import('../features/config/config-file');
  const p = dir(); const file = join(p, 'config.yaml'); writeFileSync(file, '# original\n');
  let attempts = 0; let sleeps = 0;
  const lock: RoutesLockIo = {
    acquire: () => ++attempts >= 3,
    release: () => {}, ownerDead: () => false, breakIfDead: () => {},
    sleep: () => { sleeps++; },
  };
  expect(ensureConfigMetadata(p, { lockIo: lock })).toBe(false);
  expect(attempts).toBe(1);
  expect(sleeps).toBe(0);
  expect(readFileSync(file, 'utf8')).toBe('# original\n');
  attempts = 0;
  expect(updateConfigFile(p, (raw) => `${raw}control:\n  enabled: true\n`, { lockIo: lock })).toBe(true);
  expect(attempts).toBe(3);
  expect(sleeps).toBe(2);
  expect(readFileSync(file, 'utf8')).toBe(`${CONFIG_MODELINE}\n# original\ncontrol:\n  enabled: true\n`);
});

const secondaryGroup = process.getgroups?.().find((gid) => gid !== process.getgid?.());
test.skipIf(process.platform === 'win32' || secondaryGroup === undefined)('atomic replacement preserves original ownership and a supplementary group', () => {
  const p = dir(); const file = join(p, 'config.yaml');
  writeFileSync(file, '# original\n', { mode: 0o640 });
  chownSync(file, process.getuid!(), secondaryGroup!);
  const original = statSync(file);
  expect(updateConfigFile(p, () => 'control:\n  enabled: true\n')).toBe(true);
  const updated = statSync(file);
  expect(updated.uid).toBe(original.uid);
  expect(updated.gid).toBe(original.gid);
  expect(updated.mode & 0o777).toBe(original.mode & 0o777);
});


test('explicit updates retain writable configs in read-only directories and respect the common config lock', () => {
  const p = dir(); const file = join(p, 'config.yaml'); const original = '# existing writable file\n';
  writeFileSync(file, original, { mode: 0o600 });
  const before = statSync(file);
  chmodSync(p, 0o555);
  try {
    expect(readConfigFile(p)).toBe(original);
    expect(existsSync(join(p, 'config.schema.json'))).toBe(false);
    expect(updateConfigFile(p, () => 'control:\n  enabled: true\n')).toBe(true);
    const expected = `${CONFIG_MODELINE}\ncontrol:\n  enabled: true\n`;
    expect(readFileSync(file, 'utf8')).toBe(expected);
    expect(statSync(file).ino).toBe(before.ino);
    expect(statSync(file).uid).toBe(before.uid);
    expect(statSync(file).gid).toBe(before.gid);
    const uid = process.geteuid?.() ?? process.getuid?.();
    const hash = createHash('sha256').update(realpathSync(file)).digest('hex');
    const lock = fsRoutesLockIo(join('/tmp', `tg-cli-config-locks-${uid}`, `${hash}.lock`));
    expect(lock.acquire()).toBe(true);
    try {
      expect(updateConfigFile(p, () => '# must not write while locked\n')).toBe(false);
      expect(readFileSync(file, 'utf8')).toBe(expected);
      expect(statSync(file).ino).toBe(before.ino);
    } finally { lock.release(); }
  } finally { chmodSync(p, 0o700); }
});
