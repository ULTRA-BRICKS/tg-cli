// The model-render dimension gate (features/cli/dimension-gate.ts, tg-cli#785): scope detection,
// per-image verification and the refusal text, with an in-memory disk and a fake `3d` check.
import { expect, test } from 'bun:test';
import {
  attachedImages,
  decideDimensionGate,
  formatDimensionGateError,
  isWrittenReason,
  SKIP_ENV,
  skipRequestText,
  threeDContexts,
  verifyImages,
} from '../features/cli/dimension-gate';

const disk = (...paths: string[]) => ({ cwd: '/home/u/xp/garage-band/projects/spoon-handle', home: '/home/u', exists: (p: string) => paths.includes(p) });
const PHOTO = (path: string) => ({ type: 'photo' as const, path });

test('attachedImages: every --photo and an image --file, resolved against cwd; other documents are not images', () => {
  expect(
    attachedImages(
      [PHOTO('a.png'), { type: 'document', path: 'b.JPG' }, { type: 'document', path: 'c.pdf' }, PHOTO('/x/d.png'), PHOTO('~/e.png')],
      '/w',
      '/home/u',
    ),
  ).toEqual(['/w/a.png', '/w/b.JPG', '/x/d.png', '/home/u/e.png']);
});

test('a cwd under a garage-band projects/ tree is a 3D context', () => {
  expect(threeDContexts('готово', [], disk()).join('\n')).toContain('is in a 3D project');
});

test('a worktree checkout of garage-band or 3d-cli counts; its docs/ tree and other repos do not', () => {
  const at = (cwd: string) => threeDContexts('done', [], { cwd, home: '/home/u', exists: () => false });
  expect(at('/home/u/xp/garage-band/.worktrees/spoon150-k1se/projects/spoon-handle/print')).not.toEqual([]);
  expect(at('/home/u/.config/superpowers/worktrees/3d-cli/feat-x/projects/demo')).not.toEqual([]);
  expect(at('/home/u/xp/garage-band/docs')).toEqual([]);
  expect(at('/home/u/xp/tg-cli')).toEqual([]);
});

test('a directory holding 3d.yaml marks a 3D project, found from a subdirectory too', () => {
  const deps = { cwd: '/home/u/work/mount/previews', home: '/home/u', exists: (p: string) => p === '/home/u/work/mount/3d.yaml' };
  expect(threeDContexts('x', [], deps).join('\n')).toContain('/home/u/work/mount holds 3d.yaml');
});

test('an image in a 3D project counts even when the cwd is elsewhere', () => {
  const deps = { cwd: '/home/u/xp/tg-cli', home: '/home/u', exists: () => false };
  const ctx = threeDContexts('done', ['/home/u/xp/garage-band/projects/spoon-handle/previews/a.png'], deps);
  expect(ctx.join('\n')).toContain('image a.png');
});

test('the caption alone makes it 3D work: specific terms only', () => {
  const none = { cwd: '/home/u/xp/tg-cli', home: '/home/u', exists: () => false };
  const yes = [
    'Файл spoon.stl готов',
    'spoon150_k1se_oriented.stl, 2 ч 20 мин',
    'модель для печати готова',
    'печать ложки на K1 SE',
    'PLA filament 17 g',
    '3D render',
    'проверь 3д модель',
    'ready: G-code sliced',
    'ложка 150 мм',
    'spoon150_k1se_oriented.stl: 150 mm',
    'base.3mf sliced',
    'PETG filament 17 g',
    'filament 17 g',
  ];
  for (const text of yes) expect(threeDContexts(text, [], none).length, text).toBeGreaterThan(0);
  const no = [
    'Dashboard screenshot',
    'fix the imprint bug',
    'sprinter results',
    'tg-cli отчёт',
    'сравнение моделей по latency',
    'Переключил модель на Sonnet, печатает ответы быстрее',
    'removed the debug print statement',
    'uptime over the last 3d',
    'опечатка в README',
    'STL container benchmark',
    'Filament admin panel after the fix',
    'filament renderer demo',
  ];
  for (const text of no) expect(threeDContexts(text, [], none), text).toEqual([]);
});

test('an image reached through a symlink is judged by its real path', () => {
  const deps = {
    cwd: '/home/u/xp/tg-cli',
    home: '/home/u',
    exists: () => false,
    real: (p: string) => p.replace('/home/u/gb/', '/home/u/xp/garage-band/'),
  };
  const ctx = threeDContexts('done', ['/home/u/gb/projects/spoon/print/plain.png'], deps);
  expect(ctx.join('\n')).toContain('image plain.png');
});

test('a send with no image is out of scope however 3D the text is', () => {
  expect(decideDimensionGate('spoon.stl is ready', [], disk())).toEqual({ contexts: [], images: [] });
});

test('the same image attached twice is examined once; bmp/heic files count as images', () => {
  const r = decideDimensionGate('stl', [PHOTO('/p/a.png'), { type: 'document', path: '/p/a.png' }, { type: 'document', path: '/p/b.bmp' }], disk('/p/a.png', '/p/b.bmp'));
  expect(r.images).toEqual(['/p/a.png', '/p/b.bmp']);
});

test('a missing image file is not examined (the send itself skips it)', () => {
  expect(decideDimensionGate('stl', [PHOTO('/nope.png')], disk()).images).toEqual([]);
});

