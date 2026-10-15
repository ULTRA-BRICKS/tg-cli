// Flat-chat `/new` command: spawn a fresh agent session from Telegram (issue #27).
//
// PURE: parsing, candidate-dir ranking, name-uniqueness, and the inline-button
// keyboards/callbacks. The tg-ctl entrypoint owns the pending-state store, the real
// `tmux new-window` spawn, the sendMessage, and the inject-defer guard — exactly like
// the forum-topics flow owns its threadId-keyed binding store. This is the NON-TOPIC
// sibling: a flat `/new` has no forum threadId, so it carries its own session token
// and its own callback prefixes (tnh:/tnm:/tnp:) that never collide with the topic flow's
// tgm:/tgp:/tgr:.
//
// Grammar (issue #27 + HYP-903 follow-up): `/new [<harness>|<model>] [<dir>] name [<task>]`.
// The harness/model/dir selectors are optional and order-tolerant around the name, so both
// `/new codex task-cli msg` and `/new task-cli codex msg` mean name=task-cli, harness=codex.
// A concrete model token infers its harness. After the name, only harnesses and concrete
// model-looking tokens can be treated as selectors; at most one selector is consumed after the
// name, and soft aliases like `default` stay in the task. Omitted dir/harness/model are chosen
// via buttons.

import { MODEL_CATALOG, SPAWN_HARNESSES, findModel, harnessLabel } from './models';
import type { ModelEntry, SpawnHarness } from './models';

// --- arg parser ---

export interface ParsedNewCommand {
  // The recognized harness, or null when omitted (→ ask via buttons before asking models).
  harness: SpawnHarness | null;
  // The recognized catalog model id, or null when omitted (→ ask via buttons).
  model: string | null;
  // The recognized absolute working directory, or null when omitted (→ ask via buttons).
  dir: string | null;
  // The session/window name (mandatory). Empty string when the user gave no name token —
  // the entrypoint then replies with the usage hint rather than spawning a nameless agent.
  name: string;
  // The optional initial task to inject once the agent is up. Empty when omitted.
  task: string;
  // Whether the `dir` token was consumed AFTER the name (an inline dir in the task
  // region) rather than before it. The parser can't tell a real path from a bare
  // harness command like `/compact` (both are absolute-looking, and existence is
  // an fs check the pure parser must not do), so when the entrypoint later rejects
  // an inline dir as non-existent it uses this to PREPEND the raw token back onto
  // the task instead of dropping it — preserving `/new api /compact first` →
  // task `/compact first` (codex #187). False for a dir given before the name (a
  // leading bad path is a dir attempt, not task text) or when there is no dir.
  dirAfterName: boolean;
}

// A few human-friendly aliases for the catalog model ids so a phone-typed `/new opus foo`
// resolves without the full `claude-opus` id. Only maps to ids that EXIST in MODEL_CATALOG;
// an alias whose target was removed from the catalog simply stops resolving (findModel guards).
const MODEL_ALIASES: Record<string, string> = {
  default: 'claude-default',
  opus: 'claude-opus',
  sonnet: 'claude-sonnet',
  haiku: 'claude-haiku',
  'gpt-5.5': 'codex-gpt-5.5',
  gpt55: 'codex-gpt-5.5',
  'gpt-5.4': 'codex-gpt-5.4',
  gpt54: 'codex-gpt-5.4',
  mini: 'codex-gpt-5.4-mini',
  spark: 'codex-spark',
  'gpt-5.3-codex-spark': 'codex-spark',
  'glm-5.2': 'opencode-zai-glm-5.2',
  glm: 'opencode-zai-glm-5.2',
  'zai/glm-5.2': 'opencode-zai-glm-5.2',
  kimi: 'opencode-kimi',
  'moonshotai/kimi-k2.7-code': 'opencode-kimi',
  'commandcode/moonshotai/kimi-k2.7-code': 'opencode-kimi',
  deepseek: 'opencode-deepseek',
  'deepseek/deepseek-v4-pro': 'opencode-deepseek',
  'commandcode/deepseek/deepseek-v4-pro': 'opencode-deepseek',
  qwen: 'opencode-qwen',
  'qwen/qwen3.7-max': 'opencode-qwen',
  'commandcode/qwen/qwen3.7-max': 'opencode-qwen',
};

