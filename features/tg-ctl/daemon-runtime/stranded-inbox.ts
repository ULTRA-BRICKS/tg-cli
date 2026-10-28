// daemon-runtime/stranded-inbox: extracted verbatim from tg-ctl (guardian-817 modular refactor).
import { writeStdoutLine } from "../../cli/stdout-line"
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs"
import { basename, dirname, join } from "path"
import { buildTextInjectPlan, wrapInbound } from "../inject"
import { ACKED_FILE, CLAIM_SWEEP_PREFIX, INBOX_DIR_MODE, INBOX_FILE_MODE, PENDING_FILE, STRANDED_PREFIX, inboxDirFor, inboxRoot, isDeliveredBatchFile, isStrandedFile, isSweepClaimFile, parseInboxLines, parseStrandedMarker, serializeInboxEntry, splitStrandedLines, strandedReportMarker, strandedReportText, type InboxEntry, type StrandedGroup } from "../inbox"
import { liveOmpForPane } from "../omp"
import { type OriginalOmpTarget } from "../omp-live-routing"
import { telegramFailureIsTransient } from "../../transport/telegram"
import { type ButtonRequest } from "../questions"
import { grantInboxKey, parseGrantStore } from "../grants"
import { atomicWrite, log, readFileOrNull, type Ctx } from "./ctx-io"
import { deliverOriginalOmp, executeInjectSteps } from "./delivery"
import { botPostResult, sendMessage } from "./telegram-api"
import { listLiveOmpAgents, refreshOriginalHosts } from "./session-registry"

// Entries in a key's pending.jsonl (0 when absent/unreadable).
export function pendingInboxCount(ctx: Ctx, key: string): number {
  const raw = readFileOrNull(join(inboxDirFor(ctx.configDir, key), PENDING_FILE))
  return raw ? parseInboxLines(raw).entries.length : 0
}

// The inbox holds the user's private Telegram text: directories 0700, files 0600 —
// enforced on every write, including paths that already existed with looser modes
// (review finding: a 022 umask would otherwise leave them world-readable).
export function tightenInboxModes(dir: string, file?: string): void {
  chmodSync(inboxRoot(dirname(dirname(dir))), INBOX_DIR_MODE)
  chmodSync(dir, INBOX_DIR_MODE)
  if (file && existsSync(file)) chmodSync(file, INBOX_FILE_MODE)
}

// Append ONE entry to an agent's pending inbox: mkdir -p + a single O_APPEND write of
// one complete line (never a torn record for the consuming Stop hook). Throws on IO
// failure. omp's grant-notice fallback is the only caller (tg-cli#456).
export function queueToInbox(ctx: Ctx, key: string, entry: InboxEntry): void {
  const dir = inboxDirFor(ctx.configDir, key)
  mkdirSync(dir, { recursive: true, mode: INBOX_DIR_MODE })
  const pending = join(dir, PENDING_FILE)
  appendFileSync(pending, serializeInboxEntry(entry), { mode: INBOX_FILE_MODE })
  tightenInboxModes(dir, pending)
}

// Deliver an operation-bound grant notice to its exact origin. A recorded pane uses its
// original route; OMP uses a verified session-bound socket and, when that is unavailable,
// the durable scoped inbox its Stop bridge consumes at the next yield — never a cwd/name
// guess or a spawn. Claude Code / Codex without a pane get nothing: they are tmux-only
// (tg-cli#456), and their inbox delivered only at a turn end an idle or exited session
// never reaches — every message stranded there was such a notice. The card then names
// the token path.
export async function routeGrantNotice(ctx: Ctx, req: ButtonRequest, text: string, deliveryId: string): Promise<boolean> {
  const ompOrigin = req.origin?.agent === "omp" || req.agent === "omp"
  if (req.paneId && !ompOrigin) return routeGrantNoticeToPane(ctx, req.paneId, req, text)
  if (!ompOrigin) {
    log(`grant-notice: ${req.agent} origin has no tmux pane — nothing queued (Claude Code/Codex are tmux-only)`)
    return false
  }
  await refreshOriginalHosts()
  const target = ompGrantNoticeTarget(req)
  // No exact session/pane identity: retain in scoped inbox, never guess by cwd.
  if (target) {
    const outcome = await deliverGrantNoticeToOmp(ctx, target, text, deliveryId, req)
    if (outcome !== "fallback") return outcome === "delivered"
  }
  return queueGrantNoticeToProjectInbox(ctx, req, text)
}

