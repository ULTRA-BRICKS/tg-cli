// Late-approval grant protocol v1.1 (tg-cli#398) — PURE store + decisions.
//
// When a hatch ask (a headless RIG_HATCH_REQUEST_<HOOK_ID> permission, see
// questions.ts's parseHatchHookId) EXPIRES unanswered, the daemon keeps a
// GRACE record for 24h so a late Approve tap on the stale card is still
// addressable. A late Approve mints a single-use GRANT (hgr-<12hex>, 24h TTL,
// bound to hook_id + operation fingerprint + cwd + the daemon-observed route
// identity) and routes the consume instructions to the request's origin. The
// agent-tools lib then consumes the grant via `tg-ctl ask --verify-grant`
// (TOKEN path: explicit approval id, route-agnostic) or `--verify-grant --pull`
// (PULL path: no id — for hooks with no env channel, matched by hook_id +
// operation + ROUTE EQUALITY; NO blank-route fallback, or any agent in the repo
// could consume a grant addressed to a specific subagent).
//
// This module owns only data and decisions. The tg-ctl entrypoint owns ALL
// I/O: the 0600 atomic file write (FAIL-CLOSED on mint AND consume — a grant
// that isn't durable is never confirmed/allowed, or a restart would permit
// replay), the routing sends, and the Telegram card edits.
//
// The on-disk GRANT record uses the contract's exact snake_case field names
// (approval_id/request_id/hook_id/approved_at/expires_at/consumed_at) — the
// file IS the cross-repo contract surface, so the interface mirrors it
// verbatim instead of camelCasing and remapping at the boundary.

import { agentInboxKey } from './unreachable';
import { hatchEnvVarName, type AskOperation, type AskOrigin, type ButtonRequest } from './questions';
import { isRecord } from './guards';
import { truncateWithEllipsis } from './text-util';

// hgr- + 12 lowercase hex (crypto.randomBytes(6) in the entrypoint).
export const GRANT_ID_RE = /^hgr-[0-9a-f]{12}$/;

// An expired hatch ask kept addressable for late taps. `req` is the FULL
// original request (re-normalized through tg-ctl's authoritative validator on
// restore) so a late tap can be re-validated and its grant notice routed
// without any other state. `route` is the DAEMON-OBSERVED stable route
// identity (routeForRequest) — computed from the ask's routing fields, never
// a client-payload field.
export interface GraceRecord {
  key: string; // callbackRequestId of the original ask — the tap's lookup key
  requestId: string;
  hookId: string;
  req: ButtonRequest;
  route: string | null;
  messageId: number | null; // the expired card, for tap-guard + confirmation edit
  expiredAt: number;
  graceExpiresAt: number; // expiredAt + grace window (default 24h)
}

// Contract §4, verbatim field names. `route` binds the PULL consume path
// (route equality required); the TOKEN path (explicit approval_id) is
// route-agnostic because the agent was told the id out-of-band.
export interface GrantRecord {
  approval_id: string;
  request_id: string;
  hook_id: string;
  origin?: AskOrigin;
  operation?: AskOperation; // OPAQUE — computed by the agent-tools lib
  route: string | null;
  approved_at: number;
  expires_at: number;
  consumed_at: number | null;
}

// A hatch card a human DECIDED (a late Deny, or any live answer on a hatch ask): durable
// proof the card is closed. The questions store is best-effort, so a lost write can leave
// the decided card retained on disk; the restore skips any card with this record instead
// of granting it a fresh grace record, which would let a later Approve tap or "да" reply
// undo the decision (tg-cli#433: a Deny must be final). Kept until the latest grace window
// a stale copy of the card could still open has closed (the caller's retention, tg-ctl's
// DECIDED_RETAIN_MS): past it, a restored card could not mint anyway. A critical ask waits
// without limit, so a stale copy of its card would get a fresh window from ANY later
// restart: its record has no expiry (`expiresAt: null`) and is kept for as long as a copy
// of the card is on disk (dropSettledDecided).
export interface DecidedCard {
  key: string; // callbackRequestId of the ask, as on its GraceRecord
  decision: 'allow' | 'deny';
  decidedAt: number;
  expiresAt: number | null;
}

