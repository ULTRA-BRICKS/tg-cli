// /agent addressing: parse the command, fuzzy-match a tmux window name with
// phonetic normalization, and group candidates by tmux session for button
// selection (item 1, docs/specs/agent-addressing.md).
//
// PURE — the tg-ctl entrypoint owns discovery (the real `tmux list-panes`),
// the pending-message store, the button send and the inject. These functions
// turn plain data into routing decisions and button payloads.

import type { AgentKind } from './types';
import { truncateWithEllipsis } from './text-util';
import { cwdBasename, resolveSessionName } from './session-name';

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
  // Extra exact /agent selectors (live omp `--name`). Checked BEFORE fuzzy
  // window names so an explicit name is not stolen by another pane's title.
  aliases?: string[];
  // The harness's own session title from its adapter (live omp endpoint/jsonl).
  // SECONDARY to the tmux window name — never a replacement (tg-cli#455).
  harnessTitle?: string | null;
  // Raw tmux `#{pane_title}` (omp `π > title`, Claude Code `✳ title`); used only
  // when there is no adapter title.
  paneTitle?: string | null;
  // Names this session had before a rename (the registry's aliases, spec §3.2):
  // `/agent <oldname>` still reaches it, but only when no current name matches.
  formerNames?: string[];
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
export function isAgentCommand(text: string): boolean {
  return /^\/agent(@\w+)?(?:\s|$)/i.test(text);
}

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


// Stable /agent tokens derived from a project dir basename. The full basename
// is always a token; hyphen/underscore/dot pieces of length >= 4 are too, so
// `landing` addresses `conloca-landing` without letting `dev` hit `development`
// (that name has no separator, so its only token is itself).
export function projectAddressTokens(project: string): string[] {
  const base = project.trim().toLowerCase();
  if (!base) return [];
  const parts = base.split(/[-_.]+/).filter((p) => p.length >= 4);
  return [...new Set([base, ...parts])];
}

// Unique project-dir hit for a typed selector. Exact/token match wins when it
// names exactly one item; a hyphenated selector like `rig-fable` then falls
// through to a unique FIRST segment (`rig` → `rig-cli`) so the Hyper-tab
// names from ask 108 route. Ambiguous token/segment sets return nothing —
// never guess.
export function uniqueProjectSelectorHits<T>(
  selector: string,
  items: readonly T[],
  projectOf: (item: T) => string,
): T[] {
  const want = selector.trim().toLowerCase();
  if (!want) return [];
  const tokenHits = items.filter((it) => projectAddressTokens(projectOf(it)).includes(want));
  if (tokenHits.length === 1) return tokenHits;
  if (tokenHits.length > 1) return [];
  if (!/[-_.]/.test(want)) return [];
  const head = want.split(/[-_.]+/)[0] ?? '';
  if (head.length < 3) return [];
  const headHits = items.filter((it) => {
    const proj = projectOf(it).trim().toLowerCase();
    return proj !== '' && proj.split(/[-_.]+/)[0] === head;
  });
  return headHits.length === 1 ? headHits : [];
}

// Fuzzy-match `selector` (phonetic) against the candidates, in tiers so the
// window name always takes precedence over the cwd:
//   1. window NAMES only (fuzzy) — unchanged legacy behaviour. `/agent deploy`
//      against a real `deploy` window routes there and is never pulled into a tie
//      by some other pane that merely sits in a `…/deploy` cwd.
//   1b. unless a window name matched EXACTLY, a name a session had before a
//      rename (`formerNames`, exact only) wins over a fuzzy window hit: after
//      `deploy` → `prod`, `/agent deploy` still reaches it rather than a
//      `deployer` window, while a window now really named `deploy` still wins.
//   2. only if tier 1 found NOTHING, retry consulting each pane's cwd project dir
//      too — but the cwd is matched STRICTLY (EXACT only). This makes a
//      picker-suggested cwd selector route when the window names carry no usable
//      signal — bare/numeric (the "4 · claude" ×3 bug) OR auto-renamed to the
//      SAME meaningful name (tmux's default rename gives several claude panes an
//      identical `node`/`claude` window name) — WITHOUT letting a fuzzy typo
//      resonate into a different pane's cwd.
// `confident` = the tied-best set is a single pane.
export function matchWindows(selector: string, candidates: AgentCandidate[]): MatchResult {
  const want = selector.trim().toLowerCase();
  if (want) {
    const named = candidates.filter((c) =>
      (c.aliases ?? []).some((a) => a.trim().toLowerCase() === want),
    );
    if (named.length === 1) return { matches: named, confident: true };
    if (named.length > 1) return { matches: named, confident: false };
  }
  const selKey = phoneticKey(selector);
  if (!selKey) return { matches: [], confident: false };
  let matches = bestMatches(candidates, (c) => scoreOf(selKey, c.windowName));
  const exactWindowHit = matches.length > 0 && scoreOf(selKey, matches[0].windowName) === 0;
  if (!exactWindowHit) {
    const former = candidates.filter((c) => (c.formerNames ?? []).some((n) => n.trim().toLowerCase() === want));
    if (former.length > 0) return { matches: former, confident: former.length === 1 };
  }
  if (matches.length === 0) {
    // Tier 1 found nothing → no window name matched, so rank purely by the STRICT
    // cwd score (EXACT only).
    matches = bestMatches(candidates, (c) => strictScoreOf(selKey, cwdBasename(c.panePath)));
  }
  if (matches.length === 0) {
    // Tier 3: unique project token / unique first segment (ask 108 landing, rig-fable).
    matches = uniqueProjectSelectorHits(selector, candidates, (c) => cwdBasename(c.panePath));
  }
  return { matches, confident: matches.length === 1 };
}