const HARNESS_ALIASES: Record<string, SpawnHarness> = {
  claude: 'claude',
  codex: 'codex',
  oc: 'opencode',
  opencode: 'opencode',
};

// Resolve a token to a catalog model id, or null if it is not a model. Tries the exact
// catalog id first, then the alias table (lowercased). PURE — the single place a `/new`
// token becomes a model, so the parser and any future caller agree.
export function resolveModelToken(token: string): string | null {
  if (findModel(token)) return token;
  const aliased = MODEL_ALIASES[token.toLowerCase()];
  return aliased && findModel(aliased) ? aliased : null;
}

export function resolveHarnessToken(token: string): SpawnHarness | null {
  const normalized = token.toLowerCase();
  const exact = SPAWN_HARNESSES.find((h) => h === normalized);
  if (exact) return exact;
  return HARNESS_ALIASES[normalized] ?? null;
}

function resolvePostNameModelToken(token: string): string | null {
  if (findModel(token)) return token;
  if (!/[0-9./-]/.test(token)) return null;
  const aliased = MODEL_ALIASES[token.toLowerCase()];
  return aliased && findModel(aliased) ? aliased : null;
}

// One consumed selector token, tracked so the LAST one can be RECLAIMED as the name if selectors
// swallowed every token (review #1: `/new opus` should NAME the session `opus`, not pick a model
// and leave no name).
type ConsumedSelector =
  | { kind: 'harness'; raw: string; harness: SpawnHarness }
  | { kind: 'model'; raw: string; model: string }
  | { kind: 'dir'; raw: string; dir: string };

// Working slots the parser fills token by token. Order-independent: a dir/harness/model fills its
// (empty) slot wherever it appears, before OR after the name.
interface ParseSlots {
  harness: SpawnHarness | null;
  model: string | null;
  dir: string | null;
  consumed: ConsumedSelector[];
}

// Try to consume `tok` into an empty selector slot (dir/harness/model), mutating `slots`. Returns
// true when consumed. `nameSeen` gates model recognition: BEFORE the name any model alias resolves;
// AFTER the name only a CONCRETE model-looking token does (a bare soft alias like `default`/`spark`
// in the task must stay task text). An absolute-path token is a dir in ANY position (issue: an
// inline dir arg after the name must be used, not treated as task text).
function consumeSelector(tok: string, slots: ParseSlots, nameSeen: boolean): boolean {
  const asHarness = resolveHarnessToken(tok);
  if (asHarness && slots.harness === null) {
    slots.harness = asHarness;
    slots.consumed.push({ kind: 'harness', raw: tok, harness: asHarness });
    return true;
  }
  const asModel = nameSeen ? resolvePostNameModelToken(tok) : resolveModelToken(tok);
  if (asModel && slots.model === null) {
    const entry = findModel(asModel);
    // A model whose harness contradicts an already-chosen harness is NOT a selector (it stays task
    // text / becomes the name) — `/new codex opus` keeps codex and names the session `opus`.
    if (entry && (slots.harness === null || slots.harness === entry.kind)) {
      slots.harness = entry.kind;
      slots.model = asModel;
      slots.consumed.push({ kind: 'model', raw: tok, model: asModel });
      return true;
    }
  }
  if (tok.startsWith('/') && slots.dir === null) {
    slots.dir = tok;
    slots.consumed.push({ kind: 'dir', raw: tok, dir: tok });
    return true;
  }
  return false;
}

