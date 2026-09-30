// Forum-topic bindings, the unknown-topic hold, and the attach picker
// (docs/specs/session-registry-and-topics.md §4.4).
//
// PURE: the tg-ctl entrypoint owns the file I/O (CtlPaths.topics, CtlPaths.topicHolds), the
// Bot API calls and delivery; these helpers parse/serialize the stores and compute the next
// state. Tests construct the data by hand.
//
// A topic is an ADDRESS for an existing session; it never spawns anything. A binding maps a
// topic (threadId) to one session, addressed by its pane locator (`%N`, or `omp:<pid>` for an
// omp outside tmux). Bindings come from the attach picker (a pick onto a session that has no
// topic yet) and from the flat `/new` private-topic spawn. A message in a topic with no
// binding is HELD (queued per topic) while the attach picker asks which live session gets it.

import type { AgentKind, TopicBinding, TopicPayload, TopicStatus } from './types';

// Far above any real per-chat topic count; keeps the file bounded on a long-lived bot.
export const MAX_TOPICS = 500;

// --- binding store ---

export function parseTopics(raw: string | null): TopicBinding[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: TopicBinding[] = [];
  for (const r of parsed) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    if (typeof rec.threadId !== 'number' || !Number.isFinite(rec.threadId)) continue;
    // Rows left by the deleted spawn wizard (`awaiting-path`, or an `awaiting-model` that never
    // reached a spawn) fail this check and are dropped: that topic is simply unknown again, so
    // its next message gets the attach picker.
    if (typeof rec.status !== 'string' || !isTopicStatus(rec.status)) continue;
    const paneId = typeof rec.paneId === 'string' ? rec.paneId : undefined;
    // A `bound` binding MUST carry a pane — a corrupt/partial file with bound-but-no-pane would
    // make the entrypoint route into nothing. Drop it (the topic is unknown again) rather than
    // load a binding that claims a live session it can't reach.
    if (rec.status === 'bound' && !paneId) continue;
    if (rec.status === 'awaiting-model' && rec.spawnPending !== true && !paneId) continue;
    out.push({
      threadId: rec.threadId,
      name: typeof rec.name === 'string' ? rec.name : '',
      status: rec.status,
      path: typeof rec.path === 'string' ? rec.path : undefined,
      model: typeof rec.model === 'string' ? rec.model : undefined,
      paneId,
      ts: typeof rec.ts === 'number' && Number.isFinite(rec.ts) ? rec.ts : 0,
      ...(typeof rec.harness === 'string' && rec.harness.length > 0 ? { harness: rec.harness as AgentKind } : {}),
      ...(rec.spawnPending === true ? { spawnPending: true } : {}),
      ...(typeof rec.spawnToken === 'string' && rec.spawnToken.length > 0 ? { spawnToken: rec.spawnToken } : {}),
      // The replay marker is a pair: a half (message id without its chat) can't be matched safely,
      // so it is dropped whole.
      ...(typeof rec.sourceChatId === 'number' && Number.isFinite(rec.sourceChatId) &&
        typeof rec.sourceMessageId === 'number' && Number.isFinite(rec.sourceMessageId)
        ? { sourceChatId: rec.sourceChatId, sourceMessageId: rec.sourceMessageId }
        : {}),
    });
  }
  return out;
}

function isTopicStatus(s: string): s is TopicStatus {
  return s === 'awaiting-model' || s === 'bound' || s === 'closed';
}

// The binding a given `/new` (chat + message id) already created, if any — a pending-batch replay of
// that `/new` after a crash must not create a second topic. Both halves must match: Telegram message
// ids are sequential per chat, so the id alone collides across chats.
export function findTopicCreatedBy(topics: TopicBinding[], chatId: number, messageId: number): TopicBinding | undefined {
  return topics.find((b) => b.sourceChatId === chatId && b.sourceMessageId === messageId);
}

// Upsert by threadId (one binding per topic), newest kept at the tail, capped to MAX_TOPICS.
export function appendTopic(existing: TopicBinding[], binding: TopicBinding): TopicBinding[] {
  const kept = existing.filter((t) => t.threadId !== binding.threadId);
  kept.push(binding);
  return kept.length > MAX_TOPICS ? kept.slice(kept.length - MAX_TOPICS) : kept;
}

