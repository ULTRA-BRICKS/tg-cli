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

function writeFakeOmpPs(dir: string, nearestOmpArgs = 'acp --allow-home'): void {
  const script =
    '#!/bin/sh\n' +
    'TG="$PPID"\n' +
    'TGPPID=$(/bin/ps -o ppid= -p "$TG" 2>/dev/null | tr -d " ")\n' +
    '[ -z "$TGPPID" ] && TGPPID=900000\n' +
    'PARENTPID=$((TGPPID + 100000))\n' +
    'echo "$TG $TGPPID bun run tg"\n' +
    `echo "$TGPPID $PARENTPID /opt/homebrew/bin/omp ${nearestOmpArgs}"\n` +
    'echo "$PARENTPID 1 /opt/homebrew/bin/omp"\n';
  writeFileSync(join(dir, 'ps'), script, { mode: 0o755 });
  chmodSync(join(dir, 'ps'), 0o755);
}

test('tg outbound from an ACP helper records the explicit live OMP reply target, never the helper pid', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tg-omp-route-home-'));
  const configDir = mkdtempSync(join(tmpdir(), 'tg-omp-route-cfg-'));
  const binDir = mkdtempSync(join(tmpdir(), 'tg-omp-route-bin-'));
  dirs.push(home, configDir, binDir);
  writeFileSync(join(configDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFakeOmpPs(binDir);

  const received: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/sendMessage')) {
        received.push((await req.json()) as Record<string, unknown>);
        return Response.json({ ok: true, result: { message_id: 77 } });
      }
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  try {
    const proc = Bun.spawn(['bun', TG_SCRIPT, 'hello from omp no tmux'], {
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        HOME: home,
        TG_CTL_CONFIG_DIR: configDir,
        TG_API_BASE: `http://127.0.0.1:${server.port}`,
        TG_CTL_REPLY_TARGET: 'omp:7103',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    expect(stderr).not.toContain('TG_BOT_TOKEN');
    expect(code).toBe(0);
    expect(received).toHaveLength(1);

    const routesPath = join(configDir, 'tg-ctl.123.routes.json');
    expect(existsSync(routesPath)).toBe(true);
    const routes = JSON.parse(readFileSync(routesPath, 'utf8')) as Array<{ id: number; paneId: string; parentPaneId?: string }>;
    expect(routes).toHaveLength(1);
    expect(routes[0].id).toBe(77);
    expect(routes[0].paneId).toBe('omp:7103');
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
  } finally {
    server.stop(true);
  }
}, 15_000);

test('forged TG_CTL_REPLY_TARGET is ignored outside a real omp acp helper', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tg-omp-forged-home-'));
  const configDir = mkdtempSync(join(tmpdir(), 'tg-omp-forged-cfg-'));
  const binDir = mkdtempSync(join(tmpdir(), 'tg-omp-forged-bin-'));
  dirs.push(home, configDir, binDir);
  writeFileSync(join(configDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFakeOmpPs(binDir, '--print child');

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/sendMessage')) {
        return Response.json({ ok: true, result: { message_id: 88 } });
      }
      return Response.json({ ok: false }, { status: 404 });
    },
  });
  try {
    const proc = Bun.spawn(['bun', TG_SCRIPT, 'forged target must not win'], {
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        HOME: home,
        TG_CTL_CONFIG_DIR: configDir,
        TG_API_BASE: `http://127.0.0.1:${server.port}`,
        TG_CTL_REPLY_TARGET: 'omp:7103',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);

    const routes = JSON.parse(
      readFileSync(join(configDir, 'tg-ctl.123.routes.json'), 'utf8'),
    ) as Array<{ paneId: string; parentPaneId?: string }>;
    expect(routes).toHaveLength(1);
    expect(routes[0].paneId).toMatch(/^omp:\d+$/);
    expect(routes[0].paneId).not.toBe('omp:7103');
    expect(routes[0].parentPaneId).toMatch(/^omp:\d+$/);
  } finally {
    server.stop(true);
  }
}, 15_000);