// Replay a run of consumed selectors into fresh slots, using the SAME assignment rules
// consumeSelector applies (a model forces its harness). Single source so the reclaim path (below)
// can never drift from the main scan if those rules change.
function applyConsumed(consumed: ConsumedSelector[]): Pick<ParsedNewCommand, 'harness' | 'model' | 'dir'> {
  let harness: SpawnHarness | null = null;
  let model: string | null = null;
  let dir: string | null = null;
  for (const c of consumed) {
    if (c.kind === 'model') {
      model = c.model;
      harness = findModel(c.model)?.kind ?? harness;
    } else if (c.kind === 'harness') {
      harness = c.harness;
    } else {
      dir = c.dir;
    }
  }
  return { harness, model, dir };
}

// Parse the text of a `/new …` message into its parts. Order-tolerant: the dir/harness/model
// selectors are recognized by SHAPE in any position (before or after the name); the first token
// that fills no slot is the name, and everything after the name that fills no slot is the task.
// Never throws: a `/new` with no name yields name === '' so the caller can show the usage hint.
export function parseNewCommand(text: string): ParsedNewCommand {
  // Drop the leading verb (`/new` or `/new@botname`) and split the remainder on whitespace.
  const rest = text.replace(/^\/new(@\w+)?\s*/, '');
  const tokens = rest.length > 0 ? rest.split(/\s+/) : [];
  const slots: ParseSlots = { harness: null, model: null, dir: null, consumed: [] };
  let i = 0;
  let name = '';
  let nameSeen = false;
  // Whether the dir slot was filled while the name was already seen (an inline dir
  // AFTER the name). Used by the entrypoint to preserve a rejected inline token
  // as task text (codex #187).
  let dirAfterName = false;
  // Consume selectors wherever they appear. Once the name is set, the first token that fills NO
  // slot begins the task tail (so a task word that merely looks like a selector of the wrong
  // harness, or a soft alias, stays in the task rather than being silently swallowed).
  for (; i < tokens.length; i++) {
    const tok = tokens[i];
    const dirWasEmpty = slots.dir === null;
    if (consumeSelector(tok, slots, nameSeen)) {
      if (dirWasEmpty && slots.dir !== null && nameSeen) dirAfterName = true;
      continue;
    }
    if (!nameSeen) {
      name = tok;
      nameSeen = true;
      continue;
    }
    break;
  }
  const { harness, model, dir, consumed } = slots;
  // The prefix consumed EVERY token → there's no name. Reclaim the LAST consumed token as the name
  // (review #1): a bare `/new opus` / `/new sonnet` then NAMES the session after that word instead
  // of resolving it to a model with an empty name (which would only print the usage hint). Selector
  // slots each appear at most once, so replaying the remaining consumed selectors is unambiguous.
  if (!nameSeen && consumed.length > 0) {
    const last = consumed[consumed.length - 1];
    const replayed = applyConsumed(consumed.slice(0, -1));
    // No name was ever seen, so any surviving dir came before it → not inline.
    return { ...replayed, name: last.raw, task: '', dirAfterName: false };
  }
  const task = tokens.slice(i).join(' ');
  return { harness, model, dir, name, task, dirAfterName };
}

// --- parents-aware LRU/MRU directory ranker (issue #27 acceptance) ---

// How many recent-dir buttons to offer. A long menu is noise; the free-text fallback always
// remains.
export const MAX_NEW_DIR_CHOICES = 8;

// How many `..` parents to expand per recent cwd (review #4): a single deeply-nested recent cwd
// (`/a/b/c/d/e/f`) would otherwise unfurl into a long ancestor chain and crowd OTHER recent
// projects out of the capped menu. Two levels up covers the common "spawn beside / one level above"
// case while leaving room for sibling projects.
export const MAX_PARENTS_PER_CWD = 2;

