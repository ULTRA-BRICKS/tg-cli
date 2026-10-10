// HTML-report → PDF rendering (regression: issue #95).
//
// An attached .html/.htm file is a Telegram-subset HTML *report* meant to be
// RENDERED (bold/italic/headings/tables/lists/code/blockquotes become real
// formatting), NOT a source file to syntax-highlight. The bug: `.html` was in
// CODE_EXT_LANG, so it took the code-fence path and the PDF showed literal
// `<b>`/`<code>`/`<table>` tags as monospace text. These tests pin the fix:
//   - .html/.htm are NOT code-fence types (no `{.html}` fence is emitted);
//   - they ARE eligible for the code-pdf plan pass (so they get converted);
//   - the HTML→PDF render writes an INTERMEDIATE doc that renders the tags as
//     DOM (no escaped `&lt;b&gt;` leak; real <strong>/<table>/<h1> structure).
import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  CODE_EXT_LANG,
  convertCodeToPdf,
  convertHtmlToPdf,
  detectCodeLang,
  DEVICE_PRESETS,
  isConvertibleCode,
  isRenderableHtml,
  pdfNameForCode,
  sanitizeReportHtml,
  stripEventHandlerAttrs,
} from '../features/code-pdf/convert';
import type { ConvertDeps } from '../features/md-pdf/convert';
import type { SendItem } from '../features/auto-attach/types';
import { tempDir } from './helpers/test-temp';

const disk = (path: string, type: 'photo' | 'document' = 'document'): SendItem => ({
  type,
  source: { kind: 'disk', path },
});

// A Telegram-subset HTML report exercising the tag families the CTO sends.
const REPORT_HTML =
  '<b>Drag-cluster e2e: fixed</b>\n' +
  '<h1>Heading</h1>\n' +
  '<blockquote>a quoted line</blockquote>\n' +
  '<code>findNearestSourceLocation</code> and <code>&lt;div&gt;</code>\n' +
  '<ul><li>one</li><li>two</li></ul>\n' +
  '<table><tr><th>k</th><th>v</th></tr><tr><td>a</td><td>1</td></tr></table>\n';

// --- Routing: .html/.htm leave the code-fence path -------------------------

test('CODE_EXT_LANG no longer maps html/htm to a code highlighter', () => {
  // These were the bug: an .html report fenced as code → raw tags in the PDF.
  expect(CODE_EXT_LANG.html).toBeUndefined();
  expect(CODE_EXT_LANG.htm).toBeUndefined();
});

test('detectCodeLang: .html/.htm are not code-fence types', () => {
  expect(detectCodeLang('/x/report.html')).toBeNull();
  expect(detectCodeLang('/x/page.htm')).toBeNull();
  // real source files still fence as code
  expect(detectCodeLang('/x/server.ts')).toBe('typescript');
  expect(detectCodeLang('/x/data.xml')).toBe('xml');
});

test('isRenderableHtml: disk-sourced .html/.htm documents only', () => {
  expect(isRenderableHtml(disk('/x/report.html'))).toBe(true);
  expect(isRenderableHtml(disk('/x/page.htm'))).toBe(true);
  expect(isRenderableHtml(disk('/x/server.ts'))).toBe(false);
  expect(isRenderableHtml(disk('/x/report.html', 'photo'))).toBe(false);
  expect(
    isRenderableHtml({ type: 'document', source: { kind: 'memory', filename: 'r.html', content: 'x' } }),
  ).toBe(false);
});

test('isConvertibleCode: an .html report is still eligible for the code-pdf pass', () => {
  // Eligibility must stay true so the plan converts it — just via the render
  // path, not the fence path.
  expect(isConvertibleCode(disk('/x/report.html'))).toBe(true);
  expect(isConvertibleCode(disk('/x/server.ts'))).toBe(true);
  expect(isConvertibleCode(disk('/x/photo.png'))).toBe(false);
});

test('pdfNameForCode: an .html report keeps its name (.html.pdf)', () => {
  expect(pdfNameForCode('/dir/tg-report.html')).toBe('tg-report.html.pdf');
});

// --- Routing: case-insensitive + the entrypoint dispatch -------------------

test('isRenderableHtml / detectCodeLang: extension match is case-insensitive', () => {
  // Uppercase extensions must route identically (extOf lowercases). Before the
  // fix this was handled by CODE_EXT_LANG; keep it pinned on the render path.
  expect(isRenderableHtml(disk('/x/REPORT.HTML'))).toBe(true);
  expect(isRenderableHtml(disk('/x/Page.Htm'))).toBe(true);
  expect(detectCodeLang('/x/REPORT.HTML')).toBeNull();
  expect(isConvertibleCode(disk('/x/REPORT.HTML'))).toBe(true);
});

