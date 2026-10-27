// The model-render dimension gate end to end through the real `tg` (features/cli/dimension-gate.ts):
// an agent sender (TG_AI_MODEL set) in a 3D project, a fake `3d` on PATH and a mock Bot API.
// A plain render is refused before any API call; a render with a sidecar that passes
// `3d dimension --check` goes out; a failing check blocks; a non-model image needs a written reason.
import { afterAll, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tempDir } from './helpers/test-temp';

const TG = join(import.meta.dir, '..', 'tg');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let nextId = 700;
let calls: string[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const method = new URL(req.url).pathname.split('/').pop() as string;
    if (['sendMessage', 'sendDocument', 'sendPhoto', 'sendMediaGroup'].includes(method)) {
      calls.push(method);
      nextId += 1;
      return Response.json({ ok: true, result: { message_id: nextId } });
    }
    return Response.json({ ok: false, description: `unexpected: ${method}` }, { status: 404 });
  },
});
afterAll(() => server.stop(true));

// A home with a garage-band project, two renders (plain and dimensioned) and a fake `3d` whose
// `dimension --check` verdict is read from a file next to it.
function makeHome(checkExit: number, checkOut: string): { home: string; project: string; bin: string } {
  const home = tempDir('tg-dimension-gate-');
  const cfg = join(home, '.config', 'tg-cli');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  const project = join(home, 'xp', 'garage-band', 'projects', 'spoon-handle', 'print');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'plain.png'), PNG);
  writeFileSync(join(project, 'dims.png'), PNG);
  writeFileSync(join(project, 'dims.png.dims.json'), '{}');
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  const fake3d = join(bin, '3d');
  writeFileSync(fake3d, `#!/bin/sh\n[ "$1" = dimension ] && [ "$2" = --check ] || exit 2\ncat <<'EOF'\n${checkOut}\nEOF\nexit ${checkExit}\n`);
  chmodSync(fake3d, 0o755);
  return { home, project, bin };
}

// Name of the extra-env key that swaps the `tg` script under test (see fakeTgCtl); never reaches the child.
const TG_SCRIPT = '__TG_SCRIPT';

async function tg(
  home: string,
  cwd: string,
  bin: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> {
  const { [TG_SCRIPT]: script = TG, ...env } = extraEnv;
  const proc = Bun.spawn(['bun', script, ...args], {
    cwd,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HOME: home,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
      TMUX: '',
      TG_LAYA: '0',
      TG_AI_EMOJI: 'bot',
      TG_AI_MODEL: 'claude',
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

const CAPTION = 'spoon150_k1se_oriented.stl, 116.3 x 117.9 x 39.7 мм';

test('a plain render from a 3D project is refused before any API call, naming the fix', async () => {
  calls = [];
  const { home, project, bin } = makeHome(0, 'PASS');
  const r = await tg(home, project, bin, ['--photo', 'plain.png', CAPTION]);
  expect(r.code).toBe(1);
  expect(r.err).toContain('dimension gate');
  expect(r.err).toContain('no plain.png.dims.json');
  expect(r.err).toContain('3d dimension <model.stl|3mf|scad> -o <render.png>');
  expect(calls).toEqual([]);
});

test('--dry-run shows the same refusal (the gate runs before the dry-run short-circuit)', async () => {
  const { home, project, bin } = makeHome(0, 'PASS');
  const r = await tg(home, project, bin, ['--dry-run', '--photo', 'plain.png', CAPTION]);
  expect(r.code).toBe(1);
  expect(r.out).not.toContain('tg --dry-run: OK');
});

test('a dimensioned render whose legibility check passes goes out', async () => {
  calls = [];
  const { home, project, bin } = makeHome(0, 'PASS: dimensions on dims.png are legible');
  const r = await tg(home, project, bin, ['--photo', 'dims.png', CAPTION]);
  expect(r.err).not.toContain('dimension gate');
  expect(r.code).toBe(0);
  expect(calls).toContain('sendPhoto');
});

test('a sidecar whose check fails blocks and lists the offenders', async () => {
  calls = [];
  const { home, project, bin } = makeHome(
    1,
    'FAIL: 1 legibility offender(s) on dims.png\n  - X [top]: font-too-small — font 9.0 px at 1280 px width < 14 px',
  );
  const r = await tg(home, project, bin, ['--photo', 'dims.png', CAPTION]);
  expect(r.code).toBe(1);
  expect(r.err).toContain('X [top]: font-too-small');
  expect(calls).toEqual([]);
});

test('an image outside any 3D context with a plain caption is not gated', async () => {
  calls = [];
  const { home, bin } = makeHome(0, 'PASS');
  const elsewhere = join(home, 'notes');
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, 'chart.png'), PNG);
  const r = await tg(home, elsewhere, bin, ['--photo', 'chart.png', 'Dashboard after the fix']);
  expect(r.code).toBe(0);
  expect(calls).toContain('sendPhoto');
});

test('the caption alone puts a send in a 3D context, even from another directory', async () => {
  calls = [];
  const { home, bin } = makeHome(0, 'PASS');
  const elsewhere = join(home, 'notes');
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, 'chart.png'), PNG);
  const r = await tg(home, elsewhere, bin, ['--photo', 'chart.png', 'Вот модель ложки']);
  expect(r.code).toBe(1);
  expect(r.err).toContain('the message mentions');
  expect(calls).toEqual([]);
});

