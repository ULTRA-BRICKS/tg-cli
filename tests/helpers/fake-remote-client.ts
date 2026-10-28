// A per-operation stand-in `tg-remote` for the CLIENT-side tests (TG_REMOTE_BIN seam, spec §9).
//
// `fake-remote.ts` answers every invocation with one canned reply, which is enough for the offline
// `config check`. The client mode also runs `client record|hello|status`, each with its own reply,
// its own stdin (the record JSON) and its own failure shapes (garbage, non-zero exit, a hang whose
// ssh-like child must die with the group). Every call is logged next to the launcher, including how
// the interpreter was started (`sys.orig_argv`, `sys.flags.isolated`) and whether a planted
// `./tgcli` in the caller's cwd could be imported.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { RemoteRecord } from '../../features/cli/outbound-runtime/remote-record';
import { REMOTE_OK_CLIENT } from './fake-remote';
import { tempDir } from './test-temp';

export type FakeOp = 'config check' | 'client record' | 'client status' | 'client hello';

export interface FakeReply {
  stdout?: string;
  stderr?: string;
  exit?: number;
  /** Sleep before answering; with `child` the sleeper is a grandchild (the ssh a hung tool leaves behind). */
  sleepMs?: number;
  child?: boolean;
  /** Start a `setsid` grandchild that outlives the group kill and keeps this process's stdout open. */
  escape?: boolean;
}

export interface FakeClientCall {
  /** sys.orig_argv: the interpreter, its flags and the launcher, exactly as TypeScript spawned them. */
  origArgv: string[];
  argv: string[];
  stdin: string | null;
  configDir: string | null;
  cwd: string;
  isolated: boolean;
  /** true when `import tgcli` found a package (a planted ./tgcli must never be importable). */
  tgcliImported: boolean;
  cwdOnSysPath: boolean;
}

const LAUNCHER = `import json, os, subprocess, sys, time
here = os.path.dirname(os.path.abspath(__file__))
argv = sys.argv[1:]
op = ' '.join(argv[:2])
plan = json.load(open(os.path.join(here, 'plan.json')))
reply = plan.get(op) or {}
stdin = sys.stdin.read() if op == 'client record' else None
cwd = os.getcwd()
try:
    import tgcli
    imported = True
except Exception:
    imported = False
with open(os.path.join(here, 'calls.log'), 'a') as log:
    log.write(json.dumps({
        'origArgv': list(sys.orig_argv), 'argv': argv, 'stdin': stdin, 'configDir': os.environ.get('TG_CTL_CONFIG_DIR'),
        'cwd': cwd, 'isolated': bool(sys.flags.isolated), 'tgcliImported': imported,
        'cwdOnSysPath': any(p in ('', cwd) for p in sys.path),
    }) + '\\n')
if reply.get('child'):
    child = subprocess.Popen(['sleep', str(int(reply.get('sleepMs', 0) / 1000) + 30)])
    open(os.path.join(here, 'child.pid'), 'w').write(str(child.pid))
if reply.get('escape'):
    escaped = subprocess.Popen(['sleep', '35'], start_new_session=True)
    open(os.path.join(here, 'escape.pid'), 'w').write(str(escaped.pid))
if reply.get('sleepMs'):
    time.sleep(reply['sleepMs'] / 1000)
sys.stdout.write(reply.get('stdout', ''))
sys.stderr.write(reply.get('stderr', ''))
sys.exit(reply.get('exit', 0))
`;

const RECORDED = '{"status":"recorded","detail":"ok"}\n';

export function fakeRemoteClient(initial: Partial<Record<FakeOp, FakeReply>> = {}) {
  const dir = tempDir('tg-fake-remote-client-');
  const bin = join(dir, 'tg-remote');
  writeFileSync(bin, LAUNCHER);
  chmodSync(bin, 0o755);
  const plan: Partial<Record<FakeOp, FakeReply>> = {
    'config check': { stdout: REMOTE_OK_CLIENT },
    'client record': { stdout: RECORDED },
    ...initial,
  };
  const save = () => writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
  save();
  const pidFile = (name: string): number | null => (existsSync(join(dir, name)) ? Number(readFileSync(join(dir, name), 'utf8')) : null);
  const log = join(dir, 'calls.log');
  const calls = (): FakeClientCall[] =>
    existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as FakeClientCall) : [];
  return {
    bin,
    calls,
    /** The calls of one operation, e.g. `client record`. */
    callsOf: (op: FakeOp) => calls().filter((c) => c.argv.slice(0, 2).join(' ') === op),
    /** The record JSON each `client record` call received on stdin. */
    records: (): RemoteRecord[] => calls().filter((c) => c.stdin !== null).map((c) => JSON.parse(c.stdin!) as RemoteRecord),
    setReply: (op: FakeOp, reply: FakeReply) => {
      plan[op] = reply;
      save();
    },
    /** pid of the grandchild a `child: true` reply started, or null. */
    childPid: (): number | null => pidFile('child.pid'),
    /** pid of the session-escaping grandchild an `escape: true` reply started, or null. */
    escapedPid: (): number | null => pidFile('escape.pid'),
  };
}
