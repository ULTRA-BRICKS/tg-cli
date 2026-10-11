// scripts/remote-test.sh up to the point it would reach a pod: its input checks, how it reads
// `runpodctl ssh info`, --ephemeral's promise to delete the pod it rented, and a run surviving
// an edit of the script file under it. runpodctl, ssh, rsync and curl are fakes on a hermetic
// PATH that log their arguments; nothing leaves the host and no remote script ever runs here
// (its sweep kills the user's old processes).
import { beforeEach, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { open } from 'fs/promises';
import { join } from 'path';
import { spawnSyncBounded } from './helpers/spawn-sync';
import { tempDir, trackChild } from './helpers/test-temp';

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'remote-test.sh');
const REPO = join(import.meta.dir, '..');
const SAFE_PATH = '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin';
const FAKE_KEY = 'FAKE_RUNPOD_KEY_FOR_THIS_TEST';

let root: string;
let bin: string;
let logs: string;

// `runpodctl ssh info` prints $SSH_INFO (exit 1 when it is empty: the pod has no address yet),
// first waiting for a line on the FIFO $HOLD_FIFO when one is set; `runpodctl pod delete`
// succeeds unless $DELETE_FAILS is set. ssh fails like an unreachable host, except with
// $SSH_ANSWERS set: then a bare
// `true` succeeds, and so does a pod-side script that schedules the pod's own deletion (its
// ssh arguments logged to self-delete). curl records its arguments and the config (`-K -`) it
// read from stdin, and answers the REST API: the Nth pod create with line N of
// $CREATE_RESPONSES (its body logged to curl.bodies; answered $CREATE_DELAY seconds late when
// set), a pod read with $POD_RESPONSE, the pod
// list with line N of $LIST_RESPONSE on its Nth call (NAME standing for the first created pod's
// name), the CPU catalog with $CATALOG_RESPONSE.
const FAKES: Record<string, string> = {
  runpodctl: `#!/bin/bash
echo "$*" >>"$FAKE_LOGS/runpodctl"
case "$1 $2" in
  "ssh info")
    [ -n "$HOLD_FIFO" ] && read -r _ <"$HOLD_FIFO"
    [ -n "$SSH_INFO" ] || { echo "pod not ready" >&2; exit 1; }; printf '%s\\n' "$SSH_INFO" ;;
  "pod delete") [ -z "$DELETE_FAILS" ] || exit 1 ;;
esac`,
  ssh: `#!/bin/bash
echo "$*" >>"$FAKE_LOGS/ssh"
if [ -n "$SSH_ANSWERS" ]; then
  case "\${@: -1}" in
    true) exit 0 ;;
    "bash -s -- "*) grep -q tg-remote-test-delete-at && { echo "$*" >>"$FAKE_LOGS/self-delete"; exit 0; } ;;
  esac
fi
exit 255`,
  rsync: `#!/bin/bash
echo "$*" >>"$FAKE_LOGS/rsync"
exit 255`,
  curl: `#!/bin/bash
for a in "$@"; do printf '%s\\n' "$a"; done >>"$FAKE_LOGS/curl.args"
cat >>"$FAKE_LOGS/curl.config"
method="" url="" body=""
while [ "$#" -gt 0 ]; do
  case "$1" in -X) method=$2; shift ;; -d) body=$2; shift ;; https://*) url=$1 ;; esac
  shift
done
case "$method $url" in
  "GET "*/catalog/*) printf '%s\\n' "$CATALOG_RESPONSE" ;;
  "GET "*/pods/*) printf '%s\\n' "$POD_RESPONSE" ;;
  "GET "*/pods)
    echo >>"$FAKE_LOGS/pod.lists"; name=$(sed -n 1p "$FAKE_LOGS/curl.bodies" | jq -r .name)
    sed -n "$(wc -l <"$FAKE_LOGS/pod.lists")p" <<<"\${LIST_RESPONSE//NAME/$name}" ;;
  "POST "*/pods)
    printf '%s\\n' "$body" >>"$FAKE_LOGS/curl.bodies"
    [ -n "$CREATE_DELAY" ] && sleep "$CREATE_DELAY"
    sed -n "$(wc -l <"$FAKE_LOGS/curl.bodies")p" <<<"$CREATE_RESPONSES" ;;
esac`,
};