test('convertCodeToPdf DISPATCH: an .html file takes the render path (not the fence path)', () => {
  // The real integration point is the branch in convertCodeToPdf that
  // applyCodePdfToPlan calls. Prove .html → pandoc `-f html` (render), while a
  // .ts → pandoc `-f markdown` (fence). Tools mocked; we inspect the argv.
  const capture = (path: string) => {
    let pandocArgs: string[] = [];
    let writtenMd = '';
    const deps: ConvertDeps = {
      readFile: () => '<b>x</b>',
      writeFile: (p, c) => {
        if (p.endsWith('code.md')) writtenMd = c;
      },
      run: (cmd) => {
        if (cmd[0] === 'pandoc') pandocArgs = cmd;
        return { exitCode: 0, stderr: '' };
      },
      makeTempDir: () => '/tmp/fake-dispatch',
      fileExists: () => true,
      fileSize: () => 4096,
      whichCmd: () => '/usr/bin/google-chrome',
      env: {},
    };
    convertCodeToPdf(path, deps, DEVICE_PRESETS.iphone15pro);
    return { pandocArgs, writtenMd };
  };

  const html = capture('/x/report.html');
  expect(html.pandocArgs[html.pandocArgs.indexOf('-f') + 1]).toBe('html'); // render
  expect(html.writtenMd).toBe(''); // no fenced code.md was written

  const ts = capture('/x/server.ts');
  expect(ts.pandocArgs[ts.pandocArgs.indexOf('-f') + 1]).toBe('markdown'); // fence
  expect(ts.writtenMd).toContain('```{.typescript}');
});

// --- convertHtmlToPdf: the INPUT handed to pandoc (mocked) -----------------

// With pandoc/Chrome mocked, the only observable is the SOURCE html the render
// path writes for pandoc to parse — capture `source.html`. (What pandoc DOES
// with it — turning tags into formatting — is proven by the real-pandoc
// integration test below, since the bug lived in the render itself.)
function captureSourceHandedToPandoc(htmlSource: string): {
  writtenSource: string;
  pandocArgs: string[];
  pdfPath: string | null;
} {
  let writtenSource = '';
  let pandocArgs: string[] = [];
  const deps: ConvertDeps = {
    readFile: () => htmlSource,
    writeFile: (p, c) => {
      if (p.endsWith('source.html')) writtenSource = c;
    },
    run: (cmd) => {
      if (cmd[0] === 'pandoc') pandocArgs = cmd;
      return { exitCode: 0, stderr: '' };
    },
    makeTempDir: () => '/tmp/fake-htmlpdf',
    fileExists: () => true,
    fileSize: () => 4096,
    whichCmd: () => '/usr/bin/google-chrome',
    env: {},
  };
  const out = convertHtmlToPdf('/proj/tg-report.html', deps, DEVICE_PRESETS.iphone15pro);
  return { writtenSource, pandocArgs, pdfPath: out.pdfPath };
}

test('convertHtmlToPdf: pandoc reads HTML (-f html), not markdown/code', () => {
  const { pandocArgs, pdfPath } = captureSourceHandedToPandoc(REPORT_HTML);
  expect(pandocArgs[0]).toBe('pandoc');
  expect(pandocArgs[pandocArgs.indexOf('-f') + 1]).toBe('html');
  expect(pdfPath).toBe('/tmp/fake-htmlpdf/tg-report.html.pdf');
});

test('convertHtmlToPdf: hands pandoc the report HTML verbatim, NOT escaped or fenced', () => {
  const { writtenSource } = captureSourceHandedToPandoc(REPORT_HTML);
  // The tags reach pandoc as REAL tags (so `-f html` parses them as DOM), never
  // escaped to `&lt;b&gt;` text and never wrapped in a `{.html}` code fence —
  // either of which would reproduce the verbatim-tag bug.
  expect(writtenSource).toContain('<b>');
  expect(writtenSource).toContain('<table>');
  expect(writtenSource).toContain('<h1>');
  expect(writtenSource).not.toContain('&lt;b&gt;');
  expect(writtenSource).not.toContain('{.html}');
  expect(writtenSource).toContain('Drag-cluster e2e: fixed');
});

// --- Chrome hardening: the print sandbox flags must reach BOTH paths --------

