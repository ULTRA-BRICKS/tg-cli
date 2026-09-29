// features/tg-ctl/codex-hooks-migration.ts — the PURE half of retiring the LEGACY Codex
// `hooks.json` usage-telemetry entry once rig provisions the same Stop hook in `config.toml`
// (tg-cli#316, the follow-up left open by tg-cli#308 / PR #200).
//
// WHY: Codex reads hook configuration from BOTH `$CODEX_HOME/hooks.json` and the `[hooks]` table
// of `$CODEX_HOME/config.toml`, and prints `loading hooks from both …` when both exist. PR #200
// taught `tg-ctl install-hooks` to SKIP writing hooks.json once rig provisions the telemetry hook
// in config.toml — but skipping a write never removes the entry a PREVIOUS install already put
// there, so the warning survived until the file was deleted by hand. These helpers decide what to
// remove; the entrypoint (`installHooks` in ../../tg-ctl) does the backup + write/unlink.
//
// Both helpers are deliberately TEXTUAL/structural rather than full parsers: the config.toml side
// is a targeted scan of the `[hooks]` table (NOT a TOML parser — rig owns that file and we only
// ask "is our Stop command in there"), and the hooks.json side is a plain JSON edit.

// --- config.toml side: is our Stop hook already provisioned there? ------------------------------

// Walk a line character by character, calling `onChar` for every character OUTSIDE a string, and
// stopping at an unquoted `#` (a TOML end-of-line comment). Handles both string flavors: basic
// (`"…"`, backslash escapes) and literal (`\'…\'`, no escapes at all). Returns the index the walk
// stopped at — the start of the comment, or the line length.
function walkOutsideStrings(line: string, onChar: (ch: string) => void): number {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === '"' && ch === '\\') {
      i++;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#') return i;
    onChar(ch);
  }
  return line.length;
}

// Strip a TOML end-of-line comment — a `#` that is NOT inside a string. Keeps a commented-out
// `# Stop = [… tg-ctl codex-usage-hook …]` line from reading as a live hook.
function stripTomlComment(line: string): string {
  return line.slice(0, walkOutsideStrings(line, () => {}));
}

// Net bracket depth a line adds to a TOML array value (`[` minus `]`, ignoring brackets inside
// strings). Lets the scan follow a `Stop = [` value that spans several lines.
function bracketDelta(line: string): number {
  let delta = 0;
  walkOutsideStrings(line, (ch) => {
    if (ch === '[') delta++;
    else if (ch === ']') delta--;
  });
  return delta;
}

// Match `[table]` / `[[array-of-tables]]` headers; the capture is the table path.
const TOML_TABLE_HEADER = /^\[{1,2}\s*([^\]]+?)\s*\]{1,2}$/;
// Match a `key = value` assignment. The key may be bare, quoted, or DOTTED (`hooks.Stop = …`).
const TOML_ASSIGNMENT = /^(?:"([^"]+)"|([A-Za-z0-9_.-]+))\s*=\s*(.*)$/;
// The key path a Codex Stop hook lives under, however it is spelled.
const STOP_KEY_PATH = 'hooks.Stop';

// Is the tg-ctl usage-telemetry Stop hook provisioned in the `[hooks]` table of a Codex
// `config.toml`? Matches by SUBSTRING because rig writes the resolved absolute invocation
// (`/…/bun /…/tg-ctl codex-usage-hook`), not the bare command string.
//
// TOML spells the same table several ways and rig may change its serializer, so ALL of them are
// recognized: `Stop = […]` under a `[hooks]` header (what rig writes today, inline or spanning
// lines), a dotted `hooks.Stop = […]` at the root, and `[hooks.Stop]` / `[[hooks.Stop]]` tables
// whose `command = …` lines carry the invocation. Missing a spelling would be a silent regression:
// install-hooks would write hooks.json back and recreate the dual hook source this exists to kill.
export function codexUsageHookInConfigToml(text: string, command: string): boolean {
  let table: string | null = null;
  let depth = 0;
  let hit = false;
  // An array value that spans lines is accumulated until its brackets balance; only then does a
  // hit count (so a `]`-terminated unrelated array can't carry one over).
  const settle = (): boolean => {
    if (depth > 0) return false;
    depth = 0;
    const found = hit;
    hit = false;
    return found;
  };
  for (const rawLine of text.split('\n')) {
    const line = stripTomlComment(rawLine);
    const trimmed = line.trim();
    if (depth > 0) {
      if (line.includes(command)) hit = true;
      depth += bracketDelta(line);
      if (settle()) return true;
      continue;
    }
    if (!trimmed) continue;
    const header = trimmed.match(TOML_TABLE_HEADER);
    if (header) {
      table = header[1];
      continue;
    }
    const assignment = trimmed.match(TOML_ASSIGNMENT);
    if (!assignment) continue;
    const key = assignment[1] ?? assignment[2];
    const path = table ? `${table}.${key}` : key;
    // Inside a `[hooks.Stop]` / `[[hooks.Stop]]` table every key (`command`, `type`, …) belongs to
    // the hook itself, so any of them carrying the invocation counts.
    if (table !== STOP_KEY_PATH && path !== STOP_KEY_PATH) continue;
    hit = assignment[3].includes(command);
    depth = bracketDelta(assignment[3]);
    if (settle()) return true;
  }
  return false;
}

