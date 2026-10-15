// The unattached-file gate (features/cli/file-mention-gate.ts): an agent message whose prose
// names an existing local file it does not attach is refused with the exact `--file` fix.
// tg#22056 told the CTO "Черновик … ~/work/weekly-report-mari.md, проверь перед отправкой"
// with nothing attached — a path the reader cannot open on a phone.
import { expect, test } from 'bun:test';
import {
  type FileIdentity,
  formatUnattachedFileError,
  MAX_ATTACH_BYTES,
  pathMentions,
  unattachedFileMentions,
} from '../features/cli/file-mention-gate';

const HOME = '/home/u';
const CWD = '/home/u/work';

// An in-memory disk: absolute path → identity. Directories have isFile false; files default
// to 100 bytes, mode 0644, no symlink (realPath = the path).
function disk(entries: Record<string, Partial<FileIdentity>>): (path: string) => FileIdentity | null {
  return (path) => {
    const e = entries[path];
    if (!e) return null;
    return {
      isFile: e.isFile ?? true,
      size: e.size ?? 100,
      mode: e.mode ?? 0o644,
      id: e.id ?? path,
      realPath: e.realPath ?? path,
    };
  };
}

const ROOTS = [HOME, '/tmp'];
const deps = (entries: Record<string, Partial<FileIdentity>>) => ({ cwd: CWD, home: HOME, documentRoots: ROOTS, stat: disk(entries) });

const MSG_22056 =
  'Конлока за последние часы:\n' +
  '• Правила записаны в ~/work/CONLOCA-AGENT-RULES.md.\n' +
  '• Черновик недельного отчёта для Мари: ~/work/weekly-report-mari.md, проверь перед отправкой.\n' +
  '• Стек StateBus из #84 заморожен до ответа Danny (tg#21644).';

test('tg#22056: both ~/ paths are named, neither attached → both reported, resolved absolute', () => {
  const found = unattachedFileMentions(MSG_22056, [], deps({
    '/home/u/work/CONLOCA-AGENT-RULES.md': {},
    '/home/u/work/weekly-report-mari.md': { size: 8 * 1024 },
  }));
  expect(found).toEqual([
    { mention: '~/work/CONLOCA-AGENT-RULES.md', path: '/home/u/work/CONLOCA-AGENT-RULES.md' },
    { mention: '~/work/weekly-report-mari.md', path: '/home/u/work/weekly-report-mari.md' },
  ]);
});

test('absolute and ./ paths count; trailing punctuation and line-specs are not part of the path', () => {
  expect(pathMentions('see /etc/hosts. and ./notes/a.md:12, also (~/x.txt#L3-L5) and ~/y.md:7.')).toEqual([
    '/etc/hosts',
    './notes/a.md',
    '~/x.txt',
    '~/y.md',
  ]);
  const found = unattachedFileMentions('Отчёт: ./out/report.pdf; лог /tmp/run/app.log:42', [], deps({
    '/home/u/work/out/report.pdf': {},
    '/tmp/run/app.log': {},
  }));
  expect(found.map((f) => f.path)).toEqual(['/home/u/work/out/report.pdf', '/tmp/run/app.log']);
});

test('a file attached with --file is not reported — by the same spelling, another spelling, or a symlink', () => {
  const stat = disk({ '/home/u/work/r.md': { id: 'ino-1' }, '/home/u/link.md': { id: 'ino-1' } });
  const opts = { cwd: CWD, home: HOME, documentRoots: ROOTS, stat };
  expect(unattachedFileMentions('см. ~/work/r.md', ['~/work/r.md'], opts)).toEqual([]);
  expect(unattachedFileMentions('см. /home/u/work/r.md', ['r.md'], opts)).toEqual([]);
  expect(unattachedFileMentions('см. ~/link.md', ['/home/u/work/r.md'], opts)).toEqual([]);
});

test('a symlink is judged by what it points at: a link under home to a system file or a secret does not count', () => {
  const found = unattachedFileMentions('см. ~/report.md и ~/notes.txt и ~/draft.md', [], deps({
    '/home/u/report.md': { realPath: '/etc/hosts' },
    '/home/u/notes.txt': { realPath: '/home/u/app/.env' },
    '/home/u/draft.md': { realPath: '/home/u/drafts/draft-v2.md' },
  }));
  expect(found).toEqual([{ mention: '~/draft.md', path: '/home/u/draft.md' }]);
});