// Capture the Chrome --print-to-pdf command (pandoc + Chrome mocked). The
// hardening flags are the whole point of the sandbox; a refactor of printToPdf
// could silently drop them, so pin them for the render path AND the fence path.
function captureChromeCmd(srcPath: string, content: string): string[] {
  let chromeCmd: string[] = [];
  const deps: ConvertDeps = {
    readFile: () => content,
    writeFile: () => {},
    run: (cmd) => {
      if (cmd[0] !== 'pandoc') chromeCmd = cmd; // the Chrome invocation
      return { exitCode: 0, stderr: '' };
    },
    makeTempDir: () => '/tmp/fake-harden',
    fileExists: () => true,
    fileSize: () => 4096,
    whichCmd: () => '/usr/bin/google-chrome',
    env: {},
  };
  convertCodeToPdf(srcPath, deps, DEVICE_PRESETS.iphone15pro);
  return chromeCmd;
}

test('HARDENING: Chrome print runs with the network blackhole on the HTML render path', () => {
  const cmd = captureChromeCmd('/x/report.html', '<b>x</b>');
  // The DNS blackhole stops a malicious report from beaconing out (SSRF /
  // tracking pixel) during the print. See printToPdf's SCOPE note for what it
  // does and does not cover.
  expect(cmd).toContain('--host-resolver-rules=MAP * ~NOTFOUND');
});

test('HARDENING: the fence path inherits the same network blackhole', () => {
  const cmd = captureChromeCmd('/x/server.ts', 'const x = 1;\n');
  expect(cmd).toContain('--host-resolver-rules=MAP * ~NOTFOUND');
});

// --- Sanitizer LAYER 1 (sanitizeReportHtml): strip executable/embed ELEMENTS --
// Runs on the RAW report before pandoc. Removes whole <script>/<style>/<iframe>/
// <object>/<embed>/<link>/<meta>/<base> blocks (a block scan to the close tag, so
// a `>` inside an attribute value can't end the match early). Event-handler
// (on*=) removal is LAYER 2 (stripEventHandlerAttrs), asserted next.

test('sanitizeReportHtml: strips <script> blocks (content included)', () => {
  const out = sanitizeReportHtml('<b>ok</b><script>fetch("http://evil")</script><i>after</i>');
  expect(out).not.toMatch(/<script/i);
  expect(out).not.toContain('fetch("http://evil")');
  expect(out).toContain('<b>ok</b>');
  expect(out).toContain('<i>after</i>');
});

test('sanitizeReportHtml: strips <style>/<iframe>/<object>/<embed>/<link>/<meta>', () => {
  const out = sanitizeReportHtml(
    '<style>body{display:none}</style>' +
      '<iframe src="file:///etc/passwd"></iframe>' +
      '<object data="x"></object><embed src="y">' +
      '<link rel="stylesheet" href="http://evil/x.css">' +
      '<meta http-equiv="refresh" content="0;url=http://evil">' +
      '<h1>title</h1>',
  );
  for (const tag of ['style', 'iframe', 'object', 'embed', 'link', 'meta']) {
    expect(out.toLowerCase()).not.toContain(`<${tag}`);
  }
  expect(out).not.toContain('file:///etc/passwd');
  expect(out).toContain('<h1>title</h1>'); // formatting survives
});

test('sanitizeReportHtml: a <script> with a `>` inside an attribute value is still fully stripped', () => {
  // The block scan reaches </script>, so a `>` in an attribute value can't end
  // the match early and leak the script body.
  const out = sanitizeReportHtml('<b>ok</b><script data-x=">">steal()</script><i>z</i>');
  expect(out).not.toMatch(/<script/i);
  expect(out).not.toContain('steal()');
  expect(out).toContain('<b>ok</b>');
  expect(out).toContain('<i>z</i>');
});

test('sanitizeReportHtml: case-insensitive — uppercase <SCRIPT>/<STYLE> stripped', () => {
  const out = sanitizeReportHtml('<B>keep</B><SCRIPT>bad()</SCRIPT><STYLE>x{}</STYLE>');
  expect(out).not.toMatch(/<script/i);
  expect(out).not.toMatch(/<style/i);
  expect(out).not.toContain('bad()');
  expect(out).toContain('<B>keep</B>');
});

test('sanitizeReportHtml: a clean report passes through unchanged', () => {
  const clean = '<b>bold</b> <code>x</code><table><tr><td>c</td></tr></table><blockquote>q</blockquote>';
  expect(sanitizeReportHtml(clean)).toBe(clean);
});

test('sanitizeReportHtml: a remote <img> is KEPT (the DNS blackhole, not the strip, neutralizes it)', () => {
  // The strip is for code, not remote media. A remote <img> survives the strip;
  // it just can't fetch at print time (host-resolver blackhole). Pin the intent.
  const out = sanitizeReportHtml('<img src="http://host/p.png">');
  expect(out).toContain('<img');
  expect(out).toContain('src="http://host/p.png"');
});