// --- gone-agent (dead subagent) fallback ---

// Live incident (2026-09-18): a `/agent <name>` selector that matches NO live agent
// ANYWHERE tg-ctl can see (tmux window, live omp process, or an out-of-tmux process)
// used to just report "no agent matching" and drop the message. The CTO's reaction,
// verbatim: "О хороший кейс. Если субагента нету больше надо в агента отправлять" (if
// the subagent no longer exists, it needs to be routed to [its parent] agent).
//
// tg-ctl has NO session-tree / parent-pid bookkeeping for a subagent that already
// exited — by the time its name stops resolving, the process (and every trace of who
// spawned it) is gone from `ps`/tmux alike, so there is no "parent" to look up. The
// only safe available proxy is the CTO's own last-user-target anchor (tg-cli#78, see
// `resolveLastUserTargetCandidate` in tg-ctl) — the session he was last CONFIRMED
// talking to, a DELIBERATE prior choice of his, not a guess. In the ordinary workflow
// that IS the session that dispatched the now-finished subagent, or at minimum the one
// he'd want it relayed to. The caller passes that already-resolved (pane-id-reuse
// checked) candidate straight to `goneAgentFallbackReplyText` below when it is
// non-null; a null anchor keeps the caller's explicit "no agent matching" error.
//
// Deliberately NEVER also falls back to "the only agent currently live": that exact
// heuristic caused a real production misroute (the `/agent ext` → lone `rig` pane
// incident, still guarded by ctl-agent-nomatch-integration.test.ts and
// ctl-agent-selector-nomatch-integration.test.ts) where a plain typo/no-match selector
// silently absorbed into whatever one unrelated agent happened to be running. tg-ctl
// cannot tell "this name is a gone subagent" apart from "this is a typo" — so the bar
// for a fallback must be a signal the CTO actually chose, never a candidate count.

// The reply for a delivery rescued by the last-user-target anchor above — NEVER a
// silent reroute: names the selector that missed and where it actually landed instead.
// `deferred` mirrors tg-ctl's `routedReply` idiom: the anchor pane had an open
// forwarded question, so the message was QUEUED, not injected yet — say so rather
// than claiming "delivered" for something still pending.
export function goneAgentFallbackReplyText(selector: string, label: string, deferred?: boolean): string {
  const outcome = deferred ? 'queued for' : 'delivered to';
  return `agent '${selector}' is gone — ${outcome} '${label}' instead (your last active session)`;
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

// A picker button is one row; a long harness title is cut so the tmux name leads.
const PICKER_TITLE_MAX = 40;
// An omp shown in NO tmux pane rides the picker as `omp:<pid>` (omp.ts liveOmpPaneId).
const NO_PANE_OMP_ROW = /^omp:\d+$/;

// Distinct, human-meaningful labels — one per candidate, SAME index order.
//
// The base label is the session name from resolveSessionName (the ONE resolver
// shared with the `tg` header, status and history, tg-cli#455):
//   - a tmux pane → `<window> · <harness title>`, or `<window> · <agent>` with no
//     title; a bare/numeric window leads with the cwd project instead
//     (the "4 · claude" ×3 bug);
//   - an omp in no pane → its title-first name (liveOmpLabel), with the cwd
//     project kept visible so /agent landing / rig-cli stay discoverable when the
//     title is an unrelated sentence.
// Candidates still colliding get the cwd project, then the pane id appended, so
// the buttons are never two identical strings.
export function distinctLabels(candidates: AgentCandidate[]): string[] {
  let labels = candidates.map((c) => {
    const project = cwdBasename(c.panePath);
    if (NO_PANE_OMP_ROW.test(c.paneId)) {
      const name = c.windowName.trim() || c.agent;
      if (name === project) return `${name} · ${c.agent}`;
      return project && !name.toLowerCase().includes(project.toLowerCase()) ? `${name} · ${project}` : name;
    }
    const name = resolveSessionName({
      tmuxWindow: c.windowName,
      cwd: c.panePath,
      harnessTitle: c.harnessTitle,
      paneTitle: c.paneTitle,
    });
    if (!name.primary) return c.agent;
    return `${name.primary} · ${name.secondary ? truncateWithEllipsis(name.secondary, PICKER_TITLE_MAX) : c.agent}`;
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
const AGENT_CANCEL_CALLBACK_PREFIX = 'tgac';

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
    : 'Pick an agent to send message:';
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

// Parse `tga:<token>:<index>` callback data. Returns null on any mismatch.
export function parseAgentCallback(data: string | undefined): ParsedAgentCallback | null {
  if (!data) return null;
  const parts = data.split(':');
  if (parts.length !== 3 || parts[0] !== AGENT_CALLBACK_PREFIX || !parts[1]) return null;
  const index = Number(parts[2]);
  if (!Number.isInteger(index) || index < 0) return null;
  return { token: parts[1], index };
}

export function parseAgentCancelCallback(data: string | undefined): { token: string } | null {
  if (!data) return null;
  const parts = data.split(':');
  if (parts.length !== 2 || parts[0] !== AGENT_CANCEL_CALLBACK_PREFIX || !parts[1]) return null;
  return { token: parts[1] };
}

function truncate(s: string, max: number): string {
  return truncateWithEllipsis(s.replace(/\s+/g, ' ').trim(), max);
}
