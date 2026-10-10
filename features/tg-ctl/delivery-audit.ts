// PURE core of `tg-ctl audit-delivery` (tg-cli#299): which inbound Telegram messages
// never reached an agent, which reached one more than once, and which updates the
// daemon never received at all. The entrypoint owns the I/O (history file, delivery
// ledger, daemon log, walking harness transcript directories); this module turns
// their parsed contents into one report.
//
// Evidence, strongest first:
//   1. the delivery ledger (delivery-ledger.ts) — exact, but only since tg-cli#299;
//   2. harness transcripts — every inject lands as a USER prompt that starts with the
//      inbound wrap `[TG from <name> tg#<id>] …` (optionally under a reply anchor or a
//      git-state banner line), so counting those prompts per session file shows both
//      delivery and duplication over the whole retained history. omp advisor files
//      mirror their session's prompts: they prove delivery but are never counted as
//      duplicates (they would repeat every copy of the session they mirror);
//   3. the daemon log — a delivery line quoting the wrap shows the daemon sent the
//      message even when no transcript survives to confirm it (harnesses prune them);
//   4. the history log's inbound rows — what the daemon received (no update ids).
//
// Only a prompt whose text STARTS with the wrap counts: the same wrap quoted inside
// a review diff, a subagent task, or a compaction summary is not a delivery.

import { parseDateArg } from '../replies/args';
import type { HistoryRecord } from '../replies/history';
import type { LedgerEvent, LedgerHold } from './delivery-ledger';
import { isRecord } from './guards';

interface TranscriptPrompt {
  id: string; // record id unique within its file (omp id, Claude uuid, else the line number)
  ts: string | null;
  text: string;
  synthetic: boolean; // written by the harness itself (an omp advisor "session update"), not typed
}

function textOfParts(content: unknown, partType: string): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    // A tool result travelling as a user turn is never a typed prompt.
    if (part.type === 'tool_result') return null;
    if (part.type === partType && typeof part.text === 'string') texts.push(part.text);
  }
  return texts.length > 0 ? texts.join('\n') : null;
}

// The user prompt carried by one parsed transcript record, for the three transcript
// shapes on this machine: omp (`type: message`, role user), Claude Code (`type: user`,
// minus meta/compaction/sidechain turns; a prompt typed while the agent was busy lands
// as a `queued_command` attachment instead, after a `queue-operation` enqueue record),
// Codex (`response_item` user message — its `event_msg` twin of the same input is ignored).
function transcriptPrompt(rec: unknown, lineNo: number): TranscriptPrompt | null {
  if (!isRecord(rec)) return null;
  const ts = typeof rec.timestamp === 'string' ? rec.timestamp : null;
  const message = isRecord(rec.message) ? rec.message : null;
  if (rec.type === 'message' && message?.role === 'user') {
    const text = textOfParts(message.content, 'text');
    const synthetic = message.synthetic === true || message.attribution === 'agent';
    return text === null ? null : { id: typeof rec.id === 'string' ? rec.id : `L${lineNo}`, ts, text, synthetic };
  }
  if (rec.type === 'user' && message?.role === 'user') {
    if (rec.isMeta === true || rec.isCompactSummary === true || rec.isSidechain === true) return null;
    const text = textOfParts(message.content, 'text');
    return text === null ? null : { id: typeof rec.uuid === 'string' ? rec.uuid : `L${lineNo}`, ts, text, synthetic: false };
  }
  const attachment = isRecord(rec.attachment) ? rec.attachment : null;
  if (attachment?.type === 'queued_command' && typeof attachment.prompt === 'string' && rec.isSidechain !== true) {
    return { id: typeof rec.uuid === 'string' ? rec.uuid : `L${lineNo}`, ts, text: attachment.prompt, synthetic: false };
  }
  // The enqueue proves the text reached the harness even if the session ended before it
  // ran; the `queued_command` attachment that follows is the copy counted as the delivery.
  if (rec.type === 'queue-operation' && rec.operation === 'enqueue' && typeof rec.content === 'string') {
    return { id: `L${lineNo}`, ts, text: rec.content, synthetic: true };
  }
  const payload = isRecord(rec.payload) ? rec.payload : null;
  if (rec.type === 'response_item' && payload?.type === 'message' && payload.role === 'user') {
    const text = textOfParts(payload.content, 'input_text');
    return text === null ? null : { id: `L${lineNo}`, ts, text, synthetic: false };
  }
  return null;
}

