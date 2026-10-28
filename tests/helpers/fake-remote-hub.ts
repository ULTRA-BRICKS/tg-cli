// A scriptable `tg-remote` for the DAEMON-HOST tests (TG_REMOTE_BIN seam, spec §9).
//
// The daemon spawns `python3 -I <launcher> config check --json | hub deliver <m> | hub hello <m>`.
// This fake answers the config check from the machines it was built with, and answers `hub deliver`
// / `hub hello` from per-machine spec files the test may rewrite between calls (so one test can
// script "fails, then succeeds"). Every call is logged with its argv, whether the interpreter ran
// isolated (`python3 -I`), its config dir and the stdin of a deliver — the sentinel for "this
// machine never spawned anything" and for "exactly one deliver, with exactly this request".
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tempDir } from './test-temp';

export interface FakeHubCall {
  argv: string[];
  isolated: number;
  configDir: string | null;
  stdin: string;
}

export interface FakeAnswer {
  stdout: string;
  exit?: number;
  /** Seconds to hold the answer back (a hanging link). */
  sleep?: number;
}

const LAUNCHER = `import json, os, sys, time
here = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
stdin = sys.stdin.read() if args[:2] == ['hub', 'deliver'] else ''
with open(os.path.join(here, 'calls.log'), 'a') as log:
    log.write(json.dumps({'argv': args, 'isolated': sys.flags.isolated, 'configDir': os.environ.get('TG_CTL_CONFIG_DIR'), 'stdin': stdin}) + '\\n')

def answer(name, default):
    path = os.path.join(here, name)
    spec = json.load(open(path)) if os.path.exists(path) else default
    if spec.get('sleep'):
        time.sleep(spec['sleep'])
    sys.stdout.write(spec['stdout'])
    sys.exit(spec.get('exit', 0))

if args == ['config', 'check', '--json']:
    sys.stdout.write(open(os.path.join(here, 'config.json')).read())
    sys.exit(0)
if len(args) == 3 and args[:2] == ['hub', 'deliver']:
    answer('deliver.' + args[2] + '.json', {'stdout': '{"ok":true,"sink":"tmux"}\\n'})
if len(args) == 3 and args[:2] == ['hub', 'hello']:
    answer('hello.' + args[2] + '.json', {'stdout': json.dumps({'ok': True, 'peer': args[2], 'bot': '123', 'version': '1.74.0', 'daemon': {'up': True}, 'caps': ['record', 'status']}) + '\\n'})
sys.stderr.write('fake tg-remote: unexpected ' + ' '.join(args) + '\\n')
sys.exit(2)
`;

export interface FakeHub {
  bin: string;
  calls: () => FakeHubCall[];
  /** Deliver calls only, optionally for one machine, with the request parsed. */
  delivers: (machine?: string) => { machine: string; request: Record<string, unknown>; isolated: number }[];
  setDeliver: (machine: string, answer: FakeAnswer) => void;
  setHello: (machine: string, answer: FakeAnswer) => void;
}

export function fakeRemoteHub(machines: { name: string; target: string }[]): FakeHub {
  const dir = tempDir('tg-fake-hub-');
  const bin = join(dir, 'tg-remote');
  writeFileSync(bin, LAUNCHER);
  chmodSync(bin, 0o755);
  writeFileSync(
    join(dir, 'config.json'),
    `${JSON.stringify({ ok: true, mode: 'hub', server: null, alias: null, machine: null, remote_machines: machines, errors: [] })}\n`,
  );
  const log = join(dir, 'calls.log');
  const calls = (): FakeHubCall[] =>
    existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as FakeHubCall) : [];
  return {
    bin,
    calls,
    delivers: (machine) =>
      calls()
        .filter((c) => c.argv[0] === 'hub' && c.argv[1] === 'deliver' && (machine === undefined || c.argv[2] === machine))
        .map((c) => ({ machine: c.argv[2], request: JSON.parse(c.stdin) as Record<string, unknown>, isolated: c.isolated })),
    setDeliver: (machine, answer) => writeFileSync(join(dir, `deliver.${machine}.json`), JSON.stringify(answer)),
    setHello: (machine, answer) => writeFileSync(join(dir, `hello.${machine}.json`), JSON.stringify(answer)),
  };
}
