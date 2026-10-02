// /agent addressing: parse the command, fuzzy-match a tmux window name with
// phonetic normalization, and group candidates by tmux session for button
// selection (item 1, docs/specs/agent-addressing.md).
//
// PURE — the tg-ctl entrypoint owns discovery (the real `tmux list-panes`),
// the pending-message store, the button send and the inject. These functions
// turn plain data into routing decisions and button payloads.

import type { AgentKind } from './types';

export interface AgentCandidate {
  paneId: string; // "%N"
  sessionName: string;
  windowIndex: number;
  windowName: string;
  agent: AgentKind;
  // pane_current_path — the agent's cwd. Its basename (the project dir) is the
  // human-meaningful distinguisher when several panes share a bare/numeric
  // window name (e.g. three `claude` sessions in window "4" → "rig", "3d-cli").
  panePath?: string;
}

// --- command parse ---

export interface ParsedAgentCommand {
  // First whitespace token after `/agent` — a POSSIBLE window selector. The
  // caller fuzzy-matches it; if it matches nothing, the caller replies with an
  // error (no delivery). `rest` and `all` carry the message for each case.
  selector: string | null;
  rest: string; // message when `selector` IS a window (everything after it)
  all: string; // message when there is NO selector (everything after `/agent`)
}

// `/agent feat-bot deploy now` → selector "feat-bot", rest "deploy now",
// all "feat-bot deploy now". `/agent` alone → selector null, rest/all "".
export function parseAgentCommand(text: string): ParsedAgentCommand {
  const body = text.replace(/^\/agent(@\w+)?\s*/i, '');
  if (!body.trim()) return { selector: null, rest: '', all: '' };
  const m = body.match(/^(\S+)\s*([\s\S]*)$/);
  if (!m) return { selector: null, rest: '', all: body.trim() };
  return { selector: m[1], rest: m[2], all: body.trim() };
}

// --- phonetic normalization ---

// Lowercase Cyrillic → Latin so a Russian-typed selector ("клод", "апи бот")
// matches a Latin window name ("claude", "api-bot"). Covers the everyday
// letters; anything unmapped passes through.
const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function transliterate(s: string): string {
  let out = '';
  for (const ch of s.toLowerCase()) out += CYRILLIC[ch] ?? ch;
  return out;
}

// Fold a name to a phonetic key: transliterate, drop separators, apply a few
// sound-equivalences (ph→f, ck→k, qu→kw, w→v, y→i), collapse doubled letters.
// Two names that "sound the same" land on the same key.
export function phoneticKey(s: string): string {
  let t = transliterate(s);
  t = t.replace(/[^a-z0-9]+/g, '');
  t = t.replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/qu/g, 'kw').replace(/x/g, 'ks');
  t = t.replace(/c/g, 'k'); // hard c → k: codex≡кодекс, claude≈клауд
  t = t.replace(/w/g, 'v').replace(/y/g, 'i');
  t = t.replace(/(.)\1+/g, '$1');
  return t;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

// Score a candidate against a selector key. Lower is better; Infinity = no match.
//   0 exact phonetic key · 1 prefix · 2 substring · 3+ within edit-distance band.
function scoreOf(selKey: string, name: string): number {
  const key = phoneticKey(name);
  if (!key || !selKey) return Infinity;
  if (key === selKey) return 0;
  if (key.startsWith(selKey) || selKey.startsWith(key)) return 1;
  if (key.includes(selKey) || selKey.includes(key)) return 2;
  const d = levenshtein(key, selKey);
  const band = Math.max(1, Math.ceil(Math.max(key.length, selKey.length) / 4));
  return d <= band ? 2 + d : Infinity;
}

export interface MatchResult {
  // Best-scoring candidates (all tied at the best score). Empty when nothing
  // matched well enough.
  matches: AgentCandidate[];
  // True when exactly one candidate is the clear winner → route without asking.
  confident: boolean;
}

// Pick the tied-best candidates by a per-candidate scorer (lower = better).
function bestMatches(
  candidates: AgentCandidate[],
  scoreFn: (c: AgentCandidate) => number,
): AgentCandidate[] {
  const scored = candidates
    .map((c) => ({ c, score: scoreFn(c) }))
    .filter((x) => x.score < Infinity)
    .sort((a, b) => a.score - b.score);
  if (scored.length === 0) return [];
  const best = scored[0].score;
  return scored.filter((x) => x.score === best).map((x) => x.c);
}

// A STRICT score for the cwd tier: ONLY an EXACT phonetic match (0) counts;
// anything looser — prefix, substring, edit-distance — is rejected (Infinity).
// The cwd is a fallback signal consulted for EVERY typed `/agent <selector>`, so
// it must be conservative: a short/common typed token (`/agent dev`) must NOT
// prefix-resonate into an unrelated project's cwd (`…/development`) and silently
// route there. An exact cwd hit is exactly what the picker hands back (the full
// project basename), so the bare-`/agent` round-trip is unaffected.
function strictScoreOf(selKey: string, name: string): number {
  return scoreOf(selKey, name) === 0 ? 0 : Infinity;
}