// --- hooks.json side: what must be removed from the legacy file? -------------------------------

// `none`    — nothing of ours in there (or the file is missing / hand-broken: left untouched).
// `rewrite` — our hook was removed but other content remains; `json` is the file's new body.
// `delete`  — our hook was the ONLY thing in the file; it should be removed from disk entirely.
export type CodexHooksJsonMigration =
  | { action: 'none' }
  | { action: 'rewrite'; json: string }
  | { action: 'delete' };

// Does this hook entry invoke our usage-telemetry command? SUBSTRING, so an absolute-path
// invocation (`/…/bun /…/tg-ctl codex-usage-hook`) is recognized too — a deliberately LOOSER
// match than hook-install.ts's exact `groupHasCommand`, which stays exact because it is shared
// with the Claude Code hook merge where a wrong match would clobber a user's own hook.
function isOurHookEntry(entry: unknown, command: string): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const cmd = (entry as Record<string, unknown>).command;
  return typeof cmd === 'string' && cmd.includes(command);
}

// Drop our hook entries from one Stop group. Returns the surviving group, or null when the group
// held nothing but our hooks (an empty group would still be a live, if inert, Stop entry).
function withoutOurHooks(group: unknown, command: string): unknown | null {
  if (!group || typeof group !== 'object' || Array.isArray(group)) return group;
  const g = group as Record<string, unknown>;
  if (!Array.isArray(g.hooks)) return group;
  const kept = g.hooks.filter((entry) => !isOurHookEntry(entry, command));
  if (kept.length === g.hooks.length) return group;
  return kept.length === 0 ? null : { ...g, hooks: kept };
}

// Prune empty containers upward: an emptied `Stop` array drops the key, an emptied `hooks` table
// drops that key, and a settings object with nothing left tells the caller to unlink the file.
function pruneEmptyContainers(settings: Record<string, unknown>, hooks: Record<string, unknown>, stop: unknown[]): CodexHooksJsonMigration {
  const nextHooks: Record<string, unknown> = { ...hooks };
  if (stop.length > 0) nextHooks.Stop = stop;
  else delete nextHooks.Stop;
  const next: Record<string, unknown> = { ...settings };
  if (Object.keys(nextHooks).length > 0) next.hooks = nextHooks;
  else delete next.hooks;
  if (Object.keys(next).length === 0) return { action: 'delete' };
  return { action: 'rewrite', json: `${JSON.stringify(next, null, 2)}\n` };
}

// Plan the removal of the legacy usage-telemetry Stop entry from a Codex `hooks.json` body.
// `raw` is the file content (null when the file is absent). A missing, empty, unparseable or
// non-object file yields `none` — this migration never rewrites a file it does not understand.
export function planCodexHooksJsonMigration(raw: string | null, command: string): CodexHooksJsonMigration {
  if (raw === null || raw.trim() === '') return { action: 'none' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { action: 'none' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { action: 'none' };
  const settings = parsed as Record<string, unknown>;
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return { action: 'none' };
  const hooksTable = hooks as Record<string, unknown>;
  if (!Array.isArray(hooksTable.Stop)) return { action: 'none' };
  const kept: unknown[] = [];
  let removed = false;
  for (const group of hooksTable.Stop) {
    const survivor = withoutOurHooks(group, command);
    if (survivor === group) kept.push(group);
    else {
      removed = true;
      if (survivor !== null) kept.push(survivor);
    }
  }
  if (!removed) return { action: 'none' };
  return pruneEmptyContainers(settings, hooksTable, kept);
}