test('sanitizeReportHtml: <svg> subtree is stripped whole (onload / nested <script> / <use href>)', () => {
  // <svg> is not in the Telegram report subset and is the one place LAYER 2 can't
  // be trusted (pandoc may pass it through as raw_html). The whole subtree goes —
  // the onload handler, a nested <script>, and an external <use href> all vanish,
  // while the surrounding report formatting is untouched. (#95 review hardening.)
  const html = '<b>ok</b><svg onload="beacon()"><script>steal()</script><use href="http://h/x#i"/></svg><i>done</i>';
  const out = sanitizeReportHtml(html);
  expect(out).not.toMatch(/<svg/i);
  expect(out).not.toMatch(/onload/i);
  expect(out).not.toContain('beacon()');
  expect(out).not.toContain('steal()');
  expect(out).not.toContain('http://h/x');
  expect(out).toContain('<b>ok</b>');
  expect(out).toContain('<i>done</i>');
});

test('sanitizeReportHtml: <math> (MathML) subtree is stripped whole', () => {
  const out = sanitizeReportHtml('<p>x</p><math><mi onclick="go()">a</mi></math><p>y</p>');
  expect(out).not.toMatch(/<math/i);
  expect(out).not.toMatch(/onclick/i);
  expect(out).not.toContain('go()');
  expect(out).toContain('<p>x</p>');
  expect(out).toContain('<p>y</p>');
});

test('sanitizeReportHtml: a MALFORMED/unclosed <svg> still cannot leave an active child', () => {
  // No clean </svg>, so the block pass can't match — the open tag AND the
  // handler/ref-bearing svg children (<animate>/<use>/<image>/<set>/<foreignObject>)
  // are stripped individually so nothing executable rides into pandoc's raw
  // passthrough. (#95 review: the block-pass-only guarantee was too strong.)
  const unclosed = '<b>ok</b><svg><animate onbegin="beacon()"/><use href="http://h/x#i"/><image href="http://h/p.png"/>';
  const out = sanitizeReportHtml(unclosed);
  expect(out).not.toMatch(/<svg/i);
  expect(out).not.toMatch(/<animate/i);
  expect(out).not.toMatch(/<use\b/i);
  expect(out).not.toMatch(/<image\b/i);
  expect(out).not.toMatch(/onbegin/i);
  expect(out).not.toContain('beacon()');
  expect(out).not.toContain('http://h/');
  expect(out).toContain('<b>ok</b>');
});

test('sanitizeReportHtml: an unclosed <svg onload=…> has its handler removed (open-tag strip)', () => {
  const out = sanitizeReportHtml('<b>ok</b><svg onload="beacon()"><circle r="9"/>');
  expect(out).not.toMatch(/<svg/i);
  expect(out).not.toMatch(/onload/i);
  expect(out).not.toContain('beacon()');
  expect(out).toContain('<b>ok</b>');
});

test('sanitizeReportHtml: a <foreignObject> (arbitrary-HTML embed) tag is stripped', () => {
  const out = sanitizeReportHtml('<p>x</p><svg><foreignObject><div onclick="go()">y</div></foreignObject></svg><p>z</p>');
  expect(out).not.toMatch(/<svg/i);
  expect(out).not.toMatch(/<foreignObject/i);
  expect(out).toContain('<p>x</p>');
  expect(out).toContain('<p>z</p>');
});

test('sanitizeReportHtml: NESTING bypass — a single pass that re-forms a tag is fully stripped (fixed point)', () => {
  // The classic single-pass-sanitizer bypass: removing the inner match re-forms
  // an outer <script> (`<scr<script>ipt>` -> `<script>`). The fixed-point loop
  // repeats until stable, so NO <script>/<iframe> survives. (CodeQL
  // js/incomplete-multi-character-sanitization regression.)
  expect(sanitizeReportHtml('<scr<script>ipt>alert(1)')).not.toMatch(/<script/i);
  expect(sanitizeReportHtml('<<script>script>')).not.toMatch(/<script/i);
  expect(sanitizeReportHtml('<ifr<iframe>ame src="x">')).not.toMatch(/<iframe/i);
  // A real report with a stray nested form still keeps its legitimate formatting.
  const out = sanitizeReportHtml('<b>ok</b><scr<script>ipt>steal()</scr</script>ipt>');
  expect(out).not.toMatch(/<script/i);
  expect(out).toContain('<b>ok</b>');
});

// --- Sanitizer LAYER 2 (stripEventHandlerAttrs): strip on*= on pandoc output --
// Runs on pandoc's NORMALIZED html5 (every attribute double-quoted; any `>` in a
// value escaped to `&gt;`), where the tag boundary is sound. This closes the
// raw-input `>`-in-attribute-value bypass surfaced by the #95 review: pandoc
// preserves on*= handlers on the elements it models (<img>/<div>/<span>/<td>/…),
// and an unstripped `<img onerror>` FIRES during the print (its blackholed src is
// guaranteed to fail to load).