export interface GrantStoreData {
  grace: GraceRecord[];
  grants: GrantRecord[];
  decided: DecidedCard[];
}

// The daemon-observed stable route identity for an ask — the SAME identity the
// daemon uses to deliver decisions/late-approval messages: the tmux pane when
// there is one, the ACP session id when the origin is a live omp session, else
// the Stop-hook inbox key (THE shared contract with agent-tools' inbox reader,
// unreachable.ts). Deterministic from the ask's routing fields ONLY (never
// probed from live process state), so the identity a grant was minted with is
// reproducible byte-for-byte from a later pull query's payload. null when no
// stable identity exists at all (no pane, no sessionId, no subagent name AND
// no cwd) — pull consume then DENIES and names the token path.
export function routeForRequest(
  req: Pick<ButtonRequest, 'paneId' | 'cwd' | 'subagent' | 'origin'>,
): string | null {
  if (req.paneId) return `pane:${req.paneId}`;
  if (req.origin?.agent === 'omp' && typeof req.origin.sessionId === 'string' && req.origin.sessionId) {
    return `acp:${req.origin.sessionId}`;
  }
  const subagent = req.origin?.subagent ?? req.subagent;
  if ((typeof subagent === 'string' && subagent) || (typeof req.cwd === 'string' && req.cwd)) {
    return `inbox:${agentInboxKey(subagent ?? null, req.cwd ?? '/')}`;
  }
  return null;
}

// The grant↔operation binding, fail-closed: fingerprint AND cwd must be
// present and equal on both sides (a missing field is a mismatch, never a
// wildcard); repoRoot is compared only when BOTH sides carry it (contract §5).
export function operationMatches(a: AskOperation | undefined, b: AskOperation | undefined): boolean {
  if (!a || !b) return false;
  if (typeof a.fingerprint !== 'string' || typeof b.fingerprint !== 'string' || a.fingerprint !== b.fingerprint) return false;
  if (typeof a.cwd !== 'string' || typeof b.cwd !== 'string' || a.cwd !== b.cwd) return false;
  if (typeof a.repoRoot === 'string' && typeof b.repoRoot === 'string' && a.repoRoot !== b.repoRoot) return false;
  return true;
}

export type GrantDenyReason =
  | 'unknown-approval'
  | 'already-consumed'
  | 'expired'
  | 'hook-mismatch'
  | 'operation-mismatch'
  | 'no-grant'
  | 'no-route'
  | 'route-mismatch';

export type VerifyGrantOutcome =
  | { kind: 'allow'; grant: GrantRecord }
  | { kind: 'deny'; reason: GrantDenyReason };

// TOKEN path (contract §5): validate the explicit approval id. Route-agnostic
// — the agent was told the id out-of-band. PURE: consumption (consumed_at +
// the fail-closed persist) is the CALLER's job, only on 'allow' — a mismatch
// (e.g. a typo'd fingerprint) must NOT burn the grant.
export function verifyGrant(
  grants: GrantRecord[],
  approvalId: string,
  hookId: string,
  operation: AskOperation | undefined,
  now: number,
): VerifyGrantOutcome {
  const grant = grants.find((g) => g.approval_id === approvalId);
  if (!grant) return { kind: 'deny', reason: 'unknown-approval' };
  if (grant.consumed_at !== null) return { kind: 'deny', reason: 'already-consumed' };
  if (now >= grant.expires_at) return { kind: 'deny', reason: 'expired' };
  if (grant.hook_id !== hookId) return { kind: 'deny', reason: 'hook-mismatch' };
  if (!operationMatches(grant.operation, operation)) return { kind: 'deny', reason: 'operation-mismatch' };
  return { kind: 'allow', grant };
}

export type PullGrantOutcome = { kind: 'allow'; grant: GrantRecord } | { kind: 'deny'; reason: GrantDenyReason };

