// Inbound → HistoryRecord extraction for `tg replies`. PURE — the tg-ctl daemon
// passes the raw getUpdates batch + the currently-routed pane; this returns the
// `user` history records to append (UNWRAPPED text, never the `[TG from …]`
// envelope). The daemon owns the file append (best-effort, see tg-ctl).
//
// This mirrors stepUpdates' sender-allowlist + message-kind handling but only
// for the purpose of RECALL: it logs what the CTO actually sent (text, or a
// caption / placeholder for media), so an agent can later run `tg replies` and
// see it. Media transcripts (voice) arrive asynchronously and are logged as a
// `[voice]` placeholder — the daemon does NOT re-log the transcript (keeping the
// writer on the synchronous poll path, never racing the Whisper pipeline).

import type { TgMessage, TgUpdate } from '../tg-ctl/types';
import type { HistoryRecord } from './history';

export interface InboundOpts {
  chatId: number; // the owner chat id (always allowed)
  allowedSenders: number[]; // extra allowed sender user ids (cfg.allowedSenders)
  pane: string | null; // the DEFAULT routed target pane (null when none discovered)
  // Legacy options kept for older callers. Owner messages are no longer dropped
  // by age (#183), so recall keeps every allowed message Telegram delivered.
  nowSec?: number;
  stalenessSec?: number;
  // Per-message pane override: a REPLY routes to its recognized origin pane, not
  // the default target, so logging it under the default would hide it from that
  // pane's scoped `tg replies`. The daemon injects this (reply-route recognition
  // against the routes map); returns the resolved pane, or null to use the
  // default `pane`. Omitted → every message gets the default `pane`.
  resolvePane?: (m: TgMessage) => string | null;
  // Map the RESOLVED target pane (reply-origin pane, else the default `pane`) to
  // the human AGENT NAME it belongs to (resolveSessionName().primary over the daemon's live
  // tmux snapshot). Stamped as `targetAgent` so `tg replies` can attribute + scope
  // each message. The daemon injects this; omitted (or a null return) → the record
  // carries no targetAgent (treated as untagged on read). Kept a param, not an
  // import, so this module stays pure/testable.
  resolveAgent?: (pane: string | null) => string | null;
  // Map the same resolved pane to the registry session key it hosts
  // (session-registry-and-topics.md §3.3), stamped as `sessionKey` so a later
  // rename keeps the row in that session's `tg replies`. Omitted / null → no key.
  resolveSession?: (pane: string | null) => string | null;
}

function senderAllowed(sender: number | undefined, opts: InboundOpts): boolean {
  return sender !== undefined && (sender === opts.chatId || opts.allowedSenders.includes(sender));
}

// The text to LOG for a message: its prose, else a caption, else a kind
// placeholder so a media-only message still shows up in recall.
function historyText(m: TgMessage): string {
  if (m.text) return m.text;
  if (m.caption) return m.caption;
  if (m.voice ?? m.audio) return '[voice]';
  if (m.photo?.length) return '[photo]';
  if (m.document) return '[document]';
  return '[message]';
}

export function inboundHistoryRecords(updates: TgUpdate[], opts: InboundOpts): HistoryRecord[] {
  const out: HistoryRecord[] = [];
  for (const u of updates) {
    const m = u.message;
    if (!m) continue; // callback queries + non-message updates are not history
    if (!senderAllowed(m.from?.id, opts)) continue; // a group member is never logged
    if (m.chat.id !== opts.chatId) continue; // the daemon serves its configured chat only
    // Owner inbound is not dropped by age (#183): if Telegram delivered it after
    // daemon downtime it is still a real request and belongs in recall.
    const from = m.from?.first_name || m.from?.username || 'tg';
    const resolved = opts.resolvePane?.(m) ?? null;
    const pane = resolved ?? opts.pane;
    const targetAgent = opts.resolveAgent?.(pane) ?? undefined;
    const sessionKey = opts.resolveSession?.(pane) ?? undefined;
    out.push({
      ts: m.date,
      message_id: m.message_id,
      chat_id: m.chat.id,
      direction: 'user',
      from,
      text: historyText(m),
      pane,
      ...(targetAgent ? { targetAgent } : {}),
      ...(sessionKey ? { sessionKey } : {}),
    });
  }
  return out;
}