test('stripEventHandlerAttrs: removes on*= handlers, keeps the element + other attrs', () => {
  const out = stripEventHandlerAttrs('<img src="x" onerror="beacon()" alt="a" /><b onclick="go()">x</b>');
  expect(out).not.toMatch(/onerror/i);
  expect(out).not.toMatch(/onclick/i);
  expect(out).not.toContain('beacon()');
  expect(out).not.toContain('go()');
  expect(out).toContain('src="x"');
  expect(out).toContain('alt="a"');
  expect(out).toContain('>x</b>');
});

test('stripEventHandlerAttrs: BYPASS — a `>` inside a quoted value does NOT shield a later handler', () => {
  // The raw-input matcher stopped at the first `>` and left `onerror` behind.
  // pandoc escapes the inner `>` to `&gt;`, so on the normalized output the whole
  // attribute run is one tag and the handler is removed. Regression for #95 review.
  const normalized = '<img src="x" onerror="beacon()" alt="&gt;" />';
  const out = stripEventHandlerAttrs(normalized);
  expect(out).not.toMatch(/onerror/i);
  expect(out).not.toContain('beacon()');
  expect(out).toContain('alt="&gt;"'); // the escaped value is preserved
});

test('stripEventHandlerAttrs: does NOT corrupt text or values that merely contain `on…=`', () => {
  // Only attribute NAMES starting `on` are removed; text nodes and values that
  // happen to contain `online=`/`onset=` are untouched.
  expect(stripEventHandlerAttrs('status: online=true here')).toBe('status: online=true here');
  expect(stripEventHandlerAttrs('<code>onset=5</code>')).toBe('<code>onset=5</code>');
  expect(stripEventHandlerAttrs('<p>online=true and onset=5</p>')).toBe('<p>online=true and onset=5</p>');
  expect(stripEventHandlerAttrs('<span title="status online=true">x</span>')).toBe(
    '<span title="status online=true">x</span>',
  );
});

test('stripEventHandlerAttrs: a tag with no attributes is returned unchanged', () => {
  expect(stripEventHandlerAttrs('<b>x</b><table><tr><td>c</td></tr></table>')).toBe(
    '<b>x</b><table><tr><td>c</td></tr></table>',
  );
});

test('convertHtmlToPdf: hands pandoc the element-SANITIZED source (no <script> survives)', () => {
  let writtenSource = '';
  const deps: ConvertDeps = {
    readFile: () => '<b>report</b><script>steal()</script>',
    writeFile: (p, c) => {
      if (p.endsWith('source.html')) writtenSource = c;
    },
    run: () => ({ exitCode: 0, stderr: '' }),
    makeTempDir: () => '/tmp/fake-sani',
    fileExists: () => true,
    fileSize: () => 4096,
    whichCmd: () => '/usr/bin/google-chrome',
    env: {},
  };
  convertHtmlToPdf('/x/report.html', deps, DEVICE_PRESETS.iphone15pro);
  expect(writtenSource).toContain('<b>report</b>');
  expect(writtenSource).not.toMatch(/<script/i);
  expect(writtenSource).not.toContain('steal()');
});

test('convertHtmlToPdf: LAYER 2 is actually INVOKED on pandoc output (pandoc-independent)', () => {
  // The two real-pandoc integration tests below are `skipIf(!pandocAvailable)`, so
  // on a pandoc-less runner they prove nothing. This mocked test pins LAYER 2's
  // invocation with NO pandoc: an in-memory FS where the stubbed pandoc step writes
  // a doc.html carrying an `onerror`, then the Chrome step captures doc.html AFTER
  // LAYER 2 rewrote it — the handler must be gone. A refactor that deletes the
  // LAYER 2 block would now fail here regardless of pandoc availability (#95 review).
  const store: Record<string, string> = {};
  let printed = '';
  const deps: ConvertDeps = {
    readFile: (p) => store[p] ?? '<b>raw report</b>',
    writeFile: (p, c) => {
      store[p] = c;
    },
    run: (cmd) => {
      if (cmd[0] === 'pandoc') {
        // pandoc's NORMALIZED output: an element pandoc models, carrying a handler.
        store['/t/doc.html'] = '<html><body><img src="x" onerror="beacon()"/><strong>ok</strong></body></html>';
        return { exitCode: 0, stderr: '' };
      }
      printed = store['/t/doc.html']; // Chrome's input = post-LAYER-2 doc.html
      return { exitCode: 0, stderr: '' };
    },
    makeTempDir: () => '/t',
    fileExists: () => true,
    fileSize: () => 4096,
    whichCmd: () => '/usr/bin/google-chrome',
    env: {},
  };

  const out = convertHtmlToPdf('/x/report.html', deps, DEVICE_PRESETS.iphone15pro);
  expect(out.error).toBeNull();
  // The <img> element survives; the handler was stripped by LAYER 2 before Chrome.
  expect(printed).toMatch(/<img[\s/>]/i);
  expect(printed).not.toMatch(/onerror/i);
  expect(printed).not.toContain('beacon()');
  expect(printed).toContain('<strong>ok</strong>'); // formatting untouched
});

