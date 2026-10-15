// One bot-created forum topic per registry session (docs/specs/session-registry-and-topics.md
// §4.2, §4.3, §4.5; tg-cli#467). The topic is an ADDRESS for an existing session: it is
// created lazily on the session's first outbound (a `tg` send or a question/permission
// card), stored as the registry entry's `threadId`, and reused when the session resumes.
//
// PURE — the daemon injects the Bot API calls and the registry writes.

import type { Harness, Registry, SessionEntry, SessionKey } from './session-registry';
import type { AgentKind } from './types';
import { topicTitle } from './topics';

// A thread-not-found run turns into "the topic was deleted" on the 3rd consecutive miss once
// this long has passed since the first (§4.5): fresh private-chat topics reject bot writes for
// a while (telegram-bot-api #905), so a short burst must not recreate the topic.
export const TOPIC_MISS_RECREATE_COUNT = 3;
export const TOPIC_MISS_RECREATE_AFTER_MS = 10 * 60 * 1000;
// A deleted topic is recreated at most once per this window per entry (§4.2).
export const TOPIC_RECREATE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// `primary · secondary` (§3.1), capped at Telegram's 128 characters. An entry with no usable
// name signal is titled by its key so the topic is never blank.
export function topicTitleFor(entry: Pick<SessionEntry, 'name' | 'key'>): string {
  const { primary, secondary } = entry.name;
  const name = [primary, secondary].filter((part): part is string => Boolean(part)).join(' · ');
  return sessionTopicTitle(name || entry.key);
}

// A session topic's title, which must never open like the system "📥 Inbox" topic (open
// questions only): a leading 📥 becomes ✉, and a title opening with the word "inbox" gets ✉ in
// front (tg-cli#709 — a session titled "📥 INBOX: …" was taken for the Inbox itself).
export function sessionTopicTitle(name: string): string {
  const trimmed = name.trimStart();
  const rest = trimmed.replace(/^(?:📥\uFE0F?\s*)+/u, '');
  return topicTitle(rest !== trimmed || /^inbox\b/i.test(rest) ? `✉ ${rest}` : name);
}

// The topics.json pane locator of a live entry: its tmux pane, or `omp:<pid>` for an omp
// outside tmux (the same locator forms the inbound triage and the attach picker use).
export function paneLocatorOf(entry: Pick<SessionEntry, 'harness' | 'locators'>): string | null {
  if (entry.locators.tmux) return entry.locators.tmux.paneId;
  if (entry.harness === 'omp' && entry.locators.pid !== null) return `omp:${entry.locators.pid}`;
  return null;
}

// The route origin of a sessionless `tg` send (an unpinned omp background job, a failed pin —
// tg-cli#709). No pane, pid or host ever matches it, so a reply to such a message is recognized
// as aimed at a gone sender and always gets the agent picker, never the lone live agent.
export const SYSTEM_ORIGIN = 'system';

// What `tg` knows about the session it runs in (§4.3): its tmux pane and that pane's server
// (the second field of $TMUX), the harness ancestor pid(s), and the omp session file.
export interface SessionLookup {
  tmuxPane: string | null;
  tmuxServerPid: number | null;
  ancestorPids: number[];
  sessionFile: string | null;
  // A `--session`/TG_SESSION pin's registry key: when set it alone decides (no pid/pane
  // fallback), so a resumed or pid-reused session can't swap the topic (tg-cli#709).
  sessionKey?: string | null;
}

const positiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

// The hook-socket `{"kind":"resolve-session",…}` line → a lookup, or null for any other line.
// Fields a client sends malformed are dropped rather than trusted.
export function parseResolveSessionRequest(raw: unknown): SessionLookup | null {
  if (!raw || typeof raw !== 'object' || !('kind' in raw) || raw.kind !== 'resolve-session') return null;
  const r: Record<string, unknown> = { ...raw };
  const pane = typeof r.tmuxPane === 'string' && /^%\d+$/.test(r.tmuxPane) ? r.tmuxPane : null;
  const pids = Array.isArray(r.ancestorPids) ? r.ancestorPids.filter(positiveInt).slice(0, 32) : [];
  return {
    tmuxPane: pane,
    tmuxServerPid: positiveInt(r.tmuxServerPid) ? r.tmuxServerPid : null,
    ancestorPids: pids,
    sessionFile: typeof r.sessionFile === 'string' && r.sessionFile.length > 0 ? r.sessionFile : null,
    sessionKey: typeof r.sessionKey === 'string' && r.sessionKey.length > 0 ? r.sessionKey : null,
  };
}

