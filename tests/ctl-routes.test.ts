import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parseRoutes,
  appendRoute,
  serializeRoutes,
  recognizeRoute,
  resolveRouteCwd,
  routeMatchesPane,
  aggregateUsage,
  orderByLruMru,
  withRoutesLock,
  fsRoutesLockIo,
  MAX_ROUTES,
  type Route,
  type RoutesLockIo,
} from '../features/tg-ctl/routes';

const R = (id: number, paneId: string, ts: number): Route => ({ id, paneId, ts });

test('parseRoutes: tolerates garbage, keeps valid entries', () => {
  expect(parseRoutes(null)).toEqual([]);
  expect(parseRoutes('not json')).toEqual([]);
  expect(parseRoutes('{}')).toEqual([]);
  expect(parseRoutes(JSON.stringify([{ id: 1, paneId: '%1', ts: 10 }, { id: 'x' }]))).toEqual([
    { id: 1, paneId: '%1', cwd: undefined, ts: 10 },
  ]);
});

test('appendRoute: dedups by id and caps to MAX_ROUTES', () => {
  let routes: Route[] = [];
  for (let i = 0; i < MAX_ROUTES + 50; i++) routes = appendRoute(routes, R(i, '%1', i));
  expect(routes.length).toBe(MAX_ROUTES);
  expect(routes[0].id).toBe(50); // oldest 50 dropped
  // re-appending an existing id moves it to the end, no duplicate
  routes = appendRoute(routes, R(60, '%2', 999));
  expect(routes.filter((r) => r.id === 60).length).toBe(1);
  expect(routes[routes.length - 1]).toMatchObject({ id: 60, paneId: '%2', ts: 999 });
});

test('serialize → parse round-trips', () => {
  const routes = [
    R(1, '%1', 10),
    { id: 2, paneId: 'omp:200', cwd: '/x', parentPaneId: 'omp:100', ts: 20 },
  ];
  expect(parseRoutes(serializeRoutes(routes))).toEqual([
    { id: 1, paneId: '%1', cwd: undefined, parentPaneId: undefined, ts: 10 },
    { id: 2, paneId: 'omp:200', cwd: '/x', parentPaneId: 'omp:100', ts: 20 },
  ]);
});

test('recognizeRoute: last matching id wins, else null', () => {
  const routes = [R(1, '%1', 10), R(2, '%2', 20)];
  expect(recognizeRoute(routes, 2)?.paneId).toBe('%2');
  expect(recognizeRoute(routes, 99)).toBeNull();
});

test('aggregateUsage: recency (max ts) + frequency (count) per pane', () => {
  const usage = aggregateUsage([R(1, '%1', 10), R(2, '%1', 30), R(3, '%2', 20)]);
  expect(usage.get('%1')).toEqual({ lastTs: 30, count: 2 });
  expect(usage.get('%2')).toEqual({ lastTs: 20, count: 1 });
});

test('orderByLruMru: most recent first, frequency tiebreak, unknown last', () => {
  const usage = aggregateUsage([
    R(1, '%a', 100),
    R(2, '%b', 200),
    R(3, '%b', 50),
    R(4, '%c', 200), // same recency as %b, but lower count
  ]);
  // input order deliberately scrambled; %unknown has no history
  const ordered = orderByLruMru(['%c', '%unknown', '%a', '%b'], usage);
  expect(ordered).toEqual(['%b', '%c', '%a', '%unknown']);
});

// --- resolveRouteCwd + routeMatchesPane (reply-routing fix) ---
//
// Regression for: replying to an agent message always opened the picker instead
// of routing to the pane. Root cause = `tg` recorded `process.cwd()` (agents run
// from /tmp) while the daemon compares against the pane's `pane_current_path`, so
// `sameProject` was always false. The fix records the pane path at send time, so
// both sides compare the same quantity.