// --- Error branches: a failed render keeps the original attachment ----------

test('convertHtmlToPdf error branches: each failure returns a kept-original signal', () => {
  const baseDeps: ConvertDeps = {
    readFile: () => '<b>x</b>',
    writeFile: () => {},
    run: () => ({ exitCode: 0, stderr: '' }),
    makeTempDir: () => '/tmp/fake-err',
    fileExists: () => true,
    fileSize: () => 4096,
    whichCmd: () => '/usr/bin/google-chrome',
    env: {},
  };

  // Chrome missing → error before any temp dir is created (no leak).
  const noChrome = convertHtmlToPdf('/x/r.html', { ...baseDeps, whichCmd: () => null, fileExists: () => false }, DEVICE_PRESETS.iphone15pro);
  expect(noChrome.pdfPath).toBeNull();
  expect(noChrome.error).toContain('Chrome not found');
  expect(noChrome.tmpDir).toBeNull();

  // readFile throws → 'could not read file', no temp dir.
  const readThrows = convertHtmlToPdf(
    '/x/r.html',
    {
      ...baseDeps,
      readFile: () => {
        throw new Error('EACCES');
      },
    },
    DEVICE_PRESETS.iphone15pro,
  );
  expect(readThrows.pdfPath).toBeNull();
  expect(readThrows.error).toContain('could not read file');
  expect(readThrows.tmpDir).toBeNull();

  // pandoc binary missing (run → null) → 'pandoc not found', temp dir surfaced.
  const noPandoc = convertHtmlToPdf('/x/r.html', { ...baseDeps, run: () => null }, DEVICE_PRESETS.iphone15pro);
  expect(noPandoc.pdfPath).toBeNull();
  expect(noPandoc.error).toContain('pandoc not found');
  expect(noPandoc.tmpDir).toBe('/tmp/fake-err');

  // pandoc non-zero exit → stderr propagated.
  const pandocFails = convertHtmlToPdf(
    '/x/r.html',
    { ...baseDeps, run: (cmd) => (cmd[0] === 'pandoc' ? { exitCode: 3, stderr: 'boom' } : { exitCode: 0, stderr: '' }) },
    DEVICE_PRESETS.iphone15pro,
  );
  expect(pandocFails.error).toContain('pandoc failed');
  expect(pandocFails.error).toContain('boom');

  // Chrome non-zero exit → print failure.
  const chromeFails = convertHtmlToPdf(
    '/x/r.html',
    { ...baseDeps, run: (cmd) => (cmd[0] === 'pandoc' ? { exitCode: 0, stderr: '' } : { exitCode: 1, stderr: 'crash' }) },
    DEVICE_PRESETS.iphone15pro,
  );
  expect(chromeFails.error).toContain('chrome print-to-pdf failed');

  // Empty PDF (fileSize <= 0) → empty-PDF failure.
  const emptyPdf = convertHtmlToPdf('/x/r.html', { ...baseDeps, fileSize: () => 0 }, DEVICE_PRESETS.iphone15pro);
  expect(emptyPdf.error).toContain('empty PDF');
});

// --- Real pandoc: the rendered intermediate has FORMATTING, not raw tags ----
//
// THE regression test for issue #95. Runs real pandoc on the report HTML and
// asserts the rendered doc.html (Chrome's input) is a formatted DOM — bold as
// <strong>, real <table>/<h1>/<ul>, NO escaped `&lt;b&gt;` source text, and NOT
// wrapped in a <pre><code> code block. This is what proves the PDF will show
// formatting instead of the literal tags the bug printed.

const realDeps: ConvertDeps = {
  run: (cmd, timeoutMs) => {
    try {
      const proc = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs });
      return { exitCode: proc.exitCode ?? 1, stderr: proc.stderr.toString() };
    } catch {
      return null;
    }
  },
  makeTempDir: () => tempDir('tg-htmlpdf-test-'),
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