export function removeTopic(existing: TopicBinding[], threadId: number): TopicBinding[] {
  return existing.filter((t) => t.threadId !== threadId);
}

export function serializeTopics(topics: TopicBinding[]): string {
  return JSON.stringify(topics, null, 0);
}

export function findTopic(topics: TopicBinding[], threadId: number): TopicBinding | null {
  // Defensive: last entry wins (threadId is unique after appendTopic).
  for (let i = topics.length - 1; i >= 0; i--) {
    if (topics[i].threadId === threadId) return topics[i];
  }
  return null;
}

// The topic already bound to the session in `paneId`, if any — a session has at most one topic.
export function topicForPane(topics: TopicBinding[], paneId: string): TopicBinding | null {
  for (let i = topics.length - 1; i >= 0; i--) {
    if (topics[i].status === 'bound' && topics[i].paneId === paneId) return topics[i];
  }
  return null;
}

// --- binding transitions (each returns a NEW binding) ---

// The attach picker bound an unknown topic to a live session that had no topic.
export function attachTopic(
  threadId: number,
  session: { paneId: string; name: string; path?: string; harness?: AgentKind },
  ts: number,
): TopicBinding {
  return {
    threadId,
    name: session.name,
    status: 'bound',
    paneId: session.paneId,
    ts,
    ...(session.path ? { path: session.path } : {}),
    ...(session.harness ? { harness: session.harness } : {}),
  };
}

// The spawn succeeded and `paneId` is the new agent's pane → the topic is live. Clears the
// spawn-pending + spawn-token fields (a bound topic is not mid-spawn).
export function markBound(binding: TopicBinding, paneId: string, ts: number): TopicBinding {
  const { spawnPending: _sp, spawnToken: _st, ...rest } = binding;
  return { ...rest, status: 'bound', paneId, ts };
}

// Arm the spawn-pending marker + the per-spawn token IMMEDIATELY before `tmux new-window` (so a
// crash mid-spawn leaves them set → reconcile adopts ONLY a window carrying the matching token);
// the entrypoint drops the binding on spawn failure. Stays awaiting-model. CLEARS any stale `paneId`
// (codex r14 #2): keeping an old pane id would let a pre-new-window crash leave spawnPending + a
// stale paneId that reconcile would wrongly accept as proof. The real paneId is set only AFTER
// new-window returns.
export function markSpawnPending(binding: TopicBinding, token: string, ts: number): TopicBinding {
  const { paneId: _drop, ...rest } = binding;
  return { ...rest, spawnPending: true, spawnToken: token, ts };
}

// The topic's session is gone → closed. The pane locator is kept for display only.
export function markClosed(binding: TopicBinding, ts: number): TopicBinding {
  const { spawnPending: _sp, spawnToken: _st, ...rest } = binding;
  return { ...rest, status: 'closed', ts };
}

// The reply for a message in a topic whose session is gone (§4.4 row 3): nothing is delivered
// and nothing is spawned; the hint says how to bring that session back.
export function goneTopicReply(binding: Pick<TopicBinding, 'name' | 'harness'>): string {
  return `\`${binding.name || 'this session'}\` is not running — ${resumeHint(binding.harness)}`;
}

// Only harnesses with a known resume command get one; any other (or an unrecorded) harness gets
// a generic hint rather than another harness's command.
function resumeHint(harness: AgentKind | undefined): string {
  if (harness === 'claude') return 'resume with `claude --resume`';
  if (harness === 'codex') return 'resume with `codex resume`';
  if (harness === 'opencode') return 'resume with `opencode --continue`';
  if (harness === 'omp') return 'resume with `rig omp run --resume …`';
  return 'resume it, then send again';
}

// --- tmux window slug (flat /new private-topic spawn) ---

