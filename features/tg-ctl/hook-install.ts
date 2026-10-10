import { chmodSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';

// Idempotent installer for the q→buttons agent-question hooks
// (docs/specs/2026-06-10-tg-ctl-control-design.md §8). PURE: the entrypoint
// reads/writes ~/.claude/settings.json (backing it up first) and prints guidance;
// these helpers do the JSON merge + detection.
//
// Claude Code intercepts the `AskUserQuestion` tool via a PreToolUse matcher (it
// is a tool, not its own event — confirmed against the live hooks docs) and tool
// permissions via the `PermissionRequest` event. Hooks MERGE across scopes and
// multiple matchers coexist, so adding ours never clobbers existing hooks; the
// merge is keyed on (event, matcher, command) so re-running is a no-op.
//
// PLAN-APPROVAL (ExitPlanMode) is intentionally NOT given its own PreToolUse
// matcher: per the live hooks docs both PreToolUse AND PermissionRequest can fire
// for the SAME ExitPlanMode call, so a dedicated PreToolUse matcher would forward
// the plan to Telegram twice (and leave the losing `tg-ctl ask` process blocked
// until its 120s timeout). The `PermissionRequest *` catch-all already delivers
// ExitPlanMode exactly once; `hook-normalize.ts` recognizes the tool there and
// renders Proceed/Keep-planning buttons regardless of which event carried it.

interface HookCmd {
  type: 'command';
  command: string;
  timeout?: number;
}
interface HookGroup {
  matcher?: string;
  hooks: HookCmd[];
}

const TIMEOUT_SEC = 120;
// A StopFailure hook must be quick — it only shells `tg-ctl harness-event`, which
// sends one message and returns; it does not block on a Telegram round-trip the
// way the 120s q→buttons hook does.
const HARNESS_TIMEOUT_SEC = 30;
const STATUSLINE_TELEMETRY_MARKER = 'tg-ctl-statusline-usage';
const STATUSLINE_DISPLAY_COMMAND_PREFIX = 'printf \'%s\' "$input" | sh -c ';
const STATUSLINE_TELEMETRY_MIN_INTERVAL_SEC = 30;
const SILENT_STATUSLINE_COMMAND = ':';

// The q→buttons hook groups we install, as (event, group) entries.
function desiredGroups(command: string): Array<{ event: string; group: HookGroup }> {
  const cmd: HookCmd = { type: 'command', command, timeout: TIMEOUT_SEC };
  return [
    { event: 'PreToolUse', group: { matcher: 'AskUserQuestion', hooks: [cmd] } },
    { event: 'PermissionRequest', group: { matcher: '*', hooks: [cmd] } },
  ];
}

// The harness-failure hook group (tg-cli#113): Claude Code 2.1.x fires StopFailure
// when a turn ends on an API failure / usage limit. The `*` matcher catches every
// failure matcher (rate_limit, overloaded, billing_error, session_limit, …); the
// command normalizes the payload and notifies Telegram + offers auto-continue.
function desiredHarnessGroups(command: string): Array<{ event: string; group: HookGroup }> {
  const cmd: HookCmd = { type: 'command', command, timeout: HARNESS_TIMEOUT_SEC };
  return [{ event: 'StopFailure', group: { matcher: '*', hooks: [cmd] } }];
}

function desiredCodexUsageGroups(command: string): Array<{ event: string; group: HookGroup }> {
  const cmd: HookCmd = { type: 'command', command, timeout: HARNESS_TIMEOUT_SEC };
  return [{ event: 'Stop', group: { hooks: [cmd] } }];
}

function groupHasCommand(group: unknown, matcher: string, command: string): boolean {
  if (!group || typeof group !== 'object') return false;
  const g = group as Record<string, unknown>;
  // A missing matcher means "all tools" — treat it and '*' as the same catch-all.
  const gm = typeof g.matcher === 'string' ? g.matcher : '*';
  if (gm !== (matcher || '*')) return false;
  const hooks = Array.isArray(g.hooks) ? g.hooks : [];
  return hooks.some((h) => h && typeof h === 'object' && (h as Record<string, unknown>).command === command);
}

// Are all of `groups` (each keyed on its command) already present in settings?
function groupsInstalled(settings: Record<string, unknown>, groups: Array<{ event: string; group: HookGroup }>, command: string): boolean {
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? (settings.hooks as Record<string, unknown>) : {};
  for (const { event, group } of groups) {
    const arr = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    if (!arr.some((g) => groupHasCommand(g, group.matcher ?? '', command))) return false;
  }
  return true;
}

// Merge `groups` into settings, preserving existing hooks; a group is appended
// only when an equivalent one (same event/matcher/command) is absent, so
// re-running is a no-op. Returns a shallow copy + whether anything changed.
function mergeGroups(
  settings: Record<string, unknown>,
  groups: Array<{ event: string; group: HookGroup }>,
  command: string,
): { settings: Record<string, unknown>; changed: boolean } {
  const next: Record<string, unknown> = { ...settings };
  const hooks: Record<string, unknown> = next.hooks && typeof next.hooks === 'object' ? { ...(next.hooks as Record<string, unknown>) } : {};
  let changed = false;
  for (const { event, group } of groups) {
    const existing = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
    if (!existing.some((g) => groupHasCommand(g, group.matcher ?? '', command))) {
      existing.push(group);
      changed = true;
    }
    hooks[event] = existing;
  }
  next.hooks = hooks;
  return { settings: next, changed };
}

export function claudeHooksInstalled(settings: Record<string, unknown>, command: string): boolean {
  return groupsInstalled(settings, desiredGroups(command), command);
}

// Return a deep-ish copy of `settings` with the q→buttons hook groups merged in.
export function withClaudeHooks(settings: Record<string, unknown>, command: string): { settings: Record<string, unknown>; changed: boolean } {
  return mergeGroups(settings, desiredGroups(command), command);
}

export function harnessHooksInstalled(settings: Record<string, unknown>, command: string): boolean {
  return groupsInstalled(settings, desiredHarnessGroups(command), command);
}

// Return a copy of `settings` with the StopFailure harness hook merged in (#113).
export function withHarnessHooks(settings: Record<string, unknown>, command: string): { settings: Record<string, unknown>; changed: boolean } {
  return mergeGroups(settings, desiredHarnessGroups(command), command);
}

export function codexUsageHookInstalled(settings: Record<string, unknown>, command: string): boolean {
  return groupsInstalled(settings, desiredCodexUsageGroups(command), command);
}

export function withCodexUsageHook(settings: Record<string, unknown>, command: string): { settings: Record<string, unknown>; changed: boolean } {
  return mergeGroups(settings, desiredCodexUsageGroups(command), command);
}

function statusLineCommand(settings: Record<string, unknown>): string | null {
  const statusLine = settings.statusLine;
  if (!statusLine || typeof statusLine !== 'object' || Array.isArray(statusLine)) return null;
  const command = (statusLine as Record<string, unknown>).command;
  return typeof command === 'string' && command.trim() ? command : null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseShellSingleQuoted(value: string, start: number): string | null {
  if (value[start] !== "'") return null;
  let out = '';
  for (let i = start + 1; i < value.length; i++) {
    if (value.startsWith(`'\\''`, i)) {
      out += "'";
      i += 3;
      continue;
    }
    if (value[i] === "'") return out;
    out += value[i];
  }
  return null;
}

function unwrapStatusLineTelemetryDisplayCommand(commandText: string): string | null {
  const markerIndex = commandText.indexOf(STATUSLINE_TELEMETRY_MARKER);
  if (markerIndex < 0) return null;
  const displayStart = commandText.indexOf(STATUSLINE_DISPLAY_COMMAND_PREFIX);
  if (displayStart < 0 || displayStart > markerIndex) return null;
  return parseShellSingleQuoted(commandText, displayStart + STATUSLINE_DISPLAY_COMMAND_PREFIX.length);
}

function buildStatusLineTelemetryCommand(displayCommand: string, telemetryCommand: string): string {
  const telemetryScript = `trap 'rm -f "$1"' EXIT INT TERM; ${telemetryCommand} < "$1"`;
  const prefix = [
    'input=$(cat)',
    `interval=\${TG_CTL_STATUSLINE_MIN_INTERVAL_SEC:-${STATUSLINE_TELEMETRY_MIN_INTERVAL_SEC}}`,
    `case "$interval" in ''|*[!0-9]*) interval=${STATUSLINE_TELEMETRY_MIN_INTERVAL_SEC};; esac`,
    'stamp="${TMPDIR:-/tmp}/tg-claude-statusline-usage.stamp"',
    'now=$(date +%s 2>/dev/null || printf 0)',
    'last=$(cat "$stamp" 2>/dev/null); case "$last" in \'\'|*[!0-9]*) last=0;; esac',
    'tmp=',
    'if [ "$interval" -eq 0 ] || [ $((now - last)) -ge "$interval" ]; then printf \'%s\' "$now" > "$stamp" 2>/dev/null || true; tmp=$(mktemp "${TMPDIR:-/tmp}/tg-claude-statusline-usage.XXXXXX") || tmp=; if [ -n "$tmp" ]; then chmod 600 "$tmp" 2>/dev/null || true; printf \'%s\' "$input" > "$tmp"; fi; fi',
  ].join('; ');
  return `${prefix}; if [ -n "$tmp" ]; then nohup sh -c ${shellQuote(telemetryScript)} sh "$tmp" >/dev/null 2>&1 & fi; ${STATUSLINE_DISPLAY_COMMAND_PREFIX}${shellQuote(displayCommand)}; # ${STATUSLINE_TELEMETRY_MARKER}`;
}

export function claudeStatusLineTelemetryInstalled(settings: Record<string, unknown>, command: string): boolean {
  const commandText = statusLineCommand(settings);
  return (
    commandText !== null &&
    commandText.includes(STATUSLINE_TELEMETRY_MARKER) &&
    commandText.includes(command) &&
    commandText.includes('mktemp') &&
    commandText.includes('trap') &&
    commandText.includes('TG_CTL_STATUSLINE_MIN_INTERVAL_SEC') &&
    commandText.includes('tg-claude-statusline-usage.stamp')
  );
}

export function withClaudeStatusLineTelemetry(
  settings: Record<string, unknown>,
  command: string,
): { settings: Record<string, unknown>; changed: boolean } {
  if (claudeStatusLineTelemetryInstalled(settings, command)) return { settings, changed: false };
  const currentStatusLine = settings.statusLine && typeof settings.statusLine === 'object' && !Array.isArray(settings.statusLine)
    ? (settings.statusLine as Record<string, unknown>)
    : {};
  const existingCommand = statusLineCommand(settings);
  const displayCommand = existingCommand && existingCommand.includes(STATUSLINE_TELEMETRY_MARKER)
    ? (unwrapStatusLineTelemetryDisplayCommand(existingCommand) ?? existingCommand)
    : (existingCommand ?? SILENT_STATUSLINE_COMMAND);
  return {
    settings: {
      ...settings,
      statusLine: {
        ...currentStatusLine,
        type: 'command',
        command: buildStatusLineTelemetryCommand(displayCommand, command),
      },
    },
    changed: true,
  };
}

// The three Claude Code hook channels installed together as one unit: the
// q→buttons question hook, the StopFailure limit/error hook, and the statusLine
// usage-telemetry command. Passed in (not hardcoded) so the CMD constants stay
// owned by the daemon entrypoint.
export interface ClaudeHookCommands {
  question: string;
  harness: string;
  statusLine: string;
}

// True only when ALL THREE Claude hook channels are present. Used by the daemon
// startup self-heal to decide whether a rewrite of settings.json (e.g. Claude
// Code re-emitting the file with only its own managed keys, dropping our hooks)
// needs the hooks re-merged.
export function claudeHooksFullyInstalled(settings: Record<string, unknown>, cmds: ClaudeHookCommands): boolean {
  return (
    claudeHooksInstalled(settings, cmds.question) &&
    harnessHooksInstalled(settings, cmds.harness) &&
    claudeStatusLineTelemetryInstalled(settings, cmds.statusLine)
  );
}

// Merge all three Claude hook channels in one pass. Single source of truth shared
// by `install-hooks` and the daemon startup self-heal, so both converge on the
// exact same desired settings. `changed` is true iff any channel was added.
export function reconcileClaudeHooks(
  settings: Record<string, unknown>,
  cmds: ClaudeHookCommands,
): { settings: Record<string, unknown>; changed: boolean } {
  const q = withClaudeHooks(settings, cmds.question);
  const h = withHarnessHooks(q.settings, cmds.harness);
  const t = withClaudeStatusLineTelemetry(h.settings, cmds.statusLine);
  return { settings: t.settings, changed: q.changed || h.changed || t.changed };
}

// The decision the daemon startup self-heal makes, made PURE (no I/O) so every
// branch is testable. `skip` reasons: `not-opted-in` (the user never ran
// `install-hooks`, so we never auto-install — preserves the opt-in contract),
// `unparseable`/`not-object` (leave a hand-broken file alone), `already-installed`
// (the common fast path — nothing to do). `write` carries the serialized settings
// to persist and the prior text to back up (null when there was nothing on disk).
export type ClaudeHookSelfHealPlan =
  | { action: 'skip'; reason: 'not-opted-in' | 'unparseable' | 'not-object' | 'already-installed' }
  | { action: 'write'; settingsJson: string; backup: string | null };

export function planClaudeHookSelfHeal(
  raw: string | null,
  optedIn: boolean,
  cmds: ClaudeHookCommands,
): ClaudeHookSelfHealPlan {
  // Only ever RESTORE what a prior `install-hooks` established — never first-time
  // install on daemon start. A user who never opted in, or who deliberately
  // stripped the hooks and removed the sentinel, is left untouched.
  if (!optedIn) return { action: 'skip', reason: 'not-opted-in' };
  let existing: Record<string, unknown> = {};
  const hasContent = raw !== null && raw.trim() !== '';
  if (hasContent) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw as string);
    } catch {
      return { action: 'skip', reason: 'unparseable' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { action: 'skip', reason: 'not-object' };
    }
    existing = parsed as Record<string, unknown>;
  }
  if (claudeHooksFullyInstalled(existing, cmds)) return { action: 'skip', reason: 'already-installed' };
  const { settings } = reconcileClaudeHooks(existing, cmds);
  return { action: 'write', settingsJson: `${JSON.stringify(settings, null, 2)}\n`, backup: hasContent ? raw : null };
}

