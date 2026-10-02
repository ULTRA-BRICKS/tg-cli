// Flat-chat `/new` command: spawn a fresh agent session from Telegram (issue #27).
//
// PURE: parsing, candidate-dir ranking, name-uniqueness, and the inline-button
// keyboards/callbacks. The tg-ctl entrypoint owns the pending-state store, the real
// `tmux new-window` spawn, the sendMessage, and the inject-defer guard — exactly like
// the forum-topics flow owns its threadId-keyed binding store. This is the NON-TOPIC
// sibling: a flat `/new` has no forum threadId, so it carries its own session token
// and its own callback prefixes (tnm:/tnp:) that never collide with the topic flow's
// tgm:/tgp:/tgr:.
//
// Grammar (issue #27): `/new [<model>] [<dir>] name [<task>]`. The leading <model> and
// <dir> are OPTIONAL and order-tolerant — a token is recognized as a model when it is a
// known catalog id/alias, as a dir when it is an absolute path; the FIRST remaining token
// is the mandatory <name>, and everything after it is the optional <task>. Omitted model
// and/or dir are then chosen interactively via inline buttons (the entrypoint's job).

import { MODEL_CATALOG, findModel } from './models';
import type { ModelEntry } from './models';

// --- arg parser ---

export interface ParsedNewCommand {
  // The recognized catalog model id, or null when omitted (→ ask via buttons).
  model: string | null;
  // The recognized absolute working directory, or null when omitted (→ ask via buttons).
  dir: string | null;
  // The session/window name (mandatory). Empty string when the user gave no name token —
  // the entrypoint then replies with the usage hint rather than spawning a nameless agent.
  name: string;
  // The optional initial task to inject once the agent is up. Empty when omitted.
  task: string;
}

// A few human-friendly aliases for the catalog model ids so a phone-typed `/new opus foo`
// resolves without the full `claude-opus` id. Only maps to ids that EXIST in MODEL_CATALOG;
// an alias whose target was removed from the catalog simply stops resolving (findModel guards).
const MODEL_ALIASES: Record<string, string> = {
  claude: 'claude-default',
  default: 'claude-default',
  opus: 'claude-opus',
  sonnet: 'claude-sonnet',
  haiku: 'claude-haiku',
};

// Resolve a token to a catalog model id, or null if it is not a model. Tries the exact
// catalog id first, then the alias table (lowercased). PURE — the single place a `/new`
// token becomes a model, so the parser and any future caller agree.
export function resolveModelToken(token: string): string | null {
  if (findModel(token)) return token;
  const aliased = MODEL_ALIASES[token.toLowerCase()];
  return aliased && findModel(aliased) ? aliased : null;
}

// Parse the text of a `/new …` message into its parts. Tolerant of extra whitespace and of
// the optional model/dir appearing in either order before the name. Never throws: a `/new`
// with no name yields name === '' so the caller can show the usage hint.
export function parseNewCommand(text: string): ParsedNewCommand {
  // Drop the leading verb (`/new` or `/new@botname`) and split the remainder on whitespace.
  const rest = text.replace(/^\/new(@\w+)?\s*/, '');
  const tokens = rest.length > 0 ? rest.split(/\s+/) : [];
  let model: string | null = null;
  let dir: string | null = null;
  // Track what each consumed prefix token was, so the last one can be RECLAIMED as the name if the
  // prefix swallowed every token (review #1: `/new opus` should NAME the session `opus`, not pick a
  // model and leave no name).
  const consumed: Array<{ kind: 'model' | 'dir'; raw: string }> = [];
  let i = 0;
  // Consume a LEADING run of model/dir tokens, in either order, each at most once. The first
  // token that is neither (or a second model / second dir) ends the prefix and becomes the name.
  for (; i < tokens.length; i++) {
    const tok = tokens[i];
    const asModel = resolveModelToken(tok);
    if (asModel && model === null) {
      model = asModel;
      consumed.push({ kind: 'model', raw: tok });
      continue;
    }
    if (tok.startsWith('/') && dir === null) {
      dir = tok;
      consumed.push({ kind: 'dir', raw: tok });
      continue;
    }
    break;
  }
  // The prefix consumed EVERY token → there's no name. Reclaim the LAST consumed token as the name
  // (review #1): a bare `/new opus` / `/new sonnet` then NAMES the session after that word instead
  // of resolving it to a model with an empty name (which would only print the usage hint). Model and
  // dir each appear at most once, so undoing the last token's kind is a single null-out.
  if (i >= tokens.length && consumed.length > 0) {
    const last = consumed[consumed.length - 1];
    if (last.kind === 'model') model = null;
    else dir = null;
    return { model, dir, name: last.raw, task: '' };
  }
  const name = i < tokens.length ? tokens[i] : '';
  const task = tokens.slice(i + 1).join(' ');
  return { model, dir, name, task };
}

