// The pm/rig lookup always probes the system-wide directories, which a hermetic test cannot hide.
// Tests that need `name` to be absent or to resolve to their own copy skip on a host that has one.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function hostHasSystemCli(name: 'pm' | 'rig'): boolean {
  return ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin', '/usr/local/bin'].some((dir) => existsSync(join(dir, name)));
}