// PULL path (contract, route-bound): a plain identical retry from a hook with
// NO env channel presents no approval id — find the outstanding grant by
// hook_id + operation and require ROUTE EQUALITY between the grant's
// daemon-observed route and the route computed the same way from this query's
// payload. When EITHER side lacks a stable route identity the pull DENIES
// with 'no-route' (the denial text names the token path — pullDenyReasonText).
// Deterministic deny-reason precedence so a deny never depends on scan order
// beyond the grant list itself.
export function pullGrant(
  grants: GrantRecord[],
  hookId: string,
  operation: AskOperation | undefined,
  route: string | null,
  now: number,
): PullGrantOutcome {
  const forHook = grants.filter((g) => g.hook_id === hookId);
  if (forHook.length === 0) return { kind: 'deny', reason: 'no-grant' };
  let sawOperationMismatch = false;
  let sawConsumed = false;
  let sawExpired = false;
  let sawNoRoute = false;
  let sawRouteMismatch = false;
  for (const grant of forHook) {
    if (!operationMatches(grant.operation, operation)) {
      sawOperationMismatch = true;
      continue;
    }
    if (grant.consumed_at !== null) {
      sawConsumed = true;
      continue;
    }
    if (now >= grant.expires_at) {
      sawExpired = true;
      continue;
    }
    if (grant.route === null || route === null) {
      sawNoRoute = true;
      continue;
    }
    if (grant.route !== route) {
      sawRouteMismatch = true;
      continue;
    }
    return { kind: 'allow', grant };
  }
  if (sawNoRoute) return { kind: 'deny', reason: 'no-route' };
  if (sawRouteMismatch) return { kind: 'deny', reason: 'route-mismatch' };
  if (sawConsumed) return { kind: 'deny', reason: 'already-consumed' };
  if (sawExpired) return { kind: 'deny', reason: 'expired' };
  if (sawOperationMismatch) return { kind: 'deny', reason: 'operation-mismatch' };
  return { kind: 'deny', reason: 'no-grant' };
}

// Human/model-readable deny reasons for the hook reply's decision.message and
// the client's stderr. The 'no-route' text NAMES the token path (contract:
// when auto-pull can't bind a route, the caller must be told the env-var form
// remains available). It deliberately does NOT disclose any approval id — the
// id reaches the agent through the routed grant notice, not through a deny.
export function grantDenyReasonText(reason: VerifyGrantOutcome extends { kind: 'deny' } ? never : string, hookId: string): string {
  switch (reason) {
    case 'unknown-approval':
      return 'unknown or malformed approval id — no such grant exists';
    case 'already-consumed':
      return 'grant already consumed — grants are single-use; re-request if still needed';
    case 'expired':
      return 'grant expired (24h TTL) — re-request a fresh approval';
    case 'hook-mismatch':
      return 'grant is bound to a different hook_id';
    case 'operation-mismatch':
      return 'grant is bound to a different command/directory (operation fingerprint or cwd mismatch) — NOT consumed; fix the retry to match the original operation exactly';
    case 'no-grant':
      return 'no outstanding grant for this hook_id';
    case 'no-route':
      return `auto-pull unavailable: no stable route identity on one side, so the grant cannot be bound to this caller — consume via the token path instead: retry with ${hatchEnvVarName(hookId)}="approved:<approval_id>" (single-use, operation-bound)`;
    case 'route-mismatch':
      return 'grant is bound to a different agent route — consume via the token path from the agent the grant notice was routed to';
    default:
      return 'grant verification failed';
  }
}

// Routed notices quote the ask's question as ONE line (the notice travels through inbox
// JSONL / ACP prompts / pane text where embedded newlines would fragment it), clamped so a
// novel-length prompt can't swamp the instructions — cut surrogate-safely (text-util.ts).
const NOTICE_QUESTION_MAX = 120;

// The contract's routed late-approval message (final wording).
export function hatchGrantNoticeText(args: {
  requestId: string;
  question: string;
  hookId: string;
  approvalId: string;
  approvedAt: number;
  expiresAt: number;
}): string {
  const short = truncateWithEllipsis(args.question.split('\n', 1)[0].trim(), NOTICE_QUESTION_MAX);
  const approvedTs = new Date(args.approvedAt).toISOString();
  const expiresTs = new Date(args.expiresAt).toISOString();
  const envVar = hatchEnvVarName(args.hookId);
  return (
    `Your earlier hatch request ${args.requestId} (${short}) was APPROVED belatedly by the user at ${approvedTs}. ` +
    `Approval ID: ${args.approvalId}. ` +
    `To consume: for a pre-bash hook, retry the SAME blocked operation ONCE, in the SAME directory, with ${envVar}="approved:${args.approvalId}" (inline prefix; exported var where the harness permits). ` +
    `For a pre-write hook (or any hook): simply retry the identical operation in the same directory — the grant is consumed automatically (pull). ` +
    `Do this ONLY if you have not already achieved the same goal another way. ` +
    `Grant is single-use, bound to the original command+directory, and expires ${expiresTs}.`
  );
}