// `tg`'s report after a send into a resolved topic (§4.5): `{"kind":"topic-result","key",
// "threadId","ok","description"?}` → the outcome, or null for any other line.
export function parseTopicResult(raw: unknown): { key: string; threadId: number; ok: boolean; description: string } | null {
  if (!raw || typeof raw !== 'object' || !('kind' in raw) || raw.kind !== 'topic-result') return null;
  const r: Record<string, unknown> = { ...raw };
  if (typeof r.key !== 'string' || !positiveInt(r.threadId) || typeof r.ok !== 'boolean') return null;
  // Printable ASCII only: it is logged and quoted into a Telegram notice.
  const description = typeof r.description === 'string' ? r.description.replace(/[^\x20-\x7e]/g, '?').slice(0, 200) : 'message thread not found';
  return { key: r.key, threadId: r.threadId, ok: r.ok, description };
}

// The live entry `tg` is running in. The harness pid is the most exact locator (it also covers
// an omp outside tmux), then the omp session file, then the tmux pane — which counts only on
// the same tmux server, since a restarted server reuses `%N` ids (§2.6). Gone entries never
// match: a dead session has no outbound.
export function findSessionForLookup(reg: Registry, q: SessionLookup): SessionEntry | null {
  const live = reg.sessions.filter((e) => e.state === 'live');
  if (q.sessionKey) return live.find((e) => e.key === q.sessionKey) ?? null;
  const byPid = live.find((e) => e.locators.pid !== null && q.ancestorPids.includes(e.locators.pid));
  if (byPid) return byPid;
  if (q.sessionFile) {
    const byFile = live.find((e) => e.sessionFile === q.sessionFile);
    if (byFile) return byFile;
  }
  if (q.tmuxPane) {
    return (
      live.find((e) => {
        const tmux = e.locators.tmux;
        return !!tmux && tmux.paneId === q.tmuxPane && (q.tmuxServerPid === null || tmux.serverPid === q.tmuxServerPid);
      }) ?? null
    );
  }
  return null;
}

// The agent kind each harness reports on hooks and bindings — the one agent↔harness table.
export const HARNESS_AGENT: Record<Harness, AgentKind> = { omp: 'omp', cc: 'claude', codex: 'codex' };

// The live entry a question/permission card belongs to: the hook's session id (cc/codex carry
// it as `origin.sessionId`), else the asking pane.
export function findSessionForCard(
  reg: Registry,
  card: { agent: string; sessionId?: string; paneId?: string },
): SessionEntry | null {
  const live = reg.sessions.filter((e) => e.state === 'live');
  if (card.sessionId) {
    const byId = live.find((e) => e.sessionId === card.sessionId && HARNESS_AGENT[e.harness] === card.agent);
    if (byId) return byId;
  }
  if (card.paneId) return live.find((e) => e.locators.tmux?.paneId === card.paneId) ?? null;
  return null;
}

// `ensureTopic(key)` serialised per key (§4.2): concurrent first outbounds of one session share
// one in-flight create, so two first sends create one topic. `threadIdOf` reads the stored
// binding; `create` makes and persists the topic (or adopts an existing one) and returns its
// thread id, or null when topics are unavailable. A null or thrown create is not remembered:
// the next outbound tries again.
export function createTopicEnsurer(io: {
  threadIdOf: (key: SessionKey) => number | null;
  create: (key: SessionKey) => Promise<number | null>;
}): (key: SessionKey) => Promise<number | null> {
  const inFlight = new Map<SessionKey, Promise<number | null>>();
  return (key) => {
    const known = io.threadIdOf(key);
    if (known !== null) return Promise.resolve(known);
    const pending = inFlight.get(key);
    if (pending) return pending;
    const run = (async () => {
      try {
        return await io.create(key);
      } catch {
        return null;
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, run);
    return run;
  };
}

// One threaded send fell back to General (§4.5). Returns the entry's next miss counter and
// whether to recreate the topic now: at once when Telegram reports it deleted, or on the 3rd+
// consecutive miss once 10 min have passed since the first — in both cases at most once per
// 24 h per entry (`lastRecreatedAt`). A recreate clears the counter.
export function noteTopicMiss(
  prev: SessionEntry['topicMisses'],
  now: number,
  opts: { deleted: boolean; lastRecreatedAt: number | null },
): { misses: SessionEntry['topicMisses']; recreate: boolean } {
  const misses = { count: (prev?.count ?? 0) + 1, firstAt: prev?.firstAt ?? new Date(now).toISOString() };
  const thresholdReached = misses.count >= TOPIC_MISS_RECREATE_COUNT && now - Date.parse(misses.firstAt) >= TOPIC_MISS_RECREATE_AFTER_MS;
  const capped = opts.lastRecreatedAt !== null && now - opts.lastRecreatedAt < TOPIC_RECREATE_COOLDOWN_MS;
  const recreate = (opts.deleted || thresholdReached) && !capped;
  return { misses: recreate ? null : misses, recreate };
}
