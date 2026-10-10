import { afterAll, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// tg-cli#339: outbound `tg` from an omp with no tmux pane must stamp routes.json
// paneId omp:<pid> so a Telegram reply can find that live process. tg-cli#363:
// the SAME send must also land in history.jsonl (keyed by the same omp:<pid>
// origin) — without it the daemon's awareness-nudge sweep has zero last-tg-sent
// signal for exactly the headless-agent population it targets.

const TG_SCRIPT = join(import.meta.dir, '..', 'tg');
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// `nestedParent`: the omp `tg` runs under was itself started by another omp
// (a disposable `omp --print` child of a live orchestrator) — its pid is the
// child's pid + 100000 so the test can name it without a real process.
function writeFakeOmpPs(dir: string, nestedParent = false): void {
  const script =
    '#!/bin/sh\n' +
    'TG="$PPID"\n' +
    'TGPPID=$(/bin/ps -o ppid= -p "$TG" 2>/dev/null | tr -d " ")\n' +
    '[ -z "$TGPPID" ] && TGPPID=900000\n' +
    'echo "$TG $TGPPID bun run tg"\n' +
    (nestedParent
      ? 'PARENTPID=$((TGPPID + 100000))\n' +
        'echo "$TGPPID $PARENTPID /opt/homebrew/bin/omp --print child"\n' +
        'echo "$PARENTPID 1 /opt/homebrew/bin/omp"\n'
      : 'echo "$TGPPID 1 /opt/homebrew/bin/omp"\n');
  writeFileSync(join(dir, 'ps'), script, { mode: 0o755 });
  chmodSync(join(dir, 'ps'), 0o755);
}

async function sendFromOmp(nestedParent: boolean, text: string): Promise<{ configDir: string; received: unknown[] }> {
  const home = mkdtempSync(join(tmpdir(), 'tg-omp-route-home-'));
  const configDir = mkdtempSync(join(tmpdir(), 'tg-omp-route-cfg-'));
  const binDir = mkdtempSync(join(tmpdir(), 'tg-omp-route-bin-'));
  dirs.push(home, configDir, binDir);
  writeFileSync(join(configDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFakeOmpPs(binDir, nestedParent);

  const received: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/sendMessage')) {
        received.push(await req.json());
        return Response.json({ ok: true, result: { message_id: 77 } });
      }
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  try {
    const proc = Bun.spawn(['bun', TG_SCRIPT, text], {
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        HOME: home,
        TG_CTL_CONFIG_DIR: configDir,
        TG_API_BASE: `http://127.0.0.1:${server.port}`,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).not.toContain('TG_BOT_TOKEN');
    expect(await proc.exited).toBe(0);
  } finally {
    server.stop(true);
  }
  return { configDir, received };
}

interface RouteRow {
  id: number;
  paneId: string;
  parentPaneId?: string;
}

function readRoutes(configDir: string): RouteRow[] {
  const routesPath = join(configDir, 'tg-ctl.123.routes.json');
  expect(existsSync(routesPath)).toBe(true);
  return JSON.parse(readFileSync(routesPath, 'utf8')) as RouteRow[];
}

test('tg outbound with TMUX unset records route paneId omp:<pid>, and no lineage parent for a lone omp', async () => {
  const { configDir, received } = await sendFromOmp(false, 'hello from omp no tmux');
  expect(received).toHaveLength(1);

  const routes = readRoutes(configDir);
  expect(routes).toHaveLength(1);
  expect(routes[0].id).toBe(77);
  expect(routes[0].paneId).toMatch(/^omp:\d+$/);
  expect(routes[0].parentPaneId).toBeUndefined();

  const historyPath = join(configDir, 'tg-ctl.123.history.jsonl');
  expect(existsSync(historyPath)).toBe(true);
  const historyLines = readFileSync(historyPath, 'utf8').trim().split('\n');
  expect(historyLines).toHaveLength(1);
  const record = JSON.parse(historyLines[0]) as { direction: string; pane: string; text: string };
  expect(record.direction).toBe('agent');
  expect(record.pane).toMatch(/^omp:\d+$/);
  expect(record.pane).toBe(routes[0].paneId);
  expect(record.text).toBe('hello from omp no tmux');
}, 15_000);

// #503: a reply to a disposable nested omp that has since exited must reach the
// omp that STARTED it — proven by the process tree at send time, never guessed
// from a shared cwd. The route names that parent.
test('tg from a nested out-of-tmux omp records the omp that started it as the route lineage parent', async () => {
  const { configDir, received } = await sendFromOmp(true, 'report from a nested omp');
  expect(received).toHaveLength(1);
  const routes = readRoutes(configDir);
  expect(routes).toHaveLength(1);
  const childPid = Number(routes[0].paneId.replace(/^omp:/, ''));
  expect(childPid).toBeGreaterThan(0);
  expect(routes[0].parentPaneId).toBe(`omp:${childPid + 100000}`);
}, 15_000);