test.skipIf(!pandocAvailable)(
  'integration(real pandoc): report HTML renders to a FORMATTED doc, no raw tags, no code fence',
  () => {
    // Render with real pandoc but a STUBBED Chrome (we only need pandoc's
    // doc.html, not the final PDF). Snapshot doc.html when it is written.
    let renderedHtml = '';
    const dir = tempDir('tg-htmlpdf-real-');
    const deps: ConvertDeps = {
      ...realDeps,
      makeTempDir: () => dir,
      // Path-aware: the SOURCE read returns the report fixture, but LAYER 2's
      // read-back of doc.html must see pandoc's REAL rendered output (a stub that
      // returns REPORT_HTML for every path would make LAYER 2 overwrite doc.html
      // with the raw report, defeating the render this test is asserting).
      readFile: (p: string) => (p.endsWith('doc.html') ? readFileSync(p, 'utf8') : REPORT_HTML),
      run: (cmd, timeoutMs) => {
        if (cmd[0] === 'pandoc') return realDeps.run(cmd, timeoutMs); // real render
        // Chrome step: don't launch a browser in CI — capture pandoc's output.
        renderedHtml = readFileSync(join(dir, 'doc.html'), 'utf8');
        return { exitCode: 0, stderr: '' };
      },
      fileSize: () => 4096, // pretend the (stubbed) PDF is non-empty
      whichCmd: () => '/usr/bin/google-chrome', // findChrome succeeds
    };

    const out = convertHtmlToPdf('/proj/tg-report.html', deps, DEVICE_PRESETS.iphone15pro);
    expect(out.error).toBeNull();
    expect(out.pdfPath).toBe(join(dir, 'tg-report.html.pdf'));

    // 1) The rendered DOM has REAL formatting (this is the fix).
    expect(renderedHtml).toMatch(/<strong>\s*Drag-cluster e2e: fixed\s*<\/strong>/i);
    expect(renderedHtml).toMatch(/<h1[^>]*>\s*Heading/i);
    expect(renderedHtml).toMatch(/<table[\s>]/i);
    expect(renderedHtml).toMatch(/<blockquote[\s>]/i);
    expect(renderedHtml).toMatch(/<ul[\s>]/i);
    expect(renderedHtml).toMatch(/<th[\s>]/i);

    // 2) The raw-tag bug is GONE: no escaped `<b>`/`<table>`/`<h1>` source text
    //    leaks into the rendered body as literal characters.
    expect(renderedHtml).not.toContain('&lt;b&gt;');
    expect(renderedHtml).not.toContain('&lt;/b&gt;');
    expect(renderedHtml).not.toContain('&lt;table&gt;');
    expect(renderedHtml).not.toContain('&lt;h1&gt;');

    // 3) The whole report was NOT wrapped in a single code block (the fence
    //    path). The only <code> present is the inline <code> the report itself
    //    authored — never a <pre><code> wrapping the entire body.
    const bodyMatch = renderedHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    const body = bodyMatch ? bodyMatch[1] : renderedHtml;
    expect(body).not.toMatch(/<pre[^>]*>\s*<code[^>]*class="[^"]*\bhtml\b/i);
    // The intentional inline <code>&lt;div&gt;</code> entity renders as the
    // visible text `<div>` (correct: it was authored as an entity).
    expect(renderedHtml).toContain('findNearestSourceLocation');
  },
  60_000,
);

// END-TO-END regression for the #95 review finding: an `on*=` handler shielded by
// a `>` inside a quoted attribute value survives the raw-input strip and is then
// PRESERVED by pandoc on the element it models — so it must be removed from
// pandoc's output (LAYER 2) before Chrome prints. Runs real pandoc, stubs Chrome,
// and inspects the exact html5 (doc.html) handed to the print: NO handler.
test.skipIf(!pandocAvailable)(
  'integration(real pandoc): a `>`-shielded onerror is stripped from the printed doc (review bypass)',
  () => {
    let printedHtml = '';
    const dir = tempDir('tg-htmlpdf-bypass-');
    // The raw report: the `>` inside alt="…" defeats a first-`>` raw matcher; the
    // trailing onerror would otherwise reach pandoc and be kept on the <img>.
    const payload = '<b>ok</b>\n<img alt=">" src="x" onerror="beacon()">\n';
    const deps: ConvertDeps = {
      ...realDeps,
      makeTempDir: () => dir,
      readFile: (p: string) => (p.endsWith('doc.html') ? readFileSync(p, 'utf8') : payload),
      writeFile: (p, c) => writeFileSync(p, c),
      run: (cmd, timeoutMs) => {
        if (cmd[0] === 'pandoc') return realDeps.run(cmd, timeoutMs); // real render
        // Chrome step: capture the doc.html that LAYER 2 has already rewritten.
        printedHtml = readFileSync(join(dir, 'doc.html'), 'utf8');
        return { exitCode: 0, stderr: '' };
      },
      fileSize: () => 4096,
      whichCmd: () => '/usr/bin/google-chrome',
    };

    const out = convertHtmlToPdf('/proj/report.html', deps, DEVICE_PRESETS.iphone15pro);
    expect(out.error).toBeNull();

    // The image element survives (the report can show images); the HANDLER is gone.
    expect(printedHtml).toMatch(/<img[\s>]/i);
    expect(printedHtml).not.toMatch(/onerror/i);
    expect(printedHtml).not.toContain('beacon()');
    // Sanity: prove pandoc ran and we inspected its real output (not a vacuous
    // green) — the bold text is rendered as <strong>.
    expect(printedHtml).toMatch(/<strong>\s*ok\s*<\/strong>/i);
  },
  60_000,
);