// An omp advisor transcript (`<session>/__advisor*.jsonl`) replays its session's
// prompts; it proves delivery but duplicates every copy of the session it mirrors.
const MIRROR_TRANSCRIPT = /(?:^|\/)__advisor[^/]*\.jsonl$/;
// A context compaction: Claude Code's `compact_boundary`, omp's `compaction` record.
// Claude Code re-submits the prompt that was pending when it compacted.
const COMPACTION = /"subtype":"compact_boundary"|"type":"compaction"/;

// Lines the daemon may put ABOVE the wrap: the reply quote anchor (`↩ tg#… «…»`) and
// the git-state banner (`⚠ This pane …`).
const PREFIX_LINE = /^(?:↩ |⚠ This pane )[^\n]*\n/;
const WRAP = /^\[TG from [^\]\n]*?(?: (?:tg)?#(\d+))?\] ?([\s\S]*)$/;
// An advisor mirror quotes each session turn under a `**user**:` line.
const MIRRORED_TURN = /\*\*user\*\*:\n/g;

interface InjectedWrap {
  msg: number | null; // null: a wrap written without an id (synthetic injects, pre-tg-cli#274 `/agent`)
  body: string;
}

// The inbound wrap `text` starts with, or null when it is not a tg-ctl inject.
function injectedWrap(text: string): InjectedWrap | null {
  let rest = text.trimStart();
  for (let i = 0; i < 2 && PREFIX_LINE.test(rest); i++) rest = rest.replace(PREFIX_LINE, '');
  const m = WRAP.exec(rest);
  if (!m) return null;
  return { msg: m[1] === undefined ? null : Number(m[1]), body: m[2].trim() };
}

// Every wrap a prompt carries: the one it starts with (a typed inject, unless the
// harness wrote the record itself), plus each turn an advisor mirror quotes.
function promptWraps(prompt: TranscriptPrompt): Array<InjectedWrap & { mirror: boolean }> {
  const out: Array<InjectedWrap & { mirror: boolean }> = [];
  const own = injectedWrap(prompt.text);
  if (own) out.push({ ...own, mirror: prompt.synthetic });
  for (const m of prompt.text.matchAll(MIRRORED_TURN)) {
    // Each mirrored turn ends at the next quoted turn; its own wrap is at its start.
    const turn = prompt.text.slice((m.index ?? 0) + m[0].length).split(/\n\*\*\w+\*\*:\n/, 1)[0];
    const wrap = injectedWrap(turn);
    if (wrap) out.push({ ...wrap, mirror: true });
  }
  return out;
}

export interface InjectedCopy {
  msg: number | null;
  body: string;
  file: string;
  recordId: string;
  ts: string | null;
  // Written by the harness itself — an advisor mirror, a post-compaction re-submit.
  // Proves delivery; never counted as a duplicate.
  mirror: boolean;
}

// Every tg-ctl inject recorded in one transcript file (`raw`: its whole JSONL text).
export function transcriptCopies(raw: string, file: string): InjectedCopy[] {
  const out: InjectedCopy[] = [];
  if (!raw.includes('[TG from')) return out;
  const mirrorFile = MIRROR_TRANSCRIPT.test(file);
  const lastSeenLine = new Map<number, number>();
  let lastCompaction = -1;
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (COMPACTION.test(line)) lastCompaction = i;
    if (!line.includes('[TG from')) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const prompt = transcriptPrompt(rec, i + 1);
    if (!prompt) continue;
    for (const wrap of promptWraps(prompt)) {
      const prev = wrap.msg === null ? undefined : lastSeenLine.get(wrap.msg);
      const resubmitted = prev !== undefined && lastCompaction > prev;
      if (wrap.msg !== null && !wrap.mirror) lastSeenLine.set(wrap.msg, i);
      out.push({ msg: wrap.msg, body: wrap.body, file, recordId: prompt.id, ts: prompt.ts, mirror: wrap.mirror || mirrorFile || resubmitted });
    }
  }
  return out;
}

