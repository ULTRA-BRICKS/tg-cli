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
// The config.toml side PARSES the file (`Bun.TOML.parse`) rather than scanning its text: TOML
// spells the `[hooks]` Stop table many ways (`Stop = […]` under `[hooks]`, dotted `hooks.Stop`,
// `[hooks.Stop]` / `[[hooks.Stop]]`, quoted keys) and hides look-alike text in comments and
// multi-line strings — a text scan that misreads either one either writes hooks.json back (the dual
// source this exists to kill) or, worse, migrates the legacy entry away for a hook that is not
// live. The hooks.json side is a plain JSON edit.

// --- shared: does a command string invoke ours? -------------------------------------------------

// `command` as a whole token, followed by nothing but flags: at the start or after whitespace, a
// path `/` or a quote, then the end or ` -…`. rig writes the resolved absolute invocation
// (`/…/bun /…/tg-ctl codex-usage-hook`), so an exact compare would miss it, while a bare substring
// would also claim someone else's `tg-ctl codex-usage-hook-canary`. A command holding any shell
// control operator (`&&`, `||`, `;`, `|`, `&`, a newline, backticks, `$(`) is a user's compound hook that
// merely RUNS ours — a migration would delete it whole, so it never counts, wherever ours sits.
function commandPattern(command: string): RegExp {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(?![\\s\\S]*(?:[;&|\`\\n]|\\$\\())[\\s\\S]*?(?:^|[\\s/"'])${escaped}(?=[ \\t]*$|[ \\t]+-)`);
}

// --- config.toml side: is our Stop hook already provisioned there? ------------------------------

// Is the tg-ctl usage-telemetry Stop hook provisioned in the `[hooks]` table of a Codex
// `config.toml`? A file that does not parse answers no: Codex cannot load hooks from it either,
// and "no" is the safe direction (install-hooks keeps the hooks.json fallback, status says so).
export function codexUsageHookInConfigToml(text: string, command: string): boolean {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch {
    return false;
  }
  const hooks = (parsed as Record<string, unknown>).hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false;
  // Only where Codex runs a Stop command counts: each group's `hooks[].command` (what rig writes),
  // or the group's own `command` (a `[[hooks.Stop]]` / `[hooks.Stop]` table spelled flat). A note,
  // description or any other nested field that merely mentions the command never passes for a
  // provisioned hook — that false positive would cost the hooks.json fallback in a migration.
  const stop = (hooks as Record<string, unknown>).Stop;
  const pattern = commandPattern(command);
  return (Array.isArray(stop) ? stop : [stop]).some((group) => {
    const entries = group && typeof group === 'object' ? (group as Record<string, unknown>).hooks : undefined;
    // Same shape rule as `withoutOurHooks`: a group's own `command` counts only when it has no
    // inner `hooks` — so status never credits a hook the migration would refuse to remove.
    if (!Array.isArray(entries)) return isOurHookEntry(group, pattern);
    return entries.some((entry) => isOurHookEntry(entry, pattern));
  });
}

// --- hooks.json side: what must be removed from the legacy file? -------------------------------

// `none`    — nothing of ours in there (or the file is missing / hand-broken: left untouched).
// `rewrite` — our hook was removed but other content remains; `json` is the file's new body.
// `delete`  — our hook was the ONLY thing in the file; it should be removed from disk entirely.
export type CodexHooksJsonMigration =
  | { action: 'none' }
  | { action: 'rewrite'; json: string }
  | { action: 'delete' };

// Does this hook entry invoke our usage-telemetry command (`commandPattern`)? Token-bounded rather
// than exact, so an absolute-path invocation is recognized too — a deliberately LOOSER match than
// hook-install.ts's exact `groupHasCommand`, which stays exact because it is shared with the
// Claude Code hook merge where a wrong match would clobber a user's own hook.
function isOurHookEntry(entry: unknown, pattern: RegExp): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const cmd = (entry as Record<string, unknown>).command;
  return typeof cmd === 'string' && pattern.test(cmd);
}

// Drop our hook entries from one Stop group. `removed` says whether anything of ours was in it;
// `group` is the survivor, or null when the group held nothing but our hooks (an empty group would
// still be a live, if inert, Stop entry). A FLAT group that is itself our hook (`{type, command}`,
// the shape `codexUsageHookInConfigToml` also credits) goes whole — but only when it carries no
// inner `hooks` of its own, which would be lost with it.
function withoutOurHooks(group: unknown, pattern: RegExp): { removed: boolean; group: unknown } {
  if (!group || typeof group !== 'object' || Array.isArray(group)) return { removed: false, group };
  const g = group as Record<string, unknown>;
  if (!Array.isArray(g.hooks)) return isOurHookEntry(group, pattern) ? { removed: true, group: null } : { removed: false, group };
  const kept = g.hooks.filter((entry) => !isOurHookEntry(entry, pattern));
  if (kept.length === g.hooks.length) return { removed: false, group };
  return { removed: true, group: kept.length === 0 ? null : { ...g, hooks: kept } };
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
  const pattern = commandPattern(command);
  const kept: unknown[] = [];
  let removed = false;
  for (const group of hooksTable.Stop) {
    const result = withoutOurHooks(group, pattern);
    if (!result.removed) kept.push(group);
    else {
      removed = true;
      if (result.group !== null) kept.push(result.group);
    }
  }
  if (!removed) return { action: 'none' };
  return pruneEmptyContainers(settings, hooksTable, kept);
}
