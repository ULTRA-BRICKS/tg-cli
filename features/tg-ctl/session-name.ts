// The ONE session-name resolver (tg-cli#455 / #75): every surface that names a
// session — the outbound `tg` `[window]` header, the `/agent` picker buttons,
// `tg-ctl status`, the `tg replies` history label and the question-card labels —
// derives the name here, so a session never shows two different names.
//
// The CTO's rule (2026-09-29): "основное из tmux" — the tmux window name is the
// PRIMARY name whenever the session sits in a tmux pane; the harness's own
// session title (omp `/rename`/auto title, Claude Code's terminal title) is
// SECONDARY, shown next to it, never instead of it. Outside tmux the harness
// title IS the primary name. The cwd project basename is the fallback tier when
// the window name is a bare auto-rename default or there is no title at all.
//
// PURE — callers hand in already-read tmux fields / titles; no I/O here.

// Default window names tmux hands back when `automatic-rename` is ON: it sets the
// window name to the running command, so an un-renamed pane shows the SHELL or the
// agent's launcher rather than a user-chosen label. The cc pane reports a VERSION
// string (e.g. "2.1.181") as its command, which surfaces as the window name too;
// an omp run from source reports `bun`, and an abduco-wrapped agent (rig
// `omp run`, tg-cli#454) reports `abduco`. None of these distinguishes a project —
// the label must lean on the cwd instead.
//
// Deliberately ONLY the common shells + launchers/wrappers: these are nearly
// always an auto-rename artifact, never a window a user would deliberately name.
// `tmux`/`login`/etc. are EXCLUDED — they are far more likely a deliberate user
// label than an auto-rename default, so treating them as bare would wrongly drop a
// real name (review tradeoff, tg-cli#75). A user who names a window literally "zsh"
// loses it to the cwd; that's the accepted edge.
const DEFAULT_SHELL_NAMES: Record<string, true> = { zsh: true, bash: true, sh: true, fish: true, node: true, bun: true, abduco: true };

// A window name that does NOT distinguish a pane and so must not lead the label:
//   - empty;
//   - the bare numeric session/window fallback ("4");
//   - a tmux auto-rename DEFAULT — a shell/launcher command name (zsh, node, …) or
//     a bare version string ("2.1.181", the cc pane_current_command).
// A genuine user label ("rig", "ext", "api-bot") is NOT bare and leads the label.
export function isBareWindowName(name: string): boolean {
  const t = name.trim().toLowerCase();
  if (t === '') return true;
  if (/^\d+$/.test(t)) return true; // session/window index fallback
  if (/^\d+(\.\d+)+$/.test(t)) return true; // dotted version string (cc command)
  return DEFAULT_SHELL_NAMES[t] === true;
}

// The basename of a cwd path (the project dir). Trailing slashes are stripped so
// `/Users/u/xp/rig/` → `rig`. An empty/root path yields ''.
export function cwdBasename(path: string | null | undefined): string {
  if (!path) return '';
  const trimmed = path.replace(/\/+$/, '');
  if (!trimmed) return '';
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

// A harness-painted terminal title: omp paints `π > <title>` (idle) / `π ⠹ <title>`
// (busy); Claude Code paints `✳ <title>` (idle) / a braille spinner frame
// (U+2800–U+28FF) while busy. The mark run (π, spinner frames, sparkles, `>`) is
// stripped; the `π` must be followed by a space/spinner/`>` so a Greek word is not
// mistaken for omp's prefix.
const HARNESS_TITLE_MARK = /^(?:π(?=[\s\u2800-\u28FF>])|[\u2800-\u28FF✳✶✻✽✢✦])[\s\u2800-\u28FF✳✶✻✽✢✦>]*/u;
// A harness's own product name is its idle placeholder title, not a session name.
const GENERIC_TITLES: Record<string, true> = { 'claude code': true, claude: true, codex: true, omp: true, opencode: true, pi: true };

// The harness session title carried by a tmux `#{pane_title}`, or '' when the
// title is not one a harness painted. ONLY a title carrying a harness mark counts:
// tmux's default pane title is the host name, shells/mosh paint `user@host: ~`, and
// a pane whose omp exited keeps its last `π > …` title — so callers pass a pane
// title only for a pane that currently hosts an agent.
export function titleFromPaneTitle(raw: string | null | undefined): string {
  const t = (raw ?? '').trim();
  const mark = HARNESS_TITLE_MARK.exec(t);
  if (!mark) return '';
  const title = t.slice(mark[0].length).trim();
  return GENERIC_TITLES[title.toLowerCase()] === true ? '' : title;
}

export interface SessionNameInput {
  // The tmux `#{window_name}` of the session's pane. null/undefined = the session
  // is NOT in tmux (or its pane could not be resolved) — the title then leads.
  tmuxWindow?: string | null;
  // The session's cwd (`#{pane_current_path}` or the process cwd).
  cwd?: string | null;
  // The harness's own session title from its adapter (omp endpoint / jsonl).
  harnessTitle?: string | null;
  // The raw tmux `#{pane_title}` — used only when the adapter has no title.
  paneTitle?: string | null;
  // The label a rig wrapper gave the abduco session it hosts outside tmux (the host
  // record's `label`, docs/specs/2026-09-30-harness-agnostic-control.md §3): the part a
  // window name plays in tmux. Ignored when the session is in a tmux pane.
  hostLabel?: string | null;
  // Last-resort id when nothing else names the session (e.g. `omp · 1a2b3c4d`).
  fallback?: string | null;
}

export interface SessionName {
  primary: string;
  secondary: string | null;
}

// Precedence:
//   in tmux     primary = window name (non-bare) → cwd basename → title → bare window → fallback
//               secondary = harness title (when it differs from the primary)
//   not in tmux primary = host label → harness title → cwd basename → fallback
//               secondary = harness title when a host label leads and it differs
// Never a placeholder like "no tmux" (tg-cli#448): a session with no usable signal
// at all gets '' and the caller omits the bracket.
export function resolveSessionName(input: SessionNameInput): SessionName {
  const title = (input.harnessTitle ?? '').trim() || titleFromPaneTitle(input.paneTitle);
  const project = cwdBasename(input.cwd);
  const fallback = (input.fallback ?? '').trim();
  if (input.tmuxWindow === null || input.tmuxWindow === undefined) {
    const hostLabel = (input.hostLabel ?? '').trim();
    if (hostLabel) return { primary: hostLabel, secondary: title && title.toLowerCase() !== hostLabel.toLowerCase() ? title : null };
    return { primary: title || project || fallback, secondary: null };
  }
  const win = input.tmuxWindow.trim();
  const primary = (win && !isBareWindowName(win) ? win : '') || project || title || win || fallback;
  const secondary = title && title.toLowerCase() !== primary.toLowerCase() ? title : null;
  return { primary, secondary };
}