// The routed message for a belated Deny (tg-cli#403 (d): the requester is told the outcome
// proactively — a deny as well as an approve — instead of waiting on a card nobody will
// approve). Same one-line shape and routing as the grant notice. When the Deny revokes a
// grant an earlier Approve minted, it says so: the agent may already hold that id.
export function hatchDenyNoticeText(args: {
  requestId: string;
  question: string;
  deniedAt: number;
  revokedApprovalId: string | null;
}): string {
  const short = truncateWithEllipsis(args.question.split('\n', 1)[0].trim(), NOTICE_QUESTION_MAX);
  const revoked = args.revokedApprovalId
    ? `The earlier approval ${args.revokedApprovalId} is REVOKED and can no longer be consumed. `
    : '';
  return (
    `Your earlier hatch request ${args.requestId} (${short}) was DENIED by the user at ${new Date(args.deniedAt).toISOString()}. ` +
    revoked +
    `Do NOT retry it or work around the gate that raised it; if the need is still real, ask the user directly.`
  );
}

export function buildGraceRecord(
  req: ButtonRequest,
  key: string,
  hookId: string,
  route: string | null,
  messageId: number | null,
  expiredAt: number,
  graceMs: number,
): GraceRecord {
  return { key, requestId: req.requestId, hookId, req, route, messageId, expiredAt, graceExpiresAt: expiredAt + graceMs };
}

// Re-retire (timer AND socket close can both retire the same entry; a restore
// can re-see it) must never duplicate: same callback key replaces.
export function upsertGraceRecord(grace: GraceRecord[], rec: GraceRecord): void {
  const i = grace.findIndex((g) => g.key === rec.key);
  if (i >= 0) grace[i] = rec;
  else grace.push(rec);
}

// A decision that closes the card — a late Deny, a live answer on a hatch ask — retires
// its grace record, so no later tap or text reply on the same card can mint a grant, and
// records the card as decided (see DecidedCard), so no restart re-opens it (tg-cli#433: a
// Deny must be final). `retainMs` null keeps the record while a copy of the card is on
// disk (a critical ask, see DecidedCard). Returns the undo for a caller whose durable write
// fails: it puts the grace record back and restores the previous decided record, or
// removes the new one.
export function closeDecidedCard(
  data: GrantStoreData,
  key: string,
  decision: DecidedCard['decision'],
  now: number,
  retainMs: number | null,
): () => void {
  const retired = retireGraceRecord(data.grace, key);
  const i = data.decided.findIndex((d) => d.key === key);
  const prior = i >= 0 ? data.decided[i] : null;
  const rec: DecidedCard = { key, decision, decidedAt: now, expiresAt: retainMs === null ? null : now + retainMs };
  if (prior) data.decided[i] = rec;
  else data.decided.push(rec);
  return () => {
    const j = data.decided.indexOf(rec);
    if (j >= 0) {
      if (prior) data.decided[j] = prior;
      else data.decided.splice(j, 1);
    }
    if (retired) data.grace.push(retired);
  };
}

// The restore's cleanup of the records with no expiry: one whose card is no longer in the
// questions store (`keysOnDisk`, the callbackRequestIds read at this restart) has no stale
// copy left to guard, so it is dropped. In place; true when anything was dropped.
export function dropSettledDecided(data: GrantStoreData, keysOnDisk: ReadonlySet<string>): boolean {
  const before = data.decided.length;
  data.decided = data.decided.filter((d) => d.expiresAt !== null || keysOnDisk.has(d.key));
  return data.decided.length !== before;
}