// --- parents-aware LRU/MRU directory ranker (issue #27 acceptance) ---

// How many recent-dir buttons to offer. A long menu is noise; the free-text fallback always
// remains. Mirrors the topic flow's MAX_PATH_CHOICES so both menus feel the same.
export const MAX_NEW_DIR_CHOICES = 8;

// How many `..` parents to expand per recent cwd (review #4): a single deeply-nested recent cwd
// (`/a/b/c/d/e/f`) would otherwise unfurl into a long ancestor chain and crowd OTHER recent
// projects out of the capped menu. Two levels up covers the common "spawn beside / one level above"
// case while leaving room for sibling projects.
export const MAX_PARENTS_PER_CWD = 2;

// Build the ranked, deduped recent-directory candidate list for the `/new` dir buttons.
// Unlike the topic flow's recentPathChoices, this ALSO adds each in-use dir's `..` PARENTS
// (issue #27: "the dirs already in use + their `..` parents"), so a user can spawn one level
// up from where an agent already runs. Ranking is LRU/MRU: the caller passes candidate cwds
// newest-first (most-recently-used first); a dir keeps the rank of its FIRST (newest) mention,
// and a parent inherits a rank just after its child's first mention. Output is absolute,
// existing, deduped, capped. PURE: existence is probed via the injected `isAbsoluteDir`.
export function rankNewDirChoices(
  recentCwdsNewestFirst: ReadonlyArray<string | undefined>,
  isAbsoluteDir: (p: string) => boolean,
): string[] {
  // Expand each cwd into [cwd, ...its parents up to root], preserving the newest-first order,
  // so a child always ranks ahead of its own parent and a more-recent tree outranks an older one.
  const expanded: string[] = [];
  for (const cwd of recentCwdsNewestFirst) {
    if (typeof cwd !== 'string' || cwd.length === 0 || !cwd.startsWith('/')) continue;
    expanded.push(cwd);
    // Only the nearest MAX_PARENTS_PER_CWD ancestors (review #4) — a deep cwd must not crowd out
    // sibling projects. dedup later keeps the first (newest) appearance of any shared ancestor.
    for (const parent of parentDirs(cwd).slice(0, MAX_PARENTS_PER_CWD)) expanded.push(parent);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of expanded) {
    if (seen.has(p)) continue;
    seen.add(p);
    if (!isAbsoluteDir(p)) continue;
    out.push(p);
    if (out.length >= MAX_NEW_DIR_CHOICES) break;
  }
  return out;
}

// The proper ancestor directories of an absolute path, nearest first, STOPPING before root
// (`/`) — spawning an agent at the filesystem root is never the intent. `/a/b/c` → [/a/b, /a].
// A normalized absolute path is assumed (the caller filters to startsWith('/')).
export function parentDirs(absPath: string): string[] {
  const out: string[] = [];
  // Strip a trailing slash so `/a/b/` and `/a/b` share parents; keep splitting until one
  // segment remains above root.
  let cur = absPath.replace(/\/+$/, '');
  for (;;) {
    const slash = cur.lastIndexOf('/');
    if (slash <= 0) break; // parent would be '/' (root) or empty → stop
    cur = cur.slice(0, slash);
    out.push(cur);
  }
  return out;
}

// --- name-uniqueness check (issue #27 acceptance: warn on collision) ---

// True when `name`'s spawn slug collides with an existing tmux window name. The caller passes
// the live window names (from the snapshot) and the slugifier (shared with the topic flow) so
// the comparison matches how the window will actually be named. A collision is a WARNING, not a
// hard block — tmux happily runs two windows of the same name; the warning just tells the user.
export function nameCollides(slug: string, existingWindowNames: ReadonlyArray<string>): boolean {
  return existingWindowNames.includes(slug);
}

// --- inline buttons for the flat `/new` flow ---

// Callback-data prefixes for the flat `/new` flow. DISTINCT from the topic flow's tgm:/tgp:/tgr:
// so a flat-chat tap never routes into a forum-topic binding and vice-versa. Shape:
//   tnm:<token>:<modelId>   — a model pick
//   tnp:<token>:<index>     — a recent-dir pick (index into the pending session's dirChoices)
// The <token> is the pending NewSession's id (an opaque short string the entrypoint mints), not a
// threadId — a flat `/new` has no topic. The index recovers the dir because callback_data is 64
// bytes, too small for an absolute path (same constraint the topic flow hit).
export const NEW_MODEL_CALLBACK_PREFIX = 'tnm';
export const NEW_DIR_CALLBACK_PREFIX = 'tnp';