// A safe tmux window name from a session name: keep word chars + dashes, collapse the rest
// to '-', trim, lowercase, cap length. Empty / all-symbol names fall back to the threadId.
// Lowercase Cyrillic → Latin so a Russian name ("Апи бот") yields a READABLE tmux window slug
// ("api-bot") instead of collapsing to `topic-<id>`. Mirrors agent-match.ts's transliteration;
// unmapped chars (other scripts, emoji) still fall through to the `topic-<id>` fallback.
const CYRILLIC_SLUG: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export function slugifyTopicName(name: string, threadId: number): string {
  // Trim dashes AFTER the length cap — slicing can re-expose a trailing dash if the cut
  // lands exactly on a separator.
  const slug = name
    .toLowerCase()
    .replace(/[а-яё]/g, (ch) => CYRILLIC_SLUG[ch] ?? ch)
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 24)
    .replace(/^-+|-+$/g, '');
  return slug || `topic-${threadId}`;
}

// --- unknown-topic hold (§4.4 row 4) ---

// A hold lives 10 minutes from its FIRST item; later messages (album parts included) join the
// same queue without extending it. On expiry the bot answers in the topic.
export const TOPIC_HOLD_TTL_SEC = 600;

export interface TopicHold {
  threadId: number;
  firstAt: number; // unix seconds of the first queued item
  payloads: TopicPayload[]; // FIFO
  pickerMessageId: number | null; // the attach picker once posted; null until a send succeeds
  // The "no session is running" notice was posted for this hold; it is not repeated per message
  // until a session exists and a real picker can be posted.
  noSessionNoticeSent?: true;
}

// Append `payload` to the topic's hold, creating the hold when there is none.
export function holdPayload(holds: TopicHold[], threadId: number, payload: TopicPayload, now: number): TopicHold[] {
  const i = holds.findIndex((h) => h.threadId === threadId);
  if (i === -1) return [...holds, { threadId, firstAt: now, payloads: [payload], pickerMessageId: null }];
  const next = holds.slice();
  next[i] = { ...holds[i], payloads: [...holds[i].payloads, payload] };
  return next;
}

export function findHold(holds: TopicHold[], threadId: number): TopicHold | null {
  return holds.find((h) => h.threadId === threadId) ?? null;
}

// Recording or forgetting a picker also resets the "no session" notice: after a picker dies (its
// session exited) the next message must answer again, even if no session is running by then.
export function setHoldPicker(holds: TopicHold[], threadId: number, pickerMessageId: number | null): TopicHold[] {
  return holds.map((h) => {
    if (h.threadId !== threadId) return h;
    const next: TopicHold = { ...h, pickerMessageId };
    delete next.noSessionNoticeSent;
    return next;
  });
}

export function markNoSessionNotice(holds: TopicHold[], threadId: number): TopicHold[] {
  return holds.map((h) => (h.threadId === threadId ? { ...h, noSessionNoticeSent: true } : h));
}

export function dropHold(holds: TopicHold[], threadId: number): TopicHold[] {
  return holds.filter((h) => h.threadId !== threadId);
}

// Split holds into those past TOPIC_HOLD_TTL_SEC (to answer and discard) and those still open.
export function splitExpiredHolds(holds: TopicHold[], now: number): { expired: TopicHold[]; open: TopicHold[] } {
  const expired: TopicHold[] = [];
  const open: TopicHold[] = [];
  for (const h of holds) (now - h.firstAt >= TOPIC_HOLD_TTL_SEC ? expired : open).push(h);
  return { expired, open };
}

// The hold and its picker are gone by now, so the reply points at sending again (a fresh hold and
// picker), not at a picker that no longer exists.
export function holdExpiredReply(count: number): string {
  return `${count} ${count === 1 ? 'message' : 'messages'} not delivered — send again to reach a session`;
}

const HOLD_STORE_VERSION = 1;

// Bounds the store, in memory and on disk. Past it, the OLDEST hold is evicted (it would expire
// first) and answered in its topic, so the newest message is never the one silently lost.
export const MAX_TOPIC_HOLDS = 200;

// Evicts by firstAt (oldest first), not by array position: a store restored from disk carries no
// order guarantee. Kept holds stay in their original order.
export function capHolds(holds: TopicHold[]): { kept: TopicHold[]; evicted: TopicHold[] } {
  const excess = holds.length - MAX_TOPIC_HOLDS;
  if (excess <= 0) return { kept: holds, evicted: [] };
  const evicted = new Set([...holds].sort((a, b) => a.firstAt - b.firstAt).slice(0, excess));
  return { kept: holds.filter((h) => !evicted.has(h)), evicted: holds.filter((h) => evicted.has(h)) };
}