// A tap past the grace window retires the card's grace record, so it can never mint later.
export function retireGraceRecord(grace: GraceRecord[], key: string): GraceRecord | null {
  const i = grace.findIndex((g) => g.key === key);
  return i >= 0 ? grace.splice(i, 1)[0] : null;
}

// Mint gate (fail-closed): a grant is useless unless it can be BOUND — the
// hookId and the operation's fingerprint+cwd are what every later consume is
// validated against, and an old (pre-v1.1 additive fields) ask carries no
// operation at all. Minting anyway would record an unconsumable grant and
// confuse the human; the daemon instead tells the user the agent must
// re-request with a current agent-tools lib.
export function isGrantableRequest(req: Pick<ButtonRequest, 'hookId' | 'operation'>): boolean {
  if (typeof req.hookId !== 'string' || !req.hookId) return false;
  const op = req.operation;
  return Boolean(op && typeof op.fingerprint === 'string' && op.fingerprint && typeof op.cwd === 'string' && op.cwd);
}

export function buildGrantRecord(
  req: ButtonRequest,
  approvalId: string,
  route: string | null,
  approvedAt: number,
  ttlMs: number,
): GrantRecord {
  return {
    approval_id: approvalId,
    request_id: req.requestId,
    hook_id: req.hookId ?? '',
    ...(req.origin ? { origin: req.origin } : {}),
    ...(req.operation ? { operation: req.operation } : {}),
    route,
    approved_at: approvedAt,
    expires_at: approvedAt + ttlMs,
    consumed_at: null,
  };
}

// --- (de)serialization: versioned, fail-soft, pruned on both directions ---

const GRANT_STORE_VERSION = 1;

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function parseOrigin(v: unknown): AskOrigin | undefined {
  if (!isRecord(v)) return undefined;
  const out: AskOrigin = {};
  if (optStr(v.agent)) out.agent = optStr(v.agent);
  if (optStr(v.sessionId)) out.sessionId = optStr(v.sessionId);
  if (optStr(v.subagent)) out.subagent = optStr(v.subagent);
  return Object.keys(out).length ? out : undefined;
}

function parseOperation(v: unknown): AskOperation | undefined {
  if (!isRecord(v)) return undefined;
  const out: AskOperation = {};
  if (optStr(v.kind)) out.kind = optStr(v.kind);
  if (optStr(v.fingerprint)) out.fingerprint = optStr(v.fingerprint);
  if (optStr(v.cwd)) out.cwd = optStr(v.cwd);
  if (optStr(v.repoRoot)) out.repoRoot = optStr(v.repoRoot);
  return Object.keys(out).length ? out : undefined;
}

function parseGrant(v: unknown): GrantRecord | null {
  if (!isRecord(v)) return null;
  const approvalId = optStr(v.approval_id);
  const requestId = optStr(v.request_id);
  const hookId = optStr(v.hook_id);
  const approvedAt = typeof v.approved_at === 'number' && Number.isFinite(v.approved_at) ? v.approved_at : null;
  const expiresAt = typeof v.expires_at === 'number' && Number.isFinite(v.expires_at) ? v.expires_at : null;
  if (!approvalId || !GRANT_ID_RE.test(approvalId) || !requestId || !hookId || approvedAt === null || expiresAt === null) return null;
  // consumed_at accepts ONLY literal null or a finite number — anything else
  // (missing key, a string, a bool) is a CORRUPT consumption marker, and
  // coercing it to null would resurrect a possibly-consumed grant as usable
  // (single-use replay after a hand-edited/corrupt store). Fail closed: drop
  // the record.
  if (v.consumed_at !== null && !(typeof v.consumed_at === 'number' && Number.isFinite(v.consumed_at))) return null;
  const consumedAt = v.consumed_at as number | null;
  return {
    approval_id: approvalId,
    request_id: requestId,
    hook_id: hookId,
    ...(parseOrigin(v.origin) ? { origin: parseOrigin(v.origin) } : {}),
    ...(parseOperation(v.operation) ? { operation: parseOperation(v.operation) } : {}),
    route: typeof v.route === 'string' && v.route ? v.route : null,
    approved_at: approvedAt,
    expires_at: expiresAt,
    consumed_at: consumedAt,
  };
}