// Build the ranked, deduped recent-directory candidate list for the `/new` dir buttons.
// It adds each in-use dir's `..` PARENTS too
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
//   tnh:<token>:<harness>   — a harness pick
//   tnm:<token>:<modelId>   — a model pick
//   tnp:<token>:<index>     — a recent-dir pick (index into the pending session's dirChoices)
// The <token> is the pending NewSession's id (an opaque short string the entrypoint mints), not a
// threadId — a flat `/new` has no topic. The index recovers the dir because callback_data is 64
// bytes, too small for an absolute path (same constraint the topic flow hit).
export const NEW_MODEL_CALLBACK_PREFIX = 'tnm';
export const NEW_DIR_CALLBACK_PREFIX = 'tnp';
export const NEW_HARNESS_CALLBACK_PREFIX = 'tnh';
// tnr:<token> — a "Retry spawn" tap after a spawn FAILURE. No extra field: the pending session
// already holds name+dir+harness+model, so a retry re-runs the spawn WITHOUT re-asking anything.
export const NEW_RETRY_CALLBACK_PREFIX = 'tnr';

// Build the `tmux new-window` SESSION-TARGET argv fragment for a spawn. Returns `[]` when no
// session is known (tmux then targets the current/only session). Otherwise returns
// `['-a', '-t', `=${session}:`]`. The trailing `:` makes tmux treat the target as a SESSION rather
// than a window index — CRITICAL when the session is named numerically (e.g. `1`): a bare `-t 1`
// is misparsed as WINDOW INDEX 1 and fails with `create window failed: index 1 in use`. The `=`
// forces an exact-name match and `-a` appends at the next free index. PURE — the single source both
// the flat `/new` and forum-topic spawns use, so a numeric session name can never collide again.
export function sessionTargetArgs(session: string | undefined): string[] {
  if (!session) return [];
  return ['-a', '-t', `=${session}:`];
}

export interface ParsedNewHarnessCallback {
  token: string;
  harness: SpawnHarness;
}

export interface ParsedNewModelCallback {
  token: string;
  modelId: string;
}

export interface ParsedNewDirCallback {
  token: string;
  index: number;
}

export function parseNewHarnessCallback(data: string | undefined): ParsedNewHarnessCallback | null {
  if (!data) return null;
  const parts = data.split(':');
  if (parts.length !== 3 || parts[0] !== NEW_HARNESS_CALLBACK_PREFIX || !parts[1] || !parts[2]) return null;
  const harness = resolveHarnessToken(parts[2]);
  return harness ? { token: parts[1], harness } : null;
}

export interface ParsedNewRetryCallback {
  token: string;
}

// Parse `tnr:<token>` → {token}, or null on mismatch. A retry tap carries only the pending
// session's token; the session still holds every prior answer, so no other field is needed.
export function parseNewRetryCallback(data: string | undefined): ParsedNewRetryCallback | null {
  if (!data) return null;
  const parts = data.split(':');
  if (parts.length !== 2 || parts[0] !== NEW_RETRY_CALLBACK_PREFIX || !parts[1]) return null;
  return { token: parts[1] };
}