// Fuzzy-match `selector` (phonetic) against the candidates, in TWO tiers so the
// window name always takes precedence over the cwd:
//   1. window NAMES only (fuzzy) — unchanged legacy behaviour. `/agent deploy`
//      against a real `deploy` window routes there and is never pulled into a tie
//      by some other pane that merely sits in a `…/deploy` cwd.
//   2. only if tier 1 found NOTHING, retry consulting each pane's cwd project dir
//      too — but the cwd is matched STRICTLY (EXACT only). This makes a
//      picker-suggested cwd selector route when the window names carry no usable
//      signal — bare/numeric (the "4 · claude" ×3 bug) OR auto-renamed to the
//      SAME meaningful name (tmux's default rename gives several claude panes an
//      identical `node`/`claude` window name) — WITHOUT letting a fuzzy typo
//      resonate into a different pane's cwd.
// `confident` = the tied-best set is a single pane.
export function matchWindows(selector: string, candidates: AgentCandidate[]): MatchResult {
  const selKey = phoneticKey(selector);
  if (!selKey) return { matches: [], confident: false };
  let matches = bestMatches(candidates, (c) => scoreOf(selKey, c.windowName));
  if (matches.length === 0) {
    // Tier 1 found nothing → no window name matched, so rank purely by the STRICT
    // cwd score (EXACT only).
    matches = bestMatches(candidates, (c) => strictScoreOf(selKey, cwdBasename(c.panePath)));
  }
  return { matches, confident: matches.length === 1 };
}

// --- grouping for selection buttons ---

export interface SessionGroup {
  session: string;
  candidates: AgentCandidate[]; // ordered by windowIndex
}

// Group candidates by tmux session, sessions in first-appearance order. Within a
// session, panes are sorted by window index UNLESS `preserveOrder` — the reply
// picker passes the candidates already in LRU/MRU order and must keep it (a
// windowIndex re-sort would discard the most-recent-first ranking).
export function groupBySession(candidates: AgentCandidate[], preserveOrder = false): SessionGroup[] {
  const order: string[] = [];
  const bySession = new Map<string, AgentCandidate[]>();
  for (const c of candidates) {
    const g = bySession.get(c.sessionName);
    if (g) g.push(c);
    else {
      bySession.set(c.sessionName, [c]);
      order.push(c.sessionName);
    }
  }
  return order.map((session) => {
    const inSession = bySession.get(session)!;
    return {
      session,
      candidates: preserveOrder ? inSession : [...inSession].sort((a, b) => a.windowIndex - b.windowIndex),
    };
  });
}

// --- distinct candidate labels ---

