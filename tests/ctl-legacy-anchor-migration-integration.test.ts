import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { tempDir } from './helpers/test-temp';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

// tg-cli#281: last-user-target.json replaces last-alex-target.json. A daemon
// starting against a pre-rename config dir must migrate the legacy anchor
// forward (once it holds the flock — see tg-ctl's runDaemon comment) rather
// than silently resetting the CTO's routing anchor to the ambiguity picker.
test('daemon startup migrates a legacy last-alex-target.json anchor to last-user-target.json', async () => {
  const cfgDir = tempDir('tgctl-legacy-anchor-');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');

  const legacyPath = join(cfgDir, 'tg-ctl.123.last-alex-target.json');
  const newPath = join(cfgDir, 'tg-ctl.123.last-user-target.json');
  const anchor = { paneId: '%7', cwd: '/repo/project', ts: 1700000000 };
  writeFileSync(legacyPath, JSON.stringify(anchor));

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/setMyCommands')) return Response.json({ ok: true, result: true });
      if (url.pathname.endsWith('/getUpdates')) {
        await Bun.sleep(1500);
        return Response.json({ ok: true, result: [] });
      }
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });

  const reg = createDaemonRegistry();
  try {
    const daemon = await spawnDaemon(reg, {
      tgCtlPath: TG_CTL,
      cfgDir,
      env: {
        HOME: cfgDir,
        TG_CTL_CONFIG_DIR: cfgDir,
        TG_API_BASE: `http://127.0.0.1:${server.port}`,
      },
    });

    // spawnDaemon already waited for the socket, which is created well after
    // the flock + migration in runDaemon — so the migration has run by now.
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(newPath)).toBe(true);
    expect(JSON.parse(readFileSync(newPath, 'utf8'))).toEqual(anchor);

    daemon.kill('SIGTERM');
    const exited = await Promise.race([daemon.exited, Bun.sleep(4000).then(() => 'timeout' as const)]);
    expect(exited).not.toBe('timeout');
    expect(daemon.exitCode).toBe(0);
  } finally {
    await reapDaemons(reg);
    server.stop(true);
  }
}, 15_000);

// review finding, round 3: if the legacy file survives alongside an already-
// authoritative new file, a LATER legitimate invalidation of the new file
// (recordLastUserTarget's fail-closed unlink) followed by a restart would
// silently "migrate" the stale legacy copy back — resurrecting exactly the
// anchor the invalidation meant to clear. This test proves the daemon removes
// the legacy file outright in that situation, closing the resurrection path:
// combined with `plans nothing on a fresh install — neither file exists` in
// ctl-lock.test.ts, a later restart after invalidation has nothing left to
// resurrect from.
test('daemon startup never clobbers an existing last-user-target.json, and removes the now-redundant legacy file so it cannot resurrect later', async () => {
  const cfgDir = tempDir('tgctl-legacy-anchor-noop-');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');

  const legacyPath = join(cfgDir, 'tg-ctl.123.last-alex-target.json');
  const newPath = join(cfgDir, 'tg-ctl.123.last-user-target.json');
  const staleAnchor = { paneId: '%1', cwd: '/repo/old', ts: 1 };
  const freshAnchor = { paneId: '%9', cwd: '/repo/fresh', ts: 1700000999 };
  writeFileSync(legacyPath, JSON.stringify(staleAnchor));
  writeFileSync(newPath, JSON.stringify(freshAnchor));

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/setMyCommands')) return Response.json({ ok: true, result: true });
      if (url.pathname.endsWith('/getUpdates')) {
        await Bun.sleep(1500);
        return Response.json({ ok: true, result: [] });
      }
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });

  const reg = createDaemonRegistry();
  try {
    const daemon = await spawnDaemon(reg, {
      tgCtlPath: TG_CTL,
      cfgDir,
      env: {
        HOME: cfgDir,
        TG_CTL_CONFIG_DIR: cfgDir,
        TG_API_BASE: `http://127.0.0.1:${server.port}`,
      },
    });

    // The fresh anchor must survive untouched — migration only fires when the
    // new file is ABSENT (planLegacyLastUserTargetMigration's own contract).
    expect(JSON.parse(readFileSync(newPath, 'utf8'))).toEqual(freshAnchor);
    // The stale legacy copy must be gone, not merely ignored.
    expect(existsSync(legacyPath)).toBe(false);

    daemon.kill('SIGTERM');
    const exited = await Promise.race([daemon.exited, Bun.sleep(4000).then(() => 'timeout' as const)]);
    expect(exited).not.toBe('timeout');
    expect(daemon.exitCode).toBe(0);
  } finally {
    await reapDaemons(reg);
    server.stop(true);
  }
}, 15_000);