// The single-button "Retry spawn" keyboard offered after a spawn FAILURE. The callback carries the
// session token so a tap re-runs the spawn with the already-chosen name/dir/harness/model — the
// flow NEVER re-enters the questionnaire on failure (it reports the error once and offers retry).
export function buildNewRetryKeyboard(token: string): Array<Array<{ text: string; callback_data: string }>> {
  return [[{ text: 'Retry spawn', callback_data: `${NEW_RETRY_CALLBACK_PREFIX}:${token}` }]];
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

export function buildNewHarnessKeyboard(
  token: string,
  harnesses: ReadonlyArray<SpawnHarness> = SPAWN_HARNESSES,
): Array<Array<{ text: string; callback_data: string }>> {
  return harnesses.map((h) => [
    { text: harnessLabel(h), callback_data: `${NEW_HARNESS_CALLBACK_PREFIX}:${token}:${h}` },
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
//   awaiting-harness — have name + dir; asked for the harness (buttons)
//   awaiting-model   — have name + dir + harness; asked for that harness's model (buttons)
//   awaiting-retry   — have EVERY answer but the spawn FAILED; offered a single Retry button (a
//                      failure never re-enters the questionnaire — the answers are all preserved)
//   awaiting-private-topic-fallback — private topic creation is unavailable; asked before flat fallback
export type NewSessionStatus = 'awaiting-dir' | 'awaiting-harness' | 'awaiting-model' | 'awaiting-retry' | 'awaiting-private-topic-fallback';

// One in-flight flat `/new` session, held in memory by the entrypoint (NOT persisted: a `/new`
// that a daemon restart interrupts is simply abandoned — the user re-runs `/new`, far simpler
// than the crash-recovery the persistent topic bindings need). Keyed by `token`.
export interface NewSession {
  token: string;
  name: string;
  status: NewSessionStatus;
  // Chosen working directory (set when advancing to awaiting-model).
  dir?: string;
  // Chosen harness (set by a token on the /new line or by the harness picker).
  harness?: SpawnHarness;
  // Chosen catalog model id (set just before spawn).
  model?: string;
  // The initial task to inject once the agent is up (from the `/new … name <task>` tail). Empty
  // when none was given.
  task: string;
  // The recent-dir choices OFFERED as awaiting-dir buttons, so a `tnp:<token>:<index>` tap
  // recovers the dir by index. Only meaningful while awaiting-dir.
  dirChoices?: string[];
  // Forum/private-topic id of the slash command that opened this flat /new flow. Null/absent keeps
  // the normal flat-chat behavior; a number makes daemon prompts and confirmations stay in topic.
  threadId?: number | null;
  // Set when the flow was started from an unknown topic's ➕ New session button (tg-cli#735): the
  // spawn takes THIS topic as the session's own (no createForumTopic), the session is named after
  // its directory, and the topic's held text becomes the initial task.
  bindThreadId?: number;
  // The chat + message_id of the `/new` that opened this session. Recorded on a private-topic
  // binding so a replayed `/new` (pending-batch recovery after a crash) is not spawned twice.
  sourceChatId: number;
  sourceMessageId: number;
  // The Telegram message_id of the current prompt (its keyboard is cleared when the step advances
  // so a stale button can't be re-tapped). Null until the send returns.
  promptMessageId?: number | null;
  // Unix seconds the session was created/last advanced — used to expire abandoned sessions.
  ts: number;
}

export const NEW_PRIVATE_TOPIC_FALLBACK_CALLBACK_PREFIX = 'tnf';
export const NEW_PRIVATE_TOPIC_FALLBACK_CONTINUE = 'continue';
export const NEW_PRIVATE_TOPIC_FALLBACK_CANCEL = 'cancel';

export interface ParsedNewPrivateTopicFallbackCallback {
  token: string;
  choice: typeof NEW_PRIVATE_TOPIC_FALLBACK_CONTINUE | typeof NEW_PRIVATE_TOPIC_FALLBACK_CANCEL;
}

export function parseNewPrivateTopicFallbackCallback(data: string | undefined): ParsedNewPrivateTopicFallbackCallback | null {
  if (!data) return null;
  const parts = data.split(':');
  if (parts.length !== 3 || parts[0] !== NEW_PRIVATE_TOPIC_FALLBACK_CALLBACK_PREFIX || !parts[1]) return null;
  if (parts[2] !== NEW_PRIVATE_TOPIC_FALLBACK_CONTINUE && parts[2] !== NEW_PRIVATE_TOPIC_FALLBACK_CANCEL) return null;
  return { token: parts[1], choice: parts[2] };
}

export function buildNewPrivateTopicFallbackKeyboard(token: string): Array<Array<{ text: string; callback_data: string }>> {
  return [
    [
      {
        text: 'Continue without topics',
        callback_data: `${NEW_PRIVATE_TOPIC_FALLBACK_CALLBACK_PREFIX}:${token}:${NEW_PRIVATE_TOPIC_FALLBACK_CONTINUE}`,
      },
    ],
    [
      {
        text: 'Cancel this spawn',
        callback_data: `${NEW_PRIVATE_TOPIC_FALLBACK_CALLBACK_PREFIX}:${token}:${NEW_PRIVATE_TOPIC_FALLBACK_CANCEL}`,
      },
    ],
  ];
}