// The basename of a cwd path (the project dir). Trailing slashes are stripped so
// `/Users/u/xp/rig/` → `rig`. An empty/root path yields ''.
function cwdBasename(path: string | undefined): string {
  if (!path) return '';
  const trimmed = path.replace(/\/+$/, '');
  if (!trimmed) return '';
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

// Default window names tmux hands back when `automatic-rename` is ON: it sets the
// window name to the running command, so an un-renamed pane shows the SHELL or the
// agent's launcher rather than a user-chosen label. The cc pane reports a VERSION
// string (e.g. "2.1.181") as its command, which surfaces as the window name too.
// None of these distinguishes a project — the label must lean on the cwd instead.
//
// Deliberately ONLY the common shells + the `node` cc-launcher: these are nearly
// always an auto-rename artifact, never a window a user would deliberately name.
// `tmux`/`login`/etc. are EXCLUDED — they are far more likely a deliberate user
// label than an auto-rename default, so treating them as bare would wrongly drop a
// real name (review tradeoff, tg-cli#75). A user who names a window literally "zsh"
// loses it to the cwd; that's the accepted edge.
const DEFAULT_SHELL_NAMES = new Set(['zsh', 'bash', 'sh', 'fish', 'node']);

// A window name that does NOT distinguish a pane and so must not lead the label:
//   - empty;
//   - the bare numeric session/window fallback ("4");
//   - a tmux auto-rename DEFAULT — a shell/launcher command name (zsh, node, …) or
//     a bare version string ("2.1.181", the cc pane_current_command). The CTO set
//     real window names ("rig", "3d"); only these un-renamed defaults fall through
//     to the cwd basename.
// A genuine user label ("rig", "ext", "api-bot") is NOT bare and leads the label.
// Exported so the daemon's diagnostic `formatCandidates` reply leads with the same
// names the picker buttons show (no leading "node"/"4"/version-string mismatch).
export function isBareWindowName(name: string): boolean {
  const t = name.trim().toLowerCase();
  if (t === '') return true;
  if (/^\d+$/.test(t)) return true; // session/window index fallback
  if (/^\d+(\.\d+)+$/.test(t)) return true; // dotted version string (cc command)
  return DEFAULT_SHELL_NAMES.has(t);
}

// Distinct, human-meaningful labels — one per candidate, SAME index order.
//
// The bug this fixes: three `claude` panes in window "4" all rendered as the
// identical "4 · claude", impossible to tell apart. Strategy per candidate:
//   - base = `<window> · <agent>` when the window name distinguishes it;
//   - otherwise (bare/numeric name) or when several candidates would collide on
//     the same base, append the cwd project dir → `<base> · <project>` (or just
//     `<project> · <agent>` when the window name carries no signal at all).
// A genuinely indistinguishable pair (same window, same agent, same cwd) gets
// the pane id appended so the buttons are never two identical strings.
export function distinctLabels(candidates: AgentCandidate[]): string[] {
  let labels = candidates.map((c) => {
    const project = cwdBasename(c.panePath);
    if (isBareWindowName(c.windowName)) {
      // The window name is useless — lead with the project when we have one, else
      // the (possibly empty) window name. A genuinely empty lead would render a
      // dangling "· claude", so fall back to the agent alone in that corner case.
      const lead = project || c.windowName.trim();
      return lead ? `${lead} · ${c.agent}` : c.agent;
    }
    return `${c.windowName} · ${c.agent}`;
  });
  // Resolve collisions in passes: any label still shared by >1 candidate gets the
  // NEXT distinguisher appended (the cwd project dir, then — as the last resort —
  // the pane id, which is unique per tmux server). A pass that adds the project
  // only touches labels that don't already carry it (a bare window name already
  // led with the project), so it never produces "rig · claude · rig".
  const appendDistinguisher = (suffixOf: (c: AgentCandidate) => string): boolean => {
    const counts = new Map<string, number>();
    for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
    let changed = false;
    labels = labels.map((label, i) => {
      if ((counts.get(label) ?? 0) <= 1) return label;
      const suffix = suffixOf(candidates[i]);
      if (!suffix || label.endsWith(` · ${suffix}`) || label.startsWith(`${suffix} · `)) return label;
      changed = true;
      return `${label} · ${suffix}`;
    });
    return changed;
  };
  appendDistinguisher((c) => cwdBasename(c.panePath));
  // Pane id always disambiguates (unique per server) — the final guarantee.
  appendDistinguisher((c) => c.paneId);
  return labels;
}

// The `/agent <selector>` token that addresses `target` after a bare-`/agent`
// pick. CRITICAL: the handed-back command must actually route. A selector is a
// SINGLE whitespace-free token (the command grammar takes the first token), so a
// window name / project dir containing a space is unusable as-is — its first word
// would tokenize off and the rest would leak into the message. Each candidate
// token is therefore (a) rejected if it has whitespace, and (b) run through
// `matchWindows` and accepted ONLY if it resolves CONFIDENTLY to this exact pane.
// We try the window name first (most natural to type), then the cwd project dir
// (the distinct label tapped); if neither qualifies we hand back the most
// specific non-empty token, choosing a whitespace-free one when possible — the
// worst case is the picker re-opens, never a silent misroute into another pane.
export function suggestSelector(target: AgentCandidate, candidates: AgentCandidate[]): string {
  // A selector is one whitespace-free token, so trim and require a single word.
  const name = target.windowName.trim();
  const project = cwdBasename(target.panePath).trim();
  const singleToken = (s: string): boolean => s !== '' && !/\s/.test(s);
  const match = (token: string): MatchResult | null => (singleToken(token) ? matchWindows(token, candidates) : null);
  const routesToTarget = (m: MatchResult | null): boolean =>
    m !== null && m.confident && m.matches[0].paneId === target.paneId;
  // A token is SAFE to hand back if it does NOT confidently route to a DIFFERENT
  // pane — re-typing it then either routes to target or (ambiguous/no-match)
  // honestly re-opens the picker. A token that confidently routes ELSEWHERE is a
  // silent misroute and must never be suggested.
  const routesElsewhere = (m: MatchResult | null): boolean =>
    m !== null && m.confident && m.matches[0].paneId !== target.paneId;

  const nameMatch = match(name);
  if (routesToTarget(nameMatch)) return name;
  const projMatch = match(project);
  if (routesToTarget(projMatch)) return project;
  // Fallback (no token confidently routed to target): pick a single-token
  // candidate that does NOT misroute. Re-running it just re-opens the picker.
  if (singleToken(project) && !routesElsewhere(projMatch)) return project;
  if (singleToken(name) && !routesElsewhere(nameMatch)) return name;
  // Everything we have would misroute or is empty — hand back a placeholder so
  // the instruction reads `… send: /agent <window> <message>` (the user edits it)
  // rather than a command that silently lands in the wrong pane.
  return '<window>';
}

// Drop candidates that name the SAME pane (same paneId) — a defensive guard
// against a merged/flaky snapshot listing one pane twice. Keeps first-seen
// order. A pane id is unique per tmux server, so this never collapses two real
// distinct agents; it only removes a literal duplicate row.
export function dedupeCandidates(candidates: AgentCandidate[]): AgentCandidate[] {
  const seen = new Set<string>();
  const out: AgentCandidate[] = [];
  for (const c of candidates) {
    if (seen.has(c.paneId)) continue;
    seen.add(c.paneId);
    out.push(c);
  }
  return out;
}

// --- selection button payload ---

const AGENT_CALLBACK_PREFIX = 'tga';
const AGENT_CANCEL_CALLBACK_PREFIX = 'tgc';

export interface AgentSelectPayload {
  text: string;
  reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
}

// Build the "pick an agent" message: a SHORT prompt + one inline-keyboard button
// per candidate (labelled with its distinct `window · agent` label). The buttons
// carry the labels, so the message text is intentionally just the prompt — NO
// per-agent text list and NO `▸ <session>` group header (both were redundant
// noise duplicating the buttons; see #63). Buttons stay grouped by session for a
// stable row order. `token` keys the daemon's pending-message store; callback
// data is `tga:<token>:<index>` where index is into `candidates` (button order).
//
// `notice` (optional) prepends a one-line context message ABOVE the prompt — used
// when the originally-addressed agent is GONE ("That agent … is no longer running")
// so the picker explains WHY it appeared instead of silently re-asking. It replaces
// the old plain-text `formatCandidates` dump: the live candidates are the BUTTONS,
// not a text list (tg-cli#72).
export function buildAgentSelectMessage(
  chatId: number,
  candidates: AgentCandidate[],
  token: string,
  messagePreview: string,
  preserveOrder = false,
  notice?: string,
): AgentSelectPayload & { chat_id: number } {
  const groups = groupBySession(candidates, preserveOrder);
  const indexOf = new Map(candidates.map((c, i) => [c, i] as const));
  // Labels are computed over ALL candidates so collision resolution is global
  // (two panes in different sessions can still share a window name).
  const labels = distinctLabels(candidates);
  const labelOf = (c: AgentCandidate): string => labels[indexOf.get(c) ?? 0];
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const g of groups) {
    for (const c of g.candidates) {
      keyboard.push([
        {
          text: labelOf(c),
          callback_data: `${AGENT_CALLBACK_PREFIX}:${token}:${indexOf.get(c)}`,
        },
      ]);
    }
  }
  // No message yet (bare `/agent`) → this is a PICKER, not a route: pick an
  // agent first, then send the message. With a preview it's the route picker.
  // `.trim()` so the header matches the daemon's `selectOnly` (message.trim()
  // === '') decision exactly — a whitespace-only message is select-only too.
  const prompt = messagePreview.trim()
    ? `Route to which agent?\n“${truncate(messagePreview, 80)}”`
    : 'Pick an agent:';
  // A gone-target notice (if any) goes ABOVE the prompt so the human reads "the
  // agent you meant is gone" first, then the choice. Empty/whitespace notice is
  // ignored — never an orphan blank line.
  const text = notice?.trim() ? `${notice.trim()}\n${prompt}` : prompt;
  return {
    chat_id: chatId,
    text,
    reply_markup: { inline_keyboard: keyboard },
  };
}

export interface ParsedAgentCallback {
  token: string;
  index: number;
}

export interface ParsedAgentCancelCallback {
  token: string;
}

export function buildAgentCancelKeyboard(token: string, label: string): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  return { inline_keyboard: [[{ text: label, callback_data: `${AGENT_CANCEL_CALLBACK_PREFIX}:${token}` }]] };
}

// Parse `tga:<token>:<index>` callback data. Returns null on any mismatch.
export function parseAgentCallback(data: string | undefined): ParsedAgentCallback | null {
  if (!data) return null;
  const parts = data.split(':');
  if (parts.length !== 3 || parts[0] !== AGENT_CALLBACK_PREFIX || !parts[1]) return null;
  const index = Number(parts[2]);
  if (!Number.isInteger(index) || index < 0) return null;
  return { token: parts[1], index };
}

export function parseAgentCancelCallback(data: string | undefined): ParsedAgentCancelCallback | null {
  if (!data) return null;
  const parts = data.split(':');
  if (parts.length !== 2 || parts[0] !== AGENT_CANCEL_CALLBACK_PREFIX || !parts[1]) return null;
  return { token: parts[1] };
}

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