test('a one-word or empty skip reason is refused, the written reason is only a request', async () => {
  calls = [];
  const { home, project, bin } = makeHome(0, 'PASS');
  for (const reason of ['1', 'skip', '', 'not a model']) {
    const r = await tg(home, project, bin, ['--photo', 'plain.png', CAPTION], { RIG_HATCH_REQUEST_TG_DIMENSIONS_SKIP: reason });
    expect(r.code, reason).toBe(1);
    expect(r.err).toContain('dimension gate');
  }
  expect(calls).toEqual([]);
});

test('--automated sends are not gated', async () => {
  calls = [];
  const { home, project, bin } = makeHome(0, 'PASS');
  const r = await tg(home, project, bin, ['--automated', '--photo', 'plain.png', CAPTION]);
  expect(r.err).not.toContain('dimension gate');
  expect(r.code).toBe(0);
});

test('--dry-run with a written reason never asks the owner; it reports what a real send would do', async () => {
  calls = [];
  const { home, project, bin } = makeHome(0, 'PASS');
  const started = Date.now();
  const r = await tg(home, project, bin, ['--dry-run', '--photo', 'plain.png', CAPTION], {
    RIG_HATCH_REQUEST_TG_DIMENSIONS_SKIP: 'a UI thumbnail of the dashboard, not a model',
  });
  expect(r.code).toBe(1);
  expect(r.err).toContain('a real send would ask the owner');
  expect(r.err).toContain('Reason: a UI thumbnail of the dashboard, not a model');
  expect(Date.now() - started).toBeLessThan(30_000);
  expect(calls).toEqual([]);
});

test('a missing `3d` binary blocks with the could-not-run message instead of crashing tg', async () => {
  calls = [];
  const { home, project } = makeHome(0, 'PASS');
  // PATH holds only bun, so `3d` cannot be found.
  const r = await tg(home, project, dirname(process.execPath), ['--photo', 'dims.png', CAPTION], { PATH: dirname(process.execPath) });
  expect(r.code).toBe(1);
  expect(r.err).toContain('the legibility check could not run');
  expect(r.err).not.toMatch(/\n\s+at /);
  expect(calls).toEqual([]);
});

test('a --file image counts, and an image inside a project counts when the cwd is elsewhere', async () => {
  calls = [];
  const { home, project, bin } = makeHome(0, 'PASS');
  const elsewhere = join(home, 'notes');
  mkdirSync(elsewhere, { recursive: true });
  const asFile = await tg(home, project, bin, ['--file', 'plain.png', CAPTION]);
  expect(asFile.code).toBe(1);
  expect(asFile.err).toContain('no plain.png.dims.json');
  const fromElsewhere = await tg(home, elsewhere, bin, ['--photo', join(project, 'plain.png'), 'Dashboard after the fix']);
  expect(fromElsewhere.code).toBe(1);
  expect(fromElsewhere.err).toContain('image plain.png');
  expect(calls).toEqual([]);
});

test('a ~/ path is expanded before the scope check', async () => {
  calls = [];
  const { home, bin } = makeHome(0, 'PASS');
  const elsewhere = join(home, 'notes');
  mkdirSync(elsewhere, { recursive: true });
  const r = await tg(home, elsewhere, bin, ['--photo', '~/xp/garage-band/projects/spoon-handle/print/plain.png', 'Dashboard after the fix']);
  expect(r.code).toBe(1);
  expect(r.err).toContain('dimension gate');
  expect(calls).toEqual([]);
});

// `tg` finds its tg-ctl next to itself, so a test that needs another one runs a COPY of `tg` in a
// directory whose tg-ctl is the stand-in (`ask` exits with `exitCode`, 0 = the owner approved, and
// logs its argv; null = no tg-ctl at all). There is deliberately no env override: an agent must not
// be able to name its own approver.
function fakeTgCtl(home: string, exitCode: number | null): string {
  const dir = join(home, `tg-copy-${exitCode}`);
  mkdirSync(dir, { recursive: true });
  const root = join(import.meta.dir, '..');
  for (const entry of readdirSync(root)) {
    if (entry === 'tg' || entry === 'tg-ctl' || entry === '.git') continue;
    symlinkSync(join(root, entry), join(dir, entry));
  }
  const script = join(dir, 'tg');
  writeFileSync(script, readFileSync(TG));
  chmodSync(script, 0o755);
  if (exitCode !== null) {
    const ctl = join(dir, 'tg-ctl');
    writeFileSync(ctl, `#!/bin/sh\necho "$@" >> "${join(home, 'ask.log')}"\nexit ${exitCode}\n`);
    chmodSync(ctl, 0o755);
  }
  return script;
}

