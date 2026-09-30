// The history AGENT NAME for a tmux pane — shared by the WRITE side (tg-ctl stamps
// it as `targetAgent` on an inbound history record) and the READ side (`tg replies`
// resolves it for its OWN pane to know "the current agent"). Both sides MUST derive
// the name the same way, or the default agent-scoped view would filter on a name
// that never matches what was stamped.
//
// The name is the PRIMARY of the one session-name resolver (session-name.ts): the
// tmux window name, or the cwd project when the window name is a bare auto-rename
// default. Never the harness title — a `/rename` must not split one session's
// history into two agents.
//
// PURE — the caller supplies the already-read tmux fields; no I/O here.

import { resolveSessionName } from './session-name';

// Parse a `tmux display-message -p '#{window_name}\t#{pane_current_path}'` line into the
// agent name. SPLITS ON THE FIRST TAB ONLY and strips ONLY the trailing newline — never a
// blanket `.trim()`, which would eat the tab delimiter itself when the window name is empty
// (`"\t/some/path\n"` → `"/some/path"`), shifting the PATH into the window-name slot and
// yielding a wrong label. The empty-window-name case is exactly the one the cwd fallback
// exists for (bare/auto-named panes), so it must parse correctly. A line with no tab is
// treated as a lone window name (empty path). Mirrors the daemon, which reads the same two
// tmux fields from its snapshot. null when neither field yields a name.
export function agentNameFromDisplayLine(raw: string): string | null {
  const line = raw.replace(/\r?\n$/, '');
  const tab = line.indexOf('\t');
  const windowName = tab >= 0 ? line.slice(0, tab) : line;
  const panePath = tab >= 0 ? line.slice(tab + 1) : '';
  return resolveSessionName({ tmuxWindow: windowName, cwd: panePath }).primary || null;
}
