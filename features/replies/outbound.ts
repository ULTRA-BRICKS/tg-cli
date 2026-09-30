// Outbound text selection + history-record shaping for `tg replies`. PURE —
// the `tg` entrypoint knows the message body, attachment counts, and the ids
// Telegram assigned to what it just sent, and asks this module what to LOG.
// A photo/document-only send (no body) is logged with a placeholder so it
// still shows up in recall; a truly empty send (no body, no media — can't
// happen, the CLI rejects it) → null.

import type { HistoryRecord } from './history';

export interface OutboundAttachments {
  photos: number;
  documents: number;
}

// A mixed-media send (transmit orders photos, then documents — see
// features/auto-attach/transmitter.ts) with an empty body needs BOTH counts
// in the placeholder. This is still a per-SEND label, not a per-message one —
// with buildOutboundHistoryRecords now writing one record per outbound id
// (review: tg-cli#131), EVERY id of a mixed send (photo AND document ids
// alike) gets this same combined text, so recall-by-id shows "what the whole
// send contained", not "what this specific id was". Before this fix an
// empty-body mixed send silently dropped the document count from the
// placeholder entirely (photos-only won the old priority check); the
// combined form is strictly more informative, not a precise per-id label.
export function outboundHistoryText(body: string, attach: OutboundAttachments): string | null {
  const trimmed = body.trim();
  if (trimmed !== '') return body;
  const parts: string[] = [];
  if (attach.photos > 0) parts.push(attach.photos === 1 ? 'photo' : `${attach.photos} photos`);
  if (attach.documents > 0) parts.push(attach.documents === 1 ? 'document' : `${attach.documents} files`);
  return parts.length > 0 ? `[${parts.join(', ')}]` : null;
}

// One `agent` history record PER outbound Telegram message_id — a send that
// splits into several Telegram messages (a >4096 split, or a media-group
// album) gets one record per id, all carrying the same text, so a reply
// anchored to ANY of those ids stays recall-able via `tg replies --json |
// select(.id == <tg#>)`. `buildReplyAnchor` (features/tg-ctl/updates.ts)
// stamps the reply-quote anchor with whichever id the CTO actually replied
// to — that can be any chunk/item, not only the first. Recording only the
// first id left later chunks unrecoverable (review: tg-cli#131). Falls back
// to a single `message_id: null` record when the send reported no ids at all
// (the `tg` entrypoint only calls this once originPaneId is confirmed set — a
// tmux pane if present, else the synthetic omp:<pid> origin for a headless
// omp session (tg-cli#363) — so in practice this is a successful send whose
// API response carried no message_id, not the no-origin-at-all case, which
// returns before ever reaching here. Unchanged from before this fix). Ids
// are de-duplicated (order preserved) so a caller that ever reports the
// same message_id twice (a retry, a defensive double-record) still logs
// exactly one history row per
// real Telegram message, matching routes.ts's own dedupe-by-id invariant
// (appendRoute) instead of a naive push.
//
// A TRUE multi-part send (2+ ids) stamps every sibling record with `groupId`,
// so `select.ts`'s reader can reconstruct "these N records are ONE logical
// send" from an authoritative write-time marker instead of guessing from
// coincidental field equality (same ts/text/pane) — the latter would wrongly
// merge two genuinely different messages sent in the same second with
// identical text (review: tg-cli#131 follow-up, closes #134). `groupId` is a
// CALLER-SUPPLIED opaque token (`tg` passes crypto.randomUUID()), not derived
// from `message_id`: Telegram's message_id is sequential PER CHAT, so reusing
// the first id as the group key could collide across two different chats
// sharing one bot's history file (same botId, different TG_CHAT_ID configs)
// — a random token makes that collision probability negligible regardless
// of chat topology. Keeping the token an injected parameter (like `ts`) —
// rather than generating it here with crypto.randomUUID() — keeps this
// function pure and deterministic for tests. A single-record send gets no
// groupId — nothing to group it with, so the token is simply unused.
// `targetAgent` (optional) is the SENDING session's own agent name
// (resolveSessionName().primary over its tmux pane) — the SAME namespace tg-ctl stamps on
// inbound, so a session's outbound and the inbound routed to it share one label
// and the default agent-scoped `tg replies` view groups them together. Absent
// (undefined) when the sender's agent name couldn't be resolved → untagged on
// read. Stamped on EVERY sibling record of a multi-part send (they are one
// logical send from one agent). `sessionKey` (optional) is the sender's registry
// session (session-registry-and-topics.md §3.3) — the identity `tg replies`
// scopes on, so a rename never splits the session's history.
export function buildOutboundHistoryRecords(
  outboundIds: number[],
  text: string,
  ts: number,
  pane: string,
  groupToken: string,
  chatId?: number,
  targetAgent?: string,
  sessionKey?: string,
): HistoryRecord[] {
  const uniqueIds = [...new Set(outboundIds)];
  const ids: (number | null)[] = uniqueIds.length > 0 ? uniqueIds : [null];
  // An empty token is treated the same as "no token" — symmetric with
  // history.ts's parseLine, which coerces a stored `groupId: ''` to
  // undefined for the exact same reason: groupMultiPartSends' adjacency
  // check (`r.groupId !== undefined && prev?.groupId === r.groupId`) would
  // otherwise let two records both carrying `groupId: ''` wrongly satisfy
  // it and merge. crypto.randomUUID() never produces '', but a caller
  // passing an empty string by mistake shouldn't silently create a false
  // grouping key.
  const groupId = uniqueIds.length > 1 && groupToken !== '' ? groupToken : undefined;
  const agent = targetAgent && targetAgent.trim() !== '' ? targetAgent.trim() : undefined;
  return ids.map((message_id) => ({
    ts,
    message_id,
    ...(chatId !== undefined ? { chat_id: chatId } : {}),
    direction: 'agent',
    from: 'agent',
    text,
    pane,
    ...(groupId !== undefined ? { groupId } : {}),
    ...(agent !== undefined ? { targetAgent: agent } : {}),
    ...(sessionKey ? { sessionKey } : {}),
  }));
}