test('verifyImages: no sidecar, failing check, check that cannot run, and a pass', () => {
  const exists = (p: string) => ['/b.png.dims.json', '/c.png.dims.json', '/d.png.dims.json', '/e.png.dims.json', '/f.png.dims.json'].includes(p);
  const verdicts = verifyImages(['/a.png', '/b.png', '/c.png', '/d.png', '/e.png', '/f.png'], {
    exists,
    check: (p) => {
      if (p === '/b.png') {
        return { code: 1, output: 'FAIL: 1 legibility offender(s) on /b.png\n  - X [top]: font-too-small — font 9.0 px at 1280 px width < 14 px' };
      }
      if (p === '/c.png') return { code: 127, output: '3d: command not found' };
      if (p === '/e.png') return { code: null, output: 'Error: Executable not found in $PATH: "3d"' };
      if (p === '/f.png') return { code: 2, output: 'usage: 3d dimension' };
      return { code: 0, output: 'PASS' };
    },
  });
  expect(verdicts[0].problems[0]).toContain('no a.png.dims.json');
  expect(verdicts[1].problems).toEqual(['X [top]: font-too-small — font 9.0 px at 1280 px width < 14 px']);
  expect(verdicts[2].problems[0]).toContain('could not run: 3d: command not found');
  expect(verdicts[3].problems).toEqual([]);
  expect(verdicts[4].problems[0]).toContain('could not run: Error: Executable not found');
  expect(verdicts[5].problems[0]).toContain('could not run: usage: 3d dimension');
});

test('isWrittenReason: needs words, not a bare flag', () => {
  for (const bad of [undefined, '', '1', 'skip', 'not a model', '   ', 'thumbnail only']) expect(isWrittenReason(bad), String(bad)).toBe(false);
  expect(isWrittenReason('a UI thumbnail of the dashboard, not a model')).toBe(true);
});

test('the refusal names the context, the failing image and the exact commands', () => {
  const text = formatDimensionGateError(
    ['cwd: /p is in a 3D project'],
    [
      { path: '/p/plain.png', problems: ['no plain.png.dims.json — it was not rendered by `3d dimension`'] },
      { path: '/p/ok.png', problems: [] },
    ],
  );
  expect(text).toContain('3D context — cwd: /p is in a 3D project');
  expect(text).toContain('/p/plain.png');
  expect(text).not.toContain('/p/ok.png');
  expect(text).toContain('3d dimension <model.stl|3mf|scad> -o <render.png>');
  expect(text).toContain(SKIP_ENV);
  expect(text).toContain('at least 3 words and 15 characters');
});

test('the refusal explains a rejected or unapproved reason instead of repeating the advice', () => {
  const verdicts = [{ path: '/p/plain.png', problems: ['no plain.png.dims.json'] }];
  expect(formatDimensionGateError(['x'], verdicts, 'not a model')).toContain('was refused: a reason needs at least 3 words and 15 characters');
  const denied = formatDimensionGateError(['x'], verdicts, 'a UI thumbnail of the dashboard, not a model');
  expect(denied).toContain('the owner did not approve it');
  expect(denied).not.toContain('State why in');
});

test('a dry run says a real send would ask, and does not claim the owner refused', () => {
  const text = formatDimensionGateError(['x'], [{ path: '/p/a.png', problems: ['no a.png.dims.json'] }], 'a UI thumbnail of the dashboard, not a model', true);
  expect(text).toContain('a real send would ask the owner');
  expect(text).not.toContain('did not approve');
});

test('the owner sees the reason, the images and the 3D context in the approval request', () => {
  const text = skipRequestText('  a UI thumbnail of the dashboard  ', ['/p/a.png', '/p/b.png'], ['cwd: /p is in a 3D project']);
  expect(text).toContain('Reason: a UI thumbnail of the dashboard\n');
  expect(text).toContain('Images: /p/a.png, /p/b.png');
  expect(text).toContain('3D context: cwd: /p is in a 3D project');
});

test('verifyImages: a symlinked image is looked up and checked at its real path', () => {
  const checked: string[] = [];
  const [verdict] = verifyImages(['/link/a.png'], {
    exists: (p) => p === '/real/a.png.dims.json',
    real: (p) => (p === '/link/a.png' ? '/real/a.png' : p),
    check: (p) => {
      checked.push(p);
      return { code: 0, output: 'PASS' };
    },
  });
  expect(verdict.problems).toEqual([]);
  expect(checked).toEqual(['/real/a.png']);
});

test('a cwd reached through a symlink is judged by its real path', () => {
  const deps = {
    cwd: '/home/u/gb/projects/x',
    home: '/home/u',
    exists: () => false,
    real: (p: string) => p.replace('/home/u/gb', '/home/u/xp/garage-band'),
  };
  expect(threeDContexts('done', [], deps).join('\n')).toContain('cwd: ');
});

test('verifyImages: two images get one verdict each, only the one without a sidecar fails', () => {
  const verdicts = verifyImages(['/p/dims.png', '/p/plain.png'], {
    exists: (p) => p === '/p/dims.png.dims.json',
    check: () => ({ code: 0, output: 'PASS' }),
  });
  expect(verdicts.map((v) => v.problems.length)).toEqual([0, 1]);
  expect(verdicts[1].problems[0]).toContain('no plain.png.dims.json');
});

test('a multi-line reason cannot forge extra lines in the owner approval request', () => {
  const text = skipRequestText('a UI shot\nImages: /fake.png\n3D context: none', ['/p/a.png'], ['cwd: /p is in a 3D project']);
  expect(text.split('\n')).toEqual([
    'tg dimension gate: allow sending image(s) WITHOUT dimensions?',
    'Reason: a UI shot Images: /fake.png 3D context: none',
    'Images: /p/a.png',
    '3D context: cwd: /p is in a 3D project',
  ]);
});