export function serializeHolds(holds: TopicHold[]): string {
  return `${JSON.stringify({ version: HOLD_STORE_VERSION, holds })}\n`;
}

// Anything malformed, an unknown version, or an invalid hold/payload is skipped — never thrown:
// a corrupt file degrades to "no restored holds" and never wedges daemon startup.
export function parseHolds(raw: string | null): TopicHold[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const env = parsed as Record<string, unknown>;
  if (env.version !== HOLD_STORE_VERSION || !Array.isArray(env.holds)) return [];
  const out: TopicHold[] = [];
  for (const h of env.holds) {
    if (!h || typeof h !== 'object') continue;
    const rec = h as Record<string, unknown>;
    if (!isFiniteNumber(rec.threadId) || !isFiniteNumber(rec.firstAt) || !Array.isArray(rec.payloads)) continue;
    const payloads = rec.payloads.map(parsePayload).filter((p): p is TopicPayload => p !== null);
    if (payloads.length === 0) continue;
    out.push({
      threadId: rec.threadId,
      firstAt: rec.firstAt,
      payloads,
      pickerMessageId: isFiniteNumber(rec.pickerMessageId) ? rec.pickerMessageId : null,
      ...(rec.noSessionNoticeSent === true ? { noSessionNoticeSent: true as const } : {}),
    });
  }
  return out;
}

function parsePayload(v: unknown): TopicPayload | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  if (typeof p.from !== 'string' || !isFiniteNumber(p.messageId)) return null;
  const opt = (k: string): Record<string, string> => (typeof p[k] === 'string' ? { [k]: p[k] as string } : {});
  if (p.type === 'text' && typeof p.text === 'string') {
    return { type: 'text', text: p.text, from: p.from, messageId: p.messageId };
  }
  if (typeof p.fileId !== 'string' || typeof p.suggestedName !== 'string') return null;
  if (p.type === 'media' && (p.mediaKind === 'photo' || p.mediaKind === 'document')) {
    return {
      type: 'media',
      mediaKind: p.mediaKind,
      fileId: p.fileId,
      suggestedName: p.suggestedName,
      ...opt('caption'),
      ...opt('anchor'),
      from: p.from,
      messageId: p.messageId,
    };
  }
  if (p.type === 'voice') {
    return { type: 'voice', fileId: p.fileId, suggestedName: p.suggestedName, ...opt('anchor'), from: p.from, messageId: p.messageId };
  }
  return null;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

// --- attach picker ---

// Callback-data prefix for an attach-picker button: `tgt:<threadId>:<paneId>`. The pane locator
// rides in the button itself (not an index into a list), so the tap stays unambiguous across a
// daemon restart and a fleet change between posting and tapping.
export const TOPIC_ATTACH_CALLBACK_PREFIX = 'tgt';

export function parseTopicAttachCallback(data: string | undefined): { threadId: number; paneId: string } | null {
  const m = data?.match(/^tgt:([1-9]\d*):(%\d+|omp:\d+)$/);
  if (!m) return null;
  return { threadId: Number(m[1]), paneId: m[2] };
}

// One button per live session, in the given (most recent first) order.
export function buildAttachKeyboard(
  threadId: number,
  sessions: ReadonlyArray<{ paneId: string; label: string }>,
): Array<Array<{ text: string; callback_data: string }>> {
  return sessions.map((s) => [{ text: s.label, callback_data: `${TOPIC_ATTACH_CALLBACK_PREFIX}:${threadId}:${s.paneId}` }]);
}

export function attachPickerText(sessionCount: number): string {
  return sessionCount > 0
    ? 'This topic is not linked to a session. Pick one — the held messages go there, in order:'
    : 'This topic is not linked to a session, and no session is running. Start one and send again; held messages expire in 10 min.';
}

// Telegram caps a topic name at 128 characters.
export function topicTitle(name: string): string {
  return [...name].length > 128 ? `${[...name].slice(0, 127).join('')}…` : name;
}

// A link to a topic of a supergroup (`-100…` chat ids). Private-chat topics have no public link.
export function topicLink(chatId: number, threadId: number): string | null {
  const s = String(chatId);
  return s.startsWith('-100') ? `https://t.me/c/${s.slice(4)}/${threadId}` : null;
}