export interface ParsedNewModelCallback {
  token: string;
  modelId: string;
}

export interface ParsedNewDirCallback {
  token: string;
  index: number;
}

// Parse `tnm:<token>:<modelId>` → {token, modelId}, or null on mismatch. The modelId is NOT
// validated against the catalog here (the entrypoint does, re-asking on an unknown id). The
// token is any non-empty run of url-safe chars (the entrypoint mints it).
export function parseNewModelCallback(data: string | undefined): ParsedNewModelCallback | null {
  if (!data) return null;
  const parts = data.split(':');
  if (parts.length !== 3 || parts[0] !== NEW_MODEL_CALLBACK_PREFIX || !parts[1] || !parts[2]) return null;
  return { token: parts[1], modelId: parts[2] };
}

// Parse `tnp:<token>:<index>` → {token, index}, or null on mismatch. The index is a non-negative
// integer (0-based into the pending session's dirChoices); a leading-zero / negative is rejected.
export function parseNewDirCallback(data: string | undefined): ParsedNewDirCallback | null {
  if (!data) return null;
  const parts = data.split(':');
  if (parts.length !== 3 || parts[0] !== NEW_DIR_CALLBACK_PREFIX || !parts[1] || !parts[2]) return null;
  if (!/^(0|[1-9]\d*)$/.test(parts[2])) return null;
  return { token: parts[1], index: Number(parts[2]) };
}

// The model-pick keyboard for a flat `/new` session: one button per catalog model, the callback
// carrying the session token + the model's catalog id. PURE — the entrypoint posts it with
// sendMessage(reply_markup). One button per row (rows of one) so it reads cleanly on a phone.
export function buildNewModelKeyboard(
  token: string,
  catalog: ReadonlyArray<Pick<ModelEntry, 'id' | 'label'>> = MODEL_CATALOG,
): Array<Array<{ text: string; callback_data: string }>> {
  return catalog.map((m) => [
    { text: m.label, callback_data: `${NEW_MODEL_CALLBACK_PREFIX}:${token}:${m.id}` },
  ]);
}

// The recent-dir keyboard for a flat `/new` session: one button per ranked dir (callback
// `tnp:<token>:<index>`), one dir per row so a long path stays readable. PURE — empty when there
// are no choices (the entrypoint then asks for a free-text absolute path only).
export function buildNewDirKeyboard(
  token: string,
  choices: ReadonlyArray<string>,
): Array<Array<{ text: string; callback_data: string }>> {
  return choices.map((p, i) => [
    { text: p, callback_data: `${NEW_DIR_CALLBACK_PREFIX}:${token}:${i}` },
  ]);
}

// --- pending-state machine (NON-topic, issue #27) ---

// Where a flat `/new` session is in its interactive flow. Distinct from TopicStatus: there is no
// `bound`/`closed` lifecycle — once the agent is spawned the pending session is DELETED (a flat
// `/new` agent is just a normal pane afterwards, addressed by `/agent`, not a persistent binding).
//   awaiting-dir   — have a name; asked for the working directory (buttons + free text)
//   awaiting-model — have name + dir; asked for the model (buttons)
export type NewSessionStatus = 'awaiting-dir' | 'awaiting-model';

// One in-flight flat `/new` session, held in memory by the entrypoint (NOT persisted: a `/new`
// that a daemon restart interrupts is simply abandoned — the user re-runs `/new`, far simpler
// than the crash-recovery the persistent topic bindings need). Keyed by `token`.
export interface NewSession {
  token: string;
  name: string;
  status: NewSessionStatus;
  // Chosen working directory (set when advancing to awaiting-model).
  dir?: string;
  // Chosen catalog model id (set just before spawn).
  model?: string;
  // Private-chat topic created for this `/new` session. It survives a spawn failure so a retry
  // reuses the same Telegram thread instead of creating duplicate private topics.
  privateThreadId?: number;
  // The initial task to inject once the agent is up (from the `/new … name <task>` tail). Empty
  // when none was given.
  task: string;
  // The recent-dir choices OFFERED as awaiting-dir buttons, so a `tnp:<token>:<index>` tap
  // recovers the dir by index. Only meaningful while awaiting-dir.
  dirChoices?: string[];
  // The Telegram message_id of the current prompt (its keyboard is cleared when the step advances
  // so a stale button can't be re-tapped). Null until the send returns.
  promptMessageId?: number | null;
  // Unix seconds the session was created/last advanced — used to expire abandoned sessions.
  ts: number;
}