function parseGrace(v: unknown): GraceRecord | null {
  if (!isRecord(v)) return null;
  const key = optStr(v.key);
  const requestId = optStr(v.requestId);
  const hookId = optStr(v.hookId);
  const expiredAt = typeof v.expiredAt === 'number' && Number.isFinite(v.expiredAt) ? v.expiredAt : null;
  const graceExpiresAt = typeof v.graceExpiresAt === 'number' && Number.isFinite(v.graceExpiresAt) ? v.graceExpiresAt : null;
  // `req` is stored as the full ButtonRequest JSON; the entrypoint re-runs it
  // through the authoritative normalizeButtonRequest on load (dropping the
  // record if it no longer validates), so here a shape sniff is enough.
  if (!key || !requestId || !hookId || expiredAt === null || graceExpiresAt === null) return null;
  if (!isRecord(v.req) || typeof v.req.requestId !== 'string') return null;
  return {
    key,
    requestId,
    hookId,
    req: v.req as unknown as ButtonRequest,
    route: typeof v.route === 'string' && v.route ? v.route : null,
    messageId: typeof v.messageId === 'number' && Number.isFinite(v.messageId) ? v.messageId : null,
    expiredAt,
    graceExpiresAt,
  };
}

function parseDecided(v: unknown): DecidedCard | null {
  if (!isRecord(v)) return null;
  const key = optStr(v.key);
  const decision = v.decision === 'allow' || v.decision === 'deny' ? v.decision : null;
  const decidedAt = typeof v.decidedAt === 'number' && Number.isFinite(v.decidedAt) ? v.decidedAt : null;
  const expiresAt = v.expiresAt === null ? null : typeof v.expiresAt === 'number' && Number.isFinite(v.expiresAt) ? v.expiresAt : undefined;
  if (!key || decision === null || decidedAt === null || expiresAt === undefined) return null;
  return { key, decision, decidedAt, expiresAt };
}

// Drop grants past their TTL (a grant that can never allow again carries no information
// worth keeping — its consumed proof is meaningless once expired), grace records past
// their window and decided cards past theirs (one with no expiry: dropSettledDecided). In
// place. A grace record whose card minted a grant the agent has not used yet outlives its
// window until that grant expires: the grant lives 24h from the Approve, and a late Deny
// tap on the card is how the human revokes it — without the record the tap would find
// nothing and answer "expired".
export function pruneGrantStore(data: GrantStoreData, now: number): void {
  data.grants = data.grants.filter((g) => now < g.expires_at);
  data.grace = data.grace.filter(
    (rec) => now < rec.graceExpiresAt || data.grants.some((g) => g.request_id === rec.requestId && g.consumed_at === null),
  );
  data.decided = data.decided.filter((d) => d.expiresAt === null || now < d.expiresAt);
}

export function serializeGrantStore(data: GrantStoreData, now: number): string {
  const clean: GrantStoreData = { grace: [...data.grace], grants: [...data.grants], decided: [...data.decided] };
  pruneGrantStore(clean, now);
  return `${JSON.stringify({ version: GRANT_STORE_VERSION, grace: clean.grace, grants: clean.grants, decided: clean.decided }, null, 1)}\n`;
}

// Fail-soft (never throws): garbage / wrong version / malformed records all
// degrade to what is salvageable (or empty), exactly like question-store.ts.
// Pruned against `now` on read too, so a long-down daemon doesn't resurrect
// dead records.
export function parseGrantStore(raw: string | null, now: number): GrantStoreData {
  const empty: GrantStoreData = { grace: [], grants: [], decided: [] };
  if (!raw) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!isRecord(parsed) || parsed.version !== GRANT_STORE_VERSION) return empty;
  const grace = Array.isArray(parsed.grace) ? parsed.grace.map(parseGrace).filter((g): g is GraceRecord => g !== null) : [];
  const grants = Array.isArray(parsed.grants) ? parsed.grants.map(parseGrant).filter((g): g is GrantRecord => g !== null) : [];
  const decided = Array.isArray(parsed.decided) ? parsed.decided.map(parseDecided).filter((d): d is DecidedCard => d !== null) : [];
  const data: GrantStoreData = { grace, grants, decided };
  pruneGrantStore(data, now);
  return data;
}
