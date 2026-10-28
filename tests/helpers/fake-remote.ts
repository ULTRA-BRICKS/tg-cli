// A stand-in `tg-remote` launcher for TypeScript tests (TG_REMOTE_BIN seam, spec §9).
//
// resolveRemoteMode runs `python3 <launcher> config check --json`, so the fake is a tiny Python
// script that logs every invocation next to itself, then prints the canned stdout and exits with
// the canned code. `calls()` is the sentinel: an empty list proves nothing was spawned.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tempDir } from './test-temp';

export interface FakeRemoteCall {
  argv: string[];
  configDir: string | null;
  /** sys.flags.isolated of the interpreter that ran the launcher (python3 -I => true). */
  isolated: boolean;
}

const LAUNCHER = `import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, 'calls.log'), 'a') as log:
    log.write(json.dumps({'argv': sys.argv[1:], 'configDir': os.environ.get('TG_CTL_CONFIG_DIR'), 'isolated': bool(sys.flags.isolated)}) + '\\n')
sys.stdout.write(open(os.path.join(here, 'stdout.txt')).read())
sys.exit(int(open(os.path.join(here, 'exit.txt')).read()))
`;

export function fakeRemote(reply: { stdout: string; exit: number }): { bin: string; calls: () => FakeRemoteCall[] } {
  const dir = tempDir('tg-fake-remote-');
  const bin = join(dir, 'tg-remote');
  writeFileSync(bin, LAUNCHER);
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, 'stdout.txt'), reply.stdout);
  writeFileSync(join(dir, 'exit.txt'), String(reply.exit));
  const log = join(dir, 'calls.log');
  return {
    bin,
    calls: () =>
      existsSync(log)
        ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as FakeRemoteCall)
        : [],
  };
}

export const REMOTE_OK_CLIENT = JSON.stringify({
  ok: true, mode: 'client', server: 'ssh://tg-ctl-ubuntu', alias: 'tg-ctl-ubuntu', machine: 'clvm', remote_machines: [], errors: [],
}) + '\n';

export const REMOTE_OK_HUB = JSON.stringify({
  ok: true, mode: 'hub', server: null, alias: null, machine: null,
  remote_machines: [{ name: 'clvm', target: 'ultra@65.21.40.51' }], errors: [],
}) + '\n';

export const REMOTE_INVALID = JSON.stringify({
  ok: false, mode: 'invalid', errors: ['control.server: must match ^ssh://alias$', 'control.machine: required when control.server is set'],
}) + '\n';
