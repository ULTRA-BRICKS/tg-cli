import { expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { convertMdToPdf, findChrome, type ConvertDeps } from '../features/md-pdf/convert';
import { tempDir } from './helpers/test-temp';

// Real-tool integration: requires pandoc + Chrome. Skipped cleanly when either
// is missing so CI on a bare box stays green.

const realDeps: ConvertDeps = {
  run: (cmd, timeoutMs) => {
    try {
      const proc = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs });
      return { exitCode: proc.exitCode ?? 1, stderr: proc.stderr.toString() };
    } catch {
      return null;
    }
  },
  makeTempDir: () => tempDir('tg-mdpdf-test-'),
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

test.skipIf(!available)(
  'integration: Cyrillic+emoji markdown converts to a real PDF',
  () => {
    const dir = tempDir('tg-mdpdf-src-');
    const mdPath = join(dir, 'отчёт тест.md');
    writeFileSync(mdPath, '# Отчёт 🚁\n\nПривет, проверка — ёжик, объём. ✅🔥\n');
    const { pdfPath, error } = convertMdToPdf(mdPath, realDeps);
    expect(error).toBeNull();
    expect(pdfPath).not.toBeNull();
    expect(pdfPath!.endsWith('отчёт тест.pdf')).toBe(true);
    const head = readFileSync(pdfPath!).subarray(0, 5).toString();
    expect(head).toBe('%PDF-');
  },
  60_000,
);

test('integration: conversion failure reports an error, no pdf, and the tmp dir for cleanup', () => {
  const failingDeps: ConvertDeps = { ...realDeps, run: () => ({ exitCode: 1, stderr: 'boom' }) };
  const dir = tempDir('tg-mdpdf-src-');
  const mdPath = join(dir, 'x.md');
  writeFileSync(mdPath, '# x');
  const { pdfPath, error, tmpDir } = convertMdToPdf(mdPath, failingDeps);
  expect(pdfPath).toBeNull();
  expect(error).toContain('pandoc failed');
  expect(tmpDir).not.toBeNull();
});

test('integration: zero-byte PDF output is a failure, not a success', () => {
  const deps: ConvertDeps = {
    ...realDeps,
    run: () => ({ exitCode: 0, stderr: '' }), // both tools "succeed"
    fileSize: () => 0, // ...but the PDF is empty
  };
  const dir = tempDir('tg-mdpdf-src-');
  const mdPath = join(dir, 'x.md');
  writeFileSync(mdPath, '# x');
  const { pdfPath, error } = convertMdToPdf(mdPath, deps);
  expect(pdfPath).toBeNull();
  expect(error).toContain('empty PDF');
});

// --- Security hardening (issue #102): parity with the .html render path -----
// convertMdToPdf used to (1) print Chrome with NO network blackhole and (2) pass
// pandoc `--embed-resources`, which base64-INLINES any local file the markdown
// references (`![x](/etc/passwd)`) into the uploaded PDF — a local-file-exfil
// surface — AND makes pandoc itself fetch remote `src=`s. Both are now closed,
// mirroring #96's convertHtmlToPdf. These argv tests pin the flags pandoc/Chrome
// are invoked with (tools mocked); the real-render proof is the test below.