beforeEach(() => {
  root = tempDir('remote-test-script-');
  bin = join(root, 'bin');
  logs = join(root, 'logs');
  mkdirSync(bin);
  mkdirSync(logs);
  for (const [name, body] of Object.entries(FAKES)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
});

function env(extra: Record<string, string>): Record<string, string> {
  return {
    PATH: `${bin}:${SAFE_PATH}`,
    HOME: root,
    FAKE_LOGS: logs,
    TG_REMOTE_TEST_CONFIG: join(root, 'no-such-config.env'),
    TG_REMOTE_TEST_POD_ID: 'podshared1',
    TG_REMOTE_TEST_BUN_VERSION: '1.2.3',
    ...extra,
  };
}

function run(extra: Record<string, string>, ...args: string[]) {
  const proc = spawnSyncBounded(['bash', SCRIPT, '-C', REPO, ...args], { env: env(extra) });
  return { code: proc.exitCode, stderr: proc.stderr.toString() };
}

function fakeLog(name: string): string {
  const file = join(logs, name);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

// `runpodctl ssh info` output: one JSON object per address, in the order given.
function sshInfo(...addresses: Array<{ ip: string; port: string }>): string {
  return addresses.map(({ ip, port }) => `{\n  "id": "podshared1",\n  "ip": "${ip}",\n  "port": ${port}\n}`).join('\n');
}

test('a bun version with anything after x.y.z is refused before any pod is touched', () => {
  const r = run({ TG_REMOTE_TEST_BUN_VERSION: '1.2.3/../../etc' }, 'tests/x.test.ts');
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("TG_REMOTE_TEST_BUN_VERSION to x.y.z, got '1.2.3/../../etc'");
  expect(fakeLog('runpodctl')).toBe('');
  expect(fakeLog('ssh')).toBe('');
});

test('the ssh address is the first ip and port runpodctl ssh info prints', () => {
  const r = run(
    { SSH_INFO: sshInfo({ ip: '10.0.0.1', port: '2201' }, { ip: '10.0.0.2', port: '2202' }) },
    'tests/x.test.ts',
  );
  expect(r.code).toBe(255);
  expect(r.stderr).toContain('on 10.0.0.1:2201 failed (ssh)');
  const ssh = fakeLog('ssh');
  expect(ssh).toContain('-p 2201 ');
  expect(ssh).toContain('runner@10.0.0.1 ');
  expect(ssh).not.toContain('10.0.0.2');
  expect(ssh).not.toContain('2202');
});

test('a port that is not a number is a configuration error, not an ssh target', () => {
  for (const port of ['"2201"', '22x', '99999']) {
    const r = run({ SSH_INFO: sshInfo({ ip: '10.0.0.1', port }) }, 'tests/x.test.ts');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('not a port number');
  }
  expect(fakeLog('ssh')).toBe('');
});

test('a pod with no ssh address yet is reported, not dialled', () => {
  const r = run({ SSH_INFO: '' }, 'tests/x.test.ts');
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('pod not ready');
  expect(fakeLog('ssh')).toBe('');
});

test('a run keeps running the script it started with when the file is rewritten under it', async () => {
  // bash reads a script while running it: an in-place edit (a worktree checkout, an editor)
  // once made a passed run end in `process: command not found`. Run a copy, rewrite it in place
  // (same inode, every later line shifted) while the run waits in `runpodctl ssh info`.
  const script = join(root, 'remote-test.sh');
  copyFileSync(SCRIPT, script);
  const fifo = join(root, 'hold');
  expect(spawnSyncBounded(['mkfifo', fifo], { env: { PATH: SAFE_PATH } }).exitCode).toBe(0);
  const proc = trackChild(
    Bun.spawn(['bash', script, '-C', REPO, 'tests/x.test.ts'], {
      env: env({ HOLD_FIFO: fifo, SSH_INFO: sshInfo({ ip: '10.0.0.1', port: '2201' }) }),
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
    }),
  );
  try {
    // Opening the FIFO for writing completes once the fake runpodctl holds it open for reading.
    const hold = await open(fifo, 'w');
    const [first, ...rest] = readFileSync(script, 'utf8').split('\n');
    writeFileSync(script, [first, `# ${'shifted '.repeat(40)}`, ...rest].join('\n'));
    await hold.write('go\n');
    await hold.close();
    expect(await proc.exited).toBe(255);
  } finally {
    proc.kill('SIGKILL');
  }
  const stderr = await new Response(proc.stderr).text();
  expect(stderr).toContain('on 10.0.0.1:2201 failed (ssh)');
  expect(stderr).not.toMatch(/command not found|syntax error/);
}, 30_000);

test('an ephemeral run refuses --keep and --setup instead of renting a pod', () => {
  // --ephemeral with a shared pod configured, and the default with none.
  for (const [extra, mode] of [[{}, ['--ephemeral']], [{ TG_REMOTE_TEST_POD_ID: '' }, []]] as const) {
    for (const flag of ['--keep', '--setup']) {
      const r = run({ RUNPOD_API_KEY: FAKE_KEY, CREATE_RESPONSES: '{"id":"podeph1"}', ...extra }, ...mode, flag);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(`${flag} needs a shared pod`);
    }
  }
  expect(fakeLog('curl.args')).toBe('');
});

test('with no shared pod configured a run rents its own pod', () => {
  const r = run({ TG_REMOTE_TEST_POD_ID: '', RUNPOD_API_KEY: FAKE_KEY, CREATE_RESPONSES: '{"error":"no capacity"}' });
  expect(r.code).toBe(3);
  expect(r.stderr).toContain('renting the pod failed');
  expect(fakeLog('runpodctl')).not.toContain('ssh info podshared1');
}, 30_000); // three name lookups, 2 s apart

test('a dead pod that cannot be deleted stops the run instead of renting another', () => {
  const r = run(
    {
      RUNPOD_API_KEY: FAKE_KEY,
      CREATE_RESPONSES: '{"id":"podeph1"}\n{"id":"podeph2"}',
      POD_RESPONSE: '{"id":"podeph1","dataCenterId":"US-NC-1"}',
      TG_REMOTE_TEST_SSH_WAIT: '0',
      SSH_INFO: '',
      DELETE_FAILS: '1',
    },
    '--ephemeral',
  );
  expect(r.code).toBe(3);
  expect(r.stderr).toContain('could not delete pod podeph1');
  expect(fakeLog('curl.bodies').trim().split('\n')).toHaveLength(1);
  expect(fakeLog('runpodctl').split('\n').filter((line) => line.startsWith('pod delete'))).toHaveLength(3);
}, 30_000); // three failed deletes, 2 s apart

test('a rental whose answer is lost still deletes the pod it created, found by its name', () => {
  const r = run(
    {
      RUNPOD_API_KEY: FAKE_KEY,
      CREATE_RESPONSES: 'curl: (52) Empty reply from server',
      // Not listed on the first look; listed on the second.
      LIST_RESPONSE: '{"pods":[{"id":"podother","name":"other"}]}\n{"pods":[{"id":"podother","name":"other"},{"id":"podlost1","name":"NAME"}]}',
    },
    '--ephemeral',
  );
  expect(r.code).toBe(3);
  expect(r.stderr).toContain('but pod podlost1 exists under its name');
  expect(fakeLog('runpodctl')).toContain('pod delete podlost1');
  expect(fakeLog('runpodctl')).not.toContain('podother');
}, 30_000);

test('--ephemeral reports a failed rental and deletes nothing', () => {
  const r = run({ RUNPOD_API_KEY: FAKE_KEY, CREATE_RESPONSES: '{"error":"no capacity"}' }, '--ephemeral');
  expect(r.code).toBe(3);
  expect(r.stderr).toContain('renting the pod failed: {"error":"no capacity"}');
  expect(fakeLog('runpodctl')).not.toContain('pod delete');
}, 30_000); // three name lookups, 2 s apart

test('--ephemeral replaces a pod whose ssh never answers, once, outside its data center', () => {
  const r = run(
    {
      RUNPOD_API_KEY: FAKE_KEY,
      CREATE_RESPONSES: '{"id":"podeph1"}\n{"id":"podeph2"}',
      POD_RESPONSE: '{"id":"podeph1","dataCenterId":"US-NC-1"}',
      CATALOG_RESPONSE: JSON.stringify({
        dataCenters: [
          { availability: 'HIGH', id: 'EU-SE-1' },
          { availability: 'HIGH', id: 'US-NC-1' },
          { availability: 'NONE', id: 'US-EMPTY' },
          { availability: 'LOW', id: 'US-OK' },
          { availability: 'HIGH', id: 'US-X' },
        ],
      }),
      TG_REMOTE_TEST_AVOID_DATA_CENTERS: 'EU-SE-1,US-X',
      TG_REMOTE_TEST_SSH_WAIT: '0',
      SSH_INFO: '',
    },
    '--ephemeral',
  );
  expect(r.code).toBe(3);
  expect(r.stderr).toContain('pod podeph1 in US-NC-1 has no working ssh after 0s');
  const deletes = fakeLog('runpodctl')
    .split('\n')
    .filter((line) => line.startsWith('pod delete'));
  expect(deletes).toEqual(['pod delete podeph1', 'pod delete podeph2']);
  const bodies = fakeLog('curl.bodies').trim().split('\n').map((line) => JSON.parse(line));
  expect(bodies.map((body) => body.dataCenterIds)).toEqual([
    ['US-NC-1', 'US-OK'],
    ['US-OK'],
  ]);
});

test('--ephemeral stops instead of renting blind when the dead pod has no known data center', () => {
  const r = run(
    {
      RUNPOD_API_KEY: FAKE_KEY,
      CREATE_RESPONSES: '{"id":"podeph1"}\n{"id":"podeph2"}',
      POD_RESPONSE: '{"error":"internal"}',
      TG_REMOTE_TEST_SSH_WAIT: '0',
      SSH_INFO: '',
    },
    '--ephemeral',
  );
  expect(r.code).toBe(3);
  expect(r.stderr).toContain("cannot tell that pod's data center");
  expect(fakeLog('curl.bodies').trim().split('\n')).toHaveLength(1);
  expect(fakeLog('runpodctl')).toContain('pod delete podeph1');
});

test('--ephemeral schedules the pod to delete itself as soon as its ssh answers', () => {
  const r = run(
    {
      RUNPOD_API_KEY: FAKE_KEY,
      CREATE_RESPONSES: '{"id":"podeph1"}',
      SSH_INFO: sshInfo({ ip: '10.0.0.1', port: '2201' }),
      SSH_ANSWERS: '1',
    },
    '--ephemeral',
  );
  // Provisioning then fails over ssh; the client still deletes the pod on its way out.
  expect(r.code).toBe(255);
  expect(fakeLog('self-delete')).toContain('root@10.0.0.1 bash -s -- 3600');
  expect(fakeLog('runpodctl')).toContain('pod delete podeph1');
});

test('--ephemeral never rents in an avoided data center, even when no other one has stock', () => {
  for (const catalog of ['{"dataCenters":[{"availability":"HIGH","id":"EU-SE-1"}]}', 'not json']) {
    const r = run(
      {
        RUNPOD_API_KEY: FAKE_KEY,
        CREATE_RESPONSES: '{"id":"podeph1"}',
        CATALOG_RESPONSE: catalog,
        TG_REMOTE_TEST_AVOID_DATA_CENTERS: 'EU-SE-1',
      },
      '--ephemeral',
    );
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('no data center offers cpu3c outside the avoided ones (EU-SE-1)');
  }
  expect(fakeLog('curl.bodies')).toBe('');
});

test('--ephemeral deletes the pod it rented when stopped with TERM, and keeps the key off argv', async () => {
  const proc = trackChild(
    Bun.spawn(['bash', SCRIPT, '-C', REPO, '--ephemeral', 'tests/x.test.ts'], {
      env: env({ RUNPOD_API_KEY: FAKE_KEY, CREATE_RESPONSES: '{"id":"podeph1","cpu":{"id":"cpu3c"}}', SSH_INFO: '' }),
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
    }),
  );
  let stderr = '';
  let signalled = false;
  try {
    // Stop it once the pod exists and the script is waiting for its ssh. The pipe stays open to
    // the end (a break out of `for await` would cancel it): the trap still writes to it.
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stderr += decoder.decode(value, { stream: true });
      if (!signalled && stderr.includes('waiting for ssh')) {
        proc.kill('SIGTERM');
        signalled = true;
      }
    }
    expect(await proc.exited).toBe(130);
  } finally {
    proc.kill('SIGKILL');
  }
  expect(signalled).toBe(true);
  expect(stderr).toContain('pod podeph1 created');
  expect(stderr).toContain('pod podeph1 deleted');
  expect(fakeLog('runpodctl')).toContain('pod delete podeph1');
  const [body] = fakeLog('curl.bodies').trim().split('\n').map((line) => JSON.parse(line));
  expect(body).toMatchObject({ name: expect.stringMatching(/^tg-remote-test-/), cpu: { id: 'cpu3c', vcpuCount: 8 } });
  expect(body.dataCenterIds).toBeUndefined();
  expect(fakeLog('curl.args')).not.toContain(FAKE_KEY);
  expect(fakeLog('curl.config')).toBe(`header = "Authorization: Bearer ${FAKE_KEY}"\n`);
}, 30_000);

test('a TERM during the create request still deletes the pod, found by its name', async () => {
  const proc = trackChild(
    Bun.spawn(['bash', SCRIPT, '-C', REPO, '--ephemeral', 'tests/x.test.ts'], {
      env: env({
        RUNPOD_API_KEY: FAKE_KEY,
        CREATE_DELAY: '2',
        CREATE_RESPONSES: '{"id":"podlost1"}',
        LIST_RESPONSE: '{"pods":[{"id":"podlost1","name":"NAME"}]}',
      }),
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
    }),
  );
  let stderr = '';
  try {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    let signalled = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stderr += decoder.decode(value, { stream: true });
      if (!signalled && stderr.includes('renting pod')) {
        proc.kill('SIGTERM');
        signalled = true;
      }
    }
    expect(await proc.exited).toBe(130);
  } finally {
    proc.kill('SIGKILL');
  }
  expect(stderr).not.toContain('pod podlost1 created');
  expect(fakeLog('runpodctl')).toContain('pod delete podlost1');
}, 30_000);