// Message ids a daemon log shows a delivery attempt for: every inject/route line
// quotes the wrapped text it sends, so its `[TG from … tg#<id>]` names the message.
export function logDeliveryIds(log: string): Set<number> {
  const ids = new Set<number>();
  for (const m of log.matchAll(/\[TG from [^\]\n]*? tg#(\d+)\]/g)) ids.add(Number(m[1]));
  return ids;
}

export interface AuditInput {
  chatId: number | null; // only this chat's rows (null = every chat)
  history: HistoryRecord[];
  ledger: LedgerEvent[];
  copies: InjectedCopy[];
  logAttempts: Set<number>;
  sinceSec: number | null;
  untilSec: number | null;
}

export interface AuditMessage {
  msg: number;
  date: number; // unix seconds (Telegram message date)
  text: string;
  target: string | null;
}

export interface AuditReport {
  from: number | null;
  to: number | null;
  received: number;
  delivered: number;
  notForDelivery: number; // daemon commands, verbatim `/` `!` passthroughs, stickers — no wrap to find
  duplicated: Array<AuditMessage & { copies: number; file: string }>;
  // The daemon log shows it sent the message, but no transcript survives to confirm it.
  unconfirmed: AuditMessage[];
  // Proven NOT delivered (or possibly not): the ledger recorded a failure or a delivery a
  // daemon restart interrupted. The daemon told the CTO about each one.
  undelivered: Array<AuditMessage & { reason: string }>;
  // No evidence either way: no ledger record (most predate it) and neither a transcript
  // (harnesses prune them) nor a daemon log line quoting it survives. Not a proven loss.
  unverified: AuditMessage[];
  pending: Array<AuditMessage & { hold: LedgerHold }>;
  suppressedDuplicates: number; // re-deliveries the ledger blocked
  updateGaps: Array<{ from: number; to: number; count: number; afterDate: number; beforeDate: number }>;
}

const AGENT_WITH_TEXT = /^\/agent(?:@\w+)?\s+\S+\s+\S/;

// Texts the daemon executes or passes through verbatim, never wrapped: `/status`,
// `/compact`, `!ls`, a bare `/agent [<selector>]`, and non-media updates the history
// logs as `[message]`. `/agent <selector> <text>` IS wrapped and delivered.
function notWrapped(text: string): boolean {
  if (text === '[message]' || text.startsWith('!')) return true;
  return text.startsWith('/') && !AGENT_WITH_TEXT.test(text);
}

export function buildAuditReport(input: AuditInput): AuditReport {
  const inWindow = (sec: number): boolean =>
    (input.sinceSec === null || sec >= input.sinceSec) && (input.untilSec === null || sec <= input.untilSec);

  // Received messages: history rows plus ledger receipts (the ledger also covers rows the
  // history's best-effort, lock-skipping append may have missed).
  const received = new Map<number, AuditMessage>();
  for (const r of input.history) {
    if (r.direction !== 'user' || r.message_id === null) continue;
    if (input.chatId !== null && r.chat_id !== undefined && r.chat_id !== input.chatId) continue;
    if (!inWindow(r.ts)) continue;
    received.set(r.message_id, { msg: r.message_id, date: r.ts, text: r.text, target: r.targetAgent ?? r.pane ?? null });
  }
  type Outcome = { state: 'claimed' | 'delivered' | 'uncertain' | 'unsubmitted' | 'failed' | 'queued'; target: string; error?: string; hold?: LedgerHold };
  const outcome = new Map<number, Outcome>();
  const updates = new Map<number, number>(); // update_id → message date (or receipt time)
  let suppressedDuplicates = 0;
  for (const e of input.ledger) {
    if (e.event === 'processed') continue;
    if (e.event === 'received') {
      // Every update fills the id sequence; only an owner message in this chat is "received".
      updates.set(e.update, e.date);
      const msg = e.msg;
      if (msg === undefined || (input.chatId !== null && e.chat !== input.chatId)) continue;
      if (inWindow(e.date) && !received.has(msg)) received.set(msg, { msg, date: e.date, text: '', target: null });
      continue;
    }
    if (input.chatId !== null && e.chat !== input.chatId) continue;
    if (e.event === 'duplicate') {
      suppressedDuplicates += 1;
      continue;
    }
    // An album's items each carry their own claim/outcome records (withAlbumParts).
    if (e.event === 'album') continue;
    const prior = outcome.get(e.msg);
    // A hold never hides a delivery that already happened (a replay re-queued it).
    if (e.event === 'queued' && prior && prior.state !== 'failed' && prior.state !== 'queued') continue;
    outcome.set(e.msg, {
      state: e.event,
      target: e.target,
      ...(e.event === 'failed' ? { error: e.error } : {}),
      ...(e.event === 'queued' ? { hold: e.hold } : {}),
    });
  }

  // Transcript copies per message id: distinct typed prompt records per session file.
  const typed = new Map<number, Map<string, Set<string>>>();
  const evidenced = new Set<number>();
  const idlessBodies = new Set<string>();
  for (const c of input.copies) {
    if (c.msg === null) {
      idlessBodies.add(c.body);
      continue;
    }
    evidenced.add(c.msg);
    if (c.mirror) continue;
    const files = typed.get(c.msg) ?? new Map<string, Set<string>>();
    files.set(c.file, (files.get(c.file) ?? new Set<string>()).add(c.recordId));
    typed.set(c.msg, files);
  }

  const report: AuditReport = {
    from: null,
    to: null,
    received: received.size,
    delivered: 0,
    notForDelivery: 0,
    duplicated: [],
    unconfirmed: [],
    undelivered: [],
    unverified: [],
    pending: [],
    suppressedDuplicates,
    updateGaps: [],
  };
  for (const m of [...received.values()].sort((a, b) => a.msg - b.msg)) {
    report.from = report.from === null ? m.date : Math.min(report.from, m.date);
    report.to = report.to === null ? m.date : Math.max(report.to, m.date);
    for (const [file, ids] of typed.get(m.msg) ?? []) {
      if (ids.size > 1) report.duplicated.push({ ...m, copies: ids.size, file });
    }
    const o = outcome.get(m.msg);
    // An id-less wrap proves the received message whose body it carries (`/agent <sel> <text>`
    // wraps only <text>).
    const body = AGENT_WITH_TEXT.test(m.text) ? m.text.trim().replace(/^\S+\s+\S+\s+/, '') : m.text.trim();
    if (o?.state === 'delivered' || evidenced.has(m.msg) || (m.text !== '' && idlessBodies.has(body))) {
      report.delivered += 1;
    } else if (o?.state === 'queued' && o.hold) {
      report.pending.push({ ...m, target: o.target, hold: o.hold });
    } else if (o?.state === 'failed') {
      report.undelivered.push({ ...m, target: o.target, reason: `failed, CTO notified: ${o.error ?? ''}` });
    } else if (o?.state === 'unsubmitted') {
      report.undelivered.push({ ...m, target: o.target, reason: 'typed into the pane but never submitted, CTO notified' });
    } else if (o?.state === 'uncertain') {
      report.undelivered.push({ ...m, target: o.target, reason: 'a daemon restart interrupted the delivery, CTO notified' });
    } else if (o?.state === 'claimed') {
      report.undelivered.push({ ...m, target: o.target, reason: 'delivery still in flight' });
    } else if (notWrapped(m.text)) {
      report.notForDelivery += 1;
    } else if (input.logAttempts.has(m.msg)) {
      report.unconfirmed.push(m);
    } else {
      report.unverified.push(m);
    }
  }

  // Updates Telegram assigned but this daemon never received (another consumer polled
  // the bot, or an offset skipped past them). Only ledger receipts carry update ids.
  const seen = [...updates].sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < seen.length; i++) {
    const [prevId, prevDate] = seen[i - 1];
    const [nextId, nextDate] = seen[i];
    if (nextId - prevId > 1 && inWindow(nextDate)) {
      report.updateGaps.push({ from: prevId + 1, to: nextId - 1, count: nextId - prevId - 1, afterDate: prevDate, beforeDate: nextDate });
    }
  }
  return report;
}

function fmtDate(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
}

export function formatAuditReport(r: AuditReport): string {
  const span = r.from === null || r.to === null ? 'no inbound messages' : `${fmtDate(r.from)} … ${fmtDate(r.to)} UTC`;
  const lines = [
    `Inbound delivery audit — ${span}`,
    `received ${r.received} · delivered ${r.delivered} · not delivered ${r.undelivered.length} · ` +
      `sent, transcript pruned ${r.unconfirmed.length} · no evidence left ${r.unverified.length} · ` +
      `duplicated ${r.duplicated.length} · pending ${r.pending.length} · commands/passthrough ${r.notForDelivery} · ` +
      `duplicates blocked ${r.suppressedDuplicates} · update-id gaps ${r.updateGaps.length}`,
  ];
  const section = (title: string, rows: string[]): void => {
    if (rows.length > 0) lines.push('', title, ...rows);
  };
  section(
    'Duplicated (one message injected more than once into one session):',
    r.duplicated.map((d) => `  tg#${d.msg}  ${fmtDate(d.date)}  ×${d.copies}  ${d.file}  «${preview(d.text)}»`),
  );
  section(
    'Not delivered (recorded by the delivery ledger; the CTO was told):',
    r.undelivered.map((u) => `  tg#${u.msg}  ${fmtDate(u.date)}  → ${u.target ?? '?'}  ${u.reason}  «${preview(u.text)}»`),
  );
  section(
    'Sent per the daemon log, no transcript left to confirm it:',
    r.unconfirmed.map((u) => `  tg#${u.msg}  ${fmtDate(u.date)}  → ${u.target ?? '?'}  «${preview(u.text)}»`),
  );
  section(
    'No evidence either way (no ledger record, transcript pruned or not scanned, no log line) — not a proven loss:',
    r.unverified.map((u) => `  tg#${u.msg}  ${fmtDate(u.date)}  → ${u.target ?? '?'}  «${preview(u.text)}»`),
  );
  section(
    'Pending (held for later delivery):',
    r.pending.map((p) => `  tg#${p.msg}  ${fmtDate(p.date)}  → ${p.target ?? '?'}  ${p.hold}  «${preview(p.text)}»`),
  );
  section(
    'Update-id gaps (updates this daemon never received):',
    r.updateGaps.map((g) => `  updates ${g.from}..${g.to} (${g.count})  between ${fmtDate(g.afterDate)} and ${fmtDate(g.beforeDate)} UTC`),
  );
  return `${lines.join('\n')}\n`;
}

export const AUDIT_USAGE = `Usage: tg-ctl audit-delivery [--since DATE] [--until DATE] [--json]
                            [--transcripts DIR]... [--history FILE]... [--log FILE]...
Report inbound Telegram messages that were not delivered, were delivered more than
once, or were never received (update-id gaps), with dates; a message with no ledger
record, no surviving transcript and no daemon log line is listed as "no evidence left",
not as a loss. Reads the history log, the delivery ledger, the daemon log and harness
transcripts; changes nothing.
  --since/--until DATE   bound by message date: 2026-09-01, 2026-09-01T10:00 (UTC), 7d, 24h
  --json                 machine-readable report
  --transcripts DIR      transcript root to scan instead of the defaults
                         (~/.omp/agent/sessions, ~/.claude/projects, ~/.codex/sessions)
  --history FILE         an extra history file (e.g. a legacy tg-ctl..history.jsonl)
  --log FILE             an extra daemon log (defaults: tg-ctl.<bot>.log, launchd.tg-ctl.err.log)
`;

export interface AuditOptions {
  json: boolean;
  since: number | null;
  until: number | null;
  transcripts: string[] | null; // null: the default harness roots
  history: string[];
  logs: string[];
}

export type AuditArgs = ({ kind: 'ok' } & AuditOptions) | { kind: 'help' } | { kind: 'error'; message: string };

const VALUE_FLAGS = ['--since', '--until', '--transcripts', '--history', '--log'];

export function parseAuditArgs(argv: string[], nowSec?: number): AuditArgs {
  const out: AuditOptions = { json: false, since: null, until: null, transcripts: null, history: [], logs: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '-h' || flag === '--help') return { kind: 'help' };
    if (flag === '--json') {
      out.json = true;
      continue;
    }
    if (!VALUE_FLAGS.includes(flag)) return { kind: 'error', message: `unknown argument: ${flag}` };
    const value = argv[i + 1];
    if (value === undefined) return { kind: 'error', message: `${flag} requires a value` };
    i += 1;
    if (flag === '--since' || flag === '--until') {
      const sec = parseDateArg(value, nowSec);
      if (sec === null) return { kind: 'error', message: `${flag}: cannot parse date: ${value}` };
      if (flag === '--since') out.since = sec;
      else out.until = sec;
    } else if (flag === '--transcripts') out.transcripts = [...(out.transcripts ?? []), value];
    else if (flag === '--history') out.history.push(value);
    else out.logs.push(value);
  }
  return { kind: 'ok', ...out };
}
