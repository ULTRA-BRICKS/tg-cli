// tests/helpers/fake-rig.ts — a throwaway agent-tools checkout carrying a minimal
// `agenttools_rig_delegate` CLI mirror (matching the real detect/delegate contract from
// agent-tools PR #282) plus an optional fake `rig` binary. Shared by every test that must drive
// `tg-ctl install-hooks`'s rig delegation without depending on — or touching — a real rig install.
import { chmodSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

// bun's own dir + python3's + the real PATH — needed so a test can exec `bun <tg-ctl>` and so the
// fake binDir (prepended per-test, ahead of any real `rig`) actually wins name resolution.
export const BASE_PATH = [
  dirname(Bun.which('bun') ?? '/usr/bin/bun'),
  dirname(Bun.which('python3') ?? '/usr/bin/python3'),
  process.env.PATH ?? '',
].join(':');

// Fake agent-tools checkout with a minimal agenttools_rig_delegate CLI mirror (matches the real
// detect/delegate contract from agent-tools PR #282) plus an optional fake `rig` binary that logs
// its argv to `rig.log` and exits with `rigExitCode`.
function fakeAgentToolsCheckout(root: string, opts: { withRig: boolean; rigExitCode?: number; delegateSentinel?: boolean }): { source: string; binDir: string; rigLog: string } {
  const source = join(root, 'agent-tools');
  const pkgDir = join(source, 'lib', 'agenttools_rig_delegate');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, '__init__.py'), '');
  const binDir = join(root, 'bin');
  const rigLog = join(root, 'rig.log');
  mkdirSync(binDir, { recursive: true });
  if (opts.withRig) {
    const rigBin = join(binDir, 'rig');
    writeFileSync(rigBin, `#!/bin/sh\necho "$@" >> ${JSON.stringify(rigLog)}\nexit ${opts.rigExitCode ?? 0}\n`);
    chmodSync(rigBin, 0o755);
  }
  // `delegateSentinel` simulates rig going ABSENT between `detect` and `delegate` (a race, or a
  // helper that resolves rig differently for the two calls): `detect` still finds `rig` on PATH,
  // but `delegate` returns the NO_RIG_EXIT sentinel. Lets us assert the caller falls back on the
  // sentinel (rig absent) rather than propagating it as a failure.
  const delegateBody = opts.delegateSentinel
    ? ['    if cmd == "delegate":', '        return NO_RIG_EXIT']
    : [
        '    if cmd == "delegate":',
        '        rig = find_rig()',
        '        if rig is None:',
        '            return NO_RIG_EXIT',
        '        return subprocess.run([rig, *rest]).returncode',
      ];
  writeFileSync(
    join(pkgDir, '__main__.py'),
    [
      'import shutil, subprocess, sys',
      'NO_RIG_EXIT = 97',
      'def find_rig():',
      '    return shutil.which("rig")',
      'def main():',
      '    args = sys.argv[1:]',
      '    if not args:',
      '        return 2',
      '    cmd, rest = args[0], args[1:]',
      '    if cmd == "detect":',
      '        rig = find_rig()',
      '        if rig is None:',
      '            return 1',
      '        print(rig)',
      '        return 0',
      ...delegateBody,
      '    return 2',
      'if __name__ == "__main__":',
      '    raise SystemExit(main())',
    ].join('\n'),
  );
  return { source, binDir, rigLog };
}
