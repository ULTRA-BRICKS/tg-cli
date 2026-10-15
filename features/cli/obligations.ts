/**
 * @file Follow-up obligations recorded by the intent gate (tg-cli#706): the decisions and
 * blockers a sent message still owes as separate replies, and the `tg obligations` command
 * that lists, checks and dismisses them.
 *
 * Accessed via: the `tg` entrypoint — after a send whose intent verdict was `follow-up`
 * (records one obligation per item, keyed by the sent message's id), after a `--reply-to`
 * send that passes the gate (fulfils the oldest open obligation of that kind under the
 * replied-to message), and by `tg obligations`.
 *
 * STORE: `<config dir>/intent-obligations.jsonl`, append-only events — `owed`, `fulfilled`,
 * `dismissed` — so concurrent `tg` processes never rewrite each other's lines. The open
 * set is every `owed` without a later `fulfilled`/`dismissed` for its id. A line that does
 * not parse is skipped (one torn write cannot hide the rest).
 *
 * PURE — no I/O; the entrypoint reads and appends the file.
 */
import type { FollowUp } from './intent-gate';

export const OBLIGATIONS_FILE = 'intent-obligations.jsonl';

export interface Obligation {
  // `<original message id>.<n>` — what `tg obligations dismiss` takes.
  id: string;
  chatId: string;
  originalId: number;
  kind: FollowUp['kind'];
  quote: string;
  // Unix seconds.
  at: number;
  // The sender label (`[window]` / `[window] [subagent]`) — whose reminder it is.
  sender: string;
}

type ObligationEvent =
  | ({ event: 'owed' } & Obligation)
  | { event: 'fulfilled'; id: string; chatId: string; by: number; at: number }
  | { event: 'dismissed'; id: string; chatId: string; reason: string; at: number };

const line = (e: ObligationEvent): string => `${JSON.stringify(e)}\n`;

/** The `owed` lines for a sent message's follow-ups. */
export function owedLines(
  followUps: readonly FollowUp[],
  ctx: { chatId: string; originalId: number; at: number; sender: string },
): string {
  return followUps
    .map((f, i) =>
      line({ event: 'owed', id: `${ctx.originalId}.${i + 1}`, chatId: ctx.chatId, originalId: ctx.originalId, kind: f.kind, quote: f.quote, at: ctx.at, sender: ctx.sender }),
    )
    .join('');
}

/** Every obligation still open in the store text, oldest first. */
export function openObligations(text: string): Obligation[] {
  const open = new Map<string, Obligation>();
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    let e: ObligationEvent;
    try {
      e = JSON.parse(raw) as ObligationEvent;
    } catch {
      continue;
    }
    const key = `${e.chatId}|${e.id}`;
    if (e.event === 'owed' && typeof e.originalId === 'number' && typeof e.quote === 'string') {
      const { event: _event, ...obligation } = e;
      open.set(key, obligation);
    } else if (e.event === 'fulfilled' || e.event === 'dismissed') {
      open.delete(key);
    }
  }
  return [...open.values()].sort((a, b) => a.at - b.at);
}

/**
 * The `fulfilled` line for a reply that passed the gate as `kind` under `replyTo`, or null
 * when nothing of that kind is owed there. One reply settles one obligation (the oldest).
 */
export function fulfilmentLine(
  open: readonly Obligation[],
  reply: { chatId: string; replyTo: number; kind: FollowUp['kind']; by: number; at: number },
): string | null {
  const owed = open.find((o) => o.chatId === reply.chatId && o.originalId === reply.replyTo && o.kind === reply.kind);
  return owed ? line({ event: 'fulfilled', id: owed.id, chatId: owed.chatId, by: reply.by, at: reply.at }) : null;
}

export type ObligationsCommand =
  | { action: 'list'; json: boolean; check: boolean }
  | { action: 'dismiss'; id: string; reason: string }
  | { action: 'help' }
  | { action: 'error'; message: string };

export const OBLIGATIONS_USAGE = `Usage:
  tg obligations              list the follow-ups still owed (exit 0)
  tg obligations --check      same, but exit 1 while any is open (for hooks / CI)
  tg obligations --json       the open list as JSON
  tg obligations dismiss <id> --reason "<why>"
                              close one that does not apply (the gate misread a
                              rhetorical question, say); the reason is recorded

A follow-up is owed when the intent gate let a message through that also asked a
question outside the decision format, carried several decisions, or hid a blocker in
a report. Each item is owed as its own REPLY to that message:
  tg --reply-to <message id> --tag decision --format html '<h3>Context</h3>…'
A reply that passes the gate settles the oldest open item of its kind there.`;

export function parseObligationsArgs(args: readonly string[]): ObligationsCommand {
  if (args.includes('-h') || args.includes('--help')) return { action: 'help' };
  if (args[0] === 'dismiss') {
    const id = args[1];
    const reasonAt = args.indexOf('--reason');
    const reason = reasonAt >= 0 ? (args[reasonAt + 1] ?? '').trim() : '';
    if (!id || id.startsWith('--') || reason === '') {
      return { action: 'error', message: 'Error: tg obligations dismiss needs an id and --reason "<why>".' };
    }
    return { action: 'dismiss', id, reason };
  }
  const unknown = args.find((a) => a !== '--json' && a !== '--check');
  if (unknown !== undefined) return { action: 'error', message: `Error: unknown argument '${unknown}' for tg obligations.` };
  return { action: 'list', json: args.includes('--json'), check: args.includes('--check') };
}

/** The `dismissed` line for `id`, or null when no open obligation has that id. */
export function dismissLine(open: readonly Obligation[], id: string, reason: string, at: number): string | null {
  const owed = open.find((o) => o.id === id);
  return owed ? line({ event: 'dismissed', id: owed.id, chatId: owed.chatId, reason, at }) : null;
}

/** The human list of open obligations. */
export function formatObligations(open: readonly Obligation[]): string {
  if (open.length === 0) return 'No follow-ups owed.';
  return [
    `${open.length} follow-up(s) owed — each is its own reply to the message it came from:`,
    ...open.map(
      (o) =>
        `  ${o.id}  [${o.kind}] «${o.quote}»  — ${o.sender || 'unknown sender'}\n` +
        `      tg --reply-to ${o.originalId} --tag ${o.kind} --format html '…'`,
    ),
    'Not applicable? tg obligations dismiss <id> --reason "<why>"',
  ].join('\n');
}
