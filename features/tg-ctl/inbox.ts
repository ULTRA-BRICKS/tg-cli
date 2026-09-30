// The per-agent Stop-hook inbox on disk (tg-cli#306, tg-cli#456) — PURE: paths, the
// entry shape, serialization, the fail-soft parser and the one-time stranded report.
// The tg-ctl entrypoint owns the I/O (mkdir/append/rename), the agent-tools omp Stop
// bridge owns the CONSUMING side.
//
// Claude Code and Codex are tmux-only (tg-cli#456): the daemon never queues for them
// any more — the Stop hook delivered only at their next turn end, so an idle session
// never got the message. The one writer left is omp's grant-notice fallback (an omp
// whose omp-live endpoint is unreachable), consumed at that omp's next yield. What the
// retired cc/codex channel left behind is claimed ONCE (pending.jsonl →
// stranded-<stamp>.jsonl), listed to the CTO and kept as the archive.
//
// Layout (see unreachable.ts for the key contract shared with agent-tools):
//   <configDir>/inbox/<key>/pending.jsonl            daemon appends; hook claims + consumes
//   <configDir>/inbox/<key>/delivered-<pid>-<ts>.jsonl  ONE file per hook consumption,
//                                                    written whole (temp + rename)
//   <configDir>/inbox/<key>/acked.jsonl              daemon archives delivered batches
//   <configDir>/inbox/<key>/stranded-<stamp>.jsonl   the retired cc/codex backlog
//   <configDir>/inbox-stranded-report.json           marker: that backlog was reported
// pending.jsonl is append-only JSONL: the daemon appends ONE complete line per write
// call so a concurrent reader never sees a torn record, and the hook CLAIMS it by
// renaming (atomic on POSIX) before reading, so append-after-claim lands in a fresh
// file. The hook → daemon direction deliberately has NO shared append target: a
// shared `delivered.jsonl` the daemon claimed by rename could be renamed + unlinked
// between the hook's open() and write() and the record would land on a dead inode
// (review finding). A complete per-run file that appears atomically cannot be torn
// or lost. Directories are 0700 and files 0600 — the content is the user's private
// Telegram text.

import { join } from 'path';

export interface InboxEntry {
  id: number | null; // Telegram message_id of the queued message; null if synthetic (omp grant notices)
  ts: string; // ISO-8601 UTC, when the daemon queued it
  from: string; // sender display name (the `{name}` of the inject wrap)
  text: string; // raw message text
  wrapped: string; // the exact text the agent should receive (inject-wrap applied)
}

export interface DeliveredEntry extends InboxEntry {
  delivered_ts?: string;
  session_id?: string;
  malformed?: boolean;
}

export const INBOX_DIRNAME = 'inbox';
export const PENDING_FILE = 'pending.jsonl';
export const DELIVERED_PREFIX = 'delivered-';
export const ACKED_FILE = 'acked.jsonl';
export const INBOX_DIR_MODE = 0o700;
export const INBOX_FILE_MODE = 0o600;

// A complete delivered batch the hook published (`delivered-<pid>-<ts>.jsonl`); its
// temp file (`.tmp` suffix) is still being written and must be left alone.
export function isDeliveredBatchFile(name: string): boolean {
  return name.startsWith(DELIVERED_PREFIX) && name.endsWith('.jsonl');
}

export function inboxRoot(configDir: string): string {
  return join(configDir, INBOX_DIRNAME);
}

export function inboxDirFor(configDir: string, key: string): string {
  return join(inboxRoot(configDir), key);
}

// One line, newline-terminated, never containing a raw newline (JSON escapes them).
export function serializeInboxEntry(entry: InboxEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

// Parse JSONL leniently: a malformed line is reported (not thrown) so one bad record
// never hides the good ones behind it. Only objects carrying a string `wrapped` count
// as entries; anything else is `malformed`.
export function parseInboxLines(text: string): { entries: DeliveredEntry[]; malformed: number } {
  const entries: DeliveredEntry[] = [];
  let malformed = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as unknown;
      if (obj && typeof obj === 'object' && typeof (obj as { wrapped?: unknown }).wrapped === 'string') {
        entries.push(obj as DeliveredEntry);
      } else {
        malformed++;
      }
    } catch {
      malformed++;
    }
  }
  return { entries, malformed };
}

export const STRANDED_PREFIX = 'stranded-';

export function isStrandedFile(name: string): boolean {
  return name.startsWith(STRANDED_PREFIX) && name.endsWith('.jsonl');
}