// Render `report` with REAL pandoc but a stubbed Chrome, returning the exact
// doc.html (post-LAYER-2) that would be printed. Shared by the payload-shape and
// content-survival integration tests so they can't drift on the deps wiring.
function renderPrintedDoc(report: string): string {
  const dir = tempDir('tg-htmlpdf-shape-');
  let printed = '';
  const deps: ConvertDeps = {
    ...realDeps,
    makeTempDir: () => dir,
    readFile: (p: string) => (p.endsWith('doc.html') ? readFileSync(p, 'utf8') : report),
    run: (cmd, timeoutMs) => {
      if (cmd[0] === 'pandoc') return realDeps.run(cmd, timeoutMs);
      printed = readFileSync(join(dir, 'doc.html'), 'utf8');
      return { exitCode: 0, stderr: '' };
    },
    fileSize: () => 4096,
    fileExists: () => true,
    whichCmd: () => '/usr/bin/google-chrome',
  };
  const out = convertHtmlToPdf('/proj/report.html', deps, DEVICE_PRESETS.iphone15pro);
  expect(out.error).toBeNull();
  return printed;
}

// The #95 review questioned whether stripEventHandlerAttrs's "pandoc always
// double-quotes / escapes `>`" assumption holds for OTHER handler shapes. Prove it
// against the actual pandoc on PATH: every shape is neutralized end-to-end.
test.skipIf(!pandocAvailable)(
  'integration(real pandoc): on*= handlers are stripped for unquoted / single-quoted / `>`-in-value shapes',
  () => {
    const shapes = [
      '<b>ok</b><img src="x" onerror=beacon()>', // unquoted value
      "<b>ok</b><img src='x' onerror='beacon()'>", // single-quoted value
      '<b>ok</b><img alt=">" src="x" onerror="beacon()">', // `>` shields a raw matcher
      '<b>ok</b><div ONCLICK="beacon()">y</div>', // uppercase handler name
    ];
    for (const report of shapes) {
      const printed = renderPrintedDoc(report);
      expect(printed).not.toMatch(/on(error|click)\s*=/i);
      expect(printed).not.toContain('beacon()');
      // Sanity: pandoc actually ran and we read its real output.
      expect(printed).toMatch(/<strong>\s*ok\s*<\/strong>/i);
    }
  },
  60_000,
);

// A `<svg onload>` carried in a report must be neutralized end-to-end (LAYER 1
// strips the whole subtree before pandoc). Real pandoc + stubbed Chrome.
test.skipIf(!pandocAvailable)(
  'integration(real pandoc): a <svg onload> in a report is stripped before the print',
  () => {
    const printed = renderPrintedDoc('<b>ok</b><svg onload="beacon()"><circle r="9"/></svg><i>done</i>');
    expect(printed).not.toMatch(/onload/i);
    expect(printed).not.toContain('beacon()');
    expect(printed).not.toMatch(/<svg/i);
    expect(printed).toMatch(/<strong>\s*ok\s*<\/strong>/i);
  },
  60_000,
);

// Content-loss guard: pandoc's handling of UNKNOWN Telegram custom tags
// (<tg-spoiler>/<tg-emoji>) is version-dependent — it must not drop the element's
// TEXT. The literal-tag bug at least showed the text; the fix must not regress to
// losing it. Assert the inner text survives in the printed doc.
test.skipIf(!pandocAvailable)(
  'integration(real pandoc): text inside Telegram custom tags survives in the rendered doc',
  () => {
    const printed = renderPrintedDoc('<b>ok</b> <tg-spoiler>hidden text</tg-spoiler> <tg-emoji emoji-id="5">x</tg-emoji>');
    expect(printed).toContain('hidden text');
    expect(printed).toMatch(/<strong>\s*ok\s*<\/strong>/i);
  },
  60_000,
);
