import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { convertCodeToPdf, DEVICE_PRESETS } from '../features/code-pdf/convert';
import { findChrome, type ConvertDeps } from '../features/md-pdf/convert';
import { tempDir } from './helpers/test-temp';

const realDeps: ConvertDeps = {
  run: (cmd, timeoutMs) => {
    try {
      const proc = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs });
      return { exitCode: proc.exitCode ?? 1, stderr: proc.stderr.toString() };
    } catch {
      return null;
    }
  },
  makeTempDir: () => tempDir('tg-codepdf-test-'),
  writeFile: (path, content) => writeFileSync(path, content),
  readFile: (path) => readFileSync(path, 'utf8'),
  fileExists: (path) => existsSync(path),
  fileSize: (path) => {
    try {
      return Bun.file(path).size;
    } catch {
      return -1;
    }
  },
  whichCmd: (name) => Bun.which(name),
  env: process.env as Record<string, string | undefined>,
};

const pandocAvailable = realDeps.run(['pandoc', '--version'], 5000) !== null;
const chromeAvailable = findChrome(realDeps) !== null;
const available = pandocAvailable && chromeAvailable;

// --- Mocked render: assert the pandoc invocation shape (no real tools) ------

test('convertCodeToPdf: pandoc gets the highlight style and fenced language', () => {
  const calls: string[][] = [];
  let writtenMd = '';
  const deps: ConvertDeps = {
    ...realDeps,
    readFile: () => 'export const x: number = 1;\n',
    writeFile: (p, c) => {
      if (p.endsWith('code.md')) writtenMd = c;
    },
    run: (cmd) => {
      calls.push(cmd);
      return { exitCode: 0, stderr: '' };
    },
    fileSize: () => 4096,
    makeTempDir: () => '/tmp/fake-codepdf',
    fileExists: () => true,
    whichCmd: () => '/usr/bin/google-chrome', // make findChrome succeed
    env: {},
  };
  const out = convertCodeToPdf('/proj/server.ts', deps, DEVICE_PRESETS.iphone15pro, {
    highlightStyle: 'tango',
  });
  expect(out.error).toBeNull();
  expect(out.pdfPath).toBe('/tmp/fake-codepdf/server.ts.pdf');
  const pandoc = calls[0];
  expect(pandoc[0]).toBe('pandoc');
  expect(pandoc).toContain('--highlight-style');
  expect(pandoc[pandoc.indexOf('--highlight-style') + 1]).toBe('tango');
  // The fenced markdown was written with the detected language (attribute form).
  expect(writtenMd).toContain('```{.typescript}');
  expect(writtenMd).toContain('export const x: number = 1;');
  // markdown reader (not gfm) so the {.lang} attribute fence is honored.
  expect(pandoc[pandoc.indexOf('-f') + 1]).toBe('markdown');
});

test('convertCodeToPdf: non-code type is rejected before any tool runs', () => {
  let ran = false;
  const deps: ConvertDeps = {
    ...realDeps,
    run: () => {
      ran = true;
      return { exitCode: 0, stderr: '' };
    },
    whichCmd: () => '/usr/bin/google-chrome',
  };
  const out = convertCodeToPdf('/x/notes.txt', deps, DEVICE_PRESETS.iphone15pro);
  expect(out.pdfPath).toBeNull();
  expect(out.error).toContain('not a recognized');
  expect(ran).toBe(false);
});

test('convertCodeToPdf: zero-byte PDF output is a failure', () => {
  const deps: ConvertDeps = {
    ...realDeps,
    readFile: () => 'x',
    writeFile: () => {},
    run: () => ({ exitCode: 0, stderr: '' }),
    fileSize: () => 0,
    makeTempDir: () => '/tmp/fake-codepdf2',
    whichCmd: () => '/usr/bin/google-chrome',
    fileExists: () => true,
  };
  const out = convertCodeToPdf('/x/a.ts', deps, DEVICE_PRESETS.iphone15pro);
  expect(out.pdfPath).toBeNull();
  expect(out.error).toContain('empty PDF');
});

// --- Real render: .ts and .json to actual mobile PDFs -----------------------

test.skipIf(!available)(
  'integration: a .ts file renders to a real mobile PDF',
  () => {
    const dir = tempDir('tg-codepdf-src-');
    const tsPath = join(dir, 'sample.ts');
    writeFileSync(
      tsPath,
      `export interface User {\n  id: number;\n  name: string;\n}\n\n` +
        `export function greet(u: User): string {\n` +
        `  // a very long line to prove soft-wrap on a narrow phone page works without horizontal scroll truncation\n` +
        `  return \`Hello, \${u.name} (#\${u.id}) — welcome to the application that has a deliberately verbose greeting\`;\n}\n`,
    );
    const { pdfPath, error } = convertCodeToPdf(tsPath, realDeps, DEVICE_PRESETS.iphone15pro);
    expect(error).toBeNull();
    expect(pdfPath).not.toBeNull();
    expect(pdfPath!.endsWith('sample.ts.pdf')).toBe(true);
    const head = readFileSync(pdfPath!).subarray(0, 5).toString();
    expect(head).toBe('%PDF-');
  },
  60_000,
);

test.skipIf(!available)(
  'integration: a .json file renders to a real mobile PDF',
  () => {
    const dir = tempDir('tg-codepdf-src-');
    const jsonPath = join(dir, 'config.json');
    writeFileSync(jsonPath, JSON.stringify({ name: 'tg', nested: { a: [1, 2, 3], b: true } }, null, 2));
    const { pdfPath, error } = convertCodeToPdf(jsonPath, realDeps, DEVICE_PRESETS.iphone15pro);
    expect(error).toBeNull();
    expect(pdfPath).not.toBeNull();
    expect(pdfPath!.endsWith('config.json.pdf')).toBe(true);
    const head = readFileSync(pdfPath!).subarray(0, 5).toString();
    expect(head).toBe('%PDF-');
  },
  60_000,
);