test('resolveRouteCwd: records the PANE path, not process.cwd() — and the daemon then MATCHES (no picker)', () => {
  // Agent reality: `tg` invoked from /tmp, but the tmux pane sits in the project.
  const processCwd = '/private/tmp';
  const panePath = '/Users/alex/work/my-project';

  const recordedCwd = resolveRouteCwd({ queryPanePath: () => panePath, fallbackCwd: processCwd });

  // The OLD behavior recorded process.cwd() (= /private/tmp). Assert we did NOT.
  expect(recordedCwd).toBe(panePath);
  expect(recordedCwd).not.toBe(processCwd);

  // End-to-end: a route stamped with this cwd, recognized on reply, matches the
  // live pane (whose panePath is the project dir) → routes straight to the pane.
  const routes = appendRoute([], { id: 42, paneId: '%7', cwd: recordedCwd, ts: 100 });
  const recognized = recognizeRoute(parseRoutes(serializeRoutes(routes)), 42);
  expect(recognized).not.toBeNull();
  expect(routeMatchesPane({ recognizedCwd: recognized!.cwd, panePath })).toBe(true);

  // Proof this would FAIL under the old code: had we recorded process.cwd(), the
  // same comparison against the pane path would NOT match → picker.
  expect(routeMatchesPane({ recognizedCwd: processCwd, panePath })).toBe(false);
});

test('resolveRouteCwd: falls back to process.cwd() when not in tmux / query fails or is empty', () => {
  expect(resolveRouteCwd({ queryPanePath: () => null, fallbackCwd: '/p' })).toBe('/p');
  expect(resolveRouteCwd({ queryPanePath: () => '', fallbackCwd: '/p' })).toBe('/p');
});

test('routeMatchesPane: same path matches even when one side is unresolved/relative', () => {
  expect(routeMatchesPane({ recognizedCwd: '/a/b', panePath: '/a/b' })).toBe(true);
  expect(routeMatchesPane({ recognizedCwd: '/a/b/', panePath: '/a/b' })).toBe(true); // trailing slash normalized
});

test('routeMatchesPane: pane-id reuse by a DIFFERENT project still mismatches (04cb6e5 guard preserved)', () => {
  // Same %N, but the pane is now in a different project than the recorded route.
  expect(routeMatchesPane({ recognizedCwd: '/proj-a', panePath: '/proj-b' })).toBe(false);
});

test('routeMatchesPane: absent recorded cwd (old route) or absent pane → no match (picker fallback)', () => {
  expect(routeMatchesPane({ recognizedCwd: undefined, panePath: '/a' })).toBe(false);
  expect(routeMatchesPane({ recognizedCwd: '/a', panePath: undefined })).toBe(false);
});

test('routeMatchesPane: an EMPTY panePath never matches, even when recognizedCwd happens to equal the daemon\'s own cwd (review finding)', () => {
  // resolve('') resolves to process.cwd() — without the explicit empty-string
  // guard, a recognizedCwd that happens to equal wherever the daemon was
  // launched from would falsely match ANY live candidate reporting no
  // pane_current_path, bypassing the pane-id-reuse protection entirely.
  expect(routeMatchesPane({ recognizedCwd: process.cwd(), panePath: '' })).toBe(false);
});

// --- withRoutesLock + fsRoutesLockIo (issue #53 part B: concurrent route writers must not clobber) ---
//
// In-memory model of an O_EXCL lockfile whose owner is a PID; a held lock is
// "stale" only when its owner process is DEAD (liveness, not age). Two writers
// each do a read-modify-write (the recordRoute shape); the lock must serialize
// them so no appended entry is lost.

interface FakeLock {
  ownerPid: number | null; // null = lockfile absent
}

// A fake io for `myPid`, sharing one lockfile + a liveness oracle (set of alive
// pids). All removals are ownership-checked, mirroring fsRoutesLockIo.
function fakeIo(lock: FakeLock, myPid: number, alive: Set<number>, log: string[] = []): RoutesLockIo {
  const unlinkIfOwner = (pid: number): void => {
    if (lock.ownerPid === pid) lock.ownerPid = null;
  };
  return {
    acquire: () => {
      if (lock.ownerPid !== null) return false;
      lock.ownerPid = myPid;
      log.push(`acquire:${myPid}`);
      return true;
    },
    release: () => {
      unlinkIfOwner(myPid);
      log.push(`release:${myPid}`);
    },
    ownerDead: () => (lock.ownerPid === null ? null : !alive.has(lock.ownerPid)),
    breakIfDead: () => {
      if (lock.ownerPid !== null && !alive.has(lock.ownerPid)) {
        log.push(`break:${lock.ownerPid}`);
        unlinkIfOwner(lock.ownerPid);
      }
    },
    sleep: () => {},
  };
}

