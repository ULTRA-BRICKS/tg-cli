import { expect, test } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { isNeverAttach } from '../features/auto-attach/denylist';
import { parseArgs } from '../features/cli/args';
import { tempDir } from './helpers/test-temp';

// --- pattern matching (basename-based) ---

const BLOCKED = [
  '.env',
  '.env.local',
  '.env.production',
  'prod.env',
  'staging.env',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'server.pem',
  'private.key',
  'cert.p12',
  'bundle.pfx',
  'app.jks',
  'release.keystore',
  'login.ppk',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.htpasswd',
  '.pgpass',
  '.my.cnf',
  '.bash_history',
  '.zsh_history',
  '.psql_history',
  '.node_repl_history',
  'terraform.tfvars',
  'secrets.auto.tfvars',
  'credentials',
  'credentials.json',
  'client_secret_12345.json',
  'kubeconfig',
  // tg-ctl state: the message history is a full conversation transcript, the
  // routes map leaks pane→project layout, and the last-user-target anchor
  // (tg-cli#78) leaks the CTO's active pane id + project cwd — none must ride
  // a Telegram attach.
  'tg-ctl.123456.history.jsonl',
  'tg-ctl.987.routes.json',
  'tg-ctl.987.sessions.json',
  'tg-ctl.987.sessions.json.tmp',
  'tg-ctl.987.last-user-target.json',
  // the anchor's own write-then-rename staging file (review finding): a crash
  // or failed rename can orphan this on disk with the same sensitive content.
  'tg-ctl.987.last-user-target.json.tmp.4242',
  // legacy pre-rename filename (tg-cli#281): kept denylisted permanently — a
  // pre-upgrade install (or a migration that never ran) can still have this
  // on disk with the same sensitive pane id + cwd.
  'tg-ctl.987.last-alex-target.json',
  'tg-ctl.987.last-alex-target.json.tmp.4242',
];

const ALLOWED = [
  'environment.ts',
  'envelope.md',
  'env.md',
  'dotenv.ts',
  'id_rsa.pub',
  'turkey.md',
  'monkey.png',
  'keynote.pdf',
  'history.md',
  'npmrc-docs.md',
  'report.json',
  'config.yaml',
  'terraform.tf',
  'credentials-guide.md',
];

test('denylist: secret-looking basenames are blocked', () => {
  for (const name of BLOCKED) {
    expect(isNeverAttach(`/some/dir/${name}`)).toBe(true);
  }
});

test('denylist: ordinary files are not blocked', () => {
  for (const name of ALLOWED) {
    expect(isNeverAttach(`/some/dir/${name}`)).toBe(false);
  }
});

test('denylist: matches the basename, not the directory', () => {
  expect(isNeverAttach('/home/user/.env/readme.md')).toBe(false);
  expect(isNeverAttach('readme.md')).toBe(false);
  expect(isNeverAttach('.env')).toBe(true);
});

// --- parseArgs integration ---

const dir = tempDir('tg-denylist-');
writeFileSync(join(dir, 'prod.env'), 'TOKEN=supersecret\n');
writeFileSync(join(dir, 'normal.ts'), 'export const x = 1\n');
writeFileSync(join(dir, 'tg-ctl.987.last-user-target.json'), '{"paneId":"%3","cwd":"/repo","ts":1}\n');
writeFileSync(join(dir, 'tg-ctl.987.last-alex-target.json'), '{"paneId":"%3","cwd":"/repo","ts":1}\n');

test('explicit --file of a denylisted file is a hard error', () => {
  const r = parseArgs(['--file', join(dir, 'prod.env'), 'oops'], dir, dir);
  expect(r.action).toBe('error');
  if (r.action === 'error') {
    expect(r.message).toContain('prod.env');
    expect(r.message).toContain('--no-feature attach-denylist');
  }
});

test('explicit --photo of a denylisted file is also an error', () => {
  const r = parseArgs(['--photo', join(dir, 'prod.env'), 'oops'], dir, dir);
  expect(r.action).toBe('error');
});

test('a denylisted file named in the text is not attached, token stays in text', () => {
  const r = parseArgs([`leaked ${join(dir, 'prod.env')} here`], dir, dir);
  expect(r.action).toBe('send');
  if (r.action === 'send') {
    expect(r.items).toEqual([]);
    expect(r.caption).toContain('prod.env');
  }
});

test('explicit --file of the last-user-target anchor state file is a hard error', () => {
  const r = parseArgs(['--file', join(dir, 'tg-ctl.987.last-user-target.json'), 'oops'], dir, dir);
  expect(r.action).toBe('error');
  if (r.action === 'error') expect(r.message).toContain('last-user-target.json');
});

test('explicit --file of a legacy last-alex-target anchor file is still a hard error (tg-cli#281)', () => {
  const r = parseArgs(['--file', join(dir, 'tg-ctl.987.last-alex-target.json'), 'oops'], dir, dir);
  expect(r.action).toBe('error');
  if (r.action === 'error') expect(r.message).toContain('last-alex-target.json');
});

test('--no-feature attach-denylist override: explicit attach goes through', () => {
  const r = parseArgs(['--file', join(dir, 'prod.env'), 'I know what I am doing'], dir, dir, { attachDenylist: false });
  expect(r.action).toBe('send');
  if (r.action === 'send') expect(r.items.length).toBe(1);
});

test('denylist does not affect ordinary explicit files (regression)', () => {
  const r = parseArgs(['--file', join(dir, 'normal.ts'), 'see it'], dir, dir);
  expect(r.action).toBe('send');
  if (r.action === 'send') expect(r.items.length).toBe(1);
});