// The filesystem seam the daemon startup self-heal drives, injected so the whole
// orchestration (read → plan → backup → write) is unit-testable with an in-memory
// fake. `read` returns null for BOTH a missing and an UNREADABLE file — the
// orchestration disambiguates with `exists` so it never overwrites a file it
// could not read.
export interface HookSelfHealFs {
  exists(path: string): boolean;
  read(path: string): string | null;
  backup(path: string, content: string): void;
  writeAtomic(path: string, content: string): void;
  ensureDir(dir: string): void;
  // Writes the opt-in sentinel (used only by the #211 pre-sentinel migration).
  markOptedIn(path: string): void;
}

export interface HookSelfHealPaths {
  settingsPath: string;
  settingsDir: string;
  sentinelPath: string;
}

export type HookSelfHealSkipReason =
  | 'not-opted-in'
  | 'no-settings-file'
  | 'unparseable'
  | 'not-object'
  | 'already-installed'
  | 'unreadable';

export type HookSelfHealOutcome =
  | { outcome: 'skipped'; reason: HookSelfHealSkipReason }
  | { outcome: 'healed' }
  | { outcome: 'migrated' };

// Orchestrate the startup self-heal over an injected fs. RESTORE-ONLY: it only
// re-merges hooks into a settings.json that EXISTS and is READABLE — it never
// first-time-creates the file (a user who deleted settings.json to reset Claude
// Code keeps their reset) and never clobbers a file it could not read. Opt-in is
// the presence of the sentinel `install-hooks` writes. The `.selfheal.bak` is
// written ONCE (only when absent) so a second gutting can't replace the earliest
// pre-heal snapshot with a later, already-gutted one.
export function runClaudeHookSelfHeal(
  fs: HookSelfHealFs,
  paths: HookSelfHealPaths,
  cmds: ClaudeHookCommands,
): HookSelfHealOutcome {
  // Opt-in is the FIRST gate. Without the sentinel the only thing we do is the
  // #211 migration: a settings.json that ALREADY carries every tg-ctl hook was
  // produced by an `install-hooks` run that predates the sentinel, so record the
  // opt-in it implies. A partial/absent/broken file stays not-opted-in.
  if (!fs.exists(paths.sentinelPath)) {
    if (isPreSentinelInstall(fs, paths.settingsPath, cmds)) {
      fs.markOptedIn(paths.sentinelPath);
      return { outcome: 'migrated' };
    }
    return { outcome: 'skipped', reason: 'not-opted-in' };
  }
  // `exists` FIRST (no TOCTOU ambiguity), then read only when present.
  if (!fs.exists(paths.settingsPath)) return { outcome: 'skipped', reason: 'no-settings-file' };
  const raw = fs.read(paths.settingsPath);
  if (raw === null) return { outcome: 'skipped', reason: 'unreadable' };
  const plan = planClaudeHookSelfHeal(raw, true, cmds);
  if (plan.action === 'skip') return { outcome: 'skipped', reason: plan.reason };
  const backupPath = `${paths.settingsPath}.selfheal.bak`;
  if (plan.backup !== null && !fs.exists(backupPath)) {
    fs.backup(backupPath, plan.backup);
  }
  fs.ensureDir(paths.settingsDir);
  fs.writeAtomic(paths.settingsPath, plan.settingsJson);
  return { outcome: 'healed' };
}

function isPreSentinelInstall(fs: HookSelfHealFs, settingsPath: string, cmds: ClaudeHookCommands): boolean {
  if (!fs.exists(settingsPath)) return false;
  const raw = fs.read(settingsPath);
  if (raw === null) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return claudeHooksFullyInstalled(parsed as Record<string, unknown>, cmds);
  } catch {
    return false;
  }
}

// Atomically replace settings.json WITHOUT breaking how the user keeps it (#212):
// a dotfile-managed symlink is resolved and its TARGET is replaced (renaming over
// the link itself would swap it for a regular file), and the existing mode is
// kept instead of forcing 0600. The temp file lives beside the real target so the
// rename stays on one filesystem.
export function writeSettingsPreservingLink(path: string, content: string): void {
  let target = path;
  let mode = 0o600;
  try {
    target = realpathSync(path);
    mode = statSync(target).mode & 0o7777;
  } catch {
    // missing file: write a fresh one at `path` with the private default
  }
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, content, { mode });
  chmodSync(tmp, mode); // the umask may have narrowed the creation mode
  renameSync(tmp, target);
}