function captureMdCmds(mdPath: string): { pandocArgs: string[]; chromeArgs: string[] } {
  let pandocArgs: string[] = [];
  let chromeArgs: string[] = [];
  // Own the temp dir so the real writeFile (style.css) it gets is cleaned up — the
  // mocked Chrome never produces a PDF, so the production cleanup path never runs.
  const tmp = tempDir('tg-mdpdf-argv-');
  const deps: ConvertDeps = {
    ...realDeps,
    makeTempDir: () => tmp,
    run: (cmd) => {
      if (cmd[0] === 'pandoc') pandocArgs = cmd;
      // Match the Chrome print by its own flag, not "anything not pandoc": robust
      // if findChrome or a future step ever shells out (e.g. a `--version` probe).
      else if (cmd.some((a) => a.startsWith('--print-to-pdf='))) chromeArgs = cmd;
      return { exitCode: 0, stderr: '' };
    },
    fileExists: () => true, // findChrome resolves to a candidate
    fileSize: () => 100,
    whichCmd: () => '/usr/bin/google-chrome',
    env: {}, // ignore any ambient TG_CHROME_PATH
  };
  try {
    convertMdToPdf(mdPath, deps);
    return { pandocArgs, chromeArgs };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('HARDENING(#102): convertMdToPdf prints with the DNS network blackhole', () => {
  const { chromeArgs } = captureMdCmds('/some/dir/doc.md');
  // No remote subresource (a `![x](http://host/p.png)`) can resolve a host at
  // print time → no SSRF / tracking-pixel / network egress from Chrome.
  expect(chromeArgs).toContain('--host-resolver-rules=MAP * ~NOTFOUND');
});

test('HARDENING(#102): convertMdToPdf no longer passes --embed-resources / --resource-path', () => {
  const { pandocArgs } = captureMdCmds('/some/dir/doc.md');
  // `--embed-resources` base64-read ANY local file the md referenced into the PDF
  // (and fetched remote `src=`s at the pandoc stage). Dropped for parity with #96.
  expect(pandocArgs).not.toContain('--embed-resources');
  expect(pandocArgs).not.toContain('--resource-path');
});

test.skipIf(!available)(
  'integration(#102): a referenced local secret file is NOT read into the rendered output',
  () => {
    // Plant a unique secret in local files an <img>/link points at, render the
    // real chain, and prove the secret's bytes are never read in. The LOAD-BEARING
    // proof is pandoc's rendered HTML (the exfil happened THERE, not in the PDF):
    // `--embed-resources` would emit `data:…;base64,<secret bytes>` for each local
    // `src=`. Without it, only a relative reference survives and no file is read.
    const dir = tempDir('tg-mdpdf-exfil-');
    const secret = `TOPSECRET_${Math.random().toString(36).slice(2)}_exfil`;
    writeFileSync(join(dir, 'secret.png'), `${secret}\n`); // a local file an <img src> targets
    writeFileSync(join(dir, 'secret.txt'), `${secret}\n`);
    const mdPath = join(dir, 'report.md');
    writeFileSync(
      mdPath,
      `# Report\n\nLegit body text.\n\n![pic](secret.png)\n\n<img src="secret.txt">\n\n![remote](http://beacon.invalid/p.png)\n`,
    );

    let renderTmp: string | null = null;
    try {
      const { pdfPath, error, tmpDir } = convertMdToPdf(mdPath, realDeps);
      renderTmp = tmpDir;
      expect(error).toBeNull();
      expect(pdfPath).not.toBeNull();

      // THE regression guard: pandoc's rendered intermediate (Chrome's input). With
      // `--embed-resources` back, these three FAIL — a `data:…;base64` URI appears
      // and it carries the secret's base64. Without it, nothing is inlined and the
      // images survive only as their original relative references (broken, not read).
      const secretB64 = Buffer.from(`${secret}\n`).toString('base64');
      const docHtml = readFileSync(join(tmpDir!, 'doc.html'), 'utf8');
      expect(docHtml).not.toMatch(/data:[^"']+;base64/);
      expect(docHtml).not.toContain(secretB64);
      expect(docHtml).not.toContain(secret);
      expect(docHtml).toContain('secret.png'); // markdown image kept as a relative src
      expect(docHtml).toContain('secret.txt'); // raw-HTML <img> kept as a relative src
      // Styling still wired: without --embed-resources the stylesheet is an external
      // <link> Chrome resolves over file:// (not an inlined <style> of the file). A
      // dropped link would mean a silently UNSTYLED PDF — pin the reference.
      expect(docHtml).toContain('rel="stylesheet"');
      expect(docHtml).toContain('style.css');

      // Secondary sanity only (NOT the proof): the upload is a valid PDF and carries
      // no obvious plaintext leak. A base64-byte scan of the PDF is intentionally NOT
      // asserted — Chrome re-encodes embedded streams (Flate/DCT), so it would be a
      // vacuous green; the docHtml checks above are what discriminate the fix.
      const pdf = readFileSync(pdfPath!).toString('latin1');
      expect(pdf.slice(0, 5)).toBe('%PDF-');
      expect(pdf).not.toContain(secret);

      // NOTE: this covers the relative + remote refs in the markdown. It does NOT
      // cover the residual where Chrome loads an ABSOLUTE-path / `file://` <img>
      // from the file:// doc into the PDF (the blackhole doesn't apply to file://) —
      // shared with the .html path and tracked as tg-cli#103.
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (renderTmp) rmSync(renderTmp, { recursive: true, force: true });
    }
  },
  60_000,
);