async function routeGrantNoticeToPane(ctx: Ctx, paneId: string, req: ButtonRequest, text: string): Promise<boolean> {
  try {
    const res = await executeInjectSteps(buildTextInjectPlan(paneId, wrapInbound(ctx.cfg.injectWrap, "tg", text), { sessionKey: req.sessionKey }))
    // Typed but still in its input box (#463): name the pane and text in the chat.
    if (!res.ok && res.unsubmitted) await sendMessage(ctx, res.error)
    return res.ok
  } catch (err) {
    log(`grant-notice pane route failed pane=${paneId}: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

// The exact omp session a grant notice belongs to: its recorded session id, else the live
// omp hosted by its recorded pane; null when neither identifies one.
function ompGrantNoticeTarget(req: ButtonRequest): OriginalOmpTarget | null {
  if (req.origin?.sessionId) return { cwd: req.cwd, sessionId: req.origin.sessionId }
  if (req.paneId) return liveOmpForPane(listLiveOmpAgents(), req.paneId) ?? null
  return null
}

// "delivered": the omp took it. "unsubmitted": typed into its pane but still unsent (#463) —
// reported in the chat, and not queued again. "fallback": the live route failed; use the inbox.
async function deliverGrantNoticeToOmp(ctx: Ctx, target: OriginalOmpTarget, text: string, deliveryId: string, req: ButtonRequest): Promise<"delivered" | "unsubmitted" | "fallback"> {
  const res = await deliverOriginalOmp(target, text, deliveryId, req.paneId)
  if (res.ok) return "delivered"
  // Typed into its pane but still unsubmitted (#463): report it and do not queue
  // it again — the card reports the notice undelivered and names the token path.
  if (res.unsubmitted) {
    await sendMessage(ctx, res.error)
    return "unsubmitted"
  }
  log(`grant-notice omp route failed (falling back to inbox) session=${target.sessionId ?? "-"}: ${res.error}`)
  return "fallback"
}

function queueGrantNoticeToProjectInbox(ctx: Ctx, req: ButtonRequest, text: string): boolean {
  // The requester's own project inbox (grants.ts grantInboxKey): never a subagent-name
  // inbox another project escalating under the same name would share (tg-cli#433).
  const inboxKey = grantInboxKey(req)
  if (!inboxKey) {
    log(`grant-notice: omp origin has no cwd — no project inbox to queue to session=${req.origin?.sessionId ?? "-"}`)
    return false
  }
  try {
    queueToInbox(ctx, inboxKey, {
      id: null,
      ts: new Date().toISOString(),
      from: "tg",
      text,
      wrapped: text,
    })
    return true
  } catch (err) {
    log(`grant-notice inbox route failed key-cwd=${req.cwd ?? "-"}: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

export function listInboxKeys(ctx: Ctx): string[] {
  try {
    return readdirSync(inboxRoot(ctx.configDir), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}

// Archive what the omp Stop bridge delivered. The hook publishes each consumption as ONE
// complete `delivered-<pid>-<ts>.jsonl` (temp + rename), so a file we see is whole and no
// in-flight hook write can be lost to our unlink: append it to acked.jsonl, unlink.
// Never throws into the poll loop.
export function archiveDeliveredInboxes(ctx: Ctx): void {
  for (const key of listInboxKeys(ctx)) {
    const dir = inboxDirFor(ctx.configDir, key)
    try {
      for (const name of readdirSync(dir)) {
        if (isDeliveredBatchFile(name)) archiveDeliveredBatch(key, dir, join(dir, name))
      }
    } catch (err) {
      log(`inbox ${key}: delivered-batch sweep failed: ${err}`)
    }
  }
}

// One published batch: logged, appended whole to acked.jsonl, then removed.
function archiveDeliveredBatch(key: string, dir: string, path: string): void {
  const raw = readFileOrNull(path) ?? ""
  const parsed = parseInboxLines(raw)
  if (parsed.entries.length > 0 || parsed.malformed > 0) {
    log(`inbox ${key}: ${parsed.entries.length} delivered by the Stop hook (${parsed.malformed} malformed) — archived`)
  }
  if (raw) appendFileSync(join(dir, ACKED_FILE), raw.endsWith("\n") ? raw : `${raw}\n`, { mode: INBOX_FILE_MODE })
  unlinkSync(path)
}

// Every archived stranded-*.jsonl, per inbox key (read-only).
export function strandedInboxGroups(ctx: Ctx): StrandedGroup[] {
  const groups: StrandedGroup[] = []
  for (const key of listInboxKeys(ctx)) {
    const dir = inboxDirFor(ctx.configDir, key)
    let names: string[]
    try {
      names = readdirSync(dir).filter(isStrandedFile).sort()
    } catch (err) {
      log(`inbox ${key}: cannot list stranded files: ${err}`)
      continue
    }
    for (const name of names) {
      const { entries, malformed } = parseInboxLines(readFileOrNull(join(dir, name)) ?? "")
      groups.push({ key, file: `${key}/${name}`, entries, malformed })
    }
  }
  return groups
}

// One-time retirement of the cc/codex Stop-hook inbox (tg-cli#456). Until the marker
// says `complete`: claim every pending.jsonl (rename — the same atomic claim the Stop
// hook uses, so a racing hook either got it first or finds none), split it, archive what
// the retired channel stranded as stranded-<stamp>.jsonl and append omp's still-live
// grant notices back to pending.jsonl for the omp hook (an omp fallback queued by the
// previous daemon or during a failed-send retry is never swallowed). The stranded entries
// are listed ONCE to the CTO through the daemon's own reply path, then the marker is
// written (a kill between the send and the marker write lists them again at the next
// start: a duplicate, never a loss). A transient send failure (network, 429, 5xx) keeps
// the built report and the next poll retries ONLY the send: re-sweeping would churn
// omp's pending.jsonl and could archive (and report) an omp notice queued since — or one
// whose grant expired in between — as stranded. Telegram rejecting the report outright
// (4xx) is final: retrying would fail forever, so it is logged and the archive stands
// (`tg-ctl inbox` counts it). The sweep is synchronous, so no routeGrantNotice append
// interleaves.
export let strandedReportDone = false

export let strandedReportUnsent: StrandedSweep | null = null

export async function reportStrandedInbox(ctx: Ctx): Promise<void> {
  if (strandedReportDone) return
  const marker = strandedReportMarker(ctx.configDir)
  const prior = parseStrandedMarker(readFileOrNull(marker))
  if (prior?.complete) {
    strandedReportDone = true
    return
  }
  if (strandedReportUnsent === null) strandedReportUnsent = sweepStrandedInbox(ctx, new Set(prior?.reported ?? []))
  const { text, count, complete, files } = strandedReportUnsent
  if (text !== null) {
    const sent = await botPostResult(ctx, "sendMessage", { chat_id: ctx.chatId, text })
    if (telegramFailureIsTransient(sent)) {
      log("inbox: the stranded-message report did not send — retrying the send next poll")
      return
    }
    if (!sent.ok) {
      log(`inbox: Telegram rejected the stranded-message report (${sent.status ?? "ok:false"} ${sent.description}) — not retrying; the archive keeps every message`)
    } else if (count > 0) {
      log(`inbox: ${count} stranded cc/codex message(s) reported once, archived as ${STRANDED_PREFIX}*.jsonl (tg-cli#456)`)
    }
  }
  strandedReportDone = true
  strandedReportUnsent = null
  // A key whose claim could not be archived keeps its claim-sweep-*.jsonl; an incomplete
  // marker makes the next daemon start sweep it again — so those messages are never
  // lost — and report only the archives this one did not already send.
  const reported = [...new Set([...(prior?.reported ?? []), ...files])]
  try {
    atomicWrite(marker, `${JSON.stringify({ reportedAt: new Date().toISOString(), messages: count, complete, reported })}\n`)
  } catch (err) {
    log(`inbox: could not write ${marker} (a restart would report the stranded messages again): ${err}`)
  }
  if (!complete) log("inbox: some pending.jsonl could not be archived — the next start retries the sweep")
}

// Claim, split and archive every pending.jsonl — and any claim-sweep-*.jsonl an earlier
// sweep left behind (crash or failed archive) — once; returns the report over every
// stranded-*.jsonl not in `reported` (this sweep's and any earlier daemon's unreported
// ones), the archives it lists, and whether every claim was archived.
export type StrandedSweep = { text: string | null; count: number; complete: boolean; files: string[] }

export function sweepStrandedInbox(ctx: Ctx, reported: ReadonlySet<string>): StrandedSweep {
  const liveOmpApprovals = liveOmpGrantApprovals(ctx)
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  let complete = true
  for (const key of listInboxKeys(ctx)) {
    if (!sweepInboxKey(ctx, key, stamp, liveOmpApprovals)) complete = false
  }
  const groups = strandedInboxGroups(ctx).filter((g) => !reported.has(g.file))
  return {
    text: strandedReportText(groups, inboxRoot(ctx.configDir)),
    count: groups.reduce((n, g) => n + g.entries.length, 0),
    complete,
    files: groups.map((g) => g.file),
  }
}

// approval id → request id of every unconsumed grant that belongs to an omp.
function liveOmpGrantApprovals(ctx: Ctx): Map<string, string> {
  // An omp grant: its origin says omp, it routes to an omp session, or — an omp ask with
  // no origin block (routeGrantNotice also treats `agent: "omp"` as omp) — its grace
  // record's original request came from omp.
  const store = parseGrantStore(readFileOrNull(ctx.paths.grants), Date.now())
  const ompGraceRequests = new Set(store.grace.filter((r) => r.req.agent === "omp").map((r) => r.requestId))
  return new Map(
    store.grants
      .filter((g) => g.consumed_at === null && (g.origin?.agent === "omp" || g.route?.startsWith("acp:") || ompGraceRequests.has(g.request_id)))
      .map((g) => [g.approval_id, g.request_id] as const),
  )
}

// Sweep one inbox key; false when a claim could not be taken or archived (the sweep is then incomplete).
function sweepInboxKey(ctx: Ctx, key: string, stamp: string, liveOmpApprovals: ReadonlyMap<string, string>): boolean {
  const dir = inboxDirFor(ctx.configDir, key)
  let claims: string[]
  try {
    claims = claimInboxFiles(dir, stamp)
  } catch (err) {
    log(`inbox ${key}: could not claim the stranded pending.jsonl: ${err}`)
    return false
  }
  let complete = true
  // Replaying a claim after a crash must not duplicate: its archive is named after the
  // claim and rewritten whole, and a kept omp line already back in pending.jsonl is skipped.
  for (const claim of claims) {
    try {
      archiveSweepClaim(dir, claim, liveOmpApprovals)
    } catch (err) {
      log(`inbox ${key}: could not archive ${claim} (left in place; the next start retries it): ${err}`)
      complete = false
    }
  }
  return complete
}

// The claim files to archive for one key: those an earlier sweep left behind, plus
// pending.jsonl renamed into a new claim.
function claimInboxFiles(dir: string, stamp: string): string[] {
  const pending = join(dir, PENDING_FILE)
  const claims = readdirSync(dir).filter(isSweepClaimFile).sort().map((n) => join(dir, n))
  if (!existsSync(pending)) return claims
  const claim = join(dir, `${CLAIM_SWEEP_PREFIX}${process.pid}-${stamp}.jsonl`)
  try {
    renameSync(pending, claim)
    claims.push(claim)
  } catch (err) {
    // The omp Stop hook claimed it between the check and the rename: it consumes
    // that file itself, so nothing is left to archive — not a failed sweep.
    if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err
  }
  return claims
}

// Split one claim: stranded lines go to its stranded-<stamp> archive, still-live omp
// grant notices back to pending.jsonl, then the claim is removed.
function archiveSweepClaim(dir: string, claim: string, liveOmpApprovals: ReadonlyMap<string, string>): void {
  const pending = join(dir, PENDING_FILE)
  const { keep, stranded } = splitStrandedLines(readFileSync(claim, "utf8"), liveOmpApprovals)
  const archive = join(dir, `${STRANDED_PREFIX}${basename(claim).slice(CLAIM_SWEEP_PREFIX.length)}`)
  if (stranded.length > 0) writeFileSync(archive, `${stranded.join("\n")}\n`, { mode: INBOX_FILE_MODE })
  const pendingLines = new Set((readFileOrNull(pending) ?? "").split("\n"))
  const fresh = keep.filter((l) => !pendingLines.has(l))
  if (fresh.length > 0) appendFileSync(pending, `${fresh.join("\n")}\n`, { mode: INBOX_FILE_MODE })
  unlinkSync(claim)
}

// `tg-ctl inbox` — what the Stop-hook inbox still holds: omp's grant-notice fallback
// (pending, delivered at that omp's next yield) and the archived cc/codex backlog.
// Read-only: Claude Code and Codex are tmux-only, nothing can be queued (tg-cli#456).
export function runInboxCommand(ctx: Ctx, argv: string[]): number {
  if (argv.length > 0) {
    console.error("usage: tg-ctl inbox   (`inbox queue` is gone: Claude Code and Codex are tmux-only, tg-cli#456)")
    return 1
  }
  // Until the daemon's one-time sweep has run (first poll after the upgrade, or a daemon
  // that is down), pending.jsonl may still hold the retired cc/codex backlog.
  const swept = parseStrandedMarker(readFileOrNull(strandedReportMarker(ctx.configDir)))?.complete === true
  const what = swept ? "omp grant notice, delivered at that omp's next yield" : "not swept yet: the daemon reports any cc/codex backlog here when it next starts"
  const lines: string[] = []
  for (const key of listInboxKeys(ctx)) {
    const n = pendingInboxCount(ctx, key)
    if (n > 0) lines.push(`  - ${key}: ${n} pending (${what})`)
  }
  const archived = strandedInboxGroups(ctx).reduce((n, g) => n + g.entries.length, 0)
  if (archived > 0) lines.push(`  archived: ${archived} stranded cc/codex message(s) in ${inboxRoot(ctx.configDir)}/*/${STRANDED_PREFIX}*.jsonl`)
  writeStdoutLine(lines.length > 0 ? lines.join("\n") : "inbox: nothing pending")
  return 0
}