test('withRoutesLock: acquires, runs body, always releases', () => {
  const lock: FakeLock = { ownerPid: null };
  const log: string[] = [];
  const out = withRoutesLock(fakeIo(lock, 100, new Set([100]), log), () => 42);
  expect(out).toBe(42);
  expect(lock.ownerPid).toBeNull(); // released
  expect(log).toEqual(['acquire:100', 'release:100']);
});

test('withRoutesLock: releases even when the body throws', () => {
  const lock: FakeLock = { ownerPid: null };
  expect(() =>
    withRoutesLock(fakeIo(lock, 100, new Set([100])), () => {
      throw new Error('boom');
    }),
  ).toThrow('boom');
  expect(lock.ownerPid).toBeNull(); // released despite the throw
});

test('withRoutesLock: serialized writers lose NO entries; a blocked-by-LIVE-owner writer never clobbers', () => {
  const lock: FakeLock = { ownerPid: null };
  const alive = new Set([100, 200]);
  let file: string | null = null;

  const writeRoute = (pid: number, id: number, paneId: string): void => {
    withRoutesLock(fakeIo(lock, pid, alive), () => {
      const existing = parseRoutes(file);
      file = serializeRoutes(appendRoute(existing, { id, paneId, ts: id }));
    });
  };

  // Worst interleaving: writer 200 tries while LIVE writer 100 holds the lock and
  // is mid-RMW. 200 must block (live owner never broken) and run AFTER, so 100's
  // entry is still present when 200 reads → no clobber.
  let inner: string | null = null;
  withRoutesLock(fakeIo(lock, 100, alive), () => {
    file = serializeRoutes(appendRoute(parseRoutes(file), { id: 500, paneId: '%5', ts: 500 }));
    // 200 attempts to write WHILE 100 holds the lock (attempts bounded → unlocked
    // fallback), but because it reads the same `file` 100 already wrote, the
    // append keeps BOTH — and critically it could NOT acquire (live owner).
    withRoutesLock(
      fakeIo(lock, 200, alive),
      () => {
        inner = '200-body-ran';
        file = serializeRoutes(appendRoute(parseRoutes(file), { id: 501, paneId: '%2', ts: 501 }));
      },
      { attempts: 2, delayMs: 0 },
    );
  });
  expect(inner).toBe('200-body-ran');
  const routes = parseRoutes(file);
  expect(routes.map((r) => r.id).sort()).toEqual([500, 501]); // BOTH survived
  expect(recognizeRoute(routes, 500)?.paneId).toBe('%5');
  expect(recognizeRoute(routes, 501)?.paneId).toBe('%2');

  // And a plain serialized pair also keeps both.
  file = null;
  writeRoute(100, 600, '%6');
  writeRoute(200, 601, '%7');
  expect(parseRoutes(file).map((r) => r.id).sort()).toEqual([600, 601]);
});

test('withRoutesLock: a DEAD-owner lock (crashed writer) is broken by liveness, then acquired', () => {
  const lock: FakeLock = { ownerPid: 999 }; // crashed writer left this
  const alive = new Set([100]); // 999 is DEAD, 100 (us) is alive
  const log: string[] = [];
  let ran = false;
  withRoutesLock(fakeIo(lock, 100, alive, log), () => {
    ran = true;
  }, { attempts: 3, delayMs: 0 });
  expect(ran).toBe(true);
  expect(log).toContain('break:999'); // the dead owner's lock was broken
  expect(log).toContain('acquire:100'); // then we acquired
  expect(lock.ownerPid).toBeNull(); // and released
});

