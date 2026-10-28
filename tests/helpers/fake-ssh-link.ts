// A fake `ssh` (the TG_REMOTE_SSH seam, spec §9) that connects nothing: it plays the far end of both
// links of the remote ctl feature on THIS host, so the REAL Python on each side talks to the REAL
// Python on the other over the exact argv it would hand to ssh (spec §4.3).
//
//   client -> server  ssh <opts> -- <alias> tg-remote server --peer <machine>
//       runs `python3 -I <repo>/tg-remote server --peer <machine>` against the HUB's config dir, with a
//       minimal environment (like sshd: HOME, a bare PATH, SSH_ORIGINAL_COMMAND) and the hub's home as
//       cwd. Nothing of the client's environment or config dir reaches it.
//   hub -> client     ssh <opts> -o StrictHostKeyChecking=yes -- <target> tg-remote satellite serve
//       runs `python3 -I <repo>/tg-remote satellite serve` against the CLIENT's config dir, with the
//       client's own PATH (its fake tmux/ps, bun) and home. Nothing of the hub's reaches it.
//
// Every call appends one JSON line to calls.log (the full argv, the direction, the request's `op`). The
// test scripts failures through mode.json, rewritten between sends:
//   { "<direction>": { "exit": 255, "stderr": "…", "onlyOp": "deliver"? } }   refuse before running anything
//   { "<direction>": { "dropReply": true, "onlyOp": "deliver"? } }           run the far end, then die with
//       exit 255 and no reply line: the link dropped AFTER the request was written and acted on.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tempDir } from './test-temp';

export interface SshCall {
  argv: string[];
  direction: 'server' | 'satellite' | 'unknown';
  op: string | null;
  bytes: number;
  /** For a `record`: what the client put on the wire about its history text. */
  record?: { ids: number; textBytes: number; truncated: boolean };
}

export interface SshMode {
  exit?: number;
  stderr?: string;
  dropReply?: boolean;
  onlyOp?: string;
}

export interface FakeSshConfig {
  repo: string;
  /** The daemon host: what `tg-remote server` sees. */
  hubCfg: string;
  hubHome: string;
  /** The client machine: what `tg-remote satellite serve` and the sink it starts see. */
  clientCfg: string;
  clientHome: string;
  clientPath: string;
}

const SHIM = `#!/usr/bin/env python3
import json, os, subprocess, sys
here = os.path.dirname(os.path.abspath(__file__))
rig = json.load(open(os.path.join(here, 'rig.json')))
argv = sys.argv[1:]
rest = argv[argv.index('--') + 1:] if '--' in argv else []
direction, command = 'unknown', None
if len(rest) == 5 and rest[1:4] == ['tg-remote', 'server', '--peer']:
    direction, command = 'server', ['server', '--peer', rest[4]]
elif len(rest) == 4 and rest[1:] == ['tg-remote', 'satellite', 'serve']:
    direction, command = 'satellite', ['satellite', 'serve']
line = sys.stdin.buffer.readline()
record = None
try:
    doc = json.loads(line)
    op = doc.get('op')
    if op == 'record':
        record = {'ids': len(doc['ids']), 'textBytes': len(doc['history']['text'].encode('utf-8')), 'truncated': doc['history']['truncated']}
except Exception:
    op = None
with open(os.path.join(here, 'calls.log'), 'a') as log:
    log.write(json.dumps({'argv': argv, 'direction': direction, 'op': op, 'bytes': len(line), 'record': record}) + '\\n')
if command is None:
    sys.stderr.write('bash: ' + ' '.join(rest[1:]) + ': command not found\\n')
    sys.exit(127)
mode_path = os.path.join(here, 'mode.json')
mode = (json.load(open(mode_path)) if os.path.exists(mode_path) else {}).get(direction) or {}
if mode.get('onlyOp') not in (None, op):
    mode = {}
if mode.get('exit') is not None:
    sys.stderr.write(mode.get('stderr', ''))
    sys.exit(mode['exit'])
launcher = os.path.join(rig['repo'], 'tg-remote')
if direction == 'server':
    env = {'PATH': '/usr/bin:/bin', 'HOME': rig['hubHome'], 'TG_CTL_CONFIG_DIR': rig['hubCfg'], 'SSH_ORIGINAL_COMMAND': 'tg-remote ' + ' '.join(command)}
    cwd = rig['hubHome']
else:
    env = {'PATH': rig['clientPath'], 'HOME': rig['clientHome'], 'TG_CTL_CONFIG_DIR': rig['clientCfg']}
    cwd = rig['clientHome']
child = subprocess.run(['python3', '-I', launcher, *command], input=line, env=env, cwd=cwd, stdout=subprocess.PIPE)
if mode.get('dropReply'):
    sys.exit(255)
sys.stdout.buffer.write(child.stdout)
sys.stdout.buffer.flush()
sys.exit(child.returncode)
`;

export interface FakeSsh {
  bin: string;
  calls: () => SshCall[];
  /** Calls of one direction, optionally one op. */
  of: (direction: SshCall['direction'], op?: string) => SshCall[];
  setMode: (mode: Partial<Record<'server' | 'satellite', SshMode>>) => void;
  reset: () => void;
}

export function fakeSsh(config: FakeSshConfig): FakeSsh {
  const dir = tempDir('tg-fake-ssh-');
  const bin = join(dir, 'ssh');
  writeFileSync(bin, SHIM);
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, 'rig.json'), JSON.stringify(config));
  const log = join(dir, 'calls.log');
  const calls = (): SshCall[] =>
    existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as SshCall) : [];
  const modePath = join(dir, 'mode.json');
  return {
    bin,
    calls,
    of: (direction, op) => calls().filter((c) => c.direction === direction && (op === undefined || c.op === op)),
    setMode: (mode) => writeFileSync(modePath, JSON.stringify(mode)),
    reset: () => writeFileSync(modePath, '{}'),
  };
}