// The daemon's one-time stranded sweep renames pending.jsonl to this before archiving it;
// one left behind (crash or failed archive) is re-swept on the next start.
export const CLAIM_SWEEP_PREFIX = 'claim-sweep-';

export function isSweepClaimFile(name: string): boolean {
  return name.startsWith(CLAIM_SWEEP_PREFIX) && name.endsWith('.jsonl');
}

// A grant notice names its request and approval (grants.ts hatchGrantNoticeText:
// "Your earlier hatch request <requestId> (…) … Approval ID: hgr-….").
const GRANT_NOTICE_RE = /^Your earlier hatch request (\S+) \(.*? Approval ID: (hgr-[0-9a-f]{12})\. /s;

// Split a claimed pending.jsonl into what stays for the omp Stop bridge and what the
// retired cc/codex channel stranded. Only omp's own fallback is kept — a line the daemon
// itself queued (routeGrantNotice: no Telegram id, from "tg", unwrapped) whose notice
// names a still-live omp grant by BOTH its approval and request id
// (`liveOmpApprovals`: approvalId → requestId). User-authored text quoting an approval
// id (`/agent`, `inbox queue`) never matches. Everything else — cc/codex grant notices,
// `/agent` text, malformed lines — is stranded. Lines are returned byte-for-byte,
// without their newline.
export function splitStrandedLines(raw: string, liveOmpApprovals: ReadonlyMap<string, string>): { keep: string[]; stranded: string[] } {
  const keep: string[] = [];
  const stranded: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const entry = parseInboxLines(line).entries[0];
    const daemonNotice = entry !== undefined && entry.id === null && entry.from === 'tg' && entry.text === entry.wrapped;
    const m = daemonNotice ? GRANT_NOTICE_RE.exec(String(entry.text)) : null;
    (m !== null && liveOmpApprovals.get(m[2]) === m[1] ? keep : stranded).push(line);
  }
  return { keep, stranded };
}

// In the config dir, NOT under inbox/: once it exists the one-time sweep never runs
// again, so a later pending.jsonl (omp's grant-notice fallback) stays for the omp hook.
export function strandedReportMarker(configDir: string): string {
  return join(configDir, 'inbox-stranded-report.json');
}

// One archived file's worth of stranded entries, under the inbox key it was queued to.
export interface StrandedGroup {
  key: string;
  entries: InboxEntry[];
}

const TELEGRAM_TEXT_LIMIT = 4096;
const PREVIEW_CHARS = 120;
const MORE_LINE_RESERVE = 40; // room for the "… and N more" tail

// The ONE plain-text message listing the retired channel's backlog to the CTO: a header
// (count, oldest, where the archive is), then one line per message, oldest first — its
// UTC minute, inbox key and a tag-stripped one-line preview. Fits one Telegram message;
// what does not fit is counted in a final "… and N more" line. null when nothing is
// stranded (no message at all).
export function strandedReportText(groups: StrandedGroup[], archiveRoot: string): string | null {
  const rows = groups
    .flatMap((g) => g.entries.map((e) => ({ key: g.key, ts: String(e.ts ?? ''), text: String(e.text ?? e.wrapped) })))
    .sort((a, b) => a.ts.localeCompare(b.ts));
  if (rows.length === 0) return null;
  const minute = (ts: string): string => ts.slice(0, 16).replace('T', ' ') || 'unknown time';
  const lines = [
    `📭 Claude Code and Codex are tmux-only now (tg-cli#456), so the Stop-hook inbox no longer delivers to them. ` +
      `${rows.length} message(s) queued there never reached their agent (oldest ${minute(rows[0].ts)} UTC) — ` +
      `listed once here, archived as stranded-*.jsonl under ${archiveRoot}:`,
  ];
  let length = lines[0].length;
  for (const [i, row] of rows.entries()) {
    // Cosmetic only: tags are dropped to keep the preview readable, not to sanitize.
    // The report goes out through sendMessage WITHOUT parse_mode, so Telegram shows
    // any leftover `<script` literally — there is no HTML context to inject into.
    // codeql[js/incomplete-multi-character-sanitization]
    const plain = row.text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    const preview = plain.length > PREVIEW_CHARS ? `${plain.slice(0, PREVIEW_CHARS - 1)}…` : plain;
    const line = `• ${minute(row.ts)} ${row.key} — ${preview}`;
    if (length + 1 + line.length + 1 + MORE_LINE_RESERVE > TELEGRAM_TEXT_LIMIT) {
      lines.push(`… and ${rows.length - i} more in the archive`);
      break;
    }
    lines.push(line);
    length += 1 + line.length;
  }
  return lines.join('\n');
}