const REASON = 'a UI thumbnail of the dashboard, not a model';

test('an approved skip sends the image; the owner is asked once with the reason and the image', async () => {
  calls = [];
  const { home, project, bin } = makeHome(0, 'PASS');
  const r = await tg(home, project, bin, ['--photo', 'plain.png', CAPTION], {
    RIG_HATCH_REQUEST_TG_DIMENSIONS_SKIP: REASON,
    [TG_SCRIPT]: fakeTgCtl(home, 0),
  });
  expect(r.err).toContain("dimension gate skipped with the owner's approval");
  expect(r.code).toBe(0);
  expect(calls).toContain('sendPhoto');
  const log = readFileSync(join(home, 'ask.log'), 'utf8');
  expect(log.match(/^ask /gm)?.length).toBe(1);
  expect(log).toContain(REASON);
  expect(log).toContain('plain.png');
});

test('a refused skip blocks the send and names the unapproved reason', async () => {
  calls = [];
  const { home, project, bin } = makeHome(0, 'PASS');
  const r = await tg(home, project, bin, ['--photo', 'plain.png', CAPTION], {
    RIG_HATCH_REQUEST_TG_DIMENSIONS_SKIP: REASON,
    [TG_SCRIPT]: fakeTgCtl(home, 1),
  });
  expect(r.code).toBe(1);
  expect(r.err).toContain('the owner did not approve it');
  expect(r.err).toContain('Blocked: nothing was sent.');
  expect(calls).toEqual([]);
});

test('a tg-ctl that cannot be launched blocks with a message instead of crashing tg', async () => {
  calls = [];
  const { home, project, bin } = makeHome(0, 'PASS');
  const r = await tg(home, project, bin, ['--photo', 'plain.png', CAPTION], {
    RIG_HATCH_REQUEST_TG_DIMENSIONS_SKIP: REASON,
    [TG_SCRIPT]: fakeTgCtl(home, null),
  });
  expect(r.code).toBe(1);
  expect(r.err).toContain('could not ask the owner');
  expect(r.err).not.toMatch(/\n\s+at /);
  expect(calls).toEqual([]);
});

test('a send that another gate refuses never reaches the owner approval', async () => {
  calls = [];
  const { home, project, bin } = makeHome(0, 'PASS');
  const r = await tg(home, project, bin, ['--photo', 'plain.png', 'Что делать дальше? Выбери вариант A или B для spoon.stl'], {
    RIG_HATCH_REQUEST_TG_DIMENSIONS_SKIP: REASON,
    [TG_SCRIPT]: fakeTgCtl(home, 0),
  });
  expect(r.code).toBe(1);
  expect(r.err).not.toContain("dimension gate skipped");
  expect(() => readFileSync(join(home, 'ask.log'), 'utf8')).toThrow();
});

test('two attached images: the plain one blocks the send and only it is named', async () => {
  calls = [];
  const { home, project, bin } = makeHome(0, 'PASS');
  const r = await tg(home, project, bin, ['--photo', 'dims.png', '--photo', 'plain.png', CAPTION]);
  expect(r.code).toBe(1);
  expect(r.err).toContain('no plain.png.dims.json');
  expect(r.err).not.toContain('no dims.png.dims.json');
  expect(calls).toEqual([]);
});

test('a symlink to a dimensioned render outside any 3D context uses the sidecar next to the real file', async () => {
  calls = [];
  const { home, project, bin } = makeHome(0, 'PASS');
  const elsewhere = join(home, 'notes');
  mkdirSync(elsewhere, { recursive: true });
  symlinkSync(join(project, 'dims.png'), join(elsewhere, 'link-dims.png'));
  symlinkSync(join(project, 'plain.png'), join(elsewhere, 'link-plain.png'));
  const ok = await tg(home, elsewhere, bin, ['--photo', 'link-dims.png', 'Dashboard after the fix']);
  expect(ok.err).not.toContain('dimension gate');
  expect(ok.code).toBe(0);
  expect(calls).toContain('sendPhoto');
  calls = [];
  const bad = await tg(home, elsewhere, bin, ['--photo', 'link-plain.png', 'Dashboard after the fix']);
  expect(bad.code).toBe(1);
  expect(bad.err).toContain('no plain.png.dims.json');
  expect(calls).toEqual([]);
});

test('the refusal carries the stderr of a failed owner ask', async () => {
  calls = [];
  const { home, project, bin } = makeHome(0, 'PASS');
  const script = fakeTgCtl(home, 3);
  writeFileSync(join(dirname(script), 'tg-ctl'), '#!/bin/sh\necho "ask: bot unreachable" >&2\nexit 3\n');
  const r = await tg(home, project, bin, ['--photo', 'plain.png', CAPTION], {
    RIG_HATCH_REQUEST_TG_DIMENSIONS_SKIP: 'a UI thumbnail of the dashboard, not a model',
    [TG_SCRIPT]: script,
  });
  expect(r.code).toBe(1);
  expect(r.err).toContain('tg-ctl ask: ask: bot unreachable');
  expect(calls).toEqual([]);
});