test('paths in code — fenced, inline backticks, <code>/<pre>, a $ command line — never count', () => {
  const entries = deps({ '/home/u/work/r.md': {} });
  for (const body of [
    'Run `cat ~/work/r.md` to see it.',
    '```\nless /home/u/work/r.md\n```',
    '<p>Run <code>cat ./r.md</code></p>',
    '<pre>cat ~/work/r.md</pre>',
    'Команда:\n$ cat ~/work/r.md\nи всё.',
    '<blockquote>~/work/r.md</blockquote>',
  ]) {
    expect(unattachedFileMentions(body, [], entries)).toEqual([]);
  }
});

test('directories, missing files, empty files and files over the upload limit do not count', () => {
  const found = unattachedFileMentions(
    'wt: /home/u/work/wt-gl361, gone: ~/nope.md, empty: ~/empty.log, huge: ~/dump.bin',
    [],
    deps({
      '/home/u/work/wt-gl361': { isFile: false },
      '/home/u/empty.log': { size: 0 },
      '/home/u/dump.bin': { size: MAX_ATTACH_BYTES + 1 },
    }),
  );
  expect(found).toEqual([]);
});

test('system files, scripts/binaries, private (0600) files and secrets are references, not documents', () => {
  // Real misses from the history: «commit=5 в /etc/fstab», «sudo ~/…/apply.sh — ждёт тебя»,
  // «ключ из ~/.runpod/config.toml» (0600, holds an API key), a `#!/usr/bin/env` in a ticket title.
  const found = unattachedFileMentions(
    'commit=5 в /etc/fstab; sudo ~/fixes/apply.sh; ключ из ~/.runpod/config.toml; #!/usr/bin/env bash; см. ~/app/.env',
    [],
    deps({
      '/etc/fstab': {},
      '/usr/bin/env': { mode: 0o755 },
      '/home/u/fixes/apply.sh': { mode: 0o775 },
      '/home/u/.runpod/config.toml': { mode: 0o600 },
      '/home/u/app/.env': {},
    }),
  );
  expect(found).toEqual([]);
});

test('URLs, slash words and bot commands are not paths', () => {
  expect(pathMentions('https://example.com/a/b.md и/или $0.16/h, PR/коммит, /status, file:///home/u/r.md')).toEqual([
    '/status',
  ]);
});

test('one file named twice is reported once', () => {
  const found = unattachedFileMentions('~/work/r.md … снова /home/u/work/r.md и ./r.md', [], deps({
    '/home/u/work/r.md': {},
  }));
  expect(found).toEqual([{ mention: '~/work/r.md', path: '/home/u/work/r.md' }]);
});

test('the refusal names each file and the exact command to resend with it attached', () => {
  const msg = formatUnattachedFileError(
    [{ mention: '~/work/weekly-report-mari.md', path: '/home/u/work/weekly-report-mari.md' }],
    ['--tag', 'report', MSG_22056],
  );
  expect(msg).toContain('~/work/weekly-report-mari.md');
  expect(msg).toContain('--file /home/u/work/weekly-report-mari.md');
  // The original flags come back verbatim; the long text is not echoed.
  expect(msg).toContain("tg --file /home/u/work/weekly-report-mari.md --tag report '<the same message text>'");
  expect(msg).not.toContain('StateBus');
});

test('the resend command shell-quotes a path that needs it', () => {
  const msg = formatUnattachedFileError([{ mention: '~/a&b.md', path: '/home/u/a&b.md' }], ['hi']);
  expect(msg).toContain(`tg --file '/home/u/a&b.md' hi`);
});

test('a long flag value is echoed as is; only the message text is elided; --dry-run is dropped', () => {
  const photo = `/home/u/very/deep/project/dir/screenshots/screenshot-2026-10-15-at-14.03.22-${'x'.repeat(20)}.png`;
  const title = 'T'.repeat(90);
  const msg = formatUnattachedFileError(
    [{ mention: '~/r.md', path: '/home/u/r.md' }],
    ['--dry-run', '--photo', photo, '--title', title, MSG_22056],
  );
  expect(msg).toContain(`tg --file /home/u/r.md --photo ${photo} --title ${title} '<the same message text>'`);
});

test('two files: the refusal says so and attaches both', () => {
  const msg = formatUnattachedFileError(
    [
      { mention: '~/a.md', path: '/home/u/a.md' },
      { mention: '~/b.md', path: '/home/u/b.md' },
    ],
    ['hi'],
  );
  expect(msg).toContain('names 2 local files without attaching them');
  expect(msg).toContain('tg --file /home/u/a.md --file /home/u/b.md hi');
});
