# tg-ctl alert: exclusive per-source holder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One omp session holds a source's alerts (`sysmon`) at a time, with a handoff protocol, and `tg-ctl alert send --to-holder` delivers into that holder only, never to Telegram.

**Architecture:** The holder lives in the existing alert-subscription store (`<cfg>/tg-ctl.<bot>.alert-subscriptions.json`, same lock + atomic write) as a `holders` list next to the tg-cli#636 `subscriptions`. Pure rules (state, claim, request, grant, deny, take, release, refresh) live in `features/tg-ctl/alert-subscriptions.ts`; the `tg-ctl` entrypoint owns I/O and omp-live delivery, exactly as for #636.

**Tech Stack:** Bun + TypeScript, `bun test ./tests`.

**Spec:** rig-cli `docs/specs/2026-10-15-sysmon-exclusive-subscriber-design.md` (https://git.hyperide.ai/ultrabricks/rig-cli/src/branch/main/docs/specs/2026-10-15-sysmon-exclusive-subscriber-design.md), section *tg-cli: exclusive holder*. Ticket: tg-cli#747. Consumer: rig-cli#700 (its plan starts after this one is deployed).

## Global Constraints

- Work in a worktree (`rig worktree create alert-holder-747`); the live checkout stays on `main`.
- `HOLDER_GRACE_MS = 10 * 60_000` (suspended → vacant) and `HANDOFF_ANSWER_MS = 10 * 60_000` (unanswered request → requester may take).
- Default holder TTL = `DEFAULT_ALERT_TTL_MS` (12 h); `--ttl 0` = no expiry.
- Exit codes: `0` ok, `1` error, `3` slot conflict or vacant, `5` holder suspended or delivery failed.
- Holder-only send text: `[alert <source> · <severity> · <key>] <text>` (HTML stripped as in `sessionAlertText`).
- `--to-holder` NEVER spawns `tg`.
- Non-exclusive subscriptions (tg-cli#636) keep their behavior; `--to-holder` ignores them.
- A store file without `holders` parses as `holders: []`; `STORE_VERSION` stays 1 (additive field).
- Bump `VERSION` (`features/cli/version`) and add the matching `## <version>` CHANGELOG section (minor bump).
- Deploy after merge with `scripts/deploy.sh`.

## Review Focus

1. Two sessions run `subscribe --exclusive` at the same moment → exactly one wins (claim happens under the store lock); the loser gets exit 3 naming the winner. Test in Task 3.
2. Holder session is resumed (`omp --resume`: new pid, same session id) inside 10 minutes → stays holder with the new pid; after 10 minutes without an endpoint → vacant. Test in Task 1.
3. The holder runs `handoff --to` naming a session that is not live → refused (exit 1), slot unchanged. Test in Task 3.
4. A store written by the old tg-ctl (no `holders`) and a store with a malformed holder record → parse never throws; malformed record dropped. Test in Task 1.
5. `send --to-holder` while the holder's endpoint exists but delivery fails for 10+ minutes → vacant (exit 3), not suspended forever. Test in Task 1 (state) and Task 4 (exit code).

---

### Task 1: Holder model and pure rules

**Files:**
- Modify: `features/tg-ctl/alert-subscriptions.ts`
- Test: `tests/ctl-alert-subscriptions.test.ts`

**Interfaces:**
- Produces:
  - `interface HandoffRequest { sessionId: string; title: string | null; pid: number | null; at: number; reason: string | null }`
  - `interface AlertHolder { source: string; sessionId: string; title: string | null; pid: number | null; cwd: string | null; since: number; lastSeenLiveAt: number; failingSince: number | null; expiresAt: number | null; request: HandoffRequest | null }`
  - `AlertSubscriptionStore` gains `holders: AlertHolder[]` (at most one per source).
  - `type HolderState = 'bound' | 'suspended' | 'vacant'`
  - `holderState(store: AlertSubscriptionStore, source: string, endpoints: readonly OriginalOmpEndpoint[], now: number): { state: HolderState; holder: AlertHolder | null; endpoint: OriginalOmpEndpoint | null }` — rules in spec order: vacant (none / expired / `failingSince` ≥ 10 min) → bound (endpoint with its session id) → suspended (`now - lastSeenLiveAt < HOLDER_GRACE_MS`) → vacant.
  - `type Claimant = { sessionId: string; title: string | null; pid: number | null; cwd: string | null }`
  - `type HolderOutcome = { ok: true; store: AlertSubscriptionStore; holder: AlertHolder } | { ok: false; code: 1 | 3; error: string; holder: AlertHolder | null }`
  - `claimHolder(store, source, claimant: Claimant, endpoints, now, ttlMs: number | null): HolderOutcome` — vacant or same session → ok; otherwise code 3.
  - `requestHandoff(store, source, requester: Claimant, endpoints, now, reason: string | null): HolderOutcome` — code 3 when vacant, when requester is holder, or when another session's request is younger than `HANDOFF_ANSWER_MS`.
  - `grantHandoff(store, source, callerSessionId: string, target: Claimant, endpoints, now): HolderOutcome` — caller must be holder (code 1), target must have a live endpoint (code 1).
  - `denyHandoff(store, source, callerSessionId: string): HolderOutcome & { denied?: HandoffRequest | null }` — holder only (code 1); clears `request` and returns the cleared one as `denied`.
  - `takeHolder(store, source, taker: Claimant, endpoints, now, ttlMs: number | null): HolderOutcome` — ok when vacant, or when `request.sessionId === taker.sessionId` and `now - request.at ≥ HANDOFF_ANSWER_MS`; else code 3.
  - `releaseHolder(store, source, sessionId): HolderOutcome` — code 1 when that session does not hold it.
  - `refreshHolder(store, source, endpoints, now): AlertSubscriptionStore` — when bound: `lastSeenLiveAt = now`, pid/title/cwd from the endpoint.
  - `markHolderDelivery(store, source, sessionId: string, ok: boolean, now): AlertSubscriptionStore` — applies only while `sessionId` is still the source's holder (a delivery that finished after a handoff never marks the new holder); ok clears `failingSince` and sets `lastSeenLiveAt`; failure sets `failingSince` only if null.
  - `upsertAlertSubscription` / `removeAlertSubscription` keep `store.holders` untouched (they spread the store instead of rebuilding it), and `unsubscribe --all` removes non-exclusive subscriptions only; holders change only through the holder functions.
  - Throttle (holder sends): `settleHolderAlert(store: AlertThrottleStore, key: string): AlertThrottleStore` records a delivered holder send as `messageId: 0` (no Telegram id exists); `parseAlertThrottle` accepts `messageId === 0` only for keys starting with `holder:`; `throttleVerdict` treats it as posted. A failed delivery calls the existing `settleAlert(store, key, null, [])`, which drops the claim.
  - `HOLDER_GRACE_MS`, `HANDOFF_ANSWER_MS` exported.

- [ ] **Step 1: Write the failing tests** in a new `describe('exclusive holder', …)`:
  - `holderState` at 9:59 and 10:00 after the endpoint vanished: `suspended` then `vacant`.
  - resumed session (new pid, same sessionId) → `bound`, and `refreshHolder` stores the new pid.
  - `failingSince = now - 10 min` with a live endpoint → `vacant`.
  - expired `expiresAt` → `vacant`.
  - `claimHolder`: vacant → ok; same session → ok with refreshed TTL; other session → `{ok:false, code:3}` and `holder.sessionId` is the current holder.
  - `requestHandoff`: second requester within 10 min → code 3; after 10 min → replaces the request.
  - `takeHolder` by the requester at 9:59 → code 3; at 10:00 → ok, `holder.sessionId === requester`, `request === null`.
  - `grantHandoff` to a non-live target → code 1, store unchanged.
  - parse: blob with only `subscriptions` → `holders: []`; a holder without `source` → dropped; serialize→parse round-trips a holder with a request.
  - `upsertAlertSubscription` and `removeAlertSubscription` on a store with a holder → the holder is unchanged.
  - `markHolderDelivery(store, 'sysmon', 'A', false, now)` after the slot moved to B → store unchanged.
  - `settleHolderAlert` then `throttleVerdict` inside the window → `throttled`; after serialize→parse the `messageId: 0` entry survives for a `holder:` key and is dropped for any other key.
- [ ] **Step 2: Run** `bun test ./tests/ctl-alert-subscriptions.test.ts` — Expected: FAIL (`holderState` not exported).
- [ ] **Step 3: Implement** the types and functions above in `alert-subscriptions.ts`; extend `parseAlertSubscriptions`/`serializeAlertSubscriptions` (expired holders dropped on serialize, as subscriptions are).
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(tg-ctl): exclusive alert holder model and rules (Refs #747)`.

### Task 2: argv grammar

**Files:**
- Modify: `features/tg-ctl/alert-subscriptions.ts` (`AlertCommand`, `KNOWN`, `BOOLEANS`, `USAGE`, `parseAlertArgv`)
- Test: `tests/ctl-alert-subscriptions.test.ts`

**Interfaces:**
- Produces `AlertCommand` additions:
  - `subscribe` gains `exclusive: boolean; source: string | null` (`--exclusive` requires `--source`, forbids `--sources`).
  - `{ cmd: 'handoff-request'; source: string; reason: string | null; pid: number | null; sessionId: string | null }`
  - `{ cmd: 'handoff'; source: string; to: string | null; deny: boolean; reason: string | null; pid: number | null; sessionId: string | null }` (exactly one of `--to`, `--deny`; `--pid`/`--session` name the caller like `subscribe`, needed from a tmux shell whose ancestors do not reach omp)
  - `{ cmd: 'take'; source: string; pid: number | null; sessionId: string | null; ttlMs: number | null }`
  - `{ cmd: 'release'; source: string; pid: number | null; sessionId: string | null }`
  - `{ cmd: 'holder'; source: string; json: boolean }`
  - `send` gains `toHolder: boolean` (`--to-holder`).

- [ ] **Step 1: Write the failing tests**: each new command parses with its flags; `subscribe --exclusive` without `--source` → error `--exclusive requires --source`; `--exclusive --sources a` → error; `handoff --to X --deny` → error `--to and --deny are exclusive`; `handoff` with neither → error; `--source` validated by `SOURCE_RE`; `send --to-holder` sets `toHolder: true`; unknown command error lists `send|subscribe|unsubscribe|list|handoff-request|handoff|take|release|holder`.
- [ ] **Step 2: Run** `bun test ./tests/ctl-alert-subscriptions.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** in `parseAlertArgv`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(tg-ctl): alert handoff/take/release/holder argv (Refs #747)`.

### Task 3: Entrypoint — exclusive subscribe, handoff, take, release, holder

**Files:**
- Modify: `tg-ctl` (`runAlertCommand` switch; new `runAlertExclusiveSubscribe`, `runAlertHandoffRequest`, `runAlertHandoff`, `runAlertTake`, `runAlertRelease`, `runAlertHolder`; usage block near `tg-ctl alert subscribe`)
- Test: `tests/ctl-alert-lifecycle-integration.test.ts` (new `test(...)` blocks, same harness: real omp-live endpoints, mock Bot API)

**Interfaces:**
- Consumes: Task 1 rules, Task 2 commands, existing `withAlertSubscriptions`, `resolveAlertSession`, `sendLiveMessage`.
- Produces: CLI behavior per the spec table; notes delivered with request ids `alert-holder-<source>-<sessionId>-<ms>`.
  - refusal text (stdout, exit 3): `held by <title> · pid <pid> · session <id> · since <age> · <state>` then `ask: tg-ctl alert handoff-request --source <S> --reason '<why>'`.
  - note to holder on request: names requester (title, pid, session id), reason, `tg-ctl alert handoff --source <S> --to <requester id>`, `tg-ctl alert handoff --source <S> --deny --reason '…'`, and "unanswered for 10 minutes lets it take the slot".
  - `holder --json`: `{source, state, holder: {sessionId,title,pid,cwd,since,lastSeenLiveAt,failingSince,expiresAt} | null, request: {...} | null}`.

- [ ] **Step 1: Write the failing integration tests**:
  - `exclusive: first session claims, second is refused naming the first` — two endpoints A, B; A `subscribe --exclusive --source sysmon` exit 0; B exit 3 and stdout contains A's session id and `handoff-request`.
  - `handoff: request reaches the holder, deny clears it, grant moves the slot` — B `handoff-request` exit 0; A's received log has the note with `--to <B>`; A `handoff --deny` exit 0, B receives the denial; B requests again; A `handoff --to <B>` exit 0; `holder --json` shows B.
  - `take: only after 10 minutes unanswered or when vacant` — write the store file directly with A as holder (live) and B's request at `Date.now() - 9 * 60_000`: B `take` exit 3; rewrite with `- 11 * 60_000`: exit 0 and A's received log has the "taken" note. (The 10:00 edge itself is pinned by the Task 1 pure tests; no test-only clock hook in the binary.)
  - `release` by holder exit 0, by non-holder exit 1; `holder` exit 3 after release.
  - `handoff --to <dead session>` exit 1, holder unchanged.
  - `concurrent exclusive subscribes: exactly one wins` — A and B run `subscribe --exclusive --source sysmon` started together (`Promise.all` of two spawns): exit codes sorted equal `[0, 3]`, and `holder --json` names the one that exited 0.
- [ ] **Step 2: Run** `bun test ./tests/ctl-alert-lifecycle-integration.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the six runners; every store mutation inside `withAlertSubscriptions`; deliveries outside the lock; `runAlertHolder` also calls `refreshHolder`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(tg-ctl): alert subscribe --exclusive, handoff, take, release, holder (Refs #747)`.

### Task 4: `send --to-holder`

**Files:**
- Modify: `tg-ctl` (`runAlertSend` branches on `command.toHolder` into new `runAlertSendToHolder`)
- Test: `tests/ctl-alert-lifecycle-integration.test.ts`

**Interfaces:**
- Consumes: `holderState`, `markHolderDelivery(…, sessionId, …)` with the session the send targeted, `claimAlert`/`settleHolderAlert`/`settleAlert` with key `'holder:' + throttleKey(...)`. Also add a lifecycle test: after A claims `sysmon`, `tg-ctl alert unsubscribe --all` leaves `holder --json` naming A.
- Produces: stdout `OK holder <sessionId> pid <pid>` (exit 0) | `VACANT <source>` (exit 3) | `SUSPENDED <source> <sessionId>` or `FAILED holder <sessionId>: <why>` (exit 5); `throttled holder …` (exit 0) inside the window.

- [ ] **Step 1: Write the failing integration tests**:
  - bound holder: exit 0, the holder's received log has `[alert sysmon · warning · swap] …`, the mock Bot API `sent` array is unchanged, a non-exclusive subscriber of all sources received nothing.
  - no holder: exit 3, `sent` unchanged.
  - holder endpoint withdrawn 1 min ago: exit 5.
  - same (source,key,severity) twice inside `--window`: second prints `throttled holder`, exit 0, delivered once.
  - delivery failure: the holder's endpoint is listed by `listLiveEndpoints` (its test server answers the liveness probe) but answers the send with an error receipt → exit 5 and `failingSince` set; with `failingSince` aged 10 min in the store file → exit 3.
  - a failed or suspended delivery releases its throttle claim (`settleAlert(..., null, [])`): an immediate retry with the same (source,key,severity) attempts delivery again instead of printing `throttled holder` (sysmon's pending queue depends on this, rig-cli#700).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `runAlertSendToHolder`; never calls `tgBinary()`.
- [ ] **Step 4: Run** `bun test ./tests` — Expected: whole suite PASS.
- [ ] **Step 5: Commit** `feat(tg-ctl): alert send --to-holder delivers into the exclusive holder only (Refs #747)`.

### Task 5: Docs, version, ship

**Files:**
- Modify: `tg-ctl` usage text, `README.md` (tg-ctl alert section), `AGENTS.md` (Architecture: alert subscriptions paragraph), `features/cli/version`, `CHANGELOG.md`

- [ ] **Step 1:** usage lines for the six new forms, mirroring the #636 lines' style.
- [ ] **Step 2:** bump `VERSION` (minor) and add `## <version>` describing the holder, handoff and `--to-holder`.
- [ ] **Step 3: Run** `bun test ./tests` — Expected: PASS (includes the VERSION/CHANGELOG test).
- [ ] **Step 4:** `flock /tmp/disk-session-review.lock review diff --staged --task 747` (one review at a time on *home*), fix findings, commit `docs(tg-ctl): exclusive alert holder usage and changelog (Refs #747)`.
- [ ] **Step 5:** push, open PR (`Refs #747`), CI green, squash-merge, `scripts/deploy.sh`; on *home* verify `tg-ctl alert holder --source sysmon` exits 3 (no holder yet) from the live checkout; check the ticket criteria with proofs; `task done '#747'`.

## Review amendments (binding; override the tasks above where they differ)

From the plan review (tg-cli-747). Each item names the task whose tests it extends.

1. **Grant** (Task 1/3): `grantHandoff` installs a fresh holder record for the target: `request: null`, `since = lastSeenLiveAt = now`, `failingSince: null`; `expiresAt` is `null` when the granting record had `null`, else `now + DEFAULT_ALERT_TTL_MS`. Tests assert `request === null` after a grant.
2. **TTL** (Task 2): `subscribe --exclusive` and `take` both accept `--ttl <dur>`; `--ttl 0` parses to `0` (= no expiry, `expiresAt: null`), omitted = 12 h. Tests: `--ttl 0` round-trips; a holder with `expiresAt: null` is never vacant by the expiry branch and survives serialize.
3. **Vacant/suspended before claim** (Task 4): `send --to-holder` evaluates the holder state before taking a throttle claim; exits 3/5 leave no claim. Test: two sends to a vacant source both exit 3 and neither prints `throttled`.
4. **Parse hardening** (Task 1): a holder record with a non-finite `since`/`lastSeenLiveAt`/`failingSince`/`expiresAt`, a malformed `request` (or non-finite `request.at`) is dropped; non-array `holders` parses as `[]`; two records for one source keep the earliest `since`, the rest are dropped. Parse never throws.
5. **Deny with no request** (Task 3): exit 1 `no pending handoff request`, slot unchanged.
6. **Same-session claim** (Task 1): refreshes `pid`, `title`, `cwd`, `lastSeenLiveAt` and the TTL, in `bound` or `suspended` state (resume case). Test the suspended sub-case.
7. **Live endpoint required** (Task 3): `subscribe --exclusive`, `handoff-request` and `take` need a live omp-live endpoint for the acting session (exit 1 `session <id> is not live` otherwise), as `handoff --to` already does.
8. **Liveness refresh** (Task 3/4): every alert command that observes a bound holder under the lock — including `send --to-holder` — refreshes `lastSeenLiveAt`.
9. **Stale identity** (Task 4): a delivery answered `stale_identity` re-resolves the holder's endpoint by session id once and retries; only a failure after that counts toward `failingSince`.
10. **Request queue** (Task 1/3): while a request is pending (any age), another session's `handoff-request` exits 3 naming the pending requester; the pending requester's `take` after 10 minutes therefore cannot be pre-empted.
11. **Throttle fencing** (Task 1): `settleHolderAlert` and the failure release settle only the claim they took (match the claim's `at`); a replaced claim is left alone.
12. **Request id** (Task 3): handoff notes use a bounded id built like `alertRequestId` (≤ 256 chars, sanitized).
13. **`unsubscribe --all`** (Task 3): preserves `holders`; the lifecycle test asserts the persisted file.
14. **Known limit, documented in `docs/` and `tg-ctl help alert`**: a send that selected the holder just before a handoff may still deliver to the previous holder (delivery runs outside the store lock); the next send goes to the new holder. The store is forward-compatible only: a pre-#747 tg-ctl that rewrites the file drops `holders`.