test('withRoutesLock: a LIVE-owner lock is NEVER broken (the #53 race the mtime approach had)', () => {
  // Owner 999 holds the lock and IS alive (a slow-but-running writer). A second
  // writer must NOT break it — liveness, not age, is the staleness signal.
  const lock: FakeLock = { ownerPid: 999 };
  const alive = new Set([999, 100]); // 999 alive — must be left alone
  const log: string[] = [];
  let ran = false;
  withRoutesLock(fakeIo(lock, 100, alive, log), () => {
    ran = true;
  }, { attempts: 3, delayMs: 0 });
  expect(ran).toBe(true); // body still ran (unlocked fallback)
  expect(log).not.toContain('break:999'); // the LIVE owner's lock was untouched
  expect(lock.ownerPid).toBe(999); // still held by the live owner
});

// A lock perpetually held by a LIVE writer: acquire never succeeds, owner never
// dead → never broken.
function liveHeldIo(counter: { attempts: number }): RoutesLockIo {
  return {
    acquire: () => {
      counter.attempts += 1;
      return false;
    },
    release: () => {},
    ownerDead: () => false, // owner alive — never broken
    breakIfDead: () => {},
    sleep: () => {},
  };
}

test('withRoutesLock: default (run-unlocked) runs the body even under sustained live contention', () => {
  const counter = { attempts: 0 };
  let ran = false;
  const out = withRoutesLock(liveHeldIo(counter), () => {
    ran = true;
    return 'ran';
  }, { attempts: 4, delayMs: 0 });
  expect(ran).toBe(true); // legacy behavior: body ran despite never acquiring
  expect(out).toBe('ran');
  expect(counter.attempts).toBe(4); // it really tried the full budget
});

test('withRoutesLock: onContended=skip does NOT run the body unlocked (no clobber — codex #55)', () => {
  // The fix for the lost-update window: under sustained live contention a
  // shared-file RMW must SKIP, not run unlocked (which could overwrite the
  // concurrent holder's good entry). Returns undefined; body never executes.
  const counter = { attempts: 0 };
  let ran = false;
  const out = withRoutesLock(liveHeldIo(counter), () => {
    ran = true;
    return 'ran';
  }, { attempts: 4, delayMs: 0, onContended: 'skip' });
  expect(ran).toBe(false); // body did NOT run — no unlocked clobber
  expect(out).toBeUndefined();
  expect(counter.attempts).toBe(4); // still spun the full budget first
});

test('withRoutesLock: onContended=skip STILL runs the body when the lock IS acquired', () => {
  // skip only suppresses the UNLOCKED fallback; a normal acquire runs+releases.
  const lock: FakeLock = { ownerPid: null };
  let ran = false;
  const out = withRoutesLock(fakeIo(lock, 100, new Set([100])), () => {
    ran = true;
    return 7;
  }, { onContended: 'skip' });
  expect(ran).toBe(true);
  expect(out).toBe(7);
  expect(lock.ownerPid).toBeNull(); // released
});

// --- fsRoutesLockIo: the REAL filesystem backing (O_EXCL lockfile + pid liveness) ---

test('fsRoutesLockIo: real O_EXCL lockfile serializes two writers — no lost route entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-routeslock-'));
  const routesFile = join(dir, 'routes.json');
  const lockPath = `${routesFile}.lock`;
  const alive = new Set([111, 222]);
  const isAlive = (pid: number): boolean => alive.has(pid);

  // Read race-free: a single readFileSync in try/catch (ENOENT → empty), NOT an
  // existsSync-then-read (that check-then-use is a TOCTOU pattern CodeQL flags).
  const readRoutesRaw = (): string | null => {
    try {
      return readFileSync(routesFile, 'utf8');
    } catch {
      return null;
    }
  };
  const write = (pid: number, id: number, paneId: string): void => {
    withRoutesLock(fsRoutesLockIo(lockPath, { ownPid: pid, isAlive }), () => {
      const existing = parseRoutes(readRoutesRaw());
      writeFileSync(routesFile, serializeRoutes(appendRoute(existing, { id, paneId, ts: id })));
    });
  };

  write(111, 700, '%5');
  write(222, 701, '%2');

  const routes = parseRoutes(readFileSync(routesFile, 'utf8'));
  expect(routes.map((r) => r.id).sort()).toEqual([700, 701]);
  expect(existsSync(lockPath)).toBe(false); // lock released after each write
});

test('fsRoutesLockIo: a real DEAD-owner lockfile is broken; a real held lock blocks acquire', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-routeslock-dead-'));
  const lockPath = join(dir, 'routes.json.lock');

  // A crashed writer left a lockfile owned by a DEAD pid.
  writeFileSync(lockPath, '999');
  const isAliveNone = (): boolean => false; // 999 is dead

  const io = fsRoutesLockIo(lockPath, { ownPid: 111, isAlive: isAliveNone });
  expect(io.ownerDead()).toBe(true); // dead owner detected
  io.breakIfDead();
  expect(existsSync(lockPath)).toBe(false); // dead lock removed

  // Now acquire really creates the file, and a second acquire (lock held) fails.
  expect(io.acquire()).toBe(true);
  expect(existsSync(lockPath)).toBe(true);
  expect(readFileSync(lockPath, 'utf8')).toBe('111'); // our pid stamped
  const other = fsRoutesLockIo(lockPath, { ownPid: 222, isAlive: () => true });
  expect(other.acquire()).toBe(false); // O_EXCL blocks the second writer
  // ownership-checked release: the OTHER writer's release must NOT remove our lock.
  other.release();
  expect(existsSync(lockPath)).toBe(true); // still ours — not nuked by 222
  io.release();
  expect(existsSync(lockPath)).toBe(false); // our own release removes it
});

test('fsRoutesLockIo: an EMPTY/unparseable lockfile (SIGKILL-window orphan) is breakable — no permanent wedge', () => {
  // Regression for review #53 finding 1: a `tg` SIGKILLed between openSync('wx')
  // and writeFileSync(pid) leaves a present-but-EMPTY lockfile with no owner. The
  // old two-state read treated "unreadable" like "absent" → never broken → every
  // later send wedged. It must now be classified breakable.
  const dir = mkdtempSync(join(tmpdir(), 'tg-routeslock-orphan-'));
  const lockPath = join(dir, 'routes.json.lock');

  for (const garbage of ['', '   ', 'not-a-pid', '0', '-5']) {
    writeFileSync(lockPath, garbage);
    // isAlive must be irrelevant here — there is no pid to probe; the orphan is
    // breakable purely because its owner is unreadable.
    const io = fsRoutesLockIo(lockPath, { ownPid: 111, isAlive: () => true });
    expect(io.ownerDead()).toBe(true); // unparseable owner ⇒ breakable
    io.breakIfDead();
    expect(existsSync(lockPath)).toBe(false); // orphan removed, mutex un-wedged
  }

  // And withRoutesLock recovers end-to-end: an orphan lockfile present, the body
  // still runs AND acquires (the orphan was broken), leaving a clean released lock.
  writeFileSync(lockPath, '');
  let ran = false;
  withRoutesLock(fsRoutesLockIo(lockPath, { ownPid: 111, isAlive: () => true }), () => {
    ran = true;
  }, { attempts: 3, delayMs: 0 });
  expect(ran).toBe(true);
  expect(existsSync(lockPath)).toBe(false); // recovered + released, not wedged
});

test('fsRoutesLockIo: a missing PARENT dir makes acquire THROW (not spin) → fast unlocked fallback', () => {
  // Regression for review #53 finding 2: a non-EEXIST open error (here ENOENT —
  // the parent dir does not exist) must NOT be swallowed as "held" (which would
  // spin the whole budget). acquire throws; withRoutesLock lets it propagate so
  // the caller's outer try runs the body unlocked immediately.
  const io = fsRoutesLockIo('/no/such/dir/routes.json.lock', { ownPid: 111, isAlive: () => true });
  expect(() => io.acquire()).toThrow(); // ENOENT surfaced, not masked as false
});
